import { Database } from "bun:sqlite";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { getAgentDir, getSessionsDir, isRecord } from "@oh-my-pi/pi-utils";
import type { Session } from "@opencode-ai/sdk/v2";
import type { LspServerStatus } from "../lsp/client";
import { RpcClient, RpcCommandError } from "../modes/rpc/rpc-client";
import type { RpcAvailableSlashCommand, RpcExtensionUIRequest, RpcExtensionUIResponse } from "../modes/rpc/rpc-types";
import { buildSessionContext } from "../session/session-context";
import { loadSessionFile } from "../session/session-loader";
import { listAllSessions } from "../session/session-listing";
import { SessionManager } from "../session/session-manager";
import { discoverAgents } from "../task/discovery";
import { browserMessageId, browserMessages, type BrowserMessage, type BrowserPromptPart } from "./openchamber-messages";

interface StoredSession {
	id: string;
	file: string;
	info: string;
	deleted: number;
	browser_created: number;
}
interface LiveSession {
	client: RpcClient;
	messages: AgentMessage[];
	busy: boolean;
	pending: Map<string, RpcExtensionUIRequest>;
	pendingMessageID?: string;
	pendingParts?: BrowserPromptPart[];
	pendingInput?: { id: string; text: string; parts?: BrowserPromptPart[]; created: number };
}
export interface BrowserEvent {
	directory: string;
	payload: { type: string; properties: object };
}
export interface LegacySessionGuard {
	processIds: number[];
}

export function parseLegacySessionGuard(value: unknown): LegacySessionGuard {
	if (
		!isRecord(value) ||
		!Array.isArray(value.processIds) ||
		value.processIds.some(pid => !Number.isSafeInteger(pid) || pid <= 0)
	)
		throw new Error("Invalid legacy session guard");
	return { processIds: value.processIds };
}

/** Owns RPC processes independently of browser connections; transcripts remain OMP files. */
export class OpenChamberHost {
	#db: Database;
	#live = new Map<string, LiveSession>();
	#starting = new Map<string, Promise<LiveSession>>();
	#submitting = new Set<string>();
	#closing = false;
	#closePromise?: Promise<void>;
	#failures = new Map<string, Error>();
	#children = new Map<string, { parentID: string; busy: boolean; messages: AgentMessage[] }>();
	#listeners = new Set<(event: BrowserEvent) => void>();
	constructor(
		readonly command: string[],
		dbPath = path.join(getAgentDir(), "openchamber.db"),
		readonly agentDir = getAgentDir(),
		readonly legacyGuard?: LegacySessionGuard,
	) {
		if (legacyGuard) parseLegacySessionGuard(legacyGuard);
		this.#db = new Database(dbPath, { create: true });
		this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
			CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, file TEXT NOT NULL, info TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
			CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS command_outputs(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, message TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS message_agents(session_id TEXT NOT NULL, native_id TEXT NOT NULL, agent TEXT NOT NULL, PRIMARY KEY(session_id,native_id));
			CREATE TABLE IF NOT EXISTS message_ids(session_id TEXT NOT NULL, native_id TEXT NOT NULL, client_id TEXT NOT NULL, PRIMARY KEY(session_id,native_id));
			CREATE TABLE IF NOT EXISTS message_parts(session_id TEXT NOT NULL, native_id TEXT NOT NULL, parts TEXT NOT NULL, PRIMARY KEY(session_id,native_id));`);
		this.#db
			.transaction(() => {
				if (
					!this.#db
						.query<{ name: string }, []>("PRAGMA table_info(sessions)")
						.all()
						.some(column => column.name === "browser_created")
				)
					this.#db.exec("ALTER TABLE sessions ADD COLUMN browser_created INTEGER NOT NULL DEFAULT 0");
			})
			.immediate();
	}
	onEvent(listener: (event: BrowserEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}
	emit(session: Session, type: string, properties: object): void {
		for (const listener of this.#listeners) listener({ directory: session.directory, payload: { type, properties } });
	}
	#row(id: string): StoredSession {
		const row = this.#db
			.query<StoredSession, [string]>("SELECT * FROM sessions WHERE id = ? AND deleted = 0")
			.get(id);
		if (!row) throw new Error("Session not found");
		return row;
	}
	get(id: string): Session {
		return JSON.parse(this.#row(id).info) as Session;
	}
	#save(info: Session, file?: string): void {
		if (file)
			this.#db.run(
				"INSERT INTO sessions(id,file,info) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET info=excluded.info,file=excluded.file",
				[info.id, file, JSON.stringify(info)],
			);
		else this.#db.run("UPDATE sessions SET info=? WHERE id=?", [JSON.stringify(info), info.id]);
	}
	async list(directory?: string): Promise<Session[]> {
		for (const entry of await listAllSessions(undefined, getSessionsDir(this.agentDir))) {
			const existing = this.#db.query("SELECT id FROM sessions WHERE id=? OR file=?").get(entry.id, entry.path);
			if (existing) continue;
			const info: Session = {
				id: entry.id,
				slug: entry.id,
				projectID: this.projectId(entry.cwd),
				directory: entry.cwd,
				title: entry.title ?? (entry.firstMessage.slice(0, 100) || "OMP session"),
				version: "omp",
				time: { created: entry.created.getTime(), updated: entry.modified.getTime() },
			};
			this.#save(info, entry.path);
		}
		return this.#db
			.query<{ info: string }, []>("SELECT info FROM sessions WHERE deleted=0")
			.all()
			.map(row => JSON.parse(row.info) as Session)
			.filter(info => !directory || path.resolve(info.directory) === path.resolve(directory))
			.sort((a, b) => b.time.updated - a.time.updated);
	}
	projectId(directory: string): string {
		return Bun.hash(path.resolve(directory).toLowerCase()).toString(16);
	}
	async create(directory: string, title = "New session", parentID?: string, messageID?: string): Promise<Session> {
		const selected =
			parentID && messageID
				? (await this.messages(parentID)).find(message => message.info.id === messageID)
				: undefined;
		if (messageID && !selected) throw new Error("Fork message not found");
		const sessionDir = SessionManager.getDefaultSessionDir(directory, this.agentDir);
		const manager = parentID
			? await SessionManager.forkFrom(this.#row(parentID).file, directory, sessionDir)
			: SessionManager.create(directory, sessionDir);
		try {
			if (selected) {
				const entry = manager
					.getEntries()
					.findLast(
						entry =>
							entry.type === "message" &&
							entry.message.timestamp === selected.info.time.created &&
							entry.message.role === selected.info.role,
					);
				if (!entry) throw new Error("Fork entry not found");
				manager.branch(entry.id);
			}
			await manager.ensureOnDisk();
			await manager.setSessionName(title, "user");
			const file = manager.getSessionFile();
			if (!file) throw new Error("Session file was not created");
			const info: Session = {
				id: manager.getSessionId(),
				slug: manager.getSessionId(),
				projectID: this.projectId(directory),
				directory,
				title,
				version: "omp",
				parentID,
				agent: parentID ? this.get(parentID).agent : undefined,
				time: { created: Date.now(), updated: Date.now() },
			};
			this.#save(info, file);
			this.#db.run("UPDATE sessions SET browser_created=1 WHERE id=?", [info.id]);
			if (parentID) {
				this.#db.run("INSERT INTO message_agents SELECT ?,native_id,agent FROM message_agents WHERE session_id=?", [
					info.id,
					parentID,
				]);
				this.#db.run("INSERT INTO message_parts SELECT ?,native_id,parts FROM message_parts WHERE session_id=?", [
					info.id,
					parentID,
				]);
			}
			this.emit(info, "session.created", { info });
			return info;
		} finally {
			await manager.close();
		}
	}
	async messages(id: string): Promise<BrowserMessage[]> {
		const info = this.get(id);
		const child = this.#children.get(id);
		if (child?.busy) {
			const messages = await this.#transcript(id);
			for (const current of child.messages) {
				const index = messages.findLastIndex(
					message => message.timestamp === current.timestamp && message.role === current.role,
				);
				if (index < 0) messages.push(current);
				else messages[index] = current;
			}
			return this.#convert(info, messages, true);
		}
		const live = this.#live.get(id);
		if (live?.busy) return this.#convert(info, live.messages, true);
		const messages = await this.#transcript(id);
		if (live) live.messages = messages;
		return this.#convert(info, messages);
	}
	#convert(info: Session, messages: AgentMessage[], streaming = false): BrowserMessage[] {
		const ids = this.#db
			.query<{ native_id: string; client_id: string }, [string]>(
				"SELECT native_id,client_id FROM message_ids WHERE session_id=?",
			)
			.all(info.id);
		const clientIds = new Map(ids.map(row => [row.native_id, row.client_id]));
		const converted = browserMessages(info, messages, streaming, clientIds);
		const displayParts = new Map(
			this.#db
				.query<{ native_id: string; parts: string }, [string]>(
					"SELECT native_id,parts FROM message_parts WHERE session_id=?",
				)
				.all(info.id)
				.map(row => [
					clientIds.get(row.native_id) ?? `${row.native_id}_${info.id}`,
					JSON.parse(row.parts) as BrowserPromptPart[],
				]),
		);
		for (const message of converted) {
			const parts = displayParts.get(message.info.id);
			if (message.info.role === "user" && parts)
				message.parts = parts.map((part, index) => ({
					...part,
					id: `prt_${message.info.id.slice(4)}_${index}`,
					messageID: message.info.id,
					sessionID: info.id,
				}));
		}
		const agents = new Map(
			this.#db
				.query<{ native_id: string; agent: string }, [string]>(
					"SELECT native_id,agent FROM message_agents WHERE session_id=?",
				)
				.all(info.id)
				.map(row => [clientIds.get(row.native_id) ?? `${row.native_id}_${info.id}`, row.agent]),
		);
		for (const message of converted) {
			message.info.agent = agents.get(message.info.id) ?? (info.parentID ? info.agent : undefined) ?? "build";
			if (message.info.role === "assistant") message.info.mode = message.info.agent;
		}
		const children = this.#db
			.query<{ info: string }, [string]>(
				"SELECT info FROM sessions WHERE deleted=0 AND json_extract(info,'$.parentID')=?",
			)
			.all(info.id);
		for (const row of children) {
			const child = JSON.parse(row.info) as Session;
			const details = child.metadata?.ompSubagent;
			if (!isRecord(details) || typeof details.parentToolCallId !== "string") continue;
			for (const message of converted)
				for (const part of message.parts) {
					if (
						part.type === "tool" &&
						part.callID === details.parentToolCallId &&
						part.state.status !== "pending"
					) {
						const metadata = part.state.metadata;
						const sessionIDs = Array.isArray(metadata?.sessionIDs)
							? metadata.sessionIDs.filter((value): value is string => typeof value === "string")
							: [];
						if (!sessionIDs.includes(child.id)) sessionIDs.push(child.id);
						part.state.metadata = { ...metadata, sessionID: sessionIDs[0], sessionIDs };
					}
				}
		}
		for (const row of this.#db
			.query<{ message: string }, [string]>("SELECT message FROM command_outputs WHERE session_id=?")
			.all(info.id))
			converted.push(JSON.parse(row.message) as BrowserMessage);
		return converted.sort((a, b) => a.info.time.created - b.info.time.created);
	}
	async #transcript(id: string): Promise<AgentMessage[]> {
		const loaded = await loadSessionFile(this.#row(id).file);
		if (loaded.invalidHeader) throw new Error("Session transcript is invalid");
		const entries = loaded.entries.filter(entry => entry.type !== "session");
		return buildSessionContext(entries, undefined, undefined, { transcript: true, keepDanglingToolCalls: true })
			.messages;
	}
	status(): Record<string, { type: "busy" | "idle" }> {
		return Object.fromEntries([
			...[...this.#live, ...this.#children].map(([id, live]) => [id, { type: live.busy ? "busy" : "idle" }]),
			...[...this.#submitting].map(id => [id, { type: "busy" }]),
		]);
	}
	async client(id: string): Promise<RpcClient> {
		return (await this.#ensureLive(id)).client;
	}
	async lspStatus(directory: string): Promise<(LspServerStatus & { id: string })[]> {
		const matches = (id: string) => path.relative(this.get(id).directory, directory) === "";
		await Promise.all([...this.#starting].filter(([id]) => matches(id)).map(([, pending]) => pending));
		const snapshots = await Promise.all(
			[...this.#live]
				.filter(([id]) => matches(id))
				.map(async ([id, live]) =>
					(await live.client.getLspStatus()).map((server, index) => ({ ...server, id: `${id}:${index}` })),
				),
		);
		return snapshots.flat();
	}
	async commands(directory: string): Promise<RpcAvailableSlashCommand[]> {
		for (const [id, live] of this.#live) {
			if (path.resolve(this.get(id).directory) === path.resolve(directory))
				return live.client.getAvailableCommands();
		}
		const client = new RpcClient({
			command: this.command,
			ui: true,
			cwd: directory,
			args: ["--no-session"],
			env: { PI_CODING_AGENT_DIR: this.agentDir },
		});
		try {
			await client.start();
			return await client.getAvailableCommands();
		} finally {
			await client.stop();
		}
	}
	async waitForIdle(id: string, signal: AbortSignal): Promise<void> {
		const failure = this.#failures.get(id);
		if (failure) throw failure;
		if (!this.#live.get(id)?.busy) return;
		signal.throwIfAborted();
		await new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				unsubscribe();
				signal.removeEventListener("abort", abort);
			};
			const abort = () => {
				cleanup();
				reject(signal.reason);
			};
			const unsubscribe = this.onEvent(event => {
				if (
					event.payload.type === "session.idle" &&
					"sessionID" in event.payload.properties &&
					event.payload.properties.sessionID === id
				) {
					cleanup();
					resolve();
				}
			});
			signal.addEventListener("abort", abort, { once: true });
		});
		const completedFailure = this.#failures.get(id);
		if (completedFailure) throw completedFailure;
	}
	async #ensureLive(id: string, agent?: string): Promise<LiveSession> {
		if (this.#closing) throw new Error("Browser host is closing");
		if (this.#children.get(id)?.busy) throw new Error("Subagent is busy; control it through its parent session");
		const pending = this.#starting.get(id);
		if (pending) {
			await pending;
			return this.#ensureLive(id, agent);
		}
		const existing = this.#live.get(id);
		if (existing && (agent === undefined || agent === (this.get(id).agent ?? "build"))) return existing;
		if (existing?.busy) throw new Error("Session is busy; wait before changing agents");
		if (!existing && this.legacyGuard && this.#row(id).browser_created !== 1) {
			const legacyRunning = this.legacyGuard.processIds.some(pid => {
				try {
					process.kill(pid, 0);
					return true;
				} catch (error) {
					return !isRecord(error) || error.code !== "ESRCH";
				}
			});
			if (legacyRunning)
				throw new Error(
					"Session is protected while legacy OMP processes are running; create a new browser session or wait for them to finish",
				);
		}
		const promise = this.#start(id, agent);
		this.#starting.set(id, promise);
		try {
			return await promise;
		} finally {
			this.#starting.delete(id);
		}
	}
	async #start(id: string, agent?: string): Promise<LiveSession> {
		const info = this.get(id);
		if (agent !== undefined) info.agent = agent;
		const selectedAgent = info.agent ?? "build";
		const { agents } = await discoverAgents(info.directory);
		const hasDefinition = agents.some(definition => definition.name === selectedAgent);
		if (!hasDefinition && selectedAgent !== "build") throw new Error("Unknown agent definition");
		const existing = this.#live.get(id);
		if (existing) {
			for (const child of this.#children.values()) {
				if (!child.busy) continue;
				let parentID: string | undefined = child.parentID;
				while (parentID) {
					if (parentID === id) throw new Error("Subagents are running; wait before changing agents");
					parentID = this.#children.get(parentID)?.parentID;
				}
			}
			await existing.client.stop();
			this.#live.delete(id);
		}
		const row = this.#row(id);
		const client = new RpcClient({
			command: this.command,
			ui: true,
			cwd: info.directory,
			args: ["--session", row.file, ...(hasDefinition ? ["--agent-definition", selectedAgent] : [])],
			env: { PI_CODING_AGENT_DIR: this.agentDir },
		});
		const live: LiveSession = { client, messages: [], busy: false, pending: new Map() };
		client.onFailure((kind, poolMessage) => {
			const message =
				poolMessage ??
				(kind === "transport"
					? "OMP worker stopped. Reload session history before continuing."
					: "OMP could not complete the request. Check credential pool availability before continuing.");
			this.#failures.set(
				id,
				poolMessage ? new RpcCommandError(message, "prompt", "credential_pool_exhausted") : new Error(message),
			);
			live.busy = false;
			live.pendingMessageID = undefined;
			for (const requestID of live.pending.keys())
				this.emit(info, "question.rejected", { sessionID: id, requestID });
			live.pending.clear();
			if (kind === "transport") {
				this.#live.delete(id);
				for (const [childID, child] of this.#children)
					if (child.parentID === id && child.busy) {
						child.busy = false;
						this.emit(info, "session.status", { sessionID: childID, status: { type: "idle" } });
					}
			}
			// RPC stderr and provider errors may contain secrets; expose only a safe category.
			this.emit(info, "session.error", {
				sessionID: id,
				error: {
					name: "UnknownError",
					data: { message },
				},
			});
			this.emit(info, "session.status", { sessionID: id, status: { type: "idle" } });
			this.emit(info, "session.idle", { sessionID: id });
		});
		client.onCommandOutput(text => {
			const messageID = `msg_${crypto.randomUUID()}`;
			const now = Date.now();
			const message: BrowserMessage = {
				info: {
					id: messageID,
					sessionID: id,
					role: "assistant",
					parentID: live.pendingMessageID ?? "",
					agent: info.agent ?? "build",
					mode: info.agent ?? "build",
					providerID: "omp",
					modelID: "command",
					finish: "stop",
					path: { cwd: info.directory, root: info.directory },
					time: { created: now, completed: now },
					cost: 0,
					tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
				},
				parts: [{ id: `prt_${messageID}`, messageID, sessionID: id, type: "text", text }],
			};
			this.#db.run("INSERT INTO command_outputs VALUES(?,?,?)", [messageID, id, JSON.stringify(message)]);
			this.emit(info, "message.updated", { info: message.info });
			for (const part of message.parts) this.emit(info, "message.part.updated", { part });
		});
		client.onPromptResult(agentInvoked => {
			if (agentInvoked) return;
			const pending = live.pendingInput;
			if (pending) {
				const message: BrowserMessage = {
					info: {
						id: pending.id,
						sessionID: id,
						role: "user",
						model: {
							providerID: info.model?.providerID ?? "",
							modelID: info.model?.id ?? "",
						},
						time: { created: pending.created },
						agent: info.agent ?? "build",
					},
					parts: (pending.parts?.length ? pending.parts : [{ type: "text" as const, text: pending.text }]).map(
						(part, index) => ({
							...part,
							id: `prt_${pending.id.slice(4)}_${index}`,
							messageID: pending.id,
							sessionID: id,
						}),
					),
				};
				this.#db.run("INSERT OR REPLACE INTO command_outputs VALUES(?,?,?)", [
					pending.id,
					id,
					JSON.stringify(message),
				]);
			}
			live.pendingInput = undefined;
			live.pendingMessageID = undefined;
			live.pendingParts = undefined;
			live.busy = false;
			this.emit(info, "session.status", { sessionID: id, status: { type: "idle" } });
			this.emit(info, "session.idle", { sessionID: id });
		});
		client.onEvent(event => {
			if (event.type === "agent_start") live.busy = true;
			if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
				if (
					event.type === "message_start" &&
					(event.message.role === "user" || event.message.role === "assistant")
				) {
					const occurrence = live.messages.filter(
						message => message.role === event.message.role && message.timestamp === event.message.timestamp,
					).length;
					const messageID = browserMessageId(event.message, occurrence);
					this.#db.run("INSERT OR REPLACE INTO message_agents VALUES(?,?,?)", [
						id,
						messageID,
						info.agent ?? "build",
					]);
				}
				if (event.type === "message_start" && event.message.role === "user" && live.pendingMessageID) {
					const occurrence = live.messages.filter(
						message => message.role === "user" && message.timestamp === event.message.timestamp,
					).length;
					this.#db.run("INSERT OR REPLACE INTO message_ids VALUES(?,?,?)", [
						id,
						browserMessageId(event.message, occurrence),
						live.pendingMessageID,
					]);
					if (live.pendingParts)
						this.#db.run("INSERT OR REPLACE INTO message_parts VALUES(?,?,?)", [
							id,
							browserMessageId(event.message, occurrence),
							JSON.stringify(live.pendingParts),
						]);
					live.pendingMessageID = undefined;
					live.pendingParts = undefined;
					live.pendingInput = undefined;
				}
				const index =
					event.type === "message_start"
						? -1
						: live.messages.findLastIndex(
								message => message.timestamp === event.message.timestamp && message.role === event.message.role,
							);
				if (index < 0) live.messages.push(event.message);
				else live.messages[index] = event.message;
				const converted = this.#convert(this.get(id), live.messages, event.type !== "message_end");
				// Tool results update their parent assistant part; publish authoritative parts.
				for (const message of converted.slice(-2)) {
					this.emit(info, "message.updated", { info: message.info });
					for (const part of message.parts) this.emit(info, "message.part.updated", { part });
				}
			}
			if (event.type === "agent_end") {
				live.busy = false;
				const current = this.get(id);
				current.time.updated = Date.now();
				this.#save(current);
				this.emit(current, "session.updated", { info: current });
				this.emit(info, "session.idle", { sessionID: id });
			}
			if (event.type === "agent_start" || event.type === "agent_end")
				this.emit(info, "session.status", { sessionID: id, status: { type: live.busy ? "busy" : "idle" } });
		});
		client.onExtensionUiRequest(request => {
			if (request.method === "cancel") {
				live.pending.delete(request.targetId);
				this.emit(info, "question.rejected", { sessionID: id, requestID: request.targetId });
				return;
			}
			if (!["select", "confirm", "input", "editor"].includes(request.method)) {
				this.emit(info, "omp.extension.ui", { sessionID: id, request });
				return;
			}
			live.pending.set(request.id, request);
			this.emit(info, "question.asked", this.#question(id, request));
		});
		const childIds = new Map<string, string>();
		client.onSubagentLifecycle(payload => {
			const stored = payload.sessionFile
				? this.#db
						.query<{ id: string }, [string]>("SELECT id FROM sessions WHERE file=? AND deleted=0")
						.get(payload.sessionFile)
				: undefined;
			const childID =
				stored?.id ??
				(payload.sessionFile
					? `sub_${Bun.hash(path.resolve(payload.sessionFile)).toString(16)}`
					: childIds.get(payload.id));
			if (!childID) return;
			childIds.set(payload.id, childID);
			const previous = this.#children.get(childID);
			if (!payload.sessionFile && !previous) return;
			const parentID = (payload.parentAgentId && childIds.get(payload.parentAgentId)) || previous?.parentID || id;
			const child: Session =
				previous || stored
					? this.get(childID)
					: {
							id: childID,
							slug: childID,
							projectID: info.projectID,
							directory: info.directory,
							parentID,
							title: payload.description || payload.agent,
							agent: payload.agent,
							version: "omp",
							time: { created: Date.now(), updated: Date.now() },
						};
			child.metadata = {
				...child.metadata,
				ompSubagent: { nativeId: payload.id, parentToolCallId: payload.parentToolCallId, status: payload.status },
			};
			child.parentID = parentID;
			child.time.updated = Date.now();
			this.#save(child, payload.sessionFile);
			this.#db.run("UPDATE sessions SET browser_created=1 WHERE id=?", [childID]);
			this.#children.set(childID, {
				parentID,
				busy: payload.status === "started",
				messages: previous?.messages ?? [],
			});
			this.emit(child, previous || stored ? "session.updated" : "session.created", { info: child });
			const parent = this.get(parentID);
			const parentMessages = parentID === id ? live.messages : (this.#children.get(parentID)?.messages ?? []);
			for (const message of this.#convert(parent, parentMessages, true)) {
				for (const part of message.parts)
					if (part.type === "tool" && part.callID === payload.parentToolCallId)
						this.emit(parent, "message.part.updated", { part });
			}
			this.emit(child, "session.status", {
				sessionID: childID,
				status: { type: payload.status === "started" ? "busy" : "idle" },
			});
			if (payload.status !== "started") this.emit(child, "session.idle", { sessionID: childID });
		});
		client.onSubagentEvent(payload => {
			const childID = childIds.get(payload.id);
			if (!childID) return;
			const child = this.#children.get(childID);
			const event = payload.event;
			if (
				!child ||
				(event.type !== "message_start" && event.type !== "message_update" && event.type !== "message_end")
			)
				return;
			const index =
				event.type === "message_start"
					? -1
					: child.messages.findLastIndex(
							message => message.timestamp === event.message.timestamp && message.role === event.message.role,
						);
			if (index < 0) child.messages.push(event.message);
			else child.messages[index] = event.message;
			const childInfo = this.get(childID);
			for (const message of this.#convert(childInfo, child.messages, event.type !== "message_end").slice(-2)) {
				this.emit(childInfo, "message.updated", { info: message.info });
				for (const part of message.parts) this.emit(childInfo, "message.part.updated", { part });
			}
		});
		try {
			await client.start();
			if (this.#closing) throw new Error("Browser host is closing");
			live.messages = await this.#transcript(id);
			await client.setSubagentSubscription("events");
			const current = this.get(id);
			current.agent = info.agent;
			this.#save(current);
			this.#live.set(id, live);
			this.emit(current, "session.updated", { info: current });
			return live;
		} catch (error) {
			await client.stop();
			throw error;
		}
	}
	#question(id: string, request: RpcExtensionUIRequest): object {
		const title = "title" in request ? request.title : request.method;
		const options =
			"options" in request
				? request.options.map((option, index) => ({
						label: option,
						description: request.optionDetails?.[index]?.description ?? option,
					}))
				: request.method === "confirm"
					? [
							{ label: "Yes", description: "Confirm" },
							{ label: "No", description: "Decline" },
						]
					: [];
		return {
			id: request.id,
			sessionID: id,
			questions: [
				{ question: request.method === "confirm" ? `${title}\n${request.message}` : title, header: "OMP", options },
			],
		};
	}
	questions(): object[] {
		return [...this.#live].flatMap(([id, live]) =>
			[...live.pending.values()].map(request => this.#question(id, request)),
		);
	}
	answer(requestID: string, value?: string): void {
		for (const [id, live] of this.#live) {
			const request = live.pending.get(requestID);
			if (!request) continue;
			const response: RpcExtensionUIResponse =
				value === undefined
					? { type: "extension_ui_response", id: requestID, cancelled: true }
					: request.method === "confirm"
						? { type: "extension_ui_response", id: requestID, confirmed: value === "Yes" }
						: { type: "extension_ui_response", id: requestID, value };
			live.client.respondToExtensionUi(response);
			live.pending.delete(requestID);
			this.emit(this.get(id), value === undefined ? "question.rejected" : "question.replied", {
				sessionID: id,
				requestID,
				answers: [[value]],
			});
			return;
		}
		throw new Error("Question not found");
	}
	async prompt(
		id: string,
		text: string,
		model?: { providerID: string; modelID: string },
		requestID?: string,
		images?: ImageContent[],
		agent?: string,
		displayParts?: BrowserPromptPart[],
	): Promise<void> {
		if (requestID && this.#db.query("SELECT id FROM requests WHERE id=? AND session_id=?").get(requestID, id)) return;
		if (this.#submitting.has(id)) throw new Error("Session is busy submitting a request");
		const info = this.get(id);
		this.#submitting.add(id);
		this.emit(info, "session.status", { sessionID: id, status: { type: "busy" } });
		try {
			const live = await this.#ensureLive(id, agent);
			if (live.busy) throw new Error("Session is busy; steer or wait for the current turn");
			this.#failures.delete(id);
			live.busy = true;
			try {
				live.messages = await this.#transcript(id);
				if (model) {
					await live.client.setModel(model.providerID, model.modelID);
					const info = this.get(id);
					info.model = { providerID: model.providerID, id: model.modelID };
					this.#save(info);
				}
				if (requestID) this.#db.run("INSERT INTO requests VALUES(?,?)", [requestID, id]);
				live.pendingMessageID = requestID;
				live.pendingParts = displayParts;
				live.pendingInput = {
					id: requestID ?? `msg_${crypto.randomUUID()}`,
					text,
					parts: displayParts,
					created: Date.now(),
				};
				await live.client.prompt(text, images);
			} catch (error) {
				live.busy = false;
				// Do not retry ambiguous prompt delivery automatically.
				throw error;
			}
		} finally {
			this.#submitting.delete(id);
			this.emit(info, "session.status", { sessionID: id, status: this.status()[id] ?? { type: "idle" } });
		}
	}
	async update(
		id: string,
		update: { title?: string; time?: { archived?: number }; metadata?: Record<string, unknown> },
	): Promise<Session> {
		if (update.title !== undefined) {
			await (await this.client(id)).setSessionName(update.title);
		}
		const info = this.get(id);
		if (update.title !== undefined) info.title = update.title;
		if (update.metadata !== undefined) info.metadata = update.metadata;
		if (update.time?.archived !== undefined) info.time.archived = update.time.archived;
		info.time.updated = Date.now();
		this.#save(info);
		this.emit(info, "session.updated", { info });
		return info;
	}
	async shell(id: string, command: string): Promise<BrowserMessage> {
		const live = await this.#ensureLive(id);
		if (live.busy) throw new Error("Session is busy");
		live.busy = true;
		const info = this.get(id);
		this.emit(info, "session.status", { sessionID: id, status: { type: "busy" } });
		try {
			await live.client.bash(command);
			live.messages = await this.#transcript(id);
			const nativeMessage = live.messages.at(-1);
			if (nativeMessage?.role !== "bashExecution") throw new Error("Shell command did not produce a transcript");
			const occurrence =
				live.messages.filter(
					entry => entry.role === nativeMessage.role && entry.timestamp === nativeMessage.timestamp,
				).length - 1;
			const nativeID = browserMessageId(nativeMessage, occurrence);
			this.#db.run("INSERT OR REPLACE INTO message_agents VALUES(?,?,?)", [id, nativeID, info.agent ?? "build"]);
			const message = this.#convert(info, live.messages).find(entry => entry.info.id === `${nativeID}_${id}`);
			if (!message) throw new Error("Shell command did not produce a transcript");
			this.emit(info, "message.updated", { info: message.info });
			for (const part of message.parts) this.emit(info, "message.part.updated", { part });
			return message;
		} finally {
			live.busy = false;
			this.emit(info, "session.status", { sessionID: id, status: { type: "idle" } });
			this.emit(info, "session.idle", { sessionID: id });
		}
	}
	async remove(id: string): Promise<void> {
		if (this.#starting.has(id) || this.#submitting.has(id)) throw new Error("Session is busy starting a request");
		const info = this.get(id);
		const live = this.#live.get(id);
		if (live?.busy || this.#children.get(id)?.busy) throw new Error("Abort the active session before deleting it");
		if (live) await live.client.stop();
		this.#live.delete(id);
		this.#children.delete(id);
		this.#failures.delete(id);
		this.#db.run("UPDATE sessions SET deleted=1 WHERE id=?", [id]);
		this.emit(info, "session.deleted", { info });
	}
	close(): Promise<void> {
		this.#closing = true;
		return (this.#closePromise ??= this.#close());
	}
	async #close(): Promise<void> {
		await Promise.allSettled(this.#starting.values());
		await Promise.all([...this.#live.values()].map(live => live.client.stop()));
		this.#live.clear();
		this.#children.clear();
		this.#failures.clear();
		this.#db.close();
	}
}
