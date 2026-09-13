import { describe, expect, it } from "vitest";
import {
	assertGatewayOnlyToolSurface,
	GATEWAY_ACTION_TOOL_NAMES,
} from "../../action-surface.js";
import { buildCodexLeadMcpArgv } from "../../buildCodexLeadMcpArgv.js";
import { RUNNER_ACTION_TOOL_NAMES } from "../../runner-action-names.js";
import {
	assertFullAccessLeadActionsConfigGate,
	buildFullAccessLeadActionsMcpServerConfig,
	toFullAccessMcpServerToml,
} from "../mcp-config.js";

const opts = {
	nodeBin: "/node",
	mainJsPath: "/main.js",
	leadId: "product-lead",
	projectName: "demo",
	chatChannelId: "123",
	crossDeptChannelIds: [],
	stateDir: "/state",
	commDbPath: "/comm.db",
	outboundMode: "direct" as const,
	runnerContext: {
		env: {
			FLYWHEEL_LEAD_ID: "product-lead",
			FLYWHEEL_PROJECT_NAME: "demo",
			FLYWHEEL_LEAD_KEY: "demo-product-lead",
			FLYWHEEL_CODEX_LEAD_RUNNER_ACTIONS: "1",
		},
	},
};
describe("runner-enabled full-access static MCP config", () => {
	it("adds the six tools and union of direct/Bridge credential names", () => {
		const cfg = buildFullAccessLeadActionsMcpServerConfig(opts);
		expect(cfg.enabledTools).toEqual([
			"discord_send",
			"ack_batch",
			...RUNNER_ACTION_TOOL_NAMES,
		]);
		expect(cfg.envVarNames).toEqual([
			"DISCORD_BOT_TOKEN",
			"BRIDGE_URL",
			"TEAMLEAD_API_TOKEN",
			"FLYWHEEL_LEAD_CARRIER_INSTANCE_ID",
		]);
		expect(cfg.env.FLYWHEEL_LEAD_KEY).toBe("demo-product-lead");
		expect(() =>
			assertFullAccessLeadActionsConfigGate(
				toFullAccessMcpServerToml("lead_actions", cfg),
				cfg,
			),
		).not.toThrow();
	});
	it("requires the exact enabled tools when capability is enabled", () => {
		const cfg = buildFullAccessLeadActionsMcpServerConfig(opts);
		const toml = toFullAccessMcpServerToml("lead_actions", cfg);
		expect(() =>
			assertFullAccessLeadActionsConfigGate(
				toml.replace(/^enabled_tools.*\n/m, ""),
				cfg,
			),
		).toThrow();
		expect(() =>
			assertFullAccessLeadActionsConfigGate(
				toml.replace('"start_runner", ', ""),
				cfg,
			),
		).toThrow();
	});
	it("rejects secret literals and identity overrides in runner context", () => {
		expect(() =>
			buildFullAccessLeadActionsMcpServerConfig({
				...opts,
				runnerContext: {
					env: { ...opts.runnerContext.env, TEAMLEAD_API_TOKEN: "SECRET" },
				},
			}),
		).toThrow();
		expect(() =>
			buildFullAccessLeadActionsMcpServerConfig({
				...opts,
				runnerContext: {
					env: { ...opts.runnerContext.env, FLYWHEEL_LEAD_ID: "foreign" },
				},
			}),
		).toThrow();
	});
	it("carries the same enabled tool list into headless MCP overrides", () => {
		const cfg = buildFullAccessLeadActionsMcpServerConfig(opts);
		const result = buildCodexLeadMcpArgv({ leadActions: cfg });
		expect(result.argv).toContain(
			`mcp_servers.lead_actions.enabled_tools=${JSON.stringify(cfg.enabledTools)}`,
		);
	});

	it("gates the gateway inventory on the same explicit runner tool list", () => {
		const all = [...GATEWAY_ACTION_TOOL_NAMES, ...RUNNER_ACTION_TOOL_NAMES];
		expect(() => assertGatewayOnlyToolSurface(all, true)).not.toThrow();
		expect(() => assertGatewayOnlyToolSurface(all)).toThrow();
		expect(() =>
			assertGatewayOnlyToolSurface(GATEWAY_ACTION_TOOL_NAMES, true),
		).toThrow();
	});
});
