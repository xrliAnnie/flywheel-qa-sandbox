/**
 * FLY-545 P4 — LeadSpeaker: one Lead bot mouth (serial utterance queue over a
 * resident AudioPlayer).
 *
 * Contract (plan §7 P4):
 *  - serial queue: one utterance at a time, in order.
 *  - stop() = clear queue + player.stop() — the barge-in fast path; the stop
 *    call itself is SYNCHRONOUS (the <100ms PRD budget is a local call).
 *  - pre-synthesized earcon/filler play straight from a file path (no synth
 *    wait); text goes through the injected TtsEngine (argv hygiene lives in
 *    EdgeTts — text never appears in argv here or there).
 *  - SpeakResult mirrors voice-core honesty: playbackStartMs measures until
 *    the player actually reports Playing, not until we called play().
 */
import { describe, expect, it } from "vitest";
import { LeadSpeaker, type PlayerLike } from "../audio/LeadSpeaker.js";

type Handler = (err?: Error) => void;

class FakePlayer implements PlayerLike {
	played: unknown[] = [];
	stops = 0;
	private handlers: Record<string, Handler[]> = {};
	play(resource: unknown): void {
		this.played.push(resource);
	}
	stop(): void {
		this.stops++;
		this.fire("idle");
	}
	on(event: "playing" | "idle" | "error", cb: Handler): void {
		this.handlers[event] = this.handlers[event] ?? [];
		this.handlers[event].push(cb);
	}
	fire(event: "playing" | "idle" | "error", err?: Error): void {
		for (const cb of this.handlers[event] ?? []) cb(err);
	}
}

function makeRig(over: { tts?: unknown; voice?: string } = {}) {
	const player = new FakePlayer();
	let clock = 0;
	const resources: unknown[] = [];
	const speaker = new LeadSpeaker({
		player,
		createResource: (src) => {
			resources.push(src);
			return { resource: src };
		},
		now: () => clock,
		...(over as Record<string, never>),
	});
	return {
		player,
		speaker,
		resources,
		tick: (ms: number) => {
			clock += ms;
		},
	};
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("file playback", () => {
	it("plays a file source and reports honest timings", async () => {
		const rig = makeRig();
		const p = rig.speaker.speak({ kind: "file", path: "/tmp/earcon.mp3" });
		await flush();
		expect(rig.resources).toEqual([{ kind: "file", path: "/tmp/earcon.mp3" }]);
		expect(rig.player.played).toHaveLength(1);
		rig.tick(50);
		rig.player.fire("playing");
		rig.tick(300);
		rig.player.fire("idle");
		const result = await p;
		expect(result.playbackStartMs).toBe(50);
		expect(result.durationMs).toBe(300);
		expect(result.ttsFirstByteMs).toBe(0);
		expect(result.cancelled).toBe(false);
	});
});

describe("serial queue", () => {
	it("does not start the second utterance until the first goes idle", async () => {
		const rig = makeRig();
		const p1 = rig.speaker.speak({ kind: "file", path: "/a.mp3" });
		const p2 = rig.speaker.speak({ kind: "file", path: "/b.mp3" });
		await flush();
		expect(rig.player.played).toHaveLength(1);
		rig.player.fire("playing");
		rig.player.fire("idle");
		await p1;
		await flush();
		expect(rig.player.played).toHaveLength(2);
		rig.player.fire("playing");
		rig.player.fire("idle");
		await p2;
	});
});

describe("stop (barge-in fast path)", () => {
	it("synchronously stops the player and cancels current + queued utterances", async () => {
		const rig = makeRig();
		const p1 = rig.speaker.speak({ kind: "file", path: "/a.mp3" });
		const p2 = rig.speaker.speak({ kind: "file", path: "/b.mp3" });
		const p3 = rig.speaker.speak({ kind: "file", path: "/c.mp3" });
		await flush();
		rig.player.fire("playing");
		rig.speaker.stop();
		expect(rig.player.stops).toBe(1); // synchronous local call
		const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
		expect(r1.cancelled).toBe(true);
		expect(r2.cancelled).toBe(true);
		expect(r3.cancelled).toBe(true);
		expect(rig.player.played).toHaveLength(1); // b/c never played
	});

	it("accepts new utterances after a stop", async () => {
		const rig = makeRig();
		const p1 = rig.speaker.speak({ kind: "file", path: "/a.mp3" });
		await flush();
		rig.speaker.stop();
		await p1;
		const p2 = rig.speaker.speak({ kind: "file", path: "/d.mp3" });
		await flush();
		expect(rig.player.played).toHaveLength(2);
		rig.player.fire("playing");
		rig.player.fire("idle");
		const r2 = await p2;
		expect(r2.cancelled).toBe(false);
	});
});

describe("text via injected TTS", () => {
	function makeTts() {
		const calls: { text: string; voice: string; signal: AbortSignal }[] = [];
		return {
			calls,
			synthesize: async (
				text: string,
				voice: string,
				opts: { signal: AbortSignal },
			) => {
				calls.push({ text, voice, signal: opts.signal });
				return {
					audio: Buffer.from("mp3-bytes"),
					format: {
						encoding: "mp3" as const,
						sampleRateHz: 24_000,
						channels: 1 as const,
					},
					ttsFirstByteMs: 42,
				};
			},
		};
	}

	it("synthesizes with the configured voice and propagates ttsFirstByteMs", async () => {
		const tts = makeTts();
		const rig = makeRig({ tts, voice: "zh-CN-YunxiNeural" });
		const p = rig.speaker.speak({ kind: "text", text: "会议开好了" });
		await flush();
		expect(tts.calls).toHaveLength(1);
		expect(tts.calls[0]!.text).toBe("会议开好了");
		expect(tts.calls[0]!.voice).toBe("zh-CN-YunxiNeural");
		expect(rig.resources).toHaveLength(1);
		expect((rig.resources[0] as { kind: string }).kind).toBe("stream");
		rig.player.fire("playing");
		rig.player.fire("idle");
		const r = await p;
		expect(r.ttsFirstByteMs).toBe(42);
	});

	it("rejects a text utterance without an injected TTS engine", async () => {
		const rig = makeRig();
		await expect(
			rig.speaker.speak({ kind: "text", text: "no engine" }),
		).rejects.toThrow(/tts/i);
	});

	it("a TTS failure rejects that utterance but the queue continues", async () => {
		const tts = {
			synthesize: async () => {
				throw new Error("edge-tts exploded");
			},
		};
		const rig = makeRig({ tts });
		const p1 = rig.speaker.speak({ kind: "text", text: "boom" });
		const p2 = rig.speaker.speak({ kind: "file", path: "/ok.mp3" });
		await expect(p1).rejects.toThrow(/edge-tts exploded/);
		await flush();
		expect(rig.player.played).toHaveLength(1);
		rig.player.fire("playing");
		rig.player.fire("idle");
		const r2 = await p2;
		expect(r2.cancelled).toBe(false);
	});

	it("stop during synth aborts the TTS signal and resolves cancelled", async () => {
		let capturedSignal: AbortSignal | undefined;
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const tts = {
			synthesize: async (
				_t: string,
				_v: string,
				opts: { signal: AbortSignal },
			) => {
				capturedSignal = opts.signal;
				await gate;
				return {
					audio: Buffer.from("x"),
					format: {
						encoding: "mp3" as const,
						sampleRateHz: 24_000,
						channels: 1 as const,
					},
					ttsFirstByteMs: 1,
				};
			},
		};
		const rig = makeRig({ tts });
		const p = rig.speaker.speak({ kind: "text", text: "slow" });
		await flush();
		rig.speaker.stop();
		expect(capturedSignal?.aborted).toBe(true);
		release();
		const r = await p;
		expect(r.cancelled).toBe(true);
		expect(rig.player.played).toHaveLength(0); // never reached the player
	});
});

describe("player error", () => {
	it("rejects the current utterance on a player error and continues", async () => {
		const rig = makeRig();
		const p1 = rig.speaker.speak({ kind: "file", path: "/a.mp3" });
		const p2 = rig.speaker.speak({ kind: "file", path: "/b.mp3" });
		await flush();
		rig.player.fire("playing");
		rig.player.fire("error", new Error("opus encoder died"));
		await expect(p1).rejects.toThrow(/opus encoder died/);
		await flush();
		expect(rig.player.played).toHaveLength(2);
		rig.player.fire("playing");
		rig.player.fire("idle");
		await p2;
	});
});
