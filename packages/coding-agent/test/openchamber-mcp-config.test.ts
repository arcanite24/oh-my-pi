import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { browserMcpConfig, mutateBrowserMcpConfig } from "../src/web/openchamber-mcp-config";

test("native browser MCP edits preserve secrets, reject invalid updates, and serialize writers", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-config-"));
	const file = path.join(directory, "mcp.json");
	try {
		await mutateBrowserMcpConfig(file, "plugin:probe", "POST", {
			type: "http",
			url: "https://example.invalid/?key=secret-url",
			headers: { Authorization: "secret-header" },
			oauth: { clientSecret: "secret-oauth" },
			enabled: true,
		});
		await Promise.all([
			mutateBrowserMcpConfig(file, "plugin:probe", "PATCH", { enabled: false }),
			mutateBrowserMcpConfig(file, "plugin:probe", "PATCH", { timeout: 1234 }),
		]);
		const summary = await browserMcpConfig(file);
		expect(summary).toMatchObject([{ name: "plugin:probe", enabled: false, timeout: 1234 }]);
		expect(JSON.stringify(summary)).not.toContain("secret-");
		const stored = await fs.readFile(file, "utf8");
		for (const secret of ["secret-url", "secret-header", "secret-oauth"]) expect(stored).toContain(secret);
		await expect(mutateBrowserMcpConfig(file, "plugin:probe", "POST", { command: "echo" })).rejects.toThrow(
			"already exists",
		);
		await expect(mutateBrowserMcpConfig(file, "plugin:probe", "PATCH", { timeout: -1 })).rejects.toThrow(
			"Invalid MCP",
		);
		await expect(
			mutateBrowserMcpConfig(file, "plugin:probe", "PATCH", { headers: { Authorization: 42 } }),
		).rejects.toThrow("Invalid MCP");
		expect(await fs.readFile(file, "utf8")).toBe(stored);
		await expect(
			mutateBrowserMcpConfig(file, "plugin:probe", "PATCH", JSON.parse('{"__proto__":{"command":"bad"}}')),
		).rejects.toThrow("Invalid MCP");
		expect(await fs.readFile(file, "utf8")).toBe(stored);
		await mutateBrowserMcpConfig(file, "plugin:probe", "PATCH", { oauth: { clientId: "new-client" } });
		expect(await fs.readFile(file, "utf8")).toContain("secret-oauth");
		await mutateBrowserMcpConfig(file, "plugin:probe", "PATCH", { oauth: null });
		expect((await browserMcpConfig(file))[0].configuredFields).not.toContain("oauth");
		await mutateBrowserMcpConfig(file, "plugin:probe", "DELETE", undefined);
		expect(await browserMcpConfig(file)).toEqual([]);
	} finally {
		await fs.unlink(file).catch(() => {});
		await fs.rmdir(directory);
	}
});
