/**
 * FLY-224 Phase 3b — SqliteJournalStore: the durable better-sqlite3 backing for
 * the LeadJournal (plan §6.2/§6.10). One DB file per (project, lead), living in
 * the Phase 2 state dir (`…/codex-lead/<id>/journal.db`), so a Codex Lead's
 * input/turn state survives restarts.
 *
 * Implements the same `JournalStore` contract the in-memory store does — so the
 * LeadJournal / LeadInputRouter logic is identical regardless of backend:
 *   - `insertAccepted` is idempotent via a UNIQUE(idempotency_key) constraint;
 *   - `transition` is an ATOMIC compare-and-set —
 *       `UPDATE … WHERE id=? AND state IN (…)` + a `changes === 1` check —
 *     so an out-of-expected-state transition fails (Codex Phase-3a HIGH-2);
 *   - every read/write returns a fresh object (no shared internal reference).
 *
 * better-sqlite3 is synchronous and single-connection; combined with the journal
 * being per-Lead (one process), the read-inside-`transition` is consistent, and
 * the `WHERE state IN` guard is the durable CAS at the SQL layer.
 */

import Database from "better-sqlite3";
import {
	type JournalEntry,
	type JournalState,
	type JournalStore,
	JournalTransitionError,
	TERMINAL_STATES,
} from "./LeadJournal.js";

interface Row {
	id: string;
	idempotency_key: string;
	source: string;
	payload: string;
	state: string;
	client_correlation_id: string | null;
	turn_id: string | null;
	output: string | null;
	outbox_id: string | null;
	reason: string | null;
	reply_channel_id: string | null;
	reply_route_json: string | null;
	created_at: number;
	updated_at: number;
}

function rowToEntry(r: Row): JournalEntry {
	const e: JournalEntry = {
		id: r.id,
		idempotencyKey: r.idempotency_key,
		source: r.source as "discord" | "mailbox",
		payload: r.payload,
		state: r.state as JournalState,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	};
	if (r.client_correlation_id != null)
		e.clientCorrelationId = r.client_correlation_id;
	if (r.turn_id != null) e.turnId = r.turn_id;
	if (r.output != null) e.output = r.output;
	if (r.outbox_id != null) e.outboxId = r.outbox_id;
	if (r.reason != null) e.reason = r.reason;
	if (r.reply_channel_id != null) e.replyChannelId = r.reply_channel_id;
	// FLY-314 Phase 2: durable reply-in-thread route. A malformed/old-schema null
	// → no replyRoute (byte-compat: the entry routes via replyChannelId as before).
	if (r.reply_route_json != null) {
		try {
			e.replyRoute = JSON.parse(
				r.reply_route_json,
			) as JournalEntry["replyRoute"];
		} catch {
			// leave replyRoute unset on a corrupt value
		}
	}
	return e;
}

export class SqliteJournalStore implements JournalStore {
	private readonly db: Database.Database;

	/** @param dbPath file path, or ":memory:" for tests. */
	constructor(dbPath: string) {
		this.db = new Database(dbPath);
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("foreign_keys = ON");
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS journal (
				id TEXT PRIMARY KEY,
				idempotency_key TEXT UNIQUE NOT NULL,
				source TEXT NOT NULL,
				payload TEXT NOT NULL,
				state TEXT NOT NULL,
				client_correlation_id TEXT,
				turn_id TEXT,
				output TEXT,
				outbox_id TEXT,
				reason TEXT,
				reply_channel_id TEXT,
				reply_route_json TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS journal_state_idx ON journal(state);
		`);
		this.migrate();
	}

	/**
	 * Idempotent schema migration (CR Phase-3b R2 HIGH). An earlier iteration had
	 * a `seq INTEGER NOT NULL` column; opening such a DB with the current code
	 * (which no longer writes `seq`) would fail every insert with a NOT NULL
	 * constraint. Drop the legacy column if present. SQLite supports DROP COLUMN
	 * (>= 3.35); better-sqlite3 12.x bundles a newer SQLite.
	 */
	private migrate(): void {
		const cols = this.db.prepare("PRAGMA table_info(journal)").all() as Array<{
			name: string;
		}>;
		if (cols.some((c) => c.name === "seq")) {
			this.db.exec("ALTER TABLE journal DROP COLUMN seq");
		}
		// FLY-267: add the nullable reply-route column to a pre-267 DB. Guarded by
		// PRAGMA so a reopen (column already present) is a no-op — idempotent.
		if (!cols.some((c) => c.name === "reply_channel_id")) {
			this.db.exec("ALTER TABLE journal ADD COLUMN reply_channel_id TEXT");
		}
		// FLY-314 Phase 2: add the nullable reply-route JSON column to a pre-Phase-2
		// DB. Old rows get null → no replyRoute → byte-compat (route via replyChannelId).
		if (!cols.some((c) => c.name === "reply_route_json")) {
			this.db.exec("ALTER TABLE journal ADD COLUMN reply_route_json TEXT");
		}
	}

	close(): void {
		this.db.close();
	}

	insertAccepted(entry: JournalEntry): {
		inserted: boolean;
		entry: JournalEntry;
	} {
		// Order is the SQLite-assigned rowid (monotonic + unique per insert) — no
		// app-computed seq (which could race across connections; CR MED).
		const info = this.db
			.prepare(
				`INSERT INTO journal
				 (id, idempotency_key, source, payload, state, reply_channel_id, reply_route_json, created_at, updated_at)
				 VALUES (@id, @idempotencyKey, @source, @payload, @state, @replyChannelId, @replyRouteJson, @createdAt, @updatedAt)
				 ON CONFLICT(idempotency_key) DO NOTHING`,
			)
			.run({
				id: entry.id,
				idempotencyKey: entry.idempotencyKey,
				source: entry.source,
				payload: entry.payload,
				state: entry.state,
				replyChannelId: entry.replyChannelId ?? null,
				replyRouteJson: entry.replyRoute
					? JSON.stringify(entry.replyRoute)
					: null,
				createdAt: entry.createdAt,
				updatedAt: entry.updatedAt,
			});
		if (info.changes === 1) {
			return { inserted: true, entry: { ...entry } };
		}
		// Conflict → return the existing row.
		const existing = this.getByIdempotencyKey(entry.idempotencyKey);
		if (!existing) {
			// Should not happen (conflict implies a row), but fail loud.
			throw new Error(
				`SqliteJournalStore: insert conflict but no existing row for key ${entry.idempotencyKey}`,
			);
		}
		return { inserted: false, entry: existing };
	}

	getById(id: string): JournalEntry | undefined {
		const r = this.db.prepare("SELECT * FROM journal WHERE id = ?").get(id) as
			| Row
			| undefined;
		return r ? rowToEntry(r) : undefined;
	}

	getByIdempotencyKey(key: string): JournalEntry | undefined {
		const r = this.db
			.prepare("SELECT * FROM journal WHERE idempotency_key = ?")
			.get(key) as Row | undefined;
		return r ? rowToEntry(r) : undefined;
	}

	transition(args: {
		id: string;
		expectedFrom: readonly JournalState[];
		to: JournalState;
		patch: Partial<JournalEntry>;
	}): JournalEntry {
		// Atomic CAS at the SQL layer (CR HIGH): a SINGLE guarded UPDATE that
		// touches ONLY the columns present in the patch (+ state) — never a stale
		// full-row merge that could clobber a concurrent connection's write to a
		// different column. The `WHERE … AND state IN(expectedFrom)` clause IS the
		// compare-and-set; no pre-read of the row is needed for correctness.
		const COL: Readonly<Record<string, string>> = {
			clientCorrelationId: "client_correlation_id",
			turnId: "turn_id",
			output: "output",
			outboxId: "outbox_id",
			reason: "reason",
			updatedAt: "updated_at",
		};
		const patch = stripImmutable(args.patch) as Record<string, unknown>;
		const setClauses: string[] = ["state = @state"];
		const params: Record<string, unknown> = { state: args.to, id: args.id };
		for (const [key, col] of Object.entries(COL)) {
			if (key in patch) {
				setClauses.push(`${col} = @${key}`);
				params[key] = patch[key] ?? null;
			}
		}
		const fromPlaceholders = args.expectedFrom
			.map((s, i) => {
				params[`from${i}`] = s;
				return `@from${i}`;
			})
			.join(", ");
		const info = this.db
			.prepare(
				`UPDATE journal SET ${setClauses.join(", ")} WHERE id = @id AND state IN (${fromPlaceholders})`,
			)
			.run(params);
		if (info.changes !== 1) {
			// Precondition failed (wrong state or missing) — report the actual state.
			const actual = this.getById(args.id);
			throw new JournalTransitionError(
				actual?.state ?? "missing",
				args.to,
				args.id,
			);
		}
		const updated = this.getById(args.id);
		if (!updated) throw new JournalTransitionError("missing", args.to, args.id);
		return updated;
	}

	listUnfinished(): JournalEntry[] {
		const terminal = [...TERMINAL_STATES];
		const placeholders = terminal.map(() => "?").join(", ");
		const rows = this.db
			.prepare(
				`SELECT * FROM journal WHERE state NOT IN (${placeholders}) ORDER BY rowid ASC`,
			)
			.all(...terminal) as Row[];
		return rows.map(rowToEntry);
	}
}

/** id + idempotencyKey are immutable; never let a patch change them. */
function stripImmutable(patch: Partial<JournalEntry>): Partial<JournalEntry> {
	const { id: _id, idempotencyKey: _k, ...rest } = patch;
	return rest;
}
