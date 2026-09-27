import { createHash } from "node:crypto";
import {
	type AudioFormat,
	type ConversationEventMap,
	type ConversationOptions,
	type ConversationSession,
	type SpeakReceipt,
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
import { DownlinkController, type DownlinkSink } from "./DownlinkController.js";
import type {
	CodexRealtimeAppendOutcome,
	CodexRealtimeBackgroundTurn,
	CodexRealtimeExecutionIntent,
	CodexRealtimeInputOwner,
	CodexRealtimeItem,
	CodexRealtimeTranscript,
	CodexRealtimeUnsettledInput,
} from "./RealtimeTransport.js";
import { TurnLedger } from "./TurnLedger.js";
import type { RealtimeDataEvent } from "./WebRtcLeg.js";

/** T5b ②: the downlink must have been inaudible this long before a read-aloud. */
const READ_ALOUD_QUIET_MS = 600;

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
/**
 * FLY-2885 founder rework C: a Lead reply that could not be read to the end
 * says so out loud, and in the thread when it cannot be heard.
 */
export const READBACK_REMAINDER_NOTICE = "剩下的内容在频道里。";
export const READBACK_REMAINDER_STATUS = "📻 剩下的内容在频道里";
/** The spoken notice gets this long to find a pause of its own. */
const READBACK_NOTICE_CEILING_MS = 30_000;

/**
 * QA@2: v3 appendSpeech is speakable context, and after her barge-in the
 * model's next answer tends to finish it first (probe 8: 2/9 without a note).
 * This context note — never spoken, naming the text — stopped it (0/8). It
 * goes in as developer text (v3 `session.context.append`, accepted in every
 * probe-8 run).
 */
export function readbackAbandonedNote(text: string, spoken = ""): string {
	const cut =
		spoken !== "" && text.startsWith(spoken)
			? `打断时已经朗读到：「${spoken}」。禁止续念的剩余原文是：「${text.slice(spoken.length)}」。`
			: "";
	return `（系统提示，不要读出）用户刚刚打断了你正在朗读的 Lead 回复，原文是：「${text}」。${cut}从你被打断的地方起，这段原文一个字都不要再说——尤其不要补完被截断的半个词，不要把没说完的词或句子补完，不要接着念，也不要复述或总结；剩下的内容用户会在频道里看到。现在只回应用户刚刚说的话。`;
}

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
	readonly generation?: number;
	readonly transport: CodexTransportLike;
	/** T7: give up the current generation; a new one follows via events. */
	reconnect?(reason: string): void;
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
	/**
	 * FLY-2885 T4: the room's session-level Opus downlink. WebRTC packets are
	 * pushed into it synchronously, so an answer starts on its first frame.
	 */
	downlink?: () => DownlinkSink | undefined;
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
	/** One line in the voice thread (T7 reconnect notices). */
	postStatus?: (text: string) => Promise<void>;
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
				onDownlink: (input) => callbacks.session?.observeDownlink(input),
				onGenerationLost: (input) => callbacks.session?.generationLost(input),
				onGenerationReady: (input) => callbacks.session?.generationReady(input),
				onDataEvent: (input) => callbacks.session?.observeDataEvent(input),
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
	private readonly downlink: DownlinkController;
	private readonly turns: TurnLedger;
	private readonly now: () => Date;
	private readonly monotonicNow: () => number;
	/** Whether downlink audio is audible now (drives response-started/done). */
	private audible = false;
	private lastAudibleAt = Number.NEGATIVE_INFINITY;
	/** Someone's gated speech is reaching the uplink right now. */
	private speakerActive = false;
	/** T5c: the assistant turn under overrun discard ("pending" = not yet created). */
	private overrunTurnId?: string;
	/** Speech sent while the generation changed; it has no owner any more. */
	private uplinkLostDuringRestart = false;
	private durabilityTail: Promise<void> = Promise.resolve();
	private latestKnownUser?: {
		utterance: VoiceUtterance;
		persisted: Promise<boolean>;
	};
	private readonly handoffKeys = new Set<string>();
	/** Latest user final of the current generation, and the one handed off. */
	private latestUserTranscriptId?: string;
	private handedOffTranscriptId?: string;
	private repeatPromptSequence = 0;
	private sequence = 0;
	private inputGapSinceUserFinal = false;
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
		this.turns = new TurnLedger(this.monotonicNow);
		this.downlink = new DownlinkController({
			sink: () => options.downlink?.(),
			now: this.monotonicNow,
			evidence: (record) =>
				options.onEvidence?.({ generation: this.generation, ...record }),
			forceReconnect: (reason) =>
				this.restartGeneration(`speech_overrun_${reason}`),
		});
		this.speaker = new CodexProofSpeaker({
			sessionId: options.sessionId,
			sessionGeneration: () => this.generation,
			voice: options.voice,
			format: PCM24_MONO,
			transport: () => options.conversation.transport,
			isLive: () => this.live && !this.restarting && !this.closing,
			now: this.monotonicNow,
			busyReason: () => this.readAloudBusyReason(),
			roomActive: () => this.roomActive(),
			recovering: () => this.live && this.restarting && !this.closing,
			abandoned: (text, generation, spoken) =>
				this.noteAbandonedReadback(text, generation, spoken),
			consumedVoiced: () => options.downlink?.()?.stats().consumedVoiced ?? 0,
			queuedVoiced: () => options.downlink?.()?.queued().voiced ?? 0,
			interference: () => this.downlink.interference,
			trims: () => options.downlink?.()?.stats().trims ?? 0,
			overrun: (turnId) => {
				this.downlink.overrunDiscard();
				if (turnId !== undefined && this.turns.isDone(turnId)) {
					// Found by a final that came after its turn.done: the discard
					// state only waits for the quiet gap, never for another done.
					this.overrunTurnId = undefined;
					this.downlink.overrunTurnDone();
				} else this.overrunTurnId = turnId ?? "pending";
				this.updateAudible();
			},
			evidence: (record) => options.onEvidence?.(record),
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
		// The uplink sends one frame per tick; an owned frame left the gate.
		const speaking = owner.ownerUserId !== null;
		if (speaking) this.turns.speakerActive();
		if (speaking !== this.speakerActive) {
			this.speakerActive = speaking;
			this.downlink.founderSpeaking(speaking);
		}
		if (this.restarting) {
			// Plan T7: nothing can carry this speech across a generation change,
			// so it is dropped and whatever it belonged to is unattributed.
			if (speaking && !this.uplinkLostDuringRestart) {
				this.uplinkLostDuringRestart = true;
				this.markInputGap();
				this.options.onEvidence?.({
					kind: "codex_input_gap",
					reason: "generation_changed_uplink",
					generation: this.generation,
				});
			}
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
			this.receiptEvidence(kind, receipt);
			return receipt;
		});
	}

	/**
	 * FLY-2885 founder rework: a Lead reply, read to the end or honestly cut
	 * short. When sentences are left unread (no pause in time, her barge-in,
	 * a new generation, the session ending), she hears that the rest is in the
	 * channel; unless that notice is read to the end, the thread says it.
	 */
	async readReply(
		text: string,
		options: VoiceSpeakOptions,
	): Promise<SpeakReceipt> {
		const { receipt, unreadChunks } = await this.speaker.readReply(
			text,
			options,
		);
		this.receiptEvidence("readback", receipt);
		if (unreadChunks === 0) return receipt;
		this.options.onEvidence?.({
			kind: "codex_readback_unfinished",
			pendingKey: receipt.pendingKey,
			reason: "reason" in receipt ? receipt.reason : null,
			unreadChunks,
		});
		const notice =
			this.closing || !this.live
				? undefined
				: await this.speaker.readReply(
						READBACK_REMAINDER_NOTICE,
						{
							pendingKey: `${options.pendingKey}:remainder`,
							verification: "best_effort",
						},
						// The notice is ours, not the Lead's: nothing to steer off.
						{ ceilingMs: READBACK_NOTICE_CEILING_MS, noteOnAbandon: false },
					);
		if (notice) this.receiptEvidence("cue", notice.receipt);
		// One played packet is not a heard notice (review R1): unless it was
		// read to the end, the thread says it too.
		if (notice?.receipt.outcome !== "completed")
			this.status(READBACK_REMAINDER_STATUS);
		return receipt;
	}

	/** QA@2: tell the model not to finish a Lead-reply chunk she cut into. */
	private noteAbandonedReadback(
		text: string,
		generation: number,
		spoken?: string,
	): void {
		// Only into the generation that holds the text, and never while closing.
		if (
			this.closing ||
			this.restarting ||
			!this.live ||
			generation !== this.generation
		)
			return;
		this.options.onEvidence?.({
			kind: "codex_readback_abandoned_note",
			generation,
			chars: Array.from(text).length,
		});
		void this.options.conversation.transport
			.appendText(readbackAbandonedNote(text, spoken), "developer", generation)
			.catch((error) =>
				this.options.onEvidence?.({
					kind: "codex_readback_abandoned_note_failed",
					generation,
					reason: error instanceof Error ? error.message : "unknown_error",
				}),
			);
	}

	private receiptEvidence(kind: VoiceSpeakKind, receipt: SpeakReceipt): void {
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
	}

	injectContext(_text: string): void {
		this.unsupported("silent context injection is unverified");
	}

	endUserTurn(): void {
		// V2 owns turn boundaries through its realtime input protocol. No synthetic
		// user text or tool result is injected here.
	}

	/**
	 * FLY-2885 T5: barge-in is local. The room hears the old answer stop at
	 * once (the downlink is cut and muted); the provider truncates it on its
	 * own. The generation stays, so no founder speech is lost.
	 */
	interrupt(): void {
		this.cut("speech_interrupted");
	}

	/**
	 * The room is stopping (GenericVoiceSession.stop): the same local cut as a
	 * barge-in, but not hers — nothing is settled as interrupted by her, so no
	 * steering note goes to the model (review, QA@2 rework).
	 */
	stopSpeech(): void {
		this.cut("session_closed");
	}

	private cut(reason: "speech_interrupted" | "session_closed"): void {
		if (this.closing || this.restarting || !this.live) return;
		const readbackCut = this.speaker.interrupt(reason);
		this.downlink.bargeIn({ replayBuffered: !readbackCut });
		this.overrunTurnId = undefined;
		this.audible = false;
		this.options.onEvidence?.({
			kind: "codex_barge_in",
			generation: this.generation,
			local: true,
		});
		this.events.emit("response-cancelled");
	}

	/**
	 * T5c forced restart: the overrunning turn cannot be resumed on this
	 * generation. The conversation opens a new one (T7); its audio is never
	 * released again.
	 */
	private restartGeneration(reason: string): void {
		if (this.closing || this.restarting || !this.live) return;
		this.options.onEvidence?.({
			kind: "codex_generation_restart",
			reason,
			generation: this.generation,
		});
		if (!this.options.conversation.reconnect) {
			this.transportError(new Error("codex_realtime_reconnect_unsupported"));
			void this.close();
			return;
		}
		this.options.conversation.reconnect(reason);
	}

	/**
	 * T7: the current generation is gone. Nothing of it may be heard again,
	 * no read-aloud is left pending, and speech it had not transcribed can no
	 * longer be attributed.
	 */
	generationLost(input: { generation: number; reason: string }): void {
		if (this.closing || input.generation !== this.generation) return;
		const unsettled =
			this.options.conversation.transport.unsettledInput?.() ?? null;
		this.restarting = true;
		this.downlink.reset();
		this.speaker.interrupt("generation_changed");
		this.turns.reset();
		this.overrunTurnId = undefined;
		this.latestKnownUser = undefined;
		this.latestUserTranscriptId = undefined;
		this.markInputGap();
		this.options.onEvidence?.({
			kind: "codex_input_gap",
			reason: "generation_changed",
			generation: input.generation,
			droppedBytes: unsettled?.droppedBytes ?? null,
			providerInputPending: unsettled?.providerInputPending ?? null,
		});
		if (this.audible) {
			this.audible = false;
			this.events.emit("response-cancelled");
		}
		this.status("📻 语音连接断了，正在重连");
	}

	generationReady(input: { generation: number }): void {
		if (this.closing) return;
		this.generation = input.generation;
		this.restarting = false;
		this.uplinkLostDuringRestart = false;
		this.status("📻 已重连");
	}

	private status(text: string): void {
		void this.options.postStatus?.(text).catch((error) =>
			this.options.onEvidence?.({
				kind: "codex_status_failed",
				reason: error instanceof Error ? error.message : "unknown_error",
			}),
		);
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
		this.speaker.interrupt("session_closed");
		// Plan T7 order: nothing more goes up, nothing queued is heard.
		this.downlink.reset();
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

	observeItem(_item: CodexRealtimeItem): void {
		// v3 reports assistant turns on the data channel only (observeDataEvent).
	}

	/** One WebRTC downlink packet of `generation`, payload untouched. */
	observeDownlink(packet: {
		generation: number;
		payload: Buffer;
		voiced: boolean;
	}): void {
		if (
			this.closing ||
			this.restarting ||
			packet.generation !== this.generation
		)
			return;
		this.downlink.packet(packet);
		this.updateAudible();
		this.speaker.playbackProgress();
	}

	/** oai-events of `generation`: tolerated, never required. */
	observeDataEvent(input: {
		generation: number;
		event: RealtimeDataEvent;
	}): void {
		if (this.closing || this.restarting || input.generation !== this.generation)
			return;
		const event = input.event;
		if (event.type === "session.started") {
			this.options.onEvidence?.({
				kind: "codex_realtime_session_started",
				generation: input.generation,
				expiresAt: event.expiresAt,
			});
			return;
		}
		if (event.type === "turn.created") {
			this.turns.created(event.turnId, event.role);
			if (event.role === "user") {
				this.userTurnEvidence();
				return;
			}
			if (this.overrunTurnId === "pending") this.overrunTurnId = event.turnId;
			this.speaker.turnCreated({ turnId: event.turnId, role: event.role });
			return;
		}
		this.turns.done(event.turnId, event.role);
		if (event.role === "assistant" && event.turnId === this.overrunTurnId) {
			this.overrunTurnId = undefined;
			this.downlink.overrunTurnDone();
		}
		this.speaker.turnDone({
			turnId: event.turnId,
			role: event.role,
			transcript: event.transcript,
		});
	}

	/** New user speech: a user turn.created, or a user transcript. */
	private userTurnEvidence(): void {
		if (!this.turns.userEvidence()) return;
		this.downlink.userTurnEvidence();
		this.speaker.userEvidence();
	}

	/** T5b ①–⑤: why a read-aloud must not be sent now. */
	private readAloudBusyReason(): string | undefined {
		if (this.turns.openAssistantTurn()) return "assistant_turn_open";
		this.updateAudible();
		if (
			this.audible ||
			this.monotonicNow() - this.lastAudibleAt < READ_ALOUD_QUIET_MS
		)
			return "audible";
		if (this.speakerActive) return "speaker_active";
		if (this.turns.pendingUserTurn()) return "pending_user_turn";
		if (this.downlink.discarding) return "overrun_discard";
		if (this.downlink.blocking) return "barge_in";
		return undefined;
	}

	/**
	 * Founder rework B: the conversation is still going — someone is speaking,
	 * or the model's audio is audible, muted by a barge-in, or under overrun
	 * discard. A waiting Lead reply keeps waiting while this holds.
	 */
	private roomActive(): boolean {
		this.updateAudible();
		return (
			this.speakerActive ||
			this.audible ||
			this.monotonicNow() - this.lastAudibleAt < READ_ALOUD_QUIET_MS ||
			this.downlink.blocking
		);
	}

	/** response-started/done follow what the player can still be heard playing. */
	private updateAudible(): void {
		const audible = this.downlink.audible();
		if (audible) this.lastAudibleAt = this.monotonicNow();
		if (audible === this.audible) return;
		this.audible = audible;
		if (audible) {
			this.options.onEvidence?.({
				kind: "codex_response_audible",
				generation: this.generation,
			});
			this.events.emit("response-started");
		} else {
			this.events.emit("response-done");
		}
	}

	observeTranscript(transcript: CodexRealtimeTranscript): void {
		if (
			this.closing ||
			this.restarting ||
			transcript.generation !== this.generation
		)
			return;
		if (transcript.role === "user") this.userTurnEvidence();
		else
			this.speaker.assistantTranscript({
				text: transcript.text,
				final: transcript.final,
			});
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
		const adjustedText =
			transcript.role === "assistant"
				? this.speaker.truncateAssistantFinal(transcript.text)
				: transcript.text;
		if (transcript.role === "assistant" && adjustedText === "") {
			this.options.onEvidence?.({
				kind: "codex_readback_continuation_suppressed",
				generation: transcript.generation,
			});
			return;
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
			// T5c ③: an overrun read-aloud is kept only up to its line.
			text: adjustedText,
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
		}
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
		// required: the receipt must say whether the words were actually read.
		void this.speak(prompt, "cue", { pendingKey, verification: "required" });
	}

	observeBackgroundTurn(turn: CodexRealtimeBackgroundTurn): void {
		if (this.closing) return;
		this.options.onEvidence?.({ kind: "codex_background_turn", ...turn });
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

	private unsupported(message: string): void {
		this.events.emit("error", new VoiceError("unsupported", message));
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
