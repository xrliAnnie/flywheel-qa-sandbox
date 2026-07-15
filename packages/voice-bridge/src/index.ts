/**
 * flywheel-voice-bridge — public surface (FLY-545).
 *
 * Consumed by THREE parties (public-contract standard, changes must stay
 * backward compatible): FLY-545 itself (/meet), FLY-546 (voice approval
 * signal + per-Lead voices), FLY-967 (/gemini assistant mode, which builds its
 * assistant/* modules on this exact chassis).
 */

// ---- FLY-967 /gemini assistant mode (assistant/*) ----
export {
	AssistantLanding,
	type AssistantLandingOptions,
	type LandingInput,
	type LandingLinear,
	type LandingResult,
} from "./assistant/AssistantLanding.js";
export {
	AssistantSession,
	type AssistantSessionOptions,
	type AssistantSessionState,
	type ConversationLike,
	type EarsFeed,
	type SpeakerLike,
	type TivSurface,
	type VoicePresence,
} from "./assistant/AssistantSession.js";
export {
	AssistantSpeaker,
	type AssistantSpeakerOptions,
} from "./assistant/AssistantSpeaker.js";
export {
	type BoardIssue,
	BriefingEngine,
	type BriefingEngineOptions,
	type BriefingResult,
	type IssuesPage,
} from "./assistant/BriefingEngine.js";
export {
	ASSISTANT_SLOT_MODE,
	type AssistantBriefingConfig,
	type AssistantModeConfig,
	resolveAssistantConfig,
} from "./assistant/config.js";
export {
	GeminiCommand,
	type GeminiCommandOptions,
	type GeminiInvocation,
} from "./assistant/GeminiCommand.js";
export {
	type AssistantToolDeps,
	boardSnapshotTool,
	buildAssistantTools,
	lookupIssueTool,
} from "./assistant/tools.js";
export {
	type AssistantRuntime,
	type WireAssistantOptions,
	wireAssistantMode,
} from "./assistant/wiring.js";
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
// ---- FLY-1160 resident brain loopback port ----
export {
	BrainPort,
	type BrainPortBrain,
	type BrainPortManager,
	type BrainPortOptions,
} from "./brain/BrainPort.js";
export {
	main,
	type RunVoiceBridgeOptions,
	runVoiceBridge,
	type VoiceBridgeRuntime,
} from "./cli.js";
export {
	type HuddleBrainConfig,
	type HuddleBridgeConfig,
	type HuddleBridgeLead,
	loadHuddleBridgeConfig,
	resolveHuddleBridgeConfig,
} from "./config.js";
// ---- FLY-1006 /eleven mode (eleven/*) ----
export {
	ELEVEN_SLOT_MODE,
	type ElevenModeConfig,
	loadElevenConfig,
	resolveElevenConfig,
} from "./eleven/config.js";
export {
	ElevenCommand,
	type ElevenCommandOptions,
	type ElevenInvocation,
	type ElevenPreflightResult,
} from "./eleven/ElevenCommand.js";
export {
	type ElevenEars,
	ElevenSession,
	type ElevenSessionOptions,
	type ElevenSessionState,
	type ElevenSpeakerLike,
	type ElevenTiv,
	type ElevenWsHandlers,
	type ElevenWsLike,
} from "./eleven/ElevenSession.js";
export {
	type ElevenMetadata,
	type ElevenOverrides,
	ElevenWs,
	type ElevenWsOptions,
	type WsLike,
} from "./eleven/ElevenWs.js";
export {
	type ElevenRuntime,
	type WireElevenOptions,
	wireElevenMode,
} from "./eleven/wiring.js";
export { type BinaryProbe, verifyPlaybackStack } from "./preflight.js";
export {
	type RoomEarsRuntime,
	type WireRoomEarsOptions,
	wireRoomEars,
} from "./roomEars.js";
export {
	type AcquireResult,
	SessionSlot,
	type SessionSlotHolder,
	type SessionSlotOptions,
} from "./SessionSlot.js";
export { type RoomFrameCb, VoiceRoomRuntime } from "./VoiceRoomRuntime.js";
