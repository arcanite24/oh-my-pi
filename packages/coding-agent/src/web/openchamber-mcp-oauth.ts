import type { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { expandEnvVarsDeep } from "../discovery/helpers";
import { analyzeAuthError, discoverOAuthEndpoints, fetchResourceMetadataScopes } from "../mcp/oauth-discovery";
import { connectToServer, disconnectServer } from "../mcp/client";
import { lookupMcpOAuthCredentialForServer } from "../mcp/oauth-credentials";
import type { MCPServerConfig } from "../mcp/types";
import {
	MCPOAuthFlow,
	mcpOAuthCredentialId,
	type MCPOAuthConfig,
	type MCPStoredOAuthCredential,
} from "../mcp/oauth-flow";

type Status = "pending" | "exchanging" | "complete" | "failed" | "cancelled" | "expired";
interface Attempt {
	state: string;
	serverUrl: string;
	credentialId: string;
	redirectUri: string;
	expiresAt: number;
	status: Status;
	abort: AbortController;
	flow?: MCPOAuthFlow;
	authorizationUrl?: string;
	config: MCPOAuthConfig;
}

/** Server-owned PKCE state. Browser responses never contain credential material. */
export class BrowserMcpOAuth {
	#attempts = new Map<string, Attempt>();
	constructor(readonly authStorage: AuthStorage) {}

	statusConfigured(rawConfig: MCPServerConfig) {
		if (rawConfig.type !== "http" && rawConfig.type !== "sse") return null;
		const url = expandEnvVarsDeep(rawConfig.url);
		const attempts = [...this.#attempts.values()];
		const latest = attempts.findLast(attempt => attempt.serverUrl === url);
		return latest ? this.status(latest.state) : null;
	}

	async startConfigured(rawConfig: MCPServerConfig, redirectUri: string) {
		if (rawConfig.type !== "http" && rawConfig.type !== "sse")
			throw new Error("OAuth requires a native HTTP or SSE MCP server");
		const config = expandEnvVarsDeep(rawConfig);
		if (config.enabled === false) throw new Error("Enable the MCP server before authorization");
		if (config.oauth?.redirectUri && config.oauth.redirectUri !== redirectUri)
			throw new Error("MCP redirect URI does not match the configured browser callback");
		const signal = AbortSignal.timeout(30_000);
		let challenge;
		try {
			const connection = await connectToServer(
				"browser_oauth_discovery",
				{ ...config, auth: undefined },
				{ signal },
			);
			await disconnectServer(connection);
		} catch (error) {
			challenge = analyzeAuthError(error instanceof Error ? error : new Error(String(error)), config.url);
		}
		let endpoints =
			challenge?.oauth ??
			(await discoverOAuthEndpoints(config.url, challenge?.authServerUrl, challenge?.resourceMetadataUrl, {
				protectedScopes: challenge?.scopes,
				signal,
			}));
		if (endpoints && !endpoints.scopes && challenge?.resourceMetadataUrl) {
			const scopes = await fetchResourceMetadataScopes(challenge.resourceMetadataUrl, { signal });
			if (scopes) endpoints = { ...endpoints, scopes };
		}
		if (!endpoints) throw new Error("MCP OAuth endpoint discovery failed");
		const existing = lookupMcpOAuthCredentialForServer(this.authStorage, config.auth, config.url);
		const stored = existing?.credential;
		const clientId =
			config.oauth?.clientId ||
			config.auth?.clientId ||
			stored?.clientId ||
			(!endpoints.registrationUrl ? endpoints.clientId : undefined);
		return this.start(
			config.url,
			{
				...endpoints,
				clientId,
				clientSecret: config.oauth?.clientSecret ?? config.auth?.clientSecret ?? stored?.clientSecret,
				scopes: config.oauth?.scope ?? endpoints.scopes,
				prompt: config.oauth?.prompt,
				redirectUri,
				resource: endpoints.resource ?? config.url,
				stripSameOriginResource: endpoints.resource === undefined,
			},
			redirectUri,
			existing?.credentialId,
		);
	}

	#get(state: string): Attempt {
		const attempt = this.#attempts.get(state);
		if (!attempt) throw new Error("Unknown MCP authorization attempt");
		if (Date.now() >= attempt.expiresAt && attempt.status !== "complete") {
			attempt.abort.abort();
			attempt.status = "expired";
			attempt.flow = undefined;
			attempt.authorizationUrl = undefined;
		}
		return attempt;
	}

	status(state: string) {
		const attempt = this.#get(state);
		return {
			state,
			status: attempt.status,
			expiresAt: attempt.expiresAt,
			authorizationUrl: attempt.status === "pending" ? attempt.authorizationUrl : undefined,
		};
	}

	async start(
		serverUrl: string,
		config: MCPOAuthConfig,
		redirectUri: string,
		credentialId = mcpOAuthCredentialId(serverUrl),
	) {
		for (const [state, attempt] of this.#attempts) {
			if (Date.now() >= attempt.expiresAt) {
				attempt.abort.abort();
				this.#attempts.delete(state);
			} else if (
				attempt.serverUrl === serverUrl &&
				(attempt.status === "pending" || attempt.status === "exchanging")
			)
				throw new Error("MCP authorization is already in progress for this server");
		}
		if (this.#attempts.size >= 32) throw new Error("Too many MCP authorization attempts; try again later");
		const abort = new AbortController();
		const state = crypto.randomUUID();
		const flow = new MCPOAuthFlow(config, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(300_000)]) });
		const attempt: Attempt = {
			state,
			serverUrl,
			credentialId,
			redirectUri,
			config,
			expiresAt: Date.now() + 300_000,
			status: "pending",
			abort,
			flow,
		};
		this.#attempts.set(state, attempt);
		try {
			const { url } = await flow.generateAuthUrl(state, redirectUri);
			const parsed = new URL(url);
			if (
				!["http:", "https:"].includes(parsed.protocol) ||
				parsed.username ||
				parsed.password ||
				[...parsed.searchParams.keys()].some(key =>
					/^(client_secret|access_token|refresh_token|api_key|apikey)$/i.test(key),
				)
			)
				throw new Error("Unsafe authorization URL");
			if (!abort.signal.aborted) attempt.authorizationUrl = url;
		} catch {
			attempt.status = "failed";
			attempt.flow = undefined;
		}
		return this.status(state);
	}

	async complete(state: string, code: string) {
		const attempt = this.#get(state);
		if (attempt.status !== "pending" || !attempt.flow) return this.status(state);
		if (typeof code !== "string" || !code || code.length > 16_384) throw new Error("Invalid authorization code");
		const flow = attempt.flow;
		attempt.status = "exchanging";
		attempt.authorizationUrl = undefined;
		try {
			const credentials = await flow.exchangeToken(code, state, attempt.redirectUri);
			if (attempt.abort.signal.aborted || Date.now() >= attempt.expiresAt) return this.status(state);
			const stored: MCPStoredOAuthCredential = {
				type: "oauth",
				...credentials,
				tokenUrl: attempt.config.tokenUrl,
				clientId: flow.resolvedClientId,
				clientSecret: flow.registeredClientSecret ?? attempt.config.clientSecret,
				resource: flow.resource,
				authorizationUrl: flow.authorizationUrl,
			};
			await this.authStorage.set(attempt.credentialId, stored);
			attempt.status = "complete";
		} catch {
			if (!attempt.abort.signal.aborted) attempt.status = "failed";
		} finally {
			attempt.flow = undefined;
		}
		return this.status(state);
	}

	cancel(state: string) {
		const attempt = this.#get(state);
		if (attempt.status === "exchanging") throw new Error("Authorization completion is already in progress");
		if (attempt.status === "pending") {
			attempt.abort.abort();
			attempt.status = "cancelled";
			attempt.flow = undefined;
			attempt.authorizationUrl = undefined;
		}
		return this.status(state);
	}

	close(): void {
		for (const attempt of this.#attempts.values()) attempt.abort.abort();
		this.#attempts.clear();
	}
}
