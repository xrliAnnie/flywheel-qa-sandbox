/**
 * FLY-324: "done-but-running" zombie reconciliation.
 *
 * A no-PR / no-code / QA Runner that finishes its work via
 * `flywheel-comm stage set completed` only emits a `stage_changed` event. That
 * event updates `session_stage` but NEVER transitions the FSM `status` off
 * `running` — the status change for non-merged completion only flows through
 * `session_completed` (emitted by `flywheel-comm complete --route ...`, which
 * QA / generic Runners never call). The result is a Runner stuck at
 * status=running forever:
 *   - `close_runner` rejects it (`status_not_eligible:running`),
 *   - its tmux session + git worktree linger until the next Bridge restart,
 *   - the idle watchdog false-positives `session_stuck` (it only polls
 *     status=running sessions), spamming the Lead about a Runner that is done.
 *
 * Two surfaces share the predicate below:
 *   1. event-route's `stage_changed` handler — fixes the problem going forward
 *      (a live stage_changed=completed on a still-running session transitions
 *      running→completed).
 *   2. this one-shot boot sweep — clears the EXISTING backlog of zombies whose
 *      stage_changed already fired before the fix shipped. Without it, deploying
 *      the handler fix would not unstick the sessions already stuck.
 *
 * Safety: status-only. Both surfaces transition via the canonical
 * `applyTransition` (running→completed is a legal FSM edge) and touch NOTHING
 * else — no tmux, no worktree, no Discord. Teardown stays with the existing
 * exec-id-scoped `close_runner` / boot tab-reaper, which look the window up by
 * execution_id (never by name pattern), so this introduces no cross-kill risk.
 *
 * Cutover safety (parked Runners): a Runner that reported `stage=completed` is
 * not always disposable — it can be a *parked* Runner intentionally kept alive
 * (e.g. a QA Runner holding a live browser tab / login, waiting to re-engage).
 * That distinction is human knowledge, not a reliable DB signal (parked + done
 * rows share a stale heartbeat). The boot sweep therefore honours a Lead-set
 * exclude list (`FLYWHEEL_FLY324_SWEEP_EXCLUDE`, by execId or issue identifier)
 * so the Lead skips parked Runners before the cutover restart; everything else
 * is cleared. The live handler also skips sessions with a pending complete
 * marker (the FLY-172 drain owns those).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TransitionContext } from "flywheel-core";
import type { ApplyTransitionOpts } from "../applyTransition.js";
import { applyTransition } from "../applyTransition.js";
import type { StateStore } from "../StateStore.js";
import { defaultMarkerDir } from "./complete-marker-reconciler.js";
import { sqliteDatetime } from "./types.js";

/**
 * Structural subset of a session row needed to classify it. Kept loose so both
 * the live handler (reading a freshly-patched session) and the boot sweep
 * (reading persisted rows) can pass their session object directly.
 */
export interface DoneButRunningProbe {
	status?: string | null;
	session_stage?: string | null;
	decision_route?: string | null;
	pr_number?: number | null;
}

/**
 * A session is "done but running" when it reported stage=completed yet the FSM
 * never moved off `running`, AND no review/ship flow is in play:
 *   - `decision_route` unset → `complete --route` never ran (a real completion
 *     would have already transitioned the status).
 *   - `pr_number` unset → no PR to review/merge; this is a no-PR / no-code / QA
 *     Runner, not a dev Runner mid-ship. (A merged-but-running dev session is
 *     FLY-60 W2's domain and is explicitly out of FLY-324 scope.)
 */
export function isDoneButRunning(session: DoneButRunningProbe): boolean {
	return (
		session.status === "running" &&
		session.session_stage === "completed" &&
		!session.decision_route &&
		!session.pr_number
	);
}

/**
 * True when a `flywheel-comm complete` marker is still pending on disk for this
 * execId (Bridge was down when the Runner POSTed `complete --route ...`, so the
 * route + evidence sit in `<markerDir>/<execId>.json` waiting to be replayed).
 *
 * Such a session must NOT be force-completed by FLY-324: the marker's eventual
 * replay carries the real route (e.g. needs_review → awaiting_review, or
 * blocked) and its decision metadata. If we transition it to `completed` first,
 * `completed` is terminal so the replay's transition is rejected and the route
 * is lost. The FLY-172 marker drain / heartbeat reconcile owns these sessions.
 * (Codex code-review R1 LOW.)
 */
export function hasPendingCompleteMarker(
	execId: string,
	markerDir: string = defaultMarkerDir(),
): boolean {
	return existsSync(join(markerDir, `${execId}.json`));
}

/**
 * Parse a comma/whitespace-separated `FLYWHEEL_FLY324_SWEEP_EXCLUDE` value into
 * a set of execIds / issue identifiers to skip. Empty / unset → empty set
 * (sweep everything, the default). Trims + drops blanks.
 */
export function parseSweepExcludeEnv(
	raw: string | undefined,
): ReadonlySet<string> {
	if (!raw) return new Set();
	return new Set(
		raw
			.split(/[\s,]+/)
			.map((s) => s.trim())
			.filter(Boolean),
	);
}

export interface DoneRunningReconcileResult {
	scanned: number;
	reconciled: number;
	rejected: number;
	/** Done-but-running rows skipped because a complete marker is still pending. */
	skipped: number;
	/** Done-but-running rows skipped because they are on the exclude list. */
	excluded: number;
}

export interface ReconcileDoneButRunningOpts {
	/** Override the complete-failed marker directory (tests). */
	markerDir?: string;
	/**
	 * Lead-supplied safety exclude list for the cutover sweep. A session is
	 * skipped when its `execution_id` OR `issue_identifier` is in this set.
	 *
	 * Why this exists: a Runner that reported `stage=completed` is not always a
	 * disposable zombie — it may be a *parked* Runner intentionally kept alive
	 * (e.g. a QA Runner holding a live browser tab / login, waiting to re-engage
	 * for re-verification). "Parked vs truly-done" is human knowledge the Lead
	 * has, not a signal any DB column carries reliably (these rows all share a
	 * stale heartbeat). So the Lead names the parked execIds/identifiers to skip
	 * before the cutover Bridge restart, and the sweep clears only the rest.
	 */
	exclude?: ReadonlySet<string>;
}

/**
 * One-shot boot sweep: transition every "done-but-running" zombie to
 * `completed` via the canonical FSM path. Best-effort — an FSM rejection on one
 * session logs a warning and is counted, never throws (a single bad row must
 * not block Bridge startup).
 *
 * Returns counters for audit/logging.
 */
export function reconcileDoneButRunning(
	store: StateStore,
	transitionOpts: ApplyTransitionOpts,
	opts: ReconcileDoneButRunningOpts = {},
): DoneRunningReconcileResult {
	const markerDir = opts.markerDir ?? defaultMarkerDir();
	const exclude = opts.exclude;
	const result: DoneRunningReconcileResult = {
		scanned: 0,
		reconciled: 0,
		rejected: 0,
		skipped: 0,
		excluded: 0,
	};

	// getActiveSessions() returns running / awaiting_review / approved_to_ship.
	// isDoneButRunning narrows to the running-only zombie shape.
	const zombies = store.getActiveSessions().filter(isDoneButRunning);
	result.scanned = zombies.length;

	for (const session of zombies) {
		// Lead-supplied exclude list (parked-but-needed Runners). Matches on
		// execId or issue_identifier so the Lead can name either form.
		if (
			exclude &&
			(exclude.has(session.execution_id) ||
				(session.issue_identifier != null &&
					exclude.has(session.issue_identifier)))
		) {
			result.excluded++;
			console.log(
				`[fly324-reconcile] excluded ${session.issue_identifier ?? session.execution_id} (Lead exclude list) — left running`,
			);
			continue;
		}
		// Codex R1 LOW: a session with a still-pending complete marker is owned by
		// the FLY-172 drain / heartbeat reconcile — its marker carries the real
		// route. Skip it so we never mask that route by force-completing first.
		if (hasPendingCompleteMarker(session.execution_id, markerDir)) {
			result.skipped++;
			continue;
		}
		const ctx: TransitionContext = {
			executionId: session.execution_id,
			issueId: session.issue_id,
			projectName: session.project_name,
			trigger: "fly324_done_running_boot_reconcile",
		};
		try {
			const res = applyTransition(
				transitionOpts,
				session.execution_id,
				"completed",
				ctx,
				{ last_activity_at: sqliteDatetime() },
			);
			if (res.ok) {
				result.reconciled++;
			} else {
				result.rejected++;
				console.warn(
					`[fly324-reconcile] FSM rejected running→completed for ${session.execution_id} (${session.issue_identifier ?? session.issue_id}): ${res.error}`,
				);
			}
		} catch (err) {
			result.rejected++;
			console.warn(
				`[fly324-reconcile] transition threw for ${session.execution_id}: ${(err as Error).message}`,
			);
		}
	}

	return result;
}
