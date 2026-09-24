import { createHash } from "node:crypto";
import type {
	ConversationEventMap,
	OpenAiLiveConversationSession,
	OpenAiLiveTranscriptDelta,
	RoomBargeInEvent,
	RoomIO,
	RoomUtteranceEvent,
	SpeakReceipt,
	VoiceHandoffRequest,
	VoiceHandoffResultEvent,
	VoiceUtterance,
} from "flywheel-voice-core";
import { describe, expect, it, vi } from "vitest";
import { LiveLeadAdapter } from "../live-lead-adapter.js";

const PCM = { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 } as const;

function deferred<T>() {
	let resolve!: (value: T) => void;
	return {
		promise: new Promise<T>((done) => {
			resolve = done;
		}),
		resolve,
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
	readonly audioSent: Buffer[] = [];
	readonly context: string[] = [];
	readonly eventHandlers = new Map<string, Set<(...args: any[]) => void>>();
	readonly liveTranscriptHandlers = new Set<
		(delta: OpenAiLiveTranscriptDelta) => void
	>();
	interrupt = vi.fn();
	replaceAfterBargeIn = vi.fn(async () => {
		this.providerGeneration = (this.providerGeneration ?? 0) + 1;
		return this.providerGeneration;
	});
	suspend = vi.fn(
		async (reason: "announcer-takeover" | "delegation-sealed") => ({
			generation: this.providerGeneration ?? 1,
			reason,
			finalization: "provider_connection_closed" as const,
		}),
	);
	resume = vi.fn(async () => {
		this.providerGeneration = (this.providerGeneration ?? 0) + 1;
		return this.providerGeneration;
	});
	close = vi.fn(async () => undefined);

	sendAudio(frame: Buffer): void {
		this.audioSent.push(frame);
	}
	sendText(): void {}
	injectContext(text: string): void {
		this.context.push(text);
	}
	endUserTurn(): void {}
	injectToolResult(): void {}
	on<E extends keyof ConversationEventMap>(
		event: E,
		handler: (...args: ConversationEventMap[E]) => void,
	): () => void {
		const handlers = this.eventHandlers.get(event) ?? new Set();
		handlers.add(handler);
		this.eventHandlers.set(event, handlers);
		return () => handlers.delete(handler);
	}
	onLiveTranscript(
		listener: (delta: OpenAiLiveTranscriptDelta) => void,
	): () => void {
		this.liveTranscriptHandlers.add(listener);
		return () => this.liveTranscriptHandlers.delete(listener);
	}
	emit(event: string, ...args: any[]): void {
		for (const handler of this.eventHandlers.get(event) ?? []) handler(...args);
	}
	emitLiveTranscript(delta: OpenAiLiveTranscriptDelta): void {
		for (const handler of this.liveTranscriptHandlers) handler(delta);
	}
}

function room() {
	const frameListeners = new Set<(frame: any) => void>();
	const utteranceListeners = new Set<(event: RoomUtteranceEvent) => void>();
	const bargeListeners = new Set<(event: RoomBargeInEvent) => void>();
	const io = {
		identity: {
			moduleExport: "test",
			roomIOVersion: 1 as const,
			implementationDigest: "digest",
			buildSha: null,
			instanceId: "instance",
			sessionId: "voice-session",
			roomKey: "room",
			generation: 9,
			inputRouteInstanceId: "instance",
			outputRouteInstanceId: "instance",
		},
		onFrame: vi.fn((listener) => {
			frameListeners.add(listener);
			return () => frameListeners.delete(listener);
		}),
		onUtterance: vi.fn((listener) => {
			utteranceListeners.add(listener);
			return () => utteranceListeners.delete(listener);
		}),
		onBargeIn: vi.fn((listener) => {
			bargeListeners.add(listener);
			return () => bargeListeners.delete(listener);
		}),
		onPresence: vi.fn(() => () => undefined),
		onReceiveHealth: vi.fn(() => () => undefined),
		start: vi.fn(async () => ({ founderPresent: true, humanCount: 1 })),
		stop: vi.fn(async () => undefined),
		startSpeech: vi.fn((input) => ({ outcome: "accepted" as const, ...input })),
		writeSpeech: vi.fn(async (frame) => ({
			outcome: "submitted" as const,
			speechId: frame.speechId,
			generation: frame.generation,
			sequence: frame.sequence,
		})),
		endSpeech: vi.fn(async (speechId, generation) => ({
			outcome: "submitted" as const,
			speechId,
			generation,
		})),
		localPlaybackCancel: vi.fn(),
		status: vi.fn(async () => undefined),
		playSpeech: vi.fn(),
		playClip: vi.fn(),
		audibleTail: vi.fn(),
		speaker: vi.fn(),
		setWaiting: vi.fn(),
		setBedEnabled: vi.fn(),
	};
	return {
		io: io as unknown as RoomIO,
		emitFrame(frame: any) {
			for (const listener of frameListeners) listener(frame);
		},
		emitUtterance(event: RoomUtteranceEvent) {
			for (const listener of utteranceListeners) listener(event);
		},
		emitBarge(event: RoomBargeInEvent) {
			for (const listener of bargeListeners) listener(event);
		},
	};
}

function harness(
	overrides: {
		submitHandoff?: (request: VoiceHandoffRequest) => Promise<{
			handoffId: string;
			requestDigest: string;
			state: "committed";
			providerOperationId: string;
		}>;
		delegationEndTimeoutMs?: number;
		maxSuspendedInputMs?: number;
	} = {},
) {
	const live = new FakeLive();
	const roomHarness = room();
	const handoffs: VoiceHandoffRequest[] = [];
	const handoffBindings: Array<{
		sessionId: string;
		generation: number;
		handoffId: string;
		requestDigest: string;
		targetLeadId: string;
	}> = [];
	const utterances: VoiceUtterance[] = [];
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
	const transcriptSink = {
		append: vi.fn(),
		appendDurable: vi.fn(async (entry: VoiceUtterance) => ({
			version: 1 as const,
			durable: true as const,
			sessionId: entry.sessionId,
			transcriptId: entry.transcriptId,
			contentDigest: createHash("sha256").update(entry.text).digest("hex"),
			persistedAt: "2026-09-24T00:00:00.000Z",
		})),
		readReceipt: vi.fn(async (_sessionId, transcriptId, contentDigest) => ({
			version: 1 as const,
			durable: true as const,
			sessionId: "voice-session",
			transcriptId,
			contentDigest,
			persistedAt: "2026-09-24T00:00:00.000Z",
		})),
	};
	let now = 1_000;
	const adapter = new LiveLeadAdapter({
		sessionId: "voice-session",
		generation: 9,
		projectName: "flywheel",
		founderUserId: "founder-1",
		targetLeadId: "flywheel-eng-lead",
		room: roomHarness.io,
		createConversation: vi.fn(async () => live),
		transcriptSink,
		speech,
		classifyIntent: () => "query",
		submitHandoff: vi.fn(
			overrides.submitHandoff ??
				(async (request) => {
					handoffs.push(request);
					return {
						handoffId: request.handoffId,
						requestDigest: request.requestDigest,
						state: "committed" as const,
						providerOperationId: "mailbox-delivery-1",
					};
				}),
		),
		registerHandoff: (binding) => handoffBindings.push(binding),
		now: () => now,
		nextId: (() => {
			let id = 0;
			return () => `id-${++id}`;
		})(),
		...(overrides.delegationEndTimeoutMs === undefined
			? {}
			: { delegationEndTimeoutMs: overrides.delegationEndTimeoutMs }),
		...(overrides.maxSuspendedInputMs === undefined
			? {}
			: { maxSuspendedInputMs: overrides.maxSuspendedInputMs }),
		record,
	});
	adapter.onUtterance((utterance) => utterances.push(utterance));
	return {
		adapter,
		live,
		room: roomHarness,
		handoffs,
		handoffBindings,
		utterances,
		speech,
		transcriptSink,
		record,
		setNow(value: number) {
			now = value;
		},
	};
}

describe("LiveLeadAdapter", () => {
	it("never claims the shared RoomIO lifecycle", async () => {
		const h = harness();
		await h.adapter.open("context");
		expect(h.room.io.start).not.toHaveBeenCalled();

		await h.adapter.close();
		expect(h.room.io.stop).not.toHaveBeenCalled();
	});

	it("streams each frontend audio delta to RoomIO and labels its caption as frontend", async () => {
		const h = harness();
		await h.adapter.open("foreground context");
		h.live.emit("response-started");
		h.live.emit("response-audio", Buffer.from([1, 0]), PCM);
		await vi.waitFor(() =>
			expect(h.room.io.writeSpeech).toHaveBeenCalledOnce(),
		);
		h.live.emit("response-audio", Buffer.from([2, 0]), PCM);
		h.live.emit("transcript", {
			role: "assistant",
			text: "马上回答",
			final: false,
		});

		await vi.waitFor(() =>
			expect(h.room.io.writeSpeech).toHaveBeenCalledTimes(2),
		);
		expect(
			vi
				.mocked(h.room.io.writeSpeech)
				.mock.calls.map(([frame]) => frame.sequence),
		).toEqual([0, 1]);
		expect(h.utterances.at(-1)).toMatchObject({
			role: "assistant",
			text: "马上回答",
			final: false,
			source: "frontend",
		});
	});

	it("seals one attributed utterance, persists it, and binds delegation separately from business idempotency", async () => {
		const h = harness();
		await h.adapter.open("context");
		h.room.emitUtterance({
			sessionId: "voice-session",
			generation: 9,
			utteranceId: "u1",
			attribution: { kind: "known", speakerUserId: "founder-1" },
			observedAt: 1_100,
			phase: "start",
		});
		h.live.emitLiveTranscript({
			type: "transcript-delta",
			direction: "input",
			generation: 1,
			eventId: "delta-1",
			startMs: 100,
			endMs: 200,
			delta: "帮我查一下状态",
		});
		h.room.emitUtterance({
			sessionId: "voice-session",
			generation: 9,
			utteranceId: "u1",
			attribution: { kind: "known", speakerUserId: "founder-1" },
			observedAt: 1_250,
			phase: "end",
		});
		h.live.emit("delegation-created", {
			delegationId: "provider-1",
			generation: 1,
			offsetMs: 200,
			target: "client",
		});

		await vi.waitFor(() => expect(h.handoffs).toHaveLength(1));
		const request = h.handoffs[0]!;
		expect(request.originalText).toBe("帮我查一下状态");
		expect(request.delegationBinding).toContain("provider-1");
		expect(request.idempotencyKey).not.toContain("provider-1");
		expect(h.speech.speak).toHaveBeenCalledWith(
			"我问下 Lead",
			"cue",
			expect.objectContaining({ verification: "required" }),
		);
		expect(h.utterances).toContainEqual(
			expect.objectContaining({
				text: "我问下 Lead",
				source: "frontend",
				role: "assistant",
				final: true,
			}),
		);
		expect(h.handoffBindings).toEqual([
			{
				sessionId: "voice-session",
				generation: 9,
				handoffId: request.handoffId,
				requestDigest: request.requestDigest,
				targetLeadId: "flywheel-eng-lead",
			},
		]);
		expect(h.transcriptSink.appendDurable).toHaveBeenCalledOnce();
		expect(h.utterances.at(-1)).toMatchObject({
			role: "user",
			final: true,
			attribution: { kind: "known", speakerUserId: "founder-1" },
		});
		expect(h.live.resume).toHaveBeenCalledOnce();

		h.live.emit("delegation-created", {
			delegationId: "provider-1",
			generation: 1,
			offsetMs: 200,
			target: "client",
		});
		await Promise.resolve();
		expect(h.handoffs).toHaveLength(1);
	});

	it("waits for the real RoomIO utterance end before sealing a delegation", async () => {
		const h = harness();
		await h.adapter.open("context");
		h.room.emitUtterance({
			sessionId: "voice-session",
			generation: 9,
			utteranceId: "u1",
			attribution: { kind: "known", speakerUserId: "founder-1" },
			observedAt: 1_100,
			phase: "start",
		});
		h.live.emitLiveTranscript({
			type: "transcript-delta",
			direction: "input",
			generation: 1,
			eventId: "delta-1",
			startMs: 100,
			endMs: 150,
			delta: "帮我",
		});
		h.live.emitLiveTranscript({
			type: "transcript-delta",
			direction: "output",
			generation: 1,
			eventId: "output-1",
			startMs: 100,
			endMs: 140,
			delta: "我问下 Lead",
		});
		h.live.emit("delegation-created", {
			delegationId: "provider-1",
			generation: 1,
			offsetMs: 150,
			target: "client",
		});
		await Promise.resolve();
		expect(h.live.suspend).not.toHaveBeenCalled();

		h.live.emitLiveTranscript({
			type: "transcript-delta",
			direction: "input",
			generation: 1,
			eventId: "delta-2",
			startMs: 150,
			endMs: 230,
			delta: "查完整状态",
		});
		h.room.emitUtterance({
			sessionId: "voice-session",
			generation: 9,
			utteranceId: "u1",
			attribution: { kind: "known", speakerUserId: "founder-1" },
			observedAt: 1_250,
			phase: "end",
		});

		await vi.waitFor(() => expect(h.handoffs).toHaveLength(1));
		expect(h.handoffs[0]?.originalText).toBe("帮我查完整状态");
		expect(h.live.suspend).toHaveBeenCalledOnce();
		expect(h.speech.speak).not.toHaveBeenCalled();
	});

	it("preserves but does not dispatch an utterance whose RoomIO end times out", async () => {
		vi.useFakeTimers();
		try {
			const h = harness({ delegationEndTimeoutMs: 25 });
			await h.adapter.open("context");
			h.room.emitUtterance({
				sessionId: "voice-session",
				generation: 9,
				utteranceId: "u1",
				attribution: { kind: "known", speakerUserId: "founder-1" },
				observedAt: 1_100,
				phase: "start",
			});
			h.live.emitLiveTranscript({
				type: "transcript-delta",
				direction: "input",
				generation: 1,
				eventId: "delta-1",
				startMs: 100,
				endMs: 230,
				delta: "这句不能丢",
			});
			h.live.emit("delegation-created", {
				delegationId: "provider-1",
				generation: 1,
				offsetMs: 150,
				target: "client",
			});

			await vi.advanceTimersByTimeAsync(25);
			expect(h.handoffs).toHaveLength(0);
			expect(h.utterances.at(-1)).toMatchObject({
				text: "这句不能丢",
				attribution: {
					kind: "unknown",
					reason: "room_utterance_incomplete",
				},
			});
			expect(h.record).toHaveBeenCalledWith(
				expect.objectContaining({
					kind: "live_lead_clarification_required",
					reason: "room_utterance_incomplete",
				}),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("announces an authorized Lead result without injecting its text into Live context", async () => {
		const h = harness();
		await h.adapter.open("context");
		await h.adapter.applyLeadResult(
			{
				resultEventId: "result-1",
				seq: 1,
				handoffId: "handoff-1",
				requestDigest: "request-digest",
				sourceLeadId: "flywheel-eng-lead",
				sourceDeliveryId: "delivery-1",
				resultKind: "lead_reply",
				text: "Lead 的原话",
				createdAt: "2026-09-24T00:00:00.000Z",
			} satisfies VoiceHandoffResultEvent,
			{
				handoffId: "handoff-1",
				requestDigest: "request-digest",
				targetLeadId: "flywheel-eng-lead",
				sessionId: "voice-session",
				generation: 9,
			},
		);

		expect(h.speech.speak).toHaveBeenCalledWith(
			"Lead 的原话",
			"readback",
			expect.objectContaining({ verification: "required" }),
		);
		expect(h.live.context).toEqual([]);
		expect(h.utterances.at(-1)).toMatchObject({
			text: "Lead 的原话",
			source: "lead:flywheel-eng-lead",
			role: "assistant",
			final: true,
		});
	});

	it("cancels both announcer and Live output on sustained RoomIO barge-in", async () => {
		const h = harness();
		await h.adapter.open("context");
		h.room.emitBarge({
			sessionId: "voice-session",
			generation: 9,
			utteranceId: "u1",
			owner: { kind: "known", speakerUserId: "founder-1" },
			startedAt: 1_000,
			observedAt: 1_400,
			durationMs: 400,
			phase: "sustained",
		});

		expect(h.speech.cancel).toHaveBeenCalledWith("barge-in");
		await vi.waitFor(() =>
			expect(h.live.replaceAfterBargeIn).toHaveBeenCalledOnce(),
		);
	});

	it("buffers room audio during announcer takeover and replays it once after resume", async () => {
		const h = harness();
		const spoken = deferred<SpeakReceipt>();
		h.speech.speak.mockImplementationOnce(() => spoken.promise);
		await h.adapter.open("context");

		const speaking = h.adapter.speak("Lead 原话", "readback", {
			pendingKey: "lead-1",
			verification: "required",
		});
		await vi.waitFor(() => expect(h.live.suspend).toHaveBeenCalledOnce());
		h.room.emitFrame({
			pcm: Buffer.from([1, 0]),
			format: PCM,
			sessionId: "voice-session",
			generation: 9,
			sequence: 1,
			capturedAt: 1_200,
			utteranceId: "u1",
			attribution: { kind: "known", speakerUserId: "founder-1" },
		});
		h.room.emitFrame({
			pcm: Buffer.from([2, 0]),
			format: PCM,
			sessionId: "voice-session",
			generation: 9,
			sequence: 2,
			capturedAt: 1_201,
			utteranceId: "u1",
			attribution: { kind: "known", speakerUserId: "founder-1" },
		});
		expect(h.live.audioSent).toEqual([]);

		spoken.resolve({
			pendingKey: "lead-1",
			requestDigest: "speech-digest",
			outcome: "completed",
			transport: "submitted",
			contentProof: "deterministic_tts",
		});
		await speaking;
		expect(h.live.audioSent).toEqual([
			Buffer.from([1, 0]),
			Buffer.from([2, 0]),
		]);
	});

	it("does not start a competing Live replacement when barge-in cancels an announcer", async () => {
		const h = harness();
		const spoken = deferred<SpeakReceipt>();
		h.speech.speak.mockImplementationOnce(() => spoken.promise);
		await h.adapter.open("context");
		const speaking = h.adapter.speak("播报中", "brief", {
			pendingKey: "brief-1",
			verification: "best_effort",
		});
		await vi.waitFor(() => expect(h.live.suspend).toHaveBeenCalledOnce());

		h.room.emitBarge({
			sessionId: "voice-session",
			generation: 9,
			utteranceId: "u1",
			owner: { kind: "known", speakerUserId: "founder-1" },
			startedAt: 1_000,
			observedAt: 1_400,
			durationMs: 400,
			phase: "sustained",
		});

		expect(h.speech.cancel).toHaveBeenCalledWith("barge-in");
		expect(h.live.replaceAfterBargeIn).not.toHaveBeenCalled();
		spoken.resolve({
			pendingKey: "brief-1",
			requestDigest: "speech-digest",
			outcome: "failed",
			reason: "barge-in",
			transport: "submitted",
			contentProof: "none",
		});
		await speaking;
		expect(h.live.resume).toHaveBeenCalledOnce();
	});

	it("buffers new input until a barge-in replacement generation is admitted", async () => {
		const h = harness();
		const replaced = deferred<number>();
		h.live.replaceAfterBargeIn.mockImplementationOnce(() => replaced.promise);
		await h.adapter.open("context");

		h.room.emitBarge({
			sessionId: "voice-session",
			generation: 9,
			utteranceId: "u1",
			owner: { kind: "known", speakerUserId: "founder-1" },
			startedAt: 1_000,
			observedAt: 1_400,
			durationMs: 400,
			phase: "sustained",
		});
		h.room.emitFrame({
			pcm: Buffer.from([3, 0]),
			format: PCM,
			sessionId: "voice-session",
			generation: 9,
			sequence: 1,
			capturedAt: 1_401,
			utteranceId: "u1",
			attribution: { kind: "known", speakerUserId: "founder-1" },
		});
		expect(h.live.audioSent).toEqual([]);

		replaced.resolve(2);
		await vi.waitFor(() => expect(h.live.audioSent).toHaveLength(1));
		expect(h.live.audioSent[0]).toEqual(Buffer.from([3, 0]));
	});

	it("fails visibly and drops a partial suspended buffer when its bound is exceeded", async () => {
		const h = harness({ maxSuspendedInputMs: 1 });
		const replaced = deferred<number>();
		h.live.replaceAfterBargeIn.mockImplementationOnce(() => replaced.promise);
		await h.adapter.open("context");
		h.room.emitBarge({
			sessionId: "voice-session",
			generation: 9,
			utteranceId: "u1",
			owner: { kind: "known", speakerUserId: "founder-1" },
			startedAt: 1_000,
			observedAt: 1_400,
			durationMs: 400,
			phase: "sustained",
		});
		h.room.emitFrame({
			pcm: Buffer.alloc(50),
			format: PCM,
			sessionId: "voice-session",
			generation: 9,
			sequence: 1,
			capturedAt: 1_401,
			utteranceId: "u1",
			attribution: { kind: "known", speakerUserId: "founder-1" },
		});

		expect(h.record).toHaveBeenCalledWith({
			kind: "live_lead_input_buffer_overflow",
			limitBytes: 48,
		});
		expect(h.room.io.status).toHaveBeenCalledWith("语音暂不可用，请重说");
		replaced.resolve(2);
		await vi.waitFor(() =>
			expect(h.live.replaceAfterBargeIn).toHaveBeenCalledOnce(),
		);
		expect(h.live.audioSent).toEqual([]);
	});

	it("resumes Live after a committed handoff attempt fails", async () => {
		const h = harness({
			submitHandoff: vi.fn(async () => {
				throw new Error("mailbox unavailable");
			}),
		});
		await h.adapter.open("context");
		h.room.emitUtterance({
			sessionId: "voice-session",
			generation: 9,
			utteranceId: "u1",
			attribution: { kind: "known", speakerUserId: "founder-1" },
			observedAt: 1_100,
			phase: "start",
		});
		h.live.emitLiveTranscript({
			type: "transcript-delta",
			direction: "input",
			generation: 1,
			eventId: "delta-1",
			startMs: 100,
			endMs: 200,
			delta: "帮我查一下状态",
		});
		h.room.emitUtterance({
			sessionId: "voice-session",
			generation: 9,
			utteranceId: "u1",
			attribution: { kind: "known", speakerUserId: "founder-1" },
			observedAt: 1_250,
			phase: "end",
		});

		h.live.emit("delegation-created", {
			delegationId: "provider-1",
			generation: 1,
			offsetMs: 200,
			target: "client",
		});

		await vi.waitFor(() => expect(h.live.resume).toHaveBeenCalledOnce());
		expect(h.record).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "live_lead_delegation_failed",
				message: "mailbox unavailable",
			}),
		);
	});
});
