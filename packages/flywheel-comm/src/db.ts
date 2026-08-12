import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readSync,
	statSync,
} from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import {
	canonicalJsonString,
	canonicalSubmissionDigest,
} from "flywheel-config";
import { founderMessageRootId } from "./founder-reply-routing.js";
import {
	assertProcessedEvidence,
	assertUtcIsoTimestamp,
	CHAT_DELIVERY_UNCONFIRMED_REASON,
	ensureMailboxQueueSchema,
	MailboxQueue,
	type MailboxRow,
	type ProcessedEvidenceV1,
} from "./mailbox-queue.js";
import {
	MAILBOX_POISON_VIEWS,
	MAILBOX_SCHEMA,
	MAILBOX_SCHEMA_GENERATION,
} from "./mailbox-schema.js";
import { encodeSenderRef } from "./sender-ref.js";
import type {
	Message,
	MessageProvenance,
	ResponseWriteResult,
	Session,
} from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  execution_id  TEXT PRIMARY KEY,
  tmux_window   TEXT NOT NULL,
  project_name  TEXT NOT NULL,
  issue_id      TEXT,
  lead_id       TEXT,
  started_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  ended_at      DATETIME,
  status        TEXT DEFAULT 'running' CHECK(status IN ('running','completed','timeout','blocked','failed'))
);
CREATE TABLE IF NOT EXISTS session_receipt_lineage (
  execution_id  TEXT PRIMARY KEY,
  project_name  TEXT NOT NULL,
  issue_id      TEXT,
  lead_id       TEXT
);
CREATE TABLE IF NOT EXISTS runner_declared_states (
  execution_id  TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK(kind IN ('parked','long_task')),
  reason        TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER,
  updated_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS three_stage_turn (
  issue_id        TEXT PRIMARY KEY,
  holder_exec_id  TEXT NOT NULL,
  phase           TEXT NOT NULL,
  epoch           INTEGER NOT NULL,
  granted_at      INTEGER NOT NULL,
  target_run_id   TEXT,
  target_node_id  TEXT,
  target_attempt  INTEGER,
  activation_id   TEXT
);
CREATE TABLE IF NOT EXISTS turn_wait_ledger (
  execution_id       TEXT NOT NULL,
  holder_exec_id     TEXT NOT NULL,
  epoch              INTEGER NOT NULL CHECK(epoch > 0),
  first_seen_at      INTEGER NOT NULL,
  asked_at           INTEGER,
  question_id        TEXT,
  last_error         TEXT,
  no_turn_streak     INTEGER NOT NULL DEFAULT 0,
  last_no_turn_at    INTEGER,
  PRIMARY KEY (execution_id, holder_exec_id, epoch)
);
CREATE TABLE IF NOT EXISTS turn_wake_outbox (
  wake_id           TEXT PRIMARY KEY,
  execution_id      TEXT NOT NULL,
  issue_id          TEXT NOT NULL,
  epoch             INTEGER NOT NULL CHECK(epoch > 0),
  activation_id     TEXT,
  purpose           TEXT NOT NULL,
  envelope_json     TEXT NOT NULL,
  backend           TEXT NOT NULL,
  state             TEXT NOT NULL DEFAULT 'pending'
                    CHECK(state IN ('pending','sent','acked','cancelled')),
  push_count        INTEGER NOT NULL DEFAULT 0 CHECK(push_count BETWEEN 0 AND 2),
  first_push_at     INTEGER,
  last_push_at      INTEGER,
  last_push_result  TEXT,
  claim_token       TEXT,
  claim_expires_at  INTEGER,
  acked_at          INTEGER,
	  receipt_projected_at INTEGER,
  cancel_reason     TEXT,
  episode_id        TEXT NOT NULL,
  alerted_at        INTEGER,
  alert_question_id TEXT,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turn_wake_due
  ON turn_wake_outbox(state, push_count, last_push_at, claim_expires_at);
CREATE TABLE IF NOT EXISTS runner_workflow_activation (
  execution_id          TEXT NOT NULL,
  epoch                 INTEGER NOT NULL,
  activation_id         TEXT NOT NULL,
  run_id                TEXT NOT NULL,
  node_id               TEXT NOT NULL,
  attempt               INTEGER NOT NULL CHECK(attempt > 0),
  output_credential     TEXT,
  submission_credential TEXT,
  context_json          TEXT NOT NULL,
  context_digest        TEXT NOT NULL,
  created_at            INTEGER NOT NULL,
  PRIMARY KEY (execution_id, epoch)
);
CREATE TABLE IF NOT EXISTS workflow_source_event (
  project             TEXT NOT NULL,
  source_event_id     TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK(kind IN ('founder_approval','founder_feedback','turn_grant')),
  payload             TEXT NOT NULL,
  payload_digest      TEXT NOT NULL,
  schema_version      INTEGER NOT NULL,
  at                  TEXT NOT NULL,
  PRIMARY KEY (project, source_event_id)
);
CREATE TABLE IF NOT EXISTS turn_source_history (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id            TEXT NOT NULL,
  from_role           TEXT,
  to_role             TEXT NOT NULL,
  epoch               INTEGER NOT NULL,
  target_run_id       TEXT,
  source_event_id     TEXT NOT NULL UNIQUE,
  at                  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runner_phase_wakes (
  queue_seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id          TEXT NOT NULL,
  message_id            TEXT NOT NULL,
  content               TEXT NOT NULL,
  metadata_json         TEXT,
  source_instruction_id TEXT,
  state                  TEXT NOT NULL CHECK(state IN ('pending','started','finished')),
  queued_at              INTEGER NOT NULL,
  started_at             INTEGER,
  finished_at            INTEGER,
	admission_state         TEXT,
	envelope_json           TEXT,
	push_attempts           INTEGER NOT NULL DEFAULT 0,
	last_push_at            TEXT,
	last_push_result        TEXT,
	claim_token             TEXT,
	claim_expires_at        TEXT,
	t2_claimed_at           TEXT,
	t2_result               TEXT,
	escalation_outbox_id    TEXT,
	started_ack_scope       TEXT,
	purpose                 TEXT CHECK(purpose IN ('message_traffic','gate_response','park_wake')),
  UNIQUE (execution_id, message_id)
);
CREATE TABLE IF NOT EXISTS runner_wake_failure_episode (
  execution_id                 TEXT NOT NULL,
  category                     TEXT NOT NULL CHECK(category IN ('terminal','no_receipt')),
  generation                   INTEGER NOT NULL CHECK(generation > 0),
  terminal_lifecycle_id        TEXT,
  opened_at                    TEXT NOT NULL,
  closed_at                    TEXT,
  last_message_id              TEXT NOT NULL,
  PRIMARY KEY (execution_id, category, generation)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runner_wake_failure_episode_open
  ON runner_wake_failure_episode(execution_id, category)
  WHERE closed_at IS NULL;
CREATE TABLE IF NOT EXISTS workflow_engine_park (
  execution_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  activation_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('open','cleared')),
  reason TEXT NOT NULL,
  source_row_id INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_engine_park_cursor (
  project TEXT PRIMARY KEY,
  last_row_id INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runner_shutdown_controls (
  execution_id TEXT PRIMARY KEY,
  request_id   TEXT NOT NULL UNIQUE,
  state        TEXT NOT NULL CHECK(state IN ('requested','acked','failed')),
  requested_at INTEGER NOT NULL,
  finished_at  INTEGER,
  error        TEXT
);
CREATE TRIGGER IF NOT EXISTS workflow_source_event_no_update
BEFORE UPDATE ON workflow_source_event
BEGIN SELECT RAISE(ABORT, 'workflow_source_event is append-only'); END;
CREATE TRIGGER IF NOT EXISTS workflow_source_event_no_delete
BEFORE DELETE ON workflow_source_event
BEGIN SELECT RAISE(ABORT, 'workflow_source_event is append-only'); END;
CREATE TRIGGER IF NOT EXISTS turn_source_history_no_update
BEFORE UPDATE ON turn_source_history
BEGIN SELECT RAISE(ABORT, 'turn_source_history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS turn_source_history_no_delete
BEFORE DELETE ON turn_source_history
BEGIN SELECT RAISE(ABORT, 'turn_source_history is append-only'); END;
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_name);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runner_phase_wakes_source
  ON runner_phase_wakes(execution_id, source_instruction_id)
  WHERE source_instruction_id IS NOT NULL;
${MAILBOX_SCHEMA}
`;

/**
 * FLY-626: a runner's self-declared liveness intent. `parked` = done-but-alive
 * (idle by design, kept for iteration; may be indefinite — `expires_at` null).
 * `long_task` = actively working on something that legitimately produces no pane
 * activity for a while (codex review, big build) — always bounded by `expires_at`.
 * Timestamps are epoch milliseconds (Codex R2 LOW #3).
 */
export interface RunnerDeclaredState {
	execution_id: string;
	kind: "parked" | "long_task";
	reason: string | null;
	created_at: number;
	expires_at: number | null;
	updated_at: number;
}

export interface SessionReceiptIdentity {
	execution_id: string;
	project_name: string;
	issue_id: string | null;
	lead_id: string | null;
}

export interface PendingRunnerQuestion {
	id: string;
	checkpoint: string | null;
}

/**
 * FLY-887: the three-stage TURN — which phase-session (identified by its
 * `holder_exec_id`) currently holds the exclusive right to touch the shared
 * worktree for `issue_id`. `epoch` monotonically increases on every re-grant so
 * a late/duplicated wake carrying a stale epoch can be recognized as such. Only
 * the Bridge writes this table (`grantTurn`); runners read it (`getTurn` via the
 * `turn` subcommand) before writing. Timestamps are epoch milliseconds.
 */
export interface ThreeStageTurn {
	issue_id: string;
	holder_exec_id: string;
	phase: string;
	epoch: number;
	granted_at: number;
	target_run_id: string | null;
	target_node_id: string | null;
	target_attempt: number | null;
	activation_id: string | null;
}

export interface RunnerWorkflowActivation {
	execution_id: string;
	epoch: number;
	activation_id: string;
	run_id: string;
	node_id: string;
	attempt: number;
	output_credential: string | null;
	submission_credential: string | null;
	context_json: string;
	context_digest: string;
	created_at: number;
}

export interface TurnWakeOutboxRow {
	wake_id: string;
	execution_id: string;
	issue_id: string;
	epoch: number;
	activation_id: string | null;
	purpose: string;
	envelope_json: string;
	backend: string;
	state: "pending" | "sent" | "acked" | "cancelled";
	push_count: number;
	first_push_at: number | null;
	last_push_at: number | null;
	last_push_result: string | null;
	claim_token: string | null;
	claim_expires_at: number | null;
	acked_at: number | null;
	receipt_projected_at: number | null;
	cancel_reason: string | null;
	episode_id: string;
	alerted_at: number | null;
	alert_question_id: string | null;
	created_at: number;
}

/** Lightweight indexed row used by the Bridge issue-gate supersede patrol. */
export interface GateSupersedeRow {
	row_id: number;
	id: string;
	from_agent: string;
	checkpoint: "approve_to_ship" | "review_design" | "review_code";
	created_at: string;
	superseded_at: string | null;
	superseded_by: string | null;
	answered: 0 | 1;
	pending: 0 | 1;
}

export interface FinalizeSessionResult {
	/** FLY-1238: checkpoint gates retired by this teardown. Gate count only. */
	retiredQuestionCount: number;
	/**
	 * FLY-1328: checkpoint-less asks (incl. `--report`) cascade-retired by this
	 * teardown. Required, not optional: `CommDB.finalizeSession` is the single
	 * authoritative producer of this type, so requiring the field makes any
	 * consumer that forgets to carry the count a compile error rather than a
	 * silent zero. Always 0 when FLYWHEEL_ASK_HYGIENE=0 — the DB path reverts,
	 * and the authority result reports that truthfully.
	 */
	retiredAskCount: number;
	deletedSessionCount: number;
}

export type GuardedFinalizeSessionResult =
	| { finalized: false; reason: "turn_holder" }
	| { finalized: false; reason: "target_changed" }
	| { finalized: true; result: FinalizeSessionResult };

function commDbProtectionEnabled(): boolean {
	return process.env.FLYWHEEL_COMMDB_PROTECTION !== "0";
}

/**
 * FLY-1328 kill-switch (default ON). OFF restores the pre-FLY-1328 byte path on
 * both sides of the cascade: no ask retirement, and no `resolved_via` stamp on
 * the gate rows either. Shared export — `db.ts` (A1 cascade) and the teamlead
 * patrol (A2 sweep) must never disagree about whether the feature is live.
 */
export function askHygieneEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return env.FLYWHEEL_ASK_HYGIENE !== "0";
}

/**
 * FLY-1328: an ask younger than this at teardown is spared. It kills the
 * "written → first relay tick" race: GatePoller relays every ~3s, so a
 * last-moment `ask --report` is durably in `lead_events` long before the window
 * lapses. This is a grace period, not a guarantee — a per-lead circuit stuck
 * open (or a StateStore outage) for longer than this can still swallow a late
 * ask. That exception is accepted and documented, not papered over.
 */
const ASK_CASCADE_GRACE_SQL = "-15 minutes";

/**
 * FLY-1328: with protection ON, a cascade-retired ask leaves `pending` via
 * relay_state immediately but its row lingers this long so an hours-scale
 * forensic query can still see who disposed of it and why. Day-scale forensics
 * live in the StateStore audit event instead. With protection OFF, legacy
 * pending filters on `expires_at > now`, so the row must expire on the spot.
 */
const ASK_FORENSIC_TTL_SQL = "+1 hour";

export interface WorkflowSourceEvent {
	project: string;
	source_event_id: string;
	kind: "founder_approval" | "founder_feedback" | "turn_grant";
	payload: string;
	payload_digest: string;
	schema_version: number;
	at: string;
}

export interface TurnSourceHistory {
	id: number;
	issue_id: string;
	from_role: string | null;
	to_role: string;
	epoch: number;
	target_run_id: string | null;
	source_event_id: string;
	at: string;
}

export interface PhaseWakeInput {
	id: string;
	to: string;
	content: string;
	metadata?: Record<string, unknown>;
}

export interface RunnerPhaseWake {
	queue_seq: number;
	execution_id: string;
	message_id: string;
	content: string;
	metadata_json: string | null;
	source_instruction_id: string | null;
	state: "pending" | "started" | "finished";
	queued_at: number;
	started_at: number | null;
	finished_at: number | null;
	admission_state:
		| "queued"
		| "duplicate"
		| "suppressed_cap"
		| "skipped_no_transport"
		| null;
	envelope_json: string | null;
	push_attempts: number;
	last_push_at: string | null;
	last_push_result: string | null;
	claim_token: string | null;
	claim_expires_at: string | null;
	t2_claimed_at: string | null;
	t2_result: string | null;
	escalation_outbox_id: string | null;
	started_ack_scope:
		| "exec_cli"
		| "message"
		| "debug_override"
		| "normal_traffic"
		| "terminal"
		| null;
	purpose: "message_traffic" | "gate_response" | "park_wake" | null;
}

export interface RunnerWakeFailureEpisode {
	execution_id: string;
	category: "terminal" | "no_receipt";
	generation: number;
	terminal_lifecycle_id: string | null;
	opened_at: string;
	closed_at: string | null;
	last_message_id: string;
}

export interface TerminalWakeCompletion {
	wake: RunnerPhaseWake;
	alert: ReceiptAlertOutboxRow;
	identityKind: "terminal_episode" | "founder_message";
	episodeFingerprint: string;
}

export interface ReceiptAlertOutboxRow {
	id: string;
	kind: string;
	payload: string;
	created_at: string;
	delivered_at: string | null;
	canceled_at: string | null;
	cancel_reason: string | null;
}

function runnerWakeMetadata(wake: RunnerPhaseWake): Record<string, unknown> {
	let stored: Record<string, unknown> = {};
	if (wake.metadata_json) {
		try {
			const parsed = JSON.parse(wake.metadata_json) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				stored = parsed as Record<string, unknown>;
			}
		} catch {
			// Malformed metadata never confers founder authority.
		}
	}
	if (!wake.envelope_json) return stored;
	try {
		const parsed = JSON.parse(wake.envelope_json) as {
			metadata?: unknown;
		};
		if (
			parsed.metadata &&
			typeof parsed.metadata === "object" &&
			!Array.isArray(parsed.metadata)
		) {
			return {
				...stored,
				...(parsed.metadata as Record<string, unknown>),
			};
		}
	} catch {
		// Fall back to the independently persisted metadata_json.
	}
	return stored;
}

export interface RunnerReceiptWakePushClaim {
	wake: RunnerPhaseWake;
	claimToken: string;
	attempt: number;
	envelope: PhaseWakeInput;
}

export interface RespondAndReceiptInput {
	questionId: string;
	fromAgent: string;
	content: string;
	rootId: string;
	evidence: Omit<ProcessedEvidenceV1, "ref">;
	now: string;
	provenance?: MessageProvenance;
}

export interface RespondAndReceiptResult {
	responseId: string;
}

export interface ReviewResponseInput {
	questionId: string;
	fromAgent: string;
	content: string;
	expectedOwner: string;
	expectedCheckpoint: "review_design" | "review_code";
}

export type ReceiptHandleAction = "relay" | "respond" | "no-route" | "ack";

export interface HandleReceiptInput {
	requestId: string;
	receiptId: string;
	authenticatedLead: string;
	action: ReceiptHandleAction;
	now: string;
	provenance: MessageProvenance;
	targetQuestionId?: string;
	content?: string;
	reason?: string;
	/** Test-only transaction seam injection. */
	testCrashAfter?: "effect" | "terminal";
}

export interface HandleReceiptResult {
	kind: "handled";
	receiptId: string;
	action: ReceiptHandleAction;
	responseId?: string;
}

export interface TrustedFounderApprovalAndReceiptInput {
	project: string;
	sourceEventId: string;
	questionId: string;
	fromAgent: string;
	content: string;
	expectedOwner: string;
	payload: unknown;
	rootId: string;
	evidence: Omit<ProcessedEvidenceV1, "ref">;
	now: string;
	provenance?: MessageProvenance;
}

export interface TrustedFounderGateResponseAndReceiptInput {
	questionId: string;
	fromAgent: string;
	content: string;
	expectedOwner: string;
	rootId: string;
	msgId: string;
	now: string;
	approvalSource?: {
		project: string;
		sourceEventId: string;
		payload: unknown;
	};
}

export interface RouteFounderReplyInput {
	msgId: string;
	leadId: string;
	toQuestionId?: string;
	noRouteReason?: string;
	now: string;
	provenance?: MessageProvenance;
}

export interface EnqueueFounderHubRootInput {
	id: string;
	toLead: string;
	content: string;
	refMessageId: string;
	now: string;
	nextUnprocessedAt?: string | null;
	routingState?: string | null;
}

export type RouteFounderReplyResult =
	| {
			kind: "routed";
			questionId: string;
			responseId: string;
	  }
	| {
			kind: "stale_candidate";
			questionId: string;
			winningResponseId: string;
	  }
	| { kind: "no_route"; winningResponseId?: string };

export interface RunnerShutdownControl {
	execution_id: string;
	request_id: string;
	state: "requested" | "acked" | "failed";
	requested_at: number;
	finished_at: number | null;
	error: string | null;
}

export interface WorkflowEngineParkProjectionEvent {
	row_id: number;
	event_id: string;
	execution_id: string;
	run_id: string;
	node_id: string;
	attempt: number;
	activation_id: string;
	generation: number;
	event: "park_opened" | "park_cleared";
	reason: string;
	created_at: string;
}

export interface WorkflowEngineParkProjection {
	execution_id: string;
	run_id: string;
	node_id: string;
	attempt: number;
	activation_id: string;
	generation: number;
	state: "open" | "cleared";
	reason: string;
	source_row_id: number;
	updated_at: string;
}

const TERMINAL_RECEIPT_DISPOSAL_KINDS = new Set([
	"terminal_subject_settlement",
	"superseded_session_terminal",
	"superseded_issue_done",
	"superseded_merged",
]);

function isEquivalentTerminalReceiptDisposal(
	raw: string,
	receiptId: string,
	sourceQuestionId: string,
	expectedExecutionId: string,
): boolean {
	try {
		const evidence = JSON.parse(raw) as ProcessedEvidenceV1;
		assertProcessedEvidence(evidence);
		if (
			!TERMINAL_RECEIPT_DISPOSAL_KINDS.has(evidence.kind) ||
			evidence.actor !== "terminal-receipt-projector" ||
			evidence.actor_kind !== "bridge-protocol"
		) {
			return false;
		}
		if (evidence.kind === "terminal_subject_settlement") {
			return (
				evidence.ref === receiptId &&
				evidence.fence.execution_id === expectedExecutionId
			);
		}
		return (
			evidence.ref === sourceQuestionId &&
			evidence.fence.question_id === sourceQuestionId
		);
	} catch {
		return false;
	}
}

function isMissingTableError(error: unknown, table: string): boolean {
	return (
		error instanceof Error &&
		new RegExp(`no such table: (?:main\\.)?${table}`, "i").test(error.message)
	);
}

class MailboxGenerationError extends Error {}

type CommDbOpenPhase =
	| "mkdir"
	| "database-open"
	| "pragma"
	| "virgin-probe"
	| "generation-assert"
	| "schema"
	| "migrations"
	| "purge";

function permissionDiagnostics(error: Error, dbPath: string): string {
	const code = (error as Error & { code?: unknown }).code;
	if (code !== "SQLITE_READONLY" && !/readonly|EACCES/i.test(error.message)) {
		return "";
	}
	try {
		const details: string[] = [];
		const remediation: string[] = [];
		for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
			if (!existsSync(path)) {
				details.push(`${path} missing`);
				continue;
			}
			const mode = statSync(path).mode & 0o777;
			details.push(`${path} mode=${mode.toString(8).padStart(4, "0")}`);
			if ((mode & 0o200) === 0) remediation.push(`chmod 0600 ${path}`);
		}
		const fix =
			remediation.length > 0 ? `; remediation: ${remediation.join("; ")}` : "";
		return `; permissions: ${details.join(", ")}${fix}`;
	} catch {
		return "";
	}
}

function augmentCommDbOpenError(
	error: unknown,
	dbPath: string,
	phase: CommDbOpenPhase,
): never {
	if (error instanceof MailboxGenerationError) throw error;
	if (error instanceof Error) {
		const originalMessage = error.message;
		error.message = `CommDB open failed at ${dbPath} (phase: ${phase}): ${originalMessage}${permissionDiagnostics(error, dbPath)}`;
	}
	throw error;
}

function closeAfterOpenFailure(db: Database.Database | undefined): void {
	if (!db) return;
	try {
		db.close();
	} catch {
		// Preserve the open failure; a close failure cannot make it more actionable.
	}
}

function assertMailboxGeneration(db: Database.Database, dbPath: string): void {
	const metaTable = db
		.prepare(
			"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mailbox_migration_meta'",
		)
		.get();
	if (!metaTable) {
		throw new MailboxGenerationError(
			`Legacy or partial CommDB at ${dbPath}; run the FLY-1572 mailbox migration before opening it`,
		);
	}
	const meta = db
		.prepare(
			"SELECT schema_generation FROM mailbox_migration_meta WHERE singleton = 1",
		)
		.get() as { schema_generation?: string } | undefined;
	if (meta?.schema_generation !== MAILBOX_SCHEMA_GENERATION) {
		throw new MailboxGenerationError(
			`Unsupported CommDB schema generation at ${dbPath}: ${meta?.schema_generation ?? "missing"}`,
		);
	}
	if (
		!db
			.prepare(
				"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mailbox'",
			)
			.get()
	) {
		throw new MailboxGenerationError(
			`Partial mailbox schema at ${dbPath}: mailbox table missing`,
		);
	}
}

export type MailboxMaintenanceOpenResult =
	| { status: "opened"; db: Database.Database }
	| { status: "skipped"; reason: "missing" | "legacy"; warning: string };

const MAILBOX_ADOPTION_COLUMNS = [
	"recipient_kind",
	"to_agent",
	"carrier",
	"state",
	"batch_id",
	"lease_retry_count",
	"claimed_by",
	"claim_expires_at",
	"delivered_at",
	"next_retry_at",
	"last_error",
] as const;

/** FLY-1708: open the live mailbox without creating, migrating, or purging it. */
export function openMailboxMaintenanceDatabase(
	dbPath: string,
): MailboxMaintenanceOpenResult {
	if (!existsSync(dbPath)) {
		return {
			status: "skipped",
			reason: "missing",
			warning: `mailbox database is missing: ${dbPath}`,
		};
	}
	const header = Buffer.alloc(20);
	const fd = openSync(dbPath, "r");
	let bytesRead: number;
	try {
		bytesRead = readSync(fd, header, 0, header.length, 0);
	} finally {
		closeSync(fd);
	}
	const isWal =
		bytesRead === header.length &&
		header.subarray(0, 16).equals(Buffer.from("SQLite format 3\0")) &&
		header[18] === 2 &&
		header[19] === 2;
	if (!isWal) {
		return {
			status: "skipped",
			reason: "legacy",
			warning: `legacy or non-WAL mailbox database was not opened: ${dbPath}`,
		};
	}

	let db: Database.Database | undefined;
	try {
		db = new Database(dbPath, { fileMustExist: true });
		db.pragma("busy_timeout = 5000");
		db.pragma("query_only = 1");
		assertMailboxGeneration(db, dbPath);
		const columns = new Set(
			(
				db.prepare("PRAGMA table_info(mailbox)").all() as Array<{
					name: string;
				}>
			).map(({ name }) => name),
		);
		const missing = MAILBOX_ADOPTION_COLUMNS.filter(
			(name) => !columns.has(name),
		);
		if (missing.length > 0) {
			throw new MailboxGenerationError(
				`Partial mailbox schema at ${dbPath}: missing ${missing.join(", ")}`,
			);
		}
		db.pragma("query_only = 0");
		return { status: "opened", db };
	} catch (error) {
		closeAfterOpenFailure(db);
		throw error;
	}
}

export class CommDB {
	private db: Database.Database;

	/**
	 * Open (or create) the comm database.
	 * @param dbPath - Path to the SQLite file
	 * @param createIfMissing - When false, throws if the DB file doesn't exist.
	 *   Read-only commands (check, pending) should pass false to avoid masking
	 *   configuration errors as "no pending questions".
	 * @param archiveOnOpen - Disable only when the caller must run a sweep with
	 *   an explicit retention window and report that sweep's own count.
	 */
	constructor(dbPath: string, createIfMissing = true, archiveOnOpen = true) {
		const existed = existsSync(dbPath);
		if (!createIfMissing && !existed) {
			throw new Error(
				`Database not found: ${dbPath}. Has a question been asked yet?`,
			);
		}
		let phase: CommDbOpenPhase = "mkdir";
		let opened: Database.Database | undefined;
		try {
			mkdirSync(dirname(dbPath), { recursive: true });
			phase = "database-open";
			opened = new Database(dbPath);
			this.db = opened;
			phase = "pragma";
			this.db.pragma("journal_mode = WAL");
			this.db.pragma("busy_timeout = 5000");
			phase = "virgin-probe";
			const isVirgin =
				!existed ||
				(
					this.db
						.prepare(
							"SELECT COUNT(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
						)
						.get() as { count: number }
				).count === 0;
			phase = "generation-assert";
			if (!isVirgin) assertMailboxGeneration(this.db, dbPath);
			phase = "schema";
			this.db.exec(SCHEMA);
			ensureMailboxQueueSchema(this.db);
			phase = "migrations";
			this.db
				.transaction(() => {
					this.db.exec(
						"DROP VIEW IF EXISTS messages; DROP VIEW IF EXISTS lead_inbox;",
					);
					this.applyMigrations();
					this.db.exec(MAILBOX_POISON_VIEWS);
				})
				.immediate();
			phase = "purge";
			if (archiveOnOpen) this.purgeExpired();
		} catch (error) {
			closeAfterOpenFailure(opened);
			augmentCommDbOpenError(error, dbPath, phase);
		}
	}

	/**
	 * Open the database in read-only mode for lightweight polling.
	 * Skips schema creation, migrations, and purge.
	 * Used by TmuxAdapter poll loop for dynamic timeout checks.
	 */
	static openReadonly(dbPath: string): CommDB {
		const instance = Object.create(CommDB.prototype) as CommDB;
		let phase: CommDbOpenPhase = "database-open";
		let opened: Database.Database | undefined;
		try {
			opened = new Database(dbPath, { readonly: true });
			instance.db = opened;
			phase = "pragma";
			instance.db.pragma("busy_timeout = 5000");
			phase = "generation-assert";
			assertMailboxGeneration(instance.db, dbPath);
		} catch (error) {
			closeAfterOpenFailure(opened);
			augmentCommDbOpenError(error, dbPath, phase);
		}
		return instance;
	}

	private applyMigrations(): void {
		const sessionColumns = this.db
			.prepare("PRAGMA table_info(sessions)")
			.all() as Array<{ name: string }>;
		if (!sessionColumns.some((c) => c.name === "vendor")) {
			// FLY-1188: transport vendor of the runner session ("claude-code" |
			// "codex"), written at adapter spawn. `send` routes the mailbox wake
			// by it; NULL = legacy/pre-registration row → process-wide env
			// transport (byte-compat). Same race-tolerance as delivered_at.
			try {
				this.db.exec("ALTER TABLE sessions ADD COLUMN vendor TEXT");
			} catch (err) {
				const msg = (err as Error).message ?? "";
				if (!/duplicate column name: vendor/i.test(msg)) {
					throw err;
				}
			}
		}

		// FLY-1279 / FLY-1066: resident goals can end in truthful `blocked` or
		// `failed` states. SQLite cannot ALTER a CHECK constraint, so rebuild the
		// tiny registry table atomically. No table references sessions via a
		// foreign key.
		const sessionSchema = this.db
			.prepare(
				"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
			)
			.get() as { sql?: string } | undefined;
		if (!sessionSchema?.sql?.includes("'failed'")) {
			this.db.transaction(() => {
				this.db.exec(`
					CREATE TABLE sessions_fly1066 (
						execution_id TEXT PRIMARY KEY,
						tmux_window TEXT NOT NULL,
						project_name TEXT NOT NULL,
						issue_id TEXT,
						lead_id TEXT,
						started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
						ended_at DATETIME,
						status TEXT DEFAULT 'running' CHECK(status IN ('running','completed','timeout','blocked','failed')),
						vendor TEXT
					);
					INSERT INTO sessions_fly1066 (
						execution_id, tmux_window, project_name, issue_id, lead_id,
						started_at, ended_at, status, vendor
					)
					SELECT execution_id, tmux_window, project_name, issue_id, lead_id,
						started_at, ended_at, status, vendor
					FROM sessions;
					DROP TABLE sessions;
					ALTER TABLE sessions_fly1066 RENAME TO sessions;
					CREATE INDEX idx_sessions_project ON sessions(project_name);
					CREATE INDEX idx_sessions_status ON sessions(status);
				`);
			})();
		}
		this.db.exec(`
			INSERT OR IGNORE INTO session_receipt_lineage
				(execution_id, project_name, issue_id, lead_id)
			SELECT execution_id, project_name, issue_id, lead_id
			  FROM sessions
		`);

		// FLY-1375: founder feedback is an immutable workflow source event just
		// like approval. SQLite cannot widen the CHECK constraint in place.
		const workflowSourceSchema = this.db
			.prepare(
				"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workflow_source_event'",
			)
			.get() as { sql?: string } | undefined;
		if (!workflowSourceSchema?.sql?.includes("'founder_feedback'")) {
			this.db.transaction(() => {
				this.db.exec(`
					DROP TRIGGER IF EXISTS workflow_source_event_no_update;
					DROP TRIGGER IF EXISTS workflow_source_event_no_delete;
					CREATE TABLE workflow_source_event_fly1375 (
						project TEXT NOT NULL,
						source_event_id TEXT NOT NULL,
						kind TEXT NOT NULL CHECK(kind IN ('founder_approval','founder_feedback','turn_grant')),
						payload TEXT NOT NULL,
						payload_digest TEXT NOT NULL,
						schema_version INTEGER NOT NULL,
						at TEXT NOT NULL,
						PRIMARY KEY (project, source_event_id)
					);
					INSERT INTO workflow_source_event_fly1375
						(project, source_event_id, kind, payload, payload_digest, schema_version, at)
					SELECT project, source_event_id, kind, payload, payload_digest, schema_version, at
					FROM workflow_source_event;
					DROP TABLE workflow_source_event;
					ALTER TABLE workflow_source_event_fly1375 RENAME TO workflow_source_event;
					CREATE TRIGGER workflow_source_event_no_update
					BEFORE UPDATE ON workflow_source_event
					BEGIN SELECT RAISE(ABORT, 'workflow_source_event is append-only'); END;
					CREATE TRIGGER workflow_source_event_no_delete
					BEFORE DELETE ON workflow_source_event
					BEGIN SELECT RAISE(ABORT, 'workflow_source_event is append-only'); END;
				`);
			})();
		}

		const turnColumns = this.db
			.prepare("PRAGMA table_info(three_stage_turn)")
			.all() as Array<{ name: string }>;
		for (const [name, sqlType] of [
			["target_run_id", "TEXT"],
			["target_node_id", "TEXT"],
			["target_attempt", "INTEGER"],
			["activation_id", "TEXT"],
		] as const) {
			if (turnColumns.some((column) => column.name === name)) continue;
			try {
				this.db.exec(
					`ALTER TABLE three_stage_turn ADD COLUMN ${name} ${sqlType}`,
				);
			} catch (error) {
				if (
					!new RegExp(`duplicate column name: ${name}`, "i").test(
						(error as Error).message,
					)
				) {
					throw error;
				}
			}
		}
		const wakeColumns = this.db
			.prepare("PRAGMA table_info(turn_wake_outbox)")
			.all() as Array<{ name: string }>;
		if (!wakeColumns.some((column) => column.name === "receipt_projected_at")) {
			this.db.exec(
				"ALTER TABLE turn_wake_outbox ADD COLUMN receipt_projected_at INTEGER",
			);
		}
		const waitColumns = this.db
			.prepare("PRAGMA table_info(turn_wait_ledger)")
			.all() as Array<{ name: string }>;
		for (const [name, sqlType] of [
			["no_turn_streak", "INTEGER NOT NULL DEFAULT 0"],
			["last_no_turn_at", "INTEGER"],
		] as const) {
			if (waitColumns.some((column) => column.name === name)) continue;
			this.db.exec(
				`ALTER TABLE turn_wait_ledger ADD COLUMN ${name} ${sqlType}`,
			);
		}
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS runner_workflow_activation (
				execution_id TEXT NOT NULL,
				epoch INTEGER NOT NULL,
				activation_id TEXT NOT NULL,
				run_id TEXT NOT NULL,
				node_id TEXT NOT NULL,
				attempt INTEGER NOT NULL CHECK(attempt > 0),
				output_credential TEXT,
				submission_credential TEXT,
				context_json TEXT NOT NULL,
				context_digest TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				PRIMARY KEY (execution_id, epoch)
			)
		`);
	}

	purgeExpired(): number {
		const queue = new MailboxQueue(this.db);
		const archived = queue.archiveDueFamilies({
			now: new Date().toISOString(),
		});
		queue.drainContentRefGc({ now: new Date().toISOString() });
		return archived.archivedMessages;
	}

	purgeExpiredWithRefs(): number {
		return this.purgeExpired();
	}

	cleanupReadMessages(ttlHours = 24): number {
		return this.cleanupReadMessagesWithRefs(ttlHours);
	}

	cleanupReadMessagesWithRefs(ttlHours = 24): number {
		const retentionMs = Math.max(72, ttlHours) * 60 * 60_000;
		const queue = new MailboxQueue(this.db);
		const archived = queue.archiveDueFamilies({
			now: new Date().toISOString(),
			retentionMs,
		});
		queue.drainContentRefGc({ now: new Date().toISOString() });
		return archived.archivedMessages;
	}

	insertQuestion(
		fromAgent: string,
		toAgent: string,
		content: string,
		opts?: {
			/** FLY-1375: deterministic engine-gate identity (insert-or-verify). */
			id?: string;
			checkpoint?: string;
			contentRef?: string;
			contentType?: "text" | "ref";
			/** FLY-245 D-b: override the default +72h TTL with a custom window (e.g.
			 * a minutes-scale runner-lifecycle confirmation, plan §5.1). A
			 * non-positive/non-finite value falls back to the schema default. */
			ttlSeconds?: number;
			/** FLY-1041: 'report' = runner→Lead status report — excluded from the
			 * founder-reply binding candidate set; all other question semantics
			 * (relay, pending, liveness) unchanged. */
			kind?: "report";
			/** Queue-native SLA carried by the canonical mailbox row. */
			deadlineAt?: string;
		},
	): string {
		const id = opts?.id?.trim() || randomUUID();
		if (opts?.id !== undefined && !opts.id.trim()) {
			throw new Error("deterministic question id must be non-empty");
		}
		const ttl = opts?.ttlSeconds;
		const customTtl =
			typeof ttl === "number" && Number.isFinite(ttl) && ttl > 0;
		if (opts?.deadlineAt) {
			assertUtcIsoTimestamp(opts.deadlineAt, "deadlineAt");
		}
		if (opts?.id) {
			const existing = this.db
				.prepare(
					`SELECT id, from_agent, to_agent, type, content, checkpoint,
					        content_ref, content_type, kind, deadline_at
					   FROM mailbox_message_projection WHERE id = ?`,
				)
				.get(id) as Message | undefined;
			if (existing) {
				const matches =
					existing.type === "question" &&
					existing.from_agent === fromAgent &&
					existing.to_agent === toAgent &&
					existing.content === content &&
					(existing.checkpoint ?? null) === (opts.checkpoint ?? null) &&
					(existing.content_ref ?? null) === (opts.contentRef ?? null) &&
					(existing.content_type ?? "text") === (opts.contentType ?? "text") &&
					(existing.kind ?? null) === (opts.kind ?? null) &&
					(existing.deadline_at ?? null) === (opts.deadlineAt ?? null);
				if (!matches) {
					throw new Error(`deterministic question identity conflict: ${id}`);
				}
				return id;
			}
		}
		const now = new Date();
		new MailboxQueue(this.db).enqueue({
			id,
			deliveryId: `question:${toAgent}:${id}`,
			fromAgent,
			toAgent,
			recipientKind: toAgent === "bridge" ? "bridge" : "lead",
			type: "question",
			content,
			checkpoint: opts?.checkpoint ?? null,
			contentRef: opts?.contentRef ?? null,
			contentType: opts?.contentType ?? "text",
			kind: opts?.kind ?? null,
			deadlineAt: opts?.deadlineAt ?? null,
			expiresAt: new Date(
				now.getTime() +
					(customTtl ? Math.floor(ttl as number) * 1000 : 72 * 60 * 60 * 1000),
			).toISOString(),
			createdAt: now.toISOString(),
			priority: opts?.kind === "report" ? 2 : 1,
			senderRef: encodeSenderRef(),
		});
		return id;
	}

	/**
	 * FLY-245 D-b: atomically CLAIM a runner-lifecycle consent for execution.
	 * `resolveGate` is an unconditional UPDATE (can't prevent a double-consume), so
	 * lifecycle execution uses this conditional claim: set `resolved_at` ONLY if the
	 * question is still un-consumed and un-expired, scoped to the expected
	 * `runner_lifecycle:<action>` checkpoint. Returns true ONLY for the single
	 * caller that won the claim (`changes === 1`) — at-most-once consumption of a
	 * confirmation (a terminate is irreversible, so this is stronger than the
	 * idempotent merge/ship path). Plan §5.3 / Codex R1#6.
	 */
	claimLifecycleConsent(questionId: string, checkpoint: string): boolean {
		const info = this.db
			.prepare(
				`UPDATE mailbox SET resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
				 relay_state = 'terminal_disposed'
         WHERE id = ? AND type = 'question' AND checkpoint = ?
			   AND resolved_at IS NULL AND datetime(expires_at) > datetime('now')`,
			)
			.run(questionId, checkpoint);
		return info.changes === 1;
	}

	/**
	 * FLY-1041: retire a SUPERSEDED approve_to_ship gate — expire NOW so it
	 * drops out of `getPendingQuestions` immediately (`resolveGate(qid, 0)`
	 * semantics: the pending filter is `expires_at > now`, NOT `resolved_at`).
	 * Double-guarded WHERE so a rebind race can never rewrite history:
	 * only `checkpoint='approve_to_ship'` AND only while UNANSWERED — an
	 * already-answered gate (a real approval) is untouchable. The row is kept
	 * for forensics until the normal prune; the durable audit trail is the
	 * Bridge-side `ship_gate_superseded` session_event. Returns true iff a
	 * row was retired.
	 */
	retireShipGate(
		questionId: string,
		opts?: { supersededBy?: string },
	): boolean {
		const answerable = commDbProtectionEnabled()
			? "relay_state != 'terminal_disposed'"
			: "datetime(expires_at) > datetime('now')";
		const info = this.db
			.prepare(
				`UPDATE mailbox SET
				 resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
				 state = 'ACKED',
				 acked_at = COALESCE(acked_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
				 expires_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
				 relay_state = 'terminal_disposed',
				 superseded_at = CASE WHEN ? IS NULL THEN superseded_at ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now') END,
				 superseded_by = COALESCE(?, superseded_by)
				 WHERE id = ? AND type = 'question'
				 AND checkpoint = 'approve_to_ship'
				 AND ${answerable}
				 AND NOT EXISTS (
				   SELECT 1 FROM mailbox r WHERE r.ref_id = mailbox.id AND r.type = 'response'
				 )`,
			)
			.run(opts?.supersededBy ?? null, opts?.supersededBy ?? null, questionId);
		return info.changes > 0;
	}

	/**
	 * FLY-1448 E1: retire one unanswered ship gate and settle only receipt
	 * roots whose immutable ref_message_id points at that gate. The question
	 * CAS and receipt-family evidence commit in one CommDB transaction; a
	 * response that wins first leaves both objects untouched.
	 */
	supersedeShipGateAndReceiptFamily(input: {
		questionId: string;
		reason:
			| "superseded_session_terminal"
			| "superseded_issue_done"
			| "superseded_merged";
		now: string;
	}):
		| { kind: "settled" | "already_settled"; receiptIds: string[] }
		| { kind: "response_won" | "missing"; receiptIds: [] } {
		assertUtcIsoTimestamp(input.now, "now");
		const settle = this.db.transaction(() => {
			const question = this.db
				.prepare(
					`SELECT id, checkpoint, relay_state, resolved_via
					   FROM mailbox_message_projection WHERE id = ? AND type = 'question'`,
				)
				.get(input.questionId) as
				| {
						id: string;
						checkpoint: string | null;
						relay_state: string;
						resolved_via: string | null;
				  }
				| undefined;
			if (!question || question.checkpoint !== "approve_to_ship") {
				return { kind: "missing" as const, receiptIds: [] as [] };
			}
			const response = this.db
				.prepare(
					"SELECT 1 FROM mailbox_message_projection WHERE parent_id = ? AND type = 'response' LIMIT 1",
				)
				.get(input.questionId);
			if (response) {
				return { kind: "response_won" as const, receiptIds: [] as [] };
			}
			const alreadySettled =
				question.relay_state === "terminal_disposed" &&
				question.resolved_via === input.reason;
			if (!alreadySettled) {
				const updated = this.db
					.prepare(
						`UPDATE mailbox SET
						   resolved_at = ?,
						   state = 'ACKED',
						   acked_at = COALESCE(acked_at, ?),
						   expires_at = ?,
						   relay_state = 'terminal_disposed',
						   resolved_via = ?,
						   superseded_at = COALESCE(superseded_at, ?)
						 WHERE id = ? AND type = 'question'
						   AND checkpoint = 'approve_to_ship'
						   AND relay_state != 'terminal_disposed'
						   AND NOT EXISTS (
						     SELECT 1 FROM mailbox response
						      WHERE response.ref_id = mailbox.id
						        AND response.type = 'response'
						   )`,
					)
					.run(
						input.now,
						input.now,
						input.now,
						input.reason,
						input.now,
						input.questionId,
					);
				if (updated.changes !== 1) {
					const lateResponse = this.db
						.prepare(
							"SELECT 1 FROM mailbox_message_projection WHERE parent_id = ? AND type = 'response' LIMIT 1",
						)
						.get(input.questionId);
					return {
						kind: lateResponse
							? ("response_won" as const)
							: ("missing" as const),
						receiptIds: [] as [],
					};
				}
			}

			const receiptIds = (
				this.db
					.prepare(
						`SELECT receipt_id FROM receipt_root_lineage
						  WHERE question_id = ? ORDER BY receipt_id`,
					)
					.all(input.questionId) as Array<{ receipt_id: string }>
			).map((row) => row.receipt_id);
			const queue = new MailboxQueue(this.db);
			for (const receiptId of receiptIds) {
				queue.settle({
					messageOrDeliveryId: receiptId,
					event: "disposed",
					now: input.now,
					evidence: {
						v: 1,
						kind: input.reason,
						ref: input.questionId,
						actor: "terminal-receipt-projector",
						actor_kind: "bridge-protocol",
						fence: { question_id: input.questionId },
						basis: [`question:${input.questionId}`],
					},
				});
			}
			return {
				kind: alreadySettled
					? ("already_settled" as const)
					: ("settled" as const),
				receiptIds,
			};
		});
		return settle.immediate();
	}

	/** List canonical receipt roots whose referenced message originated from
	 * the exact runner execution. This is lineage discovery, not a text parse. */
	listReceiptRootsForExecution(executionId: string): string[] {
		return (
			this.db
				.prepare(
					`SELECT DISTINCT receipt_id
					   FROM receipt_root_lineage
					  WHERE execution_id = ?
					  ORDER BY receipt_id`,
				)
				.all(executionId) as Array<{ receipt_id: string }>
		).map((row) => row.receipt_id);
	}

	getReceiptSettlementLineage(receiptId: string):
		| {
				receiptId: string;
				executionId: string;
				questionId: string;
				projectName: string;
				issueId: string | null;
				rootLeadId: string;
				sessionLeadId: string | null;
		  }
		| undefined {
		return this.db
			.prepare(
				`SELECT lineage.receipt_id AS receiptId,
				        lineage.execution_id AS executionId,
				        lineage.question_id AS questionId,
				        owner.project_name AS projectName,
				        owner.issue_id AS issueId,
				        lineage.root_lead_id AS rootLeadId,
				        owner.lead_id AS sessionLeadId
				   FROM receipt_root_lineage lineage
				   JOIN mailbox_identity identity
				     ON identity.delivery_id = lineage.receipt_id
				    AND identity.id = lineage.question_id
				   JOIN session_receipt_lineage owner
				     ON owner.execution_id = lineage.execution_id
				  WHERE lineage.receipt_id = ?`,
			)
			.get(receiptId) as
			| {
					receiptId: string;
					executionId: string;
					questionId: string;
					projectName: string;
					issueId: string | null;
					rootLeadId: string;
					sessionLeadId: string | null;
			  }
			| undefined;
	}

	/**
	 * FLY-1448 E2: settle any canonical receipt family for an exact terminal
	 * execution. `delivered_at` is intentionally irrelevant: delivered but
	 * unprocessed is still an open obligation. Processed evidence wins;
	 * conflicting disposal evidence fails closed. All terminal authorities for
	 * the same subject are equivalent: whichever one disposes first satisfies
	 * the others without rewriting its original forensic evidence.
	 */
	settleReceiptFamilyForTerminalSubject(input: {
		receiptId: string;
		expectedExecutionId: string;
		reason: "session_terminal" | "issue_done" | "pr_merged";
		now: string;
	}):
		| {
				kind: "disposed" | "already_disposed" | "processing_won";
				receiptId: string;
		  }
		| { kind: "missing"; receiptId: string } {
		assertUtcIsoTimestamp(input.now, "now");
		const settle = this.db.transaction(() => {
			const lineage = this.db
				.prepare(
					`SELECT lineage.execution_id, lineage.question_id
					   FROM receipt_root_lineage lineage
					   JOIN mailbox_identity identity
					     ON identity.delivery_id = lineage.receipt_id
					    AND identity.id = lineage.question_id
					  WHERE lineage.receipt_id = ?`,
				)
				.get(input.receiptId) as
				| { execution_id: string; question_id: string }
				| undefined;
			if (!lineage)
				return { kind: "missing" as const, receiptId: input.receiptId };
			if (lineage.execution_id !== input.expectedExecutionId) {
				throw new Error(
					`receipt lineage mismatch for ${input.receiptId}: expected ${input.expectedExecutionId}`,
				);
			}
			const queue = new MailboxQueue(this.db);
			const existing = queue.getSettlement(input.receiptId);
			if (existing?.event === "processed")
				return { kind: "processing_won" as const, receiptId: input.receiptId };
			const evidence: ProcessedEvidenceV1 = {
				v: 1,
				kind: "terminal_subject_settlement",
				ref: input.receiptId,
				actor: "terminal-receipt-projector",
				actor_kind: "bridge-protocol",
				fence: {
					execution_id: input.expectedExecutionId,
					reason: input.reason,
				},
				basis: [`receipt:${input.receiptId}`, `source:${lineage.question_id}`],
			};
			if (existing?.event === "disposed") {
				if (
					!isEquivalentTerminalReceiptDisposal(
						JSON.stringify(existing.evidence),
						input.receiptId,
						lineage.question_id,
						input.expectedExecutionId,
					)
				) {
					throw new Error(
						`receipt ${input.receiptId} has conflicting disposed evidence`,
					);
				}
				return {
					kind: "already_disposed" as const,
					receiptId: input.receiptId,
				};
			}
			queue.settle({
				messageOrDeliveryId: input.receiptId,
				event: "disposed",
				now: input.now,
				evidence,
			});
			return { kind: "disposed" as const, receiptId: input.receiptId };
		});
		return settle.immediate();
	}

	/**
	 * FLY-1099 §5 (Codex R1 #6): retire a NON-ship zombie gate question with the
	 * same double-guarded WHERE discipline as `retireShipGate` — only the exact
	 * (id, from_agent) row, only while UNANSWERED and un-expired. A concurrent
	 * response wins (returns false, history untouched); `resolveGate`'s
	 * unconditional UPDATE is deliberately NOT reused here. `requireUnanswered`
	 * is structurally always true for zombie hygiene — the parameter documents
	 * the contract rather than offering an unsafe mode.
	 */
	retireQuestionGuarded(
		questionId: string,
		opts: {
			expectedFromAgent: string;
			requireUnanswered: true;
			/**
			 * FLY-1328: disposal provenance for the `resolved_via` column. Omitted
			 * = today's byte path (column stays NULL) — the zombie-gate Z1 caller
			 * shares this primitive and its rows must not change.
			 */
			resolvedVia?: string;
			/**
			 * FLY-1328: 'ask_forensic' keeps the row for a 1h forensic window under
			 * protection instead of expiring it now. Omitted = today's immediate
			 * expiry, so the existing gate purge timing is untouched.
			 */
			retention?: "ask_forensic";
			supersededBy?: string;
		},
	): boolean {
		const protection = commDbProtectionEnabled();
		const answerable = protection
			? "relay_state != 'terminal_disposed'"
			: "datetime(expires_at) > datetime('now')";
		// Legacy pending filters on expires_at, so the forensic window only applies
		// where relay_state does the filtering — otherwise the row would linger in
		// the very queue this is clearing.
		const expiry =
			opts.retention === "ask_forensic" && protection
				? `strftime('%Y-%m-%dT%H:%M:%fZ','now', '${ASK_FORENSIC_TTL_SQL}')`
				: "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
		const info = this.db
			.prepare(
				`UPDATE mailbox SET
				 resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
				 state = 'ACKED',
				 acked_at = COALESCE(acked_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
				 expires_at = ${expiry},
				 relay_state = 'terminal_disposed',
				 superseded_at = CASE WHEN ? IS NULL THEN superseded_at ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now') END,
				 superseded_by = COALESCE(?, superseded_by)
				 ${opts.resolvedVia ? ", resolved_via = ?" : ""}
				 WHERE id = ? AND type = 'question'
				 AND from_agent = ?
				 AND ${answerable}
				 AND NOT EXISTS (
				   SELECT 1 FROM mailbox r WHERE r.ref_id = mailbox.id AND r.type = 'response'
				 )`,
			)
			.run(
				opts.supersededBy ?? null,
				opts.supersededBy ?? null,
				...(opts.resolvedVia ? [opts.resolvedVia] : []),
				questionId,
				opts.expectedFromAgent,
			);
		return info.changes > 0;
	}

	/**
	 * FLY-1099 §4.3: is this question still answerable — exists, type=question,
	 * no response child, not expired? (The same predicate `getPendingQuestions`
	 * applies, point-queried for the deferred-approval rebind pass.)
	 */
	isQuestionPending(questionId: string): boolean {
		const answerable = commDbProtectionEnabled()
			? "q.relay_state != 'terminal_disposed'"
			: "datetime(q.expires_at) > datetime('now')";
		const row = this.db
			.prepare(
				`SELECT 1 AS hit FROM mailbox_message_projection q
	       WHERE q.id = ? AND q.type = 'question'
	       AND NOT EXISTS (
	         SELECT 1 FROM mailbox_message_projection r WHERE r.parent_id = q.id AND r.type = 'response'
	       )
	       AND ${answerable}`,
			)
			.get(questionId) as { hit: number } | undefined;
		return row !== undefined;
	}

	/** FLY-1314: complete narrow-row read for global issue/family ordering. */
	getGatesForSupersede(): GateSupersedeRow[] {
		const answerable = commDbProtectionEnabled()
			? "q.relay_state != 'terminal_disposed'"
			: "datetime(q.expires_at) > datetime('now')";
		return this.db
			.prepare(
				`SELECT q.rowid AS row_id, q.id, q.from_agent, q.checkpoint,
				        q.created_at, q.superseded_at, q.superseded_by,
				        CASE WHEN EXISTS (
				          SELECT 1 FROM mailbox_message_projection r
				           WHERE r.parent_id = q.id AND r.type = 'response'
				        ) THEN 1 ELSE 0 END AS answered,
				        CASE WHEN ${answerable} AND NOT EXISTS (
				          SELECT 1 FROM mailbox_message_projection r
				           WHERE r.parent_id = q.id AND r.type = 'response'
				        ) THEN 1 ELSE 0 END AS pending
				   FROM mailbox_message_projection q
				  WHERE q.type = 'question'
				    AND q.checkpoint IN ('approve_to_ship','review_design','review_code')
				    AND q.superseded_at IS NULL
				  ORDER BY q.created_at, q.rowid`,
			)
			.all() as GateSupersedeRow[];
	}

	/** FLY-1314: independent audit-reconciliation read of durable dispositions. */
	getSupersededGates(): GateSupersedeRow[] {
		return this.db
			.prepare(
				`SELECT q.rowid AS row_id, q.id, q.from_agent, q.checkpoint,
				        q.created_at, q.superseded_at, q.superseded_by,
				        CASE WHEN EXISTS (
				          SELECT 1 FROM mailbox_message_projection r
				           WHERE r.parent_id = q.id AND r.type = 'response'
				        ) THEN 1 ELSE 0 END AS answered,
				        0 AS pending
				   FROM mailbox_message_projection q
				  WHERE q.type = 'question'
				    AND q.checkpoint IN ('approve_to_ship','review_design','review_code')
				    AND q.superseded_at IS NOT NULL
				  ORDER BY q.created_at, q.rowid`,
			)
			.all() as GateSupersedeRow[];
	}

	/**
	 * FLY-1314 point-read recheck immediately before mutation. The target must
	 * still be pending/unanswered and the named supersessor must still be a
	 * later, non-superseded gate in the same exact family. Answered supersessors
	 * deliberately count; answered targets deliberately do not.
	 */
	canSupersedeGate(questionId: string, supersessorId: string): boolean {
		const answerable = commDbProtectionEnabled()
			? "old.relay_state != 'terminal_disposed'"
			: "datetime(old.expires_at) > datetime('now')";
		const hit = this.db
			.prepare(
				`SELECT 1 AS hit
				   FROM mailbox_message_projection old
				   JOIN mailbox_message_projection newer ON newer.id = ?
				  WHERE old.id = ?
				    AND old.type = 'question' AND newer.type = 'question'
				    AND old.checkpoint = newer.checkpoint
				    AND old.checkpoint IN ('approve_to_ship','review_design','review_code')
				    AND old.superseded_at IS NULL
				    AND newer.superseded_at IS NULL
				    AND ${answerable}
				    AND NOT EXISTS (
				      SELECT 1 FROM mailbox_message_projection r
				       WHERE r.parent_id = old.id AND r.type = 'response'
				    )
				    AND (newer.created_at > old.created_at OR
				         (newer.created_at = old.created_at AND newer.rowid > old.rowid))`,
			)
			.get(supersessorId, questionId) as { hit: number } | undefined;
		return hit !== undefined;
	}

	/**
	 * Mark a gate question as resolved: set resolved_at, mark read,
	 * and shorten TTL to the configured cleanup hours.
	 */
	resolveGate(questionId: string, cleanupTtlHours = 24): void {
		this.db
			.prepare(
				`UPDATE mailbox SET
				 resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
				 state = 'ACKED',
				 acked_at = COALESCE(acked_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
				 expires_at = strftime('%Y-%m-%dT%H:%M:%fZ','now', '+' || ? || ' hours'),
				 relay_state = 'terminal_disposed'
				 WHERE id = ? AND type = 'question'`,
			)
			.run(cleanupTtlHours, questionId);
	}

	insertResponse(
		parentId: string,
		fromAgent: string,
		content: string,
		provenance?: MessageProvenance,
	): ResponseWriteResult {
		return this.db.transaction((): ResponseWriteResult => {
			const question = this.db
				.prepare(
					"SELECT * FROM mailbox_message_projection WHERE id = ? AND type = 'question'",
				)
				.get(parentId) as Message | undefined;
			if (!question) throw new Error(`Question ${parentId} not found`);
			if (question.checkpoint === "approve_to_ship") {
				if (
					question.resolved_at !== null ||
					question.superseded_at !== null ||
					question.relay_state === "terminal_disposed" ||
					this.getResponse(parentId)
				) {
					return { written: false, reason: "gate_not_open" };
				}
			}
			new MailboxQueue(this.db).enqueue({
				id: randomUUID(),
				fromAgent,
				toAgent: question.from_agent,
				recipientKind: "runner",
				type: "response",
				content,
				refId: parentId,
				createdAt: new Date().toISOString(),
				expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
				senderRef: encodeSenderRef(provenance),
			});
			this.markQuestionTerminalDisposed(parentId);
			return { written: true };
		})();
	}

	insertAckReceipt(
		fromAgent: string,
		eventSeq: number,
		ackToken: string,
	): string {
		if (!Number.isSafeInteger(eventSeq) || eventSeq <= 0) {
			throw new Error("eventSeq must be a positive safe integer");
		}
		if (!ackToken) throw new Error("ackToken is required");
		const id = randomUUID();
		new MailboxQueue(this.db).enqueue({
			id,
			deliveryId: `ack:${fromAgent}:${id}`,
			fromAgent,
			toAgent: "bridge",
			recipientKind: "bridge",
			type: "ack_receipt",
			msgClass: "protocol",
			content: JSON.stringify({ event_seq: eventSeq, ack_token: ackToken }),
			createdAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
			senderRef: encodeSenderRef(),
		});
		return id;
	}

	insertBatchAckReceipt(fromAgent: string, batchId: string): string {
		const normalizedBatchId = batchId.trim();
		if (!fromAgent.trim()) throw new Error("fromAgent is required");
		if (!normalizedBatchId) throw new Error("batchId is required");
		const id = randomUUID();
		new MailboxQueue(this.db).enqueue({
			id,
			deliveryId: `ack_batch:${fromAgent}:${id}`,
			fromAgent,
			toAgent: "bridge",
			recipientKind: "bridge",
			type: "ack_batch",
			msgClass: "protocol",
			content: JSON.stringify({ batch_id: normalizedBatchId }),
			createdAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
			senderRef: encodeSenderRef(),
		});
		return id;
	}

	getPendingAckReceipts(): Message[] {
		return this.db
			.prepare(
				`SELECT * FROM mailbox_message_projection
				 WHERE type = 'ack_receipt' AND read_at IS NULL
				   AND datetime(expires_at) > datetime('now')
				 ORDER BY created_at, id`,
			)
			.all() as Message[];
	}

	markAckReceiptConsumed(id: string): boolean {
		return (
			this.db
				.prepare(
					`UPDATE mailbox SET state = 'ACKED',
					   acked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
					 WHERE id = ? AND type = 'ack_receipt'
					   AND state IN ('QUEUED','LEASED')`,
				)
				.run(id).changes === 1
		);
	}

	markQuestionProtected(questionId: string, logicalEventId: string): boolean {
		if (!commDbProtectionEnabled()) return true;
		const result = this.db
			.prepare(
				`UPDATE mailbox SET
				   relay_state = 'protected',
				   source_ref = COALESCE(source_ref, ?)
				 WHERE id = ? AND type = 'question'
				   AND relay_state != 'terminal_disposed'
				   AND (source_ref IS NULL OR source_ref = ?)`,
			)
			.run(logicalEventId, questionId, logicalEventId);
		return result.changes === 1;
	}

	markQuestionTerminalDisposed(questionId: string): boolean {
		const result = this.db
			.prepare(
				`UPDATE mailbox SET relay_state = 'terminal_disposed'
				 WHERE id = ? AND type = 'question'
				   AND relay_state != 'terminal_disposed'`,
			)
			.run(questionId);
		return result.changes === 1;
	}

	/**
	 * FLY-1188 §7.1 (Codex R16): atomically answer a gate question IFF it is
	 * STILL the expected execution's OPEN review gate. One conditional INSERT
	 * proves type/owner/checkpoint/unresolved/unexpired/unanswered in the same
	 * statement — closing the check→write TOCTOU against a concurrent
	 * `resolveGate()` / expiry from another process. Returns true only when
	 * the response row was actually written.
	 */
	insertResponseIfGateOpen(input: {
		questionId: string;
		fromAgent: string;
		content: string;
		/** The question's from_agent must still equal this execution id. */
		expectedOwner: string;
		/** The question's checkpoint must still equal this value. */
		expectedCheckpoint: string;
		provenance?: MessageProvenance;
	}): boolean {
		const answerable = commDbProtectionEnabled()
			? "relay_state != 'terminal_disposed'"
			: "datetime(expires_at) > datetime('now')";
		return this.db
			.transaction(() => {
				const question = this.db
					.prepare(
						`SELECT * FROM mailbox_message_projection
					 WHERE id = ? AND type = 'question' AND from_agent = ?
					   AND checkpoint = ? AND resolved_at IS NULL AND ${answerable}`,
					)
					.get(
						input.questionId,
						input.expectedOwner,
						input.expectedCheckpoint,
					) as Message | undefined;
				if (
					!question ||
					question.relay_state === "terminal_disposed" ||
					this.getResponse(input.questionId)
				) {
					return false;
				}
				new MailboxQueue(this.db).enqueue({
					id: randomUUID(),
					fromAgent: input.fromAgent,
					toAgent: question.from_agent,
					recipientKind: "runner",
					type: "response",
					content: input.content,
					refId: input.questionId,
					createdAt: new Date().toISOString(),
					expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
					senderRef: encodeSenderRef(input.provenance),
				});
				this.markQuestionTerminalDisposed(input.questionId);
				return true;
			})
			.immediate();
	}

	/**
	 * Answer an open founder ship gate and append its frozen cross-database
	 * source event in the SAME CommDB transaction. A source-event failure rolls
	 * the response back; there is no response-without-outbox window.
	 */
	insertFounderApprovalResponseWithSource(input: {
		project: string;
		sourceEventId: string;
		questionId: string;
		fromAgent: string;
		content: string;
		expectedOwner: string;
		payload: unknown;
		provenance?: MessageProvenance;
	}): boolean {
		const payload = canonicalJsonString(input.payload);
		const payloadDigest = canonicalSubmissionDigest(input.payload);
		const at = new Date().toISOString();
		const answerable = commDbProtectionEnabled()
			? "q.relay_state != 'terminal_disposed'"
			: "datetime(q.expires_at) > datetime('now')";
		return this.db
			.transaction(() => {
				const question = this.db
					.prepare(
						`SELECT q.* FROM mailbox_message_projection q
					  WHERE q.id = ?
					    AND q.type = 'question'
					    AND q.from_agent = ?
					    AND q.checkpoint = 'approve_to_ship'
					    AND q.resolved_at IS NULL
					    AND q.superseded_at IS NULL
					    AND ${answerable}
					    AND NOT EXISTS (
					      SELECT 1 FROM mailbox_message_projection r
					       WHERE r.parent_id = q.id AND r.type = 'response'
					    )`,
					)
					.get(input.questionId, input.expectedOwner) as Message | undefined;
				if (!question) return false;
				new MailboxQueue(this.db).enqueue({
					id: randomUUID(),
					fromAgent: input.fromAgent,
					toAgent: question.from_agent,
					recipientKind: "runner",
					type: "response",
					content: input.content,
					refId: input.questionId,
					createdAt: at,
					expiresAt: new Date(
						Date.parse(at) + 72 * 60 * 60 * 1000,
					).toISOString(),
					senderRef: encodeSenderRef(input.provenance),
				});
				this.markQuestionTerminalDisposed(input.questionId);
				const response = input.payload as
					| { approved?: unknown; response?: { approved?: unknown } }
					| undefined;
				const kind =
					response?.response?.approved === true || response?.approved === true
						? "founder_approval"
						: "founder_feedback";
				this.db
					.prepare(
						`INSERT INTO workflow_source_event
					   (project, source_event_id, kind, payload, payload_digest, schema_version, at)
					 VALUES (?, ?, ?, ?, ?, 1, ?)`,
					)
					.run(
						input.project,
						input.sourceEventId,
						kind,
						payload,
						payloadDigest,
						at,
					);
				return true;
			})
			.immediate();
	}

	listWorkflowSourceEvents(): WorkflowSourceEvent[] {
		return this.db
			.prepare(
				`SELECT project, source_event_id, kind, payload, payload_digest,
				        schema_version, at
				   FROM workflow_source_event
				  ORDER BY at, source_event_id`,
			)
			.all() as WorkflowSourceEvent[];
	}

	listWorkflowSourceEventsAfter(
		afterRowId: number,
		limit = 256,
	): Array<WorkflowSourceEvent & { row_id: number }> {
		return this.db
			.prepare(
				`SELECT rowid AS row_id, project, source_event_id, kind, payload,
				        payload_digest, schema_version, at
				   FROM workflow_source_event
				  WHERE rowid > ?
				  ORDER BY rowid
				  LIMIT ?`,
			)
			.all(afterRowId, limit) as Array<
			WorkflowSourceEvent & { row_id: number }
		>;
	}

	listTurnSourceHistory(issueId?: string): TurnSourceHistory[] {
		if (issueId) {
			return this.db
				.prepare(
					`SELECT id, issue_id, from_role, to_role, epoch, target_run_id,
					        source_event_id, at
					   FROM turn_source_history WHERE issue_id = ? ORDER BY id`,
				)
				.all(issueId) as TurnSourceHistory[];
		}
		return this.db
			.prepare(
				`SELECT id, issue_id, from_role, to_role, epoch, target_run_id,
				        source_event_id, at
				   FROM turn_source_history ORDER BY id`,
			)
			.all() as TurnSourceHistory[];
	}

	/**
	 * FLY-1188 HIGH-2 (Codex full-PR review): write a SYNTHETIC gate-TIMEOUT
	 * response that survives the runner's next `check`. Distinct from
	 * `insertResponseIfGateOpen` in two ways that the timeout path requires:
	 *
	 *  1. NO `expires_at > now` guard. The gate's configured deadline ≈ the
	 *     question's own `expires_at`, so by the time the timeout watcher fires
	 *     the question is already expired — `insertResponseIfGateOpen` would
	 *     refuse and the timeout would never be delivered.
	 *  2. It then pushes the question's `expires_at` forward by `graceHours` in
	 *     the SAME transaction. Otherwise the very next read-write open (the
	 *     runner's `check`, or the watcher's next tick) runs `purgeExpired()`,
	 *     which cascade-deletes the still-expired question AND its response child
	 *     before the runner can read it.
	 *
	 * The race-safety of `insertResponseIfGateOpen` is preserved: a REAL Lead
	 * answer that landed first satisfies the `NOT EXISTS (response)` guard → the
	 * conditional INSERT writes 0 rows → returns false, never clobbering it.
	 * `resolved_at IS NULL` likewise blocks a double-write. Returns true only
	 * when the timeout response was actually written.
	 */
	insertTimeoutResponse(input: {
		questionId: string;
		fromAgent: string;
		content: string;
		/** The question's from_agent must still equal this execution id. */
		expectedOwner: string;
		/** The question's checkpoint must still equal this value. */
		expectedCheckpoint: string;
		/** How long the resolved question (and thus its response) survives the
		 *  purge, so the runner can read it. Defaults to the resolveGate cleanup
		 *  window (24h). */
		graceHours?: number;
		provenance?: MessageProvenance;
	}): boolean {
		const graceHours =
			typeof input.graceHours === "number" &&
			Number.isFinite(input.graceHours) &&
			input.graceHours > 0
				? Math.floor(input.graceHours)
				: 24;
		const bumpGrace = this.db.prepare(
			`UPDATE mailbox SET
			 resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
			 state = 'ACKED',
			 acked_at = COALESCE(acked_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			 expires_at = strftime('%Y-%m-%dT%H:%M:%fZ','now', '+' || ? || ' hours'),
			 relay_state = 'terminal_disposed'
			 WHERE id = ? AND type = 'question'`,
		);
		const txn = this.db.transaction((): boolean => {
			const question = this.db
				.prepare(
					`SELECT * FROM mailbox_message_projection
					 WHERE id = ? AND type = 'question' AND from_agent = ?
					   AND checkpoint = ? AND resolved_at IS NULL
					   AND relay_state != 'terminal_disposed'`,
				)
				.get(input.questionId, input.expectedOwner, input.expectedCheckpoint) as
				| Message
				| undefined;
			if (!question || this.getResponse(input.questionId)) return false;
			new MailboxQueue(this.db).enqueue({
				id: randomUUID(),
				fromAgent: input.fromAgent,
				toAgent: question.from_agent,
				recipientKind: "runner",
				type: "response",
				content: input.content,
				refId: input.questionId,
				createdAt: new Date().toISOString(),
				expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
				senderRef: encodeSenderRef(input.provenance),
			});
			bumpGrace.run(graceHours, input.questionId);
			return true;
		});
		return txn.immediate();
	}

	getResponse(questionId: string): Message | undefined {
		return this.db
			.prepare(
				"SELECT * FROM mailbox_message_projection WHERE parent_id = ? AND type = 'response'",
			)
			.get(questionId) as Message | undefined;
	}

	getWorkflowEngineParkCursor(project: string): number {
		const row = this.db
			.prepare(
				"SELECT last_row_id FROM workflow_engine_park_cursor WHERE project = ?",
			)
			.get(project) as { last_row_id: number } | undefined;
		return row?.last_row_id ?? 0;
	}

	/**
	 * FLY-1448 B2: apply the append-only StateStore park stream and advance its
	 * cursor in one CommDB transaction. Generation is monotonic; on equal
	 * generation a clear outranks an open, so delayed delivery cannot resurrect
	 * a fenced activation.
	 */
	applyWorkflowEngineParkEvents(
		project: string,
		events: readonly WorkflowEngineParkProjectionEvent[],
	): number {
		if (events.length === 0) return this.getWorkflowEngineParkCursor(project);
		const apply = this.db.transaction(() => {
			let cursor = this.getWorkflowEngineParkCursor(project);
			for (const event of events) {
				if (event.row_id <= cursor) continue;
				const current = this.getWorkflowEnginePark(event.execution_id);
				const nextState = event.event === "park_opened" ? "open" : "cleared";
				const shouldApply =
					!current ||
					event.generation > current.generation ||
					(event.generation === current.generation &&
						current.state === "open" &&
						nextState === "cleared");
				if (shouldApply) {
					this.db
						.prepare(
							`INSERT INTO workflow_engine_park
							   (execution_id, run_id, node_id, attempt, activation_id,
							    generation, state, reason, source_row_id, updated_at)
							 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
							 ON CONFLICT(execution_id) DO UPDATE SET
							   run_id=excluded.run_id, node_id=excluded.node_id,
							   attempt=excluded.attempt, activation_id=excluded.activation_id,
							   generation=excluded.generation, state=excluded.state,
							   reason=excluded.reason, source_row_id=excluded.source_row_id,
							   updated_at=excluded.updated_at`,
						)
						.run(
							event.execution_id,
							event.run_id,
							event.node_id,
							event.attempt,
							event.activation_id,
							event.generation,
							nextState,
							event.reason,
							event.row_id,
							event.created_at,
						);
				}
				cursor = Math.max(cursor, event.row_id);
			}
			this.db
				.prepare(
					`INSERT INTO workflow_engine_park_cursor(project, last_row_id, updated_at)
					 VALUES (?, ?, datetime('now'))
					 ON CONFLICT(project) DO UPDATE SET
					   last_row_id = CASE
					     WHEN excluded.last_row_id > workflow_engine_park_cursor.last_row_id
					     THEN excluded.last_row_id
					     ELSE workflow_engine_park_cursor.last_row_id END,
					   updated_at = datetime('now')`,
				)
				.run(project, cursor);
			return cursor;
		});
		return apply.immediate();
	}

	getWorkflowEnginePark(
		executionId: string,
	): WorkflowEngineParkProjection | undefined {
		return this.db
			.prepare("SELECT * FROM workflow_engine_park WHERE execution_id = ?")
			.get(executionId) as WorkflowEngineParkProjection | undefined;
	}

	/**
	 * FLY-175: Look up any message by its id. Used by the founder-consent gate
	 * (Bridge wrapper + `flywheel-comm respond`) to read a question's
	 * `checkpoint` field without trusting a caller-supplied value.
	 */
	getMessageById(id: string): Message | undefined {
		return this.db
			.prepare("SELECT * FROM mailbox_message_projection WHERE id = ?")
			.get(id) as Message | undefined;
	}

	getPendingQuestions(leadId: string): Message[] {
		const answerable = commDbProtectionEnabled()
			? "q.relay_state != 'terminal_disposed'"
			: "datetime(q.expires_at) > datetime('now')";
		return this.db
			.prepare(
				`SELECT q.* FROM mailbox_message_projection q
         WHERE q.to_agent = ? AND q.type = 'question'
         AND NOT EXISTS (
           SELECT 1 FROM mailbox_message_projection r WHERE r.parent_id = q.id AND r.type = 'response'
         )
		 AND ${answerable}
         ORDER BY q.created_at ASC`,
			)
			.all(leadId) as Message[];
	}

	/**
	 * Pending checkpoint questions opened by one runner. Lifecycle guards use
	 * this CommDB query as authority; gate-marker files are only a wake mirror
	 * and may be deleted or partially observed by the runner process.
	 */
	getPendingGatesByRunner(runnerId: string): Message[] {
		return this.db
			.prepare(
				`SELECT q.* FROM mailbox_message_projection q
         WHERE q.from_agent = ? AND q.type = 'question'
         AND q.checkpoint IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM mailbox_message_projection r WHERE r.parent_id = q.id AND r.type = 'response'
         )
         AND datetime(q.expires_at) > datetime('now')
         ORDER BY q.created_at ASC`,
			)
			.all(runnerId) as Message[];
	}

	/**
	 * FLY-58: Find the most recent pending gate question from a specific runner
	 * with a specific checkpoint. Used by Bridge to respond to approve_to_ship gate.
	 */
	getPendingGateByRunner(
		runnerId: string,
		checkpoint: string,
	): Message | undefined {
		const answerable = commDbProtectionEnabled()
			? "q.relay_state != 'terminal_disposed'"
			: "datetime(q.expires_at) > datetime('now')";
		return this.db
			.prepare(
				`SELECT q.* FROM mailbox_message_projection q
         WHERE q.from_agent = ? AND q.type = 'question'
         AND q.checkpoint = ?
         AND NOT EXISTS (
           SELECT 1 FROM mailbox_message_projection r WHERE r.parent_id = q.id AND r.type = 'response'
         )
		 AND ${answerable}
         ORDER BY q.created_at DESC
         LIMIT 1`,
			)
			.get(runnerId, checkpoint) as Message | undefined;
	}

	// NOTE (FLY-191 Codex PR R1 CRITICAL): no "latest gate question" helper on
	// purpose. SQLite created_at has 1s resolution and UUID ids don't sort by
	// insertion order, so "latest" is ambiguous under same-second re-reviews.
	// verify-approval binds to the session's persisted review_question_id
	// instead (StateStore.setReviewBinding).

	// ── Instruction (Phase 2) ──

	insertInstruction(
		fromAgent: string,
		toAgent: string,
		content: string,
		opts?: { dedupeId?: string; provenance?: MessageProvenance },
	): string {
		// A caller-supplied dedupeId is a DETERMINISTIC message identity: the
		// same logical send replayed (e.g. after a crash between this commit
		// and the caller's own checkpoint in another database) lands on the
		// same primary key and is ignored instead of duplicated (FLY-1082,
		// Codex R6). Without it, behavior is byte-identical to before.
		const id = opts?.dedupeId ?? randomUUID();
		if (opts?.dedupeId) {
			const existing = new MailboxQueue(this.db).getById(id);
			if (existing) {
				if (
					existing.from_agent !== fromAgent ||
					existing.to_agent !== toAgent ||
					existing.type !== "instruction" ||
					existing.content !== content ||
					existing.sender_ref !== encodeSenderRef(opts.provenance)
				) {
					throw new Error(
						`instruction id ${id} was reused with different content`,
					);
				}
				return id;
			}
		}
		new MailboxQueue(this.db).enqueue({
			id,
			fromAgent,
			toAgent,
			recipientKind:
				toAgent === "lead" || toAgent.endsWith("-lead") ? "lead" : "runner",
			type: "instruction",
			content,
			createdAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
			senderRef: encodeSenderRef(opts?.provenance),
		});
		return id;
	}

	/**
	 * FLY-1099 §3.3 (Codex R3 #3): instruction insert with a CALLER-stable id —
	 * the at-least-once ledger drain's sink-side dedup. A redelivery after a
	 * crash-before-mark carries the same action_key-derived id and is ignored
	 * (INSERT OR IGNORE), so /codex-code-review is never queued twice for one
	 * intent. Returns true iff a new row landed.
	 */
	insertInstructionWithId(
		id: string,
		fromAgent: string,
		toAgent: string,
		content: string,
		provenance?: MessageProvenance,
	): boolean {
		const existing = new MailboxQueue(this.db).getById(id);
		if (existing) {
			if (
				existing.from_agent !== fromAgent ||
				existing.to_agent !== toAgent ||
				existing.type !== "instruction" ||
				existing.content !== content ||
				existing.sender_ref !== encodeSenderRef(provenance)
			) {
				throw new Error(
					`instruction id ${id} was reused with different content`,
				);
			}
			return false;
		}
		return (
			new MailboxQueue(this.db).enqueue({
				id,
				fromAgent,
				toAgent,
				recipientKind:
					toAgent === "lead" || toAgent.endsWith("-lead") ? "lead" : "runner",
				type: "instruction",
				content,
				createdAt: new Date().toISOString(),
				expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
				senderRef: encodeSenderRef(provenance),
			}).outcome === "inserted"
		);
	}

	enqueueFounderHubRoot(input: EnqueueFounderHubRootInput): MailboxRow {
		const result = new MailboxQueue(this.db).enqueue({
			id: input.id,
			fromAgent: "founder",
			toAgent: input.toLead,
			recipientKind: "lead",
			sourceKind: "founder_reply",
			sourceRef: input.refMessageId,
			type: "founder_reply",
			msgClass: "model",
			priority: 0,
			content: input.content,
			refId: input.refMessageId,
			createdAt: input.now,
			senderRef: encodeSenderRef(),
		});
		if (result.outcome === "archived") {
			throw new Error(`founder hub root was already archived: ${input.id}`);
		}
		return result.row;
	}

	/**
	 * FLY-1448: close a canonical founder hub root after the ship-decision path
	 * reached a durable disposition. The read/verify/CAS and routing-state
	 * update share one CommDB transaction so a concurrent Lead action cannot
	 * be overwritten by a stale deliverer observation.
	 */
	settleFounderHubRoot(input: {
		rootId: string;
		now: string;
		evidence: ProcessedEvidenceV1;
		acceptedProcessedKinds: readonly string[];
	}):
		| { kind: "marked" | "verified"; evidenceKind: string }
		| { kind: "missing" | "conflict"; evidenceKind?: string } {
		assertUtcIsoTimestamp(input.now, "now");
		assertProcessedEvidence(input.evidence);
		const accepted = new Set(input.acceptedProcessedKinds);
		return this.db
			.transaction(() => {
				const queue = new MailboxQueue(this.db);
				const root = queue.getById(input.rootId);
				if (!root) return { kind: "missing" as const };
				const settlement = queue.getSettlement(input.rootId);
				if (settlement?.event === "disposed") {
					return { kind: "conflict" as const };
				}
				let rootPayload: ReturnType<CommDB["parseFounderRootPayload"]>;
				try {
					rootPayload = this.parseFounderRootPayload(root.content);
				} catch {
					return { kind: "conflict" as const };
				}
				if (
					root.ref_id !== rootPayload.msgId ||
					input.evidence.actor_kind !== "founder-writer" ||
					input.evidence.fence.discord_message_id !== rootPayload.msgId
				) {
					return { kind: "conflict" as const };
				}
				const inputQuestionBasisEntries =
					input.evidence.basis?.filter((basis) =>
						basis.startsWith("question:"),
					) ?? [];
				if (inputQuestionBasisEntries.length > 1) {
					return { kind: "conflict" as const };
				}
				const inputQuestionBasis = inputQuestionBasisEntries[0];
				let result: "marked" | "verified";
				let evidenceKind: string;
				if (settlement?.event === "processed") {
					let existingEvidence: ProcessedEvidenceV1;
					try {
						existingEvidence = settlement.evidence as ProcessedEvidenceV1;
						assertProcessedEvidence(existingEvidence);
					} catch {
						return { kind: "conflict" as const };
					}
					evidenceKind = existingEvidence.kind;
					if (typeof evidenceKind !== "string" || !accepted.has(evidenceKind)) {
						return {
							kind: "conflict" as const,
							...(typeof evidenceKind === "string" ? { evidenceKind } : {}),
						};
					}
					const existingQuestionBasisEntries =
						existingEvidence.basis?.filter((basis) =>
							basis.startsWith("question:"),
						) ?? [];
					if (existingQuestionBasisEntries.length > 1) {
						return { kind: "conflict" as const, evidenceKind };
					}
					const existingQuestionBasis = existingQuestionBasisEntries[0];
					if (
						existingEvidence.actor_kind !== "founder-writer" ||
						existingEvidence.actor !== input.evidence.actor ||
						(inputQuestionBasis && existingQuestionBasis !== inputQuestionBasis)
					) {
						return { kind: "conflict" as const, evidenceKind };
					}
					if (evidenceKind === "ship_gate_bound") {
						if (!existingQuestionBasis) {
							return { kind: "conflict" as const, evidenceKind };
						}
						const questionId = existingQuestionBasis.slice("question:".length);
						const response = this.db
							.prepare(
								`SELECT parent_id, from_agent, type
								   FROM mailbox_message_projection WHERE id = ?`,
							)
							.get(existingEvidence.ref) as
							| {
									parent_id: string | null;
									from_agent: string;
									type: string;
							  }
							| undefined;
						if (
							response?.type !== "response" ||
							response.parent_id !== questionId ||
							response.from_agent !== existingEvidence.actor
						) {
							return { kind: "conflict" as const, evidenceKind };
						}
					} else if (inputQuestionBasis) {
						const questionId = inputQuestionBasis.slice("question:".length);
						if (existingEvidence.ref !== questionId) {
							return { kind: "conflict" as const, evidenceKind };
						}
					} else if (existingQuestionBasis) {
						const questionId = existingQuestionBasis.slice("question:".length);
						if (existingEvidence.ref !== questionId) {
							return { kind: "conflict" as const, evidenceKind };
						}
					} else if (existingEvidence.ref !== input.evidence.ref) {
						return { kind: "conflict" as const, evidenceKind };
					}
					const discordFence =
						existingEvidence.fence.discord_message_id === rootPayload.msgId;
					const sourceEventFence =
						typeof existingEvidence.fence.source_event_id === "string" &&
						typeof existingQuestionBasis === "string" &&
						existingEvidence.fence.source_event_id.endsWith(
							`:${existingQuestionBasis.slice("question:".length)}:${rootPayload.msgId}`,
						);
					if (!discordFence && !sourceEventFence) {
						return { kind: "conflict" as const, evidenceKind };
					}
					result = "verified";
				} else {
					queue.settle({
						messageOrDeliveryId: input.rootId,
						event: "processed",
						now: input.now,
						evidence: input.evidence,
					});
					evidenceKind = input.evidence.kind;
					result = "marked";
				}
				return { kind: result, evidenceKind };
			})
			.immediate();
	}

	/** SQL-bounded seam used by the Discord chat recovery worker and patrol. */
	listChatReceiptPending(input: {
		toLead: string;
		cursorSeq?: number;
		limit?: number;
		createdBefore?: string;
		excludeQuarantined?: boolean;
	}): MailboxRow[] {
		return new MailboxQueue(this.db).listExternalPending({
			...input,
			toAgent: input.toLead,
			idPrefix: `chat:${input.toLead}:`,
		});
	}

	/**
	 * Quarantine is visibility, never disposal: later redelivery may still mark
	 * the same external row delivered. The fixed reason keeps retries idempotent.
	 */
	quarantineChatReceipt(input: { receiptId: string; now: string }): boolean {
		const queue = new MailboxQueue(this.db);
		queue.markDead(
			input.receiptId,
			input.now,
			CHAT_DELIVERY_UNCONFIRMED_REASON,
		);
		const row = queue.getById(input.receiptId);
		return Boolean(
			row?.carrier === "external" &&
				row.state === "DEAD" &&
				row.dead_reason === CHAT_DELIVERY_UNCONFIRMED_REASON,
		);
	}

	/**
	 * Handle one founder receipt as Lead: relay the original message to an
	 * eligible pending runner question, or close it explicitly as no-route.
	 * New FLY-1392 roots carry no Bridge-generated candidates; legacy promoted
	 * families retain their frozen-candidate checks. The business write,
	 * response and processed receipt(s) share this transaction.
	 */
	routeFounderReply(input: RouteFounderReplyInput): RouteFounderReplyResult {
		assertUtcIsoTimestamp(input.now, "now");
		const msgId = input.msgId.trim();
		const leadId = input.leadId.trim();
		if (!msgId) throw new Error("msgId is required");
		if (!leadId) throw new Error("leadId is required");
		const toQuestionId = input.toQuestionId?.trim();
		const noRouteReason = input.noRouteReason?.trim();
		if (Boolean(toQuestionId) === Boolean(noRouteReason)) {
			throw new Error(
				"exactly one of toQuestionId or noRouteReason is required",
			);
		}
		const rootId = founderMessageRootId(leadId, msgId);
		const fence = this.processedFenceFromProvenance(input.provenance);

		return this.db
			.transaction((): RouteFounderReplyResult => {
				const queue = new MailboxQueue(this.db);
				const root = queue.getById(rootId);
				if (
					!root ||
					root.to_agent !== leadId ||
					root.source_kind !== "founder_reply" ||
					root.type !== "founder_reply" ||
					root.ref_id !== msgId
				) {
					throw new Error(
						`founder receipt root ${leadId}:${msgId} is unavailable`,
					);
				}
				const rootPayload = this.parseFounderRootPayload(root.content);
				const settlement = queue.getSettlement(rootId);
				if (settlement) {
					if (settlement.event !== "processed") {
						throw new Error("founder route was disposed by another action");
					}
					const evidence = settlement.evidence as ProcessedEvidenceV1;
					if (
						toQuestionId &&
						evidence.kind === "lead_routed" &&
						evidence.actor === leadId &&
						evidence.basis?.includes(`question:${toQuestionId}`)
					) {
						return {
							kind: "routed",
							questionId: toQuestionId,
							responseId: evidence.ref,
						};
					}
					if (
						noRouteReason &&
						evidence.kind === "lead_no_route" &&
						evidence.actor === leadId &&
						evidence.basis?.includes(noRouteReason)
					) {
						return {
							kind: "no_route",
							...(noRouteReason === "already_answered"
								? { winningResponseId: evidence.ref }
								: {}),
						};
					}
					throw new Error(
						"founder route family was processed by another action",
					);
				}

				if (noRouteReason) {
					let winningResponseId: string | undefined;
					if (noRouteReason === "already_answered") {
						const response = toQuestionId
							? this.getResponse(toQuestionId)
							: undefined;
						winningResponseId = response?.id;
						if (!winningResponseId) {
							throw new Error(
								"already_answered requires a winning frozen-candidate response",
							);
						}
					}
					const evidence: ProcessedEvidenceV1 = {
						v: 1,
						kind: "lead_no_route",
						ref: winningResponseId ?? rootId,
						actor: leadId,
						actor_kind: "lead",
						fence,
						basis: [noRouteReason],
					};
					queue.settle({
						messageOrDeliveryId: rootId,
						event: "processed",
						now: input.now,
						evidence,
					});
					return {
						kind: "no_route",
						...(winningResponseId ? { winningResponseId } : {}),
					};
				}

				const questionId = toQuestionId as string;
				const question = this.getMessageById(questionId);
				if (!question || question.type !== "question") {
					throw new Error(`founder route question ${questionId} was not found`);
				}
				if (
					question.kind === "report" ||
					question.checkpoint === "approve_to_ship" ||
					question.checkpoint === "review_design" ||
					question.checkpoint === "review_code"
				) {
					throw new Error(`question ${questionId} is not founder-routable`);
				}
				const session = this.getSession(question.from_agent);
				if (
					!session ||
					session.lead_id !== leadId ||
					session.project_name !== rootPayload.projectName ||
					session.issue_id !== rootPayload.issueId
				) {
					throw new Error(
						`question ${questionId} founder route scope mismatch`,
					);
				}
				const winning = this.getResponse(questionId);
				if (winning) {
					return {
						kind: "stale_candidate",
						questionId,
						winningResponseId: winning.id,
					};
				}
				if (
					question.resolved_at !== null ||
					question.superseded_at !== null ||
					question.relay_state === "terminal_disposed"
				) {
					throw new Error(`question ${questionId} is no longer pending`);
				}
				const responseId = randomUUID();
				new MailboxQueue(this.db).enqueue({
					id: responseId,
					fromAgent: leadId,
					toAgent: question.from_agent,
					recipientKind: "runner",
					type: "response",
					content: rootPayload.answer,
					refId: questionId,
					createdAt: input.now,
					expiresAt: new Date(
						Date.parse(input.now) + 72 * 60 * 60 * 1000,
					).toISOString(),
					senderRef: encodeSenderRef(input.provenance),
				});
				this.markQuestionTerminalDisposed(questionId);
				const evidence: ProcessedEvidenceV1 = {
					v: 1,
					kind: "lead_routed",
					ref: responseId,
					actor: leadId,
					actor_kind: "lead",
					fence,
					basis: [`question:${questionId}`],
				};
				queue.settle({
					messageOrDeliveryId: rootId,
					event: "processed",
					now: input.now,
					evidence,
				});
				return { kind: "routed", questionId, responseId };
			})
			.immediate();
	}

	private processedFenceFromProvenance(
		provenance?: MessageProvenance,
	): Record<string, string | number> {
		if (
			provenance?.senderGeneration !== null &&
			provenance?.senderGeneration !== undefined
		) {
			return {
				...(provenance.senderLeaseKey
					? { lease_key: provenance.senderLeaseKey }
					: {}),
				lease_generation: provenance.senderGeneration,
			};
		}
		if (provenance?.writerPid !== null && provenance?.writerPid !== undefined) {
			return { writer_pid: provenance.writerPid };
		}
		return { authority: "lead_write_unprotected" };
	}

	private parseFounderRootPayload(encoded: string): {
		msgId: string;
		answer: string;
		projectName: string;
		issueId: string;
		threadId: string;
	} {
		let parsed: unknown;
		try {
			parsed = JSON.parse(encoded);
		} catch {
			throw new Error("founder root content is invalid JSON");
		}
		const value = parsed as Record<string, unknown>;
		for (const field of [
			"msgId",
			"answer",
			"projectName",
			"issueId",
			"threadId",
		]) {
			if (typeof value[field] !== "string" || !value[field].trim()) {
				throw new Error(`founder root content ${field} is invalid`);
			}
		}
		return value as {
			msgId: string;
			answer: string;
			projectName: string;
			issueId: string;
			threadId: string;
		};
	}

	/**
	 * Category-agnostic Lead handle action. The optional business effect, receipt
	 * terminal write, and runner wake share one SQLite transaction; request id +
	 * canonical payload digest makes retries deterministic.
	 */
	handleReceipt(input: HandleReceiptInput): HandleReceiptResult {
		const requestId = input.requestId.trim();
		const receiptId = input.receiptId.trim();
		const authenticatedLead = input.authenticatedLead.trim();
		if (!requestId) throw new Error("requestId is required");
		if (!receiptId) throw new Error("receiptId is required");
		if (!authenticatedLead) throw new Error("authenticatedLead is required");
		assertUtcIsoTimestamp(input.now, "now");
		if (
			!Number.isSafeInteger(input.provenance.senderGeneration) ||
			(input.provenance.senderGeneration ?? 0) <= 0 ||
			!input.provenance.senderLeaseKey?.trim()
		) {
			throw new Error(
				"not_authorized: a valid Lead lease generation is required",
			);
		}
		if (
			(input.action === "relay" || input.action === "respond") &&
			(!input.targetQuestionId?.trim() || !input.content?.trim())
		) {
			throw new Error(`${input.action} requires targetQuestionId and content`);
		}
		const payloadDigest = canonicalSubmissionDigest({
			receiptId,
			action: input.action,
			targetQuestionId: input.targetQuestionId?.trim(),
			content: input.content?.trim(),
			reason: input.reason?.trim(),
		});

		return this.db
			.transaction((): HandleReceiptResult => {
				const existingRequest = this.db
					.prepare(
						`SELECT receipt_id, action, payload_digest, result_json
						   FROM receipt_handle_requests WHERE request_id = ?`,
					)
					.get(requestId) as
					| {
							receipt_id: string;
							action: string;
							payload_digest: string;
							result_json: string;
					  }
					| undefined;
				if (existingRequest) {
					if (
						existingRequest.receipt_id !== receiptId ||
						existingRequest.action !== input.action ||
						existingRequest.payload_digest !== payloadDigest
					) {
						throw new Error(`idempotency_conflict: request ${requestId}`);
					}
					return JSON.parse(existingRequest.result_json) as HandleReceiptResult;
				}

				const queue = new MailboxQueue(this.db);
				const receipt = queue.getById(receiptId);
				if (!receipt) throw new Error(`receipt_not_found: ${receiptId}`);
				if (receipt.to_agent !== authenticatedLead) {
					throw new Error(
						`not_authorized: receipt belongs to ${receipt.to_agent}`,
					);
				}
				if (receipt.state !== "ACKED") {
					throw new Error(`receipt_not_delivered: ${receiptId}`);
				}
				const settlement = queue.getSettlement(receiptId);
				if (settlement?.event === "processed") {
					throw new Error(`already_processed: ${receiptId}`);
				}
				if (settlement?.event === "disposed") {
					throw new Error(`already_disposed: ${receiptId}`);
				}

				let responseId: string | undefined;
				if (input.action === "relay" || input.action === "respond") {
					const questionId = input.targetQuestionId?.trim() as string;
					const question = this.db
						.prepare(
							`SELECT id, from_agent, checkpoint, resolved_at, superseded_at, relay_state
							   FROM mailbox_message_projection WHERE id = ? AND type = 'question'`,
						)
						.get(questionId) as
						| {
								id: string;
								from_agent: string;
								checkpoint: string | null;
								resolved_at: string | null;
								superseded_at: string | null;
								relay_state: string;
						  }
						| undefined;
					if (question?.checkpoint === "approve_to_ship") {
						throw new Error(
							`approve_to_ship_requires_founder_writer: ${questionId}`,
						);
					}
					if (
						!question ||
						question.resolved_at !== null ||
						question.superseded_at !== null ||
						question.relay_state === "terminal_disposed" ||
						this.getResponse(questionId)
					) {
						throw new Error(`business_object_not_pending: ${questionId}`);
					}
					responseId = randomUUID();
					new MailboxQueue(this.db).enqueue({
						id: responseId,
						fromAgent: authenticatedLead,
						toAgent: question.from_agent,
						recipientKind: "runner",
						type: "response",
						content: input.content?.trim() as string,
						refId: questionId,
						createdAt: input.now,
						expiresAt: new Date(
							Date.parse(input.now) + 72 * 60 * 60 * 1000,
						).toISOString(),
						senderRef: encodeSenderRef(input.provenance),
					});
					this.markQuestionTerminalDisposed(questionId);
				}
				if (input.testCrashAfter === "effect") {
					throw new Error("injected receipt handle crash after effect");
				}

				const evidence: ProcessedEvidenceV1 = {
					v: 1,
					kind: `lead_${input.action.replace("-", "_")}`,
					ref: responseId ?? requestId,
					actor: authenticatedLead,
					actor_kind: "lead",
					fence: this.processedFenceFromProvenance(input.provenance),
					...(input.reason?.trim() ? { basis: [input.reason.trim()] } : {}),
				};
				queue.settle({
					messageOrDeliveryId: receiptId,
					event: "processed",
					now: input.now,
					evidence,
				});
				if (input.testCrashAfter === "terminal") {
					throw new Error("injected receipt handle crash after terminal");
				}

				const result: HandleReceiptResult = {
					kind: "handled",
					receiptId,
					action: input.action,
					...(responseId ? { responseId } : {}),
				};
				this.db
					.prepare(
						`INSERT INTO receipt_handle_requests (
						   request_id, receipt_id, action, payload_digest, result_json,
						   created_at
						 ) VALUES (?, ?, ?, ?, ?, ?)`,
					)
					.run(
						requestId,
						receiptId,
						input.action,
						payloadDigest,
						JSON.stringify(result),
						input.now,
					);
				return result;
			})
			.immediate();
	}

	/**
	 * FLY-1392 composite response UOW: the business response, its processed
	 * evidence commit or roll back together; Runner delivery reads the response.
	 */
	respondAndReceipt(input: RespondAndReceiptInput): RespondAndReceiptResult {
		for (const [field, value] of [
			["questionId", input.questionId],
			["fromAgent", input.fromAgent],
			["content", input.content],
			["rootId", input.rootId],
		] as const) {
			if (!value.trim()) throw new Error(`${field} is required`);
		}
		assertUtcIsoTimestamp(input.now, "now");
		if (
			input.evidence.actor_kind === "lead" &&
			input.evidence.actor !== input.fromAgent
		) {
			throw new Error("processed evidence actor must match response author");
		}

		return this.db.transaction(() => {
			if (input.evidence.actor_kind === "bridge-protocol") {
				this.assertCurrentProtocolOwner(input.evidence.fence, input.now);
			}
			const question = this.db
				.prepare(
					`SELECT id, from_agent, checkpoint, relay_state, resolved_at,
					        superseded_at FROM mailbox_message_projection
					 WHERE id = ? AND type = 'question'`,
				)
				.get(input.questionId) as
				| {
						id: string;
						from_agent: string;
						checkpoint: string | null;
						relay_state: string;
						resolved_at: string | null;
						superseded_at: string | null;
				  }
				| undefined;
			if (!question) throw new Error(`Question ${input.questionId} not found`);
			if (question.checkpoint === "approve_to_ship") {
				throw new Error("approve_to_ship requires the trusted founder writer");
			}
			let response = this.getResponse(input.questionId);
			if (!response) {
				const responseId = randomUUID();
				if (
					question.resolved_at !== null ||
					question.superseded_at !== null ||
					question.relay_state === "terminal_disposed"
				) {
					throw new Error(`question ${input.questionId} is no longer open`);
				}
				new MailboxQueue(this.db).enqueue({
					id: responseId,
					fromAgent: input.fromAgent,
					toAgent: question.from_agent,
					recipientKind: "runner",
					type: "response",
					content: input.content,
					refId: input.questionId,
					createdAt: input.now,
					expiresAt: new Date(
						Date.parse(input.now) + 72 * 60 * 60 * 1000,
					).toISOString(),
					senderRef: encodeSenderRef(input.provenance),
				});
				this.markQuestionTerminalDisposed(input.questionId);
				response = this.getResponse(input.questionId);
			}
			if (
				!response ||
				response.from_agent !== input.fromAgent ||
				response.content !== input.content
			) {
				throw new Error(
					`question ${input.questionId} was answered by another actor`,
				);
			}

			const evidence: ProcessedEvidenceV1 = {
				...input.evidence,
				ref: response.id,
			};
			const queue = new MailboxQueue(this.db);
			if (!queue.getById(input.rootId)) {
				throw new Error(`founder receipt root ${input.rootId} is unavailable`);
			}
			queue.settle({
				messageOrDeliveryId: input.rootId,
				event: "processed",
				now: input.now,
				evidence,
			});
			return { responseId: response.id };
		})();
	}

	trustedFounderApprovalAndReceipt(
		input: TrustedFounderApprovalAndReceiptInput,
	): RespondAndReceiptResult {
		assertUtcIsoTimestamp(input.now, "now");
		if (input.evidence.actor_kind !== "founder-writer") {
			throw new Error(
				"trusted founder evidence must use founder-writer actor_kind",
			);
		}
		if (input.evidence.actor !== input.fromAgent) {
			throw new Error(
				"trusted founder evidence actor must match response author",
			);
		}
		return this.db.transaction(() => {
			let response = this.getResponse(input.questionId);
			if (!response) {
				const written = this.insertFounderApprovalResponseWithSource({
					project: input.project,
					sourceEventId: input.sourceEventId,
					questionId: input.questionId,
					fromAgent: input.fromAgent,
					content: input.content,
					expectedOwner: input.expectedOwner,
					payload: input.payload,
					provenance: input.provenance,
				});
				if (!written) {
					throw new Error(
						`founder approval gate ${input.questionId} is not open`,
					);
				}
				response = this.getResponse(input.questionId);
			}
			if (
				!response ||
				response.from_agent !== input.fromAgent ||
				response.content !== input.content
			) {
				throw new Error(
					`founder approval gate ${input.questionId} was answered by another actor`,
				);
			}
			const source = this.db
				.prepare(
					`SELECT kind FROM workflow_source_event
					 WHERE project = ? AND source_event_id = ?`,
				)
				.get(input.project, input.sourceEventId) as
				| { kind: string }
				| undefined;
			if (source?.kind !== "founder_approval") {
				throw new Error("trusted founder authority source is missing");
			}
			const evidence: ProcessedEvidenceV1 = {
				...input.evidence,
				ref: response.id,
			};
			const queue = new MailboxQueue(this.db);
			if (!queue.getById(input.rootId)) {
				throw new Error(`founder receipt root ${input.rootId} is unavailable`);
			}
			queue.settle({
				messageOrDeliveryId: input.rootId,
				event: "processed",
				now: input.now,
				evidence,
			});
			return { responseId: response.id };
		})();
	}

	/** Trusted text/card ship decision + founder receipt + wake intent. */
	trustedFounderGateResponseAndReceipt(
		input: TrustedFounderGateResponseAndReceiptInput,
	): RespondAndReceiptResult {
		assertUtcIsoTimestamp(input.now, "now");
		return this.db
			.transaction(() => {
				const question = this.getMessageById(input.questionId);
				if (
					!question ||
					question.type !== "question" ||
					question.checkpoint !== "approve_to_ship" ||
					question.from_agent !== input.expectedOwner
				) {
					throw new Error(
						`founder ship gate ${input.questionId} is unavailable`,
					);
				}
				let response = this.getResponse(input.questionId);
				if (!response) {
					if (input.approvalSource) {
						const wrote = this.insertFounderApprovalResponseWithSource({
							project: input.approvalSource.project,
							sourceEventId: input.approvalSource.sourceEventId,
							questionId: input.questionId,
							fromAgent: input.fromAgent,
							content: input.content,
							expectedOwner: input.expectedOwner,
							payload: input.approvalSource.payload,
						});
						if (!wrote) {
							throw new Error(
								`founder ship gate ${input.questionId} is not open`,
							);
						}
					} else {
						const write = this.insertResponse(
							input.questionId,
							input.fromAgent,
							input.content,
						);
						if (!write.written) {
							throw new Error(
								`founder ship gate ${input.questionId} is not open`,
							);
						}
					}
					response = this.getResponse(input.questionId);
				}
				if (
					!response ||
					response.from_agent !== input.fromAgent ||
					response.content !== input.content
				) {
					throw new Error(
						`founder ship gate ${input.questionId} was answered by another action`,
					);
				}
				const queue = new MailboxQueue(this.db);
				const root = queue.getById(input.rootId);
				if (!root)
					throw new Error(
						`founder receipt root ${input.rootId} is unavailable`,
					);
				const rootPayload = this.parseFounderRootPayload(root.content);
				if (rootPayload.msgId !== input.msgId) {
					throw new Error("founder ship receipt message mismatch");
				}
				const evidence: ProcessedEvidenceV1 = {
					v: 1,
					kind: "ship_gate_bound",
					ref: response.id,
					actor: input.fromAgent,
					actor_kind: "founder-writer",
					fence: input.approvalSource
						? { source_event_id: input.approvalSource.sourceEventId }
						: { discord_message_id: input.msgId },
					basis: [`question:${input.questionId}`],
				};
				queue.settle({
					messageOrDeliveryId: input.rootId,
					event: "processed",
					now: input.now,
					evidence,
				});
				return { responseId: response.id };
			})
			.immediate();
	}

	/**
	 * Atomically persist an owned review response. Runner delivery consumes the
	 * response row directly, so no second wake record is created.
	 */
	insertReviewResponseIfGateOpen(
		input: ReviewResponseInput,
	): RespondAndReceiptResult | null {
		return this.db
			.transaction((): RespondAndReceiptResult | null => {
				let response = this.getResponse(input.questionId);
				if (response) {
					if (
						response.from_agent !== input.fromAgent ||
						response.content !== input.content
					) {
						return null;
					}
				} else {
					const inserted = this.insertResponseIfGateOpen({
						questionId: input.questionId,
						fromAgent: input.fromAgent,
						content: input.content,
						expectedOwner: input.expectedOwner,
						expectedCheckpoint: input.expectedCheckpoint,
					});
					if (!inserted) {
						response = this.getResponse(input.questionId);
						if (
							!response ||
							response.from_agent !== input.fromAgent ||
							response.content !== input.content
						) {
							return null;
						}
					} else {
						response = this.getResponse(input.questionId);
					}
				}
				if (!response) return null;
				return { responseId: response.id };
			})
			.immediate();
	}

	private assertCurrentProtocolOwner(
		fence: Record<string, string | number>,
		now: string,
	): string {
		const ownerEpoch = fence.owner_epoch;
		if (typeof ownerEpoch !== "string" || !ownerEpoch.trim()) {
			throw new Error("bridge-protocol evidence requires owner_epoch");
		}
		const owner = this.db
			.prepare(
				`SELECT owner_epoch FROM loop_owner
				 WHERE singleton = 1 AND owner_epoch = ? AND lease_expires_at >= ?`,
			)
			.get(ownerEpoch, now) as { owner_epoch: string } | undefined;
		if (!owner) throw new Error("founder protocol owner epoch is not current");
		return owner.owner_epoch;
	}

	/**
	 * GEO-151: best-effort audit row for a ProofShot artifact_emitted event.
	 * Uses `type='progress'` + `content_type='artifact'` since the existing
	 * mailbox_message_projection.type CHECK constraint only allows
	 * ('question','response','instruction','progress') — see schema at top of
	 * file. Attachments stored as JSON-encoded string[] in the `attachments`
	 * column added by the GEO-151 migration above.
	 *
	 * `content` carries a short summary line ("artifact_emitted: N file(s)")
	 * so the audit row is human-readable in `mailbox_message_projection` inspections.
	 *
	 * Caller-side is fail-open: notify command catches throws and continues
	 * (the primary path is POST /events).
	 */
	insertArtifactProgress(
		fromAgent: string,
		toAgent: string,
		paths: string[],
	): string {
		const id = randomUUID();
		const summary = `artifact_emitted: ${paths.length} file(s)`;
		this.db
			.prepare(
				`INSERT INTO mailbox_log
				 (event_id, message_id, event, at, row_json)
				 VALUES (?, ?, 'progress', strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)`,
			)
			.run(
				id,
				id,
				canonicalJsonString({
					from_agent: fromAgent,
					to_agent: toAgent,
					type: "progress",
					content: summary,
					content_type: "artifact",
					attachments: paths,
				}),
			);
		return id;
	}

	getUnreadInstructions(agentId: string): Message[] {
		return this.db
			.prepare(
				`SELECT * FROM mailbox_message_projection
         WHERE to_agent = ? AND type = 'instruction' AND read_at IS NULL
		 AND datetime(expires_at) > datetime('now')
         ORDER BY created_at ASC`,
			)
			.all(agentId) as Message[];
	}

	markInstructionRead(id: string): void {
		new MailboxQueue(this.db).ack(id, new Date().toISOString());
	}

	/**
	 * FLY-1269: durably accept a vendor mailbox envelope before transport ack.
	 * A send envelope binds to its CommDB instruction through
	 * metadata.flywheelId + metadata.execId; queue insert and instruction claim
	 * commit in the same transaction. Existing rows win before source validation
	 * so a callback retry remains acknowledgeable after later message cleanup.
	 */
	enqueueRunnerPhaseWake(
		executionId: string,
		message: PhaseWakeInput,
		nowMs: number,
	): { kind: "queued" | "duplicate"; wake: RunnerPhaseWake } {
		if (!executionId || !message.id || !message.content) {
			throw new Error(
				"phase wake requires executionId, message id, and content",
			);
		}
		const metadataExecId = message.metadata?.execId;
		if (metadataExecId !== undefined && metadataExecId !== executionId) {
			throw new Error(
				`phase wake execId mismatch: expected ${executionId}, got ${String(metadataExecId)}`,
			);
		}
		const flywheelId = message.metadata?.flywheelId;
		const sourceInstructionId =
			typeof flywheelId === "string" && typeof metadataExecId === "string"
				? flywheelId
				: null;
		const metadataJson = message.metadata
			? JSON.stringify(message.metadata)
			: null;

		const enqueue = this.db.transaction(() => {
			const existing = this.db
				.prepare(
					`SELECT * FROM runner_phase_wakes
					 WHERE execution_id = ?
					   AND (message_id = ? OR (? IS NOT NULL AND source_instruction_id = ?))
					 ORDER BY queue_seq ASC LIMIT 1`,
				)
				.get(
					executionId,
					message.id,
					sourceInstructionId,
					sourceInstructionId,
				) as RunnerPhaseWake | undefined;
			if (existing) {
				return { kind: "duplicate" as const, wake: existing };
			}

			if (sourceInstructionId) {
				const instruction = this.db
					.prepare(
						"SELECT id, to_agent, type FROM mailbox_message_projection WHERE id = ?",
					)
					.get(sourceInstructionId) as
					| { id: string; to_agent: string; type: string }
					| undefined;
				if (!instruction || instruction.type !== "instruction") {
					throw new Error(`bound instruction ${sourceInstructionId} not found`);
				}
				if (instruction.to_agent !== executionId) {
					throw new Error(
						`bound instruction ${sourceInstructionId} belongs to ${instruction.to_agent}, not ${executionId}`,
					);
				}
			}

			this.db
				.prepare(
					`INSERT INTO runner_phase_wakes
					   (execution_id, message_id, content, metadata_json,
					    source_instruction_id, state, queued_at, purpose)
					 VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
				)
				.run(
					executionId,
					message.id,
					message.content,
					metadataJson,
					sourceInstructionId,
					nowMs,
					sourceInstructionId ? "message_traffic" : "park_wake",
				);
			if (sourceInstructionId) {
				this.db
					.prepare(
						`UPDATE mailbox SET state = 'ACKED',
						   acked_at = COALESCE(acked_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
						 WHERE id = ? AND to_agent = ? AND type = 'instruction'
						   AND state IN ('QUEUED','LEASED','ACKED')`,
					)
					.run(sourceInstructionId, executionId);
			}
			const wake = this.db
				.prepare(
					"SELECT * FROM runner_phase_wakes WHERE execution_id = ? AND message_id = ?",
				)
				.get(executionId, message.id) as RunnerPhaseWake;
			return { kind: "queued" as const, wake };
		});

		return enqueue();
	}

	listRunnerPhaseWakes(executionId: string): RunnerPhaseWake[] {
		try {
			return this.db
				.prepare(
					"SELECT * FROM runner_phase_wakes WHERE execution_id = ? ORDER BY queue_seq ASC",
				)
				.all(executionId) as RunnerPhaseWake[];
		} catch (error) {
			if (isMissingTableError(error, "runner_phase_wakes")) return [];
			throw error;
		}
	}

	/**
	 * Derive authorized Lead handling or an objective business-terminal disposal
	 * before any reminder is admitted. Receipt category never participates.
	 */
	listPendingRunnerReceiptWakes(limit = 100): RunnerPhaseWake[] {
		if (!Number.isSafeInteger(limit) || limit < 1) {
			throw new Error("wake list limit must be a positive safe integer");
		}
		return this.db
			.prepare(
				`SELECT * FROM runner_phase_wakes
				 WHERE state = 'pending' AND admission_state = 'queued'
				   AND escalation_outbox_id IS NULL
				 ORDER BY queued_at ASC, queue_seq ASC LIMIT ?`,
			)
			.all(limit) as RunnerPhaseWake[];
	}

	listPendingReceiptAlerts(
		kinds: readonly string[],
		limit = 100,
	): ReceiptAlertOutboxRow[] {
		if (kinds.length === 0) return [];
		if (!Number.isSafeInteger(limit) || limit <= 0) {
			throw new Error("alert limit must be a positive safe integer");
		}
		const placeholders = kinds.map(() => "?").join(",");
		return this.db
			.prepare(
				`SELECT * FROM receipt_alert_outbox
				  WHERE delivered_at IS NULL AND canceled_at IS NULL
				    AND kind IN (${placeholders})
				  ORDER BY created_at, id LIMIT ?`,
			)
			.all(...kinds, limit) as ReceiptAlertOutboxRow[];
	}

	findPendingRunnerReceiptWakeForQuestion(
		executionId: string,
		questionId: string,
	): RunnerPhaseWake | undefined {
		return [...this.listRunnerPhaseWakes(executionId)]
			.reverse()
			.find((wake) => {
				if (wake.state !== "pending" || !wake.envelope_json) return false;
				try {
					const envelope = JSON.parse(wake.envelope_json) as {
						metadata?: { questionId?: unknown };
					};
					return envelope.metadata?.questionId === questionId;
				} catch {
					return false;
				}
			});
	}

	/**
	 * FLY-1392: reserve a mailbox push before performing transport I/O. The
	 * attempt ordinal is consumed in this transaction and is never refunded,
	 * including when the process crashes before completion.
	 */
	claimRunnerReceiptWakePush(
		executionId: string,
		messageId: string,
		nowMs: number,
		options: { t1Ms: number; claimTtlMs: number },
	): RunnerReceiptWakePushClaim | null {
		for (const [field, value] of [
			["nowMs", nowMs],
			["t1Ms", options.t1Ms],
			["claimTtlMs", options.claimTtlMs],
		] as const) {
			if (!Number.isSafeInteger(value) || value < 0) {
				throw new Error(`${field} must be a non-negative safe integer`);
			}
		}
		const claim = this.db.transaction((): RunnerReceiptWakePushClaim | null => {
			const wake = this.db
				.prepare(
					`SELECT * FROM runner_phase_wakes
					 WHERE execution_id = ? AND message_id = ?`,
				)
				.get(executionId, messageId) as RunnerPhaseWake | undefined;
			if (
				!wake ||
				wake.state !== "pending" ||
				wake.admission_state !== "queued" ||
				wake.push_attempts >= 2 ||
				!wake.envelope_json
			) {
				return null;
			}
			const claimExpiresAtMs = wake.claim_expires_at
				? Date.parse(wake.claim_expires_at)
				: Number.NaN;
			if (
				wake.claim_token &&
				Number.isFinite(claimExpiresAtMs) &&
				claimExpiresAtMs > nowMs
			) {
				return null;
			}
			const lastPushAtMs = wake.last_push_at
				? Date.parse(wake.last_push_at)
				: Number.NaN;
			if (
				wake.push_attempts > 0 &&
				Number.isFinite(lastPushAtMs) &&
				nowMs - lastPushAtMs < options.t1Ms
			) {
				return null;
			}

			const attempt = wake.push_attempts + 1;
			const claimToken = randomUUID();
			const updated = this.db
				.prepare(
					`UPDATE runner_phase_wakes
					 SET push_attempts = ?, claim_token = ?, claim_expires_at = ?,
					     last_push_at = ?, last_push_result = ?
					 WHERE execution_id = ? AND message_id = ?
					   AND state = 'pending' AND admission_state = 'queued'
					   AND push_attempts = ?`,
				)
				.run(
					attempt,
					claimToken,
					new Date(nowMs + options.claimTtlMs).toISOString(),
					new Date(nowMs).toISOString(),
					`attempt:${attempt}:claimed`,
					executionId,
					messageId,
					wake.push_attempts,
				);
			if (updated.changes !== 1) return null;
			const claimedWake = this.db
				.prepare(
					"SELECT * FROM runner_phase_wakes WHERE execution_id = ? AND message_id = ?",
				)
				.get(executionId, messageId) as RunnerPhaseWake;
			return {
				wake: claimedWake,
				claimToken,
				attempt,
				envelope: JSON.parse(claimedWake.envelope_json!) as PhaseWakeInput,
			};
		});
		return claim.immediate();
	}

	completeRunnerReceiptWakePush(input: {
		executionId: string;
		messageId: string;
		claimToken: string;
		attempt: number;
		result: string;
		nowMs: number;
	}): boolean {
		if (!input.result.trim()) throw new Error("push result is required");
		const updated = this.db
			.prepare(
				`UPDATE runner_phase_wakes
					 SET last_push_result = ?, claim_token = NULL, claim_expires_at = NULL
					 WHERE execution_id = ? AND message_id = ?
					   AND claim_token = ? AND push_attempts = ?`,
			)
			.run(
				`attempt:${input.attempt}:${input.result}`,
				input.executionId,
				input.messageId,
				input.claimToken,
				input.attempt,
			).changes;
		if (updated === 1) return true;
		if (input.result === "verified" || input.result === "delivered") {
			const staleFact = `attempt:${input.attempt}:stale_${input.result}`;
			this.db
				.prepare(
					`UPDATE runner_phase_wakes
					 SET last_push_result = CASE
					   WHEN instr(COALESCE(last_push_result, ''), ?) > 0
					     THEN last_push_result
					   ELSE COALESCE(last_push_result || '|', '') || ?
					 END
					 WHERE execution_id = ? AND message_id = ?`,
				)
				.run(staleFact, staleFact, input.executionId, input.messageId);
		}
		return false;
	}

	/** Exec-level objective acknowledgement, bounded by command-entry time. */
	ackRunnerReceiptWakesStarted(
		executionId: string,
		observedAtMs: number,
		ackScope: "exec_cli" | "debug_override" = "exec_cli",
	): number {
		if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
			throw new Error("observedAtMs must be a non-negative safe integer");
		}
		return this.db
			.prepare(
				`UPDATE runner_phase_wakes
				 SET state = 'started', started_at = ?, started_ack_scope = ?,
				     claim_token = NULL, claim_expires_at = NULL
				 WHERE execution_id = ? AND state = 'pending'
				   AND admission_state = 'queued'
				   AND purpose = 'message_traffic' AND queued_at <= ?`,
			)
			.run(observedAtMs, ackScope, executionId, observedAtMs).changes;
	}

	/**
	 * Normal Lead traffic to an already-live, non-parked runner is observable
	 * without a phase-start receipt. Retire only the exact pending wake; legacy
	 * NULL-purpose rows deliberately retain the old recovery ladder.
	 */
	disposeRunnerPhaseWakePending(
		executionId: string,
		messageId: string,
		nowMs: number,
	): boolean {
		return (
			this.db
				.prepare(
					`UPDATE runner_phase_wakes
					    SET state = 'finished', finished_at = ?,
					        started_ack_scope = 'normal_traffic',
					        claim_token = NULL, claim_expires_at = NULL
					  WHERE execution_id = ? AND message_id = ?
					    AND state = 'pending'
					    AND purpose = 'message_traffic'`,
				)
				.run(nowMs, executionId, messageId).changes === 1
		);
	}

	/**
	 * FLY-1374: a terminal execution cannot consume a wake. Retire the durable
	 * intent at this write boundary instead of manufacturing a wake-failure
	 * incident for an already-finished runner.
	 */
	disposeRunnerPhaseWakeForTerminal(
		executionId: string,
		messageId: string,
		nowMs: number,
	): boolean {
		return (
			this.db
				.prepare(
					`UPDATE runner_phase_wakes
					    SET state = 'finished', finished_at = ?,
					        last_push_result = 'disposed:terminal_target',
					        claim_token = NULL, claim_expires_at = NULL
					  WHERE execution_id = ? AND message_id = ?
					    AND state = 'pending'`,
				)
				.run(nowMs, executionId, messageId).changes === 1
		);
	}

	claimRunnerReceiptWakeT2(
		executionId: string,
		messageId: string,
		nowMs: number,
		t2Ms: number,
	): RunnerPhaseWake | null {
		const claimedAt = new Date(nowMs).toISOString();
		const claim = this.db.transaction(() => {
			const updated = this.db
				.prepare(
					`UPDATE runner_phase_wakes SET t2_claimed_at = ?
					 WHERE execution_id = ? AND message_id = ?
					   AND state = 'pending' AND admission_state = 'queued'
					   AND t2_claimed_at IS NULL AND queued_at <= ?`,
				)
				.run(claimedAt, executionId, messageId, nowMs - t2Ms);
			if (updated.changes !== 1) return null;
			return this.db
				.prepare(
					"SELECT * FROM runner_phase_wakes WHERE execution_id = ? AND message_id = ?",
				)
				.get(executionId, messageId) as RunnerPhaseWake;
		});
		return claim.immediate();
	}

	completeRunnerReceiptWakeT2(
		executionId: string,
		messageId: string,
		result: string,
	): boolean {
		if (!result.trim()) throw new Error("T2 result is required");
		return (
			this.db
				.prepare(
					`UPDATE runner_phase_wakes SET t2_result = ?
					 WHERE execution_id = ? AND message_id = ?
					   AND t2_claimed_at IS NOT NULL AND t2_result IS NULL`,
				)
				.run(result, executionId, messageId).changes === 1
		);
	}

	/**
	 * FLY-1448: atomically retire a wake that can no longer start and create
	 * the durable alert identity that explains why. Ordinary wakes coalesce by
	 * one continuous terminal lifecycle; founder-origin decisions deliberately
	 * stay message-scoped so no founder action can disappear behind an older
	 * episode.
	 */
	completeRunnerPhaseWakeTerminal(input: {
		executionId: string;
		messageId: string;
		reason: string;
		terminalLifecycleId: string;
		nowMs: number;
	}): TerminalWakeCompletion | null {
		if (!input.reason.trim())
			throw new Error("terminal wake completion reason is required");
		if (!input.terminalLifecycleId.trim()) {
			throw new Error("terminal lifecycle id is required");
		}
		if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
			throw new Error("nowMs must be a non-negative safe integer");
		}
		const complete = this.db.transaction((): TerminalWakeCompletion | null => {
			const wake = this.db
				.prepare(
					`SELECT * FROM runner_phase_wakes
					  WHERE execution_id = ? AND message_id = ?`,
				)
				.get(input.executionId, input.messageId) as RunnerPhaseWake | undefined;
			if (!wake || wake.state !== "pending") {
				return null;
			}
			const founderOrigin = runnerWakeMetadata(wake).origin === "founder";
			if (wake.escalation_outbox_id && !founderOrigin) {
				return null;
			}
			if (wake.admission_state !== "queued" && !founderOrigin) {
				return null;
			}
			const existingAlert = wake.escalation_outbox_id
				? this.getReceiptAlertOutbox(wake.escalation_outbox_id)
				: undefined;
			let preservedAlertPayload: Record<string, unknown> = {};
			if (existingAlert?.kind === "wake_failed") {
				try {
					const parsed = JSON.parse(existingAlert.payload) as unknown;
					if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
						preservedAlertPayload = parsed as Record<string, unknown>;
					}
				} catch {
					// The terminal identity below replaces malformed payload evidence.
				}
			}

			const now = new Date(input.nowMs).toISOString();
			let identityKind: TerminalWakeCompletion["identityKind"];
			let episodeFingerprint: string;
			let outboxId: string;
			let generation: number | undefined;
			let openEpisode: RunnerWakeFailureEpisode | undefined;
			if (founderOrigin) {
				identityKind = "founder_message";
				episodeFingerprint = `founder:${input.executionId}:${input.messageId}`;
				outboxId =
					existingAlert?.kind === "wake_failed"
						? existingAlert.id
						: `wake_failed:founder:${input.messageId}`;
			} else {
				identityKind = "terminal_episode";
				episodeFingerprint = `terminal:${input.executionId}:${input.terminalLifecycleId}`;
				openEpisode = this.db
					.prepare(
						`SELECT * FROM runner_wake_failure_episode
						  WHERE execution_id = ? AND category = 'terminal'
						    AND closed_at IS NULL`,
					)
					.get(input.executionId) as RunnerWakeFailureEpisode | undefined;
				if (openEpisode?.terminal_lifecycle_id === input.terminalLifecycleId) {
					generation = openEpisode.generation;
				} else {
					generation = (
						this.db
							.prepare(
								`SELECT COALESCE(MAX(generation), 0) + 1 AS generation
									   FROM runner_wake_failure_episode
									  WHERE execution_id = ? AND category = 'terminal'`,
							)
							.get(input.executionId) as { generation: number }
					).generation;
				}
				outboxId = `wake_failed:terminal:${input.executionId}:${generation}`;
			}

			const retired = this.db
				.prepare(
					`UPDATE runner_phase_wakes
					    SET state = 'finished', finished_at = ?,
					        started_ack_scope = 'terminal',
					        escalation_outbox_id = ?,
					        claim_token = NULL, claim_expires_at = NULL
						  WHERE execution_id = ? AND message_id = ?
						    AND state = 'pending'
						    AND (admission_state = 'queued' OR ? = 1)
						    AND escalation_outbox_id IS ?`,
				)
				.run(
					input.nowMs,
					outboxId,
					input.executionId,
					input.messageId,
					founderOrigin ? 1 : 0,
					wake.escalation_outbox_id,
				);
			if (retired.changes !== 1) return null;

			if (identityKind === "terminal_episode") {
				if (
					openEpisode &&
					openEpisode.terminal_lifecycle_id !== input.terminalLifecycleId
				) {
					this.db
						.prepare(
							`UPDATE runner_wake_failure_episode
							    SET closed_at = ?
							  WHERE execution_id = ? AND category = 'terminal'
							    AND generation = ? AND closed_at IS NULL`,
						)
						.run(now, input.executionId, openEpisode.generation);
				}
				if (
					!openEpisode ||
					openEpisode.terminal_lifecycle_id !== input.terminalLifecycleId
				) {
					this.db
						.prepare(
							`INSERT INTO runner_wake_failure_episode
							   (execution_id, category, generation, terminal_lifecycle_id,
							    opened_at, last_message_id)
							 VALUES (?, 'terminal', ?, ?, ?, ?)`,
						)
						.run(
							input.executionId,
							generation,
							input.terminalLifecycleId,
							now,
							input.messageId,
						);
				} else {
					this.db
						.prepare(
							`UPDATE runner_wake_failure_episode
							    SET last_message_id = ?
							  WHERE execution_id = ? AND category = 'terminal'
							    AND generation = ?`,
						)
						.run(input.messageId, input.executionId, generation);
				}
			}

			const alertPayload = JSON.stringify({
				...preservedAlertPayload,
				executionId: input.executionId,
				messageId: input.messageId,
				reason: input.reason,
				identityKind,
				episodeFingerprint,
				terminalLifecycleId: input.terminalLifecycleId,
				...(generation !== undefined ? { generation } : {}),
			});
			this.db
				.prepare(
					`INSERT INTO receipt_alert_outbox
					   (id, kind, payload, created_at)
					 VALUES (?, 'wake_failed', ?, ?)
					 ON CONFLICT(id) DO UPDATE SET
					   payload = excluded.payload,
					   canceled_at = CASE
					     WHEN receipt_alert_outbox.delivered_at IS NULL THEN NULL
					     ELSE receipt_alert_outbox.canceled_at
					   END,
					   cancel_reason = CASE
					     WHEN receipt_alert_outbox.delivered_at IS NULL THEN NULL
					     ELSE receipt_alert_outbox.cancel_reason
					   END
					 WHERE receipt_alert_outbox.kind = 'wake_failed'`,
				)
				.run(outboxId, alertPayload, now);
			const completedWake = this.db
				.prepare(
					"SELECT * FROM runner_phase_wakes WHERE execution_id = ? AND message_id = ?",
				)
				.get(input.executionId, input.messageId) as RunnerPhaseWake;
			const alert = this.getReceiptAlertOutbox(outboxId);
			if (!alert || alert.kind !== "wake_failed") {
				throw new Error("terminal wake alert outbox was not created");
			}
			return { wake: completedWake, alert, identityKind, episodeFingerprint };
		});
		return complete.immediate();
	}

	listRunnerWakeFailureEpisodes(
		executionId: string,
		category?: RunnerWakeFailureEpisode["category"],
	): RunnerWakeFailureEpisode[] {
		return (
			category
				? this.db
						.prepare(
							`SELECT * FROM runner_wake_failure_episode
						  WHERE execution_id = ? AND category = ?
						  ORDER BY generation`,
						)
						.all(executionId, category)
				: this.db
						.prepare(
							`SELECT * FROM runner_wake_failure_episode
						  WHERE execution_id = ?
						  ORDER BY category, generation`,
						)
						.all(executionId)
		) as RunnerWakeFailureEpisode[];
	}

	enqueueRunnerReceiptWakeEscalation(input: {
		executionId: string;
		messageId: string;
		reason: string;
		firstDetectedAtMs: number;
		nowMs: number;
	}): ReceiptAlertOutboxRow | null {
		if (!input.reason.trim())
			throw new Error("wake escalation reason is required");
		if (
			!Number.isSafeInteger(input.firstDetectedAtMs) ||
			input.firstDetectedAtMs < 0
		) {
			throw new Error("firstDetectedAtMs must be a non-negative safe integer");
		}
		const enqueue = this.db.transaction(() => {
			const wake = this.db
				.prepare(
					`SELECT * FROM runner_phase_wakes
					 WHERE execution_id = ? AND message_id = ?`,
				)
				.get(input.executionId, input.messageId) as RunnerPhaseWake | undefined;
			if (!wake || wake.state !== "pending") return null;
			const id = `wake_failed:${input.messageId}`;
			this.db
				.prepare(
					`INSERT OR IGNORE INTO receipt_alert_outbox
					 (id, kind, payload, created_at)
					 VALUES (?, 'wake_failed', ?, ?)`,
				)
				.run(
					id,
					JSON.stringify({
						executionId: input.executionId,
						messageId: input.messageId,
						reason: input.reason,
						firstDetectedAtMs: input.firstDetectedAtMs,
					}),
					new Date(input.nowMs).toISOString(),
				);
			this.db
				.prepare(
					`UPDATE runner_phase_wakes SET escalation_outbox_id = ?
					 WHERE execution_id = ? AND message_id = ?
					   AND state = 'pending' AND escalation_outbox_id IS NULL`,
				)
				.run(id, input.executionId, input.messageId);
			return this.getReceiptAlertOutbox(id) ?? null;
		});
		return enqueue.immediate();
	}

	/**
	 * The first still-open failed wake defines the episode. Later mailbox_message_projection for
	 * the same execution reuse this timestamp; once receipts move every member
	 * out of pending, the next failure naturally starts a new episode.
	 */
	getRunnerWakeFailureEpisodeStartedAt(executionId: string): number | null {
		const row = this.db
			.prepare(
				`SELECT MIN(queued_at) AS started_at
				   FROM runner_phase_wakes
				  WHERE execution_id = ?
				    AND state = 'pending'
				    AND escalation_outbox_id IS NOT NULL`,
			)
			.get(executionId) as { started_at: number | null };
		return row.started_at;
	}

	getReceiptAlertOutbox(id: string): ReceiptAlertOutboxRow | undefined {
		return this.db
			.prepare("SELECT * FROM receipt_alert_outbox WHERE id = ?")
			.get(id) as ReceiptAlertOutboxRow | undefined;
	}

	/** Revalidate immediately before any external receipt notification effect. */
	revalidateReceiptAlert(
		outboxId: string,
		nowMs: number,
	): ReceiptAlertOutboxRow | null {
		const check = this.db.transaction(() => {
			const alert = this.getReceiptAlertOutbox(outboxId);
			if (!alert || alert.delivered_at || alert.canceled_at) return null;
			if (alert.kind !== "wake_failed") return alert;
			let payload: {
				executionId?: string;
				messageId?: string;
				identityKind?: string;
				terminalLifecycleId?: string;
				generation?: number;
			};
			try {
				payload = JSON.parse(alert.payload) as typeof payload;
			} catch {
				return alert;
			}
			if (
				typeof payload.executionId !== "string" ||
				typeof payload.messageId !== "string"
			) {
				return alert;
			}
			if (payload.identityKind === "terminal_episode") {
				if (
					typeof payload.terminalLifecycleId !== "string" ||
					typeof payload.generation !== "number"
				) {
					return alert;
				}
				const episode = this.db
					.prepare(
						`SELECT 1 FROM runner_wake_failure_episode
						  WHERE execution_id = ? AND category = 'terminal'
						    AND generation = ? AND terminal_lifecycle_id = ?`,
					)
					.get(
						payload.executionId,
						payload.generation,
						payload.terminalLifecycleId,
					) as { 1: number } | undefined;
				return episode ? alert : null;
			}
			if (
				payload.identityKind === "founder_message" &&
				typeof payload.messageId === "string"
			) {
				const founderWake = this.db
					.prepare(
						`SELECT 1 FROM runner_phase_wakes
						  WHERE execution_id = ? AND message_id = ?
						    AND state = 'finished' AND started_ack_scope = 'terminal'
						    AND escalation_outbox_id = ?`,
					)
					.get(payload.executionId, payload.messageId, outboxId) as
					| { 1: number }
					| undefined;
				return founderWake ? alert : null;
			}
			const live = this.db
				.prepare(
					`SELECT 1 FROM runner_phase_wakes
						 WHERE execution_id = ? AND message_id = ?
						   AND state = 'pending' AND escalation_outbox_id = ?`,
				)
				.get(payload.executionId, payload.messageId, outboxId) as
				| { 1: number }
				| undefined;
			if (!live) {
				this.db
					.prepare(
						`UPDATE receipt_alert_outbox
						 SET canceled_at = ?, cancel_reason = 'source_no_longer_pending'
						 WHERE id = ? AND delivered_at IS NULL AND canceled_at IS NULL`,
					)
					.run(new Date(nowMs).toISOString(), outboxId);
				return null;
			}
			return alert;
		});
		return check.immediate();
	}

	/** Compatibility name retained for the runner-wake patrol. */
	revalidateRunnerReceiptWakeAlert(
		outboxId: string,
		nowMs: number,
	): ReceiptAlertOutboxRow | null {
		return this.revalidateReceiptAlert(outboxId, nowMs);
	}

	markReceiptAlertDelivered(outboxId: string, nowMs: number): boolean {
		return (
			this.db
				.prepare(
					`UPDATE receipt_alert_outbox SET delivered_at = ?
					 WHERE id = ? AND delivered_at IS NULL AND canceled_at IS NULL`,
				)
				.run(new Date(nowMs).toISOString(), outboxId).changes === 1
		);
	}

	markRunnerPhaseWakeStarted(
		executionId: string,
		messageId: string,
		nowMs: number,
	): boolean {
		return (
			this.db
				.prepare(
					`UPDATE runner_phase_wakes SET state = 'started', started_at = ?,
					 started_ack_scope = 'message'
					 WHERE execution_id = ? AND message_id = ? AND state = 'pending'`,
				)
				.run(nowMs, executionId, messageId).changes === 1
		);
	}

	finishRunnerPhaseWake(
		executionId: string,
		messageId: string,
		nowMs: number,
	): boolean {
		return (
			this.db
				.prepare(
					`UPDATE runner_phase_wakes SET state = 'finished', finished_at = ?
					 WHERE execution_id = ? AND message_id = ? AND state = 'started'`,
				)
				.run(nowMs, executionId, messageId).changes === 1
		);
	}

	requestRunnerShutdown(
		executionId: string,
		requestId: string,
		nowMs: number,
	): RunnerShutdownControl {
		if (!executionId || !requestId) {
			throw new Error("runner shutdown requires executionId and requestId");
		}
		const request = this.db.transaction(() => {
			this.db
				.prepare(
					`INSERT OR IGNORE INTO runner_shutdown_controls
					   (execution_id, request_id, state, requested_at)
					 VALUES (?, ?, 'requested', ?)`,
				)
				.run(executionId, requestId, nowMs);
			const row = this.db
				.prepare(
					"SELECT * FROM runner_shutdown_controls WHERE execution_id = ?",
				)
				.get(executionId) as RunnerShutdownControl | undefined;
			if (!row) {
				throw new Error(
					`shutdown request id ${requestId} is already bound to another execution`,
				);
			}
			return row;
		});
		return request();
	}

	getRunnerShutdown(executionId: string): RunnerShutdownControl | null {
		try {
			return (
				(this.db
					.prepare(
						"SELECT * FROM runner_shutdown_controls WHERE execution_id = ?",
					)
					.get(executionId) as RunnerShutdownControl | undefined) ?? null
			);
		} catch (error) {
			if (isMissingTableError(error, "runner_shutdown_controls")) return null;
			throw error;
		}
	}

	finishRunnerShutdown(
		executionId: string,
		requestId: string,
		result: { ok: true } | { ok: false; error: string },
		nowMs: number,
	): boolean {
		return (
			this.db
				.prepare(
					`UPDATE runner_shutdown_controls
					 SET state = ?, finished_at = ?, error = ?
					 WHERE execution_id = ? AND request_id = ? AND state = 'requested'`,
				)
				.run(
					result.ok ? "acked" : "failed",
					nowMs,
					result.ok ? null : result.error,
					executionId,
					requestId,
				).changes === 1
		);
	}

	// ── FLY-109: push-path helpers (at-least-once via delivered_at + explicit ack) ──
	//
	// These are push-only helpers used by inbox-mcp's poll → channel notification loop.
	// The CLI pull path (packages/flywheel-comm/src/commands/inbox.ts) continues to use
	// getUnreadInstructions()/markInstructionRead() — its semantics are NOT changed.
	//
	// State machine:
	//   inserted         → delivered_at=NULL, read_at=NULL  → returned by getPendingPushInstructions
	//   markDelivered()  → delivered_at=now,  read_at=NULL  → hidden within retry window
	//   (retry window expires) → re-surfaces in getPendingPushInstructions
	//   ackRead()        → read_at=now (idempotent)         → hidden permanently
	//
	// retry_window_sec is provided by the caller (inbox-mcp via FLYWHEEL_INBOX_RETRY_WINDOW_SEC).

	getPendingPushInstructions(
		agentId: string,
		retryWindowSec: number,
	): Message[] {
		return this.db
			.prepare(
				`SELECT * FROM mailbox_message_projection
         WHERE to_agent = ? AND type = 'instruction' AND read_at IS NULL
         AND (delivered_at IS NULL
              OR datetime(delivered_at) < datetime('now', '-' || ? || ' seconds'))
		 AND datetime(expires_at) > datetime('now')
         ORDER BY created_at ASC`,
			)
			.all(agentId, retryWindowSec) as Message[];
	}

	markInstructionDelivered(id: string): void {
		this.db
			.prepare(
				`UPDATE mailbox SET state = 'LEASED', claimed_by = 'legacy-push',
				 claim_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
				 WHERE id = ? AND type = 'instruction' AND state = 'QUEUED'`,
			)
			.run(id);
	}

	/**
	 * The only consuming read for a gate response. Internal probes continue to
	 * use getResponse(), which is intentionally pure. Consumption ACKs the
	 * canonical mailbox response; there is no secondary wake record.
	 */
	consumeGateResponse(
		questionId: string,
		executionId: string,
	): Message | undefined {
		const consume = this.db.transaction(() => {
			const response = this.db
				.prepare(
					`SELECT response.*
					   FROM mailbox_message_projection response
					   JOIN mailbox_message_projection question ON question.id = response.parent_id
					  WHERE question.id = ? AND question.type = 'question'
					    AND question.from_agent = ?
					    AND response.type = 'response'`,
				)
				.get(questionId, executionId) as Message | undefined;
			if (!response) return undefined;
			new MailboxQueue(this.db).ack(response.id, new Date().toISOString());
			return this.db
				.prepare("SELECT * FROM mailbox_message_projection WHERE id = ?")
				.get(response.id) as Message;
		});
		return consume.immediate();
	}

	/**
	 * Idempotent ack — only sets read_at if not already set.
	 * Called by inbox-mcp's flywheel_inbox_ack tool when the Lead model explicitly
	 * confirms it has processed a message. No-op for unknown ids.
	 */
	ackInstructionRead(id: string): void {
		new MailboxQueue(this.db).ack(id, new Date().toISOString());
	}

	// ── Dynamic Timeout (Phase 2) ──

	hasPendingQuestionsFrom(execId: string): boolean {
		const answerable = commDbProtectionEnabled()
			? "q.relay_state != 'terminal_disposed'"
			: "datetime(q.expires_at) > datetime('now')";
		const row = this.db
			.prepare(
				`SELECT COUNT(*) as cnt FROM mailbox_message_projection q
         WHERE q.from_agent = ? AND q.type = 'question'
         AND NOT EXISTS (
           SELECT 1 FROM mailbox_message_projection r WHERE r.parent_id = q.id AND r.type = 'response'
         )
		 AND ${answerable}`,
			)
			.get(execId) as { cnt: number };
		return row.cnt > 0;
	}

	/**
	 * FLY-818: true if this execution has an unanswered BLOCKING gate/question
	 * (`checkpoint IS NOT NULL`). A blocking `gate` command carries a checkpoint;
	 * a non-blocking `flywheel-comm ask` has `checkpoint = NULL`. The auto-continue
	 * armer uses THIS (not `hasPendingQuestionsFrom`) so a runner that fired a
	 * non-blocking ask still gets armed to self-continue (Codex code review R1 #2 —
	 * asks must not stop the loop). Stuck detection keeps the broad predicate.
	 */
	hasPendingBlockingGateFrom(execId: string): boolean {
		const answerable = commDbProtectionEnabled()
			? "q.relay_state != 'terminal_disposed'"
			: "datetime(q.expires_at) > datetime('now')";
		const row = this.db
			.prepare(
				`SELECT COUNT(*) as cnt FROM mailbox_message_projection q
         WHERE q.from_agent = ? AND q.type = 'question'
         AND q.checkpoint IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM mailbox_message_projection r WHERE r.parent_id = q.id AND r.type = 'response'
         )
		 AND ${answerable}`,
			)
			.get(execId) as { cnt: number };
		return row.cnt > 0;
	}

	/**
	 * FLY-253 (L1): True if this execution sent ANY CommDB message within the
	 * last `windowSeconds`. Liveness signal for the Bridge stuck-runner
	 * detector — a runner that recently messaged its Lead (DONE report,
	 * instruction receipt, question) is alive, however static its pane looks.
	 *
	 * The comparison stays entirely in SQLite's UTC clock domain by normalizing
	 * the ISO-Z mailbox timestamp with `datetime(created_at)`. Strict `>`: a message
	 * exactly at the window edge is outside.
	 */
	hasRecentMessagesFrom(execId: string, windowSeconds: number): boolean {
		const seconds = Math.max(0, Math.floor(windowSeconds));
		const row = this.db
			.prepare(
				`SELECT 1 as hit FROM mailbox_message_projection
         WHERE from_agent = ?
         AND datetime(created_at) > datetime('now', '-' || ? || ' seconds')
         LIMIT 1`,
			)
			.get(execId, seconds) as { hit: number } | undefined;
		return row !== undefined;
	}

	/**
	 * Monotonic, execution-bound activity cursor. Dead-execution tripwires take a
	 * baseline count at replacement time and alert only when this exact sender's
	 * count advances; no wall-clock parsing or shared-worktree attribution.
	 */
	countMessagesFrom(execId: string): number {
		const row = this.db
			.prepare(
				"SELECT COUNT(*) AS count FROM mailbox_message_projection WHERE from_agent = ?",
			)
			.get(execId) as { count: number };
		return Number(row.count);
	}

	// ── FLY-626: Runner self-declared state (park / busy / unpark) ──

	/**
	 * FLY-626: Upsert a runner's self-declared liveness marker. `expiresAtMs` null
	 * means indefinite (only valid for `parked`; `long_task` is always bounded by
	 * the caller). All timestamps are epoch ms (Codex R2 LOW #3). REPLACE so a
	 * re-declaration (park→busy, renew) atomically supersedes the prior row.
	 */
	upsertDeclaredState(
		execId: string,
		kind: "parked" | "long_task",
		reason: string | null,
		nowMs: number,
		expiresAtMs: number | null,
	): void {
		this.db
			.prepare(
				`INSERT INTO runner_declared_states
           (execution_id, kind, reason, created_at, expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(execution_id) DO UPDATE SET
           kind = excluded.kind,
           reason = excluded.reason,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`,
			)
			.run(execId, kind, reason, nowMs, expiresAtMs, nowMs);
	}

	/** FLY-626: Remove a runner's self-declared marker (`unpark` or Lead re-engagement). */
	clearDeclaredState(execId: string): void {
		this.db
			.prepare("DELETE FROM runner_declared_states WHERE execution_id = ?")
			.run(execId);
	}

	/**
	 * FLY-626: Return the runner's CURRENTLY-EFFECTIVE declared state, or null.
	 * A marker with `expires_at` <= nowMs (strict) is treated as expired → null.
	 *
	 * Readonly-tolerant (Codex R1 #5 / R2 #3): the Bridge reads via
	 * `CommDB.openReadonly()`, which skips schema creation — a DB whose writer
	 * never created this table yields "no such table". That must read as
	 * "no marker", never throw. Any other error propagates.
	 */
	getEffectiveDeclaredState(
		execId: string,
		nowMs: number,
	): RunnerDeclaredState | null {
		let row: RunnerDeclaredState | undefined;
		try {
			row = this.db
				.prepare(
					`SELECT execution_id, kind, reason, created_at, expires_at, updated_at
           FROM runner_declared_states WHERE execution_id = ?`,
				)
				.get(execId) as RunnerDeclaredState | undefined;
		} catch (err) {
			if (
				/no such table: runner_declared_states/i.test((err as Error).message)
			) {
				return null;
			}
			throw err;
		}
		if (!row) return null;
		if (row.expires_at !== null && row.expires_at <= nowMs) return null;
		return row;
	}

	// ── FLY-887: three-stage TURN (single-writer exclusive worktree activation) ──

	/**
	 * FLY-887: grant the shared-worktree TURN for `issueId` to `holderExecId`
	 * (phase = design|implement|qa). Bridge is the ONLY caller. Overwrites any
	 * prior holder and monotonically increments `epoch` so a late/duplicated wake
	 * carrying a stale epoch is recognizable. A fresh grant starts at epoch 1.
	 * `grantedAtMs` is epoch milliseconds (injected clock).
	 */
	grantTurn(
		issueId: string,
		holderExecId: string,
		phase: string,
		grantedAtMs: number,
		source?: {
			project: string;
			sourceEventId: string;
			/** Server-derived workflow run ownership; absent preserves legacy null. */
			targetRunId?: string;
			activation?: {
				activationId: string;
				runId: string;
				nodeId: string;
				attempt: number;
				outputCredential?: string;
				submissionCredential?: string;
				context: unknown;
			};
		},
	): number {
		if (source) {
			const activation = source.activation;
			const targetRunId = activation?.runId ?? source.targetRunId ?? null;
			if (targetRunId !== null && targetRunId.trim().length === 0) {
				throw new Error("targetRunId must be non-empty when provided");
			}
			if (
				activation &&
				source.targetRunId !== undefined &&
				source.targetRunId !== activation.runId
			) {
				throw new Error("activation runId must match targetRunId");
			}
			if (
				activation &&
				(!activation.activationId.trim() ||
					!activation.runId.trim() ||
					!activation.nodeId.trim() ||
					!Number.isInteger(activation.attempt) ||
					activation.attempt < 1)
			) {
				throw new Error("invalid workflow TURN activation");
			}
			const contextJson = activation
				? canonicalJsonString(activation.context)
				: null;
			const contextDigest = activation
				? canonicalSubmissionDigest(activation.context)
				: null;
			return this.db.transaction(() => {
				const priorSource = this.db
					.prepare(
						`SELECT project, payload FROM workflow_source_event
						  WHERE project = ? AND source_event_id = ?`,
					)
					.get(source.project, source.sourceEventId) as
					| { project: string; payload: string }
					| undefined;
				if (priorSource) {
					const frozen = JSON.parse(priorSource.payload) as Record<
						string,
						unknown
					>;
					if (
						frozen.issue_id !== issueId ||
						frozen.new_holder !== holderExecId ||
						frozen.to_role !== phase ||
						frozen.target_run_id !== targetRunId ||
						frozen.activation_id !== (activation?.activationId ?? null) ||
						frozen.target_node_id !== (activation?.nodeId ?? null) ||
						frozen.target_attempt !== (activation?.attempt ?? null) ||
						frozen.activation_context_digest !== contextDigest
					) {
						throw new Error(
							`workflow source replay payload mismatch (poison): ${source.sourceEventId}`,
						);
					}
					const epoch = Number(frozen.resulting_epoch);
					if (!Number.isSafeInteger(epoch) || epoch < 1) {
						throw new Error(
							`workflow source replay epoch corrupt: ${source.sourceEventId}`,
						);
					}
					if (activation) {
						const frozenActivation = this.getRunnerWorkflowActivation(
							holderExecId,
							epoch,
						);
						if (
							!frozenActivation ||
							frozenActivation.activation_id !== activation.activationId ||
							frozenActivation.context_digest !== contextDigest
						) {
							throw new Error(
								`workflow activation replay mismatch (poison): ${source.sourceEventId}`,
							);
						}
					}
					return epoch;
				}

				const current = this.db
					.prepare(
						"SELECT holder_exec_id, phase, epoch FROM three_stage_turn WHERE issue_id = ?",
					)
					.get(issueId) as
					| { holder_exec_id: string; phase: string; epoch: number }
					| undefined;
				const resultingEpoch = (current?.epoch ?? 0) + 1;
				const payloadObject = {
					schema_version: 1,
					issue_id: issueId,
					old_holder: current?.holder_exec_id ?? null,
					new_holder: holderExecId,
					from_role: current?.phase ?? null,
					to_role: phase,
					resulting_epoch: resultingEpoch,
					target_run_id: targetRunId,
					activation_id: activation?.activationId ?? null,
					target_node_id: activation?.nodeId ?? null,
					target_attempt: activation?.attempt ?? null,
					activation_context_digest: contextDigest,
				};
				const at = new Date(grantedAtMs).toISOString();
				this.db
					.prepare(
						`INSERT INTO three_stage_turn
						   (issue_id, holder_exec_id, phase, epoch, granted_at,
						    target_run_id, target_node_id, target_attempt, activation_id)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
						 ON CONFLICT(issue_id) DO UPDATE SET
						   holder_exec_id = excluded.holder_exec_id,
						   phase = excluded.phase,
						   epoch = excluded.epoch,
						   granted_at = excluded.granted_at,
						   target_run_id = excluded.target_run_id,
						   target_node_id = excluded.target_node_id,
						   target_attempt = excluded.target_attempt,
						   activation_id = excluded.activation_id`,
					)
					.run(
						issueId,
						holderExecId,
						phase,
						resultingEpoch,
						grantedAtMs,
						targetRunId,
						activation?.nodeId ?? null,
						activation?.attempt ?? null,
						activation?.activationId ?? null,
					);
				if (activation) {
					this.db
						.prepare(
							`INSERT INTO runner_workflow_activation
							   (execution_id, epoch, activation_id, run_id, node_id, attempt,
							    output_credential, submission_credential, context_json,
							    context_digest, created_at)
							 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						)
						.run(
							holderExecId,
							resultingEpoch,
							activation.activationId,
							activation.runId,
							activation.nodeId,
							activation.attempt,
							activation.outputCredential ?? null,
							activation.submissionCredential ?? null,
							contextJson,
							contextDigest,
							grantedAtMs,
						);
				}
				this.db
					.prepare(
						`INSERT INTO turn_source_history
						   (issue_id, from_role, to_role, epoch, target_run_id, source_event_id, at)
						 VALUES (?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						issueId,
						current?.phase ?? null,
						phase,
						resultingEpoch,
						targetRunId,
						source.sourceEventId,
						at,
					);
				this.db
					.prepare(
						`INSERT INTO workflow_source_event
						   (project, source_event_id, kind, payload, payload_digest, schema_version, at)
						 VALUES (?, ?, 'turn_grant', ?, ?, 1, ?)`,
					)
					.run(
						source.project,
						source.sourceEventId,
						canonicalJsonString(payloadObject),
						canonicalSubmissionDigest(payloadObject),
						at,
					);
				return resultingEpoch;
			})();
		}
		return this.db.transaction(() => {
			this.db
				.prepare(
					`INSERT INTO three_stage_turn
				   (issue_id, holder_exec_id, phase, epoch, granted_at,
				    target_run_id, target_node_id, target_attempt, activation_id)
				 VALUES (?, ?, ?, 1, ?, NULL, NULL, NULL, NULL)
				 ON CONFLICT(issue_id) DO UPDATE SET
				   holder_exec_id = excluded.holder_exec_id,
				   phase = excluded.phase,
				   epoch = three_stage_turn.epoch + 1,
				   granted_at = excluded.granted_at,
				   target_run_id = NULL,
				   target_node_id = NULL,
				   target_attempt = NULL,
				   activation_id = NULL`,
				)
				.run(issueId, holderExecId, phase, grantedAtMs);
			return Number(
				(
					this.db
						.prepare("SELECT epoch FROM three_stage_turn WHERE issue_id = ?")
						.get(issueId) as { epoch: number }
				).epoch,
			);
		})();
	}

	/**
	 * FLY-887: read the current TURN for `issueId`, or null if none.
	 *
	 * Readonly-tolerant (mirrors `getEffectiveDeclaredState`): a DB whose writer
	 * never created this table (openReadonly skips schema) yields "no such table"
	 * — that must read as "no TURN", never throw. Any other error propagates.
	 */
	getTurn(issueId: string): ThreeStageTurn | null {
		let row: ThreeStageTurn | undefined;
		try {
			row = this.db
				.prepare(
					`SELECT issue_id, holder_exec_id, phase, epoch, granted_at,
					        target_run_id, target_node_id, target_attempt, activation_id
           FROM three_stage_turn WHERE issue_id = ?`,
				)
				.get(issueId) as ThreeStageTurn | undefined;
		} catch (err) {
			if (/no such table: three_stage_turn/i.test((err as Error).message)) {
				return null;
			}
			if (/no such column:/i.test((err as Error).message)) {
				const legacy = this.db
					.prepare(
						`SELECT issue_id, holder_exec_id, phase, epoch, granted_at
						   FROM three_stage_turn WHERE issue_id = ?`,
					)
					.get(issueId) as
					| Omit<
							ThreeStageTurn,
							| "target_run_id"
							| "target_node_id"
							| "target_attempt"
							| "activation_id"
					  >
					| undefined;
				return legacy
					? {
							...legacy,
							target_run_id: null,
							target_node_id: null,
							target_attempt: null,
							activation_id: null,
						}
					: null;
			}
			throw err;
		}
		return row ?? null;
	}

	/**
	 * Record one not-yours observation and, after the threshold, materialize one
	 * deterministic Lead question for the exact (waiter, holder, epoch) event.
	 * Question + asked_at commit in one SQLite transaction, so crash/concurrent
	 * replay cannot enqueue a second mailbox message.
	 */
	observeTurnWait(input: {
		executionId: string;
		holderExecId: string;
		phase: string;
		epoch: number;
		observedAtMs: number;
		askAfterMs: number;
	}): { asked: boolean; questionId?: string } {
		if (
			!input.executionId.trim() ||
			!input.holderExecId.trim() ||
			!input.phase.trim() ||
			!Number.isSafeInteger(input.epoch) ||
			input.epoch < 1 ||
			!Number.isSafeInteger(input.observedAtMs) ||
			input.observedAtMs < 0 ||
			!Number.isFinite(input.askAfterMs) ||
			input.askAfterMs < 0
		) {
			throw new Error("invalid TURN wait observation");
		}
		let result: { asked: boolean; questionId?: string } = { asked: false };
		this.db
			.transaction(() => {
				// Seeing a concrete TURN tuple proves every older tuple for this waiter
				// is obsolete. It also resets any tentative no-turn clearing streak.
				this.db
					.prepare(
						`DELETE FROM turn_wait_ledger
					  WHERE execution_id = ?
					    AND (holder_exec_id != ? OR epoch != ?)`,
					)
					.run(input.executionId, input.holderExecId, input.epoch);
				this.db
					.prepare(
						`INSERT INTO turn_wait_ledger
					   (execution_id, holder_exec_id, epoch, first_seen_at)
					 VALUES (?, ?, ?, ?)
					 ON CONFLICT(execution_id, holder_exec_id, epoch) DO NOTHING`,
					)
					.run(
						input.executionId,
						input.holderExecId,
						input.epoch,
						input.observedAtMs,
					);
				this.db
					.prepare(
						`UPDATE turn_wait_ledger
					    SET no_turn_streak = 0, last_no_turn_at = NULL
					  WHERE execution_id = ? AND holder_exec_id = ? AND epoch = ?`,
					)
					.run(input.executionId, input.holderExecId, input.epoch);
				const row = this.db
					.prepare(
						`SELECT first_seen_at, asked_at, question_id
					   FROM turn_wait_ledger
					  WHERE execution_id = ? AND holder_exec_id = ? AND epoch = ?`,
					)
					.get(input.executionId, input.holderExecId, input.epoch) as {
					first_seen_at: number;
					asked_at: number | null;
					question_id: string | null;
				};
				if (row.asked_at !== null) {
					result = {
						asked: false,
						...(row.question_id ? { questionId: row.question_id } : {}),
					};
					return;
				}
				if (input.observedAtMs - row.first_seen_at < input.askAfterMs) return;
				const identity = this.db
					.prepare(
						`SELECT COALESCE(s.lead_id, l.lead_id) AS lead_id,
					        COALESCE(s.issue_id, l.issue_id) AS issue_id
					   FROM session_receipt_lineage l
					   LEFT JOIN sessions s ON s.execution_id = l.execution_id
					  WHERE l.execution_id = ?`,
					)
					.get(input.executionId) as
					| { lead_id: string | null; issue_id: string | null }
					| undefined;
				const leadId = identity?.lead_id?.trim();
				if (!leadId) {
					this.db
						.prepare(
							`UPDATE turn_wait_ledger SET last_error = 'lead_id_missing'
						  WHERE execution_id = ? AND holder_exec_id = ? AND epoch = ?`,
						)
						.run(input.executionId, input.holderExecId, input.epoch);
					return;
				}
				const questionId = `turn-wait:${input.executionId}:${input.holderExecId}:${input.epoch}`;
				try {
					this.insertQuestion(
						input.executionId,
						leadId,
						`TURN handoff overdue for ${identity?.issue_id ?? "unknown issue"}: ${input.executionId} is waiting while ${input.holderExecId} still holds ${input.phase} epoch ${input.epoch}. Please inspect the engine delivery and belt ledgers.`,
						{ id: questionId },
					);
					const updated = this.db
						.prepare(
							`UPDATE turn_wait_ledger
						    SET asked_at = ?, question_id = ?, last_error = NULL
						  WHERE execution_id = ? AND holder_exec_id = ? AND epoch = ?
						    AND asked_at IS NULL`,
						)
						.run(
							input.observedAtMs,
							questionId,
							input.executionId,
							input.holderExecId,
							input.epoch,
						);
					result = { asked: updated.changes === 1, questionId };
				} catch (error) {
					this.db
						.prepare(
							`UPDATE turn_wait_ledger SET last_error = ?
						  WHERE execution_id = ? AND holder_exec_id = ? AND epoch = ?`,
						)
						.run(
							error instanceof Error ? error.message : String(error),
							input.executionId,
							input.holderExecId,
							input.epoch,
						);
				}
			})
			.immediate();
		return result;
	}

	clearTurnWaitOnGrant(executionId: string): number {
		if (!executionId.trim()) return 0;
		return this.db
			.prepare("DELETE FROM turn_wait_ledger WHERE execution_id = ?")
			.run(executionId).changes;
	}

	observeNoTurnForWaiter(input: {
		executionId: string;
		observedAtMs: number;
		minimumIntervalMs: number;
	}): { cleared: boolean } {
		if (
			!input.executionId.trim() ||
			!Number.isSafeInteger(input.observedAtMs) ||
			input.observedAtMs < 0 ||
			!Number.isFinite(input.minimumIntervalMs) ||
			input.minimumIntervalMs < 1
		) {
			throw new Error("invalid no-TURN observation");
		}
		let cleared = false;
		this.db
			.transaction(() => {
				const rows = this.db
					.prepare(
						`SELECT holder_exec_id, epoch, no_turn_streak, last_no_turn_at
					   FROM turn_wait_ledger WHERE execution_id = ?`,
					)
					.all(input.executionId) as Array<{
					holder_exec_id: string;
					epoch: number;
					no_turn_streak: number;
					last_no_turn_at: number | null;
				}>;
				for (const row of rows) {
					const increment =
						row.last_no_turn_at === null ||
						input.observedAtMs - row.last_no_turn_at >= input.minimumIntervalMs;
					if (!increment) continue;
					const streak = row.no_turn_streak + 1;
					if (streak >= 2) {
						this.db
							.prepare(
								`DELETE FROM turn_wait_ledger
							  WHERE execution_id = ? AND holder_exec_id = ? AND epoch = ?`,
							)
							.run(input.executionId, row.holder_exec_id, row.epoch);
						cleared = true;
					} else {
						this.db
							.prepare(
								`UPDATE turn_wait_ledger
							    SET no_turn_streak = ?, last_no_turn_at = ?
							  WHERE execution_id = ? AND holder_exec_id = ? AND epoch = ?`,
							)
							.run(
								streak,
								input.observedAtMs,
								input.executionId,
								row.holder_exec_id,
								row.epoch,
							);
					}
				}
			})
			.immediate();
		return { cleared };
	}

	listTurnWaitLedger(executionId: string): Array<{
		holderExecId: string;
		epoch: number;
		noTurnStreak: number;
		lastNoTurnAt: number | null;
	}> {
		if (!executionId.trim()) return [];
		return (
			this.db
				.prepare(
					`SELECT holder_exec_id, epoch, no_turn_streak, last_no_turn_at
					   FROM turn_wait_ledger WHERE execution_id = ?
					  ORDER BY epoch, holder_exec_id`,
				)
				.all(executionId) as Array<{
				holder_exec_id: string;
				epoch: number;
				no_turn_streak: number;
				last_no_turn_at: number | null;
			}>
		).map((row) => ({
			holderExecId: row.holder_exec_id,
			epoch: row.epoch,
			noTurnStreak: row.no_turn_streak,
			lastNoTurnAt: row.last_no_turn_at,
		}));
	}

	enqueueTurnWake(input: {
		wakeId: string;
		executionId: string;
		issueId: string;
		epoch: number;
		activationId?: string;
		purpose: string;
		envelope: {
			fromAgent: string;
			content: string;
			metadata?: Record<string, unknown>;
		};
		backend: string;
		createdAtMs: number;
	}): { idempotentReplay: boolean } {
		if (
			!input.wakeId.trim() ||
			!input.executionId.trim() ||
			!input.issueId.trim() ||
			!Number.isSafeInteger(input.epoch) ||
			input.epoch < 1 ||
			!input.purpose.trim() ||
			!input.envelope.fromAgent.trim() ||
			!input.envelope.content.trim() ||
			!input.backend.trim() ||
			!Number.isSafeInteger(input.createdAtMs) ||
			input.createdAtMs < 0
		) {
			throw new Error("invalid TURN wake envelope");
		}
		const envelopeJson = canonicalJsonString(input.envelope);
		const prior = this.getTurnWake(input.wakeId);
		if (prior) {
			const matches =
				prior.execution_id === input.executionId &&
				prior.issue_id === input.issueId &&
				prior.epoch === input.epoch &&
				prior.activation_id === (input.activationId ?? null) &&
				prior.purpose === input.purpose &&
				prior.envelope_json === envelopeJson &&
				prior.backend === input.backend;
			if (!matches) {
				throw new Error(`TURN wake identity conflict: ${input.wakeId}`);
			}
			return { idempotentReplay: true };
		}
		this.db
			.prepare(
				`INSERT INTO turn_wake_outbox
				   (wake_id, execution_id, issue_id, epoch, activation_id, purpose,
				    envelope_json, backend, episode_id, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.wakeId,
				input.executionId,
				input.issueId,
				input.epoch,
				input.activationId ?? null,
				input.purpose,
				envelopeJson,
				input.backend,
				`turn-wake-no-receipt:${input.wakeId}`,
				input.createdAtMs,
			);
		return { idempotentReplay: false };
	}

	getTurnWake(wakeId: string): TurnWakeOutboxRow | null {
		return (
			(this.db
				.prepare("SELECT * FROM turn_wake_outbox WHERE wake_id = ?")
				.get(wakeId) as TurnWakeOutboxRow | undefined) ?? null
		);
	}

	claimDueTurnWake(input: {
		nowMs: number;
		retryAfterMs: number;
		leaseMs: number;
		excludeWakeIds?: string[];
	}): TurnWakeOutboxRow | null {
		if (
			!Number.isSafeInteger(input.nowMs) ||
			input.nowMs < 0 ||
			!Number.isFinite(input.retryAfterMs) ||
			input.retryAfterMs < 0 ||
			!Number.isFinite(input.leaseMs) ||
			input.leaseMs <= 0
		) {
			throw new Error("invalid TURN wake claim window");
		}
		const excludeWakeIds = [
			...new Set(
				(input.excludeWakeIds ?? []).filter((wakeId) => wakeId.trim()),
			),
		];
		const exclusionSql = excludeWakeIds.length
			? `AND wake_id NOT IN (${excludeWakeIds.map(() => "?").join(",")})`
			: "";
		let claimed: TurnWakeOutboxRow | null = null;
		this.db
			.transaction(() => {
				const row = this.db
					.prepare(
						`SELECT * FROM turn_wake_outbox
					  WHERE state IN ('pending','sent')
					    AND push_count < 2
					    AND (claim_token IS NULL OR claim_expires_at <= ?)
					    AND (
					      push_count = 0 OR
					      (push_count = 1 AND last_push_at <= ?)
					    )
					    ${exclusionSql}
					  ORDER BY created_at, wake_id
					  LIMIT 1`,
					)
					.get(
						input.nowMs,
						input.nowMs - input.retryAfterMs,
						...excludeWakeIds,
					) as TurnWakeOutboxRow | undefined;
				if (!row) return;
				const claimToken = randomUUID();
				const updated = this.db
					.prepare(
						`UPDATE turn_wake_outbox
					    SET claim_token = ?, claim_expires_at = ?
					  WHERE wake_id = ? AND state = ? AND push_count = ?
					    AND (claim_token IS NULL OR claim_expires_at <= ?)`,
					)
					.run(
						claimToken,
						input.nowMs + input.leaseMs,
						row.wake_id,
						row.state,
						row.push_count,
						input.nowMs,
					);
				if (updated.changes !== 1) return;
				claimed = {
					...row,
					claim_token: claimToken,
					claim_expires_at: input.nowMs + input.leaseMs,
				};
			})
			.immediate();
		return claimed;
	}

	claimTurnWakeById(input: {
		wakeId: string;
		nowMs: number;
		retryAfterMs: number;
		leaseMs: number;
	}): TurnWakeOutboxRow | null {
		if (
			!input.wakeId.trim() ||
			!Number.isSafeInteger(input.nowMs) ||
			input.nowMs < 0 ||
			!Number.isFinite(input.retryAfterMs) ||
			input.retryAfterMs < 0 ||
			!Number.isFinite(input.leaseMs) ||
			input.leaseMs <= 0
		) {
			throw new Error("invalid TURN wake claim window");
		}
		let claimed: TurnWakeOutboxRow | null = null;
		this.db
			.transaction(() => {
				const row = this.getTurnWake(input.wakeId);
				if (
					!row ||
					(row.state !== "pending" && row.state !== "sent") ||
					row.push_count >= 2 ||
					(row.claim_token !== null &&
						(row.claim_expires_at ?? Number.POSITIVE_INFINITY) > input.nowMs) ||
					(row.push_count === 1 &&
						(row.last_push_at ?? Number.POSITIVE_INFINITY) >
							input.nowMs - input.retryAfterMs)
				) {
					return;
				}
				const claimToken = randomUUID();
				const updated = this.db
					.prepare(
						`UPDATE turn_wake_outbox
					    SET claim_token = ?, claim_expires_at = ?
					  WHERE wake_id = ? AND state = ? AND push_count = ?
					    AND (claim_token IS NULL OR claim_expires_at <= ?)`,
					)
					.run(
						claimToken,
						input.nowMs + input.leaseMs,
						row.wake_id,
						row.state,
						row.push_count,
						input.nowMs,
					);
				if (updated.changes !== 1) return;
				claimed = {
					...row,
					claim_token: claimToken,
					claim_expires_at: input.nowMs + input.leaseMs,
				};
			})
			.immediate();
		return claimed;
	}

	finishTurnWakePush(input: {
		wakeId: string;
		claimToken: string;
		pushedAtMs: number;
		result: string;
	}): void {
		if (
			!input.wakeId.trim() ||
			!input.claimToken.trim() ||
			!Number.isSafeInteger(input.pushedAtMs) ||
			input.pushedAtMs < 0 ||
			!input.result.trim()
		) {
			throw new Error("invalid TURN wake push result");
		}
		const updated = this.db
			.prepare(
				`UPDATE turn_wake_outbox
				    SET state = 'sent', push_count = push_count + 1,
				        first_push_at = COALESCE(first_push_at, ?), last_push_at = ?,
				        last_push_result = ?, claim_token = NULL, claim_expires_at = NULL
				  WHERE wake_id = ? AND claim_token = ?
				    AND state IN ('pending','sent') AND push_count < 2`,
			)
			.run(
				input.pushedAtMs,
				input.pushedAtMs,
				input.result,
				input.wakeId,
				input.claimToken,
			);
		if (updated.changes !== 1) {
			throw new Error(`stale TURN wake push claim: ${input.wakeId}`);
		}
	}

	releaseTurnWakeClaim(wakeId: string, claimToken: string): boolean {
		if (!wakeId.trim() || !claimToken.trim()) return false;
		return (
			this.db
				.prepare(
					`UPDATE turn_wake_outbox
					    SET claim_token = NULL, claim_expires_at = NULL
					  WHERE wake_id = ? AND claim_token = ?
					    AND state IN ('pending','sent')`,
				)
				.run(wakeId, claimToken).changes === 1
		);
	}

	ackTurnWakes(input: {
		executionId: string;
		epoch: number;
		activationId?: string;
		ackedAtMs: number;
	}): number {
		if (
			!input.executionId.trim() ||
			!Number.isSafeInteger(input.epoch) ||
			input.epoch < 1 ||
			!Number.isSafeInteger(input.ackedAtMs) ||
			input.ackedAtMs < 0
		) {
			throw new Error("invalid TURN wake acknowledgment");
		}
		return this.db
			.prepare(
				`UPDATE turn_wake_outbox
				    SET state = 'acked', acked_at = ?, claim_token = NULL,
				        claim_expires_at = NULL
				  WHERE execution_id = ? AND epoch = ? AND activation_id IS ?
				    AND state IN ('pending','sent')`,
			)
			.run(
				input.ackedAtMs,
				input.executionId,
				input.epoch,
				input.activationId ?? null,
			).changes;
	}

	listUnprojectedTurnWakeReceipts(limit = 100): TurnWakeOutboxRow[] {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
			throw new Error("invalid TURN wake receipt projection limit");
		}
		return this.db
			.prepare(
				`SELECT * FROM turn_wake_outbox
				  WHERE state = 'acked' AND acked_at IS NOT NULL
				    AND receipt_projected_at IS NULL
				  ORDER BY acked_at, wake_id LIMIT ?`,
			)
			.all(limit) as TurnWakeOutboxRow[];
	}

	markTurnWakeReceiptProjected(wakeId: string, projectedAtMs: number): boolean {
		if (
			!wakeId.trim() ||
			!Number.isSafeInteger(projectedAtMs) ||
			projectedAtMs < 0
		) {
			return false;
		}
		return (
			this.db
				.prepare(
					`UPDATE turn_wake_outbox SET receipt_projected_at = ?
					  WHERE wake_id = ? AND state = 'acked'
					    AND acked_at IS NOT NULL AND receipt_projected_at IS NULL`,
				)
				.run(projectedAtMs, wakeId).changes === 1
		);
	}

	cancelTurnWake(wakeId: string, reason: string): boolean {
		if (!wakeId.trim() || !reason.trim()) return false;
		return (
			this.db
				.prepare(
					`UPDATE turn_wake_outbox
					    SET state = 'cancelled', cancel_reason = ?,
					        claim_token = NULL, claim_expires_at = NULL
					  WHERE wake_id = ? AND state IN ('pending','sent')`,
				)
				.run(reason, wakeId).changes === 1
		);
	}

	materializeTurnWakeNoReceiptAlerts(input: {
		nowMs: number;
		alertAfterMs: number;
	}): string[] {
		if (
			!Number.isSafeInteger(input.nowMs) ||
			input.nowMs < 0 ||
			!Number.isFinite(input.alertAfterMs) ||
			input.alertAfterMs < 0
		) {
			throw new Error("invalid TURN wake alert window");
		}
		const created: string[] = [];
		this.db
			.transaction(() => {
				const due = this.db
					.prepare(
						`SELECT w.*, COALESCE(s.lead_id, l.lead_id) AS lead_id
					   FROM turn_wake_outbox w
					   LEFT JOIN sessions s ON s.execution_id = w.execution_id
					   LEFT JOIN session_receipt_lineage l ON l.execution_id = w.execution_id
					  WHERE w.state = 'sent' AND w.acked_at IS NULL
					    AND w.alerted_at IS NULL AND w.first_push_at IS NOT NULL
					    AND w.first_push_at <= ?
					  ORDER BY w.first_push_at, w.wake_id`,
					)
					.all(input.nowMs - input.alertAfterMs) as Array<
					TurnWakeOutboxRow & { lead_id: string | null }
				>;
				for (const row of due) {
					const leadId = row.lead_id?.trim();
					if (!leadId) continue;
					const questionId = `turn-wake-alert:${row.wake_id}`;
					this.insertQuestion(
						"bridge",
						leadId,
						`TURN wake has no runner receipt for ${row.issue_id}: ${row.execution_id}, epoch ${row.epoch}, activation ${row.activation_id ?? "legacy"}, wake ${row.wake_id}. Inspect the target runner and exact belt tuple.`,
						{ id: questionId },
					);
					const updated = this.db
						.prepare(
							`UPDATE turn_wake_outbox
						    SET alerted_at = ?, alert_question_id = ?
						  WHERE wake_id = ? AND alerted_at IS NULL AND state = 'sent'`,
						)
						.run(input.nowMs, questionId, row.wake_id);
					if (updated.changes === 1) created.push(questionId);
				}
			})
			.immediate();
		return created;
	}

	getRunnerWorkflowActivation(
		executionId: string,
		epoch: number,
	): RunnerWorkflowActivation | null {
		try {
			return (
				(this.db
					.prepare(
						`SELECT execution_id, epoch, activation_id, run_id, node_id,
						        attempt, output_credential, submission_credential,
						        context_json, context_digest, created_at
						   FROM runner_workflow_activation
						  WHERE execution_id = ? AND epoch = ?`,
					)
					.get(executionId, epoch) as RunnerWorkflowActivation | undefined) ??
				null
			);
		} catch (error) {
			if (
				/no such table: runner_workflow_activation/i.test(
					(error as Error).message,
				)
			) {
				return null;
			}
			throw error;
		}
	}

	resolveRunnerWorkflowActivation(
		executionId: string,
	):
		| { state: "active"; activation: RunnerWorkflowActivation }
		| { state: "legacy" }
		| { state: "stale"; reason: string } {
		const session = this.getSession(executionId);
		if (!session?.issue_id) return { state: "legacy" };
		const turn = this.getTurn(session.issue_id);
		if (!turn || !turn.activation_id) return { state: "legacy" };
		if (turn.holder_exec_id !== executionId) {
			return { state: "stale", reason: "turn_holder_mismatch" };
		}
		const activation = this.getRunnerWorkflowActivation(
			executionId,
			turn.epoch,
		);
		if (
			!activation ||
			activation.activation_id !== turn.activation_id ||
			activation.run_id !== turn.target_run_id ||
			activation.node_id !== turn.target_node_id ||
			activation.attempt !== turn.target_attempt
		) {
			return { state: "stale", reason: "turn_activation_mismatch" };
		}
		return { state: "active", activation };
	}

	getCurrentRunnerWorkflowActivation(
		executionId: string,
	): RunnerWorkflowActivation | null {
		const resolved = this.resolveRunnerWorkflowActivation(executionId);
		return resolved.state === "active" ? resolved.activation : null;
	}

	/**
	 * FLY-921: read ALL TURN rows in this DB — the Bridge's turn-belt reconcile
	 * needs the full table to detect stale (dead-holder) TURNs. Rows carry no
	 * project name; the caller (plugin.ts) owns the per-project attribution.
	 * Readonly-tolerant: "no such table" reads as an empty table (mirrors getTurn).
	 */
	listTurns(): ThreeStageTurn[] {
		try {
			return this.db
				.prepare(
					`SELECT issue_id, holder_exec_id, phase, epoch, granted_at,
					        target_run_id, target_node_id, target_attempt, activation_id
           FROM three_stage_turn`,
				)
				.all() as ThreeStageTurn[];
		} catch (err) {
			if (/no such table: three_stage_turn/i.test((err as Error).message)) {
				return [];
			}
			throw err;
		}
	}

	/** FLY-887: remove the TURN row for `issueId` (ship-time cleanup). Idempotent. */
	deleteTurn(issueId: string): void {
		this.db
			.prepare("DELETE FROM three_stage_turn WHERE issue_id = ?")
			.run(issueId);
	}

	/**
	 * FLY-1314: compare-and-delete a TURN belt after a slow external-merge /
	 * liveness probe. A re-grant increments epoch, so a probe that observed an
	 * old holder can never erase the newer authority row.
	 */
	deleteTurnIfCurrent(
		issueId: string,
		expectedHolder: string,
		expectedEpoch: number,
	): boolean {
		const info = this.db
			.prepare(
				`DELETE FROM three_stage_turn
				 WHERE issue_id = ? AND holder_exec_id = ? AND epoch = ?`,
			)
			.run(issueId, expectedHolder, expectedEpoch);
		return info.changes === 1;
	}

	// ── Session Registry (Phase 2) ──

	private upsertSessionReceiptLineage(input: {
		executionId: string;
		projectName: string;
		issueId: string | null;
		leadId: string | null;
	}): void {
		const existing = this.db
			.prepare(
				`SELECT project_name, issue_id, lead_id
				   FROM session_receipt_lineage WHERE execution_id = ?`,
			)
			.get(input.executionId) as
			| {
					project_name: string;
					issue_id: string | null;
					lead_id: string | null;
			  }
			| undefined;
		if (
			existing &&
			(existing.project_name !== input.projectName ||
				(existing.issue_id !== null &&
					input.issueId !== null &&
					existing.issue_id !== input.issueId) ||
				(existing.lead_id !== null &&
					input.leadId !== null &&
					existing.lead_id !== input.leadId))
		) {
			throw new Error(
				`session receipt lineage mismatch for ${input.executionId}`,
			);
		}
		this.db
			.prepare(
				`INSERT INTO session_receipt_lineage
				   (execution_id, project_name, issue_id, lead_id)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(execution_id) DO UPDATE SET
				   issue_id = COALESCE(session_receipt_lineage.issue_id, excluded.issue_id),
				   lead_id = COALESCE(session_receipt_lineage.lead_id, excluded.lead_id)`,
			)
			.run(input.executionId, input.projectName, input.issueId, input.leadId);
	}

	registerSession(
		executionId: string,
		tmuxWindow: string,
		projectName: string,
		issueId?: string,
		leadId?: string,
		/** FLY-1188: transport vendor ("claude-code" | "codex"); routes `send` wakes. */
		vendor?: string,
	): void {
		this.db.transaction(() => {
			this.db
				.prepare(
					`INSERT INTO sessions (execution_id, tmux_window, project_name, issue_id, lead_id, vendor)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(execution_id) DO UPDATE SET
		   tmux_window = excluded.tmux_window,
		   project_name = excluded.project_name,
		   issue_id = excluded.issue_id,
		   lead_id = excluded.lead_id,
		   vendor = excluded.vendor,
		   started_at = CASE
		     WHEN sessions.status = 'running' THEN excluded.started_at
		     ELSE sessions.started_at
		   END,
		   ended_at = CASE
		     WHEN sessions.status = 'running' THEN NULL
		     ELSE sessions.ended_at
		   END`,
				)
				.run(
					executionId,
					tmuxWindow,
					projectName,
					issueId ?? null,
					leadId ?? null,
					vendor ?? null,
				);
			this.upsertSessionReceiptLineage({
				executionId,
				projectName,
				issueId: issueId ?? null,
				leadId: leadId ?? null,
			});
		})();
	}

	/**
	 * FLY-1374: restore the exact CommDB identity a proven-live parked holder
	 * needs before its wake is committed. Existing rows are revived in place so
	 * questions/mailbox_message_projection/receipts survive; their registered tmux target remains
	 * authoritative. Missing rows may be inserted only with a complete,
	 * caller-proven identity.
	 */
	activateSessionForWake(input: {
		executionId: string;
		tmuxWindow: string;
		projectName: string;
		issueId: string;
		leadId: string;
		vendor: string;
	}):
		| { ok: true; inserted: boolean; previousStatus: string | null }
		| { ok: false; reason: "invalid_wake_identity" } {
		const values = [
			input.executionId,
			input.tmuxWindow,
			input.projectName,
			input.issueId,
			input.leadId,
			input.vendor,
		];
		if (values.some((value) => !value.trim())) {
			return { ok: false, reason: "invalid_wake_identity" };
		}
		return this.db.transaction(() => {
			const current = this.db
				.prepare(
					"SELECT status, tmux_window FROM sessions WHERE execution_id = ?",
				)
				.get(input.executionId) as
				| { status: string; tmux_window: string }
				| undefined;
			if (!current) {
				this.db
					.prepare(
						`INSERT INTO sessions
						   (execution_id, tmux_window, project_name, issue_id, lead_id,
						    vendor, status, ended_at)
						 VALUES (?, ?, ?, ?, ?, ?, 'running', NULL)`,
					)
					.run(
						input.executionId,
						input.tmuxWindow,
						input.projectName,
						input.issueId,
						input.leadId,
						input.vendor,
					);
				this.upsertSessionReceiptLineage({
					executionId: input.executionId,
					projectName: input.projectName,
					issueId: input.issueId,
					leadId: input.leadId,
				});
				return {
					ok: true as const,
					inserted: true,
					previousStatus: null,
				};
			}
			this.db
				.prepare(
					`UPDATE sessions
					    SET status = 'running', ended_at = NULL,
					        project_name = ?, issue_id = ?, lead_id = ?, vendor = ?
					  WHERE execution_id = ?`,
				)
				.run(
					input.projectName,
					input.issueId,
					input.leadId,
					input.vendor,
					input.executionId,
				);
			this.upsertSessionReceiptLineage({
				executionId: input.executionId,
				projectName: input.projectName,
				issueId: input.issueId,
				leadId: input.leadId,
			});
			return {
				ok: true as const,
				inserted: false,
				previousStatus: current.status,
			};
		})();
	}

	/**
	 * FLY-1269: replace only the routing target after a lazily-created tmux
	 * window has an immutable id. Unlike registerSession's INSERT OR REPLACE,
	 * this preserves lifecycle/review metadata already attached to the row.
	 */
	updateSessionTmuxWindow(executionId: string, tmuxWindow: string): void {
		this.db
			.prepare("UPDATE sessions SET tmux_window = ? WHERE execution_id = ?")
			.run(tmuxWindow, executionId);
	}

	/** FLY-80: Remove a pre-registered session only if still in :pending state.
	 *  If Runner has self-registered (overwritten tmux_window), this is a no-op. */
	unregisterPendingSession(executionId: string): void {
		this.db
			.prepare(
				"DELETE FROM sessions WHERE execution_id = ? AND tmux_window LIKE '%:pending'",
			)
			.run(executionId);
	}

	updateSessionStatus(
		executionId: string,
		status: "completed" | "timeout" | "blocked",
	): void {
		this.db
			.prepare(
				"UPDATE sessions SET status = ?, ended_at = datetime('now') WHERE execution_id = ?",
			)
			.run(status, executionId);
	}

	/**
	 * FLY-1066: adapter-owned lifecycle completion may only retire a still-running
	 * registration. It must not overwrite a StateStore-authoritative failed or
	 * blocked mark that won the race first.
	 */
	updateSessionStatusIfRunning(
		executionId: string,
		status: "completed" | "timeout" | "blocked",
	): void {
		this.db
			.prepare(
				"UPDATE sessions SET status = ?, ended_at = COALESCE(ended_at, datetime('now')) WHERE execution_id = ? AND status = 'running'",
			)
			.run(status, executionId);
	}

	/**
	 * FLY-1066: reflect the StateStore-authoritative crash-preserve terminal
	 * state without deleting the routing target needed by retry teardown.
	 * Repeated marks keep the first terminal timestamp stable.
	 */
	markSessionTerminalStatus(
		executionId: string,
		status: "failed" | "blocked",
	): void {
		this.db
			.prepare(
				"UPDATE sessions SET status = ?, ended_at = COALESCE(ended_at, datetime('now')) WHERE execution_id = ?",
			)
			.run(status, executionId);
	}

	getSession(executionId: string): Session | undefined {
		return this.db
			.prepare("SELECT * FROM sessions WHERE execution_id = ?")
			.get(executionId) as Session | undefined;
	}

	/** Durable runner identity retained after the live session row is finalized. */
	getSessionReceiptIdentity(
		executionId: string,
	): SessionReceiptIdentity | undefined {
		return this.db
			.prepare(
				`SELECT execution_id, project_name, issue_id, lead_id
				   FROM session_receipt_lineage WHERE execution_id = ?`,
			)
			.get(executionId) as SessionReceiptIdentity | undefined;
	}

	/**
	 * Highest-priority unanswered question opened by this runner. Checkpoints are
	 * durable across turns; ordinary asks are limited to the current turn window.
	 * Reports cannot make a later stop look blocked.
	 */
	getPendingRunnerQuestion(
		executionId: string,
		leadId: string,
		lowerBound?: string,
	): PendingRunnerQuestion | undefined {
		const answerable = commDbProtectionEnabled()
			? "q.relay_state != 'terminal_disposed'"
			: "datetime(q.expires_at) > datetime('now')";
		return this.db
			.prepare(
				`SELECT q.id, q.checkpoint FROM mailbox_message_projection q
				 WHERE q.to_agent = ?
				   AND q.type = 'question'
				   AND q.from_agent = ?
				   AND (q.kind IS NULL OR q.kind <> 'report')
				   AND q.superseded_at IS NULL
				   AND NOT EXISTS (
				     SELECT 1 FROM mailbox_message_projection r
				      WHERE r.parent_id = q.id AND r.type = 'response'
				   )
				   AND ${answerable}
				   AND (q.checkpoint IS NOT NULL OR ? IS NULL OR julianday(q.created_at) >= julianday(?))
				 ORDER BY (q.checkpoint IS NOT NULL) DESC, q.created_at, q.rowid
				 LIMIT 1`,
			)
			.get(leadId, executionId, lowerBound ?? null, lowerBound ?? null) as
			| PendingRunnerQuestion
			| undefined;
	}

	/**
	 * FLY-1238: atomically retire every unanswered checkpoint gate owned by a
	 * runner and remove its session registry row. An answered question is
	 * immutable history. Errors deliberately propagate so teardown callers fail
	 * closed and retry the whole transaction.
	 *
	 * FLY-1328: the same teardown now also cascades to the runner's own aged,
	 * unanswered checkpoint-less asks. Closing a runner closes its account —
	 * leaving its asks pending forever is what let dead runners' questions
	 * outnumber live ones in the Lead's queue until `pending` stopped being worth
	 * reading. Gate semantics (predicates, review-gate exemption) are untouched.
	 */
	finalizeSession(executionId: string): FinalizeSessionResult {
		const askHygiene = askHygieneEnabled();
		return this.db.transaction((targetExecutionId: string) => {
			// A machine-proven terminal runner is an explicit H2 disposal condition:
			// protection prevents TTL/hygiene loss, not intentional lifecycle closeout.
			const retired = this.db
				.prepare(
					`UPDATE mailbox AS q SET
					   resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
					   state = 'ACKED',
					   acked_at = COALESCE(acked_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
					   expires_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
					   relay_state = 'terminal_disposed'
					   ${askHygiene ? ", resolved_via = 'owner_closed'" : ""}
					 WHERE q.from_agent = ?
					   AND q.type = 'question'
					   AND q.checkpoint IS NOT NULL
					   -- FLY-1257 defect ④ path-3 (Codex code review HIGH-2): a review
					   -- gate is a binding credential the reviewer/coordinator answers,
					   -- NOT the author runner — it must survive the author's teardown
					   -- (mirrors the GatePoller path-2 eviction exemption). Retiring it
					   -- here would make the coordinator drop a still-valid verdict.
					   AND q.checkpoint NOT IN ('review_design', 'review_code')
					   AND q.resolved_at IS NULL
					   AND NOT EXISTS (
					     SELECT 1 FROM mailbox_message_projection r
					      WHERE r.parent_id = q.id AND r.type = 'response'
					   )`,
				)
				.run(targetExecutionId).changes;

			// FLY-1328 A1 — cascade the owner's unanswered asks. An ask younger than
			// the grace window is spared: it may not have reached the Lead yet, and
			// the queue can afford one more tick far more than the founder can afford
			// a swallowed report.
			let retiredAsks = 0;
			if (askHygiene) {
				const forensicTtl = commDbProtectionEnabled()
					? ASK_FORENSIC_TTL_SQL
					: // Legacy pending filters on expires_at > now — expire on the spot
						// or the row would linger in the very queue we are clearing.
						"+0 seconds";
				retiredAsks = this.db
					.prepare(
						`UPDATE mailbox AS q SET
						   resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
						   state = 'ACKED',
						   acked_at = COALESCE(acked_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
						   expires_at = strftime('%Y-%m-%dT%H:%M:%fZ','now', '${forensicTtl}'),
						   relay_state = 'terminal_disposed',
						   resolved_via = 'owner_closed'
						 WHERE q.from_agent = ?
						   AND q.type = 'question'
						   AND q.checkpoint IS NULL
						   AND q.resolved_at IS NULL
						   AND q.relay_state != 'terminal_disposed'
						   AND datetime(q.created_at) <= datetime('now', ?)
						   AND NOT EXISTS (
						     SELECT 1 FROM mailbox_message_projection r
						      WHERE r.parent_id = q.id AND r.type = 'response'
						   )`,
					)
					.run(targetExecutionId, ASK_CASCADE_GRACE_SQL).changes;
			}

			this.pruneTerminalRunnerReceiptWakes(targetExecutionId);
			this.db
				.prepare("DELETE FROM runner_shutdown_controls WHERE execution_id = ?")
				.run(targetExecutionId);
			const deleted = this.db
				.prepare("DELETE FROM sessions WHERE execution_id = ?")
				.run(targetExecutionId).changes;
			return {
				retiredQuestionCount: retired,
				retiredAskCount: retiredAsks,
				deletedSessionCount: deleted,
			};
		})(executionId);
	}

	/**
	 * FLY-1374: maintenance deletion may not retire the identity of the current
	 * three-stage TURN holder. The guard and finalization share one IMMEDIATE
	 * transaction, so a TURN granted after an async liveness probe cannot race
	 * between a second read and the destructive session write.
	 *
	 * Explicit live teardown keeps using `finalizeSession`: its caller owns TURN
	 * release. This guarded variant is intentionally for inference-based cleanup.
	 */
	finalizeSessionUnlessTurnHolder(
		executionId: string,
	): GuardedFinalizeSessionResult {
		const finalize = this.db.transaction(
			(targetExecutionId: string): GuardedFinalizeSessionResult => {
				const holdsTurn = this.db
					.prepare(
						"SELECT 1 FROM three_stage_turn WHERE holder_exec_id = ? LIMIT 1",
					)
					.get(targetExecutionId);
				if (holdsTurn) {
					return { finalized: false, reason: "turn_holder" };
				}
				return {
					finalized: true,
					result: this.finalizeSession(targetExecutionId),
				};
			},
		);
		return finalize.immediate(executionId);
	}

	/** FLY-1628: finalize a pane-loss residue only while its exact target and
	 * TURN-free authority still match the evidence gathered before this txn. */
	finalizePaneLossResidue(
		executionId: string,
		expectedTmuxWindow: string,
	): GuardedFinalizeSessionResult {
		const finalize = this.db.transaction(
			(
				targetExecutionId: string,
				expectedTarget: string,
			): GuardedFinalizeSessionResult => {
				const session = this.db
					.prepare("SELECT tmux_window FROM sessions WHERE execution_id = ?")
					.get(targetExecutionId) as { tmux_window?: string } | undefined;
				if (session?.tmux_window !== expectedTarget) {
					return { finalized: false, reason: "target_changed" };
				}
				const holdsTurn = this.db
					.prepare(
						"SELECT 1 FROM three_stage_turn WHERE holder_exec_id = ? LIMIT 1",
					)
					.get(targetExecutionId);
				if (holdsTurn) return { finalized: false, reason: "turn_holder" };
				return {
					finalized: true,
					result: this.finalizeSession(targetExecutionId),
				};
			},
		);
		return finalize.immediate(executionId, expectedTmuxWindow);
	}

	/**
	 * FLY-638: delete a session registry row. Used by (a) the live teardown path
	 * (close_runner / terminate / post-merge) to drop a runner's row once its tmux
	 * is gone, and (b) the boot prune sweep that clears the backlog of dead
	 * terminal rows polluting `runner_terminal_list` / bootstrap. Idempotent —
	 * deleting a missing row is a no-op. Returns the number of rows removed.
	 *
	 * FLY-1328 — PROVEN-TEARDOWN ONLY. The A2 ask sweep treats "this row is gone"
	 * as proof the runner is torn down and can never read an answer, and retires
	 * its asks on that basis. Deleting the row of a runner that is still alive
	 * would therefore silently destroy its live questions and break the FLY-161
	 * survive-completion contract. Do not call this to tidy up, to reset state, or
	 * on any path where the runner might still be running. New call sites must
	 * also update the FLY-1328 call-site sentinel test, which exists to make
	 * exactly this decision a conscious one.
	 */
	deleteSession(executionId: string): number {
		return this.db
			.prepare("DELETE FROM sessions WHERE execution_id = ?")
			.run(executionId).changes;
	}

	/**
	 * FLY-1269: issue-terminal cleanup for a resident phase execution.
	 *
	 * FLY-1328 — PROVEN-TEARDOWN ONLY, for the same reason as `deleteSession`
	 * above: dropping the registry row is what tells the A2 ask sweep the runner
	 * is gone for good.
	 */
	deleteSessionAndRunnerPhaseLifecycle(executionId: string): number {
		const remove = this.db.transaction(() => {
			this.pruneTerminalRunnerReceiptWakes(executionId);
			this.db
				.prepare("DELETE FROM runner_shutdown_controls WHERE execution_id = ?")
				.run(executionId);
			return this.db
				.prepare("DELETE FROM sessions WHERE execution_id = ?")
				.run(executionId).changes;
		});
		return remove();
	}

	private pruneTerminalRunnerReceiptWakes(executionId: string): void {
		const nowMs = Date.now();
		const retentionCutoff = nowMs - 7 * 24 * 60 * 60_000;
		const pending = this.db
			.prepare(
				`SELECT * FROM runner_phase_wakes
				  WHERE execution_id = ? AND state = 'pending'`,
			)
			.all(executionId) as RunnerPhaseWake[];
		for (const wake of pending) {
			const founderOrigin = runnerWakeMetadata(wake).origin === "founder";
			if (founderOrigin) {
				this.completeRunnerPhaseWakeTerminal({
					executionId,
					messageId: wake.message_id,
					reason: "terminal_before_started",
					terminalLifecycleId: `commdb-session-finalize:${executionId}`,
					nowMs,
				});
				continue;
			}
			this.disposeRunnerPhaseWakeForTerminal(
				executionId,
				wake.message_id,
				nowMs,
			);
		}
		this.db
			.prepare(
				`DELETE FROM runner_phase_wakes
				 WHERE execution_id = ?
					   AND (admission_state IS NULL
					        OR (queued_at < ? AND (
					          state IN ('started','finished')
					          OR admission_state IN ('suppressed_cap','skipped_no_transport')
					        )))
					   AND NOT EXISTS (
					     SELECT 1 FROM receipt_alert_outbox alert
					      WHERE alert.id = runner_phase_wakes.escalation_outbox_id
					        AND alert.delivered_at IS NULL
					        AND alert.canceled_at IS NULL
					   )`,
			)
			.run(executionId, retentionCutoff);
	}

	getActiveSessions(projectName?: string): Session[] {
		if (projectName) {
			return this.db
				.prepare(
					"SELECT * FROM sessions WHERE project_name = ? AND status = 'running' ORDER BY started_at ASC",
				)
				.all(projectName) as Session[];
		}
		return this.db
			.prepare(
				"SELECT * FROM sessions WHERE status = 'running' ORDER BY started_at ASC",
			)
			.all() as Session[];
	}

	listSessions(projectName?: string, statuses?: string[]): Session[] {
		const conditions: string[] = [];
		const params: string[] = [];

		if (projectName) {
			conditions.push("project_name = ?");
			params.push(projectName);
		}
		if (statuses && statuses.length > 0) {
			conditions.push(`status IN (${statuses.map(() => "?").join(", ")})`);
			params.push(...statuses);
		}

		const where =
			conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		return this.db
			.prepare(`SELECT * FROM sessions ${where} ORDER BY started_at DESC`)
			.all(...params) as Session[];
	}

	/**
	 * FLY-229 / FLY-1066: recent terminal sessions, for parked-alive
	 * detection in `runner_terminal_list`. Lead-scoped IN SQL — the
	 * `(lead_id = ? OR lead_id IS NULL)` predicate is applied BEFORE `LIMIT` so an
	 * in-scope parked-alive row can't be pushed out of the window by another
	 * Lead's newer rows. Ordered by `COALESCE(ended_at, started_at) DESC` —
	 * `ended_at` is the "parked since" clock (stamped by `updateSessionStatus`);
	 * parked-alive sessions are inherently recent, so a recency cap yields no
	 * realistic false-negative. `leadId === undefined` → no scope predicate
	 * (mirrors the unscoped form of `getActiveSessions`).
	 */
	getRecentTerminalSessions(
		projectName: string,
		leadId: string | undefined,
		limit: number,
	): Session[] {
		const scoped = leadId != null;
		const sql =
			"SELECT * FROM sessions WHERE project_name = ? AND status IN ('completed','timeout','failed','blocked')" +
			(scoped ? " AND (lead_id = ? OR lead_id IS NULL)" : "") +
			" ORDER BY COALESCE(ended_at, started_at) DESC LIMIT ?";
		const params: Array<string | number> = scoped
			? [projectName, leadId as string, limit]
			: [projectName, limit];
		return this.db.prepare(sql).all(...params) as Session[];
	}

	/**
	 * FLY-229 / FLY-1066: count of terminal sessions matching the SAME
	 * scope as `getRecentTerminalSessions` — drives the truncation summary line
	 * when more terminal rows exist than the probe cap.
	 */
	countTerminalSessions(projectName: string, leadId?: string): number {
		const scoped = leadId != null;
		const sql =
			"SELECT COUNT(*) AS n FROM sessions WHERE project_name = ? AND status IN ('completed','timeout','failed','blocked')" +
			(scoped ? " AND (lead_id = ? OR lead_id IS NULL)" : "");
		const params: string[] = scoped
			? [projectName, leadId as string]
			: [projectName];
		const row = this.db.prepare(sql).get(...params) as { n: number };
		return row.n;
	}

	close(): void {
		this.db.close();
	}
}
