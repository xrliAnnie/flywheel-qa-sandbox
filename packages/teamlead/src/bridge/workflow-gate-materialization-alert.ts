import type {
	StateStore,
	WorkflowEngineAlertIdentity,
	WorkflowGateHolderRow,
} from "../StateStore.js";
import { parseSqliteUtcMs } from "./founder-notify-utils.js";

const MATERIALIZATION_STUCK_AFTER_MS = 10 * 60 * 1_000;

type MaterializationResult = { ok: true } | { ok: false; reason: string };

export interface WorkflowGateMaterializationAlertDeps {
	store: StateStore;
	holder: WorkflowGateHolderRow;
	materialize: () => Promise<MaterializationResult>;
	alertIdentity: WorkflowEngineAlertIdentity;
	now?: () => string;
	log?: (message: string) => void;
}

function materializationAlertPayload(input: {
	holder: WorkflowGateHolderRow;
	issueId: string;
	identity: WorkflowEngineAlertIdentity;
}) {
	const escalationUid = `gate_materialization_stuck:${input.holder.question_id}`;
	return {
		leadId: input.identity.leadId,
		projectName: input.identity.projectName,
		eventId: escalationUid,
		eventType: "workflow_engine_escalation" as const,
		severity: "severe" as const,
		sessionKey: `wf:${input.holder.run_id}`,
		title: `【需人工】${input.issueId} 的 ship 卡发不出来(卡在 materializing)`,
		body: `${input.issueId} 的 ship gate ${input.holder.gate_node_id} 无法 materialize。question_id=${input.holder.question_id}, head=${input.holder.head_sha.slice(0, 8)}。请检查 Discord thread/card binding 与 materializer 日志,修复后引擎会自动重试。`,
		metadata: {
			workflowEngine: {
				runId: input.holder.run_id,
				issueId: input.issueId,
				nodeId: input.holder.gate_node_id,
				executionId: input.holder.source_execution_id,
				disposition: "gate_materialization_stuck" as const,
				questionId: input.holder.question_id,
				leadResolution: input.identity.leadResolution,
			},
		},
	};
}

/**
 * Run one holder materialization and make a persistent failure visible without
 * treating a stale in-memory holder as authority after the awaited work.
 */
export async function materializeWorkflowGateWithFailLoud(
	deps: WorkflowGateMaterializationAlertDeps,
): Promise<void> {
	const log = deps.log ?? console.warn;
	let failureReason: string | undefined;
	try {
		const result = await deps.materialize();
		if (result.ok) return;
		failureReason = result.reason;
	} catch (error) {
		failureReason = error instanceof Error ? error.message : String(error);
	}
	log(
		`[workflow-gate] materialization failed for ${deps.holder.question_id}: ${failureReason}`,
	);

	const now = (deps.now ?? (() => new Date().toISOString()))();
	const current = deps.store.getWorkflowGateHolderByQuestionId(
		deps.holder.question_id,
	);
	const completedAuditConflict =
		failureReason === "workflow_gate_card_audit_conflict";
	if (
		!current ||
		current.run_id !== deps.holder.run_id ||
		current.head_sha !== deps.holder.head_sha ||
		!(["materializing", "awaiting_review"] as const).includes(
			current.state as "materializing" | "awaiting_review",
		) ||
		(current.materialization_stage === "completed" && !completedAuditConflict)
	) {
		return;
	}
	const nowMs = parseSqliteUtcMs(now);
	const lastProgressMs = parseSqliteUtcMs(current.updated_at);
	if (
		nowMs !== null &&
		lastProgressMs !== null &&
		nowMs - lastProgressMs <= MATERIALIZATION_STUCK_AFTER_MS
	) {
		return;
	}
	const run = deps.store.getWorkflowRun(current.run_id);
	if (!run || run.status !== "active") return;

	const escalationUid = `gate_materialization_stuck:${current.question_id}`;
	try {
		deps.store.enqueueWorkflowEngineAlert({
			escalationUid,
			runId: current.run_id,
			payload: materializationAlertPayload({
				holder: current,
				issueId: run.issue_id,
				identity: deps.alertIdentity,
			}),
			now,
		});
	} catch (error) {
		const existing = deps.store.getWorkflowAlertOutbox(escalationUid);
		if (existing?.run_id === current.run_id) return;
		log(
			JSON.stringify({
				event: "workflow_gate_materialization_alert_failed",
				questionId: current.question_id,
				runId: current.run_id,
				error: error instanceof Error ? error.message : String(error),
				existingRunId: existing?.run_id ?? null,
			}),
		);
	}
}
