import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import {
	assertNoLoneSurrogate,
	normalizeInboxContent,
} from "./inbox-write-normalize.js";
import { MAILBOX_SCHEMA } from "./mailbox-schema.js";
import { decodeSenderRef } from "./sender-ref.js";

export type MailboxState = "QUEUED" | "LEASED" | "ACKED" | "DEAD";
export type MailboxRecipientKind = "lead" | "runner" | "bridge";
export type MailboxMessageClass = "protocol" | "model";
export type MailboxPriority = 0 | 1 | 2 | 3;

export interface MailboxRow {
	seq: number;
	id: string;
	delivery_id: string;
	from_agent: string;
	to_agent: string;
	recipient_kind: MailboxRecipientKind;
	source_kind: string | null;
	source_ref: string | null;
	type: string;
	msg_class: MailboxMessageClass;
	content: string;
	delivery_content: string | null;
	content_ref: string | null;
	content_type: string | null;
	ref_id: string | null;
	kind: string | null;
	checkpoint: string | null;
	deadline_at: string | null;
	expires_at: string | null;
	relay_state: "open" | "protected" | "terminal_disposed";
	resolved_at: string | null;
	resolved_via: string | null;
	superseded_at: string | null;
	superseded_by: string | null;
	created_at: string;
	state: MailboxState;
	claimed_by: string | null;
	claim_expires_at: string | null;
	retry_count: number;
	next_retry_at: string | null;
	last_error: string | null;
	acked_at: string | null;
	dead_at: string | null;
	dead_reason: string | null;
	carrier: "inbox" | "external";
	sender_ref: string | null;
	priority: MailboxPriority;
	batch_id: string | null;
	collapse_key: string | null;
}

export interface EnqueueMailboxInput {
	id: string;
	deliveryId?: string;
	fromAgent: string;
	toAgent: string;
	recipientKind: MailboxRecipientKind;
	sourceKind?: string | null;
	sourceRef?: string | null;
	type: string;
	msgClass?: MailboxMessageClass;
	content: string;
	deliveryContent?: string | null;
	contentRef?: string | null;
	contentType?: string | null;
	refId?: string | null;
	kind?: string | null;
	checkpoint?: string | null;
	deadlineAt?: string | null;
	expiresAt?: string | null;
	relayState?: "open" | "protected" | "terminal_disposed";
	resolvedAt?: string | null;
	resolvedVia?: string | null;
	supersededAt?: string | null;
	supersededBy?: string | null;
	createdAt?: string;
	carrier?: "inbox" | "external";
	senderRef: string;
	priority?: MailboxPriority;
	collapseKey?: string | null;
}

export type EnqueueMailboxResult =
	| { outcome: "inserted" | "active"; row: MailboxRow }
	| { outcome: "archived" };

function requiredText(value: string, field: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${field} is required`);
	return assertNoLoneSurrogate(field, trimmed);
}

function timestamp(value: string | undefined, field: string): string {
	const result = value ?? new Date().toISOString();
	if (!result.endsWith("Z") || !Number.isFinite(Date.parse(result))) {
		throw new Error(`${field} must be a UTC timestamp`);
	}
	return result;
}

function addMilliseconds(value: string, milliseconds: number): string {
	if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
		throw new Error("leaseTtlMs must be a positive safe integer");
	}
	return new Date(Date.parse(value) + milliseconds).toISOString();
}

function placeholders(count: number): string {
	return Array.from({ length: count }, () => "?").join(",");
}

export class MailboxQueue {
	private readonly db: Database.Database;
	private readonly ownsConnection: boolean;

	constructor(dbPathOrConnection: string | Database.Database) {
		if (typeof dbPathOrConnection !== "string") {
			this.db = dbPathOrConnection;
			this.ownsConnection = false;
			return;
		}
		if (dbPathOrConnection !== ":memory:") {
			mkdirSync(dirname(dbPathOrConnection), { recursive: true });
		}
		this.db = new Database(dbPathOrConnection);
		this.ownsConnection = true;
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("busy_timeout = 5000");
		this.db.exec(MAILBOX_SCHEMA);
	}

	enqueue(input: EnqueueMailboxInput): EnqueueMailboxResult {
		const normalizedContent = normalizeInboxContent(input.content).text;
		const projection = {
			id: requiredText(input.id, "id"),
			delivery_id: requiredText(input.deliveryId ?? input.id, "deliveryId"),
			from_agent: requiredText(input.fromAgent, "fromAgent"),
			to_agent: requiredText(input.toAgent, "toAgent"),
			recipient_kind: input.recipientKind,
			source_kind: input.sourceKind ?? null,
			source_ref: input.sourceRef ?? null,
			type: requiredText(input.type, "type"),
			msg_class: input.msgClass ?? "model",
			content: normalizedContent,
			delivery_content: input.deliveryContent ?? null,
			content_ref: input.contentRef ?? null,
			content_type: input.contentType ?? "text",
			ref_id: input.refId ?? null,
			kind: input.kind ?? null,
			checkpoint: input.checkpoint ?? null,
			deadline_at: input.deadlineAt ?? null,
			expires_at: input.expiresAt ?? null,
			relay_state: input.relayState ?? "open",
			resolved_at: input.resolvedAt ?? null,
			resolved_via: input.resolvedVia ?? null,
			superseded_at: input.supersededAt ?? null,
			superseded_by: input.supersededBy ?? null,
			created_at: timestamp(input.createdAt, "createdAt"),
			carrier: input.carrier ?? "inbox",
			sender_ref: input.senderRef,
			priority: input.priority ?? 1,
			collapse_key: input.collapseKey ?? null,
		};
		if (
			!(["lead", "runner", "bridge"] as const).includes(
				projection.recipient_kind,
			)
		) {
			throw new Error("recipientKind is invalid");
		}
		if (!(["protocol", "model"] as const).includes(projection.msg_class)) {
			throw new Error("msgClass is invalid");
		}
		if (
			!Number.isSafeInteger(projection.priority) ||
			projection.priority < 0 ||
			projection.priority > 3
		) {
			throw new Error("priority must be an integer from 0 through 3");
		}
		decodeSenderRef(projection.sender_ref);
		const projectionHash = createHash("sha256")
			.update(JSON.stringify(projection))
			.digest("hex");

		return this.db
			.transaction((): EnqueueMailboxResult => {
				const identity = this.db
					.prepare(
						"SELECT id, delivery_id, insert_projection_hash, archived_at FROM mailbox_identity WHERE id = ? OR delivery_id = ?",
					)
					.get(projection.id, projection.delivery_id) as
					| {
							id: string;
							delivery_id: string;
							insert_projection_hash: string;
							archived_at: string | null;
					  }
					| undefined;
				if (identity) {
					if (
						identity.id !== projection.id ||
						identity.delivery_id !== projection.delivery_id ||
						identity.insert_projection_hash !== projectionHash
					) {
						throw new Error(`mailbox identity conflict: ${projection.id}`);
					}
					if (identity.archived_at !== null) return { outcome: "archived" };
					const row = this.getById(projection.id);
					if (!row)
						throw new Error(
							`active mailbox identity has no row: ${projection.id}`,
						);
					return { outcome: "active", row };
				}

				this.db
					.prepare(
						"INSERT INTO mailbox_identity (id, delivery_id, insert_projection_hash) VALUES (?, ?, ?)",
					)
					.run(projection.id, projection.delivery_id, projectionHash);
				this.db
					.prepare(
						`INSERT INTO mailbox (
					 id, delivery_id, from_agent, to_agent, recipient_kind, source_kind,
					 source_ref, type, msg_class, content, delivery_content, content_ref,
					 content_type, ref_id, kind, checkpoint, deadline_at, expires_at,
					 relay_state, resolved_at, resolved_via, superseded_at, superseded_by,
					 created_at, carrier, sender_ref, priority, collapse_key
					) VALUES (
					 @id, @delivery_id, @from_agent, @to_agent, @recipient_kind, @source_kind,
					 @source_ref, @type, @msg_class, @content, @delivery_content, @content_ref,
					 @content_type, @ref_id, @kind, @checkpoint, @deadline_at, @expires_at,
					 @relay_state, @resolved_at, @resolved_via, @superseded_at, @superseded_by,
					 @created_at, @carrier, @sender_ref, @priority, @collapse_key
					)`,
					)
					.run(projection);
				const row = this.getById(projection.id);
				if (!row)
					throw new Error(`mailbox insert disappeared: ${projection.id}`);
				return { outcome: "inserted", row };
			})
			.immediate();
	}

	getById(idOrDeliveryId: string): MailboxRow | undefined {
		return this.db
			.prepare("SELECT * FROM mailbox WHERE id = ? OR delivery_id = ?")
			.get(idOrDeliveryId, idOrDeliveryId) as MailboxRow | undefined;
	}

	countDeliverable(toAgent?: string): number {
		const row = this.db
			.prepare(
				`SELECT COUNT(*) AS count FROM mailbox
				  WHERE carrier = 'inbox' AND state = 'QUEUED'
				    AND (next_retry_at IS NULL OR next_retry_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
				    AND (? IS NULL OR to_agent = ?)`,
			)
			.get(toAgent ?? null, toAgent ?? null) as { count: number };
		return row.count;
	}

	acquireOrRenewOwner(input: {
		ownerEpoch: string;
		now: string;
		leaseTtlMs: number;
	}): boolean {
		const expiresAt = addMilliseconds(input.now, input.leaseTtlMs);
		const result = this.db
			.prepare(
				`INSERT INTO loop_owner (singleton, owner_epoch, lease_expires_at, renewed_at)
				 VALUES (1, ?, ?, ?)
				 ON CONFLICT(singleton) DO UPDATE SET
				   owner_epoch = excluded.owner_epoch,
				   lease_expires_at = excluded.lease_expires_at,
				   renewed_at = excluded.renewed_at
				 WHERE loop_owner.owner_epoch = excluded.owner_epoch
				    OR loop_owner.lease_expires_at < excluded.renewed_at`,
			)
			.run(input.ownerEpoch, expiresAt, input.now);
		return result.changes === 1;
	}

	isCurrentOwner(ownerEpoch: string, now: string): boolean {
		return Boolean(
			this.db
				.prepare(
					"SELECT 1 FROM loop_owner WHERE singleton = 1 AND owner_epoch = ? AND lease_expires_at > ?",
				)
				.get(ownerEpoch, now),
		);
	}

	claimLeadBatch(input: {
		toAgent: string;
		msgClass: MailboxMessageClass;
		ownerEpoch: string;
		batchId: string;
		now: string;
		claimTtlMs: number;
		maxBatchSize?: number;
	}): MailboxRow[] {
		const claimExpiresAt = addMilliseconds(input.now, input.claimTtlMs);
		return this.db
			.transaction(() => {
				if (!this.isCurrentOwner(input.ownerEpoch, input.now)) return [];
				const frozen = this.db
					.prepare(
						`SELECT batch_id FROM mailbox
					  WHERE to_agent = ? AND recipient_kind = 'lead' AND carrier = 'inbox'
					    AND msg_class = ? AND state = 'LEASED' AND batch_id IS NOT NULL
					    AND (next_retry_at IS NULL OR next_retry_at <= ?)
					  ORDER BY priority, seq LIMIT 1`,
					)
					.get(input.toAgent, input.msgClass, input.now) as
					| { batch_id: string }
					| undefined;
				if (frozen) {
					const rows = this.db
						.prepare(
							"SELECT * FROM mailbox WHERE batch_id = ? AND to_agent = ? AND state = 'LEASED' ORDER BY priority, seq",
						)
						.all(frozen.batch_id, input.toAgent) as MailboxRow[];
					const ids = rows.map(({ id }) => id);
					if (ids.length === 0) return [];
					const updated = this.db
						.prepare(
							`UPDATE mailbox SET claimed_by = ?, claim_expires_at = ?, last_error = NULL
						  WHERE id IN (${placeholders(ids.length)}) AND state = 'LEASED'
						    AND (next_retry_at IS NULL OR next_retry_at <= ?)
						    AND (claimed_by IS NULL OR claimed_by = ? OR claim_expires_at < ?)`,
						)
						.run(
							input.ownerEpoch,
							claimExpiresAt,
							...ids,
							input.now,
							input.ownerEpoch,
							input.now,
						);
					if (updated.changes !== ids.length) return [];
					return this.db
						.prepare(
							"SELECT * FROM mailbox WHERE batch_id = ? ORDER BY priority, seq",
						)
						.all(frozen.batch_id) as MailboxRow[];
				}

				const limit = input.maxBatchSize ?? 10_000;
				if (!Number.isSafeInteger(limit) || limit <= 0) {
					throw new Error("maxBatchSize must be a positive safe integer");
				}
				const rows = this.db
					.prepare(
						`SELECT * FROM mailbox
					  WHERE to_agent = ? AND recipient_kind = 'lead' AND carrier = 'inbox'
					    AND msg_class = ? AND state = 'QUEUED' AND batch_id IS NULL
					    AND (next_retry_at IS NULL OR next_retry_at <= ?)
					  ORDER BY priority, seq LIMIT ?`,
					)
					.all(input.toAgent, input.msgClass, input.now, limit) as MailboxRow[];
				const ids = rows.map(({ id }) => id);
				if (ids.length === 0) return [];
				const updated = this.db
					.prepare(
						`UPDATE mailbox SET state = 'LEASED', batch_id = ?, claimed_by = ?, claim_expires_at = ?
					  WHERE id IN (${placeholders(ids.length)}) AND state = 'QUEUED' AND batch_id IS NULL`,
					)
					.run(input.batchId, input.ownerEpoch, claimExpiresAt, ...ids);
				if (updated.changes !== ids.length) return [];
				return this.db
					.prepare(
						"SELECT * FROM mailbox WHERE batch_id = ? ORDER BY priority, seq",
					)
					.all(input.batchId) as MailboxRow[];
			})
			.immediate();
	}

	ack(idOrDeliveryId: string, now: string): boolean {
		const result = this.db
			.prepare(
				`UPDATE mailbox SET state = 'ACKED', acked_at = COALESCE(acked_at, ?),
				   claimed_by = NULL, claim_expires_at = NULL, next_retry_at = NULL
				 WHERE (id = ? OR delivery_id = ?) AND state IN ('QUEUED','LEASED')`,
			)
			.run(now, idOrDeliveryId, idOrDeliveryId);
		if (result.changes === 1) return true;
		return this.getById(idOrDeliveryId)?.state === "ACKED";
	}

	ackBatch(input: {
		batchId: string;
		ownerEpoch: string;
		memberIds: readonly string[];
		now: string;
	}): boolean {
		return this.db
			.transaction(() => {
				const rows = this.db
					.prepare(
						"SELECT id, delivery_id FROM mailbox WHERE batch_id = ? AND state = 'LEASED' AND claimed_by = ? ORDER BY priority, seq",
					)
					.all(input.batchId, input.ownerEpoch) as Array<{
					id: string;
					delivery_id: string;
				}>;
				if (
					rows.length !== input.memberIds.length ||
					rows.some((row, index) => row.delivery_id !== input.memberIds[index])
				) {
					return false;
				}
				const result = this.db
					.prepare(
						`UPDATE mailbox SET state = 'ACKED', acked_at = COALESCE(acked_at, ?),
					   claimed_by = NULL, claim_expires_at = NULL, next_retry_at = NULL
					 WHERE batch_id = ? AND state = 'LEASED' AND claimed_by = ?`,
					)
					.run(input.now, input.batchId, input.ownerEpoch);
				return result.changes === rows.length;
			})
			.immediate();
	}

	recordLeadDeliveryFailure(input: {
		batchId: string;
		ownerEpoch: string;
		now: string;
		nextRetryAt: string;
		error: string;
		maxAttempts: number;
	}): number {
		const result = this.db
			.prepare(
				`UPDATE mailbox SET
				   retry_count = retry_count + 1,
				   last_error = ?,
				   next_retry_at = CASE WHEN retry_count + 1 >= ? THEN NULL ELSE ? END,
				   state = CASE WHEN retry_count + 1 >= ? THEN 'DEAD' ELSE 'LEASED' END,
				   dead_at = CASE WHEN retry_count + 1 >= ? THEN ? ELSE dead_at END,
				   dead_reason = CASE WHEN retry_count + 1 >= ? THEN 'delivery_attempts_exhausted' ELSE dead_reason END,
				   batch_id = CASE WHEN retry_count + 1 >= ? THEN NULL ELSE batch_id END,
				   claimed_by = NULL,
				   claim_expires_at = NULL
				 WHERE batch_id = ? AND state = 'LEASED' AND claimed_by = ?`,
			)
			.run(
				input.error,
				input.maxAttempts,
				input.nextRetryAt,
				input.maxAttempts,
				input.maxAttempts,
				input.now,
				input.maxAttempts,
				input.maxAttempts,
				input.batchId,
				input.ownerEpoch,
			);
		return result.changes;
	}

	settle(input: {
		messageOrDeliveryId: string;
		event: "processed" | "disposed";
		now: string;
		evidence: unknown;
	}): "inserted" | "idempotent" {
		return this.db
			.transaction(() => {
				const identity = this.db
					.prepare(
						"SELECT id FROM mailbox_identity WHERE id = ? OR delivery_id = ?",
					)
					.get(input.messageOrDeliveryId, input.messageOrDeliveryId) as
					| { id: string }
					| undefined;
				if (!identity) {
					throw new Error(
						`mailbox identity not found: ${input.messageOrDeliveryId}`,
					);
				}
				const rowJson = JSON.stringify(input.evidence);
				const existing = this.db
					.prepare(
						"SELECT event, at, row_json FROM mailbox_log WHERE subject_id = ? AND event IN ('processed','disposed')",
					)
					.get(identity.id) as
					| { event: string; at: string; row_json: string }
					| undefined;
				if (existing) {
					if (
						existing.event === input.event &&
						existing.at === input.now &&
						existing.row_json === rowJson
					) {
						return "idempotent";
					}
					throw new Error(`mailbox settlement conflict: ${identity.id}`);
				}
				this.db
					.prepare(
						"INSERT INTO mailbox_log (event_id, message_id, subject_id, event, at, row_json) VALUES (?, ?, ?, ?, ?, ?)",
					)
					.run(
						`settled:${identity.id}`,
						identity.id,
						identity.id,
						input.event,
						input.now,
						rowJson,
					);
				return "inserted";
			})
			.immediate();
	}

	archive(id: string, now: string): "archived" | "idempotent" {
		return this.db
			.transaction(() => {
				const row = this.getById(id);
				if (!row) {
					const identity = this.db
						.prepare("SELECT archived_at FROM mailbox_identity WHERE id = ?")
						.get(id) as { archived_at: string | null } | undefined;
					if (identity?.archived_at) return "idempotent";
					throw new Error(`mailbox row not found: ${id}`);
				}
				if (row.state !== "ACKED" && row.state !== "DEAD") {
					throw new Error(`mailbox row is not terminal: ${id}`);
				}
				this.db
					.prepare(
						"INSERT INTO mailbox_log (event_id, message_id, event, at, row_json) VALUES (?, ?, 'archived', ?, ?)",
					)
					.run(`archived:${id}`, id, now, JSON.stringify(row));
				this.db
					.prepare(
						"UPDATE mailbox_identity SET archived_at = ? WHERE id = ? AND archived_at IS NULL",
					)
					.run(now, id);
				this.db.prepare("DELETE FROM mailbox WHERE id = ?").run(id);
				return "archived";
			})
			.immediate();
	}

	close(): void {
		if (this.ownsConnection) this.db.close();
	}
}
