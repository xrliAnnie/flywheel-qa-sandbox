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
	chmodSync,
	copyFileSync,
	existsSync,
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
