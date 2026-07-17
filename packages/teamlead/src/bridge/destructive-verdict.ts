import type { RunnerLiveness } from "./tmux-lookup.js";

/**
 * FLY-1329 (A1): the four-input destructive verdict.
 *
 * THE INCIDENT (FLY-1319, 2026-07-16): a park-alive implement session was force
 * closed — StateStore flipped to `completed`, its CommDB row deleted — while its
 * process was still running and still sending `ask`s. The trigger was a single
 * input: `handoff()` read liveness `absent` and took it as proof of death.
 *
 * `absent` is not proof of death. It means the tmux WINDOW could not be found at
 * the name we looked up, which a stale CommDB `tmux_window` mapping (or a window
 * rename) produces on a perfectly healthy runner. Only `dead_pin` — a window that
 * exists whose every pane is a remain-on-exit corpse — is positive evidence that
 * the process died.
 *
 * So destruction is never derived from liveness alone. Every destructive
 * lifecycle action is decided from four inputs:
 *
 *   - `action`         — what is about to be destroyed, and in which context;
 *   - `authority`      — an INDEPENDENT positive right to destroy, held without
 *                        reference to liveness (a post-ship claim, a founder
 *                        disposition, a freshly re-read terminal FSM row, a
 *                        legitimate completed assertion);
 *   - `declaredParked` — an unexpired `runner_declared_states` park marker: the
 *                        runner itself declaring "I am alive and waiting";
 *   - `liveness`       — the probe, which authorizes ONLY on `dead_pin`.
 *
 * Activity evidence (A2: heartbeat_at / recent CommDB messages) deliberately does
 * NOT appear here. It annotates alerts; it never moves a verdict. A verdict that
 * swung on "was there traffic in the last 10 minutes" would be unreproducible.
 */

/** The destructive lifecycle actions this verdict guards. */
export type DestructiveAction =
	/** `handoff()` closing the previous phase instead of parking it. */
	| "handoff_close"
	/** Abandoning a wake and spawning a replacement runner in its place. */
	| "wake_replacement_spawn"
	/** Deleting a CommDB session row left behind by a terminal session (A4). */
	| "commdb_residue_prune"
	/** FLY-324: forcing a `running` row to `completed` from a stage assertion (A5). */
	| "completed_assertion";

/**
 * A positive right to destroy that stands on its own, independent of liveness.
 * `none` = no such right; the verdict then rests on liveness alone, which means
 * only `dead_pin` can authorize.
 */
export type LifecycleAuthority =
	| "none"
	/** post-ship finalization holds the claim; the session's work is shipped. */
	| "post_ship_claim"
	/** founder / issue-terminal disposition (forcePreserved + audited paths). */
	| "founder_disposition"
	/** A FRESH re-read of the FSM shows a terminal status. Staleness here is a bug. */
	| "fsm_terminal"
	/** FLY-324: a legitimate `stage_changed`-borne completed assertion. */
	| "completed_assertion";

export interface DestructiveVerdictInput {
	action: DestructiveAction;
	authority: LifecycleAuthority;
	/** An UNEXPIRED park declaration. Expired markers must arrive here as false. */
	declaredParked: boolean;
	liveness: RunnerLiveness;
}

export interface DestructiveVerdict {
	allowed: boolean;
	/** Human-readable rationale — goes verbatim into the audit/alert body. */
	reason: string;
	/** Which input granted the right, when allowed. */
	authorizedBy?: Exclude<LifecycleAuthority, "none"> | "dead_pin";
	/** Which rule refused, when denied. */
	vetoedBy?: "parked_declaration" | "liveness";
	/** The session_event kind the caller must record for this verdict. */
	auditKind?: "prune_skipped_parked_conflict";
}

/**
 * The contexts where a runner's own park declaration is a VETO.
 *
 * A4/A5 are reconcile sweeps: they act on rows from the outside, so a runner
 * saying "I am parked and alive" contradicts the sweep's premise and must stop
 * it. `handoff_close` is the pipeline's own boundary — the park marker there
 * describes the very session being handed off from, so it carries no contrary
 * information and must not veto.
 */
const PARKED_VETO_ACTIONS: ReadonlySet<DestructiveAction> = new Set([
	"commdb_residue_prune",
	"completed_assertion",
]);

/**
 * Authorities that outrank the parked veto. Both are terminal by construction:
 * a shipped session's park marker is stale residue, and a founder disposition is
 * the highest authority in the system.
 */
const OUTRANKS_PARKED_VETO: ReadonlySet<LifecycleAuthority> = new Set([
	"post_ship_claim",
	"founder_disposition",
]);

/**
 * The actions positive death evidence (`dead_pin`) authorizes ON ITS OWN.
 *
 * These are all liveness-derived cleanups: closing a corpse's phase, abandoning a
 * wake for a spawn, pruning a dead session's CommDB residue. `completed_assertion`
 * is deliberately NOT here — asserting a session COMPLETED is an FSM claim about
 * its work, not a cleanup, and "the process died" is not evidence the work
 * completed legitimately. A completed assertion needs a completion authority
 * (`completed_assertion` / post-ship / founder), never a death probe (Codex R1
 * MEDIUM).
 */
const DEAD_PIN_AUTHORIZES: ReadonlySet<DestructiveAction> = new Set([
	"handoff_close",
	"wake_replacement_spawn",
	"commdb_residue_prune",
]);

/**
 * Which independent authorities may authorize which action (Codex R2 MEDIUM).
 *
 * Round 1's `dead_pin` fix left the authority branch (step 2) as a blanket "any
 * non-`none` authority authorizes any action" — which allowed nonsense pairs the
 * review reproduced: `wake_replacement_spawn + fsm_terminal` (a terminal FSM row
 * is not a licence to abandon a wake and spawn a replacement) and
 * `handoff_close + completed_assertion` (a completion claim is not a licence to
 * close a handoff over a live phase). An authority only grants a right over the
 * action its domain actually covers:
 *
 *   - `founder_disposition` is the top authority — it covers every action.
 *   - `post_ship_claim` covers finalizing a shipped session: pruning its CommDB
 *     residue and asserting it completed. It is NOT a mid-pipeline liveness tool.
 *   - `fsm_terminal` (a fresh terminal FSM re-read) covers pruning terminal
 *     residue only (the A4 shape) — never a wake/handoff/completion action.
 *   - `completed_assertion` (a stage-borne completion) covers the A5 completed
 *     assertion only.
 *
 * An authority absent from an action's set grants NO right; the verdict then
 * falls through to liveness, where only `dead_pin` can authorize.
 */
const ACTION_AUTHORITY_MATRIX: Readonly<
	Record<DestructiveAction, ReadonlySet<Exclude<LifecycleAuthority, "none">>>
> = {
	handoff_close: new Set(["founder_disposition"]),
	wake_replacement_spawn: new Set(["founder_disposition"]),
	commdb_residue_prune: new Set([
		"post_ship_claim",
		"founder_disposition",
		"fsm_terminal",
	]),
	completed_assertion: new Set([
		"completed_assertion",
		"post_ship_claim",
		"founder_disposition",
	]),
};

export function decideDestructive(
	input: DestructiveVerdictInput,
): DestructiveVerdict {
	const { action, authority, declaredParked, liveness } = input;

	// 1. The parked veto runs FIRST for the reconcile contexts — an unexpired park
	//    declaration means a live runner is asserting itself, and no sweep may act
	//    over that assertion. Only post-ship/founder authority outranks it.
	if (
		declaredParked &&
		PARKED_VETO_ACTIONS.has(action) &&
		!OUTRANKS_PARKED_VETO.has(authority)
	) {
		return {
			allowed: false,
			reason: `${action} refused: an unexpired parked declaration contradicts it (the runner declares itself alive and waiting); authority=${authority} does not outrank a park declaration`,
			vetoedBy: "parked_declaration",
			auditKind: "prune_skipped_parked_conflict",
		};
	}

	// 2. Independent positive authority — decided WITHOUT consulting liveness,
	//    BUT only when the authority's domain actually covers this action
	//    (ACTION_AUTHORITY_MATRIX, Codex R2). A non-`none` authority that does not
	//    cover the action grants no right and falls through to liveness below.
	//    `fsm_terminal` is the A4 shape the R2-1 review corrected v2 on: after a
	//    normal teardown the window is necessarily `absent`, so requiring liveness
	//    evidence here would make terminal residue permanently unprunable.
	if (authority !== "none" && ACTION_AUTHORITY_MATRIX[action].has(authority)) {
		return {
			allowed: true,
			reason: `${action} authorized by ${authority} (independent of liveness=${liveness})`,
			authorizedBy: authority,
		};
	}

	// 3. No independent authority → liveness alone decides, and only positive
	//    death evidence counts — AND only for the liveness-derived cleanup actions.
	//    Death never authorizes a completed_assertion (see DEAD_PIN_AUTHORIZES).
	if (liveness === "dead_pin" && DEAD_PIN_AUTHORIZES.has(action)) {
		return {
			allowed: true,
			reason: `${action} authorized by dead_pin (window exists, every pane is a remain-on-exit corpse — the process is provably dead)`,
			authorizedBy: "dead_pin",
		};
	}

	// `absent` is the FLY-1319 trap: a window-name miss, NOT proof of death.
	// `indeterminate` is a probe failure. `alive` is the opposite of a reason.
	// A held-but-non-covering authority (step 2 fell through) is named so the
	// audit body does not misreport it as "no authority held" — in BOTH the
	// absent and the other-liveness branches (Codex R2 + R3).
	const authorityNote =
		authority === "none"
			? "no independent authority was held"
			: `authority=${authority} does not cover ${action}`;
	const absentAuthoritySuffix =
		authority === "none"
			? ""
			: ` (also: authority=${authority} does not cover ${action})`;
	return {
		allowed: false,
		reason:
			liveness === "absent"
				? `${action} refused: liveness=absent proves only that no window answered to that name (stale CommDB mapping / rename), NOT that the process died — FLY-1319 closed a live park-alive session on exactly this input${absentAuthoritySuffix}`
				: `${action} refused: liveness=${liveness} is not positive death evidence and ${authorityNote}`,
		vetoedBy: "liveness",
	};
}
