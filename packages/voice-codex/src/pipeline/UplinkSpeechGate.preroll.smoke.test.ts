import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_UPLINK_PREROLL_MS } from "../discord-room.js";
import { createInitialSileroState, SileroVad } from "./SileroVad.js";
import { UplinkSpeechGate } from "./UplinkSpeechGate.js";

const FRAME_BYTES = 3_840;
const modelPath = fileURLToPath(
	new URL("../../models/silero_vad.onnx", import.meta.url),
);
const speechPath = fileURLToPath(
	new URL("./fixtures/true-speech.wav", import.meta.url),
);

afterAll(() => {
	rmSync(join(process.cwd(), ":memory:.ses"), { force: true });
});

function wavFrames(path: string, leadingSilenceMs: number): Buffer[] {
	const wav = readFileSync(path);
	let offset = 12;
	let data: Buffer | undefined;
	while (offset + 8 <= wav.length) {
		const kind = wav.toString("ascii", offset, offset + 4);
		const length = wav.readUInt32LE(offset + 4);
		if (kind === "data") data = wav.subarray(offset + 8, offset + 8 + length);
		offset += 8 + length + (length % 2);
	}
	if (!data) throw new Error("fixture WAV has no data chunk");
	const audio = Buffer.concat([
		Buffer.alloc((leadingSilenceMs / 20) * FRAME_BYTES),
		data,
	]);
	const frames: Buffer[] = [];
	for (let start = 0; start + FRAME_BYTES <= audio.length; start += FRAME_BYTES)
		frames.push(audio.subarray(start, start + FRAME_BYTES));
	return frames;
}

function rms(frame: Buffer): number {
	let sum = 0;
	for (let offset = 0; offset < frame.length; offset += 2)
		sum += frame.readInt16LE(offset) ** 2;
	return Math.sqrt(sum / (frame.length / 2));
}

/** Runs the real gate over the fixture and returns how many ms of the
 * sentence start (by energy) went out as silence. Inference is awaited per
 * chunk, so the result does not depend on host speed. */
async function headSilencedMs(vad: SileroVad, prerollMs: number) {
	const frames = wavFrames(speechPath, 500);
	let pending: Promise<unknown> = Promise.resolve();
	const gate = new UplinkSpeechGate({
		score: (samples, state) => {
			const scored = vad.score(samples, state as never);
			pending = scored;
			return scored;
		},
		initialState: createInitialSileroState,
		minSpeechMs: 200,
		threshold: 0.5,
		prerollMs,
		now: () => 0,
	});
	gate.begin("gated", 0);
	const speech: number[] = [];
	for (let index = 0; index < frames.length; index += 1) {
		gate.push(frames[index] as Buffer, index * 20, index);
		for (let turn = 0; turn < 32; turn += 1) {
			await pending.catch(() => undefined);
			await Promise.resolve();
		}
		for (const due of gate.takeDue(index * 20))
			if (due.speech) speech.push(due.metadata as number);
	}
	const onset = frames.findIndex((frame) => rms(frame) > 300);
	const first = speech[0] ?? Number.POSITIVE_INFINITY;
	expect(gate.takeCompleted()).toEqual([]);
	return Math.max(0, (first - onset) * 20);
}

describe("UplinkSpeechGate pre-roll on real speech (FLY-2798, engine B room path FLY-2799)", () => {
	it("keeps the start of a real recorded sentence that the gate alone silences", async () => {
		const vad = await SileroVad.create(modelPath);
		try {
			const withoutPreroll = await headSilencedMs(vad, 0);
			const withDefault = await headSilencedMs(vad, DEFAULT_UPLINK_PREROLL_MS);
			console.info(
				`gate head silenced: ${withoutPreroll} ms without pre-roll, ${withDefault} ms with ${DEFAULT_UPLINK_PREROLL_MS} ms`,
			);
			expect(withoutPreroll).toBeGreaterThanOrEqual(60);
			expect(withDefault).toBe(0);
		} finally {
			await vad.close();
		}
	}, 60_000);
});
