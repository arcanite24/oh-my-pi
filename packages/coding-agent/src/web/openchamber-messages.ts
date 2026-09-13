import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { FilePart, Message, Part, Session, TextPart } from "@opencode-ai/sdk/v2";

export type BrowserPromptPart =
	| Pick<TextPart, "type" | "text" | "synthetic">
	| Pick<FilePart, "type" | "mime" | "url" | "filename">;

export interface BrowserMessage {
	info: Message;
	parts: Part[];
}

/** Stable ids across streaming refreshes and persisted transcript reads. */
export function browserMessageId(message: AgentMessage, occurrence: number): string {
	return `msg_${message.timestamp.toString(16)}_${message.role}_${occurrence}`;
}

export function browserMessages(
	session: Session,
	messages: AgentMessage[],
	streaming = false,
	ids: ReadonlyMap<string, string> = new Map(),
): BrowserMessage[] {
	const output: BrowserMessage[] = [];
	const occurrences = new Map<string, number>();
	let parentID = "";
	const tools = new Map<string, Extract<Part, { type: "tool" }>>();
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message.role === "bashExecution") {
			const identity = `${message.timestamp}:${message.role}`;
			const occurrence = occurrences.get(identity) ?? 0;
			occurrences.set(identity, occurrence + 1);
			const id = `${browserMessageId(message, occurrence)}_${session.id}`;
			const time = { start: message.timestamp, end: message.timestamp };
			const input = { command: message.command };
			output.push({
				info: {
					id,
					sessionID: session.id,
					role: "assistant",
					parentID,
					agent: "build",
					mode: "build",
					providerID: "omp",
					modelID: "shell",
					path: { cwd: session.directory, root: session.directory },
					time: { created: message.timestamp, completed: message.timestamp },
					finish: "stop",
					cost: 0,
					tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
				},
				parts: [
					{
						id: `prt_${id}`,
						sessionID: session.id,
						messageID: id,
						type: "tool",
						callID: id,
						tool: "bash",
						state:
							message.cancelled || message.exitCode !== 0
								? {
										status: "error",
										input,
										error: message.cancelled ? "Command cancelled" : message.output,
										time,
									}
								: {
										status: "completed",
										input,
										output: message.output,
										title: message.command,
										metadata: { exitCode: message.exitCode, truncated: message.truncated },
										time,
									},
					},
				],
			});
			continue;
		}
		if (message.role === "toolResult") {
			const part = tools.get(message.toolCallId);
			if (part) {
				const text = message.content
					.filter(item => item.type === "text")
					.map(item => item.text)
					.join("\n");
				const time = {
					start: "time" in part.state ? part.state.time.start : message.timestamp,
					end: message.timestamp,
				};
				part.state = message.isError
					? { status: "error", input: part.state.input, error: text, time }
					: { status: "completed", input: part.state.input, output: text, title: part.tool, metadata: {}, time };
			}
			continue;
		}
		if (message.role !== "user" && message.role !== "assistant") continue;
		const identity = `${message.timestamp}:${message.role}`;
		const occurrence = occurrences.get(identity) ?? 0;
		occurrences.set(identity, occurrence + 1);
		const nativeId = browserMessageId(message, occurrence);
		const id = ids.get(nativeId) ?? `${nativeId}_${session.id}`;
		const base = { id, sessionID: session.id, time: { created: message.timestamp }, agent: "build" };
		const info: Message =
			message.role === "user"
				? {
						...base,
						role: "user",
						model: { providerID: session.model?.providerID ?? "", modelID: session.model?.id ?? "" },
					}
				: {
						...base,
						role: "assistant",
						parentID,
						providerID: message.provider,
						modelID: message.model,
						mode: "build",
						path: { cwd: session.directory, root: session.directory },
						cost: message.usage.cost.total,
						tokens: {
							input: message.usage.input,
							output: message.usage.output,
							reasoning: 0,
							cache: { read: message.usage.cacheRead, write: message.usage.cacheWrite },
						},
						...(!streaming || index !== messages.length - 1
							? {
									time: { created: message.timestamp, completed: message.timestamp },
									finish:
										message.stopReason === "toolUse"
											? "tool-calls"
											: message.stopReason === "length"
												? "length"
												: "stop",
								}
							: {}),
						...(message.stopReason === "aborted"
							? { error: { name: "MessageAbortedError" as const, data: { message: "Request cancelled" } } }
							: message.errorMessage || message.stopReason === "error"
								? {
										error: {
											name: "UnknownError" as const,
											data: {
												message:
													"Provider request failed. Check credential pool availability and the server diagnostics.",
											},
										},
									}
								: {}),
					};
		if (message.role === "user") parentID = id;
		const content =
			typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
		const parts: Part[] = [];
		for (let position = 0; position < content.length; position++) {
			const item = content[position];
			const partBase = { id: `prt_${id.slice(4)}_${position}`, messageID: id, sessionID: session.id };
			if (item.type === "text") parts.push({ ...partBase, type: "text", text: item.text });
			else if (item.type === "thinking")
				parts.push({ ...partBase, type: "reasoning", text: item.thinking, time: { start: message.timestamp } });
			else if (item.type === "image")
				parts.push({
					...partBase,
					type: "file",
					mime: item.mimeType,
					url: `data:${item.mimeType};base64,${item.data}`,
				});
			else if (item.type === "toolCall") {
				const part: Extract<Part, { type: "tool" }> = {
					...partBase,
					type: "tool",
					callID: item.id,
					tool: item.name,
					state: { status: "running", input: item.arguments, time: { start: message.timestamp } },
				};
				parts.push(part);
				tools.set(item.id, part);
			}
		}
		output.push({ info, parts });
	}
	return output;
}
