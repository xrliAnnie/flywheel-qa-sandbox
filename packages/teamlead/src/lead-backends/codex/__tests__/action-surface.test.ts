import { describe, expect, it } from "vitest";
import {
	assertActionToolSurface,
	GATEWAY_ACTION_TOOL_NAMES,
	NON_MCP_ACTION_SURFACES,
} from "../action-surface.js";

// The two reserved gateway tools a write-capable Lead may reach (245 scope).
// start_runner/read_runner_tmux are FLY-251 — NOT yet deployed, so they are NOT
// part of the approved surface here. The approved set is EXACTLY these two.
const GATEWAY_TOOLS = [...GATEWAY_ACTION_TOOL_NAMES];

describe("NON_MCP_ACTION_SURFACES (plan §3.5 checklist)", () => {
	it("enumerates every non-MCP surface F must disable", () => {
		expect([...NON_MCP_ACTION_SURFACES]).toEqual([
			"web_search",
			"connectors",
			"apps",
			"hooks",
			"multi_agent",
			"skill_install",
			"login",
		]);
	});
});

describe("GATEWAY_ACTION_TOOL_NAMES (the SSOT approved surface)", () => {
	it("is EXACTLY the two reserved gateway tools (245 scope)", () => {
		expect([...GATEWAY_ACTION_TOOL_NAMES]).toEqual([
			"request_runner_lifecycle",
			"relay_ship_decision",
		]);
	});
});

describe("assertActionToolSurface (FLY-245 Phase A3 / R2#1 / Codex code-review R1 HIGH-1)", () => {
	it("passes when observed EXACTLY equals the approved gateway tools (order-independent)", () => {
		expect(() =>
			assertActionToolSurface(
				["relay_ship_decision", "request_runner_lifecycle"],
				GATEWAY_TOOLS,
			),
		).not.toThrow();
	});

	it("HIGH-1: an EMPTY observed set fails closed (unproven surface ≠ proven safe)", () => {
		// The old subset check passed on []. An empty observation means we never
		// confirmed the tool surface — that must NOT unlock write capability.
		expect(() => assertActionToolSurface([], GATEWAY_TOOLS)).toThrow(
			/no model-callable tools observed/i,
		);
	});

	it("HIGH-1: a MISSING approved tool fails closed (exact equality, not subset)", () => {
		expect(() =>
			assertActionToolSurface(["relay_ship_decision"], GATEWAY_TOOLS),
		).toThrow(/missing/i);
	});

	it("rejects a built-in egress tool (web_search) leaking through", () => {
		expect(() =>
			assertActionToolSurface(
				["relay_ship_decision", "request_runner_lifecycle", "web_search"],
				GATEWAY_TOOLS,
			),
		).toThrow(/web_search/);
	});

	it("rejects a live connector beyond the gateway", () => {
		expect(() =>
			assertActionToolSurface(
				["relay_ship_decision", "request_runner_lifecycle", "github_connector"],
				GATEWAY_TOOLS,
			),
		).toThrow(/action-surface assertion failed/);
	});

	it("lists ALL offending extra tools (sorted)", () => {
		expect(() =>
			assertActionToolSurface(
				[
					"relay_ship_decision",
					"request_runner_lifecycle",
					"zzz_tool",
					"aaa_tool",
				],
				GATEWAY_TOOLS,
			),
		).toThrow(/\[aaa_tool, zzz_tool\]/);
	});
});
