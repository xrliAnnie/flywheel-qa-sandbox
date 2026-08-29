/**
 * StreamPlayer — streams PCM chunks to ffplay's stdin (converse face, 24kHz
 * mono s16le). interrupt() = kill + reopen: killing flushes ffplay's buffered
 * audio (barge-in stop), and the next feed() lazily spawns a fresh player.
 */
import {
	NodeProcessRunner,
	type ProcessHandle,
	type ProcessRunner,
} from "../process.js";

export interface StreamPlayerOptions {
	ffplayBin: string;
	sampleRateHz?: number;
	runner?: ProcessRunner;
}

export class StreamPlayer {
	private readonly runner: ProcessRunner;
	private readonly sampleRateHz: number;
	private handle?: ProcessHandle;
	/** ms timestamp of the first chunk of the current playback (perceived start). */
	playbackStartAt?: number;

	constructor(private readonly opts: StreamPlayerOptions) {
		this.runner = opts.runner ?? new NodeProcessRunner();
		this.sampleRateHz = opts.sampleRateHz ?? 24_000;
	}

	private ensure(): ProcessHandle {
		if (!this.handle) {
			this.handle = this.runner.spawn(this.opts.ffplayBin, [
				"-hide_banner",
				"-loglevel",
				"error",
				"-f",
				"s16le",
				"-ar",
				String(this.sampleRateHz),
				"-ch_layout",
				"mono",
				"-nodisp",
				"-autoexit",
				"-i",
				"pipe:0",
			]);
			this.playbackStartAt = undefined;
		}
		return this.handle;
	}

	feed(chunk: Buffer): void {
		const h = this.ensure();
		if (this.playbackStartAt === undefined) this.playbackStartAt = Date.now();
		h.write(chunk);
	}

	/** barge-in stop: kill the player (flushes its buffer); next feed respawns. */
	interrupt(): void {
		this.handle?.kill("SIGTERM");
		this.handle = undefined;
		this.playbackStartAt = undefined;
	}

	close(): void {
		this.handle?.end();
		this.handle = undefined;
		this.playbackStartAt = undefined;
	}
}
