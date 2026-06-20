/**
 * FLY-350 — lead-actions MCP server config shape + inventory gate (pure).
 *
 * Single source of truth for (a) the `[mcp_servers.lead_actions]` the Codex TUI
 * daemon is configured with (written into CODEX_HOME/config.toml by
 * codex-lead-tui-home.sh) and (b) the EXACT model-callable tool surface the
 * runtime asserts before it lets the gateway / Discord polling start (§10 / R3#3
 * fail-closed inventory gate).
 *
 * SECRETLESS: the env here carries only NON-SECRET coordinates (the broker
 * socket path + lead/project/channel/state config). The Discord bot token is
 * NEVER here — the MCP child fetches it over the broker socket at startup.
 */

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
