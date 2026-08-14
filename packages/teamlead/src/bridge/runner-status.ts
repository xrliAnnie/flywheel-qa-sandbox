/**
 * FLY-10: Runner terminal status detection — capture plus a four-state heuristic.
 *
 * Heuristic logic copied from packages/terminal-mcp/src/status.ts (not imported
 * to avoid Bridge depending on an MCP server package — layer violation).
 * Both copies evolve independently until the heuristic stabilises.
 *
 * Four states:
 *   executing — tmux alive, Claude Code process active
 *   waiting   — tmux alive, Claude Code present but waiting for input
 *   idle      — tmux alive but no Claude Code process (bare shell prompt)
 *   unknown   — tmux session unreachable or doesn't exist
 */

import type { CaptureError, CaptureResult } from "./session-capture.js";
import { isCaptureError } from "./session-capture.js";

// ── Types ──

export type RunnerStatus = "executing" | "waiting" | "idle" | "unknown";

export interface StatusResult {
	status: RunnerStatus;
	reason: string;
}

// ── Heuristic patterns (from terminal-mcp/src/status.ts) ──

const WAITING_PATTERNS: RegExp[] = [
	/Do you want to proceed/i,
	/\[Y\/n\]/i,
	/\[y\/N\]/i,
	/\(yes\/no\)/i,
	/\? \(Y\/n\)/,
	/\? \(y\/N\)/,
	/Press Enter/i,
	/waiting for input/i,
	/approve or deny/i,
	// Claude Code specific prompts
	/Do you want to/i,
	/Would you like to/i,
	/Should I/i,
	// Permission prompts
	/Allow\?/,
	/\[Allow\]/i,
	/\[Deny\]/i,
];

const IDLE_PATTERNS: RegExp[] = [
	/^\s*[$❯>%#]\s*$/m, // bare shell prompt at end
	/^\s*\w+@[\w.-]+[:\s~].*[$#]\s*$/m, // user@host:~ $ prompt
];

/**
 * Detect terminal status from raw output (pure heuristic, no time dimension).
 * Returns "executing" | "waiting" | "idle" — never "unknown" (that's the caller's job).
 */
export function detectTerminalStatus(output: string): {
	status: Exclude<RunnerStatus, "unknown">;
	reason: string;
} {
	const lines = output.split("\n");
	const tail = lines.filter((l) => l.trim().length > 0).slice(-15);

	if (tail.length === 0) {
		return { status: "idle", reason: "terminal output is empty" };
	}

	// Check for waiting patterns (highest priority — actionable)
	for (let i = tail.length - 1; i >= 0; i--) {
		for (const pattern of WAITING_PATTERNS) {
			if (pattern.test(tail[i]!)) {
				return {
					status: "waiting",
					reason: `matched: ${tail[i]!.trim().slice(0, 80)}`,
				};
			}
		}
	}

	// Check last few lines for idle shell prompt
	const lastLines = tail.slice(-3);
	for (const line of lastLines) {
		for (const pattern of IDLE_PATTERNS) {
			if (pattern.test(line!)) {
				return {
					status: "idle",
					reason: `shell prompt detected: ${line!.trim().slice(0, 40)}`,
				};
			}
		}
	}

	// Default: output has content but no prompt/wait signals → executing
	return { status: "executing", reason: "no prompt or wait signal detected" };
}

// ── Composed status query (capture → heuristic) ──

type CaptureFn = (
	executionId: string,
	projectName: string,
	lines: number,
) => Promise<CaptureResult | CaptureError>;

export interface StatusQueryResult {
	result: StatusResult;
	/** Non-null when capture failed with a non-tmux error (400/404). Caller should return this HTTP status. */
	captureErrorStatus?: number;
	/**
	 * FLY-195: raw captured terminal output when the capture succeeded.
	 * Both original consumers (the stuck-runner detector and the runner idle
	 * scan) were removed in FLY-1570/FLY-1560; the field stays so a caller can
	 * reuse one capture instead of taking a second capture-pane of its own.
	 */
	output?: string;
}

/**
 * Create a status query function that composes:
 *   1. tmux capture (via captureSessionFn)
 *   2. heuristic detection (detectTerminalStatus)
 *
 * Returns "unknown" only for tmux-unreachable (502).
 * For other CaptureErrors (400 bad project, 404 missing DB/session), propagates the error
 * via captureErrorStatus so the endpoint can return the correct HTTP status.
 *
 */
export function createStatusQuery(captureSessionFn: CaptureFn): {
	query: (
		executionId: string,
		projectName: string,
	) => Promise<StatusQueryResult>;
} {
	const query = async (
		executionId: string,
		projectName: string,
	): Promise<StatusQueryResult> => {
		const capture = await captureSessionFn(executionId, projectName, 100);

		if (isCaptureError(capture)) {
			// tmux capture-pane failure → "unknown" (tmux unreachable)
			// Distinguished from CommDB 502 by error message prefix
			const isTmuxError =
				capture.status === 502 &&
				capture.error.startsWith("tmux window not found");
			if (isTmuxError) {
				return {
					result: { status: "unknown" as const, reason: capture.error },
				};
			}
			// All other errors (400/404/CommDB 502) → propagate HTTP status
			return {
				result: { status: "unknown" as const, reason: capture.error },
				captureErrorStatus: capture.status,
			};
		}

		const raw = detectTerminalStatus(capture.output);
		return {
			result: raw,
			output: capture.output,
		};
	};

	return { query };
}
