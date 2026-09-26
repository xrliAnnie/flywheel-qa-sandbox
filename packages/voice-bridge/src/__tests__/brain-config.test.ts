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

const ENV = {
	ORCH_TOK: "t-orch",
	EARS_TOK: "t-ears",
	LEAD_TOK: "t-lead",
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

	it("empty block → founder-knob defaults: model sonnet, maxSessions 4, no port", () => {
		const cfg = resolveHuddleBridgeConfig(rawProjects({}), ENV);
		expect(cfg.brain).toEqual({ model: "sonnet", maxSessions: 4 });
	});

	it("explicit values parse", () => {
		const cfg = resolveHuddleBridgeConfig(
			rawProjects({ port: 9880, model: "haiku", maxSessions: 2 }),
			ENV,
		);
		expect(cfg.brain).toEqual({ port: 9880, model: "haiku", maxSessions: 2 });
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
