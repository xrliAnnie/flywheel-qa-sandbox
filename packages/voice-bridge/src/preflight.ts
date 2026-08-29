/**
 * Startup preflight (FLY-545 P2, Codex R1 #5): the playback stack shells out
 * to ffmpeg for mp3→opus transcode (prism-media StreamType inference), so a
 * missing binary must kill the daemon BEFORE any bot joins a VC — a mouth
 * that joins and then can't make sound is the worst failure shape.
 *
 * Opus encoder note: the pinned encoder is opusscript (pure JS — no native
 * prebuild needed on this Node); @discordjs/opus is an optional accelerator
 * slot, deliberately NOT a dependency (no prebuild for current Node majors).
 */
import { execFile } from "node:child_process";

export type BinaryProbe = (
	bin: string,
	args: string[],
) => Promise<{ ok: boolean; detail: string }>;

const realProbe: BinaryProbe = (bin, args) =>
	new Promise((resolve) => {
		execFile(bin, args, { timeout: 10_000 }, (err, stdout) => {
			if (err) resolve({ ok: false, detail: err.message });
			else resolve({ ok: true, detail: stdout.split("\n")[0] ?? "" });
		});
	});

export async function verifyPlaybackStack(
	ffmpegBin: string,
	probe: BinaryProbe = realProbe,
): Promise<void> {
	const result = await probe(ffmpegBin, ["-version"]);
	if (!result.ok) {
		throw new Error(
			`voice-bridge preflight: ffmpeg not runnable at "${ffmpegBin}" (${result.detail.trim()}) — install ffmpeg or set FLYWHEEL_VOICE_FFMPEG; the mp3→opus playback path cannot work without it`,
		);
	}
}
