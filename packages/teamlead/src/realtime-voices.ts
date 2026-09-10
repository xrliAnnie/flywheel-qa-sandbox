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
