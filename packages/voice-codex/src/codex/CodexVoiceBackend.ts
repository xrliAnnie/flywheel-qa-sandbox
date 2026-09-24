import { createHash } from "node:crypto";
import {
	type AudioFormat,
	type ConversationEventMap,
	type ConversationOptions,
	type ConversationSession,
	TypedEmitter,
	type VoiceBackend,
	type VoiceBackendCapabilities,
	VoiceError,
	type VoiceSpeakKind,
	type VoiceSpeakOptions,
	type VoiceUtterance,
} from "flywheel-voice-core";
import type { RealtimeAudioOwner } from "../realtime.js";
import { CodexProofSpeaker } from "./CodexProofSpeaker.js";
import type {
	CodexVoiceContextSnapshot,
	CodexVoiceOpenInput,
} from "./CodexVoiceContainer.js";
import type { CodexHandoffResult } from "./CodexVoiceHandoff.js";
import {
	CODEX_REALTIME_INPUT_QUEUE_BYTES,
	type CodexRealtimeAppendOutcome,
	type CodexRealtimeAudioDelta,
	type CodexRealtimeExecutionIntent,
	type CodexRealtimeInputOwner,
	type CodexRealtimeItem,
	type CodexRealtimeTranscript,
} from "./RealtimeTransport.js";

const PCM24_MONO: AudioFormat = {
	encoding: "pcm16",
	sampleRateHz: 24_000,
	channels: 1,
};

export const CODEX_VOICE_CAPABILITIES: VoiceBackendCapabilities = {
	announce: false,
	converse: true,
	bargeIn: false,
	// These stay false until the exact binary/model/profile combination passes
	// the contract's production proof matrix. The implementation still returns
	// per-request proof receipts, including detectable failures.
	verbatim: false,
	attribution: false,
	toolCallScheduling: "none",
	transcriptGranularity: "final-only",
	supportsResume: false,
	voiceCloning: false,
	audioIn: [PCM24_MONO],
	audioOut: [PCM24_MONO],
};

interface CodexTransportLike {
	appendAudio(
		frame: Buffer,
		generation: number,
		owner: CodexRealtimeInputOwner,
	): CodexRealtimeAppendOutcome;
	appendSpeech(text: string, generation: number): Promise<void>;
	appendText(
		text: string,
		role: "developer" | "user",
		generation: number,
	): Promise<void>;
	cancel(): Promise<void>;
	invalidateInputOwnership?(): void;
}

interface CodexConversationLike {
	readonly generation?: number;
	readonly transport: CodexTransportLike;
	restart?(): Promise<number>;
	close(reason?: string): Promise<void>;
}

interface CodexContainerLike {
	open(input: CodexVoiceOpenInput): Promise<CodexConversationLike>;
}

export interface CodexVoiceBackendOptions {
	sessionId: string;
	voice: string;
	container: CodexContainerLike;
	loadContext: () => Promise<CodexVoiceContextSnapshot>;
	playAudio?: (input: {
		itemId: string;
		pcm24Mono: Buffer;
		generation: number;
	}) => Promise<void>;
	persistUtterance?: (
		utterance: VoiceUtterance,
		captureDigest: string,
	) => Promise<void>;
	publishUtterance?: (utterance: VoiceUtterance) => Promise<void>;
	handoffToLead?: (input: {
		utterance: VoiceUtterance;
		intent: CodexRealtimeExecutionIntent;
	}) => Promise<CodexHandoffResult>;
	resolveSoleRoomUser?: () => {
		userId: string;
		name: string | null;
	} | null;
	now?: () => Date;
	monotonicNow?: () => number;
	onEvidence?: (record: Record<string, unknown>) => void;
	confirmTimeoutMs?: number;
}

export class CodexVoiceBackend implements VoiceBackend {
	readonly id = "codex-realtime" as const;
	readonly capabilities = CODEX_VOICE_CAPABILITIES;

	constructor(private readonly options: CodexVoiceBackendOptions) {}

	async createConversation(
		options: ConversationOptions,
	): Promise<ConversationSession> {
		if (options.resumeHandle)
			throw new VoiceError("unsupported", "Codex voice resume is unsupported");
		const callbacks: { session?: CodexVoiceSession } = {};
		const conversation = await this.options.container.open({
			sessionId: this.options.sessionId,
			voice: options.voice ?? this.options.voice,
			loadContext: this.options.loadContext,
			realtime: {
				onAudio: (input) => callbacks.session?.observeAudio(input),
				onTranscript: (input) => callbacks.session?.observeTranscript(input),
				onItem: (input) => callbacks.session?.observeItem(input),
				onInputGap: (input) => callbacks.session?.observeInputGap(input),
				onCapabilityViolation: (input) =>
					callbacks.session?.capabilityViolation(input.method),
				onExecutionIntent: (input) =>
					callbacks.session?.observeExecutionIntent(input),
				onClosed: (input) => callbacks.session?.transportClosed(input),
				onError: (error) => callbacks.session?.transportError(error),
			},
		});
		const session = new CodexVoiceSession({
			...this.options,
			conversation,
			transcriptSink: options.transcriptSink,
		});
		callbacks.session = session;
		return session;
	}
}

class CodexVoiceSession implements ConversationSession {
	readonly sessionId: string;
	private readonly events = new TypedEmitter<ConversationEventMap>();
	private readonly speaker: CodexProofSpeaker;
	private readonly now: () => Date;
	private readonly monotonicNow: () => number;
	private readonly audio = new Map<string, Buffer[]>();
	private readonly outputStarted = new Set<string>();
	private readonly restartAudio: Array<{
		frame: Buffer;
		owner: CodexRealtimeInputOwner;
	}> = [];
	private restartAudioBytes = 0;
	private restartInputGap = false;
	private durabilityTail: Promise<void> = Promise.resolve();
	private latestKnownUser?: {
		utterance: VoiceUtterance;
		persisted: Promise<boolean>;
	};
	private readonly handoffKeys = new Set<string>();
	private readonly outputFrameState = new Map<
		string,
		{ frameIndex: number; observedAt: number; durationMs: number }
	>();
	private sequence = 0;
	private pendingPlaybackCount = 0;
	private generation: number;
	private live = true;
	private restarting = false;
	private closing = false;
	private closePromise?: Promise<undefined>;

	constructor(
		private readonly options: CodexVoiceBackendOptions & {
			conversation: CodexConversationLike;
			transcriptSink?: ConversationOptions["transcriptSink"];
		},
	) {
		this.sessionId = options.sessionId;
		this.now = options.now ?? (() => new Date());
		this.monotonicNow =
			options.monotonicNow ?? performance.now.bind(performance);
		this.generation = options.conversation.generation ?? 1;
		this.speaker = new CodexProofSpeaker({
			sessionId: options.sessionId,
			sessionGeneration: () => this.generation,
			voice: options.voice,
			format: PCM24_MONO,
			transport: () => options.conversation.transport,
			isLive: () => this.live && !this.restarting && !this.closing,
			confirmTimeoutMs: options.confirmTimeoutMs,
		});
	}

	sendAudio(frame: Buffer, format: AudioFormat): void {
		this.send(frame, format, { ownerUserId: null, utteranceId: null });
	}

	sendOwnedAudio(frame: Buffer, owner: RealtimeAudioOwner): void {
		this.send(frame, PCM24_MONO, {
			ownerUserId: owner.ownerUserId,
			utteranceId: owner.utteranceId,
			ownerName: owner.ownerName,
		});
	}

	private send(
		frame: Buffer,
		format: AudioFormat,
		owner: CodexRealtimeInputOwner,
	): void {
		if (
			format.encoding !== "pcm16" ||
			format.sampleRateHz !== 24_000 ||
			format.channels !== 1
		)
			throw new VoiceError(
				"backend-protocol",
				"Codex voice requires 24k mono PCM16",
			);
		if (this.closing || !this.live) return;
		if (this.restarting) {
			this.queueRestartAudio(frame, owner);
			return;
		}
		const outcome = this.options.conversation.transport.appendAudio(
			frame,
			this.generation,
			owner,
		);
		this.observeAppendOutcome(outcome, frame.length);
	}

	sendText(_text: string): void {
		this.unsupported("freeform text control is disabled");
	}

	speak(text: string, kind: VoiceSpeakKind, options: VoiceSpeakOptions) {
		return this.speaker.speak(text, kind, options).then((receipt) => {
			this.options.onEvidence?.({
				kind: "codex_speak_receipt",
				speechKind: kind,
				pendingKey: receipt.pendingKey,
				requestDigest: receipt.requestDigest,
				outcome: receipt.outcome,
				transport: receipt.transport,
				contentProof: receipt.contentProof,
				...("reason" in receipt && receipt.reason
					? { reason: receipt.reason }
					: {}),
			});
			return receipt;
		});
	}

	injectContext(_text: string): void {
		this.unsupported("silent context injection is unverified");
	}

	endUserTurn(): void {
		// V2 owns turn boundaries through its realtime input protocol. No synthetic
		// user text or tool result is injected here.
	}

	interrupt(): void {
		if (this.closing || this.restarting || !this.live) return;
		this.restarting = true;
		this.latestKnownUser = undefined;
		this.speaker.interrupt();
		this.audio.clear();
		this.outputFrameState.clear();
		this.outputStarted.clear();
		this.events.emit("response-cancelled");
		const restart = this.options.conversation.restart;
		if (!restart) {
			this.restarting = false;
			this.transportError(new Error("codex_realtime_restart_unsupported"));
			return;
		}
		void restart
			.call(this.options.conversation)
			.then((generation) => {
				if (this.closing) return;
				this.generation = generation;
				this.restarting = false;
				this.flushRestartAudio();
			})
			.catch((error) => {
				this.restarting = false;
				this.restartAudio.length = 0;
				this.restartAudioBytes = 0;
				this.restartInputGap = false;
				this.transportError(
					error instanceof Error ? error : new Error(String(error)),
				);
				void this.close();
			});
	}

	injectToolResult(): void {
		this.unsupported("tool results are disabled in Codex voice");
	}

	on<E extends keyof ConversationEventMap>(
		event: E,
		handler: (...args: ConversationEventMap[E]) => void,
	): () => void {
		return this.events.on(event, handler);
	}

	close(): Promise<undefined> {
		this.closePromise ??= this.closeOnce();
		return this.closePromise;
	}

	private async closeOnce(): Promise<undefined> {
		this.closing = true;
		this.live = false;
		try {
			await this.durabilityTail;
			const flush = await this.options.transcriptSink?.flush?.();
			if (flush?.outcome === "failed") {
				this.options.onEvidence?.({
					kind: "codex_transcript_flush_failed",
					reason: flush.reason,
				});
			}
		} catch (error) {
			this.options.onEvidence?.({
				kind: "codex_transcript_flush_failed",
				reason: error instanceof Error ? error.message : "unknown_error",
			});
		} finally {
			await this.options.conversation.close("conversation_close");
		}
		return undefined;
	}

	observeItem(item: CodexRealtimeItem): void {
		if (this.closing || this.restarting || item.generation !== this.generation)
			return;
		if (item.role === "assistant") {
			this.speaker.observeAssistantItem(item);
			if (!this.outputStarted.has(item.itemId)) {
				this.outputStarted.add(item.itemId);
				this.events.emit("response-started");
			}
		}
	}

	observeAudio(delta: CodexRealtimeAudioDelta): void {
		if (this.closing || this.restarting || delta.generation !== this.generation)
			return;
		const chunks = this.audio.get(delta.itemId) ?? [];
		const observedAt = this.monotonicNow();
		const samples = delta.samplesPerChannel ?? delta.pcm24Mono.length / 2;
		const durationMs = samples / 24;
		const previous = this.outputFrameState.get(delta.itemId);
		const intervalMs = previous
			? Math.max(0, observedAt - previous.observedAt)
			: null;
		const underloadMs = previous
			? Math.max(0, intervalMs! - previous.durationMs)
			: null;
		const frameIndex = (previous?.frameIndex ?? 0) + 1;
		this.outputFrameState.set(delta.itemId, {
			frameIndex,
			observedAt,
			durationMs,
		});
		this.options.onEvidence?.({
			kind: "codex_output_audio_frame",
			generation: delta.generation,
			itemId: delta.itemId,
			frameIndex,
			pcmBytes: delta.pcm24Mono.length,
			durationMs,
			intervalMs,
			underloadMs,
		});
		chunks.push(delta.pcm24Mono);
		this.audio.set(delta.itemId, chunks);
		this.events.emit("response-audio", delta.pcm24Mono, PCM24_MONO);
	}

	observeTranscript(transcript: CodexRealtimeTranscript): void {
		if (
			this.closing ||
			this.restarting ||
			transcript.generation !== this.generation
		)
			return;
		this.speaker.observeTranscript(transcript);
		this.events.emit("transcript", {
			role: transcript.role,
			text: transcript.text,
			final: transcript.final,
		});
		if (!transcript.final) return;
		const sequence = ++this.sequence;
		const itemId = transcript.itemId ?? `unattributed-${sequence}`;
		const providerInputOwner =
			transcript.role === "user" &&
			transcript.inputOwner?.utteranceId &&
			transcript.inputOwner.ownerUserId
				? transcript.inputOwner
				: undefined;
		const soleRoomUser =
			transcript.role === "user" && !providerInputOwner
				? (this.options.resolveSoleRoomUser?.() ?? undefined)
				: undefined;
		const inputOwner =
			providerInputOwner ??
			(soleRoomUser
				? {
						ownerUserId: soleRoomUser.userId,
						ownerName: soleRoomUser.name,
						// Do not borrow a Discord utterance id by arrival order. The
						// synthetic id states exactly which room-presence proof was used
						// while keeping authorization auditable.
						utteranceId: `${this.sessionId}:${transcript.generation}:sole-room-user:${sequence}`,
					}
				: undefined);
		if (soleRoomUser) {
			this.options.onEvidence?.({
				kind: "codex_input_attribution_inferred",
				generation: transcript.generation,
				transcriptId: `${this.sessionId}:${transcript.generation}:${itemId}:${sequence}`,
				method: "sole_present_room_user",
				speakerUserId: soleRoomUser.userId,
			});
		}
		const utterance: VoiceUtterance = {
			sessionId: this.sessionId,
			sessionGeneration: transcript.generation,
			utteranceId:
				inputOwner?.utteranceId ??
				`${this.sessionId}:${transcript.generation}:${itemId}`,
			transcriptId: `${this.sessionId}:${transcript.generation}:${itemId}:${sequence}`,
			ts: this.now().toISOString(),
			sequence,
			source: transcript.role === "user" ? "room_audio" : "engine_audio",
			role: transcript.role,
			text: transcript.text,
			final: true,
			attribution:
				transcript.role === "assistant"
					? { kind: "unknown", reason: "engine_output" }
					: inputOwner
						? {
								kind: "known",
								speakerUserId: inputOwner.ownerUserId!,
							}
						: {
								kind: "unknown",
								reason:
									transcript.association !== "unattributed"
										? "provider_item_not_speaker_bound"
										: "provider_item_unattributed",
							},
		};
		if (utterance.role === "user" && utterance.attribution.kind === "unknown") {
			this.options.onEvidence?.({
				kind: "codex_input_attribution_unknown",
				generation: transcript.generation,
				transcriptId: utterance.transcriptId,
				soleRoomUserResolved: false,
				reason: utterance.attribution.reason,
			});
		}
		this.events.emit("utterance", utterance);
		const persisted = this.persist(utterance, transcript);
		if (utterance.role === "user") {
			this.latestKnownUser =
				utterance.attribution.kind === "known"
					? { utterance, persisted }
					: undefined;
		}
		if (transcript.role === "assistant" && transcript.itemId)
			void this.play(transcript.itemId, transcript.generation);
	}

	observeInputGap(input: { reason: string; droppedBytes: number }): void {
		this.options.onEvidence?.({ kind: "codex_input_gap", ...input });
	}

	capabilityViolation(method: string): void {
		this.transportError(new Error(`codex_capability_violation:${method}`));
		void this.close();
	}

	observeExecutionIntent(intent: CodexRealtimeExecutionIntent): void {
		if (
			this.closing ||
			this.restarting ||
			intent.generation !== this.generation
		)
			return;
		const candidate = this.latestKnownUser;
		if (!candidate || !this.options.handoffToLead) {
			this.options.onEvidence?.({
				kind: "codex_execution_handoff_skipped",
				generation: intent.generation,
				backendIntentKind: intent.kind,
				backendMethod: intent.method,
				reason: candidate ? "handoff_sink_missing" : "known_user_missing",
			});
			return;
		}
		const key = `${intent.generation}:${intent.kind}:${intent.itemId ?? intent.method}:${candidate.utterance.transcriptId}`;
		if (this.handoffKeys.has(key)) return;
		this.handoffKeys.add(key);
		// One user request may surface several backend execution items. Consume the
		// authorization candidate before dispatch so only the first can hand off.
		this.latestKnownUser = undefined;
		void candidate.persisted
			.then(async (durable) => {
				if (!durable) throw new Error("codex_handoff_transcript_not_durable");
				return this.options.handoffToLead!({
					utterance: candidate.utterance,
					intent,
				});
			})
			.then((receipt) => {
				this.options.onEvidence?.({
					kind: "codex_execution_handoff",
					generation: intent.generation,
					backendIntentKind: intent.kind,
					backendMethod: intent.method,
					...(intent.itemId ? { backendItemId: intent.itemId } : {}),
					transcriptId: candidate.utterance.transcriptId,
					handoffId: receipt.handoffId,
					state: receipt.state,
				});
			})
			.catch((error) => {
				this.options.onEvidence?.({
					kind: "codex_execution_handoff_failed",
					generation: intent.generation,
					backendIntentKind: intent.kind,
					backendMethod: intent.method,
					transcriptId: candidate.utterance.transcriptId,
					reason: error instanceof Error ? error.message : "unknown_error",
				});
			});
	}

	transportClosed(input: { generation: number; reason: string }): void {
		if (this.closing || this.restarting || input.generation !== this.generation)
			return;
		this.events.emit(
			"error",
			new VoiceError(
				"connection-closed",
				"Codex realtime closed",
				input.reason,
			),
		);
	}

	transportError(error: Error): void {
		const upstreamEvent =
			"upstreamEvent" in error &&
			error.upstreamEvent !== null &&
			typeof error.upstreamEvent === "object"
				? error.upstreamEvent
				: undefined;
		this.options.onEvidence?.({
			kind: "codex_transport_error",
			errorType: error.name,
			message: error.message,
			...(upstreamEvent ? { upstreamEvent } : {}),
		});
		this.events.emit(
			"error",
			new VoiceError("backend-protocol", "Codex realtime failed", error),
		);
	}

	private persist(
		utterance: VoiceUtterance,
		transcript: CodexRealtimeTranscript,
	): Promise<boolean> {
		const captureDigest = createHash("sha256")
			.update(
				JSON.stringify({
					version: 1,
					association: transcript.association,
					itemId: transcript.itemId ?? null,
					role: transcript.role,
					text: transcript.text,
					generation: transcript.generation,
				}),
			)
			.digest("hex");
		const persisted = this.durabilityTail.then(async () => {
			const local = await this.options.transcriptSink?.append({
				ts: utterance.ts,
				sessionId: utterance.sessionId,
				backendId: "codex-realtime",
				face: "converse",
				role: utterance.role,
				text: utterance.text,
				final: utterance.final,
				sessionGeneration: utterance.sessionGeneration,
				utteranceId: utterance.utteranceId,
				transcriptId: utterance.transcriptId,
				sequence: utterance.sequence,
				source: utterance.source,
				attribution: utterance.attribution,
			});
			if (local?.outcome === "failed") {
				this.options.onEvidence?.({
					kind: "codex_transcript_write_failed",
					reason: local.reason,
				});
				this.events.emit(
					"error",
					new VoiceError(
						"backend-protocol",
						"Codex transcript durability failed",
					),
				);
				return false;
			}
			let durable = this.options.persistUtterance !== undefined;
			try {
				await this.options.persistUtterance?.(utterance, captureDigest);
			} catch (error) {
				durable = false;
				this.options.onEvidence?.({
					kind: "codex_bridge_utterance_write_failed",
					reason: error instanceof Error ? error.message : "unknown_error",
				});
				this.events.emit(
					"error",
					new VoiceError(
						"backend-protocol",
						"Codex utterance durability failed",
						error,
					),
				);
			}
			try {
				await this.options.publishUtterance?.(utterance);
			} catch (error) {
				this.options.onEvidence?.({
					kind: "codex_transcript_publish_failed",
					transcriptId: utterance.transcriptId,
					reason: error instanceof Error ? error.message : "unknown_error",
				});
			}
			return durable;
		});
		this.durabilityTail = persisted.then(() => undefined);
		return persisted;
	}

	private async play(itemId: string, generation: number): Promise<void> {
		const chunks = this.audio.get(itemId) ?? [];
		this.audio.delete(itemId);
		this.outputFrameState.delete(itemId);
		if (chunks.length === 0) return;
		if (!this.options.playAudio) {
			this.options.onEvidence?.({
				kind: "codex_output_unsubmitted",
				itemId,
				generation,
				reason: "playback_sink_missing",
			});
			return;
		}
		this.pendingPlaybackCount += 1;
		let completed = false;
		try {
			await this.options.playAudio({
				itemId,
				pcm24Mono: Buffer.concat(chunks),
				generation,
			});
			this.speaker.observePlaybackSubmitted({ generation, itemId });
			completed = true;
		} catch (error) {
			if (this.closing || this.restarting || generation !== this.generation)
				return;
			this.transportError(
				error instanceof Error ? error : new Error(String(error)),
			);
		} finally {
			this.pendingPlaybackCount -= 1;
			if (
				completed &&
				this.pendingPlaybackCount === 0 &&
				!this.closing &&
				!this.restarting &&
				generation === this.generation
			) {
				this.events.emit("response-done");
			}
		}
	}

	private unsupported(message: string): void {
		this.events.emit("error", new VoiceError("unsupported", message));
	}

	private queueRestartAudio(
		frame: Buffer,
		owner: CodexRealtimeInputOwner,
	): void {
		if (
			this.restartAudioBytes + frame.length >
			CODEX_REALTIME_INPUT_QUEUE_BYTES
		) {
			this.restartInputGap = true;
			this.options.onEvidence?.({
				kind: "codex_input_gap",
				reason: "restart_backpressure",
				droppedBytes: frame.length,
			});
			return;
		}
		this.restartAudio.push({ frame: Buffer.from(frame), owner: { ...owner } });
		this.restartAudioBytes += frame.length;
	}

	private flushRestartAudio(): void {
		const queued = this.restartAudio.splice(0);
		this.restartAudioBytes = 0;
		if (this.restartInputGap) {
			this.options.conversation.transport.invalidateInputOwnership?.();
			this.restartInputGap = false;
		}
		for (const { frame, owner } of queued) {
			const outcome = this.options.conversation.transport.appendAudio(
				frame,
				this.generation,
				owner,
			);
			this.observeAppendOutcome(outcome, frame.length);
		}
	}

	private observeAppendOutcome(
		outcome: CodexRealtimeAppendOutcome,
		droppedBytes: number,
	): void {
		if (!outcome.startsWith("dropped:")) return;
		this.options.onEvidence?.({
			kind: "codex_audio_dropped",
			outcome,
			droppedBytes,
			generation: this.generation,
		});
	}
}
