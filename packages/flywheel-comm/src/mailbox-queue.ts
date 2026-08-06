import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { canonicalJsonString } from "flywheel-config";
import {
	assertNoLoneSurrogate,
	normalizeInboxContent,
} from "./inbox-write-normalize.js";
import { MAILBOX_SCHEMA } from "./mailbox-schema.js";
import { decodeSenderRef } from "./sender-ref.js";
import { isValidRefPath } from "./utils/content-ref.js";

export type MailboxState = "QUEUED" | "LEASED" | "ACKED" | "DEAD";
export type MailboxRecipientKind = "lead" | "runner" | "bridge";
export type MailboxMessageClass = "protocol" | "model";
export type MailboxPriority = 0 | 1 | 2 | 3;

export const CHAT_DELIVERY_UNCONFIRMED_REASON =
	"chat_delivery_unconfirmed" as const;

/**
 * FLY-1646: every `dead_reason` that means "quarantined for visibility", which
 * `excludeQuarantined` filters on. Migrated rows carry the legacy
 * `lead_inbox.disposition` value verbatim (see `classifyLead` in
 * mailbox-migration.ts), so the pre-merge spelling must be matched too or the
 * opt-in silently misses every pre-cutover receipt.
 */
export const QUARANTINE_DEAD_REASONS = [
	CHAT_DELIVERY_UNCONFIRMED_REASON,
	"delivery_quarantined",
] as const;

export type ProcessedActorKind =
	| "lead"
	| "bridge-protocol"
	| "founder-writer"
	| "runner";

export interface ProcessedEvidenceV1 {
	v: 1;
	kind: string;
	ref: string;
	actor: string;
	actor_kind: ProcessedActorKind;
	fence: Record<string, string | number>;
	basis?: string[];
}

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

export interface MailboxSettlement {
	event: "processed" | "disposed";
	at: string;
	evidence: unknown;
}

export interface MailboxLoopHeartbeat {
	lead_id: string;
	last_started_at: string | null;
	last_success_at: string | null;
	stall_episode_at: string | null;
}

export interface MailboxArchiveSweepResult {
	archivedFamilies: number;
	archivedMessages: number;
	skippedOversized: number;
	skippedInvalidContentRef: number;
	busy: boolean;
}

export type MailboxArchiveFamilyResult =
	| "archived"
	| "idempotent"
	| "not_due"
	| "oversized"
	| "invalid_content_ref";

function requiredText(value: string, field: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${field} is required`);
	return assertNoLoneSurrogate(field, trimmed);
}

const UTC_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export function assertUtcIsoTimestamp(value: string, field: string): void {
	if (!UTC_ISO_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
		throw new Error(`${field} must be a valid UTC ISO timestamp ending in Z`);
	}
}

export function assertProcessedEvidence(evidence: ProcessedEvidenceV1): void {
	if (!evidence || typeof evidence !== "object" || evidence.v !== 1) {
		throw new Error("processed evidence must use schema version 1");
	}
	requiredText(evidence.kind, "evidence.kind");
	requiredText(evidence.ref, "evidence.ref");
	requiredText(evidence.actor, "evidence.actor");
	if (
		!["lead", "bridge-protocol", "founder-writer", "runner"].includes(
			evidence.actor_kind,
		)
	) {
		throw new Error("processed evidence actor_kind is invalid");
	}
	if (
		!evidence.fence ||
		typeof evidence.fence !== "object" ||
		Array.isArray(evidence.fence) ||
		Object.keys(evidence.fence).length === 0
	) {
		throw new Error("processed evidence fence must be non-empty");
	}
	for (const [key, value] of Object.entries(evidence.fence)) {
		requiredText(key, "evidence fence key");
		if (
			(typeof value === "string" && value.trim().length > 0) ||
			(typeof value === "number" && Number.isSafeInteger(value))
		) {
			continue;
		}
		throw new Error(`processed evidence fence ${key} is invalid`);
	}
	if (
		evidence.basis !== undefined &&
		(!Array.isArray(evidence.basis) ||
			evidence.basis.some(
				(value) => typeof value !== "string" || !value.trim(),
			))
	) {
		throw new Error("processed evidence basis must contain non-empty strings");
	}
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

	countRunnerDeliverable(): number {
		const row = this.db
			.prepare(
				`SELECT COUNT(*) AS count FROM mailbox
				  WHERE recipient_kind = 'runner' AND carrier = 'inbox'
				    AND state = 'QUEUED'
				    AND (next_retry_at IS NULL OR next_retry_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
			)
			.get() as { count: number };
		return row.count;
	}

	/**
	 * FLY-1646: the state guard here is the exact dual of
	 * `listExternalPending`'s — anything that predicate can hand out for
	 * redelivery, this must be able to retire. Restricting it to QUEUED left
	 * quarantined (DEAD) receipts unable to converge: the recovery pass would
	 * re-notify them forever because delivery could never be recorded, and
	 * `ExternalReceiptSaga.complete()` throws outright on a recovered xdept
	 * receipt. It also contradicted `CommDB.quarantineChatReceipt`'s contract,
	 * which states that a later redelivery may still mark the same external row
	 * delivered. Keeping the two guards symmetric is what guarantees the loop
	 * terminates.
	 */
	markExternalDelivered(id: string, now: string): boolean {
		const result = this.db
			.prepare(
				`UPDATE mailbox SET state = 'ACKED', acked_at = COALESCE(acked_at, ?),
				   claimed_by = NULL, claim_expires_at = NULL
				 WHERE id = ? AND carrier = 'external' AND state <> 'ACKED'`,
			)
			.run(now, id);
		return (
			result.changes === 1 ||
			(this.getById(id)?.carrier === "external" &&
				this.getById(id)?.state === "ACKED")
		);
	}

	/**
	 * External receipts that are still AWAITING DELIVERY.
	 *
	 * FLY-1646: `state <> 'ACKED'` is load-bearing, not decoration. It is the
	 * mailbox-schema translation of the pre-FLY-1572 guard `delivered_at IS
	 * NULL` — `markExternalDelivered` is the only writer that moves an external
	 * row to ACKED, so a delivered receipt leaves this set exactly as it used
	 * to. Dropping that guard in the merge is what caused the FLY-1646 storm:
	 * the Discord plugin's ChatReceiptRuntime recovery pass re-emits every
	 * returned row with a `[redelivery]` prefix and then calls `complete`, so
	 * once `complete` could no longer retire a row the pass kept seeing work
	 * (`workRemains`) while `complete` kept reporting success (`progress`) and
	 * neither break in `workerLoop()` could ever fire.
	 *
	 * Do NOT widen this to "delivered but not yet answered". Whether a Lead
	 * actually replied is tracked by the mailbox_log settlement ledger and must
	 * never drive redelivery — that is what turned an unanswered-message
	 * backlog into a fleet-wide Discord storm.
	 *
	 * Equally, do NOT narrow this to `state IN ('QUEUED','LEASED')`. DEAD is
	 * NOT terminal for external receipts: quarantine is visibility only (see
	 * `CommDB.quarantineChatReceipt`), and `ExternalReceiptSaga` marks rows dead
	 * for recoverable reasons such as a temporarily unavailable journal. The
	 * legacy lane kept those rows redeliverable — `quarantineExternalDelivery`
	 * set only `disposition`, never `delivered_at`/`disposed_at` — and excluding
	 * them here would trade the storm for silent message loss. Genuine disposal
	 * is a `disposed` settlement row, which the NOT EXISTS clause already
	 * excludes.
	 *
	 * `excludeQuarantined` is the caller's opt-in to drop quarantined rows,
	 * mirroring the legacy `disposition <> 'delivery_quarantined'` filter.
	 */
	listExternalPending(input: {
		toAgent: string;
		idPrefix: string;
		cursorSeq?: number;
		limit?: number;
		createdBefore?: string;
		excludeQuarantined?: boolean;
	}): MailboxRow[] {
		return this.db
			.prepare(
				`SELECT mailbox.* FROM mailbox
				  WHERE to_agent = ? AND carrier = 'external'
				    AND state <> 'ACKED'
				    AND id LIKE ? ESCAPE '\\'
				    AND seq > ?
				    AND (? IS NULL OR datetime(created_at) <= datetime(?))
				    AND (? = 0 OR dead_reason IS NULL
				         OR dead_reason NOT IN (${placeholders(QUARANTINE_DEAD_REASONS.length)}))
				    AND NOT EXISTS (
				      SELECT 1 FROM mailbox_log settlement
				       WHERE settlement.subject_id = mailbox.id
				         AND settlement.event IN ('processed','disposed')
				    )
				  ORDER BY seq LIMIT ?`,
			)
			.all(
				input.toAgent,
				`${input.idPrefix.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`,
				input.cursorSeq ?? 0,
				input.createdBefore ?? null,
				input.createdBefore ?? null,
				input.excludeQuarantined ? 1 : 0,
				...QUARANTINE_DEAD_REASONS,
				input.limit ?? 100,
			) as MailboxRow[];
	}

	markDead(id: string, now: string, reason: string): boolean {
		const result = this.db
			.prepare(
				`UPDATE mailbox SET state = 'DEAD', dead_at = COALESCE(dead_at, ?),
				   dead_reason = COALESCE(dead_reason, ?), last_error = COALESCE(last_error, ?),
				   claimed_by = NULL, claim_expires_at = NULL, next_retry_at = NULL,
				   batch_id = NULL
				 WHERE id = ? AND state IN ('QUEUED','LEASED')`,
			)
			.run(now, reason, reason, id);
		if (result.changes === 1) return true;
		const row = this.getById(id);
		return row?.state === "DEAD" && row.dead_reason === reason;
	}

	releaseClaimForRetry(input: {
		id: string;
		ownerEpoch: string;
		batchId: string;
		nextRetryAt: string;
		reason: string;
	}): boolean {
		return (
			this.db
				.prepare(
					`UPDATE mailbox SET state = 'QUEUED', claimed_by = NULL,
					   claim_expires_at = NULL, batch_id = NULL, next_retry_at = ?,
					   last_error = ?
					 WHERE id = ? AND state = 'LEASED' AND claimed_by = ? AND batch_id = ?`,
				)
				.run(
					input.nextRetryAt,
					input.reason,
					input.id,
					input.ownerEpoch,
					input.batchId,
				).changes === 1
		);
	}

	recordTickStarted(leadId: string, now: string): void {
		this.db
			.prepare(
				`INSERT INTO loop_heartbeat (lead_id, last_started_at)
				 VALUES (?, ?) ON CONFLICT(lead_id) DO UPDATE SET last_started_at = excluded.last_started_at`,
			)
			.run(leadId, now);
	}

	recordTickSuccess(leadId: string, now: string): void {
		this.db
			.prepare(
				`INSERT INTO loop_heartbeat (lead_id, last_started_at, last_success_at)
				 VALUES (?, ?, ?) ON CONFLICT(lead_id) DO UPDATE SET
				 last_success_at = excluded.last_success_at, stall_episode_at = NULL`,
			)
			.run(leadId, now, now);
	}

	getHeartbeat(leadId: string): MailboxLoopHeartbeat | undefined {
		return this.db
			.prepare("SELECT * FROM loop_heartbeat WHERE lead_id = ?")
			.get(leadId) as MailboxLoopHeartbeat | undefined;
	}

	materializeForDelivery(input: {
		id: string;
		ownerEpoch: string;
		batchId: string;
		sourceKind: string;
		sourceRef: string;
		deliveryContent: string;
	}): MailboxRow {
		const result = this.db
			.prepare(
				`UPDATE mailbox SET source_kind = ?, source_ref = ?, delivery_content = ?,
				   relay_state = CASE WHEN type = 'question' THEN 'protected' ELSE relay_state END
				 WHERE id = ? AND state = 'LEASED' AND claimed_by = ? AND batch_id = ?
				   AND source_ref IS NULL AND delivery_content IS NULL`,
			)
			.run(
				input.sourceKind,
				input.sourceRef,
				input.deliveryContent,
				input.id,
				input.ownerEpoch,
				input.batchId,
			);
		const row = this.getById(input.id);
		if (!row) throw new Error(`mailbox row not found: ${input.id}`);
		if (
			result.changes !== 1 &&
			(row.source_kind !== input.sourceKind ||
				row.source_ref !== input.sourceRef ||
				row.delivery_content !== input.deliveryContent)
		) {
			throw new Error(`mailbox materialization conflict: ${input.id}`);
		}
		return row;
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

	claimBridgeProtocol(input: {
		fromAgent: string;
		ownerEpoch: string;
		now: string;
		claimTtlMs: number;
	}): MailboxRow | undefined {
		const claimExpiresAt = addMilliseconds(input.now, input.claimTtlMs);
		return this.db
			.transaction(() => {
				if (!this.isCurrentOwner(input.ownerEpoch, input.now)) return undefined;
				const row = this.db
					.prepare(
						`SELECT * FROM mailbox
						  WHERE recipient_kind = 'bridge' AND carrier = 'inbox'
						    AND from_agent = ? AND msg_class = 'protocol'
						    AND (next_retry_at IS NULL OR next_retry_at <= ?)
						    AND (state = 'QUEUED' OR
						      (state = 'LEASED' AND
						       (claimed_by IS NULL OR claimed_by = ? OR claim_expires_at < ?)))
						  ORDER BY priority, seq LIMIT 1`,
					)
					.get(input.fromAgent, input.now, input.ownerEpoch, input.now) as
					| MailboxRow
					| undefined;
				if (!row) return undefined;
				const updated = this.db
					.prepare(
						`UPDATE mailbox SET state = 'LEASED', claimed_by = ?, claim_expires_at = ?
						 WHERE id = ? AND state IN ('QUEUED','LEASED')
						   AND (claimed_by IS NULL OR claimed_by = ? OR claim_expires_at < ?)`,
					)
					.run(
						input.ownerEpoch,
						claimExpiresAt,
						row.id,
						input.ownerEpoch,
						input.now,
					);
				return updated.changes === 1 ? this.getById(row.id) : undefined;
			})
			.immediate();
	}

	claimRunner(input: {
		ownerEpoch: string;
		now: string;
		claimTtlMs: number;
	}): MailboxRow | undefined {
		const claimExpiresAt = addMilliseconds(input.now, input.claimTtlMs);
		return this.db
			.transaction(() => {
				if (!this.isCurrentOwner(input.ownerEpoch, input.now)) return undefined;
				const row = this.db
					.prepare(
						`SELECT * FROM mailbox
						  WHERE recipient_kind = 'runner' AND carrier = 'inbox'
						    AND state = 'QUEUED'
						    AND (next_retry_at IS NULL OR next_retry_at <= ?)
						  ORDER BY priority, seq LIMIT 1`,
					)
					.get(input.now) as MailboxRow | undefined;
				if (!row) return undefined;
				const updated = this.db
					.prepare(
						`UPDATE mailbox SET state = 'LEASED', claimed_by = ?, claim_expires_at = ?
						 WHERE id = ? AND state = 'QUEUED'`,
					)
					.run(input.ownerEpoch, claimExpiresAt, row.id);
				return updated.changes === 1 ? this.getById(row.id) : undefined;
			})
			.immediate();
	}

	recordRunnerDeliverySuccess(input: {
		id: string;
		ownerEpoch: string;
	}): boolean {
		return (
			this.db
				.prepare(
					`UPDATE mailbox SET last_error = NULL, next_retry_at = NULL
					 WHERE id = ? AND recipient_kind = 'runner'
					   AND state = 'LEASED' AND claimed_by = ?`,
				)
				.run(input.id, input.ownerEpoch).changes === 1
		);
	}

	recordRunnerDeliveryFailure(input: {
		id: string;
		ownerEpoch: string;
		now: string;
		nextRetryAt: string;
		error: string;
		maxAttempts: number;
	}): { deadLettered: boolean } {
		const updated = this.db
			.prepare(
				`UPDATE mailbox SET retry_count = retry_count + 1, last_error = ?,
				   next_retry_at = CASE WHEN retry_count + 1 >= ? THEN NULL ELSE ? END,
				   state = CASE WHEN retry_count + 1 >= ? THEN 'DEAD' ELSE 'QUEUED' END,
				   dead_at = CASE WHEN retry_count + 1 >= ? THEN ? ELSE dead_at END,
				   dead_reason = CASE WHEN retry_count + 1 >= ? THEN 'delivery_attempts_exhausted' ELSE dead_reason END,
				   claimed_by = NULL, claim_expires_at = NULL
				 WHERE id = ? AND recipient_kind = 'runner'
				   AND state = 'LEASED' AND claimed_by = ?`,
			)
			.run(
				input.error,
				input.maxAttempts,
				input.nextRetryAt,
				input.maxAttempts,
				input.maxAttempts,
				input.now,
				input.maxAttempts,
				input.id,
				input.ownerEpoch,
			);
		if (updated.changes !== 1) throw new Error("runner claim fence lost");
		return { deadLettered: this.getById(input.id)?.state === "DEAD" };
	}

	recordBridgeDeliveryFailure(input: {
		id: string;
		ownerEpoch: string;
		now: string;
		nextRetryAt: string;
		error: string;
		maxAttempts: number;
	}): { deadLettered: boolean } {
		const updated = this.db
			.prepare(
				`UPDATE mailbox SET retry_count = retry_count + 1, last_error = ?,
				   next_retry_at = CASE WHEN retry_count + 1 >= ? THEN NULL ELSE ? END,
				   state = CASE WHEN retry_count + 1 >= ? THEN 'DEAD' ELSE 'LEASED' END,
				   dead_at = CASE WHEN retry_count + 1 >= ? THEN ? ELSE dead_at END,
				   dead_reason = CASE WHEN retry_count + 1 >= ? THEN 'delivery_attempts_exhausted' ELSE dead_reason END,
				   claimed_by = NULL, claim_expires_at = NULL
				 WHERE id = ? AND state = 'LEASED' AND claimed_by = ?`,
			)
			.run(
				input.error,
				input.maxAttempts,
				input.nextRetryAt,
				input.maxAttempts,
				input.maxAttempts,
				input.now,
				input.maxAttempts,
				input.id,
				input.ownerEpoch,
			);
		if (updated.changes !== 1) throw new Error("bridge claim fence lost");
		return { deadLettered: this.getById(input.id)?.state === "DEAD" };
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
		if (input.memberIds.length === 0) return false;
		return this.db
			.transaction(() => {
				const rows = this.db
					.prepare(
						"SELECT delivery_id, state, claimed_by FROM mailbox WHERE batch_id = ? ORDER BY priority, seq",
					)
					.all(input.batchId) as Array<{
					delivery_id: string;
					state: MailboxState;
					claimed_by: string | null;
				}>;
				const memberIds = new Set(input.memberIds);
				const members = rows.filter((row) => memberIds.has(row.delivery_id));
				if (
					members.length !== input.memberIds.length ||
					members.some(
						(row, index) => row.delivery_id !== input.memberIds[index],
					) ||
					members.some(
						(row) =>
							row.state !== "ACKED" &&
							row.state !== "DEAD" &&
							(row.state !== "LEASED" || row.claimed_by !== input.ownerEpoch),
					)
				) {
					return false;
				}
				const leasedCount = members.filter(
					(row) => row.state === "LEASED",
				).length;
				const result = this.db
					.prepare(
						`UPDATE mailbox SET state = 'ACKED', acked_at = COALESCE(acked_at, ?),
					   claimed_by = NULL, claim_expires_at = NULL, next_retry_at = NULL
					 WHERE batch_id = ? AND delivery_id IN (${placeholders(input.memberIds.length)})
					   AND state = 'LEASED' AND claimed_by = ?`,
					)
					.run(input.now, input.batchId, ...input.memberIds, input.ownerEpoch);
				return result.changes === leasedCount;
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
				const rowJson = canonicalJsonString(input.evidence);
				const existing = this.db
					.prepare(
						"SELECT event, at, row_json FROM mailbox_log WHERE subject_id = ? AND event IN ('processed','disposed')",
					)
					.get(identity.id) as
					| { event: string; at: string; row_json: string }
					| undefined;
				if (existing) {
					if (existing.event === input.event && existing.row_json === rowJson) {
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

	getSettlement(messageOrDeliveryId: string): MailboxSettlement | undefined {
		const row = this.db
			.prepare(
				`SELECT log.event, log.at, log.row_json
				   FROM mailbox_identity identity
				   JOIN mailbox_log log ON log.subject_id = identity.id
				  WHERE (identity.id = ? OR identity.delivery_id = ?)
				    AND log.event IN ('processed','disposed')`,
			)
			.get(messageOrDeliveryId, messageOrDeliveryId) as
			| { event: "processed" | "disposed"; at: string; row_json: string }
			| undefined;
		return row
			? { event: row.event, at: row.at, evidence: JSON.parse(row.row_json) }
			: undefined;
	}

	archiveDueFamilies(input: {
		now: string;
		retentionMs?: number;
		maxFamilies?: number;
		maxFamilyBytes?: number;
	}): MailboxArchiveSweepResult {
		const retentionMs = input.retentionMs ?? 72 * 60 * 60_000;
		const maxFamilies = input.maxFamilies ?? 10;
		const maxFamilyBytes = input.maxFamilyBytes ?? 2 * 1024 * 1024;
		assertUtcIsoTimestamp(input.now, "now");
		if (!Number.isSafeInteger(retentionMs) || retentionMs < 0) {
			throw new Error("retentionMs must be a non-negative safe integer");
		}
		if (!Number.isSafeInteger(maxFamilies) || maxFamilies <= 0) {
			throw new Error("maxFamilies must be a positive safe integer");
		}
		const cutoff = new Date(Date.parse(input.now) - retentionMs).toISOString();
		const candidateLimit = maxFamilies * 4;
		const candidates = [
			...(this.db
				.prepare(
					`SELECT id, acked_at AS terminal_at FROM mailbox
					  WHERE state = 'ACKED' AND acked_at <= ?
					  ORDER BY acked_at, seq LIMIT ?`,
				)
				.all(cutoff, candidateLimit) as Array<{
				id: string;
				terminal_at: string;
			}>),
			...(this.db
				.prepare(
					`SELECT id, dead_at AS terminal_at FROM mailbox
					  WHERE state = 'DEAD' AND dead_at <= ?
					  ORDER BY dead_at, seq LIMIT ?`,
				)
				.all(cutoff, candidateLimit) as Array<{
				id: string;
				terminal_at: string;
			}>),
		].sort((left, right) => left.terminal_at.localeCompare(right.terminal_at));
		const result: MailboxArchiveSweepResult = {
			archivedFamilies: 0,
			archivedMessages: 0,
			skippedOversized: 0,
			skippedInvalidContentRef: 0,
			busy: false,
		};
		const seen = new Set<string>();
		for (const candidate of candidates) {
			if (result.archivedFamilies >= maxFamilies) break;
			const row = this.getById(candidate.id);
			if (!row) continue;
			const rootId = this.familyRootId(row);
			if (seen.has(rootId)) continue;
			seen.add(rootId);
			const memberCount = this.loadFamily(rootId).length;
			try {
				const outcome = this.archiveFamily({
					id: rootId,
					now: input.now,
					retentionMs,
					maxFamilyBytes,
				});
				if (outcome === "archived") {
					result.archivedFamilies++;
					result.archivedMessages += memberCount;
				} else if (outcome === "oversized") {
					result.skippedOversized++;
				} else if (outcome === "invalid_content_ref") {
					result.skippedInvalidContentRef++;
				}
			} catch (error) {
				if ((error as { code?: string }).code !== "SQLITE_BUSY") throw error;
				result.busy = true;
				break;
			}
		}
		return result;
	}

	archiveFamily(input: {
		id: string;
		now: string;
		retentionMs?: number;
		maxFamilyBytes?: number;
	}): MailboxArchiveFamilyResult {
		assertUtcIsoTimestamp(input.now, "now");
		const retentionMs = input.retentionMs ?? 72 * 60 * 60_000;
		if (!Number.isSafeInteger(retentionMs) || retentionMs < 0) {
			throw new Error("retentionMs must be a non-negative safe integer");
		}
		const member = this.getById(input.id);
		if (!member) {
			const identity = this.db
				.prepare("SELECT archived_at FROM mailbox_identity WHERE id = ?")
				.get(input.id) as { archived_at: string | null } | undefined;
			if (identity?.archived_at) return "idempotent";
			throw new Error(`mailbox row not found: ${input.id}`);
		}
		const rootId = this.familyRootId(member);
		const rows = this.loadFamily(rootId);
		if (
			rows.length === 0 ||
			rows.some((row) => row.state !== "ACKED" && row.state !== "DEAD")
		) {
			return "not_due";
		}
		const question = rows.find(
			(row) => row.id === rootId && row.type === "question",
		);
		if (
			question &&
			question.relay_state !== "terminal_disposed" &&
			!rows.some((row) => row.type === "response" && row.ref_id === rootId)
		) {
			return "not_due";
		}
		const terminalTimes = rows.map((row) =>
			Date.parse(
				row.state === "ACKED" ? (row.acked_at ?? "") : (row.dead_at ?? ""),
			),
		);
		if (
			terminalTimes.some((value) => !Number.isFinite(value)) ||
			Math.max(...terminalTimes) + retentionMs > Date.parse(input.now)
		) {
			return "not_due";
		}

		const snapshots: Array<{
			row: MailboxRow;
			rowJson: string;
			ref?: { path: string; hash: string };
		}> = [];
		let familyBytes = 0;
		for (const row of rows) {
			let contentRefArchive:
				| {
						path: string;
						bytes: number;
						sha256: string;
						content_base64: string;
				  }
				| undefined;
			if (row.content_ref) {
				if (!isValidRefPath(row.content_ref)) return "invalid_content_ref";
				let bytes: Buffer;
				try {
					bytes = readFileSync(row.content_ref);
				} catch {
					return "invalid_content_ref";
				}
				contentRefArchive = {
					path: row.content_ref,
					bytes: bytes.length,
					sha256: createHash("sha256").update(bytes).digest("hex"),
					content_base64: bytes.toString("base64"),
				};
			}
			const rowJson = canonicalJsonString({
				...row,
				...(contentRefArchive
					? { content_ref_archive: contentRefArchive }
					: {}),
			});
			familyBytes += Buffer.byteLength(rowJson);
			snapshots.push({
				row,
				rowJson,
				...(contentRefArchive
					? {
							ref: {
								path: contentRefArchive.path,
								hash: contentRefArchive.sha256,
							},
						}
					: {}),
			});
		}
		if (familyBytes > (input.maxFamilyBytes ?? 2 * 1024 * 1024)) {
			return "oversized";
		}

		return this.db
			.transaction((): MailboxArchiveFamilyResult => {
				const liveRows = this.loadFamily(rootId);
				if (canonicalJsonString(liveRows) !== canonicalJsonString(rows)) {
					return "not_due";
				}
				for (const snapshot of snapshots) {
					this.db
						.prepare(
							"INSERT INTO mailbox_log (event_id, message_id, event, at, row_json) VALUES (?, ?, 'archived', ?, ?)",
						)
						.run(
							`archived:${snapshot.row.id}`,
							snapshot.row.id,
							input.now,
							snapshot.rowJson,
						);
					if (snapshot.ref) {
						this.db
							.prepare(
								`INSERT INTO content_ref_gc_outbox
								 (intent_id, message_id, path, content_hash, created_at)
								 VALUES (?, ?, ?, ?, ?)`,
							)
							.run(
								`gc:${snapshot.row.id}`,
								snapshot.row.id,
								snapshot.ref.path,
								snapshot.ref.hash,
								input.now,
							);
					}
					if (
						this.db
							.prepare(
								"UPDATE mailbox_identity SET archived_at = ? WHERE id = ? AND archived_at IS NULL",
							)
							.run(input.now, snapshot.row.id).changes !== 1
					) {
						throw new Error(
							`mailbox identity archive conflict: ${snapshot.row.id}`,
						);
					}
					this.db
						.prepare("DELETE FROM mailbox WHERE id = ?")
						.run(snapshot.row.id);
				}
				return "archived";
			})
			.immediate();
	}

	drainContentRefGc(input: {
		now: string;
		limit?: number;
		removeFile?: (path: string) => void;
	}): { done: number; pending: number } {
		assertUtcIsoTimestamp(input.now, "now");
		const limit = input.limit ?? 10;
		const intents = this.db
			.prepare(
				`SELECT intent_id, path, content_hash, attempts
				   FROM content_ref_gc_outbox
				  WHERE state = 'pending'
				    AND (next_retry_at IS NULL OR next_retry_at <= ?)
				  ORDER BY created_at LIMIT ?`,
			)
			.all(input.now, limit) as Array<{
			intent_id: string;
			path: string;
			content_hash: string;
			attempts: number;
		}>;
		const result = { done: 0, pending: 0 };
		for (const intent of intents) {
			try {
				const status = this.db
					.transaction((): "done" | "pending" => {
						if (
							(
								this.db
									.prepare(
										"SELECT COUNT(*) AS count FROM mailbox WHERE content_ref = ?",
									)
									.get(intent.path) as { count: number }
							).count > 0
						) {
							this.deferContentRefGc(
								intent,
								input.now,
								"path still has a live mailbox reference",
							);
							return "pending";
						}
						if (!isValidRefPath(intent.path)) {
							this.deferContentRefGc(
								intent,
								input.now,
								"invalid content_ref path",
							);
							return "pending";
						}
						let bytes: Buffer;
						try {
							bytes = readFileSync(intent.path);
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code === "ENOENT") {
								this.finishContentRefGc(intent.intent_id, input.now);
								return "done";
							}
							this.deferContentRefGc(
								intent,
								input.now,
								(error as Error).message,
							);
							return "pending";
						}
						if (
							createHash("sha256").update(bytes).digest("hex") !==
							intent.content_hash
						) {
							this.deferContentRefGc(
								intent,
								input.now,
								"content_ref hash mismatch",
							);
							return "pending";
						}
						try {
							(input.removeFile ?? unlinkSync)(intent.path);
						} catch (error) {
							this.deferContentRefGc(
								intent,
								input.now,
								(error as Error).message,
							);
							return "pending";
						}
						this.finishContentRefGc(intent.intent_id, input.now);
						return "done";
					})
					.immediate();
				result[status]++;
			} catch (error) {
				if ((error as { code?: string }).code !== "SQLITE_BUSY") throw error;
				result.pending++;
				break;
			}
		}
		return result;
	}

	private familyRootId(row: MailboxRow): string {
		if (
			row.type === "response" &&
			row.ref_id &&
			this.db
				.prepare("SELECT 1 FROM mailbox WHERE id = ? AND type = 'question'")
				.get(row.ref_id)
		) {
			return row.ref_id;
		}
		return row.id;
	}

	private loadFamily(rootId: string): MailboxRow[] {
		const root = this.getById(rootId);
		if (!root) return [];
		if (root.type !== "question") return [root];
		return this.db
			.prepare(
				"SELECT * FROM mailbox WHERE id = ? OR (type = 'response' AND ref_id = ?) ORDER BY seq",
			)
			.all(rootId, rootId) as MailboxRow[];
	}

	private deferContentRefGc(
		intent: { intent_id: string; attempts: number },
		now: string,
		error: string,
	): void {
		const delayMs = Math.min(60 * 60_000, 1_000 * 2 ** intent.attempts);
		this.db
			.prepare(
				`UPDATE content_ref_gc_outbox
				    SET attempts = attempts + 1, next_retry_at = ?, last_error = ?
				  WHERE intent_id = ? AND state = 'pending'`,
			)
			.run(
				new Date(Date.parse(now) + delayMs).toISOString(),
				error,
				intent.intent_id,
			);
	}

	private finishContentRefGc(intentId: string, now: string): void {
		this.db
			.prepare(
				`UPDATE content_ref_gc_outbox SET state = 'done', finished_at = ?,
				 next_retry_at = NULL, last_error = NULL
				 WHERE intent_id = ? AND state = 'pending'`,
			)
			.run(now, intentId);
	}

	close(): void {
		if (this.ownsConnection) this.db.close();
	}
}
