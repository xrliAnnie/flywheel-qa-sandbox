export type ObservationState =
	| "present"
	| "live"
	| "absent"
	| "stale"
	| "not_applicable"
	| "unknown";

export interface Observation {
	state: ObservationState;
	observedAt: string;
	source: string;
	identity: string;
	reason: string;
}

export interface CloseoutObservations {
	stateSession: Observation;
	commSession: Observation;
	window: Observation;
	hostProcess: Observation;
	daemon: Observation;
	heartbeat: Observation;
	launch: Observation;
}

export type CloseoutEvidenceVerdict = "gone" | "alive" | "unknown";

export type CloseoutEvidenceAdapter =
	| "codex-tmux"
	| "claude-tmux"
	| "engine"
	| "unknown";

export interface CloseoutEvidenceIdentity {
	evidenceId: string;
	project: string;
	issueUuid: string;
	runId: string | null;
	executionId: string;
	activationId: string | null;
	operationId: string;
	operationGeneration: number;
	lifecycleRevision: number | null;
	attributionDigest: string;
	commIdentityRevision: string | null;
	windowIdentity: string | null;
	controllerGeneration: string | null;
	adapter: CloseoutEvidenceAdapter;
}

export interface CloseoutEvidence extends CloseoutEvidenceIdentity {
	version: 1;
	observedAt: string;
	expiresAt: string;
	observations: CloseoutObservations;
	negativeReasons: string[];
	liveVetoes: string[];
	unknownReasons: string[];
	verdict: CloseoutEvidenceVerdict;
}

type ObservationProbeResult = Pick<Observation, "state" | "reason"> &
	Partial<Pick<Observation, "identity" | "source">>;

type ObservationProbe = () =>
	| ObservationProbeResult
	| Promise<ObservationProbeResult>;

export interface CloseoutEvidenceCollectorDeps {
	stateSession: ObservationProbe;
	commSession: ObservationProbe;
	window: ObservationProbe;
	hostProcess: ObservationProbe;
	daemon: ObservationProbe;
	heartbeat: ObservationProbe;
	launch: ObservationProbe;
	now?: () => Date;
	sourceTimeoutMs?: number;
	totalTimeoutMs?: number;
}

export interface ExecutionCloseoutFacts {
	session:
		| Pick<
				Session,
				"status" | "adapter_type" | "heartbeat_at" | "lifecycle_revision"
		  >
		| undefined;
	launchClaimState: string | undefined;
}

export interface ExecutionCloseoutProbeDeps {
	readCommSession?: (
		executionId: string,
		projectName: string,
	) =>
		| "present"
		| "absent"
		| "unknown"
		| {
				state: "present" | "absent" | "unknown";
				revision: string | null;
		  };
	lookupTarget?: (executionId: string, projectName: string) => TmuxTargetLookup;
	probeWindow?: (tmuxWindow: string) => Promise<RunnerLiveness>;
	hasHostProcess?: (executionId: string) => Promise<boolean>;
	probeCodexDaemon?: (
		executionId: string,
	) => Promise<"alive" | "absent" | "unknown">;
	probeCodexDaemonEvidence?: (
		executionId: string,
	) => Promise<CodexDaemonEvidence>;
	now?: () => Date;
	sourceTimeoutMs?: number;
	totalTimeoutMs?: number;
}

const LIVE_VETO_SOURCES: ReadonlyArray<keyof CloseoutObservations> = [
	"window",
	"hostProcess",
	"daemon",
	"heartbeat",
];

const OBSERVATION_SOURCES: ReadonlyArray<keyof CloseoutObservations> = [
	"stateSession",
	"commSession",
	"window",
	"hostProcess",
	"daemon",
	"heartbeat",
	"launch",
];

const PHYSICAL_ABSENCE = new Set<ObservationState>([
	"absent",
	"not_applicable",
]);

async function collectObservation(
	source: keyof CloseoutObservations,
	identity: CloseoutEvidenceIdentity,
	probe: ObservationProbe,
	now: () => Date,
	timeoutMs: number,
): Promise<Observation> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<ObservationProbeResult>((resolve) => {
		timer = setTimeout(
			() => resolve({ state: "unknown", reason: "probe_timeout" }),
			timeoutMs,
		);
	});
	let fact: ObservationProbeResult;
	try {
		fact = await Promise.race([Promise.resolve().then(probe), timeout]);
	} catch (error) {
		fact = {
			state: "unknown",
			reason: `probe_error:${error instanceof Error ? error.message : String(error)}`,
		};
	} finally {
		if (timer) clearTimeout(timer);
	}
	return {
		state: fact.state,
		observedAt: now().toISOString(),
		source: fact.source ?? source,
		identity: fact.identity ?? identity.executionId,
		reason: fact.reason,
	};
}

/** Collect bounded, independently timestamped facts for one execution. */
export async function collectCloseoutEvidence(
	identity: CloseoutEvidenceIdentity,
	deps: CloseoutEvidenceCollectorDeps,
): Promise<CloseoutEvidence> {
	const now = deps.now ?? (() => new Date());
	const sourceTimeoutMs = Math.max(
		1,
		Math.min(deps.sourceTimeoutMs ?? 5_000, deps.totalTimeoutMs ?? 10_000),
	);
	const entries = await Promise.all(
		OBSERVATION_SOURCES.map(
			async (source) =>
				[
					source,
					await collectObservation(
						source,
						identity,
						deps[source],
						now,
						sourceTimeoutMs,
					),
				] as const,
		),
	);
	const observations = Object.fromEntries(
		entries,
	) as unknown as CloseoutObservations;
	const verdict = decideCloseoutEvidence(observations);
	const observedAt = now();
	const reasons = (states: ReadonlySet<ObservationState>): string[] =>
		OBSERVATION_SOURCES.flatMap((source) =>
			states.has(observations[source].state)
				? [`${source}:${observations[source].reason}`]
				: [],
		);
	const unknownReasons = reasons(new Set<ObservationState>(["unknown"]));
	if (!PHYSICAL_ABSENCE.has(observations.launch.state)) {
		unknownReasons.push(`launch:${observations.launch.reason}`);
	}
	return {
		version: 1,
		...identity,
		observedAt: observedAt.toISOString(),
		expiresAt: new Date(observedAt.getTime() + 30_000).toISOString(),
		observations,
		negativeReasons: reasons(new Set<ObservationState>(["absent", "stale"])),
		liveVetoes: reasons(new Set<ObservationState>(["live"])),
		unknownReasons,
		verdict,
	};
}

function readCommSession(
	executionId: string,
	projectName: string,
): {
	state: "present" | "absent" | "unknown";
	revision: string | null;
} {
	const path = resolveCommDbPath(projectName);
	if (!path) return { state: "unknown", revision: null };
	let db: CommDB | undefined;
	try {
		db = CommDB.openReadonly(path);
		const identity = db.getSessionCloseoutIdentity(executionId);
		return {
			state: identity.session ? "present" : "absent",
			revision: identity.revision,
		};
	} catch {
		return { state: "unknown", revision: null };
	} finally {
		db?.close();
	}
}

function closeoutAdapter(
	session: ExecutionCloseoutFacts["session"],
): CloseoutEvidenceAdapter {
	return session?.adapter_type === "codex-tmux" ||
		session?.adapter_type === "claude-tmux"
		? session.adapter_type
		: "unknown";
}

/** Production adapter from execution-bound probes to the evidence collector. */
export async function collectExecutionCloseoutEvidence(
	identity: CloseoutEvidenceIdentity,
	facts: ExecutionCloseoutFacts,
	deps: ExecutionCloseoutProbeDeps = {},
): Promise<CloseoutEvidence> {
	const now = deps.now ?? (() => new Date());
	const lookup = (deps.lookupTarget ?? lookupTmuxTarget)(
		identity.executionId,
		identity.project,
	);
	const adapter =
		identity.adapter === "unknown"
			? closeoutAdapter(facts.session)
			: identity.adapter;
	const rawComm = (deps.readCommSession ?? readCommSession)(
		identity.executionId,
		identity.project,
	);
	const comm =
		typeof rawComm === "string"
			? { state: rawComm, revision: identity.commIdentityRevision }
			: rawComm;
	const resolvedIdentity: CloseoutEvidenceIdentity = {
		...identity,
		adapter,
		windowIdentity:
			lookup.kind === "found"
				? lookup.target.tmuxWindow
				: identity.windowIdentity,
		commIdentityRevision: comm.revision,
	};
	return collectCloseoutEvidence(resolvedIdentity, {
		stateSession: async () => ({
			state: facts.session ? "present" : "absent",
			reason: facts.session ? "state_session_present" : "state_session_absent",
		}),
		commSession: async () => {
			return {
				state: comm.state,
				reason: `comm_session_${comm.state}`,
				identity: comm.revision ?? identity.executionId,
			};
		},
		window: async () => {
			if (lookup.kind === "gone") {
				return { state: "absent", reason: "execution_window_absent" };
			}
			if (lookup.kind === "error") {
				return {
					state: "unknown",
					reason: `window_lookup_error:${lookup.error}`,
				};
			}
			const live = await (deps.probeWindow ?? probeRunnerProcessLiveness)(
				lookup.target.tmuxWindow,
			);
			return live === "alive"
				? { state: "live", reason: "execution_window_live" }
				: live === "absent" || live === "dead_pin"
					? { state: "absent", reason: `execution_window_${live}` }
					: { state: "unknown", reason: "execution_window_indeterminate" };
		},
		hostProcess: async () => {
			const live = await (deps.hasHostProcess ?? hasHostProcessByExecutionId)(
				identity.executionId,
			);
			return {
				state: live ? "live" : "absent",
				reason: live ? "execution_process_live" : "execution_process_absent",
			};
		},
		daemon: async () => {
			if (adapter === "claude-tmux" || adapter === "engine") {
				return {
					state: "not_applicable",
					reason: "adapter_has_no_codex_daemon",
				};
			}
			let state: "alive" | "absent" | "unknown";
			if (deps.probeCodexDaemon) {
				state = await deps.probeCodexDaemon(identity.executionId);
			} else {
				const evidence = await (
					deps.probeCodexDaemonEvidence ?? probeCodexDaemonEvidence
				)(identity.executionId);
				state =
					evidence.liveness === "unknown" &&
					evidence.ledger === "missing" &&
					!evidence.socketLive &&
					evidence.spawnLock === "absent"
						? "absent"
						: evidence.liveness;
			}
			return {
				state: state === "alive" ? "live" : state,
				reason: `codex_daemon_${state}`,
			};
		},
		heartbeat: async () => {
			if (adapter !== "codex-tmux") {
				return {
					state: "not_applicable",
					reason: "adapter_has_no_controller_heartbeat",
				};
			}
			const heartbeat = facts.session?.heartbeat_at;
			const nowMs = now().getTime();
			if (heartbeat == null || heartbeat.trim().length === 0) {
				return { state: "stale", reason: "controller_heartbeat_missing" };
			}
			const parsed = parseControllerHeartbeatMs(heartbeat);
			if (parsed === undefined || parsed > nowMs) {
				return { state: "unknown", reason: "controller_heartbeat_invalid" };
			}
			return isFreshControllerHeartbeat(heartbeat, nowMs, 60_000)
				? { state: "live", reason: "controller_heartbeat_fresh" }
				: { state: "stale", reason: "controller_heartbeat_stale" };
		},
		launch: async () => {
			if (
				facts.launchClaimState === "active" &&
				facts.session &&
				isOperationalTerminalStatus(facts.session.status)
			) {
				return {
					state: "not_applicable",
					reason: "terminal_session_launch_claim_stale",
				} as const;
			}
			const live =
				facts.launchClaimState === "starting" ||
				facts.launchClaimState === "active";
			return {
				state: live ? "present" : "absent",
				reason: live ? "launch_in_flight" : "launch_settled",
			};
		},
		now,
		sourceTimeoutMs: deps.sourceTimeoutMs,
		totalTimeoutMs: deps.totalTimeoutMs,
	});
}

/**
 * Reduce one fully collected execution probe to the closeout verdict.
 *
 * A row is identity evidence, not liveness. Physical liveness always vetoes a
 * negative fact; incomplete probes and launch races fail closed. Only then may
 * one of the founder-approved negative facts prove the execution gone.
 */
export function decideCloseoutEvidence(
	observations: CloseoutObservations,
): CloseoutEvidenceVerdict {
	if (
		LIVE_VETO_SOURCES.some((source) => observations[source].state === "live")
	) {
		return "alive";
	}

	if (
		observations.stateSession.state === "unknown" ||
		observations.commSession.state === "unknown" ||
		observations.window.state === "unknown" ||
		observations.hostProcess.state === "unknown" ||
		observations.daemon.state === "unknown" ||
		observations.heartbeat.state === "unknown" ||
		!PHYSICAL_ABSENCE.has(observations.launch.state) ||
		!PHYSICAL_ABSENCE.has(observations.window.state) ||
		!PHYSICAL_ABSENCE.has(observations.hostProcess.state) ||
		!PHYSICAL_ABSENCE.has(observations.daemon.state) ||
		!(["stale", "not_applicable"] as const).includes(
			observations.heartbeat.state as "stale" | "not_applicable",
		)
	) {
		return "unknown";
	}

	const hasNegativeFact =
		observations.stateSession.state === "absent" ||
		observations.commSession.state === "absent" ||
		observations.window.state === "absent" ||
		observations.hostProcess.state === "absent" ||
		observations.heartbeat.state === "stale";

	return hasNegativeFact ? "gone" : "unknown";
}

import {
	type CodexDaemonEvidence,
	probeCodexDaemonEvidence,
} from "flywheel-claude-runner";
import { CommDB } from "flywheel-comm/db";
import { isOperationalTerminalStatus } from "../operational-terminal-status.js";
import type { Session } from "../StateStore.js";
import { resolveCommDbPath } from "./commdb-session-prune.js";
import { hasHostProcessByExecutionId } from "./generalized-launch-recovery.js";
import {
	isFreshControllerHeartbeat,
	parseControllerHeartbeatMs,
} from "./runner-shutdown-evidence.js";
import {
	lookupTmuxTarget,
	probeRunnerProcessLiveness,
	type RunnerLiveness,
	type TmuxTargetLookup,
} from "./tmux-lookup.js";
