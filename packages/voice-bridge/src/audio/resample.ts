/**
 * Pure-PCM resamplers for the huddle audio path (FLY-545 P3).
 *
 * The receive hot path runs every 20ms — spawning ffmpeg per frame is not an
 * option, and the conversions are integer-ratio PCM math (~20 lines each):
 *
 *   down: 48kHz stereo s16le (Discord opus decode) → 16kHz mono s16le (Gemini
 *         input): downmix L/R by average, then 3:1 decimation using a
 *         box-average (a crude low-pass; strictly better than bare
 *         take-every-3rd for ASR input at zero extra cost).
 *   up:   24kHz mono s16le (Gemini D1-A audio out) → 48kHz stereo s16le
 *         (Discord playback): 2x zero-order hold duplicated into both
 *         channels (voice quality is bounded by the 24k source; ZOH is fine).
 *
 * The downmixer is STATEFUL: opus decoder chunks are not guaranteed to land
 * on 3-frame boundaries, so remainder bytes/frames carry across push() calls
 * and a split stream produces byte-identical output to a single push.
 */

const BYTES_PER_STEREO_FRAME = 4; // 2 channels × s16
const DECIMATE = 3; // 48k → 16k

export class StereoDownmixDecimator {
	/** carried-over raw bytes that did not complete a stereo frame. */
	private byteRemainder: Buffer = Buffer.alloc(0);
	/** downmixed mono samples awaiting a full group of 3. */
	private readonly sampleRemainder: number[] = [];

	/** Push 48kHz stereo s16le bytes; returns 16kHz mono s16le bytes. */
	push(chunk: Buffer): Buffer {
		const data = this.byteRemainder.length
			? Buffer.concat([this.byteRemainder, chunk])
			: chunk;
		const wholeFrames = Math.floor(data.length / BYTES_PER_STEREO_FRAME);
		const usedBytes = wholeFrames * BYTES_PER_STEREO_FRAME;
		this.byteRemainder = Buffer.from(data.subarray(usedBytes));

		for (let i = 0; i < wholeFrames; i++) {
			const l = data.readInt16LE(i * BYTES_PER_STEREO_FRAME);
			const r = data.readInt16LE(i * BYTES_PER_STEREO_FRAME + 2);
			this.sampleRemainder.push((l + r) / 2);
		}

		const groups = Math.floor(this.sampleRemainder.length / DECIMATE);
		const out = Buffer.alloc(groups * 2);
		for (let g = 0; g < groups; g++) {
			const base = g * DECIMATE;
			const avg =
				(this.sampleRemainder[base]! +
					this.sampleRemainder[base + 1]! +
					this.sampleRemainder[base + 2]!) /
				DECIMATE;
			out.writeInt16LE(clampS16(Math.round(avg)), g * 2);
		}
		this.sampleRemainder.splice(0, groups * DECIMATE);
		return out;
	}
}

/** 24kHz mono s16le → 48kHz stereo s16le (2x zero-order hold, both channels). */
export function upsample24kMonoTo48kStereo(input: Buffer): Buffer {
	if (input.length % 2 !== 0) {
		throw new Error(
			`upsample24kMonoTo48kStereo: input must be s16-sample-aligned (even byte length), got ${input.length}`,
		);
	}
	const samples = input.length / 2;
	// each mono sample → 2 output frames × 2 channels = 4 output samples
	const out = Buffer.alloc(samples * 8);
	for (let i = 0; i < samples; i++) {
		const v = input.readInt16LE(i * 2);
		const base = i * 8;
		out.writeInt16LE(v, base);
		out.writeInt16LE(v, base + 2);
		out.writeInt16LE(v, base + 4);
		out.writeInt16LE(v, base + 6);
	}
	return out;
}

function clampS16(v: number): number {
	return Math.max(-32768, Math.min(32767, v));
}
