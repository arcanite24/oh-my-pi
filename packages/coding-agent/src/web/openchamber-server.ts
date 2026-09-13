import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { CredentialPoolExhaustedError } from "@oh-my-pi/pi-ai/auth/credential-pool";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { getAgentDbPath, getAgentDir, getModelDbPath, isRecord } from "@oh-my-pi/pi-utils";
import type { Provider } from "@opencode-ai/sdk/v2";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { discoverAgents } from "../task/discovery";
import { loadSkills } from "../extensibility/skills";
import { ACP_BUILTIN_SLASH_COMMANDS } from "../slash-commands/acp-builtins";
import { OpenChamberHost } from "./openchamber-host";
import { RpcCommandError } from "../modes/rpc/rpc-client";
import { smallModelRequest } from "./openchamber-small-model";

export interface OpenChamberServerOptions {
	port: number;
	password: string;
	command: string[];
	dataDir?: string;
	authDbPath?: string;
}

function field(body: Record<string, unknown>, name: string, optional = false): string | undefined {
	const value = body[name];
	if (optional && value === undefined) return undefined;
	if (typeof value !== "string" || value.length > 1_000_000) throw new Error(`Invalid ${name}`);
	return value;
}
async function requestBody(request: Request): Promise<Record<string, unknown>> {
	const text = await request.text();
	if (text.length > 8_000_000) throw new Error("Request too large");
	const body: unknown = text ? JSON.parse(text) : {};
	if (!isRecord(body)) throw new Error("Expected an object");
	return body;
}
function modelInput(body: Record<string, unknown>): { providerID: string; modelID: string } | undefined {
	if (body.model === undefined) return undefined;
	if (!isRecord(body.model)) throw new Error("Invalid model");
	const providerID = field(body.model, "providerID");
	const modelID = field(body.model, "modelID");
	if (!providerID || !modelID) throw new Error("Model and provider are required");
	return { providerID, modelID };
}

function promptParts(body: Record<string, unknown>): { text: string; images: ImageContent[] } {
	if (!Array.isArray(body.parts)) throw new Error("Expected message parts");
	const texts: string[] = [];
	const images: ImageContent[] = [];
	for (const part of body.parts) {
		if (!isRecord(part)) throw new Error("Invalid message part");
		if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
		else if (part.type === "file" && typeof part.mime === "string" && typeof part.url === "string") {
			const data = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(part.url);
			if (!data || data[1] !== part.mime)
				throw new Error("Attachments must contain base64 data with a matching MIME type");
			if (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(part.mime))
				images.push({ type: "image", mimeType: part.mime, data: data[2] });
			else if (part.mime.startsWith("text/")) texts.push(Buffer.from(data[2], "base64").toString("utf8"));
			else throw new Error("Upload this attachment to the project and reference its file path");
		} else throw new Error("Unsupported message part");
	}
	return { text: texts.join("\n"), images };
}

export async function startOpenChamberServer(options: OpenChamberServerOptions) {
	if (options.password.length < 32) throw new Error("OMP web backend requires a strong private password");
	const expected = Buffer.from(`Basic ${Buffer.from(`opencode:${options.password}`).toString("base64")}`);
	const dataDir = options.dataDir ?? getAgentDir();
	await fs.mkdir(dataDir, { recursive: true });
	const auth = await AuthStorage.create(options.authDbPath ?? getAgentDbPath(dataDir));
	await auth.reload();
	const nativeSettings = await Settings.loadIsolated({ agentDir: dataDir });
	const models = new ModelRegistry(auth, path.join(dataDir, "models.yml"), {
		settings: nativeSettings,
		cacheDbPath: getModelDbPath(dataDir),
	});
	await models.refresh("offline");
	const host = new OpenChamberHost(options.command, path.join(dataDir, "openchamber.db"), dataDir);
	const initialDirectory = process.cwd();
	const providers = (): Provider[] => {
		const grouped = new Map<string, Provider>();
		for (const model of models.getAll()) {
			let provider = grouped.get(model.provider);
			if (!provider) {
				provider = { id: model.provider, name: model.provider, source: "api", env: [], options: {}, models: {} };
				grouped.set(model.provider, provider);
			}
			provider.models[model.id] = {
				id: model.id,
				providerID: model.provider,
				name: model.name,
				api: { id: model.id, url: model.baseUrl, npm: "omp" },
				capabilities: {
					temperature: true,
					reasoning: model.reasoning,
					attachment: model.input.includes("image"),
					toolcall: true,
					input: { text: true, image: model.input.includes("image"), audio: false, video: false, pdf: false },
					output: { text: true, image: false, audio: false, video: false, pdf: false },
					interleaved: false,
				},
				cost: {
					input: model.cost.input ?? 0,
					output: model.cost.output ?? 0,
					cache: { read: model.cost.cacheRead ?? 0, write: model.cost.cacheWrite ?? 0 },
				},
				limit: { context: model.contextWindow ?? 0, output: model.maxTokens ?? 0 },
				status: "active",
				options: {},
				headers: {},
				release_date: "",
			};
		}
		return [...grouped.values()];
	};
	const server = Bun.serve({
		port: options.port,
		hostname: "127.0.0.1",
		idleTimeout: 0,
		maxRequestBodySize: 8_000_000,
		async fetch(request) {
			// This private service is called by the browser server, never by browsers directly.
			if (request.headers.has("origin"))
				return Response.json({ error: "Browser access is forbidden" }, { status: 403 });
			const supplied = Buffer.from(request.headers.get("authorization") ?? "");
			if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
				return Response.json({ error: "Unauthorized" }, { status: 401 });
			const url = new URL(request.url);
			const directory = path.resolve(
				url.searchParams.get("directory") ?? request.headers.get("x-opencode-directory") ?? initialDirectory,
			);
			try {
				const route = decodeURIComponent(url.pathname);
				if (route === "/omp/small-model" && request.method === "POST")
					return await smallModelRequest(await requestBody(request), models, nativeSettings, request.signal);
				if (route === "/config" || route === "/global/config") {
					if (request.method === "PATCH") {
						const body = await requestBody(request);
						if (Object.keys(body).some(key => !["model", "small_model", "autoupdate"].includes(key)))
							throw new Error("Use OMP settings for this configuration field");
						if (body.autoupdate === true) throw new Error("Upstream updates are disabled in the Multivac fork");
						if (body.model !== undefined) nativeSettings.setModelRole("default", field(body, "model"));
						if (body.small_model !== undefined) nativeSettings.setModelRole("smol", field(body, "small_model"));
						await nativeSettings.flush();
					}
					return Response.json({
						model: nativeSettings.getModelRole("default"),
						small_model: nativeSettings.getModelRole("smol"),
						autoupdate: false,
					});
				}
				if (route === "/agent") {
					const { agents } = await discoverAgents(directory);
					return Response.json([
						{
							name: "build",
							description: "OMP coding agent",
							mode: "primary",
							native: true,
							options: {},
							permission: [],
						},
						...agents.map(agent => ({
							name: agent.name,
							description: agent.description,
							mode: "subagent",
							native: agent.source === "bundled",
							options: {},
							permission: [],
						})),
					]);
				}
				if (route === "/command")
					return Response.json(
						ACP_BUILTIN_SLASH_COMMANDS.map(command => ({
							name: command.name,
							description: command.description,
							template: `/${command.name} $ARGUMENTS`,
							source: "command",
						})),
					);
				if (route === "/skill") {
					const { skills } = await loadSkills({ cwd: directory });
					return Response.json(
						skills.map(skill => ({ name: skill.name, description: skill.description, location: skill.filePath })),
					);
				}
				if (route === "/provider/auth")
					return Response.json(
						Object.fromEntries(providers().map(provider => [provider.id, [{ type: "api", label: "API key" }]])),
					);
				if (route === "/global/health")
					return Response.json({ healthy: true, version: "18.1.18-multivac", runtime: "omp" });
				if (route === "/global/event" || route === "/event") {
					let unsubscribe = () => {};
					let timer: Timer | undefined;
					const stream = new ReadableStream({
						start(controller) {
							const send = (data: object) =>
								controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
							send(
								route === "/global/event"
									? { directory, payload: { type: "server.connected", properties: {} } }
									: { type: "server.connected", properties: {} },
							);
							unsubscribe = host.onEvent(event => {
								if (route === "/global/event") send(event);
								else if (event.directory === directory) send(event.payload);
							});
							timer = setInterval(() => controller.enqueue(new TextEncoder().encode(": heartbeat\n\n")), 15_000);
						},
						cancel() {
							unsubscribe();
							if (timer) clearInterval(timer);
						},
					});
					return new Response(stream, {
						headers: {
							"Content-Type": "text/event-stream",
							"Cache-Control": "no-cache",
							"X-Accel-Buffering": "no",
						},
					});
				}
				if (route === "/provider" || route === "/config/providers") {
					await auth.reload();
					const all = providers();
					const defaults = Object.fromEntries(all.map(provider => [provider.id, Object.keys(provider.models)[0]]));
					return Response.json(
						route === "/provider"
							? {
									all,
									default: defaults,
									connected: all.filter(provider => auth.hasAuth(provider.id)).map(provider => provider.id),
								}
							: { providers: all.filter(provider => auth.hasAuth(provider.id)), default: defaults },
					);
				}
				if (route === "/omp/pool") {
					const provider = url.searchParams.get("provider") ?? "opencode-go";
					if (request.method === "PUT") auth.setCredentialPoolSettings(provider, await requestBody(request));
					return Response.json(await auth.getCredentialPool(provider));
				}
				const providerSource = /^\/omp\/provider\/([^/]+)\/source$/.exec(route);
				if (providerSource && request.method === "GET") {
					await auth.reload();
					return Response.json({
						providerId: providerSource[1],
						sources: {
							auth: { exists: auth.hasAuth(providerSource[1]) },
							user: { exists: false },
							project: { exists: false },
						},
					});
				}
				const authRoute = /^\/auth\/([^/]+)$/.exec(route);
				if (authRoute) {
					if (request.method === "PUT") {
						const body = await requestBody(request);
						if (body.type !== "api") throw new Error("Use OMP login for OAuth credentials");
						const key = field(body, "key");
						if (!key?.trim()) throw new Error("API key required");
						auth.upsertCredential(authRoute[1], { type: "api_key", key, source: "login" });
						return Response.json(true);
					}
					if (request.method === "DELETE") {
						await auth.remove(authRoute[1]);
						return Response.json(true);
					}
				}
				const accountRoute = /^\/omp\/pool\/accounts\/(\d+)$/.exec(route);
				if (accountRoute && request.method === "PUT") {
					auth.setCredentialPoolAccount(
						url.searchParams.get("provider") ?? "opencode-go",
						Number(accountRoute[1]),
						await requestBody(request),
					);
					return Response.json(true);
				}
				if (route === "/omp/pool/accounts" && request.method === "POST") {
					const body = await requestBody(request);
					const key = field(body, "key");
					if (!key?.trim()) throw new Error("API key required");
					auth.upsertCredential("opencode-go", { type: "api_key", key, source: "login" });
					return Response.json(await auth.getCredentialPool("opencode-go"));
				}
				if (route === "/path")
					return Response.json({
						home: os.homedir(),
						state: dataDir,
						config: getAgentDir(),
						worktree: directory,
						directory,
					});
				if (route === "/session/status") return Response.json(host.status());
				if (route === "/question") return Response.json(host.questions());
				const question = /^\/question\/([^/]+)\/(reply|reject)$/.exec(route);
				if (question && request.method === "POST") {
					const body = await requestBody(request);
					const answers = body.answers;
					const value =
						Array.isArray(answers) && Array.isArray(answers[0]) && typeof answers[0][0] === "string"
							? answers[0][0]
							: undefined;
					host.answer(question[1], question[2] === "reject" ? undefined : value);
					return Response.json(true);
				}
				if (route === "/session" || route === "/experimental/session") {
					if (request.method === "GET")
						return Response.json(await host.list(url.searchParams.get("directory") ?? undefined));
					if (request.method === "POST") {
						const body = await requestBody(request);
						if (!(await fs.stat(directory)).isDirectory()) throw new Error("Invalid project directory");
						return Response.json(
							await host.create(directory, field(body, "title", true), field(body, "parentID", true)),
						);
					}
				}
				const sessionRoute = /^\/session\/([^/]+)(?:\/(.*))?$/.exec(route);
				if (sessionRoute) {
					const [, id, action] = sessionRoute;
					if (!action) {
						if (request.method === "DELETE") {
							await host.remove(id);
							return Response.json(true);
						}
						if (request.method === "PATCH") {
							const body = await requestBody(request);
							if (
								body.metadata !== undefined &&
								(!isRecord(body.metadata) || JSON.stringify(body.metadata).length > 262144)
							)
								throw new Error("Session metadata must be an object of at most 256 KiB");
							const archived =
								isRecord(body.time) && typeof body.time.archived === "number" ? body.time.archived : undefined;
							return Response.json(
								await host.update(id, {
									title: field(body, "title", true),
									time: { archived },
									metadata: isRecord(body.metadata) ? body.metadata : undefined,
								}),
							);
						}
						return Response.json(host.get(id));
					}
					if (action === "message" && request.method === "GET") return Response.json(await host.messages(id));
					if (action.startsWith("message/") && request.method === "GET") {
						const message = (await host.messages(id)).find(message => message.info.id === action.slice(8));
						return message
							? Response.json(message)
							: Response.json({ error: "Message not found" }, { status: 404 });
					}
					if ((action === "prompt_async" || action === "message") && request.method === "POST") {
						const body = await requestBody(request);
						const { text, images } = promptParts(body);
						const messageID = field(body, "messageID", true) ?? `msg_${crypto.randomUUID()}`;
						await host.prompt(id, text, modelInput(body), messageID, images);
						if (action === "message") {
							await host.waitForIdle(id, AbortSignal.any([request.signal, AbortSignal.timeout(30 * 60_000)]));
							const message = (await host.messages(id)).findLast(
								message => message.info.role === "assistant" && message.info.parentID === messageID,
							);
							if (!message) throw new Error("The command completed without an assistant message");
							return Response.json(message);
						}
						return new Response(null, { status: 204 });
					}
					if (action === "abort" && request.method === "POST") {
						const client = await host.client(id);
						await Promise.all([client.abort(), client.abortBash()]);
						return Response.json(true);
					}
					if (action === "fork" && request.method === "POST") {
						const info = host.get(id);
						const body = await requestBody(request);
						return Response.json(
							await host.create(info.directory, `${info.title} (fork)`, id, field(body, "messageID", true)),
						);
					}
					if (action === "children")
						return Response.json((await host.list()).filter(info => info.parentID === id));
					if (action === "todo") {
						const state = await (await host.client(id)).getState();
						return Response.json(
							state.todoPhases.flatMap(phase =>
								phase.tasks.map(task => ({ content: task.content, status: task.status, priority: "medium" })),
							),
						);
					}
					if (action === "summarize" && request.method === "POST") {
						await (await host.client(id)).compact();
						return Response.json(true);
					}
					if (action === "command" && request.method === "POST") {
						const body = await requestBody(request);
						await host.prompt(
							id,
							`/${field(body, "command")} ${field(body, "arguments", true) ?? ""}`,
							modelInput(body),
						);
						return new Response(null, { status: 204 });
					}
					if (action === "shell" && request.method === "POST") {
						const body = await requestBody(request);
						return Response.json(await host.shell(id, field(body, "command") ?? ""));
					}
				}
				if (route === "/project" || route === "/project/current") {
					const sessions = await host.list();
					const directories = [...new Set([directory, ...sessions.map(session => session.directory)])];
					const projects = directories.map(worktree => ({
						id: host.projectId(worktree),
						worktree,
						name: path.basename(worktree),
						time: { created: 0, updated: 0 },
						sandboxes: [],
					}));
					return Response.json(route === "/project/current" ? projects[0] : projects);
				}
				return Response.json(
					{
						name: "UnsupportedOperation",
						data: { message: `OMP adapter does not implement ${request.method} ${route}` },
					},
					{ status: 501 },
				);
			} catch (error) {
				if (
					error instanceof CredentialPoolExhaustedError ||
					(error instanceof RpcCommandError && error.code === "credential_pool_exhausted")
				) {
					return Response.json(
						{
							name: "CredentialPoolExhausted",
							code: "credential_pool_exhausted",
							data: { message: error.message },
						},
						{ status: 429 },
					);
				}
				// Provider bodies and credential inputs are deliberately not logged.
				const message =
					error instanceof RpcCommandError || (error instanceof Error && error.message.includes("Stderr:"))
						? "OMP runtime request failed. Check credential pool availability and server diagnostics."
						: error instanceof Error
							? error.message
							: "OMP request failed";
				return Response.json(
					{ name: "UnknownError", data: { message } },
					{ status: /not found/i.test(message) ? 404 : /busy/i.test(message) ? 409 : 400 },
				);
			}
		},
	});
	return {
		server,
		host,
		async close() {
			server.stop(true);
			await host.close();
			auth.close();
		},
	};
}
