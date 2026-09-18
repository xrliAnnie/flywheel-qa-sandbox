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
			idleExitMs: 120_000,
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
