/**
 * FLY-1018 GeminiClient (plan §2.4) — pure transport + bounded retry.
 *
 * Two surface adapters behind one ModelSurface interface:
 *  - interactions (primary): server-held history via previous_interaction_id
 *    (`store: true`); manual function dispatch BY CONSTRUCTION.
 *  - generateContent (fallback escape hatch): local contents[] history with
 *    automaticFunctionCalling explicitly disabled.
 *
 * The raw SDK object is injected (RawGenAi) so every retry/classification
 * path is unit-testable with a fake — the loop above never sees the SDK.
 */

import {
	AbortedError,
	BACKOFF_MS,
	classifyError,
	ModelCallError,
	retryAfterMsFrom,
} from "./errors.js";
import type { AuditLog, ModelSurface, ModelTurn, ToolSpec } from "./types.js";

/** Structural slice of GoogleGenAI the client consumes (injectable). */
export interface RawGenAi {
	interactions: {
		/**
		 * The abort signal travels in the SECOND options argument
		 * (`fetchOptions.signal`) — the Interactions API rejects unknown
		 * body params with 400 (caught by the M3 harness replay against the
		 * real API: `400 Unknown parameter 'abortSignal'`).
		 */
		create(
			params: Record<string, unknown>,
			options?: { fetchOptions?: { signal?: AbortSignal } },
		): Promise<unknown>;
	};
	models: {
		generateContent(params: Record<string, unknown>): Promise<unknown>;
	};
}

export interface GeminiClientOptions {
	ai: RawGenAi;
	model: string;
	surface: "interactions" | "generate";
	audit: AuditLog;
	/** Single model call cap (plan §2.4 network row). Default 120s. */
	callTimeoutMs?: number;
	/** Injectable sleeper for retry backoff tests. */
	sleep?: (ms: number) => Promise<void>;
	/** Persistence hook — called with each new interaction id (resume). */
	onInteractionId?: (id: string) => void;
	/** Resume a prior server-side Interactions thread. */
	resumeInteractionId?: string | null;
}

const DEFAULT_CALL_TIMEOUT_MS = 120_000;

function defaultSleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * Bounded-retry wrapper: recoverable classes retry (retry-after hint wins
 * over the 2s/4s/8s ladder), everything else throws ModelCallError with the
 * original message. Caller aborts surface as AbortedError, never retried.
 */
async function callWithRetry(
	fn: () => Promise<unknown>,
	audit: AuditLog,
	sleep: (ms: number) => Promise<void>,
	signal: AbortSignal,
): Promise<unknown> {
	let attempt = 0;
	// attempt counts RETRIES (first try is attempt 0)
	while (true) {
		if (signal.aborted) throw new AbortedError();
		try {
			return await fn();
		} catch (err) {
			if (signal.aborted) throw new AbortedError();
			const cls = classifyError(err);
			const message = String((err as Error)?.message ?? err);
			if (attempt >= cls.maxRetries) {
				throw new ModelCallError(cls.kind, message, cls.httpStatus);
			}
			const delayMs =
				retryAfterMsFrom(err) ??
				BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ??
				2_000;
			attempt += 1;
			audit.retry("model", attempt, cls.maxRetries, delayMs, cls.kind);
			await sleep(delayMs);
		}
	}
}

/** Combine the caller signal with the per-call timeout. */
function callSignal(outer: AbortSignal, timeoutMs: number): AbortSignal {
	return AbortSignal.any([outer, AbortSignal.timeout(timeoutMs)]);
}

// --- interactions adapter ----------------------------------------------------

interface InteractionStepLike {
	type?: string;
	id?: string;
	name?: string;
	arguments?: Record<string, unknown>;
	text?: string;
	content?: Array<{ type?: string; text?: string }>;
}

interface InteractionLike {
	id?: string;
	steps?: InteractionStepLike[];
	usage?: { total_input_tokens?: number; total_output_tokens?: number };
}

function parseInteraction(interaction: InteractionLike): ModelTurn {
	const steps = interaction.steps ?? [];
	const functionCalls = steps
		.filter((s) => s.type === "function_call")
		.map((s) => ({
			id: s.id ?? "",
			name: s.name ?? "",
			args: s.arguments ?? {},
		}));
	const text = steps
		.flatMap((s) => {
			if (s.type === "text") return [s.text ?? ""];
			if (s.type === "model_output")
				return (s.content ?? [])
					.filter((c) => c.type === "text")
					.map((c) => c.text ?? "");
			return [];
		})
		.join("");
	return {
		functionCalls,
		text: text || null,
		usage: {
			inputTokens: interaction.usage?.total_input_tokens ?? 0,
			outputTokens: interaction.usage?.total_output_tokens ?? 0,
		},
	};
}

function interactionsToolDeclarations(
	tools: ToolSpec[],
): Array<Record<string, unknown>> {
	return tools.map((t) => ({
		type: "function",
		name: t.name,
		description: t.description,
		parameters: t.parameters,
	}));
}

// --- generateContent adapter -------------------------------------------------

interface GenerateResponseLike {
	candidates?: Array<{ content?: unknown }>;
	functionCalls?: Array<{
		id?: string;
		name?: string;
		args?: Record<string, unknown>;
	}>;
	text?: string;
	usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

export function createModelSurface(opts: GeminiClientOptions): ModelSurface {
	const sleep = opts.sleep ?? defaultSleep;
	const timeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;

	if (opts.surface === "interactions") {
		let lastId: string | null = opts.resumeInteractionId ?? null;
		let system = "";
		let declarations: Array<Record<string, unknown>> = [];

		async function create(
			input: unknown,
			signal: AbortSignal,
		): Promise<ModelTurn> {
			const interaction = (await callWithRetry(
				() =>
					opts.ai.interactions.create(
						{
							model: opts.model,
							input,
							...(lastId && { previous_interaction_id: lastId }),
							system_instruction: system,
							tools: declarations,
							store: true,
							stream: false,
						},
						{ fetchOptions: { signal: callSignal(signal, timeoutMs) } },
					),
				opts.audit,
				sleep,
				signal,
			)) as InteractionLike;
			if (typeof interaction.id === "string" && interaction.id) {
				lastId = interaction.id;
				opts.onInteractionId?.(interaction.id);
			}
			return parseInteraction(interaction);
		}

		return {
			start(sys, user, tools, signal) {
				system = sys;
				declarations = interactionsToolDeclarations(tools);
				return create(user, signal);
			},
			continueWith(results, signal) {
				const input = results.map((r) => ({
					type: "function_result",
					call_id: r.callId,
					name: r.name,
					result: r.result,
					...(r.isError && { is_error: true }),
				}));
				return create(input, signal);
			},
		};
	}

	// generate fallback — local history, explicit manual dispatch
	const contents: unknown[] = [];
	let system = "";
	let declarations: Array<Record<string, unknown>> = [];
	let callCounter = 0;

	async function send(signal: AbortSignal): Promise<ModelTurn> {
		const res = (await callWithRetry(
			() =>
				opts.ai.models.generateContent({
					model: opts.model,
					contents,
					config: {
						systemInstruction: system,
						tools: [{ functionDeclarations: declarations }],
						// this loop is manual-dispatch; never let the SDK auto-execute
						automaticFunctionCalling: { disable: true },
						abortSignal: callSignal(signal, timeoutMs),
					},
				}),
			opts.audit,
			sleep,
			signal,
		)) as GenerateResponseLike;
		const cand = res.candidates?.[0];
		if (cand?.content) contents.push(cand.content);
		const functionCalls = (res.functionCalls ?? []).map((fc) => ({
			id: fc.id ?? `call-${++callCounter}`,
			name: fc.name ?? "",
			args: fc.args ?? {},
		}));
		return {
			functionCalls,
			text: res.text ?? null,
			usage: {
				inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
				outputTokens: res.usageMetadata?.candidatesTokenCount ?? 0,
			},
		};
	}

	return {
		start(sys, user, tools, signal) {
			system = sys;
			declarations = tools.map((t) => ({
				name: t.name,
				description: t.description,
				parameters: t.parameters,
			}));
			contents.push({ role: "user", parts: [{ text: user }] });
			return send(signal);
		},
		continueWith(results, signal) {
			contents.push({
				role: "user",
				parts: results.map((r) => ({
					functionResponse: {
						id: r.callId,
						name: r.name,
						response: { result: r.result },
					},
				})),
			});
			return send(signal);
		},
	};
}
