import {
	FENCE,
	FenceViolation,
	type ReadTx,
	type WriteTx,
} from "flywheel-v2-kernel";
import { readEngineConfigTx } from "./config.js";
import { serializeSessionBinding } from "./session-binding.js";
import { ENGINE_SQL } from "./sql.js";
import type { AttemptHandle, EngineRuntime, RegisteredAgent } from "./types.js";

interface AgentRow {
	agent_id: string;
	kind: string;
	generation: number;
	instance_id: string | null;
	session_binding: string | null;
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

interface ActivationRow {
	id: string;
	attempt_id: string;
	session_ref: string;
	generation: number;
	state: string;
	session_binding: string | null;
	last_poll_at: string | null;
}

/**
 * FLY-1543 ⑤: a runner's current-identity anchor is its activations row.
 *
 * The identity quad is {agentId = instanceId = session_ref, generation =
 * activations.generation, activationId = activations.id} and the anti-zombie
 * predicate is `state='active'`. The stored session binding is compared only
 * when the caller carries one -- the first delivery envelope is prepared before
 * the tmux process (and therefore the binding) exists.
 */
export function requireCurrentRunnerTx(
	tx: ReadTx,
	agent: Extract<RegisteredAgent, { kind: "runner" }>,
): AgentRow {
	const row = tx.get<ActivationRow>(ENGINE_SQL.readActivationFull, {
		activationId: agent.activationId,
	});
	if (
		!row ||
		row.state !== "active" ||
		row.session_ref !== agent.agentId ||
		row.session_ref !== agent.instanceId ||
		row.generation !== agent.generation ||
		(agent.sessionBinding !== undefined &&
			row.session_binding !== serializeSessionBinding(agent.sessionBinding))
	) {
		throw new FenceViolation(
			`runner activation is not current for ${agent.agentId}`,
		);
	}
	return {
		agent_id: row.session_ref,
		kind: "runner",
		generation: row.generation,
		instance_id: row.session_ref,
		session_binding: row.session_binding,
		last_poll_at: row.last_poll_at,
		state: "online",
	};
}

export function requireCurrentAgentTx(
	tx: ReadTx,
	agent: RegisteredAgent,
): AgentRow {
	if (agent.kind === "runner") {
		return requireCurrentRunnerTx(tx, agent);
	}
	const row = tx.get<AgentRow>(ENGINE_SQL.readAgent, {
		agentId: agent.agentId,
	});
	if (
		!row ||
		row.kind !== agent.kind ||
		row.generation !== agent.generation ||
		row.instance_id !== agent.instanceId ||
		row.session_binding !== serializeSessionBinding(agent.sessionBinding)
	) {
		throw new FenceViolation(
			`agent generation is not current or session binding mismatched for ${agent.agentId}`,
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
	options?: { beyondInjectedAssignment?: boolean },
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
	// FLY-1563: through the session pull, the assignment letter is reachable in
	// exactly one shape — the FLY-1503 item 8 redelivery (a prior attempt exists
	// and none is running). A never-attempted dispatch row belongs to the spawn
	// path, and a running one is the normal mid-task state the pull looks past.
	if (
		options?.beyondInjectedAssignment &&
		mailbox.source_kind === "dag_task_dispatch"
	) {
		const attempts = tx.get<{ total: number; running: number }>(
			`SELECT COUNT(*) AS total,
			        COALESCE(SUM(outcome='running'),0) AS running
			   FROM processing_attempts WHERE message_uid=@messageUid`,
			{ messageUid },
		);
		if (!attempts || attempts.total === 0 || attempts.running > 0) {
			throw new FenceViolation(
				`message ${messageUid} is a spawn-injected assignment and cannot be pulled`,
			);
		}
	}

	const allRunning = tx.all<RunningMessageRow>(
		ENGINE_SQL.readRecipientRunningMessage,
		{ agent: agent.agentId },
	);
	// FLY-1563: the open dispatch attempt does not block the transient lane —
	// the ONE scoped relaxation of the per-recipient serial rule (lead ruling).
	const running = options?.beyondInjectedAssignment
		? allRunning.filter((row) => row.source_kind !== "dag_task_dispatch")
		: allRunning;
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
