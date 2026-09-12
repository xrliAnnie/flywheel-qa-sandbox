import { probeCodexDaemonLiveness } from "flywheel-claude-runner";
import type {
	RunQuiescenceEvidence,
	Session,
	StateStore,
} from "../StateStore.js";
import {
	type GeneralizedLaunchLiveness,
	hasHostProcessByExecutionId,
	probeGeneralizedLaunchLiveness,
} from "./generalized-launch-recovery.js";
import { discoverTmuxTargetByExecutionId } from "./tmux-lookup.js";

export type RunExecutionLivenessProbe = (
	executionId: string,
	projectName: string,
) => Promise<GeneralizedLaunchLiveness>;

export interface RunExecutionLivenessDeps {
	probeCodexDaemon?: typeof probeCodexDaemonLiveness;
	probeGeneric?: typeof probeGeneralizedLaunchLiveness;
}

/** FLY-2498: independent of the registered window name. All three absence
 * proofs are required; a discovered marker (even on a dead pane) is uncertainty.
 * Do not reuse generic recovery's dead-pane shortcut: it skips host evidence. */
export async function probeExecutionAbsenceBeyondTarget(
	session: Pick<Session, "adapter_type"> | undefined,
	executionId: string,
	_projectName: string,
	deps: {
		probeCodexDaemon?: typeof probeCodexDaemonLiveness;
		discover?: typeof discoverTmuxTargetByExecutionId;
		hasHostProcess?: typeof hasHostProcessByExecutionId;
	} = {},
): Promise<GeneralizedLaunchLiveness> {
	try {
		if (session?.adapter_type === "codex-tmux") {
			const daemon = await (deps.probeCodexDaemon ?? probeCodexDaemonLiveness)(
				executionId,
			);
			if (daemon !== "absent") return daemon;
		}
		const marker = await (deps.discover ?? discoverTmuxTargetByExecutionId)(
			executionId,
		);
		if (marker.kind !== "missing") return "unknown";
		const hasProcess = await (
			deps.hasHostProcess ?? hasHostProcessByExecutionId
		)(executionId);
		return hasProcess ? "unknown" : "dead";
	} catch {
		return "unknown";
	}
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
