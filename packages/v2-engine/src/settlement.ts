import { randomUUID } from "node:crypto";
import { FENCE, type Kernel, type WriteTx } from "flywheel-v2-kernel";
import { ENGINE_SQL } from "./sql.js";
import {
	readCutoverEpochTx,
	requireAttemptBindingTx,
	requireCurrentAgentTx,
	settleFailureMailboxTx,
} from "./transitions.js";
import {
	type AttemptHandle,
	type ConversionProposal,
	type Effect,
	type EngineRuntime,
	MAX_EFFECTS_PER_PROPOSAL,
	MAX_FIELD_BYTES,
	MAX_PROPOSAL_TOTAL_BYTES,
} from "./types.js";

interface PreparedEffect {
	effect: Effect;
	id: string;
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function requireField(value: string, name: string): void {
	if (value.length === 0 || byteLength(value) > MAX_FIELD_BYTES) {
		throw new TypeError(
			`${name} must be non-empty and at most ${MAX_FIELD_BYTES} UTF-8 bytes`,
		);
	}
}

function validateProposal(proposal: ConversionProposal): PreparedEffect[] {
	requireField(proposal.handle.attemptUid, "attemptUid");
	requireField(proposal.handle.messageUid, "messageUid");
	if (proposal.effects.length > MAX_EFFECTS_PER_PROPOSAL) {
		throw new TypeError(
			`effects must contain at most ${MAX_EFFECTS_PER_PROPOSAL}`,
		);
	}
	if (byteLength(JSON.stringify(proposal)) > MAX_PROPOSAL_TOTAL_BYTES) {
		throw new TypeError(
			`proposal must be at most ${MAX_PROPOSAL_TOTAL_BYTES} UTF-8 bytes`,
		);
	}
	return proposal.effects.map((effect) => {
		if (effect.kind === "task") {
			requireField(effect.taskKind, "taskKind");
			requireField(effect.projectId, "projectId");
			if (effect.lineageRootTaskId !== undefined) {
				requireField(effect.lineageRootTaskId, "lineageRootTaskId");
			}
			return { effect, id: randomUUID() };
		}
		requireField(effect.eventKind, "eventKind");
		return { effect, id: randomUUID() };
	});
}

function writeEffect(
	tx: WriteTx,
	runtime: EngineRuntime,
	proposal: ConversionProposal,
	prepared: PreparedEffect,
	cutoverEpoch: number,
): void {
	const { effect, id } = prepared;
	const createdAt = runtime.clock.nowIso();
	if (effect.kind === "task") {
		tx.run(ENGINE_SQL.insertTask, {
			id,
			projectId: effect.projectId,
			kind: effect.taskKind,
			state: effect.state,
			payload: effect.payload,
			lineageRootId: effect.lineageRootTaskId ?? id,
			createdAt,
		});
		return;
	}
	tx.run(ENGINE_SQL.insertEvent, {
		eventUid: id,
		taskId: null,
		attemptId: null,
		kind: effect.eventKind,
		sourceKind: "v2-engine",
		sourceId: proposal.handle.attemptUid,
		payload: effect.payload,
		cutoverEpoch,
		createdAt,
	});
}

export function submitProposal(
	kernel: Kernel,
	runtime: EngineRuntime,
	proposal: ConversionProposal,
): void {
	const preparedEffects = validateProposal(proposal);
	kernel.write("consume.settle.success", (tx) => {
		requireCurrentAgentTx(tx, proposal.handle.agent);
		requireAttemptBindingTx(tx, proposal.handle);
		const cutoverEpoch = readCutoverEpochTx(tx);
		for (const prepared of preparedEffects) {
			writeEffect(tx, runtime, proposal, prepared, cutoverEpoch);
		}
		tx.run(ENGINE_SQL.insertEvent, {
			eventUid: `mailbox:${proposal.handle.messageUid}:applied:${proposal.handle.attemptUid}`,
			taskId: null,
			attemptId: null,
			kind: "mailbox.applied",
			sourceKind: "v2-engine",
			sourceId: proposal.handle.messageUid,
			payload: JSON.stringify({
				message_uid: proposal.handle.messageUid,
				attempt_uid: proposal.handle.attemptUid,
			}),
			cutoverEpoch,
			createdAt: runtime.clock.nowIso(),
		});
		tx.cas(FENCE.mailboxCasPendingApplied, {
			uid: proposal.handle.messageUid,
			now: runtime.clock.nowIso(),
		});
		tx.cas(FENCE.processingAttemptCasRunningSettled, {
			attemptUid: proposal.handle.attemptUid,
			outcome: "succeeded",
			settledAt: runtime.clock.nowIso(),
		});
	});
}

export function reportConversionFailure(
	kernel: Kernel,
	runtime: EngineRuntime,
	handle: AttemptHandle,
	_error: string,
): void {
	kernel.write("consume.settle.failure", (tx) => {
		requireCurrentAgentTx(tx, handle.agent);
		requireAttemptBindingTx(tx, handle);
		tx.cas(FENCE.processingAttemptCasRunningSettled, {
			attemptUid: handle.attemptUid,
			outcome: "failed",
			settledAt: runtime.clock.nowIso(),
		});
		settleFailureMailboxTx(tx, runtime, {
			agentId: handle.agent.agentId,
			messageUid: handle.messageUid,
			attemptUid: handle.attemptUid,
			generation: handle.agent.generation,
		});
	});
}
