import { CommDB } from "flywheel-comm/db";
import type {
	StateStore,
	WorkflowCompletionActivationContext,
	WorkflowFailureInput,
} from "../StateStore.js";
import { commDbPathForProject } from "./commdb-path.js";
import { parseCompletionDrainEnvelope } from "./completion-drain.js";

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
	if (!checked.idempotentReplay) {
		let comm: CommDB | undefined;
		try {
			comm = CommDB.openReadonly(commDbPathForProject(checked.projectName));
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
			const issued = store.findIssuedDrainChallenge({
				executionId: input.executionId,
				activationId: checked.activationId,
				businessDigest: checked.businessDigest,
			});
			if (!envelope.receiptChallengeId) {
				if (issued)
					return reject("consume_pending_mail", {
						challengeId: issued.challengeId,
						mailbox: issued.mailbox,
						phaseWakes: issued.phaseWakes,
					});
				const pending = comm.getCompletionDrainPending(input.executionId);
				if (pending.mailbox.length + pending.phaseWakes.length > 0) {
					const challenge = store.issueDrainChallenge({
						executionId: input.executionId,
						activationId: checked.activationId,
						businessDigest: checked.businessDigest,
						mailSet: pending,
						watermark: pending.watermark,
					});
					return reject("consume_pending_mail", {
						challengeId: challenge.challengeId,
						mailbox: challenge.mailbox,
						phaseWakes: challenge.phaseWakes,
					});
				}
			} else {
				if (!issued || issued.challengeId !== envelope.receiptChallengeId)
					return reject("drain_receipt_rejected");
				const verification = comm.getCompletionDrainVerification(
					input.executionId,
					issued.mailbox,
					issued.phaseWakes,
				);
				if (
					issued.mailbox.some((id) => verification.mailbox[id] !== "ACKED") ||
					issued.phaseWakes.some(
						(id) =>
							!["started", "finished"].includes(
								verification.phaseWakes[id] ?? "",
							),
					)
				)
					return reject("drain_receipt_rejected");
				failure.drainChallenge = {
					challengeId: issued.challengeId,
					verification,
				};
			}
		} catch {
			return reject("completion_deferred_pending_mail", {
				detail: "commdb_unreadable",
			});
		} finally {
			comm?.close();
		}
	}
	try {
		const result = store.commitEnrolledFailure(failure);
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
