/**
 * PRD §17 逐字 worked example — THE contract test (plan B1-3.4).
 * If the PRD wording changes, change THIS test first, then the machine.
 *
 * Scenario (PRD §17 "逐字 worked example"): queue = Tadashi/FLY-906 ·
 * Honey Lemon/FLY-880 · (mid-turn) Tadashi/FLY-901(ship gate)。
 * skip → 要回代发 → mid-turn 静默入队 → c 档语音批准全链 → 芝麻关门+确认退出。
 */
import { describe, expect, it } from "vitest";
import type { QueueItem } from "../headphone/queue.js";
import { HeadphoneQueue } from "../headphone/queue.js";
import {
	type HeadphoneIO,
	HeadphoneTurnMachine,
	type TimerHost,
} from "../headphone/turn-machine.js";

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

class Timers implements TimerHost {
	set(): void {}
	clear(): void {}
}

class ScriptIO implements HeadphoneIO {
	log: string[] = [];
	private pending: Array<() => void> = [];
	speak(agentId: string, text: string): Promise<void> {
		this.log.push(`🔊[${agentId}] ${text}`);
		return new Promise((r) => this.pending.push(r));
	}
	finishSpeaking(): void {
		for (const r of this.pending.splice(0)) r();
	}
	stopSpeaking(): void {}
	async sendReply(
		item: QueueItem,
		text: string,
	): Promise<{ ok: boolean; sentMessageId?: string }> {
		this.log.push(`📤[${item.agentId}] ${text}`);
		return { ok: true, sentMessageId: "sent-880" };
	}
	async postReceipt(
		item: QueueItem,
		transcript: string,
	): Promise<{ ok: boolean; receiptMessageId?: string }> {
		this.log.push(`🧾[${item.headline.issueRef}] ${transcript}`);
		return { ok: true, receiptMessageId: "receipt-901" };
	}
	async submitApproval(
		item: QueueItem,
		_transcript: string,
		receiptMessageId: string,
	): Promise<{ ok: boolean; reason?: string }> {
		this.log.push(`✅[${item.headline.issueRef}] receipt=${receiptMessageId}`);
		return { ok: true };
	}
	persist(): void {}
	now(): number {
		return 0;
	}
}

const msg906: QueueItem = {
	id: "i-906",
	messageId: "m-906",
	channelId: "thread-906",
	agentId: "tadashi",
	kind: "normal",
	headline: {
		agentDisplay: "Tadashi",
		issueRef: "FLY-906",
		issueTitle: "语音产品设计",
		stageHint: "PRD 写到详细交互流了",
	},
	body: "有个动作想跟你确认:要不要现在把结论落地那块也画进去?",
	enqueuedAt: "2026-07-07T00:00:00.000Z",
};

const msg880: QueueItem = {
	id: "i-880",
	messageId: "m-880",
	channelId: "thread-880",
	agentId: "honey-lemon",
	kind: "normal",
	headline: {
		agentDisplay: "Honey Lemon",
		issueRef: "FLY-880",
		issueTitle: "内部 PM agent",
		stageHint: "那个共创流程 doc,Tadashi 想让我确认要不要拆两个子任务",
	},
	body: "",
	enqueuedAt: "2026-07-07T00:01:00.000Z",
};

const msg901: QueueItem = {
	id: "i-901",
	messageId: "m-901",
	channelId: "thread-901",
	agentId: "tadashi",
	kind: "ship_gate",
	headline: {
		agentDisplay: "Tadashi",
		issueRef: "FLY-901",
		issueTitle: "那个 feature-flag 注册",
		stageHint: "CI 绿了,等你点头就 ship",
	},
	body: "",
	enqueuedAt: "2026-07-07T00:02:00.000Z",
	gate: {
		gateMessageId: "gate-901",
		questionId: "q-901",
		prHeadSha: "deadbeef",
		issueId: "FLY-901",
	},
};

describe("PRD §17 worked example — full replay", () => {
	it("replays the three-message session verbatim", async () => {
		const io = new ScriptIO();
		const queue = new HeadphoneQueue();
		queue.push(msg906);
		queue.push(msg880);
		const m = new HeadphoneTurnMachine({
			io,
			queue,
			timers: new Timers(),
		});

		// 「芝麻开门」accepted by the daemon → start
		m.handleEvent({ type: "start" });
		io.finishSpeaking();
		await flush();
		// msg1 announced + asked
		m.handleEvent({ type: "utterance", text: "不用" }); // 「不用,先跳过。」
		io.finishSpeaking();
		await flush();
		// msg2 announced + asked
		m.handleEvent({ type: "utterance", text: "要回" });
		m.handleEvent({ type: "utterance", text: "先合成一个,别拆" });
		m.handleEvent({ type: "utterance", text: "确认" });
		await flush();
		// —— mid-turn: Tadashi's FLY-901 arrives while msg2's send narration
		// is still in flight → silently queued, no interruption ——
		queue.push(msg901);
		m.handleEvent({ type: "queue_pushed" });
		io.finishSpeaking();
		await flush();
		// (queue_pushed fired mid-send; after the send completes the machine
		// pulls FLY-901 as the next item)
		io.finishSpeaking();
		await flush();
		m.handleEvent({ type: "utterance", text: "ship 吧" });
		m.handleEvent({ type: "utterance", text: "确认" });
		await flush();
		io.finishSpeaking();
		await flush();
		// queue empty → idle → she closes the mode
		m.handleEvent({ type: "utterance", text: "芝麻关门" });
		m.handleEvent({ type: "utterance", text: "对" });

		expect(m.state).toBe("off");
		expect(io.log).toEqual([
			"🔊[tadashi] 我是 Tadashi。FLY-906,语音产品设计——PRD 写到详细交互流了。有个动作想跟你确认:要不要现在把结论落地那块也画进去?",
			"🔊[tadashi] 要回吗?",
			"🔊[honey-lemon] 我是 Honey Lemon。FLY-880,内部 PM agent——那个共创流程 doc,Tadashi 想让我确认要不要拆两个子任务。",
			"🔊[honey-lemon] 要回吗?",
			"🔊[honey-lemon] 说吧",
			"🔊[honey-lemon] 我转告:先合成一个,别拆,发吗?",
			"📤[honey-lemon] 先合成一个,别拆",
			"🔊[honey-lemon] 发出了。",
			"🔊[tadashi] 我是 Tadashi。FLY-901,那个 feature-flag 注册——CI 绿了,等你点头就 ship。",
			"🔊[tadashi] 要回吗?",
			"🔊[tadashi] 你确认把 FLY-901 ship 上线?",
			"🧾[FLY-901] 确认",
			"✅[FLY-901] receipt=receipt-901",
			"🔊[tadashi] 已 ship。",
			"🔊[system] 确认结束耳机模式?",
			"🔊[system] 好。这次处理了 3 条,剩 0 条留在 Discord。耳机模式结束。",
		]);
	});
});
