import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { canonicalSubmissionDigest } from "flywheel-config";
import type { StateStore, WorkflowHoldResumeCanonical } from "../StateStore.js";
import { resolveWorkflowDispatchLineage } from "../workflow-dispatch-lineage.js";
import {
	type WorkflowRecoveryCanonical,
	type WorkflowRecoveryPreflight,
	type WorkflowRecoveryTarget,
	workflowRecoveryCanonicalSchema,
	workflowRecoveryEvidenceDigest,
} from "../workflow-recovery-contract.js";
import { probeGeneralizedLaunchLiveness } from "./generalized-launch-recovery.js";
import { resolveWorkflowHeadAuthority } from "./head-authority.js";

const execFileAsync = promisify(execFile);

export async function resolveRecoveryExecutionStartAuthority(
	store: StateStore,
	sourceExecutionId: string,
): Promise<NonNullable<WorkflowRecoveryTarget["startAuthority"]>> {
	const head = await resolveWorkflowHeadAuthority(store, sourceExecutionId);
	const git = async (...args: string[]) =>
		(
			await execFileAsync("git", ["-C", head.worktreePath, ...args], {
				encoding: "utf8",
				timeout: 5_000,
			})
		).stdout.trim();
	const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
	const commonDir = await git("rev-parse", "--git-common-dir");
	const repositoryIdentity = realpathSync(
		isAbsolute(commonDir) ? commonDir : resolve(head.worktreePath, commonDir),
	);
	if (!branch) throw new Error("head_authority_unavailable");
	const evidence = {
		sourceExecutionId,
		worktreePath: realpathSync(head.worktreePath),
		repositoryIdentity,
		branch,
		headSha: head.prHeadSha,
	};
	return {
		mode: "execution_head",
		sourceExecutionId,
		reservationKey: null,
		repositoryIdentity,
		branch,
		headSha: head.prHeadSha,
		evidenceDigest: canonicalSubmissionDigest(evidence),
		provenance: "persisted_execution_worktree",
	};
}

/** Derive all authority on the server; shape is only a historical locator. */
export async function prepareWorkflowNodeRecovery(
	store: StateStore,
	request: WorkflowHoldResumeCanonical,
	probe: typeof probeGeneralizedLaunchLiveness = probeGeneralizedLaunchLiveness,
): Promise<{
	canonical: WorkflowRecoveryCanonical;
	preflight: WorkflowRecoveryPreflight;
}> {
	const before = store.inspectWorkflowNodeRecovery(request.runId);
	if (!before.target.sourceHoldEventUids.includes(request.holdEventUid))
		throw new Error("recovery_target_changed");
	if (
		store
			.listWorkflowHolds(request.runId)
			.some(
				(hold) =>
					hold.runLevel &&
					hold.requiredDecision &&
					(request.decision !== "retry" ||
						!hold.requiredDecision.includes(request.decision)),
			)
	)
		throw new Error("recovery_decision_required");
	const executionId = before.target.previousExecutionId!;
	const liveness = await probe(executionId, before.projectName, {
		allowMissingTargetHostAbsence: true,
	});
	if (liveness !== "dead")
		throw new Error(
			liveness === "alive"
				? "recovery_target_alive"
				: "recovery_liveness_unknown",
		);
	const owner = store.getWorkflowLaunchOwner(executionId);
	if (
		owner &&
		owner.committed_generation == null &&
		!store.getWorkflowLaunchCancellation(executionId) &&
		Date.parse(owner.lease_expires_at) > Date.now()
	)
		throw new Error("recovery_launch_owner_live");
	const lineage = resolveWorkflowDispatchLineage(
		store.listWorkflowRunEvents(request.runId),
		{
			runId: request.runId,
			nodeId: before.target.nodeId,
			attempt: before.target.attempt,
			executionId,
		},
	);
	// Root initial/resume authority is resolved by its own existing start policy,
	// not by inventing a predecessor or reading an unlaunched body's HEAD.
	if (!lineage.transition?.execution_id)
		throw new Error("recovery_root_start_preflight_required");
	const sourceSessionDigest = store.getWorkflowRecoverySourceBindingDigest(
		lineage.transition.execution_id,
	);
	const startAuthority = await resolveRecoveryExecutionStartAuthority(
		store,
		lineage.transition.execution_id,
	);
	const after = store.inspectWorkflowNodeRecovery(request.runId);
	if (
		before.stateDigest !== after.stateDigest ||
		sourceSessionDigest !==
			store.getWorkflowRecoverySourceBindingDigest(
				lineage.transition.execution_id,
			)
	)
		throw new Error("recovery_target_changed");
	const sourceEvidenceDigest = startAuthority.evidenceDigest;
	startAuthority.evidenceDigest = workflowRecoveryEvidenceDigest({
		stateDigest: before.stateDigest,
		sourceSessionDigest,
		sourceEvidenceDigest,
	});
	const target = { ...before.target, startAuthority };
	const canonical = workflowRecoveryCanonicalSchema.parse({
		...request,
		version: 2,
		shape: "workflow_node_recovery",
		target,
	});
	return {
		canonical,
		preflight: {
			target,
			stateDigest: before.stateDigest,
			sourceSessionDigest,
			sourceEvidenceDigest,
			observedAt: new Date().toISOString(),
			liveness: "dead",
		},
	};
}
