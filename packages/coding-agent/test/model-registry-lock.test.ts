import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";

test("model lock exposes only the exact model", async () => {
	const auth = await AuthStorage.create(":memory:");
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omp-model-lock-"));
	try {
		const modelsPath = path.join(directory, "models.yml");
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					probe: {
						api: "openai-completions",
						apiKey: "test-only",
						baseUrl: "http://127.0.0.1:1/v1",
						models: ["allowed", "blocked"].map(id => ({
							id,
							name: id,
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
						})),
					},
				},
			}),
		);
		const registry = new ModelRegistry(auth, modelsPath, { modelLock: "probe/allowed" });
		expect(registry.getAll().map(model => `${model.provider}/${model.id}`)).toEqual(["probe/allowed"]);
		expect(registry.find("probe", "blocked")).toBeUndefined();
		expect(registry.find("probe", "allowed")?.id).toBe("allowed");
	} finally {
		auth.close();
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
