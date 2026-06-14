/**
 * FLY-247 inc2a (§2.2, R3 #5 / R4 #5): the fleet-admin audit table.
 *
 * A dedicated table separate from `founder_consent_audit` (whose schema is
 * issue-scoped and NOT NULL on issue_id). Records the console's stage/apply
 * lifecycle so a Bridge-side fleet change can never happen silently.
 *
 * - Schema is lazy-init on first use (so an unused console = zero startup disk
 *   change, byte-compat).
 * - `(batch_id, event, attempt_id)` is unique. The singleton events
 *   (`staged`, `apply-requested`, `apply-result`) use attempt_id="" → an
 *   idempotent upsert. `denied` (auth-layer rejections) passes a fresh
 *   attempt_id → append-only, so repeated attacks/mistakes each leave evidence.
 * - `staged` / `apply-requested` are written BEFORE token issuance / engine
 *   spawn and are fail-closed (caller refuses on a failed write). `apply-result`
 *   cannot be fail-closed at mutation time — it is reconciled from the durable
 *   batch journal (idempotent upsert) by the live watcher and on Bridge startup.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export const FLEET_ADMIN_AUDIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS fleet_admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  event TEXT NOT NULL,
  attempt_id TEXT NOT NULL DEFAULT '',
  canonical_request TEXT,
  result TEXT,
  origin TEXT,
  reason TEXT,
  UNIQUE(batch_id, event, attempt_id)
);
CREATE INDEX IF NOT EXISTS idx_faa_batch ON fleet_admin_audit(batch_id, ts);
CREATE INDEX IF NOT EXISTS idx_faa_event ON fleet_admin_audit(event, ts);
`;

export type FleetAuditEvent =
	| "staged"
	| "apply-requested"
	| "apply-result"
	| "denied";

export interface FleetAuditRecord {
	batchId: string;
	event: FleetAuditEvent;
	/** Required for `denied` (append-only); ignored for singletons. */
	attemptId?: string;
	canonicalRequest?: string;
	result?: string;
	origin?: string;
	reason?: string;
}

const SINGLETON: ReadonlySet<FleetAuditEvent> = new Set([
	"staged",
	"apply-requested",
	"apply-result",
]);

export class FleetAdminAudit {
	private db: Database.Database | null = null;

	/**
	 * Records the DB path; does NOT touch disk. The DB file + schema are created
	 * LAZILY on the first record/query (§2.2: "schema 首次变更时 lazy-init") so an
	 * unused console = zero startup disk change (byte-compat). `now` is injectable.
	 */
	constructor(
		private readonly dbPath: string,
		private readonly now: () => string = () => new Date().toISOString(),
	) {}

	/** Open + create-schema on first use (lazy). */
	private getDb(): Database.Database {
		if (this.db) return this.db;
		mkdirSync(dirname(this.dbPath), { recursive: true });
		const db = new Database(this.dbPath);
		db.pragma("journal_mode = WAL");
		db.pragma("busy_timeout = 5000");
		db.exec(FLEET_ADMIN_AUDIT_SCHEMA);
		this.db = db;
		return db;
	}

	/**
	 * Record an event. Singleton events idempotently upsert on
	 * (batch_id, event); `denied` requires an attemptId and is append-only.
	 * Returns false (never throws) if the write fails — the caller decides
	 * whether that is fail-closed (pre-mutation) or reconciled (apply-result).
	 */
	record(rec: FleetAuditRecord): boolean {
		try {
			const attemptId = SINGLETON.has(rec.event) ? "" : (rec.attemptId ?? "");
			if (rec.event === "denied" && !attemptId) {
				throw new Error("denied events require an attemptId (append-only)");
			}
			this.getDb()
				.prepare(
					`INSERT INTO fleet_admin_audit
					   (ts, batch_id, event, attempt_id, canonical_request, result, origin, reason)
					 VALUES (@ts, @batch_id, @event, @attempt_id, @canonical_request, @result, @origin, @reason)
					 ON CONFLICT(batch_id, event, attempt_id) DO UPDATE SET
					   ts = excluded.ts,
					   canonical_request = COALESCE(excluded.canonical_request, fleet_admin_audit.canonical_request),
					   result = COALESCE(excluded.result, fleet_admin_audit.result),
					   origin = COALESCE(excluded.origin, fleet_admin_audit.origin),
					   reason = COALESCE(excluded.reason, fleet_admin_audit.reason)`,
				)
				.run({
					ts: this.now(),
					batch_id: rec.batchId,
					event: rec.event,
					attempt_id: attemptId,
					canonical_request: rec.canonicalRequest ?? null,
					result: rec.result ?? null,
					origin: rec.origin ?? null,
					reason: rec.reason ?? null,
				});
			return true;
		} catch {
			return false;
		}
	}

	/** All audit rows for a batch, oldest first (for reconciliation/inspection). */
	forBatch(batchId: string): Array<Record<string, unknown>> {
		return this.getDb()
			.prepare(
				"SELECT * FROM fleet_admin_audit WHERE batch_id = ? ORDER BY id ASC",
			)
			.all(batchId) as Array<Record<string, unknown>>;
	}

	/** True if a terminal apply-result row already exists for the batch. */
	hasApplyResult(batchId: string): boolean {
		const row = this.getDb()
			.prepare(
				"SELECT 1 FROM fleet_admin_audit WHERE batch_id = ? AND event = 'apply-result' LIMIT 1",
			)
			.get(batchId);
		return row !== undefined;
	}

	close(): void {
		if (this.db) {
			this.db.close();
			this.db = null;
		}
	}
}
