import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createInitialSileroState, SileroVad } from "./SileroVad.js";

const modelPath = fileURLToPath(
	new URL("../../models/silero_vad.onnx", import.meta.url),
);
const speechPath = fileURLToPath(
	new URL("./fixtures/true-speech.wav", import.meta.url),
);

afterAll(() => {
	rmSync(join(process.cwd(), ":memory:.ses"), { force: true });
});

function pcm16Stereo48kToMono16k(path: string): Float32Array {
	const wav = readFileSync(path);
	if (
		wav.toString("ascii", 0, 4) !== "RIFF" ||
		wav.toString("ascii", 8, 12) !== "WAVE"
	) {
		throw new Error("fixture must be a RIFF/WAVE file");
	}
	let offset = 12;
	let data: Buffer | null = null;
	while (offset + 8 <= wav.length) {
		const kind = wav.toString("ascii", offset, offset + 4);
		const length = wav.readUInt32LE(offset + 4);
		const start = offset + 8;
		if (kind === "fmt ") {
			expect(wav.readUInt16LE(start)).toBe(1);
			expect(wav.readUInt16LE(start + 2)).toBe(2);
			expect(wav.readUInt32LE(start + 4)).toBe(48_000);
			expect(wav.readUInt16LE(start + 14)).toBe(16);
		}
		if (kind === "data") data = wav.subarray(start, start + length);
		offset = start + length + (length % 2);
	}
	if (!data) throw new Error("fixture WAV has no data chunk");
	const output = new Float32Array(Math.floor(data.length / 12));
	for (let index = 0; index < output.length; index += 1) {
		const source = index * 12;
		output[index] =
			(data.readInt16LE(source) + data.readInt16LE(source + 2)) / (2 * 32_768);
	}
	return output;
}

describe("SileroVad offline smoke", () => {
	it("scores the hashed real-speech fixture across a frozen positive range", async () => {
		const audio = pcm16Stereo48kToMono16k(speechPath);
		expect(audio.length).toBeGreaterThanOrEqual(10 * 512);
		const vad = await SileroVad.create(modelPath);
		try {
			let state = createInitialSileroState();
			const probabilities: number[] = [];
			for (let offset = 0; offset + 512 <= audio.length; offset += 512) {
				const result = await vad.score(
					audio.slice(offset, offset + 512),
					state,
				);
				state = result.next;
				probabilities.push(result.probability);
			}
			const max = Math.max(...probabilities);
			const positiveChunks = probabilities.filter(
				(value) => value > 0.5,
			).length;
			console.info(
				`Silero smoke max=${max.toFixed(8)} positives=${positiveChunks}/${probabilities.length}`,
			);
			expect(probabilities).toHaveLength(298);
			expect(max).toBeGreaterThanOrEqual(0.999_99);
			expect(max).toBeLessThanOrEqual(1);
			expect(positiveChunks).toBe(243);
		} finally {
			await vad.close();
		}
	}, 20_000);
});
