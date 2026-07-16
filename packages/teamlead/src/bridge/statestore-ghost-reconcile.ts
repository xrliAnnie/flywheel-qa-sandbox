/**
 * FLY-1066 face ③: reconcile StateStore-only non-terminal session ghosts.
 *
 * A row is terminalized only when it is old enough, has no CommDB registration,
 * carries a StateStore tmux-session target, and that whole session is PROVEN
 * dead. The decision is serialized with the issue lifecycle mutex and re-reads
 * both stores after the asynchronous probe. Finalization precedes the legal FSM
 * transition so a CommDB lifecycle-cleanup failure leaves the row eligible for
 * the next pass. Alive, indeterminate, unreadable, fresh, or changed evidence is
 * always kept.
 */

import type { TransitionContext } from "flywheel-core";
import {
	type ApplyTransitionOpts,
	applyTransition,
} from "../applyTransition.js";
import type { Session, StateStore } from "../StateStore.js";
import type { FinalizeCommDbResult } from "./commdb-session-prune.js";
import type { TmuxWindowProbe } from "./tmux-lookup.js";

export const STATESTORE_GHOST_SOURCE_STATUSES: ReadonlySet<string> = new Set([
	"pending",
	"running",
	"awaiting_review",
	"approved_to_ship",
	"design_done",
]);

export type StateStoreGhostOutcome =
	| "reaped"
	| "kept_non_candidate_status"
	| "kept_fresh_or_invalid_age"
	| "kept_commdb_present"
	| "kept_commdb_indeterminate"
	| "kept_no_tmux_target"
	| "kept_target_not_dead"
	| "kept_changed_after_probe"
	| "finalize_failed"
	| "transition_failed";

export interface StateStoreGhostDeps {
	store: StateStore;
	transitionOpts: ApplyTransitionOpts;
	ghostMinAgeMs: number;
	nowMs: () => number;
	/** Return the CommDB row, undefined for proven absence, or throw if unreadable. */
	lookupCommDbSession: (
		executionId: string,
		projectName: string,
	) => unknown | undefined;
	probe: (tmuxSession: string) => Promise<TmuxWindowProbe>;
	finalizeCommDbSession: (
		executionId: string,
		projectName: string,
	) => FinalizeCommDbResult;
	lifecycleMutex?: {
		withIssueMutex: <T>(keys: string[], fn: () => Promise<T>) => Promise<T>;
		resolveLockKeys: (issueId: string) => string[];
	};
	archiveThread?: (session: Session) => Promise<void>;
	onQaPhaseTerminated?: (executionId: string, issueId: string) => void;
	log?: (message: string) => void;
}

export interface StateStoreGhostReconcileResult {
	scanned: number;
	reaped: number;
	kept: number;
	finalizeFailed: number;
	transitionFailed: number;
}

function parseStartedAtMs(
	startedAt: string | undefined,
	nowMs: number,
): number | undefined {
	if (!startedAt || !Number.isFinite(nowMs)) return undefined;
	const iso = startedAt.includes("T")
		? startedAt
		: `${startedAt.replace(" ", "T")}Z`;
	const value = Date.parse(iso);
	if (!Number.isFinite(value) || value > nowMs) return undefined;
	return value;
}

function sqliteDatetimeAt(nowMs: number): string {
	return new Date(nowMs)
		.toISOString()
		.replace("T", " ")
		.replace(/\.\d+Z$/, "");
}

/** Reconcile every legal face-③ candidate for one configured project. */
export async function reconcileStateStoreGhosts(
	projectName: string,
	deps: StateStoreGhostDeps,
): Promise<StateStoreGhostReconcileResult> {
	const result: StateStoreGhostReconcileResult = {
		scanned: 0,
		reaped: 0,
		kept: 0,
		finalizeFailed: 0,
		transitionFailed: 0,
	};
	const candidates = deps.store
		.getProjectSessions(projectName)
		.filter((session) => STATESTORE_GHOST_SOURCE_STATUSES.has(session.status));
	result.scanned = candidates.length;
	for (const session of candidates) {
		try {
			const outcome = await reapStateStoreGhost(session, deps);
			if (outcome === "reaped") result.reaped++;
			else if (outcome === "finalize_failed") result.finalizeFailed++;
			else if (outcome === "transition_failed") result.transitionFailed++;
			else result.kept++;
		} catch (err) {
			result.kept++;
			(deps.log ?? console.warn)(
				`[statestore-ghost-reconcile] ${session.execution_id}: unexpected error kept fail-closed (${(err as Error).message})`,
			);
		}
	}
	return result;
}

/** Reconcile one candidate; used by both the full pass and scheduled-run fast path. */
export async function reapStateStoreGhost(
	session: Session,
	deps: StateStoreGhostDeps,
): Promise<StateStoreGhostOutcome> {
	const run = () => reapStateStoreGhostUnlocked(session, deps);
	if (!deps.lifecycleMutex) return run();
	const keys = deps.lifecycleMutex.resolveLockKeys(session.issue_id);
	return deps.lifecycleMutex.withIssueMutex(keys, run);
}

async function reapStateStoreGhostUnlocked(
	session: Session,
	deps: StateStoreGhostDeps,
): Promise<StateStoreGhostOutcome> {
	const log = deps.log ?? ((message: string) => console.warn(message));
	const executionId = session.execution_id;
	const projectName = session.project_name;
	if (!STATESTORE_GHOST_SOURCE_STATUSES.has(session.status)) {
		return "kept_non_candidate_status";
	}

	const nowMs = deps.nowMs();
	const startedAtMs = parseStartedAtMs(session.started_at, nowMs);
	if (startedAtMs === undefined || nowMs - startedAtMs <= deps.ghostMinAgeMs) {
		return "kept_fresh_or_invalid_age";
	}

	try {
		if (deps.lookupCommDbSession(executionId, projectName) !== undefined) {
			return "kept_commdb_present";
		}
	} catch (err) {
		log(
			`[statestore-ghost-reconcile] ${executionId}: initial CommDB read indeterminate (${(err as Error).message})`,
		);
		return "kept_commdb_indeterminate";
	}
	if (!session.tmux_session) return "kept_no_tmux_target";

	let probe: TmuxWindowProbe;
	try {
		probe = await deps.probe(session.tmux_session);
	} catch (err) {
		log(
			`[statestore-ghost-reconcile] ${executionId}: tmux probe indeterminate (${(err as Error).message})`,
		);
		return "kept_target_not_dead";
	}
	if (probe !== "dead") return "kept_target_not_dead";

	// Close the probe's async race: the StateStore row must still be the same
	// candidate and CommDB absence must still be true immediately before mutate.
	const current = deps.store.getSession(executionId);
	if (
		!current ||
		current.project_name !== projectName ||
		current.status !== session.status ||
		current.tmux_session !== session.tmux_session
	) {
		return "kept_changed_after_probe";
	}
	try {
		if (deps.lookupCommDbSession(executionId, projectName) !== undefined) {
			return "kept_changed_after_probe";
		}
	} catch (err) {
		log(
			`[statestore-ghost-reconcile] ${executionId}: final CommDB read indeterminate (${(err as Error).message})`,
		);
		return "kept_commdb_indeterminate";
	}

	let finalized: FinalizeCommDbResult;
	try {
		finalized = deps.finalizeCommDbSession(executionId, projectName);
	} catch (err) {
		finalized = {
			ok: false,
			outcome: "failed",
			retiredGateCount: 0,
			deletedSessionCount: 0,
			error: (err as Error).message,
		};
	}
	deps.store.recordCommDbFinalizeOutcome({
		executionId,
		issueId: session.issue_id,
		projectName,
		ok: finalized.ok,
		error: finalized.error,
		nowMs,
	});
	if (!finalized.ok) {
		log(
			`[statestore-ghost-reconcile] ${executionId}: CommDB finalization failed (${finalized.error ?? "unknown"}); keeping for retry`,
		);
		return "finalize_failed";
	}

	const ctx: TransitionContext = {
		executionId,
		issueId: session.issue_id,
		projectName,
		trigger: "residue_harvest",
	};
	let transition: ReturnType<typeof applyTransition>;
	try {
		transition = applyTransition(
			deps.transitionOpts,
			executionId,
			"terminated",
			ctx,
			{
				last_activity_at: sqliteDatetimeAt(nowMs),
				last_error:
					"StateStore ghost reaped (CommDB absent, tmux session dead)",
			},
		);
	} catch (err) {
		log(
			`[statestore-ghost-reconcile] ${executionId}: transition threw after finalize (${(err as Error).message})`,
		);
		return "transition_failed";
	}
	if (!transition.ok) {
		log(
			`[statestore-ghost-reconcile] ${executionId}: FSM rejected ${session.status}→terminated after finalize (${transition.error ?? "unknown"})`,
		);
		return "transition_failed";
	}

	if (
		(session.chat_thread_role ?? "main") === "qa" &&
		deps.onQaPhaseTerminated
	) {
		try {
			deps.onQaPhaseTerminated(executionId, session.issue_id);
		} catch (err) {
			log(
				`[statestore-ghost-reconcile] ${executionId}: onQaPhaseTerminated threw (${(err as Error).message})`,
			);
		}
	}
	if (deps.archiveThread) {
		const reaped = deps.store.getSession(executionId) ?? {
			...session,
			status: "terminated",
		};
		await deps.archiveThread(reaped);
	}
	deps.store.insertEvent({
		event_id: `residue-ghost-reaped-${executionId}`,
		execution_id: executionId,
		issue_id: session.issue_id,
		project_name: projectName,
		event_type: "runner_residue_ghost_reaped",
		source: "bridge.statestore-ghost-reconcile",
		payload: {
			previousStatus: session.status,
			tmuxSession: session.tmux_session,
		},
	});
	return "reaped";
}
