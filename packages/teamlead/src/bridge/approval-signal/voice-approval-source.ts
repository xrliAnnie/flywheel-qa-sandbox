/**
 * FLY-546 B3-1 — VoiceSource: fills the reserved `source:"voice"` slot in the
 * ApprovalSignal union (types.ts — "Annie: extensible to voice").
 *
 * STRICTER than the text source: the §14 c-tier flow is an explicit spoken
 * readback ("你确认把 FLY-901 ship 上线?") answered by an exact confirmation
 * word, so there is NO Tier-3 classifier here — ambiguity is `unclear`,
 * never a guess (mishearing an approval is the expensive failure).
 *
 * The word sets mirror flywheel-voice-core's headphone phrases module. This
 * source owns the authoritative voice-approval normalizer: clients submit the
 * founder's verbatim transcript and must not pre-decide the approval result.
 */
import type { ApprovalSignal } from "./types.js";

const CONFIRM = ["确认", "对"] as const;
const DENY = ["不对", "取消", "不批"] as const;

function normalize(text: string): string {
	const compact = Array.from(
		text
			.normalize("NFKC")
			.toLowerCase()
			.replace(/[\p{P}\p{S}\s]+/gu, ""),
	);
	return compact
		.filter((character, index) => character !== compact[index - 1])
		.join("");
}

function matches(text: string, words: readonly string[]): boolean {
	const norm = normalize(text);
	if (norm.length === 0) return false;
	return words.some((w) => normalize(w) === norm);
}

export interface VoiceSourceArgs {
	gate: {
		questionId: string;
		prHeadSha: string;
		canonicalFounderId: string;
	};
	utterance: {
		transcriptId: string;
		text: string;
		/** the speaker the daemon attributed this utterance to (SSRC→user id). */
		founderUserId: string;
	};
}

export function evaluateVoiceSource(
	args: VoiceSourceArgs,
): Extract<ApprovalSignal, { source: "voice" }> | null {
	const { gate, utterance } = args;
	// Identity: only an utterance attributed to the canonical founder's own
	// audio track can carry approval authority.
	if (utterance.founderUserId !== gate.canonicalFounderId) return null;

	const kind = matches(utterance.text, CONFIRM)
		? ("approve" as const)
		: matches(utterance.text, DENY)
			? ("reject" as const)
			: ("unclear" as const);

	return {
		source: "voice",
		kind,
		questionId: gate.questionId,
		prHeadSha: gate.prHeadSha,
		transcriptId: utterance.transcriptId,
	};
}
