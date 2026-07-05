/**
 * FLY-626: runner self-declared liveness state — `park` / `busy` / `unpark`.
 *
 * A runner declares its intent so the Bridge stall watchdogs do not waste a
 * (token-expensive) Lead wake on it:
 *   - `park`  → done-but-alive (idle by design, kept for iteration). May be
 *               indefinite; the watchdog fully suppresses wakes. Orphan / tmux
 *               liveness reaping stays active (a dead parked runner is still
 *               reaped — see HeartbeatService).
 *   - `busy`  → actively working on something that legitimately produces no pane
 *               activity for a while (codex review, big build). Always bounded:
 *               default 60m, hard max 4h, renewable by re-declaring.
 *   - `unpark`→ clear any declaration.
 *
 * A declaration is cleared by: explicit `unpark`; the marker's own expiry
 * (`busy` is always bounded; `park --until`); or a Lead/founder RE-ENGAGEMENT —
 * a `flywheel-comm send` instruction to the runner clears its marker so the
 * watchdogs resume (Codex code-review #1, protects FLY-369). An indefinite
 * `park` with no re-engagement persists until `unpark` — orphan/tmux liveness
 * reaping stays active throughout, so a dead parked runner is still reaped.
 *
 * The marker is written to CommDB (`runner_declared_states`) so it survives a
 * Bridge restart and is read cheaply by the watchdog classifier.
 */

import type { CommDB } from "../db.js";

/** `busy` default expected-quiet window when `--expect` is omitted. */
export const BUSY_DEFAULT_MS = 60 * 60_000; // 60 min
/** `busy` hard ceiling — a single declaration can never exceed this. */
export const BUSY_MAX_MS = 4 * 3_600_000; // 4 h

/**
 * Parse a duration like `45s` / `30m` / `2h` / `1d`. A bare number is minutes.
 * Returns milliseconds, or null for garbage / non-positive input.
 */
export function parseDuration(input: string): number | null {
	const m = /^(\d+)([smhd]?)$/.exec(input.trim());
	if (!m) return null;
	const n = Number.parseInt(m[1] ?? "", 10);
	if (!Number.isFinite(n) || n <= 0) return null;
	const unit = m[2] || "m";
	const factor =
		unit === "s"
			? 1_000
			: unit === "m"
				? 60_000
				: unit === "h"
					? 3_600_000
					: 24 * 3_600_000; // "d"
	return n * factor;
}

export interface DeclareStateOpts {
	action: "park" | "busy" | "unpark";
	execId: string;
	/** Injectable clock (epoch ms). */
	nowMs: number;
	/** park `--reason` / busy `--task`. */
	reason?: string | null;
	/** park `--until` / busy `--expect`, already parsed to ms. */
	durationMs?: number | null;
}

export interface DeclareStateResult {
	kind: "parked" | "long_task" | null;
	expiresAtMs: number | null;
}

/**
 * Apply a self-declared state to the CommDB. Pure-ish (clock injected) so the
 * bounding logic is unit-testable without a real runner. `busy` is always
 * bounded (default + cap); `park` may be indefinite.
 */
export function declareState(
	db: CommDB,
	opts: DeclareStateOpts,
): DeclareStateResult {
	const { action, execId, nowMs } = opts;
	if (action === "unpark") {
		db.clearDeclaredState(execId);
		return { kind: null, expiresAtMs: null };
	}
	if (action === "park") {
		const expiresAtMs =
			opts.durationMs != null ? nowMs + opts.durationMs : null;
		db.upsertDeclaredState(
			execId,
			"parked",
			opts.reason ?? null,
			nowMs,
			expiresAtMs,
		);
		return { kind: "parked", expiresAtMs };
	}
	// busy — always bounded
	const window = Math.min(opts.durationMs ?? BUSY_DEFAULT_MS, BUSY_MAX_MS);
	const expiresAtMs = nowMs + window;
	db.upsertDeclaredState(
		execId,
		"long_task",
		opts.reason ?? null,
		nowMs,
		expiresAtMs,
	);
	return { kind: "long_task", expiresAtMs };
}
