/**
 * FLY-1018 AgentLoop (plan §2.3) — the whole control flow is ONE
 * while(true); "no function call" is the only natural exit (design
 * principle 1). The loop is a pure function over an injected ModelSurface,
 * so it is unit-tested with scripted response sequences and never touches
 * the real API (design principle 9).
 *
 * Every fuse (abort / maxSteps / token budget / context overflow) exits
 * through a structured Terminal — the loop NEVER throws on tool failure
 * or API failure (design principles 2/3). Dispatch runs the three-stage
 * gate inherited from the spike, order fixed: audit-first → whitelist →
 * schema validation.
 */

import { AbortedError, ModelCallError } from "./errors.js";
import { validateArgs } from "./tools/registry.js";
import { truncateResult } from "./truncate.js";
import type {
	AgentEvent,
	AgentState,
	AuditLog,
	ModelSurface,
	ModelTurn,
	SessionStats,
	Terminal,
	ToolSpec,
} from "./types.js";

const DIGEST_CHARS = 200;
/** Rough context window (input tokens) — both pinned tiers are 1M-class. */
const DEFAULT_CONTEXT_WINDOW_TOKENS = 1_000_000;
/** Fail-fast threshold: no compaction, just a structured exit (§2.5). */
const CONTEXT_OVERFLOW_FRACTION = 0.8;

export interface RunLoopOptions {
	surface: ModelSurface;
	registry: Record<string, ToolSpec>;
	system: string;
	user: string;
	audit: AuditLog;
	signal: AbortSignal;
	onEvent?: (e: AgentEvent) => void;
	sessionId: string;
	model: string;
	surfaceName: "interactions" | "generate";
	maxSteps: number;
	tokenBudgetIn: number;
	tokenBudgetOut: number;
	resultCapChars: number;
	contextWindowTokens?: number;
	/** Injectable clock for duration stats. */
	clock?: () => number;
}

interface PendingResult {
	callId: string;
	name: string;
	result: string;
	isError: boolean;
}

export async function runLoop(opts: RunLoopOptions): Promise<Terminal> {
	const clock = opts.clock ?? Date.now;
	const startedAt = clock();
	const contextWindow =
		opts.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
	const tools = Object.values(opts.registry);
	const toolNames = Object.keys(opts.registry);

	// Explicit cross-turn state — replaced wholesale at each continue point.
	let state: AgentState = {
		step: 0,
		inputTokens: 0,
		outputTokens: 0,
		transition: "next_turn",
	};
	const counters = {
		toolCalls: 0,
		toolErrors: 0,
		hallucinatedToolCalls: 0,
	};

	function stats(): SessionStats {
		return {
			sessionId: opts.sessionId,
			steps: state.step,
			toolCalls: counters.toolCalls,
			toolErrors: counters.toolErrors,
			hallucinatedToolCalls: counters.hallucinatedToolCalls,
			inputTokens: state.inputTokens,
			outputTokens: state.outputTokens,
			durationMs: clock() - startedAt,
			model: opts.model,
			surface: opts.surfaceName,
		};
	}

	function terminal(
		reason: Terminal["reason"],
		finalText: string | null,
		error?: Terminal["error"],
	): Terminal {
		const t: Terminal = { reason, finalText, stats: stats() };
		if (error) t.error = error;
		opts.audit.terminal(reason, t.stats);
		return t;
	}

	let pending: PendingResult[] | null = null;

	while (true) {
		// ---- fuses (all exit via Terminal, never throw — §2.3 step 1) ----
		if (opts.signal.aborted) return terminal("aborted", null);
		if (state.step >= opts.maxSteps)
			return terminal("max_steps_exceeded", null);
		if (
			state.inputTokens >= opts.tokenBudgetIn ||
			state.outputTokens >= opts.tokenBudgetOut
		)
			return terminal("token_budget_exceeded", null);
		if (state.inputTokens >= contextWindow * CONTEXT_OVERFLOW_FRACTION)
			return terminal("context_overflow", null);

		// ---- model call (client layer owns bounded retry — §2.4) ----
		opts.audit.modelCall(state.step + 1, state.transition);
		opts.onEvent?.({ type: "step", step: state.step + 1 });
		let turn: ModelTurn;
		try {
			turn =
				pending === null
					? await opts.surface.start(opts.system, opts.user, tools, opts.signal)
					: await opts.surface.continueWith(pending, opts.signal);
		} catch (err) {
			if (err instanceof AbortedError) return terminal("aborted", null);
			if (err instanceof ModelCallError) {
				return terminal("model_error", null, {
					kind: err.kind,
					message: err.message,
					httpStatus: err.httpStatus,
				});
			}
			// unexpected throw = bug-class error — still surface as model_error
			// with the original message, never swallow (§2.4)
			return terminal("model_error", null, {
				kind: "unknown",
				message: String((err as Error)?.message ?? err),
			});
		}

		state = {
			step: state.step + 1,
			inputTokens: state.inputTokens + turn.usage.inputTokens,
			outputTokens: state.outputTokens + turn.usage.outputTokens,
			transition: "tool_results",
		};
		opts.audit.modelResponse(
			state.step,
			turn.functionCalls.length,
			turn.text?.length ?? 0,
			turn.usage,
		);

		// ---- natural exit: no function call (§2.3 step 3) ----
		if (turn.functionCalls.length === 0) {
			return terminal("completed", turn.text ?? "");
		}

		// ---- dispatch three-stage gate, serial execution (§2.3 step 4) ----
		const results: PendingResult[] = [];
		let abortedMidDispatch = false;
		for (const fc of turn.functionCalls) {
			counters.toolCalls += 1;
			const argsDigest = JSON.stringify(fc.args ?? {}).slice(0, DIGEST_CHARS);

			// Pairing invariant (principle 4): once aborted, every remaining
			// dangling call gets a synthesized isError result before exit.
			if (opts.signal.aborted) {
				abortedMidDispatch = true;
				opts.audit.toolDispatch(state.step, fc.name, argsDigest, "dispatch");
				opts.audit.toolResult(
					state.step,
					fc.name,
					false,
					undefined,
					0,
					0,
					false,
				);
				counters.toolErrors += 1;
				results.push({
					callId: fc.id,
					name: fc.name,
					result: JSON.stringify({ error: "aborted before execution" }),
					isError: true,
				});
				continue;
			}

			// gate b: registry whitelist — unknown tool NEVER executes
			const tool = opts.registry[fc.name];
			if (!tool) {
				opts.audit.toolDispatch(
					state.step,
					fc.name,
					argsDigest,
					"hallucinated",
				);
				counters.hallucinatedToolCalls += 1;
				counters.toolErrors += 1;
				results.push({
					callId: fc.id,
					name: fc.name,
					result: JSON.stringify({
						error: `unknown tool: ${fc.name}. Available tools: ${toolNames.join(", ")}`,
					}),
					isError: true,
				});
				continue;
			}

			// gate c: dispatch-layer schema validation
			const errors = validateArgs(tool.parameters, fc.args ?? {});
			if (errors.length > 0) {
				opts.audit.toolDispatch(
					state.step,
					fc.name,
					argsDigest,
					"schema_reject",
				);
				counters.toolErrors += 1;
				results.push({
					callId: fc.id,
					name: fc.name,
					result: JSON.stringify({
						error: `invalid arguments: ${errors.join("; ")}`,
					}),
					isError: true,
				});
				continue;
			}

			// gate a ordering: the dispatch audit line is on disk BEFORE execute
			opts.audit.toolDispatch(state.step, fc.name, argsDigest, "dispatch");
			opts.onEvent?.({ type: "tool_dispatch", tool: fc.name });
			const toolStart = clock();
			try {
				const out = await tool.execute(fc.args ?? {}, {
					signal: opts.signal,
					audit: opts.audit,
				});
				const durationMs = clock() - toolStart;
				const { body, truncated } = truncateResult(
					out.body,
					opts.resultCapChars,
				);
				const isError = !out.ok;
				if (isError) counters.toolErrors += 1;
				opts.audit.toolResult(
					state.step,
					fc.name,
					out.ok,
					out.httpStatus,
					durationMs,
					out.body.length,
					truncated,
				);
				opts.onEvent?.({
					type: "tool_result",
					tool: fc.name,
					ok: out.ok,
					durationMs,
				});
				results.push({ callId: fc.id, name: fc.name, result: body, isError });
			} catch (err) {
				// transport-layer failure after BridgeClient's own retry —
				// error-as-message: feed back, never terminate the loop (§2.4)
				const durationMs = clock() - toolStart;
				counters.toolErrors += 1;
				opts.audit.toolResult(
					state.step,
					fc.name,
					false,
					undefined,
					durationMs,
					0,
					false,
				);
				opts.onEvent?.({
					type: "tool_result",
					tool: fc.name,
					ok: false,
					durationMs,
				});
				results.push({
					callId: fc.id,
					name: fc.name,
					result: JSON.stringify({
						error: `tool execution failed: ${String((err as Error)?.message ?? err)}`,
					}),
					isError: true,
				});
			}
		}

		if (abortedMidDispatch || opts.signal.aborted) {
			// dangling calls answered above; exit gracefully without another
			// model call (principle 4)
			return terminal("aborted", null);
		}

		pending = results;
	}
}
