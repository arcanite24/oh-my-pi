import type { UsageReport } from "../usage";

export type CredentialPoolPolicy = "most-headroom" | "sticky" | "round-robin";
export interface CredentialPoolSettings {
	policy: CredentialPoolPolicy;
	thresholds: Record<string, number>;
	maxUsageAgeMs: number;
}
export interface CredentialPoolAccount {
	label: string;
	enabled: boolean;
	allowPaidFallback: boolean;
	lastSelected: number;
}
export interface CredentialPoolCandidate {
	id: number;
	account: CredentialPoolAccount;
	usage: UsageReport | null;
	blockedUntil?: number;
}
export interface CredentialPoolStore {
	getPoolSettings(provider: string): CredentialPoolSettings;
	setPoolSettings(provider: string, settings: CredentialPoolSettings): void;
	getPoolAccount(credentialId: number): CredentialPoolAccount;
	setPoolAccount(credentialId: number, account: CredentialPoolAccount): void;
	poolTransaction<T>(operation: () => T): T;
}
export interface CredentialPoolStatus {
	id: number;
	label: string;
	enabled: boolean;
	allowPaidFallback: boolean;
	lastSelected: number;
	eligible: boolean;
	paid: boolean;
	reason: string;
	fetchedAt: number | null;
	resetAt: number | null;
	blockedUntil: number | null;
	windows: { id: string; used: number | null; resetsAt: number | null }[];
}

export const DEFAULT_POOL_SETTINGS: CredentialPoolSettings = {
	policy: "most-headroom",
	thresholds: {},
	maxUsageAgeMs: 5 * 60_000,
};
export const DEFAULT_POOL_ACCOUNT: CredentialPoolAccount = {
	label: "",
	enabled: true,
	allowPaidFallback: false,
	lastSelected: 0,
};

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parsePoolSettings(value: unknown): CredentialPoolSettings {
	if (!record(value)) throw new Error("Invalid credential pool settings");
	const policy = value.policy ?? DEFAULT_POOL_SETTINGS.policy;
	if (policy !== "most-headroom" && policy !== "sticky" && policy !== "round-robin") {
		throw new Error("Unknown credential pool policy");
	}
	const maxUsageAgeMs = value.maxUsageAgeMs ?? DEFAULT_POOL_SETTINGS.maxUsageAgeMs;
	if (
		typeof maxUsageAgeMs !== "number" ||
		!Number.isInteger(maxUsageAgeMs) ||
		maxUsageAgeMs < 1000 ||
		maxUsageAgeMs > 300_000
	) {
		throw new Error("Usage freshness must be between 1 and 300 seconds");
	}
	const thresholds = value.thresholds ?? {};
	if (
		!record(thresholds) ||
		Object.values(thresholds).some(v => typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 100)
	) {
		throw new Error("Window thresholds must be greater than 0 and at most 100 percent");
	}
	return { policy, maxUsageAgeMs, thresholds: { ...thresholds } as Record<string, number> };
}

export function parsePoolAccount(value: unknown): CredentialPoolAccount {
	if (!record(value)) throw new Error("Invalid credential pool account");
	const label = value.label ?? "";
	const enabled = value.enabled ?? true;
	const allowPaidFallback = value.allowPaidFallback ?? false;
	const lastSelected = value.lastSelected ?? 0;
	if (
		typeof label !== "string" ||
		label.length > 120 ||
		/[\x00-\x1f]/.test(label) ||
		typeof enabled !== "boolean" ||
		typeof allowPaidFallback !== "boolean" ||
		typeof lastSelected !== "number" ||
		!Number.isSafeInteger(lastSelected) ||
		lastSelected < 0
	) {
		throw new Error("Invalid credential pool account settings");
	}
	return { label: label.trim(), enabled, allowPaidFallback, lastSelected };
}

/** Pure policy evaluation: no credentials or provider payloads leave this boundary. */
export function evaluatePool(
	candidates: CredentialPoolCandidate[],
	settings: CredentialPoolSettings,
	windowIds: readonly string[],
	now = Date.now(),
): CredentialPoolStatus[] {
	return candidates.map(({ id, account, usage, blockedUntil }) => {
		const windows = windowIds.map(windowId => {
			const limit = usage?.limits.find(item => item.id === windowId);
			const fraction = limit?.amount.usedFraction;
			const used =
				typeof fraction === "number" && Number.isFinite(fraction) && fraction >= 0 ? fraction * 100 : null;
			const reset = limit?.window?.resetsAt;
			return { id: windowId, used, resetsAt: typeof reset === "number" && Number.isFinite(reset) ? reset : null };
		});
		const fresh =
			usage !== null &&
			now >= usage.fetchedAt &&
			now - usage.fetchedAt <= settings.maxUsageAgeMs &&
			windows.every(window => window.used !== null && window.resetsAt !== null && window.resetsAt > now);
		const limiting = windows.filter(
			window =>
				(window.used !== null && window.used >= (settings.thresholds[window.id] ?? 100)) ||
				usage?.limits.some(limit => limit.id === window.id && limit.status === "exhausted"),
		);
		const hardLimited =
			usage?.limits.some(limit => windowIds.includes(limit.id) && limit.status === "exhausted") ?? false;
		// Go's monthly window can use paid balance; rolling/weekly hard limits still apply.
		const hardShortLimit =
			usage?.limits.some(
				limit =>
					windowIds.slice(0, 2).includes(limit.id) &&
					(limit.status === "exhausted" || (limit.amount.usedFraction ?? 0) >= 1),
			) ?? false;
		const paid =
			account.allowPaidFallback &&
			fresh &&
			limiting.some(window => window.id === windowIds[2] && (window.used ?? 0) >= 100);
		const effectiveLimits = limiting.filter(window => !(paid && window.id === windowIds[2]));
		let reason = "subscription capacity";
		if (!account.enabled) reason = "disabled";
		else if (blockedUntil !== undefined && blockedUntil > now) {
			reason = `provider cooldown${fresh && effectiveLimits.length ? `; window limit: ${effectiveLimits.map(window => window.id).join(", ")}` : ""}`;
		} else if (!fresh) reason = "usage unavailable or stale";
		else if (effectiveLimits.length > 0 || hardShortLimit || (hardLimited && !paid)) {
			reason = `window limit: ${effectiveLimits.map(window => window.id).join(", ") || "provider limit"}`;
		} else if (paid) reason = "paid fallback";
		const resets = effectiveLimits
			.map(window => window.resetsAt)
			.filter((value): value is number => value !== null && value > now);
		return {
			id,
			...account,
			eligible: reason === "subscription capacity" || reason === "paid fallback",
			paid,
			reason,
			fetchedAt: usage?.fetchedAt ?? null,
			resetAt:
				blockedUntil && blockedUntil > now
					? Math.max(blockedUntil, ...resets)
					: resets.length
						? Math.max(...resets)
						: null,
			blockedUntil: blockedUntil ?? null,
			windows,
		};
	});
}

export function choosePoolCredential(
	statuses: CredentialPoolStatus[],
	policy: CredentialPoolPolicy,
	stickyId?: number,
): CredentialPoolStatus | undefined {
	const eligible = statuses.filter(status => status.eligible);
	const subscription = eligible.filter(status => !status.paid);
	const candidates = subscription.length ? subscription : eligible;
	if (policy === "sticky") {
		const sticky = candidates.find(status => status.id === stickyId);
		if (sticky) return sticky;
	}
	return candidates.sort((a, b) => {
		if (policy !== "round-robin") {
			const aUsed = a.windows.slice(0, 2).map(window => window.used ?? 100);
			const bUsed = b.windows.slice(0, 2).map(window => window.used ?? 100);
			const difference =
				Math.max(...aUsed) - Math.max(...bUsed) ||
				aUsed.reduce((sum, value) => sum + value, 0) - bUsed.reduce((sum, value) => sum + value, 0);
			if (difference) return difference;
		}
		return a.lastSelected - b.lastSelected || a.id - b.id;
	})[0];
}

export class CredentialPoolExhaustedError extends Error {
	constructor(readonly statuses: CredentialPoolStatus[]) {
		const resets = statuses.flatMap(status => (!status.enabled || status.resetAt === null ? [] : [status.resetAt]));
		super(
			`Credential pool unavailable: ${[...new Set(statuses.map(status => status.reason))].join("; ") || "no credentials"}.` +
				(resets.length
					? ` Earliest reset: ${new Date(Math.min(...resets)).toISOString()}.`
					: " Refresh usage or update pool settings."),
		);
		this.name = "CredentialPoolExhaustedError";
	}
}
