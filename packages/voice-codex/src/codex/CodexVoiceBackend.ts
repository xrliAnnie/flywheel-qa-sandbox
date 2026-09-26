import { createHash } from "node:crypto";
import type { VoiceCapabilityActionLedgerEntry } from "flywheel-teamlead/voice-capability";
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
import type { BackgroundTurnTerminal } from "./BrainCoordinator.js";
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
	type CodexRealtimeBackgroundTurn,
	type CodexRealtimeExecutionIntent,
	type CodexRealtimeInputOwner,
	type CodexRealtimeItem,
	type CodexRealtimeTranscript,
	type CodexRealtimeUnsettledInput,
} from "./RealtimeTransport.js";
import type { ScriptWriterResult } from "./ScriptWriter.js";
import type { SpokenScriptSource } from "./SpokenScript.js";
import type { ThreadCompletedItem } from "./ThreadEventRouter.js";

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

/**
 * Spoken, not just posted to the thread: the founder is on a headset. Only
 * "。" separates clauses so prepareReplySpeech leaves the text byte-identical.
 */
export const CODEX_HANDOFF_UNCONFIRMED_PROMPT =
	"刚才这件事还没有交给 Lead。我没能确认那句话是你说的。请再说一遍。";
export const CODEX_HANDOFF_FAILED_PROMPT =
	"刚才这件事没能交给 Lead。请再说一遍。";

interface CodexTransportLike {
	appendAudio(
		frame: Buffer,
		generation: number,
		owner: CodexRealtimeInputOwner,
	): CodexRealtimeAppendOutcome;
	unsettledInput?(): CodexRealtimeUnsettledInput;
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
	actionLedger?(): readonly VoiceCapabilityActionLedgerEntry[];
	/** Durable writes this background turn produced or replayed, when known. */
	turnActionLedger?(
		turnId: string,
	): readonly VoiceCapabilityActionLedgerEntry[] | undefined;
	/** Trusted repeat-confirmation input (FLY-2886 Lead ruling). */
	observeFounderUtterance?(text: string): void;
	readonly generation?: number;
	rewriteSpeech?(input: {
		sourceText: string;
		rosterNames: readonly string[];
	}): Promise<ScriptWriterResult>;
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
	loadContext: (generation?: number) => Promise<CodexVoiceContextSnapshot>;
	/**
	 * Opens the room playback for one assistant item. Audio is appended as it
	 * arrives, so an answer starts on its first frame instead of after its
	 * final transcript (FLY-2799 qa6: a 19s answer waited 4.8s).
	 */
	openAudio?: (input: {
		itemId: string;
		generation: number;
	}) => CodexAudioOutput;
	persistUtterance?: (
		utterance: VoiceUtterance,
		captureDigest: string,
	) => Promise<void>;
	publishUtterance?: (utterance: VoiceUtterance) => Promise<void>;
	handoffToLead?: (input: {
		actionLedger?: readonly VoiceCapabilityActionLedgerEntry[];
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
	allowSpokenParaphrase?: boolean;
	backgroundEnabled?: boolean;
	/** The session founder; only her words can answer a repeat confirmation. */
	founderUserId?: string;
}

/** One assistant item's playback, fed while its audio is still arriving. */
export interface CodexAudioOutput {
	append(pcm24Mono: Buffer): boolean;
	end(): void;
	cancel(): void;
	readonly done: Promise<void>;
}

export class CodexVoiceBackend implements VoiceBackend {
	readonly id = "codex-realtime" as const;
	readonly capabilities = CODEX_VOICE_CAPABILITIES;
	private conversation?: CodexConversationLike;
	actionLedger(): readonly VoiceCapabilityActionLedgerEntry[] {
		return this.conversation?.actionLedger?.() ?? [];
	}

	constructor(private readonly options: CodexVoiceBackendOptions) {}

	async createConversation(
		options: ConversationOptions,
	): Promise<ConversationSession> {
		if (options.resumeHandle)
			throw new VoiceError("unsupported", "Codex voice resume is unsupported");
		const callbacks: { session?: CodexVoiceSession } = {};
		const trustedContexts: SpokenScriptSource[] = [];
		const rosterNames = new Set<string>();
		const conversation = await this.options.container.open({
			sessionId: this.options.sessionId,
			voice: options.voice ?? this.options.voice,
			loadContext: async (generation) => {
				const snapshot = await this.options.loadContext(generation);
				trustedContexts.push({
					itemId: `context:${snapshot.snapshotDigest}`,
					text: snapshot.realtimePrompt,
				});
				for (const name of snapshot.rosterNames ?? []) rosterNames.add(name);
				return snapshot;
			},
			realtime: {
				onAudio: (input) => callbacks.session?.observeAudio(input),
				onTranscript: (input) => callbacks.session?.observeTranscript(input),
				onItem: (input) => callbacks.session?.observeItem(input),
				onInputGap: (input) => callbacks.session?.observeInputGap(input),
				onCapabilityViolation: (input) =>
					callbacks.session?.capabilityViolation(input.method),
				onExecutionIntent: (input) =>
					callbacks.session?.observeExecutionIntent(input),
				onBackgroundTurn: (input) =>
					callbacks.session?.observeBackgroundTurn(input),
				onClosed: (input) => callbacks.session?.transportClosed(input),
				onError: (error) => callbacks.session?.transportError(error),
			},
			...(this.options.backgroundEnabled
				? {
						background: {
							enabled: true,
							onTurnStarted: (turnId: string) =>
								callbacks.session?.observeProcessTurnStarted(turnId),
							onItemCompleted: (item: ThreadCompletedItem) =>
								callbacks.session?.observeProcessItemCompleted(item),
							onTurnTerminal: (turn: BackgroundTurnTerminal) =>
								callbacks.session?.observeProcessTurnTerminal(turn),
						},
					}
				: {}),
		});
		this.conversation = conversation;
		const session = new CodexVoiceSession({
			...this.options,
			conversation,
			trustedContexts,
			rosterNames,
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
	private readonly output = new Map<string, CodexAudioOutput>();
	/** Items whose final arrived; audio after it is not played. */
	private readonly outputEnded = new Set<string>();
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
	private activeBackgroundTurnId?: string;
	private readonly turnSources = new Map<
		string,
		Map<string, SpokenScriptSource>
	>();
	private readonly turnPriorReceipts = new Map<string, Set<string>>();
	private readonly backgroundRequests = new Map<
		string,
		{
			utterance: VoiceUtterance;
			persisted: Promise<boolean>;
			intent: CodexRealtimeExecutionIntent;
			turnId?: string;
		}
	>();
	private failureHandoffTail: Promise<void> = Promise.resolve();
	/** Latest user final of the current generation, and the one handed off. */
	private latestUserTranscriptId?: string;
	private handedOffTranscriptId?: string;
	private repeatPromptSequence = 0;
	private readonly outputFrameState = new Map<
		string,
		{ frameIndex: number; observedAt: number; durationMs: number }
	>();
	private sequence = 0;
	private pendingPlaybackCount = 0;
	private inputGapSinceUserFinal = false;
	private generation: number;
	private live = true;
	private restarting = false;
	private closing = false;
	private closePromise?: Promise<undefined>;

	constructor(
		private readonly options: CodexVoiceBackendOptions & {
			conversation: CodexConversationLike;
			trustedContexts: SpokenScriptSource[];
			rosterNames: Set<string>;
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
			allowSpokenParaphrase: options.allowSpokenParaphrase,
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

	rewriteSpeech(input: {
		sourceText: string;
		rosterNames: readonly string[];
	}): Promise<ScriptWriterResult> {
		if (
			!this.options.backgroundEnabled ||
			!this.options.conversation.rewriteSpeech ||
			this.closing
		)
			return Promise.reject(new Error("script_writer_unavailable"));
		return this.options.conversation.rewriteSpeech({
			...input,
			rosterNames: [
				...new Set([...input.rosterNames, ...this.options.rosterNames]),
			],
		});
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
		// A barge-in only breaks attribution when the old generation really
		// loses speech: bytes it never transcribed, or a VAD segment/committed
		// item still awaiting its final. The barge-in audio itself is queued and
		// replayed into the next generation. A transport that cannot measure this
		// is treated as lossy.
		const unsettled =
			this.options.conversation.transport.unsettledInput?.() ?? null;
		const inputGap =
			unsettled === null ||
			unsettled.droppedBytes > 0 ||
			unsettled.providerInputPending;
		const lost = {
			generation: this.generation,
			droppedBytes: unsettled?.droppedBytes ?? null,
			providerInputPending: unsettled?.providerInputPending ?? null,
		};
		this.restarting = true;
		this.options.onEvidence?.({ kind: "codex_barge_in", ...lost, inputGap });
		if (inputGap) {
			this.markInputGap();
			this.options.onEvidence?.({
				kind: "codex_input_gap",
				reason: "generation_changed",
				...lost,
			});
		}
		// Whatever the founder says next is a new request; nothing from before the
		// barge-in may authorize a delegation that arrives ahead of its final.
		this.latestKnownUser = undefined;
		this.latestUserTranscriptId = undefined;
		this.speaker.interrupt();
		this.cancelOutputs();
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
				this.events.emit("generation-changed", generation);
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
		this.cancelOutputs();
		try {
			await this.failureHandoffTail;
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
		} else if (item.status === "speech_started") {
			this.events.emit("speech-started", {
				generation: item.generation,
				itemId: item.itemId,
			});
		} else if (item.status === "completed") {
			this.events.emit("speech-stopped", {
				generation: item.generation,
				itemId: item.itemId,
			});
		}
	}

	observeAudio(delta: CodexRealtimeAudioDelta): void {
		if (this.closing || this.restarting || delta.generation !== this.generation)
			return;
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
		this.events.emit("response-audio", delta.pcm24Mono, PCM24_MONO);
		this.streamAudio(delta.itemId, delta.generation, delta.pcm24Mono);
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
		const inputHadGap =
			transcript.role === "user" && this.inputGapSinceUserFinal;
		const providerInputOwner =
			transcript.role === "user" &&
			!inputHadGap &&
			transcript.inputOwner?.utteranceId &&
			transcript.inputOwner.ownerUserId
				? transcript.inputOwner
				: undefined;
		const soleRoomUser =
			transcript.role === "user" && !inputHadGap && !providerInputOwner
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
					: inputHadGap
						? { kind: "unknown", reason: "input_gap" }
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
			this.inputGapSinceUserFinal = false;
			this.latestUserTranscriptId = utterance.transcriptId;
			this.latestKnownUser =
				utterance.attribution.kind === "known"
					? { utterance, persisted }
					: undefined;
			if (
				this.options.backgroundEnabled &&
				this.options.founderUserId &&
				utterance.attribution.kind === "known" &&
				utterance.attribution.speakerUserId === this.options.founderUserId
			) {
				try {
					// Only her attributed words (not an allowlisted QA speaker) can
					// answer a repeat confirmation.
					this.options.conversation.observeFounderUtterance?.(utterance.text);
				} catch (error) {
					this.options.onEvidence?.({
						kind: "codex_repeat_confirmation_input_failed",
						transcriptId: utterance.transcriptId,
						reason: error instanceof Error ? error.message : "unknown_error",
					});
				}
			}
		}
		if (transcript.role === "assistant" && transcript.itemId)
			this.endOutput(transcript.itemId);
	}

	observeInputGap(input: { reason: string; droppedBytes: number }): void {
		this.markInputGap();
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
		if (this.options.backgroundEnabled) {
			this.registerBackgroundHandoff(intent);
			return;
		}
		const candidate = this.latestKnownUser;
		if (!candidate || !this.options.handoffToLead) {
			// A later execution item of a request that already went to the Lead
			// is not a new request; everything else must not pass silently.
			const alreadyHandedOff =
				!candidate &&
				this.latestUserTranscriptId !== undefined &&
				this.latestUserTranscriptId === this.handedOffTranscriptId;
			const reason = alreadyHandedOff
				? "already_handed_off"
				: candidate
					? "handoff_sink_missing"
					: "known_user_missing";
			this.options.onEvidence?.({
				kind: "codex_execution_handoff_skipped",
				generation: intent.generation,
				backendIntentKind: intent.kind,
				backendMethod: intent.method,
				reason,
			});
			if (!alreadyHandedOff)
				this.askForRepeat(CODEX_HANDOFF_UNCONFIRMED_PROMPT, reason);
			return;
		}
		const key = `${intent.generation}:${intent.kind}:${intent.itemId ?? intent.method}:${candidate.utterance.transcriptId}`;
		if (this.handoffKeys.has(key)) return;
		this.handoffKeys.add(key);
		// One user request may surface several backend execution items. Consume the
		// authorization candidate before dispatch so only the first can hand off.
		this.latestKnownUser = undefined;
		this.handedOffTranscriptId = candidate.utterance.transcriptId;
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
				// ambiguous/needs_human are still owned by the Bridge; only an
				// explicit rejection is known not to have reached the Lead.
				if (receipt.state === "rejected")
					this.askForRepeat(CODEX_HANDOFF_FAILED_PROMPT, "handoff_rejected");
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
				this.askForRepeat(CODEX_HANDOFF_FAILED_PROMPT, "handoff_failed");
			});
	}

	private registerBackgroundHandoff(
		intent: CodexRealtimeExecutionIntent,
	): void {
		if (intent.kind !== "handoffRequest") return;
		const candidate = this.latestKnownUser;
		if (!candidate) {
			const alreadyRegistered =
				this.latestUserTranscriptId !== undefined &&
				this.latestUserTranscriptId === this.handedOffTranscriptId;
			this.options.onEvidence?.({
				kind: "codex_background_handoff_skipped",
				generation: intent.generation,
				reason: alreadyRegistered ? "already_registered" : "known_user_missing",
			});
			if (!alreadyRegistered)
				this.askForRepeat(
					CODEX_HANDOFF_UNCONFIRMED_PROMPT,
					"known_user_missing",
				);
			return;
		}
		const handoffId = intent.itemId;
		if (!handoffId) {
			this.options.onEvidence?.({
				kind: "codex_background_handoff_skipped",
				generation: intent.generation,
				reason: "handoff_id_missing",
			});
			this.askForRepeat(CODEX_HANDOFF_UNCONFIRMED_PROMPT, "handoff_id_missing");
			return;
		}
		const key = `${intent.generation}:background:${handoffId}:${candidate.utterance.transcriptId}`;
		if (this.handoffKeys.has(key)) return;
		this.handoffKeys.add(key);
		this.latestKnownUser = undefined;
		this.handedOffTranscriptId = candidate.utterance.transcriptId;
		this.backgroundRequests.set(handoffId, {
			...candidate,
			intent,
			turnId: this.activeBackgroundTurnId,
		});
		this.events.emit("background-handoff", {
			handoffId,
			inputTranscript: candidate.utterance.text,
		});
		this.options.onEvidence?.({
			kind: "codex_background_handoff_registered",
			generation: intent.generation,
			handoffId,
			transcriptId: candidate.utterance.transcriptId,
		});
		void candidate.persisted
			.then((durable) => {
				if (!durable) throw new Error("codex_handoff_transcript_not_durable");
			})
			.catch((error) => {
				this.options.onEvidence?.({
					kind: "codex_background_handoff_durability_failed",
					generation: intent.generation,
					handoffId,
					transcriptId: candidate.utterance.transcriptId,
					reason: error instanceof Error ? error.message : "unknown_error",
				});
			});
	}

	/**
	 * The model may already have said it is passing the request on; say out
	 * loud that it did not happen, instead of leaving only a thread note.
	 */
	private askForRepeat(prompt: string, reason: string): void {
		if (this.closing) return;
		const pendingKey = `${this.sessionId}:handoff-repeat:${++this.repeatPromptSequence}`;
		this.options.onEvidence?.({
			kind: "codex_handoff_repeat_prompt",
			reason,
			pendingKey,
		});
		if (this.options.backgroundEnabled) {
			this.events.emit("coordinated-speech", {
				businessId: pendingKey,
				text: prompt,
			});
			return;
		}
		// required: the receipt must say whether the words were actually read.
		void this.speak(prompt, "cue", { pendingKey, verification: "required" });
	}

	observeBackgroundTurn(turn: CodexRealtimeBackgroundTurn): void {
		if (this.closing) return;
		this.options.onEvidence?.({ kind: "codex_background_turn", ...turn });
	}

	observeProcessItemCompleted(item: ThreadCompletedItem): void {
		if (
			!this.options.backgroundEnabled ||
			this.closing ||
			!item.itemId ||
			item.raw.status !== "completed"
		)
			return;
		let text: string | undefined;
		if (
			item.type === "commandExecution" &&
			typeof item.raw.aggregatedOutput === "string"
		)
			text = item.raw.aggregatedOutput;
		if (item.type === "mcpToolCall" && item.raw.result != null)
			text = JSON.stringify(item.raw.result);
		if (text === undefined) return;
		const sources =
			this.turnSources.get(item.turnId) ??
			new Map<string, SpokenScriptSource>();
		sources.set(item.itemId, { itemId: item.itemId, text });
		this.turnSources.set(item.turnId, sources);
	}

	observeProcessTurnStarted(turnId: string): void {
		if (this.closing || !this.options.backgroundEnabled) return;
		this.activeBackgroundTurnId = turnId;
		if (!this.turnPriorReceipts.has(turnId))
			this.turnPriorReceipts.set(
				turnId,
				new Set(
					(this.options.conversation.actionLedger?.() ?? []).map(
						(row) => row.requestId,
					),
				),
			);
		for (const request of this.backgroundRequests.values())
			if (!request.turnId) request.turnId = turnId;
		this.events.emit("background-turn-started", turnId);
		this.options.onEvidence?.({
			kind: "codex_background_turn_started",
			turnId,
		});
	}

	observeProcessTurnTerminal(turn: BackgroundTurnTerminal): void {
		if (this.closing || !this.options.backgroundEnabled) return;
		if (this.activeBackgroundTurnId === turn.turnId)
			this.activeBackgroundTurnId = undefined;
		if (turn.outcome !== "completed" || !turn.spokenSegments?.length)
			void this.handoffBackgroundFailures(turn.turnId);
		else
			for (const [id, request] of this.backgroundRequests)
				if (request.turnId === turn.turnId) this.backgroundRequests.delete(id);
		const prior = this.turnPriorReceipts.get(turn.turnId) ?? new Set<string>();
		let turnLedger: readonly VoiceCapabilityActionLedgerEntry[] | undefined;
		try {
			turnLedger = this.options.conversation.turnActionLedger?.(turn.turnId);
		} catch {
			turnLedger = undefined;
		}
		// The durable per-turn ledger also sees replays of older receipts.
		const receipts =
			turnLedger ??
			(this.options.conversation.actionLedger?.() ?? []).filter(
				(row) => !prior.has(row.requestId),
			);
		const completedTurn = {
			...turn,
			sources: [
				...this.options.trustedContexts,
				...(this.turnSources.get(turn.turnId)?.values() ?? []),
			],
			rosterNames: [...this.options.rosterNames],
			hadWriteReceipt: receipts.some((row) => row.outcome === "succeeded"),
			writeReceiptUnknown: receipts.some((row) => row.outcome === "unknown"),
		};
		this.turnSources.delete(turn.turnId);
		this.turnPriorReceipts.delete(turn.turnId);
		this.events.emit("background-turn-terminal", completedTurn);
		this.options.onEvidence?.({
			kind: "codex_background_turn_terminal",
			...turn,
		});
	}

	private handoffBackgroundFailures(turnId?: string): Promise<void> {
		if (!this.options.backgroundEnabled) return Promise.resolve();
		const pending = [...this.backgroundRequests].filter(
			([, request]) => !turnId || request.turnId === turnId,
		);
		for (const [id] of pending) this.backgroundRequests.delete(id);
		const work = async () => {
			for (const [handoffId, request] of pending) {
				try {
					if (!(await request.persisted))
						throw new Error("codex_handoff_transcript_not_durable");
					if (!this.options.handoffToLead)
						throw new Error("handoff_sink_missing");
					const receipt = await this.options.handoffToLead({
						utterance: request.utterance,
						intent: request.intent,
						actionLedger: this.options.conversation.actionLedger?.() ?? [],
					});
					this.options.onEvidence?.({
						kind: "codex_background_failure_handoff",
						handoffId,
						state: receipt.state,
						leadHandoffId: receipt.handoffId,
					});
				} catch (error) {
					this.options.onEvidence?.({
						kind: "codex_background_failure_handoff_failed",
						handoffId,
						reason: error instanceof Error ? error.message : "unknown_error",
					});
				}
			}
		};
		this.failureHandoffTail = this.failureHandoffTail.then(work);
		return this.failureHandoffTail;
	}

	transportClosed(input: { generation: number; reason: string }): void {
		if (this.closing || this.restarting || input.generation !== this.generation)
			return;
		const emitClosed = () =>
			this.events.emit(
				"error",
				new VoiceError(
					"connection-closed",
					"Codex realtime closed",
					input.reason,
				),
			);
		if (this.options.backgroundEnabled)
			void this.handoffBackgroundFailures().finally(emitClosed);
		else emitClosed();
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
		const emitError = () =>
			this.events.emit(
				"error",
				new VoiceError("backend-protocol", "Codex realtime failed", error),
			);
		if (this.options.backgroundEnabled)
			void this.handoffBackgroundFailures().finally(emitError);
		else emitError();
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

	private streamAudio(itemId: string, generation: number, pcm24Mono: Buffer) {
		if (this.outputEnded.has(itemId)) {
			this.options.onEvidence?.({
				kind: "codex_output_late_audio_dropped",
				itemId,
				generation,
				pcmBytes: pcm24Mono.length,
			});
			return;
		}
		let output = this.output.get(itemId);
		if (!output) {
			// Assistant items play in order; one whose final never came must not
			// hold the next one behind it.
			for (const openItemId of [...this.output.keys()])
				this.endOutput(openItemId);
			output = this.openOutput(itemId, generation);
		}
		output?.append(pcm24Mono);
	}

	private openOutput(
		itemId: string,
		generation: number,
	): CodexAudioOutput | undefined {
		if (!this.options.openAudio) {
			this.outputEnded.add(itemId);
			this.options.onEvidence?.({
				kind: "codex_output_unsubmitted",
				itemId,
				generation,
				reason: "playback_sink_missing",
			});
			return undefined;
		}
		let output: CodexAudioOutput;
		try {
			output = this.options.openAudio({ itemId, generation });
		} catch (error) {
			this.outputEnded.add(itemId);
			this.playbackFailed(error, generation);
			return undefined;
		}
		this.output.set(itemId, output);
		this.pendingPlaybackCount += 1;
		let completed = false;
		void output.done
			.then(
				() => {
					this.speaker.observePlaybackSubmitted({ generation, itemId });
					completed = true;
				},
				(error) => this.playbackFailed(error, generation),
			)
			.finally(() => {
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
			});
		return output;
	}

	private endOutput(itemId: string): void {
		const output = this.output.get(itemId);
		this.output.delete(itemId);
		this.outputEnded.add(itemId);
		this.outputFrameState.delete(itemId);
		output?.end();
	}

	/** Barge-in / close: open outputs belong to a response that is over. */
	private cancelOutputs(): void {
		const open = [...this.output.values()];
		this.output.clear();
		this.outputEnded.clear();
		for (const output of open) output.cancel();
	}

	private playbackFailed(error: unknown, generation: number): void {
		if (this.closing || this.restarting || generation !== this.generation)
			return;
		this.transportError(
			error instanceof Error ? error : new Error(String(error)),
		);
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
			this.markInputGap();
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
		this.markInputGap();
		this.options.onEvidence?.({
			kind: "codex_audio_dropped",
			outcome,
			droppedBytes,
			generation: this.generation,
		});
	}

	private markInputGap(): void {
		this.inputGapSinceUserFinal = true;
		this.latestKnownUser = undefined;
	}
}
