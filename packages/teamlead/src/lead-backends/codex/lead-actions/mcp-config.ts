/**
 * FLY-350 — lead-actions MCP server config shape + the §10 config gate (pure).
 *
 * Single source of truth for (a) the `[mcp_servers.lead_actions]` the Codex TUI
 * daemon is configured with (written into CODEX_HOME/config.toml by
 * codex-lead-tui-home.sh) and (b) the §10 fail-closed CONFIG assertion the runtime
 * runs before daemon startup.
 *
 * § 10 gate model (race-fix design review, option C): codex 0.141 spawns the MCP
 * child EPHEMERALLY per built_tools call (no persistent "ready" lifecycle status),
 * so the old runtime "wait for the live MCP to report ready" gate false-times-out.
 * Instead the runtime asserts the EFFECTIVE config.toml it is about to hand the
 * daemon contains EXACTLY the trusted lead-actions MCP and nothing else — codex
 * can only spawn what is configured, and the first-party MCP registers exactly
 * `discord_send` (proved by the real-daemon integration test). Deterministic +
 * race-free; the security property (model tool surface == exactly `discord_send`,
 * no extra MCP, no secret in config) is preserved.
 *
 * SECRETLESS: the env here carries only NON-SECRET coordinates (the broker
 * socket path + lead/project/channel/state config). The Discord bot token is
 * NEVER here — the MCP child fetches it over the broker socket at startup.
 */

import { parse as parseToml } from "smol-toml";

/** The MCP server name as it appears in config.toml / the tool-name prefix. */
export const LEAD_ACTIONS_MCP_SERVER_NAME = "lead_actions";

/** The EXACT set of model-callable tools the content-coordination Lead exposes.
 * Linear create/assign is a FLY-351 follow-on (added here when it lands). */
export const LEAD_ACTIONS_TOOLS: readonly string[] = ["discord_send"];

export interface LeadActionsMcpServerConfig {
	command: string;
	args: string[];
	/** Non-secret coordinates only (broker socket + lead/project/channel/state). */
	env: Record<string, string>;
}

export interface BuildLeadActionsMcpOptions {
	/** Absolute node binary. */
	nodeBin: string;
	/** Absolute path to the built lead-actions-main.js (trusted dist). */
	mainJsPath: string;
	brokerSocketPath: string;
	leadId: string;
	projectName: string;
	chatChannelId: string;
	crossDeptChannelIds: string[];
	stateDir: string;
	explicitAliases?: string;
	/** FLY-676 — EFFECTIVE roundtable autoContinue (runtime-computed: replyInThread enabled
	 * && THREAD_AUTOCONTINUE !== "0"). When true, the child fail-soft refuses a proactive
	 * discord_send(target="roundtable") (FLY-680 owns the real engage hook). Non-secret. */
	roundtableAutoContinue?: boolean;
}

/** Keys that must NEVER appear in the MCP server env (defense-in-depth: this
 * config goes into config.toml on disk, readable in principle — only the broker
 * socket coordinate may reference secrets, and that is a path, not a secret). */
const FORBIDDEN_ENV_KEY = /TOKEN|SECRET|KEY/i;

/**
 * Build the `[mcp_servers.lead_actions]` server config — command + args +
 * NON-SECRET env coordinates. Throws if any env key looks secret-shaped
 * (the bot token must travel over the broker, never in config).
 */
export function buildLeadActionsMcpServerConfig(
	opts: BuildLeadActionsMcpOptions,
): LeadActionsMcpServerConfig {
	const env: Record<string, string> = {
		FLYWHEEL_LEAD_ID: opts.leadId,
		FLYWHEEL_PROJECT_NAME: opts.projectName,
		FLYWHEEL_LEAD_ACTIONS_BROKER_SOCKET: opts.brokerSocketPath,
		FLYWHEEL_LEAD_CHAT_CHANNEL_ID: opts.chatChannelId,
		FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS: opts.crossDeptChannelIds.join(","),
		FLYWHEEL_LEAD_ACTIONS_STATE_DIR: opts.stateDir,
	};
	if (opts.explicitAliases) {
		env.FLYWHEEL_LEAD_ACTIONS_CHANNEL_ALIASES = opts.explicitAliases;
	}
	// FLY-676: forward the effective roundtable autoContinue flag (non-secret) so the TUI
	// lead_actions child fail-soft refuses proactive roundtable sends — parity with the
	// headless path. Present only when ON (keeps the prior OFF env shape; byte-compat).
	if (opts.roundtableAutoContinue) {
		env.FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE_EFFECTIVE = "1";
	}
	for (const k of Object.keys(env)) {
		// FLYWHEEL_LEAD_ACTIONS_BROKER_SOCKET contains "SOCKET", not a secret token,
		// but the regex would not match it anyway; assert the REAL invariant: no
		// *TOKEN*/*SECRET*/*KEY* key smuggled a secret into config.
		if (FORBIDDEN_ENV_KEY.test(k)) {
			throw new Error(
				`buildLeadActionsMcpServerConfig: env key "${k}" is secret-shaped — secrets must travel over the broker, never in config.toml`,
			);
		}
	}
	return {
		command: opts.nodeBin,
		args: [opts.mainJsPath],
		env,
	};
}

/** Escape a string for a TOML basic (double-quoted) string. */
function tomlString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Serialize to a `[mcp_servers.<name>]` TOML fragment. env is rendered as the
 * Codex `env = { K = "V", ... }` inline table (literal values — the daemon
 * passes them to the child; all NON-SECRET here).
 */
export function toMcpServerToml(
	name: string,
	cfg: LeadActionsMcpServerConfig,
): string {
	const argsToml = cfg.args.map(tomlString).join(", ");
	const envPairs = Object.entries(cfg.env)
		.map(([k, v]) => `${k} = ${tomlString(v)}`)
		.join(", ");
	return [
		`[mcp_servers.${name}]`,
		`command = ${tomlString(cfg.command)}`,
		`args = [${argsToml}]`,
		`env = { ${envPairs} }`,
		"",
	].join("\n");
}

/** Error thrown when the live tool surface != the approved set (fail-closed). */
export class InventoryMismatchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InventoryMismatchError";
	}
}

/**
 * §10 / R3#3 fail-closed inventory gate: assert the model-callable tool surface
 * is EXACTLY the approved set (`LEAD_ACTIONS_TOOLS`) — no missing AND no extra
 * tools. The runtime calls this BEFORE allowing the gateway / Discord polling;
 * a mismatch (missing, extra, or none advertised) throws → the runtime exits
 * before any Discord traffic.
 *
 * Tool names may be prefixed by the MCP server name (e.g. `lead_actions.discord_send`
 * or `lead_actions__discord_send`); the comparison is on the bare tool name.
 */
export function assertLeadActionsInventory(liveTools: Iterable<string>): void {
	const approved = new Set(LEAD_ACTIONS_TOOLS);
	const live = new Set<string>();
	for (const raw of liveTools) {
		// strip a server-name prefix ("lead_actions.tool" / "lead_actions__tool").
		const bare = raw.replace(/^lead_actions[._]{1,2}/, "");
		live.add(bare);
	}
	const missing = [...approved].filter((t) => !live.has(t));
	const extra = [...live].filter((t) => !approved.has(t));
	if (missing.length > 0 || extra.length > 0) {
		throw new InventoryMismatchError(
			`lead-actions MCP inventory mismatch (fail-closed): ` +
				`missing=[${missing.join(", ")}] extra=[${extra.join(", ")}] ` +
				`(approved=[${[...approved].join(", ")}])`,
		);
	}
}

/** Error thrown when the effective config.toml fails the §10 config gate. */
export class ConfigGateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigGateError";
	}
}

/** Keys that must NEVER appear anywhere in the mcp_servers config (a secret in
 * config = the broker-only delivery invariant broken). */
const SECRET_SHAPED_KEY = /TOKEN|SECRET|KEY/i;

/**
 * §10 CONFIG GATE (race-fix design review option C, HIGH-1): parse the EFFECTIVE
 * `config.toml` the runtime is about to hand the codex daemon and HARD-ASSERT it
 * contains EXACTLY the trusted lead-actions MCP and nothing else. Throws
 * `ConfigGateError` on ANY drift — the runtime fail-closes before daemon startup.
 *
 * Asserts (precisely, per the design review):
 *  1. the TOML parses (a parse failure is itself fail-closed at the caller);
 *  2. `mcp_servers` has EXACTLY one key: `lead_actions` (reject every extra entry);
 *  3. `[mcp_servers.lead_actions].command` === the expected node binary, and
 *     `args` deep-equals the expected `[lead-actions-main.js]` (no alternate shape);
 *  4. its `env` keys are EXACTLY the expected non-secret coordinate set, and each
 *     value matches the runtime config (especially the broker socket path);
 *  5. NO secret-shaped key (`*TOKEN*`/`*SECRET*`/`*KEY*`) appears anywhere under
 *     `mcp_servers` (no `DISCORD_BOT_TOKEN`, no `env_vars` smuggling a token);
 *  6. if `enabled_tools` is present it is EXACTLY `["discord_send"]`; otherwise it
 *     must be absent (the surface is proved by the first-party MCP + real-daemon test).
 *
 * `expected` is the SAME `LeadActionsMcpServerConfig` the runtime built + wrote, so
 * the gate proves the on-disk config was not tampered/extended between write and
 * daemon startup, and that no other MCP can be spawned.
 */
export function assertLeadActionsConfigGate(
	tomlContent: string,
	expected: LeadActionsMcpServerConfig,
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
	// (2) exactly one server, named lead_actions.
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
	// (2b) code-review HIGH-2: the server object's top-level keys must be EXACTLY a
	// subset of the approved stdio shape — reject ANY unapproved key (e.g. `url` +
	// `type = "streamable-http"`, which would make codex spawn a DIFFERENT transport
	// / tool source than the trusted local stdio MCP). Option C's guarantee is
	// "exact trusted stdio MCP and no alternate shape".
	const APPROVED_SERVER_KEYS = new Set([
		"command",
		"args",
		"env",
		"enabled_tools",
	]);
	const unapproved = Object.keys(s).filter((k) => !APPROVED_SERVER_KEYS.has(k));
	if (unapproved.length > 0) {
		throw new ConfigGateError(
			`lead_actions has unapproved field(s) [${unapproved.join(", ")}] — only [${[...APPROVED_SERVER_KEYS].join(", ")}] are allowed (no alternate transport/tool-source; fail-closed)`,
		);
	}
	// (3) command + args exact.
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
	// (5) NO secret-shaped key anywhere under mcp_servers — reject env_vars too.
	const scanForSecrets = (obj: unknown, path: string): void => {
		if (!obj || typeof obj !== "object") return;
		for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
			if (SECRET_SHAPED_KEY.test(k)) {
				throw new ConfigGateError(
					`secret-shaped key "${k}" found at ${path} — secrets must travel over the broker, never config.toml (fail-closed)`,
				);
			}
			if (v && typeof v === "object") scanForSecrets(v, `${path}.${k}`);
		}
	};
	scanForSecrets(srv, `mcp_servers.${LEAD_ACTIONS_MCP_SERVER_NAME}`);
	// reject env_vars entirely (it would forward a host env var by NAME — a token path).
	if ("env_vars" in s) {
		throw new ConfigGateError(
			"lead_actions must not declare env_vars (no host-env forwarding — secrets go over the broker)",
		);
	}
	// (4) env keys EXACTLY the expected set + values match.
	const env = s.env;
	if (!env || typeof env !== "object" || Array.isArray(env)) {
		throw new ConfigGateError("lead_actions.env is missing or malformed");
	}
	const envObj = env as Record<string, unknown>;
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
	// (6) enabled_tools, if present, EXACTLY ["discord_send"].
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
	// A full-access Lead must NOT carry the read-deny permission profile.
	if (parsed.default_permissions !== undefined) {
		throw new ConfigGateError(
			`full-access config.toml must NOT set default_permissions (read-deny profile) — got ${JSON.stringify(parsed.default_permissions)}`,
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
// FLY-398 — FULL-ACCESS lead_actions (a SEPARATE, named gate; NOT a widened one).
//
// A full-access (= Claude-equal) Codex Lead has NO broker: the bot token lives in
// the daemon env (the H-1 positive allowlist), so the lead_actions MCP child gets
// it BY NAME via `env_vars = ["DISCORD_BOT_TOKEN"]` — the same token-by-name form
// the headless full-access argv route uses. It also pins
// `default_tools_approval_mode = "approve"` so codex auto-approves discord_send
// instead of eliciting (FLY-398 root cause). The broker-confined gate above keeps
// rejecting `env_vars` + extra fields (FLY-350 invariant); these full-access
// allowances live in a DISTINCT function so they can never bleed into the confined
// path (Codex R1 MED-3 / R2 LOW-1). The token is NEVER a literal in config.toml —
// only its NAME (env_vars) appears.
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
 * `ConfigGateError` on ANY drift (fail-closed). Distinct from the broker-confined
 * gate: it ALLOWS exactly `default_tools_approval_mode === "approve"` +
 * `env_vars === ["DISCORD_BOT_TOKEN"]`, while still rejecting literal secrets, extra
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
	// full-access approved keys = confined set PLUS env_vars + approval mode.
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
