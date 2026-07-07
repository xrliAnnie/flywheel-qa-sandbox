import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { Message, Session } from "./types.js";
import { deleteContentRef as deleteContentRefFile } from "./utils/content-ref.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  from_agent  TEXT NOT NULL,
  to_agent    TEXT NOT NULL,
  type        TEXT NOT NULL CHECK(type IN ('question','response','instruction','progress')),
  content     TEXT NOT NULL,
  parent_id   TEXT,
  read_at     DATETIME,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at  DATETIME NOT NULL DEFAULT (datetime('now', '+72 hours')),
  FOREIGN KEY (parent_id) REFERENCES messages(id)
);
CREATE TABLE IF NOT EXISTS sessions (
  execution_id  TEXT PRIMARY KEY,
  tmux_window   TEXT NOT NULL,
  project_name  TEXT NOT NULL,
  issue_id      TEXT,
  lead_id       TEXT,
  started_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  ended_at      DATETIME,
  status        TEXT DEFAULT 'running' CHECK(status IN ('running','completed','timeout'))
);
CREATE TABLE IF NOT EXISTS runner_declared_states (
  execution_id  TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK(kind IN ('parked','long_task')),
  reason        TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER,
  updated_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS three_stage_turn (
  issue_id        TEXT PRIMARY KEY,
  holder_exec_id  TEXT NOT NULL,
  phase           TEXT NOT NULL,
  epoch           INTEGER NOT NULL,
  granted_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_response ON messages(parent_id) WHERE type = 'response';
CREATE INDEX IF NOT EXISTS idx_messages_to_agent ON messages(to_agent, type, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id);
CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_name);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
`;

/**
 * FLY-626: a runner's self-declared liveness intent. `parked` = done-but-alive
 * (idle by design, kept for iteration; may be indefinite — `expires_at` null).
 * `long_task` = actively working on something that legitimately produces no pane
 * activity for a while (codex review, big build) — always bounded by `expires_at`.
 * Timestamps are epoch milliseconds (Codex R2 LOW #3).
 */
export interface RunnerDeclaredState {
	execution_id: string;
	kind: "parked" | "long_task";
	reason: string | null;
	created_at: number;
	expires_at: number | null;
	updated_at: number;
}

/**
 * FLY-887: the three-stage TURN — which phase-session (identified by its
 * `holder_exec_id`) currently holds the exclusive right to touch the shared
 * worktree for `issue_id`. `epoch` monotonically increases on every re-grant so
 * a late/duplicated wake carrying a stale epoch can be recognized as such. Only
 * the Bridge writes this table (`grantTurn`); runners read it (`getTurn` via the
 * `turn` subcommand) before writing. Timestamps are epoch milliseconds.
 */
export interface ThreeStageTurn {
	issue_id: string;
	holder_exec_id: string;
	phase: string;
	epoch: number;
	granted_at: number;
}

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
		this.applyMigrations();
		this.purgeExpired();
	}

	/**
	 * Open the database in read-only mode for lightweight polling.
	 * Skips schema creation, migrations, and purge.
	 * Used by TmuxAdapter poll loop for dynamic timeout checks.
	 */
	static openReadonly(dbPath: string): CommDB {
		const instance = Object.create(CommDB.prototype) as CommDB;
		instance.db = new Database(dbPath, { readonly: true });
		instance.db.pragma("busy_timeout = 5000");
		return instance;
	}

	private applyMigrations(): void {
		const columns = this.db
			.prepare("PRAGMA table_info(messages)")
			.all() as Array<{ name: string }>;

		if (!columns.some((c) => c.name === "read_at")) {
			this.db.exec("ALTER TABLE messages ADD COLUMN read_at DATETIME");
		}
		if (!columns.some((c) => c.name === "checkpoint")) {
			this.db.exec("ALTER TABLE messages ADD COLUMN checkpoint TEXT");
		}
		if (!columns.some((c) => c.name === "content_ref")) {
			this.db.exec("ALTER TABLE messages ADD COLUMN content_ref TEXT");
		}
		if (!columns.some((c) => c.name === "content_type")) {
			this.db.exec(
				"ALTER TABLE messages ADD COLUMN content_type TEXT DEFAULT 'text'",
			);
		}
		if (!columns.some((c) => c.name === "resolved_at")) {
			this.db.exec("ALTER TABLE messages ADD COLUMN resolved_at DATETIME");
		}
		if (!columns.some((c) => c.name === "delivered_at")) {
			// FLY-109: ALTER is not atomic w.r.t. the PRAGMA read above, so two
			// concurrent openers of the same DB can both pass the guard and race
			// on ADD COLUMN. Swallow the racing side's "duplicate column" error —
			// the column is present either way, which is all we need.
			try {
				this.db.exec("ALTER TABLE messages ADD COLUMN delivered_at DATETIME");
			} catch (err) {
				const msg = (err as Error).message ?? "";
				if (!/duplicate column name: delivered_at/i.test(msg)) {
					throw err;
				}
			}
		}
		if (!columns.some((c) => c.name === "attachments")) {
			// GEO-151: ProofShot artifact paths stored as JSON-encoded string[].
			// Same race-tolerance pattern as delivered_at above.
			try {
				this.db.exec("ALTER TABLE messages ADD COLUMN attachments TEXT");
			} catch (err) {
				const msg = (err as Error).message ?? "";
				if (!/duplicate column name: attachments/i.test(msg)) {
					throw err;
				}
			}
		}
		this.db.exec(
			"CREATE INDEX IF NOT EXISTS idx_messages_checkpoint ON messages(checkpoint) WHERE checkpoint IS NOT NULL",
		);
	}

	purgeExpired(): number {
		return this.purgeExpiredWithRefs();
	}

	purgeExpiredWithRefs(): number {
		// Collect content_ref files from both expired messages and their children
		const refs = this.db
			.prepare(
				`SELECT content_ref FROM messages
				 WHERE (expires_at < datetime('now')
				    OR parent_id IN (SELECT id FROM messages WHERE expires_at < datetime('now')))
				   AND content_ref IS NOT NULL`,
			)
			.all() as Array<{ content_ref: string }>;
		for (const { content_ref } of refs) {
			deleteContentRefFile(content_ref);
		}
		// FLY-80: Delete child messages (responses) before parents to satisfy FK constraint.
		// better-sqlite3 enforces foreign_keys=ON by default.
		const childResult = this.db
			.prepare(
				"DELETE FROM messages WHERE parent_id IN (SELECT id FROM messages WHERE expires_at < datetime('now'))",
			)
			.run();
		const parentResult = this.db
			.prepare("DELETE FROM messages WHERE expires_at < datetime('now')")
			.run();
		return childResult.changes + parentResult.changes;
	}

	cleanupReadMessages(ttlHours = 24): number {
		return this.cleanupReadMessagesWithRefs(ttlHours);
	}

	cleanupReadMessagesWithRefs(ttlHours = 24): number {
		const cleanupCondition = `read_at IS NOT NULL AND created_at < datetime('now', '-' || ? || ' hours')`;
		const refs = this.db
			.prepare(
				`SELECT content_ref FROM messages
			 WHERE (${cleanupCondition}
			    OR parent_id IN (SELECT id FROM messages WHERE ${cleanupCondition}))
			 AND content_ref IS NOT NULL`,
			)
			.all(ttlHours, ttlHours) as Array<{ content_ref: string }>;
		for (const { content_ref } of refs) {
			deleteContentRefFile(content_ref);
		}
		// FLY-80: Delete child messages before parents to satisfy FK constraint
		const childResult = this.db
			.prepare(
				`DELETE FROM messages WHERE parent_id IN (SELECT id FROM messages WHERE ${cleanupCondition})`,
			)
			.run(ttlHours);
		const parentResult = this.db
			.prepare(`DELETE FROM messages WHERE ${cleanupCondition}`)
			.run(ttlHours);
		return childResult.changes + parentResult.changes;
	}

	insertQuestion(
		fromAgent: string,
		toAgent: string,
		content: string,
		opts?: {
			checkpoint?: string;
			contentRef?: string;
			contentType?: "text" | "ref";
			/** FLY-245 D-b: override the default +72h TTL with a custom window (e.g.
			 * a minutes-scale runner-lifecycle confirmation, plan §5.1). A
			 * non-positive/non-finite value falls back to the schema default. */
			ttlSeconds?: number;
		},
	): string {
		const id = randomUUID();
		const ttl = opts?.ttlSeconds;
		const customTtl =
			typeof ttl === "number" && Number.isFinite(ttl) && ttl > 0;
		if (customTtl) {
			this.db
				.prepare(
					`INSERT INTO messages (id, from_agent, to_agent, type, content, checkpoint, content_ref, content_type, expires_at)
         VALUES (?, ?, ?, 'question', ?, ?, ?, ?, datetime('now', ?))`,
				)
				.run(
					id,
					fromAgent,
					toAgent,
					content,
					opts?.checkpoint ?? null,
					opts?.contentRef ?? null,
					opts?.contentType ?? "text",
					`+${Math.floor(ttl as number)} seconds`,
				);
		} else {
			// Default-TTL path (byte-compat with the pre-FLY-245 schema default).
			this.db
				.prepare(
					`INSERT INTO messages (id, from_agent, to_agent, type, content, checkpoint, content_ref, content_type)
         VALUES (?, ?, ?, 'question', ?, ?, ?, ?)`,
				)
				.run(
					id,
					fromAgent,
					toAgent,
					content,
					opts?.checkpoint ?? null,
					opts?.contentRef ?? null,
					opts?.contentType ?? "text",
				);
		}
		return id;
	}

	/**
	 * FLY-245 D-b: atomically CLAIM a runner-lifecycle consent for execution.
	 * `resolveGate` is an unconditional UPDATE (can't prevent a double-consume), so
	 * lifecycle execution uses this conditional claim: set `resolved_at` ONLY if the
	 * question is still un-consumed and un-expired, scoped to the expected
	 * `runner_lifecycle:<action>` checkpoint. Returns true ONLY for the single
	 * caller that won the claim (`changes === 1`) — at-most-once consumption of a
	 * confirmation (a terminate is irreversible, so this is stronger than the
	 * idempotent merge/ship path). Plan §5.3 / Codex R1#6.
	 */
	claimLifecycleConsent(questionId: string, checkpoint: string): boolean {
		const info = this.db
			.prepare(
				`UPDATE messages SET resolved_at = datetime('now')
         WHERE id = ? AND type = 'question' AND checkpoint = ?
           AND resolved_at IS NULL AND expires_at > datetime('now')`,
			)
			.run(questionId, checkpoint);
		return info.changes === 1;
	}

	/**
	 * Mark a gate question as resolved: set resolved_at, mark read,
	 * and shorten TTL to the configured cleanup hours.
	 */
	resolveGate(questionId: string, cleanupTtlHours = 24): void {
		this.db
			.prepare(
				`UPDATE messages SET
				 resolved_at = datetime('now'),
				 read_at = COALESCE(read_at, datetime('now')),
				 expires_at = datetime('now', '+' || ? || ' hours')
				 WHERE id = ? AND type = 'question'`,
			)
			.run(cleanupTtlHours, questionId);
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

	/**
	 * FLY-175: Look up any message by its id. Used by the founder-consent gate
	 * (Bridge wrapper + `flywheel-comm respond`) to read a question's
	 * `checkpoint` field without trusting a caller-supplied value.
	 */
	getMessageById(id: string): Message | undefined {
		return this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as
			| Message
			| undefined;
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

	/**
	 * FLY-58: Find the most recent pending gate question from a specific runner
	 * with a specific checkpoint. Used by Bridge to respond to approve_to_ship gate.
	 */
	getPendingGateByRunner(
		runnerId: string,
		checkpoint: string,
	): Message | undefined {
		return this.db
			.prepare(
				`SELECT q.* FROM messages q
         WHERE q.from_agent = ? AND q.type = 'question'
         AND q.checkpoint = ?
         AND NOT EXISTS (
           SELECT 1 FROM messages r WHERE r.parent_id = q.id AND r.type = 'response'
         )
         AND q.expires_at > datetime('now')
         ORDER BY q.created_at DESC
         LIMIT 1`,
			)
			.get(runnerId, checkpoint) as Message | undefined;
	}

	// NOTE (FLY-191 Codex PR R1 CRITICAL): no "latest gate question" helper on
	// purpose. SQLite created_at has 1s resolution and UUID ids don't sort by
	// insertion order, so "latest" is ambiguous under same-second re-reviews.
	// verify-approval binds to the session's persisted review_question_id
	// instead (StateStore.setReviewBinding).

	// ── Instruction (Phase 2) ──

	insertInstruction(
		fromAgent: string,
		toAgent: string,
		content: string,
	): string {
		const id = randomUUID();
		this.db
			.prepare(
				`INSERT INTO messages (id, from_agent, to_agent, type, content)
         VALUES (?, ?, ?, 'instruction', ?)`,
			)
			.run(id, fromAgent, toAgent, content);
		return id;
	}

	/**
	 * GEO-151: best-effort audit row for a ProofShot artifact_emitted event.
	 * Uses `type='progress'` + `content_type='artifact'` since the existing
	 * messages.type CHECK constraint only allows
	 * ('question','response','instruction','progress') — see schema at top of
	 * file. Attachments stored as JSON-encoded string[] in the `attachments`
	 * column added by the GEO-151 migration above.
	 *
	 * `content` carries a short summary line ("artifact_emitted: N file(s)")
	 * so the audit row is human-readable in `messages` inspections.
	 *
	 * Caller-side is fail-open: notify command catches throws and continues
	 * (the primary path is POST /events).
	 */
	insertArtifactProgress(
		fromAgent: string,
		toAgent: string,
		paths: string[],
	): string {
		const id = randomUUID();
		const summary = `artifact_emitted: ${paths.length} file(s)`;
		this.db
			.prepare(
				`INSERT INTO messages (id, from_agent, to_agent, type, content, content_type, attachments)
         VALUES (?, ?, ?, 'progress', ?, 'artifact', ?)`,
			)
			.run(id, fromAgent, toAgent, summary, JSON.stringify(paths));
		return id;
	}

	getUnreadInstructions(agentId: string): Message[] {
		return this.db
			.prepare(
				`SELECT * FROM messages
         WHERE to_agent = ? AND type = 'instruction' AND read_at IS NULL
         AND expires_at > datetime('now')
         ORDER BY created_at ASC`,
			)
			.all(agentId) as Message[];
	}

	markInstructionRead(id: string): void {
		this.db
			.prepare("UPDATE messages SET read_at = datetime('now') WHERE id = ?")
			.run(id);
	}

	// ── FLY-109: push-path helpers (at-least-once via delivered_at + explicit ack) ──
	//
	// These are push-only helpers used by inbox-mcp's poll → channel notification loop.
	// The CLI pull path (packages/flywheel-comm/src/commands/inbox.ts) continues to use
	// getUnreadInstructions()/markInstructionRead() — its semantics are NOT changed.
	//
	// State machine:
	//   inserted         → delivered_at=NULL, read_at=NULL  → returned by getPendingPushInstructions
	//   markDelivered()  → delivered_at=now,  read_at=NULL  → hidden within retry window
	//   (retry window expires) → re-surfaces in getPendingPushInstructions
	//   ackRead()        → read_at=now (idempotent)         → hidden permanently
	//
	// retry_window_sec is provided by the caller (inbox-mcp via FLYWHEEL_INBOX_RETRY_WINDOW_SEC).

	getPendingPushInstructions(
		agentId: string,
		retryWindowSec: number,
	): Message[] {
		return this.db
			.prepare(
				`SELECT * FROM messages
         WHERE to_agent = ? AND type = 'instruction' AND read_at IS NULL
         AND (delivered_at IS NULL
              OR delivered_at < datetime('now', '-' || ? || ' seconds'))
         AND expires_at > datetime('now')
         ORDER BY created_at ASC`,
			)
			.all(agentId, retryWindowSec) as Message[];
	}

	markInstructionDelivered(id: string): void {
		this.db
			.prepare(
				"UPDATE messages SET delivered_at = datetime('now') WHERE id = ?",
			)
			.run(id);
	}

	/**
	 * Idempotent ack — only sets read_at if not already set.
	 * Called by inbox-mcp's flywheel_inbox_ack tool when the Lead model explicitly
	 * confirms it has processed a message. No-op for unknown ids.
	 */
	ackInstructionRead(id: string): void {
		this.db
			.prepare(
				"UPDATE messages SET read_at = datetime('now') WHERE id = ? AND read_at IS NULL",
			)
			.run(id);
	}

	// ── Dynamic Timeout (Phase 2) ──

	hasPendingQuestionsFrom(execId: string): boolean {
		const row = this.db
			.prepare(
				`SELECT COUNT(*) as cnt FROM messages q
         WHERE q.from_agent = ? AND q.type = 'question'
         AND NOT EXISTS (
           SELECT 1 FROM messages r WHERE r.parent_id = q.id AND r.type = 'response'
         )
         AND q.expires_at > datetime('now')`,
			)
			.get(execId) as { cnt: number };
		return row.cnt > 0;
	}

	/**
	 * FLY-818: true if this execution has an unanswered BLOCKING gate/question
	 * (`checkpoint IS NOT NULL`). A blocking `gate` command carries a checkpoint;
	 * a non-blocking `flywheel-comm ask` has `checkpoint = NULL`. The auto-continue
	 * armer uses THIS (not `hasPendingQuestionsFrom`) so a runner that fired a
	 * non-blocking ask still gets armed to self-continue (Codex code review R1 #2 —
	 * asks must not stop the loop). Stuck detection keeps the broad predicate.
	 */
	hasPendingBlockingGateFrom(execId: string): boolean {
		const row = this.db
			.prepare(
				`SELECT COUNT(*) as cnt FROM messages q
         WHERE q.from_agent = ? AND q.type = 'question'
         AND q.checkpoint IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM messages r WHERE r.parent_id = q.id AND r.type = 'response'
         )
         AND q.expires_at > datetime('now')`,
			)
			.get(execId) as { cnt: number };
		return row.cnt > 0;
	}

	/**
	 * FLY-253 (L1): True if this execution sent ANY CommDB message within the
	 * last `windowSeconds`. Liveness signal for the Bridge stuck-runner
	 * detector — a runner that recently messaged its Lead (DONE report,
	 * instruction receipt, question) is alive, however static its pane looks.
	 *
	 * The comparison stays entirely in SQLite's UTC clock domain
	 * (`created_at` DEFAULT CURRENT_TIMESTAMP vs `datetime('now', ...)`) —
	 * no JS date parsing of timezone-less strings. Strict `>`: a message
	 * exactly at the window edge is outside.
	 */
	hasRecentMessagesFrom(execId: string, windowSeconds: number): boolean {
		const seconds = Math.max(0, Math.floor(windowSeconds));
		const row = this.db
			.prepare(
				`SELECT 1 as hit FROM messages
         WHERE from_agent = ?
         AND created_at > datetime('now', '-' || ? || ' seconds')
         LIMIT 1`,
			)
			.get(execId, seconds) as { hit: number } | undefined;
		return row !== undefined;
	}

	// ── FLY-626: Runner self-declared state (park / busy / unpark) ──

	/**
	 * FLY-626: Upsert a runner's self-declared liveness marker. `expiresAtMs` null
	 * means indefinite (only valid for `parked`; `long_task` is always bounded by
	 * the caller). All timestamps are epoch ms (Codex R2 LOW #3). REPLACE so a
	 * re-declaration (park→busy, renew) atomically supersedes the prior row.
	 */
	upsertDeclaredState(
		execId: string,
		kind: "parked" | "long_task",
		reason: string | null,
		nowMs: number,
		expiresAtMs: number | null,
	): void {
		this.db
			.prepare(
				`INSERT INTO runner_declared_states
           (execution_id, kind, reason, created_at, expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(execution_id) DO UPDATE SET
           kind = excluded.kind,
           reason = excluded.reason,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`,
			)
			.run(execId, kind, reason, nowMs, expiresAtMs, nowMs);
	}

	/** FLY-626: Remove a runner's self-declared marker (`unpark` or Lead re-engagement). */
	clearDeclaredState(execId: string): void {
		this.db
			.prepare("DELETE FROM runner_declared_states WHERE execution_id = ?")
			.run(execId);
	}

	/**
	 * FLY-626: Return the runner's CURRENTLY-EFFECTIVE declared state, or null.
	 * A marker with `expires_at` <= nowMs (strict) is treated as expired → null.
	 *
	 * Readonly-tolerant (Codex R1 #5 / R2 #3): the Bridge reads via
	 * `CommDB.openReadonly()`, which skips schema creation — a DB whose writer
	 * never created this table yields "no such table". That must read as
	 * "no marker", never throw. Any other error propagates.
	 */
	getEffectiveDeclaredState(
		execId: string,
		nowMs: number,
	): RunnerDeclaredState | null {
		let row: RunnerDeclaredState | undefined;
		try {
			row = this.db
				.prepare(
					`SELECT execution_id, kind, reason, created_at, expires_at, updated_at
           FROM runner_declared_states WHERE execution_id = ?`,
				)
				.get(execId) as RunnerDeclaredState | undefined;
		} catch (err) {
			if (
				/no such table: runner_declared_states/i.test((err as Error).message)
			) {
				return null;
			}
			throw err;
		}
		if (!row) return null;
		if (row.expires_at !== null && row.expires_at <= nowMs) return null;
		return row;
	}

	// ── FLY-887: three-stage TURN (single-writer exclusive worktree activation) ──

	/**
	 * FLY-887: grant the shared-worktree TURN for `issueId` to `holderExecId`
	 * (phase = design|implement|qa). Bridge is the ONLY caller. Overwrites any
	 * prior holder and monotonically increments `epoch` so a late/duplicated wake
	 * carrying a stale epoch is recognizable. A fresh grant starts at epoch 1.
	 * `grantedAtMs` is epoch milliseconds (injected clock).
	 */
	grantTurn(
		issueId: string,
		holderExecId: string,
		phase: string,
		grantedAtMs: number,
	): void {
		this.db
			.prepare(
				`INSERT INTO three_stage_turn
           (issue_id, holder_exec_id, phase, epoch, granted_at)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(issue_id) DO UPDATE SET
           holder_exec_id = excluded.holder_exec_id,
           phase = excluded.phase,
           epoch = three_stage_turn.epoch + 1,
           granted_at = excluded.granted_at`,
			)
			.run(issueId, holderExecId, phase, grantedAtMs);
	}

	/**
	 * FLY-887: read the current TURN for `issueId`, or null if none.
	 *
	 * Readonly-tolerant (mirrors `getEffectiveDeclaredState`): a DB whose writer
	 * never created this table (openReadonly skips schema) yields "no such table"
	 * — that must read as "no TURN", never throw. Any other error propagates.
	 */
	getTurn(issueId: string): ThreeStageTurn | null {
		let row: ThreeStageTurn | undefined;
		try {
			row = this.db
				.prepare(
					`SELECT issue_id, holder_exec_id, phase, epoch, granted_at
           FROM three_stage_turn WHERE issue_id = ?`,
				)
				.get(issueId) as ThreeStageTurn | undefined;
		} catch (err) {
			if (/no such table: three_stage_turn/i.test((err as Error).message)) {
				return null;
			}
			throw err;
		}
		return row ?? null;
	}

	/**
	 * FLY-921: read ALL TURN rows in this DB — the Bridge's turn-belt reconcile
	 * needs the full table to detect stale (dead-holder) TURNs. Rows carry no
	 * project name; the caller (plugin.ts) owns the per-project attribution.
	 * Readonly-tolerant: "no such table" reads as an empty table (mirrors getTurn).
	 */
	listTurns(): ThreeStageTurn[] {
		try {
			return this.db
				.prepare(
					`SELECT issue_id, holder_exec_id, phase, epoch, granted_at
           FROM three_stage_turn`,
				)
				.all() as ThreeStageTurn[];
		} catch (err) {
			if (/no such table: three_stage_turn/i.test((err as Error).message)) {
				return [];
			}
			throw err;
		}
	}

	/** FLY-887: remove the TURN row for `issueId` (ship-time cleanup). Idempotent. */
	deleteTurn(issueId: string): void {
		this.db
			.prepare("DELETE FROM three_stage_turn WHERE issue_id = ?")
			.run(issueId);
	}

	// ── Session Registry (Phase 2) ──

	registerSession(
		executionId: string,
		tmuxWindow: string,
		projectName: string,
		issueId?: string,
		leadId?: string,
	): void {
		this.db
			.prepare(
				`INSERT OR REPLACE INTO sessions (execution_id, tmux_window, project_name, issue_id, lead_id)
         VALUES (?, ?, ?, ?, ?)`,
			)
			.run(
				executionId,
				tmuxWindow,
				projectName,
				issueId ?? null,
				leadId ?? null,
			);
	}

	/** FLY-80: Remove a pre-registered session only if still in :pending state.
	 *  If Runner has self-registered (overwritten tmux_window), this is a no-op. */
	unregisterPendingSession(executionId: string): void {
		this.db
			.prepare(
				"DELETE FROM sessions WHERE execution_id = ? AND tmux_window LIKE '%:pending'",
			)
			.run(executionId);
	}

	updateSessionStatus(
		executionId: string,
		status: "completed" | "timeout",
	): void {
		this.db
			.prepare(
				"UPDATE sessions SET status = ?, ended_at = datetime('now') WHERE execution_id = ?",
			)
			.run(status, executionId);
	}

	getSession(executionId: string): Session | undefined {
		return this.db
			.prepare("SELECT * FROM sessions WHERE execution_id = ?")
			.get(executionId) as Session | undefined;
	}

	/**
	 * FLY-638: delete a session registry row. Used by (a) the live teardown path
	 * (close_runner / terminate / post-merge) to drop a runner's row once its tmux
	 * is gone, and (b) the boot prune sweep that clears the backlog of dead
	 * terminal rows polluting `runner_terminal_list` / bootstrap. Idempotent —
	 * deleting a missing row is a no-op. Returns the number of rows removed.
	 */
	deleteSession(executionId: string): number {
		return this.db
			.prepare("DELETE FROM sessions WHERE execution_id = ?")
			.run(executionId).changes;
	}

	getActiveSessions(projectName?: string): Session[] {
		if (projectName) {
			return this.db
				.prepare(
					"SELECT * FROM sessions WHERE project_name = ? AND status = 'running' ORDER BY started_at ASC",
				)
				.all(projectName) as Session[];
		}
		return this.db
			.prepare(
				"SELECT * FROM sessions WHERE status = 'running' ORDER BY started_at ASC",
			)
			.all() as Session[];
	}

	listSessions(projectName?: string, statuses?: string[]): Session[] {
		const conditions: string[] = [];
		const params: string[] = [];

		if (projectName) {
			conditions.push("project_name = ?");
			params.push(projectName);
		}
		if (statuses && statuses.length > 0) {
			conditions.push(`status IN (${statuses.map(() => "?").join(", ")})`);
			params.push(...statuses);
		}

		const where =
			conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		return this.db
			.prepare(`SELECT * FROM sessions ${where} ORDER BY started_at DESC`)
			.all(...params) as Session[];
	}

	/**
	 * FLY-229: recent terminal (completed/timeout) sessions, for parked-alive
	 * detection in `runner_terminal_list`. Lead-scoped IN SQL — the
	 * `(lead_id = ? OR lead_id IS NULL)` predicate is applied BEFORE `LIMIT` so an
	 * in-scope parked-alive row can't be pushed out of the window by another
	 * Lead's newer rows. Ordered by `COALESCE(ended_at, started_at) DESC` —
	 * `ended_at` is the "parked since" clock (stamped by `updateSessionStatus`);
	 * parked-alive sessions are inherently recent, so a recency cap yields no
	 * realistic false-negative. `leadId === undefined` → no scope predicate
	 * (mirrors the unscoped form of `getActiveSessions`).
	 */
	getRecentTerminalSessions(
		projectName: string,
		leadId: string | undefined,
		limit: number,
	): Session[] {
		const scoped = leadId != null;
		const sql =
			"SELECT * FROM sessions WHERE project_name = ? AND status IN ('completed','timeout')" +
			(scoped ? " AND (lead_id = ? OR lead_id IS NULL)" : "") +
			" ORDER BY COALESCE(ended_at, started_at) DESC LIMIT ?";
		const params: Array<string | number> = scoped
			? [projectName, leadId as string, limit]
			: [projectName, limit];
		return this.db.prepare(sql).all(...params) as Session[];
	}

	/**
	 * FLY-229: count of terminal (completed/timeout) sessions matching the SAME
	 * scope as `getRecentTerminalSessions` — drives the truncation summary line
	 * when more terminal rows exist than the probe cap.
	 */
	countTerminalSessions(projectName: string, leadId?: string): number {
		const scoped = leadId != null;
		const sql =
			"SELECT COUNT(*) AS n FROM sessions WHERE project_name = ? AND status IN ('completed','timeout')" +
			(scoped ? " AND (lead_id = ? OR lead_id IS NULL)" : "");
		const params: string[] = scoped
			? [projectName, leadId as string]
			: [projectName];
		const row = this.db.prepare(sql).get(...params) as { n: number };
		return row.n;
	}

	close(): void {
		this.db.close();
	}
}
