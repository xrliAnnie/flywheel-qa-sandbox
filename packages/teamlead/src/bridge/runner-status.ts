/**
 * FLY-10: Runner terminal status detection — four-state model + 45s stall watchdog.
 *
 * Heuristic logic copied from packages/terminal-mcp/src/status.ts (not imported
 * to avoid Bridge depending on an MCP server package — layer violation).
 * Both copies evolve independently until the heuristic stabilises.
 *
 * Four states:
 *   executing — tmux alive, Claude Code process active, output changing
 *   waiting   — tmux alive, Claude Code present but waiting for input / stalled 45s
 *   idle      — tmux alive but no Claude Code process (bare shell prompt)
 *   unknown   — tmux session unreachable or doesn't exist
 */

import { createHash } from "node:crypto";
import type { CaptureError, CaptureResult } from "./session-capture.js";
import { isCaptureError } from "./session-capture.js";

// ── Types ──

export type RunnerStatus = "executing" | "waiting" | "idle" | "unknown";

export interface StatusResult {
	status: RunnerStatus;
	reason: string;
	/** Seconds since terminal output last changed (only when stall watchdog active) */
	stale_seconds?: number;
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

// ── Stall watchdog (45s) ──

const STALL_THRESHOLD_MS = 45_000;

interface StallEntry {
	fingerprint: string;
	lastChangedAt: number; // Date.now()
}

/** In-memory cache keyed by executionId. Evicted after 1h of no updates. */
const stallCache = new Map<string, StallEntry>();
const EVICTION_MS = 3_600_000;

function fingerprint(output: string): string {
	return createHash("sha256").update(output).digest("hex").slice(0, 16);
}

/**
 * Apply 45s stall watchdog: if terminal output hasn't changed for 45s,
 * downgrade "executing" → "waiting" (likely stuck on interactive input).
 *
 * @param executionId - unique session key for the cache
 * @param output - raw terminal output
 * @param raw - result from detectTerminalStatus()
 * @param now - injectable clock for testing
 */
export function applyStallWatchdog(
	executionId: string,
	output: string,
	raw: { status: Exclude<RunnerStatus, "unknown">; reason: string },
	now: number = Date.now(),
): StatusResult {
	// Only apply stall logic to "executing" state
	if (raw.status !== "executing") {
		// Update cache anyway so next "executing" gets a fresh baseline
		stallCache.set(executionId, {
			fingerprint: fingerprint(output),
			lastChangedAt: now,
		});
		return raw;
	}

	const fp = fingerprint(output);
	const entry = stallCache.get(executionId);

	if (!entry || entry.fingerprint !== fp) {
		// Output changed — reset timer
		stallCache.set(executionId, { fingerprint: fp, lastChangedAt: now });
		return raw;
	}

	// Output unchanged — check how long
	const staleSec = Math.round((now - entry.lastChangedAt) / 1000);

	if (now - entry.lastChangedAt >= STALL_THRESHOLD_MS) {
		return {
			status: "waiting",
			reason: `stall watchdog: output unchanged for ${staleSec}s`,
			stale_seconds: staleSec,
		};
	}

	return raw;
}

/**
 * Evict stale entries from the stall cache.
 * Call periodically (e.g. from a setInterval) to prevent unbounded growth.
 */
export function evictStaleEntries(now: number = Date.now()): number {
	let evicted = 0;
	for (const [key, entry] of stallCache) {
		if (now - entry.lastChangedAt > EVICTION_MS) {
			stallCache.delete(key);
			evicted++;
		}
	}
	return evicted;
}

/** Clear entire stall cache (for tests). */
export function clearStallCache(): void {
	stallCache.clear();
}

/** Get stall cache size (for tests/diagnostics). */
export function stallCacheSize(): number {
	return stallCache.size;
}

// ── Composed status query (capture → heuristic → stall watchdog) ──

type CaptureFn = (
	executionId: string,
	projectName: string,
	lines: number,
) => Promise<CaptureResult | CaptureError>;

export interface StatusQueryResult {
	result: StatusResult;
	/** Non-null when capture failed with a non-tmux error (400/404). Caller should return this HTTP status. */
	captureErrorStatus?: number;
}

/**
 * Create a status query function that composes:
 *   1. tmux capture (via captureSessionFn)
 *   2. heuristic detection (detectTerminalStatus)
 *   3. stall watchdog (applyStallWatchdog)
 *
 * Returns "unknown" only for tmux-unreachable (502).
 * For other CaptureErrors (400 bad project, 404 missing DB/session), propagates the error
 * via captureErrorStatus so the endpoint can return the correct HTTP status.
 *
 * Starts a periodic eviction timer (every 10 min) to prevent unbounded cache growth.
 */
export function createStatusQuery(captureSessionFn: CaptureFn): {
	query: (
		executionId: string,
		projectName: string,
	) => Promise<StatusQueryResult>;
	/** Call to stop the eviction timer (for graceful shutdown / tests). */
	stopEviction: () => void;
} {
	const evictionTimer = setInterval(() => evictStaleEntries(), 600_000);
	evictionTimer.unref(); // don't keep process alive

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
		return { result: applyStallWatchdog(executionId, capture.output, raw) };
	};

	return { query, stopEviction: () => clearInterval(evictionTimer) };
}
