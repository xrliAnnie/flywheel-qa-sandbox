import { describe, expect, it } from "vitest";
import {
	assertLeadActionsInventory,
	buildLeadActionsMcpServerConfig,
	InventoryMismatchError,
	LEAD_ACTIONS_TOOLS,
	toMcpServerToml,
} from "../mcp-config.js";

const baseOpts = () => ({
	nodeBin: "/usr/local/bin/node",
	mainJsPath: "/Users/x/dist/lead-actions/lead-actions-main.js",
	brokerSocketPath:
		"/Users/x/.flywheel/state/codex-lead/mufasa/lead-actions.sock",
	leadId: "mufasa-lead",
	projectName: "growth",
	chatChannelId: "1500600400238084307",
	crossDeptChannelIds: ["1512578695468941333"],
	stateDir: "/Users/x/.flywheel/state/codex-lead/mufasa",
});

describe("buildLeadActionsMcpServerConfig", () => {
	it("builds command + args + non-secret env coordinates", () => {
		const cfg = buildLeadActionsMcpServerConfig(baseOpts());
		expect(cfg.command).toBe("/usr/local/bin/node");
		expect(cfg.args).toEqual([
			"/Users/x/dist/lead-actions/lead-actions-main.js",
		]);
		expect(cfg.env.FLYWHEEL_LEAD_ID).toBe("mufasa-lead");
		expect(cfg.env.FLYWHEEL_LEAD_ACTIONS_BROKER_SOCKET).toContain(".sock");
		expect(cfg.env.FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS).toBe(
			"1512578695468941333",
		);
	});

	it("never includes a secret-shaped env key (token travels over broker)", () => {
		const cfg = buildLeadActionsMcpServerConfig(baseOpts());
		for (const k of Object.keys(cfg.env)) {
			expect(/TOKEN|SECRET|KEY/i.test(k)).toBe(false);
		}
		// sanity: the bot-token env name is NOT present.
		expect(cfg.env.MUFASA_BOT_TOKEN).toBeUndefined();
		expect(cfg.env.DISCORD_BOT_TOKEN).toBeUndefined();
	});

	it("includes explicit aliases when provided", () => {
		const cfg = buildLeadActionsMcpServerConfig({
			...baseOpts(),
			explicitAliases: "roundtable:999",
		});
		expect(cfg.env.FLYWHEEL_LEAD_ACTIONS_CHANNEL_ALIASES).toBe(
			"roundtable:999",
		);
	});
});

describe("toMcpServerToml", () => {
	it("renders a valid [mcp_servers.<name>] fragment with no secret", () => {
		const cfg = buildLeadActionsMcpServerConfig(baseOpts());
		const toml = toMcpServerToml("lead_actions", cfg);
		expect(toml).toContain("[mcp_servers.lead_actions]");
		expect(toml).toContain('command = "/usr/local/bin/node"');
		expect(toml).toContain("lead-actions-main.js");
		expect(toml).toContain("env = {");
		expect(toml).toContain('FLYWHEEL_LEAD_ID = "mufasa-lead"');
		// no token anywhere in the rendered config
		expect(toml).not.toMatch(/TOKEN|SECRET/i);
	});

	it("escapes backslashes and quotes in values", () => {
		const toml = toMcpServerToml("lead_actions", {
			command: "node",
			args: ['/path/with "quote"/x.js'],
			env: {},
		});
		expect(toml).toContain('\\"quote\\"');
	});
});

describe("assertLeadActionsInventory (§10 / R3#3 fail-closed)", () => {
	it("passes when the surface is exactly the approved set", () => {
		expect(() => assertLeadActionsInventory(["discord_send"])).not.toThrow();
	});

	it("strips a server-name prefix before comparing", () => {
		expect(() =>
			assertLeadActionsInventory(["lead_actions.discord_send"]),
		).not.toThrow();
		expect(() =>
			assertLeadActionsInventory(["lead_actions__discord_send"]),
		).not.toThrow();
	});

	it("throws when a tool is MISSING", () => {
		expect(() => assertLeadActionsInventory([])).toThrow(
			InventoryMismatchError,
		);
	});

	it("throws when an EXTRA (unapproved) tool is present", () => {
		expect(() =>
			assertLeadActionsInventory(["discord_send", "run_shell"]),
		).toThrow(/extra=\[run_shell\]/);
	});

	it("approved set is exactly discord_send (Linear is FLY-351 follow-on)", () => {
		expect([...LEAD_ACTIONS_TOOLS]).toEqual(["discord_send"]);
	});
});
