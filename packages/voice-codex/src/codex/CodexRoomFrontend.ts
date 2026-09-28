import { randomUUID } from "node:crypto";
import type {
	BackendFactory,
	BackendRegistry,
	ConversationOptions,
	ConversationSession,
	SpeakReceipt,
	VoiceBackend,
	VoiceSpeakOptions,
} from "flywheel-voice-core";
import type { VoiceEnd } from "../daemon.js";
import type { RealtimeAudioOwner } from "../realtime.js";
import { type PreparedSpeech, stripHandoffCorrelation } from "../speech.js";
import { CodexVoiceContainerError } from "./CodexVoiceContainer.js";

export interface CodexRoomFrontendHandlers {
	onResponseState(active: boolean): void;
	onTranscript(input: {
		itemId: string;
		contentIndex: number;
		text: string;
		ownerUserId: string;
		speakerName: string;
		utteranceId: string;
	}): void;
	onUnattributedTranscript?(input: {
		itemId: string;
		text: string;
		reason: string;
	}): void;
	onSpeechAudioReady(input: { speechId: string; pcm24Mono: Buffer }): void;
	onSpeechResult(input: {
		speechId: string;
		status: "rejected" | "timeout" | "failed";
		reason: string;
	}): void;
	onClosed(outcome: VoiceEnd): void;
}

export function registerCodexVoiceBackend(
	registry: BackendRegistry,
	factory: BackendFactory,
): void {
	registry.register("codex-realtime", factory);
}

function unavailableCopy(error: CodexVoiceContainerError): string {
	switch (error.reason) {
		case "codex_quota_exhausted":
			return "📻 语音不可用：Codex 额度已用完";
		case "codex_auth_rejected":
			return "📻 语音不可用：Codex 认证失败";
		// FLY-2885 plan §12.5: never the context itself, only why.
		case "context_too_large":
			return "📻 语音不可用：这位 Lead 的记忆与上下文超出语音会话上限";
		case "context_invalid":
			return "📻 语音不可用：上下文无法核对大小";
		default:
			return "📻 语音不可用：Codex 容器启动失败";
	}
}

function diagnosticText(value: string): string {
	return Array.from(value, (character) => {
		const code = character.charCodeAt(0);
		return code < 32 || code === 127 ? " " : character;
	})
		.join("")
		.trim();
}

function failureReason(error: Error & { code?: string }): string {
	const parts = [error.code ?? error.name, error.message];
	if (error.cause instanceof Error) {
		parts.push(error.cause.name, error.cause.message);
	} else if (typeof error.cause === "string") {
		parts.push(error.cause);
	}
	const original = diagnosticText(parts.filter(Boolean).join(":"));
	return original.length <= 500
		? original
		: `${original.slice(0, 488)}:[truncated]`;
}

function readbackStatus(
	receipt: SpeakReceipt,
): "confirmed" | "unconfirmed" | "failed" {
	if (receipt.outcome === "completed") return "confirmed";
	return receipt.outcome === "failed" && receipt.transport !== "none"
		? "unconfirmed"
		: "failed";
}

/**
 * Adapts the shared ConversationSession contract to the existing room/session
 * lifecycle. It owns no room transport and performs no fallback selection.
 */
export class CodexRoomFrontend {
	private session?: ConversationSession;
	private closePromise?: Promise<void>;
	private readonly handlers?: CodexRoomFrontendHandlers;

	constructor(
		private readonly options: {
			backend: VoiceBackend;
			conversationOptions: ConversationOptions;
			handlers?: CodexRoomFrontendHandlers;
			onUnavailable(text: string): void | Promise<void>;
		},
	) {
		this.handlers = options.handlers;
	}

	async start(signal?: AbortSignal): Promise<void> {
		if (this.session) throw new Error("codex_room_frontend_started");
		if (!this.options.backend.createConversation)
			throw new Error("codex_conversation_unavailable");
		try {
			const session = await this.options.backend.createConversation(
				this.options.conversationOptions,
			);
			if (signal?.aborted) {
				await session.close();
				throw new Error("codex_room_start_aborted");
			}
			this.session = session;
			this.bind(session);
		} catch (error) {
			if (error instanceof CodexVoiceContainerError)
				await this.options.onUnavailable(unavailableCopy(error));
			throw error;
		}
	}

	appendAudio(frame: Buffer, metadata: RealtimeAudioOwner): void {
		const session = this.requireSession() as ConversationSession & {
			sendOwnedAudio?: (frame: Buffer, owner: RealtimeAudioOwner) => void;
		};
		if (session.sendOwnedAudio) session.sendOwnedAudio(frame, metadata);
		else
			session.sendAudio(frame, {
				encoding: "pcm16",
				sampleRateHz: 24_000,
				channels: 1,
			});
	}

	async appendSpeech(
		speech: PreparedSpeech,
	): Promise<"confirmed" | "unconfirmed" | "failed"> {
		const session = this.requireSession();
		if (!session.speak) return "failed";
		const receipt = await session.speak(speech.spokenText, "readback", {
			pendingKey: speech.speechId,
			verification: "required",
		});
		return readbackStatus(receipt);
	}

	/**
	 * FLY-2885 founder rework: the whole Lead reply in one read, so it can wait
	 * for the conversation, resume after an overrun and say what was left
	 * unread. The handoff-id line the Lead quotes for correlation is not read.
	 */
	async appendReply(
		text: string,
		chunkCharacters: number,
	): Promise<"confirmed" | "unconfirmed" | "failed"> {
		const session = this.requireSession() as ConversationSession & {
			readReply?: (
				text: string,
				options: VoiceSpeakOptions,
			) => Promise<SpeakReceipt>;
		};
		if (!session.readReply) return "failed";
		const receipt = await session.readReply(stripHandoffCorrelation(text), {
			pendingKey: randomUUID(),
			verification: "required",
			chunkCharacters,
		});
		return readbackStatus(receipt);
	}

	/**
	 * `__conversation__` is her barge-in (GenericVoiceSession); any other id
	 * is the room stopping with a reading in flight, which is not hers.
	 */
	cancelSpeech(speechId?: string): void {
		const session = this.session as
			| (ConversationSession & { stopSpeech?: () => void })
			| undefined;
		if (speechId === undefined || speechId === "__conversation__")
			session?.interrupt();
		else if (session?.stopSpeech) session.stopSpeech();
		else session?.interrupt();
	}

	stop(): Promise<void> {
		this.closePromise ??= this.session
			? this.session.close().then(() => undefined)
			: Promise.resolve();
		return this.closePromise;
	}

	private requireSession(): ConversationSession {
		if (!this.session) throw new Error("codex_room_frontend_not_started");
		return this.session;
	}

	private bind(session: ConversationSession): void {
		session.on("response-started", () => this.handlers?.onResponseState(true));
		session.on("response-done", () => this.handlers?.onResponseState(false));
		session.on("response-cancelled", () =>
			this.handlers?.onResponseState(false),
		);
		session.on("utterance", (utterance) => {
			if (utterance.role !== "user" || !utterance.final) return;
			if (utterance.attribution.kind === "unknown") {
				// Visible transcript publication happens before this authorization
				// seam in CodexVoiceBackend for both known and unknown finals. Unknown
				// speech must not enter VoiceDelivery/Lead authority, but it must not
				// disappear silently either.
				this.handlers?.onUnattributedTranscript?.({
					itemId: utterance.transcriptId,
					text: utterance.text,
					reason: utterance.attribution.reason,
				});
				return;
			}
			this.handlers?.onTranscript({
				itemId: utterance.transcriptId,
				contentIndex: utterance.sequence,
				text: utterance.text,
				ownerUserId: utterance.attribution.speakerUserId,
				speakerName: utterance.attribution.speakerUserId,
				utteranceId: utterance.utteranceId,
			});
		});
		session.on("session-expiring", () =>
			this.handlers?.onClosed({
				kind: "ended",
				reason: "realtime_session_expiring",
			}),
		);
		session.on("error", (error) =>
			this.handlers?.onClosed({ kind: "failed", reason: failureReason(error) }),
		);
	}
}
