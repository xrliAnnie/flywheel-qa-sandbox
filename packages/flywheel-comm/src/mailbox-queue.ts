import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { canonicalJsonString } from "flywheel-config";
import { formatDeadLetterNotice } from "./dead-letter-format.js";
import {
	assertNoLoneSurrogate,
	normalizeInboxContent,
} from "./inbox-write-normalize.js";
import {
	dropReceiptLedgerSchema,
	installMailboxRelayInvariantTriggers,
	MAILBOX_MESSAGE_PROJECTION_SELECT,
	MAILBOX_MESSAGE_PROJECTION_VERSION,
	MAILBOX_SCHEMA,
} from "./mailbox-schema.js";
import { isRunnerStopReport } from "./runner-stop-report.js";
import { decodeSenderRef, encodeSenderRef } from "./sender-ref.js";
import { isValidRefPath } from "./utils/content-ref.js";

export type MailboxState = "QUEUED" | "LEASED" | "ACKED" | "DEAD";
export interface MailboxDeliveryEvidence {
	deadReason: string | null;
	lastError: string | null;
	createdAt: string | null;
	deliveredAt: string | null;
	notifiedAt: string | null;
}
export type MailboxSettlement =
	| { kind: "absent_identity" }
	| ({
			kind: "live";
			state: MailboxState;
			settledAt: string | null;
	  } & MailboxDeliveryEvidence)
	| ({
			kind: "archived_terminal";
			state: "ACKED" | "DEAD";
			settledAt: string;
	  } & MailboxDeliveryEvidence);
export type MailboxRecipientKind = "lead" | "runner" | "bridge";
export type MailboxMessageClass = "protocol" | "model";
export type MailboxPriority = 0 | 1 | 2 | 3;
export type MailboxRecipientState = "alive" | "terminal_or_missing" | "unknown";
export type MailboxBatchDeliveryResult =
	| "applied"
	| "already_settled"
	| "lost_race";
export type RunnerMailboxSettlement = "on_delivery" | "on_consume";
export interface MailboxBatchFailureResult {
	outcome: "applied" | "already_settled" | "lost_race";
	deadLettered: boolean;
}
export type MailboxBatchAckResult = "applied" | "duplicate" | "ack_late_noop";

export interface ReconcileExpiredLeasesResult {
	requeued: number;
	dead: number;
	frozenResend: string[];
	skippedUnknown: number;
	remaining: boolean;
}

export interface DeadLetterNoticeScanResult {
	inserted: string[];
	rateLimited: string[];
	unroutable: string[];
	uncoveredRemaining: boolean;
}

export interface DeadLetterAlertCandidate {
	sourceKind: "lead_unacked" | "runner_unroutable";
	recipient: string;
	throughDeadSeq: number;
	deadCount: number;
	summary: string;
}

export const CHAT_DELIVERY_UNCONFIRMED_REASON =
	"chat_delivery_unconfirmed" as const;
export const FROZEN_DELIVERY_UNCONFIRMED_EXHAUSTED_REASON =
	"delivery_unconfirmed_exhausted" as const;
const FROZEN_DELIVERY_MARKER = /^delivery_unconfirmed:([1-9][0-9]*)$/;

function frozenDeliveryMarkerCount(value: string | null): number | null {
	if (value === null) return null;
	const match = FROZEN_DELIVERY_MARKER.exec(value);
	if (!match) return null;
	const count = Number(match[1]);
	return Number.isSafeInteger(count) && count > 0 ? count : null;
}

function deliveryEvidence(row: Partial<MailboxRow>): MailboxDeliveryEvidence {
	const textOrNull = (value: unknown): string | null =>
		typeof value === "string" ? value : null;
	return {
		deadReason: textOrNull(row.dead_reason),
		lastError: textOrNull(row.last_error),
		createdAt: textOrNull(row.created_at),
		deliveredAt: textOrNull(row.delivered_at),
		notifiedAt: textOrNull(row.notified_at),
	};
}

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
	delivered_at: string | null;
	notified_at: string | null;
	retry_count: number;
	lease_retry_count: number;
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

export type DiscordLaneVerdict =
	| { lane: "inserted_inbox" | "active_inbox"; deliveryId: string; seq: number }
	| { lane: "inserted_external"; deliveryId: string; seq: number }
	| { lane: "legacy_external"; deliveryId: string }
	| { lane: "archived" };

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

function mailboxProjectionHash(projection: unknown): string {
	return createHash("sha256").update(JSON.stringify(projection)).digest("hex");
}

function utf8Prefix(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	let end = value.length;
	while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) {
		end -= 1;
	}
	return value.slice(0, end);
}

const upgradedMailboxConnections = new WeakSet<object>();

function hasMailboxColumn(db: Database.Database, name: string): boolean {
	return (
		db
			.prepare("SELECT 1 FROM pragma_table_info('mailbox') WHERE name = ?")
			.get(name) !== undefined
	);
}

function addMailboxColumn(
	db: Database.Database,
	name: "delivered_at" | "notified_at" | "lease_retry_count",
	sql: string,
): void {
	if (hasMailboxColumn(db, name)) return;
	try {
		db.exec(sql);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!new RegExp(`duplicate column name:\\s*${name}`, "i").test(message)) {
			throw error;
		}
	}
	if (!hasMailboxColumn(db, name)) {
		throw new Error(`mailbox schema upgrade did not create ${name}`);
	}
}

/**
 * FLY-1573: upgrade an already-materialized FLY-1572 mailbox in place.
 * Every connection runs this before queue statements are prepared; repeated
 * wrappers around the same connection are a no-op after the first success.
 */
export function ensureMailboxQueueSchema(db: Database.Database): void {
	if (upgradedMailboxConnections.has(db)) return;
	const mailboxExists = db
		.prepare(
			"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mailbox'",
		)
		.get();
	if (!mailboxExists) {
		throw new Error("mailbox table must exist before queue schema upgrade");
	}
	db.transaction(() => {
		addMailboxColumn(
			db,
			"delivered_at",
			"ALTER TABLE mailbox ADD COLUMN delivered_at TEXT",
		);
		addMailboxColumn(
			db,
			"notified_at",
			"ALTER TABLE mailbox ADD COLUMN notified_at TEXT",
		);
		addMailboxColumn(
			db,
			"lease_retry_count",
			"ALTER TABLE mailbox ADD COLUMN lease_retry_count INTEGER NOT NULL DEFAULT 0",
		);
		db.exec(`CREATE INDEX IF NOT EXISTS mailbox_lease_expiry
			ON mailbox(claim_expires_at)
			WHERE state = 'LEASED' AND carrier = 'inbox'`);
		// Caller-owned compatibility schemas may expose only the lease columns.
		// Production FLY-1572 mailboxes have the full set and must receive the
		// FLY-2136 indexes on their first writable open.
		if (
			[
				"recipient_kind",
				"to_agent",
				"seq",
				"source_ref",
				"type",
				"source_kind",
				"batch_id",
				"priority",
				"claim_expires_at",
				"ref_id",
				"superseded_by",
			].every((name) => hasMailboxColumn(db, name))
		) {
			db.exec(`CREATE INDEX IF NOT EXISTS mailbox_dead_scan
				ON mailbox(recipient_kind, to_agent, seq)
				WHERE state = 'DEAD' AND carrier = 'inbox';
				CREATE INDEX IF NOT EXISTS mailbox_dead_notice_lookup
				ON mailbox(source_ref, seq)
				WHERE type = 'dead_letter_notice' AND source_kind = 'dead_letter';
				CREATE INDEX IF NOT EXISTS mailbox_batch_lookup
				ON mailbox(batch_id, priority, seq)
				WHERE batch_id IS NOT NULL;
				CREATE INDEX IF NOT EXISTS mailbox_lease_expiry_order
				ON mailbox(priority, seq, claim_expires_at)
				WHERE state = 'LEASED' AND carrier = 'inbox' AND batch_id IS NOT NULL;
				CREATE INDEX IF NOT EXISTS mailbox_ref_lookup
				ON mailbox(ref_id) WHERE ref_id IS NOT NULL;
				CREATE INDEX IF NOT EXISTS mailbox_superseded_by_lookup
				ON mailbox(superseded_by) WHERE superseded_by IS NOT NULL`);
		}

		const projection = db
			.prepare(
				"SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'mailbox_message_projection'",
			)
			.get() as { sql: string } | undefined;
		// Caller-owned minimal mailbox schemas intentionally do not own the CommDB
		// projection. Do not prepare full-schema migration SQL against them.
		if (!projection) return;
		if (projection.sql.includes(MAILBOX_MESSAGE_PROJECTION_VERSION)) return;

		// One-time v1 -> v2 evidence migration only. Once the projection is v2,
		// legacy-push may be a live pre-notify claim and must remain unnotified.
		db.prepare(
			`UPDATE mailbox SET notified_at = claim_expires_at
			  WHERE type = 'instruction' AND state = 'LEASED'
			    AND claimed_by = 'legacy-push' AND batch_id IS NULL
			    AND notified_at IS NULL`,
		).run();
		db.exec(`DROP VIEW mailbox_message_projection;
			CREATE VIEW mailbox_message_projection AS
			${MAILBOX_MESSAGE_PROJECTION_SELECT};`);
	}).immediate();
	upgradedMailboxConnections.add(db);
}

export function adoptInflightForRecipientOnConnection(
	db: Database.Database,
	input: {
		recipientKind: "lead" | "runner";
		toAgent: string;
		now: string;
	},
): { requeued: number } {
	if (input.recipientKind !== "lead" && input.recipientKind !== "runner") {
		throw new Error("recipientKind must be lead or runner");
	}
	const toAgent = requiredText(input.toAgent, "toAgent");
	assertUtcIsoTimestamp(input.now, "now");
	return db
		.transaction(() => ({
			requeued: db
				.prepare(
					`UPDATE mailbox SET state = 'QUEUED',
					   lease_retry_count = lease_retry_count + 1,
					   claimed_by = NULL, claim_expires_at = NULL, batch_id = NULL,
					   notified_at = NULL, delivered_at = NULL, next_retry_at = NULL,
					   last_error = 'recipient_reborn'
					 WHERE recipient_kind = ? AND to_agent = ? AND carrier = 'inbox'
					   AND state = 'LEASED' AND batch_id IS NOT NULL`,
				)
				.run(input.recipientKind, toAgent).changes,
		}))
		.immediate();
}

export class MailboxQueue {
	private readonly db: Database.Database;
	private readonly ownsConnection: boolean;
	private runnerTerminalScanCursor?: { toAgent: string; seq: number };
	private readonly expiredBatchScanCursors = new Map<string, number>();
	private runnerDeadNoticeScanAfterAgent = "";
	private deadAlertScanCursor?: {
		recipientKind: "lead" | "runner";
		toAgent: string;
	};
	private archiveAckedScanCursor?: { terminalAt: string; seq: number };
	private archiveDeadScanCursor?: { terminalAt: string; seq: number };

	constructor(
		dbPathOrConnection: string | Database.Database,
		options: { readOnly?: boolean } = {},
	) {
		if (typeof dbPathOrConnection !== "string") {
			this.db = dbPathOrConnection;
			this.ownsConnection = false;
			if (!options.readOnly) ensureMailboxQueueSchema(this.db);
			return;
		}
		if (options.readOnly) {
			this.db = new Database(dbPathOrConnection, {
				readonly: true,
				fileMustExist: true,
			});
			this.ownsConnection = true;
			this.db.pragma("busy_timeout = 5000");
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
		ensureMailboxQueueSchema(this.db);
		dropReceiptLedgerSchema(this.db);
		installMailboxRelayInvariantTriggers(this.db);
	}

	enqueue(input: EnqueueMailboxInput): EnqueueMailboxResult {
		const normalizedContent = normalizeInboxContent(input.content).text;
		const messageType = requiredText(input.type, "type");
		const projection = {
			id: requiredText(input.id, "id"),
			delivery_id: requiredText(input.deliveryId ?? input.id, "deliveryId"),
			from_agent: requiredText(input.fromAgent, "fromAgent"),
			to_agent: requiredText(input.toAgent, "toAgent"),
			recipient_kind: input.recipientKind,
			source_kind: input.sourceKind ?? null,
			source_ref: input.sourceRef ?? null,
			type: messageType,
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
			relay_state:
				input.relayState ??
				(messageType === "question" ? "open" : "terminal_disposed"),
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
		const projectionHash = mailboxProjectionHash(projection);
		const legacyOpenProjectionHash =
			input.relayState === undefined && messageType !== "question"
				? mailboxProjectionHash({ ...projection, relay_state: "open" })
				: undefined;

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
						(identity.insert_projection_hash !== projectionHash &&
							identity.insert_projection_hash !== legacyOpenProjectionHash)
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

	/** Atomically awards one Discord message identity to the inbox or legacy lane. */
	claimDiscordLane(
		input: EnqueueMailboxInput & { carrier: "inbox" | "external" },
	): DiscordLaneVerdict {
		return this.db
			.transaction((): DiscordLaneVerdict => {
				const identity = this.db
					.prepare(
						"SELECT id, archived_at FROM mailbox_identity WHERE id = ? OR delivery_id = ?",
					)
					.get(input.id, input.deliveryId ?? input.id) as
					| { id: string; archived_at: string | null }
					| undefined;
				if (identity?.archived_at !== null && identity !== undefined) {
					return { lane: "archived" };
				}
				if (identity) {
					const row = this.getById(identity.id);
					if (!row)
						throw new Error(
							`active mailbox identity has no row: ${identity.id}`,
						);
					return row.carrier === "inbox"
						? {
								lane: "active_inbox",
								deliveryId: row.delivery_id,
								seq: row.seq,
							}
						: { lane: "legacy_external", deliveryId: row.delivery_id };
				}
				const inserted = this.enqueue(input);
				if (inserted.outcome === "archived") return { lane: "archived" };
				return input.carrier === "inbox"
					? {
							lane: "inserted_inbox",
							deliveryId: inserted.row.delivery_id,
							seq: inserted.row.seq,
						}
					: {
							lane: "inserted_external",
							deliveryId: inserted.row.delivery_id,
							seq: inserted.row.seq,
						};
			})
			.immediate();
	}

	getById(idOrDeliveryId: string): MailboxRow | undefined {
		return this.db
			.prepare("SELECT * FROM mailbox WHERE id = ? OR delivery_id = ?")
			.get(idOrDeliveryId, idOrDeliveryId) as MailboxRow | undefined;
	}

	/**
	 * Read-only settlement view that survives live-row retention. Identity is
	 * permanent, so a truly absent producer projection stays distinguishable
	 * from an ACKED/DEAD row archived after 72h.
	 */
	inspectDeliveryState(idOrDeliveryId: string): MailboxSettlement {
		const live = this.getById(idOrDeliveryId);
		if (live) {
			return {
				kind: "live",
				state: live.state,
				settledAt:
					live.state === "ACKED"
						? live.acked_at
						: live.state === "DEAD"
							? live.dead_at
							: null,
				...deliveryEvidence(live),
			};
		}
		const identity = this.db
			.prepare(
				"SELECT id, archived_at FROM mailbox_identity WHERE id = ? OR delivery_id = ?",
			)
			.get(idOrDeliveryId, idOrDeliveryId) as
			| { id: string; archived_at: string | null }
			| undefined;
		if (!identity) return { kind: "absent_identity" };
		if (!identity.archived_at) {
			throw new Error(`active mailbox identity has no row: ${identity.id}`);
		}
		const archived = this.db
			.prepare(
				"SELECT row_json FROM mailbox_log WHERE message_id = ? AND event = 'archived' ORDER BY at DESC LIMIT 1",
			)
			.get(identity.id) as { row_json: string } | undefined;
		if (!archived) {
			throw new Error(
				`archived mailbox identity has no snapshot: ${identity.id}`,
			);
		}
		let snapshot: Partial<MailboxRow>;
		try {
			snapshot = JSON.parse(archived.row_json) as Partial<MailboxRow>;
		} catch {
			throw new Error(`archived mailbox snapshot is malformed: ${identity.id}`);
		}
		if (snapshot.state === "ACKED" && snapshot.acked_at) {
			return {
				kind: "archived_terminal",
				state: "ACKED",
				settledAt: snapshot.acked_at,
				...deliveryEvidence(snapshot),
			};
		}
		if (snapshot.state === "DEAD" && snapshot.dead_at) {
			return {
				kind: "archived_terminal",
				state: "DEAD",
				settledAt: snapshot.dead_at,
				...deliveryEvidence(snapshot),
			};
		}
		throw new Error(
			`archived mailbox snapshot is not terminal: ${identity.id}`,
		);
	}

	getIdentityCarrier(
		idOrDeliveryId: string,
	): "inbox" | "external" | "unknown_archived" | undefined {
		const live = this.getById(idOrDeliveryId);
		if (live) return live.carrier;
		const identity = this.db
			.prepare(
				"SELECT id, archived_at FROM mailbox_identity WHERE id = ? OR delivery_id = ?",
			)
			.get(idOrDeliveryId, idOrDeliveryId) as
			| { id: string; archived_at: string | null }
			| undefined;
		if (!identity) return undefined;
		if (!identity.archived_at) return undefined;
		const archived = this.db
			.prepare(
				"SELECT row_json FROM mailbox_log WHERE message_id = ? AND event = 'archived' ORDER BY at DESC LIMIT 1",
			)
			.get(identity.id) as { row_json: string } | undefined;
		if (!archived) return "unknown_archived";
		try {
			const carrier = (JSON.parse(archived.row_json) as { carrier?: unknown })
				.carrier;
			return carrier === "inbox" || carrier === "external"
				? carrier
				: "unknown_archived";
		} catch {
			return "unknown_archived";
		}
	}

	countDeliverable(toAgent?: string): number {
		const duePredicate = `carrier = 'inbox' AND state = 'QUEUED'
			AND (next_retry_at IS NULL OR next_retry_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
		const row =
			toAgent === undefined
				? (this.db
						.prepare(
							`SELECT COUNT(*) AS count FROM mailbox WHERE ${duePredicate}`,
						)
						.get() as { count: number })
				: (this.db
						.prepare(
							`SELECT COUNT(*) AS count FROM mailbox WHERE ${duePredicate} AND to_agent = ?`,
						)
						.get(toAgent) as { count: number });
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

	/** External-lane rows still awaiting delivery. ACKED is the sole terminal. */
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
		maxBatchBytes?: number;
		partitionKey?: (row: MailboxRow) => string;
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
				let rows = this.db
					.prepare(
						`SELECT * FROM mailbox
					  WHERE to_agent = ? AND recipient_kind = 'lead' AND carrier = 'inbox'
					    AND msg_class = ? AND state = 'QUEUED' AND batch_id IS NULL
					    AND (next_retry_at IS NULL OR next_retry_at <= ?)
					  ORDER BY priority, seq LIMIT ?`,
					)
					.all(input.toAgent, input.msgClass, input.now, limit) as MailboxRow[];
				if (rows.length > 0 && input.partitionKey) {
					const firstKey = input.partitionKey(rows[0]!);
					const boundary = rows.findIndex(
						(row) => input.partitionKey?.(row) !== firstKey,
					);
					if (boundary >= 0) rows = rows.slice(0, boundary);
				}
				if (input.maxBatchBytes !== undefined) {
					if (
						!Number.isSafeInteger(input.maxBatchBytes) ||
						input.maxBatchBytes <= 0
					) {
						throw new Error("maxBatchBytes must be a positive safe integer");
					}
					let bytes = 0;
					const bounded: MailboxRow[] = [];
					for (const row of rows) {
						const next =
							Buffer.byteLength(row.delivery_content ?? row.content) + 128;
						if (bounded.length > 0 && bytes + next > input.maxBatchBytes) break;
						bounded.push(row);
						bytes += next;
					}
					rows = bounded;
				}
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

	private claimQueueBatch(input: {
		recipientKind: "lead" | "runner";
		toAgent?: string;
		msgClass?: MailboxMessageClass;
		ownerEpoch: string;
		batchId: string;
		now: string;
		transportClaimTtlMs: number;
		batchWindowMs: number;
		batchMaxSize: number;
		inflightMaxBatches: number;
		maxBatchBytes?: number;
		partitionKey?: (row: MailboxRow) => string;
	}): MailboxRow[] {
		if (!Number.isSafeInteger(input.batchWindowMs) || input.batchWindowMs < 0) {
			throw new Error("batchWindowMs must be a non-negative safe integer");
		}
		for (const [name, value] of [
			["batchMaxSize", input.batchMaxSize],
			["inflightMaxBatches", input.inflightMaxBatches],
		] as const) {
			if (!Number.isSafeInteger(value) || value <= 0) {
				throw new Error(`${name} must be a positive safe integer`);
			}
		}
		if (
			input.maxBatchBytes !== undefined &&
			(!Number.isSafeInteger(input.maxBatchBytes) || input.maxBatchBytes <= 0)
		) {
			throw new Error("maxBatchBytes must be a positive safe integer");
		}
		const claimExpiresAt = addMilliseconds(
			input.now,
			input.transportClaimTtlMs,
		);
		return this.db
			.transaction(() => {
				if (!this.isCurrentOwner(input.ownerEpoch, input.now)) return [];

				const frozen = this.db
					.prepare(
						`SELECT batch_id FROM mailbox
						  WHERE recipient_kind = ? AND carrier = 'inbox'
						    AND (? IS NULL OR to_agent = ?)
						    AND (? IS NULL OR msg_class = ?)
						    AND state = 'LEASED' AND batch_id IS NOT NULL
						    AND COALESCE(notified_at, delivered_at) IS NULL
						    AND (next_retry_at IS NULL OR next_retry_at <= ?)
						    AND (claimed_by IS NULL OR claimed_by = ? OR claim_expires_at <= ?)
						  ORDER BY priority, seq LIMIT 1`,
					)
					.get(
						input.recipientKind,
						input.toAgent ?? null,
						input.toAgent ?? null,
						input.msgClass ?? null,
						input.msgClass ?? null,
						input.now,
						input.ownerEpoch,
						input.now,
					) as { batch_id: string } | undefined;
				if (frozen) {
					const remaining = this.db
						.prepare(
							`SELECT id FROM mailbox
							  WHERE batch_id = ? AND state = 'LEASED'
							    AND COALESCE(notified_at, delivered_at) IS NULL
							    AND (next_retry_at IS NULL OR next_retry_at <= ?)
							    AND (claimed_by IS NULL OR claimed_by = ? OR claim_expires_at <= ?)
							  ORDER BY priority, seq`,
						)
						.all(
							frozen.batch_id,
							input.now,
							input.ownerEpoch,
							input.now,
						) as Array<{ id: string }>;
					if (remaining.length === 0) return [];
					const result = this.db
						.prepare(
							`UPDATE mailbox SET claimed_by = ?, claim_expires_at = ?
							  WHERE id IN (${placeholders(remaining.length)}) AND state = 'LEASED'
							    AND COALESCE(notified_at, delivered_at) IS NULL
							    AND (claimed_by IS NULL OR claimed_by = ? OR claim_expires_at <= ?)`,
						)
						.run(
							input.ownerEpoch,
							claimExpiresAt,
							...remaining.map(({ id }) => id),
							input.ownerEpoch,
							input.now,
						);
					if (result.changes !== remaining.length) return [];
					return this.db
						.prepare(
							"SELECT * FROM mailbox WHERE batch_id = ? AND state IN ('LEASED','ACKED') ORDER BY priority, seq",
						)
						.all(frozen.batch_id) as MailboxRow[];
				}

				if (input.recipientKind === "lead") {
					const inflight = this.db
						.prepare(
							`SELECT COUNT(DISTINCT batch_id) AS count FROM mailbox
							  WHERE to_agent = ? AND recipient_kind = 'lead' AND carrier = 'inbox'
							    AND state = 'LEASED' AND batch_id IS NOT NULL
							    AND COALESCE(notified_at, delivered_at) IS NULL`,
						)
						.get(input.toAgent) as { count: number };
					if (inflight.count >= input.inflightMaxBatches) return [];
				}

				const head = this.db
					.prepare(
						`SELECT * FROM mailbox AS candidate
						  WHERE candidate.recipient_kind = ? AND candidate.carrier = 'inbox'
						    AND (? IS NULL OR candidate.to_agent = ?)
						    AND (? IS NULL OR candidate.msg_class = ?)
						    AND candidate.state = 'QUEUED' AND candidate.batch_id IS NULL
						    AND (candidate.next_retry_at IS NULL OR candidate.next_retry_at <= ?)
						    AND (? = 'lead' OR (
						      SELECT COUNT(DISTINCT active.batch_id) FROM mailbox AS active
						       WHERE active.to_agent = candidate.to_agent
						         AND active.recipient_kind = 'runner' AND active.carrier = 'inbox'
						         AND active.state = 'LEASED' AND active.delivered_at IS NOT NULL
						         AND active.claim_expires_at > ? AND active.batch_id IS NOT NULL
						    ) < ?)
						  ORDER BY candidate.priority, candidate.seq LIMIT 1`,
					)
					.get(
						input.recipientKind,
						input.toAgent ?? null,
						input.toAgent ?? null,
						input.msgClass ?? null,
						input.msgClass ?? null,
						input.now,
						input.recipientKind,
						input.now,
						input.inflightMaxBatches,
					) as MailboxRow | undefined;
				if (!head) return [];
				const ackClass = head.type === "response" ? "response" : "instruction";
				const windowEnd = new Date(
					Date.parse(head.created_at) + input.batchWindowMs,
				).toISOString();
				const effectiveLimit =
					input.recipientKind === "runner" && ackClass === "response"
						? 1
						: input.batchMaxSize;
				let rows = this.db
					.prepare(
						`SELECT * FROM mailbox
						  WHERE recipient_kind = ? AND carrier = 'inbox'
						    AND to_agent = ? AND from_agent = ? AND msg_class = ?
						    AND state = 'QUEUED' AND batch_id IS NULL
						    AND lease_retry_count = ? AND retry_count = ?
						    AND created_at >= ? AND created_at <= ?
						    AND (next_retry_at IS NULL OR next_retry_at <= ?)
						    AND (? = 'lead'
						      OR (? = 'response' AND type = 'response')
						      OR (? = 'instruction' AND type <> 'response'))
						  ORDER BY priority, seq LIMIT ?`,
					)
					.all(
						input.recipientKind,
						head.to_agent,
						head.from_agent,
						head.msg_class,
						head.lease_retry_count,
						head.retry_count,
						head.created_at,
						windowEnd,
						input.now,
						input.recipientKind,
						ackClass,
						ackClass,
						effectiveLimit,
					) as MailboxRow[];
				if (rows.length > 0 && input.partitionKey) {
					const firstKey = input.partitionKey(rows[0]!);
					const boundary = rows.findIndex(
						(row) => input.partitionKey?.(row) !== firstKey,
					);
					if (boundary >= 0) rows = rows.slice(0, boundary);
				}
				if (input.maxBatchBytes !== undefined) {
					let bytes = 0;
					const bounded: MailboxRow[] = [];
					for (const row of rows) {
						const next =
							Buffer.byteLength(row.delivery_content ?? row.content) + 128;
						if (bounded.length > 0 && bytes + next > input.maxBatchBytes) break;
						bounded.push(row);
						bytes += next;
					}
					rows = bounded;
				}
				if (rows.length === 0) return [];
				const ids = rows.map(({ id }) => id);
				const updated = this.db
					.prepare(
						`UPDATE mailbox SET state = 'LEASED', batch_id = ?, claimed_by = ?,
					   claim_expires_at = ?, notified_at = NULL, delivered_at = NULL
						 WHERE id IN (${placeholders(ids.length)})
						   AND state = 'QUEUED' AND batch_id IS NULL`,
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

	claimLeadBatchQueue(input: {
		toAgent: string;
		msgClass: MailboxMessageClass;
		ownerEpoch: string;
		batchId: string;
		now: string;
		transportClaimTtlMs: number;
		batchWindowMs: number;
		batchMaxSize: number;
		inflightMaxBatches: number;
		maxBatchBytes?: number;
		partitionKey?: (row: MailboxRow) => string;
	}): MailboxRow[] {
		return this.claimQueueBatch({ ...input, recipientKind: "lead" });
	}

	releaseExpiredLegacyPushClaims(input: {
		toAgent: string;
		ownerEpoch: string;
		now: string;
		maxRows: number;
	}): { requeued: number; remaining: boolean } {
		assertUtcIsoTimestamp(input.now, "now");
		if (!Number.isSafeInteger(input.maxRows) || input.maxRows <= 0) {
			throw new Error("maxRows must be a positive safe integer");
		}
		return this.db
			.transaction(() => {
				if (!this.isCurrentOwner(input.ownerEpoch, input.now)) {
					return { requeued: 0, remaining: false };
				}
				// The live Lead loop is the recipient authority. Older CommDB writers
				// inferred recipient_kind from a "-lead" suffix, so a valid suffix-free
				// Lead could otherwise strand a steady QUEUED legacy-push row forever.
				this.db
					.prepare(
						`UPDATE mailbox SET recipient_kind = 'lead'
						 WHERE to_agent = ? AND type = 'instruction' AND carrier = 'inbox'
						   AND recipient_kind <> 'lead' AND batch_id IS NULL
						   AND (state = 'QUEUED' OR (state = 'LEASED' AND claimed_by = 'legacy-push'))`,
					)
					.run(input.toAgent);
				const rows = this.db
					.prepare(
						`SELECT id FROM mailbox
						 WHERE recipient_kind = 'lead' AND to_agent = ? AND carrier = 'inbox'
						   AND state = 'LEASED' AND claimed_by = 'legacy-push'
						   AND batch_id IS NULL AND claim_expires_at <= ?
						 ORDER BY +seq LIMIT ?`,
					)
					.all(input.toAgent, input.now, input.maxRows) as Array<{
					id: string;
				}>;
				const ids = rows.map(({ id }) => id);
				const requeued =
					ids.length === 0
						? 0
						: this.db
								.prepare(
									`UPDATE mailbox SET state = 'QUEUED', claimed_by = NULL,
									   claim_expires_at = NULL, last_error = 'legacy_push_handoff'
									 WHERE id IN (${placeholders(ids.length)})
									   AND state = 'LEASED' AND claimed_by = 'legacy-push'
									   AND batch_id IS NULL AND claim_expires_at <= ?`,
								)
								.run(...ids, input.now).changes;
				const remaining =
					this.db
						.prepare(
							`SELECT 1 FROM mailbox
							 WHERE recipient_kind = 'lead' AND to_agent = ? AND carrier = 'inbox'
							   AND state = 'LEASED' AND claimed_by = 'legacy-push'
							   AND batch_id IS NULL AND claim_expires_at <= ? LIMIT 1`,
						)
						.get(input.toAgent, input.now) !== undefined;
				return { requeued, remaining };
			})
			.immediate();
	}

	listRetiredLeadRecipients(input: {
		liveToAgents: readonly string[];
		afterToAgent: string;
		limit: number;
	}): string[] {
		if (input.liveToAgents.length === 0) return [];
		if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
			throw new Error("limit must be a positive safe integer");
		}
		return (
			this.db
				.prepare(
					`SELECT to_agent FROM mailbox
					 WHERE recipient_kind = 'lead' AND carrier = 'inbox'
					   AND state IN ('QUEUED','LEASED') AND to_agent > ?
					   AND to_agent NOT IN (${placeholders(input.liveToAgents.length)})
					 GROUP BY to_agent ORDER BY to_agent LIMIT ?`,
				)
				.all(input.afterToAgent, ...input.liveToAgents, input.limit) as Array<{
				to_agent: string;
			}>
		).map(({ to_agent }) => to_agent);
	}

	sweepRecipientTerminal(input: {
		recipientKind: "lead";
		toAgent: string;
		ownerEpoch: string;
		now: string;
		maxRows: number;
	}): { dead: number; remaining: boolean } {
		assertUtcIsoTimestamp(input.now, "now");
		if (!Number.isSafeInteger(input.maxRows) || input.maxRows <= 0) {
			throw new Error("maxRows must be a positive safe integer");
		}
		return this.db
			.transaction(() => {
				if (!this.isCurrentOwner(input.ownerEpoch, input.now)) {
					return { dead: 0, remaining: false };
				}
				const ids = (
					this.db
						.prepare(
							`SELECT id FROM mailbox
							 WHERE recipient_kind = ? AND to_agent = ? AND carrier = 'inbox'
							   AND state IN ('QUEUED','LEASED')
							 ORDER BY seq LIMIT ?`,
						)
						.all(input.recipientKind, input.toAgent, input.maxRows) as Array<{
						id: string;
					}>
				).map(({ id }) => id);
				const dead =
					ids.length === 0
						? 0
						: this.db
								.prepare(
									`UPDATE mailbox SET state = 'DEAD', dead_at = ?,
									   dead_reason = 'recipient_terminal', last_error = 'recipient_terminal',
									   claimed_by = NULL, claim_expires_at = NULL,
									   next_retry_at = NULL, batch_id = NULL
									 WHERE id IN (${placeholders(ids.length)})
									   AND recipient_kind = ? AND to_agent = ?
									   AND state IN ('QUEUED','LEASED')`,
								)
								.run(input.now, ...ids, input.recipientKind, input.toAgent)
								.changes;
				const remaining =
					this.db
						.prepare(
							`SELECT 1 FROM mailbox WHERE recipient_kind = ? AND to_agent = ?
							   AND carrier = 'inbox' AND state IN ('QUEUED','LEASED') LIMIT 1`,
						)
						.get(input.recipientKind, input.toAgent) !== undefined;
				return { dead, remaining };
			})
			.immediate();
	}

	claimRunnerBatch(input: {
		ownerEpoch: string;
		now: string;
		transportClaimTtlMs: number;
		batchWindowMs: number;
		batchMaxSize: number;
		inflightMaxBatches: number;
	}): MailboxRow[] | undefined {
		const rows = this.claimQueueBatch({
			...input,
			recipientKind: "runner",
			batchId: `mailbox-batch:${randomUUID()}`,
		});
		return rows.length > 0 ? rows : undefined;
	}

	private recordBatchDelivered(input: {
		batchId: string;
		ownerEpoch: string;
		now: string;
		ackLeaseTtlMs: number;
		recipientKind: "lead" | "runner";
	}): MailboxBatchDeliveryResult {
		const expiresAt = addMilliseconds(input.now, input.ackLeaseTtlMs);
		return this.db
			.transaction(() => {
				if (!this.isCurrentOwner(input.ownerEpoch, input.now))
					return "lost_race";
				const rows = this.db
					.prepare(
						"SELECT state, claimed_by FROM mailbox WHERE batch_id = ? AND recipient_kind = ? ORDER BY priority, seq",
					)
					.all(input.batchId, input.recipientKind) as Array<{
					state: MailboxState;
					claimed_by: string | null;
				}>;
				if (rows.length === 0) return "lost_race";
				const leased = rows.filter(({ state }) => state === "LEASED");
				if (leased.length === 0) {
					return rows.every(({ state }) => state === "ACKED")
						? "already_settled"
						: "lost_race";
				}
				if (leased.some(({ claimed_by }) => claimed_by !== input.ownerEpoch)) {
					return "lost_race";
				}
				const updated = this.db
					.prepare(
						`UPDATE mailbox SET notified_at = COALESCE(notified_at, ?),
						   delivered_at = CASE WHEN ? = 'runner'
						     THEN COALESCE(delivered_at, ?) ELSE delivered_at END,
						   claim_expires_at = ?, last_error = NULL, next_retry_at = NULL
						 WHERE batch_id = ? AND recipient_kind = ? AND state = 'LEASED'
						   AND claimed_by = ?`,
					)
					.run(
						input.now,
						input.recipientKind,
						input.now,
						expiresAt,
						input.batchId,
						input.recipientKind,
						input.ownerEpoch,
					);
				return updated.changes === leased.length ? "applied" : "lost_race";
			})
			.immediate();
	}

	recordLeadBatchDelivered(input: {
		batchId: string;
		ownerEpoch: string;
		now: string;
		ackLeaseTtlMs: number;
	}): MailboxBatchDeliveryResult {
		return this.recordBatchDelivered({ ...input, recipientKind: "lead" });
	}

	recordRunnerBatchDelivered(input: {
		batchId: string;
		ownerEpoch: string;
		now: string;
		ackLeaseTtlMs: number;
		settlement: RunnerMailboxSettlement;
	}): MailboxBatchDeliveryResult {
		if (input.settlement === "on_delivery") {
			return this.db
				.transaction(() => {
					if (!this.isCurrentOwner(input.ownerEpoch, input.now)) {
						return "lost_race";
					}
					const rows = this.db
						.prepare(
							"SELECT state, claimed_by FROM mailbox WHERE batch_id = ? AND recipient_kind = 'runner' ORDER BY priority, seq",
						)
						.all(input.batchId) as Array<{
						state: MailboxState;
						claimed_by: string | null;
					}>;
					if (rows.length === 0) return "lost_race";
					const leased = rows.filter(({ state }) => state === "LEASED");
					if (leased.length === 0) {
						return rows.every(({ state }) => state === "ACKED")
							? "already_settled"
							: "lost_race";
					}
					if (
						leased.some(({ claimed_by }) => claimed_by !== input.ownerEpoch)
					) {
						return "lost_race";
					}
					const updated = this.db
						.prepare(
							`UPDATE mailbox SET state = 'ACKED',
							   acked_at = COALESCE(acked_at, ?),
							   notified_at = COALESCE(notified_at, ?),
							   delivered_at = COALESCE(delivered_at, ?),
							   last_error = NULL, claimed_by = NULL,
							   claim_expires_at = NULL, next_retry_at = NULL
							 WHERE batch_id = ? AND recipient_kind = 'runner'
							   AND state = 'LEASED' AND claimed_by = ?`,
						)
						.run(
							input.now,
							input.now,
							input.now,
							input.batchId,
							input.ownerEpoch,
						);
					return updated.changes === leased.length ? "applied" : "lost_race";
				})
				.immediate();
		}
		return this.recordBatchDelivered({ ...input, recipientKind: "runner" });
	}

	ackBatchByRecipient(input: {
		batchId: string;
		fromAgent: string;
		now: string;
	}): MailboxBatchAckResult {
		return this.db
			.transaction(() => {
				const rows = this.db
					.prepare("SELECT to_agent, state FROM mailbox WHERE batch_id = ?")
					.all(input.batchId) as Array<{
					to_agent: string;
					state: MailboxState;
				}>;
				if (rows.length === 0) return "ack_late_noop";
				if (rows.some(({ to_agent }) => to_agent !== input.fromAgent)) {
					throw new Error("mailbox batch recipient mismatch");
				}
				const leased = rows.filter(({ state }) => state === "LEASED").length;
				if (leased === 0) {
					if (rows.every(({ state }) => state === "ACKED")) {
						this.retireAckedRunnerStopReports(input.batchId, input.now);
						return "duplicate";
					}
					return "ack_late_noop";
				}
				const updated = this.db
					.prepare(
						`UPDATE mailbox SET state = 'ACKED', acked_at = COALESCE(acked_at, ?),
						   delivered_at = COALESCE(delivered_at, ?),
						   claimed_by = NULL, claim_expires_at = NULL, next_retry_at = NULL
						 WHERE batch_id = ? AND state = 'LEASED'`,
					)
					.run(input.now, input.now, input.batchId);
				if (updated.changes !== leased) return "ack_late_noop";
				this.retireAckedRunnerStopReports(input.batchId, input.now);
				return "applied";
			})
			.immediate();
	}

	private retireAckedRunnerStopReports(batchId: string, now: string): void {
		const rows = this.db
			.prepare(
				`SELECT id, kind, content FROM mailbox
				 WHERE batch_id = ? AND state = 'ACKED' AND type = 'question'`,
			)
			.all(batchId) as Array<{
			id: string;
			kind: string | null;
			content: string;
		}>;
		const reportIds = rows.filter(isRunnerStopReport).map(({ id }) => id);
		if (reportIds.length === 0) return;
		this.db
			.prepare(
				`UPDATE mailbox SET
				   relay_state = 'terminal_disposed',
				   resolved_at = COALESCE(resolved_at, ?),
				   resolved_via = COALESCE(resolved_via, 'report_ack')
				 WHERE id IN (${placeholders(reportIds.length)}) AND state = 'ACKED'`,
			)
			.run(now, ...reportIds);
	}

	adoptInflightForRecipient(input: {
		recipientKind: "lead" | "runner";
		toAgent: string;
		now: string;
	}): { requeued: number } {
		return adoptInflightForRecipientOnConnection(this.db, input);
	}

	reconcileExpiredLeases(input: {
		ownerEpoch: string;
		now: string;
		recipientKind: "lead" | "runner";
		toAgent?: string;
		leaseRetryMax: number;
		recipientState: (toAgent: string) => MailboxRecipientState;
		/**
		 * A terminal session is not authoritative when a live protocol obligation
		 * still requires that runner to consume this exact row. The callback is for
		 * cross-store obligations (for example the current design-review manifest);
		 * gate-response obligations are derived locally from the parent question.
		 */
		isTerminalDeliveryObligation?: (row: MailboxRow) => boolean;
		maxBatches: number;
		maxTerminalRows: number;
	}): ReconcileExpiredLeasesResult {
		if (!Number.isSafeInteger(input.leaseRetryMax) || input.leaseRetryMax < 0) {
			throw new Error("leaseRetryMax must be a non-negative safe integer");
		}
		return this.db
			.transaction(() => {
				const isTerminalDeliveryObligation = (row: MailboxRow): boolean => {
					if (
						row.recipient_kind === "runner" &&
						row.type === "response" &&
						row.ref_id
					) {
						const gate = this.db
							.prepare(
								`SELECT 1 FROM mailbox
								  WHERE id = ? AND type = 'question' AND checkpoint IS NOT NULL
								    AND superseded_at IS NULL LIMIT 1`,
							)
							.get(row.ref_id);
						if (gate !== undefined) return true;
					}
					try {
						return input.isTerminalDeliveryObligation?.(row) === true;
					} catch (error) {
						// Destructive terminal settlement must fail closed when the
						// cross-store obligation probe itself is unavailable.
						console.warn(
							`[mailbox] terminal delivery-obligation probe failed for ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
						);
						return true;
					}
				};
				const result: ReconcileExpiredLeasesResult = {
					requeued: 0,
					dead: 0,
					frozenResend: [],
					skippedUnknown: 0,
					remaining: false,
				};
				if (!this.isCurrentOwner(input.ownerEpoch, input.now)) {
					result.remaining = true;
					return result;
				}

				let terminalScanAtLimit = false;
				if (input.recipientKind === "runner" && input.maxTerminalRows > 0) {
					let queued: MailboxRow[];
					if (input.toAgent) {
						queued = this.db
							.prepare(
								`SELECT * FROM mailbox
								  WHERE recipient_kind = 'runner' AND carrier = 'inbox'
								    AND state = 'QUEUED' AND to_agent = ?
								  ORDER BY seq LIMIT ?`,
							)
							.all(input.toAgent, input.maxTerminalRows) as MailboxRow[];
					} else {
						const cursor = this.runnerTerminalScanCursor;
						queued = cursor
							? (this.db
									.prepare(
										`SELECT * FROM mailbox
										  WHERE recipient_kind = 'runner' AND carrier = 'inbox'
										    AND state = 'QUEUED'
										    AND (to_agent > ? OR (to_agent = ? AND seq > ?))
										  ORDER BY to_agent, seq LIMIT ?`,
									)
									.all(
										cursor.toAgent,
										cursor.toAgent,
										cursor.seq,
										input.maxTerminalRows,
									) as MailboxRow[])
							: [];
						if (queued.length < input.maxTerminalRows) {
							const remaining = input.maxTerminalRows - queued.length;
							const wrapped = cursor
								? (this.db
										.prepare(
											`SELECT * FROM mailbox
											  WHERE recipient_kind = 'runner' AND carrier = 'inbox'
											    AND state = 'QUEUED'
											    AND (to_agent < ? OR (to_agent = ? AND seq <= ?))
											  ORDER BY to_agent, seq LIMIT ?`,
										)
										.all(
											cursor.toAgent,
											cursor.toAgent,
											cursor.seq,
											remaining,
										) as MailboxRow[])
								: (this.db
										.prepare(
											`SELECT * FROM mailbox
											  WHERE recipient_kind = 'runner' AND carrier = 'inbox'
											    AND state = 'QUEUED'
											  ORDER BY to_agent, seq LIMIT ?`,
										)
										.all(remaining) as MailboxRow[]);
							queued.push(...wrapped);
						}
						const last = queued.at(-1);
						if (last) {
							this.runnerTerminalScanCursor = {
								toAgent: last.to_agent,
								seq: last.seq,
							};
						}
					}
					terminalScanAtLimit = queued.length === input.maxTerminalRows;
					for (const row of queued) {
						const state = input.recipientState(row.to_agent);
						if (state === "unknown") {
							result.skippedUnknown += 1;
							continue;
						}
						if (state !== "terminal_or_missing") continue;
						if (isTerminalDeliveryObligation(row)) continue;
						const changed = this.db
							.prepare(
								`UPDATE mailbox SET state = 'DEAD', dead_at = ?,
								   dead_reason = 'recipient_terminal', last_error = 'recipient_terminal',
								   claimed_by = NULL, claim_expires_at = NULL, next_retry_at = NULL,
								   batch_id = NULL, notified_at = NULL, delivered_at = NULL
								 WHERE id = ? AND state = 'QUEUED'`,
							)
							.run(input.now, row.id).changes;
						result.dead += changed;
					}
				}

				const expiredCursorKey = `${input.recipientKind}\u001f${input.toAgent ?? ""}`;
				const expiredCursor =
					this.expiredBatchScanCursors.get(expiredCursorKey) ?? 0;
				const selectExpired = (
					comparison: ">" | "<=",
					cursor: number,
					limit: number,
				) =>
					this.db
						.prepare(
							`SELECT batch_id, MIN(seq) AS first_seq, to_agent
							  FROM mailbox
							 WHERE recipient_kind = ? AND carrier = 'inbox' AND state = 'LEASED'
							   AND batch_id IS NOT NULL AND claim_expires_at <= ?
							   AND (? IS NULL OR to_agent = ?)
							 GROUP BY batch_id, to_agent HAVING MIN(seq) ${comparison} ?
							 ORDER BY first_seq LIMIT ?`,
						)
						.all(
							input.recipientKind,
							input.now,
							input.toAgent ?? null,
							input.toAgent ?? null,
							cursor,
							limit,
						) as Array<{
						batch_id: string;
						first_seq: number;
						to_agent: string;
					}>;
				const expired = selectExpired(">", expiredCursor, input.maxBatches);
				const remainingExpired = input.maxBatches - expired.length;
				if (remainingExpired > 0 && expiredCursor > 0) {
					expired.push(...selectExpired("<=", expiredCursor, remainingExpired));
				}
				const lastExpired = expired.at(-1);
				if (lastExpired) {
					this.expiredBatchScanCursors.set(
						expiredCursorKey,
						lastExpired.first_seq,
					);
				}
				for (const batch of expired) {
					const recipientState = input.recipientState(batch.to_agent);
					if (recipientState === "unknown") {
						result.skippedUnknown += 1;
						continue;
					}
					const members = this.db
						.prepare(
							`SELECT * FROM mailbox
							  WHERE batch_id = ? AND state = 'LEASED' AND claim_expires_at <= ?
							  ORDER BY priority, seq`,
						)
						.all(batch.batch_id, input.now) as MailboxRow[];
					if (members.length === 0) continue;
					if (
						recipientState === "terminal_or_missing" &&
						!members.some(isTerminalDeliveryObligation)
					) {
						const changed = this.db
							.prepare(
								`UPDATE mailbox SET state = 'DEAD', dead_at = ?,
								   dead_reason = 'recipient_terminal', last_error = 'recipient_terminal',
								   claimed_by = NULL, claim_expires_at = NULL, next_retry_at = NULL,
								   batch_id = NULL
								 WHERE batch_id = ? AND state = 'LEASED' AND claim_expires_at <= ?`,
							)
							.run(input.now, batch.batch_id, input.now).changes;
						result.dead += changed;
						continue;
					}
					if (
						members.every(
							({ notified_at, delivered_at }) =>
								notified_at === null && delivered_at === null,
						)
					) {
						const counts = members.map(({ last_error }) =>
							frozenDeliveryMarkerCount(last_error),
						);
						const firstCount = counts[0] ?? null;
						const completedExpiries =
							firstCount !== null &&
							counts.every((count) => count === firstCount)
								? firstCount
								: 0;
						if (completedExpiries >= input.leaseRetryMax) {
							const changed = this.db
								.prepare(
									`UPDATE mailbox SET state = 'DEAD', dead_at = ?,
									   dead_reason = '${FROZEN_DELIVERY_UNCONFIRMED_EXHAUSTED_REASON}',
									   last_error = '${FROZEN_DELIVERY_UNCONFIRMED_EXHAUSTED_REASON}',
									   claimed_by = NULL, claim_expires_at = NULL,
									   next_retry_at = NULL, batch_id = NULL
									 WHERE batch_id = ? AND state = 'LEASED' AND claim_expires_at <= ?`,
								)
								.run(input.now, batch.batch_id, input.now).changes;
							result.dead += changed;
							continue;
						}
						this.db
							.prepare(
								`UPDATE mailbox SET claimed_by = NULL, claim_expires_at = NULL,
								   last_error = ?
								 WHERE batch_id = ? AND state = 'LEASED' AND claim_expires_at <= ?`,
							)
							.run(
								`delivery_unconfirmed:${completedExpiries + 1}`,
								batch.batch_id,
								input.now,
							);
						result.frozenResend.push(batch.batch_id);
						continue;
					}
					if (
						members.some(
							({ lease_retry_count }) =>
								lease_retry_count >= input.leaseRetryMax,
						)
					) {
						const changed = this.db
							.prepare(
								`UPDATE mailbox SET state = 'DEAD', dead_at = ?,
								   dead_reason = 'lease_expired_unacked',
								   last_error = 'lease_expired_unacked', claimed_by = NULL,
								   claim_expires_at = NULL, next_retry_at = NULL, batch_id = NULL
								 WHERE batch_id = ? AND state = 'LEASED' AND claim_expires_at <= ?`,
							)
							.run(input.now, batch.batch_id, input.now).changes;
						result.dead += changed;
						continue;
					}
					const changed = this.db
						.prepare(
							`UPDATE mailbox SET state = 'QUEUED',
							   lease_retry_count = lease_retry_count + 1,
							   claimed_by = NULL, claim_expires_at = NULL, batch_id = NULL,
							   notified_at = NULL, delivered_at = NULL, next_retry_at = NULL,
							   last_error = 'lease_expired_unacked'
							 WHERE batch_id = ? AND state = 'LEASED' AND claim_expires_at <= ?`,
						)
						.run(batch.batch_id, input.now).changes;
					result.requeued += changed;
				}

				const moreExpired = this.db
					.prepare(
						`SELECT 1 FROM mailbox WHERE recipient_kind = ? AND carrier = 'inbox'
						   AND state = 'LEASED' AND claim_expires_at <= ?
						   AND (? IS NULL OR to_agent = ?) LIMIT 1`,
					)
					.get(
						input.recipientKind,
						input.now,
						input.toAgent ?? null,
						input.toAgent ?? null,
					);
				result.remaining = terminalScanAtLimit || moreExpired !== undefined;
				return result;
			})
			.immediate();
	}

	scanAndInsertDeadLetterNotices(input: {
		ownerEpoch: string;
		now: string;
		windowMs: number;
		maxRecipients: number;
		maxDeadRowsPerRecipient: number;
		maxSummaryBytes: number;
		resolveOwningLead: (recipient: string) => string | undefined;
		probeFactsByRecipient?: ReadonlyMap<string, string>;
	}): DeadLetterNoticeScanResult {
		for (const [name, value, allowZero] of [
			["windowMs", input.windowMs, true],
			["maxRecipients", input.maxRecipients, false],
			["maxDeadRowsPerRecipient", input.maxDeadRowsPerRecipient, false],
			["maxSummaryBytes", input.maxSummaryBytes, false],
		] as const) {
			if (
				!Number.isSafeInteger(value) ||
				(allowZero ? value < 0 : value <= 0)
			) {
				throw new Error(`${name} is invalid`);
			}
		}
		return this.db
			.transaction(() => {
				const result: DeadLetterNoticeScanResult = {
					inserted: [],
					rateLimited: [],
					unroutable: [],
					uncoveredRemaining: false,
				};
				if (!this.isCurrentOwner(input.ownerEpoch, input.now)) {
					result.uncoveredRemaining = true;
					return result;
				}
				const scanLimit = input.maxRecipients + 1;
				const recipients = this.db
					.prepare(
						`SELECT to_agent FROM mailbox
						  WHERE recipient_kind = 'runner' AND carrier = 'inbox' AND state = 'DEAD'
						    AND to_agent > ?
						  GROUP BY to_agent ORDER BY to_agent LIMIT ?`,
					)
					.all(this.runnerDeadNoticeScanAfterAgent, scanLimit) as Array<{
					to_agent: string;
				}>;
				if (recipients.length < scanLimit) {
					const wrapped = this.db
						.prepare(
							`SELECT to_agent FROM mailbox
							  WHERE recipient_kind = 'runner' AND carrier = 'inbox' AND state = 'DEAD'
							    AND to_agent <= ?
							  GROUP BY to_agent ORDER BY to_agent LIMIT ?`,
						)
						.all(
							this.runnerDeadNoticeScanAfterAgent,
							scanLimit - recipients.length,
						) as Array<{ to_agent: string }>;
					recipients.push(...wrapped);
				}
				if (recipients.length > input.maxRecipients) {
					result.uncoveredRemaining = true;
				}
				for (const { to_agent: recipient } of recipients.slice(
					0,
					input.maxRecipients,
				)) {
					this.runnerDeadNoticeScanAfterAgent = recipient;
					const latestNotice = this.db
						.prepare(
							`SELECT id, created_at FROM mailbox
							  WHERE type = 'dead_letter_notice' AND source_kind = 'dead_letter'
							    AND source_ref = ?
							  ORDER BY seq DESC LIMIT 1`,
						)
						.get(recipient) as { id: string; created_at: string } | undefined;
					const cursorRaw = latestNotice?.id.split(":").at(-1);
					const cursor =
						cursorRaw && /^\d+$/.test(cursorRaw) ? Number(cursorRaw) : 0;
					const aggregate = this.db
						.prepare(
							`SELECT COUNT(*) AS count, MAX(seq) AS through_seq FROM mailbox
							  WHERE recipient_kind = 'runner' AND carrier = 'inbox'
							    AND state = 'DEAD' AND to_agent = ? AND seq > ?`,
						)
						.get(recipient, cursor) as {
						count: number;
						through_seq: number | null;
					};
					if (aggregate.count === 0 || aggregate.through_seq === null) continue;
					if (
						latestNotice &&
						Date.parse(input.now) - Date.parse(latestNotice.created_at) <
							input.windowMs
					) {
						result.rateLimited.push(recipient);
						result.uncoveredRemaining = true;
						continue;
					}
					const leadId = input.resolveOwningLead(recipient);
					if (!leadId) {
						result.unroutable.push(recipient);
						result.uncoveredRemaining = true;
						continue;
					}
					const summaries = this.db
						.prepare(
							`SELECT type, from_agent, content FROM mailbox
							  WHERE recipient_kind = 'runner' AND carrier = 'inbox'
							    AND state = 'DEAD' AND to_agent = ? AND seq > ?
							  ORDER BY seq LIMIT ?`,
						)
						.all(recipient, cursor, input.maxDeadRowsPerRecipient) as Array<{
						type: string;
						from_agent: string;
						content: string;
					}>;
					const renderedSummaries: string[] = [];
					for (const summary of summaries) {
						const line = `${summary.type} from ${summary.from_agent}: ${summary.content.slice(0, 120)}`;
						const candidate = formatDeadLetterNotice({
							recipient,
							count: aggregate.count,
							probeFacts: input.probeFactsByRecipient?.get(recipient),
							summaries: [...renderedSummaries, line],
						});
						if (Buffer.byteLength(candidate, "utf8") > input.maxSummaryBytes) {
							break;
						}
						renderedSummaries.push(line);
					}
					const content = utf8Prefix(
						formatDeadLetterNotice({
							recipient,
							count: aggregate.count,
							probeFacts: input.probeFactsByRecipient?.get(recipient),
							summaries: renderedSummaries,
						}),
						input.maxSummaryBytes,
					);
					const id = `dead_letter:${encodeURIComponent(recipient)}:${aggregate.through_seq}`;
					const inserted = this.enqueue({
						id,
						fromAgent: "bridge",
						toAgent: leadId,
						recipientKind: "lead",
						sourceKind: "dead_letter",
						sourceRef: recipient,
						type: "dead_letter_notice",
						msgClass: "model",
						content,
						createdAt: input.now,
						priority: 1,
						senderRef: encodeSenderRef(),
					});
					if (inserted.outcome !== "archived") result.inserted.push(id);
				}
				return result;
			})
			.immediate();
	}

	listUncoveredLeadDeadLetters(input: {
		sinceCursor: Array<{
			sourceKind: "lead_unacked" | "runner_unroutable";
			recipient: string;
			throughDeadSeq: number;
		}>;
		limit: number;
		maxRowsPerRecipient: number;
		maxSummaryBytes: number;
		resolveOwningLead: (recipient: string) => string | undefined;
		probeFactsByRecipient?: ReadonlyMap<string, string>;
	}): DeadLetterAlertCandidate[] {
		for (const [name, value] of [
			["limit", input.limit],
			["maxRowsPerRecipient", input.maxRowsPerRecipient],
			["maxSummaryBytes", input.maxSummaryBytes],
		] as const) {
			if (!Number.isSafeInteger(value) || value <= 0) {
				throw new Error(`${name} is invalid`);
			}
		}
		const cursors = new Map(
			input.sinceCursor.map((cursor) => [
				`${cursor.sourceKind}\u001f${cursor.recipient}`,
				cursor.throughDeadSeq,
			]),
		);
		// Ring-cursor fairness lets each tick stay inside the caller's exact
		// resolution budget without permanently hiding recipients behind routable
		// or already-covered rows.
		const scanLimit = input.limit;
		const cursor = this.deadAlertScanCursor;
		const recipients = cursor
			? (this.db
					.prepare(
						`SELECT recipient_kind, to_agent FROM mailbox
						 WHERE carrier = 'inbox' AND state = 'DEAD'
						   AND dead_reason IS NOT '${FROZEN_DELIVERY_UNCONFIRMED_EXHAUSTED_REASON}'
						   AND recipient_kind IN ('lead','runner')
						   AND (recipient_kind > ? OR (recipient_kind = ? AND to_agent > ?))
						 GROUP BY recipient_kind, to_agent
						 ORDER BY recipient_kind, to_agent LIMIT ?`,
					)
					.all(
						cursor.recipientKind,
						cursor.recipientKind,
						cursor.toAgent,
						scanLimit,
					) as Array<{
					recipient_kind: "lead" | "runner";
					to_agent: string;
				}>)
			: [];
		if (recipients.length < scanLimit) {
			const wrapped = cursor
				? (this.db
						.prepare(
							`SELECT recipient_kind, to_agent FROM mailbox
							 WHERE carrier = 'inbox' AND state = 'DEAD'
							   AND dead_reason IS NOT '${FROZEN_DELIVERY_UNCONFIRMED_EXHAUSTED_REASON}'
							   AND recipient_kind IN ('lead','runner')
							   AND (recipient_kind < ? OR (recipient_kind = ? AND to_agent <= ?))
							 GROUP BY recipient_kind, to_agent
							 ORDER BY recipient_kind, to_agent LIMIT ?`,
						)
						.all(
							cursor.recipientKind,
							cursor.recipientKind,
							cursor.toAgent,
							scanLimit - recipients.length,
						) as Array<{
						recipient_kind: "lead" | "runner";
						to_agent: string;
					}>)
				: (this.db
						.prepare(
							`SELECT recipient_kind, to_agent FROM mailbox
							 WHERE carrier = 'inbox' AND state = 'DEAD'
							   AND dead_reason IS NOT '${FROZEN_DELIVERY_UNCONFIRMED_EXHAUSTED_REASON}'
							   AND recipient_kind IN ('lead','runner')
							 GROUP BY recipient_kind, to_agent
							 ORDER BY recipient_kind, to_agent LIMIT ?`,
						)
						.all(scanLimit) as Array<{
						recipient_kind: "lead" | "runner";
						to_agent: string;
					}>);
			recipients.push(...wrapped);
		}
		const result: DeadLetterAlertCandidate[] = [];
		for (const row of recipients) {
			this.deadAlertScanCursor = {
				recipientKind: row.recipient_kind,
				toAgent: row.to_agent,
			};
			const sourceKind =
				row.recipient_kind === "lead" ? "lead_unacked" : "runner_unroutable";
			if (
				row.recipient_kind === "runner" &&
				input.resolveOwningLead(row.to_agent)
			) {
				continue;
			}
			const cursor = cursors.get(`${sourceKind}\u001f${row.to_agent}`) ?? 0;
			const aggregate = this.db
				.prepare(
					`SELECT COUNT(*) AS count, MAX(seq) AS through_seq FROM mailbox
					 WHERE carrier = 'inbox' AND state = 'DEAD'
					   AND dead_reason IS NOT '${FROZEN_DELIVERY_UNCONFIRMED_EXHAUSTED_REASON}'
					   AND recipient_kind = ? AND to_agent = ? AND seq > ?`,
				)
				.get(row.recipient_kind, row.to_agent, cursor) as {
				count: number;
				through_seq: number | null;
			};
			if (aggregate.count === 0 || aggregate.through_seq === null) continue;
			const summaries = this.db
				.prepare(
					`SELECT type, from_agent, content FROM mailbox
					 WHERE carrier = 'inbox' AND state = 'DEAD'
					   AND dead_reason IS NOT '${FROZEN_DELIVERY_UNCONFIRMED_EXHAUSTED_REASON}'
					   AND recipient_kind = ? AND to_agent = ? AND seq > ?
					 ORDER BY seq LIMIT ?`,
				)
				.all(
					row.recipient_kind,
					row.to_agent,
					cursor,
					input.maxRowsPerRecipient,
				) as Array<{ type: string; from_agent: string; content: string }>;
			const renderedSummaries: string[] = [];
			for (const item of summaries) {
				const line = `${item.type} from ${item.from_agent}: ${item.content.slice(0, 120)}`;
				const candidate = formatDeadLetterNotice({
					recipient: row.to_agent,
					count: aggregate.count,
					probeFacts:
						row.recipient_kind === "runner"
							? input.probeFactsByRecipient?.get(row.to_agent)
							: undefined,
					summaries: [...renderedSummaries, line],
				});
				if (Buffer.byteLength(candidate, "utf8") > input.maxSummaryBytes) {
					break;
				}
				renderedSummaries.push(line);
			}
			const summary = formatDeadLetterNotice({
				recipient: row.to_agent,
				count: aggregate.count,
				probeFacts:
					row.recipient_kind === "runner"
						? input.probeFactsByRecipient?.get(row.to_agent)
						: undefined,
				summaries: renderedSummaries,
			});
			result.push({
				sourceKind,
				recipient: row.to_agent,
				throughDeadSeq: aggregate.through_seq,
				deadCount: aggregate.count,
				summary: utf8Prefix(summary, input.maxSummaryBytes),
			});
			if (result.length >= input.limit) break;
		}
		return result;
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
				const queued = this.db
					.prepare(
						`SELECT * FROM mailbox
						  WHERE recipient_kind = 'bridge' AND carrier = 'inbox'
						    AND from_agent = ? AND msg_class = 'protocol' AND state = 'QUEUED'
						    AND (next_retry_at IS NULL OR next_retry_at <= ?)
						  ORDER BY priority, seq LIMIT 1`,
					)
					.get(input.fromAgent, input.now) as MailboxRow | undefined;
				const reclaimable = this.db
					.prepare(
						`SELECT * FROM mailbox
						  WHERE recipient_kind = 'bridge' AND carrier = 'inbox'
						    AND from_agent = ? AND msg_class = 'protocol' AND state = 'LEASED'
						    AND (claimed_by IS NULL OR claimed_by = ? OR claim_expires_at < ?)
						    AND (next_retry_at IS NULL OR next_retry_at <= ?)
						  ORDER BY priority, seq LIMIT 1`,
					)
					.get(input.fromAgent, input.ownerEpoch, input.now, input.now) as
					| MailboxRow
					| undefined;
				const row = [queued, reclaimable]
					.filter(
						(candidate): candidate is MailboxRow => candidate !== undefined,
					)
					.sort((a, b) => a.priority - b.priority || a.seq - b.seq)[0];
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

	recordRunnerBatchDeliveryFailure(input: {
		batchId: string;
		ownerEpoch: string;
		now: string;
		nextRetryAt: string;
		error: string;
		maxAttempts: number;
	}): MailboxBatchFailureResult {
		return this.db
			.transaction((): MailboxBatchFailureResult => {
				const rows = this.db
					.prepare(
						`SELECT state, claimed_by, retry_count FROM mailbox
						  WHERE batch_id = ? AND recipient_kind = 'runner'
						  ORDER BY priority, seq`,
					)
					.all(input.batchId) as Array<{
					state: MailboxState;
					claimed_by: string | null;
					retry_count: number;
				}>;
				if (rows.length === 0) {
					return { outcome: "lost_race", deadLettered: false };
				}
				const leased = rows.filter(({ state }) => state === "LEASED");
				if (leased.length === 0) {
					return {
						outcome: rows.every(({ state }) => state === "ACKED")
							? "already_settled"
							: "lost_race",
						deadLettered: rows.some(({ state }) => state === "DEAD"),
					};
				}
				if (leased.some(({ claimed_by }) => claimed_by !== input.ownerEpoch)) {
					return { outcome: "lost_race", deadLettered: false };
				}
				const deadLettered = leased.some(
					({ retry_count }) => retry_count + 1 >= input.maxAttempts,
				);
				const updated = this.db
					.prepare(
						`UPDATE mailbox SET retry_count = retry_count + 1, last_error = ?,
						   next_retry_at = CASE WHEN retry_count + 1 >= ? THEN NULL ELSE ? END,
						   state = CASE WHEN retry_count + 1 >= ? THEN 'DEAD' ELSE 'LEASED' END,
						   dead_at = CASE WHEN retry_count + 1 >= ? THEN ? ELSE dead_at END,
						   dead_reason = CASE WHEN retry_count + 1 >= ?
						     THEN 'delivery_attempts_exhausted' ELSE dead_reason END,
						   batch_id = CASE WHEN retry_count + 1 >= ? THEN NULL ELSE batch_id END,
						   claimed_by = NULL, claim_expires_at = NULL,
						   notified_at = NULL, delivered_at = NULL
						 WHERE batch_id = ? AND recipient_kind = 'runner'
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
						input.maxAttempts,
						input.batchId,
						input.ownerEpoch,
					);
				return {
					outcome: updated.changes === leased.length ? "applied" : "lost_race",
					deadLettered,
				};
			})
			.immediate();
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
				   delivered_at = COALESCE(delivered_at, ?),
				   claimed_by = NULL, claim_expires_at = NULL, next_retry_at = NULL
				 WHERE (id = ? OR delivery_id = ?) AND state IN ('QUEUED','LEASED')`,
			)
			.run(now, now, idOrDeliveryId, idOrDeliveryId);
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
				if (result.changes !== leasedCount) return false;
				this.retireAckedRunnerStopReports(input.batchId, input.now);
				return true;
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
		deadReason?: string;
	}): number {
		const result = this.db
			.prepare(
				`UPDATE mailbox SET
				   retry_count = retry_count + 1,
				   last_error = ?,
				   next_retry_at = CASE WHEN retry_count + 1 >= ? THEN NULL ELSE ? END,
				   state = CASE WHEN retry_count + 1 >= ? THEN 'DEAD' ELSE 'LEASED' END,
				   dead_at = CASE WHEN retry_count + 1 >= ? THEN ? ELSE dead_at END,
				   dead_reason = CASE WHEN retry_count + 1 >= ? THEN ? ELSE dead_reason END,
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
				input.deadReason ?? "delivery_attempts_exhausted",
				input.maxAttempts,
				input.batchId,
				input.ownerEpoch,
			);
		return result.changes;
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
		type ArchiveCandidate = {
			id: string;
			terminal_at: string;
			seq: number;
			state: "ACKED" | "DEAD";
		};
		const ackedRows = this.archiveAckedScanCursor
			? (this.db
					.prepare(
						`SELECT id, acked_at AS terminal_at, seq FROM mailbox
						  WHERE state = 'ACKED' AND acked_at <= ?
						    AND (acked_at > ? OR (acked_at = ? AND seq > ?))
						  ORDER BY acked_at, seq LIMIT ?`,
					)
					.all(
						cutoff,
						this.archiveAckedScanCursor.terminalAt,
						this.archiveAckedScanCursor.terminalAt,
						this.archiveAckedScanCursor.seq,
						candidateLimit,
					) as Array<Omit<ArchiveCandidate, "state">>)
			: [];
		if (ackedRows.length < candidateLimit) {
			const wrapped = this.archiveAckedScanCursor
				? (this.db
						.prepare(
							`SELECT id, acked_at AS terminal_at, seq FROM mailbox
							  WHERE state = 'ACKED' AND acked_at <= ?
							    AND (acked_at < ? OR (acked_at = ? AND seq <= ?))
							  ORDER BY acked_at, seq LIMIT ?`,
						)
						.all(
							cutoff,
							this.archiveAckedScanCursor.terminalAt,
							this.archiveAckedScanCursor.terminalAt,
							this.archiveAckedScanCursor.seq,
							candidateLimit - ackedRows.length,
						) as Array<Omit<ArchiveCandidate, "state">>)
				: (this.db
						.prepare(
							`SELECT id, acked_at AS terminal_at, seq FROM mailbox
							  WHERE state = 'ACKED' AND acked_at <= ?
							  ORDER BY acked_at, seq LIMIT ?`,
						)
						.all(cutoff, candidateLimit) as Array<
						Omit<ArchiveCandidate, "state">
					>);
			ackedRows.push(...wrapped);
		}
		const deadRows = this.archiveDeadScanCursor
			? (this.db
					.prepare(
						`SELECT id, dead_at AS terminal_at, seq FROM mailbox
						  WHERE state = 'DEAD' AND dead_at <= ?
						    AND (dead_at > ? OR (dead_at = ? AND seq > ?))
						  ORDER BY dead_at, seq LIMIT ?`,
					)
					.all(
						cutoff,
						this.archiveDeadScanCursor.terminalAt,
						this.archiveDeadScanCursor.terminalAt,
						this.archiveDeadScanCursor.seq,
						candidateLimit,
					) as Array<Omit<ArchiveCandidate, "state">>)
			: [];
		if (deadRows.length < candidateLimit) {
			const wrapped = this.archiveDeadScanCursor
				? (this.db
						.prepare(
							`SELECT id, dead_at AS terminal_at, seq FROM mailbox
							  WHERE state = 'DEAD' AND dead_at <= ?
							    AND (dead_at < ? OR (dead_at = ? AND seq <= ?))
							  ORDER BY dead_at, seq LIMIT ?`,
						)
						.all(
							cutoff,
							this.archiveDeadScanCursor.terminalAt,
							this.archiveDeadScanCursor.terminalAt,
							this.archiveDeadScanCursor.seq,
							candidateLimit - deadRows.length,
						) as Array<Omit<ArchiveCandidate, "state">>)
				: (this.db
						.prepare(
							`SELECT id, dead_at AS terminal_at, seq FROM mailbox
							  WHERE state = 'DEAD' AND dead_at <= ?
							  ORDER BY dead_at, seq LIMIT ?`,
						)
						.all(cutoff, candidateLimit) as Array<
						Omit<ArchiveCandidate, "state">
					>);
			deadRows.push(...wrapped);
		}
		const candidates: ArchiveCandidate[] = [
			...ackedRows.map((row) => ({ ...row, state: "ACKED" as const })),
			...deadRows.map((row) => ({ ...row, state: "DEAD" as const })),
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
			const cursor = {
				terminalAt: candidate.terminal_at,
				seq: candidate.seq,
			};
			if (candidate.state === "ACKED") {
				this.archiveAckedScanCursor = cursor;
			} else {
				this.archiveDeadScanCursor = cursor;
			}
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
							"INSERT INTO mailbox_log (event_id, message_id, subject_id, event, at, row_json) VALUES (?, ?, ?, 'archived', ?, ?)",
						)
						.run(
							`archived:${snapshot.row.id}`,
							snapshot.row.id,
							rootId,
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
		readFile?: (path: string) => Buffer;
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
				const hasLiveReference = () =>
					(
						this.db
							.prepare(
								"SELECT COUNT(*) AS count FROM mailbox WHERE content_ref = ?",
							)
							.get(intent.path) as { count: number }
					).count > 0;
				if (hasLiveReference()) {
					this.db
						.transaction(() =>
							this.deferContentRefGc(
								intent,
								input.now,
								"path still has a live mailbox reference",
							),
						)
						.immediate();
					result.pending++;
					continue;
				}
				let fileOutcome:
					| { kind: "ready" }
					| { kind: "missing" }
					| { kind: "pending"; error: string };
				if (!isValidRefPath(intent.path)) {
					fileOutcome = { kind: "pending", error: "invalid content_ref path" };
				} else {
					try {
						const bytes = (input.readFile ?? readFileSync)(intent.path);
						fileOutcome =
							createHash("sha256").update(bytes).digest("hex") ===
							intent.content_hash
								? { kind: "ready" }
								: { kind: "pending", error: "content_ref hash mismatch" };
					} catch (error) {
						fileOutcome =
							(error as NodeJS.ErrnoException).code === "ENOENT"
								? { kind: "missing" }
								: { kind: "pending", error: (error as Error).message };
					}
				}
				const status = this.db
					.transaction((): "done" | "pending" => {
						// Recheck under the write lock after the file read so a concurrent
						// enqueue cannot make us delete a newly-live content reference.
						if (hasLiveReference()) {
							this.deferContentRefGc(
								intent,
								input.now,
								"path still has a live mailbox reference",
							);
							return "pending";
						}
						if (fileOutcome.kind === "pending") {
							this.deferContentRefGc(intent, input.now, fileOutcome.error);
							return "pending";
						}
						if (fileOutcome.kind === "ready") {
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
