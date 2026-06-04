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

/**
 * FLY-195 (plan §3.4): Lead disposition receipt for one stuck episode.
 *
 * `handled_remanaged` is written IMPLICITLY by the Bridge recovery-nudge
 * endpoint on a successful nudge; the other values are written EXPLICITLY by
 * the Lead via `POST /api/sessions/:executionId/stuck-disposition`.
 */
export const STUCK_DISPOSITIONS = [
	"handled_remanaged",
	"false_positive",
	"legitimate_wait",
	"snooze",
	"needs_founder",
] as const;
export type StuckDisposition = (typeof STUCK_DISPOSITIONS)[number];

/** Disposition values a Lead may write explicitly (handled_remanaged is implicit-only). */
export const EXPLICIT_STUCK_DISPOSITIONS: readonly StuckDisposition[] = [
	"false_positive",
	"legitimate_wait",
	"snooze",
	"needs_founder",
];

export interface StuckDispositionRow {
	execution_id: string;
	episode_fingerprint: string;
	disposition: StuckDisposition;
	/** Epoch ms until which a `snooze` disposition suppresses; null otherwise. */
	snooze_until_ms: number | null;
	noted_by: string | null;
	note: string | null;
	created_at: string;
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
	session_params?: string;
	heartbeat_at?: string;
	adapter_type?: string;
	run_attempt?: number;
	retry_predecessor?: string;
	retry_successor?: string;
	issue_labels?: string;
	pr_number?: number;
	/** FLY-175: PR head SHA when known — cache-key salt for approve consent. */
	pr_head_sha?: string;
	session_stage?: string;
	stage_updated_at?: string;
	/** FLY-59: Session role for multi-session-per-issue */
	session_role?: string;
	/** FLY-137 Phase 5: agent dispatch (Lead override or label match) */
	agent_name?: string;
	/** FLY-137 Phase 5: how the agent was selected — "override" | "label" | "generic" */
	agent_match_method?: string;
	/** FLY-137 Phase 5: design_review plan path (set via `stage set design_review --plan ...`) */
	plan_path?: string;
	/** FLY-137 Phase 5: codex-skip label snapshotted at run start (0|1) */
	codex_skip?: number;
	/**
	 * FLY-191 Phase 2: when the session ENTERED awaiting_review (deadline
	 * anchor for the Bridge-side 48h review timeout). Set only on entry —
	 * NEVER drifted by later activity/approval attempts (Codex R1 MEDIUM-6);
	 * a re-review request (changes_requested → new needs_review) re-enters
	 * the state and resets it.
	 */
	awaiting_review_entered_at?: string;
	/** FLY-191 Phase 2: dedup stamp — when gate_timed_out was last notified for the CURRENT awaiting_review entry. */
	gate_timeout_notified_at?: string;
	/**
	 * FLY-191 Phase 2 (Codex PR R1 CRITICAL): the CommDB question id of the
	 * CURRENT review request. verify-approval honors a response ONLY on this
	 * exact question; Surface B rejects answers to any other approve_to_ship
	 * question. Set (with pr_head_sha) by `setReviewBinding` on every
	 * needs_review completion; a re-review overwrites it, instantly
	 * invalidating approvals on earlier questions — no timestamp-tie games.
	 */
	review_question_id?: string;
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
	session_params?: string;
	heartbeat_at?: string;
	adapter_type?: string;
	run_attempt?: number;
	retry_predecessor?: string;
	retry_successor?: string;
	issue_labels?: string;
	pr_number?: number;
	/** FLY-175: PR head SHA when known — cache-key salt for approve consent. */
	pr_head_sha?: string;
	session_stage?: string;
	stage_updated_at?: string;
	/** FLY-59: Session role for multi-session-per-issue */
	session_role?: string;
	/** FLY-137 Phase 5: agent dispatch (Lead override or label match) */
	agent_name?: string;
	/** FLY-137 Phase 5: how the agent was selected — "override" | "label" | "generic" */
	agent_match_method?: string;
	/** FLY-137 Phase 5: design_review plan path (set via `stage set design_review --plan ...`) */
	plan_path?: string;
	/** FLY-137 Phase 5: codex-skip label snapshotted at run start (boolean) */
	codex_skip?: boolean;
	/** FLY-191 Phase 2: when the session ENTERED awaiting_review (timeout deadline anchor). */
	awaiting_review_entered_at?: string;
	/** FLY-191 Phase 2: gate_timed_out dedup stamp for the current awaiting_review entry. */
	gate_timeout_notified_at?: string;
	/** FLY-191 Phase 2: CommDB question id of the CURRENT review request (verify-approval binding). */
	review_question_id?: string;
}

// FLY-163: CleanupCandidate removed (CleanupService gone).

/**
 * FLY-191 Phase 2 (Codex R2 HIGH-1): sentinel stored in
 * `sessions.review_question_id` when a Phase-2 needs_review completion
 * carried no usable questionId. Distinguishes "binding required but missing"
 * (approval REFUSED — fail-closed) from NULL = "pre-Phase-2 legacy session"
 * (legacy approve fallback allowed). Mirrored in
 * flywheel-comm/src/commands/verify-approval.ts — keep the values in sync.
 */
export const REVIEW_BINDING_UNBOUND = "unbound";

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

		// FLY-163: forum `conversation_threads` table dropped. Per-issue chat
		// threads live in `chat_threads` (FLY-91). The `sessions.thread_id`
		// physical column is kept for backward compat (deprecated; no TS surface
		// reads/writes it) and will be removed in a follow-up via table-rename.
		this.db.run("DROP TABLE IF EXISTS conversation_threads");

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

		// Cutover: clear stale Slack thread mappings (one-time, guarded by user_version)
		const versionResult = this.db.exec("PRAGMA user_version");
		const currentVersion = (versionResult[0]?.values[0]?.[0] as number) ?? 0;
		if (currentVersion < 2) {
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

		// FLY-163: GEO-169 / GEO-200 conversation_threads ALTERs removed (table dropped).

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

		// FLY-175: PR head SHA for founder-consent approve cache-key salt.
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN pr_head_sha TEXT");
		} catch {
			/* exists */
		}

		// FLY-137 Phase 5: agent dispatch + Codex auto-trigger persistence.
		// All four columns are NULL-able / defaulted so existing rows are
		// backward-compatible with no migration data step required.
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN agent_name TEXT");
		} catch {
			/* exists */
		}
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN agent_match_method TEXT");
		} catch {
			/* exists */
		}
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN plan_path TEXT");
		} catch {
			/* exists */
		}
		try {
			this.db.run(
				"ALTER TABLE sessions ADD COLUMN codex_skip INTEGER NOT NULL DEFAULT 0",
			);
		} catch {
			/* exists */
		}

		// FLY-191 Phase 2: persisted awaiting_review entry timestamp (Bridge-side
		// 48h review-timeout anchor; must survive Bridge restarts — NOT the
		// mutable last_activity_at) + gate_timed_out dedup stamp + the CURRENT
		// review question binding (Codex PR R1 CRITICAL).
		try {
			this.db.run(
				"ALTER TABLE sessions ADD COLUMN awaiting_review_entered_at TEXT",
			);
		} catch {
			/* exists */
		}
		try {
			this.db.run(
				"ALTER TABLE sessions ADD COLUMN gate_timeout_notified_at TEXT",
			);
		} catch {
			/* exists */
		}
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN review_question_id TEXT");
		} catch {
			/* exists */
		}

		// FLY-163: drop legacy conversation_threads index (table is gone).
		this.db.run("DROP INDEX IF EXISTS idx_threads_issue");

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
		// FLY-91: Chat threads for per-issue conversation in chatChannel
		this.db.run(`
			CREATE TABLE IF NOT EXISTS chat_threads (
				thread_id TEXT PRIMARY KEY,
				channel_id TEXT NOT NULL,
				issue_id TEXT,
				lead_id TEXT,
				created_at TEXT DEFAULT (datetime('now')),
				discord_missing_at TEXT
			)
		`);
		this.db.run(
			"CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_threads_issue_channel ON chat_threads(issue_id, channel_id)",
		);

		// FLY-195: Lead disposition receipts for stuck-runner episodes (plan §3.4).
		// One row per (execution, episode fingerprint). The Lead's judgment is
		// AUTHORITATIVE: the Bridge fallback (runner_stuck_unhandled Annie alert)
		// suppresses on any row here, and the detector consults it to avoid
		// re-paging the Lead for an already-judged episode after a Bridge restart.
		this.db.run(`
			CREATE TABLE IF NOT EXISTS stuck_dispositions (
				execution_id TEXT NOT NULL,
				episode_fingerprint TEXT NOT NULL,
				disposition TEXT NOT NULL,
				snooze_until_ms INTEGER,
				noted_by TEXT,
				note TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				PRIMARY KEY (execution_id, episode_fingerprint)
			)
		`);

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

		// FLY-191 Phase 2: stamp awaiting_review entry on this legacy write
		// path too (same semantics as persistTransition).
		const enteringAwaitingReview =
			session.status === "awaiting_review" &&
			existing?.status !== "awaiting_review";

		this.db.run(
			`INSERT INTO sessions (
				execution_id, issue_id, project_name, status,
				issue_identifier, issue_title,
				started_at, last_activity_at,
				tmux_session, worktree_path, branch,
				last_error, decision_route, decision_reasoning,
				cost_usd, commit_count, files_changed, lines_added, lines_removed,
				summary, diff_summary, commit_messages, changed_file_paths,
				session_params, heartbeat_at, adapter_type, run_attempt,
				retry_predecessor, retry_successor, issue_labels,
				pr_number, session_stage, stage_updated_at, session_role
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
		if (enteringAwaitingReview) {
			this.stampAwaitingReviewEntry(session.execution_id);
		}
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
		// FLY-191 Phase 2: detect entry into awaiting_review BEFORE the upsert
		// (needs the pre-write status). Stamped after the write succeeds.
		const enteringAwaitingReview = this.isEnteringAwaitingReview(
			executionId,
			status,
		);
		this.db.run(
			`INSERT INTO sessions (
				execution_id, issue_id, project_name, status,
				issue_identifier, issue_title,
				started_at, last_activity_at,
				tmux_session, worktree_path, branch,
				last_error, decision_route, decision_reasoning,
				cost_usd, commit_count, files_changed, lines_added, lines_removed,
				summary, diff_summary, commit_messages, changed_file_paths,
				session_params, heartbeat_at, adapter_type, run_attempt,
				retry_predecessor, retry_successor, issue_labels,
				pr_number, session_stage, stage_updated_at, session_role
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
		if (enteringAwaitingReview) {
			this.stampAwaitingReviewEntry(executionId);
		}
		this.save();
	}

	/**
	 * FLY-191 Phase 2: true when this write moves the session INTO
	 * awaiting_review from a different (or no) prior status. A same-status
	 * re-upsert must NOT count — that would drift the review deadline
	 * (Codex R1 MEDIUM-6: approval attempts / feedback / keepalives must not
	 * extend the 48h window). A genuine re-entry (changes_requested →
	 * re-request review) DOES count and resets the deadline by design.
	 */
	private isEnteringAwaitingReview(
		executionId: string,
		newStatus: string,
	): boolean {
		if (newStatus !== "awaiting_review") return false;
		return this.getSession(executionId)?.status !== "awaiting_review";
	}

	/**
	 * Stamp the awaiting_review entry time + clear the gate_timed_out dedup
	 * stamp (a fresh entry opens a fresh review window — a new timeout
	 * notification is allowed for it).
	 */
	private stampAwaitingReviewEntry(executionId: string): void {
		this.db.run(
			`UPDATE sessions SET
				awaiting_review_entered_at = datetime('now'),
				gate_timeout_notified_at = NULL
			 WHERE execution_id = ?`,
			[executionId],
		);
	}

	/**
	 * FLY-191 Phase 2: explicit review-window reset for a RE-REQUEST while the
	 * session is already awaiting_review (changes_requested → runner re-posts
	 * for review → fresh `needs_review` completion). The FSM has no
	 * awaiting_review self-loop, so the event sinks call this instead of
	 * applyTransition for that case. Event-id idempotency upstream guards
	 * against replays re-stamping.
	 */
	resetAwaitingReviewWindow(executionId: string): void {
		this.stampAwaitingReviewEntry(executionId);
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
			// FLY-137 Phase 5: agent dispatch + Codex auto-trigger persistence
			agent_name: "agent_name",
			agent_match_method: "agent_match_method",
			plan_path: "plan_path",
			codex_skip: "codex_skip",
			// FLY-191 Phase 2: PR head binding for verify-approval (§5.5.2)
			pr_head_sha: "pr_head_sha",
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
		// FLY-191 Phase 2: same entry-stamp semantics as persistTransition.
		const enteringAwaitingReview = this.isEnteringAwaitingReview(
			executionId,
			status,
		);
		this.db.run(
			`UPDATE sessions SET status = ?, last_activity_at = ?, last_error = ? WHERE execution_id = ?`,
			[status, lastActivityAt, lastError ?? null, executionId],
		);
		if (enteringAwaitingReview) {
			this.stampAwaitingReviewEntry(executionId);
		}
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

	/**
	 * FLY-191 Phase 2: awaiting_review sessions whose review window has
	 * expired and that have NOT yet been notified for the current entry.
	 * Anchored on the persisted `awaiting_review_entered_at` (survives Bridge
	 * restarts; never drifted by activity). `gate_timeout_notified_at` is
	 * cleared on every fresh entry (stampAwaitingReviewEntry), so a plain
	 * IS NULL check dedups exactly once per review window. Rows with a NULL
	 * entry timestamp (pre-migration legacy) are excluded — no anchor means
	 * no deadline claim (fail-quiet, they age out via existing patrols).
	 */
	getAwaitingReviewTimedOut(thresholdHours: number): Session[] {
		const stmt = this.db.prepare(
			`SELECT * FROM sessions
			 WHERE status = 'awaiting_review'
			   AND awaiting_review_entered_at IS NOT NULL
			   AND awaiting_review_entered_at < datetime('now', ?)
			   AND gate_timeout_notified_at IS NULL`,
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

	/** FLY-191 Phase 2: dedup stamp — gate_timed_out notified for the current awaiting_review entry. */
	markGateTimeoutNotified(executionId: string): void {
		this.db.run(
			"UPDATE sessions SET gate_timeout_notified_at = datetime('now') WHERE execution_id = ?",
			[executionId],
		);
		this.save();
	}

	/**
	 * FLY-191 Phase 2 (Codex PR R1 CRITICAL + HIGH-2; R2 HIGH-1): bind the
	 * session to its CURRENT review request. Called on EVERY needs_review
	 * completion arriving via the HTTP /events path with whatever the event
	 * carried — NEVER retaining a previous review's binding (a stale
	 * questionId/pr_head_sha surviving a re-review is exactly the §5.5
	 * fail-closed contract violation).
	 *
	 * Tri-state `review_question_id` (Codex R2 HIGH-1):
	 *   - real id  → Phase-2 review, approvable only on that exact question;
	 *   - 'unbound' (REVIEW_BINDING_UNBOUND) → a Phase-2 completion arrived
	 *     WITHOUT a usable questionId. Approval paths REFUSE (the runner
	 *     can never verify-approval) — the runner must re-request review
	 *     with `--question-id`. Without this sentinel, a binding-less
	 *     Phase-2 session would fall into the legacy branch below and get
	 *     stranded in approved_to_ship.
	 *   - NULL → true pre-Phase-2 legacy session (this method never ran):
	 *     legacy blocking-gate approve fallback stays byte-compatible.
	 */
	setReviewBinding(
		executionId: string,
		binding: { questionId: string | null; prHeadSha: string | null },
	): void {
		this.db.run(
			"UPDATE sessions SET review_question_id = ?, pr_head_sha = ? WHERE execution_id = ?",
			[
				binding.questionId ?? REVIEW_BINDING_UNBOUND,
				binding.prHeadSha,
				executionId,
			],
		);
		this.save();
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

	/**
	 * FLY-102 Round 1 (Codex post-Round 4): Lookup all sessions for an identifier
	 * whose status is in the caller-supplied set. Used by `close_runner` MCP tool
	 * to avoid the unstable `ORDER BY last_activity_at DESC LIMIT 1` fallback,
	 * which under retries/parallel runs can pick the wrong execution.
	 */
	getSessionsByIdentifierAndStatuses(
		identifier: string,
		statuses: readonly string[],
	): Session[] {
		if (statuses.length === 0) return [];
		const placeholders = statuses.map(() => "?").join(",");
		const stmt = this.db.prepare(
			`SELECT * FROM sessions WHERE issue_identifier = ? AND status IN (${placeholders}) ORDER BY last_activity_at DESC`,
		);
		stmt.bind([identifier, ...statuses]);
		const rows: Session[] = [];
		while (stmt.step()) {
			rows.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return rows;
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

	// FLY-163: upsertThread / getThreadIssue / getThreadByIssue /
	// setSessionThreadId removed — conversation_threads table dropped.

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

	// FLY-163: forum thread cleanup methods (getEligibleForCleanup, markArchived,
	// markCleanupNotified, clearArchived, markDiscordMissing) removed — forum
	// channel concept gone.

	// --- FLY-91: Chat thread CRUD (per-issue threads in chatChannel) ---

	/** Delete-first upsert (same pattern as upsertThread for Forum). */
	upsertChatThread(
		threadId: string,
		channelId: string,
		issueId: string,
		leadId?: string,
	): void {
		this.db.run(
			"DELETE FROM chat_threads WHERE issue_id = ? AND channel_id = ? AND thread_id != ?",
			[issueId, channelId, threadId],
		);
		this.db.run(
			`INSERT INTO chat_threads (thread_id, channel_id, issue_id, lead_id)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(thread_id) DO UPDATE SET
				channel_id = excluded.channel_id,
				issue_id = excluded.issue_id,
				lead_id = excluded.lead_id`,
			[threadId, channelId, issueId, leadId ?? null],
		);
		this.save();
	}

	getChatThreadByIssue(
		issueId: string,
		channelId: string,
	): { thread_id: string; channel_id: string } | undefined {
		const stmt = this.db.prepare(
			"SELECT thread_id, channel_id FROM chat_threads WHERE issue_id = ? AND channel_id = ? AND discord_missing_at IS NULL",
		);
		stmt.bind([issueId, channelId]);
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			stmt.free();
			return {
				thread_id: row.thread_id as string,
				channel_id: row.channel_id as string,
			};
		}
		stmt.free();
		return undefined;
	}

	/** FLY-91 Round 2: Reverse lookup by thread_id for conflict detection. */
	getChatThreadByThreadId(
		threadId: string,
	): { thread_id: string; channel_id: string; issue_id: string } | undefined {
		const stmt = this.db.prepare(
			"SELECT thread_id, channel_id, issue_id FROM chat_threads WHERE thread_id = ? AND discord_missing_at IS NULL",
		);
		stmt.bind([threadId]);
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			stmt.free();
			return {
				thread_id: row.thread_id as string,
				channel_id: row.channel_id as string,
				issue_id: row.issue_id as string,
			};
		}
		stmt.free();
		return undefined;
	}

	markChatThreadMissing(threadId: string): void {
		this.db.run(
			"UPDATE chat_threads SET discord_missing_at = datetime('now') WHERE thread_id = ?",
			[threadId],
		);
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
			session_params: (row.session_params as string) ?? undefined,
			heartbeat_at: (row.heartbeat_at as string) ?? undefined,
			adapter_type: (row.adapter_type as string) ?? undefined,
			run_attempt: (row.run_attempt as number) ?? undefined,
			retry_predecessor: (row.retry_predecessor as string) ?? undefined,
			retry_successor: (row.retry_successor as string) ?? undefined,
			issue_labels: (row.issue_labels as string) ?? undefined,
			pr_number: (row.pr_number as number) ?? undefined,
			pr_head_sha: (row.pr_head_sha as string) ?? undefined,
			session_stage: (row.session_stage as string) ?? undefined,
			stage_updated_at: (row.stage_updated_at as string) ?? undefined,
			session_role: (row.session_role as string) ?? undefined,
			// FLY-137 Phase 5: agent dispatch + Codex auto-trigger persistence
			agent_name: (row.agent_name as string) ?? undefined,
			agent_match_method: (row.agent_match_method as string) ?? undefined,
			plan_path: (row.plan_path as string) ?? undefined,
			codex_skip: row.codex_skip ? !!(row.codex_skip as number) : undefined,
			// FLY-191 Phase 2: review-timeout anchor + dedup stamp + review binding
			awaiting_review_entered_at:
				(row.awaiting_review_entered_at as string) ?? undefined,
			gate_timeout_notified_at:
				(row.gate_timeout_notified_at as string) ?? undefined,
			review_question_id: (row.review_question_id as string) ?? undefined,
		};
	}

	/**
	 * FLY-175: minimal session shape the founder-consent evaluator needs.
	 * Avoids the middleware reaching into the full Session row + parses the
	 * label snapshot into a string array. Returns undefined if no session.
	 */
	getSessionForConsentLookup(executionId: string):
		| {
				issue_id: string;
				issue_identifier?: string;
				project_name: string;
				session_role?: string;
				session_status: string;
				issue_labels: string[];
				pr_number?: number;
				pr_head_sha?: string;
		  }
		| undefined {
		const s = this.getSession(executionId);
		if (!s) return undefined;
		let labels: string[] = [];
		if (s.issue_labels) {
			try {
				const parsed = JSON.parse(s.issue_labels);
				if (Array.isArray(parsed)) labels = parsed.map((x) => String(x));
			} catch {
				/* malformed snapshot — treat as no labels */
			}
		}
		return {
			issue_id: s.issue_id,
			issue_identifier: s.issue_identifier,
			project_name: s.project_name,
			session_role: s.session_role,
			session_status: s.status,
			issue_labels: labels,
			pr_number: s.pr_number,
			pr_head_sha: s.pr_head_sha,
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

	/**
	 * FLY-83: attempt to claim a (leadId, eventId) slot.
	 * Returns true if this caller wrote the row, false if it already existed.
	 *
	 * Uses a SELECT COUNT(*) pre-check + appendLeadEvent. Not atomic in the
	 * SQL sense, but sql.js is single-threaded inside the Bridge process, so
	 * no two JS callers interleave. Cross-process races (shell alert script
	 * vs Bridge) live in a separate `claims.db` (see scripts/lead-alert.sh),
	 * not in lead_events.
	 *
	 * `appendLeadEvent` alone cannot answer this question: on UNIQUE conflict
	 * it returns the existing seq (still non-zero), so a "got a seq back"
	 * return is indistinguishable from a fresh insert.
	 */
	tryClaimLeadEvent(
		leadId: string,
		eventId: string,
		eventType: string,
		payload: string,
		sessionKey?: string,
	): boolean {
		const existing = this.dbQuery(
			"SELECT COUNT(*) FROM lead_events WHERE lead_id = ? AND event_id = ?",
			[leadId, eventId],
		);
		const count = (existing[0]?.values[0]?.[0] as number) ?? 0;
		if (count > 0) return false;
		this.appendLeadEvent(leadId, eventId, eventType, payload, sessionKey);
		return true;
	}

	private dbQuery(
		sql: string,
		params: (string | number | null)[],
	): { values: unknown[][] }[] {
		return this.db.exec(sql, params) as { values: unknown[][] }[];
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

	// --- FLY-195: stuck-episode disposition receipts (plan §3.4) ---

	/**
	 * Upsert the Lead's disposition for one stuck episode. Last write wins
	 * (e.g. snooze → false_positive refinement). Persisted immediately —
	 * the Q7 fallback does a durable re-read right before paging Annie
	 * (Codex design R2 LOW-R2-2).
	 */
	setStuckDisposition(input: {
		execution_id: string;
		episode_fingerprint: string;
		disposition: StuckDisposition;
		snooze_until_ms?: number | null;
		noted_by?: string | null;
		note?: string | null;
	}): void {
		if (!STUCK_DISPOSITIONS.includes(input.disposition)) {
			throw new Error(`Invalid stuck disposition: ${input.disposition}`);
		}
		this.db.run(
			`INSERT INTO stuck_dispositions
			   (execution_id, episode_fingerprint, disposition, snooze_until_ms, noted_by, note)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(execution_id, episode_fingerprint) DO UPDATE SET
			   disposition = excluded.disposition,
			   snooze_until_ms = excluded.snooze_until_ms,
			   noted_by = excluded.noted_by,
			   note = excluded.note,
			   created_at = datetime('now')`,
			[
				input.execution_id,
				input.episode_fingerprint,
				input.disposition,
				input.snooze_until_ms ?? null,
				input.noted_by ?? null,
				input.note ?? null,
			],
		);
		this.save();
	}

	/** Read the disposition receipt for one stuck episode (undefined = none). */
	getStuckDisposition(
		executionId: string,
		episodeFingerprint: string,
	): StuckDispositionRow | undefined {
		const result = this.db.exec(
			`SELECT execution_id, episode_fingerprint, disposition, snooze_until_ms,
			        noted_by, note, created_at
			 FROM stuck_dispositions
			 WHERE execution_id = ? AND episode_fingerprint = ?`,
			[executionId, episodeFingerprint],
		);
		const row = result[0]?.values[0];
		if (!row) return undefined;
		return {
			execution_id: row[0] as string,
			episode_fingerprint: row[1] as string,
			disposition: row[2] as StuckDisposition,
			snooze_until_ms: (row[3] as number | null) ?? null,
			noted_by: (row[4] as string | null) ?? null,
			note: (row[5] as string | null) ?? null,
			created_at: row[6] as string,
		};
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
