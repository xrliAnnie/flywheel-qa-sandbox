/**
 * FLY-224 Phase 2b — SqliteOutboundDedupStore: the durable better-sqlite3 backing
 * for CodexLeadOutboundHandler's exactly-once dedup (plan §6.4, Phase 0A §4).
 *
 * Persists `idempotencyKey → {status, messageId}` so the Bridge's exactly-once
 * guarantee survives a restart (a SENT record is returned, not re-sent; an
 * IN_FLIGHT record — written before the Discord send — survives a crash and makes
 * the next attempt provably ambiguous instead of a silent duplicate). Lives in the
 * Bridge state dir, one row per delivered reply.
 *
 * Same `OutboundDedupStore` contract as the in-memory impl, so the handler logic is
 * backend-agnostic.
 */

import Database from "better-sqlite3";
import type {
	DedupRecord,
	OutboundDedupStore,
} from "./CodexLeadOutboundHandler.js";

interface Row {
	idempotency_key: string;
	status: string;
	message_id: string | null;
	created_at: number;
	updated_at: number;
}

export class SqliteOutboundDedupStore implements OutboundDedupStore {
	private readonly db: Database.Database;
	private readonly now: () => number;

	constructor(dbPath: string, now: () => number = () => Date.now()) {
		this.now = now;
		this.db = new Database(dbPath);
		this.db.pragma("journal_mode = WAL");
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS outbound_dedup (
				idempotency_key TEXT PRIMARY KEY,
				status TEXT NOT NULL,
				message_id TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
		`);
	}

	close(): void {
		this.db.close();
	}

	get(key: string): DedupRecord | undefined {
		const r = this.db
			.prepare("SELECT * FROM outbound_dedup WHERE idempotency_key = ?")
			.get(key) as Row | undefined;
		if (!r) return undefined;
		const rec: DedupRecord = {
			idempotencyKey: r.idempotency_key,
			status: r.status === "sent" ? "sent" : "in_flight",
		};
		if (r.message_id != null) rec.messageId = r.message_id;
		return rec;
	}

	setInFlight(key: string): boolean {
		const ts = this.now();
		// ATOMIC CLAIM (HIGH-2): create the in_flight marker only if absent and report
		// whether THIS statement inserted it. ON CONFLICT DO NOTHING + `changes` makes
		// the claim race-safe at the DB level — two concurrent racers cannot both win.
		const result = this.db
			.prepare(
				`INSERT INTO outbound_dedup (idempotency_key, status, created_at, updated_at)
				 VALUES (?, 'in_flight', ?, ?)
				 ON CONFLICT(idempotency_key) DO NOTHING`,
			)
			.run(key, ts, ts);
		return result.changes > 0;
	}

	markSent(key: string, messageId: string): void {
		const ts = this.now();
		// Upsert to sent (handles both the normal in_flight→sent and a defensive
		// create) — but never downgrade a row that is already sent.
		this.db
			.prepare(
				`INSERT INTO outbound_dedup (idempotency_key, status, message_id, created_at, updated_at)
				 VALUES (@key, 'sent', @messageId, @ts, @ts)
				 ON CONFLICT(idempotency_key) DO UPDATE SET
				   status = 'sent',
				   message_id = @messageId,
				   updated_at = @ts`,
			)
			.run({ key, messageId, ts });
	}

	delete(key: string): void {
		this.db
			.prepare("DELETE FROM outbound_dedup WHERE idempotency_key = ?")
			.run(key);
	}
}
