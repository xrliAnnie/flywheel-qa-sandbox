import { FENCE, FenceViolation, type WriteTx } from "flywheel-v2-kernel";
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
}

interface RunningRow {
	attempt_uid: string;
	message_uid: string;
	instance_id: string;
	generation: number;
	activation_id: string | null;
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
		};
	}
	return {
		kind: "runner",
		agentId,
		instanceId: draft.instanceId,
		activationId: draft.activationId,
		generation,
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
		});
	} else {
		tx.cas(ENGINE_SQL.casRegisterAgent, {
			agentId,
			kind: draft.kind,
			oldGeneration: current.generation,
			newGeneration: nextGeneration,
		});
	}
	return registered(agentId, draft, nextGeneration);
}
