/** FLY-398 — full-access lead-actions MCP config + fail-closed gates (pure). */

import { parse as parseToml } from "smol-toml";

/** The MCP server name as it appears in config.toml / the tool-name prefix. */
export const LEAD_ACTIONS_MCP_SERVER_NAME = "lead_actions";

/** The EXACT set of model-callable tools the lead-actions server exposes.
 * Linear create/assign is a FLY-351 follow-on (added here when it lands). */
export const LEAD_ACTIONS_TOOLS: readonly string[] = ["discord_send"];

/** Keys that must NEVER appear as literal MCP-server env values. */
const FORBIDDEN_ENV_KEY = /TOKEN|SECRET|KEY/i;

/** Escape a string for a TOML basic (double-quoted) string. */
function tomlString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Error thrown when the effective config.toml fails the §10 config gate. */
export class ConfigGateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigGateError";
	}
}

/** Keys that must NEVER appear as literal entries in the MCP server config. */
const SECRET_SHAPED_KEY = /TOKEN|SECRET|KEY/i;

/**
 * FLY-398 (Codex R1 HIGH-2) — assert the full-access config.toml SANDBOX shape against
 * the runtime-VALIDATED project root. The lead_actions gate validates the MCP block; this
 * validates the workspace-write sandbox itself so config drift cannot pass just because
 * the MCP block is correct. The `writable_roots` MUST equal exactly `[expectedWritableRoot]`
 * (the runtime's realpath-validated `fullAccessProjectRoot`) — otherwise a stale/overridden
 * `FLYWHEEL_CODEX_TUI_CWD` could point the daemon's writable root at an unvalidated path
 * (e.g. a control-plane dir) while the parser still accepted the validated project dir.
 * Throws `ConfigGateError` on ANY drift (fail-closed before the daemon starts).
 */
export function assertFullAccessSandboxConfig(
	tomlContent: string,
	expectedWritableRoot: string,
): void {
	let parsed: Record<string, unknown>;
	try {
		parsed = parseToml(tomlContent) as Record<string, unknown>;
	} catch (err) {
		throw new ConfigGateError(
			`config.toml does not parse (fail-closed): ${(err as Error).message}`,
		);
	}
	if (parsed.sandbox_mode !== "workspace-write") {
		throw new ConfigGateError(
			`full-access config.toml sandbox_mode must be "workspace-write" (got ${JSON.stringify(parsed.sandbox_mode)})`,
		);
	}
	if (parsed.approval_policy !== "never") {
		throw new ConfigGateError(
			`full-access config.toml approval_policy must be "never" (got ${JSON.stringify(parsed.approval_policy)})`,
		);
	}
	// A full-access Lead must not carry any permission-profile override.
	if (parsed.default_permissions !== undefined) {
		throw new ConfigGateError(
			`full-access config.toml must NOT set default_permissions — got ${JSON.stringify(parsed.default_permissions)}`,
		);
	}
	const sww = parsed.sandbox_workspace_write;
	if (!sww || typeof sww !== "object" || Array.isArray(sww)) {
		throw new ConfigGateError(
			"full-access config.toml missing [sandbox_workspace_write] table",
		);
	}
	const swwObj = sww as Record<string, unknown>;
	if (swwObj.network_access !== true) {
		throw new ConfigGateError(
			`full-access config.toml sandbox_workspace_write.network_access must be true (got ${JSON.stringify(swwObj.network_access)})`,
		);
	}
	const roots = swwObj.writable_roots;
	if (
		!Array.isArray(roots) ||
		roots.length !== 1 ||
		roots[0] !== expectedWritableRoot
	) {
		throw new ConfigGateError(
			`full-access config.toml sandbox_workspace_write.writable_roots must be exactly [${JSON.stringify(expectedWritableRoot)}] (the runtime-validated project root) — got ${JSON.stringify(roots)}. A drift means FLYWHEEL_CODEX_TUI_CWD diverged from the validated FLYWHEEL_CODEX_LEAD_PROJECT_DIR (Codex R1 HIGH-2).`,
		);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// FLY-398 — FULL-ACCESS lead_actions config + named gate.
//
// A full-access (= Claude-equal) Codex Lead has NO broker: the bot token lives in
// the daemon env (the H-1 positive allowlist), so the lead_actions MCP child gets
// it BY NAME via `env_vars = ["DISCORD_BOT_TOKEN"]` — the same token-by-name form
// the headless full-access argv route uses. It also pins
// `default_tools_approval_mode = "approve"` so codex auto-approves discord_send
// instead of eliciting (FLY-398 root cause). The token is NEVER a literal in
// config.toml — only its NAME (env_vars) appears.
// ─────────────────────────────────────────────────────────────────────────────

export interface LeadActionsFullAccessMcpServerConfig {
	command: string;
	args: string[];
	/** NON-SECRET coordinates only (lead/project/channel/state — NO broker socket). */
	env: Record<string, string>;
	/** Env var NAMES forwarded from the daemon env — EXACTLY ["DISCORD_BOT_TOKEN"]. */
	envVarNames: string[];
	/** FLY-398: pinned to "approve" so codex auto-approves the trusted tools. */
	defaultToolsApprovalMode: "approve";
}

/** The ONE env var NAME the full-access lead_actions child resolves for the bot
 * token (forwarded by name from the daemon env — never a literal). */
export const LEAD_ACTIONS_BOT_TOKEN_ENV = "DISCORD_BOT_TOKEN";

export interface BuildFullAccessLeadActionsMcpOptions {
	nodeBin: string;
	mainJsPath: string;
	leadId: string;
	projectName: string;
	chatChannelId: string;
	crossDeptChannelIds: string[];
	stateDir: string;
	explicitAliases?: string;
	/** FLY-676 — EFFECTIVE roundtable autoContinue (runtime-computed). When true, the child
	 * fail-soft refuses proactive discord_send(target="roundtable") (FLY-680). Non-secret. */
	roundtableAutoContinue?: boolean;
}

/** Build the FULL-ACCESS `[mcp_servers.lead_actions]` config — non-secret coords +
 * the bot token forwarded BY NAME (env_vars) + approve mode. NO broker socket (a
 * full-access Lead has no broker). Throws if any literal env key looks secret-shaped. */
export function buildFullAccessLeadActionsMcpServerConfig(
	opts: BuildFullAccessLeadActionsMcpOptions,
): LeadActionsFullAccessMcpServerConfig {
	const env: Record<string, string> = {
		FLYWHEEL_LEAD_ID: opts.leadId,
		FLYWHEEL_PROJECT_NAME: opts.projectName,
		FLYWHEEL_LEAD_CHAT_CHANNEL_ID: opts.chatChannelId,
		FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS: opts.crossDeptChannelIds.join(","),
		FLYWHEEL_LEAD_ACTIONS_STATE_DIR: opts.stateDir,
	};
	if (opts.explicitAliases) {
		env.FLYWHEEL_LEAD_ACTIONS_CHANNEL_ALIASES = opts.explicitAliases;
	}
	// FLY-676: forward the effective roundtable autoContinue flag (non-secret). Parity with
	// the headless full-access path; present only when ON (byte-compat OFF shape).
	if (opts.roundtableAutoContinue) {
		env.FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE_EFFECTIVE = "1";
	}
	for (const k of Object.keys(env)) {
		if (FORBIDDEN_ENV_KEY.test(k)) {
			throw new Error(
				`buildFullAccessLeadActionsMcpServerConfig: literal env key "${k}" is secret-shaped — the token travels BY NAME via env_vars, never a literal in config.toml`,
			);
		}
	}
	return {
		command: opts.nodeBin,
		args: [opts.mainJsPath],
		env,
		envVarNames: [LEAD_ACTIONS_BOT_TOKEN_ENV],
		defaultToolsApprovalMode: "approve",
	};
}

/** Render the FULL-ACCESS `[mcp_servers.lead_actions]` TOML fragment — adds
 * `default_tools_approval_mode` + `env_vars` to the base command/args/env form. */
export function toFullAccessMcpServerToml(
	name: string,
	cfg: LeadActionsFullAccessMcpServerConfig,
): string {
	const argsToml = cfg.args.map(tomlString).join(", ");
	const envPairs = Object.entries(cfg.env)
		.map(([k, v]) => `${k} = ${tomlString(v)}`)
		.join(", ");
	const envVarsToml = cfg.envVarNames.map(tomlString).join(", ");
	return [
		`[mcp_servers.${name}]`,
		`command = ${tomlString(cfg.command)}`,
		`args = [${argsToml}]`,
		`default_tools_approval_mode = ${tomlString(cfg.defaultToolsApprovalMode)}`,
		`env_vars = [${envVarsToml}]`,
		`env = { ${envPairs} }`,
		"",
	].join("\n");
}

/** High-signal secret VALUE shapes (defense-in-depth: reject a token smuggled as a
 * literal env value under a benign key — the coords this gate passes are numeric
 * ids / names / paths / `alias:id`, none of which match). */
const SECRET_SHAPED_VALUE =
	/(sk-[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/;

/**
 * FLY-398 §10 CONFIG GATE — FULL-ACCESS variant. Asserts the effective config.toml
 * contains EXACTLY the trusted full-access lead_actions MCP and nothing else. Throws
 * `ConfigGateError` on ANY drift (fail-closed). It requires exactly
 * `default_tools_approval_mode === "approve"` + `env_vars === ["DISCORD_BOT_TOKEN"]`,
 * while still rejecting literal secrets, extra
 * MCP servers, alternate transports/fields, and unexpected enabled tools.
 */
export function assertFullAccessLeadActionsConfigGate(
	tomlContent: string,
	expected: LeadActionsFullAccessMcpServerConfig,
): void {
	let parsed: Record<string, unknown>;
	try {
		parsed = parseToml(tomlContent) as Record<string, unknown>;
	} catch (err) {
		throw new ConfigGateError(
			`config.toml does not parse (fail-closed): ${(err as Error).message}`,
		);
	}
	const mcp = parsed.mcp_servers;
	if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) {
		throw new ConfigGateError(
			"config.toml has no [mcp_servers] table (fail-closed)",
		);
	}
	const servers = mcp as Record<string, unknown>;
	const names = Object.keys(servers);
	if (names.length !== 1 || names[0] !== LEAD_ACTIONS_MCP_SERVER_NAME) {
		throw new ConfigGateError(
			`mcp_servers must be EXACTLY { ${LEAD_ACTIONS_MCP_SERVER_NAME} } — found [${names.join(", ")}] (fail-closed: codex must not be able to spawn any other MCP)`,
		);
	}
	const srv = servers[LEAD_ACTIONS_MCP_SERVER_NAME];
	if (!srv || typeof srv !== "object" || Array.isArray(srv)) {
		throw new ConfigGateError("lead_actions server entry is malformed");
	}
	const s = srv as Record<string, unknown>;
	// Exact full-access stdio shape, including env_vars + approval mode.
	const APPROVED_SERVER_KEYS = new Set([
		"command",
		"args",
		"env",
		"env_vars",
		"default_tools_approval_mode",
		"enabled_tools",
	]);
	const unapproved = Object.keys(s).filter((k) => !APPROVED_SERVER_KEYS.has(k));
	if (unapproved.length > 0) {
		throw new ConfigGateError(
			`lead_actions has unapproved field(s) [${unapproved.join(", ")}] — only [${[...APPROVED_SERVER_KEYS].join(", ")}] are allowed for full-access (no alternate transport/tool-source; fail-closed)`,
		);
	}
	if (s.command !== expected.command) {
		throw new ConfigGateError(
			`lead_actions.command must be ${JSON.stringify(expected.command)} (got ${JSON.stringify(s.command)})`,
		);
	}
	const args = s.args;
	if (
		!Array.isArray(args) ||
		args.length !== expected.args.length ||
		args.some((a, i) => a !== expected.args[i])
	) {
		throw new ConfigGateError(
			`lead_actions.args must be exactly ${JSON.stringify(expected.args)} (got ${JSON.stringify(args)})`,
		);
	}
	// FLY-398: default_tools_approval_mode MUST be exactly "approve".
	if (s.default_tools_approval_mode !== "approve") {
		throw new ConfigGateError(
			`lead_actions.default_tools_approval_mode must be "approve" for full-access (got ${JSON.stringify(s.default_tools_approval_mode)}) — without it codex elicits approval and a headless/unattended daemon auto-declines (FLY-398)`,
		);
	}
	// env_vars MUST be EXACTLY ["DISCORD_BOT_TOKEN"] (token by name, never literal).
	const ev = s.env_vars;
	if (
		!Array.isArray(ev) ||
		ev.length !== 1 ||
		ev[0] !== LEAD_ACTIONS_BOT_TOKEN_ENV
	) {
		throw new ConfigGateError(
			`lead_actions.env_vars must be exactly ["${LEAD_ACTIONS_BOT_TOKEN_ENV}"] (got ${JSON.stringify(ev)}) — full-access forwards ONLY the bot token by name`,
		);
	}
	// env: exact non-secret coordinate set; reject any secret-shaped LITERAL key/value.
	const env = s.env;
	if (!env || typeof env !== "object" || Array.isArray(env)) {
		throw new ConfigGateError("lead_actions.env is missing or malformed");
	}
	const envObj = env as Record<string, unknown>;
	for (const [k, v] of Object.entries(envObj)) {
		if (SECRET_SHAPED_KEY.test(k)) {
			throw new ConfigGateError(
				`secret-shaped env key "${k}" — the token must travel BY NAME via env_vars, never a literal in config.toml (fail-closed)`,
			);
		}
		if (typeof v === "string" && SECRET_SHAPED_VALUE.test(v)) {
			throw new ConfigGateError(
				`lead_actions.env.${k} value looks like a secret — never a literal token in config.toml (fail-closed)`,
			);
		}
	}
	const expectedKeys = Object.keys(expected.env).sort();
	const actualKeys = Object.keys(envObj).sort();
	if (
		actualKeys.length !== expectedKeys.length ||
		actualKeys.some((k, i) => k !== expectedKeys[i])
	) {
		throw new ConfigGateError(
			`lead_actions.env keys must be EXACTLY [${expectedKeys.join(", ")}] (got [${actualKeys.join(", ")}])`,
		);
	}
	for (const k of expectedKeys) {
		if (envObj[k] !== expected.env[k]) {
			throw new ConfigGateError(
				`lead_actions.env.${k} must be ${JSON.stringify(expected.env[k])} (got ${JSON.stringify(envObj[k])})`,
			);
		}
	}
	if ("enabled_tools" in s) {
		const et = s.enabled_tools;
		if (
			!Array.isArray(et) ||
			et.length !== LEAD_ACTIONS_TOOLS.length ||
			et.some((t, i) => t !== LEAD_ACTIONS_TOOLS[i])
		) {
			throw new ConfigGateError(
				`lead_actions.enabled_tools, if present, must be exactly ${JSON.stringify(LEAD_ACTIONS_TOOLS)} (got ${JSON.stringify(et)})`,
			);
		}
	}
}
