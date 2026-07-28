import type { Kernel } from "flywheel-v2-kernel";

const GLOBAL_LEASE_KEY = "scheduler-once";

export type SchedulerRunResult =
	| "succeeded"
	| "partial"
	| "failed"
	| "timed_out"
	| "probe";

export interface SchedulerRunStart {
	runId: string;
	backend: string;
	host: string;
	nowIso: string;
	leaseExpiresAt: string;
}

export interface SchedulerRunFinish {
	runId: string;
	result: SchedulerRunResult;
	detail: string;
	nowIso: string;
}

export interface StaleLeadCandidate {
	agentId: string;
	generation: number;
	lastPollAt: string;
}

export interface HeartbeatRepairClaim extends StaleLeadCandidate {
	crashedAttempts: number;
	failureCount: number;
}

export interface HeartbeatRepairClaimInput {
	runId: string;
	agentId: string;
	generation: number;
	observedLastPollAt: string;
	staleBeforeIso: string;
	nowIso: string;
	leaseExpiresAt: string;
}

export interface HeartbeatRepairFinish {
	runId: string;
	agentId: string;
	generation: number;
	result: "succeeded" | "failed" | "held" | "memory_limited";
	nowIso: string;
	nextAttemptAt?: string | null;
}

interface CandidateRow {
	agent_id: string;
	generation: number;
	last_poll_at: string;
}

interface RepairLeaseRow {
	failure_count: number;
}

export interface HeartbeatProgress {
	generation: number;
	lastPollAt: string | null;
	state: "online" | "offline";
}

function requireNonEmpty(value: string, name: string): void {
	if (value.trim().length === 0 || value.includes("\0")) {
		throw new TypeError(`${name} must be a non-empty string`);
	}
}

function requireIso(value: string, name: string): void {
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
		throw new TypeError(`${name} must be canonical UTC ISO-8601`);
	}
}

function validateRunFields(input: { runId: string; nowIso: string }): void {
	requireNonEmpty(input.runId, "runId");
	requireIso(input.nowIso, "nowIso");
}

export function startSchedulerRun(
	kernel: Kernel,
	input: SchedulerRunStart,
): boolean {
	validateRunFields(input);
	requireNonEmpty(input.backend, "backend");
	requireNonEmpty(input.host, "host");
	requireIso(input.leaseExpiresAt, "leaseExpiresAt");
	return kernel.write("scheduler.start-run", (tx) => {
		tx.run(
			`INSERT INTO scheduler_runs
			 (run_id,started_at,finished_at,result,host,backend,detail)
			 VALUES (@runId,@nowIso,NULL,'running',@host,@backend,NULL)`,
			input,
		);
		const acquired = tx.run(
			`INSERT INTO scheduler_leases
			 (lease_key,owner_run_id,lease_expires_at,updated_at)
			 VALUES (@leaseKey,@runId,@leaseExpiresAt,@nowIso)
			 ON CONFLICT(lease_key) DO UPDATE SET
			   owner_run_id=excluded.owner_run_id,
			   lease_expires_at=excluded.lease_expires_at,
			   updated_at=excluded.updated_at
			 WHERE scheduler_leases.lease_expires_at <= @nowIso`,
			{ ...input, leaseKey: GLOBAL_LEASE_KEY },
		);
		if (acquired.changes === 1) return true;
		tx.cas(
			`UPDATE scheduler_runs
			 SET finished_at=@nowIso,result='lease_busy',detail='global lease held'
			 WHERE run_id=@runId AND result='running'`,
			input,
		);
		return false;
	});
}

export function finishSchedulerRun(
	kernel: Kernel,
	input: SchedulerRunFinish,
): void {
	validateRunFields(input);
	requireNonEmpty(input.detail, "detail");
	kernel.write("scheduler.finish-run", (tx) => {
		tx.cas(
			`UPDATE scheduler_runs
			 SET finished_at=@nowIso,result=@result,detail=@detail
			 WHERE run_id=@runId AND result='running'`,
			input,
		);
		tx.run(
			`DELETE FROM scheduler_leases
			 WHERE lease_key=@leaseKey AND owner_run_id=@runId`,
			{ ...input, leaseKey: GLOBAL_LEASE_KEY },
		);
		if (input.result === "succeeded" || input.result === "probe") {
			tx.run(
				`INSERT INTO meta(key,value,updated_at)
				 VALUES ('last_scheduler_success_at',@nowIso,@nowIso)
				 ON CONFLICT(key) DO UPDATE SET
				   value=excluded.value,updated_at=excluded.updated_at`,
				input,
			);
		}
	});
}

export function listStaleLeadCandidates(
	kernel: Kernel,
	input: { staleBeforeIso: string; limit: number },
): StaleLeadCandidate[] {
	requireIso(input.staleBeforeIso, "staleBeforeIso");
	if (
		!Number.isSafeInteger(input.limit) ||
		input.limit <= 0 ||
		input.limit > 1000
	) {
		throw new TypeError("limit must be an integer in 1..1000");
	}
	return kernel
		.read((tx) =>
			tx.all<CandidateRow>(
				`SELECT a.agent_id,a.generation,a.last_poll_at
				 FROM agents a
				 WHERE a.kind='lead'
				   AND a.state='online'
				   AND a.generation > 0
				   AND a.last_poll_at IS NOT NULL
				   AND a.last_poll_at <= @staleBeforeIso
				   AND EXISTS (
				     SELECT 1 FROM mailbox m
				     WHERE m.to_agent=a.agent_id AND m.state='pending'
				   )
				 ORDER BY a.last_poll_at,a.agent_id
				 LIMIT @limit`,
				input,
			),
		)
		.map((row) => ({
			agentId: row.agent_id,
			generation: row.generation,
			lastPollAt: row.last_poll_at,
		}));
}

export function claimHeartbeatRepair(
	kernel: Kernel,
	input: HeartbeatRepairClaimInput,
): HeartbeatRepairClaim | null {
	validateRunFields(input);
	requireNonEmpty(input.agentId, "agentId");
	requireIso(input.observedLastPollAt, "observedLastPollAt");
	requireIso(input.staleBeforeIso, "staleBeforeIso");
	requireIso(input.leaseExpiresAt, "leaseExpiresAt");
	if (!Number.isSafeInteger(input.generation) || input.generation <= 0) {
		throw new TypeError("generation must be a positive safe integer");
	}
	return kernel.write("scheduler.claim-heartbeat-repair", (tx) => {
		const current = tx.get<CandidateRow>(
			`SELECT a.agent_id,a.generation,a.last_poll_at
			 FROM agents a
			 WHERE a.agent_id=@agentId
			   AND a.kind='lead'
			   AND a.state='online'
			   AND a.generation=@generation
			   AND a.last_poll_at=@observedLastPollAt
			   AND a.last_poll_at <= @staleBeforeIso
			   AND EXISTS (
			     SELECT 1 FROM mailbox m
			     WHERE m.to_agent=a.agent_id AND m.state='pending'
			   )`,
			input,
		);
		if (!current) return null;
		const lease = tx.run(
			`INSERT INTO scheduler_repair_leases
			 (agent_id,generation,owner_run_id,lease_expires_at,next_attempt_at,
			  failure_count,last_result,updated_at)
			 VALUES (@agentId,@generation,@runId,@leaseExpiresAt,NULL,0,NULL,@nowIso)
			 ON CONFLICT(agent_id,generation) DO UPDATE SET
			   owner_run_id=excluded.owner_run_id,
			   lease_expires_at=excluded.lease_expires_at,
			   next_attempt_at=NULL,
			   updated_at=excluded.updated_at
			 WHERE scheduler_repair_leases.lease_expires_at <= @nowIso
			   AND (
			     scheduler_repair_leases.next_attempt_at IS NULL
			     OR scheduler_repair_leases.next_attempt_at <= @nowIso
			   )`,
			input,
		);
		if (lease.changes !== 1) return null;
		const leaseRow = tx.get<RepairLeaseRow>(
			`SELECT failure_count FROM scheduler_repair_leases
			 WHERE agent_id=@agentId AND generation=@generation
			   AND owner_run_id=@runId`,
			input,
		);
		if (!leaseRow) {
			throw new Error("scheduler repair lease disappeared inside transaction");
		}
		const crashed = tx.run(
			`UPDATE processing_attempts
			 SET outcome='crashed',settled_at=@nowIso
			 WHERE outcome='running'
			   AND generation=@generation
			   AND EXISTS (
			     SELECT 1 FROM mailbox m
			     WHERE m.message_uid=processing_attempts.message_uid
			       AND m.to_agent=@agentId
			       AND m.state='pending'
			   )`,
			input,
		);
		return {
			agentId: current.agent_id,
			generation: current.generation,
			lastPollAt: current.last_poll_at,
			crashedAttempts: crashed.changes,
			failureCount: leaseRow.failure_count,
		};
	});
}

export function finishHeartbeatRepair(
	kernel: Kernel,
	input: HeartbeatRepairFinish,
): void {
	validateRunFields(input);
	requireNonEmpty(input.agentId, "agentId");
	if (!Number.isSafeInteger(input.generation) || input.generation <= 0) {
		throw new TypeError("generation must be a positive safe integer");
	}
	if (input.nextAttemptAt != null) {
		requireIso(input.nextAttemptAt, "nextAttemptAt");
	}
	kernel.write("scheduler.finish-heartbeat-repair", (tx) => {
		if (input.result === "succeeded") {
			tx.cas(
				`DELETE FROM scheduler_repair_leases
				 WHERE agent_id=@agentId AND generation=@generation
				   AND owner_run_id=@runId`,
				input,
			);
			return;
		}
		tx.cas(
			`UPDATE scheduler_repair_leases
			 SET lease_expires_at=@nowIso,next_attempt_at=@nextAttemptAt,
			     failure_count=failure_count+1,last_result=@result,updated_at=@nowIso
			 WHERE agent_id=@agentId AND generation=@generation
			   AND owner_run_id=@runId`,
			{ ...input, nextAttemptAt: input.nextAttemptAt ?? null },
		);
	});
}

export function readHeartbeatProgress(
	kernel: Kernel,
	agentId: string,
): HeartbeatProgress | null {
	requireNonEmpty(agentId, "agentId");
	const row = kernel.read((tx) =>
		tx.get<{
			generation: number;
			last_poll_at: string | null;
			state: "online" | "offline";
		}>(
			`SELECT generation,last_poll_at,state FROM agents
			 WHERE agent_id=@agentId AND kind='lead'`,
			{ agentId },
		),
	);
	return row
		? {
				generation: row.generation,
				lastPollAt: row.last_poll_at,
				state: row.state,
			}
		: null;
}
