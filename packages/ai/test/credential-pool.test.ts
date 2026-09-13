import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";
import { withAuth } from "../src/auth-retry";
import type { UsageProvider, UsageReport } from "../src/usage";
import {
	CredentialPoolExhaustedError,
	DEFAULT_POOL_ACCOUNT,
	DEFAULT_POOL_SETTINGS,
	evaluatePool,
	parsePoolSettings,
} from "../src/auth/credential-pool";
import { removeWithRetries } from "../../utils/src/temp";

const provider = "opencode-go";
const resources: { auth: AuthStorage; directory: string }[] = [];
const now = Date.now();
function report(rolling = 10, weekly = 10, monthly = 10, fetchedAt = now): UsageReport {
	return {
		provider,
		fetchedAt,
		limits: [rolling, weekly, monthly].map((used, index) => ({
			id: ["rolling-5h", "weekly", "monthly"][index],
			label: "quota",
			scope: { provider },
			amount: { usedFraction: used / 100, unit: "percent" },
			window: { id: String(index), label: "quota", resetsAt: now + (index + 1) * 3600_000 },
			status: used === 100 ? "exhausted" : "ok",
		})),
	};
}
async function setup(reports: Record<string, UsageReport | Error | null>) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-pool-"));
	const dbPath = path.join(directory, "agent.db");
	const store = await SqliteAuthCredentialStore.open(dbPath);
	const usage: UsageProvider = {
		id: provider,
		supports: () => true,
		fetchUsage: async params => {
			const value = reports[params.credential.apiKey ?? ""] ?? null;
			if (value instanceof Error) throw value;
			return value;
		},
	};
	const auth = new AuthStorage(store, { usageProviderResolver: () => usage });
	await auth.set(
		provider,
		Object.keys(reports).map(key => ({ type: "api_key", key, source: "login" })),
	);
	resources.push({ auth, directory });
	return { auth, store, dbPath, usage };
}
afterEach(async () => {
	for (const { auth, directory } of resources.splice(0)) {
		auth.close();
		await removeWithRetries(directory);
	}
});

test("most headroom uses both windows and changes credentials within a session", async () => {
	const { auth } = await setup({ a: report(10, 80), b: report(30, 30), c: report(30, 30) });
	expect(await auth.getApiKey(provider, "session")).toBe("b");
	expect(await auth.getApiKey(provider, "session")).toBe("c");
	expect(await auth.getApiKey(provider, "session")).toBe("b");
});
test("single credential and exhausted pools fail closed with reset information", async () => {
	const { auth } = await setup({ a: report(100) });
	await expect(auth.getApiKey(provider)).rejects.toThrow("Earliest reset:");
});
test("unknown and stale usage cannot authorize requests", async () => {
	const { auth } = await setup({ a: null, b: report(0, 0, 0, now - 600_000) });
	await expect(auth.getApiKey(provider)).rejects.toThrow("usage unavailable or stale");
});
test("monthly fallback is opt-in and subscription capacity wins", async () => {
	const { auth, store } = await setup({ a: report(0, 0, 100), b: report(70, 70) });
	const a = store.listAuthCredentials(provider)[0];
	expect(await auth.getApiKey(provider)).toBe("b");
	auth.setCredentialPoolAccount(provider, a.id, { allowPaidFallback: true });
	expect(await auth.getApiKey(provider)).toBe("b");
	const b = store.listAuthCredentials(provider)[1];
	auth.setCredentialPoolAccount(provider, b.id, { enabled: false });
	expect(await auth.getApiKey(provider)).toBe("a");
	auth.setCredentialPoolAccount(provider, a.id, { allowPaidFallback: false });
	await expect(auth.getApiKey(provider)).rejects.toThrow("monthly");
});
test("paid opt-in cannot bypass a rolling hard limit", async () => {
	const { auth, store } = await setup({ a: report(100, 0, 100) });
	auth.setCredentialPoolAccount(provider, store.listAuthCredentials(provider)[0].id, { allowPaidFallback: true });
	await expect(auth.getApiKey(provider)).rejects.toThrow("rolling-5h");
});
test("sticky policy stays until disabled and thresholds apply", async () => {
	const { auth, store } = await setup({ a: report(20, 20), b: report(30, 30) });
	auth.setCredentialPoolSettings(provider, { policy: "sticky", thresholds: { weekly: 25 } });
	expect(await auth.getApiKey(provider, "session")).toBe("a");
	expect(await auth.getApiKey(provider, "session")).toBe("a");
	auth.setCredentialPoolAccount(provider, store.listAuthCredentials(provider)[0].id, { enabled: false });
	await expect(auth.getApiKey(provider, "session")).rejects.toThrow("weekly");
});
test("concurrent stores share round robin and account controls", async () => {
	const { auth, dbPath, usage, store } = await setup({ a: report(), b: report() });
	auth.setCredentialPoolSettings(provider, { policy: "round-robin" });
	const second = await AuthStorage.create(dbPath, { usageProviderResolver: () => usage });
	try {
		expect(await Promise.all([auth.getApiKey(provider), second.getApiKey(provider)])).toEqual(["a", "b"]);
		auth.setCredentialPoolAccount(provider, store.listAuthCredentials(provider)[0].id, { enabled: false });
		expect(await second.getApiKey(provider)).toBe("b");
	} finally {
		second.close();
	}
});
test("provider cooldown rotates without disclosing keys in summaries", async () => {
	const { auth } = await setup({ secretOne: report(), secretTwo: report() });
	expect(await auth.getApiKey(provider, "session")).toBe("secretOne");
	await auth.markUsageLimitReached(provider, "session", { apiKey: "secretOne", retryAfterMs: 60_000 });
	expect(await auth.getApiKey(provider, "session")).toBe("secretTwo");
	const summary = JSON.stringify(await auth.getCredentialPool(provider));
	expect(summary).not.toContain("secretOne");
	expect(summary).not.toContain("secretTwo");
	expect(summary).toContain("provider cooldown");
});
test("quota failover tries each eligible credential once and persists exhaustion across stores", async () => {
	const { auth, dbPath, usage } = await setup({ a: report(), b: report(), c: report() });
	const attempted: string[] = [];
	const quota = Object.assign(new Error("429 quota exceeded"), { status: 429 });
	await expect(
		withAuth(auth.resolver(provider, { sessionId: "failover" }), async key => {
			attempted.push(key);
			throw quota;
		}),
	).rejects.toThrow("quota exceeded");
	expect(attempted).toEqual(["a", "b", "c"]);
	const second = await AuthStorage.create(dbPath, { usageProviderResolver: () => usage });
	try {
		await expect(second.getApiKey(provider)).rejects.toThrow("provider cooldown");
	} finally {
		second.close();
	}
});
test("pool settings reject malformed thresholds", () => {
	for (const threshold of [0, -1, 101, NaN, "90"]) {
		expect(() => parsePoolSettings({ thresholds: { weekly: threshold } })).toThrow();
	}
});

test("invalid credentials do not prevent healthy account selection", async () => {
	const { auth } = await setup({ invalid: new Error("Invalid API key"), healthy: report() });
	expect(await auth.getApiKey(provider)).toBe("healthy");
	const pool = await auth.getCredentialPool(provider);
	expect(pool.accounts[0].eligible).toBe(false);
	expect(pool.accounts[0].windows.every(window => window.used === null)).toBe(true);
});

test("weekly hard limits remain enforced with paid opt-in", async () => {
	const { auth, store } = await setup({ a: report(0, 100, 100) });
	auth.setCredentialPoolAccount(provider, store.listAuthCredentials(provider)[0].id, { allowPaidFallback: true });
	await expect(auth.getApiKey(provider)).rejects.toThrow("weekly");
});

test("a passed reset requires refreshed usage before recovery", () => {
	const windows = ["rolling-5h", "weekly", "monthly"];
	const candidate = { id: 1, account: DEFAULT_POOL_ACCOUNT, usage: report(100), blockedUntil: now + 3600_000 };
	expect(evaluatePool([candidate], DEFAULT_POOL_SETTINGS, windows, now)[0].eligible).toBe(false);
	const afterReset = now + 3600_001;
	expect(evaluatePool([candidate], DEFAULT_POOL_SETTINGS, windows, afterReset)[0].eligible).toBe(false);
	const refreshed = report(0, 0, 0, afterReset);
	for (const limit of refreshed.limits) if (limit.window) limit.window.resetsAt = afterReset + 3600_000;
	expect(
		evaluatePool([{ ...candidate, usage: refreshed }], DEFAULT_POOL_SETTINGS, windows, afterReset)[0].eligible,
	).toBe(true);
});

test("cooldowns retain limiting windows and disabled accounts do not advertise a reset", () => {
	const statuses = evaluatePool(
		[
			{ id: 1, account: DEFAULT_POOL_ACCOUNT, usage: report(0, 100), blockedUntil: now + 1000 },
			{ id: 2, account: { ...DEFAULT_POOL_ACCOUNT, enabled: false }, usage: report(100) },
		],
		DEFAULT_POOL_SETTINGS,
		["rolling-5h", "weekly", "monthly"],
		now,
	);
	expect(statuses[0].reason).toContain("weekly");
	expect(new CredentialPoolExhaustedError(statuses).message).toContain(new Date(now + 2 * 3600_000).toISOString());
});
