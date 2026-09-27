import { canonicalSubmissionDigest } from "flywheel-config";
import type { StateStore, WorkflowHoldResumeCanonical } from "../StateStore.js";
import type { CodexQuotaTerminateExpectation } from "./codex-quota-store.js";
import { probeGeneralizedLaunchLiveness } from "./generalized-launch-recovery.js";
import { prepareWorkflowNodeRecovery } from "./workflow-node-recovery.js";
import type { InitialWorkflowStartObserver } from "./workflow-start-policy.js";

interface WorkflowQuotaRecoveryPorts {
	isEnabled(): boolean;
	probe?: typeof probeGeneralizedLaunchLiveness;
	observeInitialStart?: InitialWorkflowStartObserver;
}

function assertQuotaRecoveryAuthority(
	store: StateStore,
	expectation: CodexQuotaTerminateExpectation,
): { request: WorkflowHoldResumeCanonical } {
	const expected = expectation.target;
	const current = store.codexQuota.getTargetFence(
		expected.incidentId,
		expected.targetKind,
		expected.targetId,
	);
	if (
		expected.targetKind !== "runner" ||
		expected.state !== "waiting" ||
		!expected.runId ||
		expected.targetId !== expected.runId ||
		!current ||
		canonicalSubmissionDigest(current) !== canonicalSubmissionDigest(expected)
	)
		throw new Error("quota_recovery_target_changed");

	const permit = store.getCodexQuotaRecoveryPermit(expected.incidentId);
	if (
		permit?.incident_id !== expectation.permitIncidentId ||
		permit.installed_generation !== expectation.installedGeneration
	)
		throw new Error("quota_recovery_permit_changed");

	const inspection = store.inspectWorkflowNodeRecovery(expected.runId);
	if (
		inspection.target.nodeId !== expectation.nodeId ||
		inspection.target.attempt !== expectation.attempt ||
		inspection.target.previousExecutionId !== expected.oldExecutionId ||
		inspection.target.previousLaunchOrdinal !== expectation.launchOrdinal ||
		(expected.nodeId !== null && expected.nodeId !== expectation.nodeId) ||
		(expected.attempt !== null && expected.attempt !== expectation.attempt)
	)
		throw new Error("quota_recovery_source_advanced");
	const hold = store
		.listWorkflowHolds(expected.runId)
		.find((candidate) =>
			inspection.target.sourceHoldEventUids.includes(candidate.holdEventUid),
		);
	if (!hold) throw new Error("quota_recovery_hold_missing");

	return {
		request: {
			runId: expected.runId,
			principal: "master",
			shape: hold.shape,
			holdEventUid: hold.holdEventUid,
			decision: null,
			reason: `codex quota recovery ${expected.incidentId}`,
			clientRequestId: `quota-node-recovery:${canonicalSubmissionDigest(expectation)}`,
		},
	};
}

/**
 * Internal quota automation adapter for an already-held workflow node.
 * Authority is re-read before and after the asynchronous liveness observation;
 * the StateStore then repeats the full tuple and quota-target CAS in one mint
 * transaction.
 */
export async function recoverQuotaHeldWorkflowNode(
	store: StateStore,
	expectation: CodexQuotaTerminateExpectation,
	ports: WorkflowQuotaRecoveryPorts,
) {
	if (!ports.isEnabled()) throw new Error("quota_recovery_disabled");
	const { request } = assertQuotaRecoveryAuthority(store, expectation);
	const prepared = await prepareWorkflowNodeRecovery(
		store,
		request,
		ports.probe ?? probeGeneralizedLaunchLiveness,
		ports.observeInitialStart,
	);
	if (!ports.isEnabled()) throw new Error("quota_recovery_disabled");
	assertQuotaRecoveryAuthority(store, expectation);
	const result = store.recoverWorkflowNode({
		...prepared,
		now: new Date().toISOString(),
	});
	if (!result.ok) throw new Error(result.reason);
	return result;
}
