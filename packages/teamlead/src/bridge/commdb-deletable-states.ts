/**
 * FSM outcome states this reconcile may delete a CommDB `running` row for.
 * = `AUTO_CLOSE_STATES` {completed,rejected,deferred,shelved,terminated} ∪ {approved}
 * = `OUTCOME_STATUSES` − {approved_to_ship, failed, blocked}.
 *
 * `approved` is a legacy terminal FSM state (WORKFLOW_TRANSITIONS `approved: []`,
 * in OUTCOME_STATUSES) that `CLOSE_ELIGIBLE_STATES` omits — included here so a
 * `CommDB=running + FSM=approved` row is not left behind forever (Codex R1). The
 * excluded states are: `approved_to_ship` (runner still ships → non-terminal) and
 * `failed`/`blocked` (CRASH_PRESERVE — teardown target must survive).
 */
export const RECONCILE_DELETABLE_STATES: ReadonlySet<string> = new Set([
	"completed",
	"rejected",
	"deferred",
	"shelved",
	"terminated",
	"approved",
]);
