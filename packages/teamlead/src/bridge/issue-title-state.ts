import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import type { WorkflowPhaseRole } from "flywheel-config";
import { installSqlTiming } from "flywheel-config";
import type { Session, StateStore, WorkflowRunRow } from "../StateStore.js";
import { parseWorkflowRunSnapshot } from "../workflow-run-snapshot.js";
import { workflowApprovalGate } from "../workflow-template.js";
import { commDbPathForProject } from "./commdb-path.js";
import type { FounderAttentionLevel } from "./founder-attention.js";
import {
	deriveEffectiveFounderTitleState,
	derivePhaseDisplayState,
	type ParkProbe,
	type PhaseDisplayState,
} from "./issue-display.js";
import { isQaHeld, isReviewHeld, type ReviewHeldStore } from "./review-hold.js";

/** Fail closed when a run cannot prove its snapshot-defined approval gate. */
export function isWorkflowApprovalGateCurrent(
	run: WorkflowRunRow | undefined,
): boolean {
	if (!run?.snapshot || run.status !== "active" || !run.current_node_id) {
		return false;
	}
	try {
		const snapshot = parseWorkflowRunSnapshot(run.snapshot);
		return run.current_node_id === workflowApprovalGate(snapshot.manifest).node;
	} catch {
		return false;
	}
}

type IssueConclusionStore = Pick<
	StateStore,
	"hasFinalizationCompletedForIssue" | "hasMergeConfirmedForIssue"
>;

/**
 * FLY-1709: `terminated` is concluded cleanup only when the issue has durable
 * ship evidence. A historical completed session is not sufficient: generalized
 * DAGs can leave several main-role rows on one issue, and a later abandoned node
 * must not inherit an earlier node's success.
 */
export function hasDurableIssueConclusion(
	store: IssueConclusionStore,
	issueId: string,
): boolean {
	return (
		store.hasFinalizationCompletedForIssue(issueId) ||
		store.hasMergeConfirmedForIssue(issueId)
	);
}

export type IssueTitleStateStore = IssueConclusionStore &
	ReviewHeldStore &
	Pick<
		StateStore,
		| "getLatestPhaseSessionsForIssue"
		| "getSessionByIssue"
		| "getActiveWorkflowRunForIssue"
	> & {
		getWorkflowExecutionActivity?: StateStore["getWorkflowExecutionActivity"];
	};

export function readIssueTitleState(input: {
	store: IssueTitleStateStore;
	issueId: string;
	anySession?: Session;
	activeWorkflowRun?: WorkflowRunRow;
	parkFor?: (session: Session) => ParkProbe;
	founderAttention?: FounderAttentionLevel;
}) {
	const { store, issueId, anySession, activeWorkflowRun } = input;
	const parkFor =
		input.parkFor ??
		((session: Session) =>
			readIssueParkProbe(session.project_name, session.execution_id));
	const latestPhase = store.getLatestPhaseSessionsForIssue(issueId);
	const isWorkflowPhase = latestPhase.length > 0;
	const founderGateActive = isWorkflowApprovalGateCurrent(activeWorkflowRun);
	const issueConcluded = hasDurableIssueConclusion(store, issueId);
	// Unified per-phase states (face A aggregation + face B rows).
	const phaseStates = new Map<WorkflowPhaseRole, PhaseDisplayState>();
	const phaseStatuses = new Map<WorkflowPhaseRole, string>();
	const phaseSessionByRole = new Map<WorkflowPhaseRole, Session>();
	for (const s of latestPhase) {
		const role = s.chat_thread_role as WorkflowPhaseRole;
		phaseSessionByRole.set(role, s);
		phaseStatuses.set(role, s.status);
		phaseStates.set(
			role,
			derivePhaseDisplayState({
				role,
				status: s.status,
				park: parkFor(s),
				issueConcluded,
				activity: store.getWorkflowExecutionActivity?.(s.execution_id)?.activityState,
			}),
		);
	}
	const shipFinalizationClaimed =
		isWorkflowPhase && store.hasFinalizationCompletedForIssue(issueId);

	const titleState = deriveEffectiveFounderTitleState({
		phaseStates,
		phaseStatuses,
		shipFinalizationClaimed,
		issueConcluded,
		mainSessionStage: anySession?.session_stage,
		mainSessionStatus: anySession?.status,
		founderGateActive,
		founderAttention: input.founderAttention,
		qaHeld: !!anySession && !isWorkflowPhase && isQaHeld(store, anySession),
		reviewHeld: !!anySession && isReviewHeld(store, anySession),
	});
	return {
		latestPhase,
		isWorkflowPhase,
		phaseStates,
		phaseSessionByRole,
		titleState,
	};
}

export function readIssueParkProbe(
	projectName: string,
	execId: string,
	now = Date.now(),
): ParkProbe {
	const dbPath = commDbPathForProject(projectName);
	if (!existsSync(dbPath)) return "unknown";
	let db: InstanceType<typeof Database> | undefined;
	try {
		db = installSqlTiming(
			new Database(dbPath, { readonly: true, fileMustExist: true }),
			"comm",
		);
		db.pragma("busy_timeout = 5000");
		const row = db
			.prepare(
				"SELECT kind, expires_at FROM runner_declared_states WHERE execution_id = ?",
			)
			.get(execId) as { kind?: string; expires_at?: number | null } | undefined;
		if (!row || row.kind !== "parked") return "not_parked";
		if (row.expires_at != null && row.expires_at <= now) return "not_parked";
		return "parked";
	} catch {
		// missing table / locked / corrupt — could NOT probe. NEVER read this
		// as "was woken" (Codex R1 #2).
		return "unknown";
	} finally {
		db?.close();
	}
}
