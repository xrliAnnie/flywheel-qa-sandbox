import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { Message, Session } from "./types.js";

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
	}

	purgeExpired(): number {
		const result = this.db
			.prepare("DELETE FROM messages WHERE expires_at < datetime('now')")
			.run();
		return result.changes;
	}

	cleanupReadMessages(ttlHours = 24): number {
		const result = this.db
			.prepare(
				`DELETE FROM messages
			 WHERE read_at IS NOT NULL
			 AND created_at < datetime('now', '-' || ? || ' hours')`,
			)
			.run(ttlHours);
		return result.changes;
	}

	insertQuestion(fromAgent: string, toAgent: string, content: string): string {
		const id = randomUUID();
		this.db
			.prepare(
				`INSERT INTO messages (id, from_agent, to_agent, type, content)
         VALUES (?, ?, ?, 'question', ?)`,
			)
			.run(id, fromAgent, toAgent, content);
		return id;
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
