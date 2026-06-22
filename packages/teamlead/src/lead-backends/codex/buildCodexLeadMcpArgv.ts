/**
 * FLY-224 Phase 5 — buildCodexLeadMcpArgv: builds the task-scoped MCP config the
 * Codex Lead's app-server is launched with (plan §6.7a, Phase 0A §8).
 *
 * The frozen startup form is `codex app-server --strict-config -c <overrides…>`.
 * This builder returns ONLY the `-c` override argv (the caller prepends the
 * binary + `app-server --strict-config`). The whole point (§6.7a) is that a Codex
 * Lead injects its OWN MCP servers per task and NEVER inherits the host's personal
 * `~/.codex` `[mcp_servers.*]` (Annie's personal MCP + an expired token = the
 * spike's first hang). Process-local `-c` (NOT `--profile`, which app-server
 * rejects) means no shared-file race.
 *
 * Hard rules encoded here:
 *   - DISCORD MCP IS NEVER INJECTED — the candidate has only send (no safe
 *     read/reaction subset); read goes through the Lead's own gateway, reactions
 *     through a controlled Bridge endpoint (§6.7a).
 *   - chrome-devtools-mcp@1.1.1 is env-gated: only when `chrome.enabled` AND a
 *     valid browser URL — the builder writes the CONCRETE `--browser-url=<value>`
 *     (NEVER a literal `$URL`; stdio MCP exec has no shell, so env interpolation
 *     would pass the literal string). Disabled / invalid → no entry (chrome is
 *     non-critical → degraded, not fatal; recorded in `warnings`).
 *   - NO RAW SECRET in argv or in the app-server child env: a server that needs a
 *     secret references env var NAMES only (`env_vars`), resolved by the spawner;
 *     the current injected set (chrome) needs none. The builder asserts no spec
 *     carries a raw value.
 *   - The effective config hash is returned for the manifest `configHash`.
 */

import { createHash } from "node:crypto";
import { LEAD_ACTIONS_MCP_SERVER_NAME } from "./lead-actions/mcp-config.js";

export const CHROME_MCP_PACKAGE = "chrome-devtools-mcp@1.1.1";
export const CHROME_SERVER_NAME = "chrome_devtools";

/** FLY-245 Phase A2: the Flywheel Lead gateway MCP server — the ONLY MCP a
 * write-capable Codex Lead is allowed to load (plan §3.2). Every MCP child runs
 * OUTSIDE the exec sandbox (R1), so any other MCP (e.g. Chrome DevTools, which can
 * drive authenticated GitHub / loopback Bridge pages) would be an action-bypass
 * channel around the gateway. */
export const GATEWAY_MCP_SERVER_NAME = "flywheel_gateway";

export interface ChromeMcpConfig {
	enabled: boolean;
	/** Chrome remote-debugging URL, e.g. http://127.0.0.1:9222 (host + port). */
	browserUrl?: string;
}

/** The resolved gateway MCP server command (built by the runtime in Phase F). */
export interface GatewayMcpConfig {
	command: string;
	args: string[];
	/** Env var NAMES only (never values) forwarded to the gateway child. */
	envVarNames?: string[];
}

/** FLY-304: the lead-actions MCP server command for a FULL-ACCESS Codex Lead
 * (proactive discord_send). Unlike the gateway, the bot token is forwarded BY
 * NAME via `envVarNames` (it is already in the full-access app-server env,
 * Claude-equal) — never a literal in argv. The non-secret channel coordinates
 * travel as literal `env` values. */
export interface LeadActionsMcpConfig {
	command: string;
	args: string[];
	/** Literal NON-SECRET env values (channel coords, state dir). A secret-shaped
	 * key (`*TOKEN*`/`*SECRET*`/`*KEY*`) is rejected — the token goes via
	 * `envVarNames`, never a literal. */
	env?: Record<string, string>;
	/** Env var NAMES to forward from the app-server env (e.g. DISCORD_BOT_TOKEN) —
	 * never values. */
	envVarNames?: string[];
}

export interface CodexLeadMcpOptions {
	chrome?: ChromeMcpConfig;
	/** FLY-245 Phase A2: when set (write-capable Lead), the MCP allowlist is
	 * EXACTLY this gateway — Chrome and every other MCP are force-excluded. */
	gateway?: GatewayMcpConfig;
	/** FLY-304: when set (full-access Lead), inject the lead-actions MCP
	 * (proactive discord_send). MUTUALLY EXCLUSIVE with `gateway` — a write-capable
	 * Lead is gateway-only (a 2nd out-of-sandbox MCP would bypass that allowlist). */
	leadActions?: LeadActionsMcpConfig;
}

/** FLY-398: codex 0.141 per-MCP-server tool-call approval mode
 * (`mcp_servers.<name>.default_tools_approval_mode`). `prompt` (the default) ⇒ the
 * app-server elicits approval before each tool call; a HEADLESS app-server advertises
 * no elicitation capability, so codex auto-DECLINES → "user rejected MCP tool call".
 * `approve` ⇒ auto-approve + execute without eliciting. `auto` ⇒ codex decides per
 * tool. Only `approve`/`prompt`/`auto` are valid (codex `--strict-config` enforces). */
export type McpToolsApprovalMode = "auto" | "prompt" | "approve";

/** A resolved MCP server to inject (no raw secrets — env values are NON-SECRET
 * coordinates only; secrets travel by NAME via `envVarNames`). */
export interface McpServerSpec {
	name: string;
	command: string;
	args: string[];
	/** Literal NON-SECRET env values (e.g. channel ids). Secret-shaped keys are
	 * rejected by `assertNoRawSecret`. */
	env?: Record<string, string>;
	/** Names of env vars to forward (values resolved by the spawner) — never values. */
	envVarNames?: string[];
	/** FLY-398: when set, emit `default_tools_approval_mode=<mode>` for this server
	 * (omitted otherwise → codex default = `prompt`, byte-compat). */
	defaultToolsApprovalMode?: McpToolsApprovalMode;
}

export interface CodexLeadMcpResult {
	/** The `-c` override argv to pass after `app-server --strict-config`. */
	argv: string[];
	/** Stable hash of the effective config → manifest `configHash`. */
	configHash: string;
	/** Server names actually injected. */
	included: string[];
	/** Degraded reasons (e.g. chrome enabled but URL invalid → skipped). */
	warnings: string[];
}

export function buildCodexLeadMcpArgv(
	opts: CodexLeadMcpOptions = {},
): CodexLeadMcpResult {
	const specs: McpServerSpec[] = [];
	const warnings: string[] = [];

	// FLY-304: gateway (write-capable) and leadActions (full-access) are mutually
	// exclusive. The gateway path is an EXACT allowlist (gateway-only) precisely
	// because MCP children run OUTSIDE the exec sandbox; a 2nd action MCP alongside
	// it would be an action-bypass channel around the gateway. Fail LOUD, never
	// silently pick one.
	if (opts.gateway && opts.leadActions) {
		throw new Error(
			"buildCodexLeadMcpArgv: gateway + leadActions are mutually exclusive — " +
				"a write-capable Lead is gateway-only (FLY-245 §3.2); full-access uses " +
				"leadActions and has no gateway (FLY-304)",
		);
	}

	if (opts.gateway) {
		// FLY-245 Phase A2 — WRITE-CAPABLE: the allowlist is EXACTLY the gateway.
		// Chrome (and any other MCP) is force-excluded: every MCP child runs outside
		// the exec sandbox, so a second MCP would be an action-bypass around the
		// gateway (plan §3.2). A configured Chrome is dropped LOUDLY (not silently).
		if (opts.chrome?.enabled) {
			warnings.push(
				"chrome MCP force-excluded: a write-capable Codex Lead allows ONLY the flywheel_gateway MCP (plan §3.2)",
			);
		}
		specs.push({
			name: GATEWAY_MCP_SERVER_NAME,
			command: opts.gateway.command,
			args: opts.gateway.args,
			...(opts.gateway.envVarNames
				? { envVarNames: opts.gateway.envVarNames }
				: {}),
		});
	} else {
		// FLY-304 FULL-ACCESS: inject the lead-actions MCP (proactive discord_send).
		// Not a strict allowlist like the gateway — full-access is Claude-equal /
		// unconfined, so chrome (below) may coexist. The bot token is forwarded BY
		// NAME (envVarNames); only NON-SECRET coordinates travel as literal `env`.
		if (opts.leadActions) {
			specs.push({
				name: LEAD_ACTIONS_MCP_SERVER_NAME,
				command: opts.leadActions.command,
				args: opts.leadActions.args,
				...(opts.leadActions.env ? { env: opts.leadActions.env } : {}),
				...(opts.leadActions.envVarNames
					? { envVarNames: opts.leadActions.envVarNames }
					: {}),
				// FLY-398: auto-approve the trusted, alias-gated, rate-limited, audited
				// lead_actions tools (discord_send). codex 0.141 otherwise elicits per-call
				// approval, which a headless app-server (no elicitation capability)
				// auto-declines → "user rejected MCP tool call" and discord_send never
				// runs. This is an INVARIANT of injecting lead_actions (always trusted),
				// not a caller-tunable knob; full-access is Claude-equal, so this is the
				// audited "正路" — not a sandbox boundary (FLY-304 §4).
				defaultToolsApprovalMode: "approve",
			});
		}
		// READ-ONLY companion path — unchanged (byte-compat with FLY-224).
		// chrome-devtools-mcp — env-gated, non-critical.
		if (opts.chrome?.enabled) {
			const url = opts.chrome.browserUrl;
			if (url && isValidChromeUrl(url)) {
				specs.push({
					name: CHROME_SERVER_NAME,
					command: "npx",
					// Concrete URL written into argv — never a literal "$URL".
					args: ["-y", CHROME_MCP_PACKAGE, `--browser-url=${url}`],
				});
			} else {
				warnings.push(
					`chrome MCP enabled but browserUrl is missing/invalid (${url ?? "undefined"}) — skipped (degraded, no Chrome)`,
				);
			}
		}
		// Discord MCP is intentionally NOT injected (see module docstring).
	}

	// Defense-in-depth: no spec may carry a raw secret value.
	for (const s of specs) assertNoRawSecret(s);

	const argv = specs.flatMap(specToArgv);
	const configHash = hashConfig(specs);
	return { argv, configHash, included: specs.map((s) => s.name), warnings };
}

/**
 * FLY-245 Phase A2 — startup MCP inventory assertion (plan §3.2 / §3.4). The
 * observed set of READY MCP servers (from app-server `mcpServer/startupStatus/
 * updated` notifications) must EXACTLY equal the allowlist (`result.included`).
 * Any extra (an injected Chrome / unknown connector) or any missing required
 * server fails the Lead closed. Pure — the runtime collects the observed set and
 * calls this before unlocking a write-capable Lead.
 */
export function assertMcpInventory(
	observed: readonly string[],
	allowed: readonly string[],
): void {
	const obs = new Set(observed);
	const exp = new Set(allowed);
	const extra = [...obs].filter((n) => !exp.has(n));
	const missing = [...exp].filter((n) => !obs.has(n));
	if (extra.length > 0 || missing.length > 0) {
		throw new Error(
			`FLY-245 MCP inventory mismatch: expected exactly [${[...exp].sort().join(", ")}], observed [${[...obs].sort().join(", ")}]` +
				(extra.length ? ` — unexpected: [${extra.sort().join(", ")}]` : "") +
				(missing.length ? ` — missing: [${missing.sort().join(", ")}]` : ""),
		);
	}
}

/** A chrome remote-debugging URL must be http(s) with a host AND an explicit port. */
export function isValidChromeUrl(raw: string): boolean {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return false;
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") return false;
	if (!u.hostname) return false;
	if (!u.port) return false; // chrome remote debugging is always host:port
	return true;
}

/** Encode one server as Codex `-c` overrides (TOML values via JSON encoding). */
function specToArgv(spec: McpServerSpec): string[] {
	const base = `mcp_servers.${spec.name}`;
	const out: string[] = [
		"-c",
		`${base}.command=${tomlValue(spec.command)}`,
		"-c",
		`${base}.args=${tomlValue(spec.args)}`,
	];
	// FLY-398: per-server tool-call approval mode (omitted → codex default `prompt`).
	if (spec.defaultToolsApprovalMode) {
		out.push(
			"-c",
			`${base}.default_tools_approval_mode=${tomlValue(spec.defaultToolsApprovalMode)}`,
		);
	}
	// FLY-304: literal NON-SECRET env values (e.g. channel coords) as dotted
	// overrides. Sorted for deterministic argv / configHash.
	if (spec.env) {
		for (const k of Object.keys(spec.env).sort()) {
			out.push("-c", `${base}.env.${k}=${tomlValue(spec.env[k] as string)}`);
		}
	}
	if (spec.envVarNames && spec.envVarNames.length > 0) {
		out.push("-c", `${base}.env_vars=${tomlValue(spec.envVarNames)}`);
	}
	return out;
}

/**
 * Encode a string or string[] as a TOML value. TOML inline arrays + basic
 * strings share JSON's `["a","b"]` / `"a"` shape for these inputs, so JSON
 * encoding produces valid TOML here (and safely escapes quotes/backslashes).
 */
function tomlValue(v: string | string[]): string {
	return JSON.stringify(v);
}

/** Throw if a spec embeds a raw secret value (only env var NAMES are allowed). */
function assertNoRawSecret(spec: McpServerSpec): void {
	for (const a of spec.args) {
		// A name reference like FLYWHEEL_X_TOKEN is fine; a value like
		// "token=sk-..." / "Bearer ..." is not. Heuristic: flag a secret-ish key
		// followed by an `=`/`:`/space and a non-trivial value.
		if (/(token|secret|api[_-]?key|password|bearer)\s*[=:]\s*\S+/i.test(a)) {
			throw new Error(
				`buildCodexLeadMcpArgv: spec "${spec.name}" embeds a raw secret in argv — forbidden (use env_vars by name)`,
			);
		}
	}
	for (const n of spec.envVarNames ?? []) {
		// env_vars must be bare NAMES (e.g. FOO_TOKEN), never "NAME=value" (which
		// would embed the raw value).
		if (n.includes("=")) {
			throw new Error(
				`buildCodexLeadMcpArgv: env_vars entry "${n}" must be a bare name, not NAME=value`,
			);
		}
	}
	// FLY-304: literal `env` values land verbatim in argv — they must be NON-SECRET
	// coordinates only. Reject loudly if EITHER (a) the KEY is secret-shaped
	// (DISCORD_BOT_TOKEN, *SECRET*, *KEY*) OR (b) the VALUE looks like a high-signal
	// secret even under a benign key (code-review R1#1: a future caller must not be
	// able to smuggle `{ SAFE_COORD: "sk-…" }` into argv). The token must travel by
	// NAME via `env_vars` instead.
	for (const [k, v] of Object.entries(spec.env ?? {})) {
		if (/token|secret|api[_-]?key|password|bearer/i.test(k)) {
			throw new Error(
				`buildCodexLeadMcpArgv: literal env key "${k}" is secret-shaped — a secret must travel by NAME via env_vars, never as a literal value in argv`,
			);
		}
		if (looksLikeSecretValue(v)) {
			throw new Error(
				`buildCodexLeadMcpArgv: literal env value for "${k}" looks like a secret (high-signal token form) — a secret must travel by NAME via env_vars, never as a literal value in argv`,
			);
		}
	}
}

/** FLY-304 (code-review R1#1): does a literal env VALUE look like a high-signal
 * secret? Catches the common token shapes (OpenAI `sk-`, GitHub `ghp_`/PAT, Slack
 * `xox*`, JWT, Discord bot-token 3-part) + a `key=value`/`bearer` form — WITHOUT
 * false-positiving on the non-secret coordinates this feature passes (numeric
 * channel ids, names, filesystem paths, `alias:id` pins). Defense-in-depth so the
 * builder enforces the "no raw secret value" invariant it documents. */
function looksLikeSecretValue(v: unknown): boolean {
	if (typeof v !== "string") return false;
	return (
		/(token|secret|api[_-]?key|password|bearer)\s*[=:]\s*\S/i.test(v) ||
		/(sk-[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|Bearer\s+\S+)/.test(
			v,
		) ||
		/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(v) || // JWT
		/^[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}$/.test(v) // Discord bot token shape
	);
}

/** Stable hash of the effective injected config (order-independent per server). */
function hashConfig(specs: McpServerSpec[]): string {
	const canonical = JSON.stringify(
		[...specs]
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((s) => ({
				name: s.name,
				command: s.command,
				args: s.args,
				env: s.env
					? Object.fromEntries(
							Object.entries(s.env).sort(([a], [b]) => a.localeCompare(b)),
						)
					: undefined,
				envVarNames: [...(s.envVarNames ?? [])].sort(),
				defaultToolsApprovalMode: s.defaultToolsApprovalMode,
			})),
	);
	return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
