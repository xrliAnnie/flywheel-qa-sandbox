import { installSqlTiming } from "flywheel-config";
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

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import {
	type DedupRecord,
	engagementBindingKey,
	type OutboundDedupStore,
	type OutboundEngagementBinding,
} from "./CodexLeadOutboundHandler.js";

interface Row {
	idempotency_key: string;
	status: string;
	message_id: string | null;
	created_at: number;
	updated_at: number;
	binding: string | null;
	engagement: string | null;
}

export class SqliteOutboundDedupStore implements OutboundDedupStore {
	private readonly db: Database.Database;
	private readonly now: () => number;

	constructor(dbPath: string, now: () => number = () => Date.now()) {
		this.now = now;
		mkdirSync(dirname(dbPath), { recursive: true });
		this.db = installSqlTiming(new Database(dbPath), "bridge-local");
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
		this.db.transaction(() => {
			const columns = this.db
				.prepare("PRAGMA table_info(outbound_dedup)")
				.all() as { name: string }[];
			if (!columns.some((c) => c.name === "binding"))
				this.db.exec("ALTER TABLE outbound_dedup ADD COLUMN binding TEXT");
			if (!columns.some((c) => c.name === "engagement"))
				this.db.exec("ALTER TABLE outbound_dedup ADD COLUMN engagement TEXT");
		})();
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
		if (r.binding != null) {
			const [projectName, leadId, parentChannelId, payloadHash] = JSON.parse(
				r.binding,
			) as unknown[];
			if (
				typeof projectName !== "string" ||
				typeof leadId !== "string" ||
				typeof parentChannelId !== "string" ||
				typeof payloadHash !== "string"
			)
				throw new Error("outbound_binding_invalid");
			rec.binding = { projectName, leadId, parentChannelId, payloadHash };
			rec.engagement = r.engagement === "ready" ? "ready" : "pending";
		}
		return rec;
	}

	setInFlight(key: string, binding?: OutboundEngagementBinding): boolean {
		return this.db
			.transaction(() => {
				const existing = this.get(key);
				if (existing) {
					if (
						engagementBindingKey(existing.binding) !==
						engagementBindingKey(binding)
					)
						throw new Error("outbound_binding_conflict");
					return false;
				}
				const ts = this.now();
				this.db
					.prepare(`INSERT INTO outbound_dedup (idempotency_key, status, created_at, updated_at, binding, engagement)
    VALUES (?, 'in_flight', ?, ?, ?, ?)`)
					.run(
						key,
						ts,
						ts,
						engagementBindingKey(binding),
						binding ? "pending" : null,
					);
				return true;
			})
			.immediate();
	}

	markEngagementReady(
		key: string,
		binding: OutboundEngagementBinding,
		messageId: string,
	): void {
		const result = this.db
			.prepare(`UPDATE outbound_dedup SET engagement = 'ready', updated_at = ?
   WHERE idempotency_key = ? AND binding = ? AND status = 'sent' AND message_id = ?`)
			.run(this.now(), key, engagementBindingKey(binding), messageId);
		if (result.changes !== 1)
			throw new Error("outbound_engagement_receipt_invalid");
	}

	markSent(key: string, messageId: string): void {
		const ts = this.now();
		// Upsert to sent (handles both the normal in_flight→sent and a defensive
		// create) — but never downgrade a row that is already sent.
		const result = this.db
			.prepare(
				`INSERT INTO outbound_dedup (idempotency_key, status, message_id, created_at, updated_at)
				 VALUES (@key, 'sent', @messageId, @ts, @ts)
				 ON CONFLICT(idempotency_key) DO UPDATE SET
				   status = 'sent',
				   message_id = @messageId,
				   updated_at = @ts
     WHERE outbound_dedup.binding IS NULL OR outbound_dedup.message_id IS NULL OR outbound_dedup.message_id = @messageId`,
			)
			.run({ key, messageId, ts });
		if (result.changes !== 1) throw new Error("outbound_receipt_conflict");
	}

	delete(key: string): void {
		this.db
			.prepare("DELETE FROM outbound_dedup WHERE idempotency_key = ?")
			.run(key);
	}
}
