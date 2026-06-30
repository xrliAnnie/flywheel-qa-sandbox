import { describe, expect, it } from "vitest";
import { parseLeadActionsConfig } from "../config.js";

const baseEnv = (): NodeJS.ProcessEnv => ({
	FLYWHEEL_LEAD_ID: "mufasa-lead",
	FLYWHEEL_PROJECT_NAME: "growth",
	FLYWHEEL_LEAD_ACTIONS_BROKER_SOCKET: "/tmp/s.sock",
	FLYWHEEL_LEAD_CHAT_CHANNEL_ID: "1500600400238084307",
	FLYWHEEL_LEAD_ACTIONS_STATE_DIR: "/tmp/state",
});

describe("parseLeadActionsConfig", () => {
	it("parses a valid env with defaults", () => {
		const cfg = parseLeadActionsConfig({
			...baseEnv(),
			FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS: "1512578695468941333",
		});
		expect(cfg.leadId).toBe("mufasa-lead");
		expect(cfg.projectName).toBe("growth");
		expect(cfg.chatChannelId).toBe("1500600400238084307");
		expect(cfg.crossDeptChannelIds).toEqual(["1512578695468941333"]);
		expect(cfg.rateMaxPerWindow).toBe(5);
		expect(cfg.rateWindowMs).toBe(60_000);
		expect(cfg.idempotencyTtlMs).toBe(60_000);
		expect(cfg.explicitAliases).toEqual({});
	});

	it("lists ALL missing required vars at once (fail-loud)", () => {
		expect(() => parseLeadActionsConfig({})).toThrow(
			/FLYWHEEL_LEAD_ID.*FLYWHEEL_PROJECT_NAME/s,
		);
	});

	it("treats absent cross-dept channels as empty (roundtable unavailable later)", () => {
		const cfg = parseLeadActionsConfig(baseEnv());
		expect(cfg.crossDeptChannelIds).toEqual([]);
	});

	it("splits + trims multiple cross-dept channels", () => {
		const cfg = parseLeadActionsConfig({
			...baseEnv(),
			FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS: " 111 , 222 ,",
		});
		expect(cfg.crossDeptChannelIds).toEqual(["111", "222"]);
	});

	it("parses explicit alias pins", () => {
		const cfg = parseLeadActionsConfig({
			...baseEnv(),
			FLYWHEEL_LEAD_ACTIONS_CHANNEL_ALIASES: "roundtable:999",
		});
		expect(cfg.explicitAliases).toEqual({ roundtable: "999" });
	});

	it("honors rate/idempotency overrides; ignores non-positive", () => {
		const cfg = parseLeadActionsConfig({
			...baseEnv(),
			FLYWHEEL_LEAD_ACTIONS_RATE_MAX: "3",
			FLYWHEEL_LEAD_ACTIONS_RATE_WINDOW_MS: "0", // invalid → default
			FLYWHEEL_LEAD_ACTIONS_IDEMPOTENCY_TTL_MS: "abc", // invalid → default
		});
		expect(cfg.rateMaxPerWindow).toBe(3);
		expect(cfg.rateWindowMs).toBe(60_000);
		expect(cfg.idempotencyTtlMs).toBe(60_000);
	});

	it("rejects a project name with path separators", () => {
		expect(() =>
			parseLeadActionsConfig({ ...baseEnv(), FLYWHEEL_PROJECT_NAME: "../x" }),
		).toThrow(/invalid project name/);
	});
});

// FLY-304: token-source mode. content-coordination keeps the broker; full-access
// (no broker) reads DISCORD_BOT_TOKEN from the MCP child env. config.ts is pure
// parse — it exposes the MODE + optional broker socket; the actual token read /
// fail-closed lives in lead-actions-main.
describe("parseLeadActionsConfig — token mode (FLY-304)", () => {
	const coreEnv = (): NodeJS.ProcessEnv => ({
		FLYWHEEL_LEAD_ID: "mufasa-lead",
		FLYWHEEL_PROJECT_NAME: "growth",
		FLYWHEEL_LEAD_CHAT_CHANNEL_ID: "1500600400238084307",
		FLYWHEEL_LEAD_ACTIONS_STATE_DIR: "/tmp/state",
	});

	it("mode=broker when a broker socket is configured (content-coordination)", () => {
		const cfg = parseLeadActionsConfig({
			...coreEnv(),
			FLYWHEEL_LEAD_ACTIONS_BROKER_SOCKET: "/tmp/s.sock",
		});
		expect(cfg.mode).toBe("broker");
		expect(cfg.brokerSocketPath).toBe("/tmp/s.sock");
	});

	it("mode=env-token when NO broker socket (full-access)", () => {
		const cfg = parseLeadActionsConfig(coreEnv());
		expect(cfg.mode).toBe("env-token");
		expect(cfg.brokerSocketPath).toBeUndefined();
	});

	it("broker socket is no longer a required var (env-token is valid)", () => {
		expect(() => parseLeadActionsConfig(coreEnv())).not.toThrow();
	});

	it("still fails loud on the truly-required coords (lead/project/chat/state)", () => {
		expect(() => parseLeadActionsConfig({})).toThrow(
			/FLYWHEEL_LEAD_ID.*FLYWHEEL_PROJECT_NAME.*FLYWHEEL_LEAD_CHAT_CHANNEL_ID.*FLYWHEEL_LEAD_ACTIONS_STATE_DIR/s,
		);
		// broker socket must NOT be in the missing list anymore.
		expect(() => parseLeadActionsConfig({})).toThrow();
		try {
			parseLeadActionsConfig({});
		} catch (e) {
			expect((e as Error).message).not.toMatch(
				/FLYWHEEL_LEAD_ACTIONS_BROKER_SOCKET/,
			);
		}
	});

	it("FLY-676: roundtableAutoContinue is false unless the effective flag env is '1'", () => {
		const off = parseLeadActionsConfig({ ...baseEnv() });
		expect(off.roundtableAutoContinue).toBe(false);
		// only the runtime-computed EFFECTIVE flag turns it on (NOT raw THREAD_AUTOCONTINUE)
		const rawOnly = parseLeadActionsConfig({
			...baseEnv(),
			FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE: "1",
		});
		expect(rawOnly.roundtableAutoContinue).toBe(false);
		const on = parseLeadActionsConfig({
			...baseEnv(),
			FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE_EFFECTIVE: "1",
		});
		expect(on.roundtableAutoContinue).toBe(true);
	});
});
