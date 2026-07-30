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
import type {
	DeathEvidence,
	EngineRuntime,
	IdentityDraft,
	RegisteredAgent,
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

function draftAgentId(draft: IdentityDraft): string {
	return draft.kind === "lead" ? draft.leadId : draft.agentId;
}

function validateDraft(agentId: string, draft: IdentityDraft): void {
	requireNonEmpty(agentId, "agentId");
	requireNonEmpty(draftAgentId(draft), "draft agentId");
	requireNonEmpty(draft.instanceId, "instanceId");
	validateSessionBinding(draft.sessionBinding);
	if (draftAgentId(draft) !== agentId) {
		throw new FenceViolation("identity subject does not match agent");
	}
	if (draft.kind === "runner") {
		requireNonEmpty(draft.activationId, "activationId");
	}
}

function validateEvidence(
	evidence: DeathEvidence | undefined,
	current: AgentRow,
): void {
	if (
		!evidence ||
		evidence.agentId !== current.agent_id ||
		evidence.generation !== current.generation
	) {
		throw new FenceViolation(
			"death evidence does not match current generation",
		);
	}
	const parsed = Date.parse(evidence.confirmedAbsentAt);
	if (
		!Number.isFinite(parsed) ||
		new Date(parsed).toISOString() !== evidence.confirmedAbsentAt
	) {
		throw new FenceViolation("death evidence timestamp is malformed");
	}
}

function registered(
	agentId: string,
	draft: IdentityDraft,
	generation: number,
): RegisteredAgent {
	if (draft.kind === "lead") {
		return {
			kind: "lead",
			agentId,
			instanceId: draft.instanceId,
			generation,
			sessionBinding: draft.sessionBinding,
		};
	}
	return {
		kind: "runner",
		agentId,
		instanceId: draft.instanceId,
		activationId: draft.activationId,
		generation,
		sessionBinding: draft.sessionBinding,
	};
}

export function registerAgentTx(
	tx: WriteTx,
	runtime: EngineRuntime,
	agentId: string,
	draft: IdentityDraft,
	evidence?: DeathEvidence,
): RegisteredAgent {
	validateDraft(agentId, draft);
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
		validateEvidence(evidence, current);
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

	if (draft.kind === "runner") {
		const activation = tx.get<{ state: string }>(ENGINE_SQL.readActivation, {
			activationId: draft.activationId,
		});
		if (!activation || activation.state !== "active") {
			throw new FenceViolation("runner activation is not active");
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

export function reattachAgent(options: ReattachAgentOptions): RegisteredAgent {
	const { expected, hostEpoch, kernel, probe, runtime } = options;
	requireNonEmpty(expected.agentId, "agentId");
	requireNonEmpty(expected.instanceId, "instanceId");

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
		if (expected.kind === "runner") {
			const activation = tx.get<{
				id: string;
				session_ref: string;
				state: string;
			}>(ENGINE_SQL.readActivation, {
				activationId: expected.activationId,
			});
			if (
				!activation ||
				activation.state !== "active" ||
				activation.session_ref !== expected.sessionBinding.sessionId
			) {
				throw new FenceViolation(
					`runner ${expected.agentId} activation does not match live session`,
				);
			}
		}
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
