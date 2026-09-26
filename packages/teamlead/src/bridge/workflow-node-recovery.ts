import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { canonicalSubmissionDigest } from "flywheel-config";
import type { StateStore, WorkflowHoldResumeCanonical } from "../StateStore.js";
import { resolveWorkflowDispatchLineage } from "../workflow-dispatch-lineage.js";
import { parseWorkflowRunSnapshot } from "../workflow-run-snapshot.js";
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
	let sourceExecutionId = lineage.transition?.execution_id;
	if (!sourceExecutionId) {
		const reservation = store.getWorkflowStartReservationForRun(request.runId);
		const run = store.getWorkflowRun(request.runId)!;
		const snapshot = parseWorkflowRunSnapshot(run.snapshot!);
		if (
			!reservation ||
			reservation.node_id !== before.target.nodeId ||
			reservation.attempt !== before.target.attempt ||
			reservation.execution_id !== lineage.originExecutionId ||
			snapshot.manifest.edges.some((edge) => edge.to === before.target.nodeId)
		)
			throw new Error("workflow_lineage_missing");
		const dispatch = store
			.listWorkflowSideEffects(request.runId)
			.find(
				(row) =>
					row.kind === "dispatch" &&
					row.node_id === before.target.nodeId &&
					row.attempt === before.target.attempt &&
					row.execution_id === executionId &&
					row.launch_ordinal === before.target.previousLaunchOrdinal,
			);
		// A previously launched root owns work in its own persisted worktree.
		// An unlaunched root must instead resolve the original initial-start policy.
		if (dispatch?.state !== "started")
			throw new Error("recovery_root_start_preflight_required");
		sourceExecutionId = executionId;
	}
	const sourceSessionDigest =
		store.getWorkflowRecoverySourceBindingDigest(sourceExecutionId);
	const startAuthority = await resolveRecoveryExecutionStartAuthority(
		store,
		sourceExecutionId,
	);
	const after = store.inspectWorkflowNodeRecovery(request.runId);
	if (
		before.stateDigest !== after.stateDigest ||
		sourceSessionDigest !==
			store.getWorkflowRecoverySourceBindingDigest(sourceExecutionId)
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
