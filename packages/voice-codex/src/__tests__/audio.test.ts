import { describe, expect, it, vi } from "vitest";
import {
	Downmix48to24,
	WaitingMouth,
	type WaitingMouthDiagnostic,
} from "../audio.js";
import { simulatedPlayer } from "./playback-harness.js";

function pcm16(samples: number[]): Buffer {
	const output = Buffer.alloc(samples.length * 2);
	samples.forEach((sample, index) => output.writeInt16LE(sample, index * 2));
	return output;
}

/**
 * One frame per tick: no lead, and a clock that advances exactly one 20ms
 * frame per tick. Pins the queue semantics independent of lead buffering.
 */
function lockstep() {
	let now = 0;
	let callback!: () => void;
	return {
		now: () => now,
		speechLeadFrames: 0,
		idleLeadFrames: 0,
		setIntervalFn: ((next: () => void) => {
			callback = next;
			return 1 as unknown as NodeJS.Timeout;
		}) as unknown as typeof setInterval,
		clearIntervalFn: vi.fn() as unknown as typeof clearInterval,
		tick: () => {
			now += 20;
			callback();
		},
	};
}

describe("Downmix48to24", () => {
	it("preserves sample continuity across arbitrary decoder chunks", () => {
		const input = pcm16([
			1_000, 3_000, 2_000, 4_000, -1_000, -3_000, -2_000, -4_000,
		]);
		const split = new Downmix48to24();
		expect(
			Buffer.concat([
				split.push(input.subarray(0, 5)),
				split.push(input.subarray(5, 11)),
				split.push(input.subarray(11)),
			]),
		).toEqual(new Downmix48to24().push(input));
		expect(new Downmix48to24().push(input)).toEqual(pcm16([2_500, -2_500]));
	});
});

describe("WaitingMouth", () => {
	it("resolves a speech id only after its final paced frame is submitted", async () => {
		const { tick, ...pacing } = lockstep();
		const frames: Buffer[] = [];
		const mouth = new WaitingMouth({
			player: { play: vi.fn(), stop: vi.fn() },
			createResource: (source) => {
				source.stream.on("data", (chunk: Buffer) => frames.push(chunk));
				return source;
			},
			...pacing,
		});
		mouth.start();
		let completed = false;
		const played = mouth
			.playSpeech("speech-1", pcm16(Array(500).fill(321)))
			.then(() => {
				completed = true;
			});
		tick();
		await Promise.resolve();
		expect(frames).toHaveLength(1);
		expect(completed).toBe(false);
		tick();
		await played;
		expect(frames).toHaveLength(2);
		expect(frames[1]?.subarray(160).every((value) => value === 0)).toBe(true);
		mouth.stop();
	});

	it("plays consecutive speech ids in FIFO order", async () => {
		const { tick, ...pacing } = lockstep();
		const frames: Buffer[] = [];
		const mouth = new WaitingMouth({
			player: { play: vi.fn(), stop: vi.fn() },
			createResource: (source) => {
				source.stream.on("data", (chunk: Buffer) => frames.push(chunk));
				return source;
			},
			...pacing,
		});
		mouth.start();
		const completed: string[] = [];
		const first = mouth
			.playSpeech("speech-1", pcm16(Array(480).fill(111)))
			.then(() => completed.push("speech-1"));
		const second = mouth
			.playSpeech("speech-2", pcm16(Array(480).fill(222)))
			.then(() => completed.push("speech-2"));
		const both = Promise.all([first, second]);

		tick();
		await first;
		expect(completed).toEqual(["speech-1"]);
		expect(frames.map((frame) => frame.readInt16LE(0))).toEqual([111]);

		tick();
		await both;
		expect(completed).toEqual(["speech-1", "speech-2"]);
		expect(frames.map((frame) => frame.readInt16LE(0))).toEqual([111, 222]);
		mouth.stop();
	});

	it("stops queued playback before writing when the lease fence trips", async () => {
		const { tick, ...pacing } = lockstep();
		const onError = vi.fn();
		const player = { play: vi.fn(), stop: vi.fn() };
		const mouth = new WaitingMouth({
			player,
			createResource: (source) => source,
			assertLease: () => {
				throw new Error("lease_lost");
			},
			onError,
			...pacing,
		});
		mouth.start();
		const played = mouth.playSpeech("speech-fenced", Buffer.alloc(960));
		tick();
		await expect(played).rejects.toThrow("speech_playback_stopped");
		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "lease_lost",
			}),
		);
		expect(player.stop).toHaveBeenCalledOnce();
	});

	it("drains a final partial frame with silence padding", async () => {
		const { tick, ...pacing } = lockstep();
		const frames: Buffer[] = [];
		const mouth = new WaitingMouth({
			player: { play: vi.fn(), stop: vi.fn() },
			createResource: (source) => {
				source.stream.on("data", (chunk: Buffer) => frames.push(chunk));
				return source;
			},
			...pacing,
		});
		mouth.start();
		const played = mouth.playSpeech("speech-partial", pcm16([123, 123, 123]));
		tick();
		await played;
		mouth.stop();
		expect(frames[0]).toHaveLength(3_840);
		expect(frames[0]?.readInt16LE(0)).toBe(123);
		expect(frames[0]?.subarray(24).every((value) => value === 0)).toBe(true);
	});

	it("preserves every frame when generation gets more than five seconds ahead", async () => {
		const { tick, ...pacing } = lockstep();
		const frames: Buffer[] = [];
		const mouth = new WaitingMouth({
			player: { play: vi.fn(), stop: vi.fn() },
			createResource: (source) => {
				source.stream.on("data", (chunk: Buffer) => frames.push(chunk));
				return source;
			},
			...pacing,
		});
		mouth.start();
		const played = mouth.playSpeech(
			"speech-long",
			Buffer.concat(
				Array.from({ length: 260 }, (_, index) =>
					pcm16(Array(480).fill(index + 1)),
				),
			),
		);
		for (let frame = 1; frame <= 260; frame += 1) tick();
		await played;
		mouth.stop();
		expect(frames).toHaveLength(260);
		expect(frames.map((frame) => frame.readInt16LE(0))).toEqual(
			Array.from({ length: 260 }, (_, index) => index + 1),
		);
	});

	it("plays silence by default and the approved bed only while waiting", () => {
		const { tick, ...pacing } = lockstep();
		let output = Buffer.alloc(0);
		const player = { play: vi.fn(), stop: vi.fn() };
		const mouth = new WaitingMouth({
			player,
			createResource: (source) => {
				if (source.kind === "raw-stream") {
					source.stream.on("data", (chunk: Buffer) => {
						output = Buffer.concat([output, chunk]);
					});
				}
				return source;
			},
			...pacing,
		});
		mouth.start();
		tick();
		expect(output.subarray(0, 3_840).every((byte) => byte === 0)).toBe(true);
		mouth.setWaiting(true);
		tick();
		expect(output.subarray(3_840).some((byte) => byte !== 0)).toBe(true);
		mouth.setBedEnabled(false);
		tick();
		expect(output.subarray(7_680).every((byte) => byte === 0)).toBe(true);
		mouth.stop();
		expect(player.stop).toHaveBeenCalled();
	});

	it("keeps speech queued ahead of the player so an event-loop stall does not break it", async () => {
		// FLY-2799 qa6: 51 stalls >= 20ms in 72s of playback, the longest 177ms.
		// The player keeps pulling a frame per slot on its own timer; a mouth that
		// only writes one frame per tick leaves nothing queued for those slots.
		let callback!: () => void;
		const simulated = simulatedPlayer();
		const diagnostics: WaitingMouthDiagnostic[] = [];
		const mouth = new WaitingMouth({
			player: simulated.player,
			createResource: simulated.createResource,
			setIntervalFn: ((next: () => void) => {
				callback = next;
				return 1 as unknown as NodeJS.Timeout;
			}) as unknown as typeof setInterval,
			clearIntervalFn: vi.fn() as unknown as typeof clearInterval,
			onDiagnostic: (record) => diagnostics.push(record),
		});
		mouth.start();
		const played = mouth.playSpeech(
			"answer",
			Buffer.concat(
				Array.from({ length: 40 }, (_, index) =>
					pcm16(Array(480).fill(index + 1)),
				),
			),
		);
		callback();
		await Promise.resolve();
		const slot = () => {
			simulated.read();
		};
		// Steady playback: the player and the mouth alternate.
		for (let index = 0; index < 5; index += 1) {
			slot();
			callback();
			await Promise.resolve();
		}
		// A 180ms stall: the mouth's timer is late, the player catches up nine
		// slots back to back when the loop frees.
		for (let index = 0; index < 9; index += 1) slot();
		callback();
		await Promise.resolve();
		while (simulated.heard.filter(Boolean).length < 42) {
			slot();
			callback();
			await Promise.resolve();
		}
		await played;
		mouth.stop();

		const firstSpeech = simulated.heard.findIndex(
			(frame) => frame !== null && frame.readInt16LE(0) !== 0,
		);
		const speechSlots = simulated.heard.slice(firstSpeech, firstSpeech + 40);
		expect(speechSlots.every((frame) => frame !== null)).toBe(true);
		expect(speechSlots.map((frame) => frame!.readInt16LE(0))).toEqual(
			Array.from({ length: 40 }, (_, index) => index + 1),
		);
		expect(
			diagnostics.filter((record) => record.kind === "playback_underrun"),
		).toEqual([]);
	});

	it("records an underrun when a stall outlasts the lead, so a break can be traced", async () => {
		let callback!: () => void;
		const simulated = simulatedPlayer();
		const diagnostics: WaitingMouthDiagnostic[] = [];
		const mouth = new WaitingMouth({
			player: simulated.player,
			createResource: simulated.createResource,
			setIntervalFn: ((next: () => void) => {
				callback = next;
				return 1 as unknown as NodeJS.Timeout;
			}) as unknown as typeof setInterval,
			clearIntervalFn: vi.fn() as unknown as typeof clearInterval,
			onDiagnostic: (record) => diagnostics.push(record),
		});
		mouth.start();
		const played = mouth.playSpeech(
			"answer",
			Buffer.concat(
				Array.from({ length: 40 }, () => pcm16(Array(480).fill(3))),
			),
		);
		callback();
		await Promise.resolve();
		// 300ms without the mouth running: longer than the 200ms speech lead.
		for (let slot = 0; slot < 15; slot += 1) simulated.read();
		callback();
		expect(diagnostics).toContainEqual({
			kind: "playback_underrun",
			speechId: "answer",
			queuedFrames: 0,
			sincePreviousPumpMs: expect.any(Number),
			upstreamStarved: false,
		});
		mouth.cancelAllSpeech();
		await played.catch(() => undefined);
		mouth.stop();
	});

	it("drops speech already queued for the player when it is cancelled mid-play", async () => {
		let callback!: () => void;
		const simulated = simulatedPlayer();
		const diagnostics: WaitingMouthDiagnostic[] = [];
		const mouth = new WaitingMouth({
			player: simulated.player,
			createResource: simulated.createResource,
			setIntervalFn: ((next: () => void) => {
				callback = next;
				return 1 as unknown as NodeJS.Timeout;
			}) as unknown as typeof setInterval,
			clearIntervalFn: vi.fn() as unknown as typeof clearInterval,
			onDiagnostic: (record) => diagnostics.push(record),
		});
		mouth.start();
		const cancelled = mouth.playSpeech(
			"interrupted",
			Buffer.concat(
				Array.from({ length: 50 }, () => pcm16(Array(480).fill(7))),
			),
		);
		const queued = mouth.playSpeech("queued-after", pcm16(Array(480).fill(9)));
		const reasons: string[] = [];
		void cancelled.catch((error: Error) => reasons.push(error.message));
		void queued.catch((error: Error) => reasons.push(error.message));
		callback();
		await Promise.resolve();
		// The idle lead written at start plays first, then the speech.
		for (let index = 0; index < 3; index += 1) simulated.read();
		expect(simulated.heard.at(-1)?.readInt16LE(0)).toBe(7);

		mouth.cancelAllSpeech();
		await Promise.resolve();
		expect(reasons).toEqual([
			"speech_playback_stopped",
			"speech_playback_stopped",
		]);
		const heardAtCancel = simulated.heard.length;
		for (let index = 0; index < 12; index += 1) {
			simulated.read();
			callback();
			await Promise.resolve();
		}
		// The player was handed a fresh output: nothing of either speech plays.
		expect(simulated.player.play).toHaveBeenCalledTimes(2);
		expect(simulated.resources[0]?.stream.destroyed).toBe(true);
		expect(
			simulated.heard
				.slice(heardAtCancel)
				.every((frame) => frame === null || frame.every((byte) => byte === 0)),
		).toBe(true);
		expect(diagnostics).toContainEqual({
			kind: "playback_flushed",
			droppedFrames: expect.any(Number),
		});
		mouth.stop();
	});

	it("starts a streamed speech before its audio is complete and resolves after the end", async () => {
		const { tick, ...pacing } = lockstep();
		const frames: Buffer[] = [];
		const mouth = new WaitingMouth({
			player: { play: vi.fn(), stop: vi.fn() },
			createResource: (source) => {
				source.stream.on("data", (chunk: Buffer) => frames.push(chunk));
				return source;
			},
			...pacing,
		});
		mouth.start();
		const speech = mouth.openSpeech("streamed");
		let completed = false;
		void speech.done.then(() => {
			completed = true;
		});
		expect(speech.append(pcm16(Array(480).fill(11)))).toBe(true);
		tick();
		await Promise.resolve();
		expect(frames.map((frame) => frame.readInt16LE(0))).toEqual([11]);
		// Upstream is momentarily behind: the room stays silent, the speech waits.
		tick();
		await Promise.resolve();
		expect(frames.at(-1)?.every((byte) => byte === 0)).toBe(true);
		expect(completed).toBe(false);
		expect(speech.append(pcm16(Array(240).fill(12)))).toBe(true);
		speech.end();
		expect(speech.append(pcm16([99]))).toBe(false);
		tick();
		await speech.done;
		expect(frames.at(-1)?.readInt16LE(0)).toBe(12);
		expect(completed).toBe(true);
		mouth.stop();
	});

	it("upsamples speech by linear interpolation, continuous across frames", async () => {
		const { tick, ...pacing } = lockstep();
		const frames: Buffer[] = [];
		const mouth = new WaitingMouth({
			player: { play: vi.fn(), stop: vi.fn() },
			createResource: (source) => {
				source.stream.on("data", (chunk: Buffer) => frames.push(chunk));
				return source;
			},
			...pacing,
		});
		mouth.start();
		const ramp = Array.from({ length: 960 }, (_, index) => index * 10);
		const played = mouth.playSpeech("ramp", pcm16(ramp));
		tick();
		tick();
		await played;
		mouth.stop();
		const left = (frame: Buffer) =>
			Array.from({ length: frame.length / 4 }, (_, index) =>
				frame.readInt16LE(index * 4),
			);
		const samples = [...left(frames[0]!), ...left(frames[1]!)];
		// 24 kHz sample n lands on 48 kHz sample 2n; 2n+1 is the midpoint — also
		// across the frame boundary (sample 479 -> 480).
		expect(samples.slice(0, 5)).toEqual([0, 5, 10, 15, 20]);
		expect(samples.slice(957, 962)).toEqual([4785, 4790, 4795, 4800, 4805]);
		expect(frames[0]!.readInt16LE(2)).toBe(0);
		expect(frames[0]!.readInt16LE(6)).toBe(5);
	});
});
