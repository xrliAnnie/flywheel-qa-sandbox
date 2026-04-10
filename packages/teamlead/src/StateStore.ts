import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import initSqlJs, { type Database } from "sql.js";

/** All statuses that represent a final outcome (used by dashboard, queries). */
export const OUTCOME_STATUSES = [
	"completed",
	"approved",
	"approved_to_ship",
	"blocked",
	"failed",
	"rejected",
	"deferred",
	"shelved",
	"terminated",
] as const;

// Terminal states — monotonic progression: once terminal, cannot go back to running
// Note: approved_to_ship is NOT terminal — Runner still needs to ship
const TERMINAL_STATUSES = new Set<string>([
	...OUTCOME_STATUSES,
	"awaiting_review",
]);
// approved_to_ship is an outcome but not terminal (Runner will transition to completed)
TERMINAL_STATUSES.delete("approved_to_ship");

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
	retry_predecessor?: string;
	retry_successor?: string;
	issue_labels?: string;
	pr_number?: number;
	session_stage?: string;
	stage_updated_at?: string;
	/** FLY-59: Session role for multi-session-per-issue */
	session_role?: string;
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
	retry_predecessor?: string;
	retry_successor?: string;
	issue_labels?: string;
	pr_number?: number;
	session_stage?: string;
	stage_updated_at?: string;
	/** FLY-59: Session role for multi-session-per-issue */
	session_role?: string;
}

export interface CleanupCandidate {
	thread_id: string;
	issue_id: string;
	status: string;
	last_activity_at: string;
	cleanup_notified_at: string | null;
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
			this.db.run(
				"ALTER TABLE sessions RENAME COLUMN slack_thread_ts TO thread_id",
			);
		} else if (
			hasThreadId.length === 0 ||
			hasThreadId[0]!.values.length === 0
		) {
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
			this.db.run(
				"ALTER TABLE conversation_threads RENAME COLUMN thread_ts TO thread_id",
			);
		} else if (
			hasNewThreadId.length === 0 ||
			hasNewThreadId[0]!.values.length === 0
		) {
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
			this.db.run(
				"ALTER TABLE sessions ADD COLUMN run_attempt INTEGER DEFAULT 0",
			);
		} catch {
			// Column already exists — ignore
		}

		// GEO-168: retry lineage columns
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN retry_predecessor TEXT");
		} catch {}
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN retry_successor TEXT");
		} catch {}

		// GEO-152: issue labels for multi-lead routing
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN issue_labels TEXT");
		} catch {}

		// GEO-169: cleanup tracking columns
		try {
			this.db.run(
				"ALTER TABLE conversation_threads ADD COLUMN archived_at TEXT",
			);
		} catch {
			/* exists */
		}
		try {
			this.db.run(
				"ALTER TABLE conversation_threads ADD COLUMN cleanup_notified_at TEXT",
			);
		} catch {
			/* exists */
		}

		// GEO-200: Track threads that no longer exist in Discord
		try {
			this.db.run(
				"ALTER TABLE conversation_threads ADD COLUMN discord_missing_at TEXT",
			);
		} catch {
			/* exists */
		}

		// GEO-292: PR number + session stage tracking
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN pr_number INTEGER");
		} catch {
			/* exists */
		}
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN session_stage TEXT");
		} catch {
			/* exists */
		}
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN stage_updated_at TEXT");
		} catch {
			/* exists */
		}

		// FLY-59: session role for multi-session-per-issue support
		try {
			this.db.run(
				"ALTER TABLE sessions ADD COLUMN session_role TEXT DEFAULT 'main'",
			);
		} catch {
			/* exists */
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
		this.db.run(
			"CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_issue ON conversation_threads(issue_id)",
		);

		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_events_execution ON session_events(execution_id)",
		);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_events_issue ON session_events(issue_id)",
		);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)",
		);

		// GEO-195: Event journal for lead runtime delivery tracking
		this.db.run(`
			CREATE TABLE IF NOT EXISTS lead_events (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				lead_id TEXT NOT NULL,
				event_id TEXT NOT NULL,
				event_type TEXT NOT NULL,
				payload TEXT NOT NULL,
				session_key TEXT,
				delivered_at TEXT,
				delivery_attempts INTEGER NOT NULL DEFAULT 0,
				last_delivery_error TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			)
		`);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_lead_events_recent ON lead_events(lead_id, delivered_at)",
		);
		this.db.run(
			"CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_events_dedup ON lead_events(lead_id, event_id)",
		);
		// FLY-25: migration for existing tables missing new columns
		this.migrateLeadEventsDeliveryColumns();
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
			if (
				err instanceof Error &&
				err.message.includes("UNIQUE constraint failed")
			) {
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
		if (
			existing &&
			TERMINAL_STATUSES.has(existing.status) &&
			session.status === "running"
		) {
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
				session_params, heartbeat_at, adapter_type, run_attempt,
				retry_predecessor, retry_successor, issue_labels,
				pr_number, session_stage, stage_updated_at, session_role
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
				run_attempt = COALESCE(excluded.run_attempt, run_attempt),
				retry_predecessor = COALESCE(excluded.retry_predecessor, retry_predecessor),
				retry_successor = COALESCE(excluded.retry_successor, retry_successor),
				issue_labels = COALESCE(excluded.issue_labels, issue_labels),
				pr_number = COALESCE(excluded.pr_number, pr_number),
				session_stage = COALESCE(excluded.session_stage, session_stage),
				stage_updated_at = COALESCE(excluded.stage_updated_at, stage_updated_at),
				session_role = COALESCE(excluded.session_role, session_role)
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
				session.retry_predecessor ?? null,
				session.retry_successor ?? null,
				session.issue_labels ?? null,
				session.pr_number ?? null,
				session.session_stage ?? null,
				session.stage_updated_at ?? null,
				session.session_role ?? null,
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
	persistTransition(
		executionId: string,
		status: string,
		fields: Partial<SessionUpsert>,
	): void {
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
				session_params, heartbeat_at, adapter_type, run_attempt,
				retry_predecessor, retry_successor, issue_labels,
				pr_number, session_stage, stage_updated_at, session_role
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
				run_attempt = COALESCE(excluded.run_attempt, run_attempt),
				retry_predecessor = COALESCE(excluded.retry_predecessor, retry_predecessor),
				retry_successor = COALESCE(excluded.retry_successor, retry_successor),
				issue_labels = COALESCE(excluded.issue_labels, issue_labels),
				pr_number = COALESCE(excluded.pr_number, pr_number),
				session_stage = COALESCE(excluded.session_stage, session_stage),
				stage_updated_at = COALESCE(excluded.stage_updated_at, stage_updated_at),
				session_role = COALESCE(excluded.session_role, session_role)
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
				fields.retry_predecessor ?? null,
				fields.retry_successor ?? null,
				fields.issue_labels ?? null,
				fields.pr_number ?? null,
				fields.session_stage ?? null,
				fields.stage_updated_at ?? null,
				fields.session_role ?? null,
			],
		);
		this.save();
	}

	/**
	 * Update non-status metadata fields only. Does NOT touch status.
	 * Used after applyTransition() for read-model enrichment (commit_count, lines_added, etc.)
	 * GEO-158: separates status writes (FSM) from metadata writes (event-route).
	 */
	patchSessionMetadata(
		executionId: string,
		fields: Partial<Omit<SessionUpsert, "status">>,
	): void {
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
			retry_predecessor: "retry_predecessor",
			retry_successor: "retry_successor",
			issue_labels: "issue_labels",
			pr_number: "pr_number",
			session_stage: "session_stage",
			stage_updated_at: "stage_updated_at",
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
	forceStatus(
		executionId: string,
		status: string,
		lastActivityAt: string,
		lastError?: string,
	): void {
		this.db.run(
			`UPDATE sessions SET status = ?, last_activity_at = ?, last_error = ? WHERE execution_id = ?`,
			[status, lastActivityAt, lastError ?? null, executionId],
		);
		this.save();
	}

	setRetrySuccessor(executionId: string, successorId: string): void {
		this.db.run(
			"UPDATE sessions SET retry_successor = ? WHERE execution_id = ?",
			[successorId, executionId],
		);
		this.save();
	}

	getSession(executionId: string): Session | undefined {
		const stmt = this.db.prepare(
			"SELECT * FROM sessions WHERE execution_id = ?",
		);
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
		const stmt = this.db.prepare(
			"SELECT * FROM sessions WHERE issue_id = ? ORDER BY last_activity_at DESC LIMIT 1",
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

	getActiveSessions(): Session[] {
		const stmt = this.db.prepare(
			"SELECT * FROM sessions WHERE status IN ('running', 'awaiting_review', 'approved_to_ship')",
		);
		const rows: Session[] = [];
		while (stmt.step()) {
			rows.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
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
			rows.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
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
			rows.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
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
			rows.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
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
		const stmt = this.db.prepare(
			"SELECT issue_id FROM conversation_threads WHERE thread_id = ? AND discord_missing_at IS NULL",
		);
		stmt.bind([threadId]);
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			stmt.free();
			return row.issue_id as string;
		}
		stmt.free();
		return undefined;
	}

	getThreadByIssue(
		issueId: string,
	): { thread_id: string; channel: string } | undefined {
		const stmt = this.db.prepare(
			"SELECT thread_id, channel FROM conversation_threads WHERE issue_id = ? AND discord_missing_at IS NULL",
		);
		stmt.bind([issueId]);
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			stmt.free();
			return {
				thread_id: row.thread_id as string,
				channel: row.channel as string,
			};
		}
		stmt.free();
		return undefined;
	}

	setSessionThreadId(executionId: string, threadId: string): void {
		this.db.run("UPDATE sessions SET thread_id = ? WHERE execution_id = ?", [
			threadId,
			executionId,
		]);
		this.save();
	}

	getLatestSessionByIssueAndStatuses(
		issueId: string,
		statuses: string[],
		excludeExecutionId?: string,
	): Session | undefined {
		if (statuses.length === 0) return undefined;
		const placeholders = statuses.map(() => "?").join(", ");
		const params: string[] = [issueId, ...statuses];
		let excludeClause = "";
		if (excludeExecutionId) {
			excludeClause = " AND execution_id != ?";
			params.push(excludeExecutionId);
		}
		const stmt = this.db.prepare(
			`SELECT * FROM sessions WHERE issue_id = ? AND status IN (${placeholders})${excludeClause} ORDER BY last_activity_at DESC LIMIT 1`,
		);
		stmt.bind(params);
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			stmt.free();
			return this.rowToSession(row);
		}
		stmt.free();
		return undefined;
	}

	/** GEO-259: Get all sessions for an issue matching given statuses, ordered by last_activity_at DESC. */
	getSessionsByIssueAndStatuses(
		issueId: string,
		statuses: string[],
	): Session[] {
		if (statuses.length === 0) return [];
		const placeholders = statuses.map(() => "?").join(", ");
		const results: Session[] = [];
		const stmt = this.db.prepare(
			`SELECT * FROM sessions WHERE issue_id = ? AND status IN (${placeholders}) ORDER BY last_activity_at DESC`,
		);
		stmt.bind([issueId, ...statuses]);
		while (stmt.step()) {
			results.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return results;
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
			rows.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
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
			rows.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
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
			rows.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return rows;
	}

	/** GEO-270: Get sessions in terminal state (completed/failed/blocked) with stale activity. */
	getStaleCompletedSessions(thresholdHours: number): Session[] {
		const stmt = this.db.prepare(
			"SELECT * FROM sessions WHERE status IN ('completed', 'failed', 'blocked') AND last_activity_at < datetime('now', ?)",
		);
		stmt.bind([`-${thresholdHours} hours`]);
		const rows: Session[] = [];
		while (stmt.step()) {
			rows.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return rows;
	}

	/** Retrieve parsed session_params for a given execution. */
	getSessionParams(executionId: string): Record<string, unknown> | undefined {
		const stmt = this.db.prepare(
			"SELECT session_params FROM sessions WHERE execution_id = ?",
		);
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

	/** Retrieve parsed issue_labels for a given execution (GEO-152). */
	getSessionLabels(executionId: string): string[] {
		const session = this.getSession(executionId);
		if (!session?.issue_labels) return [];
		try {
			return JSON.parse(session.issue_labels) as string[];
		} catch {
			// Fallback: comma-separated
			return session.issue_labels
				.split(",")
				.map((l) => l.trim())
				.filter(Boolean);
		}
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
	getLatestSessionParams(
		issueId: string,
	):
		| { sessionParams: Record<string, unknown>; runAttempt: number }
		| undefined {
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

	getEligibleForCleanup(thresholdMinutes: number): CleanupCandidate[] {
		const stmt = this.db.prepare(`
			SELECT ct.thread_id, ct.issue_id, latest.status, latest.last_activity_at, ct.cleanup_notified_at
			FROM conversation_threads ct
			INNER JOIN (
				SELECT issue_id, status, last_activity_at,
					ROW_NUMBER() OVER (PARTITION BY issue_id ORDER BY last_activity_at DESC, started_at DESC, execution_id DESC) AS rn
				FROM sessions
			) latest ON latest.issue_id = ct.issue_id AND latest.rn = 1
			WHERE latest.status IN ('completed', 'approved', 'approved_to_ship')
				AND latest.last_activity_at < datetime('now', '-' || ? || ' minutes')
				AND ct.thread_id IS NOT NULL AND ct.archived_at IS NULL AND ct.discord_missing_at IS NULL
			ORDER BY latest.last_activity_at ASC
		`);
		stmt.bind([thresholdMinutes]);
		const rows: CleanupCandidate[] = [];
		while (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			rows.push({
				thread_id: row.thread_id as string,
				issue_id: row.issue_id as string,
				status: row.status as string,
				last_activity_at: row.last_activity_at as string,
				cleanup_notified_at: (row.cleanup_notified_at as string) ?? null,
			});
		}
		stmt.free();
		return rows;
	}
	markArchived(threadId: string): void {
		this.db.run(
			"UPDATE conversation_threads SET archived_at = datetime('now') WHERE thread_id = ?",
			[threadId],
		);
		this.save();
	}
	markCleanupNotified(threadId: string): void {
		this.db.run(
			"UPDATE conversation_threads SET cleanup_notified_at = datetime('now') WHERE thread_id = ?",
			[threadId],
		);
		this.save();
	}
	clearArchived(threadId: string): void {
		this.db.run(
			"UPDATE conversation_threads SET archived_at = NULL, cleanup_notified_at = NULL WHERE thread_id = ?",
			[threadId],
		);
		this.save();
	}

	/** GEO-200: Mark thread as no longer existing in Discord + clear all session references. */
	markDiscordMissing(threadId: string): void {
		this.db.run(
			"UPDATE conversation_threads SET discord_missing_at = datetime('now') WHERE thread_id = ?",
			[threadId],
		);
		// Clear stale session references
		this.db.run("UPDATE sessions SET thread_id = NULL WHERE thread_id = ?", [
			threadId,
		]);
		this.save();
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
			retry_predecessor: (row.retry_predecessor as string) ?? undefined,
			retry_successor: (row.retry_successor as string) ?? undefined,
			issue_labels: (row.issue_labels as string) ?? undefined,
			pr_number: (row.pr_number as number) ?? undefined,
			session_stage: (row.session_stage as string) ?? undefined,
			stage_updated_at: (row.stage_updated_at as string) ?? undefined,
			session_role: (row.session_role as string) ?? undefined,
		};
	}

	// --- GEO-195: Lead Event Journal ---

	/** Append a lead event. Returns seq. Dedup on (lead_id, event_id). */
	appendLeadEvent(
		leadId: string,
		eventId: string,
		eventType: string,
		payload: string,
		sessionKey?: string,
	): number {
		try {
			this.db.run(
				`INSERT INTO lead_events (lead_id, event_id, event_type, payload, session_key)
				 VALUES (?, ?, ?, ?, ?)`,
				[leadId, eventId, eventType, payload, sessionKey ?? null],
			);
		} catch (err) {
			// UNIQUE constraint → duplicate
			if ((err as Error).message?.includes("UNIQUE")) {
				const existing = this.db.exec(
					"SELECT seq FROM lead_events WHERE lead_id = ? AND event_id = ?",
					[leadId, eventId],
				);
				return (existing[0]?.values[0]?.[0] as number) ?? 0;
			}
			throw err;
		}
		const result = this.db.exec("SELECT last_insert_rowid()");
		return (result[0]?.values[0]?.[0] as number) ?? 0;
	}

	/** Mark a lead event as delivered. */
	markLeadEventDelivered(seq: number): void {
		this.db.run(
			"UPDATE lead_events SET delivered_at = datetime('now') WHERE seq = ?",
			[seq],
		);
	}

	/** Get recently delivered events within a time window (for bootstrap). */
	getRecentDeliveredEvents(
		leadId: string,
		windowMinutes: number,
	): LeadEventRow[] {
		const result = this.db.exec(
			`SELECT seq, lead_id, event_id, event_type, payload, session_key, delivered_at, created_at
			 FROM lead_events
			 WHERE lead_id = ? AND delivered_at IS NOT NULL
			   AND delivered_at > datetime('now', ?)
			 ORDER BY seq ASC`,
			[leadId, `-${windowMinutes} minutes`],
		);
		if (result.length === 0) return [];
		return result[0]!.values.map((row) => ({
			seq: row[0] as number,
			lead_id: row[1] as string,
			event_id: row[2] as string,
			event_type: row[3] as string,
			payload: row[4] as string,
			session_key: (row[5] as string) ?? undefined,
			delivered_at: (row[6] as string) ?? undefined,
			created_at: row[7] as string,
		}));
	}

	/** Get the highest delivered seq for a lead (for health checks). */
	getLastDeliveredSeq(leadId: string): number {
		const result = this.db.exec(
			`SELECT MAX(seq) FROM lead_events WHERE lead_id = ? AND delivered_at IS NOT NULL`,
			[leadId],
		);
		return (result[0]?.values[0]?.[0] as number) ?? 0;
	}

	/** FLY-62: Check if a lead event has been successfully delivered. */
	isLeadEventDelivered(leadId: string, eventId: string): boolean {
		const rows = this.db.exec(
			`SELECT 1 FROM lead_events
			 WHERE lead_id = ? AND event_id = ? AND delivered_at IS NOT NULL
			 LIMIT 1`,
			[leadId, eventId],
		);
		return rows.length > 0 && (rows[0]?.values?.length ?? 0) > 0;
	}

	// --- FLY-25: Delivery tracking ---

	/** Record a delivery failure: increment attempts, store error. */
	recordDeliveryFailure(seq: number, error: string): void {
		this.db.run(
			`UPDATE lead_events SET delivery_attempts = delivery_attempts + 1, last_delivery_error = ? WHERE seq = ?`,
			[error, seq],
		);
	}

	/** Get undelivered guardrail events (stuck/orphan/stale) under max attempts. */
	getUndeliveredGuardrailEvents(
		leadId: string,
		eventTypes: string[],
		maxAttempts: number,
	): LeadEventRow[] {
		if (eventTypes.length === 0) return [];
		const placeholders = eventTypes.map(() => "?").join(",");
		const result = this.db.exec(
			`SELECT seq, lead_id, event_id, event_type, payload, session_key, delivered_at, created_at, delivery_attempts, last_delivery_error
			 FROM lead_events
			 WHERE lead_id = ? AND delivered_at IS NULL
			   AND event_type IN (${placeholders})
			   AND delivery_attempts < ?
			 ORDER BY seq ASC`,
			[leadId, ...eventTypes, maxAttempts],
		);
		if (result.length === 0) return [];
		return result[0]!.values.map((row) => ({
			seq: row[0] as number,
			lead_id: row[1] as string,
			event_id: row[2] as string,
			event_type: row[3] as string,
			payload: row[4] as string,
			session_key: (row[5] as string) ?? undefined,
			delivered_at: (row[6] as string) ?? undefined,
			created_at: row[7] as string,
			delivery_attempts: (row[8] as number) ?? 0,
			last_delivery_error: (row[9] as string) ?? undefined,
		}));
	}

	/** Get delivery stats for dashboard. */
	getDeliveryStats(leadId?: string): {
		pending_count: number;
		total_delivered: number;
		total_failed: number;
		last_failure_error: string | null;
		last_failure_at: string | null;
	} {
		const whereClause = leadId ? "WHERE lead_id = ?" : "";
		const params = leadId ? [leadId] : [];

		const pendingResult = this.db.exec(
			`SELECT COUNT(*) FROM lead_events ${whereClause ? `${whereClause} AND` : "WHERE"} delivered_at IS NULL AND delivery_attempts > 0 AND delivery_attempts < 3`,
			params,
		);
		const pending_count = (pendingResult[0]?.values[0]?.[0] as number) ?? 0;

		const deliveredResult = this.db.exec(
			`SELECT COUNT(*) FROM lead_events ${whereClause ? `${whereClause} AND` : "WHERE"} delivered_at IS NOT NULL`,
			params,
		);
		const total_delivered = (deliveredResult[0]?.values[0]?.[0] as number) ?? 0;

		const failedResult = this.db.exec(
			`SELECT COUNT(*) FROM lead_events ${whereClause ? `${whereClause} AND` : "WHERE"} delivered_at IS NULL AND delivery_attempts >= 3`,
			params,
		);
		const total_failed = (failedResult[0]?.values[0]?.[0] as number) ?? 0;

		const lastFailureResult = this.db.exec(
			`SELECT last_delivery_error, created_at FROM lead_events ${whereClause ? `${whereClause} AND` : "WHERE"} last_delivery_error IS NOT NULL ORDER BY seq DESC LIMIT 1`,
			params,
		);
		const last_failure_error =
			(lastFailureResult[0]?.values[0]?.[0] as string) ?? null;
		const last_failure_at =
			(lastFailureResult[0]?.values[0]?.[1] as string) ?? null;

		return {
			pending_count,
			total_delivered,
			total_failed,
			last_failure_error,
			last_failure_at,
		};
	}

	/** FLY-25: Migration for existing DBs that lack delivery_attempts/last_delivery_error columns. */
	private migrateLeadEventsDeliveryColumns(): void {
		try {
			const info = this.db.exec("PRAGMA table_info(lead_events)");
			if (info.length === 0) return;
			const columns = info[0]!.values.map((row) => row[1] as string);
			if (!columns.includes("delivery_attempts")) {
				this.db.run(
					"ALTER TABLE lead_events ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0",
				);
			}
			if (!columns.includes("last_delivery_error")) {
				this.db.run(
					"ALTER TABLE lead_events ADD COLUMN last_delivery_error TEXT",
				);
			}
		} catch {
			// Table may not exist yet (first run) — CREATE TABLE will handle it
		}
	}
}

export interface LeadEventRow {
	seq: number;
	lead_id: string;
	event_id: string;
	event_type: string;
	payload: string;
	session_key?: string;
	delivered_at?: string;
	created_at: string;
	delivery_attempts?: number;
	last_delivery_error?: string;
}
