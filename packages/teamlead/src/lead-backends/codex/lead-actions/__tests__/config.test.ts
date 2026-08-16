import { describe, expect, it } from "vitest";
import { parseLeadActionsConfig } from "../config.js";

const baseEnv = (): NodeJS.ProcessEnv => ({
	FLYWHEEL_LEAD_ID: "mufasa-lead",
	FLYWHEEL_PROJECT_NAME: "growth",
	FLYWHEEL_LEAD_CHAT_CHANNEL_ID: "1500600400238084307",
	FLYWHEEL_LEAD_ACTIONS_STATE_DIR: "/tmp/state",
	FLYWHEEL_COMM_DB: "/tmp/comm.db",
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
		expect(cfg.commDbPath).toBe("/tmp/comm.db");
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

describe("parseLeadActionsConfig — effective roundtable flag", () => {
	it("FLY-676: roundtableAutoContinue is false unless the effective flag env is '1'", () => {
		const off = parseLeadActionsConfig({ ...baseEnv() });
		expect(off.roundtableAutoContinue).toBe(false);
		const on = parseLeadActionsConfig({
			...baseEnv(),
			FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE_EFFECTIVE: "1",
		});
		expect(on.roundtableAutoContinue).toBe(true);
	});
});
