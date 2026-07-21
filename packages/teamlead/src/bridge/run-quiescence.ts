import type { RunQuiescenceEvidence, StateStore } from "../StateStore.js";
import {
	type GeneralizedLaunchLiveness,
	probeGeneralizedLaunchLiveness,
} from "./generalized-launch-recovery.js";

export type RunExecutionLivenessProbe = (
	executionId: string,
	projectName: string,
) => Promise<GeneralizedLaunchLiveness>;

/**
 * Collect process evidence outside the SQLite transaction. StateStore rechecks
 * attribution, session status, lifecycle revision, and evidence freshness at
 * the state transition linearization point.
 */
export async function collectRunQuiescenceEvidence(
	store: StateStore,
	runId: string,
	probe: RunExecutionLivenessProbe = probeGeneralizedLaunchLiveness,
	now: () => Date = () => new Date(),
): Promise<RunQuiescenceEvidence[]> {
	const run = store.getWorkflowRun(runId);
	if (!run) throw new Error("workflow_run_not_found");
	const evidence: RunQuiescenceEvidence[] = [];
	for (const executionId of store.listRunAttributedExecutions(runId)) {
		const session = store.getSession(executionId);
		const liveness = await probe(executionId, run.project_name);
		evidence.push({
			executionId,
			sessionStatus: session?.status ?? null,
			lifecycleRevision: session?.lifecycle_revision ?? null,
			liveness,
			observedAt: now().toISOString(),
			...(session?.last_error?.startsWith("zombie: ")
				? { trustedZombieEventUid: `zombie-${executionId}` }
				: {}),
		});
	}
	return evidence;
}
