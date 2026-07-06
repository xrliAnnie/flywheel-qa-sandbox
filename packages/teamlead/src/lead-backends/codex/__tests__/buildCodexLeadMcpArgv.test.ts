import { describe, expect, it } from "vitest";
import {
	assertMcpInventory,
	buildCodexLeadMcpArgv,
	CHROME_MCP_PACKAGE,
	CHROME_SERVER_NAME,
	GATEWAY_MCP_SERVER_NAME,
	isValidChromeUrl,
} from "../buildCodexLeadMcpArgv.js";

describe("buildCodexLeadMcpArgv — chrome (env-gated)", () => {
	it("injects chrome-devtools-mcp with a CONCRETE browser URL when enabled+valid", () => {
		const r = buildCodexLeadMcpArgv({
			chrome: { enabled: true, browserUrl: "http://127.0.0.1:9222" },
		});
		expect(r.included).toEqual([CHROME_SERVER_NAME]);
		expect(r.warnings).toEqual([]);
		// -c pairs: command + args
		expect(r.argv).toContain("-c");
		expect(r.argv).toContain(`mcp_servers.${CHROME_SERVER_NAME}.command="npx"`);
		const argsEntry = r.argv.find((a) =>
			a.startsWith(`mcp_servers.${CHROME_SERVER_NAME}.args=`),
		);
		expect(argsEntry).toBeDefined();
		expect(argsEntry).toContain(CHROME_MCP_PACKAGE);
		// CONCRETE url, never a literal "$URL"
		expect(argsEntry).toContain("--browser-url=http://127.0.0.1:9222");
		expect(r.argv.join(" ")).not.toContain("$URL");
	});

	it("emits NO entry when chrome is disabled", () => {
		const r = buildCodexLeadMcpArgv({
			chrome: { enabled: false, browserUrl: "http://127.0.0.1:9222" },
		});
		expect(r.argv).toEqual([]);
		expect(r.included).toEqual([]);
		expect(r.warnings).toEqual([]);
	});

	it("emits NO entry (and a degraded warning) when enabled but URL invalid", () => {
		const r = buildCodexLeadMcpArgv({
			chrome: { enabled: true, browserUrl: "not-a-url" },
		});
		expect(r.included).toEqual([]);
		expect(r.argv).toEqual([]);
		expect(r.warnings).toHaveLength(1);
		expect(r.warnings[0]).toMatch(/chrome/i);
	});

	it("emits a degraded warning when enabled but URL missing", () => {
		const r = buildCodexLeadMcpArgv({ chrome: { enabled: true } });
		expect(r.included).toEqual([]);
		expect(r.warnings).toHaveLength(1);
	});

	it("no chrome config → empty argv", () => {
		const r = buildCodexLeadMcpArgv({});
		expect(r.argv).toEqual([]);
		expect(r.included).toEqual([]);
	});
});

describe("buildCodexLeadMcpArgv — never injects Discord MCP (§6.7a)", () => {
	it("the argv never references a discord MCP server", () => {
		const r = buildCodexLeadMcpArgv({
			chrome: { enabled: true, browserUrl: "http://127.0.0.1:9222" },
		});
		expect(r.argv.join(" ").toLowerCase()).not.toContain("discord");
		expect(r.included).not.toContain("discord");
	});
});

describe("buildCodexLeadMcpArgv — no raw secret in argv", () => {
	it("chrome argv carries no token/secret-looking value", () => {
		const r = buildCodexLeadMcpArgv({
			chrome: { enabled: true, browserUrl: "http://127.0.0.1:9222" },
		});
		expect(r.argv.join(" ")).not.toMatch(
			/(token|secret|api[_-]?key|password|bearer)\s*[=:]\s*\S/i,
		);
	});
});

describe("buildCodexLeadMcpArgv — configHash", () => {
	it("is stable for the same config and differs for a different one", () => {
		const a = buildCodexLeadMcpArgv({
			chrome: { enabled: true, browserUrl: "http://127.0.0.1:9222" },
		});
		const b = buildCodexLeadMcpArgv({
			chrome: { enabled: true, browserUrl: "http://127.0.0.1:9222" },
		});
		const c = buildCodexLeadMcpArgv({
			chrome: { enabled: true, browserUrl: "http://127.0.0.1:9333" },
		});
		const d = buildCodexLeadMcpArgv({});
		expect(a.configHash).toBe(b.configHash);
		expect(a.configHash).not.toBe(c.configHash);
		expect(a.configHash).not.toBe(d.configHash);
		expect(a.configHash).toMatch(/^[0-9a-f]{16}$/);
	});
});

describe("isValidChromeUrl", () => {
	it("accepts http(s) host:port", () => {
		expect(isValidChromeUrl("http://127.0.0.1:9222")).toBe(true);
		expect(isValidChromeUrl("https://localhost:9222")).toBe(true);
	});
	it("rejects missing port, wrong protocol, garbage", () => {
		expect(isValidChromeUrl("http://127.0.0.1")).toBe(false); // no port
		expect(isValidChromeUrl("ftp://127.0.0.1:9222")).toBe(false);
		expect(isValidChromeUrl("127.0.0.1:9222")).toBe(false); // no protocol
		expect(isValidChromeUrl("not a url")).toBe(false);
		expect(isValidChromeUrl("")).toBe(false);
	});
});

describe("buildCodexLeadMcpArgv — FLY-245 Phase A2 write-capable allowlist", () => {
	const gateway = {
		command: "/opt/flywheel/gateway",
		args: ["--stdio"],
		envVarNames: ["FLYWHEEL_GATEWAY_SOCKET"],
	};

	it("write-capable: MCP set is EXACTLY the gateway", () => {
		const r = buildCodexLeadMcpArgv({ gateway });
		expect(r.included).toEqual([GATEWAY_MCP_SERVER_NAME]);
		expect(r.argv).toContain(
			`mcp_servers.${GATEWAY_MCP_SERVER_NAME}.command="/opt/flywheel/gateway"`,
		);
		expect(
			r.argv.some((a) =>
				a.startsWith(`mcp_servers.${GATEWAY_MCP_SERVER_NAME}.env_vars=`),
			),
		).toBe(true);
	});

	it("write-capable: a configured Chrome is force-excluded LOUDLY (gateway only)", () => {
		const r = buildCodexLeadMcpArgv({
			gateway,
			chrome: { enabled: true, browserUrl: "http://127.0.0.1:9222" },
		});
		expect(r.included).toEqual([GATEWAY_MCP_SERVER_NAME]);
		expect(r.included).not.toContain(CHROME_SERVER_NAME);
		expect(r.warnings.join("\n")).toMatch(/chrome MCP force-excluded/);
	});

	it("read-only companion (no gateway): unchanged chrome behavior (byte-compat)", () => {
		const r = buildCodexLeadMcpArgv({
			chrome: { enabled: true, browserUrl: "http://127.0.0.1:9222" },
		});
		expect(r.included).toEqual([CHROME_SERVER_NAME]);
	});
});

describe("assertMcpInventory (FLY-245 Phase A2 startup assertion)", () => {
	it("passes when observed exactly equals the allowlist", () => {
		expect(() =>
			assertMcpInventory([GATEWAY_MCP_SERVER_NAME], [GATEWAY_MCP_SERVER_NAME]),
		).not.toThrow();
	});

	it("rejects an UNEXPECTED server (e.g. an injected Chrome)", () => {
		expect(() =>
			assertMcpInventory(
				[GATEWAY_MCP_SERVER_NAME, CHROME_SERVER_NAME],
				[GATEWAY_MCP_SERVER_NAME],
			),
		).toThrow(/unexpected.*chrome_devtools/i);
	});

	it("rejects a MISSING required server", () => {
		expect(() => assertMcpInventory([], [GATEWAY_MCP_SERVER_NAME])).toThrow(
			/missing.*flywheel_gateway/i,
		);
	});

	it("is order-independent", () => {
		expect(() => assertMcpInventory(["b", "a"], ["a", "b"])).not.toThrow();
	});
});

describe("buildCodexLeadMcpArgv — FLY-304 full-access leadActions (proactive discord_send)", () => {
	const leadActions = {
		command: "/usr/bin/node",
		args: ["/dist/lead-actions/lead-actions-main.js"],
		env: {
			FLYWHEEL_LEAD_ID: "mufasa-lead",
			FLYWHEEL_PROJECT_NAME: "growth",
			FLYWHEEL_LEAD_CHAT_CHANNEL_ID: "1500600400238084307",
			FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS: "1512578695468941333",
			FLYWHEEL_LEAD_ACTIONS_STATE_DIR: "/state",
		},
		envVarNames: ["DISCORD_BOT_TOKEN"],
	};

	it("injects EXACTLY the lead_actions server with command + args", () => {
		const r = buildCodexLeadMcpArgv({ leadActions });
		expect(r.included).toEqual(["lead_actions"]);
		expect(r.warnings).toEqual([]);
		expect(r.argv).toContain(
			'mcp_servers.lead_actions.command="/usr/bin/node"',
		);
		const argsEntry = r.argv.find((a) =>
			a.startsWith("mcp_servers.lead_actions.args="),
		);
		expect(argsEntry).toContain("lead-actions-main.js");
	});

	it("emits non-secret channel coords as literal env.K=value (sorted)", () => {
		const r = buildCodexLeadMcpArgv({ leadActions });
		expect(r.argv).toContain(
			'mcp_servers.lead_actions.env.FLYWHEEL_LEAD_ID="mufasa-lead"',
		);
		expect(r.argv).toContain(
			'mcp_servers.lead_actions.env.FLYWHEEL_LEAD_CHAT_CHANNEL_ID="1500600400238084307"',
		);
		expect(r.argv).toContain(
			'mcp_servers.lead_actions.env.FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS="1512578695468941333"',
		);
	});

	it("forwards the bot token BY NAME via env_vars — never a literal value", () => {
		const r = buildCodexLeadMcpArgv({ leadActions });
		expect(r.argv).toContain(
			'mcp_servers.lead_actions.env_vars=["DISCORD_BOT_TOKEN"]',
		);
		// the token NAME may appear (in env_vars), but never as a literal `env.X=`.
		expect(
			r.argv.some((a) => a.startsWith("mcp_servers.lead_actions.env.DISCORD")),
		).toBe(false);
	});

	it("leadActions + chrome COEXIST (full-access is not a strict allowlist)", () => {
		const r = buildCodexLeadMcpArgv({
			leadActions,
			chrome: { enabled: true, browserUrl: "http://127.0.0.1:9222" },
		});
		expect(r.included).toContain("lead_actions");
		expect(r.included).toContain(CHROME_SERVER_NAME);
	});

	it("THROWS on gateway + leadActions (mutually exclusive)", () => {
		expect(() =>
			buildCodexLeadMcpArgv({
				gateway: { command: "/gw", args: ["--stdio"] },
				leadActions,
			}),
		).toThrow(/mutually exclusive/i);
	});

	it("REJECTS a secret-shaped literal env key (token must go via env_vars)", () => {
		expect(() =>
			buildCodexLeadMcpArgv({
				leadActions: {
					...leadActions,
					env: { ...leadActions.env, DISCORD_BOT_TOKEN: "sk-leaked" },
				},
			}),
		).toThrow(/secret-shaped/i);
	});

	it("REJECTS a secret-shaped literal env VALUE under a benign key (R1#1)", () => {
		// A future caller must not smuggle a raw token under an innocent-looking key.
		expect(() =>
			buildCodexLeadMcpArgv({
				leadActions: {
					...leadActions,
					env: { ...leadActions.env, SAFE_COORD: "sk-ABCDEF0123456789" },
				},
			}),
		).toThrow(/looks like a secret/i);
		// a GitHub token shape under a benign key is also rejected.
		expect(() =>
			buildCodexLeadMcpArgv({
				leadActions: {
					...leadActions,
					env: { ...leadActions.env, NOTE: "ghp_ABCDEFGHIJ0123456789" },
				},
			}),
		).toThrow(/looks like a secret/i);
	});

	it("does NOT false-positive on the real non-secret coords (ids, names, paths, alias pin)", () => {
		expect(() =>
			buildCodexLeadMcpArgv({
				leadActions: {
					...leadActions,
					env: {
						...leadActions.env,
						FLYWHEEL_LEAD_ACTIONS_STATE_DIR: "/var/state/mufasa-lead",
						FLYWHEEL_LEAD_ACTIONS_CHANNEL_ALIASES:
							"roundtable:1512578695468941333",
					},
				},
			}),
		).not.toThrow();
	});

	it("configHash includes literal env (differs when a coord differs)", () => {
		const a = buildCodexLeadMcpArgv({ leadActions });
		const b = buildCodexLeadMcpArgv({
			leadActions: {
				...leadActions,
				env: { ...leadActions.env, FLYWHEEL_LEAD_CHAT_CHANNEL_ID: "999" },
			},
		});
		expect(a.configHash).not.toBe(b.configHash);
	});

	it("never embeds a raw token value anywhere in argv", () => {
		const r = buildCodexLeadMcpArgv({ leadActions });
		expect(r.argv.join(" ")).not.toMatch(
			/(token|secret|api[_-]?key|password|bearer)\s*[=:]\s*\S/i,
		);
	});
});

describe("buildCodexLeadMcpArgv — FLY-398 lead_actions auto-approve (default_tools_approval_mode)", () => {
	const leadActions = {
		command: "/usr/bin/node",
		args: ["/dist/lead-actions/lead-actions-main.js"],
		env: {
			FLYWHEEL_LEAD_ID: "mufasa-lead",
			FLYWHEEL_PROJECT_NAME: "growth",
			FLYWHEEL_LEAD_CHAT_CHANNEL_ID: "1500600400238084307",
			FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS: "1512578695468941333",
			FLYWHEEL_LEAD_ACTIONS_STATE_DIR: "/state",
		},
		envVarNames: ["DISCORD_BOT_TOKEN"],
	};

	it("pins default_tools_approval_mode=approve for the trusted lead_actions server", () => {
		// FLY-398 root cause: codex 0.141 gates MCP tool calls behind a per-server
		// approval mode (default ⇒ elicitation). A headless app-server advertises no
		// elicitation capability, so codex auto-DECLINES → "user rejected MCP tool
		// call". Pinning the audited lead_actions server to "approve" auto-approves +
		// executes discord_send without eliciting.
		const r = buildCodexLeadMcpArgv({ leadActions });
		expect(r.argv).toContain(
			'mcp_servers.lead_actions.default_tools_approval_mode="approve"',
		);
	});

	it("read-only companion (chrome) path emits NO approval-mode override (byte-compat)", () => {
		const r = buildCodexLeadMcpArgv({
			chrome: { enabled: true, browserUrl: "http://127.0.0.1:9222" },
		});
		expect(r.argv.some((a) => a.includes("default_tools_approval_mode"))).toBe(
			false,
		);
	});

	it("write-capable gateway path emits NO approval-mode override (byte-compat; out of scope)", () => {
		const r = buildCodexLeadMcpArgv({
			gateway: { command: "/gw", args: ["--stdio"] },
		});
		expect(r.argv.some((a) => a.includes("default_tools_approval_mode"))).toBe(
			false,
		);
	});

	it("the approval-mode override is reflected in configHash", () => {
		// The effective injected config changed (a new -c override), so the manifest
		// hash must change vs a spec without the approval mode.
		const withApprove = buildCodexLeadMcpArgv({ leadActions }).configHash;
		const chromeOnly = buildCodexLeadMcpArgv({
			chrome: { enabled: true, browserUrl: "http://127.0.0.1:9222" },
		}).configHash;
		expect(withApprove).not.toBe(chromeOnly);
	});
});
