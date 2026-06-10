import { describe, expect, it } from "vitest";
import {
	buildCodexLeadMcpArgv,
	CHROME_MCP_PACKAGE,
	CHROME_SERVER_NAME,
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
