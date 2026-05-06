/**
 * FLY-102 Round 3 + FLY-116: Lead-driven Runner lifecycle — close_runner primitive.
 *
 * Exposed via:
 *   - Bridge endpoint: POST /api/sessions/:executionId/close-runner
 *   - MCP tool (flywheel-terminal): `close_runner`
 *
 * Status policy (FLY-116 split):
 *   - AUTO_CLOSE_STATES (completed/rejected/deferred/shelved/terminated):
 *       kill tmux window AND close macOS Terminal viewer tab.
 *   - CRASH_PRESERVE_STATES (failed/blocked):
 *       PRESERVE — do NOT kill tmux, do NOT close Terminal tab. The user can
 *       attach to the dead window and inspect scrollback. Cleanup happens
 *       later when the user transitions to a follow-up state (retry/shelve/
 *       defer/terminate) which calls closeRunner({ forcePreserved: true }).
 *   - Other statuses (running/awaiting_review/approved/approved_to_ship):
 *       status_not_eligible — request rejected.
 *
 * Idempotent: returns success when the session has no tmux target or
 * the tmux session is already gone. Orphan Terminal tabs (no CommDB target)
 * are NOT closed here — the boot reaper handles them at startup.
 */

import { closeRunnerTerminalView } from "flywheel-core";
import type { StateStore } from "../StateStore.js";
import { resolveTerminalViewIdentity } from "./terminal-view-identity.js";
import { getTmuxTargetFromCommDb, killTmuxWindow } from "./tmux-lookup.js";

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
 * Back-compat: union of both sets — original CLOSE_ELIGIBLE_STATES from FLY-102 R3.
 * Some external callers / Terminal MCP doc reference this name.
 */
export const CLOSE_ELIGIBLE_STATES: ReadonlySet<string> = new Set([
	...AUTO_CLOSE_STATES,
	...CRASH_PRESERVE_STATES,
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
	/**
	 * FLY-116: bypass CRASH_PRESERVE_STATES gate. Used by retry / explicit
	 * cleanup actions when the user has already inspected the dead window
	 * and decided to clean it. Only takes effect for failed/blocked status
	 * (no-op for AUTO_CLOSE_STATES which already close).
	 */
	forcePreserved?: boolean;
}

export interface CloseRunnerResult {
	closed: boolean;
	alreadyGone?: boolean;
	/** FLY-116: true when crash status preserved tmux + tab. */
	preserved?: boolean;
	/** FLY-116: "crash_preserve" when preserved=true. */
	reason?: "crash_preserve";
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
	const auditKey = `${opts.executionId}-${opts.leadId ?? "unknown"}`;

	const isPreserveState = CRASH_PRESERVE_STATES.has(session.status);
	const forceClose = !!opts.forcePreserved && isPreserveState;

	// FLY-116 preserve gate: don't close failed/blocked unless forced.
	if (isPreserveState && !opts.forcePreserved) {
		store.insertEvent({
			event_id: `close-runner-preserved-${auditKey}`,
			execution_id: opts.executionId,
			issue_id: opts.issueId,
			project_name: opts.projectName,
			event_type: "lead_close_runner_preserved",
			source: "bridge.close-runner",
			payload: {
				status: session.status,
				reason: "crash_preserve",
				leadId: opts.leadId,
				executorType: opts.executorType ?? "engineer",
			},
		});
		return { closed: false, preserved: true, reason: "crash_preserve" };
	}

	// Eligibility gate: AUTO_CLOSE_STATES OR force-closing a preserve state.
	if (!AUTO_CLOSE_STATES.has(session.status) && !forceClose) {
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
		// CommDB has no target → tmux already gone. We don't attempt osascript
		// close here (without target.tmuxWindow we can't reconstruct viewer
		// identity). Orphan tabs are the boot reaper's responsibility.
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
				forcedPreserved: forceClose || undefined,
			},
		});
		return { closed: true, alreadyGone: true };
	}

	// success path: kill tmux window
	const res = await killTmuxWindow(target.tmuxWindow);

	// FLY-116: also close the per-runner Terminal tab + linked viewer session.
	// Only do this when the tmux kill actually succeeded — if kill failed
	// (e.g. permission), closing the tab anyway would hide a still-running
	// runner from the user (Codex Round 1 PR review #3).
	if (res.killed) {
		const identity = resolveTerminalViewIdentity(session, target);
		if (identity) {
			await closeRunnerTerminalView({
				baseSessionName: identity.sessionName,
				projectName: identity.projectName,
				executionId: identity.executionId,
				windowId: identity.windowId,
				sessionRole: identity.sessionRole,
			}).catch((e: Error) =>
				console.warn(`[close-runner] terminal close warn: ${e.message}`),
			);
		} else {
			console.warn(
				`[close-runner] could not resolve viewer identity for ${opts.executionId} (tmuxWindow=${target.tmuxWindow}); skipping terminal close`,
			);
		}
	}

	const eventType = res.error
		? "lead_close_runner_failed"
		: forceClose
			? "lead_close_runner_force_preserved"
			: "lead_close_runner";
	const outcomePrefix = res.error
		? "close-runner-failed"
		: forceClose
			? "close-runner-force"
			: "close-runner";
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
			forcedPreserved: forceClose || undefined,
			previousStatus: forceClose ? session.status : undefined,
		},
	});

	return { closed: res.killed, error: res.error };
}
