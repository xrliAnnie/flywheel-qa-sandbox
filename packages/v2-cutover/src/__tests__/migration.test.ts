import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { initializeEngineDb } from "flywheel-v2-engine";
import { Kernel, migrateDatabase } from "flywheel-v2-kernel";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildMigrationPlan,
	type LegacyCommMessage,
	type LegacyJsonEntry,
	type LegacyLeadInboxRow,
	migrateLegacyPlan,
	readLegacySourceSnapshot,
} from "../migration.js";

const NOW = "2026-07-28T12:00:00.000Z";

function makeTempDirectory(): { path: string; cleanup(): void } {
	const path = mkdtempSync(join(tmpdir(), "flywheel-v2-migration-"));
	return {
		path,
		cleanup() {
			rmSync(path, { recursive: true, force: true });
		},
	};
}

function digest(payload: string): string {
	return createHash("sha256").update(payload).digest("hex");
}

function message(
	overrides: Partial<LegacyCommMessage> = {},
): LegacyCommMessage {
	return {
		source: "messages",
		project: "flywheel",
		id: "m1",
		fromAgent: "runner-a",
		toAgent: "lead-a",
		type: "question",
		content: "hello",
		readAt: null,
		relayState: "open",
		createdAt: "2026-07-28T10:00:00.000Z",
		expiresAt: "2026-07-29T12:00:00.000Z",
		logicalEventId: null,
		...overrides,
	};
}

function inbox(
	overrides: Partial<LegacyLeadInboxRow> = {},
): LegacyLeadInboxRow {
	return {
		source: "lead_inbox",
		project: "flywheel",
		id: "i1",
		toLead: "lead-a",
		sourceName: "bridge_event",
		type: "instruction",
		messageClass: "model",
		content: "inbox",
		refMessageId: null,
		createdAt: NOW,
		deadlineAt: null,
		carrier: "inbox",
		disposition: null,
		deliveredAt: null,
		consumedAt: null,
		processedAt: null,
		disposedAt: null,
		receiptExemptReason: null,
		...overrides,
	};
}

function json(overrides: Partial<LegacyJsonEntry> = {}): LegacyJsonEntry {
	return {
		source: "json",
		project: "flywheel",
		team: "lead-a",
		relativePath: "lead-a/inboxes/lead-a.json",
		index: 0,
		toAgent: "lead-a",
		from: "runner-a",
		text: "hello",
		timestamp: "2026-07-28T10:00:00.000Z",
		read: false,
		flywheelId: "m1",
		...overrides,
	};
}

describe("dual-source legacy migration classifier", () => {
	it("uses the authoritative cutover Lead set when sessions have no recipient evidence", () => {
		const plan = buildMigrationPlan({
			nowIso: NOW,
			epoch: 7,
			authoritativeLiveLeadIds: ["lead-a"],
			agents: {},
			messages: [message()],
			leadInbox: [inbox()],
			jsonEntries: [],
			journalUnfinished: [],
		});

		expect(plan.decisions.map((row) => row.disposition)).toEqual([
			"migrate",
			"migrate",
		]);
		expect(plan.leadLiveness).toEqual({
			authoritativeLiveLeadIds: ["lead-a"],
			unknownRecipientIds: [],
		});
	});

	it("uses durable terminal evidence for A/B/C and reports anomalies", () => {
		const plan = buildMigrationPlan({
			nowIso: NOW,
			epoch: 7,
			agents: { "lead-a": { kind: "lead", terminal: false } },
			messages: [
				message(),
				message({ id: "read", readAt: NOW }),
				message({
					id: "disposed-message",
					relayState: "terminal_disposed",
				}),
			],
			leadInbox: [
				inbox({
					id: "delivery",
					carrier: "external",
					disposition: "delivery_quarantined",
				}),
				inbox({
					id: "receipt",
					carrier: "external",
					disposition: "external_delivered",
					deliveredAt: NOW,
				}),
				inbox({
					id: "disposed",
					disposedAt: NOW,
					consumedAt: null,
				}),
				inbox({
					id: "processed",
					processedAt: NOW,
					consumedAt: null,
				}),
				inbox({
					id: "inbox-delivered",
					carrier: "inbox",
					deliveredAt: NOW,
					processedAt: null,
					disposition: "external_delivered",
				}),
				inbox({
					id: "exempt",
					carrier: "external",
					deliveredAt: NOW,
					receiptExemptReason: "internal_mirror",
				}),
			],
			jsonEntries: [json({ read: true })],
			journalUnfinished: [{ journalPath: "/isolated/journal.db", count: 2 }],
		});

		expect(plan.domains.a).toEqual({
			messages: 1,
			leadInbox: 0,
			json: 0,
		});
		expect(plan.domains.b).toEqual({
			deliveryObligations: 1,
			receiptObligations: 1,
			journalUnfinished: 2,
			blockingManual: 1,
		});
		expect(plan.domains.c.anomalies).toMatchObject({
			disposedButUnconsumed: 1,
			processedButUnconsumed: 1,
		});
		expect(plan.go).toBe(false);
	});

	it("applies the normative classification order and stable canonical keys", () => {
		const comm = message({
			id: "discord-copy",
			content: "same",
			logicalEventId: "discord:12345",
		});
		const plan = buildMigrationPlan({
			nowIso: NOW,
			epoch: 9,
			agents: {
				"lead-a": { kind: "lead", terminal: false },
				"lead-gone": { kind: "lead", terminal: true },
			},
			messages: [
				comm,
				message({
					id: "expired-notice",
					type: "progress",
					expiresAt: "2026-07-27T00:00:00.000Z",
				}),
				message({
					id: "gone",
					toAgent: "lead-gone",
				}),
				message({
					id: "protected",
					relayState: "protected",
				}),
			],
			leadInbox: [
				inbox({ id: "protocol", messageClass: "protocol" }),
				inbox({
					id: "expired-model",
					deadlineAt: "2026-07-27T00:00:00.000Z",
				}),
				inbox({
					id: "discord-inbox",
					sourceName: "discord",
					refMessageId: "67890",
				}),
			],
			jsonEntries: [
				json({
					flywheelId: "discord-copy",
					text: "same",
				}),
				json({
					flywheelId: undefined,
					index: 1,
					text: "same text twice",
				}),
				json({
					flywheelId: undefined,
					index: 2,
					text: "same text twice",
				}),
			],
			journalUnfinished: [],
		});

		expect(
			plan.decisions.find((row) => row.nativeId === "discord-copy"),
		).toMatchObject({
			sourceKind: "discord",
			sourceId: "12345",
			disposition: "migrate",
		});
		expect(
			plan.decisions.find((row) => row.nativeId === "expired-notice"),
		).toMatchObject({ disposition: "tombstone" });
		expect(plan.decisions.find((row) => row.nativeId === "gone")).toMatchObject(
			{ disposition: "dead" },
		);
		expect(
			plan.decisions.find((row) => row.nativeId === "protected"),
		).toMatchObject({ disposition: "migrate" });
		expect(
			plan.decisions.find((row) => row.nativeId === "protocol"),
		).toMatchObject({ disposition: "tombstone" });
		expect(
			plan.decisions.find((row) => row.nativeId === "expired-model"),
		).toMatchObject({ disposition: "dead" });
		expect(plan.overlapCopies).toHaveLength(1);
		const vendor = plan.decisions.filter(
			(row) => row.sourceKind === "legacy-json",
		);
		expect(vendor).toHaveLength(2);
		expect(vendor[0]?.sourceId).not.toBe(vendor[1]?.sourceId);

		const replay = buildMigrationPlan({
			nowIso: NOW,
			epoch: 9,
			agents: { "lead-a": { kind: "lead", terminal: false } },
			messages: [],
			leadInbox: [],
			jsonEntries: plan.inputSnapshot.jsonEntries,
			journalUnfinished: [],
		});
		expect(
			replay.decisions
				.filter((row) => row.sourceKind === "legacy-json")
				.map((row) => row.sourceId),
		).toEqual(vendor.map((row) => row.sourceId));
	});

	it("fails closed on payload conflict and manual work", () => {
		const plan = buildMigrationPlan({
			nowIso: NOW,
			epoch: 1,
			agents: { "lead-a": { kind: "lead", terminal: false } },
			messages: [message()],
			leadInbox: [],
			jsonEntries: [
				json({ text: "different" }),
				json({
					index: 1,
					flywheelId: undefined,
					text: "vendor only",
				}),
			],
			journalUnfinished: [],
		});
		expect(plan.conservation.balanced).toBe(true);
		expect(plan.conservation.conflicts).toBe(1);
		expect(plan.conservation.manual).toBeGreaterThan(0);
		expect(plan.go).toBe(false);
	});
});

describe("migration-only kernel write", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
	});

	it("preserves identity/digest/epoch, provisions leads, and is idempotent", () => {
		const temp = makeTempDirectory();
		cleanups.push(temp.cleanup);
		const path = `${temp.path}/kernel.db`;
		migrateDatabase({ path });
		const kernel = Kernel.open({ path });
		cleanups.push(() => kernel.close());
		initializeEngineDb(kernel);
		kernel.write("test.epoch", (tx) => {
			tx.run("UPDATE meta SET value='44' WHERE key='cutover_epoch'");
		});
		const payload = "preserved";
		const plan = buildMigrationPlan({
			nowIso: NOW,
			epoch: 44,
			agents: { "lead-a": { kind: "lead", terminal: false } },
			messages: [message({ id: "legacy-uid", content: payload })],
			leadInbox: [],
			jsonEntries: [],
			journalUnfinished: [],
		});

		expect(migrateLegacyPlan(kernel, plan)).toEqual({
			inserted: 1,
			duplicates: 0,
			events: 0,
		});
		expect(migrateLegacyPlan(kernel, plan)).toEqual({
			inserted: 0,
			duplicates: 1,
			events: 0,
		});
		const db = new Database(path, { readonly: true });
		try {
			expect(
				db
					.prepare(
						`SELECT message_uid,source_kind,source_id,payload_digest,
						        to_agent,cutover_epoch,state
						   FROM mailbox`,
					)
					.get(),
			).toEqual({
				message_uid: "legacy-uid",
				source_kind: "legacy-comm",
				source_id: "flywheel/legacy-uid",
				payload_digest: digest(payload),
				to_agent: "lead-a",
				cutover_epoch: 44,
				state: "pending",
			});
		} finally {
			db.close();
		}
	});

	it("rejects manual plans and non-cutover authority", () => {
		const temp = makeTempDirectory();
		cleanups.push(temp.cleanup);
		const path = `${temp.path}/kernel.db`;
		migrateDatabase({ path });
		const kernel = Kernel.open({ path });
		cleanups.push(() => kernel.close());
		initializeEngineDb(kernel);
		const plan = buildMigrationPlan({
			nowIso: NOW,
			epoch: 1,
			agents: { "lead-a": { kind: "lead", terminal: false } },
			messages: [],
			leadInbox: [],
			jsonEntries: [json({ flywheelId: undefined })],
			journalUnfinished: [],
		});
		expect(() => migrateLegacyPlan(kernel, plan)).toThrow(/manual/);

		kernel.write("test.live", (tx) => {
			tx.run(
				"UPDATE meta SET value='live' WHERE key='cutover_authority_state'",
			);
		});
		const cleanPlan = buildMigrationPlan({
			nowIso: NOW,
			epoch: 1,
			agents: { "lead-a": { kind: "lead", terminal: false } },
			messages: [message()],
			leadInbox: [],
			jsonEntries: [],
			journalUnfinished: [],
		});
		expect(() => migrateLegacyPlan(kernel, cleanPlan)).toThrow(
			/requires cutover authority/,
		);
	});
});

describe("real legacy source snapshot", () => {
	it("reads comm, stock JSON plus sidecar, and every journal state fail-closed", () => {
		const temp = makeTempDirectory();
		try {
			const commDir = join(temp.path, "comm", "flywheel");
			mkdirSync(commDir, { recursive: true });
			const commPath = join(commDir, "comm.db");
			const comm = new Database(commPath);
			comm.exec(`
				CREATE TABLE messages(
				  id TEXT,from_agent TEXT,to_agent TEXT,type TEXT,content TEXT,
				  read_at TEXT,relay_state TEXT,created_at TEXT,expires_at TEXT,
				  logical_event_id TEXT
				);
				CREATE TABLE lead_inbox(
				  id TEXT,to_lead TEXT,source TEXT,type TEXT,msg_class TEXT,
				  content TEXT,ref_message_id TEXT,created_at TEXT,deadline_at TEXT,
				  carrier TEXT,disposition TEXT,delivered_at TEXT,consumed_at TEXT,
				  processed_at TEXT,disposed_at TEXT,receipt_exempt_reason TEXT
				);
				CREATE TABLE sessions(
				  execution_id TEXT,lead_id TEXT,status TEXT
				);
				INSERT INTO messages VALUES(
				  'comm-1','runner-a','lead-a','question','payload',NULL,'protected',
				  '2026-07-28 10:00:00','2026-07-29 10:00:00',NULL
				);
				INSERT INTO messages VALUES(
				  'comm-done','runner-done','lead-with-only-done','question',
				  'must not dead-letter',NULL,'open',
				  '2026-07-28 10:00:00','2026-07-29 10:00:00',NULL
				);
				INSERT INTO lead_inbox VALUES(
				  'receipt','lead-a','discord','instruction','model','payload','99',
				  '2026-07-28 10:00:00',NULL,'external','external_delivered',
				  '2026-07-28 10:01:00',NULL,NULL,NULL,NULL
				);
				INSERT INTO sessions VALUES('runner-a','lead-a','running');
				INSERT INTO sessions VALUES(
				  'runner-done','lead-with-only-done','completed'
				);
			`);
			comm.close();

			const inboxPath = join(
				temp.path,
				"teams",
				"lead-a",
				"inboxes",
				"lead-a.json",
			);
			mkdirSync(dirname(inboxPath), { recursive: true });
			const stock = {
				from: "runner-a",
				text: "payload",
				timestamp: "2026-07-28T10:00:00.000Z",
				read: false,
			};
			writeFileSync(inboxPath, JSON.stringify([stock]));
			writeFileSync(
				`${inboxPath}.flywheel.jsonl`,
				`${JSON.stringify({
					flywheelId: "comm-1",
					status: "finalized",
					idempotency: "stable",
					payloadFingerprint: digest(
						`${stock.from}|lead-a|${stock.text}|${stock.timestamp}`,
					),
					pendingAt: 1,
					finalizedAt: 2,
					mainEntryRef: {
						from: stock.from,
						timestamp: stock.timestamp,
					},
				})}\n`,
			);

			const journalPath = join(temp.path, "journal.db");
			const journal = new Database(journalPath);
			journal.exec(`
				CREATE TABLE journal(state TEXT);
				INSERT INTO journal VALUES
				  ('accepted'),('dispatching'),('dispatched'),('model_completed'),
				  ('output_pending'),('completed'),('ambiguous'),('dead_letter');
			`);
			journal.close();

			const snapshot = readLegacySourceSnapshot({
				commDatabases: [commPath],
				jsonInboxRoots: [join(temp.path, "teams")],
				journalDatabases: [journalPath],
			});
			expect(snapshot.messages).toHaveLength(2);
			expect(snapshot.messages[0]).toMatchObject({
				project: "flywheel",
				relayState: "protected",
			});
			expect(snapshot.jsonEntries[0]).toMatchObject({
				team: "lead-a",
				toAgent: "lead-a",
				flywheelId: "comm-1",
			});
			expect(snapshot.agents).toEqual({
				"runner-a": { kind: "runner", terminal: false },
				"lead-a": { kind: "lead", terminal: false },
				"runner-done": { kind: "runner", terminal: true },
			});
			const plan = buildMigrationPlan({
				nowIso: NOW,
				epoch: 7,
				...snapshot,
			});
			expect(
				plan.decisions.find((row) => row.nativeId === "comm-done"),
			).toMatchObject({
				disposition: "manual",
				reason: "business recipient liveness is unknown",
			});
			expect(snapshot.journalUnfinished).toEqual([{ journalPath, count: 5 }]);
		} finally {
			temp.cleanup();
		}
	});
});
