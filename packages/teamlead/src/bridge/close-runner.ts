/**
 * FLY-102 Round 3: Lead-driven Runner lifecycle — close_runner primitive.
 *
 * Exposed via:
 *   - Bridge endpoint: POST /api/sessions/:executionId/close-runner
 *   - MCP tool (flywheel-terminal): `close_runner`
 *
 * Policy: only close tmux when the session is in a non-running outcome
 * state (see CLOSE_ELIGIBLE_STATES). This explicitly excludes running,
 * awaiting_review, approved, approved_to_ship — those states may still
 * need tmux for Runner or observer actions.
 *
 * Idempotent: returns success when the session has no tmux target or
 * the tmux session is already gone.
 */

import type { StateStore } from "../StateStore.js";
import { getTmuxTargetFromCommDb, killTmuxWindow } from "./tmux-lookup.js";

/**
 * Non-running outcome states where tmux is safe to reap. Aligns with
 * OUTCOME_STATUSES in StateStore minus approved / approved_to_ship
 * (those still need tmux for the ship step).
 */
export const CLOSE_ELIGIBLE_STATES: ReadonlySet<string> = new Set([
	"completed",
	"failed",
	"blocked",
	"rejected",
	"deferred",
	"shelved",
	"terminated",
]);

export interface CloseRunnerOpts {
	executionId: string;
	issueId: string;
	projectName: string;
	reason?: string;
	leadId?: string;
	/**
	 * Reserved for future per-executor dispatch (e.g. QA, Designer).
	 * Not currently branched on — recorded in the audit event only.
	 */
	executorType?: string;
}

export interface CloseRunnerResult {
	closed: boolean;
	alreadyGone?: boolean;
	error?: string;
}

export async function closeRunner(
	opts: CloseRunnerOpts,
	store: StateStore,
): Promise<CloseRunnerResult> {
	const session = store.getSession(opts.executionId);
	if (!session) {
		return { closed: false, error: "session_not_found" };
	}

	// FLY-102 Round 3 QA finding: audit event_id is Lead-dimensional.
	// Same Lead's retries (409 → retry is a normal pattern) collapse to one
	// audit row via UNIQUE; different Leads each get their own row.
	const auditKey = `${opts.executionId}-${opts.leadId ?? "unknown"}`;

	if (!CLOSE_ELIGIBLE_STATES.has(session.status)) {
		const err = `status_not_eligible:${session.status}`;
		store.insertEvent({
			event_id: `close-runner-blocked-${auditKey}`,
			execution_id: opts.executionId,
			issue_id: opts.issueId,
			project_name: opts.projectName,
			event_type: "lead_close_runner_blocked",
			source: "bridge.close-runner",
			payload: {
				status: session.status,
				eligibleStates: Array.from(CLOSE_ELIGIBLE_STATES),
				reason: opts.reason,
				leadId: opts.leadId,
			},
		});
		return { closed: false, error: err };
	}

	const target = getTmuxTargetFromCommDb(opts.executionId, opts.projectName);

	if (!target) {
		store.insertEvent({
			event_id: `close-runner-${auditKey}`,
			execution_id: opts.executionId,
			issue_id: opts.issueId,
			project_name: opts.projectName,
			event_type: "lead_close_runner",
			source: "bridge.close-runner",
			payload: {
				closed: true,
				alreadyGone: true,
				reason: opts.reason,
				leadId: opts.leadId,
				executorType: opts.executorType ?? "engineer",
			},
		});
		return { closed: true, alreadyGone: true };
	}

	const res = await killTmuxWindow(target.tmuxWindow);
	const eventType = res.error
		? "lead_close_runner_failed"
		: "lead_close_runner";
	// Separate key prefix per outcome so a transient failure followed by a
	// retry that succeeds still records the success audit; within the same
	// outcome, Lead-dimensional idempotency collapses duplicate retries.
	const outcomePrefix = res.error ? "close-runner-failed" : "close-runner";
	store.insertEvent({
		event_id: `${outcomePrefix}-${auditKey}`,
		execution_id: opts.executionId,
		issue_id: opts.issueId,
		project_name: opts.projectName,
		event_type: eventType,
		source: "bridge.close-runner",
		payload: {
			closed: res.killed,
			reason: opts.reason,
			leadId: opts.leadId,
			executorType: opts.executorType ?? "engineer",
			tmuxError: res.error,
		},
	});

	return { closed: res.killed, error: res.error };
}
