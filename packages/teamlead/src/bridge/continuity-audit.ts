import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS continuity_fresh_start_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  execution_id TEXT NOT NULL UNIQUE,
  project_name TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  role TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  branch TEXT NOT NULL,
  skipped_origin_tip TEXT
);
CREATE INDEX IF NOT EXISTS idx_cfsa_issue
  ON continuity_fresh_start_audit(project_name, issue_id, ts);
`;

export interface FreshStartAuditRecord {
	executionId: string;
	projectName: string;
	issueId: string;
	role: string;
	actor: string;
	reason: string;
	branch: string;
	skippedOriginTip?: string;
}

/** Always-on append-only evidence for an explicit override of branch inheritance. */
export class ContinuityAudit {
	private db: Database.Database | undefined;

	constructor(
		private readonly dbPath: string,
		private readonly now: () => string = () => new Date().toISOString(),
	) {}

	private database(): Database.Database {
		if (this.db) return this.db;
		mkdirSync(dirname(this.dbPath), { recursive: true });
		this.db = new Database(this.dbPath);
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("busy_timeout = 5000");
		this.db.exec(SCHEMA);
		return this.db;
	}

	recordFreshStart(record: FreshStartAuditRecord): boolean {
		try {
			this.database()
				.prepare(
					`INSERT INTO continuity_fresh_start_audit
					   (ts, execution_id, project_name, issue_id, role, actor, reason, branch, skipped_origin_tip)
					 VALUES
					   (@ts, @execution_id, @project_name, @issue_id, @role, @actor, @reason, @branch, @skipped_origin_tip)
					 ON CONFLICT(execution_id) DO NOTHING`,
				)
				.run({
					ts: this.now(),
					execution_id: record.executionId,
					project_name: record.projectName,
					issue_id: record.issueId,
					role: record.role,
					actor: record.actor,
					reason: record.reason,
					branch: record.branch,
					skipped_origin_tip: record.skippedOriginTip ?? null,
				});
			return true;
		} catch {
			return false;
		}
	}

	forExecution(executionId: string): Array<Record<string, unknown>> {
		return this.database()
			.prepare(
				"SELECT * FROM continuity_fresh_start_audit WHERE execution_id = ? ORDER BY id",
			)
			.all(executionId) as Array<Record<string, unknown>>;
	}

	close(): void {
		this.db?.close();
		this.db = undefined;
	}
}
