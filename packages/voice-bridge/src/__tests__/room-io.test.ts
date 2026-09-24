import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import type { AudioFormat, RoomBargeInEvent } from "flywheel-voice-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createRoomIO,
	ROOM_IO_IMPLEMENTATION_DIGEST,
	ROOM_IO_IMPLEMENTATION_KEY,
	ROOM_IO_IMPLEMENTATION_MANIFEST,
	ROOM_IO_VERSION,
} from "../room/RoomIO.js";

function roomFixture(options?: {
	generation?: number;
	maxOutputQueueFrames?: number;
	playbackTailMarginMs?: number;
	vadProbability?: number;
	onBargeIn?(event: RoomBargeInEvent): void;
}) {
	const handlers = new Map<
		"playing" | "idle" | "error",
		Array<(error?: Error) => void>
	>();
	const resources: unknown[] = [];
	const outputFrames: Buffer[] = [];
	const opus = new PassThrough();
	const speakingHandlers = new Map<"start" | "end", (userId: string) => void>();
	const player = {
		play: vi.fn((resource: unknown) => resources.push(resource)),
		stop: vi.fn(),
		on: vi.fn(
			(
				event: "playing" | "idle" | "error",
				callback: (error?: Error) => void,
			) => {
				handlers.set(event, [...(handlers.get(event) ?? []), callback]);
			},
		),
	};
	const client = {
		user: { id: "voice-bot" },
		login: vi.fn(async () => {}),
		isReady: () => true,
		once: vi.fn(),
		destroy: vi.fn(async () => {}),
	};
	const generation = options?.generation ?? 1;
	const room = createRoomIO({
		sessionId: "fixture-session",
		generation,
		roomKey: "guild:voice-channel",
		maxOutputQueueFrames: options?.maxOutputQueueFrames,
		playbackTailMarginMs: options?.playbackTailMarginMs,
		allowedClipPaths: ["/managed/earcon.mp3", "/managed/filler.mp3"],
		createVad: async () => ({
			score: async (_samples, state) => ({
				probability: options?.vadProbability ?? 0,
				next: state,
			}),
			close: async () => {},
		}),
		deps: {
			createClient: () => client,
			joinVoice: vi.fn(async () => ({})),
			subscribeManual: () => vi.fn(() => opus),
			createDecoder: () => new PassThrough(),
			createPlayer: () => player,
			createResource: (source) => {
				if (source.kind === "raw-stream")
					source.stream.on("data", (chunk: Buffer) => outputFrames.push(chunk));
				return source;
			},
			speakingEvents: () => ({
				on: (event, callback) => speakingHandlers.set(event, callback),
			}),
			receiveEvents: () => ({
				onTransition: () => () => {},
				onDiagnostic: () => () => {},
				isSpeaking: () => false,
			}),
			memberDisplayName: vi.fn(async () => "Founder"),
			userVoiceChannelId: vi.fn(async () => "voice-channel"),
			voiceChannelHumanCount: vi.fn(async () => 1),
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
		onError: vi.fn(),
		onBargeIn: options?.onBargeIn,
		now: () => Date.now(),
	});
	return {
		room,
		generation,
		player,
		resources,
		outputFrames,
		opus,
		speak(event: "start" | "end", userId = "founder") {
			speakingHandlers.get(event)?.(userId);
		},
		emit(event: "playing" | "idle" | "error", error?: Error) {
			for (const callback of handlers.get(event) ?? []) callback(error);
		},
	};
}

const PCM24_MONO: AudioFormat = {
	encoding: "pcm16",
	sampleRateHz: 24_000,
	channels: 1,
};

describe("RoomIO v1", () => {
	afterEach(() => vi.useRealTimers());

	it("uses borrowed resident clients and only leaves connections it owns", async () => {
		const inputClient = {
			user: { id: "ears-bot" },
			login: vi.fn(async () => {}),
			isReady: () => true,
			once: vi.fn(),
			destroy: vi.fn(async () => {}),
		};
		const outputClient = {
			user: { id: "output-bot" },
			login: vi.fn(async () => {}),
			isReady: () => true,
			once: vi.fn(),
			destroy: vi.fn(async () => {}),
		};
		const inputConnection = { kind: "ears" };
		const outputConnection = { kind: "mouth" };
		const createClient = vi.fn(() => inputClient);
		const joinVoice = vi.fn(async () => inputConnection);
		const leaveVoice = vi.fn();
		const createPlayer = vi.fn(() => ({
			play: vi.fn(),
			stop: vi.fn(),
			on: vi.fn(),
		}));
		const room = createRoomIO({
			sessionId: "resident-session",
			generation: 4,
			roomKey: "guild:voice-channel",
			createVad: async () => ({
				score: async (_samples, state) => ({ probability: 0, next: state }),
				close: async () => {},
			}),
			deps: {
				createClient,
				joinVoice,
				subscribeManual: () => vi.fn(() => new PassThrough()),
				createDecoder: () => new PassThrough(),
				createPlayer,
				createResource: (source) => source,
				speakingEvents: () => ({ on: vi.fn() }),
				receiveEvents: () => ({
					onTransition: () => () => {},
					onDiagnostic: () => () => {},
					isSpeaking: () => false,
				}),
				memberDisplayName: vi.fn(),
				userVoiceChannelId: vi.fn(async () => "voice-channel"),
				voiceChannelHumanCount: vi.fn(async () => 1),
				onVoiceStateUpdate: () => () => {},
				sendMessage: vi.fn(async () => {}),
				leaveVoice,
			},
			token: "unused-borrowed-token",
			expectedBotUserId: "output-bot",
			expectedInputBotUserId: "ears-bot",
			expectedOutputBotUserId: "output-bot",
			borrowedConnections: {
				inputClient,
				inputConnection,
				inputOwnership: "borrowed",
				outputClient,
				outputConnection,
				outputOwnership: "owned",
			},
			guildId: "guild",
			voiceChannelId: "voice-channel",
			threadId: "thread",
			founderUserId: "founder",
			qaAllowUserIds: [],
			onError: vi.fn(),
		});

		await room.start();
		expect(createClient).not.toHaveBeenCalled();
		expect(joinVoice).not.toHaveBeenCalled();
		expect(createPlayer).toHaveBeenCalledWith(outputConnection);
		await room.stop();
		expect(leaveVoice).toHaveBeenCalledTimes(1);
		expect(leaveVoice).toHaveBeenCalledWith(outputConnection);
		expect(inputClient.destroy).not.toHaveBeenCalled();
		expect(outputClient.destroy).not.toHaveBeenCalled();
	});

	it("emits speaker-bound utterance boundaries for legacy engine adapters", async () => {
		const test = roomFixture();
		const utterances: unknown[] = [];
		test.room.onUtterance((event) => utterances.push(event));
		await test.room.start();
		test.speak("start");
		test.speak("end");
		expect(utterances).toEqual([
			expect.objectContaining({
				phase: "start",
				sessionId: "fixture-session",
				generation: 1,
				attribution: expect.objectContaining({
					kind: "known",
					speakerUserId: "founder",
				}),
			}),
			expect.objectContaining({
				phase: "end",
				utteranceId: expect.any(String),
			}),
		]);
		await test.room.stop();
	});

	it("exports one versioned implementation and fences streamed output by session generation", async () => {
		vi.useFakeTimers();
		const player = { play: vi.fn(), stop: vi.fn(), on: vi.fn() };
		const client = {
			user: { id: "voice-bot" },
			login: vi.fn(async () => {}),
			isReady: () => true,
			once: vi.fn(),
			destroy: vi.fn(async () => {}),
		};
		const room = createRoomIO({
			sessionId: "session-1",
			generation: 7,
			roomKey: "guild:voice-channel",
			maxOutputQueueFrames: 1,
			createVad: async () => ({
				score: async (_samples, state) => ({ probability: 0, next: state }),
				close: async () => {},
			}),
			deps: {
				createClient: () => client,
				joinVoice: vi.fn(async () => ({})),
				subscribeManual: () => vi.fn(() => new PassThrough()),
				createDecoder: () => new PassThrough(),
				createPlayer: () => player,
				createResource: (source) => source,
				speakingEvents: () => ({ on: vi.fn() }),
				receiveEvents: () => ({
					onTransition: () => () => {},
					onDiagnostic: () => () => {},
					isSpeaking: () => false,
				}),
				memberDisplayName: vi.fn(),
				userVoiceChannelId: vi.fn(async () => "voice-channel"),
				voiceChannelHumanCount: vi.fn(async () => 1),
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
			onError: vi.fn(),
		});

		expect(ROOM_IO_VERSION).toBe(1);
		expect(ROOM_IO_IMPLEMENTATION_KEY).toBe(
			"flywheel-voice-bridge/room/RoomIO#createRoomIO",
		);
		expect(room.identity).toMatchObject({
			moduleExport: ROOM_IO_IMPLEMENTATION_KEY,
			roomIOVersion: 1,
			sessionId: "session-1",
			generation: 7,
			roomKey: "guild:voice-channel",
		});

		await expect(room.start()).resolves.toEqual({
			founderPresent: true,
			humanCount: 1,
		});
		expect(
			room.startSpeech({
				speechId: "speech-1",
				generation: 6,
				format: PCM24_MONO,
			}),
		).toEqual(expect.objectContaining({ outcome: "rejected" }));
		expect(
			room.startSpeech({
				speechId: "speech-wav",
				generation: 7,
				format: { encoding: "wav", sampleRateHz: 24_000, channels: 1 },
			}),
		).toEqual(expect.objectContaining({ outcome: "rejected" }));

		expect(
			room.startSpeech({
				speechId: "speech-1",
				generation: 7,
				format: PCM24_MONO,
			}),
		).toEqual(expect.objectContaining({ outcome: "accepted" }));
		await expect(
			room.writeSpeech({
				speechId: "speech-1",
				generation: 7,
				sequence: 0,
				pcm: Buffer.alloc(960, 1),
			}),
		).resolves.toMatchObject({ outcome: "submitted", sequence: 0 });
		let secondSubmitted = false;
		const second = room
			.writeSpeech({
				speechId: "speech-1",
				generation: 7,
				sequence: 1,
				pcm: Buffer.alloc(960, 2),
			})
			.then((receipt) => {
				secondSubmitted = true;
				return receipt;
			});
		await Promise.resolve();
		expect(secondSubmitted).toBe(false);
		await vi.advanceTimersByTimeAsync(20);
		await expect(second).resolves.toMatchObject({
			outcome: "submitted",
			sequence: 1,
		});
		const ended = room.endSpeech("speech-1", 7);
		await vi.advanceTimersByTimeAsync(20);
		await expect(ended).resolves.toMatchObject({ outcome: "submitted" });

		expect(room.audibleTail()).toMatchObject({
			estimated: true,
			sessionId: "session-1",
			generation: 7,
		});
		await room.stop();
	});

	it("binds identity to the ordered implementation closure and keeps the package graph acyclic", () => {
		const model = readFileSync(
			new URL("../../models/silero_vad.onnx", import.meta.url),
		);
		expect(ROOM_IO_IMPLEMENTATION_MANIFEST).toContainEqual({
			path: "models/silero_vad.onnx",
			sha256: createHash("sha256").update(model).digest("hex"),
		});
		expect(ROOM_IO_IMPLEMENTATION_MANIFEST.map((entry) => entry.path)).toEqual(
			[...ROOM_IO_IMPLEMENTATION_MANIFEST].map((entry) => entry.path).sort(),
		);
		expect(ROOM_IO_IMPLEMENTATION_DIGEST).toMatch(/^[a-f0-9]{64}$/);

		const bridgePackage = JSON.parse(
			readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
		) as { dependencies?: Record<string, string> };
		const codexPackage = JSON.parse(
			readFileSync(
				new URL("../../../voice-codex/package.json", import.meta.url),
				"utf8",
			),
		) as { dependencies?: Record<string, string> };
		expect(bridgePackage.dependencies).not.toHaveProperty(
			"flywheel-voice-codex",
		);
		expect(codexPackage.dependencies).toHaveProperty("flywheel-voice-bridge");
		const codexShim = readFileSync(
			new URL("../../../voice-codex/src/discord-room.ts", import.meta.url),
			"utf8",
		);
		expect(codexShim).toContain("createRoomIO");
		expect(codexShim).not.toContain("class DiscordVoiceRoom implements");
	});

	it("emits versioned capture frames and exact founder plus human presence", async () => {
		vi.useFakeTimers();
		let voiceState:
			| ((event: {
					userId: string;
					isBot: boolean;
					fromChannelId: string | null;
					toChannelId: string | null;
			  }) => void)
			| undefined;
		const frames: unknown[] = [];
		const presence: unknown[] = [];
		const client = {
			user: { id: "voice-bot" },
			login: vi.fn(async () => {}),
			isReady: () => true,
			once: vi.fn(),
			destroy: vi.fn(async () => {}),
		};
		const humanCount = vi
			.fn()
			.mockResolvedValueOnce(2)
			.mockResolvedValueOnce(1);
		const room = createRoomIO({
			sessionId: "session-capture",
			generation: 3,
			roomKey: "guild:voice-channel",
			createVad: async () => ({
				score: async (_samples, state) => ({ probability: 0, next: state }),
				close: async () => {},
			}),
			deps: {
				createClient: () => client,
				joinVoice: vi.fn(async () => ({})),
				subscribeManual: () => vi.fn(() => new PassThrough()),
				createDecoder: () => new PassThrough(),
				createPlayer: () => ({ play: vi.fn(), stop: vi.fn(), on: vi.fn() }),
				createResource: (source) => source,
				speakingEvents: () => ({ on: vi.fn() }),
				receiveEvents: () => ({
					onTransition: () => () => {},
					onDiagnostic: () => () => {},
					isSpeaking: () => false,
				}),
				memberDisplayName: vi.fn(),
				userVoiceChannelId: vi.fn(async () => "voice-channel"),
				voiceChannelHumanCount: humanCount,
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
			qaAllowUserIds: [],
			onFrame: (frame) => frames.push(frame),
			onPresence: (snapshot) => presence.push(snapshot),
			onError: vi.fn(),
			now: () => Date.now(),
		});

		await room.start();
		expect(presence).toEqual([{ founderPresent: true, humanCount: 2 }]);
		await vi.advanceTimersByTimeAsync(40);
		expect(frames).toEqual([
			expect.objectContaining({
				sessionId: "session-capture",
				generation: 3,
				sequence: 0,
				format: PCM24_MONO,
				attribution: { kind: "unknown", reason: "no_active_speaker" },
			}),
			expect.objectContaining({ sequence: 1 }),
		]);

		voiceState?.({
			userId: "founder",
			isBot: false,
			fromChannelId: "voice-channel",
			toChannelId: null,
		});
		await vi.waitFor(() =>
			expect(presence).toContainEqual({ founderPresent: false, humanCount: 1 }),
		);
		await room.stop();
	});

	it("re-arms a fresh PCM resource on the same player after a managed clip", async () => {
		vi.useFakeTimers();
		const handlers = new Map<
			"playing" | "idle" | "error",
			Array<(error?: Error) => void>
		>();
		const played: unknown[] = [];
		const player = {
			play: vi.fn((resource: unknown) => played.push(resource)),
			stop: vi.fn(),
			on: vi.fn(
				(
					event: "playing" | "idle" | "error",
					callback: (error?: Error) => void,
				) => {
					handlers.set(event, [...(handlers.get(event) ?? []), callback]);
				},
			),
		};
		const emit = (event: "playing" | "idle" | "error") => {
			for (const callback of handlers.get(event) ?? []) callback();
		};
		const client = {
			user: { id: "voice-bot" },
			login: vi.fn(async () => {}),
			isReady: () => true,
			once: vi.fn(),
			destroy: vi.fn(async () => {}),
		};
		const room = createRoomIO({
			sessionId: "session-clips",
			generation: 9,
			roomKey: "guild:voice-channel",
			playbackTailMarginMs: 0,
			allowedClipPaths: ["/managed/earcon.mp3"],
			createVad: async () => ({
				score: async (_samples, state) => ({ probability: 0, next: state }),
				close: async () => {},
			}),
			deps: {
				createClient: () => client,
				joinVoice: vi.fn(async () => ({})),
				subscribeManual: () => vi.fn(() => new PassThrough()),
				createDecoder: () => new PassThrough(),
				createPlayer: () => player,
				createResource: (source) => source,
				speakingEvents: () => ({ on: vi.fn() }),
				receiveEvents: () => ({
					onTransition: () => () => {},
					onDiagnostic: () => () => {},
					isSpeaking: () => false,
				}),
				memberDisplayName: vi.fn(),
				userVoiceChannelId: vi.fn(async () => "voice-channel"),
				voiceChannelHumanCount: vi.fn(async () => 1),
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
			onError: vi.fn(),
		});
		await room.start();

		const first = room.playSpeech({
			speechId: "pcm-1",
			generation: 9,
			format: PCM24_MONO,
			pcm: Buffer.alloc(960, 1),
		});
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(20);
		await expect(first).resolves.toMatchObject({ outcome: "submitted" });

		const clip = room.playClip({
			speechId: "clip-1",
			generation: 9,
			source: { kind: "file", path: "/managed/earcon.mp3" },
			priority: "speech",
		});
		emit("playing");
		emit("idle");
		await expect(clip).resolves.toMatchObject({ outcome: "submitted" });

		const second = room.playSpeech({
			speechId: "pcm-2",
			generation: 9,
			format: PCM24_MONO,
			pcm: Buffer.alloc(960, 2),
		});
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(20);
		await expect(second).resolves.toMatchObject({ outcome: "submitted" });

		expect(played).toHaveLength(3);
		expect(played).toEqual([
			expect.objectContaining({ kind: "raw-stream" }),
			{ kind: "file", path: "/managed/earcon.mp3" },
			expect.objectContaining({ kind: "raw-stream" }),
		]);
		expect(player.stop).toHaveBeenCalled();
		await room.stop();
	});

	it("accepts supported PCM formats, rejects misaligned samples, and permits an empty final", async () => {
		vi.useFakeTimers();
		const test = roomFixture({ playbackTailMarginMs: 0 });
		await test.room.start();
		const cases: Array<{ format: AudioFormat; pcm: Buffer; marker: number }> = [
			{
				format: { encoding: "pcm16", sampleRateHz: 16_000, channels: 1 },
				pcm: Buffer.alloc(640, 1),
				marker: 1,
			},
			{ format: PCM24_MONO, pcm: Buffer.alloc(960, 2), marker: 2 },
			{
				format: { encoding: "pcm16", sampleRateHz: 48_000, channels: 2 },
				pcm: Buffer.alloc(3_840, 3),
				marker: 3,
			},
		];
		for (const [index, sample] of cases.entries()) {
			const speechId = `format-${index}`;
			expect(
				test.room.startSpeech({
					speechId,
					generation: test.generation,
					format: sample.format,
				}),
			).toMatchObject({ outcome: "accepted" });
			await expect(
				test.room.writeSpeech({
					speechId,
					generation: test.generation,
					sequence: 0,
					pcm: sample.pcm,
				}),
			).resolves.toMatchObject({ outcome: "submitted" });
			const ended = test.room.endSpeech(speechId, test.generation);
			await vi.advanceTimersByTimeAsync(20);
			await expect(ended).resolves.toMatchObject({ outcome: "submitted" });
		}
		expect(test.outputFrames).toHaveLength(3);
		expect(test.outputFrames.map((frame) => frame.readInt16LE(0))).toEqual([
			257, 514, 771,
		]);

		expect(
			test.room.startSpeech({
				speechId: "split-stereo",
				generation: test.generation,
				format: { encoding: "pcm16", sampleRateHz: 48_000, channels: 2 },
			}),
		).toMatchObject({ outcome: "accepted" });
		await expect(
			test.room.writeSpeech({
				speechId: "split-stereo",
				generation: test.generation,
				sequence: 0,
				pcm: Buffer.alloc(4, 4),
			}),
		).resolves.toMatchObject({ outcome: "submitted" });
		await expect(
			test.room.writeSpeech({
				speechId: "split-stereo",
				generation: test.generation,
				sequence: 1,
				pcm: Buffer.alloc(4, 4),
			}),
		).resolves.toMatchObject({ outcome: "submitted" });
		const splitEnded = test.room.endSpeech("split-stereo", test.generation);
		await vi.advanceTimersByTimeAsync(20);
		await expect(splitEnded).resolves.toMatchObject({ outcome: "submitted" });

		expect(
			test.room.startSpeech({
				speechId: "misaligned-stereo",
				generation: test.generation,
				format: { encoding: "pcm16", sampleRateHz: 48_000, channels: 2 },
			}),
		).toMatchObject({ outcome: "accepted" });
		await expect(
			test.room.writeSpeech({
				speechId: "misaligned-stereo",
				generation: test.generation,
				sequence: 0,
				pcm: Buffer.alloc(2),
			}),
		).resolves.toMatchObject({
			outcome: "rejected",
			reason: "speech_frame_invalid",
		});
		test.room.localPlaybackCancel("misaligned-stereo", test.generation);

		expect(
			test.room.startSpeech({
				speechId: "empty-final",
				generation: test.generation,
				format: PCM24_MONO,
			}),
		).toMatchObject({ outcome: "accepted" });
		await expect(
			test.room.endSpeech("empty-final", test.generation),
		).resolves.toMatchObject({ outcome: "submitted" });
		await test.room.stop();
	});

	it("physically cancels queued playback, rejects blocked writers and fences late frames", async () => {
		vi.useFakeTimers();
		const test = roomFixture({
			maxOutputQueueFrames: 1,
			playbackTailMarginMs: 100,
		});
		await test.room.start();
		expect(
			test.room.startSpeech({
				speechId: "cancel-me",
				generation: test.generation,
				format: PCM24_MONO,
			}),
		).toMatchObject({ outcome: "accepted" });
		await test.room.writeSpeech({
			speechId: "cancel-me",
			generation: test.generation,
			sequence: 0,
			pcm: Buffer.alloc(960, 1),
		});
		const blocked = test.room.writeSpeech({
			speechId: "cancel-me",
			generation: test.generation,
			sequence: 1,
			pcm: Buffer.alloc(960, 2),
		});
		await Promise.resolve();

		const stopsBefore = test.player.stop.mock.calls.length;
		test.room.localPlaybackCancel("cancel-me", test.generation);
		await expect(blocked).resolves.toMatchObject({
			outcome: "rejected",
			reason: "speech_playback_stopped",
		});
		expect(test.player.stop.mock.calls.length).toBeGreaterThan(stopsBefore);
		await expect(
			test.room.writeSpeech({
				speechId: "cancel-me",
				generation: test.generation,
				sequence: 2,
				pcm: Buffer.alloc(960, 3),
			}),
		).resolves.toMatchObject({
			outcome: "rejected",
			reason: "speech_not_started",
		});
		expect(test.room.audibleTail()).toMatchObject({
			estimated: true,
			drained: false,
		});
		await vi.advanceTimersByTimeAsync(100);
		expect(test.room.audibleTail().drained).toBe(true);
		await test.room.stop();
	});

	it("holds PCM writes behind a clip and fences cancel plus late Idle on the same player", async () => {
		vi.useFakeTimers();
		const test = roomFixture({
			maxOutputQueueFrames: 1,
			playbackTailMarginMs: 0,
		});
		await test.room.start();
		const clip = test.room.playClip({
			speechId: "clip-active",
			generation: test.generation,
			source: { kind: "file", path: "/managed/earcon.mp3" },
			priority: "speech",
		});
		test.emit("playing");
		expect(
			test.room.startSpeech({
				speechId: "pcm-after-clip",
				generation: test.generation,
				format: PCM24_MONO,
			}),
		).toMatchObject({ outcome: "accepted" });
		let writeSubmitted = false;
		const heldWrite = test.room
			.writeSpeech({
				speechId: "pcm-after-clip",
				generation: test.generation,
				sequence: 0,
				pcm: Buffer.alloc(960, 7),
			})
			.then((receipt) => {
				writeSubmitted = true;
				return receipt;
			});
		await Promise.resolve();
		expect(writeSubmitted).toBe(false);
		test.emit("idle");
		await expect(clip).resolves.toMatchObject({ outcome: "submitted" });
		await vi.advanceTimersByTimeAsync(20);
		await expect(heldWrite).resolves.toMatchObject({ outcome: "submitted" });
		const ended = test.room.endSpeech("pcm-after-clip", test.generation);
		await vi.advanceTimersByTimeAsync(20);
		await expect(ended).resolves.toMatchObject({ outcome: "submitted" });

		const cancelled = test.room.playClip({
			speechId: "clip-cancelled",
			generation: test.generation,
			source: { kind: "file", path: "/managed/filler.mp3" },
			priority: "speech",
		});
		test.emit("playing");
		test.room.localPlaybackCancel("clip-cancelled", test.generation);
		await expect(cancelled).resolves.toMatchObject({
			outcome: "rejected",
			reason: "speech_playback_stopped",
		});
		const resourcesAfterCancel = test.resources.length;
		test.emit("idle");
		expect(test.resources).toHaveLength(resourcesAfterCancel);
		await test.room.stop();
	});

	it("consumes PCM one, earcon, PCM two, filler, and PCM three on one player", async () => {
		vi.useFakeTimers();
		const test = roomFixture({ playbackTailMarginMs: 0 });
		await test.room.start();
		const playPcm = async (speechId: string, marker: number) => {
			const playback = test.room.playSpeech({
				speechId,
				generation: test.generation,
				format: PCM24_MONO,
				pcm: Buffer.alloc(960, marker),
			});
			await Promise.resolve();
			await vi.advanceTimersByTimeAsync(20);
			await expect(playback).resolves.toMatchObject({ outcome: "submitted" });
		};
		const playClip = async (speechId: string, path: string) => {
			const playback = test.room.playClip({
				speechId,
				generation: test.generation,
				source: { kind: "file", path },
				priority: "speech",
			});
			test.emit("playing");
			test.emit("idle");
			await expect(playback).resolves.toMatchObject({ outcome: "submitted" });
		};

		await playPcm("pcm-one", 1);
		await playClip("earcon", "/managed/earcon.mp3");
		await playPcm("pcm-two", 2);
		await playClip("filler", "/managed/filler.mp3");
		await playPcm("pcm-three", 3);

		expect(test.resources).toEqual([
			expect.objectContaining({ kind: "raw-stream" }),
			{ kind: "file", path: "/managed/earcon.mp3" },
			expect.objectContaining({ kind: "raw-stream" }),
			{ kind: "file", path: "/managed/filler.mp3" },
			expect.objectContaining({ kind: "raw-stream" }),
		]);
		expect(test.outputFrames.map((frame) => frame.readInt16LE(0))).toEqual([
			257, 514, 771,
		]);
		expect(test.player.play).toHaveBeenCalledTimes(5);
		await test.room.stop();
	});

	it("queues overlapping proactive and conversational sentences without silent loss", async () => {
		vi.useFakeTimers();
		const test = roomFixture({ playbackTailMarginMs: 0 });
		await test.room.start();

		const conversation = test.room.playSpeech({
			speechId: "conversation",
			generation: test.generation,
			format: PCM24_MONO,
			pcm: Buffer.alloc(960, 1),
		});
		const proactive = test.room.playSpeech({
			speechId: "proactive",
			generation: test.generation,
			format: PCM24_MONO,
			pcm: Buffer.alloc(960, 2),
		});

		await vi.advanceTimersByTimeAsync(40);
		await expect(conversation).resolves.toMatchObject({ outcome: "submitted" });
		await expect(proactive).resolves.toMatchObject({ outcome: "submitted" });
		expect(test.outputFrames.map((frame) => frame.readInt16LE(0))).toEqual([
			257, 514,
		]);
		await test.room.stop();
	});

	it("emits start, clock-driven sustained, and end barge observations from the input gate", async () => {
		vi.useFakeTimers();
		const events: RoomBargeInEvent[] = [];
		const test = roomFixture({
			vadProbability: 1,
		});
		const unsubscribe = test.room.onBargeIn((event) => events.push(event));
		await test.room.start();
		test.speak("start");
		test.opus.write(Buffer.alloc(3_840 * 14, 7));
		for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
		await vi.advanceTimersByTimeAsync(20);
		expect(events.map((event) => event.phase)).toEqual(["start", "sustained"]);
		expect(events[0]).toMatchObject({
			sessionId: "fixture-session",
			generation: test.generation,
			owner: {
				kind: "known",
				speakerUserId: "founder",
			},
		});
		test.speak("end");
		expect(events.at(-1)).toMatchObject({ phase: "end" });
		unsubscribe();
		await test.room.stop();
	});
});
