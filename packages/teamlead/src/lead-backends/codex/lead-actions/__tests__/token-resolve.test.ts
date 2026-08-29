import { describe, expect, it } from "vitest";
import { resolveLeadActionsBotToken } from "../lead-actions-main.js";

describe("resolveLeadActionsBotToken (FLY-304)", () => {
	it("returns DISCORD_BOT_TOKEN from the MCP child env", () => {
		const tok = resolveLeadActionsBotToken({ DISCORD_BOT_TOKEN: "env-tok" });
		expect(tok).toBe("env-tok");
	});

	it("fails closed when DISCORD_BOT_TOKEN is absent", () => {
		expect(() => resolveLeadActionsBotToken({})).toThrow(
			/DISCORD_BOT_TOKEN is absent/,
		);
	});

	it("trims whitespace-only token to fail closed", () => {
		expect(() =>
			resolveLeadActionsBotToken({ DISCORD_BOT_TOKEN: "   " }),
		).toThrow(/absent/);
	});
});
