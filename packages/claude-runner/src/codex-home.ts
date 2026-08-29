/**
 * FLY-123 (parallelization + credentials): per-runner CODEX_HOME.
 *
 * THE root-cause fix for "Codex runner concurrency = 1": multiple Codex
 * runners sharing the single global `~/.codex` corrupt each other's
 * `auth.json` on account rotation / token refresh (concurrent writes to one
 * file). Giving each runner its own `CODEX_HOME` with an isolated
 * `auth.json` + `config.toml` kills that local file race — accounts can then
 * be shared safely across concurrent runners (same posture as Claude Code
 * sharing one account), exactly as the design delta (WS-A) specifies.
 *
 * The per-runner `config.toml` is ALSO where the GitHub token now lives
 * (WS-C): `[shell_environment_policy.set] GH_TOKEN`. codex reads
 * `$CODEX_HOME/config.toml` as base config, so the token reaches the sandbox
 * shell env WITHOUT riding the codex process argv (ps-visible) or the cycle
 * state file. The 0600 config is the single, minimal plaintext surface.
 *
 * Only the ~10KB account face (auth.json + config.toml) is isolated per
 * runner; everything else codex needs it creates inside the home itself
 * (sessions/, logs, caches). We do NOT `cp -r ~/.codex` (that would be GBs).
 */

import {
	accessSync,
	chmodSync,
	copyFileSync,
	existsSync,
	constants as fsConstants,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** gh tokens are `[A-Za-z0-9_]`; `-` tolerated. Same charset the adapter and
 * codex-resume validate, so a token that passes here rides a TOML
 * double-quoted string with zero escaping. */
const TOKEN_RE = /^[A-Za-z0-9_-]{1,255}$/;

/** Delimiters for the flywheel-managed credential block in config.toml. The
 * block is idempotently stripped + re-rendered, so re-provisioning never
 * stacks duplicate tables and retirement can scrub it cleanly. */
const MANAGED_BEGIN =
	"# >>> flywheel-managed credential (FLY-123) — do not edit >>>";
const MANAGED_END = "# <<< flywheel-managed credential (FLY-123) <<<";

/**
 * FLY-123 WS-C (Codex code review R1 HIGH): GitHub-token env names that must
 * NOT ride the runner process environment. The token's ONLY surface is the
 * per-runner 0600 config.toml ([shell_environment_policy.set]); codex injects
 * it into the SANDBOX shell from there. If the Bridge/tmux server was started
 * from a shell that exported GH_TOKEN, it would otherwise be inherited into
 * node → shim → codex (ps-visible), defeating the lockdown. We blank these in
 * the runner window env AND strip them from the spawned helper env.
 */
export const SECRET_ENV_VARS = [
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"GH_ENTERPRISE_TOKEN",
	"GITHUB_ENTERPRISE_TOKEN",
] as const;

/** Return a copy of `env` with GitHub-token vars removed (Fix 1). */
export function stripSecretEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = { ...env };
	for (const k of SECRET_ENV_VARS) delete out[k];
	return out;
}

/**
 * FLY-1188 (Codex full-PR review HIGH-4 R4): the EXACT `FLYWHEEL_` variable names
 * the resident codex daemon's model-driven shell legitimately needs. These are the
 * SAME names the adapter's `buildDaemonEnv` sets explicitly for the daemon (comm
 * CLI + db + ids + the scoped ingest token). An EXACT allowlist — not a
 * `FLYWHEEL_` name/shape PATTERN — because the Bridge env carries FLYWHEEL_ handles
 * whose names are not secret-shaped but ARE auth-capable and must NOT reach the
 * network-enabled model shell: `FLYWHEEL_*_KEYCHAIN_SERVICE`/`_ACCOUNT` (Keychain
 * credential coordinates), `FLYWHEEL_WRAPPER_ENV_FILE` (a secret .env path),
 * `FLYWHEEL_GATEWAY_BROKER_SOCKET` (a permission-broker socket) (R4 HIGH). Any
 * FLYWHEEL_ var not on this list is DROPPED.
 */
const RUNNER_ALLOWED_FLYWHEEL_ENV: ReadonlySet<string> = new Set([
	"FLYWHEEL_GATE_MARKER_DIR",
	"FLYWHEEL_RUNNER_BACKEND_ID",
	"FLYWHEEL_RUNNER_VENDOR_ID",
	"FLYWHEEL_COMM_DB",
	"FLYWHEEL_COMM_CLI",
	"FLYWHEEL_EXEC_ID",
	"FLYWHEEL_ISSUE_ID",
	"FLYWHEEL_BRIDGE_URL",
	"FLYWHEEL_INGEST_TOKEN",
	"FLYWHEEL_STATE_DB_PATH",
	"FLYWHEEL_PROGRESS_PATH",
	"FLYWHEEL_PROJECT_NAME",
	"FLYWHEEL_LEAD_ID",
	"FLYWHEEL_LAND_STATUS_PATH",
	// Agent Team identity injected by the transport (CodexAdapter) — internal,
	// non-secret name strings the spawn contract requires (R4 MEDIUM).
	"FLYWHEEL_AGENT_TEAM_NAME",
	"FLYWHEEL_AGENT_NAME",
]);

/**
 * FLY-1188 (Codex full-PR review HIGH-4 R3): a SAFE-BASE ALLOWLIST of OS/shell
 * environment names the daemon legitimately needs. An allowlist — not a
 * secret-name denylist — because a denylist by name misses auth-CAPABLE vars whose
 * names don't look secret (`SSH_AUTH_SOCK` → host SSH agent,
 * `AWS_SHARED_CREDENTIALS_FILE`/`GOOGLE_APPLICATION_CREDENTIALS` → cloud creds,
 * `KUBECONFIG` → cluster creds). Proxy vars are handled SEPARATELY (R4) so their
 * `user:pass@` userinfo can be stripped. Everything not on this list, not an exact
 * runner FLYWHEEL_ var, and not an `LC_*` locale var is DROPPED.
 */
const SAFE_BASE_ENV: ReadonlySet<string> = new Set([
	"PATH",
	"HOME",
	"SHELL",
	"USER",
	"LOGNAME",
	"LANG",
	"LANGUAGE",
	"TERM",
	"TZ",
	"TMPDIR",
	"TMP",
	"TEMP",
	"PWD",
	"HOSTNAME",
	"COLUMNS",
	"LINES",
	"EDITOR",
	"VISUAL",
	"PAGER",
	"XDG_RUNTIME_DIR",
	"XDG_CACHE_HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
]);

/** Proxy env names (host network config) — kept, but with any credential
 * userinfo stripped from the URL (R4: `HTTPS_PROXY=http://user:pass@h` leaks). */
const PROXY_ENV_NAMES: ReadonlySet<string> = new Set([
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy",
	"no_proxy",
]);

/** Strip `user:pass@` userinfo from a proxy URL so an embedded credential never
 * reaches the daemon's model shell; a value without a scheme/userinfo is unchanged. */
function sanitizeProxyValue(v: string): string | undefined {
	// Split off an optional `scheme://` OR a scheme-relative `//` marker.
	const marker = v.match(/^(?:[a-z][a-z0-9+.-]*:)?\/\//i);
	const scheme = marker ? marker[0] : "";
	const afterScheme = v.slice(scheme.length);
	// The authority ends at the first `/`, `?`, or `#` (or the whole rest).
	const authEnd = afterScheme.search(/[/?#]/);
	const authority =
		authEnd === -1 ? afterScheme : afterScheme.slice(0, authEnd);
	const rest = authEnd === -1 ? "" : afterScheme.slice(authEnd);
	const at = authority.lastIndexOf("@"); // LAST @ — userinfo may contain `@`
	const result =
		at === -1
			? v // no userinfo in the authority
			: authority.slice(at + 1)
				? scheme + authority.slice(at + 1) + rest
				: ""; // userinfo but no host

	// BELT-AND-SUSPENDERS (R6): a proxy value that clears MUST contain no `@`. A
	// residual `@` means a form we could not fully normalize — e.g. redundant
	// slashes `http:///user:pass@host`, which curl still parses as credentials, so
	// the userinfo would land outside the parsed authority above. Fail-closed: drop
	// the var entirely rather than pass a value with any embedded credential.
	if (result === "" || result.includes("@")) return undefined;
	return result;
}

/** FLY-1188 HIGH-4 R4: is `k` safe for the model-driven daemon to inherit AS-IS? */
function keepInheritedEnv(k: string): boolean {
	return (
		RUNNER_ALLOWED_FLYWHEEL_ENV.has(k) ||
		k.startsWith("LC_") || // locale
		SAFE_BASE_ENV.has(k)
	);
}

/**
 * FLY-1188 (Codex full-PR review HIGH-4): the resident codex daemon runs
 * model-driven shells/tools with the network ON, so it must NOT inherit ANYTHING
 * that carries or points at a credential — third-party API keys/tokens, DB
 * passwords, a FLYWHEEL_ Bridge secret (alert bot token / Keychain coords / wrapper
 * env-file / broker socket), OR auth-CAPABLE handles whose names don't look secret
 * (SSH_AUTH_SOCK, cloud credential-file pointers, KUBECONFIG). So the wash is a
 * strict ALLOWLIST (R4): a var is kept ONLY if it is an EXACT runner `FLYWHEEL_`
 * var, an `LC_*` locale var, or a name in `SAFE_BASE_ENV`; proxy vars are kept but
 * with credential userinfo stripped. Everything else is DROPPED. Codex reads its
 * own auth from CODEX_HOME files (re-layered by the caller), never env, so
 * over-removal is safe. Apply on the INHERITED env BEFORE layering the runner's
 * explicit `FLYWHEEL_*`/`CODEX_HOME`.
 */
export function stripInheritedSecretEnv(
	env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(env)) {
		if (v === undefined) continue;
		if (PROXY_ENV_NAMES.has(k)) {
			const sanitized = sanitizeProxyValue(v);
			if (sanitized !== undefined) out[k] = sanitized; // else fail-closed drop
			continue;
		}
		if (keepInheritedEnv(k)) out[k] = v;
	}
	// GH family is stripped even if it somehow slipped the allowlist above.
	for (const k of SECRET_ENV_VARS) delete out[k];
	return out;
}

/**
 * Per-runner CODEX_HOME root. Configurable (WS-E multi-machine seam) — a
 * future remote machine points this at its own local FS. Never hardcoded deep.
 */
export function codexHomesRoot(env: NodeJS.ProcessEnv = process.env): string {
	return (
		env.FLYWHEEL_CODEX_HOMES_ROOT?.trim() ||
		join(homedir(), ".flywheel", "codex-homes")
	);
}

/** The isolated CODEX_HOME directory for one runner execution. */
export function codexHomeDir(
	executionId: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	return join(codexHomesRoot(env), executionId);
}

/** The source ~/.codex we seed auth.json + config.toml from (the host's
 * active account state). Configurable for tests / future remote pools. */
export function sourceCodexDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.FLYWHEEL_CODEX_SOURCE_HOME?.trim() || join(homedir(), ".codex");
}

/** Shared account seed pool dir (read-only seed; the shim rotates within each
 * home). Configurable so the pool stays a single shared point, never copied
 * per home. */
export function codexProfilesDir(env: NodeJS.ProcessEnv = process.env): string {
	return (
		env.FLYWHEEL_CODEX_PROFILES_DIR?.trim() ||
		join(sourceCodexDir(env), "profiles")
	);
}

/**
 * Discover the account pool by listing profile directories — a FUNCTION, not
 * a constant (WS-E seam + AC6). Adding/removing a profile dir changes the pool
 * size with zero code change. Returns sorted account names ([] if none).
 */
export function discoverAccountPool(
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	const dir = codexProfilesDir(env);
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name)
		.sort();
}

/**
 * Absolute path to the repo-owned, CODEX_HOME-aware rotation shim (WS-B, P1 =
 * 4-C). This is what runners use via FLYWHEEL_CODEX_BIN — Annie's global
 * `codex-with-fallback` is never selected for runner traffic. An explicit
 * `FLYWHEEL_CODEX_BIN` env wins (tests / ops override). The bundled shim lives
 * at `<package>/bin/`, one level up from this module whether it runs from
 * `src/` (vitest) or `dist/` (built).
 */
export function flywheelCodexBin(env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env.FLYWHEEL_CODEX_BIN?.trim();
	if (explicit) return explicit;
	return fileURLToPath(
		new URL("../bin/flywheel-codex-with-fallback", import.meta.url),
	);
}

/**
 * QA · FLY-1188 — the RAW codex binary, for anything that must RENDER a TUI.
 *
 * The rotation shim above pipes codex's stdout through `tee` (it has to read
 * the output to sniff a 429 and rotate accounts), so a process launched through
 * it never gets a TTY on stdout. `codex app-server` does not care — it speaks
 * JSON-RPC over a socket, so the DAEMON keeps the shim (and its rotation).
 * `codex resume --remote` is a full-screen TUI: with a piped stdout it prints
 * `Error: stdout is not a terminal` and exits 1. That is exactly why the
 * founder's cmux tab was empty — real-machine QA capture in the FLY-1188 doc
 * folder, `qa/tui-failure-diagnosis.txt`.
 *
 * So: the TUI gets the real binary. `FLYWHEEL_CODEX_TUI_BIN` overrides (ops /
 * tests). Otherwise resolve an absolute path off OUR PATH — the tmux server the
 * window is created in may not share it — falling back to the bare name, which
 * is the verified lead-side behavior (lead-backends/codex/tui-window.ts).
 */
export function rawCodexBin(env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env.FLYWHEEL_CODEX_TUI_BIN?.trim();
	if (explicit) return explicit;
	for (const dir of (env.PATH ?? "").split(":")) {
		if (!dir) continue;
		const candidate = join(dir, "codex");
		try {
			accessSync(candidate, fsConstants.X_OK);
			return candidate;
		} catch {
			/* not here — keep looking */
		}
	}
	return "codex"; // last resort: let the tmux shell's own PATH resolve it
}

/**
 * FLY-1188: the flywheel-shipped codex runner behavior contract (single
 * source). Package-bundled at `<package>/agents/` — one level up from this
 * module whether it runs from `src/` (vitest) or `dist/` (built), the same
 * resolution shape as the rotation shim above. Materialized into every
 * per-runner `$CODEX_HOME/AGENTS.md` by provisionCodexHome; the CODEX_HOME
 * redirection means codex reads THIS instead of the host's global
 * ~/.codex/AGENTS.md (which carries runner-irrelevant injections).
 */
export function codexRunnerContractSource(): string {
	return fileURLToPath(
		new URL("../agents/codex-runner-contract.md", import.meta.url),
	);
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Remove any prior flywheel-managed credential block (idempotent). */
function stripManagedBlock(toml: string): string {
	const re = new RegExp(
		`\\n*${escapeRegExp(MANAGED_BEGIN)}[\\s\\S]*?${escapeRegExp(MANAGED_END)}\\n?`,
		"g",
	);
	return toml.replace(re, "\n");
}

/**
 * Render a per-runner config.toml = base config (the seeded global) + the
 * flywheel-managed GH_TOKEN block. WS-C delivery contract:
 * - base config preserved verbatim (model / sandbox_mode / trust levels).
 * - GH_TOKEN folded into `[shell_environment_policy.set]` — codex-side env
 *   injection identical to the old `-c shell_environment_policy.set.GH_TOKEN`,
 *   but off the argv.
 * - idempotent: any prior managed block is stripped before re-adding.
 * - fails LOUDLY if the base already declares `[shell_environment_policy]`
 *   (TOML forbids table redefinition) — that needs a real TOML-aware merge,
 *   which the current minimal writer intentionally does not do; the global
 *   config is verified not to declare it.
 */
export function renderCodexHomeConfig(
	baseToml: string,
	ghToken?: string,
): string {
	const base = stripManagedBlock(baseToml).trimEnd();
	if (!ghToken) return base ? `${base}\n` : "";
	// Conservative TOML guard (R1 LOW #5): reject ANY non-comment line that
	// declares the shell_environment_policy namespace — table header
	// (`[shell_environment_policy...]`, incl. spaced), OR dotted/inline key
	// (`shell_environment_policy.set... =`, `shell_environment_policy = {...}`).
	// Without a full TOML parser this prevents emitting a duplicate/conflicting
	// definition; the seeded global config is verified not to declare it.
	if (
		/^[ \t]*(?:\[[ \t]*shell_environment_policy\b|shell_environment_policy[ \t]*[.=])/m.test(
			base,
		)
	) {
		throw new Error(
			"renderCodexHomeConfig: base config.toml already declares the " +
				"shell_environment_policy namespace — TOML-aware merge required (the " +
				"seeded global config changed unexpectedly); refusing to emit a " +
				"conflicting definition.",
		);
	}
	const block = `${MANAGED_BEGIN}\n[shell_environment_policy.set]\nGH_TOKEN = "${ghToken}"\n${MANAGED_END}`;
	return base ? `${base}\n\n${block}\n` : `${block}\n`;
}

export interface ProvisionCodexHomeOptions {
	executionId: string;
	/** Host gh token (from `gh auth token`); omitted = no credential injected. */
	ghToken?: string;
	env?: NodeJS.ProcessEnv;
	/** FLY-1188: contract source override (tests). Default: the package-shipped file. */
	contractSourcePath?: string;
}

/**
 * Provision a per-runner CODEX_HOME: isolated `auth.json` (seeded from the
 * host's active account) + `config.toml` (seeded global config + GH_TOKEN).
 * Returns the absolute home path. Idempotent — re-provisioning overwrites
 * auth/config in place (no stacking).
 */
export function provisionCodexHome(opts: ProvisionCodexHomeOptions): string {
	const env = opts.env ?? process.env;
	if (opts.ghToken != null && !TOKEN_RE.test(opts.ghToken)) {
		throw new Error(
			"provisionCodexHome: ghToken must match ^[A-Za-z0-9_-]{1,255}$",
		);
	}
	// FLY-1188 (Codex M2 review MEDIUM-1): read + validate the contract BEFORE
	// any home/credential write — a missing contract must abort with ZERO
	// residue, never leave a half-provisioned home holding a live GH_TOKEN.
	const contractSrc = opts.contractSourcePath ?? codexRunnerContractSource();
	if (!existsSync(contractSrc)) {
		throw new Error(
			`provisionCodexHome: codex runner contract missing at ${contractSrc} — refusing to provision a contract-less codex home (FLY-1188)`,
		);
	}
	const contract = readFileSync(contractSrc, "utf-8");
	const home = codexHomeDir(opts.executionId, env);
	const src = sourceCodexDir(env);
	mkdirSync(home, { recursive: true, mode: 0o700 });
	// R1 MED #2: mkdir(recursive) does NOT repair a pre-existing dir mode
	// (re-provision / crash-recovered home), so force 0700.
	chmodSync(home, 0o700);

	// Seed auth.json (account state) — per-runner copy kills the shared-file
	// write race. 0600 explicit (copyFileSync does not guarantee mode).
	const srcAuth = join(src, "auth.json");
	if (existsSync(srcAuth)) {
		const destAuth = join(home, "auth.json");
		copyFileSync(srcAuth, destAuth);
		chmodSync(destAuth, 0o600);
	}

	// config.toml = seeded global + GH_TOKEN block (0600). chmod AFTER write —
	// writeFileSync mode only applies on CREATE, not to a pre-existing wider
	// file (R1 MED #2).
	const srcConfig = join(src, "config.toml");
	const baseToml = existsSync(srcConfig)
		? readFileSync(srcConfig, "utf-8")
		: "";
	const cfgPath = join(home, "config.toml");
	writeFileSync(cfgPath, renderCodexHomeConfig(baseToml, opts.ghToken), {
		encoding: "utf-8",
		mode: 0o600,
	});
	chmodSync(cfgPath, 0o600); // repair mode if the file pre-existed

	// FLY-1188: materialize the runner behavior contract as the home's
	// AGENTS.md — codex reads $CODEX_HOME/AGENTS.md on EVERY process, so this
	// is the persistent instruction layer (the dynamic per-execution layer
	// stays on stdin). The source was read + validated ABOVE, before any
	// home/credential write (fail-loud with zero residue): a codex runner
	// without its contract would silently run on whatever global AGENTS.md
	// content leaked into the seed — worse than not spawning.
	const agentsPath = join(home, "AGENTS.md");
	writeFileSync(
		agentsPath,
		`<!-- flywheel-managed (FLY-1188): materialized from ${contractSrc} at provisioning; do not edit — changes belong in the source file -->\n${contract}`,
		{ encoding: "utf-8", mode: 0o600 },
	);
	chmodSync(agentsPath, 0o600); // repair mode if the file pre-existed
	return home;
}

/**
 * P5 retirement (credential-residue invariant): strip the GH_TOKEN block from
 * a RETAINED home's config.toml so a long-lived home never hoards a live
 * token. Use on TERMINAL retirement (not while awaiting a gate — the runner
 * may still resume and needs the token). No-op if the home/config is gone.
 */
export function scrubCodexHomeCredential(
	executionId: string,
	env: NodeJS.ProcessEnv = process.env,
): void {
	const cfg = join(codexHomeDir(executionId, env), "config.toml");
	if (!existsSync(cfg)) return;
	const stripped = stripManagedBlock(readFileSync(cfg, "utf-8")).trimEnd();
	writeFileSync(cfg, stripped ? `${stripped}\n` : "", {
		encoding: "utf-8",
		mode: 0o600,
	});
	chmodSync(cfg, 0o600); // repair mode on the pre-existing file
}

/**
 * FLY-123 P5 + R1 MED #3 (crash-recovery janitor): strip the live-token
 * managed block from EVERY per-runner home whose execution id is NOT in
 * `liveExecIds`. Run at Bridge startup — if the Bridge was killed mid-run the
 * `finally` scrub never fired, leaving a live GH_TOKEN in the retained home's
 * config.toml indefinitely. Homes belonging to still-live runners are left
 * intact (they may resume and need the token). Returns the count scrubbed.
 */
export function scrubOrphanedCodexHomes(
	liveExecIds: Set<string>,
	env: NodeJS.ProcessEnv = process.env,
): number {
	const root = codexHomesRoot(env);
	if (!existsSync(root)) return 0;
	let scrubbed = 0;
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || liveExecIds.has(entry.name)) continue;
		const cfg = join(root, entry.name, "config.toml");
		if (!existsSync(cfg)) continue;
		const original = readFileSync(cfg, "utf-8");
		if (!original.includes(MANAGED_BEGIN)) continue; // already clean
		scrubCodexHomeCredential(entry.name, env);
		scrubbed++;
	}
	return scrubbed;
}

/** P5 retirement: remove the entire per-runner home (auth + config +
 * sessions). Best-effort; safe to call when the home never existed. */
export function removeCodexHome(
	executionId: string,
	env: NodeJS.ProcessEnv = process.env,
): void {
	try {
		rmSync(codexHomeDir(executionId, env), { recursive: true, force: true });
	} catch {
		// best-effort (mirrors removeCodexSessionState)
	}
}
