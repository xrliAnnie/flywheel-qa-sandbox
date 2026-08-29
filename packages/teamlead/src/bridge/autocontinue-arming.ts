/**
 * FLY-818: auto-continue arming — pure lifecycle-bound decision core.
 *
 * When the auto-continue feature is opted in, the Bridge observes each spawned
 * runner until it can safely "arm" self-continuation by sending `/loop <goal>`
 * ONCE into the runner's tmux window. This module is the PURE decision core (no
 * I/O): the caller injects the pane capture, session status, pending-gate
 * signal, armed state, and how long it has been observing; this returns the
 * action to take this tick.
 *
 * Design (Codex design review R1#1 / R2#1): the arm window is **lifecycle-bound**,
 * NOT a short spawn-relative timeout. A real runner's first turn can run minutes
 * to hours (onboard, read repo, write plan, run tests). A short timeout would
 * give up arming while the runner is still legitimately working, and then never
 * send `/loop` when that first turn finally ends → straight back to the FLY-818
 * idle problem (a runner that finished a turn, went idle, and nobody continued
 * it). So we keep observing — patiently — until exactly ONE of:
 *   - the idle input box appears        → `send` (arm exactly once)
 *   - the runner reached a terminal      → `skip-terminal` (never arm)
 *     state / its pane died
 *   - a blocking gate/question is        → `skip-gate` (blocked, don't nudge)
 *     persisted pending
 *   - an explicit LONG arm window        → `fail-closed` (give up, audit)
 *     elapsed
 * otherwise `wait` (keep observing). Idempotence: once armed, always `skip-armed`
 * so a Bridge restart / retry can re-drive the observe loop without a second
 * `/loop` ever being sent.
 */

import { detectInputBoxPresent } from "./stuck-candidate.js";

/**
 * Default arm window: generous enough that a genuinely long first turn (hours of
 * onboard/implement/test) still gets armed when it finally goes idle, but finite
 * so an observer can't leak forever if a runner silently stops rendering an input
 * box without its pane dying. 6h; env-tunable via `FLYWHEEL_AUTOCONTINUE_ARM_WINDOW_MS`.
 * NOTE: this is the TOTAL observe window, not a per-probe/infra wait — those are
 * bounded separately by the capture timeout in the wiring layer.
 */
export const DEFAULT_ARM_WINDOW_MS = 6 * 60 * 60_000;

/** The action the arming observer should take for a session this tick. */
export type ArmingAction =
	| "send" // idle input box visible → send `/loop <goal>` once, mark armed
	| "skip-armed" // already armed → never re-arm (idempotent)
	| "skip-terminal" // session terminal / pane dead → never arm
	| "skip-gate" // blocking gate/question pending → don't arm (blocked)
	| "wait" // none of the above yet → keep observing
	| "fail-closed"; // arm window exceeded → give up arming, audit

export interface ArmingDecisionInput {
	/** Durable arming state: has `/loop` already been sent for this execution? */
	alreadyArmed: boolean;
	/** Session status; only `running` is arm-eligible. */
	status: string;
	/** True if the runner's tmux pane is dead (terminal, even if status lags). */
	paneDead?: boolean;
	/** Live pane capture. `ok:false` (capture error) ⇒ can't see input box ⇒ wait. */
	capture: { ok: boolean; output?: string };
	/**
	 * True if a BLOCKING gate/question is persisted pending for this execution
	 * (the runner is correctly parked waiting for a human answer). Do NOT arm —
	 * arming `/loop` here would race a blocked turn. (Non-blocking `flywheel-comm
	 * ask` is NOT a pending gate and must not set this — the runner keeps working.)
	 */
	hasPendingGate: boolean;
	/** Milliseconds since this session's arming observation began (NOT since spawn). */
	elapsedMs: number;
	/** Total lifecycle-bound arm window (default {@link DEFAULT_ARM_WINDOW_MS}). */
	armWindowMs?: number;
}

/**
 * Decide the arming action for one runner this tick. Pure; fully unit-testable.
 *
 * Order matters: armed → terminal → gate → input-box → window → wait. Terminal
 * and gate take priority over the input box (a terminalized or gate-parked runner
 * must never be armed even if a stale input box lingers in the capture); the arm
 * window is checked LAST so a long first turn keeps `wait`ing (not `fail-closed`)
 * right up until it goes idle — this is the FLY-818 fix.
 */
export function decideArmingAction(input: ArmingDecisionInput): ArmingAction {
	if (input.alreadyArmed) return "skip-armed";
	if (input.status !== "running" || input.paneDead === true) {
		return "skip-terminal";
	}
	if (input.hasPendingGate) return "skip-gate";
	if (input.capture.ok && detectInputBoxPresent(input.capture.output ?? "")) {
		return "send";
	}
	const window = input.armWindowMs ?? DEFAULT_ARM_WINDOW_MS;
	if (input.elapsedMs >= window) return "fail-closed";
	return "wait";
}
