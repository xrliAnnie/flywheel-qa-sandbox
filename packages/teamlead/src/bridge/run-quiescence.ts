import {
	type CodexDaemonEvidence,
	probeCodexDaemonEvidence,
	probeCodexDaemonLiveness,
} from "flywheel-claude-runner";
import { PRE_ADAPTER_FAILURE_KINDS } from "flywheel-core";
import type {
	RunQuiescenceEvidence,
	Session,
	StateStore,
} from "../StateStore.js";
import { CRASH_PRESERVE_STATES } from "./close-runner-states.js";
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

export interface ExecutionStoreFacts {
	failureKind?: string;
	launchClaimState?: string;
}

export interface RunExecutionLivenessDeps {
	probeCodexDaemonEvidence?: typeof probeCodexDaemonEvidence;
	/** Bridge-local pre-adapter receipt only; never session_events payloads. */
	storeFacts?: (executionId: string) => ExecutionStoreFacts;
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
 * Socket+group absence, or a closed pre-adapter failure receipt with no daemon
 * evidence, permits the existing tmux/discovery/host absence checks. */
export async function probeRunExecutionLiveness(
	session:
		| (Pick<Session, "adapter_type"> & Partial<Pick<Session, "status">>)
		| undefined,
	executionId: string,
	projectName: string,
	deps: RunExecutionLivenessDeps = {},
): Promise<GeneralizedLaunchLiveness> {
	const generic = () =>
		(deps.probeGeneric ?? probeGeneralizedLaunchLiveness)(
			executionId,
			projectName,
			{ allowMissingTargetHostAbsence: true },
		);
	if (session?.adapter_type !== "codex-tmux") return generic();

	// Existing callers and legacy injection retain the liveness-only probe.
	const probeEvidence = async (): Promise<CodexDaemonEvidence> => {
		if (deps.probeCodexDaemonEvidence)
			return deps.probeCodexDaemonEvidence(executionId);
		if (deps.probeCodexDaemon || !deps.storeFacts) {
			return {
				liveness: await (deps.probeCodexDaemon ?? probeCodexDaemonLiveness)(
					executionId,
				),
				ledger: "valid_group",
				socketLive: false,
				spawnLock: "unreadable",
			};
		}
		return probeCodexDaemonEvidence(executionId);
	};
	const first = await probeEvidence();
	if (first.liveness === "alive") return "alive";
	if (first.liveness === "absent") return generic();
	if (!deps.storeFacts || !CRASH_PRESERVE_STATES.has(session.status ?? ""))
		return "unknown";
	const facts = deps.storeFacts(executionId);
	if (
		!PRE_ADAPTER_FAILURE_KINDS.has(facts.failureKind ?? "") ||
		facts.launchClaimState !== "closed"
	)
		return "unknown";
	const isZeroEvidence = (e: CodexDaemonEvidence) =>
		e.liveness === "unknown" &&
		e.ledger === "missing" &&
		!e.socketLive &&
		e.spawnLock === "absent";
	if (!isZeroEvidence(first)) return "unknown";
	const result = await generic();
	if (result !== "dead") return result;
	return isZeroEvidence(await probeEvidence()) ? "dead" : "unknown";
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
