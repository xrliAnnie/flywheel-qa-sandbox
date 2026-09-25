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
import { createEngineAHeadphoneSession } from "../engine-a-composition.js";
import {
	type AgendaTurnRouter,
	LiveLeadAdapter,
} from "../live-lead-adapter.js";

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
	const tail = { drained: true, remainingMs: 0 as number | null };
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
		audibleTail: vi.fn(() => ({
			estimated: true as const,
			remainingMs: tail.remainingMs,
			drained: tail.drained,
			observedAt: 0,
			sessionId: "voice-session",
			generation: 9,
		})),
		speaker: vi.fn(),
		setWaiting: vi.fn(),
		setBedEnabled: vi.fn(),
	};
	return {
		io: io as unknown as RoomIO,
		tail,
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
		founderTurnSettleTimeoutMs?: number;
		founderTurnMaxHoldMs?: number;
		agendaTurns?: AgendaTurnRouter;
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
		agendaUtteranceId?: string;
	}> = [];
	const utterances: VoiceUtterance[] = [];
	const record = vi.fn();
	const onUnavailable = vi.fn();
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
		...(overrides.founderTurnSettleTimeoutMs === undefined
			? {}
			: { founderTurnSettleTimeoutMs: overrides.founderTurnSettleTimeoutMs }),
		...(overrides.founderTurnMaxHoldMs === undefined
			? {}
			: { founderTurnMaxHoldMs: overrides.founderTurnMaxHoldMs }),
		...(overrides.agendaTurns ? { agendaTurns: overrides.agendaTurns } : {}),
		record,
		onUnavailable,
	});
	adapter.onUtterance((utterance) => utterances.push(utterance));
	return {
		adapter,
		onUnavailable,
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

/** FLY-2863: Bridge agenda stubs (the inbox is never read out any more). */
function agendaStubs(
	options: {
		items?: Array<Record<string, unknown>>;
		results?: Record<string, Array<Record<string, unknown>>>;
	} = {},
) {
	let stored: unknown;
	let requests = 0;
	return {
		getAgendaSnapshot: vi.fn(async () => ({
			snapshotId: "s",
			asOf: "2026-09-24T00:00:00.000Z",
			items: options.items ?? [],
			sourceStatus: {},
			complete: true,
			olderUnspokenCount: 0,
		})),
		getAgendaState: vi.fn(async () => stored),
		putAgendaState: vi.fn(
			async (_binding: unknown, input: { state: unknown }) => {
				stored = input.state;
				return { ok: true as const };
			},
		),
		requestAgendaBrief: vi.fn(async () => ({
			requestId: `agenda-${++requests}`,
		})),
		bindAgendaTurn: vi.fn(async () => undefined),
		listVoiceHandoffResults: vi.fn(
			async (_binding: unknown, handoffId: string, after: number) => {
				const events = (options.results?.[handoffId] ?? []).filter(
					(event) => (event.seq as number) > after,
				);
				const high = (options.results?.[handoffId] ?? []).length;
				return { events, highWatermark: high, nextCursor: high };
			},
		),
	};
}

function blockedItem() {
	return {
		itemKey: "blocked:I1:t",
		class: "blocked",
		projectName: "flywheel",
		leadId: "flywheel-eng-lead",
		leadName: "flywheel eng",
		issueIdentifier: "FLY-2796",
		issueTitle: "耳机",
		threadUrl: "https://discord.com/channels/1/2",
		since: "2026-09-24T00:00:00.000Z",
		urgent: null,
		pointers: { messageIds: [] },
		sourceKey: "titles:flywheel",
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

	it("contains provider input failures instead of throwing out of the RoomIO audio clock", async () => {
		const h = harness();
		await h.adapter.open("context");
		const sendAudio = vi.spyOn(h.live, "sendAudio").mockImplementation(() => {
			throw new Error("provider generation is gone");
		});
		const frame = {
			sessionId: "voice-session",
			generation: 9,
			pcm: Buffer.from([1, 0]),
			format: PCM,
		};

		expect(() => h.room.emitFrame(frame)).not.toThrow();
		expect(() => h.room.emitFrame(frame)).not.toThrow();
		expect(sendAudio).toHaveBeenCalledOnce();
		expect(h.record).toHaveBeenCalledWith({
			kind: "live_lead_voice_unavailable",
			message: "provider generation is gone",
		});
	});

	it("streams each frontend audio delta but emits only one final frontend caption", async () => {
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
			text: "马上",
			final: false,
		});
		h.live.emit("transcript", {
			role: "assistant",
			text: "回答",
			final: false,
		});
		expect(h.utterances).toHaveLength(0);
		h.live.emit("transcript", {
			role: "assistant",
			text: "马上回答",
			final: true,
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
			final: true,
			source: "frontend",
		});
		expect(h.utterances).toHaveLength(1);
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
		expect(request.idempotencyKey).toBe(
			`${request.transcriptId}:${request.payload.targetLeadId}:${request.intentKind}`,
		);
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
			expect(h.utterances.find((u) => u.role === "user")).toMatchObject({
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
			// Preserved but not dropped silently: she is asked to say it again.
			expect(h.utterances.at(-1)).toMatchObject({
				role: "assistant",
				text: "刚才那句我没对上，你再说一次。",
			});
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

	it("retries a failed Lead result readback before marking the result applied", async () => {
		const h = harness();
		h.speech.speak
			.mockResolvedValueOnce({
				pendingKey: "handoff-result:handoff-1:result-1",
				requestDigest: "speech-digest",
				outcome: "failed",
				reason: "barge-in",
				transport: "submitted",
				contentProof: "none",
			})
			.mockResolvedValueOnce({
				pendingKey: "handoff-result:handoff-1:result-1",
				requestDigest: "speech-digest",
				outcome: "completed",
				transport: "submitted",
				contentProof: "deterministic_tts",
			});
		await h.adapter.open("context");
		const event = {
			resultEventId: "result-1",
			seq: 1,
			handoffId: "handoff-1",
			requestDigest: "request-digest",
			sourceLeadId: "flywheel-eng-lead",
			sourceDeliveryId: "delivery-1",
			resultKind: "lead_reply",
			text: "Lead 的原话",
			createdAt: "2026-09-24T00:00:00.000Z",
		} satisfies VoiceHandoffResultEvent;
		const binding = {
			handoffId: "handoff-1",
			requestDigest: "request-digest",
			targetLeadId: "flywheel-eng-lead",
			sessionId: "voice-session",
			generation: 9,
		};

		await expect(
			h.adapter.applyLeadResult(event, binding),
		).resolves.toMatchObject({
			outcome: "failed",
		});
		await expect(
			h.adapter.applyLeadResult(event, binding),
		).resolves.toMatchObject({
			outcome: "completed",
		});
		expect(h.speech.speak).toHaveBeenCalledTimes(2);
		expect(h.utterances.at(-1)).toMatchObject({
			text: "Lead 的原话",
			source: "lead:flywheel-eng-lead",
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

	it("drops sixty seconds of unattributed uplink during a long announcer takeover", async () => {
		const h = harness();
		const spoken = deferred<SpeakReceipt>();
		h.speech.speak.mockImplementationOnce(() => spoken.promise);
		await h.adapter.open("context");

		const speaking = h.adapter.speak("四十秒长播报", "brief", {
			pendingKey: "brief-long",
			verification: "required",
		});
		await vi.waitFor(() => expect(h.live.suspend).toHaveBeenCalledOnce());
		for (let second = 0; second < 60; second += 1) {
			h.room.emitFrame({
				pcm: Buffer.alloc(48_000),
				format: PCM,
				sessionId: "voice-session",
				generation: 9,
				sequence: second,
				capturedAt: 1_200 + second * 1_000,
				utteranceId: null,
				attribution: { kind: "unknown", reason: "no_active_speaker" },
			});
		}
		h.room.emitFrame({
			pcm: Buffer.from([7, 0]),
			format: PCM,
			sessionId: "voice-session",
			generation: 9,
			sequence: 60,
			capturedAt: 61_200,
			utteranceId: "u1",
			attribution: { kind: "known", speakerUserId: "founder-1" },
		});

		expect(h.record).not.toHaveBeenCalledWith(
			expect.objectContaining({ kind: "live_lead_input_buffer_overflow" }),
		);
		expect(h.room.io.status).not.toHaveBeenCalledWith("语音暂不可用，请重说");
		spoken.resolve({
			pendingKey: "brief-long",
			requestDigest: "speech-digest",
			outcome: "completed",
			transport: "submitted",
			contentProof: "deterministic_tts",
		});
		await speaking;
		expect(h.live.audioSent).toEqual([Buffer.from([7, 0])]);
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

	it("reports the Live face unavailable when resume fails instead of wedging it suspended", async () => {
		const h = harness({ maxSuspendedInputMs: 1 });
		await h.adapter.open("context");
		h.live.resume.mockRejectedValueOnce(new Error("socket connect failed"));

		const first = await h.adapter.speak("播报", "brief", {
			pendingKey: "brief-1",
			verification: "required",
		});
		expect(first.outcome).toBe("completed");
		expect(h.onUnavailable).toHaveBeenCalledExactlyOnceWith(
			"live_resume_failed",
		);
		expect(h.record).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "live_lead_voice_unavailable",
				cause: "live_resume_failed",
			}),
		);

		h.live.suspend.mockClear();
		const next = await h.adapter.speak("第二条", "brief", {
			pendingKey: "brief-2",
			verification: "required",
		});
		expect(next).toMatchObject({
			outcome: "failed",
			reason: "live_voice_unavailable",
		});
		expect(h.live.suspend).not.toHaveBeenCalled();
		for (let i = 0; i < 4; i += 1) {
			h.room.emitFrame({
				sessionId: "voice-session",
				generation: 9,
				pcm: Buffer.alloc(48),
				format: PCM,
				attribution: { kind: "known", speakerUserId: "founder-1" },
			});
		}
		expect(h.room.io.status).not.toHaveBeenCalled();
		expect(h.onUnavailable).toHaveBeenCalledOnce();
	});

	it("reports the Live face unavailable when the admitted generation is lost mid-session", async () => {
		const h = harness();
		await h.adapter.open("context");

		h.live.emit(
			"error",
			Object.assign(new Error("duplicate session.started"), {
				code: "backend-protocol",
			}),
		);
		expect(h.onUnavailable).not.toHaveBeenCalled();

		h.live.effectiveCapabilities.turnCancelOrSuppress = false;
		h.live.emit(
			"error",
			Object.assign(new Error("provider closed the active session"), {
				code: "connection-closed",
			}),
		);
		expect(h.onUnavailable).toHaveBeenCalledExactlyOnceWith(
			"live_connection_lost",
		);
		expect(h.record).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "live_lead_voice_unavailable",
				cause: "live_connection_lost",
			}),
		);
		h.live.emit("error", new Error("late duplicate"));
		expect(h.onUnavailable).toHaveBeenCalledOnce();
	});

	it("emits the founder's own turn before the frontend's final caption when nothing is delegated", async () => {
		const h = harness();
		await h.adapter.open("context");
		h.room.emitUtterance({
			sessionId: "voice-session",
			generation: 9,
			utteranceId: "u-exit",
			attribution: { kind: "known", speakerUserId: "founder-1" },
			observedAt: 1_100,
			phase: "start",
		});
		h.live.emitLiveTranscript({
			type: "transcript-delta",
			direction: "input",
			generation: 1,
			eventId: "exit-delta",
			startMs: 100,
			endMs: 200,
			delta: "我要退出语音",
		});
		h.room.emitUtterance({
			sessionId: "voice-session",
			generation: 9,
			utteranceId: "u-exit",
			attribution: { kind: "known", speakerUserId: "founder-1" },
			observedAt: 1_250,
			phase: "end",
		});
		h.live.emit("transcript", {
			role: "assistant",
			text: "好，退出语音模式。",
			final: true,
		});
		h.live.emit("transcript", {
			role: "assistant",
			text: "还有别的吗",
			final: true,
		});

		expect(h.utterances.map((u) => ({ role: u.role, text: u.text }))).toEqual([
			{ role: "user", text: "我要退出语音" },
			{ role: "assistant", text: "好，退出语音模式。" },
			{ role: "assistant", text: "还有别的吗" },
		]);
		expect(h.utterances[0]).toMatchObject({
			final: true,
			utteranceId: "u-exit",
			attribution: { kind: "known", speakerUserId: "founder-1" },
		});
	});

	it("closes a real HeadphoneSession on the spoken exit sentence under Engine A", async () => {
		const h = harness();
		const onSpokenExit = vi.fn();
		const session = createEngineAHeadphoneSession({
			binding: {
				sessionId: "voice-session",
				generation: 9,
				leaseToken: "lease",
			},
			founderUserId: "founder-1",
			bridge: {
				...agendaStubs(),
				handoffToLead: vi.fn(),
				subscribeReplies: vi.fn(() => () => undefined),
			} as never,
			room: h.room.io,
			mode: "headphone",
			transcriptSink: h.transcriptSink as never,
			baseInstructions: "Engine A",
			createEngine: () => h.adapter,
			captionSink: { caption: vi.fn() },
			record: vi.fn(),
			onSpokenExit,
		});
		await session.start();
		const providerGeneration = h.live.providerGeneration as number;
		h.room.emitUtterance({
			sessionId: "voice-session",
			generation: 9,
			utteranceId: "u-exit",
			attribution: { kind: "known", speakerUserId: "founder-1" },
			observedAt: 1_100,
			phase: "start",
		});
		h.live.emitLiveTranscript({
			type: "transcript-delta",
			direction: "input",
			generation: providerGeneration,
			eventId: "exit-delta",
			startMs: 100,
			endMs: 200,
			delta: "我要退出语音",
		});
		h.room.emitUtterance({
			sessionId: "voice-session",
			generation: 9,
			utteranceId: "u-exit",
			attribution: { kind: "known", speakerUserId: "founder-1" },
			observedAt: 1_250,
			phase: "end",
		});
		h.live.emit("transcript", {
			role: "assistant",
			text: "好，退出语音模式。",
			final: true,
		});

		await vi.waitFor(() => expect(onSpokenExit).toHaveBeenCalledOnce());
		await session.close();
	});

	it("holds announcer speech until the founder's turn is answered and its audio drained", async () => {
		const h = harness();
		await h.adapter.open("context");
		founderSays(h, "u-q", "一加一等于几", { end: false });
		const announcement = h.adapter.speak("播报第一条", "brief", {
			pendingKey: "brief-1",
			verification: "required",
		});
		await tick();
		expect(h.speech.speak).not.toHaveBeenCalled();

		endUtterance(h, "u-q", 1_250);
		await tick();
		expect(h.speech.speak).not.toHaveBeenCalled();

		h.room.tail.drained = false;
		h.room.tail.remainingMs = 40;
		h.live.emit("response-started");
		h.live.emit("transcript", {
			role: "assistant",
			text: "等于二",
			final: true,
		});
		await tick();
		expect(h.speech.speak).not.toHaveBeenCalled();

		h.room.tail.drained = true;
		h.room.tail.remainingMs = 0;
		await expect(announcement).resolves.toMatchObject({ outcome: "completed" });
		expect(h.speech.speak).toHaveBeenCalledOnce();
		expect(h.utterances.map((u) => ({ role: u.role, text: u.text }))).toEqual([
			{ role: "user", text: "一加一等于几" },
			{ role: "assistant", text: "等于二" },
		]);
	});

	it("keeps the founder's turn open through a Lead cue until the delegation is handled", async () => {
		const h = harness();
		await h.adapter.open("context");
		founderSays(h, "u1", "帮我查一下状态");
		h.live.emit("transcript", {
			role: "assistant",
			text: "我问下 Lead",
			final: true,
		});
		const announcement = h.adapter.speak("播报第一条", "brief", {
			pendingKey: "brief-1",
			verification: "required",
		});
		await tick();
		expect(h.speech.speak).not.toHaveBeenCalled();

		h.live.emit("delegation-created", {
			delegationId: "provider-1",
			generation: 1,
			offsetMs: 200,
			target: "client",
		});
		await expect(announcement).resolves.toMatchObject({ outcome: "completed" });
		expect(h.handoffs).toHaveLength(1);
		expect(vi.mocked(h.speech.speak).mock.calls.map(([text]) => text)).toEqual([
			"我问下 Lead",
			"播报第一条",
		]);
	});

	it("does not let an utterance whose end was lost hold the founder turn forever", async () => {
		const h = harness();
		await h.adapter.open("context");
		h.room.emitUtterance({
			sessionId: "voice-session",
			generation: 9,
			utteranceId: "u-abandoned",
			attribution: { kind: "known", speakerUserId: "founder-1" },
			observedAt: 1_000,
			phase: "start",
		});
		founderSays(h, "u-next", "一加一等于几");
		const announcement = h.adapter.speak("播报第一条", "brief", {
			pendingKey: "brief-1",
			verification: "required",
		});
		h.live.emit("transcript", {
			role: "assistant",
			text: "等于二",
			final: true,
		});

		await expect(announcement).resolves.toMatchObject({ outcome: "completed" });
	});

	it("settles an answered founder turn even if the room cannot report its audible tail", async () => {
		const h = harness();
		await h.adapter.open("context");
		vi.mocked(h.room.io.audibleTail).mockImplementation(() => {
			throw new Error("tail unavailable");
		});
		founderSays(h, "u-q", "一加一等于几");
		const announcement = h.adapter.speak("播报第一条", "brief", {
			pendingKey: "brief-1",
			verification: "required",
		});
		h.live.emit("transcript", {
			role: "assistant",
			text: "等于二",
			final: true,
		});

		await expect(announcement).resolves.toMatchObject({ outcome: "completed" });
		expect(h.record).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "live_lead_audible_tail_unavailable" }),
		);
	});

	it("does not count an interrupted frontend final as the answer to her follow-up", async () => {
		const h = harness();
		await h.adapter.open("context");
		founderSays(h, "u-first", "一加一等于几");
		h.live.emit("transcript", {
			role: "assistant",
			text: "等于二",
			final: true,
		});
		await tick();

		h.live.emit("response-started");
		h.room.emitUtterance({
			sessionId: "voice-session",
			generation: 9,
			utteranceId: "u-follow",
			attribution: { kind: "known", speakerUserId: "founder-1" },
			observedAt: 2_000,
			phase: "start",
		});
		h.room.emitBarge({
			sessionId: "voice-session",
			generation: 9,
			utteranceId: "u-follow",
			owner: { kind: "known", speakerUserId: "founder-1" },
			startedAt: 2_000,
			observedAt: 2_300,
			durationMs: 300,
			phase: "sustained",
		} as never);
		h.live.emit("transcript", {
			role: "assistant",
			text: "另外还有",
			final: true,
			interrupted: true,
		});
		const announcement = h.adapter.speak("播报第一条", "brief", {
			pendingKey: "brief-1",
			verification: "required",
		});
		endUtterance(h, "u-follow", 2_600);
		await tick();
		expect(h.speech.speak).not.toHaveBeenCalled();

		h.live.emit("transcript", { role: "assistant", text: "是三", final: true });
		await expect(announcement).resolves.toMatchObject({ outcome: "completed" });
	});

	it("bounds the founder-turn hold when a response never finalizes or an utterance never ends", async () => {
		const h = harness({ founderTurnMaxHoldMs: 60 });
		await h.adapter.open("context");
		founderSays(h, "u-stuck", "一加一等于几");
		h.live.emit("response-started");
		const first = h.adapter.speak("播报第一条", "brief", {
			pendingKey: "brief-1",
			verification: "required",
		});
		await tick();
		expect(h.speech.speak).not.toHaveBeenCalled();
		await expect(first).resolves.toMatchObject({ outcome: "completed" });

		h.room.emitUtterance({
			sessionId: "voice-session",
			generation: 9,
			utteranceId: "u-open",
			attribution: { kind: "known", speakerUserId: "founder-1" },
			observedAt: 3_000,
			phase: "start",
		});
		const second = h.adapter.speak("播报第二条", "brief", {
			pendingKey: "brief-2",
			verification: "required",
		});
		await expect(second).resolves.toMatchObject({ outcome: "completed" });
		expect(
			h.record.mock.calls.filter(
				([event]) => event.kind === "live_lead_founder_turn_hold_exceeded",
			),
		).toHaveLength(2);
	});

	it("binds a complex question spoken over a readback to her window after the buffered replay", async () => {
		const h = harness();
		await h.adapter.open("context");
		let releaseReadback: ((receipt: SpeakReceipt) => void) | undefined;
		h.speech.speak.mockImplementation(async (_text, kind, opts) => {
			const completed: SpeakReceipt = {
				pendingKey: opts.pendingKey,
				requestDigest: "speech-digest",
				outcome: "completed",
				transport: "submitted",
				contentProof: "deterministic_tts",
			};
			if (kind !== "brief") return completed;
			return new Promise<SpeakReceipt>((resolve) => {
				releaseReadback = resolve;
			});
		});
		h.speech.cancel.mockImplementation((reason: string) => {
			releaseReadback?.({
				pendingKey: "brief-1:0",
				requestDigest: "speech-digest",
				outcome: "failed",
				reason,
				transport: "none",
				contentProof: "none",
			});
			releaseReadback = undefined;
		});
		const readback = h.adapter.speak("很长的一条汇报", "brief", {
			pendingKey: "brief-1:0",
			verification: "required",
		});
		await vi.waitFor(() => expect(releaseReadback).toBeDefined());

		// She talks over the readback from 10.0 s; Live is suspended, so her
		// first second is buffered with its capture times.
		h.room.emitUtterance({
			sessionId: "voice-session",
			generation: 9,
			utteranceId: "u-complex",
			attribution: { kind: "known", speakerUserId: "founder-1" },
			observedAt: 10_000,
			phase: "start",
		});
		const founderFrame = (capturedAt: number) => ({
			sessionId: "voice-session",
			generation: 9,
			sequence: capturedAt,
			pcm: Buffer.alloc(960, 1),
			format: PCM,
			capturedAt,
			utteranceId: "u-complex",
			attribution: { kind: "known", speakerUserId: "founder-1" },
		});
		for (let t = 10_000; t < 11_000; t += 20) h.room.emitFrame(founderFrame(t));
		// Live resumes at 11.5 s and replays the buffered second first.
		h.setNow(11_500);
		h.room.emitBarge({
			sessionId: "voice-session",
			generation: 9,
			utteranceId: "u-complex",
			owner: { kind: "known", speakerUserId: "founder-1" },
			startedAt: 10_000,
			observedAt: 10_400,
			durationMs: 400,
			phase: "sustained",
		} as never);
		await expect(readback).resolves.toMatchObject({ reason: "barge-in" });
		await vi.waitFor(() => expect(h.live.resume).toHaveBeenCalledOnce());
		for (let t = 11_500; t < 13_000; t += 20) h.room.emitFrame(founderFrame(t));
		endUtterance(h, "u-complex", 13_800);
		const generation = h.live.providerGeneration as number;
		h.live.emitLiveTranscript({
			type: "transcript-delta",
			direction: "input",
			generation,
			eventId: "complex-delta",
			startMs: 0,
			endMs: 2_500,
			delta: "帮我查一下 FLY-2798 现在的 PR 状态",
		});
		// The provider marks the delegation ~0.5 s after her speech ends:
		// provider offset 3.0 s = 1.0 s replayed + 2.0 s of live audio.
		h.live.emit("delegation-created", {
			delegationId: "provider-complex",
			generation,
			offsetMs: 3_000,
			target: "client",
		});

		await vi.waitFor(() => expect(h.handoffs).toHaveLength(1));
		expect(h.handoffs[0]?.originalText).toBe(
			"帮我查一下 FLY-2798 现在的 PR 状态",
		);
		expect(h.record).not.toHaveBeenCalledWith(
			expect.objectContaining({ kind: "live_lead_clarification_required" }),
		);
	});

	it("tells her when a delegation cannot be attributed instead of dropping it silently", async () => {
		const h = harness();
		await h.adapter.open("context");
		founderSays(h, "u1", "帮我查一下状态");
		h.live.emit("delegation-created", {
			delegationId: "provider-unbound",
			generation: 1,
			offsetMs: 5_000,
			target: "client",
		});

		await vi.waitFor(() =>
			expect(h.record).toHaveBeenCalledWith(
				expect.objectContaining({
					kind: "live_lead_clarification_prompted",
					reason: "delegation_not_uniquely_attributed",
					outcome: "completed",
				}),
			),
		);
		expect(
			vi.mocked(h.speech.speak).mock.calls.map(([text]) => text),
		).toContain("刚才那句我没对上，你再说一次。");
		expect(h.utterances).toContainEqual(
			expect.objectContaining({
				role: "assistant",
				source: "frontend",
				text: "刚才那句我没对上，你再说一次。",
			}),
		);
		expect(h.handoffs).toHaveLength(0);
	});

	it("tells her when a delegation arrives without an offset", async () => {
		const h = harness();
		await h.adapter.open("context");
		founderSays(h, "u1", "帮我查一下状态");
		h.live.emit("delegation-created", {
			delegationId: "provider-no-offset",
			generation: 1,
			target: "client",
		});

		await vi.waitFor(() =>
			expect(h.record).toHaveBeenCalledWith(
				expect.objectContaining({
					kind: "live_lead_clarification_prompted",
					reason: "delegation_offset_missing",
				}),
			),
		);
		expect(
			vi.mocked(h.speech.speak).mock.calls.map(([text]) => text),
		).toContain("刚才那句我没对上，你再说一次。");
		expect(h.live.resume).toHaveBeenCalled();
	});

	it("tells her when the frontend promised Lead but never delegated", async () => {
		const h = harness({ founderTurnSettleTimeoutMs: 30 });
		await h.adapter.open("context");
		founderSays(h, "u1", "帮我查一下状态");
		h.live.emit("transcript", {
			role: "assistant",
			text: "我问下 Lead",
			final: true,
		});

		await vi.waitFor(() =>
			expect(
				vi.mocked(h.speech.speak).mock.calls.map(([text]) => text),
			).toContain("刚才那句我没能交给 Lead，你再说一次。"),
		);
		expect(h.record).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "live_lead_cue_without_delegation" }),
		);
	});

	it("releases an unanswered founder turn after the settle timeout and records it", async () => {
		const h = harness({ founderTurnSettleTimeoutMs: 30 });
		await h.adapter.open("context");
		founderSays(h, "u-noise", "嗯");
		const announcement = h.adapter.speak("播报第一条", "brief", {
			pendingKey: "brief-1",
			verification: "required",
		});
		await tick();
		expect(h.speech.speak).not.toHaveBeenCalled();

		await expect(announcement).resolves.toMatchObject({ outcome: "completed" });
		expect(h.record).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "live_lead_founder_turn_unanswered" }),
		);
	});

	it("FLY-2863: a barge-in during an agenda say cancels it and her turn goes to the Lead, never the inbox", async () => {
		const h = harness();
		const inbox = {
			listHeadphoneItems: vi.fn(async () => []),
			claimHeadphoneItem: vi.fn(async () => undefined),
			ackHeadphoneClaim: vi.fn(async () => undefined),
		};
		const stubs = agendaStubs({
			items: [blockedItem()],
			results: {
				"agenda-1": [
					{
						resultEventId: "r1",
						seq: 1,
						handoffId: "agenda-1",
						requestDigest: "d",
						sourceLeadId: "flywheel-eng-lead",
						sourceDeliveryId: "x",
						resultKind: "agenda_say",
						text: "一张受阻，卡在权限，要你授权。",
						agenda: { kind: "say", itemKey: "blocked:I1:t" },
						createdAt: "2026-09-24T00:00:01.000Z",
					},
				],
			},
		});
		const handoffToLead = vi.fn(
			async (_binding, request: VoiceHandoffRequest) => ({
				handoffId: request.handoffId,
				requestDigest: request.requestDigest,
				state: "committed" as const,
				providerOperationId: "mailbox-1",
			}),
		);
		const wakes: Array<(event: { handoffId: string }) => void> = [];
		const wake = (event: { handoffId: string }) => {
			for (const listener of wakes) listener(event);
		};
		const bridge = {
			...inbox,
			...stubs,
			handoffToLead,
			subscribeReplies: vi.fn((_binding, listener) => {
				wakes.push(listener);
				return () => undefined;
			}),
		};
		let pending:
			| { pendingKey: string; resolve(receipt: SpeakReceipt): void }
			| undefined;
		h.speech.speak.mockImplementation(
			async (_text, _kind, opts) =>
				new Promise<SpeakReceipt>((resolve) => {
					pending = { pendingKey: opts.pendingKey, resolve };
				}),
		);
		h.speech.cancel.mockImplementation((reason: string) => {
			const current = pending;
			pending = undefined;
			current?.resolve({
				pendingKey: current.pendingKey,
				requestDigest: "speech-digest",
				outcome: "failed",
				reason,
				transport: "none",
				contentProof: "none",
			});
		});
		const record = vi.fn();
		let callbacks!: Parameters<
			Parameters<typeof createEngineAHeadphoneSession>[0]["createEngine"]
		>[0];
		const session = createEngineAHeadphoneSession({
			binding: {
				sessionId: "voice-session",
				generation: 9,
				leaseToken: "lease",
			},
			founderUserId: "founder-1",
			bridge: bridge as never,
			room: h.room.io,
			mode: "headphone",
			transcriptSink: h.transcriptSink as never,
			baseInstructions: "Engine A",
			createEngine: (value) => {
				callbacks = value;
				return new LiveLeadAdapter({
					sessionId: "voice-session",
					generation: 9,
					projectName: "flywheel",
					founderUserId: "founder-1",
					targetLeadId: "flywheel-eng-lead",
					room: h.room.io,
					createConversation: vi.fn(async () => h.live),
					transcriptSink: h.transcriptSink as never,
					speech: h.speech,
					classifyIntent: () => "query",
					submitHandoff: value.submitHandoff,
					registerHandoff: value.registerHandoff,
					agendaTurns: value.agendaTurns,
					record,
					now: () => 1_000,
				});
			},
			captionSink: { caption: vi.fn() },
			record,
		});
		await session.start();
		wake({ handoffId: "agenda-1" });
		await vi.waitFor(() => expect(pending).toBeDefined());

		h.room.emitUtterance({
			sessionId: "voice-session",
			generation: 9,
			utteranceId: "u-barge",
			attribution: { kind: "known", speakerUserId: "founder-1" },
			observedAt: 1_100,
			phase: "start",
		});
		h.room.emitBarge({
			sessionId: "voice-session",
			generation: 9,
			utteranceId: "u-barge",
			owner: { kind: "known", speakerUserId: "founder-1" },
			startedAt: 1_100,
			observedAt: 1_400,
			durationMs: 300,
			phase: "sustained",
		} as never);
		await vi.waitFor(() =>
			expect(record).toHaveBeenCalledWith(
				expect.objectContaining({ kind: "agenda_speech_interrupted" }),
			),
		);
		expect(stubs.bindAgendaTurn).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				utteranceId: "u-barge",
				itemKey: "blocked:I1:t",
			}),
		);
		h.live.emitLiveTranscript({
			type: "transcript-delta",
			direction: "input",
			generation: h.live.providerGeneration as number,
			eventId: "barge-delta",
			startMs: 100,
			endMs: 200,
			delta: "好，授权",
		});
		endUtterance(h, "u-barge", 1_250);
		h.live.emit("response-started");
		h.live.emit("transcript", {
			role: "assistant",
			text: "好的我来授权",
			final: true,
		});
		await vi.waitFor(() => expect(handoffToLead).toHaveBeenCalledOnce());
		expect(handoffToLead.mock.calls[0]?.[1].originalText).toBe("好，授权");
		expect(callbacks.agendaTurns.bindTurn("u-barge")).toEqual({
			owner: "agenda",
			itemKey: "blocked:I1:t",
		});
		expect(inbox.listHeadphoneItems).not.toHaveBeenCalled();
		expect(inbox.claimHeadphoneItem).not.toHaveBeenCalled();
		expect(h.room.io.writeSpeech).not.toHaveBeenCalled();
		await session.close();
	}, 15_000);

	it("closes promptly and claims nothing while an inbox pull waits on the founder's turn", async () => {
		const h = harness();
		const items: Array<{
			id: string;
			revision: number;
			createdAt: string;
			needsDecision: boolean;
			text: string;
		}> = [];
		const bridge = {
			listHeadphoneItems: vi.fn(async () => [...items]),
			claimHeadphoneItem: vi.fn(async () => undefined),
			ackHeadphoneClaim: vi.fn(async () => undefined),
			getHeadphoneSourceHealth: vi.fn(async () => ({
				healthy: true,
				sourceGap: false,
				sources: [],
			})),
			handoffToLead: vi.fn(),
			...agendaStubs(),
			subscribeReplies: vi.fn(() => () => undefined),
		};
		const session = createEngineAHeadphoneSession({
			binding: {
				sessionId: "voice-session",
				generation: 9,
				leaseToken: "lease",
			},
			founderUserId: "founder-1",
			bridge: bridge as never,
			room: h.room.io,
			mode: "headphone",
			transcriptSink: h.transcriptSink as never,
			baseInstructions: "Engine A",
			createEngine: () => h.adapter,
			captionSink: { caption: vi.fn() },
			record: vi.fn(),
		});
		await session.start();
		founderSays(h, "u-leaving", "我先走了", { end: false });
		items.push({
			id: "item-a",
			revision: 1,
			createdAt: "2026-09-24T00:00:00.000Z",
			needsDecision: false,
			text: "一条新消息。",
		});
		await new Promise((resolve) => setTimeout(resolve, 1_300));

		const closed = await Promise.race([
			session.close().then(() => "closed"),
			new Promise((resolve) => setTimeout(() => resolve("hung"), 1_000)),
		]);
		expect(closed).toBe("closed");
		expect(bridge.claimHeadphoneItem).not.toHaveBeenCalled();
	}, 10_000);

	it("closes promptly while a Lead reply readback waits on the founder's turn", async () => {
		const h = harness();
		let replyListener:
			| ((event: {
					sessionId: string;
					generation: number;
					handoffId: string;
			  }) => void)
			| undefined;
		let registerHandoff!: (binding: {
			sessionId: string;
			generation: number;
			handoffId: string;
			requestDigest: string;
			targetLeadId: string;
		}) => void;
		const bridge = {
			listHeadphoneItems: vi.fn(async () => []),
			claimHeadphoneItem: vi.fn(async () => undefined),
			ackHeadphoneClaim: vi.fn(async () => undefined),
			getHeadphoneSourceHealth: vi.fn(async () => ({
				healthy: true,
				sourceGap: false,
				sources: [],
			})),
			...agendaStubs(),
			handoffToLead: vi.fn(),
			listVoiceHandoffResults: vi.fn(async () => ({
				events: [
					{
						resultEventId: "result-1",
						seq: 1,
						handoffId: "handoff-1",
						requestDigest: "request-digest",
						sourceLeadId: "flywheel-eng-lead",
						sourceDeliveryId: "delivery-1",
						resultKind: "lead_reply",
						text: "Lead 的回复",
						createdAt: "2026-09-24T00:00:01.000Z",
					},
				],
				highWatermark: 1,
				nextCursor: 1,
			})),
			subscribeReplies: vi.fn((_binding, listener) => {
				replyListener = listener;
				return () => undefined;
			}),
		};
		const session = createEngineAHeadphoneSession({
			binding: {
				sessionId: "voice-session",
				generation: 9,
				leaseToken: "lease",
			},
			founderUserId: "founder-1",
			bridge: bridge as never,
			room: h.room.io,
			mode: "headphone",
			transcriptSink: h.transcriptSink as never,
			baseInstructions: "Engine A",
			createEngine: (callbacks) => {
				registerHandoff = callbacks.registerHandoff;
				return h.adapter;
			},
			captionSink: { caption: vi.fn() },
			record: vi.fn(),
		});
		await session.start();
		founderSays(h, "u-talking", "还有一件事", { end: false });
		registerHandoff({
			sessionId: "voice-session",
			generation: 9,
			handoffId: "handoff-1",
			requestDigest: "request-digest",
			targetLeadId: "flywheel-eng-lead",
		});
		replyListener?.({
			sessionId: "voice-session",
			generation: 9,
			handoffId: "handoff-1",
		});
		await vi.waitFor(() =>
			expect(bridge.listVoiceHandoffResults).toHaveBeenCalled(),
		);
		await tick();

		const closed = await Promise.race([
			session.close().then(() => "closed"),
			new Promise((resolve) => setTimeout(() => resolve("hung"), 1_000)),
		]);
		expect(closed).toBe("closed");
	}, 10_000);
});

function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 20));
}

function endUtterance(
	h: ReturnType<typeof harness>,
	utteranceId: string,
	observedAt: number,
): void {
	h.room.emitUtterance({
		sessionId: "voice-session",
		generation: 9,
		utteranceId,
		attribution: { kind: "known", speakerUserId: "founder-1" },
		observedAt,
		phase: "end",
	});
}

function founderSays(
	h: ReturnType<typeof harness>,
	utteranceId: string,
	text: string,
	options: { end?: boolean } = {},
): void {
	h.room.emitUtterance({
		sessionId: "voice-session",
		generation: 9,
		utteranceId,
		attribution: { kind: "known", speakerUserId: "founder-1" },
		observedAt: 1_100,
		phase: "start",
	});
	h.live.emitLiveTranscript({
		type: "transcript-delta",
		direction: "input",
		generation: h.live.providerGeneration as number,
		eventId: `delta-${utteranceId}`,
		startMs: 100,
		endMs: 200,
		delta: text,
	});
	if (options.end !== false) endUtterance(h, utteranceId, 1_250);
}

describe("LiveLeadAdapter — agenda-owned turns (FLY-2863 §4.4)", () => {
	function router(owner: "agenda" | "front") {
		const bound: string[] = [];
		const waited: string[] = [];
		const agendaTurns: AgendaTurnRouter = {
			bindTurn: (utteranceId) => {
				bound.push(utteranceId);
				return owner === "agenda"
					? { owner, itemKey: "blocked:I1:t" }
					: { owner, itemKey: null };
			},
			whenTurnBound: async (utteranceId) => {
				waited.push(utteranceId);
			},
		};
		return { agendaTurns, bound, waited };
	}

	function speakTurn(h: ReturnType<typeof harness>, text: string) {
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
			delta: text,
		});
		h.room.emitUtterance({
			sessionId: "voice-session",
			generation: 9,
			utteranceId: "u1",
			attribution: { kind: "known", speakerUserId: "founder-1" },
			observedAt: 1_250,
			phase: "end",
		});
	}

	function frontendAnswers(h: ReturnType<typeof harness>, text: string) {
		h.live.emit("response-started");
		h.live.emit("response-audio", Buffer.from([1, 0]), PCM);
		h.live.emit("transcript", { role: "assistant", text, final: true });
	}

	it("silences a frontend that answers an agenda turn and hands her words to the Lead once", async () => {
		const r = router("agenda");
		const h = harness({ agendaTurns: r.agendaTurns });
		await h.adapter.open("context");
		speakTurn(h, "好，授权");
		frontendAnswers(h, "好的，我帮你授权了。");
		await vi.waitFor(() => expect(h.handoffs).toHaveLength(1));
		expect(r.bound).toEqual(["u1"]);
		expect(r.waited).toEqual(["u1"]);
		expect(h.handoffs[0]?.originalText).toBe("好，授权");
		expect(h.handoffBindings[0]?.agendaUtteranceId).toBe("u1");
		// Zero frontend playback, no frontend caption, no "我问下 Lead" cue.
		expect(h.room.io.startSpeech).not.toHaveBeenCalled();
		expect(h.room.io.writeSpeech).not.toHaveBeenCalled();
		expect(
			h.utterances.filter(
				(u) => u.role === "assistant" && u.source === "frontend",
			),
		).toEqual([]);
		expect(h.speech.speak).not.toHaveBeenCalled();
		expect(h.record).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "live_frontend_answer_suppressed" }),
		);
		await h.adapter.close();
	});

	it("a delegation for an agenda turn that was already handed off is not sent twice", async () => {
		const r = router("agenda");
		const h = harness({ agendaTurns: r.agendaTurns });
		await h.adapter.open("context");
		speakTurn(h, "好，授权");
		frontendAnswers(h, "我问下 Lead");
		await vi.waitFor(() => expect(h.handoffs).toHaveLength(1));
		h.live.emit("delegation-created", {
			delegationId: "provider-1",
			generation: 1,
			offsetMs: 200,
			target: "client",
		});
		await vi.waitFor(() =>
			expect(h.record).toHaveBeenCalledWith(
				expect.objectContaining({
					kind: "live_delegation_deduplicated_for_agenda",
				}),
			),
		);
		expect(h.handoffs).toHaveLength(1);
		await h.adapter.close();
	});

	it("a Live delegation of an agenda turn is the one handoff, without the cue", async () => {
		const r = router("agenda");
		const h = harness({ agendaTurns: r.agendaTurns });
		await h.adapter.open("context");
		speakTurn(h, "那就先放着");
		h.live.emit("delegation-created", {
			delegationId: "provider-1",
			generation: 1,
			offsetMs: 200,
			target: "client",
		});
		await vi.waitFor(() => expect(h.handoffs).toHaveLength(1));
		h.live.emit("transcript", {
			role: "assistant",
			text: "我问下 Lead",
			final: true,
		});
		await new Promise((resolve) => setImmediate(resolve));
		expect(h.handoffs).toHaveLength(1);
		expect(h.handoffBindings[0]?.agendaUtteranceId).toBe("u1");
		expect(h.speech.speak).not.toHaveBeenCalledWith(
			"我问下 Lead",
			"cue",
			expect.anything(),
		);
		await h.adapter.close();
	});

	it("a failed Bridge commit is heard as 'say it again', never swallowed", async () => {
		const r = router("agenda");
		const h = harness({
			agendaTurns: r.agendaTurns,
			submitHandoff: async () => {
				throw new Error("bridge_unreachable");
			},
		});
		await h.adapter.open("context");
		speakTurn(h, "好，授权");
		frontendAnswers(h, "好的");
		await vi.waitFor(() =>
			expect(
				vi.mocked(h.speech.speak).mock.calls.map(([text]) => text),
			).toContain("刚才那句我没能交给 Lead，你再说一次。"),
		);
		expect(h.handoffBindings).toEqual([]);
		expect(h.record).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "live_agenda_handoff_failed",
				message: "bridge_unreachable",
			}),
		);
		await h.adapter.close();
	});

	it("a failed turn binding fails closed: no unbound handoff reaches the Lead", async () => {
		const submitted: VoiceHandoffRequest[] = [];
		const h = harness({
			agendaTurns: {
				bindTurn: () => ({ owner: "agenda", itemKey: "blocked:I1:t" }),
				whenTurnBound: async () => {
					throw new Error("voice agenda turn bind failed: HTTP 503");
				},
			},
			submitHandoff: async (request) => {
				submitted.push(request);
				return {
					handoffId: request.handoffId,
					requestDigest: request.requestDigest,
					state: "committed" as const,
					providerOperationId: "x",
				};
			},
		});
		await h.adapter.open("context");
		speakTurn(h, "那就先放着");
		frontendAnswers(h, "好");
		await vi.waitFor(() =>
			expect(
				vi.mocked(h.speech.speak).mock.calls.map(([text]) => text),
			).toContain("刚才那句我没能交给 Lead，你再说一次。"),
		);
		expect(submitted).toEqual([]);
		await h.adapter.close();
	});

	it("an idle turn keeps the frontend quick answer", async () => {
		const r = router("front");
		const h = harness({ agendaTurns: r.agendaTurns });
		await h.adapter.open("context");
		speakTurn(h, "现在几点");
		frontendAnswers(h, "三点。");
		await vi.waitFor(() => expect(h.room.io.writeSpeech).toHaveBeenCalled());
		expect(h.handoffs).toEqual([]);
		expect(h.utterances).toContainEqual(
			expect.objectContaining({ role: "assistant", text: "三点。" }),
		);
		await h.adapter.close();
	});
});
