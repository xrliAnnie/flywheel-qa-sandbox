import { describe, expect, it, vi } from "vitest";
import {
	FakeV1Session,
	type HeadphoneInboxItem,
	HeadphoneMode,
	InboxReader,
	SpokenExitGuard,
} from "../headphone/index.js";
import type { VoiceUtterance } from "../types.js";

function inboxHarness(engine: FakeV1Session) {
	const items: HeadphoneInboxItem[] = [];
	const acked: string[] = [];
	const claimed = new Set<string>();
	const reader = new InboxReader({
		list: async () => items.filter((item) => !acked.includes(item.id)),
		claim: async (item) => {
			const key = `${item.id}:${item.revision}`;
			if (claimed.has(key)) return undefined;
			claimed.add(key);
			return {
				item,
				claimToken: `claim:${key}`,
				attempt: 1,
				pendingKey: `inbox:${item.id}:${item.revision}:fake-session:1:1`,
			};
		},
		ack: async (claim) => {
			acked.push(claim.item.id);
		},
		speak: (text, kind, options) => engine.speak(text, kind, options),
		record: vi.fn(),
		now: () => 0,
	});
	return { items, acked, reader };
}

function item(
	id: string,
	text: string,
	needsDecision: boolean,
): HeadphoneInboxItem {
	return {
		id,
		revision: 1,
		createdAt: "2026-09-23T00:00:00.000Z",
		needsDecision,
		text,
	};
}

function room() {
	return {
		audibleTail: () => ({
			estimated: true as const,
			remainingMs: 0,
			drained: true,
			observedAt: 0,
			sessionId: "fake-session",
			generation: 1,
		}),
	};
}

describe("HeadphoneMode V2 minimum", () => {
	it("speaks every pending question and report immediately on entry, decisions first", async () => {
		const engine = new FakeV1Session();
		const inbox = inboxHarness(engine);
		inbox.items.push(
			item("report", "现在一切正常。", false),
			item("question", "要你决定先做甲还是乙。", true),
		);
		const mode = new HeadphoneMode({
			engine,
			inbox: inbox.reader,
			room: room(),
			record: vi.fn(),
		});

		await mode.start("你是测试 Lead。\n耳机模式。\n退出条款。");

		expect(engine.speakCalls.map(({ text, kind }) => ({ text, kind }))).toEqual(
			[
				{
					text: "我正在整理现在的情况和等你决定的事。",
					kind: "brief",
				},
				{ text: "要你决定先做甲还是乙。", kind: "question" },
				{ text: "现在一切正常。", kind: "brief" },
			],
		);
		expect(inbox.acked).toEqual(["question", "report"]);
		await mode.close();
	});

	it("actively inserts a newly arrived Lead message during the session", async () => {
		const engine = new FakeV1Session();
		const inbox = inboxHarness(engine);
		const mode = new HeadphoneMode({
			engine,
			inbox: inbox.reader,
			room: room(),
			record: vi.fn(),
		});
		await mode.start("context");
		inbox.items.push(item("new", "刚有新消息，需要你决定。", true));

		await mode.notifyInboxChanged();

		expect(engine.speakCalls.at(-1)).toMatchObject({
			text: "刚有新消息，需要你决定。",
			kind: "question",
		});
		expect(inbox.acked).toEqual(["new"]);
		await mode.close();
	});

	it("retries a failed durable ack without speaking the item again", async () => {
		const engine = new FakeV1Session();
		const pending = item("ack-retry", "这条只该念一次。", false);
		const ack = vi
			.fn()
			.mockRejectedValueOnce(new Error("bridge unavailable"))
			.mockResolvedValueOnce(undefined);
		const reader = new InboxReader({
			list: async () => [pending],
			claim: async (claimed) => ({
				item: claimed,
				claimToken: "claim-1",
				attempt: 1,
				pendingKey: "inbox:ack-retry:1:fake-session:1:1",
			}),
			ack,
			speak: (text, kind, options) => engine.speak(text, kind, options),
			record: vi.fn(),
			now: () => 0,
		});
		const mode = new HeadphoneMode({
			engine,
			inbox: reader,
			room: room(),
			record: vi.fn(),
		});

		await mode.start("context");
		await mode.notifyInboxChanged();

		expect(
			engine.speakCalls.filter((call) => call.text === "这条只该念一次。"),
		).toHaveLength(1);
		expect(ack).toHaveBeenCalledTimes(2);
		await mode.close();
	});

	it("speaks one configurable heartbeat after a long quiet period", async () => {
		let now = 0;
		const engine = new FakeV1Session();
		const inbox = inboxHarness(engine);
		const mode = new HeadphoneMode({
			engine,
			inbox: inbox.reader,
			room: room(),
			heartbeatIntervalMs: 5_000,
			now: () => now,
			setTimeoutFn: (() => 1 as unknown as NodeJS.Timeout) as typeof setTimeout,
			clearTimeoutFn: vi.fn(),
			record: vi.fn(),
		});
		await mode.start("context");
		now = 5_000;

		await mode.checkHeartbeat();

		expect(engine.speakCalls.at(-1)).toMatchObject({
			text: "我还在，有新消息会告诉你。",
			kind: "heartbeat",
			verification: "none",
		});
		await mode.close();
	});

	it("falls back to the complete source text when a three-part brief is invalid", async () => {
		const engine = new FakeV1Session();
		const inbox = inboxHarness(engine);
		inbox.items.push({
			...item("fallback", "原文的末尾也必须保留。", false),
			speechBrief: {
				what: "版本 2 做好了。",
				why: "因为验证通过。",
				next: "下一步请看原文。",
			},
		});
		const mode = new HeadphoneMode({
			engine,
			inbox: inbox.reader,
			room: room(),
			record: vi.fn(),
		});
		await mode.start("context");
		expect(engine.speakCalls[1]?.text).toBe("原文的末尾也必须保留。");
		await mode.close();
	});

	it("speaks an explicit factual opening even when the current inbox is empty", async () => {
		const engine = new FakeV1Session();
		const inbox = inboxHarness(engine);
		const mode = new HeadphoneMode({
			engine,
			inbox: inbox.reader,
			room: room(),
			sourceHealthy: () => false,
			record: vi.fn(),
		});

		await mode.start("context");

		expect(engine.speakCalls.map((call) => call.text)).toEqual([
			"我正在整理现在的情况，但有些消息来源暂时没读全。",
			"有些消息来源暂时没读全，我不能确认现在没有新消息。",
		]);
		await mode.close();
	});
});

function utterance(
	role: "user" | "assistant",
	text: string,
	over: Partial<VoiceUtterance> = {},
): VoiceUtterance {
	return {
		ts: "2026-09-23T00:00:00.000Z",
		timestamp: "2026-09-23T00:00:00.000Z",
		sessionId: "s1",
		generation: 3,
		sequence: 1,
		transcriptId: `${role}-1`,
		utteranceId: `${role}-u1`,
		backendId: "fake-v1",
		source: "engine",
		face: "converse",
		role,
		text,
		final: true,
		attribution:
			role === "user"
				? { kind: "known", speakerUserId: "founder" }
				: { kind: "unknown", reason: "assistant" },
		...over,
	};
}

describe("spoken exit durability guard", () => {
	it("accepts the assistant exit only after a durable founder request in the same generation", () => {
		const guard = new SpokenExitGuard("s1", 3, "founder");
		const request = utterance("user", "先到这里，结束语音", {
			transcriptId: "founder-exit",
		});
		expect(
			guard.observeFounderRequest(request, {
				version: 1,
				durable: true,
				sessionId: "s1",
				transcriptId: "founder-exit",
				contentDigest: "a".repeat(64),
				persistedAt: "2026-09-23T00:00:00.000Z",
			}),
		).toBe(true);
		expect(
			guard.observeAssistant(utterance("assistant", "好，退出语音模式。")),
		).toBe(true);
	});

	it("rejects an assistant exit without a founder durability receipt", () => {
		const guard = new SpokenExitGuard("s1", 3, "founder");
		expect(
			guard.observeAssistant(utterance("assistant", "好，退出语音模式。")),
		).toBe(false);
	});
});
