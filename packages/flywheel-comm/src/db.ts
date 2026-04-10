import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_response ON messages(parent_id) WHERE type = 'response';
CREATE INDEX IF NOT EXISTS idx_messages_to_agent ON messages(to_agent, type, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id);
CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_name);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
`;

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
		this.db.exec(
			"CREATE INDEX IF NOT EXISTS idx_messages_checkpoint ON messages(checkpoint) WHERE checkpoint IS NOT NULL",
		);
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
		},
	): string {
		const id = randomUUID();
		this.db
			.prepare(
				`INSERT INTO messages (id, from_agent, to_agent, type, content, checkpoint, content_ref, content_type)
         VALUES (?, ?, ?, 'question', ?, ?, ?, ?)`,
			)
			.run(
				id,
				fromAgent,
				toAgent,
				content,
				opts?.checkpoint ?? null,
				opts?.contentRef ?? null,
				opts?.contentType ?? "text",
			);
		return id;
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

	getResponse(questionId: string): Message | undefined {
		return this.db
			.prepare(
				"SELECT * FROM messages WHERE parent_id = ? AND type = 'response'",
			)
			.get(questionId) as Message | undefined;
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

	// ── Instruction (Phase 2) ──

	insertInstruction(
		fromAgent: string,
		toAgent: string,
		content: string,
	): string {
		const id = randomUUID();
		this.db
			.prepare(
				`INSERT INTO messages (id, from_agent, to_agent, type, content)
         VALUES (?, ?, ?, 'instruction', ?)`,
			)
			.run(id, fromAgent, toAgent, content);
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

	// ── Session Registry (Phase 2) ──

	registerSession(
		executionId: string,
		tmuxWindow: string,
		projectName: string,
		issueId?: string,
		leadId?: string,
	): void {
		this.db
			.prepare(
				`INSERT OR REPLACE INTO sessions (execution_id, tmux_window, project_name, issue_id, lead_id)
         VALUES (?, ?, ?, ?, ?)`,
			)
			.run(
				executionId,
				tmuxWindow,
				projectName,
				issueId ?? null,
				leadId ?? null,
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

	close(): void {
		this.db.close();
	}
}
