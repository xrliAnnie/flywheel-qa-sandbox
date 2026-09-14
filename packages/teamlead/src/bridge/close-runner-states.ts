/** FLY-116: success-style outcome states. closeRunner kills tmux + Terminal tab. */
export const AUTO_CLOSE_STATES: ReadonlySet<string> = new Set([
	"completed",
	"rejected",
	"deferred",
	"shelved",
	"terminated",
]);

/** FLY-116: crash-style outcome states. closeRunner PRESERVES tmux + tab unless forcePreserved. */
export const CRASH_PRESERVE_STATES: ReadonlySet<string> = new Set([
	"failed",
	"blocked",
]);

/**
 * FLY-638: source states a `finalizeDone` close transitions to `completed`
 * before closing. A done-but-stuck runner — ship succeeded (560/628 parked at
 * `awaiting_review` or `approved_to_ship`) or QA passed (636 still `running`)
 * but it exited before emitting its final `stage set completed`, so the FSM
 * never moved off these — sits in one of these. All three edges to `completed`
 * are FSM-legal (WORKFLOW_TRANSITIONS), so the Lead can finalize + close in one
 * step instead of hand-`pkill`-ing the body.
 */
export const FINALIZE_DONE_SOURCE_STATES: ReadonlySet<string> = new Set([
	"running",
	"ship_parked",
	"awaiting_review",
	"approved_to_ship",
	// FLY-793: a DAG workflow Design phase-session lands here (route
	// `phase_design_complete`). At handoff the workflow engine closes it with
	// `finalizeDone` → completed (FSM edge `design_done → completed` is legal) so
	// the runner/worktree free for the Implement phase. NOT surfaced to the
	// founder + no thread archive (the phases share the parent issue's thread).
	"design_done",
]);

/**
 * Back-compat: union of both sets — original CLOSE_ELIGIBLE_STATES from FLY-102 R3.
 * Some external callers / Terminal MCP doc reference this name.
 */
export const CLOSE_ELIGIBLE_STATES: ReadonlySet<string> = new Set([
	...AUTO_CLOSE_STATES,
	...CRASH_PRESERVE_STATES,
]);
