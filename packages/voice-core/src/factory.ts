/**
 * Assembly helpers — build the announce backend (Edge TTS), the OpenAI Live
 * converse backend, the brain, and the backend registry from a resolved config.
 * Kept separate from cli.ts so the wiring is unit-testable without a terminal.
 * FLY-2860 retired the bundled Gemini backend; other converse backends
 * (voice-codex) register themselves.
 */

import type { AudioPlayer } from "./audio/FilePlayer.js";
import { FilePlayer } from "./audio/FilePlayer.js";
import { EdgeTtsBackend } from "./backends/edge-tts/EdgeTtsBackend.js";
import { EdgeTts } from "./backends/edge-tts/EdgeTtsEngine.js";
import {
	GptLiveBackend,
	type OpenAiLiveConnector,
} from "./backends/openai-live/GptLiveBackend.js";
import { OpenAiLiveTransport } from "./backends/openai-live/liveTransport.js";
import { BackendRegistry } from "./backends/registry.js";
import { HeadlessClaudeBrain } from "./brain/HeadlessClaudeBrain.js";
import {
	type VoiceCoreConfig,
	verifyAnnounceComponents,
	verifyOpenAiLiveComponents,
} from "./config.js";
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
		streamCommand: config.edgeTts.streamCommand,
		streamMaxBufferedBytes: config.edgeTts.streamMaxBufferedBytes,
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

export interface OpenAiLiveWiring {
	/** Injected transport for tests; defaults to the configured public endpoint. */
	transport?: OpenAiLiveConnector;
	/** Explicit credential override; otherwise resolved from config.apiKeyEnv. */
	apiKey?: string;
}

export function buildGptLiveBackend(
	config: VoiceCoreConfig,
	wiring: OpenAiLiveWiring = {},
): GptLiveBackend {
	const apiKey =
		wiring.apiKey ?? process.env[config.openaiLive.apiKeyEnv] ?? "";
	verifyOpenAiLiveComponents(config, {
		[config.openaiLive.apiKeyEnv]: wiring.transport ? "injected" : apiKey,
	});
	const transport =
		wiring.transport ??
		new OpenAiLiveTransport({
			endpoint: config.openaiLive.endpoint,
			apiKey,
		});
	return new GptLiveBackend({
		transport,
		model: config.openaiLive.model,
		voice: config.openaiLive.voice,
		contextMaxTokens: config.openaiLive.contextMaxTokens,
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
	openaiLive?: OpenAiLiveWiring;
}

/**
 * Registry with the edge-tts announce backend (always) and, when wired, the
 * OpenAI Live converse backend. Factories are lazy.
 */
export function buildRegistry(
	config: VoiceCoreConfig,
	wiring: RegistryWiring = {},
): BackendRegistry {
	const registry = new BackendRegistry();
	registry.register("edge-tts", () =>
		buildEdgeTtsBackend(config, wiring.announce),
	);
	if (wiring.openaiLive) {
		registry.register("openai-live", () =>
			buildGptLiveBackend(config, wiring.openaiLive),
		);
	}
	return registry;
}
