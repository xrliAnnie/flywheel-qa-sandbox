import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import {
	canonicalJsonString,
	canonicalSubmissionDigest,
} from "flywheel-config";
import {
	assertUtcIsoTimestamp,
	LEAD_INBOX_SCHEMA,
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
		const id = randomUUID();
		const ttl = opts?.ttlSeconds;
		const customTtl =
			typeof ttl === "number" && Number.isFinite(ttl) && ttl > 0;
		if (opts?.deadlineAt) {
			assertUtcIsoTimestamp(opts.deadlineAt, "deadlineAt");
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
		},
	): void {
		if (source) {
			const targetRunId = source.targetRunId ?? null;
			if (targetRunId !== null && targetRunId.trim().length === 0) {
				throw new Error("targetRunId must be non-empty when provided");
			}
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
						frozen.target_run_id !== targetRunId
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
					target_run_id: targetRunId,
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
				retiredAskCount: retiredAsks,
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
