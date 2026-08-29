/**
 * FilePlayer — plays a complete audio file (mp3) via afplay (announce face).
 * interrupt = SIGTERM the afplay child. Exposes spawnMs — the LOCAL overhead of
 * writing the temp file + spawning afplay, AFTER synthesis already finished.
 * This is NOT the honest end-to-end "first response" anchor: the founder's
 * perceived latency includes the preceding TTS synth wait, so that anchor is
 * measured one layer up by AnnouncerSession (SpeakResult.playbackStartMs).
 */
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	NodeProcessRunner,
	type ProcessHandle,
	type ProcessRunner,
} from "../process.js";
import { type AudioFormat, VoiceError } from "../types.js";

export interface Playback {
	/** local overhead only: ms from play() call until afplay was spawned (temp
	 * write + spawn). Does NOT include the upstream TTS synth wait — see the
	 * end-to-end SpeakResult.playbackStartMs computed by AnnouncerSession. */
	readonly spawnMs: number;
	/** resolves when playback finishes OR is interrupted. */
	readonly done: Promise<{ interrupted: boolean }>;
	interrupt(): void;
}

/** minimal shape the AnnouncerSession depends on (FilePlayer implements it). */
export interface AudioPlayer {
	play(audio: Buffer, format: AudioFormat): Playback;
}

export interface FilePlayerOptions {
	afplayBin: string;
	runner?: ProcessRunner;
	tmpDir?: string;
}

const EXT: Record<AudioFormat["encoding"], string> = {
	mp3: "mp3",
	wav: "wav",
	pcm16: "pcm",
};

export class FilePlayer implements AudioPlayer {
	private readonly runner: ProcessRunner;

	constructor(private readonly opts: FilePlayerOptions) {
		this.runner = opts.runner ?? new NodeProcessRunner();
	}

	play(audio: Buffer, format: AudioFormat): Playback {
		if (audio.length === 0)
			throw new VoiceError("backend-protocol", "player: empty audio");
		const start = Date.now();
		const path = join(
			this.opts.tmpDir ?? tmpdir(),
			`voice-play-${randomUUID()}.${EXT[format.encoding]}`,
		);
		writeFileSync(path, audio, { mode: 0o600 });
		const handle: ProcessHandle = this.runner.spawn(this.opts.afplayBin, [
			path,
		]);
		const spawnMs = Date.now() - start;
		let interrupted = false;

		const done = new Promise<{ interrupted: boolean }>((resolve) => {
			handle.onExit(() => {
				try {
					rmSync(path, { force: true });
				} catch {
					/* best-effort */
				}
				resolve({ interrupted });
			});
		});

		return {
			spawnMs,
			done,
			interrupt: () => {
				interrupted = true;
				handle.kill("SIGTERM");
			},
		};
	}
}
