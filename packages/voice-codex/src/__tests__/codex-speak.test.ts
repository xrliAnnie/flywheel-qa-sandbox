import { readFileSync } from "node:fs";
import { canArmVoiceAction, type SpeakReceipt } from "flywheel-voice-core";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
	CodexProofSpeaker,
	SPEECH_TRUNCATED_NOTE,
} from "../codex/CodexProofSpeaker.js";
import { prepareReplySpeech } from "../speech.js";

/** What the chunk actually asked to be spoken (and what a mirror keeps). */
const spoken = (text: string) => prepareReplySpeech(text)[0]!.spokenText;

const readback = JSON.parse(
	readFileSync(
		new URL("./fixtures/fly2866-v3-readback.json", import.meta.url),
		"utf8",
	),
) as {
	expected: string;
	transcripts: Array<{ run: string; overrun: boolean; text: string }>;
};

afterEach(() => {
	vi.useRealTimers();
});

/** A silent turn has no app-server final: 2 s final wait, then 600 ms check. */
const SILENT_SETTLE_MS = 2_700;

/** The session side of the speaker, fully controllable. */
function harness(options: { live?: boolean } = {}) {
	vi.useFakeTimers();
	const state = {
		busy: undefined as string | undefined,
		consumed: 0,
		queued: 0,
		interference: 0,
		trims: 0,
		generation: 9,
	};
	const sent: string[] = [];
	const evidence: Record<string, unknown>[] = [];
	const overrun = vi.fn();
	const speaker = new CodexProofSpeaker({
		sessionId: "session-a",
		voice: "cove",
		format: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
		sessionGeneration: () => state.generation,
		transport: () => ({
			appendSpeech: async (text: string) => {
				sent.push(text);
			},
		}),
		isLive: () => options.live ?? true,
		now: () => Date.now(),
		busyReason: () => state.busy,
		consumedVoiced: () => state.consumed,
		queuedVoiced: () => state.queued,
		interference: () => state.interference,
		trims: () => state.trims,
		overrun,
		evidence: (record) => evidence.push(record),
	});
	const flush = () => vi.advanceTimersByTimeAsync(0);
	/** The bound turn plays and finishes: turn.done, then the app-server final. */
	const answer = async (turnId: string, transcript: string | null) => {
		speaker.turnCreated({ turnId, role: "assistant" });
		state.consumed += 10;
		speaker.playbackProgress();
		speaker.turnDone({ turnId, role: "assistant", transcript });
		if (transcript !== null)
			speaker.assistantTranscript({ text: transcript, final: true });
		await flush();
	};
	return { speaker, state, sent, evidence, overrun, flush, answer };
}

describe("Codex v3 read-aloud receipts (FLY-2885 T5b)", () => {
	it("models receipts as a discriminated union and arms without a transport predicate", () => {
		const completed: SpeakReceipt = {
			pendingKey: "ship:FLY-1",
			requestDigest: "a".repeat(64),
			outcome: "completed",
			transport: "submitted",
			contentProof: "transcript_equivalent",
		};
		expectTypeOf(completed).toMatchTypeOf<SpeakReceipt>();
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
		await expect(
			h.speaker.speak("批准 FLY-2799", "readback", {
				pendingKey: "ship:one",
				verification: "required",
				authorityBinding: { issue: "FLY-2799", epoch: 2 },
			}),
		).resolves.toMatchObject({
			outcome: "rejected",
			reason: "pending_key_conflict",
		});
		await h.flush();
		await h.answer("turn-1", "批准 F L Y 二 七 九 九");
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
		).resolves.toMatchObject({ outcome: "rejected", reason: "not_live" });
		expect(h.sent).toEqual([]);
	});

	it("waits for an idle room and gives up after 10 s without sending", async () => {
		const h = harness();
		h.state.busy = "assistant_turn_open";
		const result = h.speaker.speak("你好", "readback", { pendingKey: "busy" });
		await vi.advanceTimersByTimeAsync(9_900);
		expect(h.sent).toEqual([]);
		await vi.advanceTimersByTimeAsync(200);
		await expect(result).resolves.toMatchObject({
			outcome: "rejected",
			reason: "busy_conversation",
			transport: "none",
		});
		expect(h.sent).toEqual([]);
	});

	it("sends as soon as the room turns idle and binds the first assistant turn created after it", async () => {
		const h = harness();
		h.state.busy = "pending_user_turn";
		const result = h.speaker.speak("你好。", "readback", {
			pendingKey: "idle",
		});
		// An answer created before the send is never borrowed, even if it is
		// equivalent.
		h.speaker.turnCreated({ turnId: "natural", role: "assistant" });
		await vi.advanceTimersByTimeAsync(500);
		expect(h.sent).toEqual([]);
		h.speaker.turnDone({
			turnId: "natural",
			role: "assistant",
			transcript: "你好。",
		});
		h.state.busy = undefined;
		await vi.advanceTimersByTimeAsync(60);
		expect(h.sent).toEqual(["你好。"]);
		await h.answer("readback-turn", "你好");
		await expect(result).resolves.toMatchObject({
			outcome: "completed",
			contentProof: "transcript_equivalent",
		});
	});

	it("fails as preempted when the founder speaks before the turn is bound", async () => {
		const h = harness();
		const result = h.speaker.speak("你好", "readback", { pendingKey: "pre" });
		await h.flush();
		h.speaker.userEvidence();
		await expect(result).resolves.toMatchObject({
			outcome: "failed",
			reason: "speech_preempted",
			transport: "none",
		});
	});

	it("re-admits every chunk of a multi-chunk reading", async () => {
		const h = harness();
		const result = h.speaker.speak("第一句。第二句。", "question", {
			pendingKey: "two",
			verification: "required",
			chunkCharacters: 4,
		});
		await h.flush();
		expect(h.sent).toHaveLength(1);
		h.state.busy = "audible";
		await h.answer("t1", "第一句。");
		await vi.advanceTimersByTimeAsync(200);
		expect(h.sent).toHaveLength(1);
		h.state.busy = undefined;
		await vi.advanceTimersByTimeAsync(60);
		expect(h.sent).toHaveLength(2);
		await h.answer("t2", "第二句。");
		await expect(result).resolves.toMatchObject({
			outcome: "completed",
			contentProof: "transcript_equivalent",
		});
	});

	it("fails a chunk whose playback was trimmed", async () => {
		const h = harness();
		const result = h.speaker.speak("你好", "readback", { pendingKey: "trim" });
		await h.flush();
		h.speaker.turnCreated({ turnId: "t", role: "assistant" });
		h.state.consumed += 3;
		h.state.trims += 1;
		h.speaker.turnDone({ turnId: "t", role: "assistant", transcript: "你好" });
		h.speaker.assistantTranscript({ text: "你好", final: true });
		await expect(result).resolves.toMatchObject({
			outcome: "failed",
			reason: "playback_trimmed",
			transport: "submitted",
		});
	});

	it("settles an interrupted chunk by what the player already consumed", async () => {
		const h = harness();
		const result = h.speaker.speak("你好", "readback", { pendingKey: "cut" });
		await h.flush();
		h.speaker.turnCreated({ turnId: "t", role: "assistant" });
		h.state.consumed += 2;
		h.speaker.interrupt();
		await expect(result).resolves.toMatchObject({
			outcome: "failed",
			reason: "speech_interrupted",
			transport: "submitted",
		});
	});

	it.each([
		[0, "none"],
		[4, "submitted"],
	] as const)(
		"reports binding_unavailable after 30 s without a turn (consumed %i → %s)",
		async (consumed, transport) => {
			const h = harness();
			const result = h.speaker.speak("你好", "readback", {
				pendingKey: `unbound-${consumed}`,
			});
			await h.flush();
			h.state.consumed += consumed;
			await vi.advanceTimersByTimeAsync(30_001);
			await expect(result).resolves.toMatchObject({
				outcome: "failed",
				reason: "speech_binding_unavailable",
				transport,
			});
		},
	);

	it("settles an in-flight chunk as generation_changed", async () => {
		const h = harness();
		const result = h.speaker.speak("你好", "readback", { pendingKey: "gen" });
		await h.flush();
		h.speaker.interrupt("generation_changed");
		await expect(result).resolves.toMatchObject({
			reason: "generation_changed",
		});
	});

	it("waits for queued audio when done arrives first instead of calling it silent", async () => {
		const h = harness();
		const result = h.speaker.speak("你好", "readback", { pendingKey: "q" });
		await h.flush();
		h.speaker.turnCreated({ turnId: "t", role: "assistant" });
		h.state.queued = 20;
		h.speaker.turnDone({ turnId: "t", role: "assistant", transcript: "你好" });
		h.speaker.assistantTranscript({ text: "你好", final: true });
		await vi.advanceTimersByTimeAsync(1_000);
		h.state.queued = 0;
		h.state.consumed += 20;
		h.speaker.playbackProgress();
		await expect(result).resolves.toMatchObject({ outcome: "completed" });
	});
});

describe("Codex v3 read-aloud overrun and silence (FLY-2885 T5c)", () => {
	it("cuts an invented continuation, truncates its mirror, and audits it without the text", async () => {
		const h = harness();
		const expected =
			"目前这件事已经进入评审，结果出来之后我会第一时间告诉你，你不用再单独跟进了。";
		const result = h.speaker.speak(expected, "readback", {
			pendingKey: "over",
		});
		await h.flush();
		// Deltas before turn.created still belong to the chunk.
		h.speaker.assistantTranscript({
			text: expected.replace("目前", "现在"),
			final: false,
		});
		expect(h.overrun).not.toHaveBeenCalled();
		h.speaker.turnCreated({ turnId: "t", role: "assistant" });
		h.speaker.assistantTranscript({
			text: "另外今天还有两件事情已经顺利完成了呢。",
			final: false,
		});
		expect(h.overrun).toHaveBeenCalledOnce();
		expect(h.overrun).toHaveBeenCalledWith("t");
		await expect(result).resolves.toMatchObject({
			outcome: "failed",
			reason: "speech_overrun",
			transport: "submitted",
		});
		// The late final is mirrored only up to the line.
		expect(
			h.speaker.truncateAssistantFinal(`${expected}另外今天还有两件事。`),
		).toBe(`${spoken(expected)}${SPEECH_TRUNCATED_NOTE}`);
		await vi.advanceTimersByTimeAsync(600);
		const audit = h.evidence.find(
			(record) => record.kind === "codex_speech_overrun",
		)!;
		expect(audit).toMatchObject({
			pendingKey: "over",
			turnId: "t",
			unalignedChars: expect.any(Number),
			extraTextSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
			stopLatencyMs: 0,
		});
		expect(JSON.stringify(audit)).not.toContain("另外");
	});

	it("stops every real FLY-2866 invented report and never a faithful reading", async () => {
		for (const transcript of readback.transcripts) {
			const h = harness();
			const result = h.speaker.speak(readback.expected, "readback", {
				pendingKey: transcript.run,
			});
			await h.flush();
			h.speaker.turnCreated({ turnId: "t", role: "assistant" });
			for (const char of Array.from(transcript.text))
				h.speaker.assistantTranscript({ text: char, final: false });
			expect(h.overrun.mock.calls.length, transcript.run).toBe(
				transcript.overrun ? 1 : 0,
			);
			if (!transcript.overrun) {
				h.state.consumed += 10;
				h.speaker.turnDone({
					turnId: "t",
					role: "assistant",
					transcript: transcript.text,
				});
				h.speaker.assistantTranscript({ text: transcript.text, final: true });
			}
			await expect(result).resolves.toMatchObject(
				transcript.overrun
					? { reason: "speech_overrun" }
					: { outcome: "completed" },
			);
			vi.useRealTimers();
		}
	});

	it("checks a final with no deltas and truncates that same final", async () => {
		const h = harness();
		const result = h.speaker.speak(readback.expected, "readback", {
			pendingKey: "final-only",
		});
		await h.flush();
		const overrunText = readback.transcripts.find((row) => row.overrun)!.text;
		h.speaker.assistantTranscript({ text: overrunText, final: true });
		expect(h.overrun).toHaveBeenCalledOnce();
		expect(h.speaker.truncateAssistantFinal(overrunText)).toBe(
			`${spoken(readback.expected)}${SPEECH_TRUNCATED_NOTE}`,
		);
		await expect(result).resolves.toMatchObject({ reason: "speech_overrun" });
	});

	it("checks the app-server final that arrives after turn.done before settling (observed v3 order)", async () => {
		const h = harness();
		const result = h.speaker.speak(readback.expected, "readback", {
			pendingKey: "done-first",
		});
		await h.flush();
		const overrunText = readback.transcripts.find((row) => row.overrun)!.text;
		h.speaker.turnCreated({ turnId: "t", role: "assistant" });
		h.state.consumed += 10;
		h.speaker.playbackProgress();
		// probe-run2: data-channel turn.done ~12 ms before transcript/done.
		h.speaker.turnDone({
			turnId: "t",
			role: "assistant",
			transcript: overrunText,
		});
		await h.flush();
		let settled = false;
		void result.then(() => {
			settled = true;
		});
		await h.flush();
		expect(settled).toBe(false);
		h.speaker.assistantTranscript({ text: overrunText, final: true });
		await expect(result).resolves.toMatchObject({
			outcome: "failed",
			reason: "speech_overrun",
			transport: "submitted",
		});
		expect(h.overrun).toHaveBeenCalledWith("t");
		expect(h.speaker.truncateAssistantFinal(overrunText)).toBe(
			`${spoken(readback.expected)}${SPEECH_TRUNCATED_NOTE}`,
		);
	});

	it("settles on the done transcript when the app-server final never comes", async () => {
		const h = harness();
		const result = h.speaker.speak("你好", "readback", {
			pendingKey: "no-final",
		});
		await h.flush();
		h.speaker.turnCreated({ turnId: "t", role: "assistant" });
		h.state.consumed += 10;
		h.speaker.turnDone({ turnId: "t", role: "assistant", transcript: "你好" });
		await vi.advanceTimersByTimeAsync(2_000);
		await expect(result).resolves.toMatchObject({
			outcome: "completed",
			contentProof: "transcript_equivalent",
		});
		expect(h.overrun).not.toHaveBeenCalled();
	});

	it("retries a confirmed-silent chunk once and binds the retry only to a new turn", async () => {
		const h = harness();
		const result = h.speaker.speak("你好", "readback", { pendingKey: "mute" });
		await h.flush();
		h.speaker.turnCreated({ turnId: "silent-1", role: "assistant" });
		h.speaker.turnDone({
			turnId: "silent-1",
			role: "assistant",
			transcript: "你好",
		});
		await vi.advanceTimersByTimeAsync(SILENT_SETTLE_MS);
		expect(h.sent).toEqual(["你好", "你好"]);
		// The first turn's late events cannot settle the retry.
		h.speaker.turnCreated({ turnId: "silent-1", role: "assistant" });
		h.speaker.turnDone({
			turnId: "silent-1",
			role: "assistant",
			transcript: "你好",
		});
		await h.flush();
		h.speaker.turnCreated({ turnId: "silent-2", role: "assistant" });
		h.speaker.turnDone({
			turnId: "silent-2",
			role: "assistant",
			transcript: "你好",
		});
		await vi.advanceTimersByTimeAsync(SILENT_SETTLE_MS);
		await expect(result).resolves.toMatchObject({
			outcome: "failed",
			reason: "speech_silent",
			transport: "none",
		});
		expect(h.evidence).toContainEqual(
			expect.objectContaining({ kind: "codex_speech_silent_retry" }),
		);
	});

	it("does not call it silent when the client cut or substituted audio in the window", async () => {
		const h = harness();
		const result = h.speaker.speak("你好", "readback", { pendingKey: "sub" });
		await h.flush();
		h.speaker.turnCreated({ turnId: "t", role: "assistant" });
		h.state.interference += 1;
		h.speaker.turnDone({ turnId: "t", role: "assistant", transcript: "你好" });
		await vi.advanceTimersByTimeAsync(SILENT_SETTLE_MS);
		await expect(result).resolves.toMatchObject({
			outcome: "failed",
			reason: "speech_binding_unavailable",
			transport: "none",
		});
		expect(h.sent).toHaveLength(1);
	});
});
