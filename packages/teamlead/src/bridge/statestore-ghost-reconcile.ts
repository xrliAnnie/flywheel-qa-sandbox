/**
 * FLY-1066 face ③: reconcile StateStore-only non-terminal session ghosts.
 *
 * A row is terminalized only when it is an active pending/running session, old
 * enough, has no CommDB registration, the immediately preceding terminal
 * CommDB prune supplied its exact target identity, and the shared execution
 * body observation says dead. The target is only a same-pass identity fence;
 * neither it nor legacy StateStore `tmux_session` is death authority. The
 * decision is serialized with the issue lifecycle mutex and re-reads both
 * stores, the body fact, and the identity fence before mutation. Alive,
 * unknown, unreadable, fresh, or changed evidence is always kept.
 */

import type { TransitionContext } from "flywheel-core";
import {
	type ApplyTransitionOpts,
	applyTransition,
} from "../applyTransition.js";
import type { Session, StateStore } from "../StateStore.js";
import type { FinalizeCommDbResult } from "./commdb-session-prune.js";
import type { ExecutionBodyLivenessReader } from "./execution-body-reader.js";

export const STATESTORE_GHOST_SOURCE_STATUSES: ReadonlySet<string> = new Set([
	"pending",
	"running",
]);

export type StateStoreGhostOutcome =
	| "reaped"
	| "kept_quota_standby"
	| "kept_non_candidate_status"
	| "kept_fresh_or_invalid_age"
	| "kept_commdb_present"
	| "kept_commdb_indeterminate"
	| "kept_no_authoritative_target"
	| "kept_invalid_authoritative_target"
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
	/**
	 * Same-pass target identity from a CommDB row finalized after body death.
	 * This is a CAS fence, not liveness evidence; historical StateStore metadata
	 * is deliberately not a fallback.
	 */
	getProvenDeadTmuxTarget: (
		executionId: string,
		projectName: string,
	) => string | undefined;
	readBodyLiveness: ExecutionBodyLivenessReader;
	finalizeCommDbSession: (
		executionId: string,
		projectName: string,
	) => FinalizeCommDbResult;
	lifecycleMutex?: {
		withIssueMutex: <T>(keys: string[], fn: () => Promise<T>) => Promise<T>;
		resolveLockKeys: (issueId: string) => string[];
	};
	archiveThread?: (session: Session) => Promise<void>;
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

/** Accept only an exact tmux window id, never a shared/bare session target. */
export function isExactTmuxWindowTarget(target: string): boolean {
	return /^.+:@\d+$/.test(target);
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
	// FLY-2900 §4.2: a Codex quota standby body is running without a process
	// (and may have lost its CommDB row) by design; the resume loop owns it.
	if (deps.store.isCodexQuotaStandby?.(executionId) === true) {
		return "kept_quota_standby";
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
	const tmuxWindow = deps.getProvenDeadTmuxTarget(executionId, projectName);
	if (!tmuxWindow) return "kept_no_authoritative_target";
	if (!isExactTmuxWindowTarget(tmuxWindow)) {
		return "kept_invalid_authoritative_target";
	}

	let body: ReturnType<ExecutionBodyLivenessReader>;
	try {
		body = deps.readBodyLiveness(executionId, projectName);
	} catch (err) {
		log(
			`[statestore-ghost-reconcile] ${executionId}: body liveness unavailable (${(err as Error).message})`,
		);
		return "kept_target_not_dead";
	}
	if (body !== "dead") return "kept_target_not_dead";

	// Close the probe's async race: the StateStore row must still be the same
	// candidate and CommDB absence must still be true immediately before mutate.
	const current = deps.store.getSession(executionId);
	if (
		!current ||
		current.project_name !== projectName ||
		current.status !== session.status ||
		deps.getProvenDeadTmuxTarget(executionId, projectName) !== tmuxWindow ||
		deps.readBodyLiveness(executionId, projectName) !== "dead"
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
			retiredAskCount: 0,
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
		runnerDeathProven: true,
		audit: {
			retiredGateCount: finalized.retiredGateCount,
			retiredAskCount: finalized.retiredAskCount,
			source: "bridge.statestore-ghost-reconcile",
		},
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
					"StateStore ghost reaped (CommDB absent, current execution body dead)",
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
			tmuxWindow,
		},
	});
	return "reaped";
}
