/**
 * Assembly helpers — build the announce backend (Edge TTS), the brain, and the
 * backend registry from a resolved config. Kept separate from cli.ts so the
 * wiring is unit-testable without a terminal. FLY-2860 retired the bundled
 * converse backend; converse backends (voice-codex) register themselves.
 */

import type { AudioPlayer } from "./audio/FilePlayer.js";
import { FilePlayer } from "./audio/FilePlayer.js";
import { EdgeTtsBackend } from "./backends/edge-tts/EdgeTtsBackend.js";
import { EdgeTts } from "./backends/edge-tts/EdgeTtsEngine.js";
import { BackendRegistry } from "./backends/registry.js";
import { HeadlessClaudeBrain } from "./brain/HeadlessClaudeBrain.js";
import { type VoiceCoreConfig, verifyAnnounceComponents } from "./config.js";
import type { ProcessRunner } from "./process.js";
import type { BrainAdapter } from "./types.js";

export interface AnnounceWiring {
	runner?: ProcessRunner;
	player?: AudioPlayer;
	now?: () => number;
	skipVerify?: boolean;
}

export function buildEdgeTtsBackend(
	config: VoiceCoreConfig,
	wiring: AnnounceWiring = {},
): EdgeTtsBackend {
	if (!wiring.skipVerify) verifyAnnounceComponents(config);
	const tts = new EdgeTts({
		command: config.edgeTts.command,
		baseArgs: config.edgeTts.args,
		timeoutMs: config.timeouts.ttsMs,
		runner: wiring.runner,
	});
	const player =
		wiring.player ??
		new FilePlayer({ afplayBin: config.afplayBin, runner: wiring.runner });
	return new EdgeTtsBackend({
		tts,
		player,
		defaultVoice: config.voice,
		now: wiring.now,
	});
}

export function buildHeadlessBrain(
	config: VoiceCoreConfig,
	runner?: ProcessRunner,
): BrainAdapter {
	return new HeadlessClaudeBrain({
		claudeBin: config.claudeBin,
		identityFile: config.identityFile,
		timeoutMs: config.timeouts.brainMs,
		runner,
	});
}

export interface RegistryWiring {
	announce?: AnnounceWiring;
}

/** Registry with the edge-tts announce backend. Factories are lazy. */
export function buildRegistry(
	config: VoiceCoreConfig,
	wiring: RegistryWiring = {},
): BackendRegistry {
	const registry = new BackendRegistry();
	registry.register("edge-tts", () =>
		buildEdgeTtsBackend(config, wiring.announce),
	);
	return registry;
}
