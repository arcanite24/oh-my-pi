import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { startOpenChamberServer } from "../src/web/openchamber-server";
import { AgentStorage } from "../src/session/agent-storage";
import { RpcClient } from "../src/modes/rpc/rpc-client";
import { listAllSessions } from "../src/session/session-listing";
import { browserMessages } from "../src/web/openchamber-messages";
import { createAssistantMessage } from "./helpers/agent-session-setup";

test("browser messages preserve cancellation and truncation without exposing provider errors", () => {
	const session = {
		id: "test",
		slug: "test",
		projectID: "test",
		directory: ".",
		title: "test",
		version: "omp",
		time: { created: 1, updated: 1 },
	};
	const cancelled = browserMessages(session, [{ ...createAssistantMessage(""), stopReason: "aborted" }])[0].info;
	expect(cancelled).toMatchObject({ error: { name: "MessageAbortedError" } });
	const truncated = browserMessages(session, [{ ...createAssistantMessage("partial"), stopReason: "length" }])[0].info;
	expect(truncated).toMatchObject({ finish: "length" });
	const failed = browserMessages(session, [
		{ ...createAssistantMessage(""), stopReason: "error", errorMessage: "Authorization: secret-test-key" },
	]);
	expect(JSON.stringify(failed)).not.toContain("secret-test-key");
	expect(failed[0].info).toMatchObject({ error: { name: "UnknownError" } });
});

test("private browser adapter rejects bypasses and stores pool settings in isolated state", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-"));
	const password = crypto.randomUUID();
	const runtime = await startOpenChamberServer({ port: 0, password, dataDir: directory, command: [process.execPath] });
	const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
	const request = (route: string, init: RequestInit = {}) => fetch(`${runtime.server.url}${route.slice(1)}`, init);
	try {
		for (const route of ["/global/health", "/global/event", "/session", "/omp/pool"]) {
			expect((await request(route)).status).toBe(401);
			expect((await request(route, { headers: { "x-forwarded-email": "owner@example.test" } })).status).toBe(401);
		}
		expect(
			(
				await request("/omp/pool", {
					method: "PUT",
					headers: { authorization, origin: "https://attacker.test" },
					body: "{}",
				})
			).status,
		).toBe(403);
		expect((await request("/%E0%A4%A", { headers: { authorization } })).status).toBe(400);
		expect((await request("/global/health", { headers: { authorization } })).status).toBe(200);
		const saved = await request("/omp/pool", {
			method: "PUT",
			headers: { authorization },
			body: JSON.stringify({ policy: "round-robin", thresholds: { weekly: 95 } }),
		});
		expect(saved.status).toBe(200);
		const read = await request("/omp/pool", { headers: { authorization } });
		expect(await read.json()).toMatchObject({ settings: { policy: "round-robin", thresholds: { weekly: 95 } } });
		expect((await fs.stat(path.join(directory, "agent.db"))).isFile()).toBe(true);
	} finally {
		await runtime.close();
		AgentStorage.close();
		await removeWithRetries(directory);
	}
});

test("browser host persists sessions and runs local RPC commands without model requests", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-rpc-"));
	await fs.writeFile(
		path.join(directory, "models.yml"),
		JSON.stringify({ providers: { openai: { apiKey: "test-only-key", baseUrl: "http://127.0.0.1:1/v1" } } }),
	);
	const runtime = await startOpenChamberServer({
		port: 0,
		password: crypto.randomUUID(),
		dataDir: directory,
		command: [process.execPath, path.resolve(import.meta.dir, "../src/cli.ts")],
	});
	try {
		const info = await runtime.host.create(directory, "RPC test");
		const client = await runtime.host.client(info.id);
		const [stored] = await listAllSessions(undefined, path.join(directory, "sessions"));
		expect(stored).toBeDefined();
		const competing = new RpcClient({
			command: [process.execPath, path.resolve(import.meta.dir, "../src/cli.ts")],
			cwd: directory,
			env: { PI_CODING_AGENT_DIR: directory },
			args: ["--session", stored.path],
		});
		try {
			await expect(competing.start()).rejects.toThrow("busy in another process");
		} finally {
			await competing.stop();
		}
		expect((await client.getState()).isStreaming).toBe(false);
		expect(await runtime.host.messages(info.id)).toEqual([]);
		await runtime.host.update(info.id, { title: "Renamed" });
		expect((await runtime.host.list(directory))[0]?.title).toBe("Renamed");
		const shell = await runtime.host.shell(info.id, "echo omp-shell-test");
		expect(shell.parts).toContainEqual(
			expect.objectContaining({
				type: "tool",
				state: expect.objectContaining({ status: "completed", output: expect.stringContaining("omp-shell-test") }),
			}),
		);
		expect((await runtime.host.messages(info.id)).at(-1)).toEqual(shell);
		await runtime.host.prompt(info.id, "/session info");
		expect(runtime.host.status()[info.id]).toEqual({ type: "idle" });
		await runtime.host.remove(info.id);
		expect(await runtime.host.list(directory)).toEqual([]);
	} finally {
		await runtime.close();
		AgentStorage.close();
		await removeWithRetries(directory);
	}
}, 60_000);

test("synchronous browser requests preserve late quota failures", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-quota-"));
	const envFile = path.join(directory, "fixture.env");
	await fs.writeFile(envFile, "MOCK_RPC_LATE_PROMPT_ERROR=1\nMOCK_RPC_LATE_PROMPT_CODE=credential_pool_exhausted\n");
	const password = crypto.randomUUID();
	const runtime = await startOpenChamberServer({
		port: 0,
		password,
		dataDir: directory,
		command: [process.execPath, `--env-file=${envFile}`, path.join(import.meta.dir, "fixtures/mock-rpc-agent.ts")],
	});
	try {
		const session = await runtime.host.create(directory, "Quota failure");
		const response = await fetch(new URL(`/session/${session.id}/message`, runtime.server.url), {
			method: "POST",
			headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
			body: JSON.stringify({ parts: [{ type: "text", text: "test" }] }),
		});
		expect(response.status).toBe(429);
		expect(await response.json()).toMatchObject({
			code: "credential_pool_exhausted",
			data: { message: "fixture quota failure" },
		});
		await expect(runtime.host.waitForIdle(session.id, AbortSignal.timeout(1000))).rejects.toThrow(
			"fixture quota failure",
		);
	} finally {
		await runtime.close();
		AgentStorage.close();
		await removeWithRetries(directory);
	}
});

test("streaming survives subscriber disconnect and client message IDs remain authoritative", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-stream-"));
	let requests = 0;
	let nextTool: { name: string; arguments: string } | undefined;
	const queuedTools: { name: string; arguments: string }[] = [];
	let holdNext = false;
	const heldRequest = Promise.withResolvers<void>();
	const provider = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			requests++;
			const input = await request.text();
			const toolCall = input.includes("Nested test worker") ? queuedTools.shift() : nextTool;
			if (toolCall === nextTool) nextTool = undefined;
			const chunk = {
				id: "chatcmpl-test",
				object: "chat.completion.chunk",
				created: 1,
				model: "test",
				choices: [
					{
						index: 0,
						delta: toolCall
							? {
									role: "assistant",
									tool_calls: [
										{
											index: 0,
											id: `call_${requests}`,
											type: "function",
											function: toolCall,
										},
									],
								}
							: { role: "assistant", content: "Hello from OMP" },
						finish_reason: null,
					},
				],
			};
			if (holdNext) {
				holdNext = false;
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
							heldRequest.resolve();
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				);
			}
			return new Response(
				`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: toolCall ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\ndata: [DONE]\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	await fs.writeFile(
		path.join(directory, "models.yml"),
		JSON.stringify({
			providers: {
				probe: {
					api: "openai-completions",
					apiKey: "test-only-key",
					baseUrl: `${provider.url}v1`,
					models: [
						{
							id: "test",
							name: "Test",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 1024,
						},
					],
				},
			},
		}),
	);
	const options = {
		port: 0,
		password: crypto.randomUUID(),
		dataDir: directory,
		command: [process.execPath, path.resolve(import.meta.dir, "../src/cli.ts")],
	};
	await fs.writeFile(
		path.join(directory, "config.yml"),
		JSON.stringify({
			tools: { approval: { bash: "prompt" } },
			task: { maxRecursionDepth: 3 },
			async: { enabled: false },
		}),
	);
	await fs.mkdir(path.join(directory, ".omp", "agents"), { recursive: true });
	await fs.writeFile(
		path.join(directory, ".omp", "agents", "nester.md"),
		'---\nname: nester\ndescription: Nested task test\nspawns: "*"\n---\nNested test worker.',
	);
	const runtime = await startOpenChamberServer(options);
	try {
		const info = await runtime.host.create(directory);
		const idle = Promise.withResolvers<void>();
		const unsubscribe = runtime.host.onEvent(event => {
			if (
				event.payload.type === "session.status" &&
				"status" in event.payload.properties &&
				(event.payload.properties.status as { type: string }).type === "busy"
			) {
				void runtime.host.update(info.id, {
					metadata: { openchamber: { goal: { id: "test-goal", status: "paused" } } },
				});
			}
			if (event.payload.type === "session.idle") idle.resolve();
		});
		const browserDisconnect = runtime.host.onEvent(() => {});
		await runtime.host.prompt(info.id, "Say hello", { providerID: "probe", modelID: "test" }, "msg_browser_request");
		browserDisconnect();
		await idle.promise;
		unsubscribe();
		const messages = await runtime.host.messages(info.id);
		expect(runtime.host.get(info.id).metadata).toEqual({
			openchamber: { goal: { id: "test-goal", status: "paused" } },
		});
		expect(messages[0]?.info.id).toBe("msg_browser_request");
		expect(messages.at(-1)?.parts).toContainEqual(expect.objectContaining({ type: "text", text: "Hello from OMP" }));
		await runtime.host.prompt(info.id, "Say hello", { providerID: "probe", modelID: "test" }, "msg_browser_request");
		expect(requests).toBe(1);
		const parentIdle = Promise.withResolvers<void>();
		const childIdle = Promise.withResolvers<void>();
		const idleChildren = new Set<string>();
		const childEvents = runtime.host.onEvent(event => {
			if (event.payload.type !== "session.idle" || !("sessionID" in event.payload.properties)) return;
			if (event.payload.properties.sessionID === info.id) parentIdle.resolve();
			else if (typeof event.payload.properties.sessionID === "string") {
				idleChildren.add(event.payload.properties.sessionID);
				if (idleChildren.size === 2) childIdle.resolve();
			}
		});
		nextTool = { name: "task", arguments: JSON.stringify({ agent: "nester", task: "Return child probe response" }) };
		queuedTools.push({
			name: "task",
			arguments: JSON.stringify({ agent: "task", task: "Return nested probe response" }),
		});
		await runtime.host.prompt(
			info.id,
			"Run subagent test",
			{ providerID: "probe", modelID: "test" },
			"msg_child_test",
		);
		await Promise.all([parentIdle.promise, childIdle.promise]);
		childEvents();
		const children = (await runtime.host.list()).filter(child => child.parentID === info.id);
		expect(children).toHaveLength(1);
		const grandchildren = (await runtime.host.list()).filter(child => child.parentID === children[0].id);
		expect(grandchildren).toHaveLength(1);
		expect(grandchildren[0].metadata).toMatchObject({ ompSubagent: { status: "completed" } });
		expect(children[0].metadata).toMatchObject({ ompSubagent: { status: "completed" } });
		expect(runtime.host.status()[children[0].id]).toEqual({ type: "idle" });
		expect((await runtime.host.messages(children[0].id)).at(-1)?.parts).toContainEqual(
			expect.objectContaining({ type: "text", text: "Hello from OMP" }),
		);
		await runtime.host.waitForIdle(info.id, AbortSignal.timeout(10_000));
		const questionSeen = Promise.withResolvers<void>();
		const answeredIdle = Promise.withResolvers<void>();
		const questionEvents = runtime.host.onEvent(event => {
			if (
				event.payload.type === "question.asked" &&
				"id" in event.payload.properties &&
				typeof event.payload.properties.id === "string"
			) {
				expect(runtime.host.questions()).toHaveLength(1);
				runtime.host.answer(event.payload.properties.id, "Yes");
				questionSeen.resolve();
			}
			if (event.payload.type === "session.idle") answeredIdle.resolve();
		});
		nextTool = {
			name: "ask",
			arguments: JSON.stringify({
				questions: [{ id: "choice", question: "Proceed with test?", options: [{ label: "Yes" }, { label: "No" }] }],
			}),
		};
		await runtime.host.prompt(
			info.id,
			"Ask a question",
			{ providerID: "probe", modelID: "test" },
			"msg_question_test",
		);
		await Promise.all([questionSeen.promise, answeredIdle.promise]);
		questionEvents();
		expect(runtime.host.questions()).toEqual([]);
		const approvalSeen = Promise.withResolvers<void>();
		const declinedIdle = Promise.withResolvers<void>();
		const approvalEvents = runtime.host.onEvent(event => {
			if (
				event.payload.type === "question.asked" &&
				"id" in event.payload.properties &&
				typeof event.payload.properties.id === "string"
			) {
				runtime.host.answer(event.payload.properties.id, "No");
				approvalSeen.resolve();
			}
			if (event.payload.type === "session.idle") declinedIdle.resolve();
		});
		nextTool = { name: "bash", arguments: JSON.stringify({ command: "echo forbidden > denied.txt" }) };
		await runtime.host.prompt(
			info.id,
			"Test a declined approval",
			{ providerID: "probe", modelID: "test" },
			"msg_approval_test",
		);
		await Promise.all([approvalSeen.promise, declinedIdle.promise]);
		approvalEvents();
		expect(await Bun.file(path.join(directory, "denied.txt")).exists()).toBe(false);
		holdNext = true;
		await runtime.host.prompt(
			info.id,
			"Test cancellation",
			{ providerID: "probe", modelID: "test" },
			"msg_cancel_test",
		);
		await heldRequest.promise;
		await (await runtime.host.client(info.id)).abort();
		await runtime.host.waitForIdle(info.id, AbortSignal.timeout(10_000));
		expect((await runtime.host.messages(info.id)).at(-1)?.info).toMatchObject({
			error: { name: "MessageAbortedError" },
		});
		const utility = (body: object) =>
			fetch(new URL("omp/small-model", runtime.server.url), {
				method: "POST",
				headers: { authorization: `Basic ${Buffer.from(`opencode:${options.password}`).toString("base64")}` },
				body: JSON.stringify({ model: "probe/test", ...body }),
			});
		expect(await (await utility({ action: "describe", maxOutputTokens: 100 })).json()).toMatchObject({
			providerID: "probe",
			modelID: "test",
			outputTokens: 100,
		});
		expect(await (await utility({ action: "generate", prompt: "Utility test" })).json()).toMatchObject({
			text: "Hello from OMP",
		});
		nextTool = { name: "respond", arguments: JSON.stringify({ result: { verdict: "continue" } }) };
		expect(
			await (
				await utility({
					action: "generate",
					prompt: "Audit test",
					responseSchema: {
						type: "object",
						properties: { verdict: { type: "string", enum: ["continue"] } },
						required: ["verdict"],
					},
				})
			).json(),
		).toMatchObject({ text: '{"verdict":"continue"}' });
		const finalMessages = await runtime.host.messages(info.id);
		await runtime.close();
		const restarted = await startOpenChamberServer(options);
		try {
			expect(await restarted.host.messages(info.id)).toEqual(finalMessages);
			expect(restarted.host.get(info.id).metadata).toEqual({
				openchamber: { goal: { id: "test-goal", status: "paused" } },
			});
		} finally {
			await restarted.close();
		}
	} finally {
		await runtime.close();
		provider.stop(true);
		AgentStorage.close();
		await removeWithRetries(directory);
	}
}, 60_000);
