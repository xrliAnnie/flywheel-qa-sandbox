import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import BetterSqlite3, { type Database as BetterDb } from "better-sqlite3";
import type { LeadNudgeRow } from "./bridge/lead-pending-escalation.js";

/**
 * FLY-663: a thin compatibility shim that exposes the exact sql.js surface
 * StateStore used (`run` / `prepare`+`bind`/`step`/`getAsObject`/`free` /
 * `exec` / `getRowsModified` / `close`) on top of a native `better-sqlite3`
 * connection. Centralizing the 1:1 mapping here keeps the ~67 query call sites
 * byte-identical (minimal diff, single well-tested seam) while removing the
 * sql.js WASM engine entirely.
 *
 * Why the migration (FLY-663 root-fix, not FLY-639's band-aid): the old
 * `StateStore.save()` called `sql.js` `db.export()` on EVERY write — that closes
 * + reopens the SQLite connection and re-serializes the WHOLE DB into a fresh
 * contiguous buffer in the 2GB-capped, fragmentation-prone WASM linear heap
 * (independent of system RAM). Under a dozen runners' high-frequency writes the
 * WASM heap fragments/exhausts → the SQLite WASM instance corrupts → the
 * production `null function or function signature mismatch` → `no such table`
 * signatures. better-sqlite3 is native SQLite: no WASM heap to exhaust/corrupt,
 * incremental WAL writes (no full-DB export per write), so corruption is
 * structurally impossible. The on-disk file is unchanged (sql.js exported a
 * standard SQLite3 file), so the migration needs zero data conversion.
 */
interface CompatExecResult {
	columns: string[];
	values: unknown[][];
}

/** sql.js-shaped Statement over a better-sqlite3 prepared statement. */
class CompatStatement {
	private bound: unknown[] = [];
	private rows: Record<string, unknown>[] | null = null;
	private cursor = 0;
	constructor(private readonly stmt: BetterSqlite3.Statement) {}
	/** sql.js `bind` — store params; defer execution until first `step()`. */
	bind(params: unknown[] = []): boolean {
		this.bound = params;
		this.rows = null;
		this.cursor = 0;
		return true;
	}
	/** sql.js `step` — lazily run the query on first call, then advance one row. */
	step(): boolean {
		if (this.rows === null) {
			this.rows = this.stmt.all(...this.bound) as Record<string, unknown>[];
			this.cursor = 0;
		}
		if (this.cursor < this.rows.length) {
			this.cursor++;
			return true;
		}
		return false;
	}
	/** sql.js `getAsObject` — the current row as a column-name-keyed object. */
	getAsObject(): Record<string, unknown> {
		return this.rows?.[this.cursor - 1] ?? {};
	}
	/** sql.js `free` — release iteration state (no native handle to free). */
	free(): void {
		this.rows = null;
		this.cursor = 0;
	}
}

/**
 * FLY-663: sql.js-surface wrapper over a native better-sqlite3 connection.
 * Statements are prepared per-call (StateStore never cached them), matching the
 * old usage exactly.
 */
class CompatDb {
	private lastChanges = 0;
	constructor(public readonly raw: BetterDb) {}

	/** sql.js `run(sql, params?)`: param query → prepared run (track changes);
	 * no-param SQL → `exec` (supports multi-statement DDL scripts). */
	run(sql: string, params?: unknown[]): void {
		if (params !== undefined) {
			const info = this.raw.prepare(sql).run(...params);
			this.lastChanges = info.changes;
		} else {
			this.raw.exec(sql);
			this.lastChanges = 0;
		}
	}

	/** sql.js `prepare(sql)` → an iterable CompatStatement (reads). */
	prepare(sql: string): CompatStatement {
		return new CompatStatement(this.raw.prepare(sql));
	}

	/** sql.js `exec(sql, params?)`: result-bearing → `[{columns, values}]`
	 * (tuple shape the lead_events / stuck / delivery / PRAGMA readers expect);
	 * non-result → run and return `[]`. */
	exec(sql: string, params?: unknown[]): CompatExecResult[] {
		const stmt = this.raw.prepare(sql);
		if (stmt.reader) {
			const rows = stmt.all(...(params ?? [])) as Record<string, unknown>[];
			if (rows.length === 0) return [];
			const columns = Object.keys(rows[0] as Record<string, unknown>);
			const values = rows.map((r) => columns.map((c) => r[c]));
			return [{ columns, values }];
		}
		stmt.run(...(params ?? []));
		this.lastChanges = 0;
		return [];
	}

	/** sql.js `getRowsModified()` → rows changed by the last `run`. */
	getRowsModified(): number {
		return this.lastChanges;
	}

	/** Run a logical mutation atomically (FLY-663 §2.8: the old export() was the
	 * persistence boundary; better-sqlite3 autocommits each statement, so
	 * multi-statement methods must be wrapped to avoid durable partial state). */
	transaction(fn: () => void): void {
		this.raw.transaction(fn)();
	}

	close(): void {
		this.raw.close();
	}
}

/**
 * FLY-639: sql.js / WASM error signatures that mean the current DB instance can
 * no longer be trusted and must be rebuilt — NOT a recoverable logical error.
 * `null function or function signature mismatch` = WASM indirect-call-table
 * corruption (the original FLY-639 incident); the rest are the well-known SQLite
 * fatal modes. FLY-663: the engine is now native better-sqlite3 (no WASM), so
 * these are retained as DORMANT defense — they also match better-sqlite3
 * `SQLITE_CORRUPT` / `SQLITE_NOTADB` style messages. Matched case-insensitively
 * as substrings. Ordinary errors (e.g. UNIQUE constraint) deliberately do NOT
 * match, so they never trigger a reload.
 */
const SQLJS_CORRUPTION_SIGNATURES = [
	"null function or function signature mismatch",
	"no such table",
	"database disk image is malformed",
	"file is not a database",
	"out of memory",
	"memory access out of bounds",
] as const;

/**
 * FLY-639: true when `err` looks like sql.js/WASM corruption that requires a DB
 * rebuild rather than continuing on a poisoned instance. Exported for tests.
 */
export function isSqlJsCorruptionError(err: unknown): boolean {
	const msg =
		err instanceof Error ? err.message : typeof err === "string" ? err : "";
	if (!msg) return false;
	const lower = msg.toLowerCase();
	return SQLJS_CORRUPTION_SIGNATURES.some((sig) => lower.includes(sig));
}

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
 * FLY-727: a stored session_event row carrying `id` + `ts` (which the base
 * `SessionEvent` interface omits). Used by the daily completion digest for
 * per-event Pacific-day filtering + last-write-wins ordering by event timestamp.
 */
export interface CompletionEventRow {
	id: number;
	ts: string; // SQLite UTC string `YYYY-MM-DD HH:MM:SS`
	execution_id: string;
	issue_id: string;
	project_name: string;
	payload?: unknown;
}

/**
 * FLY-727: input to `insertDeploymentEvent`. Ingestion requires `projectName` +
 * `source`, at least one of issue/pr, and at least one identity field
 * (mergeSha / deployedSha / deployBatchId / sourceEventId) — validated at the
 * Bridge route boundary before this is called. `deployedAt` defaults to now.
 */
export interface DeploymentEventInput {
	projectName: string;
	issueIdentifier?: string;
	prNumber?: number;
	mergeSha?: string;
	deployedSha?: string;
	deployBatchId?: string;
	environment?: string;
	source: string;
	sourceEventId?: string;
	deployedAt?: string; // SQLite UTC string; Bridge defaults to now when omitted
	metadataJson?: string;
}

export interface DeploymentEventRow {
	id: number;
	project_name: string;
	issue_identifier: string | null;
	pr_number: number | null;
	merge_sha: string | null;
	deployed_sha: string | null;
	deploy_batch_id: string | null;
	environment: string;
	source: string;
	source_event_id: string | null;
	deployed_at: string;
	recorded_at: string;
	metadata_json: string | null;
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
	/** FLY-728: resolved runner model (per-issue model routing visibility). */
	runner_model?: string;
	/** FLY-728 Part C: the difficulty-sorter's dispatch model param (retry input). */
	dispatch_model?: string;
	/** FLY-615: resolved ponytail condition (A/B join key for FLY-614/616). */
	ponytail_condition?: string;
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
	/** FLY-205: Lead-judged doc tier ("full" | "plan_only" | "none"). Retry reuses. */
	doc_tier?: string;
	/** FLY-205: Linear issue URL persisted at start (doc header continuity on retry). */
	issue_url?: string;
	/** FLY-598: founder-facing-ux flag (Lead label snapshot OR Runner self-declare), 0|1. */
	founder_facing_ux?: number;
	/** FLY-598: Bridge-written, founder-verified UX sign-off record (JSON; bound to uxHash). */
	founder_ux_signoff_json?: string;
	/** FLY-598: per-run snapshot of founder_ux_gate.mode (off|audit_only|enforce). */
	founder_ux_gate_mode?: string;
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
	/** FLY-728: resolved runner model (per-issue model routing visibility). */
	runner_model?: string;
	/** FLY-728 Part C: the difficulty-sorter's dispatch model param (retry input). */
	dispatch_model?: string;
	/** FLY-615: resolved ponytail condition (A/B join key for FLY-614/616). */
	ponytail_condition?: string;
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
	/** FLY-205: Lead-judged doc tier ("full" | "plan_only" | "none"). Retry reuses. */
	doc_tier?: string;
	/** FLY-205: Linear issue URL persisted at start (doc header continuity on retry). */
	issue_url?: string;
	/** FLY-598: founder-facing-ux flag (Lead label snapshot OR Runner self-declare). */
	founder_facing_ux?: boolean;
	/** FLY-598: Bridge-written, founder-verified UX sign-off record (JSON; bound to uxHash). */
	founder_ux_signoff_json?: string;
	/** FLY-598: per-run snapshot of founder_ux_gate.mode (off|audit_only|enforce). */
	founder_ux_gate_mode?: string;
	/** FLY-245 D-a: monotonic revision incremented on every status transition.
	 * The runner-lifecycle founder credential snapshots this; a stale confirmation
	 * is rejected once it changes (plan §5.1). Defaults 0. */
	lifecycle_revision?: number;
}

// FLY-163: CleanupCandidate removed (CleanupService gone).

/** FLY-245 D2: one durable (gateway request id → successor execution id)
 * binding in the retry dispatch intent WAL (plan §5.2.1). */
export interface RetryDispatchIntent {
	request_id: string;
	successor_execution_id: string;
	predecessor_execution_id: string;
	/** 'intent' (WAL committed, dispatch not confirmed) | 'dispatched'.
	 * Informational — never proof of start. */
	state: "intent" | "dispatched";
	created_at: string;
	updated_at: string;
}

/**
 * FLY-579 P1: durable record for the auto-QA pipeline. One row per
 * (parent main execution, reviewed PR head sha). It is the source of truth
 * for "this awaiting_review main session is QA-held" — written BEFORE the QA
 * Runner is spawned (so no relayer can observe the parent as an ordinary
 * review gate first) and read by the shared `isQaHeld` predicate.
 *
 * status:
 *  - running    — QA spawned (or claimed, pre-spawn), verdict pending → HOLD founder
 *  - passed     — QA verdict PASS → release founder ship-ready notification
 *  - failed     — QA verdict FAIL → routed back to implementer (founder NOT notified)
 *  - superseded — a newer reviewed head opened a fresh record; this one is dead
 *  - stuck      — spawn failed or QA died without a verdict → Lead-only pipeline error
 */
export interface AutoQaRecord {
	parent_execution_id: string;
	target_pr_head_sha: string;
	/** The PARENT (implementer) issue id — what is being verified. */
	issue_id: string;
	project_name: string;
	qa_execution_id?: string;
	/**
	 * FLY-643: the SEPARATE `QA·FLY-XX` Linear issue this record's QA runner runs
	 * on (its own issue + thread + runner), distinct from `issue_id` (the parent).
	 * Persisted at issue-creation time so a crash between create + spawn re-uses
	 * the same QA issue on reconcile instead of creating a duplicate. Absent on
	 * pre-FLY-643 / not-yet-created records.
	 */
	qa_issue_id?: string;
	qa_issue_identifier?: string;
	qa_issue_title?: string;
	qa_issue_url?: string;
	status: "running" | "passed" | "failed" | "superseded" | "stuck";
	verdict_event_id?: string;
	started_at: string;
	completed_at?: string;
	notified_at?: string;
}

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
	private db: CompatDb;
	private dbPath: string;

	// --- FLY-639: best-effort corruption self-heal + unrecoverable escalation ---
	/** Consecutive failed rebuilds; reset to 0 on a successful recovery. */
	private recoveryFailures = 0;
	/** Epoch-ms of the last ACTUAL rebuild attempt (storm guard). */
	private lastRecoveryAttemptAt = 0;
	/** Max consecutive failed rebuilds before escalating to a clean restart. */
	private readonly maxRecoveryFailures = 3;
	/**
	 * Min gap between actual rebuild attempts. GatePoller polls every ~3s and a
	 * single tick can hit the same corrupt store across multiple leads; without
	 * this, one corruption episode would trigger a reload storm.
	 */
	private readonly recoveryThrottleMs = 5_000;
	/**
	 * FLY-639 (retained DORMANT under FLY-663): invoked when in-process recovery
	 * has failed `maxRecoveryFailures` times in a row — the DB cannot be reopened.
	 * Default: log FATAL + controlled `process.exit(1)` so launchd respawns the
	 * Bridge with a fresh process + connection. This resolves the "never crash"
	 * vs. "launchd is the fallback" contradiction: a single transient error is
	 * contained, but a truly-dead store does not leave an alive-but-useless
	 * daemon. Injectable so tests do not kill the test runner.
	 */
	onUnrecoverableCorruption: (err: unknown) => void = (err) => {
		console.error(
			"[StateStore] FATAL: StateStore DB unrecoverable after repeated in-process reopen attempts — exiting for a clean restart (launchd respawns the Bridge with a fresh connection):",
			err instanceof Error ? err.message : err,
		);
		process.exit(1);
	};

	private constructor(db: CompatDb, dbPath: string) {
		this.db = db;
		this.dbPath = dbPath;
	}

	/**
	 * FLY-663: open the StateStore on native better-sqlite3. The factory stays
	 * `async` so the many `await StateStore.create(...)` call sites (and tests)
	 * are byte-compatible; better-sqlite3 itself is synchronous.
	 *
	 * Zero data migration: a sql.js-exported `teamlead.db` is a standard SQLite3
	 * file, so this opens the existing production DB in place. WAL mode +
	 * `synchronous=NORMAL` give incremental durable writes without the old
	 * full-DB export-on-every-write.
	 */
	static async create(dbPath: string): Promise<StateStore> {
		const store = new StateStore(StateStore.openDatabase(dbPath), dbPath);
		store.migrate();
		return store;
	}

	/** FLY-663: open a better-sqlite3 connection with the StateStore pragmas. */
	private static openDatabase(dbPath: string): CompatDb {
		if (dbPath !== ":memory:") {
			mkdirSync(dirname(dbPath), { recursive: true });
		}
		const raw = new BetterSqlite3(dbPath);
		// WAL: incremental writes (no full-DB export per write). synchronous=NORMAL
		// is safe under WAL (at most the last txn lost on power-loss) and fast.
		// busy_timeout: retry transient locks (e.g. a cross-process WAL reader /
		// checkpoint) instead of failing immediately.
		raw.pragma("journal_mode = WAL");
		raw.pragma("synchronous = NORMAL");
		raw.pragma("busy_timeout = 5000");
		raw.pragma("foreign_keys = ON");
		return new CompatDb(raw);
	}

	/**
	 * FLY-663: checkpoint the WAL into the main DB file before closing, so a clean
	 * shutdown leaves `teamlead.db` complete and `-wal` empty (backup/migration
	 * tooling can then treat the main file as authoritative). save() is a no-op
	 * now (writes are already durable), so no pre-close flush is needed.
	 */
	close(): void {
		try {
			// wal_checkpoint can return a NON-throwing busy result (busy=1) if another
			// connection holds a read txn — then the WAL is NOT fully truncated. Log it
			// so backup/migration tooling knows the -wal/-shm sidecars may still hold
			// committed frames and must be copied with the main file (Codex code R1 LOW).
			const res = this.db.raw.pragma("wal_checkpoint(TRUNCATE)") as
				| Array<{ busy?: number }>
				| undefined;
			const busy = res?.[0]?.busy;
			if (busy && busy !== 0) {
				console.warn(
					`[StateStore] close(): WAL checkpoint busy (a reader held a lock) — ${this.dbPath}-wal/-shm may retain committed frames; copy them with the main file.`,
				);
			}
		} catch {
			// best-effort; a checkpoint failure must not prevent close.
		}
		this.db.close();
	}

	/**
	 * FLY-639 (band-aid, retained DORMANT under FLY-663): best-effort in-process
	 * recovery from DB corruption. Returns `true` ONLY when the DB was reopened
	 * and is healthy again.
	 *
	 * After the FLY-663 migration the engine is native better-sqlite3 (no WASM
	 * heap), so the original sql.js corruption mode is structurally impossible.
	 * This is kept as defense-in-depth for genuine SQLite-level corruption
	 * (`SQLITE_CORRUPT` / `SQLITE_NOTADB` / a malformed on-disk file).
	 *
	 * - Non-corruption errors → `false` (DB untouched; no counting / throttling).
	 * - Corruption errors → close the suspect handle and REOPEN from the on-disk
	 *   file (a transient handle/heap state heals in-process).
	 *
	 * Recovery CONTRACT (FLY-663 §2.5 — never silently recreate an empty DB over
	 * real data):
	 *   - `:memory:` → rebuild empty (tests only have no on-disk image).
	 *   - file ABSENT → fresh empty DB (legitimate first run).
	 *   - file PRESENT but malformed / NOTADB / CORRUPT → the reopen's sanity
	 *     read THROWS → counted as a rebuild FAILURE → after
	 *     `maxRecoveryFailures` consecutive failures escalate via
	 *     `onUnrecoverableCorruption` (clean restart). It is NEVER masked as an
	 *     empty-DB "success".
	 *
	 * Never throws: a failed rebuild is logged + counted, and the caller (a
	 * periodic poller) simply skips the cycle.
	 */
	recoverFromCorruption(err: unknown): boolean {
		if (!isSqlJsCorruptionError(err)) return false;

		const now = Date.now();
		// Storm guard: at most one ACTUAL rebuild per throttle window. A throttled
		// call is the SAME corruption episode, so it is NOT counted toward the
		// unrecoverable-escalation failure tally.
		if (now - this.lastRecoveryAttemptAt < this.recoveryThrottleMs) {
			return false;
		}
		this.lastRecoveryAttemptAt = now;

		const original = err instanceof Error ? err.message : String(err);
		const old = this.db;
		// Track the freshly-built handle so it can be closed if migration throws
		// (no leaked handle on the failure path — Codex code R1 LOW).
		let next: CompatDb | undefined;
		try {
			// Reopen from the on-disk file, swap it in, then migrate it (idempotent;
			// synchronous). On ANY throw the catch restores `old` and closes `next`.
			next = this.buildDatabaseFromDisk();
			this.db = next;
			this.migrate();
			// Best-effort close of the old (corrupt) handle. A close failure does
			// not fail recovery.
			try {
				old.close();
			} catch {
				// old handle may itself be poisoned — ignore.
			}
			this.recoveryFailures = 0;
			console.error(
				`[StateStore] FLY-639: recovered from DB corruption — reopened from on-disk file (${this.dbPath}). Original error: ${original}`,
			);
			return true;
		} catch (rebuildErr) {
			this.db = old; // restore defined state (old is corrupt, retried next window)
			// Close the half-built replacement so a failed rebuild never leaks a handle.
			if (next) {
				try {
					next.close();
				} catch {
					// best-effort
				}
			}
			this.recoveryFailures++;
			console.error(
				`[StateStore] FLY-639: in-process DB rebuild FAILED (attempt ${this.recoveryFailures}/${this.maxRecoveryFailures}). Original error: ${original}; rebuild error: ${
					rebuildErr instanceof Error ? rebuildErr.message : String(rebuildErr)
				}`,
			);
			if (this.recoveryFailures >= this.maxRecoveryFailures) {
				this.onUnrecoverableCorruption(err);
			}
			return false;
		}
	}

	/**
	 * FLY-663: reopen a fresh better-sqlite3 connection from the on-disk file.
	 *
	 * A MISSING file → fresh empty DB (legitimate first-run / no image yet). A
	 * file that EXISTS yet is malformed must NOT be silently swallowed into an
	 * empty-DB "success": the sanity read below THROWS so it counts as a rebuild
	 * failure in `recoverFromCorruption()` and can reach the unrecoverable
	 * escalation (FLY-639 contract preserved; Codex code R1 MEDIUM).
	 */
	private buildDatabaseFromDisk(): CompatDb {
		if (this.dbPath === ":memory:") {
			return StateStore.openDatabase(":memory:");
		}
		const fileExisted = existsSync(this.dbPath);
		const db = StateStore.openDatabase(this.dbPath);
		if (fileExisted) {
			// Existing file → prove it is a real SQLite DB. A malformed/NOTADB image
			// makes this read throw, which the caller counts as a rebuild failure
			// (rather than masking corruption as a clean empty DB).
			db.raw.prepare("SELECT name FROM sqlite_master LIMIT 1").get();
		}
		return db;
	}

	/**
	 * FLY-663: persistence is now incremental + durable per write (better-sqlite3
	 * WAL), so the old export-on-every-write `save()` is gone. Kept as a no-op so
	 * the internal write-path call sites stay byte-identical (minimal diff).
	 */
	private save(): void {
		// no-op: every run() is already durable to the WAL.
	}

	/**
	 * FLY-605: durability barrier before a follow-on durable write. Under WAL
	 * every write is already durable, so this is a no-op (retained for the
	 * external callers in gate-poller). FLY-663: this also removes the old
	 * "appendLeadEvent/markLeadEventDelivered not durable until flush" hazard.
	 */
	flush(): void {
		// no-op: writes are already durable under WAL.
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
			// FLY-728: resolved runner model (per-issue model routing visibility).
			this.db.run("ALTER TABLE sessions ADD COLUMN runner_model TEXT");
		} catch {
			// Column already exists — ignore
		}
		try {
			// FLY-728 Part C: the difficulty-sorter's dispatch model param ONLY (the
			// source-honest retry input — distinct from runner_model, which is the
			// resolved model from any layer). Retry re-applies it so a sorter model
			// survives; a label/project/account model is NOT reintroduced.
			this.db.run("ALTER TABLE sessions ADD COLUMN dispatch_model TEXT");
		} catch {
			// Column already exists — ignore
		}
		try {
			// FLY-615: ponytail A/B condition (join key for FLY-614/616).
			this.db.run("ALTER TABLE sessions ADD COLUMN ponytail_condition TEXT");
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
		// FLY-598: founder-facing UX gate. `founder_facing_ux` = Lead label snapshot
		// at run start OR Runner self-declaration (1 = gate active for this run).
		// `founder_ux_signoff_json` = the Bridge-written, founder-identity-verified
		// sign-off record (bound to a canonical UX-brief uxHash); only the privileged
		// record path writes it, the Runner reads it via the status route.
		try {
			this.db.run(
				"ALTER TABLE sessions ADD COLUMN founder_facing_ux INTEGER NOT NULL DEFAULT 0",
			);
		} catch {
			/* exists */
		}
		try {
			this.db.run(
				"ALTER TABLE sessions ADD COLUMN founder_ux_signoff_json TEXT",
			);
		} catch {
			/* exists */
		}
		// FLY-598: per-run snapshot of founder_ux_gate.mode (off|audit_only|enforce),
		// captured at run start from the project config; the Layer B stage guard
		// reads it. Absent → treated as "off".
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN founder_ux_gate_mode TEXT");
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

		// FLY-205: doc-flow tier (Lead-judged at spawn; retry reuses it — never
		// silently upgrades back to full) + Linear issue URL (doc header line;
		// persisted at start so retry prompts keep the same header as start).
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN doc_tier TEXT");
		} catch {
			/* exists */
		}
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN issue_url TEXT");
		} catch {
			/* exists */
		}

		// FLY-245 D-a: monotonic lifecycle revision — incremented on EVERY status
		// transition (upsert / persistTransition / forceStatus). The runner-lifecycle
		// founder credential snapshots this at request time; a stale confirmation is
		// rejected when the revision has since changed (status can leave and return to
		// the same value, so `status` alone is not a sufficient freshness signal —
		// plan §5.1 / Codex R1#5). Defaults 0 so existing rows are backward-compatible.
		try {
			this.db.run(
				"ALTER TABLE sessions ADD COLUMN lifecycle_revision INTEGER NOT NULL DEFAULT 0",
			);
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
		// FLY-727: daily digest range-scans session_completed by ts.
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_events_type_ts ON session_events(event_type, ts)",
		);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)",
		);

		// FLY-727: deployment_events — the fleet "deployed to live" ledger. The daily
		// digest queries this by time (cheap indexed range); each project reports a
		// row at its real product-deploy point via `POST /api/deployments/report`.
		// dedup_key is a deterministic non-null identity so INSERT OR IGNORE is idempotent.
		this.db.run(`
			CREATE TABLE IF NOT EXISTS deployment_events (
				id                INTEGER PRIMARY KEY AUTOINCREMENT,
				project_name      TEXT NOT NULL,
				issue_identifier  TEXT,
				pr_number         INTEGER,
				merge_sha         TEXT,
				deployed_sha      TEXT,
				deploy_batch_id   TEXT,
				environment       TEXT NOT NULL DEFAULT 'production',
				source            TEXT NOT NULL,
				source_event_id   TEXT,
				deployed_at       TEXT NOT NULL,
				recorded_at       TEXT NOT NULL DEFAULT (datetime('now')),
				metadata_json     TEXT,
				dedup_key         TEXT NOT NULL
			)
		`);
		this.db.run(
			"CREATE UNIQUE INDEX IF NOT EXISTS idx_deployment_events_dedup ON deployment_events(dedup_key)",
		);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_deployment_events_time ON deployment_events(deployed_at)",
		);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_deployment_events_proj_time ON deployment_events(project_name, deployed_at)",
		);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_deployment_events_issue ON deployment_events(project_name, issue_identifier)",
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
				discord_missing_at TEXT,
				archived_at TEXT,
				attach_pin_message_id TEXT,
				attach_pin_command TEXT,
				attach_pin_pinned_at TEXT
			)
		`);
		this.db.run(
			"CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_threads_issue_channel ON chat_threads(issue_id, channel_id)",
		);

		// FLY-314: Roundtable per-topic threads. DELIBERATELY a separate table from
		// chat_threads: roundtable topics are NOT issue/session-bound, and reusing
		// chat_threads would leak synthetic ids through the issue-thread reverse
		// lookup (/api/chat-threads/by-thread) and reply-guard's "issue-thread"
		// classification (Codex design review R1#2). thread_id == source_message_id
		// (Discord "start thread from message" invariant — the crash-recovery anchor).
		this.db.run(`
			CREATE TABLE IF NOT EXISTS roundtable_topic_threads (
				thread_id TEXT PRIMARY KEY,
				channel_id TEXT NOT NULL,
				source_message_id TEXT NOT NULL,
				author_id TEXT,
				trigger_mode TEXT,
				created_at TEXT DEFAULT (datetime('now')),
				discord_missing_at TEXT,
				archived_at TEXT
			)
		`);
		this.db.run(
			"CREATE UNIQUE INDEX IF NOT EXISTS idx_roundtable_topic_msg ON roundtable_topic_threads(channel_id, source_message_id)",
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

		// FLY-245 D2: retry dispatch intent WAL (plan §5.2.1). The durable
		// (gateway request id → successor execution id) binding, committed BEFORE
		// the dispatcher runs. `state` is informational ('intent' → 'dispatched');
		// crash recovery NEVER treats it as proof of start — the authoritative
		// started evidence is the Runner's self-registered live tmux identity
		// (bridge/started-evidence.ts). Exactly one successor id per request id,
		// enforced by the PRIMARY KEY.
		this.db.run(`
			CREATE TABLE IF NOT EXISTS retry_dispatch_intents (
				request_id TEXT PRIMARY KEY,
				successor_execution_id TEXT NOT NULL,
				predecessor_execution_id TEXT NOT NULL,
				state TEXT NOT NULL DEFAULT 'intent',
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				updated_at TEXT NOT NULL DEFAULT (datetime('now'))
			)
		`);

		// FLY-368: unified alert-channel per-error threads (active-mapping ONLY —
		// the current live thread per incident; history lives in Discord / logs /
		// alert_repair_attempts, NOT here). correlation_key = coarse key for
		// resolve-by-kind: `${project}|${leadId}|${eventType}|${sessionKey??''}`.
		// event_id + episode_signature are the fine key (a different event_id under
		// the same correlation_key = a distinct, later episode → the stale row is
		// resolved+archived, then openAlertThread() UPSERTs the new mapping).
		this.db.run(`
			CREATE TABLE IF NOT EXISTS alert_threads (
				correlation_key TEXT PRIMARY KEY,
				event_id TEXT NOT NULL,
				episode_signature TEXT,
				thread_id TEXT NOT NULL,
				root_message_id TEXT,
				channel_id TEXT NOT NULL,
				lead_id TEXT NOT NULL,
				project_name TEXT NOT NULL,
				event_type TEXT NOT NULL,
				session_key TEXT,
				repair_status TEXT,
				opened_at TEXT NOT NULL DEFAULT (datetime('now')),
				resolved_at TEXT
			)
		`);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_alert_threads_active ON alert_threads(resolved_at)",
		);

		// FLY-368: durable, fail-closed audit for auto-repair-bot terminal writes
		// to a LEAD pane (the resume-menu Enter). Lead-level alerts have no real
		// execution/issue, so they MUST NOT be forced into session_events; this is
		// their purpose-built audit sink (mirrors the runner nudge's audit-before-
		// send contract). Append-only.
		this.db.run(`
			CREATE TABLE IF NOT EXISTS alert_repair_attempts (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				correlation_key TEXT NOT NULL,
				event_id TEXT,
				actor TEXT NOT NULL,
				action TEXT NOT NULL,
				lead_id TEXT,
				project_name TEXT,
				result TEXT NOT NULL,
				reason TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			)
		`);

		// FLY-579 P1: auto-QA pipeline durable record. Keyed by (parent main
		// execution, reviewed PR head sha) so a re-review against a new head opens
		// a fresh record while a repeated awaiting_review for the SAME head dedups
		// to one QA spawn. Written before the QA Runner spawns (held-first).
		this.db.run(`
			CREATE TABLE IF NOT EXISTS auto_qa_record (
				parent_execution_id TEXT NOT NULL,
				target_pr_head_sha TEXT NOT NULL,
				issue_id TEXT NOT NULL,
				project_name TEXT NOT NULL,
				qa_execution_id TEXT,
				qa_issue_id TEXT,
				qa_issue_identifier TEXT,
				qa_issue_title TEXT,
				qa_issue_url TEXT,
				status TEXT NOT NULL DEFAULT 'running',
				verdict_event_id TEXT,
				started_at TEXT NOT NULL DEFAULT (datetime('now')),
				completed_at TEXT,
				notified_at TEXT,
				PRIMARY KEY (parent_execution_id, target_pr_head_sha)
			)
		`);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_auto_qa_record_qa_exec ON auto_qa_record(qa_execution_id)",
		);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_auto_qa_record_status ON auto_qa_record(status)",
		);

		// FLY-637 #3/#4: persistent "already-notified" dedup for the quiet-path
		// Lead wake (direction A — report-once, NO backoff). A row means "I already
		// woke the Lead about THIS frozen frame", so a Bridge restart cannot
		// re-wake (the in-memory dedup sets are wiped on restart). Keyed by
		// (execution_id, source, episode_fingerprint):
		//   - source = 'idle'  (RunnerIdleWatchdog) → fp = quietFingerprint(pane)
		//   - source = 'stuck' (HeartbeatService)   → fp = sentinel 'stuck' (no pane)
		// Rows are pruned when the session leaves the watchdog's running/stuck set.
		this.db.run(`
			CREATE TABLE IF NOT EXISTS quiet_wake_notified (
				execution_id        TEXT NOT NULL,
				source              TEXT NOT NULL,
				episode_fingerprint TEXT NOT NULL,
				notified_at         TEXT NOT NULL DEFAULT (datetime('now')),
				PRIMARY KEY (execution_id, source, episode_fingerprint)
			)
		`);

		// FLY-637-ext: durable exponential-backoff state for the lead-pending
		// escalation (a runner blocked on a `question` gate the Lead hasn't
		// answered). Keyed by (execution_id, question_id) so a runner's multiple
		// pending questions never share/overwrite backoff state (Codex R1 #1).
		// Survives a Bridge restart so a restart doesn't re-storm nudges.
		this.db.run(`
			CREATE TABLE IF NOT EXISTS lead_pending_escalation (
				execution_id        TEXT NOT NULL,
				question_id         TEXT NOT NULL,
				stuck_key           TEXT NOT NULL,
				nudge_count         INTEGER NOT NULL DEFAULT 0,
				last_nudge_at_ms    INTEGER NOT NULL DEFAULT 0,
				next_eligible_at_ms INTEGER NOT NULL DEFAULT 0,
				paged_annie         INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (execution_id, question_id)
			)
		`);

		// FLY-25: migration for existing tables missing new columns
		this.migrateLeadEventsDeliveryColumns();
		// FLY-369: archived_at on chat_threads (archive-on-Done)
		this.migrateChatThreadsArchivedColumn();
		this.migrateChatThreadsAttachPinColumns();
		// FLY-643: qa_issue_* columns on auto_qa_record (separate QA issue)
		this.migrateAutoQaRecordQaIssueColumns();
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

	/**
	 * FLY-727: session_completed events in a UTC time window, carrying `id` + `ts`.
	 * The daily digest queries a WIDE UTC window and does the exact Pacific-day
	 * (+ DST) filtering per-event downstream. Read-only; ordered ASC by ts so a
	 * downstream last-write-wins dedup yields each issue's latest completion.
	 */
	getCompletionEventsInRange(
		sinceUtc: string,
		untilUtc: string,
	): CompletionEventRow[] {
		const stmt = this.db.prepare(
			`SELECT id, ts, execution_id, issue_id, project_name, payload
			 FROM session_events
			 WHERE event_type = 'session_completed' AND ts >= ? AND ts < ?
			 ORDER BY ts ASC`,
		);
		stmt.bind([sinceUtc, untilUtc]);
		const rows: CompletionEventRow[] = [];
		while (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			rows.push({
				id: row.id as number,
				ts: row.ts as string,
				execution_id: row.execution_id as string,
				issue_id: row.issue_id as string,
				project_name: row.project_name as string,
				payload: row.payload ? JSON.parse(row.payload as string) : undefined,
			});
		}
		stmt.free();
		return rows;
	}

	/**
	 * FLY-727: idempotently insert a deployment event. Returns whether a NEW row was
	 * inserted (false = dedup hit). `deployedAt` defaults to now. The dedup key is a
	 * deterministic non-null identity so `INSERT OR IGNORE` collapses replays
	 * (self-ship updater re-runs, spool drains) but keeps genuinely distinct deploys.
	 */
	insertDeploymentEvent(input: DeploymentEventInput): { inserted: boolean } {
		const norm = (s: string | undefined) => (s ? s.trim() : undefined);
		const issue = norm(input.issueIdentifier)?.toUpperCase();
		const mergeSha = norm(input.mergeSha)?.toLowerCase();
		const deployedSha = norm(input.deployedSha)?.toLowerCase();
		const batchId = norm(input.deployBatchId);
		const sourceEventId = norm(input.sourceEventId);
		const environment = norm(input.environment) ?? "production";
		const deployedAt =
			norm(input.deployedAt) ??
			new Date()
				.toISOString()
				.replace("T", " ")
				.replace(/\.\d+Z$/, "");
		// Event identity — must be non-null (Bridge route rejects if all absent).
		const eventIdentity =
			mergeSha ?? sourceEventId ?? batchId ?? deployedSha ?? "";
		// Codex code-review R6 (HIGH): a squash-merge commit is 1:1 with a single
		// PR/issue, so when `merge_sha` is the identity it ALONE identifies the deploy
		// — issue/pr are enrichment and must NOT be part of the dedup key. Otherwise a
		// fallback-git-log row whose commit subject yielded a PR but no issue (key
		// `proj||pr|sha|env`) fails to collide with the authoritative marker report
		// (key `proj|issue|pr|sha|env`), leaving two rows the digest double-counts.
		// A merge-less identity (batch / deployed-sha) CAN span multiple issues, so
		// there issue+pr stay in the key to keep genuinely-distinct deploys distinct.
		const dedupKey = mergeSha
			? [input.projectName, "", "", eventIdentity, environment].join("|")
			: [
					input.projectName,
					issue ?? "",
					input.prNumber ?? "",
					eventIdentity,
					environment,
				].join("|");

		// Correctness of dedup is guaranteed by the UNIQUE(dedup_key) index +
		// INSERT OR IGNORE regardless; the `inserted` bool is informational for the
		// CLI response, so a per-key existence probe (not a racy full-table count) is
		// enough to say "recorded" vs "already recorded".
		const existed =
			(this.db.exec(
				"SELECT 1 FROM deployment_events WHERE dedup_key = ? LIMIT 1",
				[dedupKey],
			)[0]?.values.length ?? 0) > 0;
		this.db.run(
			`INSERT OR IGNORE INTO deployment_events
			 (project_name, issue_identifier, pr_number, merge_sha, deployed_sha,
			  deploy_batch_id, environment, source, source_event_id, deployed_at,
			  metadata_json, dedup_key)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				input.projectName,
				issue ?? null,
				input.prNumber ?? null,
				mergeSha ?? null,
				deployedSha ?? null,
				batchId ?? null,
				environment,
				input.source,
				sourceEventId ?? null,
				deployedAt,
				norm(input.metadataJson) ?? null,
				dedupKey,
			],
		);
		// Codex code-review R5 #2: a marker-driven markerless FALLBACK row
		// (source='fallback-git-log') is written at deployed-sha advance BEFORE the
		// authoritative marker-backed self-ship report for the same commit identity;
		// plain INSERT OR IGNORE would leave the deploy stuck as `inferred`. When an
		// AUTHORITATIVE (non-fallback) source reports the same dedup_key, UPGRADE the
		// existing fallback row to it (source + enrich fields). Only fallback rows are
		// touched (WHERE source='fallback-git-log'), so authoritative rows never regress.
		if (input.source !== "fallback-git-log") {
			this.db.run(
				`UPDATE deployment_events
				   SET source = ?,
				       issue_identifier = COALESCE(?, issue_identifier),
				       pr_number = COALESCE(?, pr_number),
				       merge_sha = COALESCE(?, merge_sha),
				       deployed_sha = COALESCE(?, deployed_sha),
				       source_event_id = COALESCE(?, source_event_id)
				 WHERE dedup_key = ? AND source = 'fallback-git-log'`,
				[
					input.source,
					issue ?? null,
					input.prNumber ?? null,
					mergeSha ?? null,
					deployedSha ?? null,
					sourceEventId ?? null,
					dedupKey,
				],
			);
		}
		this.save();
		return { inserted: !existed };
	}

	/**
	 * FLY-727: deployment events in a UTC time window (the digest's primary source).
	 * Ordered ASC by deployed_at.
	 */
	getDeploymentEventsInRange(
		sinceUtc: string,
		untilUtc: string,
	): DeploymentEventRow[] {
		const stmt = this.db.prepare(
			`SELECT id, project_name, issue_identifier, pr_number, merge_sha,
			        deployed_sha, deploy_batch_id, environment, source,
			        source_event_id, deployed_at, recorded_at, metadata_json
			 FROM deployment_events
			 WHERE deployed_at >= ? AND deployed_at < ?
			 ORDER BY deployed_at ASC`,
		);
		stmt.bind([sinceUtc, untilUtc]);
		const rows: DeploymentEventRow[] = [];
		while (stmt.step()) {
			const r = stmt.getAsObject() as Record<string, unknown>;
			rows.push({
				id: r.id as number,
				project_name: r.project_name as string,
				issue_identifier: (r.issue_identifier as string) ?? null,
				pr_number: (r.pr_number as number) ?? null,
				merge_sha: (r.merge_sha as string) ?? null,
				deployed_sha: (r.deployed_sha as string) ?? null,
				deploy_batch_id: (r.deploy_batch_id as string) ?? null,
				environment: r.environment as string,
				source: r.source as string,
				source_event_id: (r.source_event_id as string) ?? null,
				deployed_at: r.deployed_at as string,
				recorded_at: r.recorded_at as string,
				metadata_json: (r.metadata_json as string) ?? null,
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

		// FLY-663 §2.8: the session upsert + awaiting_review stamp + lifecycle bump
		// are one logical mutation. The old export()-on-save was the atomic
		// persistence boundary; under better-sqlite3 autocommit they must be wrapped
		// so a mid-sequence throw cannot leave durable partial state.
		this.db.transaction(() => {
			this.db.run(
				`INSERT INTO sessions (
				execution_id, issue_id, project_name, status,
				issue_identifier, issue_title,
				started_at, last_activity_at,
				tmux_session, worktree_path, branch,
				last_error, decision_route, decision_reasoning,
				cost_usd, commit_count, files_changed, lines_added, lines_removed,
				summary, diff_summary, commit_messages, changed_file_paths,
				session_params, heartbeat_at, adapter_type, runner_model, dispatch_model, ponytail_condition, run_attempt,
				retry_predecessor, retry_successor, issue_labels,
				pr_number, session_stage, stage_updated_at, session_role,
				doc_tier, issue_url
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
				runner_model = COALESCE(excluded.runner_model, runner_model),
				dispatch_model = COALESCE(excluded.dispatch_model, dispatch_model),
				ponytail_condition = COALESCE(excluded.ponytail_condition, ponytail_condition),
				run_attempt = COALESCE(excluded.run_attempt, run_attempt),
				retry_predecessor = COALESCE(excluded.retry_predecessor, retry_predecessor),
				retry_successor = COALESCE(excluded.retry_successor, retry_successor),
				issue_labels = COALESCE(excluded.issue_labels, issue_labels),
				pr_number = COALESCE(excluded.pr_number, pr_number),
				session_stage = COALESCE(excluded.session_stage, session_stage),
				stage_updated_at = COALESCE(excluded.stage_updated_at, stage_updated_at),
				session_role = COALESCE(excluded.session_role, session_role),
				doc_tier = COALESCE(excluded.doc_tier, doc_tier),
				issue_url = COALESCE(excluded.issue_url, issue_url)
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
					session.runner_model ?? null,
					session.dispatch_model ?? null,
					session.ponytail_condition ?? null,
					session.run_attempt ?? null,
					session.retry_predecessor ?? null,
					session.retry_successor ?? null,
					session.issue_labels ?? null,
					session.pr_number ?? null,
					session.session_stage ?? null,
					session.stage_updated_at ?? null,
					session.session_role ?? null,
					session.doc_tier ?? null,
					session.issue_url ?? null,
				],
			);
			if (enteringAwaitingReview) {
				this.stampAwaitingReviewEntry(session.execution_id);
			}
			// FLY-245 D-a: bump the monotonic lifecycle revision on a genuine status
			// CHANGE (a new session keeps revision 0; a same-status re-upsert does not
			// inflate it). The runner-lifecycle credential's freshness snapshot relies
			// on this.
			if (existing && existing.status !== session.status) {
				this.bumpLifecycleRevision(session.execution_id);
			}
		});
		this.save();
	}

	/** FLY-245 D-a: atomically increment a session's monotonic lifecycle revision.
	 * Called by every status-write path on a real transition (plan §5.1). */
	private bumpLifecycleRevision(executionId: string): void {
		this.db.run(
			"UPDATE sessions SET lifecycle_revision = lifecycle_revision + 1 WHERE execution_id = ?",
			[executionId],
		);
	}

	/** FLY-245 D-a: read a session's current monotonic lifecycle revision (0 if
	 * the session is absent). */
	getLifecycleRevision(executionId: string): number {
		return this.getSession(executionId)?.lifecycle_revision ?? 0;
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
		// FLY-245 D-a: capture pre-write status to bump lifecycle revision on a
		// genuine transition (this is the FSM-validated path; a new session keeps
		// revision 0).
		const preStatus = this.getSession(executionId)?.status;
		// FLY-663 §2.8: status upsert + awaiting_review stamp + lifecycle bump are
		// one logical mutation — wrap so no durable partial state on a mid throw.
		this.db.transaction(() => {
			this.db.run(
				`INSERT INTO sessions (
				execution_id, issue_id, project_name, status,
				issue_identifier, issue_title,
				started_at, last_activity_at,
				tmux_session, worktree_path, branch,
				last_error, decision_route, decision_reasoning,
				cost_usd, commit_count, files_changed, lines_added, lines_removed,
				summary, diff_summary, commit_messages, changed_file_paths,
				session_params, heartbeat_at, adapter_type, runner_model, dispatch_model, ponytail_condition, run_attempt,
				retry_predecessor, retry_successor, issue_labels,
				pr_number, session_stage, stage_updated_at, session_role,
				doc_tier, issue_url
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
				runner_model = COALESCE(excluded.runner_model, runner_model),
				dispatch_model = COALESCE(excluded.dispatch_model, dispatch_model),
				ponytail_condition = COALESCE(excluded.ponytail_condition, ponytail_condition),
				run_attempt = COALESCE(excluded.run_attempt, run_attempt),
				retry_predecessor = COALESCE(excluded.retry_predecessor, retry_predecessor),
				retry_successor = COALESCE(excluded.retry_successor, retry_successor),
				issue_labels = COALESCE(excluded.issue_labels, issue_labels),
				pr_number = COALESCE(excluded.pr_number, pr_number),
				session_stage = COALESCE(excluded.session_stage, session_stage),
				stage_updated_at = COALESCE(excluded.stage_updated_at, stage_updated_at),
				session_role = COALESCE(excluded.session_role, session_role),
				doc_tier = COALESCE(excluded.doc_tier, doc_tier),
				issue_url = COALESCE(excluded.issue_url, issue_url)
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
					fields.runner_model ?? null,
					fields.dispatch_model ?? null,
					fields.ponytail_condition ?? null,
					fields.run_attempt ?? null,
					fields.retry_predecessor ?? null,
					fields.retry_successor ?? null,
					fields.issue_labels ?? null,
					fields.pr_number ?? null,
					fields.session_stage ?? null,
					fields.stage_updated_at ?? null,
					fields.session_role ?? null,
					fields.doc_tier ?? null,
					fields.issue_url ?? null,
				],
			);
			if (enteringAwaitingReview) {
				this.stampAwaitingReviewEntry(executionId);
			}
			if (preStatus !== undefined && preStatus !== status) {
				this.bumpLifecycleRevision(executionId);
			}
		});
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
			// FLY-728: resolved runner model (per-issue model routing visibility).
			runner_model: "runner_model",
			dispatch_model: "dispatch_model",
			ponytail_condition: "ponytail_condition",
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
			// FLY-205: doc-flow tier + Linear URL (retry continuity)
			doc_tier: "doc_tier",
			issue_url: "issue_url",
			// FLY-598: founder-facing UX gate flag + sign-off record + mode snapshot
			founder_facing_ux: "founder_facing_ux",
			founder_ux_signoff_json: "founder_ux_signoff_json",
			founder_ux_gate_mode: "founder_ux_gate_mode",
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
		// FLY-245 D-a: bump lifecycle revision on a forced status change too (this
		// legacy path must not be a hole in the freshness counter — plan §5.1).
		const preStatus = this.getSession(executionId)?.status;
		// FLY-663 §2.8: forced status + awaiting_review stamp + lifecycle bump are
		// one logical mutation — wrap so no durable partial state on a mid throw.
		this.db.transaction(() => {
			this.db.run(
				`UPDATE sessions SET status = ?, last_activity_at = ?, last_error = ? WHERE execution_id = ?`,
				[status, lastActivityAt, lastError ?? null, executionId],
			);
			if (enteringAwaitingReview) {
				this.stampAwaitingReviewEntry(executionId);
			}
			if (preStatus !== undefined && preStatus !== status) {
				this.bumpLifecycleRevision(executionId);
			}
		});
		this.save();
	}

	setRetrySuccessor(executionId: string, successorId: string): void {
		this.db.run(
			"UPDATE sessions SET retry_successor = ? WHERE execution_id = ?",
			[successorId, executionId],
		);
		this.save();
	}

	// ── FLY-245 D2: retry dispatch intent WAL (plan §5.2.1) ──────────────────

	/**
	 * Durably bind a gateway request id to its pre-bound successor execution id
	 * BEFORE dispatch. Throws on a duplicate request id (the PRIMARY KEY is the
	 * exactly-one-successor guarantee — callers check `getRetryDispatchIntent`
	 * first and treat an existing different binding as a conflict).
	 */
	recordRetryDispatchIntent(
		requestId: string,
		successorExecutionId: string,
		predecessorExecutionId: string,
	): void {
		this.db.run(
			`INSERT INTO retry_dispatch_intents
			 (request_id, successor_execution_id, predecessor_execution_id, state)
			 VALUES (?, ?, ?, 'intent')`,
			[requestId, successorExecutionId, predecessorExecutionId],
		);
		this.save();
	}

	getRetryDispatchIntent(requestId: string): RetryDispatchIntent | undefined {
		const stmt = this.db.prepare(
			"SELECT * FROM retry_dispatch_intents WHERE request_id = ?",
		);
		stmt.bind([requestId]);
		if (stmt.step()) {
			const row = stmt.getAsObject() as unknown as RetryDispatchIntent;
			stmt.free();
			return row;
		}
		stmt.free();
		return undefined;
	}

	/** Mark the intent as dispatched (blueprint.run() kicked off). Informational
	 * only — recovery reconciles against authoritative started evidence, never
	 * this flag (plan §5.2.1 item 4). */
	markRetryDispatchDispatched(requestId: string): void {
		this.db.run(
			"UPDATE retry_dispatch_intents SET state = 'dispatched', updated_at = datetime('now') WHERE request_id = ?",
			[requestId],
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

	/**
	 * FLY-603 Layer B: sessions whose worktree must NOT be reconciled — the
	 * protected status set for a project. `pending` IS included: it is a real
	 * persisted status (schema default; `worktree_ready` upserts a pending
	 * session before `session_started`). Returns rows; the path-authoritative
	 * key derivation happens at composition level (it needs WorktreeManager).
	 */
	listWorktreeProtectionSessions(projectName: string): Session[] {
		const stmt = this.db.prepare(
			"SELECT * FROM sessions WHERE project_name = ? AND status IN ('running', 'awaiting_review', 'approved_to_ship', 'pending')",
		);
		stmt.bind([projectName]);
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
	 * FLY-603 Layer B: all sessions for a project (any status) — candidates for
	 * the independent live-runner probe (a terminal session with a still-live
	 * tmux must keep its worktree).
	 */
	getProjectSessions(projectName: string): Session[] {
		const stmt = this.db.prepare(
			"SELECT * FROM sessions WHERE project_name = ?",
		);
		stmt.bind([projectName]);
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

	/**
	 * FLY-725: main-session ZERO-SIGNAL terminal milestones (failed/blocked) for ONE
	 * project that recently reached that state — the milestone-report patrol
	 * candidate set. `completed` is intentionally excluded (routine completions go
	 * to the FLY-727 digest, not a real-time ping; Annie 2026-07-01 plan §B).
	 * `project_name` is filtered at the SQL boundary (Codex R1 #2: `matchesLead`
	 * alone is not a project boundary — two projects can reuse a lead id). QA runners
	 * (`session_role != 'main'`) are excluded — they produce no founder-facing
	 * milestone. `lookbackHours` bounds the scan window so the patrol does not walk
	 * the entire session history each tick.
	 */
	getRecentTerminalSessionsForNotify(
		projectName: string,
		lookbackHours: number,
	): Session[] {
		const stmt = this.db.prepare(
			`SELECT * FROM sessions
			  WHERE project_name = ?
			    AND status IN ('failed', 'blocked')
			    AND (session_role IS NULL OR session_role = 'main')
			    AND last_activity_at > datetime('now', ?)`,
		);
		stmt.bind([projectName, `-${lookbackHours} hours`]);
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
		// FLY-663 §2.8: delete-stale-then-upsert is one logical mutation — wrap so a
		// crash between the DELETE and the INSERT can't leave the issue thread-less.
		this.db.transaction(() => {
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
		});
		this.save();
	}

	// ── FLY-579 P1: auto-QA record CRUD ──────────────────────────────────────

	private rowToAutoQaRecord(row: Record<string, unknown>): AutoQaRecord {
		return {
			parent_execution_id: row.parent_execution_id as string,
			target_pr_head_sha: row.target_pr_head_sha as string,
			issue_id: row.issue_id as string,
			project_name: row.project_name as string,
			qa_execution_id: (row.qa_execution_id as string) ?? undefined,
			qa_issue_id: (row.qa_issue_id as string) ?? undefined,
			qa_issue_identifier: (row.qa_issue_identifier as string) ?? undefined,
			qa_issue_title: (row.qa_issue_title as string) ?? undefined,
			qa_issue_url: (row.qa_issue_url as string) ?? undefined,
			status: row.status as AutoQaRecord["status"],
			verdict_event_id: (row.verdict_event_id as string) ?? undefined,
			started_at: row.started_at as string,
			completed_at: (row.completed_at as string) ?? undefined,
			notified_at: (row.notified_at as string) ?? undefined,
		};
	}

	/**
	 * Atomically claim a QA record for (parent, head). Returns true if a NEW
	 * record was inserted (caller should spawn QA), false if one already exists
	 * (dedup — QA already claimed/running/done for this exact head). INSERT OR
	 * IGNORE makes the claim race-safe against concurrent awaiting_review events.
	 */
	claimAutoQaRecord(input: {
		parentExecutionId: string;
		targetPrHeadSha: string;
		issueId: string;
		projectName: string;
	}): boolean {
		this.db.run(
			`INSERT OR IGNORE INTO auto_qa_record
			   (parent_execution_id, target_pr_head_sha, issue_id, project_name, status, started_at)
			 VALUES (?, ?, ?, ?, 'running', datetime('now'))`,
			[
				input.parentExecutionId,
				input.targetPrHeadSha,
				input.issueId,
				input.projectName,
			],
		);
		const inserted = this.db.getRowsModified() > 0;
		this.save();
		return inserted;
	}

	setAutoQaQaExecutionId(
		parentExecutionId: string,
		targetPrHeadSha: string,
		qaExecutionId: string,
	): void {
		this.db.run(
			"UPDATE auto_qa_record SET qa_execution_id = ? WHERE parent_execution_id = ? AND target_pr_head_sha = ?",
			[qaExecutionId, parentExecutionId, targetPrHeadSha],
		);
		this.save();
	}

	/**
	 * FLY-643: persist the SEPARATE QA Linear issue this record's QA runs on.
	 * Written immediately after the Linear issue is created and BEFORE the QA
	 * runner spawns, so a crash mid-spawn lets reconcile re-use this QA issue
	 * (re-spawn the runner) instead of creating a duplicate.
	 */
	setAutoQaIssue(
		parentExecutionId: string,
		targetPrHeadSha: string,
		qaIssue: {
			issueId: string;
			issueIdentifier?: string;
			issueTitle?: string;
			issueUrl?: string;
		},
	): void {
		this.db.run(
			`UPDATE auto_qa_record
			    SET qa_issue_id = ?,
			        qa_issue_identifier = ?,
			        qa_issue_title = ?,
			        qa_issue_url = ?
			  WHERE parent_execution_id = ? AND target_pr_head_sha = ?`,
			[
				qaIssue.issueId,
				qaIssue.issueIdentifier ?? null,
				qaIssue.issueTitle ?? null,
				qaIssue.issueUrl ?? null,
				parentExecutionId,
				targetPrHeadSha,
			],
		);
		this.save();
	}

	/**
	 * Transition a record's status. Terminal states (passed/failed/stuck) stamp
	 * completed_at. `notifiedAt: true` stamps notified_at (PASS founder
	 * ship-ready notification sent — release dedup). verdictEventId is the
	 * qa_result event id (idempotency anchor against duplicate verdicts).
	 */
	setAutoQaStatus(
		parentExecutionId: string,
		targetPrHeadSha: string,
		status: AutoQaRecord["status"],
		opts: { verdictEventId?: string; notifiedAt?: boolean },
	): void {
		const terminal =
			status === "passed" || status === "failed" || status === "stuck";
		this.db.run(
			`UPDATE auto_qa_record
			    SET status = ?,
			        verdict_event_id = COALESCE(?, verdict_event_id),
			        completed_at = CASE WHEN ? THEN datetime('now') ELSE completed_at END,
			        notified_at = CASE WHEN ? THEN datetime('now') ELSE notified_at END
			  WHERE parent_execution_id = ? AND target_pr_head_sha = ?`,
			[
				status,
				opts.verdictEventId ?? null,
				terminal ? 1 : 0,
				opts.notifiedAt ? 1 : 0,
				parentExecutionId,
				targetPrHeadSha,
			],
		);
		this.save();
	}

	/** Mark all of a parent's still-running records superseded EXCEPT keepSha. */
	supersedeOtherAutoQaRecords(
		parentExecutionId: string,
		keepSha: string,
	): void {
		this.db.run(
			`UPDATE auto_qa_record SET status = 'superseded'
			  WHERE parent_execution_id = ? AND target_pr_head_sha != ? AND status = 'running'`,
			[parentExecutionId, keepSha],
		);
		this.save();
	}

	getAutoQaRecord(
		parentExecutionId: string,
		targetPrHeadSha: string,
	): AutoQaRecord | undefined {
		const stmt = this.db.prepare(
			"SELECT * FROM auto_qa_record WHERE parent_execution_id = ? AND target_pr_head_sha = ?",
		);
		stmt.bind([parentExecutionId, targetPrHeadSha]);
		let rec: AutoQaRecord | undefined;
		if (stmt.step()) {
			rec = this.rowToAutoQaRecord(
				stmt.getAsObject() as Record<string, unknown>,
			);
		}
		stmt.free();
		return rec;
	}

	getAutoQaRecordByQaExec(qaExecutionId: string): AutoQaRecord | undefined {
		const stmt = this.db.prepare(
			"SELECT * FROM auto_qa_record WHERE qa_execution_id = ?",
		);
		stmt.bind([qaExecutionId]);
		let rec: AutoQaRecord | undefined;
		if (stmt.step()) {
			rec = this.rowToAutoQaRecord(
				stmt.getAsObject() as Record<string, unknown>,
			);
		}
		stmt.free();
		return rec;
	}

	listAutoQaRecordsByParent(parentExecutionId: string): AutoQaRecord[] {
		const stmt = this.db.prepare(
			"SELECT * FROM auto_qa_record WHERE parent_execution_id = ? ORDER BY started_at",
		);
		stmt.bind([parentExecutionId]);
		const out: AutoQaRecord[] = [];
		while (stmt.step()) {
			out.push(
				this.rowToAutoQaRecord(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return out;
	}

	listRunningAutoQaRecords(): AutoQaRecord[] {
		const stmt = this.db.prepare(
			"SELECT * FROM auto_qa_record WHERE status = 'running' ORDER BY started_at",
		);
		const out: AutoQaRecord[] = [];
		while (stmt.step()) {
			out.push(
				this.rowToAutoQaRecord(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return out;
	}

	/** Records that PASSED QA but whose founder ship-ready notification was
	 * never confirmed (notified_at IS NULL) — reconcile re-notifies these so a
	 * crash between status=passed and the notification can't strand the change. */
	listPassedUnnotifiedAutoQaRecords(): AutoQaRecord[] {
		const stmt = this.db.prepare(
			"SELECT * FROM auto_qa_record WHERE status = 'passed' AND notified_at IS NULL ORDER BY started_at",
		);
		const out: AutoQaRecord[] = [];
		while (stmt.step()) {
			out.push(
				this.rowToAutoQaRecord(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return out;
	}

	getChatThreadByIssue(
		issueId: string,
		channelId: string,
	):
		| {
				thread_id: string;
				channel_id: string;
				lead_id: string | null;
				archived_at: string | null;
		  }
		| undefined {
		const stmt = this.db.prepare(
			"SELECT thread_id, channel_id, lead_id, archived_at FROM chat_threads WHERE issue_id = ? AND channel_id = ? AND discord_missing_at IS NULL",
		);
		stmt.bind([issueId, channelId]);
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			stmt.free();
			return {
				thread_id: row.thread_id as string,
				channel_id: row.channel_id as string,
				lead_id: (row.lead_id as string) ?? null,
				archived_at: (row.archived_at as string) ?? null,
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

	/**
	 * FLY-369: mark a chat thread archived (archive-once record). The on-demand
	 * archive endpoint treats a thread with `archived_at` set as already
	 * archived and does not re-archive it, so if Annie re-opens it (Discord
	 * auto-unarchives on a new message) we do not fight her.
	 */
	markChatThreadArchived(threadId: string): void {
		this.db.run(
			"UPDATE chat_threads SET archived_at = datetime('now') WHERE thread_id = ?",
			[threadId],
		);
		this.save();
	}

	/**
	 * FLY-560 Feature C: record the runner-attach pinned-message state for an
	 * issue's chat thread. `pinnedAt` is set (ISO/datetime string) ONLY after a
	 * pin is confirmed; left null when the message is posted but not yet pinned
	 * (e.g. pin 403) so the next stage retries the pin (self-heal).
	 */
	setChatThreadAttachPin(
		issueId: string,
		channelId: string,
		state: { messageId: string; command: string; pinnedAt: string | null },
	): void {
		this.db.run(
			`UPDATE chat_threads
			 SET attach_pin_message_id = ?, attach_pin_command = ?, attach_pin_pinned_at = ?
			 WHERE issue_id = ? AND channel_id = ?`,
			[
				state.messageId,
				state.command,
				state.pinnedAt ?? null,
				issueId,
				channelId,
			],
		);
		this.save();
	}

	getChatThreadAttachPin(
		issueId: string,
		channelId: string,
	):
		| { messageId: string; command: string; pinnedAt: string | null }
		| undefined {
		const stmt = this.db.prepare(
			"SELECT attach_pin_message_id, attach_pin_command, attach_pin_pinned_at FROM chat_threads WHERE issue_id = ? AND channel_id = ?",
		);
		stmt.bind([issueId, channelId]);
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			stmt.free();
			const messageId = (row.attach_pin_message_id as string) ?? null;
			if (!messageId) return undefined; // no pin recorded yet
			return {
				messageId,
				command: (row.attach_pin_command as string) ?? "",
				pinnedAt: (row.attach_pin_pinned_at as string) ?? null,
			};
		}
		stmt.free();
		return undefined;
	}

	/** FLY-560 Feature C: clear the attach-pin record (e.g. message deleted). */
	clearChatThreadAttachPin(issueId: string, channelId: string): void {
		this.db.run(
			`UPDATE chat_threads
			 SET attach_pin_message_id = NULL, attach_pin_command = NULL, attach_pin_pinned_at = NULL
			 WHERE issue_id = ? AND channel_id = ?`,
			[issueId, channelId],
		);
		this.save();
	}

	// ── FLY-368: alert_threads (unified-alert per-error thread, active-mapping) ──

	/**
	 * FLY-368: open OR replace the active alert thread for a correlation key.
	 * Active-mapping semantics: a second call with a DIFFERENT event_id under the
	 * same correlation_key OVERWRITES the mapping (the caller must resolve+archive
	 * the prior Discord thread BEFORE calling this; this only owns the row). The
	 * UPSERT clears resolved_at so the row is active again.
	 */
	openAlertThread(input: {
		correlationKey: string;
		eventId: string;
		episodeSignature?: string | null;
		threadId: string;
		rootMessageId?: string | null;
		channelId: string;
		leadId: string;
		projectName: string;
		eventType: string;
		sessionKey?: string | null;
		repairStatus?: string | null;
	}): void {
		this.db.run(
			`INSERT INTO alert_threads (
				correlation_key, event_id, episode_signature, thread_id, root_message_id,
				channel_id, lead_id, project_name, event_type, session_key, repair_status,
				opened_at, resolved_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), NULL)
			ON CONFLICT(correlation_key) DO UPDATE SET
				event_id = excluded.event_id,
				episode_signature = excluded.episode_signature,
				thread_id = excluded.thread_id,
				root_message_id = excluded.root_message_id,
				channel_id = excluded.channel_id,
				lead_id = excluded.lead_id,
				project_name = excluded.project_name,
				event_type = excluded.event_type,
				session_key = excluded.session_key,
				repair_status = excluded.repair_status,
				opened_at = datetime('now'),
				resolved_at = NULL`,
			[
				input.correlationKey,
				input.eventId,
				input.episodeSignature ?? null,
				input.threadId,
				input.rootMessageId ?? null,
				input.channelId,
				input.leadId,
				input.projectName,
				input.eventType,
				input.sessionKey ?? null,
				input.repairStatus ?? null,
			],
		);
		this.save();
	}

	/** FLY-368: the ACTIVE (unresolved) alert thread for a correlation key, if any. */
	getActiveAlertThread(correlationKey: string): AlertThreadRow | undefined {
		const stmt = this.db.prepare(
			"SELECT * FROM alert_threads WHERE correlation_key = ? AND resolved_at IS NULL",
		);
		stmt.bind([correlationKey]);
		let out: AlertThreadRow | undefined;
		if (stmt.step()) {
			out = rowToAlertThread(stmt.getAsObject() as Record<string, unknown>);
		}
		stmt.free();
		return out;
	}

	/** FLY-368: all ACTIVE alert threads (the reconcile-pass work list). */
	listActiveAlertThreads(): AlertThreadRow[] {
		const stmt = this.db.prepare(
			"SELECT * FROM alert_threads WHERE resolved_at IS NULL ORDER BY opened_at ASC",
		);
		const out: AlertThreadRow[] = [];
		while (stmt.step()) {
			out.push(rowToAlertThread(stmt.getAsObject() as Record<string, unknown>));
		}
		stmt.free();
		return out;
	}

	/** FLY-368: update repair_status on the active row (pending|fixed|needs_human|n/a). */
	setAlertRepairStatus(correlationKey: string, status: string): void {
		this.db.run(
			"UPDATE alert_threads SET repair_status = ? WHERE correlation_key = ? AND resolved_at IS NULL",
			[status, correlationKey],
		);
		this.save();
	}

	/** FLY-368: mark the active alert thread resolved (recovery confirmed). */
	resolveAlertThread(correlationKey: string): void {
		this.db.run(
			"UPDATE alert_threads SET resolved_at = datetime('now') WHERE correlation_key = ? AND resolved_at IS NULL",
			[correlationKey],
		);
		this.save();
	}

	/**
	 * FLY-368: append a durable auto-repair attempt audit row. Returns true on
	 * success, false on write failure — callers treat false as FAIL-CLOSED (no
	 * keystroke is sent unless the `attempt` row persisted).
	 */
	recordAlertRepairAttempt(input: {
		correlationKey: string;
		eventId?: string | null;
		actor: string;
		action: string;
		leadId?: string | null;
		projectName?: string | null;
		result: "attempt" | "sent" | "refused";
		reason?: string | null;
	}): boolean {
		try {
			this.db.run(
				`INSERT INTO alert_repair_attempts (
					correlation_key, event_id, actor, action, lead_id, project_name, result, reason
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					input.correlationKey,
					input.eventId ?? null,
					input.actor,
					input.action,
					input.leadId ?? null,
					input.projectName ?? null,
					input.result,
					input.reason ?? null,
				],
			);
			this.save();
			return true;
		} catch {
			return false;
		}
	}

	// ── FLY-314: roundtable_topic_threads (separate from chat_threads) ──────────

	/**
	 * FLY-314: record a roundtable topic thread. `threadId` MUST equal the source
	 * Discord message id (the "start thread from message" invariant), which is also
	 * the crash-recovery anchor. Idempotent on thread_id.
	 */
	upsertRoundtableTopicThread(input: {
		threadId: string;
		channelId: string;
		sourceMessageId: string;
		authorId?: string;
		triggerMode?: string;
	}): void {
		this.db.run(
			`INSERT INTO roundtable_topic_threads
				(thread_id, channel_id, source_message_id, author_id, trigger_mode)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(thread_id) DO UPDATE SET
				channel_id = excluded.channel_id,
				source_message_id = excluded.source_message_id,
				author_id = excluded.author_id,
				trigger_mode = excluded.trigger_mode`,
			[
				input.threadId,
				input.channelId,
				input.sourceMessageId,
				input.authorId ?? null,
				input.triggerMode ?? null,
			],
		);
		this.save();
	}

	/** FLY-314: dedup lookup by (channel, source message). Excludes rows marked
	 * discord_missing so a deleted thread can be re-created if the topic recurs. */
	getRoundtableTopicThread(
		channelId: string,
		sourceMessageId: string,
	):
		| {
				thread_id: string;
				channel_id: string;
				source_message_id: string;
				author_id: string | null;
				archived_at: string | null;
		  }
		| undefined {
		const stmt = this.db.prepare(
			"SELECT thread_id, channel_id, source_message_id, author_id, archived_at FROM roundtable_topic_threads WHERE channel_id = ? AND source_message_id = ? AND discord_missing_at IS NULL",
		);
		stmt.bind([channelId, sourceMessageId]);
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			stmt.free();
			return {
				thread_id: row.thread_id as string,
				channel_id: row.channel_id as string,
				source_message_id: row.source_message_id as string,
				author_id: (row.author_id as string) ?? null,
				archived_at: (row.archived_at as string) ?? null,
			};
		}
		stmt.free();
		return undefined;
	}

	/** FLY-314: mark a roundtable topic thread missing (Discord 404). */
	markRoundtableTopicThreadMissing(threadId: string): void {
		this.db.run(
			"UPDATE roundtable_topic_threads SET discord_missing_at = datetime('now') WHERE thread_id = ?",
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
			// FLY-728: resolved runner model (per-issue model routing visibility).
			runner_model: (row.runner_model as string) ?? undefined,
			dispatch_model: (row.dispatch_model as string) ?? undefined,
			ponytail_condition: (row.ponytail_condition as string) ?? undefined,
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
			// FLY-205: doc-flow tier + Linear URL (retry continuity)
			doc_tier: (row.doc_tier as string) ?? undefined,
			issue_url: (row.issue_url as string) ?? undefined,
			// FLY-598: founder-facing UX gate flag + sign-off record
			founder_facing_ux: row.founder_facing_ux
				? !!(row.founder_facing_ux as number)
				: undefined,
			founder_ux_signoff_json:
				(row.founder_ux_signoff_json as string) ?? undefined,
			founder_ux_gate_mode: (row.founder_ux_gate_mode as string) ?? undefined,
			// FLY-245 D-a: monotonic lifecycle revision (defaults 0).
			lifecycle_revision:
				typeof row.lifecycle_revision === "number" ? row.lifecycle_revision : 0,
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
		return this.stuckRowFromValues(row);
	}

	/**
	 * FLY-253 (L2): read BOTH disposition rows that can govern one episode —
	 * the exact (episode_fingerprint = fp) row and the execution-scoped
	 * sentinel (episode_fingerprint = '*') row. The detector picks between
	 * them with a precedence rule evaluated against `now` (effective exact >
	 * effective sentinel > expired — Codex R1 #3: an unconditional exact-first
	 * LIMIT 1 would let an expired exact snooze shadow an active sentinel
	 * legitimate_wait and re-open the alert treadmill).
	 */
	getStuckDispositionRows(
		executionId: string,
		episodeFingerprint: string,
	): { exact?: StuckDispositionRow; sentinel?: StuckDispositionRow } {
		const result = this.db.exec(
			`SELECT execution_id, episode_fingerprint, disposition, snooze_until_ms,
			        noted_by, note, created_at
			 FROM stuck_dispositions
			 WHERE execution_id = ? AND episode_fingerprint IN (?, '*')`,
			[executionId, episodeFingerprint],
		);
		const out: { exact?: StuckDispositionRow; sentinel?: StuckDispositionRow } =
			{};
		for (const values of result[0]?.values ?? []) {
			const row = this.stuckRowFromValues(values);
			if (row.episode_fingerprint === "*") out.sentinel = row;
			else out.exact = row;
		}
		return out;
	}

	/**
	 * FLY-253 (L2, re_arm): delete ALL governing receipts for this execution —
	 * the '*' sentinel AND every episode-scoped row (Codex code R1 HIGH-1: an
	 * effective exact row on the SAME frozen fingerprint would otherwise keep
	 * suppressing after re_arm, and a Bridge restart would not fix it).
	 * re_arm means "I want detection live again" — stale frame judgments go
	 * with it. No audit is lost: every disposition wrote a session_events
	 * trace row; stuck_dispositions is the live suppression state, not the
	 * audit trail. The route layer pairs this with the detector's
	 * `rearmExecution()` so the in-memory episode is reset too.
	 */
	clearExecutionStuckReceipts(executionId: string): void {
		this.db.run(`DELETE FROM stuck_dispositions WHERE execution_id = ?`, [
			executionId,
		]);
		this.save();
	}

	/**
	 * FLY-253 (L2, reminder reset): consume CURRENTLY-EXPIRED timed rows among
	 * {exact fp, '*'} for this execution — an expired receipt is a ONE-SHOT
	 * reminder token (Codex R2 #2: leaving it in place re-resets the episode
	 * on every grace expiry → infinite Lead reminders, Annie never paged).
	 *
	 * The `snooze_until_ms <= :now` predicate is the concurrency guard: a row
	 * the Lead refreshed (new future expiry) between read and consume is NOT
	 * deleted. Untimed rows (NULL) are terminal receipts and never consumed.
	 */
	consumeExpiredStuckDispositions(
		executionId: string,
		episodeFingerprint: string,
		nowMs: number,
	): void {
		this.db.run(
			`DELETE FROM stuck_dispositions
			 WHERE execution_id = ?
			 AND episode_fingerprint IN (?, '*')
			 AND snooze_until_ms IS NOT NULL
			 AND snooze_until_ms <= ?`,
			[executionId, episodeFingerprint, nowMs],
		);
		this.save();
	}

	/** Map a raw stuck_dispositions row tuple to the typed shape. */
	private stuckRowFromValues(row: unknown[]): StuckDispositionRow {
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

	// --- FLY-637 #3/#4: persistent quiet-wake "already-notified" dedup ---

	/**
	 * True when the Lead was already woken about this exact frozen frame
	 * (execution + source + episode fingerprint). Used by both stall watchdogs to
	 * suppress a repeat wake across cosmetic pane jitter AND across a Bridge
	 * restart (the in-memory dedup sets are wiped on restart; this row is not).
	 */
	hasQuietWakeNotified(
		executionId: string,
		source: string,
		episodeFingerprint: string,
	): boolean {
		const result = this.db.exec(
			`SELECT 1 FROM quiet_wake_notified
			 WHERE execution_id = ? AND source = ? AND episode_fingerprint = ?`,
			[executionId, source, episodeFingerprint],
		);
		return (result[0]?.values.length ?? 0) > 0;
	}

	/**
	 * Record that the Lead was woken about this frozen frame. Idempotent
	 * (INSERT OR IGNORE on the composite PK). Callers MUST only record AFTER the
	 * wake event was actually persisted (FLY-637 R1 #2): recording a wake that
	 * never reached the guardrail journal would durably suppress a real one.
	 */
	recordQuietWakeNotified(
		executionId: string,
		source: string,
		episodeFingerprint: string,
	): void {
		this.db.run(
			`INSERT OR IGNORE INTO quiet_wake_notified
			   (execution_id, source, episode_fingerprint)
			 VALUES (?, ?, ?)`,
			[executionId, source, episodeFingerprint],
		);
		this.save();
	}

	/**
	 * Clear the quiet-wake dedup rows for one execution — all sources, or just
	 * the given source. Called when a session recovers / leaves the watchdog
	 * surface so a genuinely-new later episode starts clean.
	 */
	clearQuietWakeNotified(executionId: string, source?: string): void {
		if (source) {
			this.db.run(
				`DELETE FROM quiet_wake_notified WHERE execution_id = ? AND source = ?`,
				[executionId, source],
			);
		} else {
			this.db.run(`DELETE FROM quiet_wake_notified WHERE execution_id = ?`, [
				executionId,
			]);
		}
		this.save();
	}

	/**
	 * Prune quiet-wake dedup rows for a source: delete every row whose
	 * `execution_id` is NOT in `keepExecIds`. Each watchdog calls this with its
	 * OWN surface set (idle → the running sessions it polls; stuck → the current
	 * `getStuckSessions` set) so a session that left the surface drops its rows.
	 *
	 * Empty-set guard (FLY-637 R1 #4): `keepExecIds = []` means "keep none" →
	 * delete ALL rows for the source, instead of emitting an invalid `IN ()`.
	 */
	pruneQuietWakeNotifiedNotIn(source: string, keepExecIds: string[]): void {
		if (keepExecIds.length === 0) {
			this.db.run(`DELETE FROM quiet_wake_notified WHERE source = ?`, [source]);
		} else {
			const placeholders = keepExecIds.map(() => "?").join(",");
			this.db.run(
				`DELETE FROM quiet_wake_notified
				 WHERE source = ? AND execution_id NOT IN (${placeholders})`,
				[source, ...keepExecIds],
			);
		}
		// FLY-637 (Codex code R1 LOW-1): prune runs every heartbeat (5m) / idle poll,
		// usually a no-op. Only flush the sql.js DB to disk when rows actually
		// changed — avoids a recurring whole-DB export for the common empty case.
		if (this.db.getRowsModified() > 0) this.save();
	}

	// --- FLY-637-ext: lead-pending escalation durable backoff state ---

	/** Read the backoff row for one (execution, blocking question), or undefined. */
	getLeadPendingEscalation(
		executionId: string,
		questionId: string,
	): LeadNudgeRow | undefined {
		const result = this.db.exec(
			`SELECT stuck_key, nudge_count, last_nudge_at_ms, next_eligible_at_ms, paged_annie
			 FROM lead_pending_escalation
			 WHERE execution_id = ? AND question_id = ?`,
			[executionId, questionId],
		);
		const row = result[0]?.values[0];
		if (!row) return undefined;
		return {
			stuck_key: row[0] as string,
			nudge_count: row[1] as number,
			last_nudge_at_ms: row[2] as number,
			next_eligible_at_ms: row[3] as number,
			paged_annie: (row[4] as number) === 1,
		};
	}

	/** Upsert the backoff row. Caller commits AFTER the nudge/alert is accepted (R1 #5). */
	upsertLeadPendingEscalation(
		executionId: string,
		questionId: string,
		row: LeadNudgeRow,
	): void {
		this.db.run(
			`INSERT INTO lead_pending_escalation
			   (execution_id, question_id, stuck_key, nudge_count, last_nudge_at_ms, next_eligible_at_ms, paged_annie)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(execution_id, question_id) DO UPDATE SET
			   stuck_key = excluded.stuck_key,
			   nudge_count = excluded.nudge_count,
			   last_nudge_at_ms = excluded.last_nudge_at_ms,
			   next_eligible_at_ms = excluded.next_eligible_at_ms,
			   paged_annie = excluded.paged_annie`,
			[
				executionId,
				questionId,
				row.stuck_key,
				row.nudge_count,
				row.last_nudge_at_ms,
				row.next_eligible_at_ms,
				row.paged_annie ? 1 : 0,
			],
		);
		this.save();
	}

	/** Clear one question's row, or all of a runner's rows (question answered / gone). */
	clearLeadPendingEscalation(executionId: string, questionId?: string): void {
		if (questionId) {
			this.db.run(
				`DELETE FROM lead_pending_escalation WHERE execution_id = ? AND question_id = ?`,
				[executionId, questionId],
			);
		} else {
			this.db.run(
				`DELETE FROM lead_pending_escalation WHERE execution_id = ?`,
				[executionId],
			);
		}
		this.save();
	}

	/**
	 * Prune rows whose `question_id` is NOT in the current active pending set —
	 * a question that was answered / evicted drops its escalation state so a later
	 * genuine episode starts clean. Empty set ⇒ clear all (no `IN ()`).
	 */
	pruneLeadPendingEscalationNotIn(activeQuestionIds: string[]): void {
		if (activeQuestionIds.length === 0) {
			this.db.run(`DELETE FROM lead_pending_escalation`);
		} else {
			const placeholders = activeQuestionIds.map(() => "?").join(",");
			this.db.run(
				`DELETE FROM lead_pending_escalation WHERE question_id NOT IN (${placeholders})`,
				activeQuestionIds,
			);
		}
		if (this.db.getRowsModified() > 0) this.save();
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

	/** FLY-369: add archived_at to chat_threads on legacy DBs (idempotent). */
	private migrateChatThreadsArchivedColumn(): void {
		try {
			const info = this.db.exec("PRAGMA table_info(chat_threads)");
			if (info.length === 0) return;
			const columns = info[0]!.values.map((row) => row[1] as string);
			if (!columns.includes("archived_at")) {
				this.db.run("ALTER TABLE chat_threads ADD COLUMN archived_at TEXT");
			}
		} catch {
			// Table may not exist yet (first run) — CREATE TABLE will handle it
		}
	}

	/**
	 * FLY-560 Feature C: add the runner-attach pin columns to chat_threads on
	 * legacy DBs (idempotent). Mirrors migrateChatThreadsArchivedColumn.
	 */
	private migrateChatThreadsAttachPinColumns(): void {
		try {
			const info = this.db.exec("PRAGMA table_info(chat_threads)");
			if (info.length === 0) return;
			const columns = info[0]!.values.map((row) => row[1] as string);
			if (!columns.includes("attach_pin_message_id")) {
				this.db.run(
					"ALTER TABLE chat_threads ADD COLUMN attach_pin_message_id TEXT",
				);
			}
			if (!columns.includes("attach_pin_command")) {
				this.db.run(
					"ALTER TABLE chat_threads ADD COLUMN attach_pin_command TEXT",
				);
			}
			if (!columns.includes("attach_pin_pinned_at")) {
				this.db.run(
					"ALTER TABLE chat_threads ADD COLUMN attach_pin_pinned_at TEXT",
				);
			}
		} catch {
			// Table may not exist yet (first run) — CREATE TABLE will handle it
		}
	}

	/**
	 * FLY-643: add the separate-QA-issue columns to auto_qa_record on legacy DBs
	 * (idempotent). Mirrors migrateChatThreads*Columns. A pre-FLY-643 record has
	 * NULLs here (no QA issue yet) — coordinator treats absent qa_issue_id as
	 * "not created" and creates one.
	 */
	private migrateAutoQaRecordQaIssueColumns(): void {
		try {
			const info = this.db.exec("PRAGMA table_info(auto_qa_record)");
			if (info.length === 0) return;
			const columns = info[0]!.values.map((row) => row[1] as string);
			for (const col of [
				"qa_issue_id",
				"qa_issue_identifier",
				"qa_issue_title",
				"qa_issue_url",
			]) {
				if (!columns.includes(col)) {
					this.db.run(`ALTER TABLE auto_qa_record ADD COLUMN ${col} TEXT`);
				}
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

/** FLY-368: a row of the alert_threads active-mapping table. */
export interface AlertThreadRow {
	correlation_key: string;
	event_id: string;
	episode_signature: string | null;
	thread_id: string;
	root_message_id: string | null;
	channel_id: string;
	lead_id: string;
	project_name: string;
	event_type: string;
	session_key: string | null;
	repair_status: string | null;
	opened_at: string;
	resolved_at: string | null;
}

function rowToAlertThread(row: Record<string, unknown>): AlertThreadRow {
	return {
		correlation_key: row.correlation_key as string,
		event_id: row.event_id as string,
		episode_signature: (row.episode_signature as string) ?? null,
		thread_id: row.thread_id as string,
		root_message_id: (row.root_message_id as string) ?? null,
		channel_id: row.channel_id as string,
		lead_id: row.lead_id as string,
		project_name: row.project_name as string,
		event_type: row.event_type as string,
		session_key: (row.session_key as string) ?? null,
		repair_status: (row.repair_status as string) ?? null,
		opened_at: row.opened_at as string,
		resolved_at: (row.resolved_at as string) ?? null,
	};
}
