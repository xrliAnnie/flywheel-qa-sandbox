import {
	BackendRegistry,
	type BrainAdapter,
	type ConversationSession,
	type VoiceBackend,
	VoiceError,
} from "flywheel-voice-core";
import { describe, expect, it, vi } from "vitest";
import { WaitingMouth } from "../audio.js";
import {
	CodexRoomFrontend,
	registerCodexVoiceBackend,
} from "../codex/CodexRoomFrontend.js";
import { CodexVoiceBackend } from "../codex/CodexVoiceBackend.js";
import { CodexVoiceContainerError } from "../codex/CodexVoiceContainer.js";
import { CodexTranscriptPublisher } from "../codex/CodexVoiceHandoff.js";
import { GenericVoiceSession, type RoomHandlers } from "../session.js";
import { simulatedPlayer } from "./playback-harness.js";

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

/** Records what the backend streams into room playback, one item each. */
function recordedOutputs() {
	const opened: Array<{
		itemId: string;
		generation: number;
		chunks: Buffer[];
		endedBeforeFinal?: boolean;
		state: "open" | "ended" | "cancelled";
	}> = [];
	const openAudio = vi.fn(
		({ itemId, generation }: { itemId: string; generation: number }) => {
			const record = {
				itemId,
				generation,
				chunks: [] as Buffer[],
				state: "open" as "open" | "ended" | "cancelled",
			};
			opened.push(record);
			let settle!: { resolve(): void; reject(error: Error): void };
			const done = new Promise<void>((resolve, reject) => {
				settle = { resolve, reject };
			});
			void done.catch(() => undefined);
			return {
				append: (pcm24Mono: Buffer) => {
					if (record.state !== "open") return false;
					record.chunks.push(pcm24Mono);
					return true;
				},
				end: () => {
					if (record.state !== "open") return;
					record.state = "ended";
					settle.resolve();
				},
				cancel: () => {
					if (record.state !== "open") return;
					record.state = "cancelled";
					settle.reject(new Error("speech_playback_stopped"));
				},
				done,
			};
		},
	);
	return { opened, openAudio };
}

/** One frame per tick with no lead: pins queue order, not lead buffering. */
function lockstepMouth(renderedFrames: Buffer[]) {
	let now = 0;
	let callback!: () => void;
	const mouth = new WaitingMouth({
		player: { play: vi.fn(), stop: vi.fn() },
		createResource: (source) => {
			source.stream.on("data", (frame: Buffer) => renderedFrames.push(frame));
			return source;
		},
		setIntervalFn: ((next: () => void) => {
			callback = next;
			return 1 as unknown as NodeJS.Timeout;
		}) as unknown as typeof setInterval,
		clearIntervalFn: vi.fn() as unknown as typeof clearInterval,
		now: () => now,
		speechLeadFrames: 0,
		idleLeadFrames: 0,
	});
	return {
		mouth,
		tick: () => {
			now += 20;
			callback();
		},
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
	it("forwards the original backend failure instead of collapsing it to its code", async () => {
		let onError!: (error: VoiceError) => void;
		const onClosed = vi.fn();
		const session = {
			...conversation(),
			on: vi.fn((event: string, handler: (...args: never[]) => void) => {
				if (event === "error") onError = handler as (error: VoiceError) => void;
				return () => undefined;
			}),
		};
		const frontend = new CodexRoomFrontend({
			backend: backend(async () => session),
			conversationOptions: { brain },
			handlers: {
				onResponseState: vi.fn(),
				onTranscript: vi.fn(),
				onSpeechAudioReady: vi.fn(),
				onSpeechResult: vi.fn(),
				onClosed,
			},
			onUnavailable: vi.fn(),
		});
		await frontend.start();
		const upstream = new Error(
			"realtime_server_error: voice prompt was rejected",
		);
		upstream.name = "CodexRealtimeServerError";

		onError(
			new VoiceError("backend-protocol", "Codex realtime failed", upstream),
		);

		expect(onClosed).toHaveBeenCalledWith({
			kind: "failed",
			reason:
				"backend-protocol:Codex realtime failed:CodexRealtimeServerError:realtime_server_error: voice prompt was rejected",
		});
	});

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
		const outputs = recordedOutputs();
		const persisted = vi.fn(async () => undefined);
		const actual = new CodexVoiceBackend({
			sessionId: "session-v2",
			voice: "marin",
			container,
			loadContext: vi.fn(),
			openAudio: outputs.openAudio,
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
		const errors: VoiceError[] = [];
		session.on("utterance", (value) => utterances.push(value));
		session.on("error", (error) => errors.push(error));
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
		await vi.waitFor(() => expect(outputs.openAudio).toHaveBeenCalledOnce());
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
		expect(outputs.opened).toEqual([
			expect.objectContaining({
				itemId: "assistant-1",
				chunks: [Buffer.alloc(960)],
				state: "ended",
			}),
		]);
		expect(utterances).toEqual([
			expect.objectContaining({
				role: "assistant",
				text: "你好",
				attribution: { kind: "unknown", reason: "engine_output" },
			}),
		]);
		const upstream = new Error(
			"realtime_server_error: voice prompt was rejected",
		) as Error & { upstreamEvent: Record<string, unknown> };
		upstream.name = "CodexRealtimeServerError";
		upstream.upstreamEvent = {
			method: "thread/realtime/error",
			params: {
				type: "invalid_request_error",
				message: "voice prompt was rejected",
			},
		};
		callbacks.onError(upstream as never);
		expect(errors).toHaveLength(1);
		expect(evidence).toHaveBeenCalledWith({
			kind: "codex_transport_error",
			errorType: "CodexRealtimeServerError",
			message: "realtime_server_error: voice prompt was rejected",
			upstreamEvent: upstream.upstreamEvent,
		});
		await session.close();
		expect(persisted).toHaveBeenCalledWith(
			expect.objectContaining({
				attribution: { kind: "unknown", reason: "engine_output" },
			}),
			expect.stringMatching(/^[a-f0-9]{64}$/),
		);
		expect(close).toHaveBeenCalledOnce();
	});

	it("hands real execution intent to the Lead without closing and records output-frame underload", async () => {
		let callbacks!: Record<string, (...args: never[]) => void>;
		let monotonic = 1_000;
		const close = vi.fn(async () => undefined);
		const persisted = vi.fn(async () => undefined);
		const published = vi.fn(async () => undefined);
		const handoffToLead = vi.fn(async () => ({
			handoffId: "handoff-a",
			state: "dispatched" as const,
			idempotencyKey: "codex-delegate:a",
			requestDigest: "d".repeat(64),
		}));
		const evidence = vi.fn();
		const actual = new CodexVoiceBackend({
			sessionId: "session-handoff",
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
						close,
					};
				}),
			},
			loadContext: vi.fn(),
			persistUtterance: persisted,
			publishUtterance: published,
			handoffToLead,
			monotonicNow: () => monotonic,
			onEvidence: evidence,
		});
		const session = await actual.createConversation({ brain });
		const errors: Error[] = [];
		session.on("error", (error) => errors.push(error));

		callbacks.onTranscript({
			generation: 1,
			itemId: "user-a",
			association: "preceding_item",
			role: "user",
			text: "你帮我去看一下2799现在是什么状态。",
			final: true,
			inputOwner: {
				utteranceId: "founder-request",
				ownerUserId: "founder",
				ownerName: "Annie",
			},
			raw: {},
		} as never);
		await vi.waitFor(() => expect(persisted).toHaveBeenCalledOnce());
		await vi.waitFor(() => expect(published).toHaveBeenCalledOnce());

		callbacks.onExecutionIntent({
			generation: 1,
			kind: "commandExecution",
			method: "item/started",
			itemId: "exec-a",
			params: { item: { type: "commandExecution" } },
		} as never);
		await vi.waitFor(() => expect(handoffToLead).toHaveBeenCalledOnce());
		expect(handoffToLead).toHaveBeenCalledWith({
			utterance: expect.objectContaining({
				transcriptId: "session-handoff:1:user-a:1",
				text: "你帮我去看一下2799现在是什么状态。",
				attribution: { kind: "known", speakerUserId: "founder" },
			}),
			intent: expect.objectContaining({
				kind: "commandExecution",
				itemId: "exec-a",
			}),
		});
		expect(close).not.toHaveBeenCalled();
		expect(errors).toEqual([]);

		callbacks.onAudio({
			generation: 1,
			itemId: "assistant-a",
			pcm24Mono: Buffer.alloc(960),
			sampleRate: 24_000,
			numChannels: 1,
			samplesPerChannel: 480,
			raw: {},
		} as never);
		monotonic = 1_030;
		callbacks.onAudio({
			generation: 1,
			itemId: "assistant-a",
			pcm24Mono: Buffer.alloc(960),
			sampleRate: 24_000,
			numChannels: 1,
			samplesPerChannel: 480,
			raw: {},
		} as never);
		expect(evidence).toHaveBeenCalledWith({
			kind: "codex_output_audio_frame",
			generation: 1,
			itemId: "assistant-a",
			frameIndex: 2,
			pcmBytes: 960,
			durationMs: 20,
			intervalMs: 30,
			underloadMs: 10,
		});
		expect(evidence).toHaveBeenCalledWith({
			kind: "codex_execution_handoff",
			generation: 1,
			backendIntentKind: "commandExecution",
			backendMethod: "item/started",
			backendItemId: "exec-a",
			transcriptId: "session-handoff:1:user-a:1",
			handoffId: "handoff-a",
			state: "dispatched",
		});

		await session.close();
	});

	it("records backpressure as a gap without ending the room session", async () => {
		let callbacks!: Record<string, (...args: never[]) => void>;
		const appendAudio = vi
			.fn()
			.mockReturnValueOnce("dropped:backpressure" as const)
			.mockReturnValue("sent" as const);
		const evidence = vi.fn();
		const actual = new CodexVoiceBackend({
			sessionId: "session-backpressure",
			voice: "marin",
			container: {
				open: vi.fn(async (input: { realtime: typeof callbacks }) => {
					callbacks = input.realtime;
					return {
						generation: 1,
						transport: {
							appendAudio,
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
			resolveSoleRoomUser: () => ({ userId: "founder", name: "Annie" }),
			onEvidence: evidence,
		});
		const session = await actual.createConversation({ brain });
		const errors: Error[] = [];
		const utterances: Array<{ attribution: unknown; text: string }> = [];
		session.on("error", (error) => errors.push(error));
		session.on("utterance", (utterance) => utterances.push(utterance));

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

		callbacks.onTranscript({
			generation: 1,
			association: "unattributed",
			role: "user",
			text: "背压缺口后的句子",
			final: true,
			raw: {},
		} as never);
		expect(utterances.at(-1)).toMatchObject({
			text: "背压缺口后的句子",
			attribution: { kind: "unknown", reason: "input_gap" },
		});

		callbacks.onTranscript({
			generation: 1,
			association: "unattributed",
			role: "user",
			text: "无缺口的重说",
			final: true,
			raw: {},
		} as never);
		expect(utterances.at(-1)).toMatchObject({
			text: "无缺口的重说",
			attribution: { kind: "known", speakerUserId: "founder" },
		});

		callbacks.onInputGap({ reason: "rpc_error", droppedBytes: 960 });
		callbacks.onTranscript({
			generation: 1,
			association: "unattributed",
			role: "user",
			text: "RPC 缺口后的句子",
			final: true,
			raw: {},
		} as never);
		expect(utterances.at(-1)).toMatchObject({
			text: "RPC 缺口后的句子",
			attribution: { kind: "unknown", reason: "input_gap" },
		});
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
		const outputs = recordedOutputs();
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
			openAudio: outputs.openAudio,
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
		const renderedFrames: Buffer[] = [];
		const { mouth, tick } = lockstepMouth(renderedFrames);
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
			openAudio: ({ itemId }) => {
				const output = mouth.openSpeech(itemId);
				playbacks.push(output.done);
				return output;
			},
		});
		const conversation = await actual.createConversation({ brain });
		const errors: Error[] = [];
		let responseDone = 0;
		conversation.on("error", (error) => errors.push(error));
		conversation.on("response-done", () => {
			responseDone += 1;
		});
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
		expect(responseDone).toBe(0);
		expect(renderedFrames.map((frame) => frame.readInt16LE(0))).toEqual([111]);

		tick();
		await expect(playbacks[1]).resolves.toBeUndefined();
		expect(completed).toEqual(["assistant-first", "assistant-second"]);
		expect(errors).toEqual([]);
		expect(responseDone).toBe(1);
		expect(renderedFrames.map((frame) => frame.readInt16LE(0))).toEqual([
			111, 222,
		]);
		await conversation.close();
		mouth.stop();
	});

	it("streams an answer into the room from its first audio frame, before its final transcript", async () => {
		// FLY-2799 qa6: whole-item buffering held a 19.45s answer until its final
		// arrived 4.8s after the first frame.
		let callbacks!: Record<string, (...args: never[]) => void>;
		const outputs = recordedOutputs();
		const evidence = vi.fn();
		const actual = new CodexVoiceBackend({
			sessionId: "session-streamed-output",
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
						close: vi.fn(async () => undefined),
					};
				}),
			},
			loadContext: vi.fn(),
			openAudio: outputs.openAudio,
			onEvidence: evidence,
		});
		const conversation = await actual.createConversation({ brain });
		let responseDone = 0;
		conversation.on("response-done", () => {
			responseDone += 1;
		});
		const audio = (itemId: string, fill: number) =>
			callbacks.onAudio({
				generation: 1,
				itemId,
				pcm24Mono: Buffer.alloc(960, fill),
				sampleRate: 24_000,
				numChannels: 1,
				samplesPerChannel: 480,
				raw: {},
			} as never);
		const final = (itemId: string) =>
			callbacks.onTranscript({
				generation: 1,
				itemId,
				association: "preceding_item",
				role: "assistant",
				text: itemId,
				final: true,
				raw: {},
			} as never);
		callbacks.onItem({
			generation: 1,
			itemId: "answer",
			role: "assistant",
			raw: {},
		} as never);

		audio("answer", 1);
		expect(outputs.opened).toEqual([
			expect.objectContaining({
				itemId: "answer",
				chunks: [Buffer.alloc(960, 1)],
				state: "open",
			}),
		]);
		audio("answer", 2);
		expect(outputs.opened[0]?.chunks).toEqual([
			Buffer.alloc(960, 1),
			Buffer.alloc(960, 2),
		]);
		final("answer");
		expect(outputs.opened[0]?.state).toBe("ended");
		await vi.waitFor(() => expect(responseDone).toBe(1));

		// Audio after the final is not played through a second output.
		audio("answer", 3);
		expect(outputs.openAudio).toHaveBeenCalledOnce();
		expect(evidence).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "codex_output_late_audio_dropped",
				itemId: "answer",
			}),
		);

		// An item whose final never comes does not hold the next one.
		audio("unfinished", 4);
		audio("next", 5);
		expect(outputs.opened.map(({ itemId, state }) => [itemId, state])).toEqual([
			["answer", "ended"],
			["unfinished", "ended"],
			["next", "open"],
		]);

		// A barge-in cancels what is still streaming.
		conversation.interrupt();
		expect(outputs.opened.at(-1)?.state).toBe("cancelled");
		await conversation.close();
	});

	it("stops a still-streaming answer the player already has queued when the founder barges in", async () => {
		let callbacks!: Record<string, (...args: never[]) => void>;
		const simulated = simulatedPlayer();
		let tickMouth!: () => void;
		const mouth = new WaitingMouth({
			player: simulated.player,
			createResource: simulated.createResource,
			setIntervalFn: ((next: () => void) => {
				tickMouth = next;
				return 1 as unknown as NodeJS.Timeout;
			}) as unknown as typeof setInterval,
			clearIntervalFn: vi.fn() as unknown as typeof clearInterval,
		});
		mouth.start();
		const actual = new CodexVoiceBackend({
			sessionId: "session-streamed-barge-in",
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
			openAudio: ({ itemId }) => mouth.openSpeech(itemId),
		});
		const conversation = await actual.createConversation({ brain });
		const errors: Error[] = [];
		conversation.on("error", (error) => errors.push(error));
		callbacks.onItem({
			generation: 1,
			itemId: "long-answer",
			role: "assistant",
			raw: {},
		} as never);
		// 400ms of speech has arrived; more is still coming.
		callbacks.onAudio({
			generation: 1,
			itemId: "long-answer",
			pcm24Mono: Buffer.alloc(19_200, 7),
			sampleRate: 24_000,
			numChannels: 1,
			samplesPerChannel: 9_600,
			raw: {},
		} as never);
		tickMouth();
		await Promise.resolve();
		for (let slot = 0; slot < 4; slot += 1) simulated.read();
		const speechSample = Buffer.alloc(2, 7).readInt16LE(0);
		// The answer is audible before the barge-in, while its audio still streams.
		expect(simulated.heard.at(-1)?.readInt16LE(0)).toBe(speechSample);

		conversation.interrupt();
		mouth.cancelAllSpeech();
		const heardAtBargeIn = simulated.heard.length;
		for (let slot = 0; slot < 15; slot += 1) {
			simulated.read();
			tickMouth();
			await Promise.resolve();
		}
		expect(
			simulated.heard
				.slice(heardAtBargeIn)
				.every((frame) => frame === null || frame.every((byte) => byte === 0)),
		).toBe(true);
		// Barge-in handed the player a fresh output instead of letting the queued
		// lead play out.
		expect(simulated.player.play).toHaveBeenCalledTimes(2);
		expect(errors).toEqual([]);
		await conversation.close();
		mouth.stop();
	});

	it("neither cuts nor drops an answer that arrives in bursts faster than it plays", async () => {
		// FLY-2798 mechanism A, checked on the engine B path: the next segment
		// arrives while the previous one still has over a second unplayed, and one
		// segment pauses upstream for more than a second mid-answer. RoomIO there
		// refused or cut the earlier segment; B's room must queue and continue.
		let callbacks!: Record<string, (...args: never[]) => void>;
		const simulated = simulatedPlayer();
		const diagnostics: Array<{ kind: string }> = [];
		let tickMouth!: () => void;
		const mouth = new WaitingMouth({
			player: simulated.player,
			createResource: simulated.createResource,
			setIntervalFn: ((next: () => void) => {
				tickMouth = next;
				return 1 as unknown as NodeJS.Timeout;
			}) as unknown as typeof setInterval,
			clearIntervalFn: vi.fn() as unknown as typeof clearInterval,
			onDiagnostic: (record) => diagnostics.push(record),
		});
		mouth.start();
		const actual = new CodexVoiceBackend({
			sessionId: "session-burst-output",
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
						close: vi.fn(async () => undefined),
					};
				}),
			},
			loadContext: vi.fn(),
			openAudio: ({ itemId }) => mouth.openSpeech(itemId),
		});
		const conversation = await actual.createConversation({ brain });
		const errors: Error[] = [];
		conversation.on("error", (error) => errors.push(error));
		const audio = (itemId: string, fill: number, frames: number) => {
			const pcm24Mono = Buffer.alloc(frames * 960);
			for (let offset = 0; offset < pcm24Mono.length; offset += 2)
				pcm24Mono.writeInt16LE(fill, offset);
			callbacks.onAudio({
				generation: 1,
				itemId,
				pcm24Mono,
				sampleRate: 24_000,
				numChannels: 1,
				samplesPerChannel: frames * 480,
				raw: {},
			} as never);
		};
		const final = (itemId: string) =>
			callbacks.onTranscript({
				generation: 1,
				itemId,
				association: "preceding_item",
				role: "assistant",
				text: itemId,
				final: true,
				raw: {},
			} as never);
		const slots = async (count: number) => {
			for (let slot = 0; slot < count; slot += 1) {
				simulated.read();
				tickMouth();
				await Promise.resolve();
			}
		};
		for (const itemId of ["first", "second"])
			callbacks.onItem({
				generation: 1,
				itemId,
				role: "assistant",
				raw: {},
			} as never);

		// Segment 1: 1.5 s delivered at once, then a 1.2 s upstream pause
		// mid-answer (it plays out and waits), then its last 1.4 s at once.
		audio("first", 1_111, 75);
		await slots(20);
		await slots(60);
		audio("first", 1_111, 70);
		final("first");
		// Segment 2 arrives while segment 1 still has over a second to play.
		await slots(5);
		const queuedFirst =
			145 -
			simulated.heard.filter((frame) => frame?.readInt16LE(0) === 1_111).length;
		expect(queuedFirst * 20).toBeGreaterThan(1_000);
		audio("second", 2_222, 30);
		final("second");
		await slots(200);

		const heardSamples = simulated.heard
			.filter((frame): frame is Buffer => frame !== null)
			.map((frame) => frame.readInt16LE(0))
			.filter((sample) => sample !== 0);
		expect(heardSamples.filter((sample) => sample === 1_111)).toHaveLength(145);
		expect(heardSamples.filter((sample) => sample === 2_222)).toHaveLength(30);
		// In order, never interleaved or cut.
		expect(heardSamples).toEqual([
			...Array(145).fill(1_111),
			...Array(30).fill(2_222),
		]);
		expect(simulated.player.play).toHaveBeenCalledOnce();
		expect(
			diagnostics.filter(({ kind }) => kind === "playback_flushed"),
		).toEqual([]);
		expect(errors).toEqual([]);
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
		const renderedFrames: Buffer[] = [];
		const { mouth, tick } = lockstepMouth(renderedFrames);
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
			openAudio: ({ itemId }) => {
				const output = mouth.openSpeech(itemId);
				playbacks.push(output.done);
				return output;
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
			pcm24Mono: Buffer.alloc(960, 1),
			sampleRate: 24_000,
			numChannels: 1,
			samplesPerChannel: 480,
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
			pcm24Mono: Buffer.alloc(4_800, 3),
			sampleRate: 24_000,
			numChannels: 1,
			samplesPerChannel: 2_400,
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
		callbacks.onItem({
			generation: 1,
			itemId: "assistant-third-before-barge-in",
			role: "assistant",
			raw: {},
		} as never);
		callbacks.onAudio({
			generation: 1,
			itemId: "assistant-third-before-barge-in",
			pcm24Mono: Buffer.alloc(960, 4),
			sampleRate: 24_000,
			numChannels: 1,
			samplesPerChannel: 480,
			raw: {},
		} as never);
		callbacks.onTranscript({
			generation: 1,
			itemId: "assistant-third-before-barge-in",
			association: "preceding_item",
			role: "assistant",
			text: "排队的第三句也必须停。",
			final: true,
			raw: {},
		} as never);
		await vi.waitFor(() => expect(playbacks).toHaveLength(3));
		tick();
		expect(renderedFrames).toHaveLength(1);
		await expect(playbacks[0]).resolves.toBeUndefined();
		tick();
		expect(renderedFrames).toHaveLength(2);

		const cancellationReasons: string[] = [];
		playbacks.slice(1, 3).forEach((playback) => {
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
		await vi.waitFor(() => expect(playbacks).toHaveLength(4));
		tick();
		await expect(playbacks[3]).resolves.toBeUndefined();
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
		const handoffToLead = vi.fn(async () => ({
			handoffId: "handoff-after-restart-gap",
			state: "dispatched" as const,
			idempotencyKey: "restart-gap-handoff",
			requestDigest: "d".repeat(64),
		}));
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
			resolveSoleRoomUser: () => ({ userId: "founder", name: "Annie" }),
			persistUtterance: vi.fn(async () => undefined),
			handoffToLead,
			onEvidence: evidence,
		});
		const session = await actual.createConversation({ brain });
		const utterances: Array<{ attribution: unknown; text: string }> = [];
		session.on("utterance", (utterance) => utterances.push(utterance));
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

		callbacks.onTranscript({
			generation: 2,
			association: "unattributed",
			role: "user",
			text: "不要把丢掉否定词的句子交办",
			final: true,
			raw: {},
		} as never);
		callbacks.onExecutionIntent({
			generation: 2,
			kind: "commandExecution",
			method: "item/started",
			itemId: "exec-after-gap",
			params: { item: { type: "commandExecution" } },
		} as never);
		expect(utterances.at(-1)).toMatchObject({
			text: "不要把丢掉否定词的句子交办",
			attribution: { kind: "unknown", reason: "input_gap" },
		});
		expect(handoffToLead).not.toHaveBeenCalled();

		callbacks.onTranscript({
			generation: 2,
			association: "unattributed",
			role: "user",
			text: "我重说一次，请交给本体",
			final: true,
			raw: {},
		} as never);
		callbacks.onExecutionIntent({
			generation: 2,
			kind: "commandExecution",
			method: "item/started",
			itemId: "exec-after-repeat",
			params: { item: { type: "commandExecution" } },
		} as never);
		await vi.waitFor(() => expect(handoffToLead).toHaveBeenCalledOnce());
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

	it("attributes an itemless transcript only to the sole present room user and publishes it", async () => {
		let callbacks!: Record<string, (...args: never[]) => void>;
		const mirror = vi.fn(async () => ({ messageId: "discord-user" }));
		const evidence = vi.fn();
		const publisher = new CodexTranscriptPublisher({
			sessionId: "session-sole-user",
			founderUserId: "founder",
			displayName: "Raya",
			mirror,
			evidence,
		});
		const handoffToLead = vi.fn(async () => ({
			handoffId: "handoff-sole-user",
			state: "dispatched" as const,
			idempotencyKey: "codex-delegate:sole-user",
			requestDigest: "d".repeat(64),
		}));
		let soleRoomUser: { userId: string; name: string | null } | null = {
			userId: "founder",
			name: "Annie",
		};
		const actual = new CodexVoiceBackend({
			sessionId: "session-sole-user",
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
			persistUtterance: vi.fn(async () => undefined),
			publishUtterance: (utterance) => publisher.publish(utterance),
			handoffToLead,
			resolveSoleRoomUser: () => soleRoomUser,
			onEvidence: evidence,
		});
		const onTranscript = vi.fn();
		const onUnattributedTranscript = vi.fn();
		const frontend = new CodexRoomFrontend({
			backend: actual,
			conversationOptions: { brain },
			handlers: {
				onResponseState: vi.fn(),
				onTranscript,
				onUnattributedTranscript,
				onSpeechAudioReady: vi.fn(),
				onSpeechResult: vi.fn(),
				onClosed: vi.fn(),
			},
			onUnavailable: vi.fn(),
		});
		await frontend.start();
		frontend.appendAudio(Buffer.alloc(960), {
			utteranceId: "discord-founder-turn",
			ownerUserId: "founder",
			ownerName: "Annie",
		});

		callbacks.onTranscript({
			generation: 1,
			association: "unattributed",
			role: "user",
			text: "你帮我去看一下 2799",
			final: true,
			raw: {},
		} as never);

		await vi.waitFor(() => expect(onTranscript).toHaveBeenCalledOnce());
		expect(onTranscript).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "你帮我去看一下 2799",
				ownerUserId: "founder",
			}),
		);
		await vi.waitFor(() => expect(mirror).toHaveBeenCalledOnce());
		expect(mirror).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "🎙️ **你（语音）**：你帮我去看一下 2799",
			}),
		);

		callbacks.onExecutionIntent({
			generation: 1,
			kind: "commandExecution",
			method: "item/started",
			itemId: "exec-sole-user",
			params: { item: { type: "commandExecution" } },
		} as never);
		await vi.waitFor(() => expect(handoffToLead).toHaveBeenCalledOnce());
		expect(handoffToLead).toHaveBeenCalledWith({
			utterance: expect.objectContaining({
				text: "你帮我去看一下 2799",
				attribution: { kind: "known", speakerUserId: "founder" },
			}),
			intent: expect.objectContaining({ itemId: "exec-sole-user" }),
		});

		soleRoomUser = null;
		callbacks.onTranscript({
			generation: 1,
			association: "unattributed",
			role: "user",
			text: "多人房里这句不能授权",
			final: true,
			raw: {},
		} as never);
		callbacks.onExecutionIntent({
			generation: 1,
			kind: "commandExecution",
			method: "item/started",
			itemId: "exec-ambiguous-user",
			params: { item: { type: "commandExecution" } },
		} as never);
		await vi.waitFor(() =>
			expect(onUnattributedTranscript).toHaveBeenCalledWith(
				expect.objectContaining({ text: "多人房里这句不能授权" }),
			),
		);
		await vi.waitFor(() => expect(mirror).toHaveBeenCalledTimes(2));
		expect(mirror.mock.calls[1]?.[0]).toEqual(
			expect.objectContaining({
				text: "🎙️ **语音输入**：多人房里这句不能授权",
			}),
		);
		expect(handoffToLead).toHaveBeenCalledOnce();
		await frontend.stop();
	});

	it("asks for a repeat when a user transcript remains unattributed", async () => {
		let onUtterance!: (utterance: unknown) => void;
		const session = {
			...conversation(),
			on: vi.fn((event: string, handler: (...args: never[]) => void) => {
				if (event === "utterance")
					onUtterance = handler as (utterance: unknown) => void;
				return () => undefined;
			}),
		};
		const onTranscript = vi.fn();
		const onUnattributedTranscript = vi.fn();
		const frontend = new CodexRoomFrontend({
			backend: backend(async () => session),
			conversationOptions: { brain },
			handlers: {
				onResponseState: vi.fn(),
				onTranscript,
				onUnattributedTranscript,
				onSpeechAudioReady: vi.fn(),
				onSpeechResult: vi.fn(),
				onClosed: vi.fn(),
			} as never,
			onUnavailable: vi.fn(),
		});
		await frontend.start();

		onUtterance({
			transcriptId: "session:1:unattributed:1",
			utteranceId: "session:1:unattributed",
			sequence: 1,
			role: "user",
			text: "请再听一次",
			final: true,
			attribution: { kind: "unknown", reason: "provider_item_unattributed" },
		});

		expect(onTranscript).not.toHaveBeenCalled();
		expect(onUnattributedTranscript).toHaveBeenCalledWith({
			itemId: "session:1:unattributed:1",
			text: "请再听一次",
			reason: "provider_item_unattributed",
		});
		await frontend.stop();
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
