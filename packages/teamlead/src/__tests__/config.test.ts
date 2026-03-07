import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../config.js";

// Save and restore env between tests
const envBackup: Record<string, string | undefined> = {};
const envKeys = [
	"TEAMLEAD_PORT",
	"TEAMLEAD_DB_PATH",
	"TEAMLEAD_OWNS_SLACK",
	"SLACK_BOT_TOKEN",
	"SLACK_APP_TOKEN",
	"FLYWHEEL_SLACK_CHANNEL",
	"TEAMLEAD_STUCK_THRESHOLD",
	"TEAMLEAD_STUCK_INTERVAL",
	"ANTHROPIC_API_KEY",
	"TEAMLEAD_LLM_MODEL",
	"TEAMLEAD_LLM_MAX_TOKENS",
	"TEAMLEAD_ALLOWED_USER_IDS",
	"TEAMLEAD_ALLOW_ALL_USERS",
];

describe("loadConfig — LLM fields", () => {
	beforeEach(() => {
		for (const k of envKeys) {
			envBackup[k] = process.env[k];
			delete process.env[k];
		}
	});

	afterEach(() => {
		for (const k of envKeys) {
			if (envBackup[k] === undefined) {
				delete process.env[k];
			} else {
				process.env[k] = envBackup[k];
			}
		}
	});

	it("returns undefined anthropicApiKey when ANTHROPIC_API_KEY not set", () => {
		const config = loadConfig();
		expect(config.anthropicApiKey).toBeUndefined();
		expect(config.llmModel).toBe("claude-sonnet-4-5-20250514");
		expect(config.llmMaxTokens).toBe(1024);
		expect(config.allowedUserIds).toEqual([]);
		expect(config.allowAllUsers).toBe(false);
	});

	it("loads ANTHROPIC_API_KEY + allowedUserIds correctly", () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-test";
		process.env.TEAMLEAD_ALLOWED_USER_IDS = "U123,U456";
		const config = loadConfig();
		expect(config.anthropicApiKey).toBe("sk-ant-test");
		expect(config.allowedUserIds).toEqual(["U123", "U456"]);
	});

	it("throws when ownsSlack + anthropicApiKey but no allowlist/allowAll", () => {
		process.env.TEAMLEAD_OWNS_SLACK = "true";
		process.env.SLACK_BOT_TOKEN = "xoxb-test";
		process.env.SLACK_APP_TOKEN = "xapp-test";
		process.env.FLYWHEEL_SLACK_CHANNEL = "C07XXX";
		process.env.ANTHROPIC_API_KEY = "sk-ant-test";

		expect(() => loadConfig()).toThrow(
			"Brain Q&A requires TEAMLEAD_ALLOWED_USER_IDS or TEAMLEAD_ALLOW_ALL_USERS=true",
		);
	});

	it("passes with ownsSlack + anthropicApiKey + non-empty allowedUserIds", () => {
		process.env.TEAMLEAD_OWNS_SLACK = "true";
		process.env.SLACK_BOT_TOKEN = "xoxb-test";
		process.env.SLACK_APP_TOKEN = "xapp-test";
		process.env.FLYWHEEL_SLACK_CHANNEL = "C07XXX";
		process.env.ANTHROPIC_API_KEY = "sk-ant-test";
		process.env.TEAMLEAD_ALLOWED_USER_IDS = "U123";

		const config = loadConfig();
		expect(config.anthropicApiKey).toBe("sk-ant-test");
		expect(config.allowedUserIds).toEqual(["U123"]);
	});

	it("passes with ownsSlack + anthropicApiKey + allowAllUsers=true", () => {
		process.env.TEAMLEAD_OWNS_SLACK = "true";
		process.env.SLACK_BOT_TOKEN = "xoxb-test";
		process.env.SLACK_APP_TOKEN = "xapp-test";
		process.env.FLYWHEEL_SLACK_CHANNEL = "C07XXX";
		process.env.ANTHROPIC_API_KEY = "sk-ant-test";
		process.env.TEAMLEAD_ALLOW_ALL_USERS = "true";

		const config = loadConfig();
		expect(config.allowAllUsers).toBe(true);
	});
});
