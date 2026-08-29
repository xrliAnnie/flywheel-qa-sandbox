import { describe, expect, it } from "vitest";
import { ConfigError, loadAgentConfig, MODEL_IDS } from "../config.js";

/** Minimal valid env — tests override/delete from here. */
function validEnv(): Record<string, string> {
	return {
		FLYWHEEL_GEMINI_AGENT: "1",
		GEMINI_API_KEY: "test-key",
		FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9876",
		FLYWHEEL_GEMINI_AGENT_BRIDGE_TOKEN: "scoped-token-value",
	};
}

describe("loadAgentConfig", () => {
	it("fails closed when the feature flag is unset (default-off)", () => {
		const env = validEnv();
		delete env.FLYWHEEL_GEMINI_AGENT;
		expect(() => loadAgentConfig(env)).toThrow(ConfigError);
		expect(() => loadAgentConfig(env)).toThrow(/FLYWHEEL_GEMINI_AGENT/);
	});

	it("fails closed when the flag is explicitly 0", () => {
		const env = { ...validEnv(), FLYWHEEL_GEMINI_AGENT: "0" };
		expect(() => loadAgentConfig(env)).toThrow(ConfigError);
	});

	it.each([
		"GEMINI_API_KEY",
		"FLYWHEEL_BRIDGE_URL",
		"FLYWHEEL_GEMINI_AGENT_BRIDGE_TOKEN",
	])("fails closed when required env %s is missing", (key) => {
		const env = validEnv();
		delete env[key];
		expect(() => loadAgentConfig(env)).toThrow(ConfigError);
		expect(() => loadAgentConfig(env)).toThrow(new RegExp(key));
	});

	it("rejects a blank (whitespace-only) required value", () => {
		const env = { ...validEnv(), GEMINI_API_KEY: "   " };
		expect(() => loadAgentConfig(env)).toThrow(ConfigError);
	});

	it("defaults: tier flash, surface interactions, fuses per plan §2.7", () => {
		const cfg = loadAgentConfig(validEnv());
		expect(cfg.modelTier).toBe("flash");
		expect(cfg.model).toBe(MODEL_IDS.flash);
		expect(cfg.surface).toBe("interactions");
		expect(cfg.maxSteps).toBe(12);
		expect(cfg.tokenBudgetIn).toBe(200_000);
		expect(cfg.tokenBudgetOut).toBe(20_000);
		expect(cfg.toolTimeoutMs).toBe(15_000);
		expect(cfg.resultCapChars).toBe(16_000);
		expect(cfg.auditDir.endsWith(".flywheel/gemini-agent")).toBe(true);
	});

	it("maps tier pro to the pinned pro model id", () => {
		const cfg = loadAgentConfig({
			...validEnv(),
			FLYWHEEL_GEMINI_AGENT_MODEL_TIER: "pro",
		});
		expect(cfg.modelTier).toBe("pro");
		expect(cfg.model).toBe(MODEL_IDS.pro);
	});

	it("rejects an unknown model tier", () => {
		const env = { ...validEnv(), FLYWHEEL_GEMINI_AGENT_MODEL_TIER: "ultra" };
		expect(() => loadAgentConfig(env)).toThrow(ConfigError);
	});

	it("accepts the generate fallback surface", () => {
		const cfg = loadAgentConfig({
			...validEnv(),
			FLYWHEEL_GEMINI_AGENT_SURFACE: "generate",
		});
		expect(cfg.surface).toBe("generate");
	});

	it("rejects an unknown surface", () => {
		const env = { ...validEnv(), FLYWHEEL_GEMINI_AGENT_SURFACE: "live" };
		expect(() => loadAgentConfig(env)).toThrow(ConfigError);
	});

	it("rejects a non-numeric fuse override", () => {
		const env = { ...validEnv(), FLYWHEEL_GEMINI_AGENT_MAX_STEPS: "twelve" };
		expect(() => loadAgentConfig(env)).toThrow(ConfigError);
	});

	it("rejects a zero/negative fuse override", () => {
		const env = { ...validEnv(), FLYWHEEL_GEMINI_AGENT_MAX_STEPS: "0" };
		expect(() => loadAgentConfig(env)).toThrow(ConfigError);
	});

	it("accepts numeric overrides for fuses and caps", () => {
		const cfg = loadAgentConfig({
			...validEnv(),
			FLYWHEEL_GEMINI_AGENT_MAX_STEPS: "5",
			FLYWHEEL_GEMINI_AGENT_TOKEN_BUDGET_IN: "50000",
			FLYWHEEL_GEMINI_AGENT_TOKEN_BUDGET_OUT: "5000",
			FLYWHEEL_GEMINI_AGENT_TOOL_TIMEOUT_MS: "3000",
			FLYWHEEL_GEMINI_AGENT_RESULT_CAP_CHARS: "1000",
		});
		expect(cfg.maxSteps).toBe(5);
		expect(cfg.tokenBudgetIn).toBe(50_000);
		expect(cfg.tokenBudgetOut).toBe(5_000);
		expect(cfg.toolTimeoutMs).toBe(3_000);
		expect(cfg.resultCapChars).toBe(1_000);
	});

	it("rejects a bridge URL that is not http(s)", () => {
		const env = { ...validEnv(), FLYWHEEL_BRIDGE_URL: "ftp://bridge" };
		expect(() => loadAgentConfig(env)).toThrow(ConfigError);
	});

	it("strips a trailing slash from the bridge URL", () => {
		const cfg = loadAgentConfig({
			...validEnv(),
			FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9876/",
		});
		expect(cfg.bridgeUrl).toBe("http://127.0.0.1:9876");
	});

	it("honors an audit dir override", () => {
		const cfg = loadAgentConfig({
			...validEnv(),
			FLYWHEEL_GEMINI_AGENT_AUDIT_DIR: "/tmp/agent-audit",
		});
		expect(cfg.auditDir).toBe("/tmp/agent-audit");
	});
});
