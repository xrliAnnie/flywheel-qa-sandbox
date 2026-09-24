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
		status: vi.fn(),
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
		expect(h.live.interrupt).toHaveBeenCalledOnce();
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
