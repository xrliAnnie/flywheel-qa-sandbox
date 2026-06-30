import { describe, expect, it } from "vitest";
import {
	assertFullAccessLeadActionsConfigGate,
	assertFullAccessSandboxConfig,
	assertLeadActionsConfigGate,
	assertLeadActionsInventory,
	buildFullAccessLeadActionsMcpServerConfig,
	buildLeadActionsMcpServerConfig,
	ConfigGateError,
	InventoryMismatchError,
	LEAD_ACTIONS_TOOLS,
	toFullAccessMcpServerToml,
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

	it("FLY-676: forwards FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE_EFFECTIVE only when on (TUI guard)", () => {
		const off = buildLeadActionsMcpServerConfig(baseOpts());
		expect("FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE_EFFECTIVE" in off.env).toBe(
			false,
		);
		const on = buildLeadActionsMcpServerConfig({
			...baseOpts(),
			roundtableAutoContinue: true,
		});
		expect(on.env.FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE_EFFECTIVE).toBe("1");
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

	it("FLY-676: accepts config WITH the effective-flag env when expected has it (on-case round-trip)", () => {
		const expectedOn = buildLeadActionsMcpServerConfig({
			...baseOpts(),
			roundtableAutoContinue: true,
		});
		const tomlOn = [
			'default_permissions = "flywheel-lead-secret-deny"',
			'approval_policy = "never"',
			toMcpServerToml("lead_actions", expectedOn),
		].join("\n");
		expect(() => assertLeadActionsConfigGate(tomlOn, expectedOn)).not.toThrow();
		// drift: a config carrying the flag but an `expected` WITHOUT it fail-closes (loud).
		expect(() => assertLeadActionsConfigGate(tomlOn, expected())).toThrow(
			/env keys/,
		);
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

describe("FLY-398 full-access lead_actions (discriminated gate — NOT a widened gate)", () => {
	const faOpts = () => ({
		nodeBin: "/usr/local/bin/node",
		mainJsPath: "/Users/x/dist/lead-actions/lead-actions-main.js",
		leadId: "mufasa-lead",
		projectName: "growth",
		chatChannelId: "1500600400238084307",
		crossDeptChannelIds: ["1512578695468941333"],
		stateDir: "/Users/x/.flywheel/state/codex-lead/mufasa",
	});

	describe("buildFullAccessLeadActionsMcpServerConfig", () => {
		it("builds command/args + non-secret coords, env_vars by NAME, approve mode, NO broker socket", () => {
			const cfg = buildFullAccessLeadActionsMcpServerConfig(faOpts());
			expect(cfg.command).toBe("/usr/local/bin/node");
			expect(cfg.args).toEqual([
				"/Users/x/dist/lead-actions/lead-actions-main.js",
			]);
			expect(cfg.env.FLYWHEEL_LEAD_ID).toBe("mufasa-lead");
			expect(cfg.env.FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS).toBe(
				"1512578695468941333",
			);
			// full-access = Claude-equal: NO broker (token is by-name in the daemon env).
			expect(cfg.env.FLYWHEEL_LEAD_ACTIONS_BROKER_SOCKET).toBeUndefined();
			expect(cfg.envVarNames).toEqual(["DISCORD_BOT_TOKEN"]);
			expect(cfg.defaultToolsApprovalMode).toBe("approve");
			// no secret-shaped LITERAL env key (the token travels by name, never literal).
			for (const k of Object.keys(cfg.env)) {
				expect(/TOKEN|SECRET|KEY/i.test(k)).toBe(false);
			}
		});

		it("FLY-676: forwards FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE_EFFECTIVE only when on (TUI full-access guard)", () => {
			const off = buildFullAccessLeadActionsMcpServerConfig(faOpts());
			expect(
				"FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE_EFFECTIVE" in off.env,
			).toBe(false);
			const on = buildFullAccessLeadActionsMcpServerConfig({
				...faOpts(),
				roundtableAutoContinue: true,
			});
			expect(on.env.FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE_EFFECTIVE).toBe(
				"1",
			);
		});
	});

	const expectedFA = () => buildFullAccessLeadActionsMcpServerConfig(faOpts());
	const goodFAToml = () =>
		[
			'approval_policy = "never"',
			'sandbox_mode = "workspace-write"',
			"",
			toFullAccessMcpServerToml("lead_actions", expectedFA()),
		].join("\n");

	describe("toFullAccessMcpServerToml", () => {
		it("emits default_tools_approval_mode=approve + env_vars=[DISCORD_BOT_TOKEN]", () => {
			const toml = toFullAccessMcpServerToml("lead_actions", expectedFA());
			expect(toml).toContain("[mcp_servers.lead_actions]");
			expect(toml).toContain('default_tools_approval_mode = "approve"');
			expect(toml).toContain('env_vars = ["DISCORD_BOT_TOKEN"]');
			expect(toml).toContain('FLYWHEEL_LEAD_ID = "mufasa-lead"');
			// the token NAME may appear (env_vars) but never a literal token VALUE.
			expect(toml).not.toMatch(/SECRET/i);
		});
	});

	describe("assertFullAccessLeadActionsConfigGate", () => {
		it("accepts the exact full-access config (approve + env_vars by name)", () => {
			expect(() =>
				assertFullAccessLeadActionsConfigGate(goodFAToml(), expectedFA()),
			).not.toThrow();
		});

		it("rejects when default_tools_approval_mode is missing", () => {
			const toml = goodFAToml().replace(
				'default_tools_approval_mode = "approve"\n',
				"",
			);
			expect(() =>
				assertFullAccessLeadActionsConfigGate(toml, expectedFA()),
			).toThrow(/default_tools_approval_mode/);
		});

		it("rejects default_tools_approval_mode other than approve", () => {
			const toml = goodFAToml().replace(
				'default_tools_approval_mode = "approve"',
				'default_tools_approval_mode = "prompt"',
			);
			expect(() =>
				assertFullAccessLeadActionsConfigGate(toml, expectedFA()),
			).toThrow(/approve/);
		});

		it("rejects env_vars other than exactly [DISCORD_BOT_TOKEN]", () => {
			const toml = goodFAToml().replace(
				'env_vars = ["DISCORD_BOT_TOKEN"]',
				'env_vars = ["DISCORD_BOT_TOKEN", "GH_TOKEN"]',
			);
			expect(() =>
				assertFullAccessLeadActionsConfigGate(toml, expectedFA()),
			).toThrow(/env_vars/);
		});

		it("rejects a literal secret-shaped env value (token must be by NAME, not literal)", () => {
			const exp = expectedFA();
			const toml = [
				'approval_policy = "never"',
				toFullAccessMcpServerToml("lead_actions", {
					...exp,
					env: { ...exp.env, DISCORD_BOT_TOKEN: "sk-leak" },
				}),
			].join("\n");
			expect(() => assertFullAccessLeadActionsConfigGate(toml, exp)).toThrow(
				/secret-shaped/,
			);
		});

		it("rejects an EXTRA mcp_server (no second/injected MCP)", () => {
			const toml = `${goodFAToml()}\n[mcp_servers.evil]\ncommand = "node"\nargs = ["/tmp/evil.js"]\nenv = {}\n`;
			expect(() =>
				assertFullAccessLeadActionsConfigGate(toml, expectedFA()),
			).toThrow(/EXACTLY/);
		});
	});

	describe("no bleed: full-access allowances NEVER satisfy the confined gate", () => {
		it("the CONFINED gate rejects a full-access config (env_vars + approve)", () => {
			// A full-access config.toml fed to the broker-confined gate must FAIL —
			// the confined invariant (broker-only, no env_vars) must not weaken.
			expect(() =>
				assertLeadActionsConfigGate(
					goodFAToml(),
					// confined `expected` shape (no env_vars / approval mode)
					buildLeadActionsMcpServerConfig({
						...faOpts(),
						brokerSocketPath:
							"/Users/x/.flywheel/state/codex-lead/mufasa/lead-actions.sock",
					}),
				),
			).toThrow(ConfigGateError);
		});
	});
});

describe("assertFullAccessSandboxConfig (FLY-398 Codex R1 HIGH-2 — writable_roots pinned to validated root)", () => {
	const ROOT = "/Users/xiaorongli/Dev/growth";
	const goodSandboxToml = (root = ROOT) =>
		[
			'sandbox_mode = "workspace-write"',
			'approval_policy = "never"',
			"",
			"[sandbox_workspace_write]",
			"network_access = true",
			`writable_roots = [${JSON.stringify(root)}]`,
		].join("\n");

	it("accepts a config whose writable_roots is exactly [the validated project root]", () => {
		expect(() =>
			assertFullAccessSandboxConfig(goodSandboxToml(), ROOT),
		).not.toThrow();
	});

	it("REJECTS writable_roots pointing at a different (unvalidated) path", () => {
		// THE drift Codex R1 HIGH-2 caught: a stale FLYWHEEL_CODEX_TUI_CWD could point
		// the daemon writable root elsewhere while the parser accepted the project dir.
		const toml = goodSandboxToml("/Users/xiaorongli/.flywheel");
		expect(() => assertFullAccessSandboxConfig(toml, ROOT)).toThrow(
			/writable_roots must be exactly/,
		);
	});

	it("REJECTS sandbox_mode other than workspace-write", () => {
		const toml = goodSandboxToml().replace("workspace-write", "read-only");
		expect(() => assertFullAccessSandboxConfig(toml, ROOT)).toThrow(
			/sandbox_mode/,
		);
	});

	it("REJECTS network_access not true", () => {
		const toml = goodSandboxToml().replace(
			"network_access = true",
			"network_access = false",
		);
		expect(() => assertFullAccessSandboxConfig(toml, ROOT)).toThrow(
			/network_access/,
		);
	});

	it("REJECTS a read-deny permission profile on a full-access Lead", () => {
		// default_permissions must be a TOP-LEVEL key (placed before the
		// [sandbox_workspace_write] table, else TOML scopes it under that table).
		const toml = [
			'sandbox_mode = "workspace-write"',
			'approval_policy = "never"',
			'default_permissions = "flywheel-lead-secret-deny"',
			"",
			"[sandbox_workspace_write]",
			"network_access = true",
			`writable_roots = [${JSON.stringify(ROOT)}]`,
		].join("\n");
		expect(() => assertFullAccessSandboxConfig(toml, ROOT)).toThrow(
			/default_permissions/,
		);
	});

	it("REJECTS multiple writable_roots (must be exactly one)", () => {
		const toml = goodSandboxToml().replace(
			`writable_roots = [${JSON.stringify(ROOT)}]`,
			`writable_roots = [${JSON.stringify(ROOT)}, "/tmp"]`,
		);
		expect(() => assertFullAccessSandboxConfig(toml, ROOT)).toThrow(
			/writable_roots/,
		);
	});
});
