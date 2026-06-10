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

export const CHROME_MCP_PACKAGE = "chrome-devtools-mcp@1.1.1";
export const CHROME_SERVER_NAME = "chrome_devtools";

export interface ChromeMcpConfig {
	enabled: boolean;
	/** Chrome remote-debugging URL, e.g. http://127.0.0.1:9222 (host + port). */
	browserUrl?: string;
}

export interface CodexLeadMcpOptions {
	chrome?: ChromeMcpConfig;
}

/** A resolved MCP server to inject (no raw secrets — env by NAME only). */
export interface McpServerSpec {
	name: string;
	command: string;
	args: string[];
	/** Names of env vars to forward (values resolved by the spawner) — never values. */
	envVarNames?: string[];
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

	// Defense-in-depth: no spec may carry a raw secret value.
	for (const s of specs) assertNoRawSecret(s);

	const argv = specs.flatMap(specToArgv);
	const configHash = hashConfig(specs);
	return { argv, configHash, included: specs.map((s) => s.name), warnings };
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
				envVarNames: [...(s.envVarNames ?? [])].sort(),
			})),
	);
	return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
