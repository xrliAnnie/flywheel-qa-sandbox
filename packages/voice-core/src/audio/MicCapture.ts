/**
 * MicCapture — continuous mic capture via ffmpeg avfoundation, emitting 16kHz
 * mono s16le PCM frames to a callback (converse face, plan.md r2 §4 step 7).
 * The capture device follows the SYSTEM DEFAULT input (":default") unless an
 * explicit avfoundation spec is given (FLY-959 bug 1 — ":0" is the built-in
 * mic's index, not the default device). A mute toggle stops forwarding frames
 * without tearing down the stream. This replaces the round-1(old) push-to-talk
 * file recorder; VAD/turn boundaries are the streaming backend's job (Gemini
 * server-side VAD).
 */
import {
	NodeProcessRunner,
	type ProcessHandle,
	type ProcessRunner,
} from "../process.js";
import { VoiceError } from "../types.js";

export interface MicCaptureOptions {
	ffmpegBin: string;
	/** avfoundation input spec, e.g. ":default" (system default input) or ":2". */
	device?: string;
	sampleRateHz?: number;
	runner?: ProcessRunner;
}

export class MicCapture {
	private readonly runner: ProcessRunner;
	private handle?: ProcessHandle;
	private muted = false;
	private stopped = false;

	constructor(private readonly opts: MicCaptureOptions) {
		this.runner = opts.runner ?? new NodeProcessRunner();
	}

	/** begin streaming; onFrame receives raw 16kHz mono s16le PCM chunks.
	 * onError fires once if ffmpeg dies while capture is still wanted. */
	start(
		onFrame: (frame: Buffer) => void,
		onError?: (err: VoiceError) => void,
	): void {
		if (this.handle)
			throw new VoiceError("backend-protocol", "mic capture already started");
		this.stopped = false;
		const device = this.opts.device ?? ":default";
		const args = [
			"-hide_banner",
			"-loglevel",
			"error",
			"-f",
			"avfoundation",
			"-i",
			device,
			"-ar",
			String(this.opts.sampleRateHz ?? 16_000),
			"-ac",
			"1",
			"-f",
			"s16le",
			"pipe:1",
		];
		const handle = this.runner.spawn(this.opts.ffmpegBin, args);
		let stderrTail = "";
		handle.onStderr((chunk) => {
			stderrTail = (stderrTail + chunk.toString()).slice(-2000);
		});
		handle.onStdout((chunk) => {
			if (!this.muted) onFrame(chunk);
		});
		handle.onExit((code, signal) => {
			if (this.stopped) return; // intentional stop()
			onError?.(
				new VoiceError(
					"subprocess-failed",
					`mic capture (ffmpeg avfoundation "${device}") exited ${
						code !== null ? `with code ${code}` : `on ${signal}`
					}${stderrTail.trim() ? `: ${stderrTail.trim()}` : ""} — list devices with \`ffmpeg -f avfoundation -list_devices true -i ""\` and set --device or FLYWHEEL_VOICE_MIC_DEVICE (e.g. ":2")`,
				),
			);
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
		this.stopped = true;
		this.handle?.kill("SIGTERM");
		this.handle = undefined;
	}
}
