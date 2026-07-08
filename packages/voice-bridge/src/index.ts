/**
 * flywheel-voice-bridge — public surface (FLY-545).
 *
 * Consumed by THREE parties (public-contract standard, changes must stay
 * backward compatible): FLY-545 itself (/meet), FLY-546 (voice approval
 * signal + per-Lead voices), FLY-967 (/live assistant mode, which builds its
 * assistant/* modules on this exact chassis).
 */
export {
	EarsReceiver,
	type EarsReceiverOptions,
	type SpeakingEvents,
} from "./audio/EarsReceiver.js";
export {
	LeadSpeaker,
	type LeadSpeakerOptions,
	type LeadSpeakerResult,
	type PlayerLike,
	type ResourceSource,
	type SpeakSource,
} from "./audio/LeadSpeaker.js";
export {
	StereoDownmixDecimator,
	upsample24kMonoTo48kStereo,
} from "./audio/resample.js";
export {
	BotRegistry,
	type BotRegistryOptions,
	type BotSpec,
	type RegistryClientLike,
	type VoiceJoinOpts,
} from "./bots/BotRegistry.js";
export {
	createDiscordDeps,
	type DiscordDeps,
} from "./bots/discordWiring.js";
export {
	main,
	type RunVoiceBridgeOptions,
	runVoiceBridge,
	type VoiceBridgeRuntime,
} from "./cli.js";
export {
	type HuddleBridgeConfig,
	type HuddleBridgeLead,
	loadHuddleBridgeConfig,
	resolveHuddleBridgeConfig,
} from "./config.js";
export { type BinaryProbe, verifyPlaybackStack } from "./preflight.js";
export {
	type AcquireResult,
	SessionSlot,
	type SessionSlotHolder,
	type SessionSlotOptions,
} from "./SessionSlot.js";
