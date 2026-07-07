/**
 * MicCapture — continuous mic capture via ffmpeg avfoundation, emitting 16kHz
 * mono s16le PCM frames to a callback (converse face, plan.md r2 §4 step 7).
 * A mute toggle stops forwarding frames without tearing down the stream. This
 * replaces the round-1(old) push-to-talk file recorder; VAD/turn boundaries are
 * the streaming backend's job (Gemini server-side VAD).
 */
import {
	NodeProcessRunner,
	type ProcessHandle,
	type ProcessRunner,
} from "../process.js";
import { VoiceError } from "../types.js";

export interface MicCaptureOptions {
	ffmpegBin: string;
	/** avfoundation input spec, e.g. ":0" (default audio device). */
	device?: string;
	sampleRateHz?: number;
	runner?: ProcessRunner;
}

export class MicCapture {
	private readonly runner: ProcessRunner;
	private handle?: ProcessHandle;
	private muted = false;

	constructor(private readonly opts: MicCaptureOptions) {
		this.runner = opts.runner ?? new NodeProcessRunner();
	}

	/** begin streaming; onFrame receives raw 16kHz mono s16le PCM chunks. */
	start(onFrame: (frame: Buffer) => void): void {
		if (this.handle)
			throw new VoiceError("backend-protocol", "mic capture already started");
		const args = [
			"-hide_banner",
			"-loglevel",
			"error",
			"-f",
			"avfoundation",
			"-i",
			this.opts.device ?? ":0",
			"-ar",
			String(this.opts.sampleRateHz ?? 16_000),
			"-ac",
			"1",
			"-f",
			"s16le",
			"pipe:1",
		];
		const handle = this.runner.spawn(this.opts.ffmpegBin, args);
		handle.onStdout((chunk) => {
			if (!this.muted) onFrame(chunk);
		});
		this.handle = handle;
	}

	setMuted(muted: boolean): void {
		this.muted = muted;
	}

	isMuted(): boolean {
		return this.muted;
	}

	stop(): void {
		this.handle?.kill("SIGTERM");
		this.handle = undefined;
	}
}
