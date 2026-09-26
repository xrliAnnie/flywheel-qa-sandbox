import { describe, expect, it, vi } from "vitest";
import { RoomIOVoiceRoom } from "../roomio-room.js";

function options(overrides: Record<string, unknown> = {}) {
	return {
		createVad: async () => ({
			score: async (_samples: Float32Array, state: unknown) => ({
				probability: 0,
				next: state,
			}),
			close: async () => {},
		}),
		deps: {} as never,
		token: "token",
		expectedBotUserId: "voice-bot",
		guildId: "guild",
		voiceChannelId: "voice-channel",
		threadId: "thread",
		founderUserId: "founder",
		qaAllowUserIds: [],
		onAudio: vi.fn(),
		onFounderPresence: vi.fn(),
		onError: vi.fn(),
		...overrides,
	};
}

describe("RoomIOVoiceRoom (Engine A)", () => {
	it("binds the RoomIO identity to the session, generation and room", () => {
		const room = new RoomIOVoiceRoom(
			options({
				sessionId: "11111111-1111-4111-8111-111111111111",
				generation: 7,
				roomKey: "engine-a-room",
			}),
		);
		expect(room.roomIO.identity).toMatchObject({
			sessionId: "11111111-1111-4111-8111-111111111111",
			generation: 7,
			roomKey: "engine-a-room",
		});
	});

	it("derives a legacy identity when none is given", () => {
		const room = new RoomIOVoiceRoom(options());
		expect(room.roomIO.identity).toMatchObject({
			sessionId: "legacy:thread",
			generation: 1,
			roomKey: "guild:voice-channel",
		});
	});
});
