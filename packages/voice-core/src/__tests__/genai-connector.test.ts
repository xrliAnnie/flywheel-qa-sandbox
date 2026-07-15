import { describe, expect, it, vi } from "vitest";
import type { LiveServerEvent } from "../backends/gemini/transport.js";

const mocks = vi.hoisted(() => ({
	connect: vi.fn(),
	session: {
		sendRealtimeInput: vi.fn(),
		sendToolResponse: vi.fn(),
		close: vi.fn(),
	},
}));

vi.mock("@google/genai", () => ({
	GoogleGenAI: class {
		live = { connect: mocks.connect };
	},
	Modality: { AUDIO: "AUDIO", TEXT: "TEXT" },
}));

import {
	createGenaiTransport,
	describeUnexpectedClose,
} from "../backends/gemini/genaiConnector.js";

/** connect through the mocked SDK and return a serverContent→events driver. */
async function makeMessageDriver() {
	mocks.connect.mockReset();
	mocks.connect.mockResolvedValue(mocks.session);
	const transport = createGenaiTransport({ apiKey: "test-key" });
	const conn = await transport.connect({
		model: "gemini-live-test",
		tools: [],
		asyncFunctionCalling: false,
	});
	const events: LiveServerEvent[] = [];
	conn.onEvent((e) => events.push(e));
	const callbacks = (
		mocks.connect.mock.calls.at(-1)?.[0] as {
			callbacks: { onmessage: (msg: unknown) => void };
		}
	).callbacks;
	return { events, deliver: (msg: unknown) => callbacks.onmessage(msg) };
}

/**
 * FLY-1065 P1 — mapMessage passthrough: the SDK's Transcription.finished flag
 * and serverContent.generationComplete reach the session layer (the probe
 * proved turnComplete arrives ~10s late — generationComplete is the assistant
 * flush signal; finished stays as the official fast path).
 */
describe("mapMessage transcript passthrough (FLY-1065)", () => {
	it("passes finished:true through on input transcription", async () => {
		const { events, deliver } = await makeMessageDriver();
		deliver({
			serverContent: { inputTranscription: { text: "整句", finished: true } },
		});
		expect(events).toEqual([
			{
				type: "transcript",
				role: "user",
				text: "整句",
				final: false,
				finished: true,
			},
		]);
	});

	it("passes finished:true through on output transcription", async () => {
		const { events, deliver } = await makeMessageDriver();
		deliver({
			serverContent: { outputTranscription: { text: "答完", finished: true } },
		});
		expect(events[0]).toMatchObject({
			type: "transcript",
			role: "assistant",
			finished: true,
		});
	});

	it("finished absent → finished:false (never undefined-truthy)", async () => {
		const { events, deliver } = await makeMessageDriver();
		deliver({ serverContent: { inputTranscription: { text: "分片" } } });
		expect(events[0]).toMatchObject({ type: "transcript", finished: false });
	});

	it("final stays !!turnComplete (dead signal kept for transport type compat)", async () => {
		const { events, deliver } = await makeMessageDriver();
		deliver({
			serverContent: {
				inputTranscription: { text: "同帧" },
				turnComplete: true,
			},
		});
		expect(events[0]).toMatchObject({ type: "transcript", final: true });
	});

	it("serverContent.generationComplete emits a generation-complete event", async () => {
		const { events, deliver } = await makeMessageDriver();
		deliver({ serverContent: { generationComplete: true } });
		expect(events).toEqual([{ type: "generation-complete" }]);
	});

	it("same-frame interrupted + outputTranscription emits the transcript FIRST (Codex R1 #5: the half-line must be in the buffer before the flush)", async () => {
		const { events, deliver } = await makeMessageDriver();
		deliver({
			serverContent: {
				interrupted: true,
				outputTranscription: { text: "同帧半句" },
			},
		});
		const types = events.map((e) => e.type);
		expect(types.indexOf("transcript")).toBeLessThan(
			types.indexOf("interrupted"),
		);
	});

	it("same-frame interrupted + inputTranscription emits interrupted FIRST (delta R1: her new words belong to the NEW turn — the cancel reset must land after the cancel)", async () => {
		const { events, deliver } = await makeMessageDriver();
		deliver({
			serverContent: {
				interrupted: true,
				inputTranscription: { text: "她插进来的新话" },
			},
		});
		const types = events.map((e) => e.type);
		expect(types.indexOf("interrupted")).toBeLessThan(
			types.indexOf("transcript"),
		);
	});

	it("full mixed frame pins the order: output transcript → interrupted → audio → input transcript → generation-complete → turn-complete", async () => {
		const { events, deliver } = await makeMessageDriver();
		deliver({
			serverContent: {
				interrupted: true,
				inputTranscription: { text: "新 user 话" },
				outputTranscription: { text: "旧 assistant 半句" },
				modelTurn: {
					parts: [
						{ inlineData: { data: Buffer.from("OLDPCM").toString("base64") } },
					],
				},
				generationComplete: true,
				turnComplete: true,
			},
		});
		expect(events.map((e) => e.type)).toEqual([
			"transcript", // assistant half-line (buffers before the flush)
			"interrupted",
			"audio", // OLD generation's audio — stays under the cancelled window
			"transcript", // user new words (reset lands after the cancel AND the old audio)
			"generation-complete",
			"turn-complete",
		]);
		expect(events[0]).toMatchObject({ role: "assistant" });
		expect(events[3]).toMatchObject({ role: "user" });
	});

	it("interrupted frame: old-generation audio emits BEFORE the input transcript (delta R2: the reset must not un-suppress cancelled audio)", async () => {
		const { events, deliver } = await makeMessageDriver();
		deliver({
			serverContent: {
				interrupted: true,
				inputTranscription: { text: "她的新话" },
				modelTurn: {
					parts: [
						{ inlineData: { data: Buffer.from("OLDPCM").toString("base64") } },
					],
				},
			},
		});
		const types = events.map((e) => e.type);
		expect(types.indexOf("audio")).toBeGreaterThan(
			types.indexOf("interrupted"),
		);
		expect(types.indexOf("audio")).toBeLessThan(types.indexOf("transcript"));
	});

	it("a non-interrupted frame keeps the input-before-output order (byte-compat)", async () => {
		const { events, deliver } = await makeMessageDriver();
		deliver({
			serverContent: {
				inputTranscription: { text: "user" },
				outputTranscription: { text: "assistant" },
			},
		});
		expect(events.map((e) => (e as { role?: string }).role)).toEqual([
			"user",
			"assistant",
		]);
	});
});

describe("describeUnexpectedClose", () => {
	it("appends model guidance when the close reason is a model-404", () => {
		const msg = describeUnexpectedClose(
			"models/gemini-live-2.5-flash-preview is not found for API version v1beta, or is not supported for bidiGenerateContent.",
			"gemini-live-2.5-flash-preview",
		);
		expect(msg).toContain("FLYWHEEL_VOICE_GEMINI_MODEL");
		expect(msg).toContain("models.list");
		expect(msg).toContain("gemini-live-2.5-flash-preview");
	});

	it("keeps plain unexpected closes unchanged", () => {
		expect(describeUnexpectedClose("going away", "m")).toBe(
			"Gemini Live connection closed unexpectedly: going away",
		);
		expect(describeUnexpectedClose(undefined, "m")).toBe(
			"Gemini Live connection closed unexpectedly",
		);
	});
});
