import { describe, expect, it } from "vitest";
import { parseVoiceProjection } from "../projection.js";

const sessionId = "11111111-1111-4111-8111-111111111111";
const projection = {
	sessionId,
	sessionGeneration: 7,
	voiceBotUserId: "323456789012345678",
	mode: "meeting",
	projectName: "raya",
	leadId: "raya",
	displayName: "Raya",
	realtimeVoice: "marin",
	guildId: "123456789012345678",
	voiceChannelId: "223456789012345678",
	threadId: "423456789012345678",
	boundChannelIds: ["423456789012345678"],
	founderUserId: "523456789012345678",
	qaAllowUserIds: [],
};

describe("parseVoiceProjection", () => {
	it("reuses the Teamlead Realtime voice allowlist at the HTTP boundary", () => {
		expect(parseVoiceProjection(projection, sessionId)).toEqual(projection);
		expect(() =>
			parseVoiceProjection({ ...projection, realtimeVoice: "nova" }, sessionId),
		).toThrow("voice_projection_invalid");
		expect(() =>
			parseVoiceProjection({ ...projection, sessionGeneration: 0 }, sessionId),
		).toThrow("voice_projection_invalid");
	});
});
