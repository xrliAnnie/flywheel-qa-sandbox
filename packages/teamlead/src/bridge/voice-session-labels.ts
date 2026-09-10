import type { VoiceSessionMode } from "../StateStore.js";

export function voiceThreadName(input: {
	mode: VoiceSessionMode;
	topic: string | null;
	createdAt: string;
	rootMessageId: string;
}): string {
	if (!input.topic) return `voice-${input.rootMessageId.slice(-8)}`;
	if (input.mode === "rg") {
		return `🎧 随身 · ${input.createdAt.slice(0, 16).replace("T", " ")}`;
	}
	const suffix = ` · ${input.createdAt.slice(0, 10)}`;
	const available = 100 - Array.from(`🎙️ ${suffix}`).length;
	return `🎙️ ${Array.from(input.topic).slice(0, available).join("")}${suffix}`;
}
