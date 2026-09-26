import { canArmVoiceAction, type SpeakReceipt } from "flywheel-voice-core";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
	CodexProofSpeaker,
	type CodexSpeechTransport,
} from "../codex/CodexProofSpeaker.js";

class FakeSpeechTransport implements CodexSpeechTransport {
	readonly sent: Array<{ text: string; generation: number }> = [];
	appendSpeech = vi.fn(async (text: string, generation: number) => {
		this.sent.push({ text, generation });
	});
}

function harness(options: { live?: boolean; confirmTimeoutMs?: number } = {}) {
	const transport = new FakeSpeechTransport();
	const speaker = new CodexProofSpeaker({
		sessionId: "session-a",
		sessionGeneration: () => 9,
		voice: "marin",
		format: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
		transport: () => transport,
		isLive: () => options.live ?? true,
		confirmTimeoutMs: options.confirmTimeoutMs,
	});
	return { speaker, transport };
}

async function completeCurrent(
	speaker: CodexProofSpeaker,
	itemId: string,
	text: string,
): Promise<void> {
	speaker.observeAssistantItem({ generation: 9, itemId });
	speaker.observeTranscript({
		generation: 9,
		itemId,
		role: "assistant",
		text,
		final: true,
	});
	speaker.observePlaybackSubmitted({ generation: 9, itemId });
	await Promise.resolve();
}

describe("Codex proof-bound speak", () => {
	it("models receipts as a discriminated union and arms without a transport predicate", () => {
		const completed: SpeakReceipt = {
			pendingKey: "ship:FLY-1",
			requestDigest: "a".repeat(64),
			outcome: "completed",
			transport: "submitted",
			contentProof: "transcript_equivalent",
		};
		expectTypeOf(completed).toMatchTypeOf<SpeakReceipt>();
		// @ts-expect-error rejected can never claim transported, proven content
		const invalid: SpeakReceipt = {
			pendingKey: "invalid",
			requestDigest: "b".repeat(64),
			outcome: "rejected",
			reason: "not_live",
			transport: "playback_drained",
			contentProof: "transcript_equivalent",
		};
		expect(invalid.outcome).toBe("rejected");
		expect(
			canArmVoiceAction(completed, {
				expectedPendingKey: "ship:FLY-1",
				expectedRequestDigest: "a".repeat(64),
				audibleTail: { drained: true, estimate: true },
			}),
		).toBe(true);
	});

	it("reuses the same promise only for the same key and digest", async () => {
		const h = harness();
		const first = h.speaker.speak("批准 FLY-2799", "readback", {
			pendingKey: "ship:one",
			verification: "required",
			authorityBinding: { issue: "FLY-2799", epoch: 1 },
		});
		const replay = h.speaker.speak("批准 FLY-2799", "readback", {
			pendingKey: "ship:one",
			verification: "required",
			authorityBinding: { issue: "FLY-2799", epoch: 1 },
		});
		expect(replay).toBe(first);
		const conflict = await h.speaker.speak("批准 FLY-2799", "readback", {
			pendingKey: "ship:one",
			verification: "required",
			authorityBinding: { issue: "FLY-2799", epoch: 2 },
		});
		expect(conflict).toMatchObject({
			outcome: "rejected",
			reason: "pending_key_conflict",
			transport: "none",
			contentProof: "none",
		});
		await completeCurrent(h.speaker, "item-one", "批准 F L Y 二 七 九 九");
		await expect(first).resolves.toMatchObject({
			outcome: "completed",
			transport: "submitted",
			contentProof: "transcript_equivalent",
		});
	});

	it("rejects before transport when the session is not live", async () => {
		const h = harness({ live: false });
		await expect(
			h.speaker.speak("hello", "question", { pendingKey: "not-live" }),
		).resolves.toMatchObject({
			outcome: "rejected",
			reason: "not_live",
			transport: "none",
			contentProof: "none",
		});
		expect(h.transport.appendSpeech).not.toHaveBeenCalled();
	});

	it("requires every chunk to have one equivalent final and submitted playback", async () => {
		const h = harness();
		const result = h.speaker.speak("第一句。第二句。", "question", {
			pendingKey: "two-chunks",
			verification: "required",
			chunkCharacters: 4,
		});
		await vi.waitFor(() => expect(h.transport.sent).toHaveLength(1));
		await completeCurrent(h.speaker, "item-a", "第一句。");
		await vi.waitFor(() => expect(h.transport.sent).toHaveLength(2));
		await completeCurrent(h.speaker, "item-b", "第二句。");
		await expect(result).resolves.toMatchObject({
			outcome: "completed",
			contentProof: "transcript_equivalent",
		});
	});

	it("fails required verification on a missing chunk without erasing submitted transport", async () => {
		vi.useFakeTimers();
		const h = harness({ confirmTimeoutMs: 25 });
		const result = h.speaker.speak("必须逐字", "question", {
			pendingKey: "missing",
			verification: "required",
		});
		h.speaker.observeAssistantItem({ generation: 9, itemId: "item-missing" });
		h.speaker.observePlaybackSubmitted({
			generation: 9,
			itemId: "item-missing",
		});
		await vi.advanceTimersByTimeAsync(26);
		await expect(result).resolves.toMatchObject({
			outcome: "failed",
			reason: "speech_proof_timeout",
			transport: "submitted",
			contentProof: "none",
		});
		vi.useRealTimers();
	});

	it("retains a whole-request content proof when playback never submits", async () => {
		vi.useFakeTimers();
		const h = harness({ confirmTimeoutMs: 15 });
		const result = h.speaker.speak("proof without playback", "question", {
			pendingKey: "proof-only",
		});
		h.speaker.observeAssistantItem({ generation: 9, itemId: "item-proof" });
		h.speaker.observeTranscript({
			generation: 9,
			itemId: "item-proof",
			role: "assistant",
			text: "proof without playback",
			final: true,
		});
		await vi.advanceTimersByTimeAsync(16);
		await expect(result).resolves.toMatchObject({
			outcome: "failed",
			transport: "none",
			contentProof: "transcript_equivalent",
		});
		vi.useRealTimers();
	});

	it("fails duplicate finals and numerical substitutions", async () => {
		const duplicate = harness();
		const duplicateResult = duplicate.speaker.speak("编号 123", "readback", {
			pendingKey: "duplicate",
		});
		duplicate.speaker.observeAssistantItem({ generation: 9, itemId: "item-d" });
		for (let index = 0; index < 2; index += 1) {
			duplicate.speaker.observeTranscript({
				generation: 9,
				itemId: "item-d",
				role: "assistant",
				text: "编号 123",
				final: true,
			});
		}
		await expect(duplicateResult).resolves.toMatchObject({
			outcome: "failed",
			reason: "speech_duplicate_final",
		});

		const changed = harness();
		const changedResult = changed.speaker.speak("编号 123", "readback", {
			pendingKey: "changed-number",
		});
		await completeCurrent(changed.speaker, "item-n", "编号 124");
		await expect(changedResult).resolves.toMatchObject({
			outcome: "failed",
			reason: "speech_not_equivalent",
			transport: "submitted",
			contentProof: "none",
		});
	});

	it("drops stale generation observations", async () => {
		vi.useFakeTimers();
		const h = harness({ confirmTimeoutMs: 10 });
		const result = h.speaker.speak("new generation", "question", {
			pendingKey: "stale",
		});
		h.speaker.observeAssistantItem({ generation: 8, itemId: "old" });
		h.speaker.observeTranscript({
			generation: 8,
			itemId: "old",
			role: "assistant",
			text: "new generation",
			final: true,
		});
		h.speaker.observePlaybackSubmitted({ generation: 8, itemId: "old" });
		await vi.advanceTimersByTimeAsync(11);
		await expect(result).resolves.toMatchObject({
			outcome: "failed",
			contentProof: "none",
		});
		vi.useRealTimers();
	});
});
