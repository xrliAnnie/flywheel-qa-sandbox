import { createHash, randomUUID } from "node:crypto";
import type {
	AudioFormat,
	DurableTranscriptSink,
	OpenAiLiveConversationSession,
	RoomIO,
	SpeakKind,
	SpeakReceipt,
	SpeakVerification,
	VoiceHandoffIntentKind,
	VoiceHandoffReceipt,
	VoiceHandoffRequest,
	VoiceHandoffResultEvent,
	VoiceUtterance,
	VoiceV1Capabilities,
	VoiceV1Session,
} from "flywheel-voice-core";
import {
	LiveUtteranceAssembler,
	voiceHandoffRequestDigest,
} from "flywheel-voice-core";

const PCM24 = {
	encoding: "pcm16",
	sampleRateHz: 24_000,
	channels: 1,
} as const;

export interface LiveLeadSpeech {
	speak(
		text: string,
		kind: SpeakKind,
		opts: { pendingKey: string; verification: SpeakVerification },
	): Promise<SpeakReceipt>;
	cancel(reason: string): void;
}

export interface LiveLeadAdapterOptions {
	sessionId: string;
	generation: number;
	projectName: string;
	founderUserId: string;
	targetLeadId: string;
	room: RoomIO;
	createConversation(
		initialSessionContext: string,
	): Promise<OpenAiLiveConversationSession>;
	transcriptSink: DurableTranscriptSink;
	speech: LiveLeadSpeech;
	classifyIntent(utterance: VoiceUtterance): VoiceHandoffIntentKind;
	submitHandoff(request: VoiceHandoffRequest): Promise<VoiceHandoffReceipt>;
	registerHandoff(binding: LiveLeadResultBinding): void;
	now?: () => number;
	nextId?: () => string;
	delegationEndTimeoutMs?: number;
	setTimeoutFn?: typeof setTimeout;
	clearTimeoutFn?: typeof clearTimeout;
	record(event: Record<string, unknown>): void;
}

export interface LiveLeadResultBinding {
	sessionId: string;
	generation: number;
	handoffId: string;
	requestDigest: string;
	targetLeadId: string;
}

interface FrontendSpeech {
	speechId: string;
	sequence: number;
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** V1 facade for Engine A. RoomIO remains the sole room owner; this adapter
 * connects it to one fenced OpenAI Live session, durable Lead handoff, and a
 * deterministic speech face. */
export class LiveLeadAdapter implements VoiceV1Session {
	readonly backendId = "openai-live";
	readonly capabilities: VoiceV1Capabilities = {
		audioIn: [PCM24],
		audioOut: [PCM24],
		onUtterance: true,
		verbatim: true,
		attribution: true,
		turnCancelOrSuppress: true,
	};
	readonly sessionId: string;
	readonly generation: number;

	private readonly now: () => number;
	private readonly nextId: () => string;
	private readonly assembler: LiveUtteranceAssembler;
	private readonly utteranceListeners = new Set<
		(utterance: VoiceUtterance) => void
	>();
	private readonly unsubscribers: Array<() => void> = [];
	private readonly delegationWork = new Map<string, Promise<void>>();
	private readonly speakWork = new Map<
		string,
		{ digest: string; promise: Promise<SpeakReceipt> }
	>();
	private readonly appliedResultEvents = new Set<string>();
	private readonly roomTimelineWaiters = new Set<() => void>();
	private readonly delegationEndTimeoutMs: number;
	private readonly setTimeoutFn: typeof setTimeout;
	private readonly clearTimeoutFn: typeof clearTimeout;
	private live?: OpenAiLiveConversationSession;
	private frontendSpeech?: FrontendSpeech;
	private outputWork: Promise<void> = Promise.resolve();
	private utteranceSequence = 0;
	private opened = false;
	private closing = false;

	constructor(private readonly options: LiveLeadAdapterOptions) {
		this.sessionId = options.sessionId;
		this.generation = options.generation;
		this.now = options.now ?? Date.now;
		this.nextId = options.nextId ?? randomUUID;
		this.delegationEndTimeoutMs = options.delegationEndTimeoutMs ?? 5_000;
		this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
		this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
		if (
			!Number.isSafeInteger(this.delegationEndTimeoutMs) ||
			this.delegationEndTimeoutMs < 1
		)
			throw new Error("live_lead_delegation_timeout_invalid");
		if (
			options.room.identity.sessionId !== options.sessionId ||
			options.room.identity.generation !== options.generation ||
			options.room.identity.roomIOVersion !== 1
		) {
			throw new Error("live_lead_room_binding_mismatch");
		}
		this.assembler = new LiveUtteranceAssembler({
			sessionId: options.sessionId,
			generation: options.generation,
			backendId: this.backendId,
		});
	}

	async open(initialSessionContext: string): Promise<void> {
		if (this.opened || this.closing) throw new Error("live_lead_already_open");
		if (!initialSessionContext.trim())
			throw new Error("live_lead_context_required");
		this.opened = true;
		try {
			await this.options.room.start();
			const providerStartedAt = this.now();
			this.live = await this.options.createConversation(initialSessionContext);
			const providerGeneration = this.live.providerGeneration;
			if (!providerGeneration)
				throw new Error("live_lead_generation_unavailable");
			this.assembler.startProviderGeneration(
				providerGeneration,
				providerStartedAt,
			);
			this.attach(this.live);
		} catch (error) {
			this.closing = true;
			await this.options.room.stop().catch(() => undefined);
			throw error;
		}
	}

	speak(
		text: string,
		kind: SpeakKind,
		opts: { pendingKey: string; verification: SpeakVerification },
	): Promise<SpeakReceipt> {
		const requestDigest = digest({
			sessionId: this.sessionId,
			generation: this.generation,
			text,
			kind,
			verification: opts.verification,
		});
		const prior = this.speakWork.get(opts.pendingKey);
		if (prior) {
			if (prior.digest === requestDigest) return prior.promise;
			return Promise.resolve({
				pendingKey: opts.pendingKey,
				requestDigest,
				outcome: "rejected",
				reason: "pending_key_conflict",
				transport: "none",
				contentProof: "none",
			});
		}
		const promise = this.runSpeak(text, kind, opts);
		this.speakWork.set(opts.pendingKey, { digest: requestDigest, promise });
		return promise;
	}

	onUtterance(listener: (utterance: VoiceUtterance) => void): () => void {
		this.utteranceListeners.add(listener);
		return () => this.utteranceListeners.delete(listener);
	}

	injectContext(text: string): void {
		this.requireLive().injectContext(text);
	}

	async applyLeadResult(
		event: VoiceHandoffResultEvent,
		binding: LiveLeadResultBinding,
	): Promise<SpeakReceipt> {
		if (
			binding.sessionId !== this.sessionId ||
			binding.generation !== this.generation ||
			event.handoffId !== binding.handoffId ||
			event.requestDigest !== binding.requestDigest ||
			event.sourceLeadId !== binding.targetLeadId ||
			!Number.isSafeInteger(event.seq) ||
			event.seq < 1
		) {
			throw new Error("live_lead_result_binding_mismatch");
		}
		const eventKey = `${event.handoffId}:${event.resultEventId}`;
		if (this.appliedResultEvents.has(eventKey)) {
			return this.speak(event.text, "readback", {
				pendingKey: `handoff-result:${eventKey}`,
				verification: "required",
			});
		}
		this.appliedResultEvents.add(eventKey);
		const receipt = await this.speak(event.text, "readback", {
			pendingKey: `handoff-result:${eventKey}`,
			verification: "required",
		});
		if (receipt.outcome === "completed") {
			this.emitUtterance({
				ts: event.createdAt,
				timestamp: event.createdAt,
				sessionId: this.sessionId,
				generation: this.generation,
				sequence: ++this.utteranceSequence,
				transcriptId: `lead:${event.resultEventId}`,
				utteranceId: `lead:${event.resultEventId}`,
				backendId: this.backendId,
				source: `lead:${event.sourceLeadId}`,
				face: "announce",
				role: "assistant",
				text: event.text,
				final: true,
				attribution: {
					kind: "known",
					speakerUserId: event.sourceLeadId,
				},
			});
		}
		return receipt;
	}

	async close(): Promise<void> {
		if (this.closing) return;
		this.closing = true;
		this.wakeRoomTimelineWaiters();
		this.options.speech.cancel("session-close");
		this.cancelFrontendSpeech();
		for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
		await Promise.allSettled([...this.delegationWork.values()]);
		await this.outputWork.catch(() => undefined);
		await this.live?.close();
		await this.options.room.stop();
		this.utteranceListeners.clear();
	}

	private attach(live: OpenAiLiveConversationSession): void {
		this.unsubscribers.push(
			this.options.room.onFrame((frame) => {
				if (
					this.closing ||
					frame.sessionId !== this.sessionId ||
					frame.generation !== this.generation
				)
					return;
				live.sendAudio(frame.pcm, frame.format);
			}),
			this.options.room.onUtterance((event) => {
				if (this.closing) return;
				this.assembler.observeRoom(event);
				this.wakeRoomTimelineWaiters();
				if (event.phase === "end") live.endUserTurn();
			}),
			this.options.room.onBargeIn((event) => {
				if (
					this.closing ||
					event.sessionId !== this.sessionId ||
					event.generation !== this.generation ||
					event.phase !== "sustained"
				)
					return;
				this.options.speech.cancel("barge-in");
				this.cancelFrontendSpeech();
				live.interrupt();
			}),
			live.on("response-started", () => this.startFrontendSpeech()),
			live.on("response-audio", (chunk, format) =>
				this.enqueueFrontendAudio(chunk, format),
			),
			live.on("response-cancelled", () => this.cancelFrontendSpeech()),
			live.on("response-done", () => this.endFrontendSpeech()),
			live.on("transcript", (event) => {
				if (event.role !== "assistant") return;
				const timestamp = new Date(this.now()).toISOString();
				this.emitUtterance({
					ts: timestamp,
					timestamp,
					sessionId: this.sessionId,
					generation: this.generation,
					sequence: ++this.utteranceSequence,
					transcriptId: `frontend:${this.generation}:${this.utteranceSequence}`,
					utteranceId: `frontend:${this.generation}:${this.utteranceSequence}`,
					backendId: this.backendId,
					source: "frontend",
					face: "converse",
					role: "assistant",
					text: event.text,
					final: event.final,
					...(event.interrupted ? { interrupted: true } : {}),
					attribution: { kind: "unknown", reason: "assistant_output" },
				});
			}),
			live.onLiveTranscript((delta) => {
				if (delta.direction === "input") this.assembler.appendInput(delta);
			}),
			live.on("delegation-created", (delegation) => {
				const key = `${this.sessionId}:${this.generation}:${delegation.generation}:${delegation.delegationId}`;
				if (this.delegationWork.has(key)) return;
				const work = this.handleDelegation(key, delegation).catch((error) => {
					this.options.record({
						kind: "live_lead_delegation_failed",
						binding: key,
						message: error instanceof Error ? error.message : String(error),
					});
				});
				this.delegationWork.set(key, work);
			}),
			live.on("error", (error) =>
				this.options.record({
					kind: "live_lead_voice_unavailable",
					message: error.message,
					code: error.code,
				}),
			),
		);
	}

	private async handleDelegation(
		bindingKey: string,
		delegation: {
			delegationId: string;
			generation: number;
			offsetMs?: number;
			target: "client";
		},
	): Promise<void> {
		const live = this.requireLive();
		if (delegation.offsetMs === undefined) {
			this.options.record({
				kind: "live_lead_clarification_required",
				reason: "delegation_offset_missing",
				binding: bindingKey,
			});
			return;
		}
		await this.waitForDelegationWindow({
			generation: delegation.generation,
			delegationId: delegation.delegationId,
			offsetMs: delegation.offsetMs,
		});
		if (this.closing) return;
		await live.suspend("delegation-sealed");
		try {
			const utterance = this.assembler.sealDelegation({
				generation: delegation.generation,
				delegationId: delegation.delegationId,
				offsetMs: delegation.offsetMs,
			});
			this.emitUtterance(utterance);
			if (utterance.attribution.kind !== "known" || !utterance.text) {
				this.options.record({
					kind: "live_lead_clarification_required",
					reason:
						utterance.attribution.kind === "unknown"
							? utterance.attribution.reason
							: "empty_transcript",
					binding: bindingKey,
				});
				return;
			}
			const durability =
				await this.options.transcriptSink.appendDurable(utterance);
			const reread = await this.options.transcriptSink.readReceipt(
				utterance.sessionId,
				utterance.transcriptId,
				durability.contentDigest,
			);
			if (
				!durability.durable ||
				!reread?.durable ||
				reread.sessionId !== utterance.sessionId ||
				reread.transcriptId !== utterance.transcriptId ||
				reread.contentDigest !== durability.contentDigest
			) {
				throw new Error("live_lead_transcript_not_durable");
			}
			const intentKind = this.options.classifyIntent(utterance);
			const handoffId = this.nextId();
			const idempotencyKey = digest({
				sessionId: this.sessionId,
				generation: this.generation,
				transcriptId: utterance.transcriptId,
				transcriptDigest: durability.contentDigest,
				intentKind,
			});
			const withoutDigest: Omit<VoiceHandoffRequest, "requestDigest"> = {
				handoffId,
				idempotencyKey,
				intentKind,
				payload: {
					targetLeadId: this.options.targetLeadId,
					text: utterance.text,
					quotes: [utterance.text],
				},
				sessionId: this.sessionId,
				generation: this.generation,
				transcriptId: utterance.transcriptId,
				utteranceId: utterance.utteranceId,
				originalText: utterance.text,
				authorityBinding: {
					projectName: this.options.projectName,
					founderUserId: this.options.founderUserId,
					targetLeadId: this.options.targetLeadId,
					sessionId: this.sessionId,
					generation: this.generation,
					transcriptId: utterance.transcriptId,
					transcriptDigest: durability.contentDigest,
				},
				transcriptDurabilityReceipt: durability,
				delegationBinding: `openai-live:${bindingKey}`,
			};
			const request: VoiceHandoffRequest = {
				...withoutDigest,
				requestDigest: voiceHandoffRequestDigest(withoutDigest),
			};
			const receipt = await this.options.submitHandoff(request);
			if (
				receipt.handoffId !== request.handoffId ||
				receipt.requestDigest !== request.requestDigest ||
				receipt.state !== "committed"
			) {
				throw new Error(`live_lead_handoff_${receipt.state}`);
			}
			this.options.registerHandoff({
				sessionId: this.sessionId,
				generation: this.generation,
				handoffId,
				requestDigest: request.requestDigest,
				targetLeadId: this.options.targetLeadId,
			});
			this.options.record({
				kind: "live_lead_handoff_committed",
				handoffId,
				providerOperationId: receipt.providerOperationId,
				binding: bindingKey,
			});
		} finally {
			if (!this.closing) await this.resumeLive(live);
		}
	}

	private runSpeak(
		text: string,
		kind: SpeakKind,
		opts: { pendingKey: string; verification: SpeakVerification },
	): Promise<SpeakReceipt> {
		return (async () => {
			const live = this.requireLive();
			await live.suspend("announcer-takeover");
			try {
				return await this.options.speech.speak(text, kind, opts);
			} finally {
				if (!this.closing) await this.resumeLive(live);
			}
		})();
	}

	private async resumeLive(live: OpenAiLiveConversationSession): Promise<void> {
		const providerStartedAt = this.now();
		const providerGeneration = await live.resume();
		this.assembler.startProviderGeneration(
			providerGeneration,
			providerStartedAt,
		);
	}

	private waitForDelegationWindow(input: {
		generation: number;
		delegationId: string;
		offsetMs: number;
	}): Promise<void> {
		if (this.assembler.delegationWindowState(input) !== "waiting")
			return Promise.resolve();
		return new Promise((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				this.clearTimeoutFn(timer);
				this.roomTimelineWaiters.delete(check);
				resolve();
			};
			const check = () => {
				if (
					this.closing ||
					this.assembler.delegationWindowState(input) !== "waiting"
				)
					finish();
			};
			const timer = this.setTimeoutFn(finish, this.delegationEndTimeoutMs);
			timer.unref?.();
			this.roomTimelineWaiters.add(check);
			check();
		});
	}

	private wakeRoomTimelineWaiters(): void {
		for (const waiter of [...this.roomTimelineWaiters]) waiter();
	}

	private startFrontendSpeech(): void {
		this.cancelFrontendSpeech();
		const speechId = `frontend:${this.nextId()}`;
		const receipt = this.options.room.startSpeech({
			speechId,
			generation: this.generation,
			format: PCM24,
		});
		if (receipt.outcome === "rejected") {
			this.options.record({
				kind: "live_frontend_output_rejected",
				reason: receipt.reason,
			});
			return;
		}
		this.frontendSpeech = { speechId, sequence: 0 };
	}

	private enqueueFrontendAudio(chunk: Buffer, format: AudioFormat): void {
		const speech = this.frontendSpeech;
		if (!speech || this.closing) return;
		if (
			format.encoding !== PCM24.encoding ||
			format.sampleRateHz !== PCM24.sampleRateHz ||
			format.channels !== PCM24.channels
		) {
			this.cancelFrontendSpeech();
			this.options.record({
				kind: "live_frontend_output_failed",
				message: "frontend_pcm16_24khz_mono_required",
			});
			return;
		}
		const sequence = ++speech.sequence;
		this.outputWork = this.outputWork
			.then(async () => {
				if (this.frontendSpeech !== speech || this.closing) return;
				const receipt = await this.options.room.writeSpeech({
					speechId: speech.speechId,
					generation: this.generation,
					sequence,
					pcm: chunk,
				});
				if (receipt.outcome === "rejected") throw new Error(receipt.reason);
			})
			.catch((error) => {
				this.cancelFrontendSpeech();
				this.options.record({
					kind: "live_frontend_output_failed",
					message: error instanceof Error ? error.message : String(error),
				});
			});
	}

	private endFrontendSpeech(): void {
		const speech = this.frontendSpeech;
		if (!speech) return;
		this.frontendSpeech = undefined;
		this.outputWork = this.outputWork.then(async () => {
			await this.options.room.endSpeech(speech.speechId, this.generation);
		});
	}

	private cancelFrontendSpeech(): void {
		const speech = this.frontendSpeech;
		if (!speech) return;
		this.frontendSpeech = undefined;
		this.options.room.localPlaybackCancel(speech.speechId, this.generation);
	}

	private emitUtterance(utterance: VoiceUtterance): void {
		for (const listener of [...this.utteranceListeners]) listener(utterance);
	}

	private requireLive(): OpenAiLiveConversationSession {
		if (!this.live || !this.opened || this.closing)
			throw new Error("live_lead_not_live");
		return this.live;
	}
}
