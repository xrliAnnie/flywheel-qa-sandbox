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
import { fileURLToPath } from "node:url";
import { mapProcessError } from "../../errors.js";
import {
	NodeProcessRunner,
	type ProcessHandle,
	type ProcessRunner,
} from "../../process.js";
import {
	type AudioFormat,
	type StreamingTtsChunk,
	type StreamingTtsEngine,
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
	/** Python executable used by the incremental edge-tts helper. */
	streamCommand?: string;
	/** Override only for packaging/tests; defaults to the bundled helper. */
	streamScript?: string;
	/** Hard cap for unread encoded audio from a slow downstream consumer. */
	streamMaxBufferedBytes?: number;
	/** Injectable clock for first-byte measurements. */
	now?: () => number;
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

export class EdgeTts implements TtsEngine, StreamingTtsEngine {
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

	async *synthesizeStream(
		text: string,
		voice: VoiceRef,
		opts: { signal: AbortSignal },
	): AsyncIterable<StreamingTtsChunk> {
		if (!text.trim()) {
			throw new VoiceError("subprocess-failed", "edge-tts: empty text");
		}
		if (opts.signal.aborted) {
			throw new VoiceError("cancelled", "edge-tts stream cancelled");
		}
		const spec = validateVoiceSpec(toVoiceSpec(voice));
		const maxBufferedBytes = this.opts.streamMaxBufferedBytes ?? 1024 * 1024;
		if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes <= 0) {
			throw new VoiceError(
				"component-missing",
				"edge-tts: streamMaxBufferedBytes must be a positive integer",
			);
		}
		const script =
			this.opts.streamScript ??
			fileURLToPath(
				new URL("../../../scripts/stream-edge-tts.py", import.meta.url),
			);
		const args = [
			script,
			"--voice",
			spec.voiceId,
			...(spec.rate !== undefined ? [`--rate=${spec.rate}`] : []),
			...(spec.pitch !== undefined ? [`--pitch=${spec.pitch}`] : []),
		];
		const start = (this.opts.now ?? Date.now)();
		let handle: ProcessHandle;
		try {
			handle = this.runner.spawn(this.opts.streamCommand ?? "python3", args);
		} catch (error) {
			throw mapProcessError(error, "edge-tts stream");
		}
		const queued: Buffer[] = [];
		let bufferedBytes = 0;
		let receivedMedia = false;
		let stderr = "";
		let finished = false;
		let failure: VoiceError | undefined;
		let wake: (() => void) | undefined;
		const notify = (): void => {
			wake?.();
			wake = undefined;
		};
		const fail = (error: VoiceError, kill: boolean): void => {
			if (finished || failure) return;
			failure = error;
			if (kill) handle.kill("SIGKILL");
			notify();
		};
		handle.onStdout((chunk) => {
			if (finished || failure || chunk.length === 0) return;
			if (bufferedBytes + chunk.length > maxBufferedBytes) {
				fail(
					new VoiceError(
						"resource-exhausted",
						`edge-tts stream exceeded ${maxBufferedBytes} buffered bytes`,
					),
					true,
				);
				return;
			}
			receivedMedia = true;
			queued.push(chunk);
			bufferedBytes += chunk.length;
			notify();
		});
		handle.onStderr((chunk) => {
			stderr = (stderr + chunk.toString()).slice(-500);
		});
		handle.onError((error) =>
			fail(
				new VoiceError(
					"subprocess-failed",
					`edge-tts stream failed: ${error.message}`,
					error,
				),
				true,
			),
		);
		// Non-zero exits fail fast; a clean exit is finalized on close so media
		// still in the stdout pipe is delivered, not dropped.
		handle.onExit((code, signal) => {
			if (failure || code === 0) return;
			fail(
				new VoiceError(
					"subprocess-failed",
					`edge-tts stream exited ${code ?? signal ?? "unknown"}: ${stderr.trim()}`,
				),
				false,
			);
		});
		handle.onClose((code, signal) => {
			if (failure || finished) return;
			if (code === 0) {
				if (!receivedMedia) {
					fail(
						new VoiceError(
							"subprocess-failed",
							"edge-tts stream produced no media",
						),
						false,
					);
					return;
				}
				finished = true;
				notify();
				return;
			}
			fail(
				new VoiceError(
					"subprocess-failed",
					`edge-tts stream exited ${code ?? signal ?? "unknown"}: ${stderr.trim()}`,
				),
				false,
			);
		});
		const onAbort = (): void =>
			fail(new VoiceError("cancelled", "edge-tts stream cancelled"), true);
		opts.signal.addEventListener("abort", onAbort, { once: true });
		const timeout = setTimeout(
			() =>
				fail(
					new VoiceError(
						"timeout",
						`edge-tts stream timed out after ${this.opts.timeoutMs ?? 30_000}ms`,
					),
					true,
				),
			this.opts.timeoutMs ?? 30_000,
		);
		handle.end(text);

		let first = true;
		try {
			while (true) {
				if (failure) throw failure;
				if (queued.length > 0) {
					const audio = queued.shift() as Buffer;
					bufferedBytes -= audio.length;
					const firstByteMs = (this.opts.now ?? Date.now)() - start;
					yield {
						audio,
						format: MP3_FORMAT,
						...(first ? { ttsFirstByteMs: firstByteMs } : {}),
					};
					first = false;
					continue;
				}
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
