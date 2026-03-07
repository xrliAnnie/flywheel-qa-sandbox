import initSqlJs, { type Database } from "sql.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Terminal states — monotonic progression: once terminal, cannot go back to running
const TERMINAL_STATUSES = new Set([
	"completed",
	"awaiting_review",
	"approved",
	"blocked",
	"failed",
]);

export interface SessionEvent {
	event_id: string;
	execution_id: string;
	issue_id: string;
	project_name: string;
	event_type: string;
	severity?: string;
	payload?: unknown;
	source: string;
}

export interface SessionUpsert {
	execution_id: string;
	issue_id: string;
	project_name: string;
	status: string;
	issue_identifier?: string;
	issue_title?: string;
	started_at?: string;
	last_activity_at?: string;
	tmux_session?: string;
	worktree_path?: string;
	branch?: string;
	last_error?: string;
	decision_route?: string;
	decision_reasoning?: string;
	cost_usd?: number;
	commit_count?: number;
	files_changed?: number;
	lines_added?: number;
	lines_removed?: number;
	summary?: string;
	diff_summary?: string;
	commit_messages?: string;
	changed_file_paths?: string;
}

export interface Session {
	execution_id: string;
	issue_id: string;
	project_name: string;
	status: string;
	issue_identifier?: string;
	issue_title?: string;
	started_at?: string;
	last_activity_at?: string;
	tmux_session?: string;
	worktree_path?: string;
	branch?: string;
	last_error?: string;
	decision_route?: string;
	decision_reasoning?: string;
	cost_usd?: number;
	commit_count?: number;
	files_changed?: number;
	lines_added?: number;
	lines_removed?: number;
	summary?: string;
	diff_summary?: string;
	commit_messages?: string;
	changed_file_paths?: string;
}

export class StateStore {
	private db: Database;
	private dbPath: string;

	private constructor(db: Database, dbPath: string) {
		this.db = db;
		this.dbPath = dbPath;
	}

	static async create(dbPath: string): Promise<StateStore> {
		const SQL = await initSqlJs();
		let db: Database;
		if (dbPath === ":memory:") {
			db = new SQL.Database();
		} else {
			try {
				const data = readFileSync(dbPath);
				db = new SQL.Database(data);
			} catch {
				mkdirSync(dirname(dbPath), { recursive: true });
				db = new SQL.Database();
			}
		}
		const store = new StateStore(db, dbPath);
		store.migrate();
		return store;
	}

	close(): void {
		this.save();
		this.db.close();
	}

	private save(): void {
		if (this.dbPath === ":memory:") return;
		const data = this.db.export();
		writeFileSync(this.dbPath, Buffer.from(data));
	}

	migrate(): void {
		this.db.run(`
			CREATE TABLE IF NOT EXISTS session_events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				event_id TEXT UNIQUE NOT NULL,
				ts TEXT NOT NULL DEFAULT (datetime('now')),
				execution_id TEXT NOT NULL,
				issue_id TEXT NOT NULL,
				project_name TEXT NOT NULL,
				event_type TEXT NOT NULL,
				severity TEXT NOT NULL DEFAULT 'info',
				payload JSON,
				source TEXT NOT NULL
			)
		`);

		this.db.run(`
			CREATE TABLE IF NOT EXISTS sessions (
				execution_id TEXT PRIMARY KEY,
				issue_id TEXT NOT NULL,
				issue_identifier TEXT,
				issue_title TEXT,
				project_name TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending',
				started_at TEXT,
				last_activity_at TEXT,
				tmux_session TEXT,
				worktree_path TEXT,
				branch TEXT,
				last_error TEXT,
				decision_route TEXT,
				decision_reasoning TEXT,
				cost_usd REAL DEFAULT 0,
				commit_count INTEGER DEFAULT 0,
				files_changed INTEGER DEFAULT 0,
				lines_added INTEGER DEFAULT 0,
				lines_removed INTEGER DEFAULT 0,
				summary TEXT,
				diff_summary TEXT,
				commit_messages TEXT,
				changed_file_paths TEXT
			)
		`);

		this.db.run(`
			CREATE TABLE IF NOT EXISTS conversation_threads (
				thread_ts TEXT PRIMARY KEY,
				channel TEXT NOT NULL,
				issue_id TEXT,
				summary TEXT,
				last_updated TEXT NOT NULL DEFAULT (datetime('now'))
			)
		`);

		this.db.run("CREATE INDEX IF NOT EXISTS idx_events_execution ON session_events(execution_id)");
		this.db.run("CREATE INDEX IF NOT EXISTS idx_events_issue ON session_events(issue_id)");
		this.db.run("CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)");
	}

	insertEvent(event: SessionEvent): boolean {
		try {
			this.db.run(
				`INSERT INTO session_events (event_id, execution_id, issue_id, project_name, event_type, severity, payload, source)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					event.event_id,
					event.execution_id,
					event.issue_id,
					event.project_name,
					event.event_type,
					event.severity ?? "info",
					event.payload ? JSON.stringify(event.payload) : null,
					event.source,
				],
			);
			this.save();
			return true;
		} catch (err: unknown) {
			if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
				return false;
			}
			throw err;
		}
	}

	getEventsByExecution(executionId: string): SessionEvent[] {
		const stmt = this.db.prepare(
			"SELECT * FROM session_events WHERE execution_id = ? ORDER BY id",
		);
		stmt.bind([executionId]);
		const rows: SessionEvent[] = [];
		while (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			rows.push({
				event_id: row.event_id as string,
				execution_id: row.execution_id as string,
				issue_id: row.issue_id as string,
				project_name: row.project_name as string,
				event_type: row.event_type as string,
				severity: row.severity as string,
				payload: row.payload ? JSON.parse(row.payload as string) : undefined,
				source: row.source as string,
			});
		}
		stmt.free();
		return rows;
	}

	upsertSession(session: SessionUpsert): void {
		// Check monotonic state: if existing session is terminal, ignore transition back to running
		const existing = this.getSession(session.execution_id);
		if (existing && TERMINAL_STATUSES.has(existing.status) && session.status === "running") {
			return; // Ignore: terminal → running is not allowed
		}

		this.db.run(
			`INSERT INTO sessions (
				execution_id, issue_id, project_name, status,
				issue_identifier, issue_title,
				started_at, last_activity_at,
				tmux_session, worktree_path, branch,
				last_error, decision_route, decision_reasoning,
				cost_usd, commit_count, files_changed, lines_added, lines_removed,
				summary, diff_summary, commit_messages, changed_file_paths
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(execution_id) DO UPDATE SET
				issue_id = COALESCE(excluded.issue_id, issue_id),
				project_name = COALESCE(excluded.project_name, project_name),
				status = excluded.status,
				issue_identifier = COALESCE(excluded.issue_identifier, issue_identifier),
				issue_title = COALESCE(excluded.issue_title, issue_title),
				started_at = COALESCE(excluded.started_at, started_at),
				last_activity_at = COALESCE(excluded.last_activity_at, last_activity_at),
				tmux_session = COALESCE(excluded.tmux_session, tmux_session),
				worktree_path = COALESCE(excluded.worktree_path, worktree_path),
				branch = COALESCE(excluded.branch, branch),
				last_error = COALESCE(excluded.last_error, last_error),
				decision_route = COALESCE(excluded.decision_route, decision_route),
				decision_reasoning = COALESCE(excluded.decision_reasoning, decision_reasoning),
				cost_usd = COALESCE(excluded.cost_usd, cost_usd),
				commit_count = COALESCE(excluded.commit_count, commit_count),
				files_changed = COALESCE(excluded.files_changed, files_changed),
				lines_added = COALESCE(excluded.lines_added, lines_added),
				lines_removed = COALESCE(excluded.lines_removed, lines_removed),
				summary = COALESCE(excluded.summary, summary),
				diff_summary = COALESCE(excluded.diff_summary, diff_summary),
				commit_messages = COALESCE(excluded.commit_messages, commit_messages),
				changed_file_paths = COALESCE(excluded.changed_file_paths, changed_file_paths)
			`,
			[
				session.execution_id,
				session.issue_id,
				session.project_name,
				session.status,
				session.issue_identifier ?? null,
				session.issue_title ?? null,
				session.started_at ?? null,
				session.last_activity_at ?? null,
				session.tmux_session ?? null,
				session.worktree_path ?? null,
				session.branch ?? null,
				session.last_error ?? null,
				session.decision_route ?? null,
				session.decision_reasoning ?? null,
				session.cost_usd ?? null,
				session.commit_count ?? null,
				session.files_changed ?? null,
				session.lines_added ?? null,
				session.lines_removed ?? null,
				session.summary ?? null,
				session.diff_summary ?? null,
				session.commit_messages ?? null,
				session.changed_file_paths ?? null,
			],
		);
		this.save();
	}

	getSession(executionId: string): Session | undefined {
		const stmt = this.db.prepare("SELECT * FROM sessions WHERE execution_id = ?");
		stmt.bind([executionId]);
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			stmt.free();
			return this.rowToSession(row);
		}
		stmt.free();
		return undefined;
	}

	getSessionByIssue(issueId: string): Session | undefined {
		const stmt = this.db.prepare("SELECT * FROM sessions WHERE issue_id = ? ORDER BY last_activity_at DESC LIMIT 1");
		stmt.bind([issueId]);
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			stmt.free();
			return this.rowToSession(row);
		}
		stmt.free();
		return undefined;
	}

	getActiveSessions(): Session[] {
		const stmt = this.db.prepare("SELECT * FROM sessions WHERE status IN ('running', 'awaiting_review')");
		const rows: Session[] = [];
		while (stmt.step()) {
			rows.push(this.rowToSession(stmt.getAsObject() as Record<string, unknown>));
		}
		stmt.free();
		return rows;
	}

	getStuckSessions(thresholdMinutes: number): Session[] {
		const stmt = this.db.prepare(
			"SELECT * FROM sessions WHERE status = 'running' AND last_activity_at < datetime('now', ?)",
		);
		stmt.bind([`-${thresholdMinutes} minutes`]);
		const rows: Session[] = [];
		while (stmt.step()) {
			rows.push(this.rowToSession(stmt.getAsObject() as Record<string, unknown>));
		}
		stmt.free();
		return rows;
	}

	getLatestActionableSession(issueId: string): Session | undefined {
		const stmt = this.db.prepare(
			"SELECT * FROM sessions WHERE issue_id = ? AND status IN ('awaiting_review', 'blocked') ORDER BY last_activity_at DESC LIMIT 1",
		);
		stmt.bind([issueId]);
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			stmt.free();
			return this.rowToSession(row);
		}
		stmt.free();
		return undefined;
	}

	upsertThread(threadTs: string, channel: string, issueId: string): void {
		this.db.run(
			`INSERT INTO conversation_threads (thread_ts, channel, issue_id)
			 VALUES (?, ?, ?)
			 ON CONFLICT(thread_ts) DO UPDATE SET
				channel = excluded.channel,
				issue_id = excluded.issue_id,
				last_updated = datetime('now')`,
			[threadTs, channel, issueId],
		);
		this.save();
	}

	getRecentSessions(limit = 20): Session[] {
		const stmt = this.db.prepare(
			"SELECT * FROM sessions ORDER BY last_activity_at DESC LIMIT ?",
		);
		stmt.bind([limit]);
		const rows: Session[] = [];
		while (stmt.step()) {
			rows.push(this.rowToSession(stmt.getAsObject() as Record<string, unknown>));
		}
		stmt.free();
		return rows;
	}

	getSessionHistory(issueId: string, limit = 20): Session[] {
		const stmt = this.db.prepare(
			"SELECT * FROM sessions WHERE issue_id = ? ORDER BY started_at ASC LIMIT ?",
		);
		stmt.bind([issueId, limit]);
		const rows: Session[] = [];
		while (stmt.step()) {
			rows.push(this.rowToSession(stmt.getAsObject() as Record<string, unknown>));
		}
		stmt.free();
		return rows;
	}

	getThreadForIssue(issueId: string): string | undefined {
		const stmt = this.db.prepare(
			"SELECT thread_ts FROM conversation_threads WHERE issue_id = ? ORDER BY last_updated DESC LIMIT 1",
		);
		stmt.bind([issueId]);
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			stmt.free();
			return row.thread_ts as string;
		}
		stmt.free();
		return undefined;
	}

	getThreadIssue(threadTs: string): string | undefined {
		const stmt = this.db.prepare("SELECT issue_id FROM conversation_threads WHERE thread_ts = ?");
		stmt.bind([threadTs]);
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			stmt.free();
			return row.issue_id as string;
		}
		stmt.free();
		return undefined;
	}

	private rowToSession(row: Record<string, unknown>): Session {
		return {
			execution_id: row.execution_id as string,
			issue_id: row.issue_id as string,
			project_name: row.project_name as string,
			status: row.status as string,
			issue_identifier: (row.issue_identifier as string) ?? undefined,
			issue_title: (row.issue_title as string) ?? undefined,
			started_at: (row.started_at as string) ?? undefined,
			last_activity_at: (row.last_activity_at as string) ?? undefined,
			tmux_session: (row.tmux_session as string) ?? undefined,
			worktree_path: (row.worktree_path as string) ?? undefined,
			branch: (row.branch as string) ?? undefined,
			last_error: (row.last_error as string) ?? undefined,
			decision_route: (row.decision_route as string) ?? undefined,
			decision_reasoning: (row.decision_reasoning as string) ?? undefined,
			cost_usd: (row.cost_usd as number) ?? undefined,
			commit_count: (row.commit_count as number) ?? undefined,
			files_changed: (row.files_changed as number) ?? undefined,
			lines_added: (row.lines_added as number) ?? undefined,
			lines_removed: (row.lines_removed as number) ?? undefined,
			summary: (row.summary as string) ?? undefined,
			diff_summary: (row.diff_summary as string) ?? undefined,
			commit_messages: (row.commit_messages as string) ?? undefined,
			changed_file_paths: (row.changed_file_paths as string) ?? undefined,
		};
	}
}
