/**
 * Stateful Discord PCM converter extracted from Raya
 * apps/voice/src/audio/Resample.ts at b1b5a64 (FLY-2446).
 */
import { PassThrough } from "node:stream";
import { upsample24kMonoTo48kStereo } from "../audio/resample.js";

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
	private stream?: PassThrough;
	private readonly bed = new BoxBBed();
	private timer?: ReturnType<typeof setInterval>;
	private resourceEpoch = 0;
	private phase: "idle" | "pcm" | "clip" | "closed" = "idle";
	private stopped = false;
	private queued = Buffer.alloc(0);
	private queuedOffset = 0;
	private waiting = false;
	private bedEnabled = true;
	private writeBlocked = false;
	private pendingSpeech?: {
		id: string;
		ended: boolean;
		resolve(): void;
		reject(error: Error): void;
	};
	private readonly pendingWrites: Array<{
		id: string;
		chunk: Buffer;
		offset: number;
		resolve(): void;
		reject(error: Error): void;
	}> = [];
	private readonly cancelledSpeechIds = new Set<string>();
	private readonly queuedSpeechIds = new Set<string>();
	private playSpeechTail: Promise<void> = Promise.resolve();
	private activeOneShotId?: string;
	private pendingClip?: {
		id: string;
		epoch: number;
		started: boolean;
		resolve(): void;
		reject(error: Error): void;
	};

	constructor(
		private readonly options: {
			player: {
				play(resource: unknown): void;
				stop(): void;
				on?(
					event: "playing" | "idle" | "error",
					callback: (error?: Error) => void,
				): void;
			};
			createResource(source: RawSource): unknown;
			assertLease?(): void;
			onError?(error: Error): void;
			maxQueueFrames?: number;
			setIntervalFn?: typeof setInterval;
			clearIntervalFn?: typeof clearInterval;
		},
	) {
		options.player.on?.("playing", () => {
			if (this.phase === "clip" && this.pendingClip)
				this.pendingClip.started = true;
		});
		options.player.on?.("idle", () => this.finishClip());
		options.player.on?.("error", (error) =>
			this.failClip(error ?? new Error("clip_playback_failed")),
		);
	}

	start(): void {
		if (this.phase === "closed") return;
		this.stopped = false;
		this.resumePcm();
	}

	beginSpeech(speechId: string): void {
		if (
			!speechId ||
			(this.phase !== "pcm" && this.phase !== "clip") ||
			this.pendingSpeech ||
			this.pendingWrites.length > 0 ||
			this.queuedOffset < this.queued.length
		)
			throw new Error("speech_playback_invalid");
		this.pendingSpeech = {
			id: speechId,
			ended: false,
			resolve: () => {},
			reject: () => {},
		};
		this.cancelledSpeechIds.delete(speechId);
	}

	writeSpeech(speechId: string, pcm24Mono: Buffer): Promise<void> {
		if (
			this.pendingSpeech?.id !== speechId ||
			this.pendingSpeech.ended ||
			pcm24Mono.length === 0 ||
			pcm24Mono.length % 2 !== 0
		)
			return Promise.reject(new Error("speech_playback_invalid"));
		const chunk = Buffer.from(pcm24Mono);
		this.compactQueue();
		let offset = 0;
		if (this.phase === "pcm" && this.pendingWrites.length === 0) {
			const accepted = Math.min(
				chunk.length,
				Math.max(0, this.maxQueueBytes() - this.queued.length),
			);
			if (accepted > 0) {
				const admitted = chunk.subarray(0, accepted);
				this.queued = this.queued.length
					? Buffer.concat([this.queued, admitted])
					: Buffer.from(admitted);
				offset = accepted;
			}
			if (offset === chunk.length) return Promise.resolve();
		}
		return new Promise<void>((resolve, reject) => {
			this.pendingWrites.push({ id: speechId, chunk, offset, resolve, reject });
		});
	}

	endSpeech(speechId: string): Promise<void> {
		const pending = this.pendingSpeech;
		if (!pending && this.cancelledSpeechIds.delete(speechId))
			return Promise.reject(new Error("speech_playback_stopped"));
		if (!pending || pending.id !== speechId || pending.ended)
			return Promise.reject(new Error("speech_playback_invalid"));
		pending.ended = true;
		return new Promise<void>((resolve, reject) => {
			pending.resolve = resolve;
			pending.reject = reject;
			this.maybeCompleteSpeech();
		});
	}

	playSpeech(speechId: string, pcm24Mono: Buffer): Promise<void> {
		if (
			!speechId ||
			this.pendingSpeech?.id === speechId ||
			this.queuedSpeechIds.has(speechId) ||
			(this.pendingSpeech && !this.activeOneShotId)
		)
			return Promise.reject(new Error("speech_playback_invalid"));
		if (!this.pendingSpeech && this.queuedSpeechIds.size === 0) {
			this.activeOneShotId = speechId;
			const playback = this.playSpeechNow(speechId, pcm24Mono).finally(() => {
				this.activeOneShotId = undefined;
			});
			this.playSpeechTail = playback.catch(() => {});
			return playback;
		}
		this.queuedSpeechIds.add(speechId);
		const playback = this.playSpeechTail.then(async () => {
			this.queuedSpeechIds.delete(speechId);
			if (this.cancelledSpeechIds.delete(speechId))
				throw new Error("speech_playback_stopped");
			this.activeOneShotId = speechId;
			try {
				await this.playSpeechNow(speechId, pcm24Mono);
			} finally {
				this.activeOneShotId = undefined;
			}
		});
		this.playSpeechTail = playback.catch(() => {});
		return playback;
	}

	private async playSpeechNow(
		speechId: string,
		pcm24Mono: Buffer,
	): Promise<void> {
		this.beginSpeech(speechId);
		const written = this.writeSpeech(speechId, pcm24Mono);
		if (
			this.pendingWrites.length === 0 &&
			this.pendingSpeech?.id === speechId
		) {
			const ended = this.endSpeech(speechId);
			await written;
			await ended;
			return;
		}
		await written;
		await this.endSpeech(speechId);
	}

	playClip(speechId: string, resource: unknown): Promise<void> {
		if (
			!speechId ||
			this.phase !== "pcm" ||
			this.pendingClip ||
			this.pendingSpeech ||
			this.queuedOffset < this.queued.length
		) {
			return Promise.reject(new Error("clip_playback_invalid"));
		}
		this.pausePcm();
		this.phase = "clip";
		const epoch = ++this.resourceEpoch;
		const promise = new Promise<void>((resolve, reject) => {
			this.pendingClip = {
				id: speechId,
				epoch,
				started: false,
				resolve,
				reject,
			};
		});
		try {
			this.options.assertLease?.();
			this.options.player.play(resource);
		} catch (error) {
			this.failClip(error as Error);
		}
		return promise;
	}

	cancelSpeech(speechId: string): void {
		if (this.queuedSpeechIds.has(speechId)) {
			this.cancelledSpeechIds.add(speechId);
			return;
		}
		if (this.pendingClip?.id === speechId) {
			const pending = this.pendingClip;
			this.pendingClip = undefined;
			this.options.player.stop();
			pending.reject(new Error("speech_playback_stopped"));
			this.resumePcm();
			return;
		}
		if (this.pendingSpeech?.id !== speechId) return;
		this.flush();
		this.pausePcm();
		this.resumePcm();
	}

	flush(): void {
		this.queued = Buffer.alloc(0);
		this.queuedOffset = 0;
		const pending = this.pendingSpeech;
		this.pendingSpeech = undefined;
		if (pending) this.cancelledSpeechIds.add(pending.id);
		for (const speechId of this.queuedSpeechIds)
			this.cancelledSpeechIds.add(speechId);
		for (const write of this.pendingWrites.splice(0))
			write.reject(new Error("speech_playback_stopped"));
		pending?.reject(new Error("speech_playback_stopped"));
	}

	setWaiting(waiting: boolean): void {
		this.waiting = waiting;
	}

	setBedEnabled(enabled: boolean): void {
		this.bedEnabled = enabled;
	}

	stop(): void {
		this.stopped = true;
		this.flush();
		const clip = this.pendingClip;
		this.pendingClip = undefined;
		clip?.reject(new Error("speech_playback_stopped"));
		this.pausePcm();
		this.phase = "closed";
	}

	private tick(): void {
		const stream = this.stream;
		const epoch = this.resourceEpoch;
		if (this.phase !== "pcm" || !stream || this.writeBlocked) return;
		try {
			this.options.assertLease?.();
		} catch (error) {
			this.stop();
			this.options.onError?.(error as Error);
			return;
		}
		const pcm24FrameBytes = 960;
		let output: Buffer;
		const queuedBytes = this.queued.length - this.queuedOffset;
		if (queuedBytes >= pcm24FrameBytes) {
			output = upsample24kMonoTo48kStereo(
				this.queued.subarray(
					this.queuedOffset,
					this.queuedOffset + pcm24FrameBytes,
				),
			);
			this.queuedOffset += pcm24FrameBytes;
		} else if (queuedBytes > 0 && this.pendingSpeech?.ended) {
			const finalFrame = Buffer.alloc(pcm24FrameBytes);
			this.queued.copy(finalFrame, 0, this.queuedOffset);
			output = upsample24kMonoTo48kStereo(finalFrame);
			this.queuedOffset = this.queued.length;
		} else {
			output =
				this.waiting && this.bedEnabled
					? this.bed.next(960)
					: Buffer.alloc(3_840);
		}
		const accepted = stream.write(output);
		if (!accepted) {
			this.writeBlocked = true;
			stream.once("drain", () => {
				if (
					this.phase === "pcm" &&
					this.stream === stream &&
					this.resourceEpoch === epoch
				)
					this.writeBlocked = false;
			});
		}
		this.admitPendingWrites();
		this.maybeCompleteSpeech();
	}

	private pausePcm(): void {
		if (this.timer) {
			(this.options.clearIntervalFn ?? clearInterval)(this.timer);
			this.timer = undefined;
		}
		this.writeBlocked = false;
		const stream = this.stream;
		this.stream = undefined;
		stream?.end();
		stream?.destroy();
		this.options.player.stop();
		if (this.phase === "pcm") this.phase = "idle";
	}

	private resumePcm(): void {
		if (this.stopped || this.phase === "closed") return;
		if (this.phase === "pcm" && this.timer && this.stream) return;
		const stream = new PassThrough({ highWaterMark: 1 << 20 });
		this.stream = stream;
		this.phase = "pcm";
		this.writeBlocked = false;
		this.resourceEpoch += 1;
		this.options.player.play(
			this.options.createResource({ kind: "raw-stream", stream }),
		);
		this.timer = (this.options.setIntervalFn ?? setInterval)(
			() => this.tick(),
			20,
		);
		this.timer.unref?.();
	}

	private finishClip(): void {
		const pending = this.pendingClip;
		if (
			this.phase !== "clip" ||
			!pending ||
			!pending.started ||
			pending.epoch !== this.resourceEpoch
		)
			return;
		this.pendingClip = undefined;
		pending.resolve();
		this.phase = "idle";
		this.resumePcm();
	}

	private failClip(error: Error): void {
		const pending = this.pendingClip;
		if (this.phase !== "clip" || !pending) return;
		this.pendingClip = undefined;
		pending.reject(error);
		this.options.onError?.(error);
		this.options.player.stop();
		this.phase = "idle";
		this.resumePcm();
	}

	private maxQueueBytes(): number {
		return Math.max(1, this.options.maxQueueFrames ?? 250) * 960;
	}

	private compactQueue(): void {
		if (this.queuedOffset === 0) return;
		this.queued = Buffer.from(this.queued.subarray(this.queuedOffset));
		this.queuedOffset = 0;
	}

	private admitPendingWrites(): void {
		this.compactQueue();
		while (this.pendingWrites.length > 0) {
			const next = this.pendingWrites[0]!;
			if (this.pendingSpeech?.id !== next.id) {
				this.pendingWrites.shift();
				next.reject(new Error("speech_playback_stopped"));
				continue;
			}
			const available = this.maxQueueBytes() - this.queued.length;
			if (available <= 0) break;
			const accepted = Math.min(available, next.chunk.length - next.offset);
			const admitted = next.chunk.subarray(next.offset, next.offset + accepted);
			this.queued = this.queued.length
				? Buffer.concat([this.queued, admitted])
				: Buffer.from(admitted);
			next.offset += accepted;
			if (next.offset < next.chunk.length) break;
			this.pendingWrites.shift();
			next.resolve();
		}
	}

	private maybeCompleteSpeech(): void {
		const pending = this.pendingSpeech;
		if (
			!pending?.ended ||
			this.pendingWrites.length > 0 ||
			this.queuedOffset < this.queued.length
		)
			return;
		this.pendingSpeech = undefined;
		this.queued = Buffer.alloc(0);
		this.queuedOffset = 0;
		pending.resolve();
	}
}
