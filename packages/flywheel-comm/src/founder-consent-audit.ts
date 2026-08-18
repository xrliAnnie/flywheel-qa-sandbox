/**
 * FLY-175 Track 2 — Founder Consent audit store (the calibration corpus).
 *
 * Lives in flywheel-comm (not teamlead) for one structural reason: the audit
 * The Bridge (teamlead) imports this store from flywheel-comm so the audit
 * schema has one implementation and cannot drift between packages.
 *
 * Schema is plan §6. It is a calibration corpus for Track 3, not just a debug
 * log — denormalized context columns capture the mutable state at decision
 * time so decisions can be replayed without re-querying Discord/Linear.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export const FOUNDER_CONSENT_AUDIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS founder_consent_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,

  evaluator_version TEXT NOT NULL,
  prompt_content_hash TEXT,
  decision_mode TEXT NOT NULL,
  action TEXT NOT NULL,

  issue_id TEXT NOT NULL,
  issue_identifier TEXT,
  project_name TEXT,
  execution_id TEXT,
  session_role TEXT,
  session_status_at_decision TEXT,
  issue_labels_json TEXT,
  pr_number INTEGER,
  pr_head_sha TEXT,

  actor_source TEXT NOT NULL,
  lead_id TEXT,
  requested_by TEXT,
  request_reason TEXT,

  decision TEXT NOT NULL,
  decision_source TEXT NOT NULL,
  confidence REAL,
  threshold_applied REAL,

  evidence_message_id TEXT,
  evidence_excerpt TEXT,
  llm_reason TEXT,
  llm_raw_response TEXT,

  prompt_token_count INTEGER,
  completion_token_count INTEGER,
  llm_latency_ms INTEGER,
  fetched_msg_count INTEGER,
  founder_msg_count INTEGER,
  cache_hit_ts TEXT,

  thread_id TEXT,
  discord_channel_id TEXT,
  founder_user_id_snapshot TEXT,
  message_window_oldest_ts TEXT,
  message_window_newest_ts TEXT,
  config_hash TEXT,

  comm_question_id TEXT,
  comm_response_id TEXT,
  comm_project_name TEXT,

  founder_subsequent_ack TEXT,
  founder_subsequent_ack_ts TEXT,
  founder_subsequent_ack_message_id TEXT,
  human_review_label TEXT,
  human_review_label_source TEXT,
  human_review_label_ts TEXT
);
CREATE INDEX IF NOT EXISTS idx_fca_issue ON founder_consent_audit(issue_identifier, ts DESC);
CREATE INDEX IF NOT EXISTS idx_fca_lead ON founder_consent_audit(lead_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_fca_action_decision ON founder_consent_audit(action, decision, ts DESC);
CREATE INDEX IF NOT EXISTS idx_fca_project_lead ON founder_consent_audit(project_name, lead_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_fca_ts ON founder_consent_audit(ts);
CREATE INDEX IF NOT EXISTS idx_fca_comm_question ON founder_consent_audit(action, comm_question_id);
`;

export type AuditDecision = "allow" | "deny" | "fail_closed" | "bypass";
export type AuditDecisionSource =
	| "llm"
	| "cache"
	| "bypass_env"
	| "bypass_label"
	| "bypass_label_stored_fallback"
	| "fail_mode";

/** One audit row to insert. All context columns optional except the few
 * NOT NULL ones, which the caller must always supply. */
export interface FounderConsentAuditRow {
	ts: string;
	evaluator_version: string;
	prompt_content_hash?: string | null;
	decision_mode: string;
	action: string;

	issue_id: string;
	issue_identifier?: string | null;
	project_name?: string | null;
	execution_id?: string | null;
	session_role?: string | null;
	session_status_at_decision?: string | null;
	issue_labels_json?: string | null;
	pr_number?: number | null;
	pr_head_sha?: string | null;

	actor_source: string;
	lead_id?: string | null;
	requested_by?: string | null;
	request_reason?: string | null;

	decision: AuditDecision;
	decision_source: AuditDecisionSource;
	confidence?: number | null;
	threshold_applied?: number | null;

	evidence_message_id?: string | null;
	evidence_excerpt?: string | null;
	llm_reason?: string | null;
	llm_raw_response?: string | null;

	prompt_token_count?: number | null;
	completion_token_count?: number | null;
	llm_latency_ms?: number | null;
	fetched_msg_count?: number | null;
	founder_msg_count?: number | null;
	cache_hit_ts?: string | null;

	thread_id?: string | null;
	discord_channel_id?: string | null;
	founder_user_id_snapshot?: string | null;
	message_window_oldest_ts?: string | null;
	message_window_newest_ts?: string | null;
	config_hash?: string | null;

	comm_question_id?: string | null;
	comm_response_id?: string | null;
	comm_project_name?: string | null;
}

const INSERT_COLUMNS: (keyof FounderConsentAuditRow)[] = [
	"ts",
	"evaluator_version",
	"prompt_content_hash",
	"decision_mode",
	"action",
	"issue_id",
	"issue_identifier",
	"project_name",
	"execution_id",
	"session_role",
	"session_status_at_decision",
	"issue_labels_json",
	"pr_number",
	"pr_head_sha",
	"actor_source",
	"lead_id",
	"requested_by",
	"request_reason",
	"decision",
	"decision_source",
	"confidence",
	"threshold_applied",
	"evidence_message_id",
	"evidence_excerpt",
	"llm_reason",
	"llm_raw_response",
	"prompt_token_count",
	"completion_token_count",
	"llm_latency_ms",
	"fetched_msg_count",
	"founder_msg_count",
	"cache_hit_ts",
	"thread_id",
	"discord_channel_id",
	"founder_user_id_snapshot",
	"message_window_oldest_ts",
	"message_window_newest_ts",
	"config_hash",
	"comm_question_id",
	"comm_response_id",
	"comm_project_name",
];

export class FounderConsentAuditStore {
	private db: Database.Database;

	constructor(dbPath: string) {
		mkdirSync(dirname(dbPath), { recursive: true });
		this.db = new Database(dbPath);
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("busy_timeout = 5000");
		this.db.exec(FOUNDER_CONSENT_AUDIT_SCHEMA);
	}

	/** Insert one audit row. Returns the auto-increment id. */
	insert(row: FounderConsentAuditRow): number {
		const cols = INSERT_COLUMNS;
		const placeholders = cols.map(() => "?").join(", ");
		const stmt = this.db.prepare(
			`INSERT INTO founder_consent_audit (${cols.join(", ")}) VALUES (${placeholders})`,
		);
		const values = cols.map((c) => {
			const v = row[c];
			return v === undefined ? null : v;
		});
		const info = stmt.run(...(values as Array<string | number | null>));
		return Number(info.lastInsertRowid);
	}

	/** Most recent N rows for an issue (debug endpoint). */
	queryByIssue(
		issueIdentifier: string,
		limit: number,
	): Record<string, unknown>[] {
		return this.db
			.prepare(
				`SELECT * FROM founder_consent_audit
         WHERE issue_identifier = ?
         ORDER BY ts DESC LIMIT ?`,
			)
			.all(issueIdentifier, limit) as Record<string, unknown>[];
	}

	/** Most recent N rows across all issues (debug endpoint). */
	queryRecent(limit: number): Record<string, unknown>[] {
		return this.db
			.prepare("SELECT * FROM founder_consent_audit ORDER BY ts DESC LIMIT ?")
			.all(limit) as Record<string, unknown>[];
	}

	close(): void {
		this.db.close();
	}

	static exists(dbPath: string): boolean {
		return existsSync(dbPath);
	}
}
