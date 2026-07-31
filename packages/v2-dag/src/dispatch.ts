import { randomUUID } from "node:crypto";
import {
	type RegisteredAgent,
	type SessionBinding,
	serializeSessionBinding,
} from "flywheel-v2-engine";
import {
	type Kernel,
	type ReadTx,
	recordExternalEffectIntentTx,
	type WriteTx,
} from "flywheel-v2-kernel";
import { terminalizeAttemptTx } from "./attempt-terminal.js";
import { parseTaskPayload } from "./contract.js";
import { type CanonicalValue, sha256 } from "./digests.js";
import { DagContractError } from "./errors.js";
import { appendEvent } from "./events.js";
import { appendMailboxTx } from "./mailbox-append.js";
import {
	type Envelope,
	insertEnvelope,
	makeEnvelope,
	readCutoverEpoch,
	readEnvelope,
	updateEnvelope,
} from "./meta.js";
import { appendLifecycleTx } from "./outbox.js";
import type {
	DagPorts,
	DispatchFailure,
	DispatchResult,
	DispatchSkip,
	DispatchSkipReason,
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

interface LaunchClaimData {
	state: "pending" | "claimed" | "launched" | "tombstoned";
	owner_token: string | null;
	lease_until: string | null;
	launch_receipt: null | {
		token: string;
		activation_id: string;
		host_epoch: string;
		launched_at: string;
	};
}

interface RecoverableClaim {
	sessionRef: string;
	request: SpawnRequest | null;
	/** FLY-1556: null when the claim/task rows themselves cannot be parsed —
	 * the dirty row is reported as a named skip instead of aborting the whole
	 * recovery enumeration. */
	claim: Envelope<LaunchClaimData> | null;
	diagnostic?: string;
}

/** A recoverable entry whose claim AND request both parsed. */
type LiveRecoverableClaim = RecoverableClaim & {
	request: SpawnRequest;
	claim: Envelope<LaunchClaimData>;
};

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

type AuditKind =
	| "task_contract_invalid"
	| "task_dispatch_invalid"
	| "task_dispatch_skipped";

function appendFailureRecurrence(
	tx: WriteTx,
	input: {
		candidate: CandidateRow;
		diagnostic: string;
		epoch: number;
		eventUid: string;
		failureClass: string;
		kind: AuditKind;
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

function auditTaskSignal(
	kernel: Kernel,
	ports: DagPorts,
	candidate: CandidateRow,
	input: {
		kind: AuditKind;
		stage: string;
		failureClass: string;
		diagnostic: string;
	},
): boolean {
	return kernel.write(`v2dag.dispatch.${input.kind}`, (tx) => {
		const epoch = readCutoverEpoch(tx);
		const issueId = issueForTask(tx, candidate.id, epoch);
		const issue = issueId
			? readEnvelope<IssueData>(tx, `dag_issue:${issueId}`, epoch)
			: null;
		const payloadDigest = sha256(candidate.payload);
		const eventUid = `${input.kind}:${candidate.id}:${payloadDigest}:${input.stage}:${input.failureClass}`;
		if (
			tx.get("SELECT 1 FROM events WHERE event_uid=@eventUid", { eventUid })
		) {
			// The event ledger is the minimum visibility contract. If the issue
			// receipt itself is the broken invariant, there is no authoritative
			// Lead recipient for a mailbox notice, but the typed event remains
			// queryable with task id and reason.
			if (!issue) return true;
			// FLY-1503 item 5 / Codex R2-R4 (see appendFailureRecurrence): the event
			// ledger stays deduped by task+digest+stage+class while recurrence lives
			// in a durable aggregate. Steady-state repetition is one event plus a
			// counter; a changed reason is a new event.
			return appendFailureRecurrence(tx, {
				candidate,
				diagnostic: input.diagnostic,
				epoch,
				eventUid,
				failureClass: input.failureClass,
				kind: input.kind,
				notifyAgentId: issue.data.notify_agent_id,
				nowIso: ports.clock.nowIso(),
				payloadDigest,
				stage: input.stage,
			});
		}
		const payload = {
			task_id: candidate.id,
			payload_digest: payloadDigest,
			failure_stage: input.stage,
			error_class: input.failureClass,
			error: input.diagnostic,
		};
		appendEvent(tx, {
			eventUid,
			taskId: candidate.id,
			kind: input.kind,
			sourceKind: "dispatcher",
			sourceId: candidate.id,
			payload,
			cutoverEpoch: epoch,
			createdAt: ports.clock.nowIso(),
		});
		if (!issue) return true;
		appendMailboxTx(tx, {
			sourceKind: input.kind,
			sourceId: eventUid,
			toAgent: issue.data.notify_agent_id,
			kind: input.kind,
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
		return auditTaskSignal(kernel, ports, candidate, {
			kind,
			stage,
			failureClass: errorClass(error),
			diagnostic: error instanceof Error ? error.message : String(error),
		});
	} catch {
		return false;
	}
}

/**
 * FLY-1543 ⑥: a skip is a first-class, visible signal -- one typed event per
 * (task, reason) identity, recurrence-deduped through the same durable channel
 * as dispatch failures, so a 1s tick cannot grow the events table.
 */
function auditTaskSkipSafely(
	kernel: Kernel,
	ports: DagPorts,
	candidate: CandidateRow,
	reason: DispatchSkipReason,
): boolean {
	try {
		return auditTaskSignal(kernel, ports, candidate, {
			kind: "task_dispatch_skipped",
			stage: reason,
			failureClass: "skip",
			diagnostic: reason,
		});
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

function eligibility(
	tx: WriteTx,
	taskId: string,
): "eligible" | "ineligible_dependency" | "attempt_active" {
	const blocked = tx.get<{ count: number }>(
		`SELECT count(*) AS count
		   FROM task_dependencies d
		   JOIN tasks upstream ON upstream.id=d.blocked_by_task_id
		  WHERE d.task_id=@taskId AND upstream.state<>'done'`,
		{ taskId },
	)?.count;
	if ((blocked ?? 0) > 0) return "ineligible_dependency";
	const active = tx.get<{ count: number }>(
		`SELECT count(*) AS count FROM attempts
		  WHERE task_id=@taskId AND desired_state<>'terminal'`,
		{ taskId },
	)?.count;
	if ((active ?? 0) > 0) return "attempt_active";
	return "eligible";
}

type PreparedDispatch =
	| { prepared: SpawnRequest }
	| { skip: DispatchSkipReason };

function prepareDispatch(
	tx: WriteTx,
	ports: DagPorts,
	candidate: CandidateRow,
	head: string | null,
): PreparedDispatch {
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
	if (!task || task.state !== "ready") return { skip: "task_not_ready" };
	const eligible = eligibility(tx, candidate.id);
	if (eligible !== "eligible") return { skip: eligible };
	const epoch = readCutoverEpoch(tx);
	if (!issueForTask(tx, candidate.id, epoch)) {
		return { skip: "issue_receipt_missing" };
	}
	const payload = parseTaskPayload(JSON.parse(task.payload));

	let chain: Envelope<WriterChainData> | null = null;
	if (payload.writes_repo) {
		chain = readEnvelope<WriterChainData>(
			tx,
			`writer_chain:${payload.worktree_id}`,
			epoch,
		);
		if (!chain) return { skip: "worktree_receipt_missing" };
		// FLY-1543 ⑥: the writer chain remains the only per-worktree serializer
		// (same-worktree tasks stay strictly serial); the occupancy family died
		// with the badge system, so different worktrees now run in parallel even
		// under one roleId.
		if (chain.data.open_attempt !== null) return { skip: "writer_span_open" };
		// pending_gap is a ledger invariant guard: admission now refuses a dirty
		// worktree outright (⑥), so this is unreachable in a healthy ledger --
		// kept as double insurance, not as a fallback.
		if (chain.data.pending_gap !== null || head !== chain.data.chain_head) {
			return { skip: "writer_head_drift" };
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
	const agent = {
		kind: "runner" as const,
		agentId: sessionRef,
		instanceId: sessionRef,
		generation,
		activationId,
	};
	insertEnvelope(
		tx,
		`launch_claim:${sessionRef}`,
		makeEnvelope<LaunchClaimData>(epoch, {
			state: "pending",
			owner_token: null,
			lease_until: null,
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
	const request: SpawnRequest = {
		taskId: candidate.id,
		attemptId,
		attemptGeneration: generation,
		activationId,
		sessionRef,
		ownerToken: "",
		agent,
		// FLY-1544 ①: the instruction book hangs off the node kind.
		taskKind: task.kind,
		executor: payload.executor,
	};
	// FLY-1543 ④: the assignment row is written in the SAME transaction that
	// creates the activation, addressed to the session, so the launch path can
	// prepare the first delivery envelope BEFORE the tmux process exists and
	// embed it in the spawn prompt.
	appendTaskAssignmentTx(tx, ports, request);
	appendEvent(tx, {
		eventUid: `attempt_dispatched:${attemptId}`,
		taskId: candidate.id,
		attemptId,
		kind: "attempt_dispatched",
		sourceKind: "dispatcher",
		sourceId: attemptId,
		payload: {
			agent_id: sessionRef,
			instance_id: sessionRef,
			agent_generation: generation,
			activation_id: activationId,
			attempt_id: attemptId,
			session_ref: sessionRef,
			task_kind: task.kind,
			host_epoch: hostEpoch,
		},
		cutoverEpoch: epoch,
		createdAt: now,
	});
	// FLY-1544 ③: dispatch lands in the issue's Discord thread.
	appendLifecycleTx(tx, {
		sourceKind: "dag_task_dispatched",
		sourceId: attemptId,
		kind: "task_dispatched",
		issueId: task.external_issue_id,
		payload: {
			task_id: candidate.id,
			task_kind: task.kind,
			attempt_id: attemptId,
			session_ref: sessionRef,
		},
		cutoverEpoch: epoch,
		createdAt: now,
	});
	return { prepared: request };
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
		if (!claim || claim.data.state !== "pending") {
			return {
				claimed: false as const,
				diagnostic: claim
					? `launch claim for ${request.sessionRef} is ${claim.data.state}, not pending`
					: `launch claim for ${request.sessionRef} is missing`,
			};
		}
		const attempt = tx.get<{ desired_state: string }>(
			"SELECT desired_state FROM attempts WHERE id=@attemptId",
			{ attemptId: request.attemptId },
		);
		if (
			!attempt ||
			(attempt.desired_state !== "dispatched" &&
				attempt.desired_state !== "started")
		) {
			return {
				claimed: false as const,
				diagnostic: attempt
					? `attempt ${request.attemptId} is ${attempt.desired_state}, not dispatchable`
					: `attempt ${request.attemptId} is missing`,
			};
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
		return { claimed: true as const };
	});
	// FLY-1543 ⑥: the reason travels in the error, not a collapsed sentence.
	if (!claimed.claimed) throw new Error(claimed.diagnostic);
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
		// FLY-1543 ⑤: the envelope is addressed to the session, never to a role
		// name -- who holds a badge no longer decides who receives the work.
		toAgent: request.sessionRef,
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

export { appendTaskAssignmentTx };

/**
 * FLY-1543 ⑤: the spawned process is bound to its activation, not to an agents
 * row. Write-once CAS: a NULL binding takes the observed value, a byte-equal
 * replay is a no-op, a different value is a contract violation.
 */
function bindSpawnedRunnerTx(
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
	const row = tx.get<{
		state: string;
		generation: number;
		session_binding: string | null;
	}>(
		`SELECT state,generation,session_binding
		   FROM activations
		  WHERE id=@activationId AND session_ref=@sessionRef`,
		{ activationId: request.activationId, sessionRef: request.sessionRef },
	);
	if (
		!row ||
		row.state !== "active" ||
		row.generation !== request.attemptGeneration
	) {
		throw new DagContractError("spawned runner activation is not active");
	}
	const serialized = serializeSessionBinding(sessionBinding);
	if (row.session_binding === null) {
		tx.cas(
			`UPDATE activations SET session_binding=@sessionBinding
			  WHERE id=@activationId AND session_binding IS NULL AND state='active'`,
			{
				activationId: request.activationId,
				sessionBinding: serialized,
			},
		);
	} else if (row.session_binding !== serialized) {
		throw new DagContractError(
			"spawned runner session binding conflicts with the recorded one",
		);
	}
	return {
		kind: "runner",
		agentId: request.sessionRef,
		instanceId: request.sessionRef,
		generation: request.attemptGeneration,
		activationId: request.activationId,
		sessionBinding,
	};
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
			return bindSpawnedRunnerTx(tx, ports, request, sessionBinding);
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
	const skips: DispatchResult["skips"] = [];
	const recordSkip = (candidate: CandidateRow, reason: DispatchSkipReason) => {
		skips.push({ taskId: candidate.id, reason });
		auditTaskSkipSafely(kernel, ports, candidate, reason);
	};
	for (const candidate of candidates) {
		let outcome: PreparedDispatch;
		let failureStage: DispatchFailureStage = "task_payload";
		try {
			const payload = parseTaskPayload(JSON.parse(candidate.payload));
			let head: string | null = null;
			if (payload.writes_repo && payload.worktree_id) {
				failureStage = "worktree_lookup";
				const worktree = kernel.read((tx) =>
					readEnvelope<{ worktree_path: string }>(
						tx,
						`canonical_worktree:${payload.worktree_id}`,
					),
				);
				if (!worktree) {
					recordSkip(candidate, "worktree_receipt_missing");
					continue;
				}
				failureStage = "worktree_head";
				head = await ports.git.readHead(worktree.data.worktree_path);
			}
			failureStage = "prepare";
			outcome = kernel.write("v2dag.dispatch.prepare", (tx) =>
				prepareDispatch(tx, ports, candidate, head),
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
		if ("skip" in outcome) {
			recordSkip(candidate, outcome.skip);
			continue;
		}
		hitFault(ports, "dispatch_after_prepare");
		let claimed: SpawnRequest;
		try {
			claimed = await claimLaunch(kernel, ports, outcome.prepared);
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
			skips.push({ taskId: candidate.id, reason: "launch_claim_lost" });
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
		} else {
			// FLY-1543 ⑥: the claimed-but-unlaunched attempt is no longer an
			// implicit skip only recovery understands -- it is counted and audited.
			recordSkip(candidate, "launch_gate_lost");
		}
	}
	return { dispatched, failures, skips };
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
		kind: string;
		payload: string;
	}>(
		`SELECT a.task_id,a.id AS attempt_id,
		        a.generation AS attempt_generation,
		        act.id AS activation_id,
		        t.kind,
		        t.payload
		   FROM activations act
		   JOIN attempts a ON a.id=act.attempt_id
		   JOIN tasks t ON t.id=a.task_id
		  WHERE act.session_ref=@sessionRef
		    AND act.state='active'
		    AND a.desired_state IN ('dispatched','started')`,
		{ sessionRef },
	);
	if (!state) return null;
	const payload = parseTaskPayload(JSON.parse(state.payload));
	return {
		taskId: state.task_id,
		attemptId: state.attempt_id,
		attemptGeneration: state.attempt_generation,
		activationId: state.activation_id,
		sessionRef,
		ownerToken: "",
		agent: {
			kind: "runner",
			agentId: sessionRef,
			instanceId: sessionRef,
			generation: state.attempt_generation,
			activationId: state.activation_id,
		},
		taskKind: state.kind,
		executor: payload.executor,
	};
}

function recoverableClaims(kernel: Kernel): RecoverableClaim[] {
	return kernel.read((tx) => {
		const epoch = readCutoverEpoch(tx);
		const rows = tx.all<{ key: string }>(
			"SELECT key FROM meta WHERE key LIKE 'launch_claim:%' ORDER BY key",
		);
		return rows.flatMap((row): RecoverableClaim[] => {
			const sessionRef = row.key.slice("launch_claim:".length);
			// FLY-1556: one corrupt claim envelope or task payload used to throw
			// out of this read and abort the ENTIRE recovery pass — from there the
			// tick, and before the fault domains the whole engine process. A dirty
			// row is now that row's problem: named, skipped, everyone else recovers.
			try {
				const claim = readEnvelope<LaunchClaimData>(tx, row.key, epoch);
				if (!claim || claim.data.state === "tombstoned") return [];
				const request = requestForSession(tx, sessionRef);
				// FLY-1543 ⑥: an unrecoverable claim is reported, never silently
				// dropped from the recovery pass.
				return [{ sessionRef, request, claim }];
			} catch (error) {
				return [
					{
						sessionRef,
						request: null,
						claim: null,
						diagnostic: error instanceof Error ? error.message : String(error),
					},
				];
			}
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
		bindSpawnedRunnerTx(tx, ports, input.request, input.sessionBinding);
		return true;
	});
}

async function recoverClaimed(
	kernel: Kernel,
	ports: DagPorts,
	entry: LiveRecoverableClaim,
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
	entry: LiveRecoverableClaim,
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
				bindSpawnedRunnerTx(tx, ports, entry.request, probe.sessionBinding);
				return true;
			});
		},
	);
}

/**
 * FLY-1543 ⑥: the lost-open state (worktree AND branch ref both unreadable) is
 * the one that requires the Lead to run the `lost_open_attempt` ceremony. It
 * used to be a silent `false`; now the Lead is told, once per attempt, through
 * the mailbox (mirroring the writer-gap adoption notice shape).
 */
function notifyLostOpenCandidate(
	kernel: Kernel,
	ports: DagPorts,
	entry: LiveRecoverableClaim,
): void {
	kernel.write("v2dag.launch.lost-open-candidate", (tx) => {
		const epoch = readCutoverEpoch(tx);
		const issueId = issueForTask(tx, entry.request.taskId, epoch);
		if (!issueId) return;
		const issue = readEnvelope<IssueData>(tx, `dag_issue:${issueId}`, epoch);
		if (!issue) return;
		const eventUid = `attempt_lost_open_candidate:${entry.request.attemptId}`;
		const payload = {
			task_id: entry.request.taskId,
			attempt_id: entry.request.attemptId,
			session_ref: entry.request.sessionRef,
			reason: "worktree_and_ref_unrecoverable",
		};
		if (
			!tx.get("SELECT 1 FROM events WHERE event_uid=@eventUid", { eventUid })
		) {
			appendEvent(tx, {
				eventUid,
				taskId: entry.request.taskId,
				attemptId: entry.request.attemptId,
				kind: "attempt_lost_open_candidate",
				sourceKind: "launch_reconciler",
				sourceId: entry.request.sessionRef,
				payload,
				cutoverEpoch: epoch,
				createdAt: ports.clock.nowIso(),
			});
		}
		appendMailboxTx(tx, {
			sourceKind: "attempt_lost_open_candidate",
			sourceId: entry.request.attemptId,
			toAgent: issue.data.notify_agent_id,
			kind: "attempt_lost_open_candidate",
			payload,
			retentionClass: "business",
			cutoverEpoch: epoch,
			createdAt: ports.clock.nowIso(),
		});
	});
}

async function reapLaunched(
	kernel: Kernel,
	ports: DagPorts,
	entry: LiveRecoverableClaim,
): Promise<
	{ status: "reaped" } | { status: "skip"; reason: DispatchSkipReason }
> {
	const launchedAt = entry.claim.data.launch_receipt?.launched_at;
	if (
		!launchedAt ||
		Date.parse(launchedAt) + LAUNCH_REAP_GRACE_MS > ports.clock.nowMs()
	) {
		return { status: "skip", reason: "reap_grace" };
	}
	return await ports.locks.withSessionLock(
		entry.request.sessionRef,
		async () => {
			const probe = await ports.process.probe(entry.request.sessionRef);
			if (probe.state !== "absent") {
				return {
					status: "skip" as const,
					reason: "reap_process_present" as const,
				};
			}
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
				if (!snapshot?.startHead) {
					return {
						status: "skip" as const,
						reason: "reap_head_unreadable" as const,
					};
				}
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
				if (head === null) {
					notifyLostOpenCandidate(kernel, ports, entry);
					return {
						status: "skip" as const,
						reason: "reap_head_unreadable" as const,
					};
				}
				if (
					observedFromWorktree &&
					!(await ports.git.isAncestor(snapshot.path, snapshot.startHead, head))
				) {
					return {
						status: "skip" as const,
						reason: "reap_lineage_diverged" as const,
					};
				}
				writerPacket = {
					worktreeId: payload.worktree_id,
					head,
					revision: snapshot.revision,
				};
			}
			const reaped = kernel.write("v2dag.launch.reap", (tx) => {
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
				terminalizeAttemptTx(tx, {
					attemptId: entry.request.attemptId,
					reason: "failed",
					cutoverEpoch: epoch,
					nowIso: ports.clock.nowIso(),
				});
				// FLY-1556: only a still-running task goes back to ready. A task that
				// was canceled (or otherwise moved on) under its started attempt — the
				// zombie class from the 2026-07-30 incident — used to make this CAS
				// throw on zero changes, so the zombie attempt could NEVER be reaped
				// and recovery re-threw on it every tick.
				const taskState = tx.get<{ state: string }>(
					"SELECT state FROM tasks WHERE id=@taskId",
					{ taskId: entry.request.taskId },
				)?.state;
				if (taskState === "running") {
					tx.cas(
						`UPDATE tasks SET state='ready',state_version=state_version+1,
					 terminal_at=NULL WHERE id=@taskId AND state='running'`,
						{ taskId: entry.request.taskId },
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
			return reaped
				? { status: "reaped" as const }
				: {
						status: "skip" as const,
						reason: "recovery_claim_missing" as const,
					};
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
	const taskId = entry.request?.taskId ?? entry.sessionRef;
	let candidate: CandidateRow | null = null;
	try {
		candidate = kernel.read(
			(tx) =>
				tx.get<CandidateRow>("SELECT id,payload FROM tasks WHERE id=@taskId", {
					taskId,
				}) ?? null,
		);
	} catch {
		return { taskId, stage, audited: false };
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
	return { taskId, stage, audited };
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
	skips: DispatchSkip[];
}> {
	const entries = recoverableClaims(kernel);
	let launched = 0;
	let adopted = 0;
	let reaped = 0;
	const failures: DispatchFailure[] = [];
	const skips: DispatchSkip[] = [];
	for (const entry of entries) {
		if (entry.claim === null) {
			// FLY-1556: the claim (or its task lineage) is unparseable dirty data.
			// Named residue, same as the unrecoverable-request case — never a
			// thrown enumeration.
			skips.push({ taskId: null, reason: "recovery_claim_unreadable" });
			continue;
		}
		if (entry.request === null) {
			// FLY-1543 ⑥: the claim exists but no active dispatchable attempt backs
			// it -- previously an invisible drop, now a named residue.
			skips.push({ taskId: null, reason: "recovery_request_unrecoverable" });
			continue;
		}
		const recoverable = {
			...entry,
			request: entry.request,
			claim: entry.claim,
		};
		let stage: Extract<
			DispatchFailureStage,
			"recovery_pending" | "recovery_claimed" | "recovery_reap"
		> = "recovery_pending";
		try {
			if (entry.claim.data.state === "pending") {
				const claimed = await claimLaunch(kernel, ports, recoverable.request);
				if (await launchOnce(kernel, ports, claimed)) {
					launched += 1;
				} else {
					skips.push({
						taskId: recoverable.request.taskId,
						reason: "launch_gate_lost",
					});
				}
			} else if (entry.claim.data.state === "claimed") {
				stage = "recovery_claimed";
				const outcome = await recoverClaimed(kernel, ports, recoverable);
				if (outcome.status === "takeover") {
					if (await launchOnce(kernel, ports, outcome.request)) {
						launched += 1;
					} else {
						skips.push({
							taskId: recoverable.request.taskId,
							reason: "launch_gate_lost",
						});
					}
				} else if (outcome.status === "adopted") {
					adopted += 1;
				} else {
					skips.push({
						taskId: recoverable.request.taskId,
						reason: "launch_claim_lost",
					});
				}
			} else if (entry.claim.data.state === "launched") {
				stage = "recovery_reap";
				if (await adoptLaunchedRunner(kernel, ports, recoverable)) {
					adopted += 1;
				} else {
					const outcome = await reapLaunched(kernel, ports, recoverable);
					if (outcome.status === "reaped") {
						reaped += 1;
					} else {
						skips.push({
							taskId: recoverable.request.taskId,
							reason: outcome.reason,
						});
					}
				}
			}
		} catch (error) {
			if (error instanceof InjectedFault) throw error;
			failures.push(recordRecoveryFailure(kernel, ports, entry, error, stage));
		}
	}
	return {
		examined: entries.length,
		launched,
		adopted,
		reaped,
		failures,
		skips,
	};
}

export type { RegisteredAgent, ExecutorDescriptor };
