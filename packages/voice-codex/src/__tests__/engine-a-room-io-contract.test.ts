import { PassThrough } from "node:stream";
import { createRoomIO } from "flywheel-voice-bridge";
import {
	CompositeSpeech,
	type ConversationEventMap,
	type OpenAiLiveConversationSession,
	type OpenAiLiveTranscriptDelta,
	type SpeakReceipt,
	type StreamingTtsEngine,
} from "flywheel-voice-core";
import { describe, expect, it, vi } from "vitest";
import { LiveLeadAdapter } from "../live-lead-adapter.js";

const PCM = { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 } as const;

function realRoom() {
	const outputFrames: Buffer[] = [];
	const bargeListeners = new Set<
		Parameters<ReturnType<typeof createRoomIO>["onBargeIn"]>[0]
	>();
	const handlers = new Map<string, Array<(error?: Error) => void>>();
	const player = {
		play: vi.fn(),
		stop: vi.fn(),
		on: vi.fn((event: string, callback: (error?: Error) => void) => {
			handlers.set(event, [...(handlers.get(event) ?? []), callback]);
		}),
	};
	const client = {
		user: { id: "voice-bot" },
		login: vi.fn(async () => undefined),
		isReady: () => true,
		once: vi.fn(),
		destroy: vi.fn(async () => undefined),
	};
	const room = createRoomIO({
		sessionId: "voice-session",
		generation: 9,
		roomKey: "guild:voice-channel",
		createVad: async () => ({
			score: async (_samples, state) => ({ probability: 0, next: state }),
			close: async () => undefined,
		}),
		deps: {
			createClient: () => client,
			joinVoice: vi.fn(async () => ({})),
			subscribeManual: () => vi.fn(() => new PassThrough()),
			createDecoder: () => new PassThrough(),
			createPlayer: () => player,
			createResource: (source) => {
				if (source.kind === "raw-stream")
					source.stream.on("data", (chunk: Buffer) =>
						outputFrames.push(Buffer.from(chunk)),
					);
				return source;
			},
			speakingEvents: () => ({ on: vi.fn() }),
			receiveEvents: () => ({
				onTransition: () => () => undefined,
				onDiagnostic: () => () => undefined,
				isSpeaking: () => false,
			}),
			memberDisplayName: vi.fn(async () => "Founder"),
			userVoiceChannelId: vi.fn(async () => "voice-channel"),
			voiceChannelHumanCount: vi.fn(async () => 1),
			onVoiceStateUpdate: () => () => undefined,
			sendMessage: vi.fn(async () => undefined),
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
	vi.spyOn(room, "onBargeIn").mockImplementation((listener) => {
		bargeListeners.add(listener);
		return () => bargeListeners.delete(listener);
	});
	return {
		room,
		outputFrames,
		emitBarge(
			event: Parameters<(typeof room)["onBargeIn"]>[0] extends (
				value: infer Event,
			) => void
				? Event
				: never,
		) {
			for (const listener of bargeListeners) listener(event);
		},
	};
}

class FakeLive implements OpenAiLiveConversationSession {
	readonly sessionId = "provider-session";
	readonly effectiveCapabilities = {
		verbatim: false,
		attribution: false,
		turnCancelOrSuppress: true,
	};
	providerGeneration = 1;
	private readonly handlers = new Map<string, Set<(...args: any[]) => void>>();

	sendAudio(): void {}
	sendText(): void {}
	injectContext(): void {}
	endUserTurn(): void {}
	injectToolResult(): void {}
	interrupt(): void {}
	async replaceAfterBargeIn(): Promise<number> {
		return ++this.providerGeneration;
	}
	async suspend(reason: "announcer-takeover" | "delegation-sealed") {
		return {
			generation: this.providerGeneration,
			reason,
			finalization: "provider_connection_closed" as const,
		};
	}
	async resume(): Promise<number> {
		return ++this.providerGeneration;
	}
	async close(): Promise<void> {}
	on<E extends keyof ConversationEventMap>(
		event: E,
		handler: (...args: ConversationEventMap[E]) => void,
	): () => void {
		const handlers = this.handlers.get(event) ?? new Set();
		handlers.add(handler as (...args: any[]) => void);
		this.handlers.set(event, handlers);
		return () => handlers.delete(handler as (...args: any[]) => void);
	}
	onLiveTranscript(
		_listener: (delta: OpenAiLiveTranscriptDelta) => void,
	): () => void {
		return () => undefined;
	}
	emit(event: string, ...args: any[]): void {
		for (const handler of this.handlers.get(event) ?? []) handler(...args);
	}
}

describe("Engine A producers against the real RoomIO sequence contract", () => {
	it("streams CompositeSpeech from sequence zero while the real guard rejects one", async () => {
		const fixture = realRoom();
		await fixture.room.start();
		try {
			const rejectedId = "negative-control";
			expect(
				fixture.room.startSpeech({
					speechId: rejectedId,
					generation: 9,
					format: PCM,
				}),
			).toMatchObject({ outcome: "accepted" });
			await expect(
				fixture.room.writeSpeech({
					speechId: rejectedId,
					generation: 9,
					sequence: 1,
					pcm: Buffer.from([1, 0]),
				}),
			).resolves.toMatchObject({
				outcome: "rejected",
				reason: "speech_sequence_invalid",
			});
			fixture.room.localPlaybackCancel(rejectedId, 9);

			const tts: StreamingTtsEngine = {
				synthesize: vi.fn(),
				async *synthesizeStream() {
					yield { audio: Buffer.from([1, 0]), format: PCM };
					yield { audio: Buffer.from([2, 0]), format: PCM };
				},
			};
			const speech = new CompositeSpeech({
				sessionId: "voice-session",
				generation: 9,
				room: fixture.room,
				tts,
				voice: "voice-1",
				beforeSpeak: vi.fn(async () => undefined),
			});

			await expect(
				speech.speak("Lead reply", "readback", {
					pendingKey: "lead-result-1",
					verification: "required",
				}),
			).resolves.toMatchObject({ outcome: "completed" });
			expect(fixture.outputFrames.length).toBeGreaterThan(0);
		} finally {
			await fixture.room.stop();
		}
	});

	it("streams LiveLeadAdapter frontend audio through the real RoomIO guard", async () => {
		const fixture = realRoom();
		await fixture.room.start();
		const endSpeech = vi.spyOn(fixture.room, "endSpeech");
		const live = new FakeLive();
		const record = vi.fn();
		const speech = {
			speak: vi.fn(
				async (
					_text: string,
					_kind: string,
					opts: { pendingKey: string },
				): Promise<SpeakReceipt> => ({
					pendingKey: opts.pendingKey,
					requestDigest: "speech-digest",
					outcome: "completed",
					transport: "submitted",
					contentProof: "deterministic_tts",
				}),
			),
			cancel: vi.fn(),
		};
		const adapter = new LiveLeadAdapter({
			sessionId: "voice-session",
			generation: 9,
			projectName: "flywheel",
			founderUserId: "founder",
			targetLeadId: "flywheel-eng-lead",
			room: fixture.room,
			createConversation: vi.fn(async () => live),
			transcriptSink: {
				append: vi.fn(),
				appendDurable: vi.fn(),
				readReceipt: vi.fn(),
			},
			speech,
			classifyIntent: () => "query",
			submitHandoff: vi.fn(),
			registerHandoff: vi.fn(),
			frontendAudioIdleMs: 10,
			record,
		});
		try {
			await adapter.open("context");
			live.emit("response-started");
			live.emit("response-audio", Buffer.from([1, 0]), PCM);
			live.emit("response-audio", Buffer.from([2, 0]), PCM);

			await vi.waitFor(() =>
				expect(fixture.outputFrames.length).toBeGreaterThan(0),
			);
			await vi.waitFor(() => expect(endSpeech).toHaveBeenCalledOnce());
			expect(fixture.room.audibleTail().drained).toBe(false);
			const firstBurstFrames = fixture.outputFrames.length;
			live.emit("response-audio", Buffer.from([3, 0]), PCM);
			await vi.waitFor(() =>
				expect(fixture.outputFrames.length).toBeGreaterThan(firstBurstFrames),
			);
			await vi.waitFor(() => expect(endSpeech).toHaveBeenCalledTimes(2));
			expect(record).not.toHaveBeenCalledWith(
				expect.objectContaining({
					kind: "live_frontend_output_failed",
					message: "speech_sequence_invalid",
				}),
			);
		} finally {
			await adapter.close();
			await fixture.room.stop();
		}
	});

	it("cancels a real RoomIO frontend tail when barge-in follows the idle boundary", async () => {
		const fixture = realRoom();
		await fixture.room.start();
		const endSpeech = vi.spyOn(fixture.room, "endSpeech");
		const localPlaybackCancel = vi.spyOn(fixture.room, "localPlaybackCancel");
		const live = new FakeLive();
		const adapter = new LiveLeadAdapter({
			sessionId: "voice-session",
			generation: 9,
			projectName: "flywheel",
			founderUserId: "founder",
			targetLeadId: "flywheel-eng-lead",
			room: fixture.room,
			createConversation: vi.fn(async () => live),
			transcriptSink: {
				append: vi.fn(),
				appendDurable: vi.fn(),
				readReceipt: vi.fn(),
			},
			speech: { speak: vi.fn(), cancel: vi.fn() },
			classifyIntent: () => "query",
			submitHandoff: vi.fn(),
			registerHandoff: vi.fn(),
			frontendAudioIdleMs: 10,
			record: vi.fn(),
		});
		try {
			await adapter.open("context");
			live.emit("response-started");
			live.emit("response-audio", Buffer.alloc(48_000, 1), PCM);
			await vi.waitFor(() => expect(endSpeech).toHaveBeenCalledOnce());
			expect(fixture.room.audibleTail().drained).toBe(false);
			const speechId = endSpeech.mock.calls[0]![0];
			fixture.emitBarge({
				sessionId: "voice-session",
				generation: 9,
				utteranceId: "founder-interrupt",
				owner: { kind: "known", speakerUserId: "founder" },
				startedAt: 1,
				observedAt: 2,
				durationMs: 1,
				phase: "sustained",
			});
			await vi.waitFor(() =>
				expect(localPlaybackCancel).toHaveBeenCalledWith(speechId, 9),
			);
		} finally {
			await adapter.close();
			await fixture.room.stop();
		}
	});
});
