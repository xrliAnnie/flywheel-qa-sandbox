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
