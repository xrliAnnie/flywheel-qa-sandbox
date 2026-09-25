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
				sessionId: "11111111-1111-4111-8111-111111111111",
				generation: 7,
				roomKey: "engine-a-room",
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
			expect(room.roomIO.identity).toMatchObject({
				sessionId: "11111111-1111-4111-8111-111111111111",
				generation: 7,
				roomKey: "engine-a-room",
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
			expect(room.roomIO.identity).toMatchObject({
				sessionId: "legacy:thread",
				generation: 1,
				roomKey: "guild:voice-channel",
			});

			expect(await room.start()).toEqual({ founderPresent: true });
			await vi.advanceTimersByTimeAsync(40);
			expect(onAudio).toHaveBeenCalledTimes(2);
			expect(onAudio.mock.calls[0]?.[0]).toEqual(Buffer.alloc(960));
			expect(onAudio.mock.calls[0]?.[1]).toEqual({
				ownerName: null,
				ownerUserId: null,
				utteranceId: null,
			});
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
			if (probability === 1) {
				expect(
					onAudio.mock.calls.some(
						([frame, metadata]) =>
							frame.readInt16LE(0) === 2_500 &&
							metadata.ownerUserId === "founder" &&
							metadata.ownerName === "Annie" &&
							typeof metadata.utteranceId === "string",
					),
				).toBe(true);
			}
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

	it("degrades and resubscribes the same continuous speaker without ending the room", async () => {
		vi.useFakeTimers();
		const speaking = new Map<string, (userId: string) => void>();
		const firstOpus = new PassThrough();
		const secondOpus = new PassThrough();
		const firstDecoder = new PassThrough();
		const secondDecoder = new PassThrough();
		const subscribe = vi
			.fn<(userId: string) => NodeJS.ReadableStream>()
			.mockReturnValueOnce(firstOpus)
			.mockReturnValueOnce(secondOpus);
		const createDecoder = vi
			.fn<() => NodeJS.ReadWriteStream>()
			.mockReturnValueOnce(firstDecoder)
			.mockReturnValueOnce(secondDecoder);
		const onError = vi.fn();
		const health: Array<{ state: string; reason: string }> = [];
		const client = {
			user: { id: "voice-bot" },
			login: vi.fn(async () => {}),
			isReady: () => true,
			once: vi.fn(),
			destroy: vi.fn(async () => {}),
		};
		const room = new DiscordVoiceRoom({
			createVad: async () => ({
				score: async (_samples, state) => ({ probability: 1, next: state }),
				close: async () => {},
			}),
			deps: {
				createClient: () => client,
				joinVoice: vi.fn(async () => ({})),
				subscribeManual: () => subscribe,
				createDecoder,
				createPlayer: () => ({ play: vi.fn(), stop: vi.fn(), on: vi.fn() }),
				createResource: vi.fn(),
				speakingEvents: () => ({
					on: (event, callback) => speaking.set(event, callback),
				}),
				receiveEvents: () => ({
					onTransition: () => () => {},
					onDiagnostic: () => () => {},
					isSpeaking: (userId) => userId === "founder",
				}),
				memberDisplayName: vi.fn(async () => "Annie"),
				userVoiceChannelId: vi.fn(async () => "voice-channel"),
				onVoiceStateUpdate: () => () => {},
				sendMessage: vi.fn(async () => {}),
				leaveVoice: vi.fn(),
			},
			token: "token",
			expectedBotUserId: "voice-bot",
			guildId: "guild",
			voiceChannelId: "voice-channel",
			threadId: "thread",
			founderUserId: "founder",
			qaAllowUserIds: [],
			onAudio: vi.fn(),
			onFounderPresence: vi.fn(),
			onReceiveHealth: (snapshot) => health.push(snapshot),
			onError,
		});

		await room.start();
		speaking.get("start")?.("founder");
		firstOpus.emit(
			"error",
			new Error(
				"Failed to decrypt: DecryptionFailed(UnencryptedWhenPassthroughDisabled)",
			),
		);
		await vi.advanceTimersByTimeAsync(250);
		expect(subscribe).toHaveBeenCalledTimes(2);
		for (let frame = 0; frame < 10; frame += 1) {
			secondOpus.write(Buffer.alloc(3_840));
		}
		expect(health).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ state: "degraded", reason: "dave_decrypt" }),
				expect.objectContaining({
					state: "receiving",
					reason: "audio_observed",
				}),
			]),
		);
		expect(onError).not.toHaveBeenCalled();
		await room.stop();
	});

	it("restores the first retry delay after 30 seconds without receive failures across short utterances", async () => {
		vi.useFakeTimers();
		const speaking = new Map<string, (userId: string) => void>();
		const speakingUsers = new Set<string>();
		const opuses = Array.from({ length: 4 }, () => new PassThrough());
		const decoders = Array.from({ length: 4 }, () => new PassThrough());
		const subscribe = vi
			.fn<(userId: string) => NodeJS.ReadableStream>()
			.mockImplementation(() => opuses[subscribe.mock.calls.length - 1]!);
		const createDecoder = vi
			.fn<() => NodeJS.ReadWriteStream>()
			.mockImplementation(() => decoders[createDecoder.mock.calls.length - 1]!);
		const client = {
			user: { id: "voice-bot" },
			login: vi.fn(async () => {}),
			isReady: () => true,
			once: vi.fn(),
			destroy: vi.fn(async () => {}),
		};
		const room = new DiscordVoiceRoom({
			createVad: async () => ({
				score: async (_samples, state) => ({ probability: 1, next: state }),
				close: async () => {},
			}),
			deps: {
				createClient: () => client,
				joinVoice: vi.fn(async () => ({})),
				subscribeManual: () => subscribe,
				createDecoder,
				createPlayer: () => ({ play: vi.fn(), stop: vi.fn(), on: vi.fn() }),
				createResource: vi.fn(),
				speakingEvents: () => ({
					on: (event, callback) => speaking.set(event, callback),
				}),
				receiveEvents: () => ({
					onTransition: () => () => {},
					onDiagnostic: () => () => {},
					isSpeaking: (userId) => speakingUsers.has(userId),
				}),
				memberDisplayName: vi.fn(async () => "Annie"),
				userVoiceChannelId: vi.fn(async () => "voice-channel"),
				onVoiceStateUpdate: () => () => {},
				sendMessage: vi.fn(async () => {}),
				leaveVoice: vi.fn(),
			},
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
		});

		await room.start();
		speakingUsers.add("founder");
		speaking.get("start")?.("founder");
		opuses[0]?.emit("error", new Error("packet failure"));
		await vi.advanceTimersByTimeAsync(250);
		for (let frame = 0; frame < 10; frame += 1) {
			opuses[1]?.write(Buffer.alloc(3_840));
		}
		speakingUsers.delete("founder");
		speaking.get("end")?.("founder");
		await vi.advanceTimersByTimeAsync(30_000);

		speakingUsers.add("founder");
		speaking.get("start")?.("founder");
		opuses[2]?.emit("error", new Error("packet failure"));
		await vi.advanceTimersByTimeAsync(250);
		expect(subscribe).toHaveBeenCalledTimes(4);
		await room.stop();
	});

	it("uses a new admitted speaker for the single post-cooldown probation", async () => {
		vi.useFakeTimers();
		const speaking = new Map<string, (userId: string) => void>();
		const speakingUsers = new Set<string>();
		const opuses = Array.from({ length: 5 }, () => new PassThrough());
		const decoders = Array.from({ length: 5 }, () => new PassThrough());
		const subscribe = vi
			.fn<(userId: string) => NodeJS.ReadableStream>()
			.mockImplementation(() => opuses[subscribe.mock.calls.length - 1]!);
		const createDecoder = vi
			.fn<() => NodeJS.ReadWriteStream>()
			.mockImplementation(() => decoders[createDecoder.mock.calls.length - 1]!);
		const client = {
			user: { id: "voice-bot" },
			login: vi.fn(async () => {}),
			isReady: () => true,
			once: vi.fn(),
			destroy: vi.fn(async () => {}),
		};
		const room = new DiscordVoiceRoom({
			createVad: async () => ({
				score: async (_samples, state) => ({ probability: 1, next: state }),
				close: async () => {},
			}),
			deps: {
				createClient: () => client,
				joinVoice: vi.fn(async () => ({})),
				subscribeManual: () => subscribe,
				createDecoder,
				createPlayer: () => ({ play: vi.fn(), stop: vi.fn(), on: vi.fn() }),
				createResource: vi.fn(),
				speakingEvents: () => ({
					on: (event, callback) => speaking.set(event, callback),
				}),
				receiveEvents: () => ({
					onTransition: () => () => {},
					onDiagnostic: () => () => {},
					isSpeaking: (userId) => speakingUsers.has(userId),
				}),
				memberDisplayName: vi.fn(async () => "Annie"),
				userVoiceChannelId: vi.fn(async () => "voice-channel"),
				onVoiceStateUpdate: () => () => {},
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
			onAudio: vi.fn(),
			onFounderPresence: vi.fn(),
			onError: vi.fn(),
		});

		await room.start();
		speakingUsers.add("founder");
		speaking.get("start")?.("founder");
		for (const [index, delay] of [250, 1_000, 3_000].entries()) {
			opuses[index]?.emit("error", new Error("packet failure"));
			await vi.advanceTimersByTimeAsync(delay);
		}
		opuses[3]?.emit("error", new Error("packet failure"));
		await vi.advanceTimersByTimeAsync(1);
		speakingUsers.delete("founder");
		speakingUsers.add("qa");
		speaking.get("start")?.("qa");
		await vi.advanceTimersByTimeAsync(30_000);

		expect(subscribe).toHaveBeenCalledTimes(5);
		expect(subscribe).toHaveBeenLastCalledWith("qa");
		await room.stop();
	});
});

/**
 * FLY-2701 review R3 (MEDIUM): the abort checkpoints only run once the awaited
 * call returns. Joining really does `joinVoiceChannel()` and then waits up to
 * 15s for Ready, and the presence query is another await after the last
 * checkpoint. So when the other start branch fails, everything already created
 * here — the logged-in client, the VAD, and eventually the connection itself —
 * sat there until that call finished or the outer deadline expired.
 */
describe("DiscordVoiceRoom honours an aborted start promptly", () => {
	function room(options: {
		joinVoice: () => Promise<unknown>;
		userVoiceChannelId?: () => Promise<string | undefined>;
		signal: AbortSignal;
	}) {
		const client = {
			user: { id: "voice-bot" },
			login: vi.fn(async () => {}),
			isReady: () => true,
			once: vi.fn(),
			destroy: vi.fn(async () => {}),
		};
		const leaveVoice = vi.fn();
		const close = vi.fn(async () => {});
		const joinVoice = vi.fn(options.joinVoice);
		const instance = new DiscordVoiceRoom({
			createVad: async () => ({
				score: async (_samples, state) => ({ probability: 0, next: state }),
				close,
			}),
			deps: {
				createClient: () => client,
				joinVoice,
				sendMessage: vi.fn(async () => {}),
				subscribeManual: vi.fn(),
				createDecoder: vi.fn(),
				createPlayer: vi.fn(() => ({})),
				createResource: vi.fn(),
				speakingEvents: vi.fn(() => ({ on: vi.fn() })),
				memberDisplayName: vi.fn(),
				userVoiceChannelId: vi.fn(
					options.userVoiceChannelId ?? (async () => "voice"),
				),
				onVoiceStateUpdate: vi.fn(() => vi.fn()),
				leaveVoice,
			},
			token: "token",
			expectedBotUserId: "voice-bot",
			guildId: "guild",
			voiceChannelId: "voice",
			threadId: "thread",
			founderUserId: "founder",
			qaAllowUserIds: [],
			onAudio: vi.fn(),
			onFounderPresence: vi.fn(),
			onError: vi.fn(),
		});
		return { instance, client, leaveVoice, close, joinVoice };
	}

	it("releases the logged-in client without waiting for a hung join", async () => {
		const controller = new AbortController();
		const test = room({
			joinVoice: () => new Promise(() => {}),
			signal: controller.signal,
		});
		const started = test.instance.start(controller.signal);
		started.catch(() => undefined);

		await vi.waitFor(() => expect(test.joinVoice).toHaveBeenCalled());
		controller.abort(new Error("other branch failed"));

		// The join is still hanging and always will be; everything that already
		// exists must come down now, not in fifteen seconds.
		await vi.waitFor(() => expect(test.client.destroy).toHaveBeenCalled());
		await vi.waitFor(() => expect(test.close).toHaveBeenCalled());
	});

	it("leaves a connection that lands after the abort", async () => {
		const controller = new AbortController();
		let landJoin!: (value: unknown) => void;
		const test = room({
			joinVoice: () =>
				new Promise((resolve) => {
					landJoin = resolve;
				}),
			signal: controller.signal,
		});
		const started = test.instance.start(controller.signal);
		started.catch(() => undefined);
		await vi.waitFor(() => expect(test.joinVoice).toHaveBeenCalled());

		controller.abort(new Error("other branch failed"));
		landJoin({ connection: true });

		await expect(started).rejects.toThrow();
		await vi.waitFor(() => expect(test.leaveVoice).toHaveBeenCalled());
	});

	it("never issues the presence query once the start was aborted", async () => {
		const controller = new AbortController();
		const userVoiceChannelId = vi.fn(async () => "voice");
		const test = room({
			joinVoice: async () => {
				controller.abort(new Error("other branch failed"));
				return { connection: true };
			},
			userVoiceChannelId,
			signal: controller.signal,
		});

		await expect(test.instance.start(controller.signal)).rejects.toThrow();
		expect(userVoiceChannelId).not.toHaveBeenCalled();
		expect(test.leaveVoice).toHaveBeenCalled();
	});
});
