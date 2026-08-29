/**
 * Assembly helpers — build the announce backend (Edge TTS), the converse backend
 * (Gemini Live), the brain, and the backend registry from a resolved config.
 * Kept separate from cli.ts so the wiring is unit-testable without a terminal.
 */

import type { AudioPlayer } from "./audio/FilePlayer.js";
import { FilePlayer } from "./audio/FilePlayer.js";
import { EdgeTtsBackend } from "./backends/edge-tts/EdgeTtsBackend.js";
import { EdgeTts } from "./backends/edge-tts/EdgeTtsEngine.js";
import {
	GeminiLiveBackend,
	type GeminiModelProfile,
} from "./backends/gemini/GeminiLiveBackend.js";
import { createGenaiTransport } from "./backends/gemini/genaiConnector.js";
import type { GeminiLiveTransport } from "./backends/gemini/transport.js";
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

export interface ConverseWiring {
	/** injected transport (tests / custom); defaults to the real @google/genai one. */
	transport?: GeminiLiveTransport;
	/** model capability flags; asyncFunctionCalling defaults to false (safe). */
	asyncFunctionCalling?: boolean;
	connectionSec?: number;
	audioSec?: number;
	/** api key for the real transport (from config's apiKeyEnv); ignored if transport given. */
	apiKey?: string;
}

export function buildGeminiBackend(
	config: VoiceCoreConfig,
	wiring: ConverseWiring = {},
): GeminiLiveBackend {
	const profile: GeminiModelProfile = {
		model: config.gemini.model,
		asyncFunctionCalling: wiring.asyncFunctionCalling ?? false,
		connectionSec: wiring.connectionSec,
		audioSec: wiring.audioSec,
	};
	const transport =
		wiring.transport ?? createGenaiTransport({ apiKey: wiring.apiKey ?? "" });
	return new GeminiLiveBackend({ transport, profile });
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
	converse?: ConverseWiring;
	/** register the converse (gemini) backend (needs a key or an injected transport). */
	enableConverse?: boolean;
}

/**
 * Registry with the edge-tts announce backend (always) and, when enabled, the
 * gemini-live converse backend. Factories are lazy, so registering gemini does
 * not construct its transport until it is selected.
 */
export function buildRegistry(
	config: VoiceCoreConfig,
	wiring: RegistryWiring = {},
): BackendRegistry {
	const registry = new BackendRegistry();
	registry.register("edge-tts", () =>
		buildEdgeTtsBackend(config, wiring.announce),
	);
	if (wiring.enableConverse || wiring.converse?.transport) {
		registry.register("gemini-live", () =>
			buildGeminiBackend(config, wiring.converse),
		);
	}
	return registry;
}
