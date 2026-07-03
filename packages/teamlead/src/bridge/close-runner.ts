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
import {
	type ApplyTransitionOpts,
	applyTransition,
} from "../applyTransition.js";
import type { StateStore } from "../StateStore.js";
import { requestCmuxPinClose } from "./cmux-close-request.js";
import { deleteCommDbSession } from "./commdb-session-prune.js";
import {
	type CloseArchiveDeps,
	maybeArchiveThreadOnClose,
} from "./done-thread-archiver.js";
import { resolveTerminalViewIdentity } from "./terminal-view-identity.js";
import {
	getTmuxTargetFromCommDb,
	killCmuxLinkedSession,
	killTmuxWindow,
} from "./tmux-lookup.js";
import { sqliteDatetime } from "./types.js";

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
	"awaiting_review",
	"approved_to_ship",
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
	/**
	 * FLY-638: done-mode finalize. When true AND the session is stuck in a
	 * non-terminal but DONE state (running/awaiting_review/approved_to_ship — see
	 * FINALIZE_DONE_SOURCE_STATES), the close FIRST transitions it to `completed`
	 * via the FSM (so the eligibility gate passes AND the FLY-369 archive cascade,
	 * which is gated on `completed`, fires) before tearing down. The Lead's
	 * invocation is the authority — close_runner is already a founder-consent
	 * reserved action — so we do NOT auto-finalize without this flag; a genuinely
	 * under-review runner is never silently completed + archived. Requires
	 * `transitionOpts`.
	 */
	finalizeDone?: boolean;
	/**
	 * FLY-638: FSM transition opts, required when `finalizeDone` is set so the
	 * done-finalize goes through the canonical `applyTransition` path. Absent →
	 * `finalizeDone` is refused (`finalize_done_unavailable`) rather than bypassing
	 * the FSM.
	 */
	transitionOpts?: ApplyTransitionOpts;
	/**
	 * FLY-369: when provided, a successful done-cleanup close (status=completed
	 * with no other active runner for the issue) cascades to archiving the
	 * issue's Discord chat thread via the central `maybeArchiveThreadOnClose`.
	 * Absent (legacy/internal callers) → no archive. Fire-and-forget; archive
	 * failures never affect the close result.
	 */
	archive?: CloseArchiveDeps;
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
	let session = store.getSession(opts.executionId);
	if (!session) {
		return { closed: false, error: "session_not_found" };
	}

	// FLY-102 Round 3 QA finding: audit event_id is Lead-dimensional.
	const auditKey = `${opts.executionId}-${opts.leadId ?? "unknown"}`;

	// FLY-638: done-mode finalize. A done-but-stuck runner (ship succeeded / QA
	// passed but it exited before its final `stage set completed`, so the FSM
	// never moved off running/awaiting_review/approved_to_ship) is transitioned to
	// `completed` HERE — before the eligibility gate — so the close proceeds AND
	// the FLY-369 archive cascade fires. Lead-asserted (explicit `finalizeDone`
	// flag); never auto-applied. CRASH_PRESERVE_STATES (failed/blocked) are NOT in
	// FINALIZE_DONE_SOURCE_STATES — a crash is not "done", so done-mode leaves them
	// to the preserve gate below.
	if (opts.finalizeDone && FINALIZE_DONE_SOURCE_STATES.has(session.status)) {
		if (!opts.transitionOpts) {
			// Defensive: production wires transitionOpts. Without it we cannot
			// transition through the FSM, and must not forceStatus past it.
			return { closed: false, error: "finalize_done_unavailable" };
		}
		const priorStatus = session.status;
		const fin = applyTransition(
			opts.transitionOpts,
			opts.executionId,
			"completed",
			{
				executionId: opts.executionId,
				issueId: opts.issueId,
				projectName: opts.projectName,
				trigger: "fly638_close_runner_done",
			},
			{ last_activity_at: sqliteDatetime() },
		);
		if (!fin.ok) {
			return {
				closed: false,
				error: `finalize_done_rejected:${fin.error ?? "fsm"}`,
			};
		}
		store.insertEvent({
			event_id: `close-runner-finalized-${auditKey}`,
			execution_id: opts.executionId,
			issue_id: opts.issueId,
			project_name: opts.projectName,
			event_type: "lead_close_runner_finalized",
			source: "bridge.close-runner",
			payload: {
				fromStatus: priorStatus,
				toStatus: "completed",
				reason: opts.reason,
				leadId: opts.leadId,
				executorType: opts.executorType ?? "engineer",
			},
		});
		// Re-fetch so the rest of the close runs against status=completed.
		session = store.getSession(opts.executionId) ?? session;
	}

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
		// FLY-369: runner is closed (already gone) → central close→archive
		// cascade. Guarded inside to done-cleanup (completed) + no other active
		// runner. Runs only on this success path (Codex code review R6 #1).
		if (opts.archive) {
			await maybeArchiveThreadOnClose(store, session, opts.archive);
		}
		// FLY-638: tmux is already gone → drop the dead CommDB session row so it
		// doesn't linger in runner_terminal_list / bootstrap.
		deleteCommDbSession(opts.executionId, opts.projectName);
		return { closed: true, alreadyGone: true };
	}

	// FLY-638: kill the per-runner cmux LINKED session BEFORE killTmuxWindow
	// (display-message needs the window alive to read its name). Best-effort —
	// a cmux-resolve/kill failure must never block the window kill or the close.
	const cmuxRes = await killCmuxLinkedSession(target.tmuxWindow).catch(
		(e: Error) => {
			console.warn(`[close-runner] cmux session close warn: ${e.message}`);
			return undefined;
		},
	);

	// success path: kill tmux window
	const res = await killTmuxWindow(target.tmuxWindow);

	// FLY-116: also close the per-runner Terminal tab + linked viewer session.
	// Only do this when the tmux kill actually succeeded — if kill failed
	// (e.g. permission), closing the tab anyway would hide a still-running
	// runner from the user (Codex Round 1 PR review #3).
	if (res.killed) {
		// FLY-685: request cmux workspace-pin (sidebar tab) removal — BEFORE the
		// terminal-view close (Codex design R1 #1). `closeRunnerTerminalView`
		// awaits an `osascript` call with no exec timeout; if it stalls, the tmux
		// window is already gone but the pin would fall back to the 5-min FLY-293
		// reaper. Writing the marker first preserves the "next watcher tick" path.
		// window_name = the cmux workspace TITLE, reused from killCmuxLinkedSession's
		// already-resolved `cmuxSession` ("cmux-<window_name>"). Absent → the window
		// was already gone → nothing to target (FLY-293 reaper still backstops).
		// Best-effort: never throws, never blocks the close; the watcher still
		// re-validates the window + linked session are gone before closing the pin.
		const cmuxWindowName = cmuxRes?.cmuxSession?.startsWith("cmux-")
			? cmuxRes.cmuxSession.slice("cmux-".length)
			: undefined;
		if (cmuxWindowName) requestCmuxPinClose(cmuxWindowName);

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

	// FLY-369: central close→archive cascade — ONLY when the close actually
	// succeeded (Codex code review R6 #1: a kill failure must NOT archive). The
	// cascade is itself guarded to done-cleanup (completed) + no other active
	// runner; it runs after terminal-tab cleanup and never affects the result.
	if (res.killed && opts.archive) {
		await maybeArchiveThreadOnClose(store, session, opts.archive);
	}

	// FLY-638: on a successful close the runner's tmux window is gone → drop its
	// CommDB session row. Only on the killed path — a kill failure leaves the row
	// (and the still-alive runner) for retry.
	if (res.killed) {
		deleteCommDbSession(opts.executionId, opts.projectName);
	}

	return { closed: res.killed, error: res.error };
}
