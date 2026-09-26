import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

it("records a founder ask and settles only asks preceding the founder reply, idempotently", async () => {
	const store = await StateStore.create(":memory:");
	try {
		const input = {
			ask_id: "ask-1",
			project_name: "example",
			issue_id: "issue-1",
			channel_id: "channel-1",
			thread_id: "thread-1",
			lead_id: "lead-1",
			question_id: null,
			excerpt: "Which option?",
			asked_at: "2026-09-15T22:00:00.000Z",
		};
		store.insertFounderAsk(input);
		store.insertFounderAsk({
			...input,
			ask_id: "ask-2",
			asked_at: "2026-09-15T22:02:00.000Z",
		});
		store.backfillFounderAskMessage("ask-1", "message-1");
		expect(store.listOpenFounderAsks("example", "issue-1")).toHaveLength(2);
		expect(store.listOpenFounderAsks("other")).toEqual([]);
		const reply = {
			threadId: "thread-1",
			beforeMs: Date.parse("2026-09-15T22:01:00.000Z"),
			messageId: "reply-1",
		};
		expect(store.settleFounderAsksByThread(reply)).toBe(1);
		expect(store.settleFounderAsksByThread(reply)).toBe(0);
		expect(
			store.listOpenFounderAsks("example").map((row) => row.ask_id),
		).toEqual(["ask-2"]);
		const events = store.getEventsByExecution("lead:lead-1");
		expect(events.map((event) => event.event_type).sort()).toEqual([
			"founder_ask_lit",
			"founder_ask_settled",
		]);
		expect(
			events.find((event) => event.event_type === "founder_ask_settled")
				?.payload,
		).toMatchObject({
			askId: "ask-1",
			settledBy: "founder_reply",
			settledMessageId: "reply-1",
		});
	} finally {
		store.close();
	}
});

it("preserves asks across migration/reopen and rolls settlement back when its audit fails", async () => {
	const dir = mkdtempSync(join(tmpdir(), "founder-ask-"));
	const path = join(dir, "fixture.db");
	let store = await StateStore.create(path);
	const db = new Database(path);
	try {
		store.insertFounderAsk({
			ask_id: "ask-1",
			project_name: "example",
			issue_id: "x' OR 1=1 --",
			channel_id: "channel-1",
			thread_id: "thread-1",
			lead_id: "lead-1",
			question_id: null,
			excerpt: "🍀".repeat(130),
			asked_at: "2026-09-15T22:00:00.000Z",
		});
		store.close();
		store = await StateStore.create(path);
		expect(
			store.listOpenFounderAsks("example", "x' OR 1=1 --")[0]?.excerpt,
		).toBe("🍀".repeat(120));
		db.exec(
			"CREATE TRIGGER refuse_ask_audit BEFORE INSERT ON session_events WHEN NEW.event_type='founder_ask_settled' BEGIN SELECT RAISE(ABORT, 'audit_failed'); END",
		);
		expect(() => store.settleFounderAsk("ask-1", "lead_withdrawn")).toThrow(
			"audit_failed",
		);
		expect(store.getFounderAsk("ask-1")?.settled_at).toBeNull();
		db.exec("DROP TRIGGER refuse_ask_audit");
		expect(store.settleFounderAsk("ask-1", "lead_withdrawn")).toBe(true);
		expect(store.settleFounderAsk("ask-1", "lead_withdrawn")).toBe(false);
		store.close();
		store = await StateStore.create(path);
		expect(store.listOpenFounderAsks("example")).toEqual([]);
		expect(store.getFounderAsk("ask-1")?.settled_by).toBe("lead_withdrawn");
	} finally {
		store.close();
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("keeps no-session clear obligations dirty across settlement and recovered thread binding", async () => {
	const store = await StateStore.create(":memory:");
	try {
		store.upsertChatThread("new-thread", "channel", "issue");
		const clean = () =>
			store.setChatThreadDisplayFingerprint(
				"issue",
				"channel",
				"landed",
				new Date().toISOString(),
			);
		store.insertFounderAsk({
			ask_id: "ask",
			project_name: "example",
			issue_id: "issue",
			channel_id: "channel",
			thread_id: "old-thread",
			lead_id: "lead",
			question_id: null,
			excerpt: "Decide",
			asked_at: new Date().toISOString(),
		});
		clean();
		store.backfillFounderAskMessage("ask", "message", "new-thread");
		expect(store.getFounderAsk("ask")?.thread_id).toBe("new-thread");
		expect(
			store.listDisplayReconcileCandidates(null, 50)[0]?.display_fingerprint,
		).toBeNull();
		expect(store.listDisplaySweepActiveIssues(null, 10)).toEqual([
			{ issue_id: "issue", channel_id: "channel" },
		]);
		clean();
		store.settleFounderAsk("ask", "lead_withdrawn");
		expect(
			store.listDisplayReconcileCandidates(null, 50)[0]?.display_fingerprint,
		).toBeNull();
		expect(store.getLatestFounderAskForIssue("issue")?.settled_by).toBe(
			"lead_withdrawn",
		);
		expect(store.listDisplaySweepActiveIssues(null, 10)).toEqual([]);
	} finally {
		store.close();
	}
});

it("pages open ask scan targets, including no-session threads, without settled history", async () => {
	const store = await StateStore.create(":memory:");
	try {
		for (const n of [1, 2, 3]) {
			store.insertFounderAsk({
				ask_id: `ask-${n}`,
				project_name: "example",
				issue_id: `issue-${n}`,
				channel_id: "channel",
				thread_id: `thread-${n}`,
				lead_id: "lead",
				question_id: null,
				excerpt: "Decide",
				asked_at: new Date().toISOString(),
			});
			store.backfillFounderAskMessage(`ask-${n}`, `message-${n}`);
		}
		expect(
			store
				.listFounderAskScanTargets("example", null, 2)
				.map((r) => r.thread_id),
		).toEqual(["thread-1", "thread-2"]);
		expect(
			store
				.listFounderAskScanTargets("example", "thread-2", 2)
				.map((r) => r.thread_id),
		).toEqual(["thread-3"]);
		store.settleFounderAsk("ask-3", "lead_withdrawn");
		expect(store.listFounderAskScanTargets("example", "thread-2", 2)).toEqual(
			[],
		);
	} finally {
		store.close();
	}
});

it("FLY-2914 binds at most one open patrol ask per project + schedule key", async () => {
	const store = await StateStore.create(":memory:");
	try {
		const key = "a".repeat(64);
		const input = {
			ask_id: "11111111-1111-4111-8111-111111111111",
			project_name: "flywheel",
			issue_id: "FLY-2373",
			channel_id: "channel-1",
			thread_id: "thread-1",
			lead_id: "flywheel-eng-lead",
			question_id: null,
			excerpt: "请排修 FLY-2373",
			asked_at: "2026-09-26T06:00:00.000Z",
			patrol_schedule_key: key,
		};
		expect(store.reservePatrolScheduleAsk(input)).toEqual({
			reserved: true,
			ask: expect.objectContaining({ ask_id: input.ask_id, message_id: null }),
		});
		const second = store.reservePatrolScheduleAsk({
			...input,
			ask_id: "22222222-2222-4222-8222-222222222222",
		});
		expect(second).toEqual({
			reserved: false,
			ask: expect.objectContaining({ ask_id: input.ask_id }),
		});
		// the same key in another project is a different category binding
		expect(
			store.reservePatrolScheduleAsk({
				...input,
				ask_id: "33333333-3333-4333-8333-333333333333",
				project_name: "other",
				thread_id: "thread-2",
			}).reserved,
		).toBe(true);
		expect(store.getOpenPatrolScheduleAsk("flywheel", key)?.ask_id).toBe(
			input.ask_id,
		);
		// a raw insert cannot sneak a second open row past the partial unique index
		expect(() =>
			store.insertFounderAsk({
				...input,
				ask_id: "44444444-4444-4444-8444-444444444444",
			}),
		).toThrow();
		store.backfillFounderAskMessage(input.ask_id, "1553272103002709999");
		expect(store.getOpenPatrolScheduleAsk("flywheel", key)?.message_id).toBe(
			"1553272103002709999",
		);
		// after the founder answers, a new episode may be opened for the same key
		expect(
			store.settleFounderAsksByThread({
				threadId: "thread-1",
				beforeMs: Date.parse("2026-09-26T07:00:00.000Z"),
				messageId: "reply-1",
			}),
		).toBe(1);
		expect(store.getOpenPatrolScheduleAsk("flywheel", key)).toBeUndefined();
		expect(
			store.reservePatrolScheduleAsk({
				...input,
				ask_id: "55555555-5555-4555-8555-555555555555",
				asked_at: "2026-09-26T08:00:00.000Z",
			}).reserved,
		).toBe(true);
		// ordinary asks keep a NULL key and never collide
		store.insertFounderAsk({
			...input,
			ask_id: "66666666-6666-4666-8666-666666666666",
			patrol_schedule_key: undefined,
		});
		store.insertFounderAsk({
			...input,
			ask_id: "77777777-7777-4777-8777-777777777777",
			patrol_schedule_key: undefined,
		});
		expect(
			store.getFounderAsk("77777777-7777-4777-8777-777777777777")
				?.patrol_schedule_key,
		).toBeNull();
	} finally {
		store.close();
	}
});

it("FLY-2914 migrates a legacy founder_ask table with a NULL schedule key", async () => {
	const dir = mkdtempSync(join(tmpdir(), "founder-ask-2914-"));
	const path = join(dir, "teamlead.db");
	try {
		const legacy = new Database(path);
		legacy.exec(`CREATE TABLE founder_ask (
			ask_id TEXT PRIMARY KEY, project_name TEXT NOT NULL, issue_id TEXT NOT NULL,
			channel_id TEXT NOT NULL, thread_id TEXT NOT NULL, lead_id TEXT NOT NULL,
			message_id TEXT, question_id TEXT, excerpt TEXT NOT NULL, asked_at TEXT NOT NULL,
			settled_at TEXT, settled_by TEXT, settled_message_id TEXT)`);
		legacy
			.prepare(
				"INSERT INTO founder_ask(ask_id,project_name,issue_id,channel_id,thread_id,lead_id,excerpt,asked_at) VALUES('old','flywheel','FLY-1','c','t','l','x','2026-09-01T00:00:00.000Z')",
			)
			.run();
		legacy.close();
		const store = await StateStore.create(path);
		try {
			expect(store.getFounderAsk("old")?.patrol_schedule_key).toBeNull();
			expect(
				store.getOpenPatrolScheduleAsk("flywheel", "a".repeat(64)),
			).toBeUndefined();
		} finally {
			store.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("FLY-2914 finds only strictly active runs through identifier or UUID aliases", async () => {
	const store = await StateStore.create(":memory:");
	try {
		const uuid = "bff5c1b6-c7f6-4017-9710-52ff55b37c34";
		store.createWorkflowRun({
			runId: "run-uuid",
			issueId: uuid,
			projectName: "flywheel",
			claimsReadEnrolled: false,
		});
		expect(
			store.getActiveWorkflowRunIdForAliases("flywheel", ["FLY-2373", uuid]),
		).toBe("run-uuid");
		expect(
			store.getActiveWorkflowRunIdForAliases("other", ["FLY-2373", uuid]),
		).toBeUndefined();
		(
			store as unknown as { db: { run(sql: string, params: unknown[]): void } }
		).db.run("UPDATE workflow_run SET status='held' WHERE run_id=?", [
			"run-uuid",
		]);
		expect(
			store.getActiveWorkflowRunIdForAliases("flywheel", ["FLY-2373", uuid]),
		).toBeUndefined();
		expect(
			store.getActiveWorkflowRunIdForAliases("flywheel", []),
		).toBeUndefined();
	} finally {
		store.close();
	}
});
