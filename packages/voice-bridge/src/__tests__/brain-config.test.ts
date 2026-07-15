/**
 * FLY-1160 §5 — huddle.brain config face. Absent = byte-compat (no brain
 * field at all); present-but-invalid = fail LOUD (voice-bridge reads
 * projects.json itself — a typo must not silently become a default). The
 * token env name is HARD-PINNED to FLYWHEEL_BRAIN_PORT_TOKEN and deliberately
 * NOT configurable (Codex R2 #4b: a configurable tokenEnv lets daemon and
 * shim read different secrets).
 */
import { describe, expect, it } from "vitest";
import { resolveHuddleBridgeConfig } from "../config.js";

// FLY-1160 Phase B merge: the merged 545 resolver requires the /glaw meeting
// tokens (FLYWHEEL_API_TOKEN / DISCORD_OWNER_USER_ID / GEMINI_API_KEY) before
// it returns — the brain sub-block assertions below are orthogonal to them.
const ENV = {
	ORCH_TOK: "t-orch",
	EARS_TOK: "t-ears",
	LEAD_TOK: "t-lead",
	// this branch's PR-2 fail-fast requirements (/glaw loop)
	FLYWHEEL_API_TOKEN: "t-bridge",
	DISCORD_OWNER_USER_ID: "annie-1",
	GEMINI_API_KEY: "t-gemini",
};

function rawProjects(brain?: unknown) {
	return [
		{
			projectName: "flywheel",
			projectRoot: "/tmp/flywheel",
			huddle: {
				guildId: "g",
				voiceChannelId: "vc",
				orchestratorBotTokenEnv: "ORCH_TOK",
				earsBotTokenEnv: "EARS_TOK",
				...(brain !== undefined ? { brain } : {}),
			},
			leads: [{ agentId: "lead", botTokenEnv: "LEAD_TOK" }],
		},
	];
}

describe("huddle.brain config (FLY-1160)", () => {
	it("no huddle.brain → no brain field at all (byte-compat sentinel)", () => {
		const cfg = resolveHuddleBridgeConfig(rawProjects(), ENV);
		expect("brain" in cfg).toBe(false);
	});

	it("empty block → founder-knob defaults: model sonnet, maxSessions 4, no port, mode resident", () => {
		const cfg = resolveHuddleBridgeConfig(rawProjects({}), ENV);
		expect(cfg.brain).toEqual({
			model: "sonnet",
			maxSessions: 4,
			mode: "resident",
		});
	});

	it("explicit values parse", () => {
		const cfg = resolveHuddleBridgeConfig(
			rawProjects({ port: 9880, model: "haiku", maxSessions: 2 }),
			ENV,
		);
		expect(cfg.brain).toEqual({
			port: 9880,
			model: "haiku",
			maxSessions: 2,
			mode: "resident",
		});
	});

	it("no mode → mode defaults to resident (FLY-1190: /glaw thinks with Claude by default; ears stay Gemini)", () => {
		// FLY-1190 (Annie 拍板): a configured resident brain makes /glaw resident-Claude
		// BY DEFAULT. Before FLY-1190 the default was gemini (absent = gemini, byte-compat)
		// — that flipped once the STT-abort protection was extended to the resident leg.
		const cfg = resolveHuddleBridgeConfig(rawProjects({}), ENV);
		expect(cfg.brain?.mode).toBe("resident");
	});

	it("explicit mode: resident | gemini parses", () => {
		expect(
			resolveHuddleBridgeConfig(rawProjects({ mode: "resident" }), ENV).brain,
		).toEqual({ model: "sonnet", maxSessions: 4, mode: "resident" });
		expect(
			resolveHuddleBridgeConfig(rawProjects({ mode: "gemini" }), ENV).brain,
		).toEqual({ model: "sonnet", maxSessions: 4, mode: "gemini" });
	});

	it("fails loud on an unknown mode", () => {
		expect(() =>
			resolveHuddleBridgeConfig(rawProjects({ mode: "claude" }), ENV),
		).toThrow(/mode/);
		expect(() =>
			resolveHuddleBridgeConfig(rawProjects({ mode: 7 }), ENV),
		).toThrow(/mode/);
	});

	it("fails loud on invalid shapes", () => {
		expect(() => resolveHuddleBridgeConfig(rawProjects("yes"), ENV)).toThrow(
			/brain/,
		);
		expect(() =>
			resolveHuddleBridgeConfig(rawProjects({ port: "9880" }), ENV),
		).toThrow(/port/);
		expect(() =>
			resolveHuddleBridgeConfig(rawProjects({ port: 0 }), ENV),
		).toThrow(/port/);
		expect(() =>
			resolveHuddleBridgeConfig(rawProjects({ model: "" }), ENV),
		).toThrow(/model/);
		expect(() =>
			resolveHuddleBridgeConfig(rawProjects({ maxSessions: -1 }), ENV),
		).toThrow(/maxSessions/);
	});
});
