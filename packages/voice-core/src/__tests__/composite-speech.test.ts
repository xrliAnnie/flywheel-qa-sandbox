import { describe, expect, it, vi } from "vitest";
import { CompositeSpeech } from "../backends/openai-live/CompositeSpeech.js";
import type {
	RoomIO,
	StreamingTtsChunk,
	StreamingTtsEngine,
} from "../index.js";

const PCM = { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 } as const;

function deferred<T>() {
	let resolve!: (value: T) => void;
	return {
		promise: new Promise<T>((done) => {
			resolve = done;
		}),
		resolve,
	};
}

function room(overrides: Partial<RoomIO> = {}) {
	return {
		startSpeech: vi.fn(() => ({
			outcome: "accepted" as const,
			speechId: "unused",
			generation: 4,
		})),
		writeSpeech: vi.fn(async (frame) => ({
			outcome: "submitted" as const,
			speechId: frame.speechId,
			generation: frame.generation,
			sequence: frame.sequence,
		})),
		endSpeech: vi.fn(async (speechId, generation) => ({
			outcome: "submitted" as const,
			speechId,
			generation,
		})),
		localPlaybackCancel: vi.fn(),
		...overrides,
	} as Pick<
		RoomIO,
		"startSpeech" | "writeSpeech" | "endSpeech" | "localPlaybackCancel"
	>;
}

function tts(
	produce: (signal: AbortSignal) => AsyncIterable<StreamingTtsChunk>,
): StreamingTtsEngine {
	return {
		synthesize: vi.fn(),
		synthesizeStream: (_text, _voice, { signal }) => produce(signal),
	};
}

describe("CompositeSpeech", () => {
	it("submits the first PCM chunk before synthesis completes", async () => {
		const continueStream = deferred<void>();
		const io = room();
		const speaker = new CompositeSpeech({
			sessionId: "session-1",
			generation: 4,
			room: io,
			tts: tts(async function* () {
				yield { audio: Buffer.from([1, 0]), format: PCM, ttsFirstByteMs: 8 };
				await continueStream.promise;
				yield { audio: Buffer.from([2, 0]), format: PCM };
			}),
			voice: "zh-CN-XiaoxiaoNeural",
			beforeSpeak: vi.fn(async () => undefined),
		});

		const speaking = speaker.speak("Lead 原话", "readback", {
			pendingKey: "lead:1",
			verification: "required",
		});
		await vi.waitFor(() => expect(io.writeSpeech).toHaveBeenCalledTimes(1));
		expect(io.endSpeech).not.toHaveBeenCalled();
		continueStream.resolve();

		await expect(speaking).resolves.toMatchObject({
			outcome: "completed",
			transport: "submitted",
			contentProof: "deterministic_tts",
		});
		expect(io.writeSpeech).toHaveBeenCalledTimes(2);
		expect(io.endSpeech).toHaveBeenCalledOnce();
	});

	it("replays the same pending request and rejects a conflicting digest", async () => {
		const gate = deferred<void>();
		const io = room();
		const speaker = new CompositeSpeech({
			sessionId: "session-1",
			generation: 4,
			room: io,
			tts: tts(async function* () {
				await gate.promise;
				yield { audio: Buffer.from([1, 0]), format: PCM };
			}),
			voice: "voice-1",
			beforeSpeak: vi.fn(async () => undefined),
		});

		const first = speaker.speak("same", "brief", {
			pendingKey: "pending-1",
			verification: "best_effort",
		});
		expect(
			speaker.speak("same", "brief", {
				pendingKey: "pending-1",
				verification: "best_effort",
			}),
		).toBe(first);
		await expect(
			speaker.speak("different", "brief", {
				pendingKey: "pending-1",
				verification: "best_effort",
			}),
		).resolves.toMatchObject({
			outcome: "rejected",
			reason: "pending_key_conflict",
			transport: "none",
			contentProof: "none",
		});
		gate.resolve();
		await first;
	});

	it("fences later chunks when cancelled across a write await", async () => {
		const writeGate = deferred<{
			outcome: "submitted";
			speechId: string;
			generation: number;
			sequence: number;
		}>();
		const io = room({ writeSpeech: vi.fn(() => writeGate.promise) });
		const speaker = new CompositeSpeech({
			sessionId: "session-1",
			generation: 4,
			room: io,
			tts: tts(async function* () {
				yield { audio: Buffer.from([1, 0]), format: PCM };
				yield { audio: Buffer.from([2, 0]), format: PCM };
			}),
			voice: "voice-1",
			beforeSpeak: vi.fn(async () => undefined),
		});

		const speaking = speaker.speak("cancel me", "cue", {
			pendingKey: "pending-1",
			verification: "required",
		});
		await vi.waitFor(() => expect(io.writeSpeech).toHaveBeenCalledOnce());
		speaker.cancel("barge-in");
		const frame = vi.mocked(io.writeSpeech).mock.calls[0]![0];
		writeGate.resolve({
			outcome: "submitted",
			speechId: frame.speechId,
			generation: frame.generation,
			sequence: frame.sequence,
		});

		await expect(speaking).resolves.toMatchObject({
			outcome: "failed",
			reason: "barge-in",
			transport: "submitted",
			contentProof: "none",
		});
		expect(io.writeSpeech).toHaveBeenCalledOnce();
		expect(io.localPlaybackCancel).toHaveBeenCalledOnce();
	});

	it("cancels an opened RoomIO stream when synthesis fails after its first chunk", async () => {
		const io = room();
		const speaker = new CompositeSpeech({
			sessionId: "session-1",
			generation: 4,
			room: io,
			tts: tts(async function* () {
				yield { audio: Buffer.from([1, 0]), format: PCM };
				throw new Error("decoder truncated");
			}),
			voice: "voice-1",
			beforeSpeak: vi.fn(async () => undefined),
		});

		await expect(
			speaker.speak("truncated", "readback", {
				pendingKey: "pending-1",
				verification: "required",
			}),
		).resolves.toMatchObject({
			outcome: "failed",
			reason: "decoder truncated",
			transport: "submitted",
			contentProof: "none",
		});
		expect(io.localPlaybackCancel).toHaveBeenCalledOnce();
		expect(io.endSpeech).not.toHaveBeenCalled();
	});
});
