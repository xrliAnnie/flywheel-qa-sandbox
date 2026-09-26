/**
 * flywheel-voice-core — public surface (plan.md r2).
 *
 * The upper layer (a Lead skill, the FLY-544 Discord bridge, ...) imports the
 * TYPES + the REGISTRY and never a concrete backend, so voice backends stay
 * pluggable behind one dual-face (announce / converse) contract.
 */

// audio
export {
	type AudioPlayer,
	FilePlayer,
	type FilePlayerOptions,
	type Playback,
} from "./audio/FilePlayer.js";
export { MicCapture, type MicCaptureOptions } from "./audio/MicCapture.js";
export {
	StreamPlayer,
	type StreamPlayerOptions,
} from "./audio/StreamPlayer.js";
export {
	EdgeTtsBackend,
	type EdgeTtsBackendOptions,
} from "./backends/edge-tts/EdgeTtsBackend.js";
export {
	EdgeTts,
	type EdgeTtsOptions,
} from "./backends/edge-tts/EdgeTtsEngine.js";
// backends + registry
export {
	assertBackendConsistent,
	type BackendFactory,
	BackendRegistry,
} from "./backends/registry.js";
// brain
export {
	HeadlessClaudeBrain,
	type HeadlessClaudeBrainOptions,
	parseStreamLine,
} from "./brain/HeadlessClaudeBrain.js";
export {
	type ParsedStreamEvent,
	parseStreamEvent,
	type StreamEventKind,
} from "./brain/stream-parse.js";
// config
export {
	type ConfigOverrides,
	resolveConfig,
	type VoiceCoreConfig,
	verifyAnnounceComponents,
	verifyBrainComponents,
} from "./config.js";
export { TypedEmitter } from "./emitter.js";
export { mapProcessError } from "./errors.js";
// assembly
export {
	type AnnounceWiring,
	buildEdgeTtsBackend,
	buildHeadlessBrain,
	buildRegistry,
	type RegistryWiring,
} from "./factory.js";
// headphone mode (FLY-546) — pure logic layer
export * from "./headphone/index.js";
export {
	AbortError,
	NodeProcessRunner,
	type ProcessExitInfo,
	type ProcessHandle,
	type ProcessRunner,
	type RunOptions,
	type RunResult,
	type SpawnOptions,
	TimeoutError,
} from "./process.js";
export {
	parseReceiveHealth,
	RECEIVE_REASONS,
	RECEIVE_STATES,
	type ReceiveHealth,
	type ReceiveReason,
	type ReceiveState,
} from "./receive-health.js";
// secret red line (FLY-1065) — every transcript exit passes through this
export { scrubTranscript } from "./scrub.js";
// shared layer
export {
	clearTranscriptWriteFailure,
	getTranscriptWriteFailure,
	JsonlTranscriptSink,
	MemoryTranscriptSink,
} from "./transcript.js";
// contract
export * from "./types.js";
// voice-thread mirror marks shared by the posters and the Bridge poller
export { isVoiceMirrorText, VOICE_MIRROR_MARKS } from "./voice-mirror.js";
