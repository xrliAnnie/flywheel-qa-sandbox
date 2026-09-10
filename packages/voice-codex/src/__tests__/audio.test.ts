import { describe, expect, it, vi } from "vitest";
import { Downmix48to24, WaitingMouth } from "../audio.js";

function pcm16(samples: number[]): Buffer {
	const output = Buffer.alloc(samples.length * 2);
	samples.forEach((sample, index) => output.writeInt16LE(sample, index * 2));
	return output;
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
	it("drains a final partial frame with silence padding", () => {
		let tick!: () => void;
		const frames: Buffer[] = [];
		const mouth = new WaitingMouth({
			player: { play: vi.fn(), stop: vi.fn() },
			createResource: (source) => {
				source.stream.on("data", (chunk: Buffer) => frames.push(chunk));
				return source;
			},
			setIntervalFn: (callback) => {
				tick = callback;
				return 1 as unknown as NodeJS.Timeout;
			},
			clearIntervalFn: vi.fn(),
		});
		mouth.start();
		mouth.feed(pcm16([123, 123, 123]));
		mouth.finish();
		tick();
		mouth.stop();
		expect(frames[0]).toHaveLength(3_840);
		expect(frames[0]?.readInt16LE(0)).toBe(123);
		expect(frames[0]?.subarray(24).every((value) => value === 0)).toBe(true);
	});

	it("preserves every frame when generation gets more than five seconds ahead", () => {
		let tick!: () => void;
		const frames: Buffer[] = [];
		const mouth = new WaitingMouth({
			player: { play: vi.fn(), stop: vi.fn() },
			createResource: (source) => {
				source.stream.on("data", (chunk: Buffer) => frames.push(chunk));
				return source;
			},
			setIntervalFn: (callback) => {
				tick = callback;
				return 1 as unknown as NodeJS.Timeout;
			},
			clearIntervalFn: vi.fn(),
		});
		mouth.start();
		for (let frame = 1; frame <= 260; frame += 1) {
			mouth.feed(pcm16(Array(480).fill(frame)));
		}
		for (let frame = 1; frame <= 260; frame += 1) tick();
		mouth.stop();
		expect(frames).toHaveLength(260);
		expect(frames.map((frame) => frame.readInt16LE(0))).toEqual(
			Array.from({ length: 260 }, (_, index) => index + 1),
		);
	});

	it("plays silence by default and the approved bed only while waiting", () => {
		let tick: (() => void) | undefined;
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
			setIntervalFn: (callback) => {
				tick = callback;
				return 1 as unknown as NodeJS.Timeout;
			},
			clearIntervalFn: vi.fn(),
		});
		mouth.start();
		tick?.();
		expect(output.subarray(0, 3_840).every((byte) => byte === 0)).toBe(true);
		mouth.setWaiting(true);
		tick?.();
		expect(output.subarray(3_840).some((byte) => byte !== 0)).toBe(true);
		mouth.setBedEnabled(false);
		tick?.();
		expect(output.subarray(7_680).every((byte) => byte === 0)).toBe(true);
		mouth.stop();
		expect(player.stop).toHaveBeenCalled();
	});
});
