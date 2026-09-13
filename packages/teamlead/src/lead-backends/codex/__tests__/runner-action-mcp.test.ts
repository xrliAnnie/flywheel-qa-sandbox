import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildFullAccessAppServerEnv } from "../codex-lead-runtime.js";
import { buildTuiDaemonEnv } from "../codex-lead-tui-runtime.js";
import { resolveRunnerActionMcpContext } from "../runner-action-mcp.js";
import { runnerActionsOptionsFromEnv } from "../runner-actions.js";
import { runnerActionEnv } from "./helpers/runner-action-env.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	const home = mkdtempSync(join(tmpdir(), "fly2459-mcp-context-"));
	dirs.push(home);
	return runnerActionEnv(home, resolve(process.cwd(), "../.."));
}
it("projects canonical coordinates without bearer or credential values", () => {
	const env = fixture();
	env.FLYWHEEL_LEAD_CARRIER_INSTANCE_ID = "PRIVATE_CARRIER";
	const context = resolveRunnerActionMcpContext(env)!;
	expect(context.env.FLYWHEEL_LEAD_KEY).toBe("flywheel-flywheel-product-lead");
	expect(JSON.stringify(context)).not.toMatch(
		/TEST_BRIDGE|TEST_DISCORD|PRIVATE_CARRIER/,
	);
});
it("keeps canonical context in both full-access daemon env paths", () => {
	const env = fixture();
	const runnerActionContext = resolveRunnerActionMcpContext(env)!;
	const tui = buildTuiDaemonEnv({
		profile: "full-access",
		env,
		codexHome: join(env.HOME!, "codex"),
		botToken: "TEST_DISCORD",
		carrierInstanceId: "PRIVATE_CARRIER",
	});
	const headless = buildFullAccessAppServerEnv(env, {
		botToken: "TEST_DISCORD",
		bridgeUrl: env.BRIDGE_URL!,
		apiToken: env.TEAMLEAD_API_TOKEN!,
		runnerActionContext,
	});
	for (const child of [tui, headless]) {
		expect(child).toMatchObject(runnerActionContext.env);
		expect(child.TEAMLEAD_API_TOKEN).toBe("TEST_BRIDGE");
	}
});
it("rejects startup when direct mode enables runners without Bridge credentials", () => {
	const env = fixture();
	delete env.TEAMLEAD_API_TOKEN;
	expect(() => runnerActionsOptionsFromEnv(env)).toThrow(/credential/);
});
it("cannot enable MCP tools from a stale marker after raw registry revocation", () => {
	const env = fixture();
	const raw = JSON.parse(readFileSync(env.FLYWHEEL_PROJECTS_FILE!, "utf8"));
	raw[0].leads[0].codexRunnerActions = false;
	writeFileSync(env.FLYWHEEL_PROJECTS_FILE!, JSON.stringify(raw));
	expect(() => resolveRunnerActionMcpContext(env)).toThrow(/capability/);
});
it("preserves the off path and rejects truthy marker spellings", () => {
	expect(resolveRunnerActionMcpContext({})).toBeUndefined();
	expect(
		runnerActionsOptionsFromEnv({ FLYWHEEL_CODEX_LEAD_RUNNER_ACTIONS: "0" }),
	).toBeUndefined();
	expect(() =>
		resolveRunnerActionMcpContext({
			FLYWHEEL_CODEX_LEAD_RUNNER_ACTIONS: "true",
		}),
	).toThrow();
});
