/**
 * Stateful Discord PCM converter extracted from Raya
 * apps/voice/src/audio/Resample.ts at b1b5a64 (FLY-2446).
 */
import { PassThrough } from "node:stream";

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

const FRAME_MS = 20;
/** One 20ms frame of 24 kHz mono PCM16. */
const PCM24_FRAME_BYTES = 960;
/** One 20ms frame of 48 kHz stereo PCM16. */
const PCM48_STEREO_FRAME_BYTES = 3_840;
/**
 * Frames kept queued ahead of the player while speech is playing. The player
 * pulls a frame every 20ms on its own timer; with nothing queued, any
 * event-loop stall longer than one frame is an audible break. 200ms covers the
 * stalls measured in the FLY-2799 qa6 room (p99 177ms). A barge-in drops the
 * whole queue (see dropQueuedOutput), so this lead never delays a cancel.
 */
export const SPEECH_LEAD_FRAMES = 10;
/** Frames kept ahead while idle: small, so new speech starts promptly. */
export const IDLE_LEAD_FRAMES = 2;
/**
 * A stall longer than this is not back-filled on the wall clock: the player
 * has already skipped those slots and later speech must not queue behind them.
 */
const MAX_CATCH_UP_FRAMES = 50;

/**
 * 20ms of 24 kHz mono PCM16 → 48 kHz stereo by linear interpolation. `next`
 * is the first sample of the following frame when it is already known; the
 * last sample is held otherwise. Zero-order hold (duplicating each sample)
 * leaves a strong image of the voice band above 12 kHz; interpolating the
 * midpoint attenuates it further (FLY-2799 qa6: "音色奇怪").
 */
function upsampleFrameLinear(frame: Buffer, next: number | undefined): Buffer {
	const samples = frame.length / 2;
	const output = Buffer.alloc(samples * 8);
	for (let index = 0; index < samples; index += 1) {
		const current = frame.readInt16LE(index * 2);
		const following =
			index + 1 < samples
				? frame.readInt16LE(index * 2 + 2)
				: (next ?? current);
		const midpoint = Math.round((current + following) / 2);
		const base = index * 8;
		output.writeInt16LE(current, base);
		output.writeInt16LE(current, base + 2);
		output.writeInt16LE(midpoint, base + 4);
		output.writeInt16LE(midpoint, base + 6);
	}
	return output;
}

/** A speech whose audio may still be arriving while it plays. */
export interface SpeechStream {
	/** Queue more 24 kHz mono PCM16; false once the speech ended or was stopped. */
	append(pcm24Mono: Buffer): boolean;
	/** No more audio follows; `done` settles once the last frame is written. */
	end(): void;
	/** Stop this speech now (queued frames included). */
	cancel(): void;
	/** Resolves after the final frame is submitted; rejects when stopped. */
	readonly done: Promise<void>;
}

interface QueuedSpeech {
	id: string;
	pcm24Mono: Buffer;
	offset: number;
	ended: boolean;
	resolve(): void;
	reject(error: Error): void;
}

export type WaitingMouthDiagnostic =
	| {
			/**
			 * Mid-speech, the player had taken everything queued (or more, on the
			 * wall clock) when the mouth next ran: the lead did not cover the gap
			 * since the previous run, which is an audible break.
			 */
			kind: "playback_underrun";
			speechId: string;
			queuedFrames: number;
			sincePreviousPumpMs: number;
			/** The speech was still streaming and its next frame had not arrived. */
			upstreamStarved: boolean;
	  }
	| { kind: "playback_flushed"; droppedFrames: number };

export class WaitingMouth {
	private stream = new PassThrough({ highWaterMark: 1 << 20 });
	private resource: unknown;
	private readonly bed = new BoxBBed();
	private timer?: ReturnType<typeof setInterval>;
	private readonly speechQueue: QueuedSpeech[] = [];
	private waiting = false;
	private bedEnabled = true;
	private writeBlocked = false;
	private stopped = false;
	private openedAt = 0;
	private lastPumpAt?: number;
	private framesWritten = 0;
	/** Frame count just past the last speech frame in the current output. */
	private speechWrittenUntil = 0;
	private readonly now: () => number;

	constructor(
		private readonly options: {
			player: { play(resource: unknown): void; stop(): void };
			createResource(source: RawSource): unknown;
			assertLease?(): void;
			onError?(error: Error): void;
			onDiagnostic?(record: WaitingMouthDiagnostic): void;
			setIntervalFn?: typeof setInterval;
			clearIntervalFn?: typeof clearInterval;
			/** Monotonic milliseconds; paces output when the player does not report its position. */
			now?: () => number;
			speechLeadFrames?: number;
			idleLeadFrames?: number;
		},
	) {
		this.now = options.now ?? (() => performance.now());
	}

	start(): void {
		if (this.timer || this.stopped) return;
		this.openOutput();
		this.timer = (this.options.setIntervalFn ?? setInterval)(
			() => this.tick(),
			FRAME_MS,
		);
		this.timer.unref?.();
		this.pump();
	}

	playSpeech(speechId: string, pcm24Mono: Buffer): Promise<void> {
		if (pcm24Mono.length === 0 || pcm24Mono.length % 2 !== 0) {
			return Promise.reject(new Error("speech_playback_invalid"));
		}
		const speech = this.openSpeech(speechId);
		speech.append(pcm24Mono);
		speech.end();
		return speech.done;
	}

	openSpeech(speechId: string): SpeechStream {
		if (
			!speechId ||
			this.stopped ||
			this.speechQueue.some((speech) => speech.id === speechId)
		) {
			const done = Promise.reject(new Error("speech_playback_invalid"));
			return {
				append: () => false,
				end: () => undefined,
				cancel: () => undefined,
				done,
			};
		}
		let settle!: Pick<QueuedSpeech, "resolve" | "reject">;
		const done = new Promise<void>((resolve, reject) => {
			settle = { resolve, reject };
		});
		const speech: QueuedSpeech = {
			id: speechId,
			pcm24Mono: Buffer.alloc(0),
			offset: 0,
			ended: false,
			...settle,
		};
		this.speechQueue.push(speech);
		return {
			append: (pcm24Mono) => this.appendSpeech(speech, pcm24Mono),
			end: () => this.endSpeech(speech),
			cancel: () => this.cancelSpeech(speechId),
			done,
		};
	}

	cancelSpeech(speechId: string): void {
		const index = this.speechQueue.findIndex(
			(speech) => speech.id === speechId,
		);
		if (index < 0) return;
		const [cancelled] = this.speechQueue.splice(index, 1);
		cancelled?.reject(new Error("speech_playback_stopped"));
		if (index === 0 && (cancelled?.offset ?? 0) > 0) this.dropQueuedOutput();
	}

	cancelAllSpeech(): void {
		this.flush();
	}

	flush(): void {
		const pending = this.speechQueue.splice(0);
		for (const speech of pending) {
			speech.reject(new Error("speech_playback_stopped"));
		}
		if (this.speechWrittenUntil > this.consumedFrames())
			this.dropQueuedOutput();
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
		this.stopped = true;
		this.flush();
		this.stream.end();
		this.options.player.stop();
	}

	private appendSpeech(speech: QueuedSpeech, pcm24Mono: Buffer): boolean {
		if (speech.ended || !this.speechQueue.includes(speech)) return false;
		if (pcm24Mono.length % 2 !== 0) {
			this.speechQueue.splice(this.speechQueue.indexOf(speech), 1);
			speech.reject(new Error("speech_playback_invalid"));
			return false;
		}
		speech.pcm24Mono = Buffer.concat([speech.pcm24Mono, pcm24Mono]);
		return true;
	}

	private endSpeech(speech: QueuedSpeech): void {
		if (speech.ended || !this.speechQueue.includes(speech)) return;
		speech.ended = true;
		const remaining = speech.pcm24Mono.length % PCM24_FRAME_BYTES;
		if (remaining > 0) {
			speech.pcm24Mono = Buffer.concat([
				speech.pcm24Mono,
				Buffer.alloc(PCM24_FRAME_BYTES - remaining),
			]);
		}
		if (speech.offset >= speech.pcm24Mono.length) {
			this.speechQueue.splice(this.speechQueue.indexOf(speech), 1);
			speech.resolve();
		}
	}

	private openOutput(): void {
		this.stream = new PassThrough({ highWaterMark: 1 << 20 });
		this.resource = this.options.createResource({
			kind: "raw-stream",
			stream: this.stream,
		});
		this.options.player.play(this.resource);
		this.openedAt = this.now();
		this.framesWritten = 0;
		this.speechWrittenUntil = 0;
		this.writeBlocked = false;
	}

	/**
	 * Frames the player has taken from the current output. A discord.js
	 * AudioResource reports it exactly (playbackDuration grows 20ms per frame
	 * read); anything else is paced on the wall clock.
	 */
	private consumedFrames(): number {
		const reported = (this.resource as { playbackDuration?: unknown } | null)
			?.playbackDuration;
		if (typeof reported === "number" && Number.isFinite(reported)) {
			return Math.floor(reported / FRAME_MS);
		}
		return Math.floor((this.now() - this.openedAt) / FRAME_MS);
	}

	/**
	 * Barge-in: frames already queued for the player must not be heard. Handing
	 * the player a new resource destroys the old one and everything buffered in
	 * it immediately.
	 */
	private dropQueuedOutput(): void {
		if (this.stopped || !this.timer) return;
		const previous = this.stream;
		const droppedFrames = Math.max(
			0,
			this.framesWritten - this.consumedFrames(),
		);
		this.openOutput();
		previous.destroy();
		this.options.onDiagnostic?.({ kind: "playback_flushed", droppedFrames });
		this.pump();
	}

	private tick(): void {
		if (this.stopped || this.writeBlocked) return;
		try {
			this.options.assertLease?.();
		} catch (error) {
			this.stop();
			this.options.onError?.(error as Error);
			return;
		}
		this.pump();
	}

	private pump(): void {
		const pumpedAt = this.now();
		const sincePreviousPumpMs =
			this.lastPumpAt === undefined ? 0 : pumpedAt - this.lastPumpAt;
		this.lastPumpAt = pumpedAt;
		const consumed = this.consumedFrames();
		const head = this.speechQueue[0];
		if (head && head.offset > 0 && this.framesWritten <= consumed) {
			this.options.onDiagnostic?.({
				kind: "playback_underrun",
				speechId: head.id,
				queuedFrames: this.framesWritten - consumed,
				sincePreviousPumpMs: Math.round(sincePreviousPumpMs),
				upstreamStarved: !head.ended && !this.speechReady(),
			});
		}
		if (consumed - this.framesWritten > MAX_CATCH_UP_FRAMES) {
			this.framesWritten = consumed - MAX_CATCH_UP_FRAMES;
			this.speechWrittenUntil = Math.min(
				this.speechWrittenUntil,
				this.framesWritten,
			);
		}
		while (!this.stopped && !this.writeBlocked) {
			const lead = this.speechReady()
				? (this.options.speechLeadFrames ?? SPEECH_LEAD_FRAMES)
				: (this.options.idleLeadFrames ?? IDLE_LEAD_FRAMES);
			if (this.framesWritten >= consumed + lead) break;
			this.writeFrame();
		}
	}

	private speechReady(): boolean {
		const speech = this.speechQueue[0];
		return (
			speech !== undefined &&
			speech.pcm24Mono.length - speech.offset >= PCM24_FRAME_BYTES
		);
	}

	private writeFrame(): void {
		const speech = this.speechReady() ? this.speechQueue[0] : undefined;
		let output: Buffer;
		if (speech) {
			const frame = speech.pcm24Mono.subarray(
				speech.offset,
				speech.offset + PCM24_FRAME_BYTES,
			);
			const nextOffset = speech.offset + PCM24_FRAME_BYTES;
			output = upsampleFrameLinear(
				frame,
				nextOffset + 2 <= speech.pcm24Mono.length
					? speech.pcm24Mono.readInt16LE(nextOffset)
					: undefined,
			);
			speech.offset = nextOffset;
		} else {
			output =
				this.waiting && this.bedEnabled
					? this.bed.next(960)
					: Buffer.alloc(PCM48_STEREO_FRAME_BYTES);
		}
		const stream = this.stream;
		const accepted = stream.write(output);
		this.framesWritten += 1;
		if (speech) this.speechWrittenUntil = this.framesWritten;
		if (!accepted) {
			this.writeBlocked = true;
			stream.once("drain", () => {
				if (this.stream === stream) this.writeBlocked = false;
			});
		}
		if (speech?.ended && speech.offset >= speech.pcm24Mono.length) {
			this.speechQueue.shift();
			speech.resolve();
		}
	}
}
