/**
 * defaultCues (FLY-545 QA R3 ③) — Annie asked for AUDIBLE wait cues, not just
 * text. The mouth's earcon/filler channel already plays clips on speech-stop
 * (thinking cue) and on silent tools (filler), but it only worked when the
 * operator pre-provisioned clip files — unset paths meant SILENCE. These are
 * synthesized fallbacks: tiny 48k stereo s16le WAV tones written once at
 * daemon start, so every /glaw deployment has cues out of the box.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;

export interface ToneSegment {
	/** 0 = silence gap. */
	freqHz: number;
	ms: number;
	/** 0..1 peak amplitude; keep cues quiet (default 0.18). */
	gain?: number;
}

function renderTonePcm(seg: ToneSegment): Buffer {
	const gain = seg.gain ?? 0.18;
	const frames = Math.round((SAMPLE_RATE * seg.ms) / 1000);
	const fade = Math.min(Math.round(SAMPLE_RATE * 0.01), frames >> 1); // 10ms
	const data = Buffer.alloc(frames * CHANNELS * 2);
	if (seg.freqHz <= 0) return data; // silence
	for (let i = 0; i < frames; i++) {
		const env =
			i < fade ? i / fade : i > frames - fade ? (frames - i) / fade : 1;
		const v = Math.round(
			Math.sin((2 * Math.PI * seg.freqHz * i) / SAMPLE_RATE) *
				gain *
				env *
				32767,
		);
		for (let c = 0; c < CHANNELS; c++) {
			data.writeInt16LE(v, (i * CHANNELS + c) * 2);
		}
	}
	return data;
}

/** Render soft sine tone(s) as ONE valid WAV (single header, faded, no clicks). */
export function renderToneWav(...segments: ToneSegment[]): Buffer {
	const data = Buffer.concat(segments.map(renderTonePcm));
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + data.length, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16); // PCM chunk size
	header.writeUInt16LE(1, 20); // PCM
	header.writeUInt16LE(CHANNELS, 22);
	header.writeUInt32LE(SAMPLE_RATE, 24);
	header.writeUInt32LE(SAMPLE_RATE * CHANNELS * 2, 28); // byte rate
	header.writeUInt16LE(CHANNELS * 2, 32); // block align
	header.writeUInt16LE(16, 34); // bits per sample
	header.write("data", 36);
	header.writeUInt32LE(data.length, 40);
	return Buffer.concat([header, data]);
}

export interface DefaultCuePaths {
	/** speech-stop / tool-call acknowledgement: one soft mid ping. */
	earconPath: string;
	/** still-working filler (armed when a tool stays silent): lower double tone. */
	fillerPath: string;
}

/** Write the fallback cue WAVs (idempotent) and return their paths. */
export function ensureDefaultCues(dir?: string): DefaultCuePaths {
	const base = dir ?? join(tmpdir(), "flywheel-glaw-cues");
	const earconPath = join(base, "cue-ack.wav");
	const fillerPath = join(base, "cue-working.wav");
	mkdirSync(dirname(earconPath), { recursive: true });
	if (!existsSync(earconPath)) {
		writeFileSync(earconPath, renderToneWav({ freqHz: 880, ms: 140 }));
	}
	if (!existsSync(fillerPath)) {
		writeFileSync(
			fillerPath,
			renderToneWav(
				{ freqHz: 587, ms: 120 },
				{ freqHz: 0, ms: 60 },
				{ freqHz: 784, ms: 160 },
			),
		);
	}
	return { earconPath, fillerPath };
}
