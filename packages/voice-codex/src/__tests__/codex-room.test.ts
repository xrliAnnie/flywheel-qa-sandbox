import {
	BackendRegistry,
	type BrainAdapter,
	type ConversationSession,
	type VoiceBackend,
} from "flywheel-voice-core";
import { describe, expect, it, vi } from "vitest";
import { WaitingMouth } from "../audio.js";
import {
	CodexRoomFrontend,
	registerCodexVoiceBackend,
} from "../codex/CodexRoomFrontend.js";
import { CodexVoiceBackend } from "../codex/CodexVoiceBackend.js";
import { CodexVoiceContainerError } from "../codex/CodexVoiceContainer.js";
import { GenericVoiceSession, type RoomHandlers } from "../session.js";

const brain: BrainAdapter = {
	async *respond() {
		yield "unused";
	},
};

function conversation(
	close = vi.fn(async () => undefined),
): ConversationSession {
	return {
		sessionId: "codex-session",
		sendAudio: vi.fn(),
		sendText: vi.fn(),
		injectContext: vi.fn(),
		endUserTurn: vi.fn(),
		interrupt: vi.fn(),
		injectToolResult: vi.fn(),
		on: vi.fn(() => () => undefined),
		close,
		speak: vi.fn(async (_text, _kind, opts) => ({
			outcome: "completed" as const,
			transport: "submitted" as const,
			contentProof: "transcript_equivalent" as const,
			pendingKey: opts.pendingKey,
			requestDigest: "d".repeat(64),
		})),
	};
}

function backend(
	createConversation: VoiceBackend["createConversation"],
): VoiceBackend {
	return {
		id: "codex-realtime",
		capabilities: {
			announce: false,
			converse: true,
			bargeIn: false,
			verbatim: true,
			attribution: false,
			toolCallScheduling: "none",
			transcriptGranularity: "final-only",
			supportsResume: false,
			voiceCloning: false,
			audioIn: [{ encoding: "pcm16", sampleRateHz: 24_000, channels: 1 }],
			audioOut: [{ encoding: "pcm16", sampleRateHz: 24_000, channels: 1 }],
		},
		createConversation,
	};
}

describe("Codex room composition", () => {
	it("maps the V2 transport into the shared session without claiming attribution", async () => {
		let callbacks!: Record<string, (...args: never[]) => void>;
		const appendAudio = vi.fn(() => "sent" as const);
		const appendSpeech = vi.fn(async () => undefined);
		const close = vi.fn(async () => undefined);
		const evidence = vi.fn();
		const container = {
			open: vi.fn(async (input: { realtime: typeof callbacks }) => {
				callbacks = input.realtime;
				return {
					transport: {
						appendAudio,
						appendSpeech,
						appendText: vi.fn(async () => undefined),
						cancel: vi.fn(async () => undefined),
					},
					close,
				};
			}),
		};
		const played = vi.fn(async () => undefined);
		const persisted = vi.fn(async () => undefined);
		const actual = new CodexVoiceBackend({
			sessionId: "session-v2",
			voice: "marin",
			container,
			loadContext: vi.fn(),
			playAudio: played,
			persistUtterance: persisted,
			onEvidence: evidence,
		});
		expect(actual.capabilities).toMatchObject({
			converse: true,
			bargeIn: false,
			verbatim: false,
			attribution: false,
		});
		const session = await actual.createConversation({ brain });
		const utterances: unknown[] = [];
		session.on("utterance", (value) => utterances.push(value));
		session.sendAudio(Buffer.alloc(480), {
			encoding: "pcm16",
			sampleRateHz: 24_000,
			channels: 1,
		});
		expect(appendAudio).toHaveBeenCalledWith(expect.any(Buffer), 1, {
			ownerUserId: null,
			utteranceId: null,
		});
		const speechReceipt = session.speak!("你好", "readback", {
			pendingKey: "speech-1",
			verification: "required",
		});
		expect(appendSpeech).toHaveBeenCalledWith("你好", 1);

		callbacks.onItem({
			generation: 1,
			itemId: "assistant-1",
			role: "assistant",
			raw: {},
		} as never);
		callbacks.onAudio({
			generation: 1,
			itemId: "assistant-1",
			pcm24Mono: Buffer.alloc(960),
			sampleRate: 24_000,
			numChannels: 1,
			samplesPerChannel: 480,
			raw: {},
		} as never);
		callbacks.onTranscript({
			generation: 1,
			itemId: "assistant-1",
			association: "preceding_item",
			role: "assistant",
			text: "你好",
			final: true,
			raw: {},
		} as never);
		await vi.waitFor(() => expect(played).toHaveBeenCalledOnce());
		await expect(speechReceipt).resolves.toMatchObject({
			outcome: "completed",
			transport: "submitted",
			contentProof: "transcript_equivalent",
		});
		expect(evidence).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "codex_speak_receipt",
				pendingKey: "speech-1",
				outcome: "completed",
				contentProof: "transcript_equivalent",
			}),
		);
		expect(played).toHaveBeenCalledWith(
			expect.objectContaining({ itemId: "assistant-1" }),
		);
		expect(utterances).toEqual([
			expect.objectContaining({
				role: "assistant",
				text: "你好",
				attribution: { kind: "unknown", reason: "engine_output" },
			}),
		]);
		await session.close();
		expect(persisted).toHaveBeenCalledWith(
			expect.objectContaining({
				attribution: { kind: "unknown", reason: "engine_output" },
			}),
			expect.stringMatching(/^[a-f0-9]{64}$/),
		);
		expect(close).toHaveBeenCalledOnce();
	});

	it("records backpressure as a gap without ending the room session", async () => {
		const appendAudio = vi
			.fn()
			.mockReturnValueOnce("dropped:backpressure" as const)
			.mockReturnValue("sent" as const);
		const evidence = vi.fn();
		const actual = new CodexVoiceBackend({
			sessionId: "session-backpressure",
			voice: "marin",
			container: {
				open: vi.fn(async () => ({
					generation: 1,
					transport: {
						appendAudio,
						appendSpeech: vi.fn(async () => undefined),
						appendText: vi.fn(async () => undefined),
						cancel: vi.fn(async () => undefined),
					},
					restart: vi.fn(async () => 2),
					close: vi.fn(async () => undefined),
				})),
			},
			loadContext: vi.fn(),
			onEvidence: evidence,
		});
		const session = await actual.createConversation({ brain });
		const errors: Error[] = [];
		session.on("error", (error) => errors.push(error));

		session.sendAudio(Buffer.alloc(960), {
			encoding: "pcm16",
			sampleRateHz: 24_000,
			channels: 1,
		});
		session.sendAudio(Buffer.alloc(960), {
			encoding: "pcm16",
			sampleRateHz: 24_000,
			channels: 1,
		});

		expect(appendAudio).toHaveBeenCalledTimes(2);
		expect(errors).toEqual([]);
	});

	it("restarts after interrupt, replays queued founder audio, and can speak on the new generation", async () => {
		let callbacks!: Record<string, (...args: never[]) => void>;
		let generation = 1;
		const firstTransport = {
			appendAudio: vi.fn(() => "sent" as const),
			appendSpeech: vi.fn(async () => undefined),
			appendText: vi.fn(async () => undefined),
			cancel: vi.fn(async () => undefined),
		};
		const secondTransport = {
			appendAudio: vi.fn(() => "sent" as const),
			appendSpeech: vi.fn(async () => undefined),
			appendText: vi.fn(async () => undefined),
			cancel: vi.fn(async () => undefined),
		};
		let transport = firstTransport;
		const conversation = {
			get generation() {
				return generation;
			},
			get transport() {
				return transport;
			},
			restart: vi.fn(async () => {
				await firstTransport.cancel();
				generation = 2;
				transport = secondTransport;
				return generation;
			}),
			close: vi.fn(async () => undefined),
		};
		const played = vi.fn(async () => undefined);
		const actual = new CodexVoiceBackend({
			sessionId: "session-interrupt",
			voice: "marin",
			container: {
				open: vi.fn(async (input: { realtime: typeof callbacks }) => {
					callbacks = input.realtime;
					return conversation;
				}),
			},
			loadContext: vi.fn(),
			playAudio: played,
		});
		const session = await actual.createConversation({ brain });
		const owned = session as ConversationSession & {
			sendOwnedAudio(
				frame: Buffer,
				owner: {
					utteranceId: string | null;
					ownerUserId: string | null;
					ownerName?: string | null;
				},
			): void;
		};

		session.interrupt();
		owned.sendOwnedAudio(Buffer.alloc(960), {
			utteranceId: "founder-turn",
			ownerUserId: "founder",
			ownerName: "Annie",
		});
		await vi.waitFor(() => expect(conversation.restart).toHaveBeenCalledOnce());
		await vi.waitFor(() =>
			expect(secondTransport.appendAudio).toHaveBeenCalledWith(
				expect.any(Buffer),
				2,
				{
					utteranceId: "founder-turn",
					ownerUserId: "founder",
					ownerName: "Annie",
				},
			),
		);

		const receipt = session.speak!("继续", "readback", {
			pendingKey: "after-interrupt",
			verification: "required",
		});
		await vi.waitFor(() =>
			expect(secondTransport.appendSpeech).toHaveBeenCalledWith("继续", 2),
		);
		callbacks.onItem({
			generation: 2,
			itemId: "assistant-2",
			role: "assistant",
			raw: {},
		} as never);
		callbacks.onAudio({
			generation: 2,
			itemId: "assistant-2",
			pcm24Mono: Buffer.alloc(960),
			sampleRate: 24_000,
			numChannels: 1,
			samplesPerChannel: 480,
			raw: {},
		} as never);
		callbacks.onTranscript({
			generation: 2,
			itemId: "assistant-2",
			association: "preceding_item",
			role: "assistant",
			text: "继续",
			final: true,
			raw: {},
		} as never);
		await expect(receipt).resolves.toMatchObject({ outcome: "completed" });
	});

	it("queues consecutive assistant sentences without ending the conversation", async () => {
		let callbacks!: Record<string, (...args: never[]) => void>;
		let tick!: () => void;
		const renderedFrames: Buffer[] = [];
		const mouth = new WaitingMouth({
			player: { play: vi.fn(), stop: vi.fn() },
			createResource: (source) => {
				source.stream.on("data", (frame: Buffer) => renderedFrames.push(frame));
				return source;
			},
			setIntervalFn: (callback) => {
				tick = callback;
				return 1 as unknown as NodeJS.Timeout;
			},
			clearIntervalFn: vi.fn(),
		});
		mouth.start();
		const playbacks: Promise<void>[] = [];
		const actual = new CodexVoiceBackend({
			sessionId: "session-consecutive-output",
			voice: "marin",
			container: {
				open: vi.fn(async (input: { realtime: typeof callbacks }) => {
					callbacks = input.realtime;
					return {
						generation: 1,
						transport: {
							appendAudio: vi.fn(() => "sent" as const),
							appendSpeech: vi.fn(async () => undefined),
							appendText: vi.fn(async () => undefined),
							cancel: vi.fn(async () => undefined),
						},
						restart: vi.fn(async () => 2),
						close: vi.fn(async () => undefined),
					};
				}),
			},
			loadContext: vi.fn(),
			playAudio: ({ itemId, pcm24Mono }) => {
				const playback = mouth.playSpeech(itemId, pcm24Mono);
				playbacks.push(playback);
				return playback;
			},
		});
		const conversation = await actual.createConversation({ brain });
		const errors: Error[] = [];
		conversation.on("error", (error) => errors.push(error));
		const completed: string[] = [];
		const emitSentence = (itemId: string, sample: number) => {
			callbacks.onItem({
				generation: 1,
				itemId,
				role: "assistant",
				raw: {},
			} as never);
			const pcm24Mono = Buffer.alloc(960);
			for (let offset = 0; offset < pcm24Mono.length; offset += 2) {
				pcm24Mono.writeInt16LE(sample, offset);
			}
			callbacks.onAudio({
				generation: 1,
				itemId,
				pcm24Mono,
				sampleRate: 24_000,
				numChannels: 1,
				samplesPerChannel: 480,
				raw: {},
			} as never);
			callbacks.onTranscript({
				generation: 1,
				itemId,
				association: "preceding_item",
				role: "assistant",
				text: itemId,
				final: true,
				raw: {},
			} as never);
		};

		emitSentence("assistant-first", 111);
		emitSentence("assistant-second", 222);
		await vi.waitFor(() => expect(playbacks).toHaveLength(2));
		playbacks.forEach((playback, index) => {
			void playback.then(
				() =>
					completed.push(index === 0 ? "assistant-first" : "assistant-second"),
				() => undefined,
			);
		});

		tick();
		await playbacks[0];
		expect(completed).toEqual(["assistant-first"]);
		expect(errors).toEqual([]);
		expect(renderedFrames.map((frame) => frame.readInt16LE(0))).toEqual([111]);

		tick();
		await expect(playbacks[1]).resolves.toBeUndefined();
		expect(completed).toEqual(["assistant-first", "assistant-second"]);
		expect(errors).toEqual([]);
		expect(renderedFrames.map((frame) => frame.readInt16LE(0))).toEqual([
			111, 222,
		]);
		await conversation.close();
		mouth.stop();
	});

	it("stops real queued playback on founder barge-in and continues on the next generation", async () => {
		let callbacks!: Record<string, (...args: never[]) => void>;
		let roomHandlers!: RoomHandlers;
		let finishRestart!: () => void;
		const restartPending = new Promise<void>((resolve) => {
			finishRestart = resolve;
		});
		let generation = 1;
		const firstTransport = {
			appendAudio: vi.fn(() => "sent" as const),
			appendSpeech: vi.fn(async () => undefined),
			appendText: vi.fn(async () => undefined),
			cancel: vi.fn(async () => undefined),
		};
		const secondTransport = {
			appendAudio: vi.fn(() => "sent" as const),
			appendSpeech: vi.fn(async () => undefined),
			appendText: vi.fn(async () => undefined),
			cancel: vi.fn(async () => undefined),
		};
		let transport = firstTransport;
		const conversation = {
			get generation() {
				return generation;
			},
			get transport() {
				return transport;
			},
			restart: vi.fn(async () => {
				await restartPending;
				generation = 2;
				transport = secondTransport;
				return generation;
			}),
			close: vi.fn(async () => undefined),
		};
		let tick!: () => void;
		const renderedFrames: Buffer[] = [];
		const mouth = new WaitingMouth({
			player: { play: vi.fn(), stop: vi.fn() },
			createResource: (source) => {
				source.stream.on("data", (frame: Buffer) => renderedFrames.push(frame));
				return source;
			},
			setIntervalFn: (callback) => {
				tick = callback;
				return 1 as unknown as NodeJS.Timeout;
			},
			clearIntervalFn: vi.fn(),
		});
		mouth.start();
		const playbacks: Promise<void>[] = [];
		const actual = new CodexVoiceBackend({
			sessionId: "session-local-barge-in",
			voice: "marin",
			container: {
				open: vi.fn(async (input: { realtime: typeof callbacks }) => {
					callbacks = input.realtime;
					return conversation;
				}),
			},
			loadContext: vi.fn(),
			playAudio: ({ itemId, pcm24Mono }) => {
				const playback = mouth.playSpeech(itemId, pcm24Mono);
				playbacks.push(playback);
				return playback;
			},
		});
		const room = {
			start: vi.fn(async () => ({ founderPresent: true })),
			playSpeech: (speechId: string, pcm24Mono: Buffer) =>
				mouth.playSpeech(speechId, pcm24Mono),
			cancelSpeech: (speechId: string) => mouth.cancelSpeech(speechId),
			cancelAllSpeech: () => mouth.cancelAllSpeech(),
			status: vi.fn(async () => undefined),
			stop: vi.fn(async () => mouth.stop()),
			setWaiting: vi.fn(),
			setBedEnabled: vi.fn(),
		};
		let ended: unknown;
		const session = new GenericVoiceSession({
			projection: {
				sessionId: "11111111-1111-4111-8111-111111111111",
				voiceBotUserId: "323456789012345678",
				mode: "meeting",
				projectName: "raya",
				leadId: "raya",
				displayName: "Raya",
				realtimeVoice: "marin",
				guildId: "guild",
				voiceChannelId: "voice",
				threadId: "thread",
				boundChannelIds: ["thread"],
				founderUserId: "founder",
				qaAllowUserIds: [],
			},
			delivery: { capture: vi.fn(async () => false) },
			createFrontend: (handlers) =>
				new CodexRoomFrontend({
					backend: actual,
					conversationOptions: { brain },
					handlers,
					onUnavailable: vi.fn(),
				}),
			createRoom: (handlers) => {
				roomHandlers = handlers;
				return room;
			},
			lifecycle: vi.fn(),
			evidence: vi.fn(),
			confirmationMs: 100,
		});
		void session.waitForEnd().then((outcome) => {
			ended = outcome;
		});
		await session.start();
		await session.markLive();

		callbacks.onItem({
			generation: 1,
			itemId: "assistant-before-barge-in",
			role: "assistant",
			raw: {},
		} as never);
		callbacks.onAudio({
			generation: 1,
			itemId: "assistant-before-barge-in",
			pcm24Mono: Buffer.alloc(4_800, 1),
			sampleRate: 24_000,
			numChannels: 1,
			samplesPerChannel: 2_400,
			raw: {},
		} as never);
		callbacks.onTranscript({
			generation: 1,
			itemId: "assistant-before-barge-in",
			association: "preceding_item",
			role: "assistant",
			text: "这句必须立刻停。",
			final: true,
			raw: {},
		} as never);
		callbacks.onItem({
			generation: 1,
			itemId: "assistant-queued-before-barge-in",
			role: "assistant",
			raw: {},
		} as never);
		callbacks.onAudio({
			generation: 1,
			itemId: "assistant-queued-before-barge-in",
			pcm24Mono: Buffer.alloc(960, 3),
			sampleRate: 24_000,
			numChannels: 1,
			samplesPerChannel: 480,
			raw: {},
		} as never);
		callbacks.onTranscript({
			generation: 1,
			itemId: "assistant-queued-before-barge-in",
			association: "preceding_item",
			role: "assistant",
			text: "这句也必须一起停。",
			final: true,
			raw: {},
		} as never);
		await vi.waitFor(() => expect(playbacks).toHaveLength(2));
		tick();
		expect(renderedFrames).toHaveLength(1);

		const cancellationReasons: string[] = [];
		playbacks.slice(0, 2).forEach((playback) => {
			void playback.catch((error: Error) => {
				cancellationReasons.push(error.message);
			});
		});
		roomHandlers.onAudio(Buffer.alloc(960), {
			utteranceId: "founder-interrupt",
			ownerUserId: "founder",
			ownerName: "Annie",
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(cancellationReasons).toEqual([
			"speech_playback_stopped",
			"speech_playback_stopped",
		]);
		const framesAtCancel = renderedFrames.length;
		tick();
		tick();
		expect(
			renderedFrames
				.slice(framesAtCancel)
				.every((frame) => frame.every((byte) => byte === 0)),
		).toBe(true);

		finishRestart();
		await vi.waitFor(() =>
			expect(secondTransport.appendAudio).toHaveBeenCalledWith(
				expect.any(Buffer),
				2,
				expect.objectContaining({ utteranceId: "founder-interrupt" }),
			),
		);
		callbacks.onItem({
			generation: 2,
			itemId: "assistant-after-barge-in",
			role: "assistant",
			raw: {},
		} as never);
		callbacks.onAudio({
			generation: 2,
			itemId: "assistant-after-barge-in",
			pcm24Mono: Buffer.alloc(960, 2),
			sampleRate: 24_000,
			numChannels: 1,
			samplesPerChannel: 480,
			raw: {},
		} as never);
		callbacks.onTranscript({
			generation: 2,
			itemId: "assistant-after-barge-in",
			association: "preceding_item",
			role: "assistant",
			text: "可以继续说。",
			final: true,
			raw: {},
		} as never);
		await vi.waitFor(() => expect(playbacks).toHaveLength(3));
		tick();
		await expect(playbacks[2]).resolves.toBeUndefined();
		await Promise.resolve();
		expect(ended).toBeUndefined();
		await session.stop({ kind: "ended", reason: "test-complete" });
	});

	it("invalidates attribution when restart buffering drops founder audio", async () => {
		let callbacks!: Record<string, (...args: never[]) => void>;
		let finishRestart!: (generation: number) => void;
		const restartPending = new Promise<number>((resolve) => {
			finishRestart = resolve;
		});
		const secondTransport = {
			appendAudio: vi.fn(() => "sent" as const),
			appendSpeech: vi.fn(async () => undefined),
			appendText: vi.fn(async () => undefined),
			cancel: vi.fn(async () => undefined),
			invalidateInputOwnership: vi.fn(),
		};
		let transport = {
			appendAudio: vi.fn(() => "sent" as const),
			appendSpeech: vi.fn(async () => undefined),
			appendText: vi.fn(async () => undefined),
			cancel: vi.fn(async () => undefined),
			invalidateInputOwnership: vi.fn(),
		};
		const evidence = vi.fn();
		const conversation = {
			generation: 1,
			get transport() {
				return transport;
			},
			restart: vi.fn(async () => {
				const generation = await restartPending;
				conversation.generation = generation;
				transport = secondTransport;
				return generation;
			}),
			close: vi.fn(async () => undefined),
		};
		const actual = new CodexVoiceBackend({
			sessionId: "session-restart-gap",
			voice: "marin",
			container: {
				open: vi.fn(async (input: { realtime: typeof callbacks }) => {
					callbacks = input.realtime;
					return conversation;
				}),
			},
			loadContext: vi.fn(),
			onEvidence: evidence,
		});
		const session = await actual.createConversation({ brain });
		const owned = session as ConversationSession & {
			sendOwnedAudio(
				frame: Buffer,
				owner: {
					utteranceId: string | null;
					ownerUserId: string | null;
					ownerName?: string | null;
				},
			): void;
		};
		const owner = {
			utteranceId: "founder-overflow",
			ownerUserId: "founder",
			ownerName: "Annie",
		};

		session.interrupt();
		for (let index = 0; index < 51; index += 1) {
			owned.sendOwnedAudio(Buffer.alloc(960), owner);
		}
		expect(evidence).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "codex_input_gap",
				reason: "restart_backpressure",
			}),
		);

		finishRestart(2);
		await vi.waitFor(() =>
			expect(secondTransport.appendAudio).toHaveBeenCalled(),
		);
		expect(secondTransport.invalidateInputOwnership).toHaveBeenCalledOnce();
		expect(
			secondTransport.invalidateInputOwnership.mock.invocationCallOrder[0],
		).toBeLessThan(secondTransport.appendAudio.mock.invocationCallOrder[0]!);
	});

	it("turns a continuously owned user item into known attribution", async () => {
		let callbacks!: Record<string, (...args: never[]) => void>;
		const actual = new CodexVoiceBackend({
			sessionId: "session-owner",
			voice: "marin",
			container: {
				open: vi.fn(async (input: { realtime: typeof callbacks }) => {
					callbacks = input.realtime;
					return {
						generation: 1,
						transport: {
							appendAudio: vi.fn(() => "sent" as const),
							appendSpeech: vi.fn(async () => undefined),
							appendText: vi.fn(async () => undefined),
							cancel: vi.fn(async () => undefined),
						},
						restart: vi.fn(async () => 2),
						close: vi.fn(async () => undefined),
					};
				}),
			},
			loadContext: vi.fn(),
		});
		const session = await actual.createConversation({ brain });
		const utterances: unknown[] = [];
		session.on("utterance", (utterance) => utterances.push(utterance));
		callbacks.onTranscript({
			generation: 1,
			itemId: "user-1",
			association: "preceding_item",
			role: "user",
			text: "请交给本体",
			final: true,
			inputOwner: {
				utteranceId: "room-utterance-1",
				ownerUserId: "founder",
				ownerName: "Annie",
			},
			raw: {},
		} as never);

		expect(utterances).toEqual([
			expect.objectContaining({
				utteranceId: "room-utterance-1",
				attribution: { kind: "known", speakerUserId: "founder" },
			}),
		]);
	});

	it("registers Codex only at the composition root", async () => {
		const registry = new BackendRegistry();
		expect(registry.has("codex-realtime")).toBe(false);
		registerCodexVoiceBackend(registry, () =>
			backend(async () => conversation()),
		);
		expect(registry.ids()).toEqual(["codex-realtime"]);
		expect((await registry.create("codex-realtime")).id).toBe("codex-realtime");
	});

	it("still closes the ephemeral container when Bridge transcript durability fails", async () => {
		let callbacks!: Record<string, (...args: never[]) => void>;
		const close = vi.fn(async () => undefined);
		const evidence = vi.fn();
		const actual = new CodexVoiceBackend({
			sessionId: "session-durability",
			voice: "marin",
			container: {
				open: vi.fn(async (input: { realtime: typeof callbacks }) => {
					callbacks = input.realtime;
					return {
						transport: {
							appendAudio: vi.fn(() => "sent" as const),
							appendSpeech: vi.fn(async () => undefined),
							appendText: vi.fn(async () => undefined),
							cancel: vi.fn(async () => undefined),
						},
						close,
					};
				}),
			},
			loadContext: vi.fn(),
			persistUtterance: vi.fn(async () => {
				throw new Error("bridge_down");
			}),
			onEvidence: evidence,
		});
		const session = await actual.createConversation({ brain });
		const errors: Error[] = [];
		session.on("error", (error) => errors.push(error));
		callbacks.onTranscript({
			generation: 1,
			itemId: "user-1",
			association: "preceding_item",
			role: "user",
			text: "需要交给本体",
			final: true,
			raw: {},
		} as never);

		await session.close();
		expect(close).toHaveBeenCalledOnce();
		expect(evidence).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "codex_bridge_utterance_write_failed",
				reason: "bridge_down",
			}),
		);
		expect(errors).toHaveLength(1);
	});

	it("closes the ephemeral conversation before a room leave finishes", async () => {
		const close = vi.fn(async () => undefined);
		const roomStop = vi.fn(async () => undefined);
		let roomHandlers!: {
			onFounderPresence(present: boolean): void;
		};
		const frontend = new CodexRoomFrontend({
			backend: backend(async () => conversation(close)),
			conversationOptions: { brain },
			onUnavailable: vi.fn(),
		});
		const session = new GenericVoiceSession({
			projection: {
				sessionId: "session-a",
				mode: "meeting",
				projectName: "flywheel",
				leadId: "raya",
				displayName: "Raya",
				realtimeVoice: "marin",
				guildId: "1",
				voiceChannelId: "2",
				voiceBotUserId: "3",
				threadId: "4",
				boundChannelIds: [],
				founderUserId: "founder",
				qaAllowUserIds: [],
			},
			delivery: { capture: vi.fn(async () => false) },
			createFrontend: () => frontend,
			createRoom: (handlers) => {
				roomHandlers = handlers;
				return {
					start: async () => ({ founderPresent: true }),
					playSpeech: async () => undefined,
					status: async () => undefined,
					stop: roomStop,
				};
			},
			lifecycle: vi.fn(),
			evidence: vi.fn(),
			confirmationMs: 100,
		});
		await session.start();
		await session.markLive();
		roomHandlers.onFounderPresence(false);
		expect(await session.waitForEnd()).toEqual({
			kind: "ended",
			reason: "she-left",
		});
		await session.stop({ kind: "ended", reason: "she-left" });
		expect(close).toHaveBeenCalledOnce();
		expect(roomStop).toHaveBeenCalledOnce();
		expect(close.mock.invocationCallOrder[0]).toBeLessThan(
			roomStop.mock.invocationCallOrder[0]!,
		);
	});

	it.each([
		["codex_quota_exhausted", "额度"],
		["codex_auth_rejected", "认证"],
	] as const)(
		"surfaces %s as unavailable without fallback",
		async (reason, copy) => {
			const unavailable = vi.fn();
			const create = vi.fn(async () => {
				throw new CodexVoiceContainerError(reason);
			});
			const frontend = new CodexRoomFrontend({
				backend: backend(create),
				conversationOptions: { brain },
				onUnavailable: unavailable,
			});
			await expect(frontend.start()).rejects.toThrow("voice_unavailable");
			expect(create).toHaveBeenCalledOnce();
			expect(unavailable).toHaveBeenCalledWith(
				expect.stringContaining("语音不可用"),
			);
			expect(unavailable).toHaveBeenCalledWith(expect.stringContaining(copy));
		},
	);
});
