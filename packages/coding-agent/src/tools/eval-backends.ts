import { $flag } from "@oh-my-pi/pi-utils";
import type { ToolSession } from ".";

export interface EvalBackendsAllowance {
	python: boolean;
	js: boolean;
}

/** Read per-backend allowance from settings (py/js default on). */
export function readEvalBackendsAllowance(session: Pick<ToolSession, "settings">): EvalBackendsAllowance {
	return {
		python: session.settings.get("eval.py") ?? true,
		js: session.settings.get("eval.js") ?? true,
	};
}

/**
 * Materialize the active eval backend allowance: PI_PY / PI_JS
 * env flags override the per-key settings; otherwise settings win (py/js default on).
 */
export function resolveEvalBackends(session: Pick<ToolSession, "settings">): EvalBackendsAllowance {
	const settings = readEvalBackendsAllowance(session);
	return {
		python: $flag("PI_PY", settings.python),
		js: $flag("PI_JS", settings.js),
	};
}

/** Expand the native agent execution alias using the session's enabled backends. */
export function expandExecutionToolNames(names: string[], session: Pick<ToolSession, "settings">): string[] {
	if (!names.includes("exec")) return names;
	const backends = resolveEvalBackends(session);
	const expanded = names.filter(name => name !== "exec");
	if (backends.python || backends.js) expanded.push("eval");
	expanded.push("bash");
	return [...new Set(expanded)];
}
