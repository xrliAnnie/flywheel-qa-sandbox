import { describe, expect, it } from "vitest";
import type { QueueItem } from "../headphone/queue.js";
import { HeadphoneQueue } from "../headphone/queue.js";
import {
	type HeadphoneIO,
	HeadphoneTurnMachine,
	type PersistedTurnState,
	type TimerHost,
} from "../headphone/turn-machine.js";

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

class FakeTimers implements TimerHost {
	entries = new Map<string, { delayMs: number; fire: () => void }>();
	set(tag: string, delayMs: number, fire: () => void): void {
		this.entries.set(tag, { delayMs, fire });
	}
	clear(tag: string): void {
		this.entries.delete(tag);
	}
	fire(tag: string): void {
		const t = this.entries.get(tag);
		this.entries.delete(tag);
		t?.fire();
	}
	has(tag: string): boolean {
		return this.entries.has(tag);
	}
}

class FakeIO implements HeadphoneIO {
	speaks: Array<{ agentId: string; text: string }> = [];
	stopped = 0;
	sent: Array<{ itemId: string; text: string }> = [];
	receipts: Array<{ itemId: string; transcript: string }> = [];
	approvals: Array<{
		itemId: string;
		transcript: string;
		receiptMessageId: string;
	}> = [];
	calls: string[] = [];
	persisted: PersistedTurnState[] = [];
	sendResult: { ok: boolean; sentMessageId?: string } = {
		ok: true,
		sentMessageId: "sent-1",
	};
	receiptResult: { ok: boolean; receiptMessageId?: string } = {
		ok: true,
		receiptMessageId: "receipt-1",
	};
	approvalResult: { ok: boolean; reason?: string; warning?: string } = {
		ok: true,
	};
	private pendingSpeaks: Array<() => void> = [];
	private clock = 1_000;

	speak(agentId: string, text: string): Promise<void> {
		this.speaks.push({ agentId, text });
		this.calls.push(`speak:${text}`);
		return new Promise((r) => this.pendingSpeaks.push(r));
	}
	/** resolve all outstanding speak() promises (playback finished). */
	finishSpeaking(): void {
		const pending = this.pendingSpeaks.splice(0);
		for (const r of pending) r();
	}
	stopSpeaking(): void {
		this.stopped++;
	}
	async sendReply(
		item: QueueItem,
		text: string,
	): Promise<{ ok: boolean; sentMessageId?: string }> {
		this.sent.push({ itemId: item.id, text });
		this.calls.push(`send:${text}`);
		return this.sendResult;
	}
	async postReceipt(
		item: QueueItem,
		transcript: string,
	): Promise<{ ok: boolean; receiptMessageId?: string }> {
		this.receipts.push({ itemId: item.id, transcript });
		this.calls.push("receipt");
		return this.receiptResult;
	}
	async submitApproval(
		item: QueueItem,
		transcript: string,
		receiptMessageId: string,
	): Promise<{ ok: boolean; reason?: string }> {
		this.approvals.push({ itemId: item.id, transcript, receiptMessageId });
		this.calls.push("approve");
		return this.approvalResult;
	}
	persist(state: unknown): void {
		this.persisted.push(structuredClone(state) as PersistedTurnState);
	}
	now(): number {
		return this.clock;
	}
	advance(ms: number): void {
		this.clock += ms;
	}
	lastSpeak(): string {
		return this.speaks[this.speaks.length - 1]?.text ?? "";
	}
}

const item = (n: number, over: Partial<QueueItem> = {}): QueueItem => ({
	id: `item-${n}`,
	messageId: `msg-${n}`,
	channelId: "chan-1",
	agentId: "tadashi",
	kind: "normal",
	headline: {
		agentDisplay: "Tadashi",
		issueRef: `FLY-90${n}`,
		issueTitle: "标题",
		stageHint: "进度",
	},
	body: `正文 ${n}`,
	enqueuedAt: "2026-07-07T00:00:00.000Z",
	...over,
});

const shipGate = (n: number, over: Partial<QueueItem> = {}): QueueItem =>
	item(n, {
		kind: "ship_gate",
		gate: {
			gateMessageId: `gate-msg-${n}`,
			questionId: `q-${n}`,
			prHeadSha: "abc123",
			issueId: `FLY-90${n}`,
		},
		...over,
	});

function build(
	opts: { items?: QueueItem[]; restore?: PersistedTurnState } = {},
) {
	const io = new FakeIO();
	const timers = new FakeTimers();
	const queue = new HeadphoneQueue();
	for (const i of opts.items ?? []) queue.push(i);
	const offCalls: Array<{
		processed: number;
		remaining: number;
		reason: string;
	}> = [];
	const m = new HeadphoneTurnMachine({
		io,
		queue,
		timers,
		onModeOff: (r) => offCalls.push(r),
		restore: opts.restore,
	});
	return { io, timers, queue, m, offCalls };
}

/** drive: start mode, finish the first announcement so we sit at the ask. */
async function startToDisposition(ctx: ReturnType<typeof build>) {
	ctx.m.handleEvent({ type: "start" });
	ctx.io.finishSpeaking();
	await flush();
	expect(ctx.m.state).toBe("awaiting_disposition");
}

describe("HeadphoneTurnMachine — core turn loop", () => {
	it("start with empty queue → idle; queue_pushed announces headline+body in the agent voice", async () => {
		const ctx = build();
		ctx.m.handleEvent({ type: "start" });
		expect(ctx.m.state).toBe("idle");
		ctx.queue.push(item(1));
		ctx.m.handleEvent({ type: "queue_pushed" });
		expect(ctx.m.state).toBe("announcing");
		expect(ctx.io.speaks[0]).toEqual({
			agentId: "tadashi",
			text: "我是 Tadashi。FLY-901,标题——进度。正文 1",
		});
		// announce_done → ask, same agent voice, ship_gate and normal alike
		ctx.io.finishSpeaking();
		await flush();
		expect(ctx.m.state).toBe("awaiting_disposition");
		expect(ctx.io.lastSpeak()).toBe("要回吗?");
		expect(ctx.io.speaks[1]?.agentId).toBe("tadashi");
	});

	it("announces per-agent voices (换 agent 换声线)", async () => {
		const ctx = build({
			items: [
				item(1),
				item(2, {
					agentId: "honey-lemon",
					headline: { agentDisplay: "Honey Lemon" },
				}),
			],
		});
		await startToDisposition(ctx);
		ctx.m.handleEvent({ type: "utterance", text: "不用" });
		expect(ctx.io.speaks.at(-1)?.agentId).toBe("honey-lemon");
	});

	it("long body (>400 chars) → headline + first two sentences + 要听全文吗? → detail choice; CONFIRM plays full text", async () => {
		const body = `${"第一句。第二句。"}${"废".repeat(400)}。`;
		const ctx = build({ items: [item(1, { body })] });
		ctx.m.handleEvent({ type: "start" });
		expect(ctx.m.state).toBe("awaiting_detail_choice");
		expect(ctx.io.speaks[0]?.text).toContain("第一句。第二句。");
		expect(ctx.io.speaks[0]?.text).toContain("要听全文吗?");
		expect(ctx.io.speaks[0]?.text).not.toContain("废废废");
		ctx.m.handleEvent({ type: "utterance", text: "对" });
		expect(ctx.m.state).toBe("announcing");
		expect(ctx.io.lastSpeak()).toContain("废废废");
	});

	it("detail choice SKIP (or silence) skips the full text and goes to the ask", () => {
		const body = `第一句。${"废".repeat(500)}`;
		const ctx = build({ items: [item(1, { body })] });
		ctx.m.handleEvent({ type: "start" });
		ctx.m.handleEvent({ type: "utterance", text: "不用" });
		expect(ctx.m.state).toBe("awaiting_disposition");
		expect(ctx.io.lastSpeak()).toBe("要回吗?");

		const ctx2 = build({ items: [item(1, { body })] });
		ctx2.m.handleEvent({ type: "start" });
		ctx2.timers.fire("silence");
		expect(ctx2.m.state).toBe("awaiting_disposition");
	});

	it("barge-in: founder_speaking_start during announcing stops TTS and keeps the item context", async () => {
		const ctx = build({ items: [item(1)] });
		ctx.m.handleEvent({ type: "start" });
		expect(ctx.m.state).toBe("announcing");
		ctx.m.handleEvent({ type: "founder_speaking_start" });
		expect(ctx.io.stopped).toBe(1);
		expect(ctx.m.state).toBe("awaiting_disposition");
		// the stale announce_done from the interrupted speak is ignored
		ctx.io.finishSpeaking();
		await flush();
		expect(ctx.m.state).toBe("awaiting_disposition");
		// her utterance then disposes the SAME item
		ctx.m.handleEvent({ type: "utterance", text: "跳过" });
		expect(ctx.m.state).toBe("idle");
	});

	it("SKIP finishes the item and pulls the next; queue empty → idle", async () => {
		const ctx = build({ items: [item(1), item(2)] });
		await startToDisposition(ctx);
		ctx.m.handleEvent({ type: "utterance", text: "不用" });
		expect(ctx.m.state).toBe("announcing");
		expect(ctx.io.lastSpeak()).toContain("正文 2");
		ctx.io.finishSpeaking();
		await flush();
		ctx.m.handleEvent({ type: "utterance", text: "skip" });
		expect(ctx.m.state).toBe("idle");
	});

	it("REPLY → 说吧 → dictate → readback → CONFIRM → sendReply → narrate → next; ledger persisted", async () => {
		const ctx = build({ items: [item(1)] });
		await startToDisposition(ctx);
		ctx.m.handleEvent({ type: "utterance", text: "要回" });
		expect(ctx.m.state).toBe("dictating");
		expect(ctx.io.lastSpeak()).toBe("说吧");
		ctx.m.handleEvent({ type: "utterance", text: "先合成一个,别拆" });
		expect(ctx.m.state).toBe("readback");
		expect(ctx.io.lastSpeak()).toBe("我转告:先合成一个,别拆,发吗?");
		ctx.m.handleEvent({ type: "utterance", text: "确认" });
		expect(ctx.m.state).toBe("sending");
		await flush();
		expect(ctx.io.sent).toEqual([
			{ itemId: "item-1", text: "先合成一个,别拆" },
		]);
		expect(ctx.io.lastSpeak()).toBe("发出了。");
		expect(ctx.m.state).toBe("idle");
		// side-effect ledger reached persistence
		const withLedger = ctx.io.persisted.some(
			(p) => p.currentItem?.sideEffects?.sentMessageId === "sent-1",
		);
		expect(withLedger).toBe(true);
	});

	it("readback DENY once → re-dictate; DENY again → defer to tail", async () => {
		const ctx = build({ items: [item(1), item(2)] });
		await startToDisposition(ctx);
		ctx.m.handleEvent({ type: "utterance", text: "要回" });
		ctx.m.handleEvent({ type: "utterance", text: "内容甲" });
		ctx.m.handleEvent({ type: "utterance", text: "不对" });
		expect(ctx.m.state).toBe("dictating");
		expect(ctx.io.lastSpeak()).toBe("重说一遍?");
		ctx.m.handleEvent({ type: "utterance", text: "内容乙" });
		ctx.m.handleEvent({ type: "utterance", text: "取消" });
		// second DENY → defer, move on to item 2
		expect(ctx.io.sent).toHaveLength(0);
		expect(ctx.m.state).toBe("announcing");
		expect(ctx.io.lastSpeak()).toContain("正文 2");
		expect(ctx.queue.size()).toBe(1); // item-1 back at the tail
	});

	it("PAUSE defers the current item and idles WITHOUT exiting the mode", async () => {
		const ctx = build({ items: [item(1), item(2)] });
		await startToDisposition(ctx);
		ctx.m.handleEvent({ type: "utterance", text: "先停一下" });
		expect(ctx.io.lastSpeak()).toBe("好,先放回队列");
		expect(ctx.m.state).toBe("idle");
		expect(ctx.queue.size()).toBe(2); // item-2 still queued + item-1 deferred back
	});

	it("disposition silence(15s) defers to the tail and moves on", async () => {
		const ctx = build({ items: [item(1), item(2)] });
		await startToDisposition(ctx);
		ctx.timers.fire("silence");
		expect(ctx.io.speaks.map((s) => s.text)).toContain("先放回队尾");
		expect(ctx.m.state).toBe("announcing");
		expect(ctx.io.lastSpeak()).toContain("正文 2");
	});

	it("unclear once → re-ask; unclear twice → defer → next", async () => {
		const ctx = build({ items: [item(1), item(2)] });
		await startToDisposition(ctx);
		ctx.m.handleEvent({ type: "utterance", text: "唔这个嘛" });
		expect(ctx.io.lastSpeak()).toBe("skip 还是要回?");
		expect(ctx.m.state).toBe("awaiting_disposition");
		ctx.m.handleEvent({ type: "utterance", text: "那什么来着" });
		expect(ctx.m.state).toBe("announcing");
		expect(ctx.io.lastSpeak()).toContain("正文 2");
	});

	it("mid-turn queue_pushed stays silent (no announce, no speak)", async () => {
		const ctx = build({ items: [item(1)] });
		await startToDisposition(ctx);
		const speaksBefore = ctx.io.speaks.length;
		ctx.queue.push(item(2));
		ctx.m.handleEvent({ type: "queue_pushed" });
		expect(ctx.io.speaks.length).toBe(speaksBefore);
		expect(ctx.m.state).toBe("awaiting_disposition");
	});
});

describe("HeadphoneTurnMachine — spoken exit (optional path)", () => {
	it("STOP_WORD in disposition → confirm step → CONFIRM → recap + mode OFF + item preserved", async () => {
		const ctx = build({ items: [item(1), item(2)] });
		await startToDisposition(ctx);
		ctx.m.handleEvent({ type: "utterance", text: "芝麻关门" });
		expect(ctx.m.state).toBe("confirm_exit");
		expect(ctx.io.lastSpeak()).toBe("确认结束耳机模式?");
		ctx.m.handleEvent({ type: "utterance", text: "对" });
		expect(ctx.m.state).toBe("off");
		expect(ctx.offCalls).toEqual([
			{ processed: 0, remaining: 2, reason: "spoken_exit" },
		]);
		// in-hand item went back to the queue head
		expect(ctx.queue.peek()?.id).toBe("item-1");
	});

	it("STOP_WORD in idle (queue empty) → confirm → off", async () => {
		const ctx = build();
		ctx.m.handleEvent({ type: "start" });
		ctx.m.handleEvent({ type: "utterance", text: "芝麻关门" });
		expect(ctx.m.state).toBe("confirm_exit");
		ctx.m.handleEvent({ type: "utterance", text: "确认" });
		expect(ctx.m.state).toBe("off");
	});

	it("confirm_exit + anything else → 继续 → back to the previous state", async () => {
		const ctx = build({ items: [item(1)] });
		await startToDisposition(ctx);
		ctx.m.handleEvent({ type: "utterance", text: "芝麻关门" });
		ctx.m.handleEvent({ type: "utterance", text: "等等不是" });
		expect(ctx.io.lastSpeak()).toBe("继续。");
		expect(ctx.m.state).toBe("awaiting_disposition");
		// timeout also returns
		ctx.m.handleEvent({ type: "utterance", text: "芝麻关门" });
		ctx.timers.fire("confirm_exit");
		expect(ctx.m.state).toBe("awaiting_disposition");
	});
});

describe("HeadphoneTurnMachine — §14 c-tier voice approval", () => {
	it("APPROVE_INTENT on a ship_gate item → explicit readback (never skips a step)", async () => {
		const ctx = build({ items: [shipGate(1)] });
		await startToDisposition(ctx); // announce→ask happens for ship_gate too
		ctx.m.handleEvent({ type: "utterance", text: "ship 吧" });
		expect(ctx.m.state).toBe("awaiting_approval_confirm");
		expect(ctx.io.lastSpeak()).toBe("你确认把 FLY-901 ship 上线?");
		// nothing written yet
		expect(ctx.io.receipts).toHaveLength(0);
		expect(ctx.io.approvals).toHaveLength(0);
	});

	it("CONFIRM → receipt FIRST, then approval bound to the receipt id → narrate", async () => {
		const ctx = build({ items: [shipGate(1)] });
		await startToDisposition(ctx);
		ctx.m.handleEvent({ type: "utterance", text: "ship 吧" });
		ctx.m.handleEvent({ type: "utterance", text: "确认" });
		await flush();
		expect(
			ctx.io.calls.filter((c) => c === "receipt" || c === "approve"),
		).toEqual(["receipt", "approve"]);
		expect(ctx.io.approvals[0]?.receiptMessageId).toBe("receipt-1");
		expect(ctx.io.lastSpeak()).toBe("已 ship。");
		expect(ctx.m.state).toBe("idle");
		// ledger ordering: the receipt id persists BEFORE the approval call and
		// the attempt id only AFTER it returned — a crash before/during the call
		// leaves no attempt marker, so boot recovery re-queues the turn instead
		// of suppressing it (a confirmed approval is never silently lost).
		const receiptOnly = ctx.io.persisted.some(
			(p) =>
				p.currentItem?.sideEffects?.receiptMessageId === "receipt-1" &&
				!p.currentItem?.sideEffects?.approvalAttemptId,
		);
		const withAttempt = ctx.io.persisted.some(
			(p) => p.currentItem?.sideEffects?.approvalAttemptId === "item-1",
		);
		expect(receiptOnly).toBe(true);
		expect(withAttempt).toBe(true);
	});

	it("a written approval whose post-write hook did not confirm narrates the warning, not a clean 已 ship", async () => {
		const ctx = build({ items: [shipGate(1)] });
		ctx.io.approvalResult = {
			ok: true,
			warning: "批准已写入,但后续推进没确认,回屏幕看一眼。",
		};
		await startToDisposition(ctx);
		ctx.m.handleEvent({ type: "utterance", text: "ship 吧" });
		ctx.m.handleEvent({ type: "utterance", text: "确认" });
		await flush();
		expect(ctx.io.lastSpeak()).toBe(
			"批准已写入,但后续推进没确认,回屏幕看一眼。",
		);
		expect(ctx.m.state).toBe("idle");
	});

	it("receipt failure → NO approval write (receipt-first is a hard gate)", async () => {
		const ctx = build({ items: [shipGate(1)] });
		ctx.io.receiptResult = { ok: false };
		await startToDisposition(ctx);
		ctx.m.handleEvent({ type: "utterance", text: "ship 吧" });
		ctx.m.handleEvent({ type: "utterance", text: "确认" });
		await flush();
		expect(ctx.io.approvals).toHaveLength(0);
		expect(ctx.m.state).toBe("idle");
	});

	it("DENY → no receipt, no approval, narrate and finish", async () => {
		const ctx = build({ items: [shipGate(1)] });
		await startToDisposition(ctx);
		ctx.m.handleEvent({ type: "utterance", text: "ship 吧" });
		ctx.m.handleEvent({ type: "utterance", text: "不批" });
		expect(ctx.io.receipts).toHaveLength(0);
		expect(ctx.io.approvals).toHaveLength(0);
		expect(ctx.m.state).toBe("idle");
	});

	it("unclear repeats the readback verbatim ONCE; second unclear → no write, finish", async () => {
		const ctx = build({ items: [shipGate(1)] });
		await startToDisposition(ctx);
		ctx.m.handleEvent({ type: "utterance", text: "ship 吧" });
		ctx.m.handleEvent({ type: "utterance", text: "嗯……那个" });
		expect(ctx.io.lastSpeak()).toBe("你确认把 FLY-901 ship 上线?");
		expect(ctx.m.state).toBe("awaiting_approval_confirm");
		ctx.m.handleEvent({ type: "utterance", text: "还是再想想" });
		expect(ctx.io.approvals).toHaveLength(0);
		expect(ctx.m.state).toBe("idle");
	});

	it("silence(15s) in the approval state NEVER writes (silence ≠ consent)", async () => {
		const ctx = build({ items: [shipGate(1)] });
		await startToDisposition(ctx);
		ctx.m.handleEvent({ type: "utterance", text: "ship 吧" });
		ctx.timers.fire("silence");
		expect(ctx.io.approvals).toHaveLength(0);
		expect(ctx.m.state).toBe("idle");
	});

	it("STOP_WORD in the approval state discards the attempt FIRST, then confirm-exit", async () => {
		const ctx = build({ items: [shipGate(1)] });
		await startToDisposition(ctx);
		ctx.m.handleEvent({ type: "utterance", text: "ship 吧" });
		ctx.m.handleEvent({ type: "utterance", text: "芝麻关门" });
		expect(ctx.m.state).toBe("confirm_exit");
		expect(ctx.io.approvals).toHaveLength(0);
		// confirming exit still never writes
		ctx.m.handleEvent({ type: "utterance", text: "对" });
		expect(ctx.io.approvals).toHaveLength(0);
		expect(ctx.m.state).toBe("off");
	});

	it("APPROVE_INTENT on a NORMAL item never triggers approval", async () => {
		const ctx = build({ items: [item(1)] });
		await startToDisposition(ctx);
		ctx.m.handleEvent({ type: "utterance", text: "批准" });
		expect(ctx.m.state).toBe("idle");
		expect(ctx.io.lastSpeak()).toContain("回屏幕");
		expect(ctx.io.approvals).toHaveLength(0);
	});
});

describe("HeadphoneTurnMachine — presence / disconnect grace (Annie ④)", () => {
	it("reconnect within grace resumes the SAME item at its phase (ask → re-ask), no duplicate side effects", async () => {
		const ctx = build({ items: [item(1)] });
		await startToDisposition(ctx);
		ctx.m.handleEvent({ type: "presence", inVc: false });
		expect(ctx.m.state).toBe("disconnect_grace");
		// 59s later she reconnects (grace timer has NOT fired)
		ctx.io.advance(59_000);
		ctx.m.handleEvent({ type: "presence", inVc: true });
		expect(ctx.m.state).toBe("awaiting_disposition");
		expect(ctx.io.lastSpeak()).toBe("要回吗?");
		// same item still in hand — skipping completes exactly one item
		ctx.m.handleEvent({ type: "utterance", text: "不用" });
		expect(ctx.m.state).toBe("idle");
		expect(ctx.io.sent).toHaveLength(0);
	});

	it("resume replays the entry prompt per itemPhase: announce → replay headline+body", async () => {
		const ctx = build({ items: [item(1)] });
		ctx.m.handleEvent({ type: "start" });
		expect(ctx.m.state).toBe("announcing");
		ctx.m.handleEvent({ type: "presence", inVc: false });
		ctx.m.handleEvent({ type: "presence", inVc: true });
		expect(ctx.m.state).toBe("announcing");
		expect(ctx.io.lastSpeak()).toBe("我是 Tadashi。FLY-901,标题——进度。正文 1");
	});

	it("resume replays dictate/readback prompts", async () => {
		const ctx = build({ items: [item(1)] });
		await startToDisposition(ctx);
		ctx.m.handleEvent({ type: "utterance", text: "要回" });
		ctx.m.handleEvent({ type: "presence", inVc: false });
		ctx.m.handleEvent({ type: "presence", inVc: true });
		expect(ctx.m.state).toBe("dictating");
		expect(ctx.io.lastSpeak()).toBe("说吧");
		ctx.m.handleEvent({ type: "utterance", text: "内容" });
		ctx.m.handleEvent({ type: "presence", inVc: false });
		ctx.m.handleEvent({ type: "presence", inVc: true });
		expect(ctx.m.state).toBe("readback");
		expect(ctx.io.lastSpeak()).toBe("我转告:内容,发吗?");
	});

	it("grace timeout (61s) → mode OFF, recap via onModeOff, queue snapshot keeps the item", async () => {
		const ctx = build({ items: [item(1), item(2)] });
		await startToDisposition(ctx);
		ctx.m.handleEvent({ type: "presence", inVc: false });
		ctx.io.advance(61_000);
		ctx.timers.fire("grace");
		expect(ctx.m.state).toBe("off");
		expect(ctx.offCalls).toEqual([
			{ processed: 0, remaining: 2, reason: "vc_exit" },
		]);
		expect(ctx.queue.peek()?.id).toBe("item-1");
	});

	it("leaving mid-approval invalidates the attempt IMMEDIATELY: old readback can never be confirmed", async () => {
		const ctx = build({ items: [shipGate(1)] });
		await startToDisposition(ctx);
		ctx.m.handleEvent({ type: "utterance", text: "ship 吧" });
		expect(ctx.m.state).toBe("awaiting_approval_confirm");
		ctx.m.handleEvent({ type: "presence", inVc: false });
		// item went back to the queue head as a FRESH ship_gate turn
		expect(ctx.queue.peek()?.id).toBe("item-1");
		ctx.m.handleEvent({ type: "presence", inVc: true });
		// resume announces it fresh — we are NOT in the approval state
		expect(ctx.m.state).toBe("announcing");
		// a stray「确认」against the dead readback writes NOTHING
		ctx.m.handleEvent({ type: "utterance", text: "确认" });
		expect(ctx.io.receipts).toHaveLength(0);
		expect(ctx.io.approvals).toHaveLength(0);
	});

	it("presence(false) during sending finishes the send first, then enters grace", async () => {
		const ctx = build({ items: [item(1)] });
		await startToDisposition(ctx);
		ctx.m.handleEvent({ type: "utterance", text: "要回" });
		ctx.m.handleEvent({ type: "utterance", text: "内容" });
		ctx.m.handleEvent({ type: "utterance", text: "确认" });
		expect(ctx.m.state).toBe("sending");
		ctx.m.handleEvent({ type: "presence", inVc: false });
		expect(ctx.m.state).toBe("sending"); // not torn mid-send
		await flush();
		expect(ctx.io.sent).toHaveLength(1);
		expect(ctx.m.state).toBe("disconnect_grace");
	});

	it("STOP_WORD during sending does not take effect", async () => {
		const ctx = build({ items: [item(1)] });
		await startToDisposition(ctx);
		ctx.m.handleEvent({ type: "utterance", text: "要回" });
		ctx.m.handleEvent({ type: "utterance", text: "内容" });
		ctx.m.handleEvent({ type: "utterance", text: "确认" });
		ctx.m.handleEvent({ type: "utterance", text: "芝麻关门" });
		expect(ctx.m.state).toBe("sending");
		await flush();
		expect(ctx.m.state).not.toBe("confirm_exit");
		expect(ctx.io.sent).toHaveLength(1);
	});

	it("disconnect_grace state shape round-trips through persist/restore", async () => {
		const ctx = build({ items: [item(1)] });
		await startToDisposition(ctx);
		ctx.io.advance(500);
		ctx.m.handleEvent({ type: "presence", inVc: false });
		const snap = ctx.io.persisted.at(-1);
		if (!snap) throw new Error("expected persisted state");
		expect(snap.state).toBe("disconnect_grace");
		expect(snap.grace).toMatchObject({
			previousState: "awaiting_disposition",
			currentItemId: "item-1",
			itemPhase: "ask",
		});
		expect(typeof snap.grace?.enteredAtMs).toBe("number");
		// restore into a fresh machine → same externally observable state
		const ctx2 = build({ restore: snap });
		expect(ctx2.m.state).toBe("disconnect_grace");
		ctx2.m.handleEvent({ type: "presence", inVc: true });
		expect(ctx2.m.state).toBe("awaiting_disposition");
		expect(ctx2.io.lastSpeak()).toBe("要回吗?");
	});
});
