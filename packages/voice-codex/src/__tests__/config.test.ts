import { describe, expect, it } from "vitest";
import {
	loadVoiceDaemonConfig,
	resolveLeadVoiceToken,
	voiceCodexEnv,
} from "../config.js";

describe("voice daemon config", () => {
	const projection = {
		projectName: "raya",
		leadId: "raya-lead",
		guildId: "123456789012345678",
		voiceChannelId: "223456789012345678",
		voiceBotUserId: "323456789012345678",
	};
	const project = {
		projectName: "raya",
		voiceRoom: {
			guildId: projection.guildId,
			voiceChannelId: projection.voiceChannelId,
		},
		leads: [
			{
				agentId: projection.leadId,
				botUserId: projection.voiceBotUserId,
				botTokenEnv: "RAYA_TOKEN",
			},
		],
	};
	it("resolves only the pinned Lead token, including same-ID credential rotation", () => {
		expect(
			resolveLeadVoiceToken(projection, [project], {
				RAYA_TOKEN: "secret",
				HUDDLE_TOKEN: "wrong",
			}),
		).toBe("secret");
		expect(
			resolveLeadVoiceToken(projection, [project], { RAYA_TOKEN: "rotated" }),
		).toBe("rotated");
	});
	it.each([
		"projectName",
		"leadId",
		"guildId",
		"voiceChannelId",
		"voiceBotUserId",
	] as const)("rejects missing or drifted %s", (field) => {
		for (const value of ["", "wrong", undefined]) {
			expect(() =>
				resolveLeadVoiceToken({ ...projection, [field]: value }, [project], {
					RAYA_TOKEN: "secret",
				}),
			).toThrow(/registry_drift/);
		}
	});
	it("rejects ambiguous project or Lead and legacy config without fallback", () => {
		for (const projects of [
			[],
			[project, project],
			[{ ...project, leads: [] }],
			[{ ...project, leads: [...project.leads, ...project.leads] }],
			[{ ...project, huddle: {} }],
			[{ ...project, voiceRoom: null }],
		]) {
			expect(() =>
				resolveLeadVoiceToken(projection, projects, { RAYA_TOKEN: "secret" }),
			).toThrow(/registry_drift/);
		}
		expect(() =>
			resolveLeadVoiceToken(projection, [project], { HUDDLE_TOKEN: "wrong" }),
		).toThrow("voice_bot_token_unset");
		expect(() =>
			resolveLeadVoiceToken(
				projection,
				[
					{
						...project,
						leads: [
							{
								...project.leads[0],
								botTokenEnv: "bad-name",
								botToken: "cached",
							},
						],
					},
				],
				{},
			),
		).toThrow(/registry_drift/);
	});

	it("rejects lease timings without a strict half-TTL margin", () => {
		expect(() =>
			loadVoiceDaemonConfig(
				{
					TEAMLEAD_API_TOKEN: "master",
					OPENAI_API_KEY: "api-key",
					FLYWHEEL_VOICE_LEASE_TTL_MS: "10000",
					FLYWHEEL_VOICE_LEASE_RENEW_MS: "4000",
					FLYWHEEL_VOICE_LEASE_HTTP_TIMEOUT_MS: "1000",
				},
				"/Users/tester",
			),
		).toThrow(/half the lease TTL/);
	});

	it.each([undefined, "", "  "])(
		"requires a nonempty parent API key: %s",
		(key) => {
			expect(() =>
				loadVoiceDaemonConfig(
					{ TEAMLEAD_API_TOKEN: "master", OPENAI_API_KEY: key },
					"/Users/tester",
				),
			).toThrow("OPENAI_API_KEY is required");
		},
	);

	it("uses bounded delivery retry defaults", () => {
		const config = loadVoiceDaemonConfig(
			{ TEAMLEAD_API_TOKEN: "master", OPENAI_API_KEY: "api-key" },
			"/Users/tester",
		);
		expect(config).toMatchObject({
			realtimeApiKey: "api-key",
			bridgeUrl: "http://127.0.0.1:9876",
			idleHttpTimeoutMs: 2_000,
			leaseHttpTimeoutMs: 2_000,
			mirrorRetryWindowMs: 60_000,
			mirrorRetries: 1,
			ingestRetries: 1,
			deliveryRetryMs: 500,
			healthStateRoot: "/Users/tester/.flywheel",
			voiceHealthHelperPath:
				"/Users/tester/Dev/flywheel/scripts/lib/voice-health.py",
		});
	});

	it("derives health paths only from trusted Flywheel roots, never the voice subdirectory", () => {
		const config = loadVoiceDaemonConfig(
			{
				TEAMLEAD_API_TOKEN: "master",
				OPENAI_API_KEY: "api-key",
				FLYWHEEL_DIR: "/opt/flywheel",
				FLYWHEEL_STATE_DIR: "/var/lib/flywheel",
				FLYWHEEL_VOICE_STATE_DIR: "/var/lib/custom-voice",
			},
			"/Users/tester",
		);

		expect(config.healthStateRoot).toBe("/var/lib/flywheel");
		expect(config.voiceHealthHelperPath).toBe(
			"/opt/flywheel/scripts/lib/voice-health.py",
		);
		expect(config.healthStateRoot).not.toBe(config.voiceRoot);
	});

	it("gives the canonical Bridge URL precedence over the compatibility alias", () => {
		const base = { TEAMLEAD_API_TOKEN: "master", OPENAI_API_KEY: "api-key" };
		expect(
			loadVoiceDaemonConfig(
				{
					...base,
					FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9001/",
					BRIDGE_URL: "http://127.0.0.1:9002",
				},
				"/Users/tester",
			).bridgeUrl,
		).toBe("http://127.0.0.1:9001");
		expect(
			loadVoiceDaemonConfig(
				{ ...base, BRIDGE_URL: "http://localhost:9002/" },
				"/Users/tester",
			).bridgeUrl,
		).toBe("http://localhost:9002");
	});

	it("configures idle and lease HTTP timeouts independently", () => {
		const config = loadVoiceDaemonConfig(
			{
				TEAMLEAD_API_TOKEN: "master",
				OPENAI_API_KEY: "api-key",
				FLYWHEEL_VOICE_IDLE_HTTP_TIMEOUT_MS: "7000",
				FLYWHEEL_VOICE_LEASE_HTTP_TIMEOUT_MS: "1500",
			},
			"/Users/tester",
		);

		expect(config.idleHttpTimeoutMs).toBe(7_000);
		expect(config.leaseHttpTimeoutMs).toBe(1_500);
	});

	it.each([
		"https://bridge.example.com",
		"ftp://127.0.0.1:9876",
		"http://user:pass@127.0.0.1:9876",
		"http://127.0.0.1:9876?token=secret",
		"http://127.0.0.1:9876/#private",
	])(
		"rejects an unsafe canonical Bridge URL without falling back: %s",
		(url) => {
			expect(() =>
				loadVoiceDaemonConfig(
					{
						TEAMLEAD_API_TOKEN: "master",
						OPENAI_API_KEY: "api-key",
						FLYWHEEL_BRIDGE_URL: url,
						BRIDGE_URL: "http://127.0.0.1:9876",
					},
					"/Users/tester",
				),
			).toThrow("voice_bridge_url_invalid");
		},
	);

	it("builds a positive environment allowlist for the no-tool Codex frontend", () => {
		expect(
			voiceCodexEnv({
				HOME: "/Users/tester",
				PATH: "/usr/bin:/bin",
				HTTPS_PROXY: "http://proxy.test",
				TEAMLEAD_API_TOKEN: "secret",
				GH_TOKEN: "secret",
				OPENAI_API_KEY: "api-secret",
				UNRELATED: "nope",
			}),
		).toEqual({
			HOME: "/Users/tester",
			PATH: "/usr/bin:/bin",
			HTTPS_PROXY: "http://proxy.test",
		});
	});
});
