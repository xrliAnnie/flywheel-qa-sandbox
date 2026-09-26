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
// ---- FLY-2798 canonical RoomIO v1 (Engine A) ----
export * from "./room/adapter.js";
export { AudioClock } from "./room/audio/AudioClock.js";
export { FrameQueue } from "./room/audio/FrameQueue.js";
export { JitterBuffer } from "./room/audio/JitterBuffer.js";
export {
	Downmix48to24 as RoomAudioDownmix48to24,
	Up24to48Stereo,
} from "./room/audio/Resample.js";
export {
	PCM24_MONO_SILENCE,
	PCM48_STEREO_SILENCE,
} from "./room/audio/Silence.js";
export { Downmix48to24, WaitingMouth } from "./room/audio.js";
export {
	createInitialSileroState,
	SILERO_MODEL_SHA256,
	type SileroScore,
	type SileroState,
	SileroVad,
} from "./room/pipeline/SileroVad.js";
export { Uplink, type UplinkFrameMetadata } from "./room/pipeline/Uplink.js";
export {
	type UplinkGateDegradedEvent,
	type UplinkGateDegradedReason,
	type UplinkGateFrame,
	type UplinkGateMode,
	type UplinkGateSummary,
	UplinkSpeechGate,
	uplinkGateDelayFrames,
} from "./room/pipeline/UplinkSpeechGate.js";
export {
	BridgeRoomIO,
	createRoomIO,
	ROOM_IO_IMPLEMENTATION_DIGEST,
	ROOM_IO_IMPLEMENTATION_KEY,
	ROOM_IO_IMPLEMENTATION_MANIFEST,
	ROOM_IO_VERSION,
	type RoomIOOptions,
} from "./room/RoomIO.js";
export {
	classifyReceiveFailure,
	ReceiveHealthTracker,
	VOICE_CODEX_RECEIVE_POLICY,
	voiceReceiveRuntimeEvidence,
} from "./room/receive-health.js";
export { SpeakerAttribution } from "./room/speaker-attribution.js";
