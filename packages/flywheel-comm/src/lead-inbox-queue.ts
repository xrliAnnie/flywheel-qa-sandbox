import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type LeadInboxMessageClass = "protocol" | "model";
export type LeadInboxPriority = 0 | 1 | 2 | 3;

export interface LeadInboxRow {
	seq: number;
	id: string;
	to_lead: string;
	source: string;
	type: string;
	msg_class: LeadInboxMessageClass;
	priority: LeadInboxPriority;
	content: string;
	ref_message_id: string | null;
	legacy_alias: string | null;
	batch_id: string | null;
	created_at: string;
	deadline_at: string | null;
	attempts: number;
	last_error: string | null;
	claimed_by: string | null;
	claim_expires_at: string | null;
	disposition: string | null;
	delivered_at: string | null;
	consumed_at: string | null;
}

export interface EnqueueLeadInboxInput {
	id: string;
	toLead: string;
	source: string;
	type: string;
	msgClass: LeadInboxMessageClass;
	priority: LeadInboxPriority;
	content: string;
	refMessageId?: string | null;
	legacyAlias?: string | null;
	deadlineAt?: string | null;
	createdAt?: string;
}

export interface LoopHeartbeatRow {
	lead_id: string;
	last_started_at: string | null;
	last_success_at: string | null;
	stall_episode_at: string | null;
}

export interface LeadInboxHealthEpisode {
	episodeAt: string;
	stalled: boolean;
	overdue: number;
	p0Overdue: number;
}

export const LEAD_INBOX_SCHEMA = `
CREATE TABLE IF NOT EXISTS lead_inbox (
  seq              INTEGER PRIMARY KEY AUTOINCREMENT,
  id               TEXT NOT NULL UNIQUE,
  to_lead          TEXT NOT NULL,
  source           TEXT NOT NULL,
  type             TEXT NOT NULL,
  msg_class        TEXT NOT NULL CHECK(msg_class IN ('protocol','model')),
  priority         INTEGER NOT NULL CHECK(priority BETWEEN 0 AND 3),
  content          TEXT NOT NULL,
  ref_message_id   TEXT,
  legacy_alias     TEXT,
  batch_id         TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deadline_at      TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  claimed_by       TEXT,
  claim_expires_at TEXT,
  disposition      TEXT,
  delivered_at     TEXT,
  consumed_at      TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_inbox_ref
  ON lead_inbox(ref_message_id) WHERE ref_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lead_inbox_pending
  ON lead_inbox(to_lead, priority, seq) WHERE consumed_at IS NULL;
CREATE TABLE IF NOT EXISTS loop_owner (
  singleton        INTEGER PRIMARY KEY CHECK(singleton = 1),
  owner_epoch      TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  renewed_at       TEXT
);
CREATE TABLE IF NOT EXISTS loop_heartbeat (
  lead_id          TEXT PRIMARY KEY,
  last_started_at  TEXT,
  last_success_at  TEXT,
  stall_episode_at TEXT
);
`;

const UTC_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export function assertUtcIsoTimestamp(value: string, field: string): void {
	if (!UTC_ISO_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
		throw new Error(`${field} must be a valid UTC ISO timestamp ending in Z`);
	}
}

function requiredText(value: string, field: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${field} is required`);
	return trimmed;
}

export class LeadInboxQueue {
	private readonly db: Database.Database;

	constructor(dbPath: string) {
		if (dbPath !== ":memory:") {
			mkdirSync(dirname(dbPath), { recursive: true });
		}
		this.db = new Database(dbPath);
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("busy_timeout = 5000");
		this.db.exec(LEAD_INBOX_SCHEMA);
	}

	enqueue(input: EnqueueLeadInboxInput): LeadInboxRow {
		const id = requiredText(input.id, "id");
		const toLead = requiredText(input.toLead, "toLead");
		const source = requiredText(input.source, "source");
		const type = requiredText(input.type, "type");
		if (input.deadlineAt) {
			assertUtcIsoTimestamp(input.deadlineAt, "deadlineAt");
		}
		if (input.createdAt) {
			assertUtcIsoTimestamp(input.createdAt, "createdAt");
		}

		this.db
			.prepare(
				`INSERT OR IGNORE INTO lead_inbox (
				   id, to_lead, source, type, msg_class, priority, content,
				   ref_message_id, legacy_alias, deadline_at, created_at
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
				   COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
				 )`,
			)
			.run(
				id,
				toLead,
				source,
				type,
				input.msgClass,
				input.priority,
				input.content,
				input.refMessageId ?? null,
				input.legacyAlias ?? null,
				input.deadlineAt ?? null,
				input.createdAt ?? null,
			);

		const row = this.getById(id);
		if (!row) throw new Error(`lead inbox enqueue failed for ${id}`);
		const expected = {
			to_lead: toLead,
			source,
			type,
			msg_class: input.msgClass,
			priority: input.priority,
			content: input.content,
			ref_message_id: input.refMessageId ?? null,
			legacy_alias: input.legacyAlias ?? null,
			deadline_at: input.deadlineAt ?? null,
		};
		for (const [key, value] of Object.entries(expected)) {
			if (row[key as keyof LeadInboxRow] !== value) {
				throw new Error(`lead inbox id ${id} was reused with different ${key}`);
			}
		}
		return row;
	}

	getById(id: string): LeadInboxRow | undefined {
		return this.db.prepare("SELECT * FROM lead_inbox WHERE id = ?").get(id) as
			| LeadInboxRow
			| undefined;
	}

	countPending(toLead?: string): number {
		const row = (
			toLead
				? this.db
						.prepare(
							"SELECT COUNT(*) AS count FROM lead_inbox WHERE consumed_at IS NULL AND to_lead = ?",
						)
						.get(toLead)
				: this.db
						.prepare(
							"SELECT COUNT(*) AS count FROM lead_inbox WHERE consumed_at IS NULL",
						)
						.get()
		) as { count: number };
		return row.count;
	}

	acquireOrRenewOwner(input: {
		ownerEpoch: string;
		now: string;
		leaseTtlMs: number;
	}): boolean {
		const ownerEpoch = requiredText(input.ownerEpoch, "ownerEpoch");
		assertUtcIsoTimestamp(input.now, "now");
		if (!Number.isSafeInteger(input.leaseTtlMs) || input.leaseTtlMs <= 0) {
			throw new Error("leaseTtlMs must be a positive safe integer");
		}
		const expiresAt = new Date(
			Date.parse(input.now) + input.leaseTtlMs,
		).toISOString();
		const acquire = this.db.transaction(() => {
			const current = this.db
				.prepare(
					"SELECT owner_epoch, lease_expires_at FROM loop_owner WHERE singleton = 1",
				)
				.get() as { owner_epoch: string; lease_expires_at: string } | undefined;
			if (!current) {
				this.db
					.prepare(
						`INSERT INTO loop_owner
						 (singleton, owner_epoch, lease_expires_at, renewed_at)
						 VALUES (1, ?, ?, ?)`,
					)
					.run(ownerEpoch, expiresAt, input.now);
				return true;
			}
			if (
				current.owner_epoch !== ownerEpoch &&
				current.lease_expires_at > input.now
			) {
				return false;
			}
			return (
				this.db
					.prepare(
						`UPDATE loop_owner
						 SET owner_epoch = ?, lease_expires_at = ?, renewed_at = ?
						 WHERE singleton = 1
						   AND (owner_epoch = ? OR lease_expires_at <= ?)`,
					)
					.run(ownerEpoch, expiresAt, input.now, ownerEpoch, input.now)
					.changes === 1
			);
		});
		return acquire.immediate();
	}

	isCurrentOwner(ownerEpoch: string, now: string): boolean {
		assertUtcIsoTimestamp(now, "now");
		return Boolean(
			this.db
				.prepare(
					`SELECT 1 FROM loop_owner
					 WHERE singleton = 1 AND owner_epoch = ? AND lease_expires_at > ?`,
				)
				.get(ownerEpoch, now),
		);
	}

	claimPending(input: {
		toLead: string;
		ownerEpoch: string;
		now: string;
		claimTtlMs: number;
		limit?: number;
	}): LeadInboxRow[] {
		assertUtcIsoTimestamp(input.now, "now");
		if (!Number.isSafeInteger(input.claimTtlMs) || input.claimTtlMs <= 0) {
			throw new Error("claimTtlMs must be a positive safe integer");
		}
		const limit = input.limit ?? 10_000;
		if (!Number.isSafeInteger(limit) || limit <= 0) {
			throw new Error("limit must be a positive safe integer");
		}
		const expiresAt = new Date(
			Date.parse(input.now) + input.claimTtlMs,
		).toISOString();
		const claim = this.db.transaction(() => {
			if (!this.isCurrentOwner(input.ownerEpoch, input.now)) return [];
			const candidates = this.db
				.prepare(
					`SELECT id FROM lead_inbox
					  WHERE to_lead = ? AND consumed_at IS NULL
					    AND (claimed_by IS NULL OR claimed_by = ? OR claim_expires_at < ?)
					  ORDER BY priority, seq LIMIT ?`,
				)
				.all(input.toLead, input.ownerEpoch, input.now, limit) as Array<{
				id: string;
			}>;
			const update = this.db.prepare(
				`UPDATE lead_inbox SET claimed_by = ?, claim_expires_at = ?
				  WHERE id = ? AND consumed_at IS NULL
				    AND (claimed_by IS NULL OR claimed_by = ? OR claim_expires_at < ?)`,
			);
			for (const { id } of candidates) {
				update.run(
					input.ownerEpoch,
					expiresAt,
					id,
					input.ownerEpoch,
					input.now,
				);
			}
			if (candidates.length === 0) return [];
			const placeholders = candidates.map(() => "?").join(",");
			return this.db
				.prepare(
					`SELECT * FROM lead_inbox WHERE id IN (${placeholders})
					   AND claimed_by = ? AND consumed_at IS NULL
					 ORDER BY priority, seq`,
				)
				.all(
					...candidates.map(({ id }) => id),
					input.ownerEpoch,
				) as LeadInboxRow[];
		});
		return claim();
	}

	claimProtocol(input: {
		toLead: string;
		ownerEpoch: string;
		now: string;
		claimTtlMs: number;
	}): LeadInboxRow | undefined {
		const rows = this.claimByClass({
			...input,
			msgClass: "protocol",
			limit: 1,
		});
		return rows[0];
	}

	claimModelBatch(input: {
		toLead: string;
		ownerEpoch: string;
		batchId: string;
		now: string;
		claimTtlMs: number;
		limit?: number;
	}): LeadInboxRow[] {
		assertUtcIsoTimestamp(input.now, "now");
		const batchId = requiredText(input.batchId, "batchId");
		const limit = input.limit ?? 10_000;
		if (!Number.isSafeInteger(limit) || limit <= 0) {
			throw new Error("limit must be a positive safe integer");
		}
		if (!Number.isSafeInteger(input.claimTtlMs) || input.claimTtlMs <= 0) {
			throw new Error("claimTtlMs must be a positive safe integer");
		}
		const expiresAt = new Date(
			Date.parse(input.now) + input.claimTtlMs,
		).toISOString();
		const claim = this.db.transaction(() => {
			if (!this.isCurrentOwner(input.ownerEpoch, input.now)) return [];
			const existing = this.db
				.prepare(
					`SELECT batch_id FROM lead_inbox
					 WHERE to_lead = ? AND msg_class = 'model'
					   AND consumed_at IS NULL AND batch_id IS NOT NULL
					 GROUP BY batch_id
					 ORDER BY MIN(priority), MIN(seq) LIMIT 1`,
				)
				.get(input.toLead) as { batch_id: string } | undefined;
			const effectiveBatchId = existing?.batch_id ?? batchId;
			let rows: LeadInboxRow[];
			if (existing) {
				rows = this.db
					.prepare(
						`SELECT * FROM lead_inbox
						 WHERE to_lead = ? AND msg_class = 'model'
						   AND consumed_at IS NULL AND batch_id = ?
						 ORDER BY priority, seq`,
					)
					.all(input.toLead, effectiveBatchId) as LeadInboxRow[];
				if (
					rows.some(
						(row) =>
							row.claimed_by !== null &&
							row.claimed_by !== input.ownerEpoch &&
							(row.claim_expires_at ?? "") >= input.now,
					)
				) {
					return [];
				}
			} else {
				rows = this.db
					.prepare(
						`SELECT * FROM lead_inbox
						 WHERE to_lead = ? AND msg_class = 'model'
						   AND consumed_at IS NULL AND batch_id IS NULL
						   AND (claimed_by IS NULL OR claimed_by = ? OR claim_expires_at < ?)
						 ORDER BY priority, seq LIMIT ?`,
					)
					.all(
						input.toLead,
						input.ownerEpoch,
						input.now,
						limit,
					) as LeadInboxRow[];
			}
			if (rows.length === 0) return [];
			const update = this.db.prepare(
				`UPDATE lead_inbox SET batch_id = ?, claimed_by = ?, claim_expires_at = ?
				 WHERE id = ? AND consumed_at IS NULL
				   AND (batch_id IS NULL OR batch_id = ?)
				   AND (claimed_by IS NULL OR claimed_by = ? OR claim_expires_at < ?)`,
			);
			for (const row of rows) {
				const result = update.run(
					effectiveBatchId,
					input.ownerEpoch,
					expiresAt,
					row.id,
					effectiveBatchId,
					input.ownerEpoch,
					input.now,
				);
				if (result.changes !== 1) return [];
			}
			return this.db
				.prepare(
					`SELECT * FROM lead_inbox
					 WHERE to_lead = ? AND consumed_at IS NULL AND batch_id = ?
					   AND claimed_by = ? ORDER BY priority, seq`,
				)
				.all(
					input.toLead,
					effectiveBatchId,
					input.ownerEpoch,
				) as LeadInboxRow[];
		});
		return claim.immediate();
	}

	markConsumed(
		ids: string[],
		input: { ownerEpoch: string; disposition: string; now: string },
	): number {
		if (ids.length === 0) return 0;
		assertUtcIsoTimestamp(input.now, "now");
		const consume = this.db.transaction(() => {
			if (!this.isCurrentOwner(input.ownerEpoch, input.now)) return 0;
			const placeholders = ids.map(() => "?").join(",");
			return this.db
				.prepare(
					`UPDATE lead_inbox SET
				   delivered_at = CASE WHEN ? = 'delivered'
				     THEN COALESCE(delivered_at, ?) ELSE delivered_at END,
				   consumed_at = ?, disposition = ?,
				   claimed_by = NULL, claim_expires_at = NULL
				 WHERE id IN (${placeholders}) AND consumed_at IS NULL
				   AND claimed_by = ?`,
				)
				.run(
					input.disposition,
					input.now,
					input.now,
					input.disposition,
					...ids,
					input.ownerEpoch,
				).changes;
		});
		return consume.immediate();
	}

	/**
	 * Terminalize an immutable model batch and persist its one-shot advisory in
	 * the same transaction. The stable advisory id closes the crash window where
	 * a quarantined batch could otherwise be consumed without surfacing the loss.
	 */
	quarantineModelBatch(
		ids: string[],
		input: {
			ownerEpoch: string;
			batchId: string;
			toLead: string;
			error: string;
			now: string;
		},
	): number {
		if (ids.length === 0) return 0;
		const memberIds = ids.map((id) => requiredText(id, "id"));
		if (new Set(memberIds).size !== memberIds.length) {
			throw new Error("model quarantine ids must be unique");
		}
		const ownerEpoch = requiredText(input.ownerEpoch, "ownerEpoch");
		const batchId = requiredText(input.batchId, "batchId");
		const toLead = requiredText(input.toLead, "toLead");
		const error = requiredText(input.error, "error");
		assertUtcIsoTimestamp(input.now, "now");
		const alertId = `model_alert:${toLead}:${batchId}`;
		const alertSource = `model_quarantine:${batchId}`;
		const alertContent =
			`[model_batch_quarantined] ${batchId} quarantined ${memberIds.length} model message(s) ` +
			"after immutable membership conflict; operator intervention required.";

		const quarantine = this.db.transaction(() => {
			if (!this.isCurrentOwner(ownerEpoch, input.now)) return 0;
			const placeholders = memberIds.map(() => "?").join(",");
			const eligible = this.db
				.prepare(
					`SELECT COUNT(*) AS count FROM lead_inbox
					 WHERE id IN (${placeholders}) AND to_lead = ?
					   AND msg_class = 'model' AND batch_id = ?
					   AND consumed_at IS NULL AND claimed_by = ?`,
				)
				.get(...memberIds, toLead, batchId, ownerEpoch) as { count: number };
			if (eligible.count !== memberIds.length) return 0;

			const result = this.db
				.prepare(
					`UPDATE lead_inbox SET attempts = attempts + 1, last_error = ?,
					   consumed_at = ?, disposition = 'quarantined',
					   claimed_by = NULL, claim_expires_at = NULL
					 WHERE id IN (${placeholders}) AND to_lead = ?
					   AND msg_class = 'model' AND batch_id = ?
					   AND consumed_at IS NULL AND claimed_by = ?`,
				)
				.run(error, input.now, ...memberIds, toLead, batchId, ownerEpoch);
			if (result.changes !== memberIds.length) {
				throw new Error(
					"model quarantine membership changed during transaction",
				);
			}

			this.db
				.prepare(
					`INSERT OR IGNORE INTO lead_inbox (
					   id, to_lead, source, type, msg_class, priority, content, created_at
					 ) VALUES (?, ?, ?, 'model_batch_quarantined', 'model', 2, ?, ?)`,
				)
				.run(alertId, toLead, alertSource, alertContent, input.now);
			const alert = this.getById(alertId);
			if (
				!alert ||
				alert.to_lead !== toLead ||
				alert.source !== alertSource ||
				alert.type !== "model_batch_quarantined" ||
				alert.msg_class !== "model" ||
				alert.priority !== 2 ||
				alert.content !== alertContent
			) {
				throw new Error(`model quarantine alert id ${alertId} was reused`);
			}
			return result.changes;
		});
		return quarantine.immediate();
	}

	/** Boot reconciliation terminalizes evidence without creating a live claim. */
	reconcileConsumed(
		id: string,
		input: {
			ownerEpoch: string;
			disposition: string;
			delivered: boolean;
			now: string;
		},
	): boolean {
		assertUtcIsoTimestamp(input.now, "now");
		const reconcile = this.db.transaction(() => {
			if (!this.isCurrentOwner(input.ownerEpoch, input.now)) return false;
			const result = this.db
				.prepare(
					`UPDATE lead_inbox SET
					   delivered_at = CASE WHEN ? THEN COALESCE(delivered_at, ?) ELSE delivered_at END,
					   consumed_at = COALESCE(consumed_at, ?),
					   disposition = COALESCE(disposition, ?),
					   claimed_by = NULL, claim_expires_at = NULL
					 WHERE id = ?`,
				)
				.run(
					input.delivered ? 1 : 0,
					input.now,
					input.now,
					input.disposition,
					id,
				);
			return result.changes === 1;
		});
		return reconcile.immediate();
	}

	/**
	 * Boot cutover's cross-store commit point. Inserts a row already terminal in
	 * one comm.db transaction, so a crash can never expose a live queue row after
	 * the StateStore delivery receipt was committed.
	 */
	reconcileEnqueueConsumed(
		input: EnqueueLeadInboxInput,
		terminal: {
			ownerEpoch: string;
			disposition: string;
			delivered: boolean;
			now: string;
		},
	): boolean {
		const id = requiredText(input.id, "id");
		const toLead = requiredText(input.toLead, "toLead");
		const source = requiredText(input.source, "source");
		const type = requiredText(input.type, "type");
		assertUtcIsoTimestamp(terminal.now, "now");
		if (input.deadlineAt) assertUtcIsoTimestamp(input.deadlineAt, "deadlineAt");
		if (input.createdAt) assertUtcIsoTimestamp(input.createdAt, "createdAt");
		const reconcile = this.db.transaction(() => {
			if (!this.isCurrentOwner(terminal.ownerEpoch, terminal.now)) return false;
			const result = this.db
				.prepare(
					`INSERT OR IGNORE INTO lead_inbox (
					   id, to_lead, source, type, msg_class, priority, content,
					   ref_message_id, legacy_alias, deadline_at, created_at,
					   disposition, delivered_at, consumed_at
					 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
					   COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
					   ?, CASE WHEN ? THEN ? ELSE NULL END, ?
					 )`,
				)
				.run(
					id,
					toLead,
					source,
					type,
					input.msgClass,
					input.priority,
					input.content,
					input.refMessageId ?? null,
					input.legacyAlias ?? null,
					input.deadlineAt ?? null,
					input.createdAt ?? null,
					terminal.disposition,
					terminal.delivered ? 1 : 0,
					terminal.now,
					terminal.now,
				);
			if (result.changes === 1) return true;
			const row = this.getById(id);
			return Boolean(
				row?.consumed_at &&
					row.disposition === terminal.disposition &&
					row.to_lead === toLead &&
					row.source === source &&
					row.type === type &&
					row.msg_class === input.msgClass &&
					row.priority === input.priority &&
					row.content === input.content,
			);
		});
		return reconcile.immediate();
	}

	recordFailure(
		ids: string[],
		input: { ownerEpoch: string; error: string; now: string },
	): number {
		if (ids.length === 0) return 0;
		assertUtcIsoTimestamp(input.now, "now");
		const fail = this.db.transaction(() => {
			if (!this.isCurrentOwner(input.ownerEpoch, input.now)) return 0;
			const placeholders = ids.map(() => "?").join(",");
			return this.db
				.prepare(
					`UPDATE lead_inbox SET attempts = attempts + 1, last_error = ?,
					   claimed_by = NULL, claim_expires_at = NULL
					 WHERE id IN (${placeholders}) AND consumed_at IS NULL
					   AND claimed_by = ?`,
				)
				.run(input.error, ...ids, input.ownerEpoch).changes;
		});
		return fail.immediate();
	}

	recordProtocolFailure(
		id: string,
		input: {
			ownerEpoch: string;
			error: string;
			now: string;
			maxAttempts: number;
		},
	): { attempts: number; quarantined: boolean } {
		assertUtcIsoTimestamp(input.now, "now");
		if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts <= 0) {
			throw new Error("maxAttempts must be a positive safe integer");
		}
		const fail = this.db.transaction(() => {
			if (!this.isCurrentOwner(input.ownerEpoch, input.now)) {
				return { attempts: 0, quarantined: false };
			}
			const row = this.db
				.prepare(
					`SELECT attempts FROM lead_inbox
					 WHERE id = ? AND msg_class = 'protocol' AND consumed_at IS NULL
					   AND claimed_by = ?`,
				)
				.get(id, input.ownerEpoch) as { attempts: number } | undefined;
			if (!row) return { attempts: 0, quarantined: false };
			const attempts = row.attempts + 1;
			const quarantined = attempts >= input.maxAttempts;
			this.db
				.prepare(
					`UPDATE lead_inbox SET attempts = ?, last_error = ?,
					   consumed_at = CASE WHEN ? THEN ? ELSE consumed_at END,
					   disposition = CASE WHEN ? THEN 'quarantined' ELSE disposition END,
					   claimed_by = NULL, claim_expires_at = NULL
					 WHERE id = ? AND consumed_at IS NULL AND claimed_by = ?`,
				)
				.run(
					attempts,
					input.error,
					quarantined ? 1 : 0,
					input.now,
					quarantined ? 1 : 0,
					id,
					input.ownerEpoch,
				);
			return { attempts, quarantined };
		});
		return fail.immediate();
	}

	recordTickStarted(leadId: string, now: string): void {
		assertUtcIsoTimestamp(now, "now");
		this.db
			.prepare(
				`INSERT INTO loop_heartbeat (lead_id, last_started_at)
				 VALUES (?, ?)
				 ON CONFLICT(lead_id) DO UPDATE SET last_started_at = excluded.last_started_at`,
			)
			.run(requiredText(leadId, "leadId"), now);
	}

	recordTickSuccess(leadId: string, now: string): void {
		assertUtcIsoTimestamp(now, "now");
		this.db
			.prepare(
				`INSERT INTO loop_heartbeat (lead_id, last_success_at)
				 VALUES (?, ?)
				 ON CONFLICT(lead_id) DO UPDATE SET last_success_at = excluded.last_success_at,
				   stall_episode_at = CASE WHEN EXISTS (
				     SELECT 1 FROM lead_inbox
				      WHERE to_lead = excluded.lead_id AND consumed_at IS NULL
				        AND deadline_at IS NOT NULL AND deadline_at <= excluded.last_success_at
				   ) THEN loop_heartbeat.stall_episode_at ELSE NULL END`,
			)
			.run(requiredText(leadId, "leadId"), now);
	}

	getHeartbeat(leadId: string): LoopHeartbeatRow | undefined {
		return this.db
			.prepare("SELECT * FROM loop_heartbeat WHERE lead_id = ?")
			.get(leadId) as LoopHeartbeatRow | undefined;
	}

	/** Atomically latch one founder alert for a stall/deadline episode. */
	claimHealthEpisode(input: {
		leadId: string;
		now: string;
		staleBefore: string;
	}): LeadInboxHealthEpisode | undefined {
		const leadId = requiredText(input.leadId, "leadId");
		assertUtcIsoTimestamp(input.now, "now");
		assertUtcIsoTimestamp(input.staleBefore, "staleBefore");
		const claim = this.db.transaction(() => {
			const heartbeat = this.getHeartbeat(leadId);
			const counts = this.db
				.prepare(
					`SELECT COUNT(*) AS overdue,
					        COALESCE(SUM(CASE WHEN priority = 0 THEN 1 ELSE 0 END), 0) AS p0_overdue
					   FROM lead_inbox
					  WHERE to_lead = ? AND consumed_at IS NULL
					    AND deadline_at IS NOT NULL AND deadline_at <= ?`,
				)
				.get(leadId, input.now) as { overdue: number; p0_overdue: number };
			const stalled =
				!heartbeat?.last_success_at ||
				heartbeat.last_success_at < input.staleBefore;
			if (!stalled && counts.overdue === 0) return undefined;
			if (heartbeat?.stall_episode_at) return undefined;
			if (heartbeat) {
				const changed = this.db
					.prepare(
						`UPDATE loop_heartbeat SET stall_episode_at = ?
						  WHERE lead_id = ? AND stall_episode_at IS NULL`,
					)
					.run(input.now, leadId).changes;
				if (changed !== 1) return undefined;
			} else {
				this.db
					.prepare(
						`INSERT INTO loop_heartbeat (lead_id, stall_episode_at)
						 VALUES (?, ?)`,
					)
					.run(leadId, input.now);
			}
			return {
				episodeAt: input.now,
				stalled,
				overdue: counts.overdue,
				p0Overdue: counts.p0_overdue,
			};
		});
		return claim.immediate();
	}

	private claimByClass(input: {
		toLead: string;
		ownerEpoch: string;
		now: string;
		claimTtlMs: number;
		msgClass: LeadInboxMessageClass;
		limit: number;
	}): LeadInboxRow[] {
		assertUtcIsoTimestamp(input.now, "now");
		if (!Number.isSafeInteger(input.claimTtlMs) || input.claimTtlMs <= 0) {
			throw new Error("claimTtlMs must be a positive safe integer");
		}
		const expiresAt = new Date(
			Date.parse(input.now) + input.claimTtlMs,
		).toISOString();
		const claim = this.db.transaction(() => {
			if (!this.isCurrentOwner(input.ownerEpoch, input.now)) return [];
			const rows = this.db
				.prepare(
					`SELECT * FROM lead_inbox
					 WHERE to_lead = ? AND msg_class = ? AND consumed_at IS NULL
					   AND (claimed_by IS NULL OR claimed_by = ? OR claim_expires_at < ?)
					 ORDER BY priority, seq LIMIT ?`,
				)
				.all(
					input.toLead,
					input.msgClass,
					input.ownerEpoch,
					input.now,
					input.limit,
				) as LeadInboxRow[];
			const update = this.db.prepare(
				`UPDATE lead_inbox SET claimed_by = ?, claim_expires_at = ?
				 WHERE id = ? AND consumed_at IS NULL
				   AND (claimed_by IS NULL OR claimed_by = ? OR claim_expires_at < ?)`,
			);
			return rows.filter(
				(row) =>
					update.run(
						input.ownerEpoch,
						expiresAt,
						row.id,
						input.ownerEpoch,
						input.now,
					).changes === 1,
			);
		});
		return claim.immediate();
	}

	close(): void {
		this.db.close();
	}
}
