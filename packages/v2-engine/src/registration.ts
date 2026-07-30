import {
	FENCE,
	FenceViolation,
	type Kernel,
	type WriteTx,
} from "flywheel-v2-kernel";
import {
	parseSessionBinding,
	serializeSessionBinding,
	sessionBindingsEqual,
	validateSessionBinding,
} from "./session-binding.js";
import { ENGINE_SQL } from "./sql.js";
import { settleFailureMailboxTx } from "./transitions.js";
import {
	type EngineRuntime,
	type IdentityDraft,
	isSessionRecipient,
	type RegisteredAgent,
} from "./types.js";

interface AgentRow {
	agent_id: string;
	kind: string;
	generation: number;
	instance_id: string | null;
	session_binding: string | null;
}

interface RunningRow {
	attempt_uid: string;
	message_uid: string;
	instance_id: string;
	generation: number;
	activation_id: string | null;
}

/**
 * Codex R3 HIGH-1: the probe used to answer `string | null`, which conflated
 * "this pid does not exist" with "the probe itself could not answer". Reading
 * the second as the first is fail-open: it is exactly what lets a caller claim a
 * live session is dead. The probe therefore reports which of the two it
 * observed, and callers must decide separately for each.
 */
export type ProcessStartProbe =
	| { status: "present"; startIdentity: string }
	| { status: "absent" }
	| { status: "unavailable"; reason: string };

/**
 * The four states a caller can conclude about a recorded session binding.
 * Only `different_process` and `pid_absent` are positive evidence of death.
 */
export type SessionProcessState =
	| "same_process"
	| "different_process"
	| "pid_absent"
	| "probe_unavailable";

export function classifySessionProcess(
	probed: ProcessStartProbe,
	expectedStartIdentity: string,
): SessionProcessState {
	if (probed.status === "unavailable") return "probe_unavailable";
	if (probed.status === "absent") return "pid_absent";
	return probed.startIdentity === expectedStartIdentity
		? "same_process"
		: "different_process";
}

export interface SessionEvidenceProbe {
	processStart(pid: number): ProcessStartProbe;
	sessionOwner(sessionId: string): { pid: number; pidStart: string } | null;
}

export interface ReattachAgentOptions {
	kernel: Kernel;
	runtime: EngineRuntime;
	expected: RegisteredAgent;
	hostEpoch: string;
	probe: SessionEvidenceProbe;
}

function requireNonEmpty(value: string, name: string): void {
	if (value.trim().length === 0) {
		throw new FenceViolation(`${name} must not be empty`);
	}
}

function validateDraft(agentId: string, draft: IdentityDraft): void {
	requireNonEmpty(agentId, "agentId");
	requireNonEmpty(draft.leadId, "draft agentId");
	requireNonEmpty(draft.instanceId, "instanceId");
	validateSessionBinding(draft.sessionBinding);
	if (draft.leadId !== agentId) {
		throw new FenceViolation("identity subject does not match agent");
	}
}

function registered(
	agentId: string,
	draft: IdentityDraft,
	generation: number,
): RegisteredAgent {
	return {
		kind: "lead",
		agentId,
		instanceId: draft.instanceId,
		generation,
		sessionBinding: draft.sessionBinding,
	};
}

/**
 * FLY-1543 ①: registration IS the takeover. A new registration for an existing
 * lead identity displaces the current generation directly -- no death evidence,
 * no process interrogation. Displacement itself is the safety mechanism: the
 * generation bump makes every credential, heartbeat and running attempt of the
 * superseded generation invalid through the existing fences, so a still-live
 * old process is just a shell that can no longer read mail or write the ledger.
 * A same-uid impostor registering as a lead is an accepted design boundary
 * (founder ruling recorded on the FLY-1502 lane): it already holds the host
 * secret.
 *
 * FLY-1543 ⑤: lead-only. A runner's identity is its activations row; the
 * `v2dag:` session namespace is structurally refused here so the two recipient
 * namespaces can never collide.
 */
export function registerAgentTx(
	tx: WriteTx,
	runtime: EngineRuntime,
	agentId: string,
	draft: IdentityDraft,
): RegisteredAgent {
	if (draft.kind !== "lead") {
		throw new FenceViolation("registerAgentTx accepts lead identities only");
	}
	validateDraft(agentId, draft);
	if (isSessionRecipient(agentId)) {
		throw new FenceViolation(
			"lead agent id must not use the v2dag: session namespace",
		);
	}
	const current = tx.get<AgentRow>(ENGINE_SQL.readAgent, { agentId });
	if (current && current.kind !== draft.kind) {
		throw new FenceViolation(`agent kind collision for ${agentId}`);
	}

	const running = tx.all<RunningRow>(ENGINE_SQL.readRecipientRunning, {
		agent: agentId,
	});
	if (!current && running.length > 0) {
		throw new FenceViolation(
			`recipient ${agentId} has an unexplained running attempt`,
		);
	}

	let nextGeneration = 1;
	if (current && current.generation > 0) {
		nextGeneration = current.generation + 1;
		const foreign = running.find(
			(row) => row.generation !== current.generation,
		);
		if (foreign) {
			throw new FenceViolation(
				`recipient ${agentId} has foreign running attempt ${foreign.attempt_uid}`,
			);
		}
		for (const row of running) {
			tx.cas(FENCE.processingAttemptCasRunningSettled, {
				attemptUid: row.attempt_uid,
				outcome: "crashed",
				settledAt: runtime.clock.nowIso(),
				proposalDigest: null,
			});
			settleFailureMailboxTx(tx, runtime, {
				agentId,
				messageUid: row.message_uid,
				attemptUid: row.attempt_uid,
				generation: current.generation,
			});
		}
	}

	if (!current) {
		tx.run(ENGINE_SQL.insertRegisteredAgent, {
			agentId,
			kind: draft.kind,
			instanceId: draft.instanceId,
			sessionBinding: serializeSessionBinding(draft.sessionBinding),
		});
	} else {
		tx.cas(ENGINE_SQL.casRegisterAgent, {
			agentId,
			kind: draft.kind,
			oldGeneration: current.generation,
			newGeneration: nextGeneration,
			instanceId: draft.instanceId,
			sessionBinding: serializeSessionBinding(draft.sessionBinding),
		});
	}
	return registered(agentId, draft, nextGeneration);
}

function requireStoredBinding(
	row: AgentRow | undefined,
	expected: RegisteredAgent,
): string {
	if (
		!row ||
		row.generation < 1 ||
		row.instance_id === null ||
		row.session_binding === null
	) {
		throw new FenceViolation(`agent ${expected.agentId} is not reattachable`);
	}
	if (
		row.kind !== expected.kind ||
		row.generation !== expected.generation ||
		row.instance_id !== expected.instanceId
	) {
		throw new FenceViolation(
			`agent ${expected.agentId} durable identity does not match reattach request`,
		);
	}
	if (!expected.sessionBinding) {
		throw new FenceViolation(
			`agent ${expected.agentId} reattach requires a session binding`,
		);
	}
	const stored = parseSessionBinding(row.session_binding);
	if (!sessionBindingsEqual(stored, expected.sessionBinding)) {
		throw new FenceViolation(
			`agent ${expected.agentId} session binding does not match reattach request`,
		);
	}
	return row.session_binding;
}

function requireLiveSessionEvidence(
	expected: RegisteredAgent,
	hostEpoch: string,
	probe: SessionEvidenceProbe,
): void {
	if (!expected.sessionBinding) {
		throw new FenceViolation(
			`agent ${expected.agentId} reattach requires a session binding`,
		);
	}
	validateSessionBinding(expected.sessionBinding);
	requireNonEmpty(hostEpoch, "hostEpoch");
	if (expected.sessionBinding.hostEpoch !== hostEpoch) {
		throw new FenceViolation(
			`agent ${expected.agentId} session binding has a stale host epoch`,
		);
	}
	// Reattach requires positive proof that the SAME process is still there, so
	// every non-`same_process` state -- including an unavailable probe -- fails
	// closed here.
	if (
		classifySessionProcess(
			probe.processStart(expected.sessionBinding.pid),
			expected.sessionBinding.pidStart,
		) !== "same_process"
	) {
		throw new FenceViolation(
			`agent ${expected.agentId} process start identity does not match`,
		);
	}
	const owner = probe.sessionOwner(expected.sessionBinding.sessionId);
	if (
		!owner ||
		owner.pid !== expected.sessionBinding.pid ||
		owner.pidStart !== expected.sessionBinding.pidStart
	) {
		throw new FenceViolation(
			`agent ${expected.agentId} session owner does not match`,
		);
	}
}

/**
 * FLY-1543 ⑤: reattach is lead-only. Runners never reattach: a runner session
 * that comes back is the same activations row (nothing to restore), and a
 * runner session that died is resumed as a NEW activation by the DAG lifecycle.
 */
export function reattachAgent(options: ReattachAgentOptions): RegisteredAgent {
	const { expected, hostEpoch, kernel, probe, runtime } = options;
	requireNonEmpty(expected.agentId, "agentId");
	requireNonEmpty(expected.instanceId, "instanceId");
	if (expected.kind !== "lead") {
		throw new FenceViolation("reattachAgent accepts lead identities only");
	}

	const storedBinding = kernel.read((tx) =>
		requireStoredBinding(
			tx.get<AgentRow>(ENGINE_SQL.readAgent, {
				agentId: expected.agentId,
			}),
			expected,
		),
	);
	requireLiveSessionEvidence(expected, hostEpoch, probe);

	kernel.write("consumer.reattach", (tx) => {
		const result = tx.run(ENGINE_SQL.casReattachAgent, {
			agentId: expected.agentId,
			kind: expected.kind,
			generation: expected.generation,
			instanceId: expected.instanceId,
			sessionBinding: storedBinding,
			now: runtime.clock.nowIso(),
		});
		if (result.changes !== 1) {
			throw new FenceViolation(
				`agent ${expected.agentId} binding changed during reattach`,
			);
		}
	});
	return expected;
}
