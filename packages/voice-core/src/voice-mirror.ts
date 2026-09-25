/**
 * Voice-room messages the voice daemon posts into a session thread as the Lead
 * bot (FLY-2799). The Bridge's outbound poller reads that same thread for Lead
 * replies to speak, so every line the voice side posts must carry one of these
 * leading marks — otherwise the founder hears her own words, or a status line,
 * read back to her. Posters build their text from these marks; the poller
 * excludes by them. One list, two ends.
 *
 * Marks are compared without the emoji variation selector (U+FE0F): Discord
 * clients and bots may send either form.
 */
export const VOICE_MIRROR_MARKS = {
	/** daemon / room status lines */
	status: "📻",
	/** engine A (legacy room) founder transcript */
	legacyTranscript: "🗣️",
	/** engine B assistant transcript */
	assistantTranscript: "🤖",
	/** engine B user transcript */
	userTranscript: "🎙️",
} as const;

const VARIATION_SELECTOR = /️/gu;

const BASE_MARKS = Object.values(VOICE_MIRROR_MARKS).map((mark) =>
	mark.replace(VARIATION_SELECTOR, ""),
);

/** True when a thread message is the voice side's own mirror or status line. */
export function isVoiceMirrorText(text: string): boolean {
	const head = text.trimStart().replace(VARIATION_SELECTOR, "");
	return BASE_MARKS.some((mark) => head.startsWith(mark));
}
