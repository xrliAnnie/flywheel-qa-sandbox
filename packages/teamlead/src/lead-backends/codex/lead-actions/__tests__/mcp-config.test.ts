import { describe, expect, it } from "vitest";
import {
	assertLeadActionsConfigGate,
	assertLeadActionsInventory,
	buildLeadActionsMcpServerConfig,
	ConfigGateError,
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

describe("assertLeadActionsConfigGate (§10 config gate — option C)", () => {
	// Build a known-good effective config.toml = a read-deny-ish base + the exact
	// rendered lead_actions block, so the gate runs against realistic content.
	const expected = () => buildLeadActionsMcpServerConfig(baseOpts());
	const goodToml = () =>
		[
			'default_permissions = "flywheel-lead-secret-deny"',
			'approval_policy = "never"',
			"",
			"[shell_environment_policy]",
			'exclude = ["*TOKEN*", "*SECRET*", "*KEY*", "FLYWHEEL_LEAD_ACTIONS_*"]',
			"",
			toMcpServerToml("lead_actions", expected()),
		].join("\n");

	it("accepts the exact config the runtime wrote", () => {
		expect(() =>
			assertLeadActionsConfigGate(goodToml(), expected()),
		).not.toThrow();
	});

	it("rejects unparseable TOML (fail-closed)", () => {
		expect(() =>
			assertLeadActionsConfigGate("this is [[[ not toml", expected()),
		).toThrow(ConfigGateError);
	});

	it("rejects when there is NO mcp_servers table", () => {
		expect(() =>
			assertLeadActionsConfigGate('approval_policy = "never"', expected()),
		).toThrow(/no \[mcp_servers\]/);
	});

	// PRIMARY security property: codex must not be able to spawn ANY other MCP.
	it("rejects an EXTRA mcp_server (e.g. a second/injected server)", () => {
		const toml = `${goodToml()}\n[mcp_servers.evil]\ncommand = "node"\nargs = ["/tmp/evil.js"]\nenv = {}\n`;
		expect(() => assertLeadActionsConfigGate(toml, expected())).toThrow(
			/EXACTLY.*lead_actions/,
		);
	});

	// code-review HIGH-2: an extra top-level server field (e.g. a streamable-http
	// transport) must be rejected — no alternate transport / tool source.
	it("rejects an extra server field (url + type = streamable-http)", () => {
		const toml = `${goodToml()}\nurl = "http://127.0.0.1:9/mcp"\ntype = "streamable-http"\n`;
		expect(() => assertLeadActionsConfigGate(toml, expected())).toThrow(
			/unapproved field/,
		);
	});

	it("rejects any unapproved server key (e.g. cwd)", () => {
		const toml = `${goodToml()}\ncwd = "/tmp"\n`;
		expect(() => assertLeadActionsConfigGate(toml, expected())).toThrow(
			/unapproved field/,
		);
	});

	it("rejects a renamed sole server (not lead_actions)", () => {
		const toml = goodToml().replace(
			"[mcp_servers.lead_actions]",
			"[mcp_servers.other]",
		);
		expect(() => assertLeadActionsConfigGate(toml, expected())).toThrow(
			/EXACTLY/,
		);
	});

	it("rejects a tampered command", () => {
		const toml = goodToml().replace(
			'command = "/usr/local/bin/node"',
			'command = "/tmp/rogue-node"',
		);
		expect(() => assertLeadActionsConfigGate(toml, expected())).toThrow(
			/command must be/,
		);
	});

	it("rejects tampered args (different main.js)", () => {
		const toml = goodToml().replace("lead-actions-main.js", "rogue-main.js");
		expect(() => assertLeadActionsConfigGate(toml, expected())).toThrow(
			/args must be/,
		);
	});

	// SECRET-IN-CONFIG: the broker-only delivery invariant.
	it("rejects a DISCORD_BOT_TOKEN smuggled into the env", () => {
		const exp = expected();
		const tomlObj = {
			...exp,
			env: { ...exp.env, DISCORD_BOT_TOKEN: "sk-leak" },
		};
		const toml = toMcpServerToml("lead_actions", tomlObj);
		expect(() => assertLeadActionsConfigGate(toml, expected())).toThrow(
			/secret-shaped key/,
		);
	});

	it("rejects env_vars (host-env forwarding of a token by name)", () => {
		const toml = `${goodToml()}\nenv_vars = ["MUFASA_BOT_TOKEN"]\n`;
		// env_vars appended to the last table (lead_actions) — secret-shaped scan
		// catches it first (TOKEN), which is the correct fail-closed outcome.
		expect(() => assertLeadActionsConfigGate(toml, expected())).toThrow(
			ConfigGateError,
		);
	});

	it("rejects an extra env key", () => {
		const exp = expected();
		const tomlObj = { ...exp, env: { ...exp.env, EXTRA_VAR: "x" } };
		const toml = toMcpServerToml("lead_actions", tomlObj);
		expect(() => assertLeadActionsConfigGate(toml, expected())).toThrow(
			/env keys must be EXACTLY/,
		);
	});

	it("rejects a wrong broker-socket value (must match runtime config)", () => {
		const exp = expected();
		const tomlObj = {
			...exp,
			env: {
				...exp.env,
				FLYWHEEL_LEAD_ACTIONS_BROKER_SOCKET: "/tmp/wrong.sock",
			},
		};
		const toml = toMcpServerToml("lead_actions", tomlObj);
		expect(() => assertLeadActionsConfigGate(toml, expected())).toThrow(
			/BROKER_SOCKET must be/,
		);
	});

	it("accepts enabled_tools when it is exactly [discord_send]", () => {
		const toml = `${goodToml()}\nenabled_tools = ["discord_send"]\n`;
		expect(() => assertLeadActionsConfigGate(toml, expected())).not.toThrow();
	});

	it("rejects enabled_tools with an extra tool", () => {
		const toml = `${goodToml()}\nenabled_tools = ["discord_send", "run_shell"]\n`;
		expect(() => assertLeadActionsConfigGate(toml, expected())).toThrow(
			/enabled_tools/,
		);
	});
});
