import type {
	BackendFactory,
	BackendRegistry,
	ConversationOptions,
	ConversationSession,
	VoiceBackend,
} from "flywheel-voice-core";
import type { VoiceEnd } from "../daemon.js";
import type { RealtimeAudioOwner } from "../realtime.js";
import type { PreparedSpeech } from "../speech.js";
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
		default:
			return "📻 语音不可用：Codex 容器启动失败";
	}
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
		if (receipt.outcome === "completed") return "confirmed";
		return receipt.outcome === "failed" && receipt.transport !== "none"
			? "unconfirmed"
			: "failed";
	}

	cancelSpeech(): void {
		this.session?.interrupt();
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
			if (
				utterance.role !== "user" ||
				!utterance.final ||
				utterance.attribution.kind !== "known"
			)
				return;
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
			this.handlers?.onClosed({ kind: "failed", reason: error.code }),
		);
	}
}
