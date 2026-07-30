import { randomUUID } from "node:crypto";
import {
	type DeathEvidence,
	type RegisteredAgent,
	registerAgentTx,
	type SessionBinding,
} from "flywheel-v2-engine";
import {
	FENCE,
	type Kernel,
	type ReadTx,
	recordExternalEffectIntentTx,
	type WriteTx,
} from "flywheel-v2-kernel";
import { parseTaskPayload } from "./contract.js";
import { type CanonicalValue, sha256 } from "./digests.js";
import { DagContractError } from "./errors.js";
import { appendEvent } from "./events.js";
import { validateInjectionRef } from "./injection-ref.js";
import { appendMailboxTx } from "./mailbox-append.js";
import {
	type Envelope,
	insertEnvelope,
	makeEnvelope,
	readCutoverEpoch,
	readEnvelope,
	updateEnvelope,
} from "./meta.js";
import type {
	DagPorts,
	DispatchFailure,
	DispatchResult,
	ExecutorDescriptor,
	SpawnRequest,
} from "./types.js";

interface CandidateRow {
	id: string;
	payload: string;
}

interface IssueData {
	task_ids: string[];
	notify_agent_id: string;
}

interface WriterChainData {
	chain_head: string;
	open_attempt: null | {
		attempt_id: string;
		generation: number;
		family: string;
		start_head: string;
	};
	span_author_set: string[];
	pending_gap: null | { from: string; to: string };
}

interface AgentBindingData {
	state: "active" | "clear";
	activation_id: string | null;
	attempt_id: string | null;
	session_ref_current: string | null;
	session_ref_last: string | null;
	host_epoch: string | null;
}

interface LaunchClaimData {
	state: "pending" | "claimed" | "launched" | "tombstoned";
	owner_token: string | null;
	lease_until: string | null;
	death_evidence?: DeathEvidence | null;
	launch_receipt: null | {
		token: string;
		activation_id: string;
		host_epoch: string;
		launched_at: string;
	};
}

interface RecoverableClaim {
	request: SpawnRequest;
	claim: Envelope<LaunchClaimData>;
}

const CLAIM_LEASE_MS = 60_000;
const LAUNCH_REAP_GRACE_MS = 60_000;

class InjectedFault extends Error {
	constructor(point: string, cause: unknown) {
		super(
			`${point}: ${cause instanceof Error ? cause.message : String(cause)}`,
		);
		this.name = "InjectedFault";
	}
}

type DispatchFailureStage =
	| "task_payload"
	| "agent_binding"
	| "process_probe"
	| "worktree_lookup"
	| "worktree_head"
	| "prepare"
	| "launch_claim"
	| "launch"
	| "recovery_pending"
	| "recovery_claimed"
	| "recovery_reap";

function hitFault(ports: DagPorts, point: string): void {
	try {
		ports.faults?.hit(point);
	} catch (error) {
		throw new InjectedFault(point, error);
	}
}

function isContractParseFailure(error: unknown): boolean {
	return error instanceof DagContractError || error instanceof SyntaxError;
}

function errorClass(error: unknown): string {
	if (!(error instanceof Error)) return typeof error;
	return error.constructor.name || error.name || "Error";
}

/**
 * Codex R3 MEDIUM-3: explicit capacity for the recurrence record.
 *
 * MAX_SAMPLES bounds how many DISTINCT diagnostics are retained (the rest are
 * counted, so truncation is visible rather than silent). MAX_NOTICES bounds how
 * many mailbox rows one failure may ever create, so a permanently broken task
 * cannot grow mailbox history without limit no matter how long it runs or how
 * often the Lead drains.
 *
 * What is NOT bounded, stated precisely rather than glossed: there is one meta
 * row per distinct failure identity (kind + task + payload digest + stage + error
 * class), and nothing prunes it. That is the same order as the `events` row this
 * function already writes for each of those identities, so it adds a constant
 * factor to a dimension that is unbounded by design -- it does not introduce a
 * new one. A single failing task cannot grow it, because its identity is fixed;
 * only new tasks and new stages can, at one row each.
 */
export const MAX_RECURRENCE_SAMPLES = 5;
export const MAX_RECURRENCE_NOTICES = 8;

interface RecurrenceSample {
	digest: string;
	error: string;
	occurrences: number;
	first_seen: string;
	last_seen: string;
}

interface FailureRecurrenceData {
	event_uid: string;
	task_id: string;
	payload_digest: string;
	failure_stage: string;
	error_class: string;
	occurrences: number;
	first_seen: string;
	last_seen: string;
	notices_created: number;
	notice_cap_reached: boolean;
	samples: RecurrenceSample[];
	/** Distinct diagnostics seen but not retained, because MAX_SAMPLES was full. */
	distinct_diagnostics_dropped: number;
	/**
	 * Codex R4 MEDIUM-4: a diagnostic arrived that no notice has carried yet,
	 * because the mailbox slot was occupied when it was recorded. Durable, so the
	 * obligation to tell the Lead outlives the process that noticed it.
	 */
	undelivered_signal: boolean;
}

/**
 * Fixed-length notice key. Codex R3 MEDIUM-3 flagged that one event uid can be a
 * string prefix of another; hashing removes that possibility structurally rather
 * than relying on getting a separator comparison right.
 */
export function failureRecurrenceKey(eventUid: string): string {
	return sha256(eventUid);
}

function appendFailureRecurrence(
	tx: WriteTx,
	input: {
		candidate: CandidateRow;
		diagnostic: string;
		epoch: number;
		eventUid: string;
		failureClass: string;
		kind: string;
		notifyAgentId: string;
		nowIso: string;
		payloadDigest: string;
		stage: string;
	},
): boolean {
	const noticeKey = failureRecurrenceKey(input.eventUid);
	const metaKey = `dag_failure_recurrence:${noticeKey}`;
	const diagnosticDigest = sha256(input.diagnostic);
	const current = readEnvelope<FailureRecurrenceData>(tx, metaKey, input.epoch);

	const base: FailureRecurrenceData = current?.data ?? {
		event_uid: input.eventUid,
		task_id: input.candidate.id,
		payload_digest: input.payloadDigest,
		failure_stage: input.stage,
		error_class: input.failureClass,
		occurrences: 0,
		first_seen: input.nowIso,
		last_seen: input.nowIso,
		notices_created: 0,
		notice_cap_reached: false,
		samples: [],
		distinct_diagnostics_dropped: 0,
		undelivered_signal: false,
	};

	const samples = base.samples.map((sample) => ({ ...sample }));
	const existing = samples.find((sample) => sample.digest === diagnosticDigest);
	let dropped = base.distinct_diagnostics_dropped;
	if (existing) {
		existing.occurrences += 1;
		existing.last_seen = input.nowIso;
	} else if (samples.length < MAX_RECURRENCE_SAMPLES) {
		samples.push({
			digest: diagnosticDigest,
			error: input.diagnostic,
			occurrences: 1,
			first_seen: input.nowIso,
			last_seen: input.nowIso,
		});
	} else {
		dropped += 1;
	}

	// At most one outstanding notice per failure. Compared by exact prefix on a
	// fixed-length key: LIKE would treat the underscores in ids such as
	// `task_dispatch_invalid` as single-character wildcards.
	const noticePrefix = `${noticeKey}:`;
	const outstanding =
		tx.get<{ count: number }>(
			`SELECT count(*) AS count FROM mailbox
			  WHERE source_kind=@sourceKind
			    AND substr(source_id,1,@prefixLength)=@noticePrefix
			    AND state='pending'`,
			{
				sourceKind: `${input.kind}_repeat`,
				prefixLength: noticePrefix.length,
				noticePrefix,
			},
		)?.count ?? 0;

	// Codex R4 MEDIUM-4: a diagnostic that first appears while a notice is pending
	// used to reach the aggregate and stop there. If the task then recovered, no
	// further notice was ever raised and `meta` has no Lead read path, so that
	// signal was permanently invisible. The aggregate now carries an explicit
	// undelivered-signal flag, and the next notice is raised as soon as the mailbox
	// slot frees -- so the obligation survives in durable state instead of
	// depending on the failure happening to recur.
	const sampleIsNew = !existing;
	const pendingBlocked = outstanding > 0;
	const undeliveredSignal =
		base.undelivered_signal || (pendingBlocked && sampleIsNew);
	const shouldNotify =
		outstanding === 0 && base.notices_created < MAX_RECURRENCE_NOTICES;
	const next: FailureRecurrenceData = {
		...base,
		occurrences: base.occurrences + 1,
		last_seen: input.nowIso,
		notices_created: base.notices_created + (shouldNotify ? 1 : 0),
		notice_cap_reached:
			base.notice_cap_reached ||
			base.notices_created + (shouldNotify ? 1 : 0) >= MAX_RECURRENCE_NOTICES,
		samples,
		distinct_diagnostics_dropped: dropped,
		// Cleared only by actually raising the notice that carries it.
		undelivered_signal: shouldNotify ? false : undeliveredSignal,
	};

	if (current) {
		updateEnvelope(tx, metaKey, current, next, input.nowIso);
	} else {
		insertEnvelope(tx, metaKey, makeEnvelope(input.epoch, next), input.nowIso);
	}

	if (!shouldNotify) return true;
	appendMailboxTx(tx, {
		sourceKind: `${input.kind}_repeat`,
		sourceId: `${noticeKey}:n${next.notices_created}`,
		toAgent: input.notifyAgentId,
		kind: `${input.kind}_repeat`,
		payload: {
			task_id: input.candidate.id,
			payload_digest: input.payloadDigest,
			failure_stage: input.stage,
			error_class: input.failureClass,
			recurrence_key: noticeKey,
			occurrences: next.occurrences,
			first_seen: next.first_seen,
			last_seen: next.last_seen,
			notice_index: next.notices_created,
			notice_cap_reached: next.notice_cap_reached,
			distinct_diagnostics_dropped: next.distinct_diagnostics_dropped,
			// True when this notice is carrying a diagnostic that an earlier round
			// recorded but could not deliver.
			carries_deferred_signal: undeliveredSignal,
			samples: next.samples.map((sample) => ({
				diagnostic_digest: sample.digest,
				error: sample.error,
				occurrences: sample.occurrences,
				first_seen: sample.first_seen,
				last_seen: sample.last_seen,
			})),
		},
		retentionClass: "business",
		cutoverEpoch: input.epoch,
		createdAt: input.nowIso,
	});
	return true;
}

function auditTaskFailure(
	kernel: Kernel,
	ports: DagPorts,
	candidate: CandidateRow,
	error: unknown,
	kind: "task_contract_invalid" | "task_dispatch_invalid",
	stage: DispatchFailureStage,
): boolean {
	return kernel.write(`v2dag.dispatch.${kind}`, (tx) => {
		const epoch = readCutoverEpoch(tx);
		const issueId = issueForTask(tx, candidate.id, epoch);
		if (!issueId) return false;
		const issue = readEnvelope<IssueData>(tx, `dag_issue:${issueId}`, epoch);
		if (!issue) return false;
		const payloadDigest = sha256(candidate.payload);
		const failureClass = errorClass(error);
		const eventUid = `${kind}:${candidate.id}:${payloadDigest}:${stage}:${failureClass}`;
		if (
			tx.get("SELECT 1 FROM events WHERE event_uid=@eventUid", { eventUid })
		) {
			// FLY-1503 item 5: the event ledger stays deduped by
			// task+digest+stage+class, but this early return used to skip the notify
			// mailbox as well, so a failure that recurred on every coordinator tick
			// was completely silent while callers were still told it was audited.
			// Production hit this: seven identical launch failures produced one
			// notification and no further signal.
			//
			// Codex R2 MEDIUM-3: the hour bucket bounded neither the total (the
			// mailbox has no TTL, so a consumed notice was simply replaced next hour,
			// forever) nor the diagnostics (event identity carries only the error
			// *class*, so a pending "connection refused" notice permanently masked a
			// later "invalid configuration" of the same class).
			//
			// Key the notice on a digest of the actual diagnostic instead. The
			// mailbox's own (source_kind, source_id) dedup then makes an identical
			// diagnostic a one-time row for all time -- bounded by distinct
			// diagnostics rather than by elapsed hours -- while a changed message is a
			// new id and is no longer suppressed.
			// Codex R3 MEDIUM-3: keying the notice on the diagnostic digest bounded
			// the notices for an IDENTICAL message but not for a varying one -- a
			// diagnostic carrying a uuid, request id, temp path or timestamp produced
			// a new digest, so a new permanent mailbox row, every time. And a
			// one-off diagnostic that arrived while an earlier notice was still
			// pending was dropped outright: if it never recurred the Lead never saw
			// it at all.
			//
			// So the recurrence lives in a durable aggregate -- count, first/last
			// seen, and a capped set of distinct diagnostic samples -- and the
			// mailbox carries at most one notice at a time, up to a hard cap on how
			// many notices one failure may ever create. A diagnostic that changes
			// while a notice is pending is recorded in the aggregate immediately and
			// travels in the NEXT notice, so it is delayed rather than lost.
			return appendFailureRecurrence(tx, {
				candidate,
				diagnostic: error instanceof Error ? error.message : String(error),
				epoch,
				eventUid,
				failureClass,
				kind,
				notifyAgentId: issue.data.notify_agent_id,
				nowIso: ports.clock.nowIso(),
				payloadDigest,
				stage,
			});
		}
		const payload = {
			task_id: candidate.id,
			payload_digest: payloadDigest,
			failure_stage: stage,
			error_class: failureClass,
			error: error instanceof Error ? error.message : String(error),
		};
		appendEvent(tx, {
			eventUid,
			taskId: candidate.id,
			kind,
			sourceKind: "dispatcher",
			sourceId: candidate.id,
			payload,
			cutoverEpoch: epoch,
			createdAt: ports.clock.nowIso(),
		});
		appendMailboxTx(tx, {
			sourceKind: kind,
			sourceId: eventUid,
			toAgent: issue.data.notify_agent_id,
			kind,
			payload,
			retentionClass: "business",
			cutoverEpoch: epoch,
			createdAt: ports.clock.nowIso(),
		});
		return true;
	});
}

function auditTaskFailureSafely(
	kernel: Kernel,
	ports: DagPorts,
	candidate: CandidateRow,
	error: unknown,
	kind: "task_contract_invalid" | "task_dispatch_invalid",
	stage: DispatchFailureStage,
): boolean {
	try {
		return auditTaskFailure(kernel, ports, candidate, error, kind, stage);
	} catch {
		return false;
	}
}

function issueForTask(
	tx: WriteTx,
	taskId: string,
	epoch: number,
): string | null {
	const task = tx.get<{ external_issue_id: string }>(
		"SELECT external_issue_id FROM tasks WHERE id=@taskId",
		{ taskId },
	);
	if (!task) return null;
	const envelope = readEnvelope<IssueData>(
		tx,
		`dag_issue:${task.external_issue_id}`,
		epoch,
	);
	return envelope?.data.task_ids.includes(taskId)
		? task.external_issue_id
		: null;
}

function eligible(tx: WriteTx, taskId: string): boolean {
	const blocked = tx.get<{ count: number }>(
		`SELECT count(*) AS count
		   FROM task_dependencies d
		   JOIN tasks upstream ON upstream.id=d.blocked_by_task_id
		  WHERE d.task_id=@taskId AND upstream.state<>'done'`,
		{ taskId },
	)?.count;
	const active = tx.get<{ count: number }>(
		`SELECT count(*) AS count FROM attempts
		  WHERE task_id=@taskId AND desired_state<>'terminal'`,
		{ taskId },
	)?.count;
	return blocked === 0 && active === 0;
}

function prepareDispatch(
	tx: WriteTx,
	ports: DagPorts,
	candidate: CandidateRow,
	head: string | null,
	evidence?: DeathEvidence,
): SpawnRequest | null {
	const task = tx.get<{
		state: string;
		payload: string;
		project_id: string;
		external_issue_id: string;
		kind: string;
	}>(
		`SELECT state,payload,project_id,external_issue_id,kind
		   FROM tasks WHERE id=@taskId`,
		{ taskId: candidate.id },
	);
	if (!task || task.state !== "ready" || !eligible(tx, candidate.id))
		return null;
	const epoch = readCutoverEpoch(tx);
	if (!issueForTask(tx, candidate.id, epoch)) return null;
	const payload = parseTaskPayload(JSON.parse(task.payload));
	const bindingKey = `agent_binding:${payload.executor.logicalAgentId}`;
	const binding = readEnvelope<AgentBindingData>(tx, bindingKey, epoch);
	if (binding?.data.state === "active") return null;
	const agentRow = tx.get<{ generation: number }>(
		"SELECT generation FROM agents WHERE agent_id=@agentId AND kind='runner'",
		{ agentId: payload.executor.logicalAgentId },
	);
	if (agentRow && agentRow.generation > 0 && !binding) return null;

	let chain: Envelope<WriterChainData> | null = null;
	if (payload.writes_repo) {
		chain = readEnvelope<WriterChainData>(
			tx,
			`writer_chain:${payload.worktree_id}`,
			epoch,
		);
		if (
			!chain ||
			chain.data.open_attempt !== null ||
			chain.data.pending_gap !== null ||
			head !== chain.data.chain_head
		) {
			return null;
		}
	}
	const generation =
		tx.get<{ generation: number }>(
			"SELECT COALESCE(MAX(generation),0)+1 AS generation FROM attempts WHERE task_id=@taskId",
			{ taskId: candidate.id },
		)?.generation ?? 1;
	const attemptId = randomUUID();
	const activationId = randomUUID();
	const sessionRef = `v2dag:${attemptId}:${generation}:${activationId}`;
	const hostEpoch = ports.host.hostEpoch();
	const now = ports.clock.nowIso();
	const injectionRef = validateInjectionRef(
		ports.injectionRef.build({
			taskId: candidate.id,
			attemptId,
			attemptGeneration: generation,
			activationId,
			sessionRef,
			agentId: payload.executor.logicalAgentId,
			executor: payload.executor,
		}),
	);
	tx.run(
		`INSERT INTO attempts
		 (id,task_id,generation,vendor,model,worktree_id,host_epoch,desired_state)
		 VALUES(@id,@taskId,@generation,@vendor,@model,@worktreeId,@hostEpoch,'dispatched')`,
		{
			id: attemptId,
			taskId: candidate.id,
			generation,
			vendor: payload.executor.vendor,
			model: payload.executor.model,
			worktreeId: payload.worktree_id,
			hostEpoch,
		},
	);
	tx.run(
		`INSERT INTO activations(id,attempt_id,session_ref,generation,state)
		 VALUES(@id,@attemptId,@sessionRef,@generation,'active')`,
		{ id: activationId, attemptId, sessionRef, generation },
	);
	tx.run(
		`INSERT INTO meta(key,value,updated_at)
		 VALUES (@key,@value,@now)`,
		{
			key: `injection_ref:${activationId}`,
			value: injectionRef,
			now,
		},
	);
	const agent = {
		kind: "runner" as const,
		agentId: payload.executor.logicalAgentId,
		instanceId: sessionRef,
		generation: (agentRow?.generation ?? 0) + 1,
		activationId,
	};
	const nextBinding: AgentBindingData = {
		state: "active",
		activation_id: activationId,
		attempt_id: attemptId,
		session_ref_current: sessionRef,
		session_ref_last: binding?.data.session_ref_last ?? null,
		host_epoch: hostEpoch,
	};
	if (binding) {
		updateEnvelope(tx, bindingKey, binding, nextBinding, now);
	} else {
		insertEnvelope(tx, bindingKey, makeEnvelope(epoch, nextBinding), now);
	}
	insertEnvelope(
		tx,
		`launch_claim:${sessionRef}`,
		makeEnvelope<LaunchClaimData>(epoch, {
			state: "pending",
			owner_token: null,
			lease_until: null,
			death_evidence: evidence ?? null,
			launch_receipt: null,
		}),
		now,
	);
	tx.cas(
		"UPDATE tasks SET state='running',state_version=state_version+1 WHERE id=@taskId AND state='ready'",
		{ taskId: candidate.id },
	);
	if (payload.writes_repo && chain) {
		updateEnvelope(
			tx,
			`writer_chain:${payload.worktree_id}`,
			chain,
			{
				...chain.data,
				open_attempt: {
					attempt_id: attemptId,
					generation,
					family: payload.executor.family,
					start_head: chain.data.chain_head,
				},
			},
			now,
		);
	}
	appendEvent(tx, {
		eventUid: `attempt_dispatched:${attemptId}`,
		taskId: candidate.id,
		attemptId,
		kind: "attempt_dispatched",
		sourceKind: "dispatcher",
		sourceId: attemptId,
		payload: {
			agent_id: agent.agentId,
			instance_id: sessionRef,
			agent_generation: agent.generation,
			activation_id: activationId,
			attempt_id: attemptId,
			session_ref: sessionRef,
			host_epoch: hostEpoch,
		},
		cutoverEpoch: epoch,
		createdAt: now,
	});
	return {
		taskId: candidate.id,
		attemptId,
		attemptGeneration: generation,
		activationId,
		sessionRef,
		injectionRef,
		ownerToken: "",
		agent,
		...(evidence ? { deathEvidence: evidence } : {}),
		executor: payload.executor,
	};
}

export async function claimLaunch(
	kernel: Kernel,
	ports: DagPorts,
	request: SpawnRequest,
): Promise<SpawnRequest> {
	const ownerToken = randomUUID();
	const claimed = kernel.write("v2dag.launch.claim", (tx) => {
		const epoch = readCutoverEpoch(tx);
		const key = `launch_claim:${request.sessionRef}`;
		const claim = readEnvelope<LaunchClaimData>(tx, key, epoch);
		if (!claim || claim.data.state !== "pending") return false;
		const attempt = tx.get<{ desired_state: string }>(
			"SELECT desired_state FROM attempts WHERE id=@attemptId",
			{ attemptId: request.attemptId },
		);
		if (
			!attempt ||
			(attempt.desired_state !== "dispatched" &&
				attempt.desired_state !== "started")
		) {
			return false;
		}
		const leaseUntil = new Date(
			ports.clock.nowMs() + CLAIM_LEASE_MS,
		).toISOString();
		updateEnvelope(
			tx,
			key,
			claim,
			{
				...claim.data,
				state: "claimed",
				owner_token: ownerToken,
				lease_until: leaseUntil,
			},
			ports.clock.nowIso(),
		);
		if (attempt.desired_state === "dispatched") {
			tx.cas(
				`UPDATE attempts SET desired_state='started',started_at=@now
				 WHERE id=@attemptId AND desired_state='dispatched'`,
				{ attemptId: request.attemptId, now: ports.clock.nowIso() },
			);
		}
		return true;
	});
	if (!claimed) throw new Error(`launch claim lost for ${request.sessionRef}`);
	return { ...request, ownerToken };
}

function appendTaskAssignmentTx(
	tx: WriteTx,
	ports: DagPorts,
	request: SpawnRequest,
): void {
	const task = tx.get<{
		project_id: string;
		external_issue_id: string;
		kind: string;
		payload: string;
	}>(
		`SELECT t.project_id,t.external_issue_id,t.kind,t.payload
		   FROM attempts a
		   JOIN tasks t ON t.id=a.task_id
		  WHERE a.id=@attemptId AND a.task_id=@taskId`,
		{ attemptId: request.attemptId, taskId: request.taskId },
	);
	if (!task) {
		throw new DagContractError("runner task assignment source is missing");
	}
	const payload = parseTaskPayload(JSON.parse(task.payload));
	let startHead: string | null = null;
	if (payload.writes_repo) {
		const chain = readEnvelope<WriterChainData>(
			tx,
			`writer_chain:${payload.worktree_id}`,
		);
		if (chain?.data.open_attempt?.attempt_id !== request.attemptId) {
			throw new DagContractError(
				"runner task assignment writer span is not authoritative",
			);
		}
		startHead = chain.data.open_attempt.start_head;
	}
	appendMailboxTx(tx, {
		sourceKind: "dag_task_dispatch",
		sourceId: request.activationId,
		toAgent: request.agent.agentId,
		kind: "task_assignment",
		payload: {
			v: 1,
			project_id: task.project_id,
			issue_id: task.external_issue_id,
			task_id: request.taskId,
			task_kind: task.kind,
			attempt_id: request.attemptId,
			attempt_generation: request.attemptGeneration,
			activation_id: request.activationId,
			session_ref: request.sessionRef,
			host_epoch: ports.host.hostEpoch(),
			start_head: startHead,
			contract: payload.contract,
			writes_repo: payload.writes_repo,
			worktree_id: payload.worktree_id,
			executor: payload.executor,
		} as unknown as CanonicalValue,
		retentionClass: "business",
		cutoverEpoch: readCutoverEpoch(tx),
		createdAt: ports.clock.nowIso(),
	});
}

function storedSessionMatches(
	serialized: string | null,
	binding: SessionBinding,
): boolean {
	if (serialized === null) return false;
	let value: unknown;
	try {
		value = JSON.parse(serialized);
	} catch {
		return false;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const stored = value as Record<string, unknown>;
	return (
		Object.keys(stored).sort().join(",") ===
			"host_epoch,pid,pid_start,session_id,v" &&
		stored.v === 1 &&
		stored.host_epoch === binding.hostEpoch &&
		stored.session_id === binding.sessionId &&
		stored.pid === binding.pid &&
		stored.pid_start === binding.pidStart
	);
}

function registerSpawnedRunnerTx(
	tx: WriteTx,
	ports: DagPorts,
	request: SpawnRequest,
	sessionBinding: SessionBinding,
): RegisteredAgent {
	if (
		sessionBinding.hostEpoch !== ports.host.hostEpoch() ||
		sessionBinding.sessionId !== request.sessionRef
	) {
		throw new DagContractError(
			"spawn returned a session binding for a different host or session",
		);
	}
	const current = tx.get<{
		kind: string;
		generation: number;
		instance_id: string | null;
		session_binding: string | null;
	}>(
		`SELECT kind,generation,instance_id,session_binding
		   FROM agents WHERE agent_id=@agentId`,
		{ agentId: request.agent.agentId },
	);
	let registered: RegisteredAgent;
	if (current?.instance_id === request.sessionRef) {
		if (
			current.kind !== "runner" ||
			current.generation !== request.agent.generation ||
			!storedSessionMatches(current.session_binding, sessionBinding)
		) {
			throw new DagContractError(
				"durable runner registration conflicts with process evidence",
			);
		}
		registered = {
			kind: "runner",
			agentId: request.agent.agentId,
			instanceId: request.sessionRef,
			activationId: request.activationId,
			generation: current.generation,
			sessionBinding,
		};
	} else {
		registered = registerAgentTx(
			tx,
			{ clock: ports.clock },
			request.agent.agentId,
			{
				kind: "runner",
				agentId: request.agent.agentId,
				instanceId: request.sessionRef,
				activationId: request.activationId,
				sessionBinding,
			},
			request.deathEvidence,
		);
		if (registered.generation !== request.agent.generation) {
			throw new DagContractError("spawn registration generation drifted");
		}
	}
	appendTaskAssignmentTx(tx, ports, request);
	return registered;
}

export async function launchOnce(
	kernel: Kernel,
	ports: DagPorts,
	request: SpawnRequest,
): Promise<RegisteredAgent | false> {
	return await ports.locks.withSessionLock(request.sessionRef, async () => {
		const consumed = kernel.write("v2dag.launch.once", (tx) => {
			const epoch = readCutoverEpoch(tx);
			const key = `launch_claim:${request.sessionRef}`;
			const claim = readEnvelope<LaunchClaimData>(tx, key, epoch);
			const activation = tx.get<{ state: string }>(
				"SELECT state FROM activations WHERE id=@activationId",
				{ activationId: request.activationId },
			);
			if (
				!claim ||
				claim.data.state !== "claimed" ||
				claim.data.owner_token !== request.ownerToken ||
				claim.data.lease_until === null ||
				Date.parse(claim.data.lease_until) <= ports.clock.nowMs() ||
				activation?.state !== "active"
			) {
				return false;
			}
			recordExternalEffectIntentTx(tx, {
				effectKey: `spawn:${request.sessionRef}`,
				family: "spawn",
				nowIso: ports.clock.nowIso(),
			});
			updateEnvelope(
				tx,
				key,
				claim,
				{
					...claim.data,
					state: "launched",
					launch_receipt: {
						token: request.ownerToken,
						activation_id: request.activationId,
						host_epoch: ports.host.hostEpoch(),
						launched_at: ports.clock.nowIso(),
					},
				},
				ports.clock.nowIso(),
			);
			return true;
		});
		if (!consumed) return false;
		hitFault(ports, "launch_after_receipt");
		const sessionBinding = await ports.spawn.spawn(request);
		hitFault(ports, "launch_after_spawn");
		const agent = kernel.write("v2dag.launch.register", (tx) => {
			return registerSpawnedRunnerTx(tx, ports, request, sessionBinding);
		});
		return agent;
	});
}

export async function dispatchOnce(
	kernel: Kernel,
	ports: DagPorts,
): Promise<DispatchResult> {
	const candidates = kernel.read((tx) =>
		tx.all<CandidateRow>(
			"SELECT id,payload FROM tasks WHERE state='ready' ORDER BY created_at,id",
		),
	);
	const dispatched: SpawnRequest[] = [];
	const failures: DispatchFailure[] = [];
	for (const candidate of candidates) {
		let prepared: SpawnRequest | null;
		let failureStage: DispatchFailureStage = "task_payload";
		try {
			const payload = parseTaskPayload(JSON.parse(candidate.payload));
			let evidence: DeathEvidence | undefined;
			failureStage = "agent_binding";
			const prior = kernel.read((tx) => {
				const agent = tx.get<{ generation: number }>(
					"SELECT generation FROM agents WHERE agent_id=@agentId",
					{ agentId: payload.executor.logicalAgentId },
				);
				const binding = readEnvelope<AgentBindingData>(
					tx,
					`agent_binding:${payload.executor.logicalAgentId}`,
				);
				return { agent, binding };
			});
			if (prior.agent && prior.agent.generation > 0) {
				if (
					prior.binding?.data.state !== "clear" ||
					prior.binding.data.session_ref_last === null
				) {
					continue;
				}
				failureStage = "process_probe";
				const probe = await ports.process.probe(
					prior.binding.data.session_ref_last,
				);
				if (probe.state !== "absent") continue;
				evidence = {
					agentId: payload.executor.logicalAgentId,
					generation: prior.agent.generation,
					confirmedAbsentAt: probe.confirmedAt,
				};
			}
			let head: string | null = null;
			if (payload.writes_repo && payload.worktree_id) {
				failureStage = "worktree_lookup";
				const worktree = kernel.read((tx) =>
					readEnvelope<{ worktree_path: string }>(
						tx,
						`canonical_worktree:${payload.worktree_id}`,
					),
				);
				if (!worktree) continue;
				failureStage = "worktree_head";
				head = await ports.git.readHead(worktree.data.worktree_path);
			}
			failureStage = "prepare";
			prepared = kernel.write("v2dag.dispatch.prepare", (tx) =>
				prepareDispatch(tx, ports, candidate, head, evidence),
			);
		} catch (error) {
			const audited = auditTaskFailureSafely(
				kernel,
				ports,
				candidate,
				error,
				isContractParseFailure(error)
					? "task_contract_invalid"
					: "task_dispatch_invalid",
				failureStage,
			);
			failures.push({ taskId: candidate.id, stage: failureStage, audited });
			continue;
		}
		if (!prepared) continue;
		hitFault(ports, "dispatch_after_prepare");
		let claimed: SpawnRequest;
		try {
			claimed = await claimLaunch(kernel, ports, prepared);
		} catch (error) {
			const audited = auditTaskFailureSafely(
				kernel,
				ports,
				candidate,
				error,
				"task_dispatch_invalid",
				"launch_claim",
			);
			failures.push({
				taskId: candidate.id,
				stage: "launch_claim",
				audited,
			});
			continue;
		}
		hitFault(ports, "dispatch_after_claim");
		let launched: RegisteredAgent | false;
		try {
			launched = await launchOnce(kernel, ports, claimed);
		} catch (error) {
			if (error instanceof InjectedFault) throw error;
			const audited = auditTaskFailureSafely(
				kernel,
				ports,
				candidate,
				error,
				"task_dispatch_invalid",
				"launch",
			);
			failures.push({ taskId: candidate.id, stage: "launch", audited });
			continue;
		}
		if (launched) {
			if (launched.kind !== "runner") {
				throw new DagContractError("spawn registered a non-runner agent");
			}
			dispatched.push({ ...claimed, agent: launched });
		}
	}
	return { dispatched, failures };
}

function requestForSession(
	tx: ReadTx,
	sessionRef: string,
): SpawnRequest | null {
	const state = tx.get<{
		task_id: string;
		attempt_id: string;
		attempt_generation: number;
		activation_id: string;
		agent_id: string;
		agent_generation: number;
		agent_instance_id: string | null;
		payload: string;
		injection_ref: string;
	}>(
		`SELECT a.task_id,a.id AS attempt_id,
		        a.generation AS attempt_generation,
		        act.id AS activation_id,
		        json_extract(t.payload,'$.executor.logicalAgentId') AS agent_id,
		        COALESCE(ag.generation,0) AS agent_generation,
		        ag.instance_id AS agent_instance_id,
		        t.payload,ir.value AS injection_ref
		   FROM activations act
		   JOIN attempts a ON a.id=act.attempt_id
		   JOIN tasks t ON t.id=a.task_id
		   -- FLY-1503 item 4: LEFT JOIN so a launch that failed before
		   -- registerAgentTx could create the agents row stays recoverable.
		   -- An INNER JOIN here made recoverableClaims silently drop the claim,
		   -- leaving the attempt reapable only by hand.
		   LEFT JOIN agents ag
		     ON ag.agent_id=json_extract(t.payload,'$.executor.logicalAgentId')
		   JOIN meta ir ON ir.key='injection_ref:' || act.id
		  WHERE act.session_ref=@sessionRef
		    AND act.state='active'
		    AND a.desired_state IN ('dispatched','started')`,
		{ sessionRef },
	);
	if (!state) return null;
	const payload = parseTaskPayload(JSON.parse(state.payload));
	const injectionRef = validateInjectionRef(state.injection_ref);
	const registered = state.agent_instance_id === sessionRef;
	return {
		taskId: state.task_id,
		attemptId: state.attempt_id,
		attemptGeneration: state.attempt_generation,
		activationId: state.activation_id,
		sessionRef,
		injectionRef,
		ownerToken: "",
		agent: {
			kind: "runner",
			agentId: state.agent_id,
			instanceId: sessionRef,
			generation: registered
				? state.agent_generation
				: state.agent_generation + 1,
			activationId: state.activation_id,
		},
		executor: payload.executor,
	};
}

function recoverableClaims(kernel: Kernel): RecoverableClaim[] {
	return kernel.read((tx) => {
		const epoch = readCutoverEpoch(tx);
		const rows = tx.all<{ key: string }>(
			"SELECT key FROM meta WHERE key LIKE 'launch_claim:%' ORDER BY key",
		);
		return rows.flatMap((row) => {
			const claim = readEnvelope<LaunchClaimData>(tx, row.key, epoch);
			if (!claim || claim.data.state === "tombstoned") return [];
			const sessionRef = row.key.slice("launch_claim:".length);
			const request = requestForSession(tx, sessionRef);
			if (!request) return [];
			return [
				{
					request: {
						...request,
						...(claim.data.death_evidence
							? { deathEvidence: claim.data.death_evidence }
							: {}),
					},
					claim,
				},
			];
		});
	});
}

function markClaimLaunched(
	kernel: Kernel,
	ports: DagPorts,
	input: {
		request: SpawnRequest;
		expectedRevision: number;
		ownerToken: string;
		sessionBinding: SessionBinding;
	},
): boolean {
	return kernel.write("v2dag.launch.recover-adopt", (tx) => {
		const epoch = readCutoverEpoch(tx);
		const key = `launch_claim:${input.request.sessionRef}`;
		const claim = readEnvelope<LaunchClaimData>(tx, key, epoch);
		if (
			!claim ||
			claim.revision !== input.expectedRevision ||
			claim.data.state !== "claimed" ||
			claim.data.owner_token !== input.ownerToken
		) {
			return false;
		}
		updateEnvelope(
			tx,
			key,
			claim,
			{
				...claim.data,
				state: "launched",
				launch_receipt: {
					token: input.ownerToken,
					activation_id: input.request.activationId,
					host_epoch: ports.host.hostEpoch(),
					launched_at: ports.clock.nowIso(),
				},
			},
			ports.clock.nowIso(),
		);
		registerSpawnedRunnerTx(tx, ports, input.request, input.sessionBinding);
		return true;
	});
}

async function recoverClaimed(
	kernel: Kernel,
	ports: DagPorts,
	entry: RecoverableClaim,
): Promise<
	| { status: "adopted" | "unchanged" }
	| { status: "takeover"; request: SpawnRequest }
> {
	return await ports.locks.withSessionLock(
		entry.request.sessionRef,
		async () => {
			const current = kernel.read((tx) =>
				readEnvelope<LaunchClaimData>(
					tx,
					`launch_claim:${entry.request.sessionRef}`,
				),
			);
			if (
				!current ||
				current.revision !== entry.claim.revision ||
				current.data.state !== "claimed" ||
				current.data.owner_token === null
			) {
				return { status: "unchanged" };
			}
			const probe = await ports.process.probe(entry.request.sessionRef);
			if (probe.state === "present") {
				return markClaimLaunched(kernel, ports, {
					request: entry.request,
					expectedRevision: current.revision,
					ownerToken: current.data.owner_token,
					sessionBinding: probe.sessionBinding,
				})
					? { status: "adopted" }
					: { status: "unchanged" };
			}
			if (
				current.data.lease_until === null ||
				Date.parse(current.data.lease_until) > ports.clock.nowMs()
			) {
				return { status: "unchanged" };
			}
			const ownerToken = randomUUID();
			const taken = kernel.write("v2dag.launch.takeover", (tx) => {
				const epoch = readCutoverEpoch(tx);
				const key = `launch_claim:${entry.request.sessionRef}`;
				const claim = readEnvelope<LaunchClaimData>(tx, key, epoch);
				if (
					!claim ||
					claim.revision !== current.revision ||
					claim.data.state !== "claimed"
				) {
					return null;
				}
				return updateEnvelope(
					tx,
					key,
					claim,
					{
						...claim.data,
						owner_token: ownerToken,
						lease_until: new Date(
							ports.clock.nowMs() + CLAIM_LEASE_MS,
						).toISOString(),
					},
					ports.clock.nowIso(),
				);
			});
			return taken
				? {
						status: "takeover",
						request: { ...entry.request, ownerToken },
					}
				: { status: "unchanged" };
		},
	);
}

async function adoptLaunchedRunner(
	kernel: Kernel,
	ports: DagPorts,
	entry: RecoverableClaim,
): Promise<boolean> {
	return await ports.locks.withSessionLock(
		entry.request.sessionRef,
		async () => {
			const current = kernel.read((tx) =>
				readEnvelope<LaunchClaimData>(
					tx,
					`launch_claim:${entry.request.sessionRef}`,
				),
			);
			if (
				!current ||
				current.revision !== entry.claim.revision ||
				current.data.state !== "launched"
			) {
				return false;
			}
			const probe = await ports.process.probe(entry.request.sessionRef);
			if (probe.state !== "present") return false;
			return kernel.write("v2dag.launch.recover-register", (tx) => {
				const epoch = readCutoverEpoch(tx);
				const claim = readEnvelope<LaunchClaimData>(
					tx,
					`launch_claim:${entry.request.sessionRef}`,
					epoch,
				);
				if (
					!claim ||
					claim.revision !== current.revision ||
					claim.data.state !== "launched"
				) {
					return false;
				}
				registerSpawnedRunnerTx(tx, ports, entry.request, probe.sessionBinding);
				return true;
			});
		},
	);
}

async function reapLaunched(
	kernel: Kernel,
	ports: DagPorts,
	entry: RecoverableClaim,
): Promise<boolean> {
	const launchedAt = entry.claim.data.launch_receipt?.launched_at;
	if (
		!launchedAt ||
		Date.parse(launchedAt) + LAUNCH_REAP_GRACE_MS > ports.clock.nowMs()
	) {
		return false;
	}
	return await ports.locks.withSessionLock(
		entry.request.sessionRef,
		async () => {
			const probe = await ports.process.probe(entry.request.sessionRef);
			if (probe.state !== "absent") return false;
			const payload = kernel.read((tx) => {
				const task = tx.get<{ payload: string }>(
					"SELECT payload FROM tasks WHERE id=@taskId",
					{ taskId: entry.request.taskId },
				);
				return task ? parseTaskPayload(JSON.parse(task.payload)) : null;
			});
			let writerPacket:
				| {
						worktreeId: string;
						head: string;
						revision: number;
				  }
				| undefined;
			if (payload?.writes_repo && payload.worktree_id) {
				const snapshot = kernel.read((tx) => {
					const worktree = readEnvelope<{
						worktree_path: string;
						repo_identity: string;
						branch_ref: string;
					}>(tx, `canonical_worktree:${payload.worktree_id}`);
					const writer = readEnvelope<WriterChainData>(
						tx,
						`writer_chain:${payload.worktree_id}`,
					);
					return worktree && writer
						? {
								path: worktree.data.worktree_path,
								repoIdentity: worktree.data.repo_identity,
								branchRef: worktree.data.branch_ref,
								revision: writer.revision,
								startHead: writer.data.open_attempt?.start_head,
							}
						: null;
				});
				if (!snapshot?.startHead) return false;
				let observedFromWorktree = await ports.worktreeRef.worktreePresent(
					snapshot.path,
				);
				let head: string | null = null;
				if (observedFromWorktree) {
					try {
						head = await ports.git.readHead(snapshot.path);
					} catch {
						observedFromWorktree = false;
					}
				}
				if (!observedFromWorktree) {
					head = await ports.worktreeRef.readExactRef(
						snapshot.repoIdentity,
						snapshot.branchRef,
					);
				}
				if (head === null) return false;
				if (
					observedFromWorktree &&
					!(await ports.git.isAncestor(snapshot.path, snapshot.startHead, head))
				) {
					return false;
				}
				writerPacket = {
					worktreeId: payload.worktree_id,
					head,
					revision: snapshot.revision,
				};
			}
			return kernel.write("v2dag.launch.reap", (tx) => {
				const epoch = readCutoverEpoch(tx);
				const key = `launch_claim:${entry.request.sessionRef}`;
				const claim = readEnvelope<LaunchClaimData>(tx, key, epoch);
				if (
					!claim ||
					claim.revision !== entry.claim.revision ||
					claim.data.state !== "launched"
				) {
					return false;
				}
				updateEnvelope(
					tx,
					key,
					claim,
					{ ...claim.data, state: "tombstoned" },
					ports.clock.nowIso(),
				);
				tx.cas(FENCE.activationCasActiveTerminal, {
					activationId: entry.request.activationId,
				});
				tx.cas(FENCE.attemptCasActiveTerminal, {
					attemptId: entry.request.attemptId,
					reason: "failed",
					terminalAt: ports.clock.nowIso(),
				});
				tx.cas(
					`UPDATE tasks SET state='ready',state_version=state_version+1,
				 terminal_at=NULL WHERE id=@taskId AND state='running'`,
					{ taskId: entry.request.taskId },
				);
				const bindingKey = `agent_binding:${entry.request.agent.agentId}`;
				const binding = readEnvelope<AgentBindingData>(tx, bindingKey, epoch);
				if (
					!binding ||
					binding.data.activation_id !== entry.request.activationId ||
					binding.data.attempt_id !== entry.request.attemptId
				) {
					throw new Error("reap binding changed");
				}
				updateEnvelope(
					tx,
					bindingKey,
					binding,
					{
						state: "clear",
						activation_id: null,
						attempt_id: null,
						session_ref_current: null,
						session_ref_last: entry.request.sessionRef,
						host_epoch: null,
					},
					ports.clock.nowIso(),
				);
				if (writerPacket && payload?.worktree_id) {
					const writerKey = `writer_chain:${payload.worktree_id}`;
					const writer = readEnvelope<WriterChainData>(tx, writerKey, epoch);
					const span = readEnvelope<{
						head: string;
						updated_by_attempt: string | null;
					}>(tx, `span_tip:${payload.worktree_id}`, epoch);
					if (
						!writer ||
						!span ||
						writer.revision !== writerPacket.revision ||
						writer.data.open_attempt?.attempt_id !== entry.request.attemptId
					) {
						throw new Error("reap writer packet changed");
					}
					updateEnvelope(
						tx,
						writerKey,
						writer,
						{
							...writer.data,
							chain_head: writerPacket.head,
							open_attempt: null,
							span_author_set: [
								...new Set([
									...writer.data.span_author_set,
									...(writerPacket.head === writer.data.open_attempt.start_head
										? []
										: [writer.data.open_attempt.family]),
								]),
							].sort(),
						},
						ports.clock.nowIso(),
					);
				}
				appendEvent(tx, {
					eventUid: `attempt_reaped:${entry.request.attemptId}`,
					taskId: entry.request.taskId,
					attemptId: entry.request.attemptId,
					kind: "attempt_reaped",
					sourceKind: "launch_reconciler",
					sourceId: entry.request.sessionRef,
					payload: {
						session_ref: entry.request.sessionRef,
						confirmed_absent_at: probe.confirmedAt,
					},
					cutoverEpoch: epoch,
					createdAt: ports.clock.nowIso(),
				});
				return true;
			});
		},
	);
}

function recordRecoveryFailure(
	kernel: Kernel,
	ports: DagPorts,
	entry: RecoverableClaim,
	error: unknown,
	stage: Extract<
		DispatchFailureStage,
		"recovery_pending" | "recovery_claimed" | "recovery_reap"
	>,
): DispatchFailure {
	let candidate: CandidateRow | null = null;
	try {
		candidate = kernel.read(
			(tx) =>
				tx.get<CandidateRow>("SELECT id,payload FROM tasks WHERE id=@taskId", {
					taskId: entry.request.taskId,
				}) ?? null,
		);
	} catch {
		return { taskId: entry.request.taskId, stage, audited: false };
	}
	const audited =
		candidate === null
			? false
			: auditTaskFailureSafely(
					kernel,
					ports,
					candidate,
					error,
					"task_dispatch_invalid",
					stage,
				);
	return { taskId: entry.request.taskId, stage, audited };
}

export async function recoverPendingLaunches(
	kernel: Kernel,
	ports: DagPorts,
): Promise<{
	examined: number;
	launched: number;
	adopted: number;
	reaped: number;
	failures: DispatchFailure[];
}> {
	const entries = recoverableClaims(kernel);
	let launched = 0;
	let adopted = 0;
	let reaped = 0;
	const failures: DispatchFailure[] = [];
	for (const entry of entries) {
		let stage: Extract<
			DispatchFailureStage,
			"recovery_pending" | "recovery_claimed" | "recovery_reap"
		> = "recovery_pending";
		try {
			if (entry.claim.data.state === "pending") {
				const claimed = await claimLaunch(kernel, ports, entry.request);
				if (await launchOnce(kernel, ports, claimed)) launched += 1;
			} else if (entry.claim.data.state === "claimed") {
				stage = "recovery_claimed";
				const outcome = await recoverClaimed(kernel, ports, entry);
				if (
					outcome.status === "takeover" &&
					(await launchOnce(kernel, ports, outcome.request))
				) {
					launched += 1;
				}
				if (outcome.status === "adopted") adopted += 1;
			} else if (entry.claim.data.state === "launched") {
				stage = "recovery_reap";
				if (await adoptLaunchedRunner(kernel, ports, entry)) {
					adopted += 1;
				} else if (await reapLaunched(kernel, ports, entry)) {
					reaped += 1;
				}
			}
		} catch (error) {
			if (error instanceof InjectedFault) throw error;
			failures.push(recordRecoveryFailure(kernel, ports, entry, error, stage));
		}
	}
	return { examined: entries.length, launched, adopted, reaped, failures };
}

export type { RegisteredAgent, ExecutorDescriptor };
