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
		/** Someone is speaking or the model's audio still flows. */
		active: false,
		live: options.live ?? true,
		/** A new generation is being opened (T7). */
		recovering: false,
		consumed: 0,
		queued: 0,
		interference: 0,
		trims: 0,
		generation: 9,
		failAppend: false,
	};
	const sent: string[] = [];
	const evidence: Record<string, unknown>[] = [];
	const overrun = vi.fn();
	const abandoned = vi.fn();
	const speaker = new CodexProofSpeaker({
		sessionId: "session-a",
		voice: "cove",
		format: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
		sessionGeneration: () => state.generation,
		transport: () => ({
			appendSpeech: async (text: string) => {
				sent.push(text);
				if (state.failAppend) {
					state.failAppend = false;
					throw new Error("rpc rejected");
				}
			},
		}),
		isLive: () => state.live,
		recovering: () => state.recovering,
		now: () => Date.now(),
		busyReason: () => state.busy,
		roomActive: () => state.active,
		consumedVoiced: () => state.consumed,
		queuedVoiced: () => state.queued,
		interference: () => state.interference,
		trims: () => state.trims,
		overrun,
		abandoned,
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
	return { speaker, state, sent, evidence, overrun, abandoned, flush, answer };
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
		const result = h.speaker.speak("你好", "cue", { pendingKey: "busy" });
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
		// The late final (the whole transcript the deltas were part of) is
		// mirrored only up to the line.
		const late = `${expected.replace("目前", "现在")}另外今天还有两件事情已经顺利完成了呢。还有更多。`;
		h.speaker.assistantTranscript({ text: late, final: true });
		expect(h.speaker.truncateAssistantFinal(late)).toBe(
			`${spoken(expected)}${SPEECH_TRUNCATED_NOTE}`,
		);
		expect(h.overrun).toHaveBeenCalledOnce();
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

	it("still checks and truncates a final that arrives after the wait, and never lets it reach the next chunk", async () => {
		const h = harness();
		const overrunText = readback.transcripts.find((row) => row.overrun)!.text;
		const first = h.speaker.speak(readback.expected, "brief", {
			pendingKey: "late-final",
		});
		await h.flush();
		h.speaker.turnCreated({ turnId: "t1", role: "assistant" });
		h.state.consumed += 10;
		h.speaker.turnDone({ turnId: "t1", role: "assistant", transcript: null });
		await vi.advanceTimersByTimeAsync(2_000);
		await expect(first).resolves.toMatchObject({ outcome: "completed" });
		// The next reading waits for t1's final instead of claiming it.
		const second = h.speaker.speak("好的。", "readback", {
			pendingKey: "next",
		});
		await vi.advanceTimersByTimeAsync(500);
		expect(h.sent).toEqual([spoken(readback.expected)]);
		h.speaker.assistantTranscript({ text: overrunText, final: true });
		expect(h.overrun).toHaveBeenCalledWith("t1");
		expect(h.speaker.truncateAssistantFinal(overrunText)).toBe(
			`${spoken(readback.expected)}${SPEECH_TRUNCATED_NOTE}`,
		);
		await vi.advanceTimersByTimeAsync(500);
		expect(h.evidence).toContainEqual(
			expect.objectContaining({
				kind: "codex_speech_overrun",
				pendingKey: "late-final",
				turnId: "t1",
				late: true,
				stopLatencyMs: expect.any(Number),
			}),
		);
		await vi.advanceTimersByTimeAsync(100);
		expect(h.sent).toEqual([spoken(readback.expected), "好的。"]);
		await h.answer("t2", "好的。");
		await expect(second).resolves.toMatchObject({ outcome: "completed" });
		expect(h.overrun).toHaveBeenCalledTimes(1);
	});

	it.each([
		["the founder's next turn", "user"],
		["another assistant turn", "assistant"],
	] as const)(
		"never takes a final after %s for the late chunk",
		async (_name, role) => {
			const h = harness();
			const first = h.speaker.speak(readback.expected, "brief", {
				pendingKey: "stale",
			});
			await h.flush();
			h.speaker.turnCreated({ turnId: "t1", role: "assistant" });
			h.state.consumed += 10;
			h.speaker.turnDone({ turnId: "t1", role: "assistant", transcript: null });
			await vi.advanceTimersByTimeAsync(2_000);
			await first;
			// A new turn starts: whatever final follows may be its own.
			h.speaker.turnCreated({ turnId: "n1", role });
			const answer = "这是对新问题的完整回答，内容与刚才那句朗读完全不同。";
			h.speaker.assistantTranscript({ text: answer, final: true });
			expect(h.overrun).not.toHaveBeenCalled();
			expect(h.speaker.truncateAssistantFinal(answer)).toBe(answer);
			// The fence lifts with it.
			const next = h.speaker.speak("好的。", "readback", {
				pendingKey: "after",
			});
			await h.flush();
			expect(h.sent.at(-1)).toBe("好的。");
			await h.answer("t2", "好的。");
			await expect(next).resolves.toMatchObject({ outcome: "completed" });
		},
	);

	it("checks the late final of a chunk the founder interrupted", async () => {
		const h = harness();
		const overrunText = readback.transcripts.find((row) => row.overrun)!.text;
		const result = h.speaker.speak(readback.expected, "readback", {
			pendingKey: "cut-then-final",
		});
		await h.flush();
		h.speaker.turnCreated({ turnId: "t", role: "assistant" });
		h.state.consumed += 5;
		h.speaker.interrupt();
		await expect(result).resolves.toMatchObject({
			reason: "speech_interrupted",
		});
		h.speaker.assistantTranscript({ text: overrunText, final: true });
		expect(h.speaker.truncateAssistantFinal(overrunText)).toBe(
			`${spoken(readback.expected)}${SPEECH_TRUNCATED_NOTE}`,
		);
	});

	it("drops the pending final check on a new generation", async () => {
		const h = harness();
		const result = h.speaker.speak(readback.expected, "brief", {
			pendingKey: "gen-final",
		});
		await h.flush();
		h.speaker.turnCreated({ turnId: "t", role: "assistant" });
		h.state.consumed += 5;
		h.speaker.interrupt();
		await result;
		h.speaker.interrupt("generation_changed");
		h.state.generation += 1;
		// A new generation's reading is sent at once and owns its own final.
		const next = h.speaker.speak("好的。", "readback", {
			pendingKey: "new-gen",
		});
		await h.flush();
		expect(h.sent.at(-1)).toBe("好的。");
		await h.answer("n1", "好的。");
		await expect(next).resolves.toMatchObject({ outcome: "completed" });
		expect(h.overrun).not.toHaveBeenCalled();
	});

	it("never takes the founder's answer for a read-aloud she preempted (review R3 H1)", async () => {
		const h = harness();
		const result = h.speaker.speak(readback.expected, "readback", {
			pendingKey: "preempt",
		});
		await h.flush();
		h.speaker.userEvidence();
		await expect(result).resolves.toMatchObject({
			reason: "speech_preempted",
		});
		const answer = "这是对新问题的完整回答，内容与刚才那句朗读完全不同。";
		h.speaker.assistantTranscript({ text: answer, final: true });
		expect(h.overrun).not.toHaveBeenCalled();
		expect(h.speaker.truncateAssistantFinal(answer)).toBe(answer);
	});

	it("keeps an interrupted unbound chunk's watch through its own late turn.created (review R3 H2)", async () => {
		const h = harness();
		const overrunText = readback.transcripts.find((row) => row.overrun)!.text;
		const result = h.speaker.speak(readback.expected, "readback", {
			pendingKey: "unbound-cut",
		});
		await h.flush();
		// Audio before its turn.created, then a local barge-in.
		h.state.consumed += 5;
		h.speaker.interrupt();
		await expect(result).resolves.toMatchObject({
			reason: "speech_interrupted",
		});
		h.speaker.turnCreated({ turnId: "own", role: "assistant" });
		h.speaker.turnDone({ turnId: "own", role: "assistant", transcript: null });
		h.speaker.assistantTranscript({ text: overrunText, final: true });
		expect(h.overrun).toHaveBeenCalledWith("own");
		expect(h.speaker.truncateAssistantFinal(overrunText)).toBe(
			`${spoken(readback.expected)}${SPEECH_TRUNCATED_NOTE}`,
		);
	});

	it("never lets a silent attempt's late final stand in for its retry's own (review R3 H3)", async () => {
		const h = harness();
		const overrunText = readback.transcripts.find((row) => row.overrun)!.text;
		const result = h.speaker.speak(readback.expected, "readback", {
			pendingKey: "silent-then-final",
		});
		await h.flush();
		h.speaker.turnCreated({ turnId: "s1", role: "assistant" });
		h.speaker.turnDone({ turnId: "s1", role: "assistant", transcript: null });
		await vi.advanceTimersByTimeAsync(SILENT_SETTLE_MS);
		expect(h.sent).toHaveLength(2);
		// The silent attempt's faithful final lands after the retry was sent.
		h.speaker.assistantTranscript({
			text: spoken(readback.expected),
			final: true,
		});
		h.speaker.turnCreated({ turnId: "s2", role: "assistant" });
		h.state.consumed += 10;
		h.speaker.turnDone({ turnId: "s2", role: "assistant", transcript: null });
		await h.flush();
		// The retry's own final is the overrun.
		h.speaker.assistantTranscript({ text: overrunText, final: true });
		await expect(result).resolves.toMatchObject({ reason: "speech_overrun" });
		expect(h.overrun).toHaveBeenCalledWith("s2");
		expect(h.speaker.truncateAssistantFinal(overrunText)).toBe(
			`${spoken(readback.expected)}${SPEECH_TRUNCATED_NOTE}`,
		);
	});

	it("does not fence the next reading behind a chunk whose transport was rejected (review R3 M1)", async () => {
		const h = harness();
		h.state.failAppend = true;
		const first = h.speaker.speak("你好", "readback", { pendingKey: "rpc" });
		await h.flush();
		await expect(first).resolves.toMatchObject({
			reason: "speech_transport_failed",
		});
		const second = h.speaker.speak("好的。", "readback", {
			pendingKey: "after-rpc",
		});
		await h.flush();
		expect(h.sent).toEqual(["你好", "好的。"]);
		await h.answer("t2", "好的。");
		await expect(second).resolves.toMatchObject({ outcome: "completed" });
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

describe("Codex Lead reply read to the end (FLY-2885 founder rework 2026-09-26)", () => {
	const settledFlag = (promise: Promise<unknown>) => {
		const flag = { settled: false };
		void promise.then(() => {
			flag.settled = true;
		});
		return flag;
	};

	it("keeps a Lead reply waiting while the conversation goes on past 10 s, then reads it", async () => {
		const h = harness();
		h.state.busy = "speaker_active";
		h.state.active = true;
		const result = h.speaker.readReply("你好。", { pendingKey: "wait" });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(h.sent).toEqual([]);
		h.state.busy = undefined;
		h.state.active = false;
		await vi.advanceTimersByTimeAsync(60);
		expect(h.sent).toEqual(["你好。"]);
		await h.answer("t", "你好。");
		await expect(result).resolves.toEqual({
			receipt: expect.objectContaining({
				outcome: "completed",
				contentProof: "transcript_equivalent",
			}),
			unreadChunks: 0,
		});
		expect(
			h.evidence.some(
				(record) => record.kind === "codex_speech_admission_timeout",
			),
		).toBe(false);
	});

	it("gives up 8 s after the room went quiet while still busy (a stuck state), not after a count", async () => {
		const h = harness();
		h.state.busy = "pending_user_turn";
		h.state.active = true;
		const result = h.speaker.readReply("第一句。第二句。", {
			pendingKey: "stuck",
			chunkCharacters: 4,
		});
		const flag = settledFlag(result);
		await vi.advanceTimersByTimeAsync(20_000);
		expect(flag.settled).toBe(false);
		// She stops; nothing is audible; the ledger still says busy.
		h.state.active = false;
		await vi.advanceTimersByTimeAsync(7_900);
		expect(flag.settled).toBe(false);
		await vi.advanceTimersByTimeAsync(200);
		await expect(result).resolves.toEqual({
			receipt: expect.objectContaining({
				outcome: "rejected",
				reason: "busy_conversation",
				transport: "none",
			}),
			unreadChunks: 2,
		});
		expect(h.evidence).toContainEqual(
			expect.objectContaining({
				kind: "codex_speech_admission_timeout",
				pendingKey: "stuck",
				busy: "pending_user_turn",
				limit: "quiet",
			}),
		);
		expect(h.sent).toEqual([]);
	});

	it("gives up after 120 s of conversation without a pause", async () => {
		const h = harness();
		h.state.busy = "speaker_active";
		h.state.active = true;
		const result = h.speaker.readReply("你好。", { pendingKey: "ceiling" });
		const flag = settledFlag(result);
		await vi.advanceTimersByTimeAsync(119_900);
		expect(flag.settled).toBe(false);
		await vi.advanceTimersByTimeAsync(200);
		await expect(result).resolves.toMatchObject({
			receipt: { outcome: "rejected", reason: "busy_conversation" },
			unreadChunks: 1,
		});
		expect(h.evidence).toContainEqual(
			expect.objectContaining({
				kind: "codex_speech_admission_timeout",
				limit: "ceiling",
			}),
		);
	});

	it("resumes after an overrun from the first sentence not yet read, never repeating one", async () => {
		const h = harness();
		const expected = "第一句话已经说完了。第二句话还没有念。";
		const result = h.speaker.readReply(expected, {
			pendingKey: "resume",
			verification: "required",
		});
		await h.flush();
		expect(h.sent).toEqual([expected]);
		h.speaker.turnCreated({ turnId: "t1", role: "assistant" });
		h.state.consumed += 10;
		h.speaker.assistantTranscript({
			text: "第一句话已经说完了。",
			final: false,
		});
		h.speaker.assistantTranscript({
			text: "另外今天还有两件事情完成了呢。",
			final: false,
		});
		expect(h.overrun).toHaveBeenCalledWith("t1");
		// The overrun turn's own final is still to come: nothing is sent first.
		await vi.advanceTimersByTimeAsync(5_000);
		expect(h.sent).toEqual([expected]);
		const oldFinal = "第一句话已经说完了。另外今天还有两件事情完成了呢。";
		h.speaker.assistantTranscript({ text: oldFinal, final: true });
		// The mirror keeps only what was read, and it is not cut twice.
		expect(h.speaker.truncateAssistantFinal(oldFinal)).toBe(
			`第一句话已经说完了。${SPEECH_TRUNCATED_NOTE}`,
		);
		expect(h.overrun).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(60);
		expect(h.sent).toEqual([expected, "第二句话还没有念。"]);
		await h.answer("t2", "第二句话还没有念。");
		// The continuation's own final is mirrored in full.
		expect(h.speaker.truncateAssistantFinal("第二句话还没有念。")).toBe(
			"第二句话还没有念。",
		);
		await expect(result).resolves.toEqual({
			receipt: expect.objectContaining({
				outcome: "failed",
				reason: "speech_overrun",
				transport: "submitted",
			}),
			unreadChunks: 0,
		});
		expect(h.evidence).toContainEqual(
			expect.objectContaining({
				kind: "codex_readback_continue",
				pendingKey: "resume",
				chunk: 0,
				spokenSentences: 1,
				totalSentences: 2,
			}),
		);
	});

	it("goes on to the next chunk when the overrun came after the whole chunk was read", async () => {
		const h = harness();
		const result = h.speaker.readReply("第一句。第二句。", {
			pendingKey: "whole",
			chunkCharacters: 4,
		});
		await h.flush();
		h.speaker.turnCreated({ turnId: "t1", role: "assistant" });
		h.state.consumed += 10;
		h.speaker.assistantTranscript({
			text: "第一句。然后我们还要讨论很多其他的事情。",
			final: false,
		});
		expect(h.overrun).toHaveBeenCalledOnce();
		h.speaker.assistantTranscript({
			text: "第一句。然后我们还要讨论很多其他的事情。",
			final: true,
		});
		await vi.advanceTimersByTimeAsync(60);
		expect(h.sent).toEqual(["第一句。", "第二句。"]);
		await h.answer("t2", "第二句。");
		await expect(result).resolves.toMatchObject({
			receipt: { reason: "speech_overrun" },
			unreadChunks: 0,
		});
	});

	it("re-reads a chunk once when an overrun read none of it, then stops and counts it unread", async () => {
		const h = harness();
		const result = h.speaker.readReply("今天下午三点开会。", {
			pendingKey: "stall",
		});
		for (const turnId of ["t1", "t2"]) {
			await vi.advanceTimersByTimeAsync(60);
			h.speaker.turnCreated({ turnId, role: "assistant" });
			h.state.consumed += 10;
			h.speaker.assistantTranscript({
				text: "我现在去帮你查一下这个问题的具体情况。",
				final: false,
			});
			h.speaker.assistantTranscript({
				text: "我现在去帮你查一下这个问题的具体情况。",
				final: true,
			});
		}
		await expect(result).resolves.toEqual({
			receipt: expect.objectContaining({
				outcome: "failed",
				reason: "speech_overrun",
				transport: "submitted",
			}),
			unreadChunks: 1,
		});
		expect(h.sent).toEqual(["今天下午三点开会。", "今天下午三点开会。"]);
		expect(h.overrun).toHaveBeenCalledTimes(2);
	});

	it("stops the reply when she barges in and reports what was left unread", async () => {
		const h = harness();
		const result = h.speaker.readReply("第一句。第二句。", {
			pendingKey: "barge",
			chunkCharacters: 4,
		});
		await h.flush();
		h.speaker.turnCreated({ turnId: "t1", role: "assistant" });
		h.state.consumed += 2;
		h.speaker.interrupt();
		await expect(result).resolves.toEqual({
			receipt: expect.objectContaining({
				outcome: "failed",
				reason: "speech_interrupted",
				transport: "submitted",
			}),
			unreadChunks: 2,
		});
		await vi.advanceTimersByTimeAsync(1_000);
		expect(h.sent).toEqual(["第一句。"]);
	});

	it("moves on past a chunk that was heard but not proven, as the reply loop always did", async () => {
		const h = harness();
		const result = h.speaker.readReply("第一句。第二句。", {
			pendingKey: "unproven",
			verification: "required",
			chunkCharacters: 4,
		});
		await h.flush();
		await h.answer("t1", "完全不同的话");
		await vi.advanceTimersByTimeAsync(60);
		expect(h.sent).toEqual(["第一句。", "第二句。"]);
		await h.answer("t2", "第二句。");
		await expect(result).resolves.toEqual({
			receipt: expect.objectContaining({
				outcome: "failed",
				reason: "speech_not_equivalent",
				transport: "submitted",
			}),
			unreadChunks: 0,
		});
	});

	it("lets a cue through while a Lead reply waits for the conversation", async () => {
		const h = harness();
		h.state.busy = "speaker_active";
		h.state.active = true;
		const reply = h.speaker.readReply("你好。", { pendingKey: "reply" });
		await vi.advanceTimersByTimeAsync(1_000);
		const cue = h.speaker.speak(
			"刚才这件事没能交给 Lead。请再说一遍。",
			"cue",
			{
				pendingKey: "cue",
				verification: "required",
			},
		);
		h.state.busy = undefined;
		h.state.active = false;
		await vi.advanceTimersByTimeAsync(60);
		expect(h.sent).toEqual(["刚才这件事没能交给 Lead。请再说一遍。"]);
		await h.answer("cue-turn", "刚才这件事没能交给 Lead。请再说一遍。");
		await expect(cue).resolves.toMatchObject({ outcome: "completed" });
		await vi.advanceTimersByTimeAsync(60);
		expect(h.sent.at(-1)).toBe("你好。");
		await h.answer("reply-turn", "你好。");
		await expect(reply).resolves.toMatchObject({
			receipt: { outcome: "completed" },
			unreadChunks: 0,
		});
	});

	it("never reads two Lead replies at once", async () => {
		const h = harness();
		h.state.busy = "speaker_active";
		h.state.active = true;
		void h.speaker.readReply("你好。", { pendingKey: "first" });
		await h.flush();
		await expect(
			h.speaker.readReply("再见。", { pendingKey: "second" }),
		).resolves.toMatchObject({
			receipt: { outcome: "rejected", reason: "busy" },
		});
	});

	it("waits out a reconnect and reads the reply on the new generation", async () => {
		const h = harness();
		h.state.live = false;
		h.state.recovering = true;
		const result = h.speaker.readReply("你好。", { pendingKey: "reconnect" });
		await vi.advanceTimersByTimeAsync(20_000);
		expect(h.sent).toEqual([]);
		h.state.generation += 1;
		h.state.live = true;
		h.state.recovering = false;
		await vi.advanceTimersByTimeAsync(60);
		expect(h.sent).toEqual(["你好。"]);
		await h.answer("t", "你好。");
		await expect(result).resolves.toMatchObject({
			receipt: { outcome: "completed" },
			unreadChunks: 0,
		});
	});

	it("counts a reply unread when the session is closing", async () => {
		const h = harness({ live: false });
		await expect(
			h.speaker.readReply("第一句。第二句。", {
				pendingKey: "closed",
				chunkCharacters: 4,
			}),
		).resolves.toMatchObject({
			receipt: { outcome: "rejected", reason: "not_live" },
			unreadChunks: 2,
		});
	});

	it("stops a waiting reply when the session closes, with every chunk unread", async () => {
		const h = harness();
		h.state.busy = "speaker_active";
		h.state.active = true;
		const result = h.speaker.readReply("第一句。第二句。", {
			pendingKey: "closing",
			chunkCharacters: 4,
		});
		await vi.advanceTimersByTimeAsync(1_000);
		h.state.live = false;
		await vi.advanceTimersByTimeAsync(60);
		await expect(result).resolves.toMatchObject({
			receipt: { outcome: "rejected", reason: "generation_changed" },
			unreadChunks: 2,
		});
		expect(h.sent).toEqual([]);
	});

	it("queues a reply behind a cue that is being spoken instead of turning it away", async () => {
		const h = harness();
		const cue = h.speaker.speak("我确认一下。", "cue", {
			pendingKey: "cue-first",
			verification: "required",
		});
		await h.flush();
		expect(h.sent).toEqual(["我确认一下。"]);
		const reply = h.speaker.readReply("你好。", { pendingKey: "after-cue" });
		await vi.advanceTimersByTimeAsync(500);
		expect(h.sent).toEqual(["我确认一下。"]);
		await h.answer("cue-turn", "我确认一下。");
		await expect(cue).resolves.toMatchObject({ outcome: "completed" });
		await vi.advanceTimersByTimeAsync(60);
		expect(h.sent).toEqual(["我确认一下。", "你好。"]);
		await h.answer("reply-turn", "你好。");
		await expect(reply).resolves.toMatchObject({
			receipt: { outcome: "completed" },
		});
	});

	it("waits out a lost overrun final (30 s), then never truncates the continuation's own (review R1)", async () => {
		const h = harness();
		const expected = "第一句话已经说完了。第二句话还没有念。";
		const result = h.speaker.readReply(expected, { pendingKey: "lost-final" });
		await h.flush();
		h.speaker.turnCreated({ turnId: "t1", role: "assistant" });
		h.state.consumed += 10;
		h.speaker.assistantTranscript({
			text: "第一句话已经说完了。另外今天还有两件事情完成了呢。",
			final: false,
		});
		// No final ever comes for t1. The quiet-room limit does not fire on it.
		await vi.advanceTimersByTimeAsync(29_000);
		expect(h.sent).toEqual([expected]);
		await vi.advanceTimersByTimeAsync(1_100);
		expect(h.sent).toEqual([expected, "第二句话还没有念。"]);
		await h.answer("t2", "第二句话还没有念。");
		expect(h.speaker.truncateAssistantFinal("第二句话还没有念。")).toBe(
			"第二句话还没有念。",
		);
		await expect(result).resolves.toMatchObject({ unreadChunks: 0 });
		expect(h.overrun).toHaveBeenCalledOnce();
	});

	it("still truncates the overrun final when she speaks first, and leaves her answer alone (review R1)", async () => {
		const h = harness();
		const expected = "第一句话已经说完了。第二句话还没有念。";
		const result = h.speaker.readReply(expected, { pendingKey: "she-spoke" });
		await h.flush();
		h.speaker.turnCreated({ turnId: "t1", role: "assistant" });
		h.state.consumed += 10;
		h.speaker.assistantTranscript({
			text: "第一句话已经说完了。另外今天还有两件事情完成了呢。",
			final: false,
		});
		// She starts before the overrun turn's final lands.
		h.speaker.userEvidence();
		h.speaker.turnCreated({ turnId: "answer", role: "assistant" });
		const oldFinal = "第一句话已经说完了。另外今天还有两件事情完成了呢。";
		h.speaker.assistantTranscript({ text: oldFinal, final: true });
		expect(h.speaker.truncateAssistantFinal(oldFinal)).toBe(
			`第一句话已经说完了。${SPEECH_TRUNCATED_NOTE}`,
		);
		const answer = "这是对新问题的完整回答，内容与刚才那句朗读完全不同。";
		h.speaker.assistantTranscript({ text: answer, final: true });
		expect(h.speaker.truncateAssistantFinal(answer)).toBe(answer);
		expect(h.overrun).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(60);
		expect(h.sent.at(-1)).toBe("第二句话还没有念。");
		await h.answer("t2", "第二句话还没有念。");
		await expect(result).resolves.toMatchObject({ unreadChunks: 0 });
	});

	it("gives up an overrun chunk's claim when its final was lost and her next answer's comes first (review R2)", async () => {
		const h = harness();
		const expected = "第一句话已经说完了。第二句话还没有念。";
		const result = h.speaker.readReply(expected, {
			pendingKey: "lost-then-she",
		});
		await h.flush();
		h.speaker.turnCreated({ turnId: "t1", role: "assistant" });
		h.state.consumed += 10;
		h.speaker.assistantTranscript({
			text: "第一句话已经说完了。另外今天还有两件事情完成了呢。",
			final: false,
		});
		// t1's final never comes. She asks something; the model answers.
		await vi.advanceTimersByTimeAsync(3_000);
		h.speaker.userEvidence();
		h.speaker.turnCreated({ turnId: "answer", role: "assistant" });
		const answer = "这是对新问题的完整回答，内容与刚才那句朗读完全不同。";
		h.speaker.assistantTranscript({ text: answer, final: true });
		expect(h.speaker.truncateAssistantFinal(answer)).toBe(answer);
		expect(h.overrun).toHaveBeenCalledOnce();
		// The fence went with the claim: the rest is read at the next pause.
		await vi.advanceTimersByTimeAsync(60);
		expect(h.sent.at(-1)).toBe("第二句话还没有念。");
		await h.answer("t2", "第二句话还没有念。");
		expect(h.speaker.truncateAssistantFinal("第二句话还没有念。")).toBe(
			"第二句话还没有念。",
		);
		await expect(result).resolves.toMatchObject({ unreadChunks: 0 });
	});

	it("lets an overrun that read nothing claim its own late final by what was heard, and holds the re-read for it (review R3)", async () => {
		const h = harness();
		const result = h.speaker.readReply("今天下午三点开会。", {
			pendingKey: "nothing-read",
		});
		await h.flush();
		h.speaker.turnCreated({ turnId: "t1", role: "assistant" });
		h.state.consumed += 10;
		h.speaker.assistantTranscript({
			text: "我现在去帮你查一下这个问题的具体情况。",
			final: false,
		});
		// The same line is not re-read while t1's final is still to come.
		await vi.advanceTimersByTimeAsync(2_000);
		expect(h.sent).toEqual(["今天下午三点开会。"]);
		const late = "我现在去帮你查一下这个问题的具体情况。然后还有很多别的事。";
		h.speaker.assistantTranscript({ text: late, final: true });
		// Nothing of the line was read: the mirror keeps only the note.
		expect(h.speaker.truncateAssistantFinal(late)).toBe(SPEECH_TRUNCATED_NOTE);
		expect(h.overrun).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(60);
		expect(h.sent).toEqual(["今天下午三点开会。", "今天下午三点开会。"]);
		await h.answer("t2", "今天下午三点开会。");
		await expect(result).resolves.toMatchObject({ unreadChunks: 0 });
	});

	it("never claims her answer for a lost overrun final just because both open with the same sentence (review R3)", async () => {
		const h = harness();
		const expected = "好的。第一项已经完成。第二项还在进行。";
		const result = h.speaker.readReply(expected, { pendingKey: "shared-open" });
		await h.flush();
		h.speaker.turnCreated({ turnId: "t1", role: "assistant" });
		h.state.consumed += 10;
		h.speaker.assistantTranscript({
			text: "好的。第一项已经完成。另外今天还有两件事情完成了呢。",
			final: false,
		});
		// t1's final is lost; she asks, and the model's answer opens alike.
		await vi.advanceTimersByTimeAsync(3_000);
		h.speaker.userEvidence();
		h.speaker.turnCreated({ turnId: "answer", role: "assistant" });
		const answer = "好的。这是对新问题的完整回答，内容与刚才那句朗读完全不同。";
		h.speaker.assistantTranscript({ text: answer, final: true });
		expect(h.speaker.truncateAssistantFinal(answer)).toBe(answer);
		await vi.advanceTimersByTimeAsync(60);
		expect(h.sent.at(-1)).toBe("第二项还在进行。");
		await h.answer("t2", "第二项还在进行。");
		await expect(result).resolves.toMatchObject({ unreadChunks: 0 });
		expect(h.overrun).toHaveBeenCalledOnce();
	});

	it("tells the model to drop the rest of a Lead-reply chunk she barged into (QA@2)", async () => {
		const h = harness();
		const result = h.speaker.readReply("第一句。第二句。", {
			pendingKey: "barge-note",
			chunkCharacters: 4,
		});
		await h.flush();
		h.speaker.turnCreated({ turnId: "t1", role: "assistant" });
		h.state.consumed += 2;
		h.speaker.interrupt();
		await expect(result).resolves.toMatchObject({ unreadChunks: 2 });
		expect(h.abandoned).toHaveBeenCalledOnce();
		expect(h.abandoned).toHaveBeenCalledWith("第一句。", 9);
	});

	it("tells the model to drop a chunk she preempted after it was sent (QA@2)", async () => {
		const h = harness();
		const result = h.speaker.readReply("你好。", {
			pendingKey: "preempt-note",
		});
		await h.flush();
		h.speaker.userEvidence();
		await expect(result).resolves.toMatchObject({
			receipt: { reason: "speech_preempted" },
		});
		expect(h.abandoned).toHaveBeenCalledWith("你好。", 9);
	});

	it.each([
		[
			"a chunk still waiting for a pause",
			async (h: ReturnType<typeof harness>) => {
				h.state.busy = "speaker_active";
				h.state.active = true;
				const result = h.speaker.readReply("你好。", { pendingKey: "wait" });
				await vi.advanceTimersByTimeAsync(1_000);
				h.state.live = false;
				await vi.advanceTimersByTimeAsync(60);
				return result;
			},
		],
		[
			"a chunk cut by a new generation",
			async (h: ReturnType<typeof harness>) => {
				const result = h.speaker.readReply("你好。", { pendingKey: "gen" });
				await h.flush();
				h.speaker.turnCreated({ turnId: "t1", role: "assistant" });
				h.speaker.interrupt("generation_changed");
				return result;
			},
		],
	])(
		"sends no note for %s: nothing of it is in the model's context",
		async (_name, run) => {
			const h = harness();
			await run(h);
			expect(h.abandoned).not.toHaveBeenCalled();
		},
	);

	it("sends no note for a cue she barged into", async () => {
		const h = harness();
		const cue = h.speaker.speak("我确认一下。", "cue", {
			pendingKey: "cue-cut",
			verification: "required",
		});
		await h.flush();
		h.speaker.turnCreated({ turnId: "t1", role: "assistant" });
		h.state.consumed += 2;
		h.speaker.interrupt();
		await cue;
		expect(h.abandoned).not.toHaveBeenCalled();
	});

	it("stops the reply and steers off the cut chunk when she barges in between an overrun and its rest (review)", async () => {
		const h = harness();
		const expected = "第一句话已经说完了。第二句话还没有念。";
		const result = h.speaker.readReply(expected, { pendingKey: "gap-barge" });
		await h.flush();
		h.speaker.turnCreated({ turnId: "t1", role: "assistant" });
		h.state.consumed += 10;
		h.speaker.assistantTranscript({
			text: "第一句话已经说完了。另外今天还有两件事情完成了呢。",
			final: false,
		});
		// The rest waits for t1's final; she barges in meanwhile.
		await vi.advanceTimersByTimeAsync(200);
		h.speaker.interrupt();
		expect(h.abandoned).toHaveBeenCalledOnce();
		expect(h.abandoned).toHaveBeenCalledWith(expected, 9);
		await vi.advanceTimersByTimeAsync(60);
		await expect(result).resolves.toMatchObject({
			receipt: { outcome: "failed", reason: "speech_interrupted" },
			unreadChunks: 1,
		});
		h.speaker.assistantTranscript({
			text: "第一句话已经说完了。另外今天还有两件事情完成了呢。",
			final: true,
		});
		await vi.advanceTimersByTimeAsync(1_000);
		expect(h.sent).toEqual([expected]);
	});

	it("does not stop or steer a reply that only waits in the queue when she speaks", async () => {
		const h = harness();
		h.state.busy = "speaker_active";
		h.state.active = true;
		const result = h.speaker.readReply("你好。", { pendingKey: "queued" });
		await vi.advanceTimersByTimeAsync(1_000);
		h.speaker.interrupt();
		h.state.busy = undefined;
		h.state.active = false;
		await vi.advanceTimersByTimeAsync(60);
		expect(h.sent).toEqual(["你好。"]);
		await h.answer("t", "你好。");
		await expect(result).resolves.toMatchObject({ unreadChunks: 0 });
		expect(h.abandoned).not.toHaveBeenCalled();
	});

	it("never steers off its own remainder notice", async () => {
		const h = harness();
		const notice = h.speaker.readReply(
			"剩下的内容在频道里。",
			{ pendingKey: "notice" },
			{ noteOnAbandon: false },
		);
		await h.flush();
		h.speaker.turnCreated({ turnId: "t1", role: "assistant" });
		h.state.consumed += 2;
		h.speaker.interrupt();
		await notice;
		expect(h.abandoned).not.toHaveBeenCalled();
	});
});
