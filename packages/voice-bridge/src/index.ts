/**
 * flywheel-voice-bridge — the Discord voice wiring library voice-codex runs on.
 *
 * FLY-2860 retired the legacy voice-bridge daemon and its slash commands
 * (/gemini, /gemini-advanced, /eleven, /glaw). What remains is the shared
 * discord.js / @discordjs/voice glue: bot registry, the DiscordDeps seam and
 * the Lead playback speaker.
 */

export {
	LeadSpeaker,
	type LeadSpeakerOptions,
	type LeadSpeakerResult,
	type PlayerLike,
	type ResourceSource,
	type SpeakSource,
} from "./audio/LeadSpeaker.js";
export {
	BotRegistry,
	type BotRegistryOptions,
	type BotSpec,
	type RegistryClientLike,
	type VoiceJoinOpts,
} from "./bots/BotRegistry.js";
export {
	buildVoiceJoinOptions,
	createDiscordDeps,
	type DiscordDeps,
	type DiscordReceiveDiagnostic,
	type DiscordReceivePolicy,
	type DiscordReceiveRuntimeDiagnostic,
	loadDiscordReceiveRuntimeDiagnostic,
	parseDiscordReceiveDiagnostic,
} from "./bots/discordWiring.js";
