/**
 * FLY-1006 S7 — ElevenSession contract tests: event→turn mapping onto the
 * streaming mouth, interruption/late-chunk suppression, waiting cue, metrics
 * trail and idempotent teardown — all against the REAL VoiceRoomRuntime
 * (true-to-prod ears surface + shared slot).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ELEVEN_SLOT_MODE } from "../eleven/config.js";
import {
	ElevenSession,
	type ElevenWsHandlers,
} from "../eleven/ElevenSession.js";
import { VoiceRoomRuntime } from "../VoiceRoomRuntime.js";

function makeFixture(over: Record<string, unknown> = {}) {
	const room = new VoiceRoomRuntime();
	expect(room.slot.acquire(ELEVEN_SLOT_MODE, "s1").ok).toBe(true);
	const speaker = {
		calls: [] as string[],
		beginTurn() {
			this.calls.push("begin");
		},
		feed(_c: Buffer) {
			this.calls.push("feed");
		},
		endTurn() {
			this.calls.push("end");
		},
		flush() {
			this.calls.push("flush");
		},
	};
	const ws = { sent: [] as Buffer[], flushes: 0, closes: 0 };
	const cue = { starts: 0, stops: 0 };
	const voice = { joins: 0, leaves: 0 };
	const trail: Record<string, unknown>[] = [];
	let handlers: ElevenWsHandlers | undefined;
	const session = new ElevenSession({
		sessionId: "s1",
		slot: room.slot,
		slotMode: ELEVEN_SLOT_MODE,
		ears: room,
		connect: async (h) => {
			handlers = h;
			return {
				sendAudio: (b) => ws.sent.push(b),
				flushAudio: () => ws.flushes++,
				close: () => ws.closes++,
			};
		},
		speaker,
		voice: {
			join: async () => {
				voice.joins++;
			},
			leave: () => {
				voice.leaves++;
			},
		},
		cue: {
			start: () => cue.starts++,
			stop: () => cue.stops++,
		},
		transcript: (line) => trail.push(line),
		log: () => {},
		...over,
	});
	return {
		room,
		session,
		speaker,
		ws,
		cue,
		voice,
		trail,
		handlers: () => handlers as ElevenWsHandlers,
	};
}

describe("ElevenSession (FLY-1006 S7)", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("live wiring: frames → ws.sendAudio; speaking-end → flushAudio + waiting cue", async () => {
		const f = makeFixture();
		await f.session.start();
		expect(f.session.stateName).toBe("live");
		expect(f.voice.joins).toBe(1);

		f.room.routeFrame(Buffer.alloc(640), {});
		expect(f.ws.sent).toHaveLength(1);

		f.room.routeSpeakingEnd();
		expect(f.ws.flushes).toBe(1);
		expect(f.cue.starts).toBe(1);
	});

	it("turn mapping: first audio = beginTurn (cue stops); gap > turnGapMs = endTurn", async () => {
		const f = makeFixture();
		await f.session.start();
		f.room.routeSpeakingEnd();

		f.handlers().onAudio(Buffer.alloc(4));
		f.handlers().onAudio(Buffer.alloc(4));
		expect(f.cue.stops).toBeGreaterThan(0);
		expect(f.speaker.calls).toEqual(["begin", "feed", "feed"]);

		vi.advanceTimersByTime(1600);
		expect(f.speaker.calls.at(-1)).toBe("end");

		// metrics: speech_end → first_audio with the segment measurement
		expect(f.trail.some((l) => l.type === "speech_end")).toBe(true);
		const first = f.trail.find((l) => l.type === "first_audio");
		expect(first).toBeDefined();
		expect(typeof first?.sinceSpeechEndMs).toBe("number");
	});

	it("interruption: flush + late chunks dropped/counted until the next user_transcript", async () => {
		const f = makeFixture();
		await f.session.start();
		f.handlers().onAudio(Buffer.alloc(4)); // turn open

		f.handlers().onInterruption();
		expect(f.speaker.calls.at(-1)).toBe("flush");

		f.handlers().onAudio(Buffer.alloc(4)); // late chunk of the dead turn
		f.handlers().onAudio(Buffer.alloc(4));
		expect(f.session.droppedLateChunks).toBe(2);
		expect(f.speaker.calls.filter((c) => c === "begin")).toHaveLength(1);

		f.handlers().onUserTranscript?.("接着说"); // founder spoke → fresh response
		f.handlers().onAudio(Buffer.alloc(4));
		expect(f.speaker.calls.filter((c) => c === "begin")).toHaveLength(2);
	});

	it("local barge-in routes through the room to the same flush path", async () => {
		const f = makeFixture();
		await f.session.start();
		f.handlers().onAudio(Buffer.alloc(4));
		f.room.routeBargeIn();
		expect(f.speaker.calls.at(-1)).toBe("flush");
		expect(f.session.droppedLateChunks).toBe(0);
		f.handlers().onAudio(Buffer.alloc(4));
		expect(f.session.droppedLateChunks).toBe(1);
	});

	// ---- waiting cue semantics (QA FLY-1006 B1/B2 kickback) ----------------
	// the cue's own gate: turn not open + not already cueing. `suppressed` is
	// about dropping a dead turn's late chunks — it must NOT gate the cue.

	it("cue: local barge-in mid-utterance does not block the cue on speaking-end (B1)", async () => {
		const f = makeFixture();
		await f.session.start();
		// EarsReceiver's backchannel gate fires onBargeIn ~350ms into EVERY real
		// utterance — before the founder's own speaking-end.
		f.room.routeBargeIn();
		f.room.routeSpeakingEnd();
		expect(f.cue.starts).toBe(1);
	});

	it("cue: start is idempotent per wait (double speaking-end = one start)", async () => {
		const f = makeFixture();
		await f.session.start();
		f.room.routeSpeakingEnd();
		f.room.routeSpeakingEnd();
		expect(f.cue.starts).toBe(1);
	});

	it("cue: suppressed late chunks of the dead turn do not stop the cue", async () => {
		const f = makeFixture();
		await f.session.start();
		f.handlers().onAudio(Buffer.alloc(4)); // turn open
		f.room.routeBargeIn(); // founder interrupts → suppressed
		f.room.routeSpeakingEnd(); // she finished — the wait begins
		expect(f.cue.starts).toBe(1);

		f.handlers().onAudio(Buffer.alloc(4)); // late chunk of the DEAD turn
		expect(f.session.droppedLateChunks).toBe(1);
		expect(f.cue.stops).toBe(0); // the cue keeps filling the wait

		f.handlers().onUserTranscript?.("接着说");
		f.handlers().onAudio(Buffer.alloc(4)); // the REAL answer's onset
		expect(f.cue.stops).toBe(1);
		expect(f.speaker.calls.filter((c) => c === "begin")).toHaveLength(2);
	});

	it("cue: barge-in while the cue is playing stops it (she started talking)", async () => {
		const f = makeFixture();
		await f.session.start();
		f.room.routeSpeakingEnd(); // cue on
		f.room.routeBargeIn();
		expect(f.cue.stops).toBe(1);
	});

	// ---- QA fix round 3 ① — idle local barge-in must not poison the answer --
	// Annie P6 (session 36686daf): her natural pauses/breaths fired 8+ local
	// barge-ins while the agent was NOT speaking. Each one set `suppressed`,
	// which drops the UPCOMING answer's audio until user_transcript arrives —
	// state thrash with nothing to interrupt. A local barge-in is a real
	// interruption ONLY while a turn is open.

	it("idle local barge-in (no open turn) does not suppress the upcoming answer", async () => {
		const f = makeFixture();
		await f.session.start();
		f.room.routeBargeIn(); // breath >350ms — agent has never spoken
		f.handlers().onAudio(Buffer.alloc(4)); // the answer arrives
		expect(f.session.droppedLateChunks).toBe(0);
		expect(f.speaker.calls.filter((c) => c === "begin")).toHaveLength(1);
	});

	it("idle local barge-in is not logged as an interruption (metrics honesty)", async () => {
		const f = makeFixture();
		await f.session.start();
		f.room.routeSpeakingEnd(); // waiting — cue on
		f.room.routeBargeIn(); // she resumed talking: the wait ends…
		expect(f.cue.stops).toBe(1);
		// …but nothing was interrupted: no flush, no `interruption` trail line.
		expect(f.speaker.calls).not.toContain("flush");
		expect(f.trail.filter((l) => l.type === "interruption")).toHaveLength(0);
		expect(f.trail.some((l) => l.type === "barge_in_idle")).toBe(true);
	});

	it("local barge-in with an OPEN turn is still a real interruption", async () => {
		const f = makeFixture();
		await f.session.start();
		f.handlers().onAudio(Buffer.alloc(4)); // agent speaking
		f.room.routeBargeIn();
		expect(f.speaker.calls.at(-1)).toBe("flush");
		expect(
			f.trail.filter((l) => l.type === "interruption" && l.source === "local"),
		).toHaveLength(1);
		f.handlers().onAudio(Buffer.alloc(4)); // late chunk of the dead turn
		expect(f.session.droppedLateChunks).toBe(1);
	});

	// ---- QA fix round 3 ②③ — TIV: text visibility in the voice channel -----
	// Annie: 「为什么我和 Eleven 的对话在文本那边没有显示?」「等待的时候也应该
	// 给我显示一个正在处理的状态」— same unified standard as /glaw F2.

	function makeTiv() {
		const statuses: string[] = [];
		const captions: { role: string; text: string }[] = [];
		return {
			statuses,
			captions,
			tiv: {
				status: (line: string) => statuses.push(line),
				caption: (role: "user" | "assistant", text: string) =>
					captions.push({ role, text }),
			},
		};
	}

	it("tiv: status walks 在听 → 正在处理 → 回话中 → 在听 across one round", async () => {
		const t = makeTiv();
		const f = makeFixture({ tiv: t.tiv });
		await f.session.start();
		expect(t.statuses.at(-1)).toContain("在听");
		f.room.routeSpeakingEnd(); // she finished — the wait begins
		vi.advanceTimersByTime(1_100); // 🧠 posts after the anti-spam debounce (≥holdoff)
		expect(t.statuses.at(-1)).toContain("正在处理");
		f.handlers().onAudio(Buffer.alloc(4)); // answer onset
		expect(t.statuses.at(-1)).toContain("回话");
		vi.advanceTimersByTime(1600); // gap → turn end
		expect(t.statuses.at(-1)).toContain("在听");
	});

	it("tiv: the 正在处理 status appears even when no cue clip is configured", async () => {
		const t = makeTiv();
		const f = makeFixture({ tiv: t.tiv, cue: undefined });
		await f.session.start();
		f.room.routeSpeakingEnd();
		f.room.routeSpeakingEnd(); // VAD flutter — still one status
		vi.advanceTimersByTime(1_100);
		expect(t.statuses.filter((s) => s.includes("正在处理"))).toHaveLength(1);
	});

	it("tiv: mid-utterance pauses post NO status at all (anti-spam debounce)", async () => {
		const t = makeTiv();
		const f = makeFixture({ tiv: t.tiv });
		await f.session.start(); // 🎙 在听 (the only message)
		for (let i = 0; i < 8; i++) {
			f.room.routeSpeakingEnd(); // breath — wait begins
			vi.advanceTimersByTime(400); // …but she resumes before the debounce
			f.room.routeSpeakingStart();
		}
		expect(t.statuses).toEqual([expect.stringContaining("在听")]);
	});

	it("tiv: a 900ms pause (same utterance per the 1000ms holdoff) posts NOTHING (Codex R3-fix-3)", async () => {
		const t = makeTiv();
		const f = makeFixture({ tiv: t.tiv });
		await f.session.start(); // 🎙 在听 (the only message)
		f.room.routeSpeakingEnd(); // pause begins — wait opens
		vi.advanceTimersByTime(900); // 800–999ms band: ears still latched…
		f.room.routeSpeakingStart(); // …she resumes the SAME utterance
		vi.advanceTimersByTime(2_000);
		expect(t.statuses).toEqual([expect.stringContaining("在听")]);
	});

	it("tiv: a fast answer (before the debounce) never flashes 🧠", async () => {
		const t = makeTiv();
		const f = makeFixture({ tiv: t.tiv });
		await f.session.start();
		f.room.routeSpeakingEnd();
		vi.advanceTimersByTime(400);
		f.handlers().onAudio(Buffer.alloc(4)); // answer within the debounce
		vi.advanceTimersByTime(2_000);
		expect(t.statuses.some((s) => s.includes("正在处理"))).toBe(false);
		expect(t.statuses.filter((s) => s.includes("回话")).length).toBeGreaterThan(
			0,
		);
	});

	it("tiv: an interruption resets the status to 在听 — the status never lies (Codex R3-fix-1)", async () => {
		const t = makeTiv();
		const f = makeFixture({ tiv: t.tiv });
		await f.session.start();
		f.handlers().onAudio(Buffer.alloc(4)); // 💬 回话中
		f.room.routeBargeIn(); // real interruption — agent stops
		expect(t.statuses.at(-1)).toContain("在听");

		f.room.routeSpeakingEnd();
		vi.advanceTimersByTime(1_100); // 🧠 正在处理…
		expect(t.statuses.at(-1)).toContain("正在处理");
		f.handlers().onInterruption(); // platform interruption mid-wait
		expect(t.statuses.at(-1)).toContain("在听");
	});

	it("tiv: consecutive identical statuses are deduped (no channel spam)", async () => {
		const t = makeTiv();
		const f = makeFixture({ tiv: t.tiv });
		await f.session.start(); // 🎙 在听
		f.room.routeBargeIn(); // idle barge-in, nothing on — still 在听
		expect(t.statuses).toEqual([expect.stringContaining("在听")]);
	});

	it("speaking-start during the wait ends the wait UI — cue stops, status 在听 (Codex R3-fix-2)", async () => {
		const t = makeTiv();
		const f = makeFixture({ tiv: t.tiv });
		await f.session.start();
		f.room.routeSpeakingEnd(); // wait on: cue + (debounced) 🧠
		expect(f.cue.starts).toBe(1);
		vi.advanceTimersByTime(1_100);
		expect(t.statuses.at(-1)).toContain("正在处理");

		// she resumes speaking within the barge-in holdoff — the latch means NO
		// barge-in fires, but the wait UI must still stop lying.
		f.room.routeSpeakingStart();
		expect(f.cue.stops).toBe(1);
		expect(t.statuses.at(-1)).toContain("在听");

		// her next speech-end re-opens the wait (cue + 🧠 come back)
		f.room.routeSpeakingEnd();
		expect(f.cue.starts).toBe(2);
		vi.advanceTimersByTime(1_100);
		expect(t.statuses.at(-1)).toContain("正在处理");
	});

	it("speaking-start during agent playback does NOT touch the turn (backchannel-safe)", async () => {
		const t = makeTiv();
		const f = makeFixture({ tiv: t.tiv });
		await f.session.start();
		f.handlers().onAudio(Buffer.alloc(4)); // 💬 回话中, turn open
		f.room.routeSpeakingStart(); // a brief "嗯" — under the barge-in gate
		expect(t.statuses.at(-1)).toContain("回话");
		expect(f.speaker.calls).not.toContain("flush");
	});

	it("tiv: captions surface her words and the agent's reply", async () => {
		const t = makeTiv();
		const f = makeFixture({ tiv: t.tiv });
		await f.session.start();
		f.handlers().onUserTranscript?.("哈豆模式能用吗");
		f.handlers().onAgentResponse?.("可以用，我看了下状态。");
		expect(t.captions).toEqual([
			{ role: "user", text: "哈豆模式能用吗" },
			{ role: "assistant", text: "可以用，我看了下状态。" },
		]);
	});

	it("cue: stop() never touches an idle cue (shared-player safety, B2)", async () => {
		const f = makeFixture();
		await f.session.start();
		// no speaking-end ever happened — the cue never started; nothing in the
		// turn lifecycle may call cue.stop() (it would player.stop() the mouth).
		f.handlers().onAudio(Buffer.alloc(4));
		f.handlers().onAudio(Buffer.alloc(4));
		await f.session.stop();
		expect(f.cue.starts).toBe(0);
		expect(f.cue.stops).toBe(0);
	});

	it("cue: teardown stops an active cue", async () => {
		const f = makeFixture();
		await f.session.start();
		f.room.routeSpeakingEnd(); // cue on
		await f.session.stop();
		expect(f.cue.stops).toBe(1);
	});

	it("teardown is idempotent and releases the shared slot exactly once", async () => {
		const f = makeFixture();
		await f.session.start();
		await f.session.stop();
		await f.session.stop();
		expect(f.ws.closes).toBe(1);
		expect(f.voice.leaves).toBe(1);
		// slot is free again (another mode can take the room)
		expect(f.room.slot.acquire("gemini", "next").ok).toBe(true);
		// dead session no longer consumes room events
		f.room.routeFrame(Buffer.alloc(640), {});
		expect(f.ws.sent).toHaveLength(0);
	});

	it("ws close while live tears the session down (slot released)", async () => {
		const f = makeFixture();
		await f.session.start();
		f.handlers().onClose?.(1000);
		await vi.runAllTimersAsync();
		expect(f.session.stateName).toBe("ended");
		expect(f.room.slot.current()).toBe(null);
	});

	it("connect failure releases the slot and rethrows (command replies fail-loud)", async () => {
		const f = makeFixture({
			connect: async () => {
				throw new Error("signed-url failed (500)");
			},
		});
		await expect(f.session.start()).rejects.toThrow(/signed-url/);
		expect(f.room.slot.current()).toBe(null);
	});
});
