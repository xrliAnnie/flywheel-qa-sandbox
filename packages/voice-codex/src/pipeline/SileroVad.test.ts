import {
	closeSync,
	copyFileSync,
	mkdtempSync,
	openSync,
	readSync,
	rmSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InferenceSession } from "onnxruntime-node";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
	createInitialSileroState,
	SILERO_MODEL_SHA256,
	SileroVad,
} from "./SileroVad.js";

const modelPath = fileURLToPath(
	new URL("../../models/silero_vad.onnx", import.meta.url),
);

afterAll(() => {
	rmSync(join(process.cwd(), ":memory:.ses"), { force: true });
});

describe("SileroVad", () => {
	it("D-GATE7 rejects a model whose SHA does not match the vendored constant", async () => {
		const root = mkdtempSync(join(tmpdir(), "raya-silero-sha-"));
		const corrupt = join(root, "silero_vad.onnx");
		copyFileSync(modelPath, corrupt);
		const fd = openSync(corrupt, "r+");
		try {
			const byte = Buffer.alloc(1);
			readSync(fd, byte, 0, 1, 0);
			byte[0] = (byte[0] ?? 0) ^ 0xff;
			writeSync(fd, byte, 0, 1, 0);
		} finally {
			closeSync(fd);
		}
		try {
			await expect(SileroVad.create(corrupt)).rejects.toThrow(
				new RegExp(
					`expected ${SILERO_MODEL_SHA256.slice(0, 8)}.*actual [0-9a-f]{8}`,
					"iu",
				),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports the model SHA and actual metadata when its contract is incompatible", async () => {
		const release = vi.fn(async () => {});
		const create = vi.spyOn(InferenceSession, "create").mockResolvedValueOnce({
			inputNames: ["input", "state", "sr"],
			outputNames: ["output", "stateN"],
			inputMetadata: [
				{ name: "input", isTensor: true, type: "float32", shape: ["", ""] },
				{ name: "state", isTensor: true, type: "float32", shape: [1, "", 128] },
				{ name: "sr", isTensor: true, type: "int64", shape: [] },
			],
			outputMetadata: [
				{ name: "output", isTensor: true, type: "float32", shape: [1, 1] },
				{ name: "stateN", isTensor: true, type: "float32", shape: [2, 1, 128] },
			],
			release,
		} as unknown as InferenceSession);

		try {
			await expect(SileroVad.create(modelPath)).rejects.toThrow(
				new RegExp(
					`${SILERO_MODEL_SHA256}.*inputMetadata.*\\[1,"",128\\]`,
					"u",
				),
			);
			expect(release).toHaveBeenCalledOnce();
		} finally {
			create.mockRestore();
		}
	});

	it("scores with caller-owned state and never mutates the prior state", async () => {
		const vad = await SileroVad.create(modelPath);
		try {
			const prior = createInitialSileroState();
			const hiddenBefore = Float32Array.from(prior.hidden);
			const contextBefore = Float32Array.from(prior.context);
			const first = await vad.score(new Float32Array(512), prior);
			const second = await vad.score(new Float32Array(512), prior);

			expect(first.probability).toBeGreaterThanOrEqual(0);
			expect(first.probability).toBeLessThan(0.1);
			expect(second.probability).toBeCloseTo(first.probability, 8);
			expect(Array.from(first.next.hidden)).toEqual(
				Array.from(second.next.hidden),
			);
			expect(Array.from(first.next.context)).toEqual(
				Array.from(second.next.context),
			);
			expect(prior.hidden).toEqual(hiddenBefore);
			expect(prior.context).toEqual(contextBefore);
			expect(first.next.hidden).toHaveLength(256);
			expect(first.next.context).toHaveLength(64);
		} finally {
			await vad.close();
		}
	});

	it("rejects non-512-sample chunks before invoking native inference", async () => {
		const vad = await SileroVad.create(modelPath);
		try {
			await expect(
				vad.score(new Float32Array(511), createInitialSileroState()),
			).rejects.toThrow(/512/u);
		} finally {
			await vad.close();
		}
	});
});
