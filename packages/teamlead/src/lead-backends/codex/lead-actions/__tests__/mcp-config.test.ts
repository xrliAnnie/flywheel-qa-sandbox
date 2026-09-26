import { describe, expect, it } from "vitest";
import {
	assertFullAccessLeadActionsConfigGate,
	assertFullAccessSandboxConfig,
	buildFullAccessLeadActionsMcpServerConfig,
	toFullAccessMcpServerToml,
} from "../mcp-config.js";

describe("FLY-398 full-access lead_actions", () => {
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
			// full-access forwards the token by name in the daemon env.
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

	it("REJECTS a default permission profile on a full-access Lead", () => {
		// default_permissions must be a TOP-LEVEL key (placed before the
		// [sandbox_workspace_write] table, else TOML scopes it under that table).
		const toml = [
			'sandbox_mode = "workspace-write"',
			'approval_policy = "never"',
			'default_permissions = "legacy-restricted-profile"',
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
