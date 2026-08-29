import type { QueueItem, VoiceSpec } from "flywheel-voice-core";
import { VoiceDirectory } from "flywheel-voice-core";
import { describe, expect, it } from "vitest";
import type { ShipApprovalResult } from "../bridge-client.js";
import { NullAudioIO } from "../null-audio-io.js";

class FakeAnnouncer {
	spoken: Array<{ text: string; voice: VoiceSpec }> = [];
	stops = 0;
	async speak(text: string, voice: VoiceSpec): Promise<void> {
		this.spoken.push({ text, voice });
	}
	stop(): void {
		this.stops++;
	}
}

class FakeSender {
	sent: Array<{ channelId: string; content: string; replyTo?: string }> = [];
	recent: Array<{ id: string; content: string }> = [];
	async sendMessage(
		channelId: string,
		content: string,
		replyToMessageId?: string,
	): Promise<string> {
		this.sent.push({ channelId, content, replyTo: replyToMessageId });
		return `sent-${this.sent.length}`;
	}
	async scanRecent(): Promise<Array<{ id: string; content: string }>> {
		return this.recent;
	}
}

class FakeBridge {
	requests: unknown[] = [];
	result: ShipApprovalResult = { ok: true, written: true, kind: "approve" };
	async postShipApproval(body: unknown): Promise<ShipApprovalResult> {
		this.requests.push(body);
		return this.result;
	}
}

const item = (over: Partial<QueueItem> = {}): QueueItem => ({
	id: "item-1",
	messageId: "orig-1",
	channelId: "thread-1",
	agentId: "tadashi",
	authorId: "lead-tadashi-bot",
	kind: "normal",
	headline: { agentDisplay: "Tadashi", issueRef: "FLY-901" },
	body: "正文",
	enqueuedAt: "2026-07-07T00:00:00.000Z",
	...over,
});

function build() {
	const announcer = new FakeAnnouncer();
	const sender = new FakeSender();
	const bridge = new FakeBridge();
	const persisted: unknown[] = [];
	const io = new NullAudioIO({
		announcer,
		directory: new VoiceDirectory(
			{ tadashi: { voiceId: "zh-CN-YunyangNeural" } },
			{ voiceId: "zh-CN-XiaoxiaoNeural" },
		),
		sender,
		bridge,
		founderUserId: "annie-id",
		persist: (s) => persisted.push(s),
	});
	return { announcer, sender, bridge, io, persisted };
}

describe("NullAudioIO (desktop dry-run)", () => {
	it("speak resolves the per-agent voice; system falls back to the default", async () => {
		const { announcer, io } = build();
		await io.speak("tadashi", "你好");
		await io.speak("system", "要回吗?");
		expect(announcer.spoken[0]?.voice.voiceId).toBe("zh-CN-YunyangNeural");
		expect(announcer.spoken[1]?.voice.voiceId).toBe("zh-CN-XiaoxiaoNeural");
	});

	it("sendReply posts 🎧 Annie(语音) + @lead + idempotency marker as a reply to the original", async () => {
		const { sender, io } = build();
		const res = await io.sendReply(item(), "先合成一个,别拆");
		expect(res.ok).toBe(true);
		expect(res.sentMessageId).toBe("sent-1");
		const out = sender.sent[0];
		expect(out?.channelId).toBe("thread-1");
		expect(out?.replyTo).toBe("orig-1");
		expect(out?.content).toContain("🎧 Annie(语音)");
		expect(out?.content).toContain("<@lead-tadashi-bot>");
		expect(out?.content).toContain("先合成一个,别拆");
		expect(out?.content).toContain("〔hp:item-1〕");
	});

	it("sendReply adopts an already-delivered marked message instead of re-sending (crash window)", async () => {
		const { sender, io } = build();
		sender.recent = [
			{ id: "pre-existing", content: "🎧 Annie(语音)……〔hp:item-1〕" },
		];
		const res = await io.sendReply(item(), "内容");
		expect(res).toEqual({ ok: true, sentMessageId: "pre-existing" });
		expect(sender.sent).toHaveLength(0);
	});

	it("postReceipt posts the TIV receipt card with gate id / pr head / transcript", async () => {
		const { sender, io } = build();
		const gated = item({
			kind: "ship_gate",
			gate: {
				gateMessageId: "gate-1",
				questionId: "q-1",
				prHeadSha: "sha-1",
				issueId: "FLY-901",
			},
		});
		const res = await io.postReceipt(gated, "确认");
		expect(res.ok).toBe(true);
		const card = sender.sent[0]?.content ?? "";
		expect(card).toContain("语音批准收据");
		expect(card).toContain("q-1");
		expect(card).toContain("sha-1");
		expect(card).toContain("确认");
		expect(card).toContain("FLY-901");
	});

	it("submitApproval passes the gate binding + receipt id + attested founder id to the Bridge", async () => {
		const { bridge, io } = build();
		const gated = item({
			kind: "ship_gate",
			gate: {
				gateMessageId: "gate-1",
				questionId: "q-1",
				prHeadSha: "sha-1",
				issueId: "FLY-901",
			},
		});
		const res = await io.submitApproval(gated, "确认", "receipt-9");
		expect(res.ok).toBe(true);
		expect(bridge.requests[0]).toMatchObject({
			gateMessageId: "gate-1",
			questionId: "q-1",
			prHeadSha: "sha-1",
			receiptMessageId: "receipt-9",
			transcript: { text: "确认", founderUserId: "annie-id" },
		});
	});

	it("a written approval whose post-write hook did not confirm surfaces an honest warning", async () => {
		const { bridge, io } = build();
		bridge.result = {
			ok: true,
			written: true,
			kind: "approve",
			retrySafe: false,
		};
		const gated = item({
			kind: "ship_gate",
			gate: {
				gateMessageId: "g",
				questionId: "q",
				prHeadSha: "s",
				issueId: "FLY-901",
			},
		});
		const res = await io.submitApproval(gated, "确认", "receipt-9");
		expect(res.ok).toBe(true);
		expect(res.warning).toContain("回屏幕");
	});

	it("submitApproval without a gate binding refuses locally (never guesses)", async () => {
		const { bridge, io } = build();
		const res = await io.submitApproval(item(), "确认", "receipt-9");
		expect(res.ok).toBe(false);
		expect(bridge.requests).toHaveLength(0);
	});

	it("a Bridge unclear/reject verdict surfaces as ok:false with the kind", async () => {
		const { bridge, io } = build();
		bridge.result = { ok: true, written: false, kind: "unclear" };
		const gated = item({
			kind: "ship_gate",
			gate: {
				gateMessageId: "g",
				questionId: "q",
				prHeadSha: "s",
				issueId: "FLY-901",
			},
		});
		const res = await io.submitApproval(gated, "唔", "receipt-9");
		expect(res.ok).toBe(false);
		expect(res.reason).toContain("unclear");
	});
});
