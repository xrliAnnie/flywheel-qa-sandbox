import { describe, expect, it } from "vitest";
import { EdgeTtsBackend } from "../backends/edge-tts/EdgeTtsBackend.js";
import { MemoryTranscriptSink } from "../transcript.js";
import type { VoiceError } from "../types.js";
import { FakeAudioPlayer, FakeTts } from "./fakes.js";

function backend(tts: FakeTts, player: FakeAudioPlayer) {
	return new EdgeTtsBackend({
		tts,
		player,
		defaultVoice: "zh-CN-XiaoxiaoNeural",
	});
}

describe("EdgeTtsBackend capabilities", () => {
	it("is announce-only (speech-out), no converse", () => {
		const b = backend(new FakeTts(), new FakeAudioPlayer());
		expect(b.capabilities.announce).toBe(true);
		expect(b.capabilities.converse).toBe(false);
		expect(b.capabilities.supportsResume).toBe(false);
		expect(typeof b.createAnnouncer).toBe("function");
	});
});

describe("AnnouncerSession", () => {
	it("speak returns SpeakResult and records an announce transcript", async () => {
		const sink = new MemoryTranscriptSink();
		const tts = new FakeTts(Buffer.from("MP3"), { ttsFirstByteMs: 9 });
		const b = backend(tts, new FakeAudioPlayer("immediate"));
		const announcer = await b.createAnnouncer({ transcriptSink: sink });
		const r = await announcer.speak("早会:今天三个 PR 待审");
		// playbackStartMs is the session-measured end-to-end anchor (synth wait +
		// spawn), not the player's local spawn constant. With a zero-delay fake TTS
		// it's ~0, so just assert it is a valid non-negative elapsed time.
		expect(r.ttsFirstByteMs).toBe(9);
		expect(r.playbackStartMs).toBeGreaterThanOrEqual(0);
		expect(r.durationMs).toBeGreaterThanOrEqual(0);
		expect(tts.synthesizeCalls).toEqual(["早会:今天三个 PR 待审"]);
		expect(sink.entries).toHaveLength(1);
		expect(sink.entries[0]).toMatchObject({
			face: "announce",
			role: "assistant",
			text: "早会:今天三个 PR 待审",
		});
	});

	it("plays queued speaks serially in order", async () => {
		const tts = new FakeTts();
		const player = new FakeAudioPlayer("immediate");
		const announcer = await backend(tts, player).createAnnouncer({});
		const order: string[] = [];
		await Promise.all([
			announcer.speak("one").then(() => order.push("one")),
			announcer.speak("two").then(() => order.push("two")),
			announcer.speak("three").then(() => order.push("three")),
		]);
		expect(tts.synthesizeCalls).toEqual(["one", "two", "three"]); // serial
		expect(order).toEqual(["one", "two", "three"]);
		expect(player.playCount).toBe(3);
	});

	it("interrupt() kills current playback, clears the queue, rejects pending as cancelled", async () => {
		const tts = new FakeTts();
		const player = new FakeAudioPlayer("manual"); // playback never completes on its own
		const announcer = await backend(tts, player).createAnnouncer({});
		const first = announcer.speak("long announcement");
		const queued = announcer.speak("queued");
		// let the first speak reach playback
		await new Promise((r) => setTimeout(r, 5));
		announcer.interrupt();
		const firstErr = await first.catch((e) => e);
		const queuedErr = await queued.catch((e) => e);
		expect(player.interrupted).toBe(true);
		expect((firstErr as VoiceError).code).toBe("cancelled");
		expect((queuedErr as VoiceError).code).toBe("cancelled");
	});

	it("aborts an in-flight synth via a per-speak AbortSignal", async () => {
		const tts = new FakeTts(Buffer.from("x"), { hangUntilAbort: true });
		const announcer = await backend(tts, new FakeAudioPlayer()).createAnnouncer(
			{},
		);
		const ctrl = new AbortController();
		const p = announcer.speak("will be aborted", { signal: ctrl.signal });
		await new Promise((r) => setTimeout(r, 5));
		ctrl.abort();
		const err = await p.catch((e) => e);
		expect((err as VoiceError).code).toBe("cancelled");
	});

	// QA regression (FLY-543): types.ts documents playbackStartMs as "when the
	// founder actually hears sound (the honest first-response anchor)" — plan.md
	// §3 likewise: "用户真正听到声音（诚实口径）". A real edge-tts run (ttsFirstByteMs
	// ~1.6s) showed playbackStartMs=2ms: FilePlayer only times the local temp-file
	// write + spawn *after* synthesis already finished, so the returned metric
	// never reflects the TTS wait the founder actually experienced. FakeAudioPlayer
	// hardcodes playbackStartMs=3 regardless of synth delay, which is why this
	// went unnoticed by the existing suite.
	it("playbackStartMs reflects real elapsed time to first sound, including TTS synth wait", async () => {
		const SYNTH_DELAY_MS = 60;
		const tts = new FakeTts(Buffer.from("MP3"), {
			ttsFirstByteMs: SYNTH_DELAY_MS,
			realDelayMs: SYNTH_DELAY_MS,
		});
		const announcer = await backend(
			tts,
			new FakeAudioPlayer("immediate"),
		).createAnnouncer({});
		const wallStart = Date.now();
		const r = await announcer.speak("延迟播报测试");
		const wallElapsed = Date.now() - wallStart;
		// the founder cannot hear anything before synthesis is done — the honest
		// first-response anchor must be at least as large as the real synth wait.
		expect(r.playbackStartMs).toBeGreaterThanOrEqual(SYNTH_DELAY_MS - 5);
		expect(r.playbackStartMs).toBeLessThanOrEqual(wallElapsed + 5);
	});

	it("rejects empty text and speaking after close", async () => {
		const announcer = await backend(
			new FakeTts(),
			new FakeAudioPlayer(),
		).createAnnouncer({});
		await expect(announcer.speak("   ")).rejects.toMatchObject({
			code: "subprocess-failed",
		});
		await announcer.close();
		await expect(announcer.speak("hi")).rejects.toMatchObject({
			code: "backend-protocol",
		});
	});
});
