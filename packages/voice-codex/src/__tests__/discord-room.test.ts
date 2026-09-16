import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordVoiceRoom } from "../discord-room.js";

function pcm16(samples: number[]): Buffer {
	const output = Buffer.alloc(samples.length * 2);
	samples.forEach((sample, index) => output.writeInt16LE(sample, index * 2));
	return output;
}

describe("DiscordVoiceRoom", () => {
	afterEach(() => vi.useRealTimers());
	it.each([undefined, "wrong-bot"])(
		"destroys ready client with identity %s before join or delivery",
		async (id) => {
			const client = {
				user: id ? { id } : undefined,
				login: vi.fn(async () => {}),
				isReady: () => true,
				once: vi.fn(),
				destroy: vi.fn(async () => {}),
			};
			const joinVoice = vi.fn(async () => ({}));
			const sendMessage = vi.fn(async () => {});
			const onAudio = vi.fn();
			const close = vi.fn(async () => {});
			const room = new DiscordVoiceRoom({
				createVad: async () => ({
					score: async (_samples, state) => ({ probability: 0, next: state }),
					close,
				}),
				deps: {
					createClient: () => client,
					joinVoice,
					sendMessage,
					subscribeManual: vi.fn(),
					createDecoder: vi.fn(),
					createPlayer: vi.fn(),
					createResource: vi.fn(),
					speakingEvents: vi.fn(),
					memberDisplayName: vi.fn(),
					userVoiceChannelId: vi.fn(),
					onVoiceStateUpdate: vi.fn(),
					leaveVoice: vi.fn(),
				},
				token: "token",
				expectedBotUserId: "voice-bot",
				guildId: "guild",
				voiceChannelId: "voice",
				threadId: "thread",
				founderUserId: "founder",
				qaAllowUserIds: [],
				onAudio,
				onFounderPresence: vi.fn(),
				onError: vi.fn(),
			});
			await expect(room.start()).rejects.toThrow("lead_bot_identity_mismatch");
			expect(joinVoice).not.toHaveBeenCalled();
			expect(sendMessage).not.toHaveBeenCalled();
			expect(onAudio).not.toHaveBeenCalled();
			expect(client.destroy).toHaveBeenCalledOnce();
			expect(close).toHaveBeenCalledOnce();
		},
	);
	it.each([0, 1])(
		"admits projected speakers and clocks VAD probability %s as speech or silence",
		async (probability) => {
			vi.useFakeTimers();
			const speaking = new Map<string, (userId: string) => void>();
			let voiceState:
				| ((event: {
						userId: string;
						isBot: boolean;
						fromChannelId: string | null;
						toChannelId: string | null;
				  }) => void)
				| undefined;
			const opus = new PassThrough();
			const decoder = new PassThrough();
			const client = {
				user: { id: "voice-bot" },
				login: vi.fn(async () => {}),
				isReady: () => true,
				once: vi.fn(),
				destroy: vi.fn(async () => {}),
			};
			const onAudio = vi.fn();
			const onFounderPresence = vi.fn();
			const subscribe = vi.fn(() => opus);
			const room = new DiscordVoiceRoom({
				createVad: async () => ({
					score: async (_samples, state) => ({ probability, next: state }),
					close: async () => {},
				}),
				deps: {
					createClient: () => client,
					joinVoice: vi.fn(async () => ({})),
					subscribeManual: () => subscribe,
					createDecoder: () => decoder,
					createPlayer: () => ({ play: vi.fn(), stop: vi.fn(), on: vi.fn() }),
					createResource: vi.fn(),
					speakingEvents: () => ({
						on: (event, callback) => speaking.set(event, callback),
					}),
					memberDisplayName: vi.fn(async () => "Annie"),
					userVoiceChannelId: vi.fn(async () => "voice-channel"),
					onVoiceStateUpdate: (_client, callback) => {
						voiceState = callback;
						return () => {};
					},
					sendMessage: vi.fn(async () => {}),
					leaveVoice: vi.fn(),
				},
				token: "token",
				expectedBotUserId: "voice-bot",
				guildId: "guild",
				voiceChannelId: "voice-channel",
				threadId: "thread",
				founderUserId: "founder",
				qaAllowUserIds: ["qa"],
				onAudio,
				onFounderPresence,
				onError: vi.fn(),
			});

			expect(await room.start()).toEqual({ founderPresent: true });
			await vi.advanceTimersByTimeAsync(40);
			expect(onAudio).toHaveBeenCalledTimes(2);
			expect(onAudio.mock.calls[0]?.[0]).toEqual(Buffer.alloc(960));
			speaking.get("start")?.("stranger");
			expect(subscribe).not.toHaveBeenCalled();
			speaking.get("start")?.("founder");
			for (let frame = 0; frame < 40; frame += 1) {
				opus.write(pcm16(Array(1_920).fill(2_500)));
				await vi.advanceTimersByTimeAsync(20);
			}
			expect(
				onAudio.mock.calls.some(([frame]) => frame.readInt16LE(0) === 2_500),
			).toBe(probability === 1);
			expect(room.speaker()).toMatchObject({ userId: "founder" });
			speaking.get("end")?.("founder");
			await vi.advanceTimersByTimeAsync(1_000);
			expect(onAudio.mock.lastCall?.[0]).toEqual(Buffer.alloc(960));
			await vi.advanceTimersByTimeAsync(2_000);
			expect(room.speaker()).toMatchObject({ userId: "founder" });
			voiceState?.({
				userId: "founder",
				isBot: false,
				fromChannelId: "voice-channel",
				toChannelId: null,
			});
			expect(onFounderPresence).toHaveBeenCalledWith(false);
			await room.stop();
			const sentBeforeStop = onAudio.mock.calls.length;
			await vi.advanceTimersByTimeAsync(100);
			expect(onAudio).toHaveBeenCalledTimes(sentBeforeStop);
			expect(client.destroy).toHaveBeenCalled();
		},
	);
});
