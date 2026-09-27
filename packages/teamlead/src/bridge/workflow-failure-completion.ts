import { CommDB } from "flywheel-comm/db";
import type {
	StateStore,
	WorkflowCompletionActivationContext,
	WorkflowFailureInput,
} from "../StateStore.js";
import { commDbPathForProject } from "./commdb-path.js";
import {
	type CompletionDrainProof,
	parseCompletionDrainEnvelope,
	reconcileCompletionDrainSettlement,
	runSemanticCompletionDrain,
} from "./completion-drain.js";

/** Bearer authentication precedes this seam; only this server reads TURN/mail. */
export function acceptWorkflowFailure(
	store: StateStore,
	input: {
		executionId: string;
		sourceEventId: string;
		payload: Record<string, unknown> | undefined;
		workflowActivation: WorkflowCompletionActivationContext | undefined;
	},
): { status: number; body: Record<string, unknown> } {
	const reject = (reason: string, detail: Record<string, unknown> = {}) => ({
		status: 409,
		body: { error: "workflow_completion_rejected", reason, ...detail },
	});
	const envelope = parseCompletionDrainEnvelope(input.payload);
	if (!envelope.ok) return reject(envelope.reason);
	const failure: WorkflowFailureInput = {
		executionId: input.executionId,
		sourceEventId: input.sourceEventId,
		reason:
			typeof input.payload?.summary === "string" ? input.payload.summary : "",
		completionSubmission: envelope.completionSubmission,
		workflowActivation: input.workflowActivation,
	};
	const checked = store.checkEnrolledFailure(failure);
	if (!checked.ok) return reject(checked.reason);
	const commDbPath = commDbPathForProject(checked.projectName);
	if (!checked.idempotentReplay) {
		let comm: CommDB | undefined;
		try {
			comm = CommDB.openReadonly(commDbPath);
			const turn = comm.getTurn(checked.issueId);
			if (
				!turn ||
				turn.holder_exec_id !== input.executionId ||
				turn.epoch !== input.workflowActivation?.turnEpoch ||
				turn.activation_id !== checked.activationId ||
				turn.target_run_id !== checked.runId ||
				turn.target_node_id !== checked.nodeId ||
				turn.target_attempt !== checked.attempt
			)
				return reject("activation_turn_conflict");
		} catch {
			return reject("completion_deferred_pending_mail", {
				detail: "commdb_unreadable",
			});
		} finally {
			comm?.close();
		}
		if (envelope.receiptChallengeId) {
			console.info(
				`[completion-drain] ${input.executionId}: legacy drain receipt ${envelope.receiptChallengeId} ignored; obligations re-verified`,
			);
		}
		try {
			const drain = runSemanticCompletionDrain({
				commDbPath,
				store,
				executionId: input.executionId,
				activationId: checked.activationId,
				businessDigest: checked.businessDigest,
				commit: (drainProof: CompletionDrainProof) =>
					store.commitEnrolledFailure({ ...failure, drainProof }),
			});
			if (drain.kind === "unread") {
				return { status: 409, body: drain.response };
			}
			if (drain.kind === "unavailable") {
				return reject("completion_deferred_pending_mail", {
					detail: drain.detail,
				});
			}
			if (drain.settlementError) {
				console.warn(
					`[completion-drain] failure wake settlement deferred for ${input.executionId}: ${drain.settlementError}; a replay reconciles it`,
				);
			}
			const result = drain.completion;
			return result.ok
				? {
						status: 200,
						body: {
							ok: true,
							generalized: true,
							duplicate: result.idempotentReplay,
							failureRecorded: true,
							eventUid: result.eventUid,
						},
					}
				: reject(result.reason);
		} catch {
			return { status: 500, body: { error: "workflow_failure_commit_failed" } };
		}
	}
	try {
		const result = store.commitEnrolledFailure(failure);
		if (result.ok && result.idempotentReplay) {
			try {
				reconcileCompletionDrainSettlement({
					commDbPath,
					store,
					runId: result.runId,
					executionId: input.executionId,
					activationId: result.activationId,
					completionEventId: result.eventUid,
				});
			} catch (error) {
				console.warn(
					`[completion-drain] failure replay settlement deferred for ${input.executionId}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		return result.ok
			? {
					status: 200,
					body: {
						ok: true,
						generalized: true,
						duplicate: result.idempotentReplay,
						failureRecorded: true,
						eventUid: result.eventUid,
					},
				}
			: reject(result.reason);
	} catch {
		return { status: 500, body: { error: "workflow_failure_commit_failed" } };
	}
}
