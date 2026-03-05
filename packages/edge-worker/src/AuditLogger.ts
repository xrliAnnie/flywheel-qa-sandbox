import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import initSqlJs, { type Database } from "sql.js";
import type { DecisionResult, ExecutionContext } from "flywheel-core";

export interface AuditEntry {
	id: string;
	timestamp: string;
	eventType: "decision_made" | "hard_rule_triggered" | "llm_fallback";
	issueId: string;
	issueIdentifier: string;
	projectId: string;
	route: string;
	decisionSource: string;
	confidence: number;
	reasoning: string;
	commitCount: number;
	filesChanged: number;
	linesAdded: number;
	linesRemoved: number;
	durationMinutes: number;
	consecutiveFailures: number;
}

export class AuditLogger {
	private db: Database | null = null;

	constructor(private dbPath: string) {}

	async init(): Promise<void> {
		const SQL = await initSqlJs();
		if (existsSync(this.dbPath)) {
			const buffer = readFileSync(this.dbPath);
			this.db = new SQL.Database(buffer);
		} else {
			this.db = new SQL.Database();
		}
		this.db.run(`
			CREATE TABLE IF NOT EXISTS audit_entries (
				id TEXT PRIMARY KEY,
				timestamp TEXT NOT NULL,
				event_type TEXT NOT NULL,
				issue_id TEXT NOT NULL,
				issue_identifier TEXT NOT NULL,
				project_id TEXT NOT NULL,
				route TEXT NOT NULL,
				decision_source TEXT NOT NULL,
				confidence REAL NOT NULL,
				reasoning TEXT NOT NULL,
				commit_count INTEGER NOT NULL,
				files_changed INTEGER NOT NULL,
				lines_added INTEGER NOT NULL,
				lines_removed INTEGER NOT NULL,
				duration_minutes REAL NOT NULL,
				consecutive_failures INTEGER NOT NULL
			)
		`);
		this.save();
	}

	async log(ctx: ExecutionContext, result: DecisionResult): Promise<void> {
		if (!this.db) throw new Error("AuditLogger not initialized");

		const eventType = this.deriveEventType(result);
		this.db.run(
			`INSERT INTO audit_entries (
				id, timestamp, event_type, issue_id, issue_identifier, project_id,
				route, decision_source, confidence, reasoning,
				commit_count, files_changed, lines_added, lines_removed,
				duration_minutes, consecutive_failures
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				randomUUID(),
				new Date().toISOString(),
				eventType,
				ctx.issueId,
				ctx.issueIdentifier,
				ctx.projectId,
				result.route,
				result.decisionSource,
				result.confidence,
				result.reasoning,
				ctx.commitCount,
				ctx.filesChangedCount,
				ctx.linesAdded,
				ctx.linesRemoved,
				ctx.durationMs / 60_000,
				ctx.consecutiveFailures,
			],
		);
		this.save();
	}

	async getByIssue(issueId: string): Promise<AuditEntry[]> {
		if (!this.db) throw new Error("AuditLogger not initialized");
		const stmt = this.db.prepare(
			"SELECT * FROM audit_entries WHERE issue_id = ? ORDER BY rowid DESC",
		);
		stmt.bind([issueId]);
		const entries: AuditEntry[] = [];
		while (stmt.step()) {
			entries.push(this.rowToEntry(stmt.getAsObject()));
		}
		stmt.free();
		return entries;
	}

	async getRecent(limit: number): Promise<AuditEntry[]> {
		if (!this.db) throw new Error("AuditLogger not initialized");
		const stmt = this.db.prepare(
			"SELECT * FROM audit_entries ORDER BY rowid DESC LIMIT ?",
		);
		stmt.bind([limit]);
		const entries: AuditEntry[] = [];
		while (stmt.step()) {
			entries.push(this.rowToEntry(stmt.getAsObject()));
		}
		stmt.free();
		return entries;
	}

	async close(): Promise<void> {
		if (this.db) {
			this.save();
			this.db.close();
			this.db = null;
		}
	}

	private save(): void {
		if (!this.db) return;
		const data = this.db.export();
		writeFileSync(this.dbPath, Buffer.from(data));
	}

	private deriveEventType(
		result: DecisionResult,
	): AuditEntry["eventType"] {
		if (result.decisionSource === "hard_rule") return "hard_rule_triggered";
		if (result.decisionSource === "fallback_heuristic") return "llm_fallback";
		return "decision_made";
	}

	private rowToEntry(row: Record<string, unknown>): AuditEntry {
		return {
			id: row.id as string,
			timestamp: row.timestamp as string,
			eventType: row.event_type as AuditEntry["eventType"],
			issueId: row.issue_id as string,
			issueIdentifier: row.issue_identifier as string,
			projectId: row.project_id as string,
			route: row.route as string,
			decisionSource: row.decision_source as string,
			confidence: row.confidence as number,
			reasoning: row.reasoning as string,
			commitCount: row.commit_count as number,
			filesChanged: row.files_changed as number,
			linesAdded: row.lines_added as number,
			linesRemoved: row.lines_removed as number,
			durationMinutes: row.duration_minutes as number,
			consecutiveFailures: row.consecutive_failures as number,
		};
	}
}
