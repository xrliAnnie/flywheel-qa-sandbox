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
import type {
	CodexRealtimeAppendOutcome,
	CodexRealtimeAudioDelta,
	CodexRealtimeInputOwner,
	CodexRealtimeItem,
	CodexRealtimeTranscript,
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
}

interface CodexConversationLike {
	transport: CodexTransportLike;
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
	now?: () => Date;
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
				onClosed: (input) => callbacks.session?.transportClosed(input.reason),
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
	private readonly audio = new Map<string, Buffer[]>();
	private readonly outputStarted = new Set<string>();
	private durabilityTail: Promise<void> = Promise.resolve();
	private sequence = 0;
	private live = true;
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
		this.speaker = new CodexProofSpeaker({
			sessionId: options.sessionId,
			sessionGeneration: 1,
			voice: options.voice,
			format: PCM24_MONO,
			transport: options.conversation.transport,
			isLive: () => this.live && !this.closing,
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
		const result = this.options.conversation.transport.appendAudio(
			frame,
			1,
			owner,
		);
		if (result.startsWith("dropped:")) {
			this.events.emit(
				"error",
				new VoiceError("backend-protocol", `Codex audio ${result}`),
			);
		}
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
		if (this.closing) return;
		this.live = false;
		void this.options.conversation.transport
			.cancel()
			.catch((error) =>
				this.transportError(
					error instanceof Error ? error : new Error(String(error)),
				),
			);
		this.events.emit("response-cancelled");
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
		if (this.closing) return;
		if (item.role === "assistant") {
			this.speaker.observeAssistantItem(item);
			if (!this.outputStarted.has(item.itemId)) {
				this.outputStarted.add(item.itemId);
				this.events.emit("response-started");
			}
		}
	}

	observeAudio(delta: CodexRealtimeAudioDelta): void {
		if (this.closing) return;
		const chunks = this.audio.get(delta.itemId) ?? [];
		chunks.push(delta.pcm24Mono);
		this.audio.set(delta.itemId, chunks);
		this.events.emit("response-audio", delta.pcm24Mono, PCM24_MONO);
	}

	observeTranscript(transcript: CodexRealtimeTranscript): void {
		if (this.closing) return;
		this.speaker.observeTranscript(transcript);
		this.events.emit("transcript", {
			role: transcript.role,
			text: transcript.text,
			final: transcript.final,
		});
		if (!transcript.final) return;
		const sequence = ++this.sequence;
		const itemId = transcript.itemId ?? `unattributed-${sequence}`;
		const utterance: VoiceUtterance = {
			sessionId: this.sessionId,
			sessionGeneration: 1,
			utteranceId: `${this.sessionId}:1:${itemId}`,
			transcriptId: `${this.sessionId}:1:${itemId}:${sequence}`,
			ts: this.now().toISOString(),
			sequence,
			source: transcript.role === "user" ? "room_audio" : "engine_audio",
			role: transcript.role,
			text: transcript.text,
			final: true,
			attribution:
				transcript.role === "assistant"
					? { kind: "unknown", reason: "engine_output" }
					: {
							kind: "unknown",
							reason:
								transcript.association === "preceding_item"
									? "provider_item_not_speaker_bound"
									: "provider_item_unattributed",
						},
		};
		this.events.emit("utterance", utterance);
		this.persist(utterance, transcript);
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

	transportClosed(reason: string): void {
		if (this.closing) return;
		this.events.emit(
			"error",
			new VoiceError("connection-closed", "Codex realtime closed", reason),
		);
	}

	transportError(error: Error): void {
		this.events.emit(
			"error",
			new VoiceError("backend-protocol", "Codex realtime failed", error),
		);
	}

	private persist(
		utterance: VoiceUtterance,
		transcript: CodexRealtimeTranscript,
	): void {
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
		this.durabilityTail = this.durabilityTail.then(async () => {
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
				return;
			}
			try {
				await this.options.persistUtterance?.(utterance, captureDigest);
			} catch (error) {
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
		});
	}

	private async play(itemId: string, generation: number): Promise<void> {
		const chunks = this.audio.get(itemId) ?? [];
		this.audio.delete(itemId);
		if (chunks.length === 0) return;
		try {
			await this.options.playAudio?.({
				itemId,
				pcm24Mono: Buffer.concat(chunks),
				generation,
			});
			this.speaker.observePlaybackSubmitted({ generation, itemId });
			this.events.emit("response-done");
		} catch (error) {
			this.transportError(
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	}

	private unsupported(message: string): void {
		this.events.emit("error", new VoiceError("unsupported", message));
	}
}
