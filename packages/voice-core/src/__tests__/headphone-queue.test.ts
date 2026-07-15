import { describe, expect, it } from "vitest";
import { HeadphoneQueue, type QueueItem } from "../headphone/queue.js";

const item = (n: number, over: Partial<QueueItem> = {}): QueueItem => ({
	id: `item-${n}`,
	messageId: `msg-${n}`,
	channelId: "chan-1",
	agentId: "tadashi",
	kind: "normal",
	headline: { agentDisplay: "Tadashi", issueRef: `FLY-${n}` },
	body: `body ${n}`,
	enqueuedAt: `2026-07-07T00:0${n}:00.000Z`,
	...over,
});

describe("HeadphoneQueue", () => {
	it("preserves FIFO order across push/peek/shift", () => {
		const q = new HeadphoneQueue();
		q.push(item(1));
		q.push(item(2));
		q.push(item(3));
		expect(q.size()).toBe(3);
		expect(q.peek()?.id).toBe("item-1");
		expect(q.shift()?.id).toBe("item-1");
		expect(q.shift()?.id).toBe("item-2");
		expect(q.shift()?.id).toBe("item-3");
		expect(q.shift()).toBeUndefined();
	});

	it("defer() moves an item to the tail", () => {
		const q = new HeadphoneQueue();
		q.push(item(1));
		q.push(item(2));
		const first = q.shift();
		if (!first) throw new Error("expected item");
		q.defer(first);
		expect(q.shift()?.id).toBe("item-2");
		expect(q.shift()?.id).toBe("item-1");
	});

	it("deferToFront() puts an item back at the head (disconnect recovery)", () => {
		const q = new HeadphoneQueue();
		q.push(item(2));
		q.deferToFront(item(1));
		expect(q.shift()?.id).toBe("item-1");
	});

	it("snapshot()/restore() round-trips deep-equal", () => {
		const q = new HeadphoneQueue();
		q.push(item(1, { sideEffects: { sentMessageId: "sent-1" } }));
		q.push(
			item(2, {
				kind: "ship_gate",
				gate: {
					gateMessageId: "g-1",
					questionId: "q-1",
					prHeadSha: "abc",
					issueId: "FLY-2",
				},
			}),
		);
		const snap = q.snapshot();
		const q2 = new HeadphoneQueue();
		q2.restore(snap);
		expect(q2.snapshot()).toEqual(snap);
		expect(q2.size()).toBe(2);
		expect(q2.peek()?.sideEffects?.sentMessageId).toBe("sent-1");
	});

	it("calls onPersist on every mutation (push/shift/defer/restore)", () => {
		let calls = 0;
		const q = new HeadphoneQueue({ onPersist: () => calls++ });
		q.push(item(1));
		expect(calls).toBe(1);
		q.push(item(2));
		expect(calls).toBe(2);
		const it1 = q.shift();
		expect(calls).toBe(3);
		if (!it1) throw new Error("expected item");
		q.defer(it1);
		expect(calls).toBe(4);
	});

	it("deduplicates by messageId (a re-delivered gateway event is not a new item)", () => {
		const q = new HeadphoneQueue();
		expect(q.push(item(1))).toBe(true);
		expect(q.push(item(2, { messageId: "msg-1", id: "item-other" }))).toBe(
			false,
		);
		expect(q.size()).toBe(1);
	});

	it("dedupe survives shift (an already-announced message must not re-enqueue)", () => {
		const q = new HeadphoneQueue();
		q.push(item(1));
		q.shift();
		expect(q.push(item(1))).toBe(false);
		expect(q.size()).toBe(0);
	});

	it("dedupe state survives snapshot/restore", () => {
		const q = new HeadphoneQueue();
		q.push(item(1));
		q.shift();
		const q2 = new HeadphoneQueue();
		q2.restore(q.snapshot());
		expect(q2.push(item(1))).toBe(false);
	});
});
