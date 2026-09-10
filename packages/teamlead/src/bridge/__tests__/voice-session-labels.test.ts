import { describe, expect, it } from "vitest";
import { voiceThreadName } from "../voice-session-labels.js";

describe("voice session labels", () => {
	it("names meeting and RG threads from persisted session data", () => {
		expect(
			voiceThreadName({
				mode: "meeting",
				topic: "Voice meeting",
				createdAt: "2026-09-08T20:00:00.000Z",
				rootMessageId: "100000000000000011",
			}),
		).toBe("🎙️ Voice meeting · 2026-09-08");
		expect(
			voiceThreadName({
				mode: "rg",
				topic: "walk",
				createdAt: "2026-09-08T20:01:00.000Z",
				rootMessageId: "100000000000000011",
			}),
		).toBe("🎧 随身 · 2026-09-08 20:01");
	});

	it("falls back to the generic name when topic is absent", () => {
		expect(
			voiceThreadName({
				mode: "meeting",
				topic: null,
				createdAt: "2026-09-08T20:00:00.000Z",
				rootMessageId: "100000000000000011",
			}),
		).toBe("voice-00000011");
	});
});
