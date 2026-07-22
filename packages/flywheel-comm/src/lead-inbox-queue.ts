import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type LeadInboxMessageClass = "protocol" | "model";
export type LeadInboxPriority = 0 | 1 | 2 | 3;
export type ReceiptPriorityWindowsMs = readonly [
	number,
	number,
	number,
	number,
];

export const DEFAULT_RECEIPT_PRIORITY_WINDOWS_MS: ReceiptPriorityWindowsMs = [
	30 * 60_000,
	30 * 60_000,
	240 * 60_000,
	24 * 60 * 60_000,
];

export const CHAT_DELIVERY_UNCONFIRMED_REASON =
	"chat_delivery_unconfirmed" as const;

export function receiptPriorityWindowsMs(
	env: Record<string, string | undefined> = process.env,
): ReceiptPriorityWindowsMs {
	return DEFAULT_RECEIPT_PRIORITY_WINDOWS_MS.map((fallback, priority) => {
		const minutes = Number.parseInt(
			env[`FLYWHEEL_RECEIPT_WINDOW_P${priority}_MIN`] ?? "",
			10,
		);
		return Number.isSafeInteger(minutes) && minutes > 0
			? minutes * 60_000
			: fallback;
	}) as unknown as ReceiptPriorityWindowsMs;
}

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
	processed_at: string | null;
	processed_evidence: string | null;
	read_at: string | null;
	escalated_at: string | null;
	next_retry_at: string | null;
	next_unprocessed_at: string | null;
	resend_of: string | null;
	resend_round: number | null;
	candidates_json: string | null;
	family_root_id: string | null;
	routing_state: string | null;
	carrier: "inbox" | "external";
	disposed_at: string | null;
	disposed_evidence: string | null;
	receipt_exempt_reason: "internal_mirror" | null;
	receipt_episode_id: string | null;
	delivered_rounds: number;
}

export interface EnqueueLeadInboxInput {
	id: string;
	toLead: string;
	source: string;
	type: string;
	msgClass: LeadInboxMessageClass;
	priority?: LeadInboxPriority;
	content: string;
	refMessageId?: string | null;
	legacyAlias?: string | null;
	deadlineAt?: string | null;
	createdAt?: string;
	carrier?: "inbox" | "external";
	receiptExemptReason?: "internal_mirror" | null;
	receiptExemptionAudit?: {
		eventId: string;
		actor: string;
		at: string;
		changeSource: string;
	};
}

export interface EnqueueFounderHubRootInput {
	id: string;
	toLead: string;
	content: string;
	refMessageId: string;
	now: string;
	nextUnprocessedAt?: string | null;
	routingState?: string | null;
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

export interface ReceiptAlertOutboxRow {
	id: string;
	kind: string;
	payload: string;
	created_at: string;
	delivered_at: string | null;
	canceled_at: string | null;
	cancel_reason: string | null;
}

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

export type DisposedEvidenceV1 = ProcessedEvidenceV1;

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
  consumed_at      TEXT,
  processed_at     TEXT,
  processed_evidence TEXT,
  read_at          TEXT,
  escalated_at     TEXT,
  next_retry_at    TEXT,
  next_unprocessed_at TEXT,
  resend_of        TEXT,
  resend_round     INTEGER,
  candidates_json  TEXT,
  family_root_id   TEXT,
  routing_state    TEXT,
  carrier          TEXT NOT NULL DEFAULT 'inbox'
                   CHECK(carrier IN ('inbox','external')),
  disposed_at      TEXT,
  disposed_evidence TEXT,
  receipt_exempt_reason TEXT
                   CHECK(receipt_exempt_reason IS NULL OR receipt_exempt_reason = 'internal_mirror'),
  receipt_episode_id TEXT,
  delivered_rounds INTEGER NOT NULL DEFAULT 0 CHECK(delivered_rounds >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_inbox_ref
  ON lead_inbox(ref_message_id) WHERE ref_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lead_inbox_pending
  ON lead_inbox(to_lead, priority, seq) WHERE consumed_at IS NULL;
CREATE TABLE IF NOT EXISTS receipt_alert_outbox (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  payload       TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  delivered_at  TEXT,
  canceled_at   TEXT,
  cancel_reason TEXT
);
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

const RECEIPT_LEAD_COLUMNS = [
	["processed_at", "TEXT"],
	["processed_evidence", "TEXT"],
	["read_at", "TEXT"],
	["escalated_at", "TEXT"],
	["next_retry_at", "TEXT"],
	["next_unprocessed_at", "TEXT"],
	["resend_of", "TEXT"],
	["resend_round", "INTEGER"],
	["candidates_json", "TEXT"],
	["family_root_id", "TEXT"],
	["routing_state", "TEXT"],
	[
		"carrier",
		"TEXT NOT NULL DEFAULT 'inbox' CHECK(carrier IN ('inbox','external'))",
	],
	["disposed_at", "TEXT"],
	["disposed_evidence", "TEXT"],
	[
		"receipt_exempt_reason",
		"TEXT CHECK(receipt_exempt_reason IS NULL OR receipt_exempt_reason = 'internal_mirror')",
	],
	["receipt_episode_id", "TEXT"],
	["delivered_rounds", "INTEGER NOT NULL DEFAULT 0"],
] as const;

const RECEIPT_WAKE_COLUMNS = [
	["admission_state", "TEXT"],
	["envelope_json", "TEXT"],
	["push_attempts", "INTEGER NOT NULL DEFAULT 0"],
	["last_push_at", "TEXT"],
	["last_push_result", "TEXT"],
	["claim_token", "TEXT"],
	["claim_expires_at", "TEXT"],
	["t2_claimed_at", "TEXT"],
	["t2_result", "TEXT"],
	["escalation_outbox_id", "TEXT"],
	["started_ack_scope", "TEXT"],
] as const;

function tableExists(db: Database.Database, table: string): boolean {
	return Boolean(
		db
			.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
			.get(table),
	);
}

function addColumns(
	db: Database.Database,
	table: string,
	columns: ReadonlyArray<readonly [string, string]>,
): void {
	if (!tableExists(db, table)) return;
	const existing = new Set(
		(
			db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
		).map(({ name }) => name),
	);
	for (const [name, sqlType] of columns) {
		if (existing.has(name)) continue;
		try {
			db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${sqlType}`);
		} catch (error) {
			if (
				!new RegExp(`duplicate column name: ${name}`, "i").test(
					(error as Error).message,
				)
			) {
				throw error;
			}
		}
	}
}

/** Additive, race-tolerant FLY-1392 schema migration shared by both DB facades. */
export function applyReceiptFoundationMigrations(db: Database.Database): void {
	addColumns(db, "lead_inbox", RECEIPT_LEAD_COLUMNS);
	addColumns(db, "runner_phase_wakes", RECEIPT_WAKE_COLUMNS);
	db.exec(`
		CREATE TABLE IF NOT EXISTS receipt_alert_outbox (
		  id TEXT PRIMARY KEY,
		  kind TEXT NOT NULL,
		  payload TEXT NOT NULL,
		  created_at TEXT NOT NULL,
		  delivered_at TEXT,
		  canceled_at TEXT,
		  cancel_reason TEXT
		);
		CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_inbox_resend
		  ON lead_inbox(resend_of, resend_round) WHERE resend_of IS NOT NULL;
		DROP INDEX IF EXISTS idx_lead_inbox_pending;
		CREATE INDEX IF NOT EXISTS idx_lead_inbox_pending
		  ON lead_inbox(to_lead, priority, seq)
		  WHERE carrier = 'inbox' AND consumed_at IS NULL;
		CREATE TABLE IF NOT EXISTS receipt_activation_episodes (
		  episode_id TEXT PRIMARY KEY,
		  disabled_at TEXT,
		  enabled_at TEXT,
		  activation_at TEXT,
		  status TEXT NOT NULL,
		  dry_run_counts TEXT NOT NULL,
		  commit_counts TEXT,
		  high_water_mark TEXT
		);
		CREATE TABLE IF NOT EXISTS receipt_exemption_audit (
		  event_id TEXT PRIMARY KEY,
		  receipt_id TEXT NOT NULL,
		  reason TEXT NOT NULL CHECK(reason = 'internal_mirror'),
		  actor TEXT NOT NULL,
		  ts TEXT NOT NULL,
		  change_source TEXT NOT NULL,
		  operation TEXT NOT NULL CHECK(operation IN ('set','clear')),
		  prev_value TEXT,
		  new_value TEXT
		);
		CREATE TRIGGER IF NOT EXISTS receipt_exemption_audit_no_update
		BEFORE UPDATE ON receipt_exemption_audit
		BEGIN SELECT RAISE(ABORT, 'receipt exemption audit is append-only'); END;
		CREATE TRIGGER IF NOT EXISTS receipt_exemption_audit_no_delete
		BEFORE DELETE ON receipt_exemption_audit
		BEGIN SELECT RAISE(ABORT, 'receipt exemption audit is append-only'); END;
		CREATE TABLE IF NOT EXISTS receipt_handle_requests (
		  request_id TEXT PRIMARY KEY,
		  receipt_id TEXT NOT NULL,
		  action TEXT NOT NULL,
		  payload_digest TEXT NOT NULL,
		  result_json TEXT NOT NULL,
		  created_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS receipt_resend_deliveries (
		  child_id TEXT PRIMARY KEY,
		  root_id TEXT NOT NULL,
		  logical_round INTEGER NOT NULL CHECK(logical_round > 0),
		  delivered_at TEXT NOT NULL
		);
		DROP INDEX IF EXISTS idx_lead_inbox_resend;
		CREATE INDEX IF NOT EXISTS idx_lead_inbox_resend
		  ON lead_inbox(resend_of, resend_round, receipt_episode_id)
		  WHERE resend_of IS NOT NULL;
		CREATE TRIGGER IF NOT EXISTS lead_inbox_receipt_terminal_insert
		BEFORE INSERT ON lead_inbox
		WHEN (NEW.processed_at IS NULL) != (NEW.processed_evidence IS NULL)
		  OR (NEW.disposed_at IS NULL) != (NEW.disposed_evidence IS NULL)
		  OR (NEW.processed_at IS NOT NULL AND NEW.disposed_at IS NOT NULL)
		BEGIN
		  SELECT CASE
		    WHEN (NEW.processed_at IS NULL) != (NEW.processed_evidence IS NULL)
		      THEN RAISE(ABORT, 'processed evidence must be paired')
		    WHEN (NEW.disposed_at IS NULL) != (NEW.disposed_evidence IS NULL)
		      THEN RAISE(ABORT, 'disposed evidence must be paired')
		    ELSE RAISE(ABORT, 'receipt terminal states are exclusive')
		  END;
		END;
		CREATE TRIGGER IF NOT EXISTS lead_inbox_receipt_terminal_update
		BEFORE UPDATE OF processed_at, processed_evidence, disposed_at, disposed_evidence
		ON lead_inbox
		WHEN (NEW.processed_at IS NULL) != (NEW.processed_evidence IS NULL)
		  OR (NEW.disposed_at IS NULL) != (NEW.disposed_evidence IS NULL)
		  OR (NEW.processed_at IS NOT NULL AND NEW.disposed_at IS NOT NULL)
		BEGIN
		  SELECT CASE
		    WHEN (NEW.processed_at IS NULL) != (NEW.processed_evidence IS NULL)
		      THEN RAISE(ABORT, 'processed evidence must be paired')
		    WHEN (NEW.disposed_at IS NULL) != (NEW.disposed_evidence IS NULL)
		      THEN RAISE(ABORT, 'disposed evidence must be paired')
		    ELSE RAISE(ABORT, 'receipt terminal states are exclusive')
		  END;
		END;
	`);
}

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

function leadInboxPriority(value: number | undefined): LeadInboxPriority {
	const priority = value ?? 2;
	if (!Number.isSafeInteger(priority) || priority < 0 || priority > 3) {
		throw new Error("priority must be an integer from 0 through 3");
	}
	return priority as LeadInboxPriority;
}

function assertReceiptPriorityWindows(windows: ReceiptPriorityWindowsMs): void {
	if (
		windows.length !== 4 ||
		windows.some((window) => !Number.isSafeInteger(window) || window <= 0)
	) {
		throw new Error("receiptWindowsMs must contain four positive integers");
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

export class LeadInboxQueue {
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
		this.db.exec(LEAD_INBOX_SCHEMA);
		applyReceiptFoundationMigrations(this.db);
	}

	enqueue(input: EnqueueLeadInboxInput): LeadInboxRow {
		const id = requiredText(input.id, "id");
		const toLead = requiredText(input.toLead, "toLead");
		const source = requiredText(input.source, "source");
		const type = requiredText(input.type, "type");
		const priority = leadInboxPriority(input.priority);
		const carrier = input.carrier ?? "inbox";
		if (carrier !== "inbox" && carrier !== "external") {
			throw new Error("carrier must be inbox or external");
		}
		if (
			input.receiptExemptReason !== undefined &&
			input.receiptExemptReason !== null &&
			input.receiptExemptReason !== "internal_mirror"
		) {
			throw new Error("receiptExemptReason must be internal_mirror");
		}
		if (input.receiptExemptReason && !input.receiptExemptionAudit) {
			throw new Error("receipt exemption requires an audit record");
		}
		if (!input.receiptExemptReason && input.receiptExemptionAudit) {
			throw new Error("receipt exemption audit requires internal_mirror");
		}
		const exemptionAudit = input.receiptExemptionAudit;
		if (exemptionAudit) {
			requiredText(exemptionAudit.eventId, "receiptExemptionAudit.eventId");
			requiredText(exemptionAudit.actor, "receiptExemptionAudit.actor");
			requiredText(
				exemptionAudit.changeSource,
				"receiptExemptionAudit.changeSource",
			);
			assertUtcIsoTimestamp(exemptionAudit.at, "receiptExemptionAudit.at");
		}
		if (input.deadlineAt) {
			assertUtcIsoTimestamp(input.deadlineAt, "deadlineAt");
		}
		if (input.createdAt) {
			assertUtcIsoTimestamp(input.createdAt, "createdAt");
		}

		const enqueue = this.db.transaction(() => {
			this.db
				.prepare(
					`INSERT OR IGNORE INTO lead_inbox (
				   id, to_lead, source, type, msg_class, priority, content,
				   ref_message_id, legacy_alias, deadline_at, created_at, carrier,
				   receipt_exempt_reason
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
				   COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')), ?, ?
				 )`,
				)
				.run(
					id,
					toLead,
					source,
					type,
					input.msgClass,
					priority,
					input.content,
					input.refMessageId ?? null,
					input.legacyAlias ?? null,
					input.deadlineAt ?? null,
					input.createdAt ?? null,
					carrier,
					input.receiptExemptReason ?? null,
				);

			const row = this.getById(id);
			if (!row) throw new Error(`lead inbox enqueue failed for ${id}`);
			const expected = {
				to_lead: toLead,
				source,
				type,
				msg_class: input.msgClass,
				priority,
				content: input.content,
				ref_message_id: input.refMessageId ?? null,
				legacy_alias: input.legacyAlias ?? null,
				deadline_at: input.deadlineAt ?? null,
				carrier,
				receipt_exempt_reason: input.receiptExemptReason ?? null,
			};
			for (const [key, value] of Object.entries(expected)) {
				if (row[key as keyof LeadInboxRow] !== value) {
					throw new Error(
						`lead inbox id ${id} was reused with different ${key}`,
					);
				}
			}
			if (exemptionAudit) {
				this.db
					.prepare(
						`INSERT OR IGNORE INTO receipt_exemption_audit (
						   event_id, receipt_id, reason, actor, ts, change_source,
						   operation, prev_value, new_value
						 ) VALUES (?, ?, 'internal_mirror', ?, ?, ?, 'set', NULL,
						   'internal_mirror')`,
					)
					.run(
						exemptionAudit.eventId,
						id,
						exemptionAudit.actor,
						exemptionAudit.at,
						exemptionAudit.changeSource,
					);
				const audit = this.db
					.prepare(
						`SELECT receipt_id, reason, actor, ts, change_source, operation,
						        prev_value, new_value
						   FROM receipt_exemption_audit WHERE event_id = ?`,
					)
					.get(exemptionAudit.eventId) as Record<string, unknown> | undefined;
				const expectedAudit = {
					receipt_id: id,
					reason: "internal_mirror",
					actor: exemptionAudit.actor,
					ts: exemptionAudit.at,
					change_source: exemptionAudit.changeSource,
					operation: "set",
					prev_value: null,
					new_value: "internal_mirror",
				};
				if (
					!audit ||
					Object.entries(expectedAudit).some(
						([key, value]) => audit[key] !== value,
					)
				) {
					throw new Error(
						`receipt exemption audit ${exemptionAudit.eventId} was reused`,
					);
				}
			}
			return row;
		});
		return enqueue.immediate();
	}

	/**
	 * Compatibility name for the v2 founder producer. The canonical row is the
	 * model-lane delivery itself; no protocol/consumed shadow row is created.
	 */
	enqueueHubRoot(input: EnqueueFounderHubRootInput): LeadInboxRow {
		const id = requiredText(input.id, "id");
		const toLead = requiredText(input.toLead, "toLead");
		const content = requiredText(input.content, "content");
		const refMessageId = requiredText(input.refMessageId, "refMessageId");
		assertUtcIsoTimestamp(input.now, "now");
		const routingState = input.routingState?.trim() || "hub_recorded";
		const enqueue = this.db.transaction(() => {
			this.enqueue({
				id,
				toLead,
				source: "founder_reply",
				type: "founder_reply",
				msgClass: "model",
				priority: 0,
				content,
				refMessageId,
				createdAt: input.now,
			});
			this.db
				.prepare(
					`UPDATE lead_inbox SET routing_state = COALESCE(routing_state, ?)
					 WHERE id = ? AND routing_state IS NULL`,
				)
				.run(routingState, id);
			const row = this.getById(id);
			if (
				!row ||
				row.to_lead !== toLead ||
				row.source !== "founder_reply" ||
				row.type !== "founder_reply" ||
				row.msg_class !== "model" ||
				row.priority !== 0 ||
				row.content !== content ||
				row.ref_message_id !== refMessageId ||
				row.disposition !== null ||
				row.delivered_at !== null ||
				row.consumed_at !== null ||
				row.routing_state !== routingState
			) {
				throw new Error(
					`founder hub root ${id} was reused with different data`,
				);
			}
			return row;
		});
		return enqueue.immediate();
	}

	getById(id: string): LeadInboxRow | undefined {
		return this.db.prepare("SELECT * FROM lead_inbox WHERE id = ?").get(id) as
			| LeadInboxRow
			| undefined;
	}

	/** Complete the external transport saga after its durable journal accepts. */
	markExternalDelivered(
		id: string,
		input: { now: string; receiptWindowsMs: ReceiptPriorityWindowsMs },
	): boolean {
		assertUtcIsoTimestamp(input.now, "now");
		assertReceiptPriorityWindows(input.receiptWindowsMs);
		const mark = this.db.transaction(() => {
			const row = this.getById(requiredText(id, "id"));
			if (!row || row.carrier !== "external") return false;
			const nextUnprocessedAt =
				row.receipt_exempt_reason === null &&
				row.processed_at === null &&
				row.disposed_at === null
					? new Date(
							Date.parse(input.now) + input.receiptWindowsMs[row.priority],
						).toISOString()
					: null;
			const result = this.db
				.prepare(
					`UPDATE lead_inbox SET delivered_at = ?, consumed_at = ?,
					   disposition = 'external_delivered',
					   next_unprocessed_at = COALESCE(next_unprocessed_at, ?),
					   resend_round = COALESCE(resend_round, 0)
					 WHERE id = ? AND carrier = 'external' AND delivered_at IS NULL
					   AND consumed_at IS NULL`,
				)
				.run(input.now, input.now, nextUnprocessedAt, id);
			if (result.changes === 1) return true;
			const existing = this.getById(id);
			return Boolean(
				existing?.carrier === "external" &&
					existing.delivered_at !== null &&
					existing.consumed_at !== null &&
					existing.disposition === "external_delivered",
			);
		});
		return mark.immediate();
	}

	listExternalDeliveryPending(input: {
		before: string;
		limit?: number;
	}): LeadInboxRow[] {
		assertUtcIsoTimestamp(input.before, "before");
		const limit = input.limit ?? 100;
		if (!Number.isSafeInteger(limit) || limit <= 0) {
			throw new Error("limit must be a positive safe integer");
		}
		return this.db
			.prepare(
				`SELECT * FROM lead_inbox
				  WHERE carrier = 'external' AND delivered_at IS NULL
				    AND disposed_at IS NULL AND created_at <= ?
				  ORDER BY seq ASC LIMIT ?`,
			)
			.all(input.before, limit) as LeadInboxRow[];
	}

	/**
	 * Stable, SQL-filtered pagination for one external receipt producer lane.
	 * The lane owns redelivery, so already delivered/settled/disposed rows never
	 * consume its bounded scan budget.
	 */
	listExternalPendingForLane(input: {
		toLead: string;
		idPrefix: string;
		cursorSeq?: number;
		limit?: number;
		createdBefore?: string;
		excludeQuarantined?: boolean;
	}): LeadInboxRow[] {
		const toLead = requiredText(input.toLead, "toLead");
		const idPrefix = requiredText(input.idPrefix, "idPrefix");
		const cursorSeq = input.cursorSeq ?? 0;
		const limit = input.limit ?? 100;
		if (!Number.isSafeInteger(cursorSeq) || cursorSeq < 0) {
			throw new Error("cursorSeq must be a non-negative safe integer");
		}
		if (!Number.isSafeInteger(limit) || limit <= 0) {
			throw new Error("limit must be a positive safe integer");
		}
		if (input.createdBefore) {
			assertUtcIsoTimestamp(input.createdBefore, "createdBefore");
		}

		const predicates = [
			"carrier = 'external'",
			"delivered_at IS NULL",
			"disposed_at IS NULL",
			"processed_at IS NULL",
			"to_lead = ?",
			"substr(id, 1, length(?)) = ?",
			"seq > ?",
		];
		const values: Array<string | number> = [
			toLead,
			idPrefix,
			idPrefix,
			cursorSeq,
		];
		if (input.createdBefore) {
			predicates.push("created_at <= ?");
			values.push(input.createdBefore);
		}
		if (input.excludeQuarantined) {
			predicates.push(
				"(disposition IS NULL OR disposition <> 'delivery_quarantined')",
			);
		}
		values.push(limit);
		return this.db
			.prepare(
				`SELECT * FROM lead_inbox
				  WHERE ${predicates.join(" AND ")}
				  ORDER BY seq ASC LIMIT ?`,
			)
			.all(...values) as LeadInboxRow[];
	}

	getLatestReceiptActivation():
		| {
				episode_id: string;
				status: string;
				high_water_mark: string | null;
		  }
		| undefined {
		return this.db
			.prepare(
				`SELECT episode_id, status, high_water_mark
				 FROM receipt_activation_episodes ORDER BY rowid DESC LIMIT 1`,
			)
			.get() as
			| {
					episode_id: string;
					status: string;
					high_water_mark: string | null;
			  }
			| undefined;
	}

	markExternalAborted(
		id: string,
		input: { now: string; reason: string },
	): boolean {
		assertUtcIsoTimestamp(input.now, "now");
		const reason = requiredText(input.reason, "reason");
		const evidence: DisposedEvidenceV1 = {
			v: 1,
			kind: "external_delivery_aborted",
			ref: id,
			actor: "receipt-saga-reconciler",
			actor_kind: "bridge-protocol",
			fence: { reason },
			basis: ["journal_absent", "retention_watermark"],
		};
		const encoded = JSON.stringify(evidence);
		const mark = this.db.transaction(() => {
			const result = this.db
				.prepare(
					`UPDATE lead_inbox SET disposition = 'delivery_aborted',
					   disposed_at = ?, disposed_evidence = ?,
					   next_unprocessed_at = NULL
					 WHERE id = ? AND carrier = 'external' AND delivered_at IS NULL
					   AND processed_at IS NULL AND disposed_at IS NULL`,
				)
				.run(input.now, encoded, id);
			if (result.changes === 1) return true;
			const existing = this.getById(id);
			return Boolean(
				existing?.carrier === "external" &&
					existing.disposition === "delivery_aborted" &&
					existing.disposed_evidence === encoded,
			);
		});
		return mark.immediate();
	}

	quarantineExternalDelivery(
		id: string,
		input: { now: string; reason: string },
	): boolean {
		assertUtcIsoTimestamp(input.now, "now");
		const reason = requiredText(input.reason, "reason");
		const quarantine = this.db.transaction(() => {
			const row = this.getById(id);
			if (
				!row ||
				row.carrier !== "external" ||
				row.delivered_at !== null ||
				row.disposed_at !== null
			) {
				return false;
			}
			this.db
				.prepare(
					`UPDATE lead_inbox SET disposition = 'delivery_quarantined',
					   last_error = ? WHERE id = ? AND delivered_at IS NULL`,
				)
				.run(reason, id);
			const outboxId = `external_saga_unknown:${id}`;
			const payload = JSON.stringify({
				receiptId: id,
				toLead: row.to_lead,
				reason,
			});
			this.db
				.prepare(
					`INSERT OR IGNORE INTO receipt_alert_outbox
					 (id, kind, payload, created_at)
					 VALUES (?, 'external_saga_unknown', ?, ?)`,
				)
				.run(outboxId, payload, input.now);
			const outbox = this.getReceiptAlertOutbox(outboxId);
			return Boolean(
				outbox?.kind === "external_saga_unknown" && outbox.payload === payload,
			);
		});
		return quarantine.immediate();
	}

	markProcessed(
		id: string,
		input: { now: string; evidence: ProcessedEvidenceV1 },
	): boolean {
		assertUtcIsoTimestamp(input.now, "now");
		assertProcessedEvidence(input.evidence);
		const encoded = JSON.stringify(input.evidence);
		const mark = this.db.transaction(() => {
			const result = this.db
				.prepare(
					`UPDATE lead_inbox SET processed_at = ?, processed_evidence = ?
					 WHERE id = ? AND processed_at IS NULL
					   AND processed_evidence IS NULL AND disposed_at IS NULL
					   AND disposed_evidence IS NULL`,
				)
				.run(input.now, encoded, id);
			if (result.changes === 1) {
				this.closeReceiptFamily(id, input.now);
				return true;
			}
			const existing = this.getById(id);
			if (!existing) return false;
			if (existing.disposed_at !== null) {
				throw new Error(`lead inbox row ${id} is already disposed`);
			}
			if (
				existing.processed_at !== null &&
				existing.processed_evidence === encoded
			) {
				this.closeReceiptFamily(id, input.now);
				return true;
			}
			throw new Error(
				`lead inbox row ${id} has conflicting processed evidence`,
			);
		});
		return mark.immediate();
	}

	markDisposed(
		id: string,
		input: { now: string; evidence: DisposedEvidenceV1 },
	): boolean {
		assertUtcIsoTimestamp(input.now, "now");
		assertProcessedEvidence(input.evidence);
		const encoded = JSON.stringify(input.evidence);
		const mark = this.db.transaction(() => {
			const result = this.db
				.prepare(
					`UPDATE lead_inbox SET disposed_at = ?, disposed_evidence = ?
					 WHERE id = ? AND disposed_at IS NULL AND disposed_evidence IS NULL
					   AND processed_at IS NULL AND processed_evidence IS NULL`,
				)
				.run(input.now, encoded, id);
			if (result.changes === 1) {
				this.closeReceiptFamily(id, input.now);
				return true;
			}
			const existing = this.getById(id);
			if (!existing) return false;
			if (existing.processed_at !== null) {
				throw new Error(`lead inbox row ${id} is already processed`);
			}
			if (
				existing.disposed_at !== null &&
				existing.disposed_evidence === encoded
			) {
				this.closeReceiptFamily(id, input.now);
				return true;
			}
			throw new Error(`lead inbox row ${id} has conflicting disposed evidence`);
		});
		return mark.immediate();
	}

	countPending(toLead?: string): number {
		const row = (
			toLead
				? this.db
						.prepare(
							"SELECT COUNT(*) AS count FROM lead_inbox WHERE carrier = 'inbox' AND consumed_at IS NULL AND to_lead = ?",
						)
						.get(toLead)
				: this.db
						.prepare(
							"SELECT COUNT(*) AS count FROM lead_inbox WHERE carrier = 'inbox' AND consumed_at IS NULL",
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
					  WHERE to_lead = ? AND carrier = 'inbox' AND consumed_at IS NULL
					    AND (claimed_by IS NULL OR claimed_by = ? OR claim_expires_at < ?)
					  ORDER BY priority, seq LIMIT ?`,
				)
				.all(input.toLead, input.ownerEpoch, input.now, limit) as Array<{
				id: string;
			}>;
			const update = this.db.prepare(
				`UPDATE lead_inbox SET claimed_by = ?, claim_expires_at = ?
				  WHERE id = ? AND carrier = 'inbox' AND consumed_at IS NULL
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
					   AND carrier = 'inbox' AND claimed_by = ? AND consumed_at IS NULL
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
		respectRetryAt?: boolean;
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
		respectRetryAt?: boolean;
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
			const retryPredicate = input.respectRetryAt
				? "AND (next_retry_at IS NULL OR next_retry_at <= ?)"
				: "";
			const existing = this.db
				.prepare(
					`SELECT batch_id FROM lead_inbox
					 WHERE to_lead = ? AND carrier = 'inbox' AND msg_class = 'model'
					   AND consumed_at IS NULL AND batch_id IS NOT NULL
					   AND (resend_of IS NULL OR receipt_episode_id =
					     (SELECT episode_id FROM receipt_activation_episodes
					       WHERE status = 'active' ORDER BY rowid DESC LIMIT 1))
					   ${retryPredicate}
					 GROUP BY batch_id
					 ORDER BY MIN(priority), MIN(seq) LIMIT 1`,
				)
				.get(
					...(input.respectRetryAt
						? [input.toLead, input.now]
						: [input.toLead]),
				) as { batch_id: string } | undefined;
			const effectiveBatchId = existing?.batch_id ?? batchId;
			let rows: LeadInboxRow[];
			if (existing) {
				rows = this.db
					.prepare(
						`SELECT * FROM lead_inbox
						 WHERE to_lead = ? AND carrier = 'inbox' AND msg_class = 'model'
						   AND consumed_at IS NULL AND batch_id = ?
						   AND (resend_of IS NULL OR receipt_episode_id =
						     (SELECT episode_id FROM receipt_activation_episodes
						       WHERE status = 'active' ORDER BY rowid DESC LIMIT 1))
						   ${retryPredicate}
						 ORDER BY priority, seq`,
					)
					.all(
						...(input.respectRetryAt
							? [input.toLead, effectiveBatchId, input.now]
							: [input.toLead, effectiveBatchId]),
					) as LeadInboxRow[];
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
						 WHERE to_lead = ? AND carrier = 'inbox' AND msg_class = 'model'
						   AND consumed_at IS NULL AND batch_id IS NULL
						   AND (resend_of IS NULL OR receipt_episode_id =
						     (SELECT episode_id FROM receipt_activation_episodes
						       WHERE status = 'active' ORDER BY rowid DESC LIMIT 1))
						   ${retryPredicate}
						   AND (claimed_by IS NULL OR claimed_by = ? OR claim_expires_at < ?)
						 ORDER BY priority, seq LIMIT ?`,
					)
					.all(
						input.toLead,
						...(input.respectRetryAt ? [input.now] : []),
						input.ownerEpoch,
						input.now,
						limit,
					) as LeadInboxRow[];
			}
			if (rows.length === 0) return [];
			const update = this.db.prepare(
				`UPDATE lead_inbox SET batch_id = ?, claimed_by = ?, claim_expires_at = ?
				 WHERE id = ? AND carrier = 'inbox' AND consumed_at IS NULL
				   AND (resend_of IS NULL OR receipt_episode_id =
				     (SELECT episode_id FROM receipt_activation_episodes
				       WHERE status = 'active' ORDER BY rowid DESC LIMIT 1))
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
					 WHERE to_lead = ? AND carrier = 'inbox' AND consumed_at IS NULL AND batch_id = ?
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
		input: {
			ownerEpoch: string;
			disposition: string;
			now: string;
			/** Present only while FLYWHEEL_RECEIPT_FOUNDATION is enabled. */
			receiptWindowMs?: number;
			/** Category-agnostic v2 windows indexed by row priority. */
			receiptWindowsMs?: ReceiptPriorityWindowsMs;
			/** Test-only R6 transaction crash seams. */
			testCrashAfter?: "before_child_cas" | "round_recorded";
		},
	): number {
		if (ids.length === 0) return 0;
		assertUtcIsoTimestamp(input.now, "now");
		if (
			input.receiptWindowMs !== undefined &&
			(!Number.isSafeInteger(input.receiptWindowMs) ||
				input.receiptWindowMs <= 0)
		) {
			throw new Error("receiptWindowMs must be a positive safe integer");
		}
		if (input.receiptWindowsMs) {
			assertReceiptPriorityWindows(input.receiptWindowsMs);
		}
		const receiptWindows = input.receiptWindowsMs;
		const consume = this.db.transaction(() => {
			if (!this.isCurrentOwner(input.ownerEpoch, input.now)) return 0;
			const placeholders = ids.map(() => "?").join(",");
			const eligible =
				(input.receiptWindowMs !== undefined || receiptWindows !== undefined) &&
				input.disposition === "delivered"
					? (this.db
							.prepare(
								`SELECT id, priority FROM lead_inbox
								  WHERE id IN (${placeholders}) AND carrier = 'inbox'
								    AND consumed_at IS NULL AND claimed_by = ?
								    AND resend_of IS NULL AND processed_at IS NULL
								    AND disposed_at IS NULL AND receipt_exempt_reason IS NULL`,
							)
							.all(...ids, input.ownerEpoch) as Array<{
							id: string;
							priority: LeadInboxPriority;
						}>)
					: [];
			const resendChildren = this.db
				.prepare(
					`SELECT id, resend_of, resend_round, receipt_episode_id, priority
					 FROM lead_inbox
					 WHERE id IN (${placeholders}) AND carrier = 'inbox'
					   AND consumed_at IS NULL AND claimed_by = ?
					   AND resend_of IS NOT NULL AND resend_round IS NOT NULL`,
				)
				.all(...ids, input.ownerEpoch) as Array<{
				id: string;
				resend_of: string;
				resend_round: number;
				receipt_episode_id: string | null;
				priority: LeadInboxPriority;
			}>;
			if (
				resendChildren.length > 0 &&
				input.testCrashAfter === "before_child_cas"
			) {
				throw new Error("test crash after adapter receipt before child CAS");
			}
			const consumed = this.db
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
			for (const child of resendChildren) {
				if (input.disposition !== "delivered" || !child.receipt_episode_id) {
					continue;
				}
				const inserted = this.db
					.prepare(
						`INSERT OR IGNORE INTO receipt_resend_deliveries
						 (child_id, root_id, logical_round, delivered_at)
						 VALUES (?, ?, ?, ?)`,
					)
					.run(child.id, child.resend_of, child.resend_round, input.now);
				if (inserted.changes !== 1) continue;
				const advanced = this.db
					.prepare(
						`UPDATE lead_inbox SET delivered_rounds = ?, resend_round = ?
						 WHERE id = ? AND resend_of IS NULL
						   AND delivered_rounds = ? AND receipt_episode_id = ?
						   AND processed_at IS NULL AND disposed_at IS NULL`,
					)
					.run(
						child.resend_round,
						child.resend_round,
						child.resend_of,
						child.resend_round - 1,
						child.receipt_episode_id,
					);
				if (advanced.changes !== 1) {
					throw new Error(`resend root round CAS failed for ${child.id}`);
				}
				if (input.testCrashAfter === "round_recorded") {
					throw new Error("test crash after resend round accounting");
				}
				const windowMs =
					receiptWindows?.[child.priority] ?? input.receiptWindowMs;
				if (windowMs === undefined) {
					throw new Error("resend delivery requires an active receipt window");
				}
				this.db
					.prepare(
						`UPDATE lead_inbox SET next_unprocessed_at = ?
						 WHERE id = ? AND delivered_rounds = ?
						   AND receipt_episode_id = ? AND processed_at IS NULL
						   AND disposed_at IS NULL`,
					)
					.run(
						new Date(Date.parse(input.now) + windowMs).toISOString(),
						child.resend_of,
						child.resend_round,
						child.receipt_episode_id,
					);
			}
			if (eligible.length > 0) {
				const initialize = this.db.prepare(
					`UPDATE lead_inbox SET
					   next_unprocessed_at = COALESCE(next_unprocessed_at, ?),
					   resend_round = COALESCE(resend_round, 0),
					   receipt_episode_id = COALESCE(receipt_episode_id,
					     (SELECT episode_id FROM receipt_activation_episodes
					       WHERE status = 'active' AND activation_at IS NOT NULL
					       ORDER BY rowid DESC LIMIT 1))
					 WHERE id = ? AND consumed_at = ? AND disposition = 'delivered'
					   AND processed_at IS NULL AND disposed_at IS NULL
					   AND receipt_exempt_reason IS NULL`,
				);
				for (const row of eligible) {
					const windowMs =
						receiptWindows?.[row.priority] ?? input.receiptWindowMs;
					if (windowMs === undefined) continue;
					initialize.run(
						new Date(Date.parse(input.now) + windowMs).toISOString(),
						row.id,
						input.now,
					);
				}
			}
			return consumed;
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
					 WHERE id IN (${placeholders}) AND carrier = 'inbox' AND consumed_at IS NULL
					   AND claimed_by = ?`,
				)
				.run(input.error, ...ids, input.ownerEpoch).changes;
		});
		return fail.immediate();
	}

	recordModelDeliveryFailure(
		ids: string[],
		input: {
			ownerEpoch: string;
			batchId: string;
			toLead: string;
			error: string;
			now: string;
			maxAttempts: number;
			backoffBaseMs: number;
			backoffCapMs: number;
		},
	): { attempts: number; deadLettered: boolean; outboxId: string | null } {
		if (ids.length === 0) {
			return { attempts: 0, deadLettered: false, outboxId: null };
		}
		const memberIds = ids.map((id) => requiredText(id, "id"));
		if (new Set(memberIds).size !== memberIds.length) {
			throw new Error("model failure ids must be unique");
		}
		const ownerEpoch = requiredText(input.ownerEpoch, "ownerEpoch");
		const batchId = requiredText(input.batchId, "batchId");
		const toLead = requiredText(input.toLead, "toLead");
		const error = requiredText(input.error, "error");
		assertUtcIsoTimestamp(input.now, "now");
		for (const [field, value] of [
			["maxAttempts", input.maxAttempts],
			["backoffBaseMs", input.backoffBaseMs],
			["backoffCapMs", input.backoffCapMs],
		] as const) {
			if (!Number.isSafeInteger(value) || value <= 0) {
				throw new Error(`${field} must be a positive safe integer`);
			}
		}
		const fail = this.db.transaction(() => {
			if (!this.isCurrentOwner(ownerEpoch, input.now)) {
				return { attempts: 0, deadLettered: false, outboxId: null };
			}
			const placeholders = memberIds.map(() => "?").join(",");
			const rows = this.db
				.prepare(
					`SELECT id, attempts FROM lead_inbox
					 WHERE id IN (${placeholders}) AND to_lead = ? AND carrier = 'inbox'
					   AND msg_class = 'model' AND batch_id = ?
					   AND consumed_at IS NULL AND claimed_by = ?`,
				)
				.all(...memberIds, toLead, batchId, ownerEpoch) as Array<{
				id: string;
				attempts: number;
			}>;
			if (rows.length !== memberIds.length) {
				return { attempts: 0, deadLettered: false, outboxId: null };
			}
			const attempts = Math.max(...rows.map((row) => row.attempts)) + 1;
			const deadLettered = attempts >= input.maxAttempts;
			const retryDelay = Math.min(
				input.backoffCapMs,
				input.backoffBaseMs * 2 ** Math.max(0, attempts - 1),
			);
			const nextRetryAt = deadLettered
				? null
				: new Date(Date.parse(input.now) + retryDelay).toISOString();
			const result = this.db
				.prepare(
					`UPDATE lead_inbox SET attempts = attempts + 1, last_error = ?,
					   next_retry_at = ?,
					   consumed_at = CASE WHEN ? THEN ? ELSE consumed_at END,
					   disposition = CASE WHEN ? THEN 'dead_letter' ELSE disposition END,
					   claimed_by = NULL, claim_expires_at = NULL
					 WHERE id IN (${placeholders}) AND to_lead = ? AND carrier = 'inbox'
					   AND msg_class = 'model' AND batch_id = ?
					   AND consumed_at IS NULL AND claimed_by = ?`,
				)
				.run(
					error,
					nextRetryAt,
					deadLettered ? 1 : 0,
					input.now,
					deadLettered ? 1 : 0,
					...memberIds,
					toLead,
					batchId,
					ownerEpoch,
				);
			if (result.changes !== memberIds.length) {
				throw new Error("model batch membership changed during failure commit");
			}
			if (!deadLettered) {
				return { attempts, deadLettered, outboxId: null };
			}
			const outboxId = `dead_letter:${batchId}`;
			const payload = JSON.stringify({
				batchId,
				toLead,
				memberIds,
				attempts,
				error,
			});
			this.db
				.prepare(
					`INSERT OR IGNORE INTO receipt_alert_outbox
					 (id, kind, payload, created_at)
					 VALUES (?, 'dead_letter', ?, ?)`,
				)
				.run(outboxId, payload, input.now);
			const outbox = this.getReceiptAlertOutbox(outboxId);
			if (
				!outbox ||
				outbox.kind !== "dead_letter" ||
				outbox.payload !== payload
			) {
				throw new Error(`dead-letter outbox id ${outboxId} was reused`);
			}
			return { attempts, deadLettered, outboxId };
		});
		return fail.immediate();
	}

	getReceiptAlertOutbox(id: string): ReceiptAlertOutboxRow | undefined {
		return this.db
			.prepare("SELECT * FROM receipt_alert_outbox WHERE id = ?")
			.get(id) as ReceiptAlertOutboxRow | undefined;
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
					 WHERE id = ? AND carrier = 'inbox' AND msg_class = 'protocol' AND consumed_at IS NULL
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
					 WHERE id = ? AND carrier = 'inbox' AND consumed_at IS NULL AND claimed_by = ?`,
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

	recordProtocolDeliveryFailure(
		id: string,
		input: {
			ownerEpoch: string;
			error: string;
			now: string;
			maxAttempts: number;
			backoffBaseMs: number;
			backoffCapMs: number;
		},
	): { attempts: number; deadLettered: boolean; outboxId: string | null } {
		assertUtcIsoTimestamp(input.now, "now");
		for (const [field, value] of [
			["maxAttempts", input.maxAttempts],
			["backoffBaseMs", input.backoffBaseMs],
			["backoffCapMs", input.backoffCapMs],
		] as const) {
			if (!Number.isSafeInteger(value) || value <= 0) {
				throw new Error(`${field} must be a positive safe integer`);
			}
		}
		const fail = this.db.transaction(() => {
			if (!this.isCurrentOwner(input.ownerEpoch, input.now)) {
				return { attempts: 0, deadLettered: false, outboxId: null };
			}
			const row = this.db
				.prepare(
					`SELECT id, to_lead, type, attempts FROM lead_inbox
					 WHERE id = ? AND carrier = 'inbox' AND msg_class = 'protocol' AND consumed_at IS NULL
					   AND claimed_by = ?`,
				)
				.get(id, input.ownerEpoch) as
				| { id: string; to_lead: string; type: string; attempts: number }
				| undefined;
			if (!row) {
				return { attempts: 0, deadLettered: false, outboxId: null };
			}
			const attempts = row.attempts + 1;
			const deadLettered = attempts >= input.maxAttempts;
			const retryDelay = Math.min(
				input.backoffCapMs,
				input.backoffBaseMs * 2 ** Math.max(0, attempts - 1),
			);
			const nextRetryAt = deadLettered
				? null
				: new Date(Date.parse(input.now) + retryDelay).toISOString();
			this.db
				.prepare(
					`UPDATE lead_inbox SET attempts = ?, last_error = ?, next_retry_at = ?,
					   consumed_at = CASE WHEN ? THEN ? ELSE consumed_at END,
					   disposition = CASE WHEN ? THEN 'dead_letter' ELSE disposition END,
					   claimed_by = NULL, claim_expires_at = NULL
					 WHERE id = ? AND carrier = 'inbox' AND msg_class = 'protocol' AND consumed_at IS NULL
					   AND claimed_by = ?`,
				)
				.run(
					attempts,
					input.error,
					nextRetryAt,
					deadLettered ? 1 : 0,
					input.now,
					deadLettered ? 1 : 0,
					id,
					input.ownerEpoch,
				);
			if (!deadLettered) {
				return { attempts, deadLettered, outboxId: null };
			}
			const outboxId = `dead_letter:protocol:${id}`;
			const payload = JSON.stringify({
				messageId: id,
				toLead: row.to_lead,
				type: row.type,
				attempts,
				error: input.error,
			});
			this.db
				.prepare(
					`INSERT OR IGNORE INTO receipt_alert_outbox
					 (id, kind, payload, created_at)
					 VALUES (?, 'dead_letter', ?, ?)`,
				)
				.run(outboxId, payload, input.now);
			return { attempts, deadLettered, outboxId };
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
				      WHERE to_lead = excluded.lead_id AND carrier = 'inbox' AND consumed_at IS NULL
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
					  WHERE to_lead = ? AND carrier = 'inbox' AND consumed_at IS NULL
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
		respectRetryAt?: boolean;
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
			const retryPredicate = input.respectRetryAt
				? "AND (next_retry_at IS NULL OR next_retry_at <= ?)"
				: "";
			const rows = this.db
				.prepare(
					`SELECT * FROM lead_inbox
				 WHERE to_lead = ? AND carrier = 'inbox' AND msg_class = ? AND consumed_at IS NULL
					   ${retryPredicate}
					   AND (claimed_by IS NULL OR claimed_by = ? OR claim_expires_at < ?)
					 ORDER BY priority, seq LIMIT ?`,
				)
				.all(
					input.toLead,
					input.msgClass,
					...(input.respectRetryAt ? [input.now] : []),
					input.ownerEpoch,
					input.now,
					input.limit,
				) as LeadInboxRow[];
			const update = this.db.prepare(
				`UPDATE lead_inbox SET claimed_by = ?, claim_expires_at = ?
				 WHERE id = ? AND carrier = 'inbox' AND consumed_at IS NULL
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

	/**
	 * Evidence closes the whole retry family in the same surrounding
	 * transaction: the owner leaves patrol, every reminder is superseded, and a
	 * not-yet-delivered escalation is canceled before it can page anyone.
	 */
	private closeReceiptFamily(id: string, now: string): void {
		const familyIds = this.db
			.prepare(
				`SELECT id FROM lead_inbox
				 WHERE id = ? OR family_root_id = ?
				    OR id = (SELECT family_root_id FROM lead_inbox WHERE id = ?)`,
			)
			.all(id, id, id) as Array<{ id: string }>;
		const ownerIds = [...new Set(familyIds.map((row) => row.id))];
		if (ownerIds.length === 0) return;
		const placeholders = ownerIds.map(() => "?").join(",");
		this.db
			.prepare(
				`UPDATE lead_inbox SET next_unprocessed_at = NULL
				 WHERE id IN (${placeholders})`,
			)
			.run(...ownerIds);
		this.db
			.prepare(
				`UPDATE lead_inbox SET
				   consumed_at = COALESCE(consumed_at, ?),
				   disposition = 'superseded_by_evidence',
				   next_unprocessed_at = NULL,
				   claimed_by = NULL,
				   claim_expires_at = NULL
				 WHERE resend_of IN (${placeholders})
				   AND COALESCE(disposition, '') != 'superseded_by_evidence'`,
			)
			.run(now, ...ownerIds);
		this.db
			.prepare(
				`UPDATE receipt_alert_outbox SET
				   canceled_at = ?, cancel_reason = 'source_no_longer_unprocessed'
				 WHERE (${ownerIds
						.map(
							() =>
								"(id = 'unprocessed:' || ? OR id LIKE 'unprocessed:' || ? || '@%')",
						)
						.join(" OR ")})
				   AND delivered_at IS NULL AND canceled_at IS NULL`,
			)
			.run(now, ...ownerIds.flatMap((ownerId) => [ownerId, ownerId]));
	}

	close(): void {
		if (this.ownsConnection) this.db.close();
	}
}
