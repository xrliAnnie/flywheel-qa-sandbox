import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs module shared by the executable e2e rigs
import { buildStagedConfig } from "../../e2e/lib/rig-config.mjs";

describe("buildStagedConfig (FLY-1353)", () => {
	it("carries every boot-read field into the config passed to runVoiceBridge", () => {
		const config = buildStagedConfig({
			STAGED_PROJECT_NAME: "voice-qa",
			STAGED_GUILD_ID: "guild-qa",
			STAGED_VC_ID: "vc-qa",
			STAGED_HEALTH_PORT: "9988",
			HUDDLE_ORCH_BOT_TOKEN: "orch-token",
			HUDDLE_EARS_BOT_TOKEN: "ears-token",
			FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9877",
			FLYWHEEL_API_TOKEN: "bridge-token",
			GEMINI_API_KEY: "gemini-token",
			FLYWHEEL_HUDDLE_GEMINI_MODEL: "gemini-live-qa",
			DISCORD_OWNER_USER_ID: "founder-qa",
			FFMPEG_BIN: "ffmpeg-qa",
		});

		expect(config).toMatchObject({
			projectName: "voice-qa",
			guildId: "guild-qa",
			voiceChannelId: "vc-qa",
			orchestratorToken: "orch-token",
			earsToken: "ears-token",
			bridgeUrl: "http://127.0.0.1:9877",
			apiToken: "bridge-token",
			geminiApiKey: "gemini-token",
			geminiModel: "gemini-live-qa",
			founderUserId: "founder-qa",
			bargeInMinRms: 0,
			bargeInHoldoffMs: 1_000,
			healthPort: 9_988,
			ffmpegBin: "ffmpeg-qa",
			backchannelMs: 350,
			allowUserIds: [],
		});
	});

	it("mirrors the loader defaults used by staged rigs while keeping the measurement noise gate off", () => {
		const config = buildStagedConfig({
			STAGED_GUILD_ID: "guild-qa",
			STAGED_VC_ID: "vc-qa",
			HUDDLE_ORCH_BOT_TOKEN: "orch-token",
			HUDDLE_EARS_BOT_TOKEN: "ears-token",
			FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9877",
			FLYWHEEL_API_TOKEN: "bridge-token",
			GEMINI_API_KEY: "gemini-token",
		});

		expect(config).toMatchObject({
			projectName: "flywheel",
			geminiModel: "gemini-3.1-flash-live-preview",
			founderUserId: "",
			bargeInMinRms: 0,
			bargeInHoldoffMs: 1_000,
			healthPort: 9_879,
			ffmpegBin: "ffmpeg",
		});
	});

	it.each(["gemini-staged.mjs", "gemini-voice-loop.mjs"])(
		"%s uses the shared builder and an overridable presence override default",
		(file) => {
			const source = readFileSync(
				fileURLToPath(new URL(`../../e2e/${file}`, import.meta.url)),
				"utf8",
			);
			expect(source).toContain(
				'import { buildStagedConfig } from "./lib/rig-config.mjs";',
			);
			expect(source).toContain("buildStagedConfig(");
			expect(source).toContain(
				'process.env.FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE ??= "1";',
			);
		},
	);
});
