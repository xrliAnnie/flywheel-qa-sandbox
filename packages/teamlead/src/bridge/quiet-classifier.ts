/**
 * FLY-626: shared, cheap, STATELESS quiet classifier.
 *
 * The stall watchdogs (RunnerIdleWatchdog, HeartbeatService) consult this BEFORE
 * the token-expensive Lead wake. It answers one question from cheap signals only
 * (CommDB / StateStore reads + the runner's self-declared marker — no Lead wake,
 * no LLM): is this quiet legitimately explained, or is it the one case
 * (`quiet_unexplained`) that may escalate to a Lead wake (subject to the wiring
 * layer's threshold + backoff)?
 *
 * SCOPE (Codex R1 #1): this covers cheap STATELESS exemptions only. It does NOT
 * subsume the FLY-253 `stuck_dispositions` state machine or the Q7 Annie
 * fallback — those stay in StuckRunnerDetector. FLY-195's `evaluateStuckCandidate`
 * keeps its own raw-fingerprint episode logic untouched (byte-compat).
 *
 * Shared with FLY-623 (restart heartbeat reconnect uses the same predicate).
 */

import { createHash } from "node:crypto";
import { isStuckEligibleStatus } from "./stuck-candidate.js";

/** Why a quiet session is (or is not) exempt from a Lead wake. */
export type QuietVerdict =
	| "self_parked" // runner declared `park` (done-but-alive)
	| "self_long_task" // runner declared `busy` (bounded long task)
	| "done_but_running" // FLY-637 #1: stage=completed but FSM still running (FLY-324)
	| "pending_gate" // unanswered CommDB gate/ask — parked at a gate
	| "recent_comm" // messaged its Lead recently (mechanically alive)
	| "review_signal" // needs_review emitted, status not yet flipped (gray zone)
	| "parked_review_status" // awaiting_review / approved_to_ship etc. (not running)
	| "quiet_unexplained"; // nothing explains the quiet → MAY wake the Lead

export interface QuietSignals {
	/** Session status (only `running` is wake-eligible). */
	status: string;
	/** Unanswered CommDB gate/ask question from this execution. */
	hasPendingGate: boolean;
	/** Sent ANY CommDB message within the activity window (FLY-253 L1). */
	hasRecentComm: boolean;
	/** needs_review emitted but status row not flipped yet. */
	hasPendingReviewSignal: boolean;
	/** Effective runner self-declared marker kind, or null. */
	declaredKind: "parked" | "long_task" | null;
	/**
	 * FLY-637 #1 (explicit FLY-324 skip): the session reported `stage=completed`
	 * yet the FSM never moved off `running` (no PR / no decision_route — a no-code
	 * / QA Runner that finished via `stage set completed`). Such a Runner is done,
	 * not stuck. FLY-324's live handler / boot sweep normally transitions it out of
	 * `running`; this explicit signal is belt-and-suspenders for the residual cases
	 * where it slipped past (parked exclude / pending marker / race). Absent ⇒
	 * false (byte-compat). Computed by the caller via the shared `isDoneButRunning`
	 * predicate.
	 */
	isDoneButRunning?: boolean;
}

export interface QuietResult {
	verdict: QuietVerdict;
	/** True ONLY for `quiet_unexplained` — the single verdict that may wake a Lead. */
	mayWake: boolean;
}

/**
 * Classify a quiet running session from cheap stateless signals. Order is
 * cheapest-first; any explanation short-circuits to a non-waking verdict.
 */
export function classifyQuiet(signals: QuietSignals): QuietResult {
	if (!isStuckEligibleStatus(signals.status)) {
		return { verdict: "parked_review_status", mayWake: false };
	}
	// FLY-637 #1: a done-but-running Runner (stage=completed, FSM still running) is
	// finished, not stuck — explicit FLY-324 skip, before the self-declared markers.
	if (signals.isDoneButRunning) {
		return { verdict: "done_but_running", mayWake: false };
	}
	if (signals.declaredKind === "parked") {
		return { verdict: "self_parked", mayWake: false };
	}
	if (signals.declaredKind === "long_task") {
		return { verdict: "self_long_task", mayWake: false };
	}
	if (signals.hasPendingGate) {
		return { verdict: "pending_gate", mayWake: false };
	}
	if (signals.hasRecentComm) {
		return { verdict: "recent_comm", mayWake: false };
	}
	if (signals.hasPendingReviewSignal) {
		return { verdict: "review_signal", mayWake: false };
	}
	return { verdict: "quiet_unexplained", mayWake: true };
}

// ── Normalized quiet fingerprint (Codex R1 #7 / R2 LOW #4) ──
//
// FLY-195's raw fingerprint stays UNTOUCHED. For FLY-626 escalation dedup we
// need a fingerprint that ignores harmless TUI churn (status-bar ctx%, spinner
// timers) so executing↔waiting jitter does not manufacture a "new episode" that
// re-enables wakes. This normalized fingerprint is used ONLY for FLY-626 quiet
// episode dedup, never for FLY-195 stagnation.

/** Lines that are pure TUI chrome / live animation — dropped entirely. */
const VOLATILE_LINE = [
	/\bctx\s+\d+%/i, // status-bar context budget
	/bypass permissions/i, // status-bar permission hint
	/esc to (interrupt|cancel)/i, // live in-progress spinner row
	/^\s*[✻✶✳✢✽*·]\s/u, // spinner glyph at line start ("✻ Cooked for 12s")
	/\b(Cooked|Cooking|Working|Thinking|Forming|Pondering|Simmering|Brewing|Percolating|Crunching|Churning|Computing|Processing|Generating|Distilling|Synthesizing|Marinating|Conjuring|Noodling)\b.{0,40}\b\d+s\b/i,
];

/** Volatile tokens embedded in otherwise-stable lines — replaced with a marker. */
function scrubInlineVolatile(line: string): string {
	return line
		.replace(/\b\d+%/g, "#%") // percentages (ctx, progress)
		.replace(/\b\d+:\d+(:\d+)?\b/g, "#:#") // clocks
		.replace(/\b\d+(\.\d+)?s\b/g, "#s") // second timers
		.replace(/[ \t]+$/g, ""); // trailing whitespace
}

/**
 * Normalize a pane capture for FLY-626 quiet-episode dedup: drop volatile chrome
 * lines, scrub embedded timers/percentages, drop blank lines. Deterministic.
 */
export function normalizeForQuietFingerprint(output: string): string {
	return output
		.split("\n")
		.filter((l) => !VOLATILE_LINE.some((re) => re.test(l)))
		.map(scrubInlineVolatile)
		.filter((l) => l.trim().length > 0)
		.join("\n");
}

/** SHA-256 (first 16 hex) of the NORMALIZED pane — the FLY-626 quiet episode key. */
export function quietFingerprint(output: string): string {
	return createHash("sha256")
		.update(normalizeForQuietFingerprint(output))
		.digest("hex")
		.slice(0, 16);
}
