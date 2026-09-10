import { describe, expect, it, vi } from "vitest";
import { UplinkSpeechGate } from "./UplinkSpeechGate.js";

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { promise, resolve, reject };
}

function frame(index: number): Buffer {
	const pcm = Buffer.alloc(3_840);
	pcm.writeInt32LE(index, 0);
	return pcm;
}

function sineFrame(frameIndex: number, frequencyHz: number): Buffer {
	const pcm = Buffer.alloc(3_840);
	for (let index = 0; index < 960; index += 1) {
		const absoluteSample = frameIndex * 960 + index;
		const value = Math.round(
			Math.sin((2 * Math.PI * frequencyHz * absoluteSample) / 48_000) * 24_000,
		);
		const offset = index * 4;
		pcm.writeInt16LE(value, offset);
		pcm.writeInt16LE(value, offset + 2);
	}
	return pcm;
}

function pcmFramesFrom16k(samples: readonly number[]): Array<{
	frame: Buffer;
	containsSpeech: boolean;
}> {
	const frames: Array<{ frame: Buffer; containsSpeech: boolean }> = [];
	for (let start = 0; start < samples.length; start += 320) {
		const pcm = Buffer.alloc(3_840);
		let containsSpeech = false;
		for (let index = 0; index < 320; index += 1) {
			const value = samples[start + index] ?? 0;
			containsSpeech ||= value !== 0;
			const int16 = Math.round(value * 16_000);
			for (let repeat = 0; repeat < 3; repeat += 1) {
				const offset = (index * 3 + repeat) * 4;
				pcm.writeInt16LE(int16, offset);
				pcm.writeInt16LE(int16, offset + 2);
			}
		}
		frames.push({ frame: pcm, containsSpeech });
	}
	return frames;
}

async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function decidingGate(
	decision: Deferred<{ probability: number; next: unknown }>,
) {
	let now = 0;
	const score = vi
		.fn()
		.mockResolvedValueOnce({ probability: 0.9, next: { chunk: 1 } })
		.mockImplementationOnce(() => decision.promise);
	const gate = new UplinkSpeechGate({
		score,
		initialState: () => ({ chunk: 0 }),
		minSpeechMs: 64,
		threshold: 0.5,
		now: () => now,
	});
	gate.begin("gated", 0);
	const input = [frame(1), frame(2), frame(3), frame(4)];
	for (const pcm of input) gate.push(pcm, 0);
	return {
		gate,
		input,
		score,
		setNow(value: number) {
			now = value;
		},
	};
}

describe("UplinkSpeechGate D-GATE10 end-hold", () => {
	it("opens and backfills when the decisive positive score lands within 5ms", async () => {
		const decision = deferred<{ probability: number; next: unknown }>();
		const { gate, input, score, setNow } = decidingGate(decision);
		await vi.waitFor(() => expect(score).toHaveBeenCalledTimes(2));

		gate.end(0);
		expect(gate.takeDue(0)).toEqual([]);
		setNow(5);
		decision.resolve({ probability: 0.9, next: { chunk: 2 } });
		await settle();

		const output = gate.takeDue(5);
		expect(output.map(({ frame }) => frame)).toEqual(input);
		expect(output.every(({ speech }) => speech)).toBe(true);
		expect(gate.takeCompleted()).toEqual([
			expect.objectContaining({
				opened: true,
				endedWithScoreInFlight: true,
				heldMs: 5,
			}),
		]);
	});

	it("flushes silence when the decisive negative score lands within 5ms", async () => {
		const decision = deferred<{ probability: number; next: unknown }>();
		const { gate, input, score, setNow } = decidingGate(decision);
		await vi.waitFor(() => expect(score).toHaveBeenCalledTimes(2));

		gate.end(0);
		setNow(5);
		decision.resolve({ probability: 0.1, next: { chunk: 2 } });
		await settle();

		const output = gate.takeDue(5);
		expect(output.map(({ frame }) => frame)).toEqual(input);
		expect(output.every(({ speech }) => !speech)).toBe(true);
		expect(gate.takeCompleted()).toEqual([
			expect.objectContaining({
				opened: false,
				endedWithScoreInFlight: true,
				heldMs: 5,
			}),
		]);
	});

	it("caps the hold at exactly 20ms and discards the 25ms result", async () => {
		const decision = deferred<{ probability: number; next: unknown }>();
		const { gate, input, score, setNow } = decidingGate(decision);
		await vi.waitFor(() => expect(score).toHaveBeenCalledTimes(2));

		gate.end(0);
		setNow(20);
		const output = gate.takeDue(20);
		expect(output.map(({ frame }) => frame)).toEqual(input);
		expect(output.every(({ speech }) => !speech)).toBe(true);
		expect(gate.takeCompleted()).toEqual([
			expect.objectContaining({
				opened: false,
				endedWithScoreInFlight: true,
				heldMs: 20,
			}),
		]);
		const tokenAfterDeadline = gate.token;

		setNow(25);
		decision.resolve({ probability: 0.9, next: { stale: true } });
		await settle();
		expect(gate.takeDue(25)).toEqual([]);
		expect(gate.takeCompleted()).toEqual([]);
		expect(gate.token).toBe(tokenAfterDeadline);
	});

	it("forces the held chain closed before a new begin at 8ms", async () => {
		const decision = deferred<{ probability: number; next: unknown }>();
		const { gate, input, score, setNow } = decidingGate(decision);
		await vi.waitFor(() => expect(score).toHaveBeenCalledTimes(2));
		const oldToken = gate.token;

		gate.end(0);
		setNow(8);
		gate.begin("gated", 8);

		const output = gate.takeDue(8);
		expect(output.map(({ frame }) => frame)).toEqual(input);
		expect(output.every(({ speech }) => !speech)).toBe(true);
		expect(gate.takeCompleted()).toEqual([
			expect.objectContaining({
				opened: false,
				endedWithScoreInFlight: true,
				heldMs: 8,
			}),
		]);
		expect(gate.token).toBe(oldToken + 1);
		expect(gate.mode).toBe("gated");

		decision.resolve({ probability: 0.9, next: { stale: true } });
		await settle();
		expect(gate.takeDue(10)).toEqual([]);
		expect(gate.token).toBe(oldToken + 1);
	});
});

describe("UplinkSpeechGate neural gating", () => {
	it("reports null score percentiles when a passthrough chain performs no inference", () => {
		const gate = new UplinkSpeechGate({
			score: vi.fn(async () => ({ probability: 0.1, next: {} })),
			initialState: () => ({}),
			minSpeechMs: 100,
			threshold: 0.5,
		});
		gate.begin("passthrough", 0);
		gate.push(frame(1), 0);
		gate.end(20);
		gate.takeDue(20);

		expect(gate.takeCompleted()).toEqual([
			expect.objectContaining({
				scoreCount: 0,
				scoreMsP50: null,
				scoreMsP99: null,
			}),
		]);
	});

	it("records deterministic p50 and p99 model score durations", async () => {
		const measureNow = vi
			.fn()
			.mockReturnValueOnce(0)
			.mockReturnValueOnce(1)
			.mockReturnValueOnce(10)
			.mockReturnValueOnce(14)
			.mockReturnValueOnce(20)
			.mockReturnValueOnce(29);
		const score = vi.fn(async () => ({ probability: 0.1, next: {} }));
		const gate = new UplinkSpeechGate({
			score,
			initialState: () => ({}),
			minSpeechMs: 100,
			threshold: 0.5,
			measureNow,
		});
		gate.begin("gated", 0);
		for (let index = 0; index < 5; index += 1) gate.push(frame(index), 0);
		await vi.waitFor(() => expect(score).toHaveBeenCalledTimes(3));
		gate.end(100);
		gate.takeDue(100);

		expect(gate.takeCompleted()).toEqual([
			expect.objectContaining({
				scoreCount: 3,
				scoreMsP50: 4,
				scoreMsP99: 9,
			}),
		]);
	});

	it("reports that a chain opened even when trailing silence closes it", async () => {
		const probabilities = [0.9, 0.9, 0.9, 0.9, 0.1, 0.1, 0.1, 0.1];
		const onOpened = vi.fn();
		const gate = new UplinkSpeechGate({
			score: vi.fn(async () => ({
				probability: probabilities.shift() ?? 0.1,
				next: {},
			})),
			initialState: () => ({}),
			minSpeechMs: 100,
			threshold: 0.5,
			now: () => 240,
			onOpened,
		});
		gate.begin("gated", 0);
		for (let index = 0; index < 13; index += 1) {
			gate.push(frame(index), index * 20);
			await settle();
		}
		gate.end(260);
		gate.takeDue(260);

		expect(gate.takeCompleted()).toEqual([
			expect.objectContaining({ opened: true, openAtMs: 240 }),
		]);
		expect(onOpened).toHaveBeenCalledOnce();
		expect(onOpened).toHaveBeenCalledWith({ token: 0, openAtMs: 240 });
	});

	it("low-pass filters frequencies above the 16kHz Nyquist limit before decimation", async () => {
		const chunks: Float32Array[] = [];
		const gate = new UplinkSpeechGate({
			score: vi.fn(async (chunk: Float32Array) => {
				chunks.push(Float32Array.from(chunk));
				return { probability: 0.1, next: {} };
			}),
			initialState: () => ({}),
			minSpeechMs: 100,
			threshold: 0.5,
		});
		gate.begin("gated", 0);
		for (let index = 0; index < 20; index += 1) {
			gate.push(sineFrame(index, 12_000), index * 20);
			await settle();
		}
		await vi.waitFor(() => expect(chunks.length).toBeGreaterThanOrEqual(10));
		const steady = chunks.slice(2).flatMap((chunk) => Array.from(chunk));
		const rms = Math.sqrt(
			steady.reduce((sum, sample) => sum + sample * sample, 0) / steady.length,
		);
		expect(rms).toBeLessThan(0.1);
	});

	it.each([
		{ phase: 0, minSpeechMs: 100, expectedDelay: 9 },
		{ phase: 1, minSpeechMs: 100, expectedDelay: 9 },
		{ phase: 256, minSpeechMs: 200, expectedDelay: 14 },
		{ phase: 511, minSpeechMs: 300, expectedDelay: 19 },
	])(
		"D-GATE1 retains every speech frame at phase $phase and minSpeech=$minSpeechMs",
		async ({ phase, minSpeechMs, expectedDelay }) => {
			const chunksRequired = Math.ceil(minSpeechMs / 32);
			const samples = [
				...Array.from({ length: phase }, () => 0),
				...Array.from({ length: chunksRequired * 512 + 640 }, () => 1),
			];
			let now = 0;
			const score = vi.fn(async (chunk: Float32Array) => ({
				probability: chunk.some((sample) => sample > 0.25) ? 0.9 : 0.1,
				next: {},
			}));
			const gate = new UplinkSpeechGate({
				score,
				initialState: () => ({}),
				minSpeechMs,
				threshold: 0.5,
				now: () => now,
			});
			expect(gate.delayFrames).toBe(expectedDelay);
			gate.begin("gated", now);
			const output: ReturnType<UplinkSpeechGate["takeDue"]> = [];
			const frames = pcmFramesFrom16k(samples);
			for (const { frame } of frames) {
				gate.push(frame, now);
				await settle();
				output.push(...gate.takeDue(now));
				now += 20;
			}
			await vi.waitFor(() =>
				expect(score).toHaveBeenCalledTimes(Math.floor(samples.length / 512)),
			);
			gate.end(now);
			output.push(...gate.takeDue(now));

			expect(output.map(({ frame }) => frame)).toEqual(
				frames.map(({ frame }) => frame),
			);
			for (let index = 0; index < frames.length; index += 1) {
				if (frames[index]?.containsSpeech) {
					expect(output[index]?.speech, `frame ${index}`).toBe(true);
				}
			}
			expect(gate.takeCompleted()).toEqual([
				expect.objectContaining({ opened: true }),
			]);
		},
	);

	it("D-GATE2 replaces a negative breath chain with silence decisions", async () => {
		const score = vi.fn(async () => ({ probability: 0.2, next: {} }));
		const gate = new UplinkSpeechGate({
			score,
			initialState: () => ({}),
			minSpeechMs: 100,
			threshold: 0.5,
		});
		gate.begin("gated", 0);
		const input = Array.from({ length: 14 }, (_, index) => frame(index));
		const output: ReturnType<UplinkSpeechGate["takeDue"]> = [];
		for (const pcm of input) {
			gate.push(pcm, 0);
			await settle();
			output.push(...gate.takeDue(0));
		}
		await vi.waitFor(() => expect(score).toHaveBeenCalledTimes(8));
		gate.end(0);
		output.push(...gate.takeDue(0));

		expect(output.map(({ frame }) => frame)).toEqual(input);
		expect(output.every(({ speech }) => !speech)).toBe(true);
		expect(gate.takeCompleted()).toEqual([
			expect.objectContaining({
				opened: false,
				framesSilenced: input.length,
				framesPassed: 0,
			}),
		]);
	});

	it("D-GATE3 resets K-1 positives when the next chunk is negative", async () => {
		const probabilities = [0.9, 0.9, 0.9, 0.1];
		const score = vi.fn(async () => ({
			probability: probabilities.shift() ?? 0.1,
			next: {},
		}));
		const gate = new UplinkSpeechGate({
			score,
			initialState: () => ({}),
			minSpeechMs: 100,
			threshold: 0.5,
		});
		gate.begin("gated", 0);
		const input = Array.from({ length: 7 }, (_, index) => frame(index));
		for (const pcm of input) {
			gate.push(pcm, 0);
			await settle();
		}
		await vi.waitFor(() => expect(score).toHaveBeenCalledTimes(4));
		gate.end(0);
		const output = gate.takeDue(0);

		expect(output.map(({ frame }) => frame)).toEqual(input);
		expect(output.every(({ speech }) => !speech)).toBe(true);
		expect(gate.takeCompleted()).toEqual([
			expect.objectContaining({ opened: false }),
		]);
	});

	it("D-GATE8 resets model state and positive duration at every epoch", async () => {
		const initialState = vi.fn(() => ({}));
		const score = vi.fn(async () => ({ probability: 0.9, next: {} }));
		const gate = new UplinkSpeechGate({
			score,
			initialState,
			minSpeechMs: 100,
			threshold: 0.5,
		});
		for (let chain = 0; chain < 3; chain += 1) {
			gate.begin("gated", chain * 100);
			for (let index = 0; index < 4; index += 1) {
				gate.push(frame(index), chain * 100);
				await settle();
			}
			gate.end(chain * 100 + 80);
			gate.takeDue(chain * 100 + 80);
		}
		expect(gate.takeCompleted().map(({ opened }) => opened)).toEqual([
			false,
			false,
			false,
		]);

		gate.begin("gated", 400);
		for (let index = 0; index < 7; index += 1) {
			gate.push(frame(index), 400);
			await settle();
		}
		await settle();
		gate.end(540);
		gate.takeDue(540);
		expect(gate.takeCompleted()).toEqual([
			expect.objectContaining({ opened: true }),
		]);
		expect(initialState).toHaveBeenCalledTimes(4);
	});

	it("D-GATE9 degrades synchronously when a due decision is still pending", async () => {
		const late = deferred<{ probability: number; next: unknown }>();
		const gate = new UplinkSpeechGate({
			score: vi.fn(() => late.promise),
			initialState: () => ({}),
			minSpeechMs: 100,
			threshold: 0.5,
		});
		gate.begin("gated", 0);
		for (let index = 0; index <= gate.delayFrames; index += 1) {
			gate.push(frame(index), index * 20);
		}

		const due = gate.takeDue(gate.delayFrames * 20);
		expect(due).toHaveLength(gate.delayFrames + 1);
		expect(due.map(({ frame: emitted }) => emitted.readInt32LE(0))).toEqual(
			Array.from({ length: gate.delayFrames + 1 }, (_, index) => index),
		);
		expect(due.every(({ speech }) => speech)).toBe(true);
		gate.end(gate.delayFrames * 20);
		gate.takeDue(gate.delayFrames * 20 + 20);
		const token = gate.token;
		expect(gate.takeCompleted()).toEqual([
			expect.objectContaining({
				degraded: "inference_lag",
				framesSilencedBeforeDegrade: 0,
			}),
		]);

		late.resolve({ probability: 0.9, next: { stale: true } });
		await settle();
		expect(gate.token).toBe(token);
	});

	it("D-GATE6 fail-opens a deterministic startup failure once for the session", async () => {
		const score = vi.fn(async () => ({ probability: 0.1, next: {} }));
		const degraded = vi.fn();
		const gate = new UplinkSpeechGate({
			score,
			initialState: () => ({}),
			minSpeechMs: 100,
			threshold: 0.5,
			startupFailure: "model SHA mismatch",
			onDegraded: degraded,
		});

		for (let chain = 0; chain < 2; chain += 1) {
			gate.begin("gated", chain * 100);
			gate.push(frame(chain), chain * 100);
			gate.end(chain * 100 + 20);
			expect(gate.takeDue(chain * 100 + 20)).toEqual([
				{ frame: frame(chain), speech: true },
			]);
		}

		expect(score).not.toHaveBeenCalled();
		expect(degraded).toHaveBeenCalledTimes(1);
		expect(degraded).toHaveBeenCalledWith({
			reason: "startup",
			consecutive: 1,
			sessionPermanent: true,
			message: "model SHA mismatch",
		});
	});

	it("D-GATE6 retries transient score faults by chain and stops after three strikes", async () => {
		const score = vi.fn(async () => {
			throw new Error("inference failed");
		});
		const degraded = vi.fn();
		const gate = new UplinkSpeechGate({
			score,
			initialState: () => ({}),
			minSpeechMs: 100,
			threshold: 0.5,
			onDegraded: degraded,
		});

		for (let chain = 0; chain < 3; chain += 1) {
			gate.begin("gated", chain * 100);
			gate.push(frame(chain * 2), chain * 100);
			gate.push(frame(chain * 2 + 1), chain * 100 + 20);
			await settle();
			gate.end(chain * 100 + 40);
			gate.takeDue(chain * 100 + 40);
		}
		expect(score).toHaveBeenCalledTimes(3);
		expect(degraded.mock.calls.map(([event]) => event.consecutive)).toEqual([
			1, 2, 3,
		]);
		expect(degraded.mock.calls.at(-1)?.[0]).toMatchObject({
			reason: "score_error",
			sessionPermanent: true,
		});

		gate.begin("gated", 400);
		gate.push(frame(20), 400);
		gate.push(frame(21), 420);
		await settle();
		gate.end(440);
		const output = gate.takeDue(440);
		expect(score).toHaveBeenCalledTimes(3);
		expect(output.every(({ speech }) => speech)).toBe(true);
	});

	it("D-GATE6 preserves frame order when an in-flight score fault fail-opens", async () => {
		let scoreCalls = 0;
		const gate = new UplinkSpeechGate({
			score: vi.fn(async () => {
				scoreCalls += 1;
				if (scoreCalls === 8) throw new Error("inference failed");
				return { probability: 0.1, next: {} };
			}),
			initialState: () => ({}),
			minSpeechMs: 100,
			threshold: 0.5,
		});
		const output: number[] = [];
		gate.begin("gated", 0);
		for (let index = 1; index <= 30; index += 1) {
			gate.push(frame(index), index * 20);
			await settle();
			output.push(
				...gate
					.takeDue(index * 20)
					.map(({ frame: emitted }) => emitted.readInt32LE(0)),
			);
		}
		gate.end(620);
		output.push(
			...gate.takeDue(620).map(({ frame: emitted }) => emitted.readInt32LE(0)),
		);

		expect(output).toEqual(Array.from({ length: 30 }, (_, index) => index + 1));
	});

	it("D-GATE6 marks queue overflow before the delayed audio becomes due", () => {
		const pending = deferred<{ probability: number; next: unknown }>();
		const degraded = vi.fn();
		const gate = new UplinkSpeechGate({
			score: vi.fn(() => pending.promise),
			initialState: () => ({}),
			minSpeechMs: 100,
			threshold: 0.5,
			onDegraded: degraded,
		});
		gate.begin("gated", 0);
		for (let index = 0; index < 32; index += 1) {
			gate.push(frame(index), index * 20);
		}
		gate.end(640);
		gate.takeDue(660);

		expect(gate.takeCompleted()).toEqual([
			expect.objectContaining({
				degraded: "queue_overflow",
				framesSilencedBeforeDegrade: 0,
			}),
		]);
		expect(degraded).toHaveBeenCalledWith(
			expect.objectContaining({ reason: "queue_overflow", consecutive: 1 }),
		);
	});
});
