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
