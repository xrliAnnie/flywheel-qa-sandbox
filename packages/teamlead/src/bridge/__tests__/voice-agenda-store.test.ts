import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { HeadphoneInboxCollector } from "../headphone-collector.js";
import { HeadphoneInboxStore } from "../headphone-inbox.js";
import { VoiceAgendaStore } from "../voice-agenda-store.js";
import { VoiceHandoffStore } from "../voice-handoff-store.js";

let db: Database.Database | undefined;
afterEach(() => {
	db?.close();
	db = undefined;
});

const LEGACY_HANDOFF_TABLES = `
	CREATE TABLE voice_handoffs (
		handoff_id TEXT PRIMARY KEY,
		idempotency_key TEXT NOT NULL UNIQUE,
		request_digest TEXT NOT NULL,
		project_name TEXT NOT NULL,
		founder_user_id TEXT NOT NULL,
		target_lead_id TEXT NOT NULL,
		session_id TEXT NOT NULL,
		generation INTEGER NOT NULL CHECK(generation > 0),
		state TEXT NOT NULL CHECK(state IN ('authorized','dispatching','committed','rejected','ambiguous','needs_human')),
		message_id TEXT NOT NULL UNIQUE,
		provider_operation_id TEXT NOT NULL UNIQUE,
		attempt_token TEXT,
		state_version INTEGER NOT NULL DEFAULT 1,
		request_json TEXT NOT NULL,
		terminal_reason TEXT,
		reconcile_count INTEGER NOT NULL DEFAULT 0,
		last_reconcile_at TEXT,
		next_reconcile_at TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	);
	CREATE TABLE voice_handoff_results (
		handoff_id TEXT NOT NULL,
		result_event_id TEXT NOT NULL,
		seq INTEGER NOT NULL CHECK(seq > 0),
		request_digest TEXT NOT NULL,
		source_lead_id TEXT NOT NULL,
		source_delivery_id TEXT NOT NULL,
		result_kind TEXT NOT NULL CHECK(result_kind IN ('lead_reply','progress','completed','failed')),
		text TEXT NOT NULL,
		payload_digest TEXT NOT NULL,
		created_at TEXT NOT NULL,
		PRIMARY KEY(handoff_id, result_event_id),
		UNIQUE(handoff_id, seq),
		FOREIGN KEY(handoff_id) REFERENCES voice_handoffs(handoff_id)
	);
`;

describe("VoiceHandoffStore FLY-2863 migration", () => {
	it("widens a pre-agenda result table in place and keeps every row and digest", () => {
		db = new Database(":memory:");
		db.exec(LEGACY_HANDOFF_TABLES);
		db.prepare(
			`INSERT INTO voice_handoffs VALUES ('h1','k1','${"a".repeat(64)}','p','f','lead','s',1,'committed','m1','op1',NULL,1,'{"transcriptId":"t"}',NULL,0,NULL,NULL,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
		).run();
		db.prepare(
			`INSERT INTO voice_handoff_results VALUES ('h1','e1',1,'${"a".repeat(64)}','lead','d1','lead_reply','hi','digest-1','2026-01-01T00:00:00Z')`,
		).run();
		const store = new VoiceHandoffStore(db);
		store.migrate();
		store.migrate();
		expect(store.listResults("h1", 0, 10).events).toEqual([
			expect.objectContaining({ resultEventId: "e1", text: "hi", seq: 1 }),
		]);
		expect(store.get("h1")).toMatchObject({
			requestKind: "user_handoff",
			agenda: null,
		});
		const event = store.appendResult({
			handoffId: "h1",
			resultEventId: "e2",
			requestDigest: "a".repeat(64),
			sourceLeadId: "lead",
			sourceDeliveryId: "d2",
			resultKind: "agenda_say",
			text: "先说受阻。",
			agenda: { kind: "say", itemKey: null },
			createdAt: "2026-01-01T00:00:01Z",
		});
		expect(event).toMatchObject({ seq: 2, agenda: { kind: "say" } });
		expect(() =>
			store.appendResult({
				handoffId: "h1",
				resultEventId: "e3",
				requestDigest: "a".repeat(64),
				sourceLeadId: "lead",
				sourceDeliveryId: "d3",
				resultKind: "agenda_close",
				text: "x",
				createdAt: "2026-01-01T00:00:02Z",
			}),
		).toThrow(/agenda_invalid/u);
	});

	it("only an agenda brief may exist without a founder transcript", () => {
		db = new Database(":memory:");
		const store = new VoiceHandoffStore(db);
		store.migrate();
		expect(() =>
			db!
				.prepare(
					`INSERT INTO voice_handoffs (handoff_id,idempotency_key,request_digest,project_name,founder_user_id,target_lead_id,session_id,generation,state,message_id,provider_operation_id,request_json,created_at,updated_at)
					 VALUES ('h','k','d','p','f','l','s',1,'authorized','m','o','{}','t','t')`,
				)
				.run(),
		).toThrow(/CHECK/u);
		const record = store.authorizeAgendaBrief({
			handoffId: "018f47d2-7b64-7b42-a3df-000000000009",
			idempotencyKey: "agenda:s:1:c",
			requestDigest: "b".repeat(64),
			projectName: "p",
			founderUserId: "f",
			targetLeadId: "l",
			sessionId: "s",
			generation: 1,
			messageId: "voice-handoff:018f47d2-7b64-7b42-a3df-000000000009",
			providerOperationId:
				"chat:l:voice-handoff:018f47d2-7b64-7b42-a3df-000000000009",
			agenda: {
				kind: "brief",
				purpose: "open",
				itemKey: null,
				clientRequestId: "c",
				authorId: "400000000000000001",
				answerKey: "k".repeat(24),
				brief: {},
				text: "brief",
			},
			now: "2026-01-01T00:00:00Z",
		});
		expect(record.requestKind).toBe("agenda_brief");
		expect(() =>
			store.authorizeAgendaBrief({
				...{
					handoffId: "018f47d2-7b64-7b42-a3df-00000000000a",
					idempotencyKey: "agenda:s:1:c",
					requestDigest: "c".repeat(64),
					projectName: "p",
					founderUserId: "f",
					targetLeadId: "l",
					sessionId: "s",
					generation: 1,
					messageId: "voice-handoff:x",
					providerOperationId: "op-x",
					agenda: {
						kind: "brief",
						purpose: "open",
						itemKey: null,
						clientRequestId: "c",
						authorId: "400000000000000001",
						answerKey: "k".repeat(24),
						brief: {},
						text: "brief",
					},
					now: "2026-01-01T00:00:00Z",
				},
			}),
		).toThrow(/identity_conflict/u);
	});
});

describe("VoiceAgendaStore", () => {
	function open(): VoiceAgendaStore {
		db = new Database(":memory:");
		db.exec(
			"CREATE TABLE chat_threads (thread_id TEXT, channel_id TEXT, issue_id TEXT, lead_id TEXT, archived_at TEXT, discord_missing_at TEXT)",
		);
		new HeadphoneInboxStore(db).migrate();
		const store = new VoiceAgendaStore(db);
		store.migrate("2026-09-01T00:00:00.000Z");
		return store;
	}

	it("writes the history baseline once and never moves it", () => {
		const store = open();
		store.migrate("2026-09-30T00:00:00.000Z");
		expect(store.leadSaidBaselineAt()).toBe("2026-09-01T00:00:00.000Z");
	});

	it("ends an episode only on a complete read and re-entry mints a new one", () => {
		const store = open();
		const present = [{ issueId: "i", agendaClass: "blocked" as const }];
		const first = store.observeEpisodes({
			present,
			completeIssueIds: new Set(["i"]),
			now: "2026-09-24T01:00:00.000Z",
		});
		// Absent but unreadable: the episode survives.
		store.observeEpisodes({
			present: [],
			completeIssueIds: new Set(),
			now: "2026-09-24T02:00:00.000Z",
		});
		expect(
			store.observeEpisodes({
				present,
				completeIssueIds: new Set(["i"]),
				now: "2026-09-24T03:00:00.000Z",
			})[0]?.since,
		).toBe(first[0]?.since);
		store.observeEpisodes({
			present: [],
			completeIssueIds: new Set(["i"]),
			now: "2026-09-24T04:00:00.000Z",
		});
		expect(
			store.observeEpisodes({
				present,
				completeIssueIds: new Set(["i"]),
				now: "2026-09-24T05:00:00.000Z",
			})[0]?.since,
		).toBe("2026-09-24T05:00:00.000Z");
	});

	it("drops a legacy body-claimed urgent table instead of trusting it", () => {
		db = new Database(":memory:");
		db.exec(
			"CREATE TABLE chat_threads (thread_id TEXT, channel_id TEXT, issue_id TEXT, lead_id TEXT, archived_at TEXT, discord_missing_at TEXT)",
		);
		new HeadphoneInboxStore(db).migrate();
		db.exec(`CREATE TABLE voice_agenda_urgent (
			project_name TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT NOT NULL,
			lead_id TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
			PRIMARY KEY(channel_id, message_id))`);
		db.prepare(
			"INSERT INTO voice_agenda_urgent VALUES ('p','c','m','forged-lead','security','t')",
		).run();
		const store = new VoiceAgendaStore(db);
		store.migrate("2026-09-01T00:00:00.000Z");
		store.migrate("2026-09-01T00:00:00.000Z");
		expect(store.getUrgent("c", "m")).toBeUndefined();
		store.recordUrgent({
			projectName: "p",
			channelId: "c",
			messageId: "m2",
			authorId: "bot",
			reason: "security",
			now: "t",
		});
		expect(store.getUrgent("c", "m2")).toEqual({
			authorId: "bot",
			reason: "security",
		});
	});

	it("rejects an urgent flag outside the enumerated reasons", () => {
		const store = open();
		expect(() =>
			store.recordUrgent({
				projectName: "p",
				channelId: "c",
				messageId: "m",
				authorId: "l",
				reason: "because" as never,
				now: "2026-09-24T00:00:00.000Z",
			}),
		).toThrow(/reason_invalid/u);
	});

	it("a resolved disposition without evidence fails the whole CAS write", () => {
		const store = open();
		const state = {
			version: 1 as const,
			sessionId: "s",
			generation: 1,
			stateVersion: 1,
			opened: true,
			queue: [],
			active: null,
			urgentQueue: [],
			activeUrgent: null,
			items: {},
			outstanding: null,
			applied: {},
			lastActivityAt: "t",
		};
		expect(() =>
			store.saveState({
				state,
				expectedVersion: 0,
				dispositions: [
					{
						itemKey: "k",
						disposition: "resolved",
						evidence: null,
						reason: "r",
						requestId: "q",
						createdAt: "t",
					},
				],
				now: "t",
			}),
		).toThrow(/CHECK/u);
		expect(store.getState("s")).toBeUndefined();
	});
});

describe("HeadphoneInboxCollector — FLY-2863 U1 marker", () => {
	it("records an urgent marker only on a Lead-authored message with an enumerated reason", async () => {
		db = new Database(":memory:");
		const inbox = new HeadphoneInboxStore(db);
		inbox.migrate();
		const marks: unknown[] = [];
		const collector = new HeadphoneInboxCollector({
			store: inbox,
			listScopes: () => [
				{
					projectName: "raya",
					founderUserId: "founder-1",
					channelId: "chan-1",
					allowedAuthorIds: ["lead-bot", "bridge-bot"],
					leadAuthorIds: ["lead-bot"],
					token: "t",
				},
			],
			fetchPage: async () => ({
				kind: "page",
				messages: [
					{
						id: "100000000000000001",
						authorId: "lead-bot",
						content: "🚨[urgent:production_down] 生产挂了，要你拍",
						timestamp: "2026-09-24T00:00:01.000Z",
					},
					{
						id: "100000000000000002",
						authorId: "lead-bot",
						content: "🚨[urgent:because] 我觉得急",
						timestamp: "2026-09-24T00:00:02.000Z",
					},
					{
						id: "100000000000000003",
						authorId: "bridge-bot",
						content: "🤖[自动] 🚨[urgent:security] 状态",
						timestamp: "2026-09-24T00:00:03.000Z",
					},
					{
						id: "100000000000000004",
						authorId: "founder-1",
						content: "🚨[urgent:security] 我自己说",
						timestamp: "2026-09-24T00:00:04.000Z",
					},
				],
			}),
			recordUrgent: (mark) => marks.push(mark),
			now: () => Date.parse("2026-09-24T00:00:05.000Z"),
		});
		expect(await collector.tick()).toBe("collected");
		expect(marks).toEqual([
			{
				projectName: "raya",
				channelId: "chan-1",
				messageId: "100000000000000001",
				authorId: "lead-bot",
				reason: "production_down",
			},
		]);
		expect(
			inbox.getSourceState("raya", "founder-1", "chan-1")?.founderLastMessageAt,
		).toBe("2026-09-24T00:00:04.000Z");
	});
});

describe("HeadphoneInboxCollector — urgent marks commit with the page", () => {
	it("a failed urgent write does not advance the cursor; the next tick records it", async () => {
		db = new Database(":memory:");
		const inbox = new HeadphoneInboxStore(db);
		inbox.migrate();
		let fail = true;
		const marks: string[] = [];
		const collector = new HeadphoneInboxCollector({
			store: inbox,
			minimumPageIntervalMs: 0,
			listScopes: () => [
				{
					projectName: "raya",
					founderUserId: "founder-1",
					channelId: "chan-1",
					allowedAuthorIds: ["lead-bot"],
					leadAuthorIds: ["lead-bot"],
					token: "t",
				},
			],
			fetchPage: async () => ({
				kind: "page",
				messages: [
					{
						id: "100000000000000001",
						authorId: "lead-bot",
						content: "🚨[urgent:security] 有人在试密码",
						timestamp: "2026-09-24T00:00:01.000Z",
					},
				],
			}),
			recordUrgent: (mark) => {
				if (fail) throw new Error("SQLITE_BUSY");
				marks.push(mark.messageId);
			},
		});
		await expect(collector.tick()).rejects.toThrow("SQLITE_BUSY");
		expect(inbox.getSourceState("raya", "founder-1", "chan-1")).toBeUndefined();
		fail = false;
		expect(await collector.tick()).toBe("collected");
		expect(marks).toEqual(["100000000000000001"]);
		expect(inbox.getSourceState("raya", "founder-1", "chan-1")?.health).toBe(
			"healthy",
		);
	});
});
