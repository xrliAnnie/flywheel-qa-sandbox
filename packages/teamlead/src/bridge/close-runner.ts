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
import {
	isResidentCodexPhase,
	prepareCodexPhaseShutdown,
} from "./codex-phase-shutdown.js";
import {
	type FinalizeCommDbResult,
	finalizeCommDbSession,
} from "./commdb-session-prune.js";
import {
	type CloseArchiveDeps,
	maybeArchiveThreadOnClose,
} from "./done-thread-archiver.js";
import { reapRunnerMcp } from "./runner-teardown.js";
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
	// FLY-793: a three-stage Design phase-session lands here (route
	// `phase_design_complete`). At handoff the PhaseOrchestrator closes it with
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
	 * FLY-1185 (Codex R1#13): issue-terminal authority override. Set ONLY by
	 * the lifecycle-closeout executor when the ISSUE is terminal (shipped /
	 * canceled / founder-parked): a residual live husk whose status is outside
	 * the eligible sets (e.g. legacy `approved`) is still torn down — status
	 * untouched, teardown only, audited. Never set by Lead/founder actions.
	 */
	issueTerminalOverride?: boolean;
	/** FLY-1185 (Codex R2#3): set ONLY by the lifecycle executor, which
	 * already holds the issue mutex (the keyed lock is not re-entrant). */
	skipLifecycleGuard?: boolean;
	/**
	 * FLY-1185 (Codex R4#2): fresh-authority re-check threaded INTO the kill
	 * sequence — closeRunner awaits several slow external boundaries (MCP
	 * reap, cmux kill, tmux kill, terminal-view close); a Linear reopen
	 * landing between them must stop the remaining teardown. Called before
	 * each subsequent external mutation; `ok:false` (or a throw — fail-closed)
	 * aborts with `authority_lost`. Absent → byte-compatible (single up-front
	 * check by the caller only).
	 */
	authorityCheck?: () => Promise<{ ok: boolean; reason?: string }>;
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

/**
 * FLY-1185 (Codex R2#3) — the B/C entries' unification seam. Every
 * `closeRunner` call (explicit close endpoint, reject/defer/shelve actions,
 * legacy reconcile finalize) serializes through the SAME per-issue mutex the
 * unified executor uses, so an explicit close can never interleave with a
 * ship/park/apply closeout on the same issue. Registered once at the Bridge
 * composition root; absent (tests / non-Bridge callers) → legacy behavior.
 * The executor itself passes `skipLifecycleGuard` (it already holds the
 * mutex — the keyed lock is NOT re-entrant).
 */
export interface LifecycleCloseGuard {
	withIssueMutex: <T>(keys: string[], fn: () => Promise<T>) => Promise<T>;
	resolveLockKeys: (store: StateStore, issueId: string) => string[];
}
let lifecycleCloseGuard: LifecycleCloseGuard | undefined;
export function registerLifecycleCloseGuard(
	guard: LifecycleCloseGuard,
): () => void {
	lifecycleCloseGuard = guard;
	return () => {
		if (lifecycleCloseGuard === guard) lifecycleCloseGuard = undefined;
	};
}

export interface CloseRunnerResult {
	closed: boolean;
	/** FLY-1238: true only after unresolved CommDB gates and the session row
	 * were retired in one transaction (or the project has no CommDB). */
	commDbFinalized: boolean;
	retiredGateCount: number;
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
	// Codex R2#3: serialize with the unified executor's issue mutex.
	if (lifecycleCloseGuard && !opts.skipLifecycleGuard) {
		const guard = lifecycleCloseGuard;
		const keys = guard.resolveLockKeys(store, opts.issueId);
		return guard.withIssueMutex(keys, () =>
			closeRunnerInner({ ...opts, skipLifecycleGuard: true }, store),
		);
	}
	return closeRunnerInner(opts, store);
}

async function closeRunnerInner(
	opts: CloseRunnerOpts,
	store: StateStore,
): Promise<CloseRunnerResult> {
	let session = store.getSession(opts.executionId);
	if (!session) {
		return {
			closed: false,
			commDbFinalized: false,
			retiredGateCount: 0,
			error: "session_not_found",
		};
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
			return {
				closed: false,
				commDbFinalized: false,
				retiredGateCount: 0,
				error: "finalize_done_unavailable",
			};
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
				commDbFinalized: false,
				retiredGateCount: 0,
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
		return {
			closed: false,
			commDbFinalized: false,
			retiredGateCount: 0,
			preserved: true,
			reason: "crash_preserve",
		};
	}

	// Eligibility gate: AUTO_CLOSE_STATES OR force-closing a preserve state OR
	// the FLY-1185 issue-terminal authority (residual husk teardown, audited).
	if (
		!AUTO_CLOSE_STATES.has(session.status) &&
		!forceClose &&
		!opts.issueTerminalOverride
	) {
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
		return {
			closed: false,
			commDbFinalized: false,
			retiredGateCount: 0,
			error: err,
		};
	}

	if (
		opts.issueTerminalOverride &&
		!AUTO_CLOSE_STATES.has(session.status) &&
		!forceClose
	) {
		store.insertEvent({
			event_id: `close-runner-issue-terminal-override-${auditKey}`,
			execution_id: opts.executionId,
			issue_id: opts.issueId,
			project_name: opts.projectName,
			event_type: "lead_close_runner_issue_terminal_override",
			source: "bridge.close-runner",
			payload: {
				status: session.status,
				reason: opts.reason,
				leadId: opts.leadId,
			},
		});
	}

	const finalizeCommunications = (): FinalizeCommDbResult => {
		const finalized = finalizeCommDbSession(opts.executionId, opts.projectName);
		store.recordCommDbFinalizeOutcome({
			executionId: opts.executionId,
			issueId: opts.issueId,
			projectName: opts.projectName,
			ok: finalized.ok,
			error: finalized.error,
		});
		if (!finalized.ok) {
			store.insertEvent({
				event_id: `close-runner-commdb-finalize-failed-${auditKey}`,
				execution_id: opts.executionId,
				issue_id: opts.issueId,
				project_name: opts.projectName,
				event_type: "lead_close_runner_commdb_finalize_failed",
				source: "bridge.close-runner",
				payload: {
					error: finalized.error,
					reason: opts.reason,
					leadId: opts.leadId,
				},
			});
		}
		return finalized;
	};

	// FLY-1269: a resident Codex phase owns a daemon + founder TUI beyond its
	// phase-complete status. Issue-terminal close must ask that controller to
	// drain first; only a proven orphan may use the legacy direct kill below.
	// Claude phases and ordinary Codex executions are not applicable and remain
	// byte-compatible.
	if (isResidentCodexPhase(session)) {
		if (opts.authorityCheck) {
			try {
				const authority = await opts.authorityCheck();
				if (!authority.ok) {
					return {
						closed: false,
						commDbFinalized: false,
						retiredGateCount: 0,
						error: `authority_lost:pre_phase_shutdown:${authority.reason ?? "authority_lost"}`,
					};
				}
			} catch (err) {
				return {
					closed: false,
					commDbFinalized: false,
					retiredGateCount: 0,
					error: `authority_lost:pre_phase_shutdown:authority_check_failed:${(err as Error).message}`,
				};
			}
		}
		const shutdown = await prepareCodexPhaseShutdown({
			executionId: opts.executionId,
			projectName: opts.projectName,
			getSession: () => store.getSession(opts.executionId),
		});
		if (shutdown.kind === "blocked") {
			store.insertEvent({
				event_id: `close-runner-phase-shutdown-blocked-${auditKey}`,
				execution_id: opts.executionId,
				issue_id: opts.issueId,
				project_name: opts.projectName,
				event_type: "lead_close_runner_failed",
				source: "bridge.close-runner",
				payload: {
					closed: false,
					reason: opts.reason,
					phaseShutdownError: shutdown.error,
				},
			});
			return {
				closed: false,
				commDbFinalized: false,
				retiredGateCount: 0,
				error: shutdown.error,
			};
		}
		if (shutdown.kind === "graceful") {
			if (opts.authorityCheck) {
				try {
					const authority = await opts.authorityCheck();
					if (!authority.ok) {
						return {
							closed: false,
							commDbFinalized: false,
							retiredGateCount: 0,
							error: `authority_lost:post_phase_shutdown:${authority.reason ?? "authority_lost"}`,
						};
					}
				} catch (err) {
					return {
						closed: false,
						commDbFinalized: false,
						retiredGateCount: 0,
						error: `authority_lost:post_phase_shutdown:authority_check_failed:${(err as Error).message}`,
					};
				}
			}
			store.insertEvent({
				event_id: `close-runner-${auditKey}`,
				execution_id: opts.executionId,
				issue_id: opts.issueId,
				project_name: opts.projectName,
				event_type: forceClose
					? "lead_close_runner_force_preserved"
					: "lead_close_runner",
				source: "bridge.close-runner",
				payload: {
					closed: true,
					reason: opts.reason,
					leadId: opts.leadId,
					executorType: opts.executorType ?? "engineer",
					phaseShutdownRequestId: shutdown.requestId,
					forcedPreserved: forceClose || undefined,
				},
			});
			markDetectionClearingSafe(store, opts.executionId);
			const finalized = finalizeCommunications();
			if (!finalized.ok) {
				return {
					closed: true,
					commDbFinalized: false,
					retiredGateCount: 0,
					error: `commdb_finalize_failed:${finalized.error ?? "unknown"}`,
				};
			}
			if (opts.archive) {
				await maybeArchiveThreadOnClose(store, session, opts.archive);
			}
			return {
				closed: true,
				commDbFinalized: true,
				retiredGateCount: finalized.retiredGateCount,
			};
		}
	}

	// FLY-1048 PR-C (C5): detection episodes flip to CLEARING only on the two
	// SUCCESS paths below (already-gone / killed) — a refused close or a failed
	// tmux kill leaves a possibly-still-alive runner, and muting its detection
	// for the clearing TTL would blind the very watchdog this flow exists for.
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
		// FLY-1048 PR-C (C5): the runner is entering cleanup — mute its detection
		// episodes (CLEARING) so half-torn-down state cannot spam the Lead. Only
		// on success paths; best-effort (a marking failure must not block close).
		markDetectionClearingSafe(store, opts.executionId);
		// FLY-1238: retire every unresolved gate in the same transaction that
		// deletes the CommDB session. Archival is forbidden until this succeeds;
		// otherwise a zombie gate could still consume founder speech.
		const finalized = finalizeCommunications();
		if (!finalized.ok) {
			return {
				closed: true,
				alreadyGone: true,
				commDbFinalized: false,
				retiredGateCount: 0,
				error: `commdb_finalize_failed:${finalized.error ?? "unknown"}`,
			};
		}
		// FLY-369: runner is closed (already gone) → central close→archive
		// cascade. Guarded inside to done-cleanup (completed) + no other active
		// runner. Runs only on this success path (Codex code review R6 #1).
		if (opts.archive) {
			await maybeArchiveThreadOnClose(store, session, opts.archive);
		}
		return {
			closed: true,
			alreadyGone: true,
			commDbFinalized: true,
			retiredGateCount: finalized.retiredGateCount,
		};
	}

	// FLY-1185 (Codex R4#2 + R7#2): fail-closed, STICKY authority re-check
	// between the slow external boundaries of the kill sequence. A throw counts
	// as lost, and once lost in this run it STAYS lost — a later transient
	// success can't revive it and let the remaining teardown proceed.
	let authorityStickyLost: string | undefined;
	const authorityLostReason = async (): Promise<string | undefined> => {
		if (authorityStickyLost) return authorityStickyLost;
		if (!opts.authorityCheck) return undefined;
		try {
			const res = await opts.authorityCheck();
			if (res.ok) return undefined;
			authorityStickyLost = res.reason ?? "authority_lost";
			return authorityStickyLost;
		} catch (err) {
			authorityStickyLost = `authority_check_failed:${(err as Error).message}`;
			return authorityStickyLost;
		}
	};
	const abortAuthorityLost = (
		stage: string,
		reason: string,
	): CloseRunnerResult => {
		store.insertEvent({
			event_id: `close-runner-authority-lost-${auditKey}`,
			execution_id: opts.executionId,
			issue_id: opts.issueId,
			project_name: opts.projectName,
			event_type: "lead_close_runner_authority_lost",
			source: "bridge.close-runner",
			payload: { stage, reason, leadId: opts.leadId },
		});
		return {
			closed: false,
			commDbFinalized: false,
			retiredGateCount: 0,
			error: `authority_lost:${stage}:${reason}`,
		};
	};

	// FLY-1185 §2.5: reap the runner's MCP-family descendant processes BEFORE
	// any kill (the pane pid is only resolvable while the window is alive).
	// Reap-only + best-effort — the battle-tested kill sequence below is
	// byte-unchanged. R5#2: the reaper re-verifies authority BEFORE its SIGTERM
	// and (post-grace) SIGKILL passes, so a Linear reopen mid-reap stops the
	// remaining signals — the internal destructive boundaries are now covered
	// too, not just the outer kill sequence.
	const reapRes = await reapRunnerMcp(target.tmuxWindow, {
		authorityCheck: async () => (await authorityLostReason()) === undefined,
	}).catch(() => undefined);
	// R7#2: the reaper observed authority lost mid-pass — that observation is
	// STICKY for this run; abort the whole teardown as blocked instead of
	// letting the subsequent kill sequence proceed on a later transient success.
	if (reapRes?.authorityLost) {
		return abortAuthorityLost(
			"mcp_reap",
			authorityStickyLost ?? "authority_lost",
		);
	}

	// R4#2: the MCP reap awaited external process state — re-verify before the
	// first destructive kill.
	{
		const lost = await authorityLostReason();
		if (lost) return abortAuthorityLost("pre_cmux_kill", lost);
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

	// R4#2: another slow boundary crossed — re-verify before the window kill.
	{
		const lost = await authorityLostReason();
		if (lost) return abortAuthorityLost("pre_tmux_kill", lost);
	}

	// success path: kill tmux window
	const res = await killTmuxWindow(target.tmuxWindow);

	// FLY-116: also close the per-runner Terminal tab + linked viewer session.
	// Only do this when the tmux kill actually succeeded — if kill failed
	// (e.g. permission), closing the tab anyway would hide a still-running
	// runner from the user (Codex Round 1 PR review #3).
	// R4#2: the tmux kill is done (irreversible); the remaining steps are
	// display cleanup only — still re-verify so a reopen skips even the
	// cosmetic mutations (audited; the close result itself stands since the
	// window is already gone).
	let lostPostKill: string | undefined;
	if (res.killed) {
		lostPostKill = await authorityLostReason();
		if (lostPostKill) {
			store.insertEvent({
				event_id: `close-runner-authority-lost-post-${auditKey}`,
				execution_id: opts.executionId,
				issue_id: opts.issueId,
				project_name: opts.projectName,
				event_type: "lead_close_runner_authority_lost",
				source: "bridge.close-runner",
				payload: {
					stage: "post_tmux_kill",
					reason: lostPostKill,
					leadId: opts.leadId,
				},
			});
		}
	}
	if (res.killed && !lostPostKill) {
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

	// FLY-1048 PR-C (C5): same CLEARING mark on the killed success path — a
	// failed kill leaves the (possibly still alive) runner's episodes armed.
	if (res.killed) {
		markDetectionClearingSafe(store, opts.executionId);
	}

	let commDbFinalized = false;
	let retiredGateCount = 0;
	let finalizeError: string | undefined;
	if (res.killed) {
		const finalized = finalizeCommunications();
		commDbFinalized = finalized.ok;
		retiredGateCount = finalized.retiredGateCount;
		if (!finalized.ok) {
			finalizeError = `commdb_finalize_failed:${finalized.error ?? "unknown"}`;
		}
	}

	// FLY-369: central close→archive cascade — ONLY when the close actually
	// succeeded (Codex code review R6 #1: a kill failure must NOT archive). The
	// cascade is itself guarded to done-cleanup (completed) + no other active
	// runner; FLY-1238 additionally requires communication finalization first.
	if (res.killed && commDbFinalized && opts.archive) {
		await maybeArchiveThreadOnClose(store, session, opts.archive);
	}

	return {
		closed: res.killed,
		commDbFinalized,
		retiredGateCount,
		error: res.error ?? finalizeError,
	};
}

/**
 * FLY-1048 PR-C (C5): best-effort CLEARING mark for every active detection
 * episode of a runner entering cleanup. Never throws — muting detection is
 * strictly subordinate to the close itself.
 */
function markDetectionClearingSafe(
	store: StateStore,
	executionId: string,
): void {
	try {
		const n = store.markDetectionEscalationsClearingForTarget(
			executionId,
			Date.now(),
		);
		if (n > 0) {
			console.log(
				`[close-runner] ${executionId}: ${n} detection episode(s) marked CLEARING`,
			);
		}
	} catch (err) {
		console.warn(
			`[close-runner] detection CLEARING mark failed for ${executionId}: ${(err as Error).message}`,
		);
	}
}
