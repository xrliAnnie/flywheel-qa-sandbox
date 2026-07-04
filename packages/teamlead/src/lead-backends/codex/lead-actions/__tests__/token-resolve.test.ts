import { describe, expect, it, vi } from "vitest";
import { resolveLeadActionsBotToken } from "../lead-actions-main.js";

// FLY-304: the lead-actions MCP token-source dual path.
//  - broker (content-coordination): fetched over the SecretBroker — UNCHANGED.
//  - env-token (full-access): read from the MCP child's own env.
// Either path is fail-closed when no token is available.
describe("resolveLeadActionsBotToken (FLY-304)", () => {
	it("broker mode: returns the broker-supplied token", async () => {
		const fetchBroker = vi.fn(async () => ({
			DISCORD_BOT_TOKEN: "broker-tok",
		}));
		const tok = await resolveLeadActionsBotToken(
			{ mode: "broker", brokerSocketPath: "/tmp/s.sock" },
			{},
			{ fetchBroker },
		);
		expect(tok).toBe("broker-tok");
		expect(fetchBroker).toHaveBeenCalledWith("/tmp/s.sock");
	});

	it("broker mode: fail-closed when broker supplies no token", async () => {
		const fetchBroker = vi.fn(async () => ({}) as Record<string, string>);
		await expect(
			resolveLeadActionsBotToken(
				{ mode: "broker", brokerSocketPath: "/tmp/s.sock" },
				{},
				{ fetchBroker },
			),
		).rejects.toThrow(/broker did not supply DISCORD_BOT_TOKEN/);
	});

	it("broker mode: fail-closed when no broker socket path", async () => {
		const fetchBroker = vi.fn(async () => ({ DISCORD_BOT_TOKEN: "x" }));
		await expect(
			resolveLeadActionsBotToken({ mode: "broker" }, {}, { fetchBroker }),
		).rejects.toThrow(/broker mode requires a broker socket path/);
		expect(fetchBroker).not.toHaveBeenCalled();
	});

	it("env-token mode: returns DISCORD_BOT_TOKEN from the MCP child env", async () => {
		const fetchBroker = vi.fn(async () => ({
			DISCORD_BOT_TOKEN: "should-not",
		}));
		const tok = await resolveLeadActionsBotToken(
			{ mode: "env-token" },
			{ DISCORD_BOT_TOKEN: "env-tok" },
			{ fetchBroker },
		);
		expect(tok).toBe("env-tok");
		// env-token mode must NOT consult the broker.
		expect(fetchBroker).not.toHaveBeenCalled();
	});

	it("env-token mode: fail-closed when DISCORD_BOT_TOKEN absent from env", async () => {
		await expect(
			resolveLeadActionsBotToken(
				{ mode: "env-token" },
				{},
				{ fetchBroker: vi.fn(async () => ({})) },
			),
		).rejects.toThrow(/env-token mode but DISCORD_BOT_TOKEN is absent/);
	});

	it("env-token mode: trims whitespace-only token to fail-closed", async () => {
		await expect(
			resolveLeadActionsBotToken(
				{ mode: "env-token" },
				{ DISCORD_BOT_TOKEN: "   " },
				{ fetchBroker: vi.fn(async () => ({})) },
			),
		).rejects.toThrow(/absent/);
	});
});
