/**
 * Stateful Discord PCM converter extracted from Raya
 * apps/voice/src/audio/Resample.ts at b1b5a64 (FLY-2446).
 */
import { PassThrough } from "node:stream";
import { upsample24kMonoTo48kStereo } from "flywheel-voice-bridge";

export class Downmix48to24 {
	private bytes = Buffer.alloc(0);
	private pendingMono: number | null = null;

	push(chunk: Buffer): Buffer {
		let input = this.bytes.length
			? Buffer.concat([this.bytes, chunk])
			: Buffer.from(chunk);
		const completeBytes = input.length - (input.length % 4);
		this.bytes = Buffer.from(input.subarray(completeBytes));
		input = input.subarray(0, completeBytes);
		const output: number[] = [];
		for (let offset = 0; offset < input.length; offset += 4) {
			const mono = Math.trunc(
				(input.readInt16LE(offset) + input.readInt16LE(offset + 2)) / 2,
			);
			if (this.pendingMono === null) {
				this.pendingMono = mono;
			} else {
				output.push(
					Math.max(
						-32_768,
						Math.min(32_767, Math.trunc((this.pendingMono + mono) / 2)),
					),
				);
				this.pendingMono = null;
			}
		}
		const result = Buffer.alloc(output.length * 2);
		output.forEach((sample, index) => result.writeInt16LE(sample, index * 2));
		return result;
	}
}

const SAMPLE_RATE = 48_000;
const BOX_B_NOTES = [261.63, 293.66, 329.63, 392, 440] as const;

function boxBHash(index: number): number {
	let value = (index * 1_103_515_245 + 12_345) & 0x7fffffff;
	value ^= value >>> 13;
	return (value * 1_274_126_177) & 0x7fffffff;
}

/** Annie-approved music-box B, extracted from Raya audio/Bed.ts at b1b5a64. */
class BoxBBed {
	private sample = 0;
	private readonly noteCache = new Map<number, number>();

	private noteIndex(index: number): number {
		if (index <= 0) return 2;
		const cached = this.noteCache.get(index);
		if (cached !== undefined) return cached;
		const next = Math.max(
			0,
			Math.min(4, this.noteIndex(index - 1) + ((boxBHash(index) % 3) - 1)),
		);
		this.noteCache.set(index, next);
		return next;
	}

	next(sampleFrames: number): Buffer {
		const output = Buffer.alloc(sampleFrames * 4);
		for (let index = 0; index < sampleFrames; index += 1) {
			const seconds = this.sample / SAMPLE_RATE;
			const currentNote = Math.floor(seconds / 1.5);
			let mixed = 0;
			for (let overlap = 0; overlap < 3; overlap += 1) {
				const note = currentNote - overlap;
				const noteSeconds = seconds - note * 1.5;
				if (note < 0 || noteSeconds < 0 || noteSeconds > 2.6) continue;
				const base = BOX_B_NOTES[this.noteIndex(note)] ?? BOX_B_NOTES[2];
				const frequency = base * ((boxBHash(note) >>> 8) % 100 < 25 ? 2 : 1);
				const envelope = Math.exp(-1.5 * noteSeconds);
				mixed +=
					(Math.sin(2 * Math.PI * frequency * noteSeconds) +
						0.28 *
							Math.sin(2 * Math.PI * 4 * frequency * noteSeconds) *
							Math.exp(-3.3 * noteSeconds)) *
					envelope *
					0.5;
			}
			const value = Math.round(mixed * 0.06 * 32_767);
			output.writeInt16LE(value, index * 4);
			output.writeInt16LE(value, index * 4 + 2);
			this.sample += 1;
		}
		return output;
	}
}

type RawSource = { kind: "raw-stream"; stream: PassThrough };

export class WaitingMouth {
	private readonly stream = new PassThrough({ highWaterMark: 1 << 20 });
	private readonly bed = new BoxBBed();
	private timer?: ReturnType<typeof setInterval>;
	private queued = Buffer.alloc(0);
	private waiting = false;
	private bedEnabled = true;

	constructor(
		private readonly options: {
			player: { play(resource: unknown): void; stop(): void };
			createResource(source: RawSource): unknown;
			setIntervalFn?: typeof setInterval;
			clearIntervalFn?: typeof clearInterval;
		},
	) {}

	start(): void {
		if (this.timer) return;
		this.options.player.play(
			this.options.createResource({ kind: "raw-stream", stream: this.stream }),
		);
		this.timer = (this.options.setIntervalFn ?? setInterval)(
			() => this.tick(),
			20,
		);
		this.timer.unref?.();
	}

	feed(chunk: Buffer): void {
		if (chunk.length === 0 || chunk.length % 2 !== 0) return;
		this.queued = Buffer.concat([this.queued, chunk]);
	}

	flush(): void {
		this.queued = Buffer.alloc(0);
	}

	finish(): void {
		const remaining = this.queued.length % 960;
		if (remaining > 0) {
			this.queued = Buffer.concat([this.queued, Buffer.alloc(960 - remaining)]);
		}
	}

	setWaiting(waiting: boolean): void {
		this.waiting = waiting;
	}

	setBedEnabled(enabled: boolean): void {
		this.bedEnabled = enabled;
	}

	stop(): void {
		if (this.timer) {
			(this.options.clearIntervalFn ?? clearInterval)(this.timer);
			this.timer = undefined;
		}
		this.flush();
		this.stream.end();
		this.options.player.stop();
	}

	private tick(): void {
		const pcm24FrameBytes = 960;
		let output: Buffer;
		if (this.queued.length >= pcm24FrameBytes) {
			output = upsample24kMonoTo48kStereo(
				this.queued.subarray(0, pcm24FrameBytes),
			);
			this.queued = Buffer.from(this.queued.subarray(pcm24FrameBytes));
		} else {
			output =
				this.waiting && this.bedEnabled
					? this.bed.next(960)
					: Buffer.alloc(3_840);
		}
		this.stream.write(output);
	}
}
