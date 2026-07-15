import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import {
	canonicalJsonString,
	canonicalSubmissionDigest,
} from "flywheel-config";
import type { Message, Session } from "./types.js";
import { deleteContentRef as deleteContentRefFile } from "./utils/content-ref.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  from_agent  TEXT NOT NULL,
  to_agent    TEXT NOT NULL,
  type        TEXT NOT NULL CHECK(type IN ('question','response','instruction','progress')),
  content     TEXT NOT NULL,
  parent_id   TEXT,
  read_at     DATETIME,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at  DATETIME NOT NULL DEFAULT (datetime('now', '+72 hours')),
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
  status        TEXT DEFAULT 'running' CHECK(status IN ('running','completed','timeout'))
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
  granted_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_source_event (
  project             TEXT NOT NULL,
  source_event_id     TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK(kind IN ('founder_approval','turn_grant')),
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
  UNIQUE (execution_id, message_id)
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
}

export interface FinalizeSessionResult {
	retiredQuestionCount: number;
	deletedSessionCount: number;
}

export interface WorkflowSourceEvent {
	project: string;
	source_event_id: string;
	kind: "founder_approval" | "turn_grant";
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
}

export interface RunnerShutdownControl {
	execution_id: string;
	request_id: string;
	state: "requested" | "acked" | "failed";
	requested_at: number;
	finished_at: number | null;
	error: string | null;
}

function isMissingTableError(error: unknown, table: string): boolean {
	return (
		error instanceof Error &&
		new RegExp(`no such table: (?:main\\.)?${table}`, "i").test(error.message)
	);
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
		const columns = this.db
			.prepare("PRAGMA table_info(messages)")
			.all() as Array<{ name: string }>;

		if (!columns.some((c) => c.name === "read_at")) {
			this.db.exec("ALTER TABLE messages ADD COLUMN read_at DATETIME");
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
		this.db.exec(
			"CREATE INDEX IF NOT EXISTS idx_messages_checkpoint ON messages(checkpoint) WHERE checkpoint IS NOT NULL",
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
	}

	purgeExpired(): number {
		return this.purgeExpiredWithRefs();
	}

	purgeExpiredWithRefs(): number {
		// Collect content_ref files from both expired messages and their children
		const refs = this.db
			.prepare(
				`SELECT content_ref FROM messages
				 WHERE (expires_at < datetime('now')
				    OR parent_id IN (SELECT id FROM messages WHERE expires_at < datetime('now')))
				   AND content_ref IS NOT NULL`,
			)
			.all() as Array<{ content_ref: string }>;
		for (const { content_ref } of refs) {
			deleteContentRefFile(content_ref);
		}
		// FLY-80: Delete child messages (responses) before parents to satisfy FK constraint.
		// better-sqlite3 enforces foreign_keys=ON by default.
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

	cleanupReadMessages(ttlHours = 24): number {
		return this.cleanupReadMessagesWithRefs(ttlHours);
	}

	cleanupReadMessagesWithRefs(ttlHours = 24): number {
		const cleanupCondition = `read_at IS NOT NULL AND created_at < datetime('now', '-' || ? || ' hours')`;
		const refs = this.db
			.prepare(
				`SELECT content_ref FROM messages
			 WHERE (${cleanupCondition}
			    OR parent_id IN (SELECT id FROM messages WHERE ${cleanupCondition}))
			 AND content_ref IS NOT NULL`,
			)
			.all(ttlHours, ttlHours) as Array<{ content_ref: string }>;
		for (const { content_ref } of refs) {
			deleteContentRefFile(content_ref);
		}
		// FLY-80: Delete child messages before parents to satisfy FK constraint
		const childResult = this.db
			.prepare(
				`DELETE FROM messages WHERE parent_id IN (SELECT id FROM messages WHERE ${cleanupCondition})`,
			)
			.run(ttlHours);
		const parentResult = this.db
			.prepare(`DELETE FROM messages WHERE ${cleanupCondition}`)
			.run(ttlHours);
		return childResult.changes + parentResult.changes;
	}

	insertQuestion(
		fromAgent: string,
		toAgent: string,
		content: string,
		opts?: {
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
		},
	): string {
		const id = randomUUID();
		const ttl = opts?.ttlSeconds;
		const customTtl =
			typeof ttl === "number" && Number.isFinite(ttl) && ttl > 0;
		if (customTtl) {
			this.db
				.prepare(
					`INSERT INTO messages (id, from_agent, to_agent, type, content, checkpoint, content_ref, content_type, kind, expires_at)
         VALUES (?, ?, ?, 'question', ?, ?, ?, ?, ?, datetime('now', ?))`,
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
					`+${Math.floor(ttl as number)} seconds`,
				);
		} else {
			// Default-TTL path (byte-compat with the pre-FLY-245 schema default).
			this.db
				.prepare(
					`INSERT INTO messages (id, from_agent, to_agent, type, content, checkpoint, content_ref, content_type, kind)
         VALUES (?, ?, ?, 'question', ?, ?, ?, ?, ?)`,
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
				`UPDATE messages SET resolved_at = datetime('now')
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
	retireShipGate(questionId: string): boolean {
		const info = this.db
			.prepare(
				`UPDATE messages SET
				 resolved_at = datetime('now'),
				 read_at = COALESCE(read_at, datetime('now')),
				 expires_at = datetime('now')
				 WHERE id = ? AND type = 'question'
				 AND checkpoint = 'approve_to_ship'
				 AND expires_at > datetime('now')
				 AND NOT EXISTS (
				   SELECT 1 FROM messages r WHERE r.parent_id = messages.id AND r.type = 'response'
				 )`,
			)
			.run(questionId);
		return info.changes > 0;
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
		opts: { expectedFromAgent: string; requireUnanswered: true },
	): boolean {
		const info = this.db
			.prepare(
				`UPDATE messages SET
				 resolved_at = datetime('now'),
				 read_at = COALESCE(read_at, datetime('now')),
				 expires_at = datetime('now')
				 WHERE id = ? AND type = 'question'
				 AND from_agent = ?
				 AND expires_at > datetime('now')
				 AND NOT EXISTS (
				   SELECT 1 FROM messages r WHERE r.parent_id = messages.id AND r.type = 'response'
				 )`,
			)
			.run(questionId, opts.expectedFromAgent);
		return info.changes > 0;
	}

	/**
	 * FLY-1099 §4.3: is this question still answerable — exists, type=question,
	 * no response child, not expired? (The same predicate `getPendingQuestions`
	 * applies, point-queried for the deferred-approval rebind pass.)
	 */
	isQuestionPending(questionId: string): boolean {
		const row = this.db
			.prepare(
				`SELECT 1 AS hit FROM messages q
	       WHERE q.id = ? AND q.type = 'question'
	       AND NOT EXISTS (
	         SELECT 1 FROM messages r WHERE r.parent_id = q.id AND r.type = 'response'
	       )
	       AND q.expires_at > datetime('now')`,
			)
			.get(questionId) as { hit: number } | undefined;
		return row !== undefined;
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
				 expires_at = datetime('now', '+' || ? || ' hours')
				 WHERE id = ? AND type = 'question'`,
			)
			.run(cleanupTtlHours, questionId);
	}

	insertResponse(parentId: string, fromAgent: string, content: string): void {
		const question = this.db
			.prepare("SELECT * FROM messages WHERE id = ? AND type = 'question'")
			.get(parentId) as Message | undefined;
		if (!question) {
			throw new Error(`Question ${parentId} not found`);
		}
		const id = randomUUID();
		this.db
			.prepare(
				`INSERT INTO messages (id, from_agent, to_agent, type, content, parent_id)
         VALUES (?, ?, ?, 'response', ?, ?)`,
			)
			.run(id, fromAgent, question.from_agent, content, parentId);
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
	}): boolean {
		const id = randomUUID();
		const result = this.db
			.prepare(
				`INSERT INTO messages (id, from_agent, to_agent, type, content, parent_id)
				 SELECT ?, ?, q.from_agent, 'response', ?, q.id
				   FROM messages q
				  WHERE q.id = ?
				    AND q.type = 'question'
				    AND q.from_agent = ?
				    AND q.checkpoint = ?
				    AND q.resolved_at IS NULL
				    AND q.expires_at > datetime('now')
				    AND NOT EXISTS (
				      SELECT 1 FROM messages r
				       WHERE r.parent_id = q.id AND r.type = 'response'
				    )`,
			)
			.run(
				id,
				input.fromAgent,
				input.content,
				input.questionId,
				input.expectedOwner,
				input.expectedCheckpoint,
			);
		return result.changes > 0;
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
	}): boolean {
		const payload = canonicalJsonString(input.payload);
		const payloadDigest = canonicalSubmissionDigest(input.payload);
		const at = new Date().toISOString();
		return this.db.transaction(() => {
			const responseId = randomUUID();
			const result = this.db
				.prepare(
					`INSERT INTO messages (id, from_agent, to_agent, type, content, parent_id)
					 SELECT ?, ?, q.from_agent, 'response', ?, q.id
					   FROM messages q
					  WHERE q.id = ?
					    AND q.type = 'question'
					    AND q.from_agent = ?
					    AND q.checkpoint = 'approve_to_ship'
					    AND q.resolved_at IS NULL
					    AND q.expires_at > datetime('now')
					    AND NOT EXISTS (
					      SELECT 1 FROM messages r
					       WHERE r.parent_id = q.id AND r.type = 'response'
					    )`,
				)
				.run(
					responseId,
					input.fromAgent,
					input.content,
					input.questionId,
					input.expectedOwner,
				);
			if (result.changes !== 1) return false;
			this.db
				.prepare(
					`INSERT INTO workflow_source_event
					   (project, source_event_id, kind, payload, payload_digest, schema_version, at)
					 VALUES (?, ?, 'founder_approval', ?, ?, 1, ?)`,
				)
				.run(input.project, input.sourceEventId, payload, payloadDigest, at);
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
	}): boolean {
		const graceHours =
			typeof input.graceHours === "number" &&
			Number.isFinite(input.graceHours) &&
			input.graceHours > 0
				? Math.floor(input.graceHours)
				: 24;
		const insertResponse = this.db.prepare(
			`INSERT INTO messages (id, from_agent, to_agent, type, content, parent_id)
			 SELECT ?, ?, q.from_agent, 'response', ?, q.id
			   FROM messages q
			  WHERE q.id = ?
			    AND q.type = 'question'
			    AND q.from_agent = ?
			    AND q.checkpoint = ?
			    AND q.resolved_at IS NULL
			    AND NOT EXISTS (
			      SELECT 1 FROM messages r
			       WHERE r.parent_id = q.id AND r.type = 'response'
			    )`,
		);
		const bumpGrace = this.db.prepare(
			`UPDATE messages SET
			 resolved_at = datetime('now'),
			 read_at = COALESCE(read_at, datetime('now')),
			 expires_at = datetime('now', '+' || ? || ' hours')
			 WHERE id = ? AND type = 'question'`,
		);
		const txn = this.db.transaction((): boolean => {
			const res = insertResponse.run(
				randomUUID(),
				input.fromAgent,
				input.content,
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
		return this.db
			.prepare(
				`SELECT q.* FROM messages q
         WHERE q.to_agent = ? AND q.type = 'question'
         AND NOT EXISTS (
           SELECT 1 FROM messages r WHERE r.parent_id = q.id AND r.type = 'response'
         )
         AND q.expires_at > datetime('now')
         ORDER BY q.created_at ASC`,
			)
			.all(leadId) as Message[];
	}

	/**
	 * FLY-58: Find the most recent pending gate question from a specific runner
	 * with a specific checkpoint. Used by Bridge to respond to approve_to_ship gate.
	 */
	getPendingGateByRunner(
		runnerId: string,
		checkpoint: string,
	): Message | undefined {
		return this.db
			.prepare(
				`SELECT q.* FROM messages q
         WHERE q.from_agent = ? AND q.type = 'question'
         AND q.checkpoint = ?
         AND NOT EXISTS (
           SELECT 1 FROM messages r WHERE r.parent_id = q.id AND r.type = 'response'
         )
         AND q.expires_at > datetime('now')
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
		opts?: { dedupeId?: string },
	): string {
		// A caller-supplied dedupeId is a DETERMINISTIC message identity: the
		// same logical send replayed (e.g. after a crash between this commit
		// and the caller's own checkpoint in another database) lands on the
		// same primary key and is ignored instead of duplicated (FLY-1082,
		// Codex R6). Without it, behavior is byte-identical to before.
		const id = opts?.dedupeId ?? randomUUID();
		this.db
			.prepare(
				`INSERT ${opts?.dedupeId ? "OR IGNORE " : ""}INTO messages (id, from_agent, to_agent, type, content)
         VALUES (?, ?, ?, 'instruction', ?)`,
			)
			.run(id, fromAgent, toAgent, content);
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
	): boolean {
		const info = this.db
			.prepare(
				`INSERT OR IGNORE INTO messages (id, from_agent, to_agent, type, content)
         VALUES (?, ?, ?, 'instruction', ?)`,
			)
			.run(id, fromAgent, toAgent, content);
		return info.changes > 0;
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
					    source_instruction_id, state, queued_at)
					 VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
				)
				.run(
					executionId,
					message.id,
					message.content,
					metadataJson,
					sourceInstructionId,
					nowMs,
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

	markRunnerPhaseWakeStarted(
		executionId: string,
		messageId: string,
		nowMs: number,
	): boolean {
		return (
			this.db
				.prepare(
					`UPDATE runner_phase_wakes SET state = 'started', started_at = ?
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
		const row = this.db
			.prepare(
				`SELECT COUNT(*) as cnt FROM messages q
         WHERE q.from_agent = ? AND q.type = 'question'
         AND NOT EXISTS (
           SELECT 1 FROM messages r WHERE r.parent_id = q.id AND r.type = 'response'
         )
         AND q.expires_at > datetime('now')`,
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
		const row = this.db
			.prepare(
				`SELECT COUNT(*) as cnt FROM messages q
         WHERE q.from_agent = ? AND q.type = 'question'
         AND q.checkpoint IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM messages r WHERE r.parent_id = q.id AND r.type = 'response'
         )
         AND q.expires_at > datetime('now')`,
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
		source?: { project: string; sourceEventId: string },
	): void {
		if (source) {
			this.db.transaction(() => {
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
						frozen.target_run_id !== null
					) {
						throw new Error(
							`workflow source replay payload mismatch (poison): ${source.sourceEventId}`,
						);
					}
					return;
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
					target_run_id: null,
				};
				const at = new Date(grantedAtMs).toISOString();
				this.db
					.prepare(
						`INSERT INTO three_stage_turn
						   (issue_id, holder_exec_id, phase, epoch, granted_at)
						 VALUES (?, ?, ?, ?, ?)
						 ON CONFLICT(issue_id) DO UPDATE SET
						   holder_exec_id = excluded.holder_exec_id,
						   phase = excluded.phase,
						   epoch = excluded.epoch,
						   granted_at = excluded.granted_at`,
					)
					.run(issueId, holderExecId, phase, resultingEpoch, grantedAtMs);
				this.db
					.prepare(
						`INSERT INTO turn_source_history
						   (issue_id, from_role, to_role, epoch, target_run_id, source_event_id, at)
						 VALUES (?, ?, ?, ?, NULL, ?, ?)`,
					)
					.run(
						issueId,
						current?.phase ?? null,
						phase,
						resultingEpoch,
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
			})();
			return;
		}
		this.db
			.prepare(
				`INSERT INTO three_stage_turn
           (issue_id, holder_exec_id, phase, epoch, granted_at)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(issue_id) DO UPDATE SET
           holder_exec_id = excluded.holder_exec_id,
           phase = excluded.phase,
           epoch = three_stage_turn.epoch + 1,
           granted_at = excluded.granted_at`,
			)
			.run(issueId, holderExecId, phase, grantedAtMs);
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
					`SELECT issue_id, holder_exec_id, phase, epoch, granted_at
           FROM three_stage_turn WHERE issue_id = ?`,
				)
				.get(issueId) as ThreeStageTurn | undefined;
		} catch (err) {
			if (/no such table: three_stage_turn/i.test((err as Error).message)) {
				return null;
			}
			throw err;
		}
		return row ?? null;
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
					`SELECT issue_id, holder_exec_id, phase, epoch, granted_at
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
				`INSERT OR REPLACE INTO sessions (execution_id, tmux_window, project_name, issue_id, lead_id, vendor)
         VALUES (?, ?, ?, ?, ?, ?)`,
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
		status: "completed" | "timeout",
	): void {
		this.db
			.prepare(
				"UPDATE sessions SET status = ?, ended_at = datetime('now') WHERE execution_id = ?",
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
	 * runner and remove its session registry row. A checkpoint-less `ask` is not
	 * a gate; an answered question is immutable history. Errors deliberately
	 * propagate so teardown callers fail closed and retry the whole transaction.
	 */
	finalizeSession(executionId: string): FinalizeSessionResult {
		return this.db.transaction((targetExecutionId: string) => {
			const retired = this.db
				.prepare(
					`UPDATE messages AS q SET
					   resolved_at = datetime('now'),
					   read_at = COALESCE(read_at, datetime('now')),
					   expires_at = datetime('now')
					 WHERE q.from_agent = ?
					   AND q.type = 'question'
					   AND q.checkpoint IS NOT NULL
					   AND q.resolved_at IS NULL
					   AND NOT EXISTS (
					     SELECT 1 FROM messages r
					      WHERE r.parent_id = q.id AND r.type = 'response'
					   )`,
				)
				.run(targetExecutionId).changes;
			this.db
				.prepare("DELETE FROM runner_phase_wakes WHERE execution_id = ?")
				.run(targetExecutionId);
			this.db
				.prepare("DELETE FROM runner_shutdown_controls WHERE execution_id = ?")
				.run(targetExecutionId);
			const deleted = this.db
				.prepare("DELETE FROM sessions WHERE execution_id = ?")
				.run(targetExecutionId).changes;
			return {
				retiredQuestionCount: retired,
				deletedSessionCount: deleted,
			};
		})(executionId);
	}

	/**
	 * FLY-638: delete a session registry row. Used by (a) the live teardown path
	 * (close_runner / terminate / post-merge) to drop a runner's row once its tmux
	 * is gone, and (b) the boot prune sweep that clears the backlog of dead
	 * terminal rows polluting `runner_terminal_list` / bootstrap. Idempotent —
	 * deleting a missing row is a no-op. Returns the number of rows removed.
	 */
	deleteSession(executionId: string): number {
		return this.db
			.prepare("DELETE FROM sessions WHERE execution_id = ?")
			.run(executionId).changes;
	}

	/** FLY-1269: issue-terminal cleanup for a resident phase execution. */
	deleteSessionAndRunnerPhaseLifecycle(executionId: string): number {
		const remove = this.db.transaction(() => {
			this.db
				.prepare("DELETE FROM runner_phase_wakes WHERE execution_id = ?")
				.run(executionId);
			this.db
				.prepare("DELETE FROM runner_shutdown_controls WHERE execution_id = ?")
				.run(executionId);
			return this.db
				.prepare("DELETE FROM sessions WHERE execution_id = ?")
				.run(executionId).changes;
		});
		return remove();
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
	 * FLY-229: recent terminal (completed/timeout) sessions, for parked-alive
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
			"SELECT * FROM sessions WHERE project_name = ? AND status IN ('completed','timeout')" +
			(scoped ? " AND (lead_id = ? OR lead_id IS NULL)" : "") +
			" ORDER BY COALESCE(ended_at, started_at) DESC LIMIT ?";
		const params: Array<string | number> = scoped
			? [projectName, leadId as string, limit]
			: [projectName, limit];
		return this.db.prepare(sql).all(...params) as Session[];
	}

	/**
	 * FLY-229: count of terminal (completed/timeout) sessions matching the SAME
	 * scope as `getRecentTerminalSessions` — drives the truncation summary line
	 * when more terminal rows exist than the probe cap.
	 */
	countTerminalSessions(projectName: string, leadId?: string): number {
		const scoped = leadId != null;
		const sql =
			"SELECT COUNT(*) AS n FROM sessions WHERE project_name = ? AND status IN ('completed','timeout')" +
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
