/**
 * FLY-545 P3 — pure-PCM resamplers (no ffmpeg subprocess on the 20ms hot path).
 *
 * Down: Discord decoded s16le 48kHz stereo → Gemini s16le 16kHz mono
 *   (downmix L/R average, then 3:1 box-average decimation — the box filter is
 *   a crude low-pass that beats bare take-every-3rd for ASR input).
 * Up: Gemini s16le 24kHz mono → Discord s16le 48kHz stereo
 *   (2x zero-order hold, duplicated into both channels — D1-A playback path).
 * Both are STATEFUL streamers: chunk boundaries carry remainders so a split
 * stream produces byte-identical output to a single push.
 */
import { describe, expect, it } from "vitest";
import {
	StereoDownmixDecimator,
	upsample24kMonoTo48kStereo,
} from "../audio/resample.js";

/** build an s16le buffer from sample values. */
function s16(...samples: number[]): Buffer {
	const buf = Buffer.alloc(samples.length * 2);
	samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
	return buf;
}

function readS16(buf: Buffer): number[] {
	const out: number[] = [];
	for (let i = 0; i < buf.length; i += 2) out.push(buf.readInt16LE(i));
	return out;
}

describe("StereoDownmixDecimator (48k stereo → 16k mono)", () => {
	it("averages L/R then box-averages groups of 3", () => {
		// 3 stereo frames: (100,200) (100,200) (100,200) → downmix 150,150,150 → one 150
		const d = new StereoDownmixDecimator();
		const out = d.push(s16(100, 200, 100, 200, 100, 200));
		expect(readS16(out)).toEqual([150]);
	});

	it("produces one output sample per 3 input frames (6 → 2)", () => {
		const d = new StereoDownmixDecimator();
		// frames downmix to 10,20,30,40,50,60 → box groups (10,20,30)=20, (40,50,60)=50
		const out = d.push(s16(10, 10, 20, 20, 30, 30, 40, 40, 50, 50, 60, 60));
		expect(readS16(out)).toEqual([20, 50]);
	});

	it("carries remainders across pushes (split == single push)", () => {
		const whole = s16(10, 10, 20, 20, 30, 30, 40, 40, 50, 50, 60, 60);
		const single = new StereoDownmixDecimator().push(whole);
		const split = new StereoDownmixDecimator();
		const parts: Buffer[] = [];
		// deliberately misaligned splits: 5 bytes / 9 bytes / rest
		parts.push(split.push(whole.subarray(0, 5)));
		parts.push(split.push(whole.subarray(5, 14)));
		parts.push(split.push(whole.subarray(14)));
		expect(Buffer.concat(parts).equals(single)).toBe(true);
	});

	it("handles a 20ms Discord frame (960 stereo frames → 320 mono samples)", () => {
		const d = new StereoDownmixDecimator();
		const out = d.push(Buffer.alloc(960 * 2 * 2)); // silence
		expect(out.length).toBe(320 * 2);
	});

	it("rounds the L/R average to the nearest integer", () => {
		const d = new StereoDownmixDecimator();
		// (1,2)→1.5, three identical → box avg 1.5 → round 2
		const out = d.push(s16(1, 2, 1, 2, 1, 2));
		expect(readS16(out)).toEqual([2]);
	});
});

describe("upsample24kMonoTo48kStereo", () => {
	it("duplicates each sample 2x into both channels (N mono → 4N samples)", () => {
		const out = upsample24kMonoTo48kStereo(s16(7, -3));
		// 7 → two stereo frames (7,7)(7,7); -3 → (-3,-3)(-3,-3)
		expect(readS16(out)).toEqual([7, 7, 7, 7, -3, -3, -3, -3]);
	});

	it("throws on a non-sample-aligned buffer (odd byte length)", () => {
		expect(() => upsample24kMonoTo48kStereo(Buffer.alloc(3))).toThrow(
			/aligned/i,
		);
	});
});
