import { createHash } from "node:crypto";
import { scrubTranscript, type VoiceUtterance } from "flywheel-voice-core";
import type {
	VoiceHandoffReceipt,
	VoiceHandoffToLeadInput,
} from "../bridge-client.js";
import type { CodexRealtimeExecutionIntent } from "./RealtimeTransport.js";

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function nonce(sessionId: string, transcriptId: string): string {
	return BigInt(`0x${digest(`${sessionId}:${transcriptId}`)}`)
		.toString(36)
		.slice(0, 25);
}

export function buildCodexDelegateHandoff(input: {
	sessionId: string;
	leadId: string;
	utterance: VoiceUtterance;
	intent: CodexRealtimeExecutionIntent;
}): VoiceHandoffToLeadInput {
	if (
		input.utterance.role !== "user" ||
		!input.utterance.final ||
		input.utterance.attribution.kind !== "known"
	) {
		throw new Error("codex_delegate_utterance_not_authorized");
	}
	const backendIdentity = [
		input.sessionId,
		input.utterance.transcriptId,
		input.intent.generation,
		input.intent.kind,
		input.intent.method,
		input.intent.itemId ?? "none",
	].join(":");
	return {
		intentKind: "delegate_request",
		payload: {
			backendIntentKind: input.intent.kind,
			backendMethod: input.intent.method,
			...(input.intent.itemId ? { backendItemId: input.intent.itemId } : {}),
		},
		transcriptId: input.utterance.transcriptId,
		originalText: input.utterance.text,
		idempotencyKey: `codex-delegate:${digest(backendIdentity).slice(0, 32)}`,
		authorityBinding: {
			version: 1,
			source: "codex_voice_execution_intent",
			sessionId: input.sessionId,
			leadId: input.leadId,
			transcriptId: input.utterance.transcriptId,
			speakerUserId: input.utterance.attribution.speakerUserId,
		},
	};
}

export class CodexTranscriptPublisher {
	private tail: Promise<void> = Promise.resolve();

	constructor(
		private readonly options: {
			sessionId: string;
			founderUserId: string;
			displayName: string;
			mirror(input: {
				text: string;
				nonce: string;
			}): Promise<{ messageId: string }>;
			evidence(record: Record<string, unknown>): void;
		},
	) {}

	publish(utterance: VoiceUtterance): Promise<void> {
		const publish = this.tail.then(() => this.publishOne(utterance));
		this.tail = publish.catch(() => undefined);
		return publish;
	}

	private async publishOne(utterance: VoiceUtterance): Promise<void> {
		if (!utterance.final) return;
		const safeText = Array.from(scrubTranscript(utterance.text).trim())
			.slice(0, 1_800)
			.join("");
		if (!safeText) return;
		const speaker =
			utterance.role === "assistant"
				? `🤖 **${this.options.displayName.replace(/[*_~`\\]/gu, "").slice(0, 80)} 语音分身**`
				: utterance.attribution.kind === "known" &&
						utterance.attribution.speakerUserId === this.options.founderUserId
					? "🎙️ **你（语音）**"
					: "🎙️ **语音输入**";
		const mirrored = await this.options.mirror({
			text: `${speaker}：${safeText}`,
			nonce: nonce(this.options.sessionId, utterance.transcriptId),
		});
		this.options.evidence({
			kind: "codex_transcript_published",
			transcriptId: utterance.transcriptId,
			role: utterance.role,
			messageId: mirrored.messageId,
		});
	}
}

export type CodexHandoffResult = Pick<
	VoiceHandoffReceipt,
	"handoffId" | "state" | "idempotencyKey" | "requestDigest"
>;
