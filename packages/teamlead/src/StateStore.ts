import initSqlJs, { type Database } from "sql.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** All statuses that represent a final outcome (used by dashboard, queries). */
export const OUTCOME_STATUSES = [
	"completed", "approved", "blocked", "failed",
	"rejected", "deferred", "shelved",
] as const;

// Terminal states — monotonic progression: once terminal, cannot go back to running
const TERMINAL_STATUSES = new Set<string>([
	...OUTCOME_STATUSES,
	"awaiting_review",
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
	slack_thread_ts?: string;
	session_params?: string;
	heartbeat_at?: string;
	adapter_type?: string;
	run_attempt?: number;
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
	slack_thread_ts?: string;
	session_params?: string;
	heartbeat_at?: string;
	adapter_type?: string;
	run_attempt?: number;
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

		// Idempotent migration — add slack_thread_ts if not present
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN slack_thread_ts TEXT");
		} catch {
			// Column already exists — ignore
		}

		// Idempotent migration — add GEO-157 heartbeat/adapter columns
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN session_params TEXT");
		} catch {
			// Column already exists — ignore
		}
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN heartbeat_at TEXT");
		} catch {
			// Column already exists — ignore
		}
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN adapter_type TEXT");
		} catch {
			// Column already exists — ignore
		}
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN run_attempt INTEGER DEFAULT 0");
		} catch {
			// Column already exists — ignore
		}

		// Ensure one issue = one canonical thread: clean up historical duplicates
		this.db.run(`
			DELETE FROM conversation_threads
			WHERE rowid NOT IN (
				SELECT MAX(rowid) FROM conversation_threads
				WHERE issue_id IS NOT NULL
				GROUP BY issue_id
			) AND issue_id IS NOT NULL
		`);
		this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_issue ON conversation_threads(issue_id)");

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
				summary, diff_summary, commit_messages, changed_file_paths,
				slack_thread_ts,
				session_params, heartbeat_at, adapter_type, run_attempt
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
				changed_file_paths = COALESCE(excluded.changed_file_paths, changed_file_paths),
				slack_thread_ts = COALESCE(excluded.slack_thread_ts, slack_thread_ts),
				session_params = COALESCE(excluded.session_params, session_params),
				heartbeat_at = COALESCE(excluded.heartbeat_at, heartbeat_at),
				adapter_type = COALESCE(excluded.adapter_type, adapter_type),
				run_attempt = COALESCE(excluded.run_attempt, run_attempt)
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
				session.slack_thread_ts ?? null,
				session.session_params ?? null,
				session.heartbeat_at ?? null,
				session.adapter_type ?? null,
				session.run_attempt ?? null,
			],
		);
		this.save();
	}

	/** Force-update status, bypassing the monotonic terminal→running guard. Used by explicit user actions (retry). */
	forceStatus(executionId: string, status: string, lastActivityAt: string, lastError?: string): void {
		this.db.run(
			`UPDATE sessions SET status = ?, last_activity_at = ?, last_error = ? WHERE execution_id = ?`,
			[status, lastActivityAt, lastError ?? null, executionId],
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

	getSessionByIdentifier(identifier: string): Session | undefined {
		const stmt = this.db.prepare(
			"SELECT * FROM sessions WHERE issue_identifier = ? ORDER BY last_activity_at DESC LIMIT 1",
		);
		stmt.bind([identifier]);
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			stmt.free();
			return this.rowToSession(row);
		}
		stmt.free();
		return undefined;
	}

	getRecentSessions(limit: number): Session[] {
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

	getSessionHistory(issueId: string): Session[] {
		const stmt = this.db.prepare(
			"SELECT * FROM sessions WHERE issue_id = ? ORDER BY started_at ASC",
		);
		stmt.bind([issueId]);
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
		// One issue = one canonical thread: remove any prior mapping for this issue
		// (unless it's the same thread_ts, in which case the INSERT handles it)
		this.db.run(
			"DELETE FROM conversation_threads WHERE issue_id = ? AND thread_ts != ?",
			[issueId, threadTs],
		);
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

	getThreadByIssue(issueId: string): { thread_ts: string; channel: string } | undefined {
		const stmt = this.db.prepare(
			"SELECT thread_ts, channel FROM conversation_threads WHERE issue_id = ?",
		);
		stmt.bind([issueId]);
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			stmt.free();
			return { thread_ts: row.thread_ts as string, channel: row.channel as string };
		}
		stmt.free();
		return undefined;
	}

	setSessionThreadTs(executionId: string, threadTs: string): void {
		this.db.run(
			"UPDATE sessions SET slack_thread_ts = ? WHERE execution_id = ?",
			[threadTs, executionId],
		);
		this.save();
	}

	getLatestSessionByIssueAndStatuses(issueId: string, statuses: string[]): Session | undefined {
		if (statuses.length === 0) return undefined;
		const placeholders = statuses.map(() => "?").join(", ");
		const stmt = this.db.prepare(
			`SELECT * FROM sessions WHERE issue_id = ? AND status IN (${placeholders}) ORDER BY last_activity_at DESC LIMIT 1`,
		);
		stmt.bind([issueId, ...statuses]);
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			stmt.free();
			return this.rowToSession(row);
		}
		stmt.free();
		return undefined;
	}

	getTerminalSessionsSince(sinceTs: string): Session[] {
		const placeholders = OUTCOME_STATUSES.map(() => "?").join(", ");
		const stmt = this.db.prepare(
			`SELECT * FROM sessions
			 WHERE status IN (${placeholders})
			 AND last_activity_at >= ?
			 ORDER BY last_activity_at DESC`,
		);
		stmt.bind([...OUTCOME_STATUSES, sinceTs]);
		const rows: Session[] = [];
		while (stmt.step()) {
			rows.push(this.rowToSession(stmt.getAsObject() as Record<string, unknown>));
		}
		stmt.free();
		return rows;
	}

	getRecentOutcomeSessions(limit: number): Session[] {
		const placeholders = OUTCOME_STATUSES.map(() => "?").join(", ");
		const stmt = this.db.prepare(
			`SELECT * FROM sessions
			 WHERE status IN (${placeholders})
			 ORDER BY last_activity_at DESC
			 LIMIT ?`,
		);
		stmt.bind([...OUTCOME_STATUSES, limit]);
		const rows: Session[] = [];
		while (stmt.step()) {
			rows.push(this.rowToSession(stmt.getAsObject() as Record<string, unknown>));
		}
		stmt.free();
		return rows;
	}

	/** Update heartbeat timestamp for an active execution. */
	updateHeartbeat(executionId: string): void {
		this.db.run(
			"UPDATE sessions SET heartbeat_at = datetime('now') WHERE execution_id = ?",
			[executionId],
		);
		this.save();
	}

	/** Find running sessions whose heartbeat has gone stale (orphan detection). */
	getOrphanSessions(thresholdMinutes: number): Session[] {
		const stmt = this.db.prepare(
			"SELECT * FROM sessions WHERE status = 'running' AND heartbeat_at IS NOT NULL AND heartbeat_at < datetime('now', ?)",
		);
		stmt.bind([`-${thresholdMinutes} minutes`]);
		const rows: Session[] = [];
		while (stmt.step()) {
			rows.push(this.rowToSession(stmt.getAsObject() as Record<string, unknown>));
		}
		stmt.free();
		return rows;
	}

	/** Retrieve parsed session_params for a given execution. */
	getSessionParams(executionId: string): Record<string, unknown> | undefined {
		const stmt = this.db.prepare("SELECT session_params FROM sessions WHERE execution_id = ?");
		stmt.bind([executionId]);
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			stmt.free();
			const raw = row.session_params as string | null;
			if (raw) {
				return JSON.parse(raw) as Record<string, unknown>;
			}
			return undefined;
		}
		stmt.free();
		return undefined;
	}

	/** Store session_params as JSON for a given execution. */
	setSessionParams(executionId: string, params: Record<string, unknown>): void {
		this.db.run(
			"UPDATE sessions SET session_params = ? WHERE execution_id = ?",
			[JSON.stringify(params), executionId],
		);
		this.save();
	}

	/** Get the most recent session_params + run_attempt for an issue (for session recovery). */
	getLatestSessionParams(issueId: string): { sessionParams: Record<string, unknown>; runAttempt: number } | undefined {
		const stmt = this.db.prepare(
			"SELECT session_params, run_attempt FROM sessions WHERE issue_id = ? AND session_params IS NOT NULL ORDER BY last_activity_at DESC LIMIT 1",
		);
		stmt.bind([issueId]);
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			stmt.free();
			const raw = row.session_params as string | null;
			if (raw) {
				return {
					sessionParams: JSON.parse(raw) as Record<string, unknown>,
					runAttempt: (row.run_attempt as number) ?? 0,
				};
			}
			return undefined;
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
			slack_thread_ts: (row.slack_thread_ts as string) ?? undefined,
			session_params: (row.session_params as string) ?? undefined,
			heartbeat_at: (row.heartbeat_at as string) ?? undefined,
			adapter_type: (row.adapter_type as string) ?? undefined,
			run_attempt: (row.run_attempt as number) ?? undefined,
		};
	}
}
