/**
 * flywheel-voice-headphone — FLY-546 headphone-mode daemon package.
 * Pure logic (queue / turn machine / phrases / tap filter) lives in
 * flywheel-voice-core's headphone module; this package composes it with
 * Discord + Bridge + an audio face.
 */
export {
	BridgeVoiceClient,
	type BridgeVoiceClientOptions,
	type FetchLike,
	type GateBinding,
	type ShipApprovalRequest,
	type ShipApprovalResult,
	type VoiceContext,
	type VoiceScope,
} from "./bridge-client.js";
export { type HeadphoneConfig, loadHeadphoneConfig } from "./config.js";
export { runHeadphoneDaemon } from "./daemon.js";
export {
	type BridgeLookups,
	type DaemonCoreOptions,
	type GatewayMessage,
	HeadphoneDaemonCore,
	type MachineLike,
} from "./daemon-core.js";
export { LocalEdgeAnnouncer } from "./local-announcer.js";
export {
	type DiscordSenderLike,
	type LocalAnnouncerLike,
	NullAudioIO,
	type NullAudioIOOptions,
	type ShipApprovalClientLike,
} from "./null-audio-io.js";
export {
	adoptOrSend,
	normalizeRestoredTurn,
	type RecoveryDeps,
	sendMarker,
} from "./recovery.js";
export {
	type DaemonState,
	loadState,
	STATE_SCHEMA_VERSION,
	saveState,
} from "./state-file.js";
