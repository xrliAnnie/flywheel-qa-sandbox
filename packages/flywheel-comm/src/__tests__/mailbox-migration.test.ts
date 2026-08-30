import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	backupCommDb,
	classifyMailboxDatabase,
	inspectMailboxSwapIntent,
	type MailboxRestorePhase,
	type MailboxSwapPhase,
	migrateCommDbWithSwap,
	migrateLegacyDatabaseFile,
	rollbackMailboxMigration,
	verifyMigratedDatabase,
} from "../mailbox-migration.js";
import { MailboxQueue } from "../mailbox-queue.js";
import { MAILBOX_CORE_SCHEMA } from "../mailbox-schema.js";
import { writeContentRef } from "../utils/content-ref.js";

const NOW = "2026-08-05T12:00:00.000Z";

const LEGACY_SCHEMA = `
CREATE TABLE messages (
 id TEXT PRIMARY KEY, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL,
 type TEXT NOT NULL, content TEXT NOT NULL, parent_id TEXT, read_at TEXT,
 created_at TEXT NOT NULL, expires_at TEXT, deadline_at TEXT, relay_state TEXT,
 resolved_via TEXT, logical_event_id TEXT, superseded_at TEXT, superseded_by TEXT,
 sender_lease_key TEXT, sender_generation INTEGER, sender_holder_pid INTEGER,
 sender_holder_start TEXT, writer_pid INTEGER, writer_start TEXT,
 checkpoint TEXT, content_ref TEXT, content_type TEXT, resolved_at TEXT,
 delivered_at TEXT, attachments TEXT, kind TEXT
);
CREATE UNIQUE INDEX idx_unique_response ON messages(parent_id) WHERE type='response';
CREATE TABLE lead_inbox (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 to_lead TEXT NOT NULL, source TEXT NOT NULL, type TEXT NOT NULL,
 msg_class TEXT NOT NULL, priority INTEGER NOT NULL, content TEXT NOT NULL,
 ref_message_id TEXT, legacy_alias TEXT, batch_id TEXT, created_at TEXT NOT NULL,
 deadline_at TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
 claimed_by TEXT, claim_expires_at TEXT, disposition TEXT, delivered_at TEXT,
 consumed_at TEXT, processed_at TEXT, processed_evidence TEXT, read_at TEXT,
 escalated_at TEXT, next_retry_at TEXT, next_unprocessed_at TEXT, resend_of TEXT,
 resend_round INTEGER, candidates_json TEXT, family_root_id TEXT,
 routing_state TEXT, carrier TEXT NOT NULL DEFAULT 'inbox', disposed_at TEXT,
 disposed_evidence TEXT, receipt_exempt_reason TEXT, receipt_episode_id TEXT,
 delivered_rounds INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE receipt_root_lineage (
 receipt_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL,
 question_id TEXT NOT NULL, root_lead_id TEXT NOT NULL
);
`;

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeSwapIntent(
	dbPath: string,
	overrides: Record<string, unknown> = {},
): string {
	const intentPath = `${dbPath}.migration-swap-intent.json`;
	writeFileSync(
		intentPath,
		JSON.stringify({
			v: 1,
			dbPath,
			backupPath: `${dbPath}.pre-fly1572-2026-08-04T12-00-00.000Z`,
			stagingPath: join(dirname(dbPath), ".fly1572-stale", "comm.db"),
			phase: "done",
			originalMode: 0o600,
			createdAt: "2026-08-04T12:00:00.000Z",
			sourceMessages: 0,
			sourceLeadInbox: 0,
			quarantinedSidecars: [],
			...overrides,
		}),
	);
	return intentPath;
}

function insertMessage(
	db: Database.Database,
	input: Partial<Record<string, unknown>> & {
		id: string;
		from_agent: string;
		to_agent: string;
		type: string;
	},
): void {
	db.prepare(
		`INSERT INTO messages
		 (id, from_agent, to_agent, type, content, parent_id, read_at, created_at,
		  expires_at, relay_state, resolved_at, delivered_at, checkpoint, kind,
		  logical_event_id)
		 VALUES (@id, @from_agent, @to_agent, @type, @content, @parent_id, @read_at,
		  @created_at, @expires_at, @relay_state, @resolved_at, @delivered_at,
		  @checkpoint, @kind, @logical_event_id)`,
	).run({
		content: input.id,
		parent_id: null,
		read_at: null,
		created_at: "2026-08-05T10:00:00.000Z",
		expires_at: "2026-08-08T10:00:00.000Z",
		relay_state: "open",
		resolved_at: null,
		delivered_at: null,
		checkpoint: null,
		kind: null,
		logical_event_id: null,
		...input,
	});
}

function insertLead(
	db: Database.Database,
	input: Partial<Record<string, unknown>> & {
		id: string;
		to_lead: string;
		source: string;
	},
): void {
	db.prepare(
		`INSERT INTO lead_inbox
		 (id, to_lead, source, type, msg_class, priority, content, ref_message_id,
		  legacy_alias, batch_id, created_at, attempts, claimed_by, claim_expires_at,
		  disposition, delivered_at, consumed_at, processed_at, processed_evidence,
		  candidates_json, carrier, disposed_at, disposed_evidence)
		 VALUES (@id, @to_lead, @source, @type, @msg_class, @priority, @content,
		  @ref_message_id, @legacy_alias, @batch_id, @created_at, @attempts,
		  @claimed_by, @claim_expires_at, @disposition, @delivered_at, @consumed_at,
		  @processed_at, @processed_evidence, @candidates_json, @carrier,
		  @disposed_at, @disposed_evidence)`,
	).run({
		type: "runner_question",
		msg_class: "model",
		priority: 1,
		content: input.id,
		ref_message_id: null,
		legacy_alias: null,
		batch_id: null,
		created_at: "2026-08-05T10:00:00.000Z",
		attempts: 0,
		claimed_by: null,
		claim_expires_at: null,
		disposition: null,
		delivered_at: null,
		consumed_at: null,
		processed_at: null,
		processed_evidence: null,
		candidates_json: null,
		carrier: "inbox",
		disposed_at: null,
		disposed_evidence: null,
		...input,
	});
}

describe("FLY-1572 legacy mailbox migration", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1572-migration-"));
		dbPath = join(dir, "comm.db");
		const db = new Database(dbPath);
		db.exec(LEGACY_SCHEMA);
		db.close();
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("folds mirrors, preserves the exact true-unread set, and logs consumed history", () => {
		const legacy = new Database(dbPath);
		insertMessage(legacy, {
			id: "question-1",
			from_agent: "exec-1",
			to_agent: "flywheel-eng-lead",
			type: "question",
			content: "Should I merge PR #123?",
			logical_event_id: "4242",
		});
		insertMessage(legacy, {
			id: "instruction-1",
			from_agent: "flywheel-eng-lead",
			to_agent: "exec-1",
			type: "instruction",
		});
		insertLead(legacy, {
			id: "question:flywheel-eng-lead:question-1",
			to_lead: "flywheel-eng-lead",
			source: "question:1",
			content: '{"event_type":"gate_question","question_id":"question-1"}',
			ref_message_id: "question-1",
			legacy_alias: "flywheel-eng-lead-1-exec-1",
		});
		insertLead(legacy, {
			id: "founder_msg:flywheel-eng-lead:123",
			to_lead: "flywheel-eng-lead",
			source: "founder_reply",
			type: "founder_reply",
			priority: 0,
			ref_message_id: "123",
		});
		insertLead(legacy, {
			id: "founder_msg:flywheel-eng-lead:old",
			to_lead: "flywheel-eng-lead",
			source: "founder_reply",
			type: "founder_reply",
			priority: 0,
			ref_message_id: "old",
			created_at: "2026-07-01T00:00:00.000Z",
			delivered_at: "2026-07-01T00:01:00.000Z",
			consumed_at: "2026-07-01T00:02:00.000Z",
		});
		legacy.close();

		expect(migrateLegacyDatabaseFile(dbPath, { now: NOW })).toMatchObject({
			status: "migrated",
			sourceMessages: 2,
			sourceLeadInbox: 3,
			sourceTrueUnread: 2,
		});
		const migrated = new Database(dbPath);
		try {
			expect(
				migrated
					.prepare(
						"SELECT id, delivery_id, state FROM mailbox WHERE state='QUEUED' ORDER BY delivery_id",
					)
					.all(),
			).toEqual([
				{
					id: "founder_msg:flywheel-eng-lead:123",
					delivery_id: "founder_msg:flywheel-eng-lead:123",
					state: "QUEUED",
				},
				{
					id: "instruction-1",
					delivery_id: "instruction-1",
					state: "QUEUED",
				},
				{
					id: "question-1",
					delivery_id: "question:flywheel-eng-lead:question-1",
					state: "QUEUED",
				},
			]);
			expect(
				migrated
					.prepare("SELECT id, relay_state FROM mailbox ORDER BY id")
					.all(),
			).toEqual([
				{
					id: "founder_msg:flywheel-eng-lead:123",
					relay_state: "terminal_disposed",
				},
				{ id: "instruction-1", relay_state: "terminal_disposed" },
				{ id: "question-1", relay_state: "open" },
			]);
			expect(
				migrated
					.prepare(
						`SELECT name FROM sqlite_master
						 WHERE name IN (
						  'receipt_root_lineage', 'receipt_handle_requests',
						  'mailbox_log_settlement_slot',
						  'mailbox_non_question_relay_insert_guard',
						  'mailbox_non_question_relay_update_guard'
						 ) ORDER BY name`,
					)
					.pluck()
					.all(),
			).toEqual([
				"mailbox_non_question_relay_insert_guard",
				"mailbox_non_question_relay_update_guard",
			]);
			expect(
				migrated
					.prepare(
						"SELECT content, delivery_content, source_kind, source_ref FROM mailbox WHERE id='question-1'",
					)
					.get(),
			).toEqual({
				content: "Should I merge PR #123?",
				delivery_content:
					'{"event_type":"gate_question","question_id":"question-1"}',
				source_kind: "question",
				source_ref: "4242",
			});
			expect(
				migrated
					.prepare(
						"SELECT event FROM mailbox_log WHERE event_id='migrated:lead_inbox:founder_msg:flywheel-eng-lead:old'",
					)
					.get(),
			).toEqual({ event: "migrated_history" });
			expect(
				migrated
					.prepare(
						"SELECT schema_generation, source_true_unread_count FROM mailbox_migration_meta WHERE singleton=1",
					)
					.get(),
			).toEqual({
				schema_generation: "mailbox_v1",
				source_true_unread_count: 2,
			});
			expect(() => migrated.prepare("SELECT * FROM messages").all()).toThrow(
				/poison_messages/,
			);
		} finally {
			migrated.close();
		}
		expect(migrateLegacyDatabaseFile(dbPath, { now: NOW })).toMatchObject({
			status: "already_migrated",
		});
	});

	it("removes receipt-only schema residue from an already-migrated database", () => {
		const legacy = new Database(dbPath);
		insertMessage(legacy, {
			id: "instruction-1",
			from_agent: "flywheel-eng-lead",
			to_agent: "exec-1",
			type: "instruction",
		});
		legacy.close();
		migrateLegacyDatabaseFile(dbPath, { now: NOW });

		const stale = new Database(dbPath);
		stale.exec(`
			DROP TRIGGER IF EXISTS mailbox_non_question_relay_insert_guard;
			DROP TRIGGER IF EXISTS mailbox_non_question_relay_update_guard;
			DROP TRIGGER IF EXISTS mailbox_receipt_root_lineage_insert;
			DROP TRIGGER IF EXISTS receipt_root_lineage_no_update;
			DROP TRIGGER IF EXISTS receipt_root_lineage_no_delete;
			DROP TABLE IF EXISTS receipt_root_lineage;
			DROP TABLE IF EXISTS receipt_handle_requests;
			DROP INDEX IF EXISTS mailbox_log_settlement_slot;
			CREATE TABLE receipt_root_lineage (receipt_id TEXT PRIMARY KEY);
			CREATE TABLE receipt_handle_requests (request_id TEXT PRIMARY KEY);
			CREATE TABLE receipt_activation_episodes (id TEXT PRIMARY KEY);
			CREATE TABLE receipt_resend_deliveries (id TEXT PRIMARY KEY);
			CREATE TABLE receipt_exemption_audit (id TEXT PRIMARY KEY);
			CREATE UNIQUE INDEX mailbox_log_settlement_slot
			  ON mailbox_log(message_id, event)
			  WHERE event IN ('processed', 'disposed');
		`);
		stale.close();

		expect(migrateLegacyDatabaseFile(dbPath, { now: NOW })).toMatchObject({
			status: "already_migrated",
		});
		const migrated = new Database(dbPath);
		try {
			expect(
				migrated
					.prepare(
						`SELECT name FROM sqlite_master
						 WHERE name LIKE 'receipt_%'
						    OR name = 'mailbox_log_settlement_slot'
						 ORDER BY name`,
					)
					.pluck()
					.all(),
			).toEqual(["receipt_alert_outbox"]);
			expect(
				migrated
					.prepare(
						"SELECT name FROM sqlite_master WHERE name LIKE 'mailbox_non_question_relay_%' ORDER BY name",
					)
					.pluck()
					.all(),
			).toEqual([
				"mailbox_non_question_relay_insert_guard",
				"mailbox_non_question_relay_update_guard",
			]);
		} finally {
			migrated.close();
		}
	});

	it("rolls the whole cutover transaction back at every injected stage", () => {
		const legacy = new Database(dbPath);
		insertMessage(legacy, {
			id: "question-1",
			from_agent: "exec-1",
			to_agent: "flywheel-eng-lead",
			type: "question",
		});
		legacy.close();
		expect(() =>
			migrateLegacyDatabaseFile(dbPath, {
				now: NOW,
				faultAt: "after_source_load",
			}),
		).toThrow(/fault injection/);
		const verify = new Database(dbPath);
		try {
			expect(
				verify
					.prepare("SELECT type FROM sqlite_master WHERE name='messages'")
					.get(),
			).toEqual({ type: "table" });
			expect(
				verify
					.prepare("SELECT 1 FROM sqlite_master WHERE name='mailbox'")
					.get(),
			).toBeUndefined();
		} finally {
			verify.close();
		}
	});

	it("synthesizes a true-unread orphan question but rejects dangling ack mirrors", () => {
		const legacy = new Database(dbPath);
		insertLead(legacy, {
			id: "question:flywheel-eng-lead:missing",
			to_lead: "flywheel-eng-lead",
			source: "question:9",
			ref_message_id: "missing-question",
			legacy_alias: "flywheel-eng-lead-9-exec-orphan",
		});
		legacy.close();
		migrateLegacyDatabaseFile(dbPath, { now: NOW });
		const migrated = new Database(dbPath);
		try {
			expect(
				migrated
					.prepare(
						"SELECT id, delivery_id, from_agent, source_kind, state FROM mailbox",
					)
					.get(),
			).toEqual({
				id: "missing-question",
				delivery_id: "question:flywheel-eng-lead:missing",
				from_agent: "exec-orphan",
				source_kind: "question_orphan",
				state: "QUEUED",
			});
		} finally {
			migrated.close();
		}
	});

	it("fails closed when an ack mirror has no source message", () => {
		const legacy = new Database(dbPath);
		insertLead(legacy, {
			id: "ack:flywheel-eng-lead:missing",
			to_lead: "flywheel-eng-lead",
			source: "ack_receipt:9",
			ref_message_id: "missing-ack",
		});
		legacy.close();
		expect(() => migrateLegacyDatabaseFile(dbPath, { now: NOW })).toThrow(
			/dangling ack/i,
		);
	});

	it("trusts only delivered-and-consumed plain-text sender-less xdept rows", () => {
		const legacy = new Database(dbPath);
		insertLead(legacy, {
			id: "xdept:flywheel-eng-lead:terminal-alert",
			to_lead: "flywheel-eng-lead",
			source: "discord_cross_department",
			type: "external_delivery",
			carrier: "external",
			content: "legacy rate-limit alert without sender identity",
			delivered_at: "2026-08-05T10:01:00.000Z",
			consumed_at: "2026-08-05T10:02:00.000Z",
		});
		legacy.close();
		expect(() => migrateLegacyDatabaseFile(dbPath, { now: NOW })).not.toThrow();
		const migrated = new Database(dbPath);
		try {
			expect(
				migrated
					.prepare("SELECT from_agent, state FROM mailbox WHERE id=?")
					.get("xdept:flywheel-eng-lead:terminal-alert"),
			).toEqual({ from_agent: "bridge", state: "ACKED" });
		} finally {
			migrated.close();
		}

		const livePath = join(dir, "live-xdept.db");
		const live = new Database(livePath);
		live.exec(LEGACY_SCHEMA);
		insertLead(live, {
			id: "xdept:flywheel-eng-lead:live",
			to_lead: "flywheel-eng-lead",
			source: "discord_cross_department",
			type: "external_delivery",
			carrier: "external",
			content: "legacy payload without sender identity",
			consumed_at: "2026-08-05T10:00:00.000Z",
		});
		insertLead(live, {
			id: "xdept:flywheel-eng-lead:live-2",
			to_lead: "flywheel-eng-lead",
			source: "discord_cross_department",
			type: "external_delivery",
			carrier: "external",
			content: "another legacy payload without sender identity",
			delivered_at: "2026-08-05T11:00:00.000Z",
		});
		insertLead(live, {
			id: "xdept:flywheel-eng-lead:live-json",
			to_lead: "flywheel-eng-lead",
			source: "discord_cross_department",
			type: "external_delivery",
			carrier: "external",
			content: '{"message":"no sender identity"}',
			delivered_at: "2026-08-05T11:30:00.000Z",
			consumed_at: "2026-08-05T11:31:00.000Z",
		});
		live.close();
		expect(() => migrateLegacyDatabaseFile(livePath, { now: NOW })).toThrow(
			/sender is missing on live rows:.*xdept:flywheel-eng-lead:live.*retention_expires_at=2026-08-08T10:00:00.000Z.*xdept:flywheel-eng-lead:live-2.*retention_expires_at=2026-08-08T11:00:00.000Z.*xdept:flywheel-eng-lead:live-json.*retention_expires_at=2026-08-08T11:31:00.000Z/,
		);
	});

	it("maps settled, disposed, consumed, delivered, and three-null lead rows without ghost unread", () => {
		const legacy = new Database(dbPath);
		insertLead(legacy, {
			id: "processed",
			to_lead: "flywheel-eng-lead",
			source: "founder_reply",
			type: "founder_reply",
			carrier: "external",
			processed_at: "2026-08-05T10:00:00.000Z",
			processed_evidence: '{"kind":"handled"}',
		});
		insertLead(legacy, {
			id: "disposed",
			to_lead: "flywheel-eng-lead",
			source: "founder_reply",
			type: "founder_reply",
			carrier: "external",
			disposed_at: "2026-08-05T10:01:00.000Z",
			disposed_evidence: '{"kind":"no_action"}',
		});
		insertLead(legacy, {
			id: "delivered-external",
			to_lead: "flywheel-eng-lead",
			source: "founder_reply",
			type: "founder_reply",
			carrier: "external",
			delivered_at: "2026-08-05T10:02:00.000Z",
		});
		insertLead(legacy, {
			id: "consumed-history",
			to_lead: "flywheel-eng-lead",
			source: "founder_reply",
			type: "founder_reply",
			created_at: "2026-07-01T00:00:00.000Z",
			consumed_at: "2026-07-01T00:01:00.000Z",
		});
		insertLead(legacy, {
			id: "true-unread",
			to_lead: "flywheel-eng-lead",
			source: "founder_reply",
			type: "founder_reply",
		});
		legacy.close();
		migrateLegacyDatabaseFile(dbPath, { now: NOW });
		const migrated = new Database(dbPath);
		try {
			expect(
				migrated.prepare("SELECT id, state FROM mailbox ORDER BY id").all(),
			).toEqual([
				{ id: "delivered-external", state: "ACKED" },
				{ id: "disposed", state: "DEAD" },
				{ id: "processed", state: "ACKED" },
				{ id: "true-unread", state: "QUEUED" },
			]);
			expect(
				migrated
					.prepare(
						"SELECT event FROM mailbox_log WHERE subject_id IN ('processed','disposed') ORDER BY subject_id",
					)
					.all(),
			).toEqual([{ event: "disposed" }, { event: "processed" }]);
			expect(
				migrated
					.prepare(
						"SELECT event FROM mailbox_log WHERE event_id='migrated:lead_inbox:consumed-history'",
					)
					.get(),
			).toEqual({ event: "migrated_history" });
			expect(
				migrated
					.prepare(
						"SELECT event FROM mailbox_log WHERE message_id='consumed-history' AND event='archived'",
					)
					.get(),
			).toEqual({ event: "archived" });
			const queue = new MailboxQueue(migrated, { readOnly: true });
			expect(queue.inspectDeliveryState("consumed-history")).toMatchObject({
				kind: "archived_terminal",
				state: "ACKED",
			});
		} finally {
			migrated.close();
		}
	});

	it("rejects an extra queued lead-inbox projection, not only missing unread rows", () => {
		const legacy = new Database(dbPath);
		insertMessage(legacy, {
			id: "question-anchor",
			from_agent: "exec-1",
			to_agent: "flywheel-eng-lead",
			type: "question",
		});
		insertLead(legacy, {
			id: "question:flywheel-eng-lead:question-anchor",
			to_lead: "flywheel-eng-lead",
			source: "question:1",
			ref_message_id: "question-anchor",
			legacy_alias: "flywheel-eng-lead-1-exec-1",
		});
		insertLead(legacy, {
			id: "consumed-not-unread",
			to_lead: "flywheel-eng-lead",
			source: "founder_reply",
			type: "founder_reply",
			consumed_at: "2026-08-05T10:30:00.000Z",
		});
		legacy.exec(MAILBOX_CORE_SCHEMA);
		legacy.exec(`
			CREATE TRIGGER qa_inject_extra_queued_projection
			AFTER INSERT ON mailbox_log
			WHEN NEW.event = 'migration_snapshot'
			  AND NEW.message_id = 'consumed-not-unread'
			BEGIN
			  UPDATE mailbox
			     SET state = 'QUEUED', acked_at = NULL
			   WHERE id = 'consumed-not-unread';
			END;
		`);
		legacy.close();

		expect(() => migrateLegacyDatabaseFile(dbPath, { now: NOW })).toThrow(
			/true-unread migration mismatch.*consumed-not-unread/,
		);
	});

	it("classifies retired resend copies as history and quarantine alerts as bridge messages", () => {
		const legacy = new Database(dbPath);
		insertLead(legacy, {
			id: "resend-copy",
			to_lead: "flywheel-eng-lead",
			source: "receipt_resend:lead_event:flywheel-eng-lead:original",
			type: "stage_changed",
			consumed_at: "2026-08-05T11:00:00.000Z",
			resend_of: "lead_event:flywheel-eng-lead:original",
			resend_round: 1,
		});
		insertLead(legacy, {
			id: "model-alert",
			to_lead: "flywheel-eng-lead",
			source: "model_quarantine:batch-1",
			type: "model_batch_quarantined",
			consumed_at: "2026-08-05T11:00:00.000Z",
		});
		legacy.close();

		migrateLegacyDatabaseFile(dbPath, { now: NOW });
		const migrated = new Database(dbPath);
		try {
			expect(
				migrated.prepare("SELECT 1 FROM mailbox WHERE id='resend-copy'").get(),
			).toBeUndefined();
			expect(
				migrated
					.prepare(
						"SELECT event FROM mailbox_log WHERE event_id='migrated:lead_inbox:resend-copy'",
					)
					.get(),
			).toEqual({ event: "migrated_history" });
			expect(
				migrated
					.prepare(
						"SELECT from_agent, source_kind, source_ref, state FROM mailbox WHERE id='model-alert'",
					)
					.get(),
			).toEqual({
				from_agent: "bridge",
				source_kind: "model_quarantine",
				source_ref: "batch-1",
				state: "ACKED",
			});
		} finally {
			migrated.close();
		}
	});

	it("fails closed instead of reviving a nonterminal legacy resend copy", () => {
		const legacy = new Database(dbPath);
		insertLead(legacy, {
			id: "live-resend-copy",
			to_lead: "flywheel-eng-lead",
			source: "receipt_resend:lead_event:flywheel-eng-lead:original",
			type: "stage_changed",
		});
		legacy.close();

		expect(() => migrateLegacyDatabaseFile(dbPath, { now: NOW })).toThrow(
			/live receipt_resend copy requires manual disposition/,
		);
	});

	it("keeps a terminal receipt resend question when the resolved family is not archivable", () => {
		const legacy = new Database(dbPath);
		insertLead(legacy, {
			id: "resend-question",
			to_lead: "flywheel-eng-lead",
			source: "receipt_resend:lead_event:flywheel-eng-lead:original",
			type: "question",
			created_at: "2026-07-01T00:00:00.000Z",
			consumed_at: "2026-07-01T00:01:00.000Z",
		});
		legacy.close();

		migrateLegacyDatabaseFile(dbPath, { now: NOW });
		const migrated = new Database(dbPath);
		try {
			expect(
				migrated
					.prepare(
						`SELECT mailbox.state, mailbox_identity.archived_at
						   FROM mailbox
						   JOIN mailbox_identity USING (id)
						  WHERE mailbox.id='resend-question'`,
					)
					.get(),
			).toEqual({ state: "ACKED", archived_at: null });
			expect(
				migrated
					.prepare(
						"SELECT event FROM mailbox_log WHERE message_id='resend-question' ORDER BY log_seq",
					)
					.all(),
			).toEqual([{ event: "migration_snapshot" }]);
		} finally {
			migrated.close();
		}
	});

	it("keeps a standalone terminal response when the database resolves a wider live family", () => {
		const legacy = new Database(dbPath);
		insertMessage(legacy, {
			id: "live-question",
			from_agent: "exec-1",
			to_agent: "flywheel-eng-lead",
			type: "question",
		});
		insertLead(legacy, {
			id: "standalone-response",
			to_lead: "flywheel-eng-lead",
			source: "founder_reply",
			type: "response",
			ref_message_id: "live-question",
			created_at: "2026-07-01T00:00:00.000Z",
			consumed_at: "2026-07-01T00:01:00.000Z",
		});
		legacy.close();

		migrateLegacyDatabaseFile(dbPath, { now: NOW });
		const migrated = new Database(dbPath);
		try {
			expect(
				migrated
					.prepare(
						"SELECT id, state FROM mailbox WHERE id IN ('live-question','standalone-response') ORDER BY id",
					)
					.all(),
			).toEqual([
				{ id: "live-question", state: "QUEUED" },
				{ id: "standalone-response", state: "ACKED" },
			]);
			expect(
				migrated
					.prepare(
						"SELECT archived_at FROM mailbox_identity WHERE id='standalone-response'",
					)
					.get(),
			).toEqual({ archived_at: null });
		} finally {
			migrated.close();
		}
	});

	it("lists every unknown legacy source family before starting cutover", () => {
		const legacy = new Database(dbPath);
		insertLead(legacy, {
			id: "unknown-a",
			to_lead: "flywheel-eng-lead",
			source: "mystery_alpha",
		});
		insertLead(legacy, {
			id: "unknown-b",
			to_lead: "flywheel-eng-lead",
			source: "mystery_beta:detail",
		});
		legacy.close();

		expect(() => migrateLegacyDatabaseFile(dbPath, { now: NOW })).toThrow(
			/unknown lead_inbox source families:.*mystery_alpha.*mystery_beta:detail/,
		);
		const verify = new Database(dbPath, { readonly: true });
		try {
			expect(
				verify
					.prepare("SELECT 1 FROM sqlite_master WHERE name='mailbox'")
					.get(),
			).toBeUndefined();
		} finally {
			verify.close();
		}
	});

	it("fails closed on the legacy delivered-only inbox gray state", () => {
		const legacy = new Database(dbPath);
		insertLead(legacy, {
			id: "gray",
			to_lead: "flywheel-eng-lead",
			source: "founder_reply",
			type: "founder_reply",
			delivered_at: "2026-08-05T10:00:00.000Z",
		});
		legacy.close();
		expect(() => migrateLegacyDatabaseFile(dbPath, { now: NOW })).toThrow(
			/manual disposition required/,
		);
	});

	it("keeps RPC families intact and preserves expired unanswered questions", () => {
		const legacy = new Database(dbPath);
		insertMessage(legacy, {
			id: "question-live-response",
			from_agent: "exec-1",
			to_agent: "flywheel-eng-lead",
			type: "question",
		});
		insertMessage(legacy, {
			id: "response-live",
			from_agent: "flywheel-eng-lead",
			to_agent: "exec-1",
			type: "response",
			parent_id: "question-live-response",
		});
		insertLead(legacy, {
			id: "question:flywheel-eng-lead:question-live-response",
			to_lead: "flywheel-eng-lead",
			source: "question:1",
			ref_message_id: "question-live-response",
			legacy_alias: "flywheel-eng-lead-1-exec-1",
			consumed_at: "2026-07-01T00:00:00.000Z",
		});
		insertMessage(legacy, {
			id: "question-protected-expired",
			from_agent: "exec-2",
			to_agent: "flywheel-eng-lead",
			type: "question",
			expires_at: "2026-07-01T00:00:00.000Z",
			relay_state: "protected",
		});
		insertMessage(legacy, {
			id: "question-old-terminal",
			from_agent: "exec-3",
			to_agent: "flywheel-eng-lead",
			type: "question",
			created_at: "2026-07-01T00:00:00.000Z",
			resolved_at: "2026-07-01T00:01:00.000Z",
			relay_state: "terminal_disposed",
		});
		insertMessage(legacy, {
			id: "response-old-terminal",
			from_agent: "flywheel-eng-lead",
			to_agent: "exec-3",
			type: "response",
			parent_id: "question-old-terminal",
			created_at: "2026-07-01T00:02:00.000Z",
			delivered_at: "2026-07-01T00:03:00.000Z",
		});
		legacy.close();
		migrateLegacyDatabaseFile(dbPath, { now: NOW });
		const migrated = new Database(dbPath);
		try {
			expect(
				migrated
					.prepare(
						"SELECT id, state FROM mailbox WHERE id IN ('question-live-response','response-live','question-protected-expired') ORDER BY id",
					)
					.all(),
			).toEqual([
				{ id: "question-live-response", state: "ACKED" },
				{ id: "question-protected-expired", state: "QUEUED" },
				{ id: "response-live", state: "QUEUED" },
			]);
			expect(
				migrated
					.prepare(
						"SELECT event_id FROM mailbox_log WHERE event_id IN ('migrated:messages:question-old-terminal','migrated:messages:response-old-terminal') ORDER BY event_id",
					)
					.all(),
			).toEqual([
				{ event_id: "migrated:messages:question-old-terminal" },
				{ event_id: "migrated:messages:response-old-terminal" },
			]);
			expect(
				migrated
					.prepare(
						"SELECT COUNT(*) AS count FROM mailbox WHERE id IN ('question-old-terminal','response-old-terminal')",
					)
					.get(),
			).toEqual({ count: 0 });
			expect(
				migrated
					.prepare(
						"SELECT message_id FROM mailbox_log WHERE event='archived' AND message_id IN ('question-old-terminal','response-old-terminal') ORDER BY message_id",
					)
					.all(),
			).toEqual([
				{ message_id: "question-old-terminal" },
				{ message_id: "response-old-terminal" },
			]);
		} finally {
			migrated.close();
		}
	});

	it("backs up, atomically swaps, and rolls back the database and refs", async () => {
		const legacy = new Database(dbPath);
		insertMessage(legacy, {
			id: "question-1",
			from_agent: "exec-1",
			to_agent: "flywheel-eng-lead",
			type: "question",
		});
		insertLead(legacy, {
			id: "question:flywheel-eng-lead:question-1",
			to_lead: "flywheel-eng-lead",
			source: "question:1",
			ref_message_id: "question-1",
			legacy_alias: "flywheel-eng-lead-1-exec-1",
		});
		legacy.close();
		const result = await migrateCommDbWithSwap(dbPath, { now: NOW });
		expect(result).toMatchObject({ status: "migrated", sourceMessages: 1 });
		expect(existsSync(result.backupPath)).toBe(true);
		expect(existsSync(`${result.backupPath}.refs-manifest.json`)).toBe(true);
		expect((await migrateCommDbWithSwap(dbPath, { now: NOW })).intentPath).toBe(
			result.intentPath,
		);
		mkdirSync(join(dir, "refs"), { recursive: true });
		writeFileSync(join(dir, "refs", "post-backup.txt"), "extra ref");
		writeFileSync(`${dbPath}-wal`, "");
		writeFileSync(`${dbPath}-shm`, "");

		expect(rollbackMailboxMigration(dbPath)).toMatchObject({
			sourceMessages: 1,
			sourceLeadInbox: 1,
		});
		const restored = new Database(dbPath, { readonly: true });
		try {
			expect(restored.prepare("SELECT id FROM messages").all()).toEqual([
				{ id: "question-1" },
			]);
			expect(restored.prepare("SELECT id FROM lead_inbox").all()).toEqual([
				{ id: "question:flywheel-eng-lead:question-1" },
			]);
		} finally {
			restored.close();
		}
		expect(existsSync(`${dbPath}.restore-intent.json`)).toBe(false);
		expect(
			readdirSync(dir).filter((name) =>
				name.includes(".fly1572-rollback-quarantine-"),
			),
		).toEqual([]);
		expect(() => rollbackMailboxMigration(dbPath)).not.toThrow();
	});

	it("archives a stale completed intent and remigrates the current legacy canonical", async () => {
		const oldBackupPath = `${dbPath}.pre-fly1572-2026-08-04T12-00-00.000Z`;
		await backupCommDb(dbPath, oldBackupPath);
		const oldBackupBytes = readFileSync(oldBackupPath);
		const intentPath = `${dbPath}.migration-swap-intent.json`;
		writeFileSync(
			intentPath,
			JSON.stringify({
				v: 1,
				dbPath,
				backupPath: oldBackupPath,
				stagingPath: join(dir, ".fly1572-stale", "comm.db"),
				phase: "done",
				originalMode: 0o600,
				createdAt: "2026-08-04T12:00:00.000Z",
				sourceMessages: 0,
				sourceLeadInbox: 0,
				quarantinedSidecars: [],
			}),
		);
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

		const result = await migrateCommDbWithSwap(dbPath, { now: NOW });

		expect(result).toMatchObject({ status: "migrated" });
		expect(result.backupPath).not.toBe(oldBackupPath);
		expect(readFileSync(oldBackupPath)).toEqual(oldBackupBytes);
		const archived = readdirSync(dir).filter((name) =>
			name.startsWith("comm.db.migration-swap-intent.json.stale-"),
		);
		expect(archived).toHaveLength(1);
		expect(JSON.parse(readFileSync(intentPath, "utf8"))).toMatchObject({
			v: 2,
			phase: "done",
			sourceBinding: {
				mainSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
			},
		});
		expect(errorLog).toHaveBeenCalledWith(
			expect.stringContaining('"reason":"stale_post_swap_intent"'),
		);
		errorLog.mockRestore();
	});

	it.each(["staging", "quarantine"] as const)(
		"refuses a stale completed intent when its %s artifact still exists",
		async (artifact) => {
			const stagingPath = join(dir, ".fly1572-stale", "comm.db");
			const quarantinePath = `${dbPath}-wal.fly1572-quarantine`;
			if (artifact === "staging") {
				mkdirSync(dirname(stagingPath), { recursive: true });
				writeFileSync(stagingPath, "stale staging evidence");
			} else {
				writeFileSync(quarantinePath, "stale WAL evidence");
			}
			writeSwapIntent(dbPath, {
				stagingPath,
				quarantinedSidecars: artifact === "quarantine" ? [quarantinePath] : [],
			});
			const before = sha256(dbPath);

			await expect(migrateCommDbWithSwap(dbPath, { now: NOW })).rejects.toThrow(
				/stale mailbox swap intent.*artifact/i,
			);

			expect(sha256(dbPath)).toBe(before);
			expect(
				existsSync(artifact === "staging" ? stagingPath : quarantinePath),
			).toBe(true);
		},
	);

	it("binds a swap intent to its canonical database path", async () => {
		const otherPath = join(dir, "other", "comm.db");
		writeSwapIntent(dbPath, {
			dbPath: otherPath,
			backupPath: `${otherPath}.pre-fly1572-old`,
			stagingPath: join(dirname(otherPath), ".fly1572-old", "comm.db"),
		});
		const before = sha256(dbPath);

		await expect(migrateCommDbWithSwap(dbPath, { now: NOW })).rejects.toThrow(
			/intent belongs to a different database/i,
		);
		expect(sha256(dbPath)).toBe(before);
	});

	it("rejects a fenced resume when bytes changed through an already-open writer", async () => {
		const sourceHash = sha256(dbPath);
		const writer = new Database(dbPath);
		writeSwapIntent(dbPath, {
			v: 2,
			phase: "fenced",
			sourceBinding: { mainSha256: sourceHash, walSha256: null },
		});
		chmodSync(dbPath, 0o444);
		insertMessage(writer, {
			id: "written-after-fence",
			from_agent: "exec-new",
			to_agent: "flywheel-eng-lead",
			type: "question",
		});
		writer.close();
		const changedHash = sha256(dbPath);
		expect(changedHash).not.toBe(sourceHash);

		await expect(migrateCommDbWithSwap(dbPath, { now: NOW })).rejects.toThrow(
			/diverged from the fenced source\/artifacts/i,
		);

		expect(sha256(dbPath)).toBe(changedHash);
		const verify = new Database(dbPath, { readonly: true });
		try {
			expect(verify.prepare("SELECT id FROM messages").pluck().all()).toContain(
				"written-after-fence",
			);
		} finally {
			verify.close();
		}
	});

	it("refuses to adopt an unbound backup published before the phase ledger advanced", async () => {
		const backupPath = `${dbPath}.pre-fly1572-unbound`;
		await backupCommDb(dbPath, backupPath);
		writeSwapIntent(dbPath, {
			v: 2,
			backupPath,
			phase: "fenced",
			sourceBinding: { mainSha256: sha256(dbPath), walSha256: null },
		});
		chmodSync(dbPath, 0o444);
		const before = sha256(dbPath);

		await expect(migrateCommDbWithSwap(dbPath, { now: NOW })).rejects.toThrow(
			/unbound backup/i,
		);

		expect(sha256(dbPath)).toBe(before);
		expect(existsSync(backupPath)).toBe(true);
	});

	it("rejects a structurally valid backup whose bytes do not match the intent binding", async () => {
		const backupPath = `${dbPath}.pre-fly1572-bound`;
		await backupCommDb(dbPath, backupPath);
		const backupSha256 = sha256(backupPath);
		const refsManifestSha256 = sha256(`${backupPath}.refs-manifest.json`);
		const foreignPath = join(dir, "foreign-backup.db");
		const foreign = new Database(foreignPath);
		foreign.exec(LEGACY_SCHEMA);
		insertMessage(foreign, {
			id: "foreign-row",
			from_agent: "foreign-exec",
			to_agent: "flywheel-eng-lead",
			type: "question",
		});
		foreign.close();
		copyFileSync(foreignPath, backupPath);
		writeSwapIntent(dbPath, {
			v: 2,
			backupPath,
			phase: "backed_up",
			sourceBinding: { mainSha256: sha256(dbPath), walSha256: null },
			backupSha256,
			refsManifestSha256,
		});
		chmodSync(dbPath, 0o444);
		const before = sha256(dbPath);

		await expect(migrateCommDbWithSwap(dbPath, { now: NOW })).rejects.toThrow(
			/diverged from the fenced source\/artifacts/i,
		);
		expect(sha256(dbPath)).toBe(before);
	});

	it("rejects a structurally valid staging database whose bytes do not match the intent binding", async () => {
		const backupPath = `${dbPath}.pre-fly1572-staging-bound`;
		await backupCommDb(dbPath, backupPath);
		const stagingPath = join(dir, ".fly1572-staging-bound", "comm.db");
		mkdirSync(dirname(stagingPath), { recursive: true });
		copyFileSync(backupPath, stagingPath);
		migrateLegacyDatabaseFile(stagingPath, { now: NOW });
		const stagingSha256 = sha256(stagingPath);
		const foreignPath = join(dir, "foreign-staging.db");
		copyFileSync(backupPath, foreignPath);
		const foreign = new Database(foreignPath);
		insertMessage(foreign, {
			id: "foreign-staging-row",
			from_agent: "foreign-exec",
			to_agent: "flywheel-eng-lead",
			type: "question",
		});
		foreign.close();
		migrateLegacyDatabaseFile(foreignPath, { now: NOW });
		copyFileSync(foreignPath, stagingPath);
		writeSwapIntent(dbPath, {
			v: 2,
			backupPath,
			stagingPath,
			phase: "staging_verified",
			sourceBinding: { mainSha256: sha256(dbPath), walSha256: null },
			backupSha256: sha256(backupPath),
			refsManifestSha256: sha256(`${backupPath}.refs-manifest.json`),
			stagingSha256,
		});
		chmodSync(dbPath, 0o444);
		const before = sha256(dbPath);

		await expect(migrateCommDbWithSwap(dbPath, { now: NOW })).rejects.toThrow(
			/diverged from the fenced source\/artifacts/i,
		);
		expect(sha256(dbPath)).toBe(before);
	});

	it("reports a missing migration marker with the database path", () => {
		expect(() => verifyMigratedDatabase(dbPath)).toThrow(
			`mailbox migration marker missing: ${dbPath}`,
		);
	});

	it("classifies legacy, migrated, mixed, and unknown schemas through the shared library helper", () => {
		expect(classifyMailboxDatabase(dbPath)).toBe("legacy");
		const unknownPath = join(dir, "unknown.db");
		new Database(unknownPath).close();
		expect(classifyMailboxDatabase(unknownPath)).toBe("unknown");
		const migratedPath = join(dir, "migrated.db");
		copyFileSync(dbPath, migratedPath);
		migrateLegacyDatabaseFile(migratedPath, { now: NOW });
		expect(classifyMailboxDatabase(migratedPath)).toBe("migrated");
		const mixed = new Database(migratedPath);
		mixed.exec("DROP VIEW messages; CREATE TABLE messages (id TEXT);");
		mixed.close();
		expect(classifyMailboxDatabase(migratedPath)).toBe("mixed");
	});

	it.each([
		["malformed JSON", "{"],
		[
			"unknown phase",
			JSON.stringify({
				v: 1,
				dbPath: "/tmp/comm.db",
				backupPath: "/tmp/comm.db.pre-fly1572-old",
				stagingPath: "/tmp/.fly1572-old/comm.db",
				phase: "invented",
				originalMode: 0o600,
				createdAt: NOW,
				sourceMessages: 0,
				sourceLeadInbox: 0,
				quarantinedSidecars: [],
			}),
		],
		[
			"relative artifact path",
			JSON.stringify({
				v: 1,
				dbPath: "/tmp/comm.db",
				backupPath: "relative.db",
				stagingPath: "/tmp/.fly1572-old/comm.db",
				phase: "done",
				originalMode: 0o600,
				createdAt: NOW,
				sourceMessages: 0,
				sourceLeadInbox: 0,
				quarantinedSidecars: [],
			}),
		],
		[
			"v2 missing binding",
			JSON.stringify({
				v: 2,
				dbPath: "/tmp/comm.db",
				backupPath: "/tmp/comm.db.pre-fly1572-old",
				stagingPath: "/tmp/.fly1572-old/comm.db",
				phase: "fenced",
				originalMode: 0o600,
				createdAt: NOW,
				sourceMessages: 0,
				sourceLeadInbox: 0,
				quarantinedSidecars: [],
			}),
		],
		[
			"unsupported version",
			JSON.stringify({
				v: 3,
				dbPath: "/tmp/comm.db",
				backupPath: "/tmp/comm.db.pre-fly1572-old",
				stagingPath: "/tmp/.fly1572-old/comm.db",
				phase: "done",
				originalMode: 0o600,
				createdAt: NOW,
				sourceMessages: 0,
				sourceLeadInbox: 0,
				quarantinedSidecars: [],
			}),
		],
		[
			"backup outside canonical directory",
			JSON.stringify({
				v: 1,
				dbPath: "/tmp/comm.db",
				backupPath: "/var/tmp/comm.db.pre-fly1572-old",
				stagingPath: "/tmp/.fly1572-old/comm.db",
				phase: "done",
				originalMode: 0o600,
				createdAt: NOW,
				sourceMessages: 0,
				sourceLeadInbox: 0,
				quarantinedSidecars: [],
			}),
		],
		[
			"staging outside canonical directory",
			JSON.stringify({
				v: 1,
				dbPath: "/tmp/comm.db",
				backupPath: "/tmp/comm.db.pre-fly1572-old",
				stagingPath: "/var/tmp/.fly1572-old/comm.db",
				phase: "done",
				originalMode: 0o600,
				createdAt: NOW,
				sourceMessages: 0,
				sourceLeadInbox: 0,
				quarantinedSidecars: [],
			}),
		],
		[
			"quarantine outside canonical layout",
			JSON.stringify({
				v: 1,
				dbPath: "/tmp/comm.db",
				backupPath: "/tmp/comm.db.pre-fly1572-old",
				stagingPath: "/tmp/.fly1572-old/comm.db",
				phase: "done",
				originalMode: 0o600,
				createdAt: NOW,
				sourceMessages: 0,
				sourceLeadInbox: 0,
				quarantinedSidecars: ["/tmp/other-wal.fly1572-quarantine"],
			}),
		],
		[
			"v2 backed-up missing artifact bindings",
			JSON.stringify({
				v: 2,
				dbPath: "/tmp/comm.db",
				backupPath: "/tmp/comm.db.pre-fly1572-old",
				stagingPath: "/tmp/.fly1572-old/comm.db",
				phase: "backed_up",
				originalMode: 0o600,
				createdAt: NOW,
				sourceMessages: 0,
				sourceLeadInbox: 0,
				quarantinedSidecars: [],
				sourceBinding: {
					mainSha256: "a".repeat(64),
					walSha256: null,
				},
			}),
		],
		[
			"v2 staging missing staging binding",
			JSON.stringify({
				v: 2,
				dbPath: "/tmp/comm.db",
				backupPath: "/tmp/comm.db.pre-fly1572-old",
				stagingPath: "/tmp/.fly1572-old/comm.db",
				phase: "staging_verified",
				originalMode: 0o600,
				createdAt: NOW,
				sourceMessages: 0,
				sourceLeadInbox: 0,
				quarantinedSidecars: [],
				sourceBinding: {
					mainSha256: "a".repeat(64),
					walSha256: null,
				},
				backupSha256: "b".repeat(64),
				refsManifestSha256: "c".repeat(64),
			}),
		],
	] as const)("normalizes invalid intent errors for %s", (_name, contents) => {
		const intentPath = `${dbPath}.migration-swap-intent.json`;
		writeFileSync(intentPath, contents);
		expect(() => inspectMailboxSwapIntent(intentPath)).toThrow(
			`invalid mailbox swap intent: ${intentPath}:`,
		);
	});

	it("keeps a migrated canonical idempotent when its completed v1 intent remains", async () => {
		migrateLegacyDatabaseFile(dbPath, { now: NOW });
		writeSwapIntent(dbPath);
		const before = sha256(dbPath);

		await expect(
			migrateCommDbWithSwap(dbPath, { now: NOW }),
		).resolves.toMatchObject({ status: "migrated" });
		expect(sha256(dbPath)).toBe(before);
		expect(
			JSON.parse(readFileSync(`${dbPath}.migration-swap-intent.json`, "utf8")),
		).toMatchObject({ v: 1, phase: "done" });
	});

	it("refuses rollback when a completed intent points at a newly active legacy canonical", async () => {
		const backupPath = `${dbPath}.pre-fly1572-stale-rollback`;
		await backupCommDb(dbPath, backupPath);
		const legacy = new Database(dbPath);
		insertMessage(legacy, {
			id: "new-since-stale-backup",
			from_agent: "exec-new",
			to_agent: "flywheel-eng-lead",
			type: "question",
		});
		legacy.close();
		writeSwapIntent(dbPath, { backupPath, phase: "done" });
		const before = sha256(dbPath);
		const backupBefore = sha256(backupPath);

		expect(() => rollbackMailboxMigration(dbPath)).toThrow(/rollback refused/i);

		expect(sha256(dbPath)).toBe(before);
		expect(sha256(backupPath)).toBe(backupBefore);
		const verify = new Database(dbPath, { readonly: true });
		try {
			expect(verify.prepare("SELECT id FROM messages").pluck().all()).toContain(
				"new-since-stale-backup",
			);
		} finally {
			verify.close();
		}
	});

	it("rejects v1 pre-swap resumes because they cannot bind the fenced source", async () => {
		const backupPath = `${dbPath}.pre-fly1572-v1-pre-swap`;
		await backupCommDb(dbPath, backupPath);
		writeSwapIntent(dbPath, { backupPath, phase: "backed_up" });
		chmodSync(dbPath, 0o444);
		const before = sha256(dbPath);

		await expect(migrateCommDbWithSwap(dbPath, { now: NOW })).rejects.toThrow(
			/v1 pre-swap intent has no source binding/i,
		);
		expect(sha256(dbPath)).toBe(before);
	});

	it.each(["fenced", "backed_up", "sidecars_quarantined"] as const)(
		"rejects an impossible migrated canonical in the pre-swap %s phase",
		async (phase) => {
			const phaseDir = join(dir, `impossible-migrated-${phase}`);
			mkdirSync(phaseDir);
			const path = join(phaseDir, "comm.db");
			const legacy = new Database(path);
			legacy.exec(LEGACY_SCHEMA);
			legacy.close();
			migrateLegacyDatabaseFile(path, { now: NOW });
			const migratedHash = sha256(path);
			const backupPath = `${path}.pre-fly1572-impossible-${phase}`;
			await backupCommDb(path, backupPath);
			writeSwapIntent(path, {
				v: 2,
				backupPath,
				phase,
				sourceBinding: { mainSha256: migratedHash, walSha256: null },
				backupSha256: sha256(backupPath),
				refsManifestSha256: sha256(`${backupPath}.refs-manifest.json`),
			});

			await expect(migrateCommDbWithSwap(path, { now: NOW })).rejects.toThrow(
				new RegExp(
					`pre-swap phase ${phase} cannot own a migrated canonical`,
					"i",
				),
			);
			expect(sha256(path)).toBe(migratedHash);
		},
	);

	it("rejects a rename-landed canonical that does not match the bound staging image", async () => {
		await expect(
			migrateCommDbWithSwap(dbPath, {
				now: NOW,
				faultAfter: "staging_verified",
			}),
		).rejects.toThrow(/fault injection/);
		const foreignPath = join(dir, "foreign-rename-landed.db");
		const foreign = new Database(foreignPath);
		foreign.exec(LEGACY_SCHEMA);
		insertMessage(foreign, {
			id: "foreign-rename-landed",
			from_agent: "foreign-exec",
			to_agent: "flywheel-eng-lead",
			type: "question",
		});
		foreign.close();
		migrateLegacyDatabaseFile(foreignPath, { now: NOW });
		chmodSync(dbPath, 0o600);
		copyFileSync(foreignPath, dbPath);
		const before = sha256(dbPath);

		await expect(migrateCommDbWithSwap(dbPath, { now: NOW })).rejects.toThrow(
			/pre-swap phase staging_verified cannot own a migrated canonical/i,
		);
		expect(sha256(dbPath)).toBe(before);
	});

	it("refuses a sidecar quarantine rename when source and target both exist", async () => {
		writeFileSync(`${dbPath}-wal`, "bound WAL");
		await expect(
			migrateCommDbWithSwap(dbPath, { now: NOW, faultAfter: "backed_up" }),
		).rejects.toThrow(/fault injection/);
		writeFileSync(`${dbPath}-wal.fly1572-quarantine`, "older evidence");
		const before = sha256(dbPath);

		await expect(migrateCommDbWithSwap(dbPath, { now: NOW })).rejects.toThrow(
			/WAL source\/quarantine state is contradictory|source and quarantine both exist/i,
		);
		expect(sha256(dbPath)).toBe(before);
		expect(readFileSync(`${dbPath}-wal.fly1572-quarantine`, "utf8")).toBe(
			"older evidence",
		);
	});

	it("resumes a backed-up phase when the bound WAL quarantine rename landed first", async () => {
		writeFileSync(`${dbPath}-wal`, "bound WAL");
		await expect(
			migrateCommDbWithSwap(dbPath, { now: NOW, faultAfter: "backed_up" }),
		).rejects.toThrow(/fault injection/);
		renameSync(`${dbPath}-wal`, `${dbPath}-wal.fly1572-quarantine`);

		await expect(
			migrateCommDbWithSwap(dbPath, { now: NOW }),
		).resolves.toMatchObject({ status: "migrated" });
		expect(existsSync(`${dbPath}-wal.fly1572-quarantine`)).toBe(false);
		const migrated = new Database(dbPath, { readonly: true });
		try {
			expect(
				migrated
					.prepare(
						"SELECT schema_generation FROM mailbox_migration_meta WHERE singleton=1",
					)
					.get(),
			).toEqual({ schema_generation: "mailbox_v1" });
		} finally {
			migrated.close();
		}
	});

	it("preserves committed WAL-only rows across every durable forward phase", async () => {
		const phases: MailboxSwapPhase[] = [
			"fenced",
			"backed_up",
			"sidecars_quarantined",
			"staging_verified",
			"canonical_swapped",
			"dir_fsynced",
			"verified",
			"done",
		];
		const seedPath = join(dir, "wal-authority-seed.db");
		const seed = new Database(seedPath);
		seed.pragma("journal_mode = WAL");
		seed.pragma("wal_autocheckpoint = 0");
		seed.exec(LEGACY_SCHEMA);
		seed.pragma("wal_checkpoint(TRUNCATE)");
		insertMessage(seed, {
			id: "wal-only-authority",
			from_agent: "exec-wal",
			to_agent: "flywheel-eng-lead",
			type: "question",
		});
		for (const phase of phases) {
			const path = join(dir, `wal-authority-${phase}.db`);
			copyFileSync(seedPath, path);
			copyFileSync(`${seedPath}-wal`, `${path}-wal`);
		}
		seed.close();

		for (const phase of phases) {
			const path = join(dir, `wal-authority-${phase}.db`);
			await expect(
				migrateCommDbWithSwap(path, { now: NOW, faultAfter: phase }),
			).rejects.toThrow(/fault injection/);
			await expect(
				migrateCommDbWithSwap(path, { now: NOW }),
			).resolves.toMatchObject({ status: "migrated" });
			const migrated = new Database(path, { readonly: true });
			try {
				expect(
					migrated.prepare("SELECT id FROM mailbox").pluck().all(),
				).toContain("wal-only-authority");
			} finally {
				migrated.close();
			}
		}
	}, 30_000);

	it.each([
		"after_fresh_intent_durable",
		"after_main_fenced",
		"after_wal_fenced",
	] as const)("resumes safely after the %s fence seam", async (faultAfter) => {
		await expect(
			migrateCommDbWithSwap(dbPath, { now: NOW, faultAfter }),
		).rejects.toThrow(/fault injection/);

		await expect(
			migrateCommDbWithSwap(dbPath, { now: NOW }),
		).resolves.toMatchObject({ status: "migrated" });
	});

	it.each([
		"after_stale_intent_archived",
		"after_stale_intent_dir_fsynced",
	] as const)(
		"resumes safely after the %s stale-archive seam",
		async (faultAfter) => {
			writeSwapIntent(dbPath);
			await expect(
				migrateCommDbWithSwap(dbPath, { now: NOW, faultAfter }),
			).rejects.toThrow(/fault injection/);

			await expect(
				migrateCommDbWithSwap(dbPath, { now: NOW }),
			).resolves.toMatchObject({ status: "migrated" });
			expect(
				readdirSync(dir).filter((name) =>
					name.startsWith("comm.db.migration-swap-intent.json.stale-"),
				),
			).toHaveLength(1);
		},
	);

	it("accepts an aborted v2 intent without inventing post-backup hash requirements", () => {
		const intentPath = writeSwapIntent(dbPath, {
			v: 2,
			phase: "aborted",
			sourceBinding: { mainSha256: sha256(dbPath), walSha256: null },
		});
		expect(inspectMailboxSwapIntent(intentPath)).toMatchObject({
			v: 2,
			phase: "aborted",
		});
	});

	it("rejects rollback when a bound backup is replaced by a valid foreign bundle", async () => {
		await migrateCommDbWithSwap(dbPath, { now: NOW });
		const intentPath = `${dbPath}.migration-swap-intent.json`;
		const intent = JSON.parse(readFileSync(intentPath, "utf8")) as {
			backupPath: string;
		};
		const foreignPath = join(dir, "foreign-rollback.db");
		const foreign = new Database(foreignPath);
		foreign.exec(LEGACY_SCHEMA);
		insertMessage(foreign, {
			id: "foreign-rollback-row",
			from_agent: "foreign-exec",
			to_agent: "flywheel-eng-lead",
			type: "question",
		});
		foreign.close();
		copyFileSync(foreignPath, intent.backupPath);
		const before = sha256(dbPath);

		expect(() => rollbackMailboxMigration(dbPath)).toThrow(
			/diverged from the fenced source\/artifacts/i,
		);
		expect(sha256(dbPath)).toBe(before);
	});

	it.each(["wal", "refs"] as const)(
		"refuses an already-restored shortcut when new %s state exists",
		async (extra) => {
			await migrateCommDbWithSwap(dbPath, { now: NOW });
			const intent = JSON.parse(
				readFileSync(`${dbPath}.migration-swap-intent.json`, "utf8"),
			) as { backupPath: string };
			copyFileSync(intent.backupPath, dbPath);
			if (extra === "wal") {
				writeFileSync(`${dbPath}-wal`, "new committed evidence");
			} else {
				mkdirSync(join(dir, "refs"), { recursive: true });
				writeFileSync(join(dir, "refs", "new.txt"), "new ref evidence");
			}
			const before = sha256(dbPath);

			expect(() => rollbackMailboxMigration(dbPath)).toThrow(
				/rollback refused/i,
			);
			expect(sha256(dbPath)).toBe(before);
			expect(
				existsSync(
					extra === "wal" ? `${dbPath}-wal` : join(dir, "refs", "new.txt"),
				),
			).toBe(true);
		},
	);

	it("rolls back safely from every pre-swap phase and cleans forward quarantines", async () => {
		const phases: MailboxSwapPhase[] = [
			"fenced",
			"backed_up",
			"sidecars_quarantined",
			"staging_verified",
		];
		const seedPath = join(dir, "pre-swap-rollback-seed.db");
		const seed = new Database(seedPath);
		seed.pragma("journal_mode = WAL");
		seed.pragma("wal_autocheckpoint = 0");
		seed.exec(LEGACY_SCHEMA);
		seed.pragma("wal_checkpoint(TRUNCATE)");
		insertMessage(seed, {
			id: "wal-only-rollback-authority",
			from_agent: "exec-rollback",
			to_agent: "flywheel-eng-lead",
			type: "question",
		});
		for (const phase of phases) {
			const path = join(dir, `pre-swap-rollback-${phase}.db`);
			copyFileSync(seedPath, path);
			copyFileSync(`${seedPath}-wal`, `${path}-wal`);
		}
		seed.close();

		for (const phase of phases) {
			const path = join(dir, `pre-swap-rollback-${phase}.db`);
			await expect(
				migrateCommDbWithSwap(path, { now: NOW, faultAfter: phase }),
			).rejects.toThrow(/fault injection/);

			expect(() => rollbackMailboxMigration(path)).not.toThrow();
			expect(() => rollbackMailboxMigration(path)).not.toThrow();
			const restored = new Database(path, { readonly: true });
			try {
				expect(
					restored.prepare("SELECT id FROM messages").pluck().all(),
				).toContain("wal-only-rollback-authority");
			} finally {
				restored.close();
			}
			expect(existsSync(`${path}-wal.fly1572-quarantine`)).toBe(false);
			expect(existsSync(`${path}-shm.fly1572-quarantine`)).toBe(false);
		}
	}, 30_000);

	it("repairs the canonical mode before returning already_migrated", async () => {
		migrateLegacyDatabaseFile(dbPath, { now: NOW });
		chmodSync(dbPath, 0o400);

		await expect(
			migrateCommDbWithSwap(dbPath, { now: NOW }),
		).resolves.toMatchObject({ status: "already_migrated" });
		expect(statSync(dbPath).mode & 0o777).toBe(0o600);
	});

	it("materializes committed WAL frames and content refs into the backup authority", async () => {
		const path = join(dir, "wal.db");
		const writer = new Database(path);
		writer.pragma("journal_mode = WAL");
		writer.pragma("wal_autocheckpoint = 0");
		writer.exec(LEGACY_SCHEMA);
		insertMessage(writer, {
			id: "wal-only",
			from_agent: "exec-1",
			to_agent: "flywheel-eng-lead",
			type: "question",
		});
		const refPath = writeContentRef(path, "wal-only", "ref bytes");
		const backupPath = await backupCommDb(path, join(dir, "wal.backup"));
		try {
			const backup = new Database(backupPath, { readonly: true });
			try {
				expect(backup.prepare("SELECT id FROM messages").all()).toEqual([
					{ id: "wal-only" },
				]);
			} finally {
				backup.close();
			}
			expect(readFileSync(`${backupPath}.refs/wal-only.txt`, "utf8")).toBe(
				"ref bytes",
			);
			expect(existsSync(refPath)).toBe(true);
		} finally {
			writer.close();
		}
	});

	it("leaves WAL shared memory writable while the canonical database and WAL are fenced", async () => {
		const path = join(dir, "fence.db");
		const writer = new Database(path);
		writer.pragma("journal_mode = WAL");
		writer.exec(LEGACY_SCHEMA);
		insertMessage(writer, {
			id: "fenced-question",
			from_agent: "exec-1",
			to_agent: "flywheel-eng-lead",
			type: "question",
		});
		const walPath = `${path}-wal`;
		const shmPath = `${path}-shm`;
		try {
			await expect(
				migrateCommDbWithSwap(path, { now: NOW, faultAfter: "fenced" }),
			).rejects.toThrow(/fault injection/);
			expect(statSync(path).mode & 0o222).toBe(0);
			expect(statSync(walPath).mode & 0o222).toBe(0);
			expect(statSync(shmPath).mode & 0o200).toBe(0o200);
		} finally {
			for (const file of [path, walPath, shmPath]) {
				if (existsSync(file)) chmodSync(file, 0o600);
			}
			writer.close();
		}
	});

	it("removes abandoned backup temp databases and journals before retrying", async () => {
		const backupPath = join(dir, "retry.backup");
		const stale = `${backupPath}.tmp-00000000-0000-4000-8000-000000000000`;
		writeFileSync(stale, "partial backup");
		writeFileSync(`${stale}-journal`, "partial journal");
		writeFileSync(`${stale}-wal`, "partial wal");
		writeFileSync(`${stale}-shm`, "partial shm");

		await backupCommDb(dbPath, backupPath);

		expect(existsSync(stale)).toBe(false);
		expect(existsSync(`${stale}-journal`)).toBe(false);
		expect(existsSync(`${stale}-wal`)).toBe(false);
		expect(existsSync(`${stale}-shm`)).toBe(false);
		expect(existsSync(backupPath)).toBe(true);
	});

	it("removes forward sidecar quarantines after cutover converges", async () => {
		const path = join(dir, "forward-cleanup.db");
		const legacy = new Database(path);
		legacy.exec(LEGACY_SCHEMA);
		insertMessage(legacy, {
			id: "question-forward-cleanup",
			from_agent: "exec-1",
			to_agent: "flywheel-eng-lead",
			type: "question",
		});
		legacy.close();
		writeFileSync(`${path}-wal`, "");
		writeFileSync(`${path}-shm`, "");
		await expect(
			migrateCommDbWithSwap(path, { now: NOW, faultAfter: "backed_up" }),
		).rejects.toThrow(/fault injection/);

		await expect(
			migrateCommDbWithSwap(path, { now: NOW }),
		).resolves.toMatchObject({ status: "migrated" });
		expect(existsSync(`${path}-wal.fly1572-quarantine`)).toBe(false);
		expect(existsSync(`${path}-shm.fly1572-quarantine`)).toBe(false);
	});

	it("resumes idempotently after every durable forward-swap phase", async () => {
		const phases: MailboxSwapPhase[] = [
			"fenced",
			"backed_up",
			"sidecars_quarantined",
			"staging_verified",
			"canonical_swapped",
			"dir_fsynced",
			"verified",
			"done",
		];
		for (const phase of phases) {
			const path = join(dir, `${phase}.db`);
			const legacy = new Database(path);
			legacy.exec(LEGACY_SCHEMA);
			insertMessage(legacy, {
				id: `question-${phase}`,
				from_agent: "exec-1",
				to_agent: "flywheel-eng-lead",
				type: "question",
			});
			legacy.close();
			await expect(
				migrateCommDbWithSwap(path, { now: NOW, faultAfter: phase }),
			).rejects.toThrow(/fault injection/);
			await expect(
				migrateCommDbWithSwap(path, { now: NOW }),
			).resolves.toMatchObject({
				status: "migrated",
			});
			const migrated = new Database(path, { readonly: true });
			try {
				expect(
					migrated
						.prepare(
							"SELECT schema_generation FROM mailbox_migration_meta WHERE singleton=1",
						)
						.get(),
				).toEqual({ schema_generation: "mailbox_v1" });
			} finally {
				migrated.close();
			}
		}
	}, 30_000);

	it("reconciles a canonical rename that landed before its intent phase", async () => {
		const path = join(dir, "rename-before-intent.db");
		const legacy = new Database(path);
		legacy.exec(LEGACY_SCHEMA);
		insertMessage(legacy, {
			id: "question-rename",
			from_agent: "exec-1",
			to_agent: "flywheel-eng-lead",
			type: "question",
		});
		legacy.close();
		await expect(
			migrateCommDbWithSwap(path, {
				now: NOW,
				faultAfter: "staging_verified",
			}),
		).rejects.toThrow(/fault injection/);
		const intentPath = `${path}.migration-swap-intent.json`;
		const intent = JSON.parse(readFileSync(intentPath, "utf8")) as {
			stagingPath: string;
		};
		renameSync(intent.stagingPath, path);
		await expect(
			migrateCommDbWithSwap(path, { now: NOW }),
		).resolves.toMatchObject({
			status: "migrated",
		});
	});

	it("resumes rollback after every durable restore phase", async () => {
		const phases: MailboxRestorePhase[] = [
			"staged",
			"refs_swapped",
			"db_swapped",
			"verified",
			"done",
		];
		for (const phase of phases) {
			const path = join(dir, `restore-${phase}.db`);
			const legacy = new Database(path);
			legacy.exec(LEGACY_SCHEMA);
			insertMessage(legacy, {
				id: `question-${phase}`,
				from_agent: "exec-1",
				to_agent: "flywheel-eng-lead",
				type: "question",
			});
			legacy.close();
			await migrateCommDbWithSwap(path, { now: NOW });
			expect(() =>
				rollbackMailboxMigration(path, { faultAfter: phase }),
			).toThrow(/fault injection/);
			expect(() => rollbackMailboxMigration(path)).not.toThrow();
			expect(existsSync(`${path}.restore-intent.json`)).toBe(false);
			const restored = new Database(path, { readonly: true });
			try {
				expect(
					restored
						.prepare("SELECT type FROM sqlite_master WHERE name='messages'")
						.get(),
				).toEqual({ type: "table" });
			} finally {
				restored.close();
			}
		}
	}, 30_000);
});
