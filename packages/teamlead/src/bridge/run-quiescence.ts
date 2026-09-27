import {
	type CodexDaemonEvidence,
	probeCodexDaemonEvidence,
} from "flywheel-claude-runner";
import type {
	RunQuiescenceEvidence,
	Session,
	StateStore,
} from "../StateStore.js";
import {
	type ExecutionBodyLivenessReader,
	readStoredExecutionBodyLiveness,
} from "./execution-body-reader.js";
import { storeExecutionBodyDeathEnabled } from "./flag-store-runtime.js";
import {
	type GeneralizedLaunchLiveness,
	probeHostProcessByExecutionId,
} from "./generalized-launch-recovery.js";

export type RunExecutionLivenessProbe = (
	executionId: string,
	projectName: string,
) => Promise<GeneralizedLaunchLiveness>;

export interface RunExecutionLivenessDeps {
	store?: StateStore;
	readBodyLiveness?: ExecutionBodyLivenessReader;
	/** Internal testing/embedding seam; production reads the managed store flag. */
	isEnabled?(): boolean;
	probeCodexDaemonEvidence?: typeof probeCodexDaemonEvidence;
	probeHostProcess?: typeof probeHostProcessByExecutionId;
}

/** Compatibility name for execution-wide physical evidence, independent of any
 * presentation target. Both callers use the same reader and no-body exception. */
export async function probeExecutionAbsenceBeyondTarget(
	session: Pick<Session, "adapter_type"> | undefined,
	executionId: string,
	projectName: string,
	deps: RunExecutionLivenessDeps = {},
): Promise<GeneralizedLaunchLiveness> {
	return probeRunExecutionLiveness(session, executionId, projectName, deps);
}

/** Ordinary death comes only from the shared body reader. A trusted pre-adapter
 * receipt is a separate never-spawned exception: two zero daemon samples, host
 * absence and the same closed launch claim must survive every async boundary. */
export async function probeRunExecutionLiveness(
	_session:
		| (Pick<Session, "adapter_type"> & Partial<Pick<Session, "status">>)
		| undefined,
	executionId: string,
	projectName: string,
	deps: RunExecutionLivenessDeps = {},
): Promise<GeneralizedLaunchLiveness> {
	try {
		const enabled = () =>
			deps.isEnabled
				? deps.isEnabled() === true
				: deps.store
					? storeExecutionBodyDeathEnabled({ mode: "ready", store: deps.store })
					: deps.readBodyLiveness !== undefined;
		if (!enabled()) return "unknown";
		const body = deps.readBodyLiveness
			? deps.readBodyLiveness(executionId, projectName)
			: deps.store
				? readStoredExecutionBodyLiveness(deps.store, executionId, projectName)
				: "unknown";
		if (body === "alive" || body === "dead") return body;
		const store = deps.store;
		if (!store) return "unknown";
		const snapshot = () =>
			store.getPreAdapterQuiescenceSnapshot(executionId, projectName);
		const initial = snapshot();
		if (!initial) return "unknown";
		const current = () => enabled() && snapshot() === initial;
		const zero = (e: CodexDaemonEvidence) =>
			e.liveness === "unknown" &&
			e.ledger === "missing" &&
			!e.socketLive &&
			e.spawnLock === "absent";
		const probe = deps.probeCodexDaemonEvidence ?? probeCodexDaemonEvidence;
		if (!zero(await probe(executionId)) || !current()) return "unknown";
		const host = await (deps.probeHostProcess ?? probeHostProcessByExecutionId)(
			executionId,
		);
		if (host.verdict !== "absent" || !current()) return "unknown";
		return zero(await probe(executionId)) && current() ? "dead" : "unknown";
	} catch {
		return "unknown";
	}
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
		const bodyDeathObligationId =
			store.getCurrentProjectedExecutionBodyDeath(executionId)?.obligationId;
		const preAdapterSnapshot = store.getPreAdapterQuiescenceSnapshot(
			executionId,
			run.project_name,
		);
		const liveness = probe
			? await probe(executionId, run.project_name)
			: await probeRunExecutionLiveness(
					session,
					executionId,
					run.project_name,
					{ store },
				);
		evidence.push({
			executionId,
			sessionStatus: session?.status ?? null,
			lifecycleRevision: session?.lifecycle_revision ?? null,
			liveness,
			observedAt: now().toISOString(),
			...(liveness === "dead" &&
			bodyDeathObligationId &&
			store.getCurrentProjectedExecutionBodyDeath(executionId)?.obligationId ===
				bodyDeathObligationId
				? { bodyDeathObligationId }
				: {}),
			...(liveness === "dead" &&
			preAdapterSnapshot &&
			store.getPreAdapterQuiescenceSnapshot(executionId, run.project_name) ===
				preAdapterSnapshot
				? { preAdapterSnapshot }
				: {}),
			...(session?.last_error?.startsWith("zombie: ")
				? { trustedZombieEventUid: `zombie-${executionId}` }
				: {}),
		});
	}
	return evidence;
}
