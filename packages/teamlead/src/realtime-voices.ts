export const REALTIME_V2_VOICES = [
	"alloy",
	"ash",
	"ballad",
	"coral",
	"echo",
	"sage",
	"shimmer",
	"verse",
	"marin",
	"cedar",
] as const;

export type RealtimeV2Voice = (typeof REALTIME_V2_VOICES)[number];

export function isRealtimeV2Voice(value: unknown): value is RealtimeV2Voice {
	return REALTIME_V2_VOICES.some((voice) => voice === value);
}

/**
 * FLY-2885: engine B (Codex realtime v3, gpt-live-1-codex) accepts only these
 * nine voices; its default is cove. A separate list from REALTIME_V2_VOICES —
 * the two fields never fall back to each other.
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
