// FLY-2383: the single frozen cross-repo contract for the voice concurrency soak.
//
// Every dynamic import, handshake, SHA check, Prism resolution and the first page
// of the data appendix reads from here. Nothing may hardcode these elsewhere:
// the whole point is that a reader of the appendix can tell exactly which harness
// and which subject SHA produced the numbers.
export const CROSS_REPO = Object.freeze({
	EXPECTED_CONTRACT_VERSION: "raya-voice-529/v1",

	// The raya baseline this measurement is defined against. Both the harness root
	// and the subject root must be clean and sit on this exact commit, or the run
	// refuses to start (exit 78). CONTRACT_VERSION alone cannot catch semantic
	// drift inside the internal modules we import directly.
	EXPECTED_RAYA_SHA: "b1b5a64f2f060349b95f39c6cf4b05b453a6a7f1",

	// Cross-repo imports, spelled out rather than derived, all relative to --harness-root.
	IMPORTS: Object.freeze({
		orchestrator: "scripts/qa/lib/orchestrator.mjs",
		envCompose: "scripts/qa/lib/env-compose.mjs",
		session: "scripts/qa/lib/session.mjs",
		ttsFixture: "scripts/qa/lib/tts-fixture.mjs",
		scenario: "scripts/qa/raya-voice-529.mjs",
		emitter: "probes/c9-voice-emitter.mjs",
		contracts: "packages/contracts/dist/index.js",
	}),

	// prism-media is a dependency of raya's voice app, not of flywheel. Resolving it
	// from the flywheel root returns NOT_FOUND, so the driver anchors a createRequire
	// at this package.json inside the (already SHA-verified) harness root.
	PRISM_ANCHOR: "apps/voice/package.json",
});

// 48kHz stereo s16le, 960 samples per channel, 20ms per frame.
export const PCM48_STEREO_FRAME_BYTES = 3_840;
export const PCM_SAMPLE_RATE_HZ = 48_000;
export const PCM_SAMPLES_PER_CHANNEL = 960;
export const PCM_FRAME_MS = 20;
export const FRAMES_PER_SECOND = 1_000 / PCM_FRAME_MS;

// The five notes of the approved "box B" waiting sound, ported into raya as
// apps/voice/src/audio/Bed.ts. These are what the tonal detector listens for.
export const BOX_B_NOTES_HZ = Object.freeze([261.63, 293.66, 329.63, 392, 440]);

// The qualification policy a threshold file must have been accepted under. A
// stale file from a retracted policy classifies identically but was qualified by
// a different rule, so the id is checked exactly rather than trusted.
export const QUALIFICATION_POLICY_ID = "fly2383/window-level/v3";

// Every run bundle must carry these, whatever the manifest happens to list.
export const REQUIRED_RAW_ARTIFACTS = Object.freeze([
	"frames.jsonl",
	"bridge-receipts.jsonl",
	"session/state/voice-evidence/events.jsonl",
]);

// A window shot through with unobserved seconds is not a clean observation.
// Shared so the report can re-judge a run rather than trust its manifest.
export const MAX_HOLE_SHARE = 0.1;
export const MIN_MAIN_RUN_DURATION_MS = 1_800_000;

export const THRESHOLD_KEYS = Object.freeze([
	"silenceFloor",
	"bedTonalMin",
	"bedEnergyMax",
	"voiceEnergyMin",
	"voiceTonalMax",
]);

export const AUDIO_CLASSES = Object.freeze([
	"voice",
	"bed",
	"silence",
	"unknown",
]);
