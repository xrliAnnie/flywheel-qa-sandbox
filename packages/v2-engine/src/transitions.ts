import {
	FENCE,
	FenceViolation,
	type ReadTx,
	type WriteTx,
} from "flywheel-v2-kernel";
import { readEngineConfigTx } from "./config.js";
import { ENGINE_SQL } from "./sql.js";
import type { AttemptHandle, EngineRuntime, RegisteredAgent } from "./types.js";

interface AgentRow {
	agent_id: string;
	kind: string;
	generation: number;
	last_poll_at: string | null;
	state: string;
}

export interface RunningMessageRow {
	attempt_uid: string;
	message_uid: string;
	instance_id: string;
	generation: number;
	activation_id: string | null;
	started_at: string;
	payload: string;
	kind: string;
	source_kind: string;
	seq: number;
	created_at: string;
}

export interface AttemptBindingRow {
	attempt_uid: string;
	message_uid: string;
	instance_id: string;
	generation: number;
	activation_id: string | null;
	started_at: string;
	outcome: string;
	to_agent: string;
	mailbox_state: string;
	mailbox_cutover_epoch: number;
}

interface EventRow {
	event_uid: string;
	task_id: string | null;
	attempt_id: string | null;
	kind: string;
	source_kind: string | null;
	source_id: string | null;
	payload: string | null;
	cutover_epoch: number;
	created_at: string;
}

function activationFor(agent: RegisteredAgent): string | null {
	return agent.kind === "runner" ? agent.activationId : null;
}

function isCanonicalIso(value: string): boolean {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function readCutoverEpochTx(tx: ReadTx): number {
	const value = tx.get<{ value: string }>(ENGINE_SQL.readCutoverEpoch)?.value;
	const epoch = value === undefined ? Number.NaN : Number(value);
	if (!Number.isSafeInteger(epoch) || epoch <= 0) {
		throw new FenceViolation("cutover_epoch is missing or malformed");
	}
	return epoch;
}

export function requireCurrentAgentTx(
	tx: ReadTx,
	agent: RegisteredAgent,
): AgentRow {
	const row = tx.get<AgentRow>(ENGINE_SQL.readAgent, {
		agentId: agent.agentId,
	});
	if (!row || row.kind !== agent.kind || row.generation !== agent.generation) {
		throw new FenceViolation(
			`agent generation is not current for ${agent.agentId}`,
		);
	}
	return row;
}

export function requireAttemptBindingTx(
	tx: ReadTx,
	handle: AttemptHandle,
): AttemptBindingRow {
	const row = tx.get<AttemptBindingRow>(ENGINE_SQL.readAttemptBinding, {
		attemptUid: handle.attemptUid,
	});
	const agent = handle.agent;
	if (
		!row ||
		row.outcome !== "running" ||
		row.message_uid !== handle.messageUid ||
		row.to_agent !== agent.agentId ||
		row.mailbox_state !== "pending" ||
		row.instance_id !== agent.instanceId ||
		row.generation !== agent.generation ||
		row.activation_id !== activationFor(agent)
	) {
		throw new FenceViolation(
			`attempt binding mismatch for ${handle.attemptUid}`,
		);
	}
	return row;
}

export interface FailureContext {
	agentId: string;
	messageUid: string;
	attemptUid: string;
	generation: number;
}

export function settleFailureMailboxTx(
	tx: WriteTx,
	runtime: EngineRuntime,
	context: FailureContext,
): void {
	const row = tx.get<{
		retry_count: number;
		state: string;
		to_agent: string;
	}>(ENGINE_SQL.readMailboxRetry, { messageUid: context.messageUid });
	if (!row || row.state !== "pending" || row.to_agent !== context.agentId) {
		throw new FenceViolation(
			`mailbox failure binding mismatch for ${context.messageUid}`,
		);
	}
	const config = readEngineConfigTx(tx);
	const nextCount = row.retry_count + 1;
	if (nextCount < config.maxAttempts) {
		const delay = Math.min(
			config.retryBaseMs * 2 ** row.retry_count,
			config.retryCapMs,
		);
		tx.cas(FENCE.mailboxCasScheduleRetry, {
			uid: context.messageUid,
			agent: context.agentId,
			nextRetryAt: new Date(runtime.clock.nowMs() + delay).toISOString(),
		});
		return;
	}

	tx.cas(FENCE.mailboxCasFailureDead, {
		uid: context.messageUid,
		agent: context.agentId,
	});
	const eventUid = `mailbox:${context.messageUid}:dead`;
	const payload = JSON.stringify({
		message_uid: context.messageUid,
		attempt_uid: context.attemptUid,
		generation: context.generation,
	});
	const intent = {
		eventUid,
		kind: "mailbox.dead",
		sourceKind: "agent",
		sourceId: context.agentId,
		payload,
		cutoverEpoch: readCutoverEpochTx(tx),
		createdAt: runtime.clock.nowIso(),
	};
	tx.run(ENGINE_SQL.insertEventIfAbsent, intent);
	const event = tx.get<EventRow>(ENGINE_SQL.readEventByUid, { eventUid });
	if (
		!event ||
		event.kind !== intent.kind ||
		event.source_kind !== intent.sourceKind ||
		event.source_id !== intent.sourceId ||
		event.payload !== intent.payload ||
		event.cutover_epoch !== intent.cutoverEpoch ||
		event.task_id !== null ||
		event.attempt_id !== null ||
		!isCanonicalIso(event.created_at)
	) {
		throw new FenceViolation(`dead event collision for ${context.messageUid}`);
	}
}

export function startAttemptTx(
	tx: WriteTx,
	runtime: EngineRuntime,
	agent: RegisteredAgent,
	messageUid: string,
): {
	handle: AttemptHandle;
	message: {
		payload: string;
		kind: string;
		sourceKind: string;
		seq: number;
	};
	resumed: boolean;
} | null {
	requireCurrentAgentTx(tx, agent);
	const mailbox = tx.get<{
		message_uid: string;
		to_agent: string;
		state: string;
		next_retry_at: string | null;
		payload: string;
		kind: string;
		source_kind: string;
		seq: number;
	}>(ENGINE_SQL.readMailboxForStart, { messageUid });
	if (
		!mailbox ||
		mailbox.to_agent !== agent.agentId ||
		mailbox.state !== "pending" ||
		(mailbox.next_retry_at !== null &&
			mailbox.next_retry_at > runtime.clock.nowIso())
	) {
		return null;
	}

	const running = tx.all<RunningMessageRow>(
		ENGINE_SQL.readRecipientRunningMessage,
		{ agent: agent.agentId },
	);
	if (running.length > 1) {
		throw new FenceViolation(
			`recipient ${agent.agentId} has multiple running attempts`,
		);
	}
	const current = running[0];
	if (current) {
		if (current.message_uid !== messageUid) {
			throw new FenceViolation(
				`recipient ${agent.agentId} already has running ${current.message_uid}`,
			);
		}
		const handle = {
			attemptUid: current.attempt_uid,
			messageUid,
			agent,
		};
		requireAttemptBindingTx(tx, handle);
		return {
			handle,
			message: {
				payload: current.payload,
				kind: current.kind,
				sourceKind: current.source_kind,
				seq: current.seq,
			},
			resumed: true,
		};
	}

	const attemptNo =
		(tx.get<{ attempt_no: number }>(ENGINE_SQL.readMaxAttemptNo, {
			messageUid,
		})?.attempt_no ?? 0) + 1;
	const attemptUid = `${messageUid}#${attemptNo}`;
	tx.run(ENGINE_SQL.insertProcessingAttempt, {
		attemptUid,
		messageUid,
		attemptNo,
		instanceId: agent.instanceId,
		generation: agent.generation,
		activationId: activationFor(agent),
		startedAt: runtime.clock.nowIso(),
	});
	return {
		handle: { attemptUid, messageUid, agent },
		message: {
			payload: mailbox.payload,
			kind: mailbox.kind,
			sourceKind: mailbox.source_kind,
			seq: mailbox.seq,
		},
		resumed: false,
	};
}
