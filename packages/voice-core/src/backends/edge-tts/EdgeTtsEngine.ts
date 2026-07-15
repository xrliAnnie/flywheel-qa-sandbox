/**
 * EdgeTts — TtsEngine backed by edge-tts. Text is passed via a 0600 temp file
 * (`--file`), NOT argv (the eval set contains secret-bearing sentences). Output
 * media is written to a temp mp3 and read back as a Buffer.
 *
 * edge-tts has three caveats (unofficial / rate-limited / no SLA) — that is
 * exactly why TtsEngine is an interface: AzureTts can drop in with the same
 * shape (left as an interface slot, not implemented). Failures are explicit.
 *
 * ttsFirstByteMs note (honest): the file-based CLI is not observably streaming,
 * so first-byte here == synth-complete (media ready). End-to-end "first response"
 * is measured downstream at playback start (plan.md §4 step 8), never here.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapProcessError } from "../../errors.js";
import { NodeProcessRunner, type ProcessRunner } from "../../process.js";
import {
	type AudioFormat,
	type TtsEngine,
	toVoiceSpec,
	VoiceError,
	type VoiceRef,
	type VoiceSpec,
} from "../../types.js";

const MP3_FORMAT: AudioFormat = {
	encoding: "mp3",
	sampleRateHz: 24_000,
	channels: 1,
};

export interface EdgeTtsOptions {
	/** e.g. "edge-tts" or "python". */
	command: string;
	/** e.g. [] or ["-m", "edge_tts"]. */
	baseArgs?: string[];
	timeoutMs?: number;
	runner?: ProcessRunner;
	tmpDir?: string;
}

const RATE_RE = /^[+-]\d+%$/;
const PITCH_RE = /^[+-]\d+Hz$/;

/** Fail-fast on malformed prosody — a config error, not a synth failure. */
function validateVoiceSpec(spec: VoiceSpec): VoiceSpec {
	if (!spec.voiceId.trim()) {
		throw new VoiceError("component-missing", "edge-tts: empty voiceId");
	}
	if (spec.rate !== undefined && !RATE_RE.test(spec.rate)) {
		throw new VoiceError(
			"component-missing",
			`edge-tts: malformed rate "${spec.rate}" (expected ±N%, e.g. -10%)`,
		);
	}
	if (spec.pitch !== undefined && !PITCH_RE.test(spec.pitch)) {
		throw new VoiceError(
			"component-missing",
			`edge-tts: malformed pitch "${spec.pitch}" (expected ±NHz, e.g. +2Hz)`,
		);
	}
	return spec;
}

export class EdgeTts implements TtsEngine {
	private readonly runner: ProcessRunner;

	constructor(private readonly opts: EdgeTtsOptions) {
		this.runner = opts.runner ?? new NodeProcessRunner();
	}

	async synthesize(
		text: string,
		voice: VoiceRef,
		opts: { signal: AbortSignal },
	): Promise<{ audio: Buffer; format: AudioFormat; ttsFirstByteMs: number }> {
		if (!text.trim()) {
			throw new VoiceError("subprocess-failed", "edge-tts: empty text");
		}
		const spec = validateVoiceSpec(toVoiceSpec(voice));
		const id = randomUUID();
		const dir = this.opts.tmpDir ?? tmpdir();
		const textPath = join(dir, `voice-tts-${id}.txt`);
		const outPath = join(dir, `voice-tts-${id}.mp3`);
		writeFileSync(textPath, text, { mode: 0o600, encoding: "utf8" });
		const start = Date.now();
		try {
			// Prosody flags MUST be `=`-joined so a leading `-` value (e.g. -10%)
			// is not parsed as a flag by the edge-tts CLI (FLY-960 recipe).
			const args = [
				...(this.opts.baseArgs ?? []),
				"--voice",
				spec.voiceId,
				...(spec.rate !== undefined ? [`--rate=${spec.rate}`] : []),
				...(spec.pitch !== undefined ? [`--pitch=${spec.pitch}`] : []),
				"--file",
				textPath,
				"--write-media",
				outPath,
			];
			const result = await this.runner.run(this.opts.command, args, {
				signal: opts.signal,
				timeoutMs: this.opts.timeoutMs,
			});
			if (result.code !== 0) {
				throw new VoiceError(
					"subprocess-failed",
					`edge-tts exited ${result.code}: ${result.stderr.trim().slice(0, 500)}`,
				);
			}
			const ttsFirstByteMs = Date.now() - start;
			let audio: Buffer;
			try {
				audio = readFileSync(outPath);
			} catch (readErr) {
				throw new VoiceError(
					"subprocess-failed",
					"edge-tts produced no media file",
					readErr,
				);
			}
			return { audio, format: MP3_FORMAT, ttsFirstByteMs };
		} catch (err) {
			throw mapProcessError(err, "edge-tts");
		} finally {
			for (const p of [textPath, outPath]) {
				try {
					rmSync(p, { force: true });
				} catch {
					/* best-effort */
				}
			}
		}
	}
}
