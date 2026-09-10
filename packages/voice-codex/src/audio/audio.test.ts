import { describe, expect, it, vi } from "vitest";
import { AudioClock } from "./AudioClock.js";
import { FrameQueue } from "./FrameQueue.js";
import { JitterBuffer } from "./JitterBuffer.js";
import { Downmix48to24, Up24to48Stereo } from "./Resample.js";
import { PCM24_MONO_SILENCE, PCM48_STEREO_SILENCE } from "./Silence.js";

function pcm16(samples: number[]): Buffer {
	const output = Buffer.alloc(samples.length * 2);
	samples.forEach((sample, index) => output.writeInt16LE(sample, index * 2));
	return output;
}

describe("audio frame primitives", () => {
	it("cuts arbitrary chunks into exact downlink frames and flushes residue", () => {
		const queue = new FrameQueue(8);
		queue.push(Buffer.from([1, 2, 3]));
		expect(queue.residueBytes()).toBe(3);
		queue.push(Buffer.from([4, 5, 6, 7, 8, 9, 10]));
		expect(queue.depth()).toBe(1);
		expect(queue.residueBytes()).toBe(2);
		expect(queue.take()).toEqual(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
		expect(queue.depth()).toBe(0);
		queue.flush();
		expect(queue.residueBytes()).toBe(0);
		queue.push(Buffer.alloc(6));
		expect(queue.depth()).toBe(0);
	});

	it("prebuffers uplink, drops oldest on overflow, and re-prebuffers after underflow", () => {
		const jitter = new JitterBuffer({
			frameBytes: 2,
			prebufferFrames: 2,
			maxFrames: 3,
		});
		jitter.push(Buffer.from([1, 1]));
		expect(jitter.take()).toEqual(Buffer.alloc(2));
		jitter.push(Buffer.from([2, 2]));
		jitter.push(Buffer.from([3, 3]));
		jitter.push(Buffer.from([4, 4]));
		jitter.push(Buffer.from([5, 5]));
		expect(jitter.droppedOverflow).toBe(2);
		expect(jitter.take()).toEqual(Buffer.from([3, 3]));
		expect(jitter.take()).toEqual(Buffer.from([4, 4]));
		expect(jitter.take()).toEqual(Buffer.from([5, 5]));
		expect(jitter.take()).toEqual(Buffer.alloc(2));
	});

	it("defines exact 20ms silence frames", () => {
		expect(PCM24_MONO_SILENCE).toHaveLength(960);
		expect(PCM48_STEREO_SILENCE).toHaveLength(3_840);
		expect(PCM24_MONO_SILENCE.every((byte) => byte === 0)).toBe(true);
	});
});

describe("stateful resampling", () => {
	it("is byte-identical between whole and chunked downmix input", () => {
		const input = pcm16([
			1_000, 3_000, 2_000, 4_000, -1_000, -3_000, -2_000, -4_000,
		]);
		const whole = new Downmix48to24().push(input);
		const chunkedResampler = new Downmix48to24();
		const chunked = Buffer.concat([
			chunkedResampler.push(input.subarray(0, 8)),
			chunkedResampler.push(input.subarray(8)),
		]);
		expect(chunked).toEqual(whole);
		expect(whole).toEqual(pcm16([2_500, -2_500]));
	});

	it("is byte-identical between whole and chunked 24k-to-48k stereo input", () => {
		const input = pcm16([0, 1_000, -1_000, 2_000]);
		const whole = new Up24to48Stereo().push(input);
		const chunkedResampler = new Up24to48Stereo();
		const chunked = Buffer.concat([
			chunkedResampler.push(input.subarray(0, 4)),
			chunkedResampler.push(input.subarray(4)),
		]);
		expect(chunked).toEqual(whole);
		expect(whole).toHaveLength(input.length * 4);
	});
});

describe("AudioClock", () => {
	it("reports only elapsed scheduled ticks and fires the current frame once", () => {
		let now = 0;
		let scheduled: (() => void) | undefined;
		const fire = vi.fn();
		const dropped = vi.fn();
		const clock = new AudioClock({
			intervalMs: 20,
			now: () => now,
			schedule: (callback) => {
				scheduled = callback;
				return 1;
			},
			cancel: () => {},
			onFire: fire,
			onDropped: dropped,
		});
		clock.start();
		now = 250;
		scheduled?.();
		expect(dropped).toHaveBeenCalledTimes(11);
		expect(fire).toHaveBeenCalledTimes(1);
		expect(dropped.mock.calls.length + fire.mock.calls.length).toBe(12);
		clock.stop();
	});
});
