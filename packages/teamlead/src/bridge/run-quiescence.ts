import { probeCodexDaemonLiveness } from "flywheel-claude-runner";
import type {
	RunQuiescenceEvidence,
	Session,
	StateStore,
} from "../StateStore.js";
import {
	type GeneralizedLaunchLiveness,
	probeGeneralizedLaunchLiveness,
} from "./generalized-launch-recovery.js";

export type RunExecutionLivenessProbe = (
	executionId: string,
	projectName: string,
) => Promise<GeneralizedLaunchLiveness>;

export interface RunExecutionLivenessDeps {
	probeCodexDaemon?: typeof probeCodexDaemonLiveness;
	probeGeneric?: typeof probeGeneralizedLaunchLiveness;
}

/** Production policy for the strict quiescence gate. Codex owns a detached
 * daemon outside tmux, so generic target/argv evidence cannot prove it dead.
 * Only after the shared daemon probe proves socket+group absence may the
 * existing tmux/discovery/host policy classify the execution dead. */
export async function probeRunExecutionLiveness(
	session: Pick<Session, "adapter_type"> | undefined,
	executionId: string,
	projectName: string,
	deps: RunExecutionLivenessDeps = {},
): Promise<GeneralizedLaunchLiveness> {
	if (session?.adapter_type === "codex-tmux") {
		const daemon = await (deps.probeCodexDaemon ?? probeCodexDaemonLiveness)(
			executionId,
		);
		if (daemon === "alive") return "alive";
		if (daemon === "unknown") return "unknown";
	}
	return (deps.probeGeneric ?? probeGeneralizedLaunchLiveness)(
		executionId,
		projectName,
		{ allowMissingTargetHostAbsence: true },
	);
}

/**
 * Collect process evidence outside the SQLite transaction. StateStore rechecks
 * attribution, session status, lifecycle revision, and evidence freshness at
 * the state transition linearization point.
 */
export async function collectRunQuiescenceEvidence(
	store: StateStore,
	runId: string,
	probe?: RunExecutionLivenessProbe,
	now: () => Date = () => new Date(),
): Promise<RunQuiescenceEvidence[]> {
	const run = store.getWorkflowRun(runId);
	if (!run) throw new Error("workflow_run_not_found");
	const evidence: RunQuiescenceEvidence[] = [];
	for (const executionId of store.listRunAttributedExecutions(runId)) {
		const session = store.getSession(executionId);
		const liveness = probe
			? await probe(executionId, run.project_name)
			: await probeRunExecutionLiveness(session, executionId, run.project_name);
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
