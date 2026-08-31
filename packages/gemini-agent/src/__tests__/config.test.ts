import { describe, expect, it } from "vitest";
import { ConfigError, loadAgentConfig } from "../config.js";

describe("loadAgentConfig", () => {
	it("refuses to start the retired Gemini agent", () => {
		expect(() => loadAgentConfig({})).toThrow(ConfigError);
		expect(() => loadAgentConfig({})).toThrow(/retired/i);
	});

	it("the retired env cannot reactivate the agent", () => {
		expect(() =>
			loadAgentConfig({
				FLYWHEEL_GEMINI_AGENT: "1",
				GEMINI_API_KEY: "test-key",
				FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9876",
				FLYWHEEL_GEMINI_AGENT_BRIDGE_TOKEN: "scoped-token-value",
			}),
		).toThrow(/retired/i);
	});
});
