import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import {
	canonicalJsonString,
	canonicalSubmissionDigest,
} from "flywheel-config";
import type { FrozenFounderRouteCandidatesV1 } from "./founder-reply-routing.js";
import {
	founderMessageRootId,
	founderRouteRowId,
} from "./founder-reply-routing.js";
import type {
	EnqueueFounderHubRootInput,
	LeadInboxRow,
	ProcessedEvidenceV1,
	ReceiptPriorityWindowsMs,
} from "./lead-inbox-queue.js";
import {
	applyReceiptFoundationMigrations,
	assertProcessedEvidence,
	assertUtcIsoTimestamp,
	CHAT_DELIVERY_UNCONFIRMED_REASON,
	LEAD_INBOX_SCHEMA,
	LeadInboxQueue,
} from "./lead-inbox-queue.js";
import type {
	Message,
	MessageProvenance,
	ResponseWriteResult,
	Session,
} from "./types.js";
import { deleteContentRef as deleteContentRefFile } from "./utils/content-ref.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  from_agent  TEXT NOT NULL,
  to_agent    TEXT NOT NULL,
  type        TEXT NOT NULL CHECK(type IN ('question','response','instruction','progress','ack_receipt')),
  content     TEXT NOT NULL,
  parent_id   TEXT,
  read_at     DATETIME,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at  DATETIME NOT NULL DEFAULT (datetime('now', '+72 hours')),
  deadline_at TEXT,
  relay_state TEXT NOT NULL DEFAULT 'open' CHECK(relay_state IN ('open','protected','terminal_disposed')),
  resolved_via TEXT,
  logical_event_id TEXT,
  superseded_at DATETIME,
  superseded_by TEXT,
  sender_lease_key TEXT,
  sender_generation INTEGER,
  sender_holder_pid INTEGER,
  sender_holder_start TEXT,
  writer_pid INTEGER,
  writer_start TEXT,
  FOREIGN KEY (parent_id) REFERENCES messages(id)
);
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_response ON messages(parent_id) WHERE type = 'response';
CREATE INDEX IF NOT EXISTS idx_messages_to_agent ON messages(to_agent, type, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id);
CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_name);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runner_phase_wakes_source
  ON runner_phase_wakes(execution_id, source_instruction_id)
  WHERE source_instruction_id IS NOT NULL;
${LEAD_INBOX_SCHEMA}
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
	alert: import("./lead-inbox-queue.js").ReceiptAlertOutboxRow;
	identityKind: "terminal_episode" | "founder_message";
	episodeFingerprint: string;
}

export interface ReceiptWakePolicy {
	transportAvailable?: boolean;
	execPushCap?: number;
	execPushWindowMs?: number;
}

export interface RunnerReceiptWakePushClaim {
	wake: RunnerPhaseWake;
	claimToken: string;
	attempt: number;
	envelope: PhaseWakeInput;
}

export interface InstructionAndIntentInput {
	instructionId: string;
	fromAgent: string;
	executionId: string;
	content: string;
	intentKey: string;
	envelope: PhaseWakeInput;
	queuedAtMs: number;
	provenance?: MessageProvenance;
	wakePolicy?: ReceiptWakePolicy;
}

export interface InstructionAndIntentResult {
	kind: "queued" | "duplicate";
	instructionId: string;
	wake: RunnerPhaseWake;
}

export interface RespondAndReceiptInput {
	questionId: string;
	fromAgent: string;
	content: string;
	rootId: string;
	evidence: Omit<ProcessedEvidenceV1, "ref">;
	now: string;
	intentKey: string;
	envelope: PhaseWakeInput;
	queuedAtMs: number;
	provenance?: MessageProvenance;
}

export interface ResponseAndIntentInput {
	questionId: string;
	fromAgent: string;
	content: string;
	intentKey: string;
	envelope: PhaseWakeInput;
	queuedAtMs: number;
	provenance?: MessageProvenance;
	wakePolicy?: ReceiptWakePolicy;
}

export interface RespondAndReceiptResult {
	responseId: string;
	wake: RunnerPhaseWake;
}

export interface ReviewResponseAndWakeInput {
	questionId: string;
	fromAgent: string;
	content: string;
	expectedOwner: string;
	expectedCheckpoint: "review_design" | "review_code";
	summary: string;
	queuedAtMs: number;
	wakePolicy?: ReceiptWakePolicy;
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
	intentKey?: string;
	envelope?: PhaseWakeInput;
	queuedAtMs?: number;
	/** Test-only transaction seam injection. */
	testCrashAfter?: "effect" | "terminal" | "wake";
}

export interface HandleReceiptResult {
	kind: "handled";
	receiptId: string;
	action: ReceiptHandleAction;
	responseId?: string;
	wake?: RunnerPhaseWake;
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
	intentKey: string;
	envelope: PhaseWakeInput;
	queuedAtMs: number;
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
	intentKey: string;
	envelope: PhaseWakeInput;
	queuedAtMs: number;
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
	intentKey?: string;
	envelope?: PhaseWakeInput;
	queuedAtMs?: number;
}

export type RouteFounderReplyResult =
	| {
			kind: "routed";
			questionId: string;
			responseId: string;
			wake: RunnerPhaseWake;
	  }
	| {
			kind: "stale_candidate";
			questionId: string;
			winningResponseId: string;
	  }
	| { kind: "no_route"; winningResponseId?: string };

export type UnprocessedReceiptAdvance =
	| { kind: "resent"; rootId: string; round: number; resendId: string }
	| { kind: "escalation_queued"; rootId: string; outboxId: string };

export interface UnprocessedReceiptAlertPayload {
	rootId: string;
	episodeId: string;
	targetKey: string;
	toLead: string;
	type: string;
	projectName: string;
	issueId: string;
	issueIdentifier?: string;
	executionId: string;
	questionId?: string;
	threadId?: string;
	firstDeliveredAt: string;
	resendRound: number;
	contentSummary: string;
}

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

function positiveReceiptEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || !raw.trim()) return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`invalid positive receipt configuration ${name}=${raw}`);
	}
	return value;
}

function provenanceValues(
	provenance: MessageProvenance | undefined,
): [
	string | null,
	number | null,
	number | null,
	string | null,
	number | null,
	string | null,
] {
	return [
		provenance?.senderLeaseKey ?? null,
		provenance?.senderGeneration ?? null,
		provenance?.senderHolderPid ?? null,
		provenance?.senderHolderStart ?? null,
		provenance?.writerPid ?? null,
		provenance?.writerStart ?? null,
	];
}

export class CommDB {
	private db: Database.Database;

	/**
	 * Open (or create) the comm database.
	 * @param dbPath - Path to the SQLite file
	 * @param createIfMissing - When false, throws if the DB file doesn't exist.
	 *   Read-only commands (check, pending) should pass false to avoid masking
	 *   configuration errors as "no pending questions".
	 */
	constructor(dbPath: string, createIfMissing = true) {
		if (!createIfMissing && !existsSync(dbPath)) {
			throw new Error(
				`Database not found: ${dbPath}. Has a question been asked yet?`,
			);
		}
		mkdirSync(dirname(dbPath), { recursive: true });
		this.db = new Database(dbPath);
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("busy_timeout = 5000");
		this.db.exec(SCHEMA);
		this.applyMigrations();
		this.purgeExpired();
	}

	/**
	 * Open the database in read-only mode for lightweight polling.
	 * Skips schema creation, migrations, and purge.
	 * Used by TmuxAdapter poll loop for dynamic timeout checks.
	 */
	static openReadonly(dbPath: string): CommDB {
		const instance = Object.create(CommDB.prototype) as CommDB;
		instance.db = new Database(dbPath, { readonly: true });
		instance.db.pragma("busy_timeout = 5000");
		return instance;
	}

	private applyMigrations(): void {
		applyReceiptFoundationMigrations(this.db);
		const columns = this.db
			.prepare("PRAGMA table_info(messages)")
			.all() as Array<{ name: string }>;

		if (!columns.some((c) => c.name === "read_at")) {
			this.db.exec("ALTER TABLE messages ADD COLUMN read_at DATETIME");
		}
		if (!columns.some((c) => c.name === "deadline_at")) {
			try {
				this.db.exec("ALTER TABLE messages ADD COLUMN deadline_at TEXT");
			} catch (error) {
				if (
					!/duplicate column name: deadline_at/i.test((error as Error).message)
				) {
					throw error;
				}
			}
		}
		if (!columns.some((c) => c.name === "checkpoint")) {
			this.db.exec("ALTER TABLE messages ADD COLUMN checkpoint TEXT");
		}
		if (!columns.some((c) => c.name === "content_ref")) {
			this.db.exec("ALTER TABLE messages ADD COLUMN content_ref TEXT");
		}
		if (!columns.some((c) => c.name === "content_type")) {
			this.db.exec(
				"ALTER TABLE messages ADD COLUMN content_type TEXT DEFAULT 'text'",
			);
		}
		if (!columns.some((c) => c.name === "resolved_at")) {
			this.db.exec("ALTER TABLE messages ADD COLUMN resolved_at DATETIME");
		}
		if (!columns.some((c) => c.name === "delivered_at")) {
			// FLY-109: ALTER is not atomic w.r.t. the PRAGMA read above, so two
			// concurrent openers of the same DB can both pass the guard and race
			// on ADD COLUMN. Swallow the racing side's "duplicate column" error —
			// the column is present either way, which is all we need.
			try {
				this.db.exec("ALTER TABLE messages ADD COLUMN delivered_at DATETIME");
			} catch (err) {
				const msg = (err as Error).message ?? "";
				if (!/duplicate column name: delivered_at/i.test(msg)) {
					throw err;
				}
			}
		}
		if (!columns.some((c) => c.name === "attachments")) {
			// GEO-151: ProofShot artifact paths stored as JSON-encoded string[].
			// Same race-tolerance pattern as delivered_at above.
			try {
				this.db.exec("ALTER TABLE messages ADD COLUMN attachments TEXT");
			} catch (err) {
				const msg = (err as Error).message ?? "";
				if (!/duplicate column name: attachments/i.test(msg)) {
					throw err;
				}
			}
		}
		if (!columns.some((c) => c.name === "kind")) {
			// FLY-1041: 'report' marks a fire-and-forget runner→Lead status report
			// (`ask --report`). Deliberately NOT the checkpoint column — GatePoller
			// gives checkpoints gate-eviction / nudge semantics that do not apply
			// to reports. Transport-wise a report is still a question (relayToLead,
			// pending CLI, liveness all unchanged); ONLY the founder-reply
			// candidate set excludes it. Same race-tolerance as delivered_at.
			try {
				this.db.exec("ALTER TABLE messages ADD COLUMN kind TEXT");
			} catch (err) {
				const msg = (err as Error).message ?? "";
				if (!/duplicate column name: kind/i.test(msg)) {
					throw err;
				}
			}
		}
		if (!columns.some((c) => c.name === "relay_state")) {
			try {
				this.db.exec(
					"ALTER TABLE messages ADD COLUMN relay_state TEXT NOT NULL DEFAULT 'open' CHECK(relay_state IN ('open','protected','terminal_disposed'))",
				);
			} catch (err) {
				const msg = (err as Error).message ?? "";
				if (!/duplicate column name: relay_state/i.test(msg)) throw err;
			}
		}
		if (!columns.some((c) => c.name === "logical_event_id")) {
			try {
				this.db.exec("ALTER TABLE messages ADD COLUMN logical_event_id TEXT");
			} catch (err) {
				const msg = (err as Error).message ?? "";
				if (!/duplicate column name: logical_event_id/i.test(msg)) throw err;
			}
		}
		for (const name of ["superseded_at", "superseded_by"] as const) {
			if (columns.some((column) => column.name === name)) continue;
			try {
				this.db.exec(`ALTER TABLE messages ADD COLUMN ${name} TEXT`);
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
		const provenanceColumns = [
			["sender_lease_key", "TEXT"],
			["sender_generation", "INTEGER"],
			["sender_holder_pid", "INTEGER"],
			["sender_holder_start", "TEXT"],
			["writer_pid", "INTEGER"],
			["writer_start", "TEXT"],
		] as const;
		for (const [name, sqlType] of provenanceColumns) {
			if (columns.some((column) => column.name === name)) continue;
			try {
				this.db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${sqlType}`);
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
		this.migrateMessageTypeConstraint();
		// FLY-1328: who disposed of this question — 'owner_closed' (the owning
		// runner's teardown cascade) / 'owner_closed_sweep' (the patrol catching a
		// runner that died without one). NULL for every pre-FLY-1328 row and for
		// every disposal the flag is off for. Deliberately added AFTER the rebuild
		// above: that rebuild carries a fixed column list, so a pre-FLY-1279
		// database must rebuild first and gain the column second, or the column is
		// dropped on the way through. (The converse — a database with resolved_via
		// but no ack_receipt — cannot exist: within one open, rebuild always runs
		// before this ADD.) Same duplicate-column race tolerance as delivered_at.
		const postRebuildColumns = this.db
			.prepare("PRAGMA table_info(messages)")
			.all() as Array<{ name: string }>;
		if (!postRebuildColumns.some((c) => c.name === "resolved_via")) {
			try {
				this.db.exec("ALTER TABLE messages ADD COLUMN resolved_via TEXT");
			} catch (err) {
				const msg = (err as Error).message ?? "";
				if (!/duplicate column name: resolved_via/i.test(msg)) throw err;
			}
		}
		// Existing answered/resolved questions already have machine evidence of a
		// terminal disposition. Do not revive them as actionable during migration.
		this.db.exec(`
			UPDATE messages AS q SET relay_state = 'terminal_disposed'
			 WHERE q.type = 'question'
			   AND q.relay_state != 'terminal_disposed'
			   AND (q.resolved_at IS NOT NULL OR EXISTS (
			     SELECT 1 FROM messages r
			      WHERE r.parent_id = q.id AND r.type = 'response'
			   ))
		`);
		this.db.exec(
			"CREATE INDEX IF NOT EXISTS idx_messages_checkpoint ON messages(checkpoint) WHERE checkpoint IS NOT NULL",
		);
		this.db.exec(
			"CREATE INDEX IF NOT EXISTS idx_messages_logical_event ON messages(logical_event_id) WHERE logical_event_id IS NOT NULL",
		);

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

	/** FLY-1279: SQLite cannot ALTER a CHECK constraint, so add ack_receipt by
	 * rebuilding the table once. All columns are present before this runs. */
	private migrateMessageTypeConstraint(): void {
		const schema = this.db
			.prepare(
				"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'",
			)
			.get() as { sql?: string } | undefined;
		if (schema?.sql?.includes("'ack_receipt'")) return;

		this.db.pragma("foreign_keys = OFF");
		try {
			this.db.transaction(() => {
				this.db.exec(`
					ALTER TABLE messages RENAME TO messages_fly1279_legacy;
					CREATE TABLE messages (
					  id TEXT PRIMARY KEY,
					  from_agent TEXT NOT NULL,
					  to_agent TEXT NOT NULL,
					  type TEXT NOT NULL CHECK(type IN ('question','response','instruction','progress','ack_receipt')),
					  content TEXT NOT NULL,
					  parent_id TEXT,
					  read_at DATETIME,
					  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
					  expires_at DATETIME NOT NULL DEFAULT (datetime('now', '+72 hours')),
					  deadline_at TEXT,
					  checkpoint TEXT,
					  content_ref TEXT,
					  content_type TEXT DEFAULT 'text',
					  resolved_at DATETIME,
					  delivered_at DATETIME,
					  attachments TEXT,
					  kind TEXT,
					  relay_state TEXT NOT NULL DEFAULT 'open' CHECK(relay_state IN ('open','protected','terminal_disposed')),
					  logical_event_id TEXT,
					  sender_lease_key TEXT,
					  sender_generation INTEGER,
					  sender_holder_pid INTEGER,
					  sender_holder_start TEXT,
					  writer_pid INTEGER,
					  writer_start TEXT,
					  FOREIGN KEY (parent_id) REFERENCES messages(id)
					);
					INSERT INTO messages (
					  id, from_agent, to_agent, type, content, parent_id, read_at,
					  created_at, expires_at, deadline_at, checkpoint, content_ref, content_type,
					  resolved_at, delivered_at, attachments, kind, relay_state,
					  logical_event_id, sender_lease_key, sender_generation,
					  sender_holder_pid, sender_holder_start, writer_pid, writer_start
					)
					SELECT id, from_agent, to_agent, type, content, parent_id, read_at,
					  created_at, expires_at, deadline_at, checkpoint, content_ref, content_type,
					  resolved_at, delivered_at, attachments, kind, relay_state,
					  logical_event_id, sender_lease_key, sender_generation,
					  sender_holder_pid, sender_holder_start, writer_pid, writer_start
					FROM messages_fly1279_legacy;
					DROP TABLE messages_fly1279_legacy;
					CREATE UNIQUE INDEX idx_unique_response ON messages(parent_id) WHERE type = 'response';
					CREATE INDEX idx_messages_to_agent ON messages(to_agent, type, created_at);
					CREATE INDEX idx_messages_parent ON messages(parent_id);
					CREATE INDEX idx_messages_expires ON messages(expires_at);
				`);
			})();
		} finally {
			this.db.pragma("foreign_keys = ON");
		}
	}

	purgeExpired(): number {
		return this.purgeExpiredWithRefs();
	}

	purgeExpiredWithRefs(): number {
		if (!commDbProtectionEnabled()) {
			// Exact pre-FLY-1279 behavior for emergency rollback.
			const refs = this.db
				.prepare(
					`SELECT content_ref FROM messages
					 WHERE (expires_at < datetime('now')
					    OR parent_id IN (SELECT id FROM messages WHERE expires_at < datetime('now')))
					   AND content_ref IS NOT NULL`,
				)
				.all() as Array<{ content_ref: string }>;
			for (const { content_ref } of refs) deleteContentRefFile(content_ref);
			const childResult = this.db
				.prepare(
					"DELETE FROM messages WHERE parent_id IN (SELECT id FROM messages WHERE expires_at < datetime('now'))",
				)
				.run();
			const parentResult = this.db
				.prepare("DELETE FROM messages WHERE expires_at < datetime('now')")
				.run();
			return childResult.changes + parentResult.changes;
		}

		const deletableExpired = (
			alias: string,
		) => `${alias}.expires_at < datetime('now')
			AND NOT (
				${alias}.type = 'question'
				AND ${alias}.relay_state != 'terminal_disposed'
				AND NOT EXISTS (
					SELECT 1 FROM messages response
					 WHERE response.parent_id = ${alias}.id AND response.type = 'response'
				)
			)`;
		// Collect content_ref files from both expired messages and their children
		const refs = this.db
			.prepare(
				`SELECT message.content_ref FROM messages message
				 WHERE (${deletableExpired("message")}
				    OR message.parent_id IN (
				      SELECT parent.id FROM messages parent
				       WHERE ${deletableExpired("parent")}
				    ))
				   AND message.content_ref IS NOT NULL`,
			)
			.all() as Array<{ content_ref: string }>;
		for (const { content_ref } of refs) {
			deleteContentRefFile(content_ref);
		}
		// FLY-80: Delete child messages (responses) before parents to satisfy FK constraint.
		// better-sqlite3 enforces foreign_keys=ON by default.
		const childResult = this.db
			.prepare(
				`DELETE FROM messages WHERE parent_id IN (
				   SELECT parent.id FROM messages parent
				    WHERE ${deletableExpired("parent")}
				 )`,
			)
			.run();
		const parentResult = this.db
			.prepare(
				`DELETE FROM messages WHERE id IN (
				   SELECT message.id FROM messages message
				    WHERE ${deletableExpired("message")}
				 )`,
			)
			.run();
		return childResult.changes + parentResult.changes;
	}

	cleanupReadMessages(ttlHours = 24): number {
		return this.cleanupReadMessagesWithRefs(ttlHours);
	}

	cleanupReadMessagesWithRefs(ttlHours = 24): number {
		const cleanupCondition = (alias: string) => `${alias}.read_at IS NOT NULL
			AND ${alias}.created_at < datetime('now', '-' || ? || ' hours')
			${
				commDbProtectionEnabled()
					? `AND NOT (
						${alias}.type = 'question'
						AND ${alias}.relay_state != 'terminal_disposed'
						AND NOT EXISTS (
							SELECT 1 FROM messages response
							 WHERE response.parent_id = ${alias}.id AND response.type = 'response'
						)
					)`
					: ""
			}`;
		const refs = this.db
			.prepare(
				`SELECT message.content_ref FROM messages message
			 WHERE (${cleanupCondition("message")}
			    OR message.parent_id IN (
			      SELECT parent.id FROM messages parent
			       WHERE ${cleanupCondition("parent")}
			    ))
			 AND message.content_ref IS NOT NULL`,
			)
			.all(ttlHours, ttlHours) as Array<{ content_ref: string }>;
		for (const { content_ref } of refs) {
			deleteContentRefFile(content_ref);
		}
		// FLY-80: Delete child messages before parents to satisfy FK constraint
		const childResult = this.db
			.prepare(
				`DELETE FROM messages WHERE parent_id IN (
				   SELECT parent.id FROM messages parent
				    WHERE ${cleanupCondition("parent")}
				 )`,
			)
			.run(ttlHours);
		const parentResult = this.db
			.prepare(
				`DELETE FROM messages WHERE id IN (
				   SELECT message.id FROM messages message
				    WHERE ${cleanupCondition("message")}
				 )`,
			)
			.run(ttlHours);
		return childResult.changes + parentResult.changes;
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
			/** Queue-native SLA copied into lead_inbox during admission. */
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
					   FROM messages WHERE id = ?`,
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
		if (customTtl) {
			this.db
				.prepare(
					`INSERT INTO messages (id, from_agent, to_agent, type, content, checkpoint, content_ref, content_type, kind, deadline_at, expires_at)
		 VALUES (?, ?, ?, 'question', ?, ?, ?, ?, ?, ?, datetime('now', ?))`,
				)
				.run(
					id,
					fromAgent,
					toAgent,
					content,
					opts?.checkpoint ?? null,
					opts?.contentRef ?? null,
					opts?.contentType ?? "text",
					opts?.kind ?? null,
					opts?.deadlineAt ?? null,
					`+${Math.floor(ttl as number)} seconds`,
				);
		} else {
			// Default-TTL path (byte-compat with the pre-FLY-245 schema default).
			this.db
				.prepare(
					`INSERT INTO messages (id, from_agent, to_agent, type, content, checkpoint, content_ref, content_type, kind, deadline_at)
		 VALUES (?, ?, ?, 'question', ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					id,
					fromAgent,
					toAgent,
					content,
					opts?.checkpoint ?? null,
					opts?.contentRef ?? null,
					opts?.contentType ?? "text",
					opts?.kind ?? null,
					opts?.deadlineAt ?? null,
				);
		}
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
				`UPDATE messages SET resolved_at = datetime('now'),
				 relay_state = 'terminal_disposed'
         WHERE id = ? AND type = 'question' AND checkpoint = ?
           AND resolved_at IS NULL AND expires_at > datetime('now')`,
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
			: "expires_at > datetime('now')";
		const info = this.db
			.prepare(
				`UPDATE messages SET
				 resolved_at = datetime('now'),
				 read_at = COALESCE(read_at, datetime('now')),
				 expires_at = datetime('now'),
				 relay_state = 'terminal_disposed',
				 superseded_at = CASE WHEN ? IS NULL THEN superseded_at ELSE datetime('now') END,
				 superseded_by = COALESCE(?, superseded_by)
				 WHERE id = ? AND type = 'question'
				 AND checkpoint = 'approve_to_ship'
				 AND ${answerable}
				 AND NOT EXISTS (
				   SELECT 1 FROM messages r WHERE r.parent_id = messages.id AND r.type = 'response'
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
					   FROM messages WHERE id = ? AND type = 'question'`,
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
					"SELECT 1 FROM messages WHERE parent_id = ? AND type = 'response' LIMIT 1",
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
						`UPDATE messages SET
						   resolved_at = ?,
						   read_at = COALESCE(read_at, ?),
						   expires_at = ?,
						   relay_state = 'terminal_disposed',
						   resolved_via = ?,
						   superseded_at = COALESCE(superseded_at, ?)
						 WHERE id = ? AND type = 'question'
						   AND checkpoint = 'approve_to_ship'
						   AND relay_state != 'terminal_disposed'
						   AND NOT EXISTS (
						     SELECT 1 FROM messages response
						      WHERE response.parent_id = messages.id
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
							"SELECT 1 FROM messages WHERE parent_id = ? AND type = 'response' LIMIT 1",
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
						`SELECT id FROM lead_inbox
						  WHERE resend_of IS NULL AND ref_message_id = ?
						  ORDER BY seq`,
					)
					.all(input.questionId) as Array<{ id: string }>
			).map((row) => row.id);
			const queue = new LeadInboxQueue(this.db);
			for (const receiptId of receiptIds) {
				queue.markDisposed(receiptId, {
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
					`SELECT DISTINCT root.id
					   FROM lead_inbox root
					   JOIN messages source ON source.id = root.ref_message_id
					   JOIN sessions owner ON owner.execution_id = source.from_agent
					  WHERE root.resend_of IS NULL
					    AND owner.execution_id = ?
					  ORDER BY root.seq`,
				)
				.all(executionId) as Array<{ id: string }>
		).map((row) => row.id);
	}

	getReceiptSettlementLineage(receiptId: string):
		| {
				receiptId: string;
				executionId: string;
				questionId: string;
				projectName: string;
				rootLeadId: string;
				sessionLeadId: string | null;
		  }
		| undefined {
		return this.db
			.prepare(
				`SELECT root.id AS receiptId,
				        owner.execution_id AS executionId,
				        source.id AS questionId,
				        owner.project_name AS projectName,
				        root.to_lead AS rootLeadId,
				        owner.lead_id AS sessionLeadId
				   FROM lead_inbox root
				   JOIN messages source ON source.id = root.ref_message_id
				   JOIN sessions owner ON owner.execution_id = source.from_agent
				  WHERE root.id = ? AND root.resend_of IS NULL`,
			)
			.get(receiptId) as
			| {
					receiptId: string;
					executionId: string;
					questionId: string;
					projectName: string;
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
			const queue = new LeadInboxQueue(this.db);
			const root = queue.getById(input.receiptId);
			if (!root)
				return { kind: "missing" as const, receiptId: input.receiptId };
			if (root.resend_of !== null) {
				throw new Error(
					`receipt lineage requires a canonical root: ${root.id}`,
				);
			}
			if (!root.ref_message_id) {
				throw new Error(`receipt lineage has no source message: ${root.id}`);
			}
			const lineage = this.db
				.prepare(
					`SELECT source.from_agent, owner.execution_id
					   FROM messages source
					   JOIN sessions owner ON owner.execution_id = source.from_agent
					  WHERE source.id = ?`,
				)
				.get(root.ref_message_id) as
				| { from_agent: string; execution_id: string }
				| undefined;
			if (
				!lineage ||
				lineage.from_agent !== input.expectedExecutionId ||
				lineage.execution_id !== input.expectedExecutionId
			) {
				throw new Error(
					`receipt lineage mismatch for ${root.id}: expected ${input.expectedExecutionId}`,
				);
			}
			if (root.processed_at !== null || root.processed_evidence !== null) {
				if (root.processed_at === null || root.processed_evidence === null) {
					throw new Error(`receipt ${root.id} has partial processed evidence`);
				}
				return { kind: "processing_won" as const, receiptId: root.id };
			}
			const evidence: ProcessedEvidenceV1 = {
				v: 1,
				kind: "terminal_subject_settlement",
				ref: root.id,
				actor: "terminal-receipt-projector",
				actor_kind: "bridge-protocol",
				fence: {
					execution_id: input.expectedExecutionId,
					reason: input.reason,
				},
				basis: [`receipt:${root.id}`, `source:${root.ref_message_id}`],
			};
			if (root.disposed_at !== null || root.disposed_evidence !== null) {
				if (root.disposed_at === null || root.disposed_evidence === null) {
					throw new Error(`receipt ${root.id} has partial disposed evidence`);
				}
				if (
					!isEquivalentTerminalReceiptDisposal(
						root.disposed_evidence,
						root.id,
						root.ref_message_id,
						input.expectedExecutionId,
					)
				) {
					throw new Error(
						`receipt ${root.id} has conflicting disposed evidence`,
					);
				}
				return { kind: "already_disposed" as const, receiptId: root.id };
			}
			queue.markDisposed(root.id, { now: input.now, evidence });
			return { kind: "disposed" as const, receiptId: root.id };
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
			: "expires_at > datetime('now')";
		// Legacy pending filters on expires_at, so the forensic window only applies
		// where relay_state does the filtering — otherwise the row would linger in
		// the very queue this is clearing.
		const expiry =
			opts.retention === "ask_forensic" && protection
				? `datetime('now', '${ASK_FORENSIC_TTL_SQL}')`
				: "datetime('now')";
		const info = this.db
			.prepare(
				`UPDATE messages SET
				 resolved_at = datetime('now'),
				 read_at = COALESCE(read_at, datetime('now')),
				 expires_at = ${expiry},
				 relay_state = 'terminal_disposed',
				 superseded_at = CASE WHEN ? IS NULL THEN superseded_at ELSE datetime('now') END,
				 superseded_by = COALESCE(?, superseded_by)
				 ${opts.resolvedVia ? ", resolved_via = ?" : ""}
				 WHERE id = ? AND type = 'question'
				 AND from_agent = ?
				 AND ${answerable}
				 AND NOT EXISTS (
				   SELECT 1 FROM messages r WHERE r.parent_id = messages.id AND r.type = 'response'
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
			: "q.expires_at > datetime('now')";
		const row = this.db
			.prepare(
				`SELECT 1 AS hit FROM messages q
	       WHERE q.id = ? AND q.type = 'question'
	       AND NOT EXISTS (
	         SELECT 1 FROM messages r WHERE r.parent_id = q.id AND r.type = 'response'
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
			: "q.expires_at > datetime('now')";
		return this.db
			.prepare(
				`SELECT q.rowid AS row_id, q.id, q.from_agent, q.checkpoint,
				        q.created_at, q.superseded_at, q.superseded_by,
				        CASE WHEN EXISTS (
				          SELECT 1 FROM messages r
				           WHERE r.parent_id = q.id AND r.type = 'response'
				        ) THEN 1 ELSE 0 END AS answered,
				        CASE WHEN ${answerable} AND NOT EXISTS (
				          SELECT 1 FROM messages r
				           WHERE r.parent_id = q.id AND r.type = 'response'
				        ) THEN 1 ELSE 0 END AS pending
				   FROM messages q
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
				          SELECT 1 FROM messages r
				           WHERE r.parent_id = q.id AND r.type = 'response'
				        ) THEN 1 ELSE 0 END AS answered,
				        0 AS pending
				   FROM messages q
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
			: "old.expires_at > datetime('now')";
		const hit = this.db
			.prepare(
				`SELECT 1 AS hit
				   FROM messages old
				   JOIN messages newer ON newer.id = ?
				  WHERE old.id = ?
				    AND old.type = 'question' AND newer.type = 'question'
				    AND old.checkpoint = newer.checkpoint
				    AND old.checkpoint IN ('approve_to_ship','review_design','review_code')
				    AND old.superseded_at IS NULL
				    AND newer.superseded_at IS NULL
				    AND ${answerable}
				    AND NOT EXISTS (
				      SELECT 1 FROM messages r
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
				`UPDATE messages SET
				 resolved_at = datetime('now'),
				 read_at = COALESCE(read_at, datetime('now')),
				 expires_at = datetime('now', '+' || ? || ' hours'),
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
		const question = this.db
			.prepare("SELECT * FROM messages WHERE id = ? AND type = 'question'")
			.get(parentId) as Message | undefined;
		if (!question) {
			throw new Error(`Question ${parentId} not found`);
		}
		return this.db.transaction((): ResponseWriteResult => {
			const id = randomUUID();
			if (question.checkpoint === "approve_to_ship") {
				const answerable = commDbProtectionEnabled()
					? "q.relay_state != 'terminal_disposed'"
					: "q.expires_at > datetime('now')";
				const result = this.db
					.prepare(
						`INSERT INTO messages (
						  id, from_agent, to_agent, type, content, parent_id,
						  sender_lease_key, sender_generation, sender_holder_pid,
						  sender_holder_start, writer_pid, writer_start
						)
						 SELECT ?, ?, q.from_agent, 'response', ?, q.id, ?, ?, ?, ?, ?, ?
						   FROM messages q
						  WHERE q.id = ? AND q.type = 'question'
						    AND q.checkpoint = 'approve_to_ship'
						    AND q.resolved_at IS NULL
						    AND q.superseded_at IS NULL
						    AND ${answerable}
						    AND NOT EXISTS (
						      SELECT 1 FROM messages r
						       WHERE r.parent_id = q.id AND r.type = 'response'
						    )`,
					)
					.run(
						id,
						fromAgent,
						content,
						...provenanceValues(provenance),
						parentId,
					);
				if (result.changes !== 1) {
					return { written: false, reason: "gate_not_open" };
				}
			} else {
				this.db
					.prepare(
						`INSERT INTO messages (
					  id, from_agent, to_agent, type, content, parent_id,
					  sender_lease_key, sender_generation, sender_holder_pid,
					  sender_holder_start, writer_pid, writer_start
					) VALUES (?, ?, ?, 'response', ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						id,
						fromAgent,
						question.from_agent,
						content,
						parentId,
						...provenanceValues(provenance),
					);
			}
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
		this.db
			.prepare(
				`INSERT INTO messages (id, from_agent, to_agent, type, content)
				 VALUES (?, ?, 'bridge', 'ack_receipt', ?)`,
			)
			.run(
				id,
				fromAgent,
				JSON.stringify({ event_seq: eventSeq, ack_token: ackToken }),
			);
		return id;
	}

	getPendingAckReceipts(): Message[] {
		return this.db
			.prepare(
				`SELECT * FROM messages
				 WHERE type = 'ack_receipt' AND read_at IS NULL
				   AND expires_at > datetime('now')
				 ORDER BY created_at, id`,
			)
			.all() as Message[];
	}

	markAckReceiptConsumed(id: string): boolean {
		return (
			this.db
				.prepare(
					`UPDATE messages SET read_at = datetime('now')
					 WHERE id = ? AND type = 'ack_receipt' AND read_at IS NULL`,
				)
				.run(id).changes === 1
		);
	}

	markQuestionProtected(questionId: string, logicalEventId: string): boolean {
		if (!commDbProtectionEnabled()) return true;
		const result = this.db
			.prepare(
				`UPDATE messages SET
				   relay_state = 'protected',
				   logical_event_id = COALESCE(logical_event_id, ?)
				 WHERE id = ? AND type = 'question'
				   AND relay_state != 'terminal_disposed'
				   AND (logical_event_id IS NULL OR logical_event_id = ?)`,
			)
			.run(logicalEventId, questionId, logicalEventId);
		return result.changes === 1;
	}

	markQuestionTerminalDisposed(questionId: string): boolean {
		const result = this.db
			.prepare(
				`UPDATE messages SET relay_state = 'terminal_disposed'
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
			? "q.relay_state != 'terminal_disposed'"
			: "q.expires_at > datetime('now')";
		return this.db.transaction(() => {
			const id = randomUUID();
			const result = this.db
				.prepare(
					`INSERT INTO messages (
					  id, from_agent, to_agent, type, content, parent_id,
					  sender_lease_key, sender_generation, sender_holder_pid,
					  sender_holder_start, writer_pid, writer_start
					)
				 SELECT ?, ?, q.from_agent, 'response', ?, q.id, ?, ?, ?, ?, ?, ?
				   FROM messages q
				  WHERE q.id = ?
				    AND q.type = 'question'
				    AND q.from_agent = ?
				    AND q.checkpoint = ?
				    AND q.resolved_at IS NULL
				    AND ${answerable}
				    AND NOT EXISTS (
				      SELECT 1 FROM messages r
				       WHERE r.parent_id = q.id AND r.type = 'response'
				    )`,
				)
				.run(
					id,
					input.fromAgent,
					input.content,
					...provenanceValues(input.provenance),
					input.questionId,
					input.expectedOwner,
					input.expectedCheckpoint,
				);
			if (result.changes !== 1) return false;
			this.markQuestionTerminalDisposed(input.questionId);
			return true;
		})();
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
			: "q.expires_at > datetime('now')";
		return this.db.transaction(() => {
			const responseId = randomUUID();
			const result = this.db
				.prepare(
					`INSERT INTO messages (
					  id, from_agent, to_agent, type, content, parent_id,
					  sender_lease_key, sender_generation, sender_holder_pid,
					  sender_holder_start, writer_pid, writer_start
					)
					 SELECT ?, ?, q.from_agent, 'response', ?, q.id, ?, ?, ?, ?, ?, ?
					   FROM messages q
					  WHERE q.id = ?
					    AND q.type = 'question'
					    AND q.from_agent = ?
					    AND q.checkpoint = 'approve_to_ship'
					    AND q.resolved_at IS NULL
					    AND q.superseded_at IS NULL
					    AND ${answerable}
					    AND NOT EXISTS (
					      SELECT 1 FROM messages r
					       WHERE r.parent_id = q.id AND r.type = 'response'
					    )`,
				)
				.run(
					responseId,
					input.fromAgent,
					input.content,
					...provenanceValues(input.provenance),
					input.questionId,
					input.expectedOwner,
				);
			if (result.changes !== 1) return false;
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
		})();
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
		const insertResponse = this.db.prepare(
			`INSERT INTO messages (
			   id, from_agent, to_agent, type, content, parent_id,
			   sender_lease_key, sender_generation, sender_holder_pid,
			   sender_holder_start, writer_pid, writer_start
			 )
			 SELECT ?, ?, q.from_agent, 'response', ?, q.id, ?, ?, ?, ?, ?, ?
			   FROM messages q
			  WHERE q.id = ?
			    AND q.type = 'question'
			    AND q.from_agent = ?
			    AND q.checkpoint = ?
			    AND q.resolved_at IS NULL
			    AND q.relay_state != 'terminal_disposed'
			    AND NOT EXISTS (
			      SELECT 1 FROM messages r
			       WHERE r.parent_id = q.id AND r.type = 'response'
			    )`,
		);
		const bumpGrace = this.db.prepare(
			`UPDATE messages SET
			 resolved_at = datetime('now'),
			 read_at = COALESCE(read_at, datetime('now')),
			 expires_at = datetime('now', '+' || ? || ' hours'),
			 relay_state = 'terminal_disposed'
			 WHERE id = ? AND type = 'question'`,
		);
		const txn = this.db.transaction((): boolean => {
			const res = insertResponse.run(
				randomUUID(),
				input.fromAgent,
				input.content,
				...provenanceValues(input.provenance),
				input.questionId,
				input.expectedOwner,
				input.expectedCheckpoint,
			);
			if (res.changes === 0) return false;
			bumpGrace.run(graceHours, input.questionId);
			return true;
		});
		return txn();
	}

	getResponse(questionId: string): Message | undefined {
		return this.db
			.prepare(
				"SELECT * FROM messages WHERE parent_id = ? AND type = 'response'",
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
		return this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as
			| Message
			| undefined;
	}

	getPendingQuestions(leadId: string): Message[] {
		const answerable = commDbProtectionEnabled()
			? "q.relay_state != 'terminal_disposed'"
			: "q.expires_at > datetime('now')";
		return this.db
			.prepare(
				`SELECT q.* FROM messages q
         WHERE q.to_agent = ? AND q.type = 'question'
         AND NOT EXISTS (
           SELECT 1 FROM messages r WHERE r.parent_id = q.id AND r.type = 'response'
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
				`SELECT q.* FROM messages q
         WHERE q.from_agent = ? AND q.type = 'question'
         AND q.checkpoint IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM messages r WHERE r.parent_id = q.id AND r.type = 'response'
         )
         AND q.expires_at > datetime('now')
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
			: "q.expires_at > datetime('now')";
		return this.db
			.prepare(
				`SELECT q.* FROM messages q
         WHERE q.from_agent = ? AND q.type = 'question'
         AND q.checkpoint = ?
         AND NOT EXISTS (
           SELECT 1 FROM messages r WHERE r.parent_id = q.id AND r.type = 'response'
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
		this.db
			.prepare(
				`INSERT ${opts?.dedupeId ? "OR IGNORE " : ""}INTO messages (
				  id, from_agent, to_agent, type, content,
				  sender_lease_key, sender_generation, sender_holder_pid,
				  sender_holder_start, writer_pid, writer_start
				) VALUES (?, ?, ?, 'instruction', ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				fromAgent,
				toAgent,
				content,
				...provenanceValues(opts?.provenance),
			);
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
		const info = this.db
			.prepare(
				`INSERT OR IGNORE INTO messages (
				  id, from_agent, to_agent, type, content,
				  sender_lease_key, sender_generation, sender_holder_pid,
				  sender_holder_start, writer_pid, writer_start
				) VALUES (?, ?, ?, 'instruction', ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(id, fromAgent, toAgent, content, ...provenanceValues(provenance));
		return info.changes > 0;
	}

	enqueueFounderHubRoot(input: EnqueueFounderHubRootInput): LeadInboxRow {
		return new LeadInboxQueue(this.db).enqueueHubRoot(input);
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
				const queue = new LeadInboxQueue(this.db);
				const root = queue.getById(input.rootId);
				if (!root) return { kind: "missing" as const };
				if (
					root.disposed_at !== null ||
					root.disposed_evidence !== null ||
					(root.processed_at === null) !== (root.processed_evidence === null)
				) {
					return { kind: "conflict" as const };
				}
				let rootPayload: ReturnType<CommDB["parseFounderRootPayload"]>;
				try {
					rootPayload = this.parseFounderRootPayload(root.content);
				} catch {
					return { kind: "conflict" as const };
				}
				if (
					root.ref_message_id !== rootPayload.msgId ||
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
				if (root.processed_at !== null && root.processed_evidence !== null) {
					let existingEvidence: ProcessedEvidenceV1;
					try {
						existingEvidence = JSON.parse(
							root.processed_evidence,
						) as ProcessedEvidenceV1;
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
								   FROM messages WHERE id = ?`,
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
					} else if (existingEvidence.ref !== input.evidence.ref) {
						return { kind: "conflict" as const, evidenceKind };
					}
					const discordFence =
						existingEvidence.fence.discord_message_id === rootPayload.msgId;
					const sourceEventFence =
						typeof existingEvidence.fence.source_event_id === "string" &&
						typeof inputQuestionBasis === "string" &&
						existingEvidence.fence.source_event_id.endsWith(
							`:${inputQuestionBasis.slice("question:".length)}:${rootPayload.msgId}`,
						);
					if (!discordFence && !sourceEventFence) {
						return { kind: "conflict" as const, evidenceKind };
					}
					result = "verified";
				} else {
					queue.markProcessed(input.rootId, {
						now: input.now,
						evidence: input.evidence,
					});
					evidenceKind = input.evidence.kind;
					result = "marked";
				}
				const updated = this.db
					.prepare(
						`UPDATE lead_inbox SET routing_state = 'bound',
						   next_unprocessed_at = NULL
						 WHERE id = ? AND processed_at IS NOT NULL
						   AND processed_evidence IS NOT NULL
						   AND disposed_at IS NULL`,
					)
					.run(input.rootId);
				if (updated.changes !== 1) {
					return { kind: "conflict" as const, evidenceKind };
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
	}): LeadInboxRow[] {
		return new LeadInboxQueue(this.db).listExternalPendingForLane({
			...input,
			idPrefix: `chat:${input.toLead}:`,
		});
	}

	/**
	 * Quarantine is visibility, never disposal: later redelivery may still mark
	 * the same external row delivered. The fixed reason keeps retries idempotent.
	 */
	quarantineChatReceipt(input: { receiptId: string; now: string }): boolean {
		const queue = new LeadInboxQueue(this.db);
		queue.quarantineExternalDelivery(input.receiptId, {
			now: input.now,
			reason: CHAT_DELIVERY_UNCONFIRMED_REASON,
		});
		const row = queue.getById(input.receiptId);
		const alert = queue.getReceiptAlertOutbox(
			`external_saga_unknown:${input.receiptId}`,
		);
		return Boolean(
			row?.carrier === "external" &&
				row.delivered_at === null &&
				row.disposed_at === null &&
				row.disposition === "delivery_quarantined" &&
				row.last_error === CHAT_DELIVERY_UNCONFIRMED_REASON &&
				alert?.kind === "external_saga_unknown",
		);
	}

	/**
	 * Handle one founder receipt as Lead: relay the original message to an
	 * eligible pending runner question, or close it explicitly as no-route.
	 * New FLY-1392 roots carry no Bridge-generated candidates; legacy promoted
	 * families retain their frozen-candidate checks. The business write,
	 * processed receipt(s), and wake intent share this transaction.
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
		const routeId = founderRouteRowId(leadId, msgId);
		const fence = this.processedFenceFromProvenance(input.provenance);

		return this.db
			.transaction((): RouteFounderReplyResult => {
				const queue = new LeadInboxQueue(this.db);
				const root = queue.getById(rootId);
				const route = queue.getById(routeId);
				if (
					!root ||
					root.to_lead !== leadId ||
					root.source !== "founder_reply" ||
					root.type !== "founder_reply" ||
					root.ref_message_id !== msgId
				) {
					throw new Error(
						`founder receipt root ${leadId}:${msgId} is unavailable`,
					);
				}
				if (
					route &&
					(route.to_lead !== leadId ||
						route.family_root_id !== rootId ||
						!route.candidates_json)
				) {
					throw new Error(
						`founder route family ${leadId}:${msgId} is unavailable`,
					);
				}
				const rootPayload = this.parseFounderRootPayload(root.content);
				const candidates = route
					? this.parseFounderRouteCandidates(route.candidates_json as string)
					: null;
				if (candidates && candidates.leadId !== leadId) {
					throw new Error("founder route lead scope mismatch");
				}

				if (
					root.processed_at !== null ||
					(route !== undefined && route.processed_at !== null)
				) {
					if (
						root.processed_at === null ||
						!root.processed_evidence ||
						(route !== undefined &&
							(route.processed_at === null ||
								root.processed_evidence !== route.processed_evidence))
					) {
						throw new Error("founder route family has split processed state");
					}
					const evidence = JSON.parse(
						root.processed_evidence,
					) as ProcessedEvidenceV1;
					if (
						toQuestionId &&
						evidence.kind === "lead_routed" &&
						evidence.actor === leadId &&
						evidence.basis?.includes(`question:${toQuestionId}`)
					) {
						const wake = this.db
							.prepare("SELECT * FROM runner_phase_wakes WHERE message_id = ?")
							.get(input.intentKey ?? "") as RunnerPhaseWake | undefined;
						if (!wake) throw new Error("routed founder reply wake is missing");
						return {
							kind: "routed",
							questionId: toQuestionId,
							responseId: evidence.ref,
							wake,
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
						for (const questionId of candidates?.questionIds ?? []) {
							const response = this.getResponse(questionId);
							if (response) {
								winningResponseId = response.id;
								break;
							}
						}
						if (!winningResponseId) {
							throw new Error(
								"already_answered requires a winning frozen-candidate response",
							);
						}
					}
					const evidence: ProcessedEvidenceV1 = {
						v: 1,
						kind: "lead_no_route",
						ref: winningResponseId ?? route?.id ?? rootId,
						actor: leadId,
						actor_kind: "lead",
						fence,
						basis: [noRouteReason],
					};
					queue.markProcessed(rootId, { now: input.now, evidence });
					if (route) {
						queue.markProcessed(routeId, { now: input.now, evidence });
					}
					const familyIds = route ? [rootId, routeId] : [rootId];
					const closed = this.db
						.prepare(
							`UPDATE lead_inbox SET routing_state = 'no_route',
						   next_unprocessed_at = NULL,
						   consumed_at = COALESCE(consumed_at, ?),
						   disposition = CASE WHEN id = ? THEN 'lead_no_route'
						                      ELSE disposition END
						 WHERE id IN (${familyIds.map(() => "?").join(",")})
						   AND processed_at IS NOT NULL`,
						)
						.run(input.now, route?.id ?? rootId, ...familyIds);
					if (closed.changes !== familyIds.length) {
						throw new Error("founder no-route family closure failed");
					}
					return {
						kind: "no_route",
						...(winningResponseId ? { winningResponseId } : {}),
					};
				}

				const questionId = toQuestionId as string;
				if (candidates && !candidates.questionIds.includes(questionId)) {
					throw new Error(`question ${questionId} is not a frozen candidate`);
				}
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
					session.issue_id !== rootPayload.issueId ||
					(candidates !== null &&
						(candidates.projectName !== rootPayload.projectName ||
							candidates.issueId !== rootPayload.issueId ||
							candidates.threadId !== rootPayload.threadId))
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
				if (
					!input.intentKey ||
					!input.envelope ||
					input.queuedAtMs === undefined
				) {
					throw new Error("question route requires a wake intent");
				}
				const responseId = randomUUID();
				this.db
					.prepare(
						`INSERT INTO messages (
					  id, from_agent, to_agent, type, content, parent_id,
					  sender_lease_key, sender_generation, sender_holder_pid,
					  sender_holder_start, writer_pid, writer_start
					) VALUES (?, ?, ?, 'response', ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						responseId,
						leadId,
						question.from_agent,
						rootPayload.answer,
						questionId,
						...provenanceValues(input.provenance),
					);
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
				queue.markProcessed(rootId, { now: input.now, evidence });
				if (route) {
					queue.markProcessed(routeId, { now: input.now, evidence });
				}
				const familyIds = route ? [rootId, routeId] : [rootId];
				const closed = this.db
					.prepare(
						`UPDATE lead_inbox SET routing_state = 'bound',
					   next_unprocessed_at = NULL,
					   consumed_at = COALESCE(consumed_at, ?),
					   disposition = CASE WHEN id = ? THEN 'routed_question'
					                      ELSE disposition END
					 WHERE id IN (${familyIds.map(() => "?").join(",")})
					   AND processed_at IS NOT NULL`,
					)
					.run(input.now, route?.id ?? rootId, ...familyIds);
				if (closed.changes !== familyIds.length) {
					throw new Error("founder route family closure failed");
				}
				const wake = this.admitReceiptWakeIntent({
					executionId: question.from_agent,
					intentKey: input.intentKey,
					envelope: input.envelope,
					queuedAtMs: input.queuedAtMs,
					purpose: "park_wake",
				});
				return { kind: "routed", questionId, responseId, wake };
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

	private parseFounderRouteCandidates(
		encoded: string,
	): FrozenFounderRouteCandidatesV1 {
		let parsed: unknown;
		try {
			parsed = JSON.parse(encoded);
		} catch {
			throw new Error("founder route candidates_json is invalid JSON");
		}
		const value = parsed as Partial<FrozenFounderRouteCandidatesV1>;
		if (
			value?.v !== 1 ||
			!Array.isArray(value.questionIds) ||
			value.questionIds.some((id) => typeof id !== "string" || !id.trim()) ||
			typeof value.leadId !== "string" ||
			typeof value.projectName !== "string" ||
			typeof value.issueId !== "string" ||
			typeof value.threadId !== "string"
		) {
			throw new Error("founder route candidates_json has invalid shape");
		}
		return value as FrozenFounderRouteCandidatesV1;
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
	 * FLY-1392: one CommDB unit of work for a Lead instruction and the wake
	 * intent that must make that instruction observable to the target runner.
	 * Transport I/O deliberately happens after this durable commit.
	 */
	instructionAndIntent(
		input: InstructionAndIntentInput,
	): InstructionAndIntentResult {
		for (const [field, value] of [
			["instructionId", input.instructionId],
			["fromAgent", input.fromAgent],
			["executionId", input.executionId],
			["content", input.content],
			["intentKey", input.intentKey],
			["envelope.id", input.envelope.id],
			["envelope.content", input.envelope.content],
		] as const) {
			if (!value.trim()) throw new Error(`${field} is required`);
		}
		if (input.envelope.to !== input.executionId) {
			throw new Error(
				`wake envelope target mismatch: expected ${input.executionId}, got ${input.envelope.to}`,
			);
		}
		if (!Number.isSafeInteger(input.queuedAtMs) || input.queuedAtMs < 0) {
			throw new Error("queuedAtMs must be a non-negative safe integer");
		}
		const envelopeJson = JSON.stringify(input.envelope);

		return this.db
			.transaction((): InstructionAndIntentResult => {
				this.db
					.prepare(
						`INSERT OR IGNORE INTO messages (
					  id, from_agent, to_agent, type, content,
					  sender_lease_key, sender_generation, sender_holder_pid,
					  sender_holder_start, writer_pid, writer_start
					) VALUES (?, ?, ?, 'instruction', ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						input.instructionId,
						input.fromAgent,
						input.executionId,
						input.content,
						...provenanceValues(input.provenance),
					);
				const instruction = this.db
					.prepare(
						"SELECT id, from_agent, to_agent, type, content FROM messages WHERE id = ?",
					)
					.get(input.instructionId) as
					| {
							id: string;
							from_agent: string;
							to_agent: string;
							type: string;
							content: string;
					  }
					| undefined;
				if (
					!instruction ||
					instruction.from_agent !== input.fromAgent ||
					instruction.to_agent !== input.executionId ||
					instruction.type !== "instruction" ||
					instruction.content !== input.content
				) {
					throw new Error(
						`instruction id ${input.instructionId} was reused with different content`,
					);
				}

				const existing = this.db
					.prepare(
						`SELECT * FROM runner_phase_wakes
					 WHERE execution_id = ?
					   AND (message_id = ? OR source_instruction_id = ?)
					 ORDER BY queue_seq LIMIT 1`,
					)
					.get(input.executionId, input.intentKey, input.instructionId) as
					| RunnerPhaseWake
					| undefined;
				if (existing) {
					if (
						existing.message_id !== input.intentKey ||
						existing.source_instruction_id !== input.instructionId ||
						existing.envelope_json !== envelopeJson
					) {
						throw new Error(
							`wake intent ${input.intentKey} was reused with different content`,
						);
					}
					return {
						kind: "duplicate",
						instructionId: input.instructionId,
						wake: existing,
					};
				}

				const wake = this.admitReceiptWakeIntent({
					executionId: input.executionId,
					intentKey: input.intentKey,
					envelope: input.envelope,
					queuedAtMs: input.queuedAtMs,
					sourceInstructionId: input.instructionId,
					wakePolicy: input.wakePolicy,
					purpose: "message_traffic",
				});
				return {
					kind: "queued",
					instructionId: input.instructionId,
					wake,
				};
			})
			.immediate();
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
		if (
			(input.action === "relay" || input.action === "respond") &&
			(!input.intentKey?.trim() ||
				!input.envelope ||
				input.queuedAtMs === undefined)
		) {
			throw new Error(`${input.action} requires a wake intent`);
		}

		const payloadDigest = canonicalSubmissionDigest({
			receiptId,
			action: input.action,
			targetQuestionId: input.targetQuestionId?.trim(),
			content: input.content?.trim(),
			reason: input.reason?.trim(),
			intentKey: input.intentKey?.trim(),
			envelope: input.envelope,
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

				const queue = new LeadInboxQueue(this.db);
				const receipt = queue.getById(receiptId);
				if (!receipt) throw new Error(`receipt_not_found: ${receiptId}`);
				if (receipt.to_lead !== authenticatedLead) {
					throw new Error(
						`not_authorized: receipt belongs to ${receipt.to_lead}`,
					);
				}
				if (receipt.delivered_at === null) {
					throw new Error(`receipt_not_delivered: ${receiptId}`);
				}
				if (receipt.processed_at !== null) {
					throw new Error(`already_processed: ${receiptId}`);
				}
				if (receipt.disposed_at !== null) {
					throw new Error(`already_disposed: ${receiptId}`);
				}

				let responseId: string | undefined;
				let wake: RunnerPhaseWake | undefined;
				if (input.action === "relay" || input.action === "respond") {
					const questionId = input.targetQuestionId?.trim() as string;
					const question = this.db
						.prepare(
							`SELECT id, from_agent, resolved_at, superseded_at, relay_state
							   FROM messages WHERE id = ? AND type = 'question'`,
						)
						.get(questionId) as
						| {
								id: string;
								from_agent: string;
								resolved_at: string | null;
								superseded_at: string | null;
								relay_state: string;
						  }
						| undefined;
					if (
						!question ||
						question.resolved_at !== null ||
						question.superseded_at !== null ||
						question.relay_state === "terminal_disposed" ||
						this.getResponse(questionId)
					) {
						throw new Error(`business_object_not_pending: ${questionId}`);
					}
					if (input.envelope?.to !== question.from_agent) {
						throw new Error("wake target must match the question owner");
					}
					responseId = randomUUID();
					this.db
						.prepare(
							`INSERT INTO messages (
							   id, from_agent, to_agent, type, content, parent_id,
							   sender_lease_key, sender_generation, sender_holder_pid,
							   sender_holder_start, writer_pid, writer_start
							 ) VALUES (?, ?, ?, 'response', ?, ?, ?, ?, ?, ?, ?, ?)`,
						)
						.run(
							responseId,
							authenticatedLead,
							question.from_agent,
							input.content?.trim(),
							questionId,
							...provenanceValues(input.provenance),
						);
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
				queue.markProcessed(receiptId, { now: input.now, evidence });
				if (input.testCrashAfter === "terminal") {
					throw new Error("injected receipt handle crash after terminal");
				}

				if (input.action === "relay" || input.action === "respond") {
					wake = this.admitReceiptWakeIntent({
						executionId: input.envelope?.to as string,
						intentKey: input.intentKey as string,
						envelope: input.envelope as PhaseWakeInput,
						queuedAtMs: input.queuedAtMs as number,
						purpose: "park_wake",
					});
				}
				if (input.testCrashAfter === "wake") {
					throw new Error("injected receipt handle crash after wake");
				}

				const result: HandleReceiptResult = {
					kind: "handled",
					receiptId,
					action: input.action,
					...(responseId ? { responseId } : {}),
					...(wake ? { wake } : {}),
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
	 * evidence, and the runner wake intent either all commit or all roll back.
	 */
	respondAndReceipt(input: RespondAndReceiptInput): RespondAndReceiptResult {
		for (const [field, value] of [
			["questionId", input.questionId],
			["fromAgent", input.fromAgent],
			["content", input.content],
			["rootId", input.rootId],
			["intentKey", input.intentKey],
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
					        superseded_at FROM messages
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
				const inserted = this.db
					.prepare(
						`INSERT INTO messages (
						  id, from_agent, to_agent, type, content, parent_id,
						  sender_lease_key, sender_generation, sender_holder_pid,
						  sender_holder_start, writer_pid, writer_start
						)
						SELECT ?, ?, q.from_agent, 'response', ?, q.id, ?, ?, ?, ?, ?, ?
						  FROM messages q
						 WHERE q.id = ? AND q.type = 'question'
						   AND q.resolved_at IS NULL AND q.superseded_at IS NULL
						   AND q.relay_state != 'terminal_disposed'
						   AND NOT EXISTS (
						     SELECT 1 FROM messages r
						      WHERE r.parent_id = q.id AND r.type = 'response'
						   )`,
					)
					.run(
						responseId,
						input.fromAgent,
						input.content,
						...provenanceValues(input.provenance),
						input.questionId,
					);
				if (inserted.changes !== 1) {
					throw new Error(`question ${input.questionId} is no longer open`);
				}
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
			const queue = new LeadInboxQueue(this.db);
			queue.markProcessed(input.rootId, { now: input.now, evidence });
			const rootUpdated = this.db
				.prepare(
					`UPDATE lead_inbox SET routing_state = 'bound',
					   next_unprocessed_at = NULL
					 WHERE id = ? AND processed_at IS NOT NULL
					   AND processed_evidence IS NOT NULL`,
				)
				.run(input.rootId);
			if (rootUpdated.changes !== 1) {
				throw new Error(`founder receipt root ${input.rootId} is unavailable`);
			}
			const wake = this.admitReceiptWakeIntent({
				executionId: question.from_agent,
				intentKey: input.intentKey,
				envelope: input.envelope,
				queuedAtMs: input.queuedAtMs,
				purpose: "park_wake",
			});
			return { responseId: response.id, wake };
		})();
	}

	/** Response + wake intent in one transaction for gate/ask answers. */
	responseAndIntent(input: ResponseAndIntentInput): RespondAndReceiptResult {
		return this.db
			.transaction(() => {
				const question = this.db
					.prepare(
						`SELECT id, from_agent, resolved_at, superseded_at, relay_state
					 FROM messages WHERE id = ? AND type = 'question'`,
					)
					.get(input.questionId) as
					| {
							id: string;
							from_agent: string;
							resolved_at: string | null;
							superseded_at: string | null;
							relay_state: string;
					  }
					| undefined;
				if (!question)
					throw new Error(`Question ${input.questionId} not found`);
				let response = this.getResponse(input.questionId);
				if (!response) {
					const responseId = randomUUID();
					const inserted = this.db
						.prepare(
							`INSERT INTO messages (
						  id, from_agent, to_agent, type, content, parent_id,
						  sender_lease_key, sender_generation, sender_holder_pid,
						  sender_holder_start, writer_pid, writer_start
						)
						SELECT ?, ?, q.from_agent, 'response', ?, q.id, ?, ?, ?, ?, ?, ?
						  FROM messages q
						 WHERE q.id = ? AND q.type = 'question'
						   AND q.resolved_at IS NULL AND q.superseded_at IS NULL
						   AND q.relay_state != 'terminal_disposed'
						   AND NOT EXISTS (
						     SELECT 1 FROM messages r
						      WHERE r.parent_id = q.id AND r.type = 'response'
						   )`,
						)
						.run(
							responseId,
							input.fromAgent,
							input.content,
							...provenanceValues(input.provenance),
							input.questionId,
						);
					if (inserted.changes !== 1) {
						throw new Error(`question ${input.questionId} is no longer open`);
					}
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
				const wake = this.admitReceiptWakeIntent({
					executionId: question.from_agent,
					intentKey: input.intentKey,
					envelope: input.envelope,
					queuedAtMs: input.queuedAtMs,
					wakePolicy: input.wakePolicy,
					purpose: "park_wake",
				});
				return { responseId: response.id, wake };
			})
			.immediate();
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
			const queue = new LeadInboxQueue(this.db);
			queue.markProcessed(input.rootId, { now: input.now, evidence });
			const rootUpdated = this.db
				.prepare(
					`UPDATE lead_inbox SET routing_state = 'bound',
					   next_unprocessed_at = NULL
					 WHERE id = ? AND processed_at IS NOT NULL
					   AND processed_evidence IS NOT NULL`,
				)
				.run(input.rootId);
			if (rootUpdated.changes !== 1) {
				throw new Error(`founder receipt root ${input.rootId} is unavailable`);
			}
			const wake = this.admitReceiptWakeIntent({
				executionId: input.expectedOwner,
				intentKey: input.intentKey,
				envelope: input.envelope,
				queuedAtMs: input.queuedAtMs,
				purpose: "park_wake",
			});
			return { responseId: response.id, wake };
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
				const queue = new LeadInboxQueue(this.db);
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
				queue.markProcessed(input.rootId, { now: input.now, evidence });
				const updated = this.db
					.prepare(
						`UPDATE lead_inbox SET routing_state = 'bound',
					   next_unprocessed_at = NULL
					 WHERE id = ? AND processed_at IS NOT NULL`,
					)
					.run(input.rootId);
				if (updated.changes !== 1) {
					throw new Error(
						`founder receipt root ${input.rootId} is unavailable`,
					);
				}
				const wake = this.admitReceiptWakeIntent({
					executionId: input.expectedOwner,
					intentKey: input.intentKey,
					envelope: input.envelope,
					queuedAtMs: input.queuedAtMs,
					purpose: "park_wake",
				});
				return { responseId: response.id, wake };
			})
			.immediate();
	}

	private admitReceiptWakeIntent(input: {
		executionId: string;
		intentKey: string;
		envelope: PhaseWakeInput;
		queuedAtMs: number;
		sourceInstructionId?: string | null;
		wakePolicy?: ReceiptWakePolicy;
		purpose: NonNullable<RunnerPhaseWake["purpose"]>;
	}): RunnerPhaseWake {
		if (input.envelope.to !== input.executionId) {
			throw new Error(
				`wake envelope target mismatch: expected ${input.executionId}, got ${input.envelope.to}`,
			);
		}
		if (!Number.isSafeInteger(input.queuedAtMs) || input.queuedAtMs < 0) {
			throw new Error("queuedAtMs must be a non-negative safe integer");
		}
		const envelopeJson = JSON.stringify(input.envelope);
		const metadataJson = input.envelope.metadata
			? JSON.stringify(input.envelope.metadata)
			: null;
		const existing = this.db
			.prepare(
				`SELECT * FROM runner_phase_wakes
				 WHERE execution_id = ?
				   AND (message_id = ? OR (? IS NOT NULL AND source_instruction_id = ?))
				 ORDER BY queue_seq LIMIT 1`,
			)
			.get(
				input.executionId,
				input.intentKey,
				input.sourceInstructionId ?? null,
				input.sourceInstructionId ?? null,
			) as RunnerPhaseWake | undefined;
		if (existing) {
			if (
				existing.message_id !== input.intentKey ||
				existing.source_instruction_id !==
					(input.sourceInstructionId ?? existing.source_instruction_id) ||
				existing.envelope_json !== envelopeJson ||
				existing.purpose !== input.purpose
			) {
				throw new Error(
					`wake intent ${input.intentKey} was reused with different content`,
				);
			}
			return existing;
		}

		const policy = input.wakePolicy ?? {};
		const registeredVendor = (
			this.db
				.prepare("SELECT vendor FROM sessions WHERE execution_id = ?")
				.get(input.executionId) as { vendor: string | null } | undefined
		)?.vendor;
		const transportAvailable =
			policy.transportAvailable ?? registeredVendor !== "none";
		const execPushCap =
			policy.execPushCap ??
			positiveReceiptEnv("FLYWHEEL_RECEIPT_EXEC_PUSH_CAP", 6);
		const execPushWindowMs =
			policy.execPushWindowMs ??
			positiveReceiptEnv("FLYWHEEL_RECEIPT_EXEC_PUSH_WINDOW_MIN", 10) * 60_000;
		if (!Number.isSafeInteger(execPushCap) || execPushCap < 1) {
			throw new Error("execPushCap must be a positive safe integer");
		}
		if (!Number.isSafeInteger(execPushWindowMs) || execPushWindowMs < 1) {
			throw new Error("execPushWindowMs must be a positive safe integer");
		}
		const windowStart =
			Math.floor(input.queuedAtMs / execPushWindowMs) * execPushWindowMs;
		const admittedInWindow = (
			this.db
				.prepare(
					`SELECT COUNT(*) AS count FROM runner_phase_wakes
					 WHERE execution_id = ? AND admission_state = 'queued'
					   AND purpose != 'gate_response'
					   AND queued_at > ? AND queued_at <= ?`,
				)
				.get(
					input.executionId,
					input.queuedAtMs - execPushWindowMs,
					input.queuedAtMs,
				) as { count: number }
		).count;
		const admissionState: NonNullable<RunnerPhaseWake["admission_state"]> =
			!transportAvailable
				? "skipped_no_transport"
				: input.purpose !== "gate_response" && admittedInWindow >= execPushCap
					? "suppressed_cap"
					: "queued";
		this.db
			.prepare(
				`INSERT INTO runner_phase_wakes (
				  execution_id, message_id, content, metadata_json,
				  source_instruction_id, state, queued_at, admission_state,
				  envelope_json, push_attempts, purpose
				) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, 0, ?)`,
			)
			.run(
				input.executionId,
				input.intentKey,
				input.envelope.content,
				metadataJson,
				input.sourceInstructionId ?? null,
				input.queuedAtMs,
				admissionState,
				envelopeJson,
				input.purpose,
			);
		if (admissionState === "suppressed_cap") {
			const outboxId = `wake_cap:${input.executionId}:${windowStart}`;
			this.db
				.prepare(
					`INSERT OR IGNORE INTO receipt_alert_outbox
					 (id, kind, payload, created_at)
					 VALUES (?, 'wake_cap', ?, ?)`,
				)
				.run(
					outboxId,
					JSON.stringify({
						executionId: input.executionId,
						windowStart,
						windowMs: execPushWindowMs,
						cap: execPushCap,
					}),
					new Date(input.queuedAtMs).toISOString(),
				);
		}
		return this.db
			.prepare(
				"SELECT * FROM runner_phase_wakes WHERE execution_id = ? AND message_id = ?",
			)
			.get(input.executionId, input.intentKey) as RunnerPhaseWake;
	}

	/**
	 * FLY-1434 ⑧: atomically persist a Bridge-owned review response and the
	 * purpose-bound wake that makes it observable. An exact replay repairs an
	 * older owned response that committed before the wake existed. Foreign
	 * answers and non-queued admissions fail closed.
	 */
	insertReviewResponseWithWakeIfGateOpen(
		input: ReviewResponseAndWakeInput,
	): RespondAndReceiptResult | null {
		class ReviewWakeAdmissionError extends Error {}
		try {
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
					const wake = this.admitReceiptWakeIntent({
						executionId: input.expectedOwner,
						intentKey: response.id,
						envelope: {
							id: response.id,
							to: input.expectedOwner,
							content:
								`Your review request has been answered: ${input.summary} ` +
								`(question ${input.questionId}). Read the durable answer with ` +
								`flywheel-comm check ${input.questionId}. This wake carries NO authority.`,
							metadata: {
								kind: "review_response",
								questionId: input.questionId,
								responseId: response.id,
							},
						},
						queuedAtMs: input.queuedAtMs,
						wakePolicy: input.wakePolicy,
						purpose: "gate_response",
					});
					if (wake.admission_state !== "queued") {
						throw new ReviewWakeAdmissionError(
							`review response wake admission failed: ${wake.admission_state}`,
						);
					}
					return { responseId: response.id, wake };
				})
				.immediate();
		} catch (error) {
			if (error instanceof ReviewWakeAdmissionError) return null;
			throw error;
		}
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
	 * messages.type CHECK constraint only allows
	 * ('question','response','instruction','progress') — see schema at top of
	 * file. Attachments stored as JSON-encoded string[] in the `attachments`
	 * column added by the GEO-151 migration above.
	 *
	 * `content` carries a short summary line ("artifact_emitted: N file(s)")
	 * so the audit row is human-readable in `messages` inspections.
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
				`INSERT INTO messages (id, from_agent, to_agent, type, content, content_type, attachments)
         VALUES (?, ?, ?, 'progress', ?, 'artifact', ?)`,
			)
			.run(id, fromAgent, toAgent, summary, JSON.stringify(paths));
		return id;
	}

	getUnreadInstructions(agentId: string): Message[] {
		return this.db
			.prepare(
				`SELECT * FROM messages
         WHERE to_agent = ? AND type = 'instruction' AND read_at IS NULL
         AND expires_at > datetime('now')
         ORDER BY created_at ASC`,
			)
			.all(agentId) as Message[];
	}

	markInstructionRead(id: string): void {
		this.db
			.prepare("UPDATE messages SET read_at = datetime('now') WHERE id = ?")
			.run(id);
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
					.prepare("SELECT id, to_agent, type FROM messages WHERE id = ?")
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
						`UPDATE messages SET read_at = COALESCE(read_at, datetime('now'))
						 WHERE id = ? AND to_agent = ? AND type = 'instruction'`,
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
	deriveProcessedReceipts(now: string): number {
		assertUtcIsoTimestamp(now, "now");
		const derive = this.db.transaction(() => {
			const candidates = this.db
				.prepare(
					`SELECT receipt.id AS receipt_id, receipt.to_lead AS expected_lead,
						        question.id AS question_id,
						        response.id AS response_id, response.from_agent,
						        response.sender_lease_key, response.sender_generation,
						        question.resolved_at, question.superseded_at,
						        question.relay_state
					   FROM lead_inbox receipt
					   JOIN messages question
					     ON question.id = receipt.ref_message_id
					    AND question.type = 'question'
						   LEFT JOIN messages response
					     ON response.parent_id = question.id
					    AND response.type = 'response'
					  WHERE receipt.resend_of IS NULL
						    AND receipt.processed_at IS NULL
						    AND receipt.processed_evidence IS NULL
						    AND receipt.disposed_at IS NULL
						    AND receipt.disposed_evidence IS NULL
						    AND (response.id IS NOT NULL OR question.resolved_at IS NOT NULL
						      OR question.superseded_at IS NOT NULL
						      OR question.relay_state = 'terminal_disposed')
					  ORDER BY receipt.seq`,
				)
				.all() as Array<{
				receipt_id: string;
				expected_lead: string;
				question_id: string;
				response_id: string | null;
				from_agent: string | null;
				sender_lease_key: string | null;
				sender_generation: number | null;
				resolved_at: string | null;
				superseded_at: string | null;
				relay_state: string;
			}>;
			const copiedEvidence = new Map<string, ProcessedEvidenceV1>();
			for (const row of this.db
				.prepare(
					`SELECT processed_evidence FROM lead_inbox
					  WHERE processed_evidence IS NOT NULL`,
				)
				.all() as Array<{ processed_evidence: string }>) {
				try {
					const evidence = JSON.parse(
						row.processed_evidence,
					) as ProcessedEvidenceV1;
					assertProcessedEvidence(evidence);
					copiedEvidence.set(evidence.ref, evidence);
				} catch {
					// Invalid legacy evidence is not authority and cannot be copied.
				}
			}

			const queue = new LeadInboxQueue(this.db);
			let derived = 0;
			for (const candidate of candidates) {
				let evidence: ProcessedEvidenceV1 | null = null;
				if (
					candidate.from_agent === candidate.expected_lead &&
					candidate.response_id !== null &&
					candidate.sender_generation !== null
				) {
					evidence = {
						v: 1,
						kind: "response_observed",
						ref: candidate.response_id,
						actor: candidate.from_agent,
						actor_kind: "lead",
						fence: {
							...(candidate.sender_lease_key
								? { lease_key: candidate.sender_lease_key }
								: {}),
							lease_generation: candidate.sender_generation,
						},
						basis: [`question:${candidate.question_id}`],
					};
				} else if (candidate.response_id !== null) {
					const source = copiedEvidence.get(candidate.response_id);
					if (
						source?.actor === candidate.expected_lead &&
						source.actor_kind === "lead"
					) {
						evidence = {
							v: 1,
							kind: "response_observed",
							ref: candidate.response_id,
							actor: source.actor,
							actor_kind: source.actor_kind,
							fence: { ...source.fence },
							basis: [
								`question:${candidate.question_id}`,
								`source_evidence:${source.kind}`,
							],
						};
					}
				}
				if (evidence) {
					if (queue.markProcessed(candidate.receipt_id, { now, evidence })) {
						derived++;
					}
					continue;
				}
				const disposalEvidence: ProcessedEvidenceV1 = {
					v: 1,
					kind: "business_object_terminal",
					ref: candidate.response_id ?? candidate.question_id,
					actor: candidate.from_agent ?? "commdb",
					actor_kind: candidate.from_agent?.startsWith("founder")
						? "founder-writer"
						: candidate.from_agent
							? "runner"
							: "bridge-protocol",
					fence:
						candidate.sender_generation !== null
							? {
									...(candidate.sender_lease_key
										? { lease_key: candidate.sender_lease_key }
										: {}),
									lease_generation: candidate.sender_generation,
								}
							: { authority: "commdb_business_terminal" },
					basis: [`question:${candidate.question_id}`],
				};
				queue.markDisposed(candidate.receipt_id, {
					now,
					evidence: disposalEvidence,
				});
			}
			return derived;
		});
		return derive.immediate();
	}

	reconcileReceiptActivation(input: {
		enabled: boolean;
		now: string;
		receiptWindowsMs: ReceiptPriorityWindowsMs;
		highWaterMark: string;
		dryRun?: boolean;
	}): {
		episodeId: string;
		status: "disabled" | "dry_run" | "active";
		activatedAt: string | null;
		derived: number;
		initialized: number;
		dryRunCounts: Record<string, unknown>;
		commitCounts: Record<string, unknown> | null;
	} {
		assertUtcIsoTimestamp(input.now, "now");
		if (
			input.receiptWindowsMs.some(
				(window) => !Number.isSafeInteger(window) || window <= 0,
			)
		) {
			throw new Error("receiptWindowsMs must contain four positive integers");
		}
		if (!/^\d+$/.test(input.highWaterMark)) {
			throw new Error("highWaterMark must be a Discord snowflake lower bound");
		}
		type EpisodeRow = {
			episode_id: string;
			disabled_at: string | null;
			enabled_at: string | null;
			activation_at: string | null;
			status: "disabled" | "dry_run" | "active";
			dry_run_counts: string;
			commit_counts: string | null;
			high_water_mark: string | null;
		};
		const reconcile = this.db.transaction(() => {
			const latest = (): EpisodeRow | undefined =>
				this.db
					.prepare(
						`SELECT * FROM receipt_activation_episodes
						  ORDER BY rowid DESC LIMIT 1`,
					)
					.get() as EpisodeRow | undefined;
			const parseCounts = (
				encoded: string | null,
			): Record<string, unknown> | null =>
				encoded ? (JSON.parse(encoded) as Record<string, unknown>) : null;
			const emptyCounts = (): Record<string, unknown> => ({
				eligible: 0,
				pending: 0,
				exempt: 0,
				autoSettled: 0,
				disposed: 0,
				byPriority: { 0: 0, 1: 0, 2: 0, 3: 0 },
				estimated: { t1: 0, t2: 0, t3: 0, outboxPeak: 0 },
			});
			const activationCounts = (): Record<string, unknown> => {
				const rows = this.db
					.prepare(
						`SELECT priority,
						        SUM(CASE WHEN delivered_at IS NOT NULL
						          AND processed_at IS NULL AND disposed_at IS NULL
						          AND receipt_exempt_reason IS NULL THEN 1 ELSE 0 END) eligible,
						        SUM(CASE WHEN processed_at IS NULL AND disposed_at IS NULL
						          AND receipt_exempt_reason IS NULL THEN 1 ELSE 0 END) pending,
						        SUM(CASE WHEN receipt_exempt_reason IS NOT NULL THEN 1 ELSE 0 END) exempt,
						        SUM(CASE WHEN processed_at IS NOT NULL THEN 1 ELSE 0 END) settled,
						        SUM(CASE WHEN disposed_at IS NOT NULL THEN 1 ELSE 0 END) disposed
						   FROM lead_inbox WHERE resend_of IS NULL GROUP BY priority`,
					)
					.all() as Array<{
					priority: 0 | 1 | 2 | 3;
					eligible: number;
					pending: number;
					exempt: number;
					settled: number;
					disposed: number;
				}>;
				const counts = emptyCounts();
				const byPriority = counts.byPriority as Record<string, number>;
				for (const row of rows) {
					counts.eligible = Number(counts.eligible) + row.eligible;
					counts.pending = Number(counts.pending) + row.pending;
					counts.exempt = Number(counts.exempt) + row.exempt;
					counts.autoSettled = Number(counts.autoSettled) + row.settled;
					counts.disposed = Number(counts.disposed) + row.disposed;
					byPriority[String(row.priority)] = row.eligible;
				}
				const eligible = Number(counts.eligible);
				counts.estimated = {
					t1: eligible,
					t2: eligible,
					t3: eligible,
					outboxPeak: eligible,
				};
				return counts;
			};

			let current = latest();
			if (!input.enabled) {
				if (!current) {
					const episodeId = `receipt:${Date.parse(input.now)}:1`;
					const counts = emptyCounts();
					this.db
						.prepare(
							`INSERT INTO receipt_activation_episodes
							 (episode_id, disabled_at, enabled_at, activation_at, status,
							  dry_run_counts, commit_counts, high_water_mark)
							 VALUES (?, ?, NULL, NULL, 'disabled', ?, NULL, ?)`,
						)
						.run(
							episodeId,
							input.now,
							JSON.stringify(counts),
							input.highWaterMark,
						);
					current = latest();
				} else if (current.status !== "disabled") {
					this.db
						.prepare(
							`UPDATE receipt_activation_episodes
							 SET disabled_at = ?, status = 'disabled'
							 WHERE episode_id = ? AND status != 'disabled'`,
						)
						.run(input.now, current.episode_id);
					this.db
						.prepare(
							`UPDATE lead_inbox SET consumed_at = ?, disposition = 'superseded',
							   claimed_by = NULL, claim_expires_at = NULL
							 WHERE resend_of IS NOT NULL AND consumed_at IS NULL`,
						)
						.run(input.now);
					this.db
						.prepare(
							`UPDATE receipt_alert_outbox SET canceled_at = ?,
							   cancel_reason = 'receipt_foundation_disabled'
							 WHERE kind = 'receipt_unprocessed' AND delivered_at IS NULL
							   AND canceled_at IS NULL`,
						)
						.run(input.now);
					current = latest();
				}
				if (!current) throw new Error("receipt disable episode is unavailable");
				return {
					episodeId: current.episode_id,
					status: "disabled" as const,
					activatedAt: current.activation_at,
					derived: 0,
					initialized: 0,
					dryRunCounts: parseCounts(current.dry_run_counts) ?? emptyCounts(),
					commitCounts: parseCounts(current.commit_counts),
				};
			}

			const derived = this.deriveProcessedReceipts(input.now);
			if (!current || current.status === "disabled") {
				const count = (
					this.db
						.prepare("SELECT COUNT(*) count FROM receipt_activation_episodes")
						.get() as { count: number }
				).count;
				const episodeId = `receipt:${Date.parse(input.now)}:${count + 1}`;
				const counts = activationCounts();
				this.db
					.prepare(
						`INSERT INTO receipt_activation_episodes
						 (episode_id, disabled_at, enabled_at, activation_at, status,
						  dry_run_counts, commit_counts, high_water_mark)
						 VALUES (?, NULL, ?, NULL, 'dry_run', ?, NULL, ?)`,
					)
					.run(
						episodeId,
						input.now,
						JSON.stringify(counts),
						input.highWaterMark,
					);
				current = latest();
			}
			if (!current)
				throw new Error("receipt activation episode is unavailable");
			const dryRunCounts = activationCounts();
			this.db
				.prepare(
					`UPDATE receipt_activation_episodes
					 SET dry_run_counts = ? WHERE episode_id = ?`,
				)
				.run(JSON.stringify(dryRunCounts), current.episode_id);
			if (input.dryRun) {
				return {
					episodeId: current.episode_id,
					status: "dry_run" as const,
					activatedAt: null,
					derived,
					initialized: 0,
					dryRunCounts,
					commitCounts: null,
				};
			}
			if (current.status === "active" && current.activation_at) {
				const newlyDelivered = this.db
					.prepare(
						`SELECT id, priority FROM lead_inbox
						 WHERE resend_of IS NULL AND delivered_at IS NOT NULL
						   AND receipt_episode_id IS NULL AND processed_at IS NULL
						   AND disposed_at IS NULL AND receipt_exempt_reason IS NULL`,
					)
					.all() as Array<{ id: string; priority: 0 | 1 | 2 | 3 }>;
				let initialized = 0;
				for (const row of newlyDelivered) {
					initialized += this.db
						.prepare(
							`UPDATE lead_inbox SET receipt_episode_id = ?,
							   next_unprocessed_at = COALESCE(next_unprocessed_at, ?)
							 WHERE id = ? AND receipt_episode_id IS NULL
							   AND processed_at IS NULL AND disposed_at IS NULL`,
						)
						.run(
							current.episode_id,
							new Date(
								Date.parse(input.now) + input.receiptWindowsMs[row.priority],
							).toISOString(),
							row.id,
						).changes;
				}
				return {
					episodeId: current.episode_id,
					status: "active" as const,
					activatedAt: current.activation_at,
					derived,
					initialized,
					dryRunCounts,
					commitCounts: parseCounts(current.commit_counts),
				};
			}

			// One-time legacy accounting: only durably delivered reminder effects
			// consume a logical round. Merely materialized v1 children are superseded.
			const legacyRounds = this.db
				.prepare(
					`SELECT resend_of root_id, COUNT(DISTINCT resend_round) rounds
					   FROM lead_inbox
					  WHERE resend_of IS NOT NULL AND delivered_at IS NOT NULL
					    AND resend_round IS NOT NULL
					  GROUP BY resend_of`,
				)
				.all() as Array<{ root_id: string; rounds: number }>;
			for (const row of legacyRounds) {
				this.db
					.prepare(
						`UPDATE lead_inbox SET delivered_rounds = ?
						 WHERE id = ? AND delivered_rounds < ?`,
					)
					.run(row.rounds, row.root_id, row.rounds);
			}
			this.db
				.prepare(
					`UPDATE lead_inbox SET consumed_at = ?, disposition = 'superseded'
					 WHERE resend_of IS NOT NULL AND delivered_at IS NULL
					   AND consumed_at IS NULL AND receipt_episode_id IS NULL`,
				)
				.run(input.now);
			this.db
				.prepare(
					`UPDATE receipt_alert_outbox SET canceled_at = ?,
					   cancel_reason = 'legacy_generation_superseded'
					 WHERE kind IN ('unprocessed','receipt_unprocessed')
					   AND delivered_at IS NULL AND canceled_at IS NULL`,
				)
				.run(input.now);

			const eligible = this.db
				.prepare(
					`SELECT id, priority FROM lead_inbox
					 WHERE resend_of IS NULL AND delivered_at IS NOT NULL
					   AND processed_at IS NULL AND disposed_at IS NULL
					   AND receipt_exempt_reason IS NULL`,
				)
				.all() as Array<{ id: string; priority: 0 | 1 | 2 | 3 }>;
			let initialized = 0;
			const initialize = this.db.prepare(
				`UPDATE lead_inbox SET next_unprocessed_at = ?, receipt_episode_id = ?
				 WHERE id = ? AND processed_at IS NULL AND disposed_at IS NULL
				   AND receipt_exempt_reason IS NULL AND delivered_at IS NOT NULL`,
			);
			for (const row of eligible) {
				initialized += initialize.run(
					new Date(
						Date.parse(input.now) + input.receiptWindowsMs[row.priority],
					).toISOString(),
					current.episode_id,
					row.id,
				).changes;
			}
			const commitCounts = activationCounts();
			this.db
				.prepare(
					`UPDATE receipt_activation_episodes SET activation_at = ?,
					   status = 'active', commit_counts = ? WHERE episode_id = ?`,
				)
				.run(input.now, JSON.stringify(commitCounts), current.episode_id);
			return {
				episodeId: current.episode_id,
				status: "active" as const,
				activatedAt: input.now,
				derived,
				initialized,
				dryRunCounts,
				commitCounts,
			};
		});
		return reconcile.immediate();
	}

	/** Compatibility wrapper; v2 activation authority is receipt_activation_episodes. */
	bootstrapUnprocessedReceipts(input: {
		now: string;
		windowMs: number;
		receiptWindowsMs?: ReceiptPriorityWindowsMs;
	}): { activationAt: string; derived: number; initialized: number } {
		assertUtcIsoTimestamp(input.now, "now");
		if (!Number.isSafeInteger(input.windowMs) || input.windowMs <= 0) {
			throw new Error("windowMs must be a positive safe integer");
		}
		const receiptWindows =
			input.receiptWindowsMs ??
			([
				input.windowMs,
				input.windowMs,
				input.windowMs,
				input.windowMs,
			] as const);
		const activation = this.reconcileReceiptActivation({
			enabled: true,
			now: input.now,
			receiptWindowsMs: receiptWindows,
			highWaterMark: String(Date.parse(input.now)),
		});
		return {
			activationAt: activation.activatedAt ?? input.now,
			derived: activation.derived,
			initialized: activation.initialized,
		};
	}

	advanceDueUnprocessedReceipts(input: {
		now: string;
		windowMs: number;
		receiptWindowsMs?: ReceiptPriorityWindowsMs;
		resendCap: number;
		limit?: number;
	}): UnprocessedReceiptAdvance[] {
		assertUtcIsoTimestamp(input.now, "now");
		for (const [field, value] of [
			["windowMs", input.windowMs],
			["resendCap", input.resendCap],
			["limit", input.limit ?? 100],
		] as const) {
			if (!Number.isSafeInteger(value) || value <= 0) {
				throw new Error(`${field} must be a positive safe integer`);
			}
		}
		const limit = input.limit ?? 100;
		const receiptWindows =
			input.receiptWindowsMs ??
			([
				input.windowMs,
				input.windowMs,
				input.windowMs,
				input.windowMs,
			] as const);
		if (
			receiptWindows.some(
				(window) => !Number.isSafeInteger(window) || window <= 0,
			)
		) {
			throw new Error("receiptWindowsMs must contain four positive integers");
		}
		const advance = this.db.transaction(() => {
			const episode = this.db
				.prepare(
					`SELECT episode_id FROM receipt_activation_episodes
					 WHERE status = 'active' AND activation_at IS NOT NULL
					 ORDER BY rowid DESC LIMIT 1`,
				)
				.get() as { episode_id: string } | undefined;
			if (!episode) return [];
			const roots = this.db
				.prepare(
					`SELECT receipt.* FROM lead_inbox receipt
					  WHERE receipt.resend_of IS NULL
					    AND receipt.processed_at IS NULL
					    AND receipt.processed_evidence IS NULL
					    AND receipt.delivered_at IS NOT NULL
					    AND receipt.escalated_at IS NULL
					    AND receipt.next_unprocessed_at IS NOT NULL
					    AND receipt.next_unprocessed_at <= ?
					    AND receipt.receipt_episode_id = ?
					    AND receipt.receipt_exempt_reason IS NULL
					    AND receipt.disposed_at IS NULL
					  ORDER BY receipt.next_unprocessed_at, receipt.seq
					  LIMIT ?`,
				)
				.all(input.now, episode.episode_id, limit) as LeadInboxRow[];
			const outcomes: UnprocessedReceiptAdvance[] = [];
			for (const root of roots) {
				const round = root.delivered_rounds;
				if (round < input.resendCap) {
					const nextRound = round + 1;
					const resendId = `${root.id}#r${nextRound}@${episode.episode_id}`;
					const updated = this.db
						.prepare(
							`UPDATE lead_inbox SET next_unprocessed_at = NULL
							  WHERE id = ? AND processed_at IS NULL AND disposed_at IS NULL
							    AND receipt_exempt_reason IS NULL
							    AND delivered_rounds = ? AND receipt_episode_id = ?
							    AND next_unprocessed_at <= ?`,
						)
						.run(root.id, round, episode.episode_id, input.now);
					if (updated.changes !== 1) continue;
					const content = `${root.content}\n\n⚠️ 第 ${nextRound} 次重发,首投 ${root.delivered_at},仍无处理收据。`;
					const resendClass =
						root.type === "founder_reply" ? "model" : root.msg_class;
					this.db
						.prepare(
							`INSERT OR IGNORE INTO lead_inbox (
							   id, to_lead, source, type, msg_class, priority, content,
							   ref_message_id, created_at, resend_of, resend_round,
							   receipt_episode_id
							 ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
						)
						.run(
							resendId,
							root.to_lead,
							`receipt_resend:${root.id}`,
							root.type,
							resendClass,
							root.priority,
							content,
							input.now,
							root.id,
							nextRound,
							episode.episode_id,
						);
					const resend = new LeadInboxQueue(this.db).getById(resendId);
					if (
						!resend ||
						resend.resend_of !== root.id ||
						resend.resend_round !== nextRound ||
						resend.ref_message_id !== null ||
						resend.msg_class !== resendClass ||
						resend.content !== content ||
						resend.receipt_episode_id !== episode.episode_id
					) {
						throw new Error(`receipt resend id ${resendId} was reused`);
					}
					outcomes.push({
						kind: "resent",
						rootId: root.id,
						round: nextRound,
						resendId,
					});
					continue;
				}

				const outboxId = `unprocessed:${root.id}@${episode.episode_id}`;
				const payload = this.buildUnprocessedReceiptAlertPayload(root);
				const inserted = this.db
					.prepare(
						`INSERT OR IGNORE INTO receipt_alert_outbox
						 (id, kind, payload, created_at)
						 VALUES (?, 'receipt_unprocessed', ?, ?)`,
					)
					.run(outboxId, JSON.stringify(payload), input.now);
				this.db
					.prepare(
						`UPDATE lead_inbox SET next_unprocessed_at = NULL
						  WHERE id = ? AND processed_at IS NULL AND disposed_at IS NULL`,
					)
					.run(root.id);
				if (inserted.changes !== 1) continue;
				outcomes.push({
					kind: "escalation_queued",
					rootId: root.id,
					outboxId,
				});
			}
			return outcomes;
		});
		return advance.immediate();
	}

	/** v2 retires Bridge attribution/rebind promotion; Lead handles the canonical row. */
	promoteDueFounderRebinds(input: {
		ownerEpoch: string;
		now: string;
		limit?: number;
	}): LeadInboxRow[] {
		assertUtcIsoTimestamp(input.now, "now");
		void input.ownerEpoch;
		void input.limit;
		return [];
	}

	listPendingReceiptAlerts(
		kinds: readonly string[],
		limit = 100,
	): import("./lead-inbox-queue.js").ReceiptAlertOutboxRow[] {
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
			.all(
				...kinds,
				limit,
			) as import("./lead-inbox-queue.js").ReceiptAlertOutboxRow[];
	}

	private buildUnprocessedReceiptAlertPayload(
		root: LeadInboxRow,
	): UnprocessedReceiptAlertPayload {
		let projectName = "unknown";
		let issueId = "unknown";
		let executionId = `${root.to_lead}:receipt`;
		let threadId: string | undefined;
		if (root.ref_message_id) {
			const question = this.getMessageById(root.ref_message_id);
			const session = question
				? this.getSession(question.from_agent)
				: undefined;
			if (session) {
				projectName = session.project_name;
				issueId = session.issue_id ?? issueId;
				executionId = session.execution_id;
			}
		}
		const familyRoot = root.family_root_id
			? new LeadInboxQueue(this.db).getById(root.family_root_id)
			: root.type === "founder_reply"
				? root
				: undefined;
		if (familyRoot) {
			try {
				const payload = this.parseFounderRootPayload(familyRoot.content);
				projectName = payload.projectName;
				issueId = payload.issueId;
				threadId = payload.threadId;
				executionId = `${projectName}:${root.to_lead}`;
			} catch {
				// Preserve an honest, routable fallback; delivery will retry/no-owner.
			}
		}
		return {
			rootId: root.id,
			episodeId: root.receipt_episode_id ?? "legacy/v1",
			targetKey: `${projectName}:${root.to_lead}`,
			toLead: root.to_lead,
			type: root.type,
			projectName,
			issueId,
			executionId,
			...(root.ref_message_id ? { questionId: root.ref_message_id } : {}),
			...(threadId ? { threadId } : {}),
			firstDeliveredAt: root.delivered_at ?? root.created_at,
			resendRound: root.delivered_rounds,
			contentSummary: root.content.replaceAll(/\s+/g, " ").slice(0, 500),
		};
	}

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
			if (
				!wake ||
				wake.state !== "pending" ||
				wake.admission_state !== "queued" ||
				wake.escalation_outbox_id
			) {
				return null;
			}

			let founderOrigin = false;
			try {
				const envelope = JSON.parse(wake.envelope_json ?? "{}") as {
					metadata?: { origin?: unknown };
				};
				founderOrigin = envelope.metadata?.origin === "founder";
			} catch {
				// An unreadable envelope is not founder authority.
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
				outboxId = `wake_failed:founder:${input.messageId}`;
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
					    AND state = 'pending' AND admission_state = 'queued'
					    AND escalation_outbox_id IS NULL`,
				)
				.run(input.nowMs, outboxId, input.executionId, input.messageId);
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

			this.db
				.prepare(
					`INSERT OR IGNORE INTO receipt_alert_outbox
					   (id, kind, payload, created_at)
					 VALUES (?, 'wake_failed', ?, ?)`,
				)
				.run(
					outboxId,
					JSON.stringify({
						executionId: input.executionId,
						messageId: input.messageId,
						reason: input.reason,
						identityKind,
						episodeFingerprint,
						terminalLifecycleId: input.terminalLifecycleId,
						...(generation !== undefined ? { generation } : {}),
					}),
					now,
				);
			const completedWake = this.db
				.prepare(
					"SELECT * FROM runner_phase_wakes WHERE execution_id = ? AND message_id = ?",
				)
				.get(input.executionId, input.messageId) as RunnerPhaseWake;
			const alert = this.getReceiptAlertOutbox(outboxId);
			if (!alert) throw new Error("terminal wake alert outbox was not created");
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
		nowMs: number;
	}): import("./lead-inbox-queue.js").ReceiptAlertOutboxRow | null {
		if (!input.reason.trim())
			throw new Error("wake escalation reason is required");
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
	 * The first still-open failed wake defines the episode. Later messages for
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

	getReceiptAlertOutbox(
		id: string,
	): import("./lead-inbox-queue.js").ReceiptAlertOutboxRow | undefined {
		return this.db
			.prepare("SELECT * FROM receipt_alert_outbox WHERE id = ?")
			.get(id) as
			| import("./lead-inbox-queue.js").ReceiptAlertOutboxRow
			| undefined;
	}

	/** Revalidate immediately before any external receipt notification effect. */
	revalidateReceiptAlert(
		outboxId: string,
		nowMs: number,
	): import("./lead-inbox-queue.js").ReceiptAlertOutboxRow | null {
		const check = this.db.transaction(() => {
			const alert = this.getReceiptAlertOutbox(outboxId);
			if (!alert || alert.delivered_at || alert.canceled_at) return null;
			if (
				alert.kind === "receipt_unprocessed" ||
				alert.kind === "unprocessed"
			) {
				let payload: { rootId?: string; episodeId?: string };
				try {
					payload = JSON.parse(alert.payload) as typeof payload;
				} catch {
					payload = {};
				}
				const activeEpisode = this.db
					.prepare(
						`SELECT episode_id FROM receipt_activation_episodes
						 WHERE status = 'active' AND activation_at IS NOT NULL
						 ORDER BY rowid DESC LIMIT 1`,
					)
					.get() as { episode_id: string } | undefined;
				const live =
					typeof payload.rootId === "string"
						? (this.db
								.prepare(
									`SELECT 1 FROM lead_inbox receipt
									  WHERE receipt.id = ? AND receipt.resend_of IS NULL
									    AND receipt.processed_at IS NULL
									    AND receipt.processed_evidence IS NULL
									    AND receipt.delivered_at IS NOT NULL
										    AND receipt.disposed_at IS NULL
										    AND receipt.disposed_evidence IS NULL
										    AND receipt.receipt_exempt_reason IS NULL`,
								)
								.get(payload.rootId) as { 1: number } | undefined)
						: undefined;
				if (
					!live ||
					alert.created_at > new Date(nowMs).toISOString() ||
					payload.episodeId !== activeEpisode?.episode_id
				) {
					this.db
						.prepare(
							`UPDATE receipt_alert_outbox
							 SET canceled_at = ?, cancel_reason = ?
							 WHERE id = ? AND delivered_at IS NULL AND canceled_at IS NULL`,
						)
						.run(
							new Date(nowMs).toISOString(),
							payload.episodeId !== activeEpisode?.episode_id
								? "stale_activation_episode"
								: "source_no_longer_unprocessed",
							outboxId,
						);
					return null;
				}
				return alert;
			}
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
				payload = {};
			}
			if (
				payload.identityKind === "terminal_episode" &&
				typeof payload.executionId === "string" &&
				typeof payload.terminalLifecycleId === "string" &&
				typeof payload.generation === "number"
			) {
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
				typeof payload.executionId === "string" &&
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
			const live =
				typeof payload.executionId === "string" &&
				typeof payload.messageId === "string"
					? (this.db
							.prepare(
								`SELECT 1 FROM runner_phase_wakes
								 WHERE execution_id = ? AND message_id = ?
								   AND state = 'pending' AND escalation_outbox_id = ?`,
							)
							.get(payload.executionId, payload.messageId, outboxId) as
							| { 1: number }
							| undefined)
					: undefined;
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
	): import("./lead-inbox-queue.js").ReceiptAlertOutboxRow | null {
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

	markUnprocessedReceiptEscalated(outboxId: string, nowMs: number): boolean {
		const now = new Date(nowMs).toISOString();
		const mark = this.db.transaction(() => {
			const alert = this.getReceiptAlertOutbox(outboxId);
			if (
				!alert ||
				(alert.kind !== "receipt_unprocessed" &&
					alert.kind !== "unprocessed") ||
				alert.canceled_at
			) {
				return false;
			}
			let payload: { rootId?: string };
			try {
				payload = JSON.parse(alert.payload) as typeof payload;
			} catch {
				return false;
			}
			if (typeof payload.rootId !== "string") return false;
			this.db
				.prepare(
					`UPDATE receipt_alert_outbox SET delivered_at = COALESCE(delivered_at, ?)
					  WHERE id = ? AND canceled_at IS NULL`,
				)
				.run(now, outboxId);
			this.db
				.prepare(
					`UPDATE lead_inbox SET escalated_at = COALESCE(escalated_at, ?),
					   next_unprocessed_at = NULL
					 WHERE id = ?`,
				)
				.run(now, payload.rootId);
			return this.getReceiptAlertOutbox(outboxId)?.delivered_at !== null;
		});
		return mark.immediate();
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
				`SELECT * FROM messages
         WHERE to_agent = ? AND type = 'instruction' AND read_at IS NULL
         AND (delivered_at IS NULL
              OR delivered_at < datetime('now', '-' || ? || ' seconds'))
         AND expires_at > datetime('now')
         ORDER BY created_at ASC`,
			)
			.all(agentId, retryWindowSec) as Message[];
	}

	markInstructionDelivered(id: string): void {
		this.db
			.prepare(
				"UPDATE messages SET delivered_at = datetime('now') WHERE id = ?",
			)
			.run(id);
	}

	/**
	 * The only consuming read for a gate response. Internal probes continue to
	 * use getResponse(), which is intentionally pure. Consumption stamps the
	 * response and finishes only its exact purpose-bound wake.
	 */
	consumeGateResponse(
		questionId: string,
		executionId: string,
	): Message | undefined {
		const consume = this.db.transaction(() => {
			const response = this.db
				.prepare(
					`SELECT response.*
					   FROM messages response
					   JOIN messages question ON question.id = response.parent_id
					  WHERE question.id = ? AND question.type = 'question'
					    AND question.from_agent = ?
					    AND response.type = 'response'`,
				)
				.get(questionId, executionId) as Message | undefined;
			if (!response) return undefined;
			const nowMs = Date.now();
			this.db
				.prepare(
					`UPDATE messages
					    SET delivered_at = COALESCE(delivered_at, datetime('now'))
					  WHERE id = ? AND type = 'response'`,
				)
				.run(response.id);
			this.db
				.prepare(
					`UPDATE runner_phase_wakes
					    SET state = 'finished', finished_at = ?,
					        claim_token = NULL, claim_expires_at = NULL
					  WHERE execution_id = ? AND message_id = ?
					    AND purpose = 'gate_response'
					    AND state IN ('pending','started')`,
				)
				.run(nowMs, executionId, response.id);
			return this.db
				.prepare("SELECT * FROM messages WHERE id = ?")
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
		this.db
			.prepare(
				"UPDATE messages SET read_at = datetime('now') WHERE id = ? AND read_at IS NULL",
			)
			.run(id);
	}

	// ── Dynamic Timeout (Phase 2) ──

	hasPendingQuestionsFrom(execId: string): boolean {
		const answerable = commDbProtectionEnabled()
			? "q.relay_state != 'terminal_disposed'"
			: "q.expires_at > datetime('now')";
		const row = this.db
			.prepare(
				`SELECT COUNT(*) as cnt FROM messages q
         WHERE q.from_agent = ? AND q.type = 'question'
         AND NOT EXISTS (
           SELECT 1 FROM messages r WHERE r.parent_id = q.id AND r.type = 'response'
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
			: "q.expires_at > datetime('now')";
		const row = this.db
			.prepare(
				`SELECT COUNT(*) as cnt FROM messages q
         WHERE q.from_agent = ? AND q.type = 'question'
         AND q.checkpoint IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM messages r WHERE r.parent_id = q.id AND r.type = 'response'
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
	 * The comparison stays entirely in SQLite's UTC clock domain
	 * (`created_at` DEFAULT CURRENT_TIMESTAMP vs `datetime('now', ...)`) —
	 * no JS date parsing of timezone-less strings. Strict `>`: a message
	 * exactly at the window edge is outside.
	 */
	hasRecentMessagesFrom(execId: string, windowSeconds: number): boolean {
		const seconds = Math.max(0, Math.floor(windowSeconds));
		const row = this.db
			.prepare(
				`SELECT 1 as hit FROM messages
         WHERE from_agent = ?
         AND created_at > datetime('now', '-' || ? || ' seconds')
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
			.prepare("SELECT COUNT(*) AS count FROM messages WHERE from_agent = ?")
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
					activation.attempt < 1 ||
					activation.nodeId !== phase)
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

	registerSession(
		executionId: string,
		tmuxWindow: string,
		projectName: string,
		issueId?: string,
		leadId?: string,
		/** FLY-1188: transport vendor ("claude-code" | "codex"); routes `send` wakes. */
		vendor?: string,
	): void {
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
	}

	/**
	 * FLY-1374: restore the exact CommDB identity a proven-live parked holder
	 * needs before its wake is committed. Existing rows are revived in place so
	 * questions/messages/receipts survive; their registered tmux target remains
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
					`UPDATE messages AS q SET
					   resolved_at = datetime('now'),
					   read_at = COALESCE(read_at, datetime('now')),
					   expires_at = datetime('now'),
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
					     SELECT 1 FROM messages r
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
						`UPDATE messages AS q SET
						   resolved_at = datetime('now'),
						   read_at = COALESCE(read_at, datetime('now')),
						   expires_at = datetime('now', '${forensicTtl}'),
						   relay_state = 'terminal_disposed',
						   resolved_via = 'owner_closed'
						 WHERE q.from_agent = ?
						   AND q.type = 'question'
						   AND q.checkpoint IS NULL
						   AND q.resolved_at IS NULL
						   AND q.relay_state != 'terminal_disposed'
						   AND q.created_at <= datetime('now', ?)
						   AND NOT EXISTS (
						     SELECT 1 FROM messages r
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
		const retentionCutoff = Date.now() - 7 * 24 * 60 * 60_000;
		this.db
			.prepare(
				`UPDATE runner_phase_wakes
				 SET state = 'finished', finished_at = ?,
				     claim_token = NULL, claim_expires_at = NULL
				 WHERE execution_id = ? AND state = 'pending'`,
			)
			.run(Date.now(), executionId);
		this.db
			.prepare(
				`DELETE FROM runner_phase_wakes
				 WHERE execution_id = ?
				   AND (admission_state IS NULL
				        OR (queued_at < ? AND (
				          state IN ('started','finished')
				          OR admission_state IN ('suppressed_cap','skipped_no_transport')
				        )))`,
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
