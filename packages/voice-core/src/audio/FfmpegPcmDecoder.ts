import {
	NodeProcessRunner,
	type ProcessHandle,
	type ProcessRunner,
} from "../process.js";
import type { AudioFormat, StreamingTtsChunk } from "../types.js";
import { VoiceError } from "../types.js";

export interface FfmpegPcmDecoderOptions {
	ffmpegBin: string;
	runner?: ProcessRunner;
	/** PCM waiting for a slow consumer; defaults to two seconds at 24 kHz mono. */
	maxBufferedBytes?: number;
	timeoutMs?: number;
}

const PCM24_MONO: AudioFormat = {
	encoding: "pcm16",
	sampleRateHz: 24_000,
	channels: 1,
};

const FFMPEG_ARGS = [
	"-hide_banner",
	"-loglevel",
	"error",
	"-f",
	"mp3",
	"-i",
	"pipe:0",
	"-f",
	"s16le",
	"-acodec",
	"pcm_s16le",
	"-ac",
	"1",
	"-ar",
	"24000",
	"pipe:1",
];

export class FfmpegPcmDecoder {
	private readonly runner: ProcessRunner;
	private readonly maxBufferedBytes: number;
	private readonly timeoutMs: number;

	constructor(private readonly opts: FfmpegPcmDecoderOptions) {
		this.runner = opts.runner ?? new NodeProcessRunner();
		this.maxBufferedBytes = opts.maxBufferedBytes ?? 96_000;
		this.timeoutMs = opts.timeoutMs ?? 30_000;
		if (
			!Number.isSafeInteger(this.maxBufferedBytes) ||
			this.maxBufferedBytes <= 0 ||
			!Number.isSafeInteger(this.timeoutMs) ||
			this.timeoutMs <= 0
		) {
			throw new VoiceError(
				"component-missing",
				"ffmpeg PCM decoder limits must be positive integers",
			);
		}
	}

	async *decode(
		source: AsyncIterable<StreamingTtsChunk>,
		opts: { signal: AbortSignal },
	): AsyncIterable<StreamingTtsChunk> {
		let handle: ProcessHandle;
		try {
			handle = this.runner.spawn(this.opts.ffmpegBin, FFMPEG_ARGS);
		} catch (error) {
			throw new VoiceError(
				"subprocess-failed",
				"ffmpeg PCM decoder could not start",
				error,
			);
		}

		const queued: Buffer[] = [];
		let bufferedBytes = 0;
		let trailingByte: Buffer | undefined;
		let receivedPcm = false;
		let ttsFirstByteMs: number | undefined;
		let inputFinished = false;
		let finished = false;
		let failure: VoiceError | undefined;
		let terminalFailure: VoiceError | undefined;
		let wake: (() => void) | undefined;
		const drainWaiters = new Set<() => void>();
		const releaseDrainWaiters = (): void => {
			for (const resolve of drainWaiters) resolve();
			drainWaiters.clear();
		};
		const notify = (): void => {
			wake?.();
			wake = undefined;
		};
		const fail = (error: VoiceError): void => {
			if (finished || failure) return;
			failure = error;
			handle.kill("SIGKILL");
			releaseDrainWaiters();
			notify();
		};
		const onAbort = (): void =>
			fail(new VoiceError("cancelled", "ffmpeg PCM decode cancelled"));
		opts.signal.addEventListener("abort", onAbort, { once: true });
		if (opts.signal.aborted) onAbort();
		const timeout = setTimeout(
			() =>
				fail(
					new VoiceError(
						"timeout",
						`ffmpeg PCM decoder timed out after ${this.timeoutMs}ms`,
					),
				),
			this.timeoutMs,
		);

		handle.onStdout((chunk) => {
			if (!finished && !failure && chunk.length > 0) {
				if (
					bufferedBytes + (trailingByte?.length ?? 0) + chunk.length >
					this.maxBufferedBytes
				) {
					fail(
						new VoiceError(
							"resource-exhausted",
							`ffmpeg PCM decoder exceeded ${this.maxBufferedBytes} buffered bytes`,
						),
					);
					return;
				}
				const combined = trailingByte
					? Buffer.concat([trailingByte, chunk])
					: chunk;
				const completeLength = combined.length - (combined.length % 2);
				if (completeLength > 0) {
					const complete = combined.subarray(0, completeLength);
					queued.push(complete);
					bufferedBytes += complete.length;
					receivedPcm = true;
				}
				trailingByte =
					completeLength < combined.length
						? Buffer.from(combined.subarray(completeLength))
						: undefined;
				notify();
			}
		});
		let stderr = "";
		handle.onStderr((chunk) => {
			stderr = (stderr + chunk.toString()).slice(-500);
		});
		handle.onDrain(releaseDrainWaiters);
		handle.onError((error) =>
			fail(
				new VoiceError(
					"subprocess-failed",
					`ffmpeg PCM decoder failed: ${error.message}`,
					error,
				),
			),
		);
		handle.onExit((code, signal) => {
			if (failure) return;
			if (code === 0) {
				if (!inputFinished) {
					terminalFailure = new VoiceError(
						"subprocess-failed",
						"ffmpeg PCM decoder exited before input completed",
					);
				} else if (trailingByte) {
					terminalFailure = new VoiceError(
						"subprocess-failed",
						"ffmpeg PCM decoder produced a truncated sample",
					);
				} else if (!receivedPcm) {
					terminalFailure = new VoiceError(
						"subprocess-failed",
						"ffmpeg PCM decoder produced no media",
					);
				}
				finished = true;
				releaseDrainWaiters();
				notify();
				return;
			}
			fail(
				new VoiceError(
					"subprocess-failed",
					`ffmpeg PCM decoder exited ${code ?? signal ?? "unknown"}: ${stderr.trim()}`,
				),
			);
		});

		void (async () => {
			try {
				for await (const chunk of source) {
					if (opts.signal.aborted) {
						throw new VoiceError("cancelled", "ffmpeg PCM decode cancelled");
					}
					if (finished) {
						throw new VoiceError(
							"connection-closed",
							"ffmpeg PCM decoder closed before input completed",
						);
					}
					if (
						chunk.format.encoding !== "mp3" ||
						chunk.format.sampleRateHz !== 24_000 ||
						chunk.format.channels !== 1
					) {
						throw new VoiceError(
							"backend-protocol",
							"ffmpeg PCM decoder requires MP3 mono 24 kHz input",
						);
					}
					ttsFirstByteMs ??= chunk.ttsFirstByteMs;
					if (!handle.write(chunk.audio)) {
						await new Promise<void>((resolve) => drainWaiters.add(resolve));
						if (failure) throw failure;
						if (finished) {
							throw new VoiceError(
								"connection-closed",
								"ffmpeg PCM decoder closed while input was backpressured",
							);
						}
					}
				}
				if (!failure && !finished) {
					inputFinished = true;
					handle.end();
				}
			} catch (error) {
				fail(
					error instanceof VoiceError
						? error
						: new VoiceError(
								"subprocess-failed",
								"ffmpeg PCM decoder input failed",
								error,
							),
				);
			}
		})();

		let first = true;
		try {
			while (true) {
				if (failure) throw failure;
				const audio = queued.shift();
				if (audio) {
					bufferedBytes -= audio.length;
					yield {
						audio,
						format: PCM24_MONO,
						...(first && ttsFirstByteMs !== undefined
							? { ttsFirstByteMs }
							: {}),
					};
					first = false;
					continue;
				}
				if (terminalFailure) throw terminalFailure;
				if (finished) return;
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
			}
		} finally {
			clearTimeout(timeout);
			opts.signal.removeEventListener("abort", onAbort);
			if (!finished && !failure) handle.kill("SIGKILL");
		}
	}
}
