/** Refactored from Raya apps/voice/src/session/ExitProtocol.ts@f669d1b. */
import type { TranscriptDurabilityReceipt, VoiceUtterance } from "../types.js";

export const EXIT_SENTENCE = "好，退出语音模式。";
export const MAX_REALTIME_START_INSTRUCTIONS_CHARS = 8_192;
export const EXIT_PROTOCOL_CLAUSE = `
【退出语音的规则】
- 用户明确表示要结束或退出语音（例如「我要退出了」「先到这里」「结束语音」「我们下次再聊」）时，你只回答这一句，不加任何别的内容：「${EXIT_SENTENCE}」
- 用户的话里有「退出」「结束」等字眼但意思不是要结束语音（例如「我不想退出这个话题」）时，照常回答，不要说那句话。
- 拿不准时，先问「要退出语音吗？」，用户确认后再说那句话。
- 除了上面的情况，任何时候都不要说出「退出语音模式」这几个字。
`.trim();

export function composeStartInstructions(
	base: string,
	enabled: boolean,
): string {
	const composed =
		!enabled || base.includes(EXIT_PROTOCOL_CLAUSE)
			? base
			: `${base}\n\n${EXIT_PROTOCOL_CLAUSE}`;
	if (composed.length > MAX_REALTIME_START_INSTRUCTIONS_CHARS)
		throw new Error(
			"realtime start instructions must be at most 8,192 UTF-16 code units after composing the spoken-exit protocol",
		);
	return composed;
}

export function normalizeTranscript(text: string): string {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[\p{P}\p{S}\p{Z}\p{C}]/gu, "");
}

const SPOKEN_EXIT_PATTERN =
	/^(?:好(?:的|吧)?|行|ok(?:ay)?|嗯|那(?:我(?:们)?)?|我们|现在){0,4}退出语音模式(?:再见|拜拜|下次见|回头见|回头聊)?$/u;

export function isSpokenExit(text: string): boolean {
	return (
		text.length <= 64 && SPOKEN_EXIT_PATTERN.test(normalizeTranscript(text))
	);
}

export function isFounderExitRequest(text: string): boolean {
	const normalized = normalizeTranscript(text);
	if (/不(?:想|要|会)?(?:退出|结束)/u.test(normalized)) return false;
	return /(?:退出语音|结束语音|先到这里|我们下次再聊|下次再聊)/u.test(
		normalized,
	);
}

/** Accept the assistant exit sentence only after a durable final utterance
 * from the canonical founder in this exact session generation. */
export class SpokenExitGuard {
	private armedByTranscriptId?: string;

	constructor(
		private readonly sessionId: string,
		private readonly generation: number,
		private readonly founderUserId: string,
	) {}

	observeFounderRequest(
		utterance: VoiceUtterance,
		receipt: TranscriptDurabilityReceipt,
	): boolean {
		const armed =
			utterance.sessionId === this.sessionId &&
			utterance.generation === this.generation &&
			utterance.role === "user" &&
			utterance.final === true &&
			utterance.attribution.kind === "known" &&
			utterance.attribution.speakerUserId === this.founderUserId &&
			receipt.durable === true &&
			receipt.sessionId === utterance.sessionId &&
			receipt.transcriptId === utterance.transcriptId &&
			isFounderExitRequest(utterance.text);
		this.armedByTranscriptId = armed ? utterance.transcriptId : undefined;
		return armed;
	}

	observeAssistant(utterance: VoiceUtterance): boolean {
		const accepted =
			this.armedByTranscriptId !== undefined &&
			utterance.sessionId === this.sessionId &&
			utterance.generation === this.generation &&
			utterance.role === "assistant" &&
			utterance.final === true &&
			isSpokenExit(utterance.text);
		if (utterance.role === "assistant" && utterance.final)
			this.armedByTranscriptId = undefined;
		return accepted;
	}
}
