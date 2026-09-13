import { Database } from "bun:sqlite";
import { expect, it } from "bun:test";
import { SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as path from "node:path";

it("merges provider deadlines across connections and replaces only heuristic cooldowns", () => {
	const temporary = TempDir.createSync("block-provenance-");
	const filename = path.join(temporary.path(), "auth.db");
	const first = new SqliteAuthCredentialStore(new Database(filename));
	const second = new SqliteAuthCredentialStore(new Database(filename));
	const key = { credentialId: 1, providerKey: "opencode-go:api_key", blockScope: "" };
	const now = Date.now();
	try {
		first.upsertCredentialBlock({ ...key, blockedUntilMs: now + 1_800_000, providerBlockedUntilMs: 0 });
		second.upsertCredentialBlock({ ...key, blockedUntilMs: now + 300_000, providerBlockedUntilMs: now + 300_000 });
		expect(first.getCredentialBlock(1, key.providerKey, "")).toBe(now + 300_000);
		first.upsertCredentialBlock({ ...key, blockedUntilMs: now + 1_200_000, providerBlockedUntilMs: now + 1_200_000 });
		second.upsertCredentialBlock({ ...key, blockedUntilMs: now + 1_800_000, providerBlockedUntilMs: 0 });
		expect(first.getCredentialProviderBlock(1, key.providerKey, "")).toBe(now + 1_200_000);
		first.upsertCredentialBlock({ ...key, blockedUntilMs: now + 300_000, providerBlockedUntilMs: now + 300_000 });
		expect(second.getCredentialBlock(1, key.providerKey, "")).toBe(now + 1_200_000);
	} finally {
		first.close();
		second.close();
		temporary.removeSync();
	}
});

it("preserves legacy rows and invalidates heuristic provenance when an older executable writes", () => {
	const db = new Database(":memory:");
	const now = Date.now();
	db.run(`CREATE TABLE auth_credential_blocks (
		credential_id INTEGER NOT NULL, provider_key TEXT NOT NULL, block_scope TEXT NOT NULL DEFAULT '',
		blocked_until_ms INTEGER NOT NULL, updated_at INTEGER NOT NULL,
		PRIMARY KEY (credential_id, provider_key, block_scope))`);
	db.run("INSERT INTO auth_credential_blocks VALUES (1, 'opencode-go:api_key', '', ?, 0)", [now + 1_800_000]);
	const store = new SqliteAuthCredentialStore(db);
	const key = { credentialId: 1, providerKey: "opencode-go:api_key", blockScope: "" };
	try {
		expect(store.getCredentialProviderBlock(1, key.providerKey, "")).toBe(now + 1_800_000);
		store.upsertCredentialBlock({ ...key, blockedUntilMs: now + 300_000, providerBlockedUntilMs: now + 300_000 });
		expect(store.getCredentialBlock(1, key.providerKey, "")).toBe(now + 1_800_000);
		store.deleteCredentialBlock(1, key.providerKey, "");
		store.upsertCredentialBlock({ ...key, blockedUntilMs: now + 1_800_000, providerBlockedUntilMs: 0 });
		// Legacy MAX writes can leave the timestamp unchanged. They still erase
		// knowledge that this deadline used to be only a heuristic.
		db.run("UPDATE auth_credential_blocks SET blocked_until_ms = MAX(blocked_until_ms, ?) WHERE credential_id = 1", [
			now + 1_800_000,
		]);
		store.upsertCredentialBlock({ ...key, blockedUntilMs: now + 300_000, providerBlockedUntilMs: now + 300_000 });
		expect(store.getCredentialBlock(1, key.providerKey, "")).toBe(now + 1_800_000);
	} finally {
		store.close();
	}
});
