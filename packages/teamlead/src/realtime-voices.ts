/**
 * FLY-2885: engine B (Codex realtime v3, gpt-live-1-codex) accepts only these
 * nine voices; its default is cove.
 */
export const LIVE_V3_VOICES = [
	"juniper",
	"maple",
	"spruce",
	"ember",
	"vale",
	"breeze",
	"arbor",
	"sol",
	"cove",
] as const;

export type LiveV3Voice = (typeof LIVE_V3_VOICES)[number];

export const DEFAULT_LIVE_V3_VOICE: LiveV3Voice = "cove";

export function isLiveV3Voice(value: unknown): value is LiveV3Voice {
	return LIVE_V3_VOICES.some((voice) => voice === value);
}
