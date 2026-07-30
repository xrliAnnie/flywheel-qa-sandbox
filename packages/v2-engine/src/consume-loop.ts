import {
	CANDIDATE_SQL,
	FenceViolation,
	type Kernel,
	type ReadTx,
	type WriteTx,
} from "flywheel-v2-kernel";
import {
	type Candidate,
	type CandidateLane,
	type CandidateSet,
	selectNext,
} from "./candidates.js";
import { readEngineConfigTx } from "./config.js";
import { ENGINE_SQL } from "./sql.js";
import {
	type RunningMessageRow,
	requireAttemptBindingTx,
	requireCurrentAgentTx,
	startAttemptTx,
} from "./transitions.js";
import type {
	EngineConfig,
	EngineRuntime,
	PollResult,
	RegisteredAgent,
} from "./types.js";

interface CandidateRow {
	seq: number;
	message_uid: string;
	payload: string;
	created_at: string;
}

function laneKey(lane: CandidateLane): keyof CandidateSet {
	return lane.toLowerCase() as keyof CandidateSet;
}

function toCandidate(lane: CandidateLane, row: CandidateRow): Candidate {
	return {
		lane,
		seq: row.seq,
		messageUid: row.message_uid,
		payload: row.payload,
		createdAt: row.created_at,
	};
}

function readCandidates(
	tx: ReadTx,
	agentId: string,
	now: string,
): CandidateSet {
	const candidates: CandidateSet = {};
	for (const lane of ["F1", "F2", "N1", "N2"] as const) {
		const row = tx.get<CandidateRow>(CANDIDATE_SQL[lane], {
			agent: agentId,
			now,
		});
		if (row) candidates[laneKey(lane)] = toCandidate(lane, row);
	}
	return candidates;
}

function readRunning(
	tx: ReadTx,
	agentId: string,
): RunningMessageRow | undefined {
	const rows = tx.all<RunningMessageRow>(
		ENGINE_SQL.readRecipientRunningMessage,
		{ agent: agentId },
	);
	if (rows.length > 1) {
		throw new FenceViolation(
			`recipient ${agentId} has multiple running attempts`,
		);
	}
	return rows[0];
}

function heartbeatDue(
	lastPollAt: string | null,
	nowMs: number,
	config: EngineConfig,
): boolean {
	if (lastPollAt === null) return true;
	const parsed = Date.parse(lastPollAt);
	if (
		!Number.isFinite(parsed) ||
		new Date(parsed).toISOString() !== lastPollAt
	) {
		throw new FenceViolation("agent last_poll_at is malformed");
	}
	return nowMs - parsed >= config.heartbeatWriteIntervalMs;
}

function available(
	running: RunningMessageRow,
	agent: RegisteredAgent,
): Extract<PollResult, { status: "available" }> {
	const handle = {
		attemptUid: running.attempt_uid,
		messageUid: running.message_uid,
		agent,
	};
	return {
		status: "available",
		handle,
		payload: running.payload,
		kind: running.kind,
		sourceKind: running.source_kind,
		seq: running.seq,
		resumed: true,
	};
}

export interface PollOnceResult {
	result: PollResult;
	nextFounderStreak: number;
}

/** FLY-1543 ⑤: a runner's heartbeat lands on its activations row, not agents. */
function casHeartbeatTx(
	tx: WriteTx,
	runtime: EngineRuntime,
	agent: RegisteredAgent,
): void {
	if (agent.kind === "runner") {
		tx.cas(ENGINE_SQL.casActivationHeartbeat, {
			activationId: agent.activationId,
			sessionRef: agent.agentId,
			now: runtime.clock.nowIso(),
		});
		return;
	}
	tx.cas(ENGINE_SQL.casHeartbeat, {
		agentId: agent.agentId,
		kind: agent.kind,
		generation: agent.generation,
		now: runtime.clock.nowIso(),
	});
}

export function refreshHeartbeat(
	kernel: Kernel,
	runtime: EngineRuntime,
	agent: RegisteredAgent,
): boolean {
	return kernel.write("consume.heartbeat", (tx) => {
		const config = readEngineConfigTx(tx);
		const authority = requireCurrentAgentTx(tx, agent);
		if (!heartbeatDue(authority.last_poll_at, runtime.clock.nowMs(), config)) {
			return false;
		}
		casHeartbeatTx(tx, runtime, agent);
		return true;
	});
}

export function pollOnce(
	kernel: Kernel,
	runtime: EngineRuntime,
	agent: RegisteredAgent,
	founderStreak: number,
	currentAttemptUid?: string,
): PollOnceResult {
	const fast = kernel.read((tx) => {
		const config = readEngineConfigTx(tx);
		const authority = requireCurrentAgentTx(tx, agent);
		const running = readRunning(tx, agent.agentId);
		if (
			running &&
			currentAttemptUid === running.attempt_uid &&
			!heartbeatDue(authority.last_poll_at, runtime.clock.nowMs(), config)
		) {
			requireAttemptBindingTx(tx, available(running, agent).handle);
			return {
				result: {
					status: "busy",
					attemptUid: running.attempt_uid,
				} as PollResult,
				config,
				needsWrite: false,
			};
		}
		if (running) {
			return { config, needsWrite: true as const };
		}
		const selected = selectNext(
			readCandidates(tx, agent.agentId, runtime.clock.nowIso()),
			founderStreak,
			runtime.clock.nowMs(),
			config,
		);
		const needsHeartbeat = heartbeatDue(
			authority.last_poll_at,
			runtime.clock.nowMs(),
			config,
		);
		if (!selected && !needsHeartbeat) {
			return {
				result: {
					status: "empty",
					retryAfterMs: config.pollIntervalMs,
				} as PollResult,
				config,
				needsWrite: false,
			};
		}
		return { config, needsWrite: true as const };
	});
	if (!fast.needsWrite && fast.result) {
		return { result: fast.result, nextFounderStreak: founderStreak };
	}

	return kernel.write("consume.poll", (tx) => {
		const config = readEngineConfigTx(tx);
		const authority = requireCurrentAgentTx(tx, agent);
		const running = readRunning(tx, agent.agentId);
		if (heartbeatDue(authority.last_poll_at, runtime.clock.nowMs(), config)) {
			casHeartbeatTx(tx, runtime, agent);
		}

		if (running && currentAttemptUid === running.attempt_uid) {
			requireAttemptBindingTx(tx, available(running, agent).handle);
			return {
				result: {
					status: "busy",
					attemptUid: running.attempt_uid,
				},
				nextFounderStreak: founderStreak,
			};
		}
		// A supplied uid can legitimately become stale between cadence scheduling
		// and settlement. Ignore it and resume/select from durable state.
		if (running) {
			const result = available(running, agent);
			requireAttemptBindingTx(tx, result.handle);
			return { result, nextFounderStreak: founderStreak };
		}

		const selected = selectNext(
			readCandidates(tx, agent.agentId, runtime.clock.nowIso()),
			founderStreak,
			runtime.clock.nowMs(),
			config,
		);
		if (!selected) {
			return {
				result: {
					status: "empty",
					retryAfterMs: config.pollIntervalMs,
				},
				nextFounderStreak: founderStreak,
			};
		}
		const started = startAttemptTx(
			tx,
			runtime,
			agent,
			selected.pick.messageUid,
		);
		if (!started) {
			return {
				result: {
					status: "empty",
					retryAfterMs: config.pollIntervalMs,
				},
				nextFounderStreak: founderStreak,
			};
		}
		return {
			result: {
				status: "available",
				handle: started.handle,
				payload: started.message.payload,
				kind: started.message.kind,
				sourceKind: started.message.sourceKind,
				seq: started.message.seq,
				resumed: started.resumed,
			},
			nextFounderStreak: started.resumed ? founderStreak : selected.nextStreak,
		};
	});
}
