import type { ProjectEntry } from "../ProjectConfig.js";
import type { LandOperationRow, StateStore } from "../StateStore.js";
import {
	type LandFinalizationContext,
	resolveLandFinalizationContext,
} from "./land-source-session.js";
import { buildMergedWorktreeProof } from "./merged-worktree-proof.js";
import type { PostShipOpts } from "./post-ship-finalization.js";

export type PreparedLandFinalization =
	| {
			ok: true;
			context: Exclude<LandFinalizationContext, { kind: "unresolved" }>;
			opts: PostShipOpts;
	  }
	| {
			ok: false;
			reason:
				| "merge_receipt_unavailable"
				| "operation_identity_invalid"
				| "land_claim_unavailable";
	  };

/** Build the exact post-ship identity without manufacturing a Session row. */
export function prepareLandFinalization(
	store: StateStore,
	operation: LandOperationRow,
	common: Pick<PostShipOpts, "discordOwnerUserId" | "fallbackBotToken"> = {},
	project?: Pick<ProjectEntry, "projectName" | "projectRoot" | "projectRepo">,
): PreparedLandFinalization {
	const context = resolveLandFinalizationContext(store, operation);
	if (context.kind === "unresolved")
		return { ok: false, reason: context.reason };
	if (!operation.owner_id || !operation.owner_instance_id)
		return { ok: false, reason: "land_claim_unavailable" };
	const landOperation = {
		operationId: operation.operation_id,
		ownerId: operation.owner_id,
		ownerInstanceId: operation.owner_instance_id,
		generation: operation.generation,
	};
	const proofStep = store
		.listLandOperationSteps(operation.operation_id)
		.find((step) => step.step === "aux:merged_worktree_proof");
	const mergedWorktreeProof =
		project?.projectName === operation.project_name &&
		project.projectRepo &&
		proofStep
			? buildMergedWorktreeProof({
					operation: {
						operationId: operation.operation_id,
						operationGeneration: operation.generation,
						projectName: operation.project_name,
						issueId: operation.issue_id,
						runId: operation.run_id,
						prNumber: operation.pr_number,
						approvedHead: operation.approved_head,
					},
					mergeReceipt: {
						receiptId: `${operation.operation_id}:${proofStep.step}`,
						observedAt: proofStep.completed_at,
						receipt: proofStep.receipt,
					},
					projectRoot: project.projectRoot,
					trustedRepoIdentity: project.projectRepo,
				})
			: undefined;
	const shared = {
		runId: operation.run_id ?? undefined,
		mergedPr: {
			prNumber: operation.pr_number,
			headSha: operation.approved_head,
		},
		issueId: operation.issue_id,
		projectName: operation.project_name,
		landOperation,
		...(mergedWorktreeProof ? { mergedWorktreeProof } : {}),
		...common,
	};
	if (context.kind === "session") {
		return {
			ok: true,
			context,
			opts: {
				...shared,
				executionId: context.session.execution_id,
				issueIdentifier: context.session.issue_identifier,
				sessionStatus: context.session.status,
			},
		};
	}
	return {
		ok: true,
		context,
		opts: {
			...shared,
			issueIdentifier: context.issueIdentifier,
			operationContext: {
				operationId: context.operationId,
				ownerId: operation.owner_id,
				ownerInstanceId: operation.owner_instance_id,
				generation: operation.generation,
				runId: context.runId,
				sourceExecutionId: context.sourceExecutionId,
				mergeReceiptId: context.mergeReceiptId,
			},
		},
	};
}
