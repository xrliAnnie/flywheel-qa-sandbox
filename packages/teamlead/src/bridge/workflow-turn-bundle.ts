import type { CommDB } from "flywheel-comm/db";
import type { GeneralizedExecutionDispatch } from "./retry-dispatcher.js";

export function grantPrelaunchWorkflowTurn(input: {
	db: Pick<CommDB, "getTurn" | "grantTurn">;
	issueId: string;
	projectName: string;
	executionId: string;
	phase: string;
	grantedAtMs: number;
	generalizedExecution?: GeneralizedExecutionDispatch;
}): { epoch: number; grantedAt: string } {
	const sourceEventId = `turn:spawn:${input.executionId}`;
	const workflow = input.generalizedExecution;
	if (
		workflow?.engineOwned &&
		(!workflow.activationId ||
			!workflow.projectTurn ||
			workflow.executionId !== input.executionId)
	) {
		throw new Error(
			"engine workflow TURN bundle missing activation or projection",
		);
	}
	const epoch = input.db.grantTurn(
		input.issueId,
		input.executionId,
		input.phase,
		input.grantedAtMs,
		{
			project: input.projectName,
			sourceEventId,
			...(workflow?.engineOwned && {
				targetRunId: workflow.runId,
				activation: {
					activationId: workflow.activationId!,
					runId: workflow.runId,
					nodeId: workflow.nodeId,
					attempt: workflow.attempt,
					...(workflow.outputCredential
						? { outputCredential: workflow.outputCredential }
						: {}),
					...(workflow.submissionCredential
						? { submissionCredential: workflow.submissionCredential }
						: {}),
					context: {
						kind: "workflow_spawn",
						snapshotDigest: workflow.snapshotDigest,
					},
				},
			}),
		},
	);
	const persisted = input.db.getTurn(input.issueId);
	if (
		!persisted ||
		persisted.epoch !== epoch ||
		persisted.holder_exec_id !== input.executionId ||
		persisted.phase !== input.phase ||
		!Number.isSafeInteger(persisted.granted_at)
	) {
		throw new Error(`pre-launch TURN replay mismatch: ${sourceEventId}`);
	}
	const grantedAt = new Date(persisted.granted_at).toISOString();
	if (workflow?.engineOwned) {
		if (
			persisted.target_run_id !== workflow.runId ||
			persisted.target_node_id !== workflow.nodeId ||
			persisted.target_attempt !== workflow.attempt ||
			persisted.activation_id !== workflow.activationId
		) {
			throw new Error(`engine workflow TURN bundle mismatch: ${sourceEventId}`);
		}
		const projected = workflow.projectTurn!({
			activationId: workflow.activationId!,
			issueId: input.issueId,
			executionId: input.executionId,
			epoch,
			sourceEventId,
			grantedAt,
		});
		if (!projected.ok) {
			throw new Error(
				`engine workflow TURN projection failed: ${projected.reason}`,
			);
		}
	}
	return { epoch, grantedAt };
}

export type GrantPrelaunchWorkflowTurn = typeof grantPrelaunchWorkflowTurn;
