import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Message } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  from_agent  TEXT NOT NULL,
  to_agent    TEXT NOT NULL,
  type        TEXT NOT NULL CHECK(type IN ('question','response','instruction','progress')),
  content     TEXT NOT NULL,
  parent_id   TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at  DATETIME NOT NULL DEFAULT (datetime('now', '+72 hours')),
  FOREIGN KEY (parent_id) REFERENCES messages(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_response ON messages(parent_id) WHERE type = 'response';
CREATE INDEX IF NOT EXISTS idx_messages_to_agent ON messages(to_agent, type, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id);
CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages(expires_at);
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
    this.purgeExpired();
  }

  purgeExpired(): number {
    const result = this.db
      .prepare("DELETE FROM messages WHERE expires_at < datetime('now')")
      .run();
    return result.changes;
  }

  insertQuestion(
    fromAgent: string,
    toAgent: string,
    content: string,
  ): string {
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

  close(): void {
    this.db.close();
  }
}
