/**
 * FLY-545 P2 — HuddleBridgeConfig: fail-fast resolver over
 * ~/.flywheel/projects.json + env. Every missing piece must name itself AND
 * say how to fix it (launchd crash loops are debugged from one log line).
 */
import { describe, expect, it } from "vitest";
import { resolveHuddleBridgeConfig } from "../config.js";

const huddle = {
	guildId: "g-1",
	voiceChannelId: "vc-1",
	orchestratorBotTokenEnv: "HUDDLE_ORCH_BOT_TOKEN",
	earsBotTokenEnv: "HUDDLE_EARS_BOT_TOKEN",
};

function project(over: Record<string, unknown> = {}) {
	return {
		projectName: "flywheel",
		projectRoot: "/tmp/flywheel",
		leads: [
			{
				agentId: "flywheel-eng-lead",
				chatChannel: "chan-1",
				match: { labels: ["Flywheel"] },
				botTokenEnv: "TADASHI_BOT_TOKEN",
				voice: { voiceId: "zh-CN-YunxiNeural" },
			},
		],
		huddle,
		...over,
	};
}

const env = {
	HUDDLE_ORCH_BOT_TOKEN: "tok-orch",
	HUDDLE_EARS_BOT_TOKEN: "tok-ears",
	TADASHI_BOT_TOKEN: "tok-tadashi",
	// PR-2 requirements (the /glaw loop fail-fasts on all three)
	FLYWHEEL_API_TOKEN: "tok-bridge",
	DISCORD_OWNER_USER_ID: "annie-1",
	GEMINI_API_KEY: "tok-gemini",
};

describe("resolveHuddleBridgeConfig", () => {
	it("resolves a full config with defaults applied", () => {
		const cfg = resolveHuddleBridgeConfig([project()], env);
		expect(cfg.projectName).toBe("flywheel");
		expect(cfg.guildId).toBe("g-1");
		expect(cfg.voiceChannelId).toBe("vc-1");
		expect(cfg.commandName).toBe("glaw"); // default (Annie-final ①)
		expect(cfg.moveMembers).toBe(true); // default
		expect(cfg.orchestratorToken).toBe("tok-orch");
		expect(cfg.earsToken).toBe("tok-ears");
		expect(cfg.leads).toEqual([
			{
				agentId: "flywheel-eng-lead",
				botTokenEnv: "TADASHI_BOT_TOKEN",
				botToken: "tok-tadashi",
				voice: { voiceId: "zh-CN-YunxiNeural" },
				chatChannel: "chan-1",
			},
		]);
		expect(cfg.backchannelMs).toBe(350);
		expect(cfg.healthPort).toBe(9878);
		expect(cfg.ffmpegBin).toBe("ffmpeg");
		expect(cfg.allowUserIds).toEqual([]);
		expect(cfg.bridgeUrl).toBe("http://127.0.0.1:9876"); // default
		expect(cfg.apiToken).toBe("tok-bridge");
		expect(cfg.founderUserId).toBe("annie-1");
		expect(cfg.geminiApiKey).toBe("tok-gemini");
		expect(cfg.geminiModel).toBe("gemini-3.1-flash-live-preview"); // pinned default
	});

	it("PR-2 requirements fail-fast with the var name + fix guidance", () => {
		for (const missing of [
			"FLYWHEEL_API_TOKEN",
			"DISCORD_OWNER_USER_ID",
			"GEMINI_API_KEY",
		] as const) {
			const { [missing]: _drop, ...without } = env;
			expect(() => resolveHuddleBridgeConfig([project()], without)).toThrow(
				new RegExp(`${missing}.*\\.env`, "s"),
			);
		}
	});

	it("voice accepts BOTH VoiceRef forms (FLY-546) and fails loud on junk", () => {
		const forms = resolveHuddleBridgeConfig(
			[
				project({
					leads: [
						{
							agentId: "a",
							botTokenEnv: "TADASHI_BOT_TOKEN",
							voice: "zh-CN-YunxiNeural",
						},
						{
							agentId: "b",
							botTokenEnv: "TADASHI_BOT_TOKEN",
							voice: { voiceId: "zh-CN-XiaoxiaoNeural", rate: "+10%" },
						},
					],
				}),
			],
			env,
		);
		expect(forms.leads[0]?.voice).toEqual({ voiceId: "zh-CN-YunxiNeural" });
		expect(forms.leads[1]?.voice).toEqual({
			voiceId: "zh-CN-XiaoxiaoNeural",
			rate: "+10%",
		});
		for (const bad of [
			"",
			null,
			{ voiceId: "" },
			{ voiceId: "   " },
			{ voiceId: 42 },
			{ voiceId: "x", rate: "fast" },
			{ voiceId: "x", pitch: "high" },
			["x"],
			7,
		]) {
			expect(() =>
				resolveHuddleBridgeConfig(
					[
						project({
							leads: [
								{
									agentId: "a",
									botTokenEnv: "TADASHI_BOT_TOKEN",
									voice: bad,
								},
							],
						}),
					],
					env,
				),
			).toThrow(/voice/);
		}
	});

	it("lead geminiVoice + aliases pass through; bad aliases fail loud", () => {
		const cfg = resolveHuddleBridgeConfig(
			[
				project({
					leads: [
						{
							agentId: "flywheel-eng-lead",
							botTokenEnv: "TADASHI_BOT_TOKEN",
							geminiVoice: "Kore",
							aliases: ["Tadashi", "阿正"],
						},
					],
				}),
			],
			env,
		);
		expect(cfg.leads[0]?.geminiVoice).toBe("Kore");
		expect(cfg.leads[0]?.aliases).toEqual(["Tadashi", "阿正"]);
		expect(() =>
			resolveHuddleBridgeConfig(
				[
					project({
						leads: [
							{
								agentId: "flywheel-eng-lead",
								botTokenEnv: "TADASHI_BOT_TOKEN",
								aliases: "Tadashi",
							},
						],
					}),
				],
				env,
			),
		).toThrow(/aliases/);
	});

	it("honors explicit huddle fields and env knobs", () => {
		const cfg = resolveHuddleBridgeConfig(
			[
				project({
					huddle: { ...huddle, commandName: "hud", moveMembers: false },
				}),
			],
			{
				...env,
				FLYWHEEL_HUDDLE_BACKCHANNEL_MS: "500",
				FLYWHEEL_VOICE_BRIDGE_HEALTH_PORT: "9999",
				FLYWHEEL_VOICE_FFMPEG: "/opt/bin/ffmpeg",
				FLYWHEEL_HUDDLE_ALLOW_USER_IDS: "111, 222",
			},
		);
		expect(cfg.commandName).toBe("hud");
		expect(cfg.moveMembers).toBe(false);
		expect(cfg.backchannelMs).toBe(500);
		expect(cfg.healthPort).toBe(9999);
		expect(cfg.ffmpegBin).toBe("/opt/bin/ffmpeg");
		expect(cfg.allowUserIds).toEqual(["111", "222"]);
		expect(
			resolveHuddleBridgeConfig([project()], {
				...env,
				FLYWHEEL_BRIDGE_URL: "http://10.0.0.2:9876",
				FLYWHEEL_HUDDLE_GEMINI_MODEL: "gemini-x-live",
			}),
		).toMatchObject({
			bridgeUrl: "http://10.0.0.2:9876",
			geminiModel: "gemini-x-live",
		});
	});

	it("ignores retired huddle media env overlays", () => {
		const cfg = resolveHuddleBridgeConfig([project()], {
			...env,
			FLYWHEEL_HUDDLE_EARCON: "/tmp/earcon.mp3",
			FLYWHEEL_HUDDLE_FILLER: "/tmp/filler.mp3",
		});
		expect(cfg.earconPath).toBeUndefined();
		expect(cfg.fillerPath).toBeUndefined();
	});

	it("fails when NO project has a huddle block (with fix guidance)", () => {
		expect(() =>
			resolveHuddleBridgeConfig([project({ huddle: undefined })], env),
		).toThrow(/huddle/);
	});

	it("fails when MORE THAN ONE project has a huddle block (v1 single)", () => {
		expect(() =>
			resolveHuddleBridgeConfig(
				[project(), project({ projectName: "sub" })],
				env,
			),
		).toThrow(/flywheel.*sub|sub.*flywheel/s);
	});

	for (const field of [
		"guildId",
		"voiceChannelId",
		"orchestratorBotTokenEnv",
		"earsBotTokenEnv",
	]) {
		it(`fails on a missing huddle.${field}`, () => {
			const bad: Record<string, unknown> = { ...huddle };
			delete bad[field];
			expect(() =>
				resolveHuddleBridgeConfig([project({ huddle: bad })], env),
			).toThrow(new RegExp(field));
		});
	}

	it("fails when a bot token env var is unset, naming the var and the fix", () => {
		const { HUDDLE_EARS_BOT_TOKEN: _drop, ...withoutEars } = env;
		expect(() => resolveHuddleBridgeConfig([project()], withoutEars)).toThrow(
			/HUDDLE_EARS_BOT_TOKEN.*\.env/s,
		);
	});

	it("fails when a lead's token env var is unset, naming lead + var", () => {
		const { TADASHI_BOT_TOKEN: _drop, ...withoutLead } = env;
		expect(() => resolveHuddleBridgeConfig([project()], withoutLead)).toThrow(
			/flywheel-eng-lead.*TADASHI_BOT_TOKEN/s,
		);
	});

	it("fails when the project has no lead with a botTokenEnv", () => {
		expect(() =>
			resolveHuddleBridgeConfig(
				[
					project({
						leads: [
							{
								agentId: "x",
								chatChannel: "c",
								match: { labels: ["Flywheel"] },
							},
						],
					}),
				],
				env,
			),
		).toThrow(/botTokenEnv/);
	});

	it("fails on a non-array projects document", () => {
		expect(() => resolveHuddleBridgeConfig({}, env)).toThrow(/array/i);
	});

	it("fails loud on an explicit commandName outside the slash grammar (Codex R1 MEDIUM)", () => {
		for (const bad of ["", "UPPER", "has space", 42, true]) {
			expect(() =>
				resolveHuddleBridgeConfig(
					[project({ huddle: { ...huddle, commandName: bad } })],
					env,
				),
			).toThrow(/commandName/);
		}
	});

	it("fails loud on an explicit non-boolean moveMembers (Codex R1 MEDIUM)", () => {
		for (const bad of ["false", 0, "yes"]) {
			expect(() =>
				resolveHuddleBridgeConfig(
					[project({ huddle: { ...huddle, moveMembers: bad } })],
					env,
				),
			).toThrow(/moveMembers/);
		}
	});

	it("fails on a non-numeric health port", () => {
		expect(() =>
			resolveHuddleBridgeConfig([project()], {
				...env,
				FLYWHEEL_VOICE_BRIDGE_HEALTH_PORT: "not-a-port",
			}),
		).toThrow(/FLYWHEEL_VOICE_BRIDGE_HEALTH_PORT/);
	});
});
