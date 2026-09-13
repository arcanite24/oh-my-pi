import { expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { isRecord, removeWithRetries } from "@oh-my-pi/pi-utils";
import { mcpOAuthCredentialId } from "../src/mcp/oauth-flow";
import { BrowserMcpOAuth } from "../src/web/openchamber-mcp-oauth";
import { startOpenChamberServer } from "../src/web/openchamber-server";
import { AgentStorage } from "../src/session/agent-storage";
import { MCPTransportError } from "../src/mcp/errors";
import { analyzeAuthError } from "../src/mcp/oauth-discovery";

test("transport OAuth hints stay out of serialized errors but reach shared discovery", () => {
	const metadataUrl = "https://provider.example.invalid/private-challenge-marker";
	const error = new MCPTransportError({
		transport: "http",
		stage: "connect",
		failure: "http_status",
		message: "HTTP 401: Authentication required",
		code: 401,
		retryable: false,
		oauthChallenge: { wwwAuthenticate: `Bearer resource_metadata="${metadataUrl}"`, authServer: null },
	});
	expect(JSON.stringify(error)).not.toContain("private-challenge-marker");
	expect(String(error)).not.toContain("private-challenge-marker");
	expect(analyzeAuthError(error).resourceMetadataUrl).toBe(metadataUrl);
});

test.each(["http", "sse"] as const)(
	"browser OAuth follows %s authentication challenges and protected scopes",
	async transport => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-oauth-challenge-"));
		const auth = await AuthStorage.create(path.join(directory, "agent.db"));
		const oauth = new BrowserMcpOAuth(auth);
		let challenges = 0;
		const requestedPaths: string[] = [];
		const provider = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				const url = new URL(request.url);
				requestedPaths.push(url.pathname);
				if (url.pathname === "/mcp") {
					challenges++;
					expect(request.headers.get("authorization")).toBeNull();
					return new Response("Authentication required", {
						status: 401,
						headers: {
							"WWW-Authenticate": `Bearer resource_metadata="${url.origin}/custom-resource", scope="tools:read"`,
						},
					});
				}
				if (url.pathname === "/custom-resource")
					return Response.json({ resource: `${url.origin}/mcp`, authorization_servers: [`${url.origin}/issuer`] });
				if (
					url.pathname === "/.well-known/oauth-authorization-server/issuer" ||
					url.pathname === "/issuer/.well-known/oauth-authorization-server"
				)
					return Response.json({
						issuer: `${url.origin}/issuer`,
						authorization_endpoint: `${url.origin}/authorize`,
						token_endpoint: `${url.origin}/token`,
					});
				return new Response(null, { status: 404 });
			},
		});
		try {
			const result = await oauth
				.startConfigured(
					{ type: transport, url: new URL("mcp", provider.url).href, oauth: { clientId: "challenge-test" } },
					"https://browser.example.invalid/api/omp/mcp-oauth/callback",
				)
				.catch(() => {
					throw new Error(`Fixture discovery failed; requested paths: ${requestedPaths.join(", ")}`);
				});
			expect(challenges).toBeGreaterThan(0);
			expect(result.status).toBe("pending");
			const url = new URL(result.authorizationUrl!);
			expect(url.pathname).toBe("/authorize");
			expect(url.searchParams.get("scope")).toBe("tools:read");
			expect(url.searchParams.get("resource")).toBe(new URL("mcp", provider.url).href);
		} finally {
			oauth.close();
			auth.close();
			provider.stop(true);
			await removeWithRetries(directory);
		}
	},
);

test("private OAuth routes reject browser bypass and untrusted callbacks", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-oauth-api-"));
	const password = crypto.randomUUID();
	const options = { port: 0, password, command: [process.execPath], dataDir: directory };
	let exchanges = 0;
	const provider = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			if (url.pathname.includes(".well-known"))
				return Response.json({
					authorization_endpoint: `${url.origin}/authorize`,
					token_endpoint: `${url.origin}/token`,
				});
			if (url.pathname === "/token") {
				exchanges++;
				return Response.json({
					access_token: "api-test-access",
					refresh_token: "api-test-refresh",
					expires_in: 3600,
				});
			}
			return new Response(null, { status: 404 });
		},
	});
	try {
		const seed = await AuthStorage.create(path.join(directory, "agent.db"));
		try {
			await seed.set("mcp_oauth_legacy_probe", {
				type: "oauth",
				access: "old-access",
				refresh: "old-refresh",
				expires: Date.now() + 3600000,
			});
		} finally {
			seed.close();
		}
		await fs.writeFile(
			path.join(directory, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					probe: {
						type: "http",
						url: new URL("mcp", provider.url).href,
						oauth: { clientId: "test-client" },
						auth: { type: "oauth", credentialId: "mcp_oauth_legacy_probe" },
					},
				},
			}),
		);
		await expect(startOpenChamberServer({ ...options, browserOrigin: "http://example.com" })).rejects.toThrow(
			"Browser origin",
		);
		const runtime = await startOpenChamberServer({ ...options, browserOrigin: "http://127.0.0.1:4408" });
		try {
			const url = new URL("/omp/mcp-oauth/callback?state=unknown&code=secret-code", runtime.server.url);
			const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
			expect((await fetch(url)).status).toBe(401);
			expect((await fetch(url, { headers: { authorization, origin: "http://127.0.0.1:4408" } })).status).toBe(403);
			const response = await fetch(url, { headers: { authorization }, redirect: "manual" });
			expect(response.status).toBe(400);
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(response.headers.get("referrer-policy")).toBe("no-referrer");
			expect(await response.text()).not.toContain("secret-code");
			const start = await fetch(new URL("/omp/mcp-oauth?scope=user&name=probe", runtime.server.url), {
				method: "POST",
				headers: { authorization },
			});
			expect(start.status).toBe(200);
			const attempt = await start.json();
			if (!isRecord(attempt) || typeof attempt.state !== "string" || typeof attempt.authorizationUrl !== "string")
				throw new Error("Expected a pending authorization response");
			expect(attempt.status).toBe("pending");
			const recovered = await fetch(new URL("/omp/mcp-oauth?scope=user&name=probe", runtime.server.url), {
				headers: { authorization },
			});
			expect(await recovered.json()).toMatchObject({ state: attempt.state, status: "pending" });
			expect(exchanges).toBe(0);
			expect(new URL(attempt.authorizationUrl).searchParams.get("redirect_uri")).toBe(
				"http://127.0.0.1:4408/api/omp/mcp-oauth/callback",
			);
			const callback = new URL(`/omp/mcp-oauth/callback?state=${attempt.state}&code=test-code`, runtime.server.url);
			const completed = await fetch(callback, { headers: { authorization }, redirect: "manual" });
			expect(completed.status).toBe(303);
			expect(completed.headers.get("location")).toBe("http://127.0.0.1:4408/?settings=mcp");
			const status = await fetch(new URL(`/omp/mcp-oauth?state=${attempt.state}`, runtime.server.url), {
				headers: { authorization },
			});
			expect(await status.json()).toMatchObject({ status: "complete" });
			await fetch(callback, { headers: { authorization }, redirect: "manual" });
			expect(exchanges).toBe(1);
		} finally {
			await runtime.close();
			AgentStorage.close();
		}
		const stored = await AuthStorage.create(path.join(directory, "agent.db"));
		try {
			await stored.reload();
			expect(stored.get("mcp_oauth_legacy_probe")).toMatchObject({
				access: "api-test-access",
				refresh: "api-test-refresh",
			});
			expect(stored.get(mcpOAuthCredentialId(new URL("mcp", provider.url).href))).toBeUndefined();
		} finally {
			stored.close();
		}
	} finally {
		provider.stop(true);
		await removeWithRetries(directory);
	}
});

test("browser MCP OAuth keeps PKCE and tokens server-side and accepts each callback once", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-oauth-"));
	const storage = await AuthStorage.create(path.join(directory, "agent.db"));
	const oauth = new BrowserMcpOAuth(storage);
	let exchanges = 0;
	let challenge = "";
	let fail = false;
	const provider = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			exchanges++;
			const body = new URLSearchParams(await request.text());
			const verifier = body.get("code_verifier");
			expect(verifier).toBeTruthy();
			expect(
				Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier ?? ""))).toString(
					"base64url",
				),
			).toBe(challenge);
			return fail
				? new Response("provider-secret-error", { status: 400 })
				: Response.json({ access_token: "test-only-access", refresh_token: "test-only-refresh", expires_in: 3600 });
		},
	});
	const serverUrl = new URL("mcp", provider.url).href;
	const redirect = "http://127.0.0.1:4408/api/omp/mcp-oauth/callback";
	const config = {
		authorizationUrl: new URL("authorize", provider.url).href,
		tokenUrl: new URL("token", provider.url).href,
		clientId: "test-client",
	};
	try {
		const attempt = await oauth.start(serverUrl, config, redirect);
		const authorization = new URL(attempt.authorizationUrl!);
		challenge = authorization.searchParams.get("code_challenge")!;
		expect(authorization.searchParams.get("state")).toBe(attempt.state);
		expect(authorization.searchParams.has("code_verifier")).toBe(false);
		await expect(oauth.complete("wrong-state", "code")).rejects.toThrow("Unknown");
		expect(exchanges).toBe(0);
		await expect(oauth.start(serverUrl, config, redirect)).rejects.toThrow("already in progress");
		const [completed, duplicate] = await Promise.all([
			oauth.complete(attempt.state, "code"),
			oauth.complete(attempt.state, "duplicate"),
		]);
		expect(duplicate.status).toBe("exchanging");
		expect(completed.status).toBe("complete");
		expect(JSON.stringify(completed)).not.toContain("test-only");
		expect(storage.get(mcpOAuthCredentialId(serverUrl))).toMatchObject({
			type: "oauth",
			access: "test-only-access",
			refresh: "test-only-refresh",
			clientId: "test-client",
		});
		await oauth.complete(attempt.state, "replay");
		expect(exchanges).toBe(1);
		fail = true;
		const retry = await oauth.start(serverUrl, config, redirect);
		challenge = new URL(retry.authorizationUrl!).searchParams.get("code_challenge")!;
		const failed = await oauth.complete(retry.state, "bad-code");
		expect(failed.status).toBe("failed");
		expect(JSON.stringify(failed)).not.toContain("provider-secret-error");
		expect(storage.get(mcpOAuthCredentialId(serverUrl))).toMatchObject({ access: "test-only-access" });
		const cancelled = await oauth.start(serverUrl, config, redirect);
		oauth.cancel(cancelled.state);
		expect((await oauth.complete(cancelled.state, "ignored")).status).toBe("cancelled");
		expect(exchanges).toBe(2);
		const expired = await oauth.start(serverUrl, config, redirect);
		const clock = vi.spyOn(Date, "now").mockReturnValue(expired.expiresAt + 1);
		try {
			expect((await oauth.complete(expired.state, "ignored")).status).toBe("expired");
		} finally {
			clock.mockRestore();
		}
		expect(exchanges).toBe(2);
	} finally {
		oauth.close();
		provider.stop(true);
		storage.close();
		await removeWithRetries(directory);
	}
});
