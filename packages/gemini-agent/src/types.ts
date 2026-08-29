/**
 * FLY-1018 core types — the loop's control-flow contract (plan §2.2).
 *
 * Design principles (concept-level, from the FLY-1018 design docs):
 * every termination is a structured Terminal (never a throw), cross-turn
 * state lives in one explicit AgentState replaced wholesale at each
 * continue point, and the model surface is injectable so the loop is
 * purely unit-testable with scripted response sequences.
 */

export type TerminalReason =
	| "completed" // model produced a final answer (no functionCall)
	| "max_steps_exceeded" // step fuse (default 12)
	| "token_budget_exceeded" // token budget fuse
	| "context_overflow" // rough estimate near window — fail-fast, no compaction
	| "aborted" // AbortSignal fired
	| "model_error" // API-layer fatal (4xx/auth/retries exhausted)
	| "config_error"; // pre-start validation failed

export interface Terminal {
	reason: TerminalReason;
	/** Final answer when completed; null on error terminals. */
	finalText: string | null;
	error?: { kind: string; message: string; httpStatus?: number };
	/** Terminal carries the full session audit (design principle 10). */
	stats: SessionStats;
}

export interface SessionStats {
	sessionId: string;
	/** Model call rounds. */
	steps: number;
	toolCalls: number;
	toolErrors: number;
	/** Whitelist-gate rejections (expected to stay 0). */
	hallucinatedToolCalls: number;
	inputTokens: number;
	outputTokens: number;
	durationMs: number;
	model: string;
	surface: "interactions" | "generate";
}

/**
 * Cross-turn state — replaced wholesale at every continue point
 * (design principle 2), with the transition reason recorded.
 */
export interface AgentState {
	step: number;
	inputTokens: number;
	outputTokens: number;
	/** Why this turn continues: "next_turn" | "tool_results" | "retry_after_5xx". */
	transition: string;
}

/**
 * Audit contract (plan §2.6) — implemented by audit.ts (JSONL on disk).
 * Methods are synchronous: a write that has not reached disk MUST NOT be
 * followed by the action it records (audit-before-call, design principle 6).
 */
export interface AuditLog {
	sessionStart(e: {
		entry: "cli" | "discord" | "delegate";
		model: string;
		surface: string;
		projectName: string;
		userTextDigest: string;
	}): void;
	modelCall(step: number, transition: string): void;
	modelResponse(
		step: number,
		functionCallCount: number,
		textChars: number,
		usage: { inputTokens: number; outputTokens: number },
	): void;
	toolDispatch(
		step: number,
		tool: string,
		argsDigest: string,
		decision: "dispatch" | "hallucinated" | "schema_reject",
	): void;
	toolResult(
		step: number,
		tool: string,
		ok: boolean,
		httpStatus: number | undefined,
		durationMs: number,
		bodyChars: number,
		truncated: boolean,
	): void;
	retry(
		layer: "model" | "tool",
		attempt: number,
		maxAttempts: number,
		delayMs: number,
		errorKind: string,
	): void;
	terminal(reason: TerminalReason, stats: SessionStats): void;
	warning(message: string): void;
}

/** JSON-schema subset the registry validates against (spike-compatible). */
export interface JsonSchema {
	type: string;
	description?: string;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	enum?: (string | number)[];
	items?: JsonSchema;
}

export interface ToolExecCtx {
	signal: AbortSignal;
	audit: AuditLog;
}

/** body = JSON string (pre-truncation). */
export interface ToolResult {
	ok: boolean;
	httpStatus?: number;
	body: string;
}

export interface ToolSpec {
	name: string;
	description: string;
	parameters: JsonSchema;
	/** query_status / search_memory = true; everything else = false. */
	readonly: boolean;
	execute(args: Record<string, unknown>, ctx: ToolExecCtx): Promise<ToolResult>;
}

/** onEvent callback — consumed by entry shells (replaces a yield stream). */
export type AgentEvent =
	| { type: "step"; step: number }
	| { type: "tool_dispatch"; tool: string }
	| { type: "tool_result"; tool: string; ok: boolean; durationMs: number };

export interface ModelTurn {
	functionCalls: Array<{
		id: string;
		name: string;
		args: Record<string, unknown>;
	}>;
	text: string | null;
	usage: { inputTokens: number; outputTokens: number };
}

/**
 * client.ts implements this; the loop sees ONLY this interface
 * (design principle 9 — injectable model surface).
 */
export interface ModelSurface {
	start(
		system: string,
		user: string,
		tools: ToolSpec[],
		signal: AbortSignal,
	): Promise<ModelTurn>;
	continueWith(
		results: Array<{
			callId: string;
			name: string;
			result: string;
			isError: boolean;
		}>,
		signal: AbortSignal,
	): Promise<ModelTurn>;
}
