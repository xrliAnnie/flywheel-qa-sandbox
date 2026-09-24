export const VOICE_HANDOFF_INTENT_KINDS = [
	"query",
	"judgment",
	"action",
] as const;

export type VoiceHandoffIntentKind =
	(typeof VOICE_HANDOFF_INTENT_KINDS)[number];
