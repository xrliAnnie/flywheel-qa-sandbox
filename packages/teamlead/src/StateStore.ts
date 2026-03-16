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
	thread_id?: string;
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
	thread_id?: string;
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
				changed_file_paths TEXT,
				thread_id TEXT
			)
		`);

		this.db.run(`
			CREATE TABLE IF NOT EXISTS conversation_threads (
				thread_id TEXT PRIMARY KEY,
				channel TEXT NOT NULL,
				issue_id TEXT,
				summary TEXT,
				last_updated TEXT NOT NULL DEFAULT (datetime('now'))
			)
		`);

		// Migration: rename slack_thread_ts → thread_id (existing DBs)
		// Three cases: (a) fresh DB → DDL already has thread_id, skip
		//              (b) old DB with slack_thread_ts → rename
		//              (c) legacy DB without either column → ADD COLUMN
		const hasSlackThreadTs = this.db.exec(
			"SELECT 1 FROM pragma_table_info('sessions') WHERE name='slack_thread_ts'",
		);
		const hasThreadId = this.db.exec(
			"SELECT 1 FROM pragma_table_info('sessions') WHERE name='thread_id'",
		);
		if (hasSlackThreadTs.length > 0 && hasSlackThreadTs[0]!.values.length > 0) {
			// Case (b): old DB — rename
			this.db.run("ALTER TABLE sessions RENAME COLUMN slack_thread_ts TO thread_id");
		} else if (hasThreadId.length === 0 || hasThreadId[0]!.values.length === 0) {
			// Case (c): legacy DB — neither column exists
			this.db.run("ALTER TABLE sessions ADD COLUMN thread_id TEXT");
		}
		// Case (a): fresh DB — thread_id already in DDL, nothing to do

		// Same logic for conversation_threads
		const hasOldThreadTs = this.db.exec(
			"SELECT 1 FROM pragma_table_info('conversation_threads') WHERE name='thread_ts'",
		);
		const hasNewThreadId = this.db.exec(
			"SELECT 1 FROM pragma_table_info('conversation_threads') WHERE name='thread_id'",
		);
		if (hasOldThreadTs.length > 0 && hasOldThreadTs[0]!.values.length > 0) {
			this.db.run("ALTER TABLE conversation_threads RENAME COLUMN thread_ts TO thread_id");
		} else if (hasNewThreadId.length === 0 || hasNewThreadId[0]!.values.length === 0) {
			this.db.run("ALTER TABLE conversation_threads ADD COLUMN thread_id TEXT");
		}

		// Cutover: clear stale Slack thread mappings (one-time, guarded by user_version)
		const versionResult = this.db.exec("PRAGMA user_version");
		const currentVersion = (versionResult[0]?.values[0]?.[0] as number) ?? 0;
		if (currentVersion < 2) {
			this.db.run("DELETE FROM conversation_threads");
			this.db.run("UPDATE sessions SET thread_id = NULL");
			this.db.run("PRAGMA user_version = 2");
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

		// Rebuild unique index with current column name
		this.db.run("DROP INDEX IF EXISTS idx_threads_issue");
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
				thread_id,
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
				thread_id = COALESCE(excluded.thread_id, thread_id),
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
				session.thread_id ?? null,
				session.session_params ?? null,
				session.heartbeat_at ?? null,
				session.adapter_type ?? null,
				session.run_attempt ?? null,
			],
		);
		this.save();
	}

	/**
	 * Persist a status change that has already been validated by FSM.
	 * Bypasses monotonic guard — caller MUST have validated via WorkflowFSM.
	 * Uses INSERT OR UPDATE to handle both first-time creation and subsequent transitions.
	 * GEO-158: used exclusively by applyTransition().
	 */
	persistTransition(executionId: string, status: string, fields: Partial<SessionUpsert>): void {
		this.db.run(
			`INSERT INTO sessions (
				execution_id, issue_id, project_name, status,
				issue_identifier, issue_title,
				started_at, last_activity_at,
				tmux_session, worktree_path, branch,
				last_error, decision_route, decision_reasoning,
				cost_usd, commit_count, files_changed, lines_added, lines_removed,
				summary, diff_summary, commit_messages, changed_file_paths,
				thread_id,
				session_params, heartbeat_at, adapter_type, run_attempt
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(execution_id) DO UPDATE SET
				status = excluded.status,
				issue_id = COALESCE(excluded.issue_id, issue_id),
				project_name = COALESCE(excluded.project_name, project_name),
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
				thread_id = COALESCE(excluded.thread_id, thread_id),
				session_params = COALESCE(excluded.session_params, session_params),
				heartbeat_at = COALESCE(excluded.heartbeat_at, heartbeat_at),
				adapter_type = COALESCE(excluded.adapter_type, adapter_type),
				run_attempt = COALESCE(excluded.run_attempt, run_attempt)
			`,
			[
				executionId,
				fields.issue_id ?? null,
				fields.project_name ?? null,
				status,
				fields.issue_identifier ?? null,
				fields.issue_title ?? null,
				fields.started_at ?? null,
				fields.last_activity_at ?? null,
				fields.tmux_session ?? null,
				fields.worktree_path ?? null,
				fields.branch ?? null,
				fields.last_error ?? null,
				fields.decision_route ?? null,
				fields.decision_reasoning ?? null,
				fields.cost_usd ?? null,
				fields.commit_count ?? null,
				fields.files_changed ?? null,
				fields.lines_added ?? null,
				fields.lines_removed ?? null,
				fields.summary ?? null,
				fields.diff_summary ?? null,
				fields.commit_messages ?? null,
				fields.changed_file_paths ?? null,
				fields.thread_id ?? null,
				fields.session_params ?? null,
				fields.heartbeat_at ?? null,
				fields.adapter_type ?? null,
				fields.run_attempt ?? null,
			],
		);
		this.save();
	}

	/**
	 * Update non-status metadata fields only. Does NOT touch status.
	 * Used after applyTransition() for read-model enrichment (commit_count, lines_added, etc.)
	 * GEO-158: separates status writes (FSM) from metadata writes (event-route).
	 */
	patchSessionMetadata(executionId: string, fields: Partial<Omit<SessionUpsert, "status">>): void {
		const setClauses: string[] = [];
		const values: (string | number | null)[] = [];

		const fieldMap: Record<string, keyof typeof fields> = {
			issue_id: "issue_id",
			project_name: "project_name",
			issue_identifier: "issue_identifier",
			issue_title: "issue_title",
			started_at: "started_at",
			last_activity_at: "last_activity_at",
			tmux_session: "tmux_session",
			worktree_path: "worktree_path",
			branch: "branch",
			last_error: "last_error",
			decision_route: "decision_route",
			decision_reasoning: "decision_reasoning",
			cost_usd: "cost_usd",
			commit_count: "commit_count",
			files_changed: "files_changed",
			lines_added: "lines_added",
			lines_removed: "lines_removed",
			summary: "summary",
			diff_summary: "diff_summary",
			commit_messages: "commit_messages",
			changed_file_paths: "changed_file_paths",
			thread_id: "thread_id",
			session_params: "session_params",
			heartbeat_at: "heartbeat_at",
			adapter_type: "adapter_type",
			run_attempt: "run_attempt",
		};

		for (const [col, key] of Object.entries(fieldMap)) {
			if (fields[key] !== undefined) {
				setClauses.push(`${col} = ?`);
				values.push(fields[key] as string | number | null);
			}
		}

		if (setClauses.length === 0) return;

		values.push(executionId);
		this.db.run(
			`UPDATE sessions SET ${setClauses.join(", ")} WHERE execution_id = ?`,
			values,
		);
		this.save();
	}

	/**
	 * @deprecated Use applyTransition() with FSM instead. Will be removed in v1.3.0.
	 */
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

	upsertThread(threadId: string, channel: string, issueId: string): void {
		// One issue = one canonical thread: remove any prior mapping for this issue
		// (unless it's the same thread_id, in which case the INSERT handles it)
		this.db.run(
			"DELETE FROM conversation_threads WHERE issue_id = ? AND thread_id != ?",
			[issueId, threadId],
		);
		this.db.run(
			`INSERT INTO conversation_threads (thread_id, channel, issue_id)
			 VALUES (?, ?, ?)
			 ON CONFLICT(thread_id) DO UPDATE SET
				channel = excluded.channel,
				issue_id = excluded.issue_id,
				last_updated = datetime('now')`,
			[threadId, channel, issueId],
		);
		this.save();
	}

	getThreadIssue(threadId: string): string | undefined {
		const stmt = this.db.prepare("SELECT issue_id FROM conversation_threads WHERE thread_id = ?");
		stmt.bind([threadId]);
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			stmt.free();
			return row.issue_id as string;
		}
		stmt.free();
		return undefined;
	}

	getThreadByIssue(issueId: string): { thread_id: string; channel: string } | undefined {
		const stmt = this.db.prepare(
			"SELECT thread_id, channel FROM conversation_threads WHERE issue_id = ?",
		);
		stmt.bind([issueId]);
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			stmt.free();
			return { thread_id: row.thread_id as string, channel: row.channel as string };
		}
		stmt.free();
		return undefined;
	}

	setSessionThreadId(executionId: string, threadId: string): void {
		this.db.run(
			"UPDATE sessions SET thread_id = ? WHERE execution_id = ?",
			[threadId, executionId],
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
			thread_id: (row.thread_id as string) ?? undefined,
			session_params: (row.session_params as string) ?? undefined,
			heartbeat_at: (row.heartbeat_at as string) ?? undefined,
			adapter_type: (row.adapter_type as string) ?? undefined,
			run_attempt: (row.run_attempt as number) ?? undefined,
		};
	}
}
