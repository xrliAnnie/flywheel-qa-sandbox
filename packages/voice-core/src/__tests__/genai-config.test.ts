/**
 * FLY-967 P1 — real-connector config assembly against a mocked @google/genai:
 * systemInstruction composition (systemPreamble + systemHint), speechConfig
 * carrying ONLY voiceName (native-audio models reject an explicit languageCode
 * — Codex R1 #3), the sendText realtime frame shape, and byte-compat of the
 * unset paths (audio frame shape / no speechConfig / no systemInstruction).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveConnectParams } from "../backends/gemini/transport.js";

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

import { createGenaiTransport } from "../backends/gemini/genaiConnector.js";

const base: LiveConnectParams = {
	model: "gemini-live-test",
	tools: [],
	asyncFunctionCalling: false,
};

async function connectWith(over: Partial<LiveConnectParams>) {
	const transport = createGenaiTransport({ apiKey: "test-key" });
	const conn = await transport.connect({ ...base, ...over });
	const call = mocks.connect.mock.calls.at(-1)?.[0] as {
		model: string;
		config: Record<string, unknown>;
	};
	return { conn, config: call.config };
}

beforeEach(() => {
	mocks.connect.mockReset();
	mocks.session.sendRealtimeInput.mockReset();
	mocks.connect.mockResolvedValue(mocks.session);
});

describe("speechConfig — voiceName only, never languageCode", () => {
	it("maps voice to speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName", async () => {
		const { config } = await connectWith({ voice: "Kore" });
		expect(config.speechConfig).toEqual({
			voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
		});
		expect(JSON.stringify(config.speechConfig)).not.toContain("languageCode");
	});

	it("omits speechConfig entirely when voice is unset (byte-compat)", async () => {
		const { config } = await connectWith({});
		expect(config).not.toHaveProperty("speechConfig");
	});
});

describe("systemInstruction — preamble + hint composition", () => {
	it("prefixes systemPreamble before systemHint with a blank line", async () => {
		const { config } = await connectWith({
			systemPreamble: "[简报 15:00] board 快照…",
			systemHint: "口语短句",
		});
		expect(config.systemInstruction).toEqual({
			parts: [{ text: "[简报 15:00] board 快照…\n\n口语短句" }],
		});
	});

	it("preamble alone still lands in systemInstruction", async () => {
		const { config } = await connectWith({ systemPreamble: "只有简报" });
		expect(config.systemInstruction).toEqual({
			parts: [{ text: "只有简报" }],
		});
	});

	it("hint alone keeps the current shape (byte-compat)", async () => {
		const { config } = await connectWith({ systemHint: "只有口语纪律" });
		expect(config.systemInstruction).toEqual({
			parts: [{ text: "只有口语纪律" }],
		});
	});

	it("neither set → no systemInstruction key (byte-compat)", async () => {
		const { config } = await connectWith({});
		expect(config).not.toHaveProperty("systemInstruction");
	});
});

describe("realtime input frames", () => {
	it("sendText sends a bare text realtime frame", async () => {
		const { conn } = await connectWith({});
		conn.sendText("请用一两句开场");
		expect(mocks.session.sendRealtimeInput).toHaveBeenCalledWith({
			text: "请用一两句开场",
		});
	});

	it("sendAudio frame shape is unchanged (regression)", async () => {
		const { conn } = await connectWith({});
		conn.sendAudio(Buffer.from("PCMDATA"), {
			encoding: "pcm16",
			sampleRateHz: 16_000,
			channels: 1,
		});
		expect(mocks.session.sendRealtimeInput).toHaveBeenCalledWith({
			audio: {
				data: Buffer.from("PCMDATA").toString("base64"),
				mimeType: "audio/pcm;rate=16000",
			},
		});
	});

	it("response modality stays AUDIO (regression)", async () => {
		const { config } = await connectWith({ voice: "Kore" });
		expect(config.responseModalities).toEqual(["AUDIO"]);
	});

	it("bargeIn ON (default) keeps native interruption — no realtimeInputConfig override (Annie's call: headphone users get real barge-in)", async () => {
		const { config } = await connectWith({ voice: "Kore" });
		expect(config).not.toHaveProperty("realtimeInputConfig");
		const explicit = await connectWith({ voice: "Kore", bargeIn: true });
		expect(explicit.config).not.toHaveProperty("realtimeInputConfig");
	});

	it("bargeIn OFF pins NO_INTERRUPTION — speaker users' echo must not cancel a live response (FLY-967 round-4: every reply died ~0.3s in)", async () => {
		const { config } = await connectWith({ voice: "Kore", bargeIn: false });
		expect(config.realtimeInputConfig).toEqual({
			activityHandling: "NO_INTERRUPTION",
		});
	});
});

describe("language contract sentinel (FLY-1065 — Annie: 中英混说 must both work)", () => {
	it("input/output transcription configs stay {} — languageCodes is NEVER pinned (unset = model auto-detects the language)", async () => {
		const { config } = await connectWith({});
		expect(config.inputAudioTranscription).toEqual({});
		expect(config.outputAudioTranscription).toEqual({});
		expect(JSON.stringify(config)).not.toContain("languageCodes");
	});
});
