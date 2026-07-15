/**
 * reply-classifier (FLY-545 QA R3, Codex R23 HIGH-2) — decide whether a turn's
 * captured PCM delta is a REAL spoken reply, cue-only feedback, or silence.
 *
 * The old `delta > 20k bytes` check was fooled by the default earcon alone
 * (140ms = 26,880 bytes of 48k stereo s16le): a Lead that never answered still
 * scored REPLIED. Cues are bounded by design — earcon (~140ms) + filler
 * (~340ms) + margin — so anything within the cue budget is NOT a reply, and a
 * verdict of `cue-only` on every turn must FAIL the run loudly (it means the
 * pipeline acknowledged her and then said nothing).
 */
const BYTES_PER_SEC = 48_000 * 2 * 2; // 48k stereo s16le

/** worst-case cue audio per turn: earcon 140ms + filler 340ms, ×2 margin. */
export const CUE_BUDGET_BYTES = Math.round(BYTES_PER_SEC * (0.14 + 0.34) * 2);
/** a real spoken reply is at least ~1s of audio beyond any cues. */
export const MIN_REPLY_BYTES = CUE_BUDGET_BYTES + BYTES_PER_SEC;

/** @returns {"replied" | "cue-only" | "silent"} */
export function classifyReplyBytes(deltaBytes) {
	if (deltaBytes >= MIN_REPLY_BYTES) return "replied";
	if (deltaBytes > 0) return "cue-only";
	return "silent";
}
