import { describe, expect, it } from "vitest";
import { engineBVoice, parseVoiceProjection } from "../projection.js";

const sessionId = "11111111-1111-4111-8111-111111111111";
const projection = {
	sessionId,
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
	});

	it("treats engine B's liveVoice as optional so stored projections still parse and recover (FLY-2885)", () => {
		// Projections saved before FLY-2885 have no liveVoice at all.
		expect("liveVoice" in projection).toBe(false);
		expect(parseVoiceProjection(projection, sessionId)).toEqual(projection);
		for (const liveVoice of ["cove", "sol", "juniper"]) {
			expect(
				parseVoiceProjection({ ...projection, liveVoice }, sessionId),
			).toMatchObject({ liveVoice });
		}
		for (const liveVoice of ["marin", "", null, 3]) {
			expect(() =>
				parseVoiceProjection({ ...projection, liveVoice }, sessionId),
			).toThrow("voice_projection_invalid");
		}
	});

	it("resolves engine B's voice without falling back to realtimeVoice", () => {
		expect(engineBVoice(projection)).toBe("cove");
		expect(
			engineBVoice({ ...projection, realtimeVoice: "verse", liveVoice: "sol" }),
		).toBe("sol");
	});
});
