import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs module shared by the executable e2e rigs
import {
	buildStagedConfig,
	buildStagedResidentIdentity,
} from "../../e2e/lib/rig-config.mjs";

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

	it("supplies the resident lease's founder and Lead identities", () => {
		expect(
			buildStagedResidentIdentity(
				{ STAGED_LEAD_ID: "voice-qa-lead" },
				"founder-from-guild-owner",
			),
		).toEqual({
			leadId: "voice-qa-lead",
			founderUserId: "founder-from-guild-owner",
		});
		expect(buildStagedResidentIdentity({}, "founder-from-guild-owner")).toEqual(
			{
				leadId: "flywheel-eng-lead",
				founderUserId: "founder-from-guild-owner",
			},
		);
		expect(() => buildStagedResidentIdentity({}, "")).toThrow(
			/staged founder identity is required/,
		);
	});

	it.each(["gemini-voice-loop.mjs", "eleven-voice-loop.mjs"])(
		"%s supplies the shared resident identity to its mode and room config",
		(file) => {
			const source = readFileSync(
				fileURLToPath(new URL(`../../e2e/${file}`, import.meta.url)),
				"utf8",
			);
			expect(source).toContain("buildStagedResidentIdentity(");
			expect(source).toContain("leadId: residentIdentity.leadId");
			expect(source).toContain("founderUserId: residentIdentity.founderUserId");
		},
	);

	it("supplies the resident Lead identity to the /gemini holder in the /eleven mutex boot", () => {
		const source = readFileSync(
			fileURLToPath(
				new URL("../../e2e/eleven-voice-loop.mjs", import.meta.url),
			),
			"utf8",
		);
		const bootAAssistant = source.slice(
			source.indexOf("\t\tassistant: {"),
			source.indexOf("\t\tassistantWiring: {"),
		);
		expect(bootAAssistant).toContain("leadId: residentIdentity.leadId");
	});

	it.each(["gemini-staged.mjs", "gemini-voice-loop.mjs"])(
		"%s uses the shared builder and an overridable presence override default",
		(file) => {
			const source = readFileSync(
				fileURLToPath(new URL(`../../e2e/${file}`, import.meta.url)),
				"utf8",
			);
			expect(source).toMatch(
				/import\s*{[^}]*buildStagedConfig[^}]*}\s*from\s*"\.\/lib\/rig-config\.mjs";/s,
			);
			expect(source).toContain("buildStagedConfig(");
			expect(source).toContain(
				'process.env.FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE ??= "1";',
			);
		},
	);

	it("restores the caller Bridge config between the /eleven mutex and audio boots", () => {
		const source = readFileSync(
			fileURLToPath(
				new URL("../../e2e/eleven-voice-loop.mjs", import.meta.url),
			),
			"utf8",
		);
		const captureBridgeUrl = source.indexOf(
			'const stagedBridgeUrl = need("FLYWHEEL_BRIDGE_URL");',
		);
		const captureApiToken = source.indexOf(
			'const stagedApiToken = process.env.FLYWHEEL_API_TOKEN ?? "staged-mutex-leg";',
		);
		const mutexOverride = source.indexOf(
			'process.env.FLYWHEEL_BRIDGE_URL = "http://10.255.255.255:9877";',
		);
		const restoreBridgeUrl = source.indexOf(
			"process.env.FLYWHEEL_BRIDGE_URL = stagedBridgeUrl;",
			mutexOverride,
		);
		const restoreApiToken = source.indexOf(
			"process.env.FLYWHEEL_API_TOKEN = stagedApiToken;",
			mutexOverride,
		);
		const audioBoot = source.indexOf(
			'log("boot B: /eleven only — audio round + barge-in + survival");',
		);

		expect(captureBridgeUrl).toBeGreaterThan(-1);
		expect(captureApiToken).toBeGreaterThan(-1);
		expect(captureBridgeUrl).toBeLessThan(mutexOverride);
		expect(captureApiToken).toBeLessThan(mutexOverride);
		expect(restoreBridgeUrl).toBeGreaterThan(mutexOverride);
		expect(restoreApiToken).toBeGreaterThan(mutexOverride);
		expect(restoreBridgeUrl).toBeLessThan(audioBoot);
		expect(restoreApiToken).toBeLessThan(audioBoot);
	});

	it("runs the default /eleven mutex and audio boots in isolated child processes", () => {
		const source = readFileSync(
			fileURLToPath(
				new URL("../../e2e/eleven-voice-loop.mjs", import.meta.url),
			),
			"utf8",
		);
		const allBranch = source.indexOf('if (LEGS === "all")');
		const login = source.indexOf("await injector.login(injectorToken);");

		expect(allBranch).toBeGreaterThan(-1);
		expect(allBranch).toBeLessThan(login);
		expect(source).toContain('for (const leg of ["mutex", "audio"])');
		expect(source).toContain("ELEVEN_LOOP_LEGS: leg");
	});

	it("proves /eleven STOP from non-silent PCM rather than continuous clock bytes", () => {
		const source = readFileSync(
			fileURLToPath(
				new URL("../../e2e/eleven-voice-loop.mjs", import.meta.url),
			),
			"utf8",
		);
		expect(source).toContain("nonSilentBytes");
		expect(source).toContain("nonSilentAfterCut");
		expect(source).not.toContain("grewAfterCut < 288_000");
	});
});
