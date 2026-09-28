import { describe, expect, it } from "vitest";
import {
	loadVoiceDaemonConfig,
	resolveLeadVoiceToken,
	resolveVoiceCommDbPath,
	scrubVoiceApiKeys,
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

	it("reserves enough lease time for a health retry and fencing margin", () => {
		expect(() =>
			loadVoiceDaemonConfig(
				{
					TEAMLEAD_API_TOKEN: "master",
					OPENAI_API_KEY: "api-key",
					FLYWHEEL_VOICE_LEASE_TTL_MS: "15000",
					FLYWHEEL_VOICE_LEASE_RENEW_MS: "2000",
					FLYWHEEL_VOICE_LEASE_HTTP_TIMEOUT_MS: "4500",
				},
				"/Users/tester",
			),
		).toThrow(/health retry/);
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
			{
				TEAMLEAD_API_TOKEN: "master",
				OPENAI_API_KEY: "api-key",
				FLYWHEEL_VOICE_BUILD_SHA: "a".repeat(40),
			},
			"/Users/tester",
		);
		expect(config).toMatchObject({
			backendId: "openai-realtime",
			realtimeApiKey: "api-key",
			buildSha: "a".repeat(40),
			speechChunkTokens: 80,
			bridgeUrl: "http://127.0.0.1:9876",
			idleHttpTimeoutMs: 2_000,
			leaseHttpTimeoutMs: 2_000,
			idleExitMs: 120_000,
			mirrorRetryWindowMs: 60_000,
			mirrorRetries: 1,
			ingestRetries: 1,
			deliveryRetryMs: 500,
			healthStateRoot: "/Users/tester/.flywheel",
			voiceHealthHelperPath:
				"/Users/tester/Dev/flywheel/scripts/lib/voice-health.py",
		});
	});

	it("enables Codex only explicitly and requires an absolute standalone binary", () => {
		expect(
			loadVoiceDaemonConfig(
				{
					TEAMLEAD_API_TOKEN: "master",
					OPENAI_API_KEY: "api-key",
					FLYWHEEL_VOICE_BACKEND: "codex-realtime",
					FLYWHEEL_CODEX_BIN: "/opt/flywheel/codex-0.156.1/codex",
				},
				"/Users/tester",
			),
		).toMatchObject({
			backendId: "codex-realtime",
			codexBin: "/opt/flywheel/codex-0.156.1/codex",
		});
		for (const env of [
			{ FLYWHEEL_VOICE_BACKEND: "unknown" },
			{
				FLYWHEEL_VOICE_BACKEND: "codex-realtime",
				FLYWHEEL_CODEX_BIN: "codex",
			},
		]) {
			expect(() =>
				loadVoiceDaemonConfig(
					{
						TEAMLEAD_API_TOKEN: "master",
						OPENAI_API_KEY: "api-key",
						...env,
					},
					"/Users/tester",
				),
			).toThrow(/voice backend|standalone Codex binary/);
		}
	});

	it("never requires or keeps an API key for the codex backend (FLY-2885)", () => {
		const codex = {
			TEAMLEAD_API_TOKEN: "master",
			FLYWHEEL_VOICE_BACKEND: "codex-realtime",
			FLYWHEEL_CODEX_BIN: "/opt/flywheel/codex-0.156.1/codex",
		};
		const withoutKey = loadVoiceDaemonConfig(codex, "/Users/tester");
		expect(withoutKey).toMatchObject({
			backendId: "codex-realtime",
			realtimeApiKey: null,
			codexAuthSource: "/Users/tester/.codex/auth.json",
		});
		// A key left in the shared .env for engine A is not carried into config.
		expect(
			loadVoiceDaemonConfig(
				{ ...codex, OPENAI_API_KEY: "api-key" },
				"/Users/tester",
			).realtimeApiKey,
		).toBeNull();
		expect(
			loadVoiceDaemonConfig(
				{
					...codex,
					FLYWHEEL_VOICE_CODEX_AUTH_SOURCE: "/srv/codex/auth.json",
				},
				"/Users/tester",
			).codexAuthSource,
		).toBe("/srv/codex/auth.json");
		expect(() =>
			loadVoiceDaemonConfig(
				{ ...codex, FLYWHEEL_VOICE_CODEX_AUTH_SOURCE: "auth.json" },
				"/Users/tester",
			),
		).toThrow(/FLYWHEEL_VOICE_CODEX_AUTH_SOURCE/);
		// The legacy engine keeps its key requirement unchanged.
		expect(() =>
			loadVoiceDaemonConfig({ TEAMLEAD_API_TOKEN: "master" }, "/Users/tester"),
		).toThrow("OPENAI_API_KEY is required");
	});

	it("scrubs both API keys from the daemon's own environment", () => {
		const env: NodeJS.ProcessEnv = {
			OPENAI_API_KEY: "api-key",
			CODEX_API_KEY: "codex-key",
			PATH: "/usr/bin",
		};
		scrubVoiceApiKeys(env);
		expect(env).toEqual({ PATH: "/usr/bin" });
	});

	it("reads the WebRTC room tuning with bounded values", () => {
		const base = {
			TEAMLEAD_API_TOKEN: "master",
			FLYWHEEL_VOICE_BACKEND: "codex-realtime",
			FLYWHEEL_CODEX_BIN: "/opt/flywheel/codex-0.156.1/codex",
		};
		expect(loadVoiceDaemonConfig(base, "/Users/tester")).toMatchObject({
			uplinkMinOnsetDbfs: -30,
			webrtcStunUrls: ["stun:stun.l.google.com:19302"],
			qaFaults: false,
		});
		expect(
			loadVoiceDaemonConfig(
				{
					...base,
					FLYWHEEL_VOICE_UPLINK_MIN_ONSET_DBFS: "off",
					FLYWHEEL_VOICE_WEBRTC_STUN: "",
					FLYWHEEL_VOICE_QA_FAULTS: "1",
				},
				"/Users/tester",
			),
		).toMatchObject({
			uplinkMinOnsetDbfs: null,
			webrtcStunUrls: [],
			qaFaults: true,
		});
		expect(
			loadVoiceDaemonConfig(
				{ ...base, FLYWHEEL_VOICE_UPLINK_MIN_ONSET_DBFS: "-42.5" },
				"/Users/tester",
			).uplinkMinOnsetDbfs,
		).toBe(-42.5);
		for (const bad of [
			{ FLYWHEEL_VOICE_UPLINK_MIN_ONSET_DBFS: "5" },
			{ FLYWHEEL_VOICE_UPLINK_MIN_ONSET_DBFS: "loud" },
			{ FLYWHEEL_VOICE_WEBRTC_STUN: "http://stun.example" },
			{ FLYWHEEL_VOICE_QA_FAULTS: "yes" },
		]) {
			expect(() =>
				loadVoiceDaemonConfig({ ...base, ...bad }, "/Users/tester"),
			).toThrow(/FLYWHEEL_VOICE_/);
		}
	});

	it("defaults the uplink VAD pre-roll to 200 ms and accepts an explicit override", () => {
		const base = { TEAMLEAD_API_TOKEN: "master", OPENAI_API_KEY: "api-key" };
		expect(loadVoiceDaemonConfig(base, "/Users/tester").uplinkPrerollMs).toBe(
			200,
		);
		expect(
			loadVoiceDaemonConfig(
				{ ...base, FLYWHEEL_VOICE_UPLINK_PREROLL_MS: "0" },
				"/Users/tester",
			).uplinkPrerollMs,
		).toBe(0);
		for (const value of ["-1", "1001", "0.5", "abc"]) {
			expect(() =>
				loadVoiceDaemonConfig(
					{ ...base, FLYWHEEL_VOICE_UPLINK_PREROLL_MS: value },
					"/Users/tester",
				),
			).toThrow("FLYWHEEL_VOICE_UPLINK_PREROLL_MS");
		}
	});

	it("rejects a malformed voice build identity", () => {
		expect(() =>
			loadVoiceDaemonConfig(
				{
					TEAMLEAD_API_TOKEN: "master",
					OPENAI_API_KEY: "api-key",
					FLYWHEEL_VOICE_BUILD_SHA: "not-a-sha",
				},
				"/Users/tester",
			),
		).toThrow("FLYWHEEL_VOICE_BUILD_SHA");
	});

	it("uses an explicit isolated CommDB path and preserves the production default", () => {
		const isolated = loadVoiceDaemonConfig(
			{
				TEAMLEAD_API_TOKEN: "master",
				OPENAI_API_KEY: "api-key",
				FLYWHEEL_COMM_DB: "/private/tmp/voice-slot/comm.db",
			},
			"/Users/tester",
		);
		expect(resolveVoiceCommDbPath(isolated, "raya", "/Users/tester")).toBe(
			"/private/tmp/voice-slot/comm.db",
		);
		const standard = loadVoiceDaemonConfig(
			{ TEAMLEAD_API_TOKEN: "master", OPENAI_API_KEY: "api-key" },
			"/Users/tester",
		);
		expect(resolveVoiceCommDbPath(standard, "raya", "/Users/tester")).toBe(
			"/Users/tester/.flywheel/comm/raya/comm.db",
		);
		for (const commDbPath of ["relative/comm.db", "/"]) {
			expect(() =>
				loadVoiceDaemonConfig(
					{
						TEAMLEAD_API_TOKEN: "master",
						OPENAI_API_KEY: "api-key",
						FLYWHEEL_COMM_DB: commDbPath,
					},
					"/Users/tester",
				),
			).toThrow(/FLYWHEEL_COMM_DB/);
		}
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

	it("keeps the legacy Codex environment helper credential-free for compatibility", () => {
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
