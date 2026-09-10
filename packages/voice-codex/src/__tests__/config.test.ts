import { describe, expect, it } from "vitest";
import {
	loadVoiceDaemonConfig,
	resolveVoiceBotToken,
	voiceCodexEnv,
} from "../config.js";

describe("voice daemon config", () => {
	it("resolves the registry-owned huddle bot without storing a token in config", () => {
		expect(
			resolveVoiceBotToken(
				"raya",
				"123456789012345678",
				"223456789012345678",
				[
					{
						projectName: "raya",
						huddle: {
							guildId: "123456789012345678",
							voiceChannelId: "223456789012345678",
							orchestratorBotTokenEnv: "HUDDLE_TOKEN",
						},
					},
				],
				{ HUDDLE_TOKEN: "secret" },
			),
		).toBe("secret");
		expect(() =>
			resolveVoiceBotToken(
				"raya",
				"wrong",
				"223456789012345678",
				[
					{
						projectName: "raya",
						huddle: {
							guildId: "123456789012345678",
							voiceChannelId: "223456789012345678",
							orchestratorBotTokenEnv: "HUDDLE_TOKEN",
						},
					},
				],
				{ HUDDLE_TOKEN: "secret" },
			),
		).toThrow(/registry_drift/);
	});

	it("rejects lease timings without a strict half-TTL margin", () => {
		expect(() =>
			loadVoiceDaemonConfig(
				{
					TEAMLEAD_API_TOKEN: "master",
					FLYWHEEL_VOICE_LEASE_TTL_MS: "10000",
					FLYWHEEL_VOICE_LEASE_RENEW_MS: "4000",
					FLYWHEEL_VOICE_LEASE_HTTP_TIMEOUT_MS: "1000",
				},
				"/Users/tester",
			),
		).toThrow(/half the lease TTL/);
	});

	it("uses bounded delivery retry defaults", () => {
		const config = loadVoiceDaemonConfig(
			{ TEAMLEAD_API_TOKEN: "master" },
			"/Users/tester",
		);
		expect(config).toMatchObject({
			mirrorRetryWindowMs: 60_000,
			mirrorRetries: 1,
			ingestRetries: 1,
			deliveryRetryMs: 500,
		});
	});

	it("builds a positive environment allowlist for the no-tool Codex frontend", () => {
		expect(
			voiceCodexEnv({
				HOME: "/Users/tester",
				PATH: "/usr/bin:/bin",
				HTTPS_PROXY: "http://proxy.test",
				TEAMLEAD_API_TOKEN: "secret",
				GH_TOKEN: "secret",
				UNRELATED: "nope",
			}),
		).toEqual({
			HOME: "/Users/tester",
			PATH: "/usr/bin:/bin",
			HTTPS_PROXY: "http://proxy.test",
		});
	});
});
