import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { InferenceSession, Tensor } from "onnxruntime-node";

export const SILERO_MODEL_SHA256 =
	"1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3";

const SAMPLE_RATE = 16_000;
// Upstream Silero VAD v6.2 contract at commit
// be95df9152c0d7618fa1edfeb296fc3dae32376f (model SHA above).
const CHUNK_SAMPLES = 512;
// Silero v6.2's public 16 kHz streaming contract carries the previous 64
// samples alongside each 512-sample chunk. The model's ONNX metadata marks
// both input dimensions dynamic, so create() also proves this contract by
// executing one zero block before the instance is returned.
const CONTEXT_SAMPLES = 64;
const HIDDEN_SAMPLES = 2 * 1 * 128;

export interface SileroState {
	hidden: Float32Array;
	context: Float32Array;
}

export interface SileroScore {
	probability: number;
	next: SileroState;
}

export function createInitialSileroState(): SileroState {
	return {
		hidden: new Float32Array(HIDDEN_SAMPLES),
		context: new Float32Array(CONTEXT_SAMPLES),
	};
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function metadataByName(
	metadata: readonly InferenceSession.ValueMetadata[],
): Map<string, InferenceSession.ValueMetadata> {
	return new Map(metadata.map((entry) => [entry.name, entry]));
}

function requireTensor(
	metadata: Map<string, InferenceSession.ValueMetadata>,
	name: string,
	type: "float32" | "int64",
	rank: number,
): InferenceSession.TensorValueMetadata {
	const value = metadata.get(name);
	if (!value?.isTensor || value.type !== type || value.shape.length !== rank) {
		throw new Error(
			`Silero model ${name} must be a rank-${rank} ${type} tensor`,
		);
	}
	return value;
}

function concreteDimension(
	value: number | string,
	expected: number,
	name: string,
): void {
	if (typeof value === "number" && value !== expected) {
		throw new Error(
			`Silero model ${name} must be ${expected}, received ${value}`,
		);
	}
}

function requireNames(
	actual: readonly string[],
	expected: readonly string[],
	kind: "input" | "output",
): void {
	if (
		actual.length !== expected.length ||
		expected.some((name) => !actual.includes(name))
	) {
		throw new Error(
			`Silero model ${kind} names must be ${expected.join(",")}, received ${actual.join(",")}`,
		);
	}
}

function metadataSnapshot(session: InferenceSession): string {
	const simplify = (metadata: readonly InferenceSession.ValueMetadata[]) =>
		metadata.map((value) =>
			value.isTensor
				? {
						name: value.name,
						isTensor: true,
						type: value.type,
						shape: value.shape,
					}
				: { name: value.name, isTensor: false },
		);
	return JSON.stringify({
		inputMetadata: simplify(session.inputMetadata),
		outputMetadata: simplify(session.outputMetadata),
	});
}

function floatTensor(
	result: InferenceSession.ReturnType,
	name: string,
): Tensor {
	const value = result[name];
	if (!(value instanceof Tensor) || value.type !== "float32") {
		throw new Error(`Silero model output ${name} must be float32`);
	}
	return value;
}

export class SileroVad {
	private closed = false;

	private constructor(private readonly session: InferenceSession) {}

	static async create(modelPath: string): Promise<SileroVad> {
		const actualSha = sha256(modelPath);
		if (actualSha !== SILERO_MODEL_SHA256) {
			throw new Error(
				`Silero model SHA mismatch: expected ${SILERO_MODEL_SHA256.slice(0, 8)}, actual ${actualSha.slice(0, 8)}`,
			);
		}
		const session = await InferenceSession.create(modelPath, {
			executionProviders: ["cpu"],
			intraOpNumThreads: 1,
		});
		try {
			requireNames(session.inputNames, ["input", "state", "sr"], "input");
			requireNames(session.outputNames, ["output", "stateN"], "output");
			const inputs = metadataByName(session.inputMetadata);
			const input = requireTensor(inputs, "input", "float32", 2);
			const state = requireTensor(inputs, "state", "float32", 3);
			requireTensor(inputs, "sr", "int64", 0);
			concreteDimension(
				input.shape[1] ?? "",
				CHUNK_SAMPLES + CONTEXT_SAMPLES,
				"input length",
			);
			concreteDimension(state.shape[0] ?? "", 2, "state dimension 0");
			concreteDimension(state.shape[2] ?? "", 128, "state dimension 2");

			const outputs = metadataByName(session.outputMetadata);
			requireTensor(outputs, "output", "float32", 2);
			requireTensor(outputs, "stateN", "float32", 3);

			const vad = new SileroVad(session);
			await vad.score(
				new Float32Array(CHUNK_SAMPLES),
				createInitialSileroState(),
			);
			return vad;
		} catch (error) {
			const metadata = metadataSnapshot(session);
			await session.release();
			throw new Error(
				`Silero model ${SILERO_MODEL_SHA256} contract failure: ${error instanceof Error ? error.message : String(error)}; ${metadata}`,
			);
		}
	}

	async score(
		chunk16k: Float32Array,
		prior: SileroState,
	): Promise<SileroScore> {
		if (this.closed) throw new Error("Silero VAD is closed");
		if (chunk16k.length !== CHUNK_SAMPLES) {
			throw new Error(
				`Silero VAD requires ${CHUNK_SAMPLES} samples, received ${chunk16k.length}`,
			);
		}
		if (
			prior.hidden.length !== HIDDEN_SAMPLES ||
			prior.context.length !== CONTEXT_SAMPLES
		) {
			throw new Error("Silero VAD state shape is invalid");
		}
		const input = new Float32Array(CONTEXT_SAMPLES + CHUNK_SAMPLES);
		input.set(prior.context, 0);
		input.set(chunk16k, CONTEXT_SAMPLES);
		const result = await this.session.run({
			input: new Tensor("float32", input, [1, input.length]),
			state: new Tensor(
				"float32",
				Float32Array.from(prior.hidden),
				[2, 1, 128],
			),
			sr: new Tensor("int64", BigInt64Array.of(BigInt(SAMPLE_RATE)), []),
		});
		const output = floatTensor(result, "output");
		const nextState = floatTensor(result, "stateN");
		const probability = Number(output.data[0]);
		if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
			throw new Error("Silero VAD returned an invalid probability");
		}
		if (nextState.data.length !== HIDDEN_SAMPLES) {
			throw new Error(
				`Silero VAD returned ${nextState.data.length} state samples, expected ${HIDDEN_SAMPLES}`,
			);
		}
		return {
			probability,
			next: {
				hidden: Float32Array.from(nextState.data as Float32Array),
				context: Float32Array.from(
					chunk16k.subarray(CHUNK_SAMPLES - CONTEXT_SAMPLES),
				),
			},
		};
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.session.release();
	}
}
