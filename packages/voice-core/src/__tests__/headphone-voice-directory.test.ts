import { describe, expect, it } from "vitest";
import { VoiceDirectory } from "../headphone/voice-directory.js";

const FALLBACK = { voiceId: "zh-CN-XiaoxiaoNeural" };

describe("VoiceDirectory", () => {
	it("resolves a mapped agentId to its VoiceSpec", () => {
		const dir = new VoiceDirectory(
			{ tadashi: { voiceId: "zh-CN-YunyangNeural", rate: "-10%" } },
			FALLBACK,
		);
		expect(dir.resolve("tadashi")).toEqual({
			voiceId: "zh-CN-YunyangNeural",
			rate: "-10%",
		});
	});

	it("falls back to the default VoiceSpec for unknown agents", () => {
		const dir = new VoiceDirectory({}, FALLBACK);
		expect(dir.resolve("unknown-agent")).toEqual(FALLBACK);
	});

	it("matches agentIds case-insensitively", () => {
		const dir = new VoiceDirectory(
			{ Tadashi: { voiceId: "zh-CN-YunyangNeural" } },
			FALLBACK,
		);
		expect(dir.resolve("tadashi")).toEqual({ voiceId: "zh-CN-YunyangNeural" });
		expect(dir.resolve("TADASHI")).toEqual({ voiceId: "zh-CN-YunyangNeural" });
	});

	it("throws at construction on duplicate agentIds differing only by case (config error)", () => {
		expect(
			() =>
				new VoiceDirectory(
					{
						tadashi: { voiceId: "a" },
						Tadashi: { voiceId: "b" },
					},
					FALLBACK,
				),
		).toThrow(/duplicate/i);
	});
});
