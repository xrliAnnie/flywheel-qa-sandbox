import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { expect, it, vi } from "vitest";
import { InMemoryInboundCursorStore } from "../../lead-backends/codex/InboundCursorStore.js";
import { StateStore } from "../../StateStore.js";
import { GatePoller, type GatePollerConfig } from "../gate-poller.js";

const location = vi.hoisted(() => ({ path: "" }));
vi.mock("../session-capture.js", async (original) => ({
	...(await original<object>()),
	defaultGetCommDbPath: () => location.path,
}));

it("rotates no-session asks within the existing read budget and audits answered linked questions", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ask-scan-"));
	location.path = join(dir, "comm.db");
	const db = new CommDB(location.path);
	const store = await StateStore.create(":memory:");
	const founder = "123456789012345678";
	const asked = Date.now() - 60_000;
	const message = ((BigInt(asked + 1000) - 1420070400000n) << 22n).toString();
	const changed = vi.fn();
	const get = vi.fn(async () => ({
		ok: true,
		status: 200,
		json: async () => [
			{ id: message, content: "reply", author: { id: founder } },
		],
	}));
	try {
		for (const n of [1, 2]) {
			store.upsertChatThread(
				`22345678901234567${n}`,
				"323456789012345678",
				`TEST-${n}`,
				"lead",
			);
			store.insertFounderAsk({
				ask_id: `ask-${n}`,
				project_name: "test",
				issue_id: `TEST-${n}`,
				channel_id: "323456789012345678",
				thread_id: `22345678901234567${n}`,
				lead_id: "lead",
				question_id: null,
				excerpt: "Decide",
				asked_at: new Date(asked).toISOString(),
			});
			store.backfillFounderAskMessage(`ask-${n}`, `message-${n}`);
		}
		const config = {
			pollIntervalMs: 3000,
			projects: [
				{
					projectName: "test",
					projectRoot: "/tmp/test",
					leads: [
						{
							agentId: "lead",
							chatChannel: "323456789012345678",
							botToken: "fixture",
							match: { labels: [] },
						},
					],
				},
			],
			store,
			runtimeRegistry: { getForLead: () => undefined },
			chatThreadsEnabled: true,
			discordOwnerUserId: founder,
			founderReplyScanBudget: 1,
			cursorStore: new InMemoryInboundCursorStore(),
			fetchImpl: get,
			onFounderAttentionChange: changed,
		} as unknown as GatePollerConfig;
		const poller = new GatePoller(config) as unknown as {
			founderReplyDeliverPass(): Promise<void>;
		};
		await poller.founderReplyDeliverPass();
		expect(get).toHaveBeenCalledTimes(1);
		expect(store.listOpenFounderAsks("test")).toHaveLength(1);
		await poller.founderReplyDeliverPass();
		expect(get).toHaveBeenCalledTimes(2);
		expect(store.listOpenFounderAsks("test")).toHaveLength(0);
		const q = db.insertQuestion("runner", "lead", "decision");
		store.insertFounderAsk({
			ask_id: "linked",
			project_name: "test",
			issue_id: "TEST-3",
			channel_id: "323456789012345678",
			thread_id: "223456789012345673",
			lead_id: "lead",
			question_id: q,
			excerpt: "Decide",
			asked_at: new Date(asked).toISOString(),
		});
		store.backfillFounderAskMessage("linked", "message-3");
		db.insertResponse(q, "lead", "answered");
		await poller.founderReplyDeliverPass();
		expect(store.getFounderAsk("linked")?.settled_by).toBe("question_answered");
		expect(
			store
				.getEventsByExecution("lead:lead")
				.some(
					(e) =>
						e.event_type === "founder_ask_settled" &&
						e.payload.askId === "linked",
				),
		).toBe(true);
	} finally {
		store.close();
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
