import {
	chmodSync,
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
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	backupCommDb,
	type MailboxRestorePhase,
	type MailboxSwapPhase,
	migrateCommDbWithSwap,
	migrateLegacyDatabaseFile,
	rollbackMailboxMigration,
} from "../mailbox-migration.js";
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
		legacy.exec(`
			CREATE TRIGGER qa_inject_extra_queued_projection
			AFTER INSERT ON receipt_root_lineage
			WHEN NEW.question_id = 'question-anchor'
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
		await expect(
			migrateCommDbWithSwap(path, { now: NOW, faultAfter: "backed_up" }),
		).rejects.toThrow(/fault injection/);
		writeFileSync(`${path}-wal`, "");
		writeFileSync(`${path}-shm`, "");

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
