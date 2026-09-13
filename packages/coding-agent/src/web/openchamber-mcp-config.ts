import * as fs from "node:fs/promises";
import * as path from "node:path";
import { validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema";
import { isRecord, withFileLock } from "@oh-my-pi/pi-utils";
import schema from "../config/mcp-schema.json";
import { readMCPConfigFile, validateServerName, writeMCPConfigFile } from "../mcp/config-writer";
import type { MCPConfigFile } from "../mcp/types";

function validate(config: unknown): asserts config is MCPConfigFile {
	if (!validateJsonSchemaValue(schema, config).success) throw new Error("Invalid MCP configuration");
}

/** Connection fields are write-only: even URLs and command arguments can contain credentials. */
export async function browserMcpConfig(file: string) {
	const config = await readNativeMcpConfig(file);
	return Object.entries(config.mcpServers ?? {}).map(([name, server]) => ({
		name,
		type: server.type ?? "stdio",
		enabled: server.enabled !== false,
		timeout: server.timeout,
		requestIdFormat: server.requestIdFormat ?? "number",
		configuredFields: Object.keys(server),
	}));
}

export async function readNativeMcpConfig(file: string): Promise<MCPConfigFile> {
	const config = await readMCPConfigFile(file);
	validate(config);
	return config;
}

/** Omitted fields survive edits; an explicit null removes an optional field. */
export async function mutateBrowserMcpConfig(file: string, name: string, method: string, patch: unknown) {
	if (validateServerName(name)) throw new Error("Invalid MCP server name");
	if (!["POST", "PATCH", "DELETE"].includes(method)) throw new Error("Unsupported MCP configuration operation");
	if (method !== "DELETE" && !isRecord(patch)) throw new Error("Expected MCP configuration fields");
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	await withFileLock(file, async () => {
		const config = await readMCPConfigFile(file);
		validate(config);
		const servers = config.mcpServers ?? {};
		const exists = Object.hasOwn(servers, name);
		if (method === "POST" && exists) throw new Error("MCP server already exists in this scope");
		if (method !== "POST" && !exists) throw new Error("MCP server does not exist in this scope");
		if (method === "DELETE") {
			delete servers[name];
			await writeMCPConfigFile(file, { ...config, mcpServers: servers });
			return;
		}
		if (!isRecord(patch)) throw new Error("Expected MCP configuration fields");
		const fields: Record<string, unknown> = { ...(method === "PATCH" ? servers[name] : {}) };
		for (const [key, value] of Object.entries(patch)) {
			if (key === "__proto__") throw new Error("Invalid MCP configuration field");
			if (value === null) delete fields[key];
			else if (isRecord(value)) {
				const members = { ...(isRecord(fields[key]) ? fields[key] : {}), ...value };
				for (const member of Object.keys(members)) if (members[member] === null) delete members[member];
				fields[key] = members;
			} else fields[key] = value;
		}
		const next = { ...config, mcpServers: { ...servers, [name]: fields } };
		validate(next);
		await writeMCPConfigFile(file, next);
	});
}
