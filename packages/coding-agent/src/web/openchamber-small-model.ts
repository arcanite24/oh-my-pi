import { completeSimple, validateToolCall, type Tool } from "@oh-my-pi/pi-ai";
import { resolveApiKeyOnce, seedApiKeyResolver } from "@oh-my-pi/pi-ai/auth-retry";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";

/** Utility calls use the same resolver and bounded credential rotation as CLI requests. */
export async function smallModelRequest(
	body: Record<string, unknown>,
	models: ModelRegistry,
	settings: Settings,
	signal: AbortSignal,
): Promise<Response> {
	await models.authStorage.reload();
	if (body.action === "providers")
		return Response.json([...new Set(models.getAvailable().map(model => model.provider))]);
	if (body.action !== "describe" && body.action !== "generate") throw new Error("Invalid small-model action");
	for (const key of ["model", "preferredProviderID", "preferredModelID", "prompt", "system", "sessionID"])
		if (body[key] !== undefined && typeof body[key] !== "string") throw new Error(`Invalid ${key}`);
	const preferred =
		body.preferredProviderID && body.preferredModelID
			? `${body.preferredProviderID}/${body.preferredModelID}`
			: undefined;
	const selector = body.model || settings.getModelRole("smol") || preferred || settings.getModelRole("default");
	if (typeof selector !== "string") {
		return body.action === "describe"
			? Response.json(null)
			: Response.json({ error: "Configure an OMP small model or select a session model" }, { status: 404 });
	}
	const split = selector.indexOf("/");
	const model =
		split > 0
			? models.find(selector.slice(0, split), selector.slice(split + 1))
			: models.getAvailable().find(model => model.id === selector);
	if (!model) return Response.json({ error: "Small model not found" }, { status: 404 });
	if (
		body.restrictToPreferredProvider === true &&
		body.preferredProviderID &&
		body.preferredProviderID !== model.provider
	)
		return Response.json({ error: "Small model must use the session provider" }, { status: 422 });
	const requested = body.maxOutputTokens ?? 4000;
	if (typeof requested !== "number" || !Number.isSafeInteger(requested) || requested < 1)
		throw new Error("Invalid output token budget");
	const contextTokens = model.contextWindow ?? 64000;
	const outputTokens = Math.min(requested, model.maxTokens ?? requested, Math.max(1, contextTokens - 1));
	const inputCharBudget = Math.max(1, contextTokens - outputTokens) * 4;
	const description = {
		providerID: model.provider,
		modelID: model.id,
		source: body.model ? "request" : "omp",
		hasLogin: models.authStorage.hasAuth(model.provider),
		inputCharBudget,
		contextTokens,
		contextKnown: !!model.contextWindow,
		outputTokens,
		outputTokenLimit: model.maxTokens ?? null,
		structuredOutput: null,
	};
	if (body.action === "describe") return Response.json(description);
	if (typeof body.prompt !== "string" || !body.prompt.trim()) throw new Error("Prompt is required");
	const system = typeof body.system === "string" ? body.system : "";
	const schemaChars = body.responseSchema === undefined ? 0 : JSON.stringify(body.responseSchema).length;
	const budget = Math.max(0, inputCharBudget - system.length - schemaChars);
	const inputTruncated = body.prompt.length > budget;
	if (!budget || (inputTruncated && body.onOverflow === "error"))
		return Response.json(
			{
				error: "Input exceeds the selected model context",
				code: "context-too-small",
				requiredChars: body.prompt.length + system.length,
				availableChars: inputCharBudget,
			},
			{ status: 413 },
		);
	if (body.responseSchema !== undefined && !isRecord(body.responseSchema)) throw new Error("Invalid response schema");
	const tools: Tool[] | undefined = isRecord(body.responseSchema)
		? [
				{
					name: "respond",
					description: "Return the requested structured result",
					parameters: {
						type: "object",
						properties: { result: body.responseSchema },
						required: ["result"],
						additionalProperties: false,
					},
				},
			]
		: undefined;
	const timeoutMs = body.timeoutMs ?? 60000;
	if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1800000)
		throw new Error("Invalid request timeout");
	const sessionId = `web-utility-${crypto.randomUUID()}`;
	try {
		const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
		const resolver = models.resolver(model, sessionId);
		const key = await resolveApiKeyOnce(resolver, requestSignal);
		const result = await completeSimple(
			model,
			{
				systemPrompt: system ? [system] : undefined,
				messages: [{ role: "user", content: body.prompt.slice(0, budget), timestamp: Date.now() }],
				tools,
			},
			{
				apiKey: seedApiKeyResolver(key, resolver),
				sessionId,
				maxTokens: outputTokens,
				disableReasoning: true,
				toolChoice: tools ? { type: "function", name: "respond" } : undefined,
				signal: requestSignal,
			},
		);
		if (result.stopReason === "error" || result.stopReason === "aborted")
			return Response.json(
				{ error: "OMP utility request failed; check credential pool availability" },
				{ status: 503 },
			);
		const call = result.content.find(part => part.type === "toolCall" && part.name === "respond");
		let text: string;
		if (tools) {
			if (!call || call.type !== "toolCall")
				return Response.json(
					{ error: "Model did not return the requested structured result", code: "structured-output-invalid" },
					{ status: 422 },
				);
			try {
				const validated = validateToolCall(tools, call);
				if (!isRecord(validated)) throw new Error("Invalid structured result");
				text = JSON.stringify(validated.result);
			} catch {
				return Response.json(
					{ error: "Model returned an invalid structured result", code: "structured-output-invalid" },
					{ status: 422 },
				);
			}
		} else
			text = result.content
				.filter(part => part.type === "text")
				.map(part => part.text)
				.join("\n")
				.trim();
		if (!text) return Response.json({ error: "Model returned no text", code: "output-exhausted" }, { status: 422 });
		return Response.json({
			text,
			providerID: model.provider,
			modelID: model.id,
			source: description.source,
			...(inputTruncated ? { inputTruncated: true } : {}),
		});
	} finally {
		models.authStorage.releaseSessionCredentialForReselection(model.provider, sessionId);
	}
}
