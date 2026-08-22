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
	cpSync,
	existsSync,
	constants as fsConstants,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

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
const MANAGED_SKILLS_BEGIN =
	"# >>> flywheel-managed skills (FLY-1395) — do not edit >>>";
const MANAGED_SKILLS_END = "# <<< flywheel-managed skills (FLY-1395) <<<";
const MANAGED_NOTIFY_BEGIN =
	"# >>> flywheel-managed notify (FLY-1571) — do not edit >>>";
const MANAGED_NOTIFY_END = "# <<< flywheel-managed notify (FLY-1571) <<<";
const MANAGED_TRUST_BEGIN =
	"# >>> flywheel-managed workspace trust (FLY-1961) — do not edit >>>";
const MANAGED_TRUST_END =
	"# <<< flywheel-managed workspace trust (FLY-1961) <<<";
const CODEX_SKILL_NAME_RE = /^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/;
const MATT_CODEX_SKILL_DIRS = [
	"code-review",
	"diagnosing-bugs",
	"grilling",
	"tdd",
	"to-spec",
	"to-tickets",
] as const;

function namespaceMattSkill(contents: string, skillDir: string): string {
	const lineEnding = contents.startsWith("---\r\n") ? "\r\n" : "\n";
	if (!contents.startsWith(`---${lineEnding}`)) {
		throw new Error(
			`provisionCodexHome: matt skill ${skillDir} has no YAML frontmatter`,
		);
	}
	const bodyStart = `---${lineEnding}`.length;
	const frontmatterEnd = contents.indexOf(`${lineEnding}---`, bodyStart);
	if (frontmatterEnd < 0) {
		throw new Error(
			`provisionCodexHome: matt skill ${skillDir} has unterminated YAML frontmatter`,
		);
	}
	const frontmatter = contents.slice(bodyStart, frontmatterEnd);
	const nameMatch =
		/^name:\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([A-Za-z0-9._-]+))\s*$/m.exec(
			frontmatter,
		);
	const sourceName = nameMatch?.[1] ?? nameMatch?.[2] ?? nameMatch?.[3];
	if (!nameMatch || sourceName !== skillDir) {
		throw new Error(
			`provisionCodexHome: matt skill ${skillDir} frontmatter name must be ${skillDir}`,
		);
	}
	const namespacedFrontmatter = frontmatter.replace(
		nameMatch[0],
		`name: matt-skills:${skillDir}`,
	);
	return `${contents.slice(0, bodyStart)}${namespacedFrontmatter}${contents.slice(frontmatterEnd)}`;
}

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
 * FLY-1188 (Codex full-PR review HIGH-4 R3): a SAFE-BASE ALLOWLIST of OS/shell
 * environment names the daemon legitimately needs. An allowlist — not a
 * secret-name denylist — because a denylist by name misses auth-CAPABLE vars whose
 * names don't look secret (`SSH_AUTH_SOCK` → host SSH agent,
 * `AWS_SHARED_CREDENTIALS_FILE`/`GOOGLE_APPLICATION_CREDENTIALS` → cloud creds,
 * `KUBECONFIG` → cluster creds). Proxy vars are handled SEPARATELY (R4) so their
 * `user:pass@` userinfo can be stripped. Everything not on this list or an `LC_*`
 * locale var is DROPPED; inherited `FLYWHEEL_*` values are never retained.
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
		!k.startsWith("FLYWHEEL_") && (k.startsWith("LC_") || SAFE_BASE_ENV.has(k))
	);
}

/**
 * FLY-1188 (Codex full-PR review HIGH-4): the resident codex daemon runs
 * model-driven shells/tools with the network ON, so it must NOT inherit ANYTHING
 * that carries or points at a credential — third-party API keys/tokens, DB
 * passwords, a FLYWHEEL_ Bridge secret (alert bot token / Keychain coords / wrapper
 * env-file / broker socket), OR auth-CAPABLE handles whose names don't look secret
 * (SSH_AUTH_SOCK, cloud credential-file pointers, KUBECONFIG). So the wash is a
 * strict ALLOWLIST (R4): a var is kept ONLY if it is an `LC_*` locale var or a
 * name in `SAFE_BASE_ENV`; proxy vars are kept but with credential userinfo
 * stripped. Every inherited `FLYWHEEL_*` and everything else is DROPPED. Codex
 * reads its own auth from CODEX_HOME files (re-layered by the caller), never env.
 * The adapter applies this once to inherited env, then explicitly layers the
 * runner's execution-scoped protocol values.
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
	// GH family is stripped even if it somehow slipped the safe base above.
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
 * The rotation shim above redirects codex's stdout to a capture file (it has
 * to read the output to sniff a 429 and rotate accounts), so a process launched
 * through it never gets a TTY on stdout. `codex app-server` does not care — it
 * speaks JSON-RPC over a socket, so the DAEMON keeps the shim (and its
 * rotation).
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

/** Remove any prior flywheel-managed skill block (idempotent). */
function stripManagedSkillsBlock(toml: string): string {
	const re = new RegExp(
		`\n*${escapeRegExp(MANAGED_SKILLS_BEGIN)}[\\s\\S]*?${escapeRegExp(MANAGED_SKILLS_END)}\n?`,
		"g",
	);
	return toml.replace(re, "\n");
}

function stripManagedNotifyBlock(toml: string): string {
	const re = new RegExp(
		`\\n*${escapeRegExp(MANAGED_NOTIFY_BEGIN)}[\\s\\S]*?${escapeRegExp(MANAGED_NOTIFY_END)}\\n?`,
		"g",
	);
	return toml.replace(re, "\n").replace(/^\n+/, "");
}

function stripManagedTrustBlock(toml: string): string {
	const re = new RegExp(
		`\\n*${escapeRegExp(MANAGED_TRUST_BEGIN)}[\\s\\S]*?${escapeRegExp(MANAGED_TRUST_END)}\\n?`,
		"g",
	);
	return toml.replace(re, "\n");
}

export interface RenderCodexHomeConfigOptions {
	skillDisableNames?: string[];
	/** Absolute deployed hook path used by Codex's root-scope notify setting. */
	notifyProgramPath?: string;
	/** Canonical worktree Codex must trust before its TUI starts. */
	trustedProjectPath?: string;
}

/** FLY-1604: fixed placeholder used during structural validation. Lexically
 * equivalent to a TOKEN_RE-constrained token inside a TOML basic string, so
 * the placeholder-rendered candidate parses iff the real-token render would.
 * The live token must never enter the TOML parser — parser errors quote the
 * offending line and its neighbors, which could be the credential line. */
const TOKEN_PLACEHOLDER = "__FLYWHEEL_GH_TOKEN_PLACEHOLDER__";

/** Literal `[shell_environment_policy.set]` header line (whitespace and a
 * trailing comment tolerated). Anchor for the surgical merge ONLY — the
 * parsed base, not this regex, decides conflict semantics (FLY-1604). */
const SEP_SET_HEADER_RE =
	/^[ \t]*\[[ \t]*shell_environment_policy[ \t]*\.[ \t]*set[ \t]*\][ \t]*(?:#.*)?$/gm;
const ROOT_NOTIFY_RE = /^[ \t]*notify[ \t]*=.*$/gm;
const TABLE_HEADER_RE = /^[ \t]*\[{1,2}[^\n]+$/m;

function isPlainTable(v: unknown): v is Record<string, unknown> {
	return (
		typeof v === "object" &&
		v !== null &&
		!Array.isArray(v) &&
		!(v instanceof Date)
	);
}

/** Parse TOML with sanitized failures (FLY-1604, Codex R1 HIGH-1): smol-toml
 * errors embed the offending source line and its neighbors — potentially a
 * credential line — so the raw parser message never propagates. */
function parseTomlSanitized(
	text: string,
	stage: "base" | "rendered",
): Record<string, unknown> {
	try {
		return parseToml(text) as Record<string, unknown>;
	} catch {
		throw new Error(
			stage === "base"
				? "renderCodexHomeConfig: base config.toml is not valid TOML — refusing to merge into an unparseable config (parser detail withheld: it may quote config or credential content)."
				: "renderCodexHomeConfig: rendered config.toml would not be valid TOML — the base declares a shape this writer cannot legally extend (e.g. an inline table); refusing to write a corrupt config (parser detail withheld: it may quote config or credential content).",
		);
	}
}

/**
 * Render a per-runner config.toml = base config (the seeded global) + the
 * flywheel-managed GH_TOKEN block. WS-C delivery contract:
 * - base config preserved verbatim (model / sandbox_mode / trust levels).
 * - GH_TOKEN folded into `[shell_environment_policy.set]` — codex-side env
 *   injection identical to the old `-c shell_environment_policy.set.GH_TOKEN`,
 *   but off the argv.
 * - idempotent: any prior managed block is stripped before re-adding.
 * - FLY-1604 TOML-aware merge: codex itself now writes a
 *   `[shell_environment_policy.set]` table into the global config, so a base
 *   declaring the table is a MERGE case, not a conflict — the sentinel-wrapped
 *   GH_TOKEN keyline (headerless) is injected directly after the existing
 *   literal header, where TOML scopes it to that table. The parsed base is
 *   the semantic authority; genuinely unmergeable shapes (dotted/inline/
 *   quoted definitions, a pre-existing GH_TOKEN, unparseable TOML) still
 *   fail loudly — with sanitized messages that never quote the token or any
 *   config source.
 */
export function renderCodexHomeConfig(
	baseToml: string,
	ghToken?: string,
	opts: RenderCodexHomeConfigOptions = {},
): string {
	const hasNotify = opts.notifyProgramPath !== undefined;
	const hasTrust = opts.trustedProjectPath !== undefined;
	if (
		hasNotify &&
		(!opts.notifyProgramPath ||
			!isAbsolute(opts.notifyProgramPath) ||
			opts.notifyProgramPath.includes("\0"))
	) {
		throw new Error(
			"renderCodexHomeConfig: notifyProgramPath must be a non-empty absolute path without NUL bytes",
		);
	}
	if (
		hasTrust &&
		(!opts.trustedProjectPath ||
			!isAbsolute(opts.trustedProjectPath) ||
			opts.trustedProjectPath.includes("\0"))
	) {
		throw new Error(
			"renderCodexHomeConfig: trustedProjectPath must be a non-empty absolute and NUL-free path",
		);
	}
	const base = stripManagedSkillsBlock(
		stripManagedBlock(
			hasTrust
				? stripManagedTrustBlock(
						hasNotify ? stripManagedNotifyBlock(baseToml) : baseToml,
					)
				: hasNotify
					? stripManagedNotifyBlock(baseToml)
					: baseToml,
		),
	).trimEnd();
	const skillDisableNames = [...new Set(opts.skillDisableNames ?? [])].sort();
	for (const name of skillDisableNames) {
		if (!CODEX_SKILL_NAME_RE.test(name)) {
			throw new Error(
				`renderCodexHomeConfig: invalid Codex skill name ${JSON.stringify(name)}`,
			);
		}
	}
	// Defense in depth: provisionCodexHome validates too, but render is an
	// exported seam — an arbitrary string must never ride into TOML here.
	// Presence = `!== undefined`, NOT truthiness (Codex code R1 MED-1): a
	// supplied "" must fail here, never half-render as an empty credential.
	const hasToken = ghToken !== undefined;
	if (hasToken && !TOKEN_RE.test(ghToken)) {
		throw new Error(
			"renderCodexHomeConfig: ghToken must match ^[A-Za-z0-9_-]{1,255}$",
		);
	}
	if (!hasToken && skillDisableNames.length === 0 && !hasNotify && !hasTrust) {
		// Pure passthrough — nothing injected, no parse, no new failure surface.
		return base ? `${base}\n` : "";
	}

	// FLY-1604: the parsed base is the semantic authority for mergeability.
	// The old line-regex guards misclassified relative keys under other
	// tables as root-namespace conflicts and missed quoted headers entirely
	// (silent duplicate-table corruption caught only at codex startup).
	const notifyAnchors = hasNotify ? [...base.matchAll(ROOT_NOTIFY_RE)] : [];
	if (hasNotify && notifyAnchors.length > 1) {
		throw new Error(
			"renderCodexHomeConfig: base config.toml has an ambiguous notify definition — refusing to replace it",
		);
	}
	if (hasNotify && notifyAnchors[0]) {
		try {
			const parsedLine = parseToml(notifyAnchors[0][0]) as Record<
				string,
				unknown
			>;
			if (!Array.isArray(parsedLine.notify)) throw new Error("not an array");
		} catch {
			throw new Error(
				"renderCodexHomeConfig: root notify must be exactly one complete single-line array assignment — refusing an ambiguous shape",
			);
		}
	}
	const parsedBase = parseTomlSanitized(base, "base");
	let addManagedTrust = false;
	if (hasTrust) {
		const projects = parsedBase.projects;
		if (projects !== undefined && !isPlainTable(projects)) {
			throw new Error(
				"renderCodexHomeConfig: base config.toml projects must be a table",
			);
		}
		const target =
			projects === undefined ? undefined : projects[opts.trustedProjectPath!];
		if (target !== undefined && !isPlainTable(target)) {
			throw new Error(
				"renderCodexHomeConfig: target project entry must be a table",
			);
		}
		if (target !== undefined && target.trust_level !== "trusted") {
			throw new Error(
				"renderCodexHomeConfig: target project trust_level must already be trusted or absent",
			);
		}
		addManagedTrust = target === undefined;
	}
	let notifyAnchor: RegExpMatchArray | undefined;
	if (hasNotify) {
		const parsedNotify = parsedBase.notify;
		if (parsedNotify !== undefined && !Array.isArray(parsedNotify)) {
			throw new Error(
				"renderCodexHomeConfig: base config.toml defines notify with an unsupported quoted, dotted, or non-array shape",
			);
		}
		notifyAnchor = notifyAnchors[0];
		if (parsedNotify !== undefined && !notifyAnchor) {
			throw new Error(
				"renderCodexHomeConfig: base config.toml defines notify without one literal root assignment — refusing an ambiguous shape",
			);
		}
		if (notifyAnchor) {
			const notifyIndex = notifyAnchor.index ?? -1;
			const firstTable = TABLE_HEADER_RE.exec(base);
			if (notifyIndex < 0 || (firstTable && notifyIndex > firstTable.index)) {
				throw new Error(
					"renderCodexHomeConfig: notify assignment is not in the root namespace — refusing to rewrite a relative table key",
				);
			}
			if (parsedNotify === undefined) {
				throw new Error(
					"renderCodexHomeConfig: notify line does not resolve to the root namespace",
				);
			}
		}
	}

	// GH_TOKEN strategy: surgical (inject after the unique literal
	// [shell_environment_policy.set] header) when the base defines the set
	// table; otherwise append the classic full block — the candidate parse
	// below is the final judge of whether appending a fresh table header is
	// legal (inline tables are immutable and fail there).
	let surgicalAnchorEnd = -1;
	if (hasToken) {
		const sep = parsedBase.shell_environment_policy;
		if (sep !== undefined && !isPlainTable(sep)) {
			throw new Error(
				"renderCodexHomeConfig: base config.toml defines shell_environment_policy as a non-table value — cannot merge; refusing to emit a conflicting definition.",
			);
		}
		const sepSet = sep === undefined ? undefined : sep.set;
		if (isPlainTable(sepSet)) {
			if (Object.hasOwn(sepSet, "GH_TOKEN")) {
				throw new Error(
					"renderCodexHomeConfig: base config.toml already sets GH_TOKEN under shell_environment_policy.set — refusing to overwrite a non-flywheel-managed credential key.",
				);
			}
			const anchors = [...base.matchAll(SEP_SET_HEADER_RE)];
			const anchor = anchors.length === 1 ? anchors[0] : undefined;
			if (!anchor) {
				throw new Error(
					"renderCodexHomeConfig: base config.toml defines the shell_environment_policy.set table without exactly one literal [shell_environment_policy.set] header (quoted, dotted, or inline definition) — cannot merge surgically; refusing to emit a conflicting definition.",
				);
			}
			surgicalAnchorEnd = anchor.index + anchor[0].length;
		} else if (sepSet !== undefined) {
			throw new Error(
				"renderCodexHomeConfig: base config.toml defines shell_environment_policy.set as a non-table value — cannot merge; refusing to emit a conflicting definition.",
			);
		}
	}

	// Skills strategy: appending [[skills.config]] elements is legal
	// array-of-tables extension. Refuse a single-table skills.config and any
	// name overlap — codex's duplicate-name resolution is unverified, and an
	// effect-undefined config must not be written (FLY-1604 R1 MED-3).
	let baseSkillsCount = 0;
	if (skillDisableNames.length > 0) {
		const skills = parsedBase.skills;
		if (skills !== undefined && !isPlainTable(skills)) {
			throw new Error(
				"renderCodexHomeConfig: base config.toml defines skills as a non-table value — cannot merge; refusing to emit a conflicting definition.",
			);
		}
		const cfg = skills === undefined ? undefined : skills.config;
		if (cfg !== undefined) {
			if (!Array.isArray(cfg)) {
				throw new Error(
					"renderCodexHomeConfig: base config.toml defines skills.config as a single table — cannot extend it as an array of tables; refusing to emit a conflicting definition.",
				);
			}
			baseSkillsCount = cfg.length;
			const baseNames = new Set(
				cfg
					.filter(isPlainTable)
					.map((entry) => entry.name)
					.filter((name): name is string => typeof name === "string"),
			);
			if (skillDisableNames.some((name) => baseNames.has(name))) {
				throw new Error(
					"renderCodexHomeConfig: base config.toml already declares [[skills.config]] entries for skill names flywheel would disable — codex duplicate-name resolution is undefined; refusing to emit an ambiguous config.",
				);
			}
		}
	}

	// Deterministic builder (FLY-1604 R2 HIGH-1): candidate and final are
	// BOTH built from the original base along the same already-decided path;
	// the token value only ever lands on the managed GH_TOKEN line. No
	// global substitution — base bytes that happen to contain the
	// placeholder string stay untouched.
	const buildRendered = (
		tokenValue?: string,
		notifyProgramPath?: string,
	): string => {
		let body = base;
		const blocks: string[] = [];
		if (tokenValue !== undefined) {
			if (surgicalAnchorEnd >= 0) {
				body = `${base.slice(0, surgicalAnchorEnd)}\n${MANAGED_BEGIN}\nGH_TOKEN = "${tokenValue}"\n${MANAGED_END}${base.slice(surgicalAnchorEnd)}`;
			} else {
				blocks.push(
					`${MANAGED_BEGIN}\n[shell_environment_policy.set]\nGH_TOKEN = "${tokenValue}"\n${MANAGED_END}`,
				);
			}
		}
		if (notifyProgramPath !== undefined) {
			const notifyLine = stringifyToml({
				notify: [notifyProgramPath, "--codex"],
			}).trim();
			if (notifyLine.includes("\n")) {
				throw new Error(
					"renderCodexHomeConfig: internal notify serializer emitted a multiline assignment",
				);
			}
			const block = `${MANAGED_NOTIFY_BEGIN}\n${notifyLine}\n${MANAGED_NOTIFY_END}`;
			if (notifyAnchor) {
				const notifyIndex = notifyAnchor.index ?? -1;
				if (notifyIndex < 0) {
					throw new Error(
						"renderCodexHomeConfig: internal notify anchor has no source offset",
					);
				}
				body = `${body.slice(0, notifyIndex)}${block}${body.slice(notifyIndex + notifyAnchor[0].length)}`;
			} else {
				body = body ? `${block}\n${body}` : block;
			}
		}
		if (skillDisableNames.length > 0) {
			const entries = skillDisableNames.map(
				(name) => `[[skills.config]]\nname = "${name}"\nenabled = false`,
			);
			blocks.push(
				`${MANAGED_SKILLS_BEGIN}\n${entries.join("\n\n")}\n${MANAGED_SKILLS_END}`,
			);
		}
		if (addManagedTrust) {
			const serialized = stringifyToml({
				projects: {
					[opts.trustedProjectPath!]: { trust_level: "trusted" },
				},
			}).trim();
			blocks.push(
				`${MANAGED_TRUST_BEGIN}\n${serialized}\n${MANAGED_TRUST_END}`,
			);
		}
		if (blocks.length === 0) return body ? `${body}\n` : "";
		const managed = blocks.join("\n\n");
		return body ? `${body}\n\n${managed}\n` : `${managed}\n`;
	};

	// Validate the placeholder-rendered candidate BEFORE materializing the
	// real token (the live token never enters the parser).
	const notifyPlaceholder = "/__FLYWHEEL_RUNNER_STOP_NOTIFY_PLACEHOLDER__";
	const candidate = buildRendered(
		hasToken ? TOKEN_PLACEHOLDER : undefined,
		hasNotify ? notifyPlaceholder : undefined,
	);
	const parsedOut = parseTomlSanitized(candidate, "rendered");
	if (hasNotify) {
		if (
			!Array.isArray(parsedOut.notify) ||
			parsedOut.notify.length !== 2 ||
			parsedOut.notify[0] !== notifyPlaceholder ||
			parsedOut.notify[1] !== "--codex"
		) {
			throw new Error(
				"renderCodexHomeConfig: internal invariant violated — managed notify is missing or malformed",
			);
		}
		const baseWithoutNotify = { ...parsedBase };
		const outWithoutNotify = { ...parsedOut };
		delete baseWithoutNotify.notify;
		delete outWithoutNotify.notify;
		// Credential and skill additions are validated separately below; restore
		// their base values before comparing the remaining config semantics.
		if (hasToken) {
			if (parsedBase.shell_environment_policy === undefined)
				delete outWithoutNotify.shell_environment_policy;
			else
				outWithoutNotify.shell_environment_policy =
					parsedBase.shell_environment_policy;
		}
		if (skillDisableNames.length > 0) {
			if (parsedBase.skills === undefined) delete outWithoutNotify.skills;
			else outWithoutNotify.skills = parsedBase.skills;
		}
		if (hasTrust) {
			if (parsedBase.projects === undefined) delete outWithoutNotify.projects;
			else outWithoutNotify.projects = parsedBase.projects;
		}
		if (!isDeepStrictEqual(outWithoutNotify, baseWithoutNotify)) {
			throw new Error(
				"renderCodexHomeConfig: internal invariant violated — notify rewrite altered unrelated config",
			);
		}
	}
	if (hasToken) {
		const outSep = parsedOut.shell_environment_policy;
		const outSet = isPlainTable(outSep) ? outSep.set : undefined;
		if (!isPlainTable(outSet) || outSet.GH_TOKEN !== TOKEN_PLACEHOLDER) {
			throw new Error(
				"renderCodexHomeConfig: internal invariant violated — rendered config does not carry the managed GH_TOKEN entry; refusing to write.",
			);
		}
		const outRest: Record<string, unknown> = { ...outSet };
		delete outRest.GH_TOKEN;
		const baseSep = parsedBase.shell_environment_policy;
		const baseSet =
			isPlainTable(baseSep) && isPlainTable(baseSep.set) ? baseSep.set : {};
		if (!isDeepStrictEqual(outRest, baseSet)) {
			throw new Error(
				"renderCodexHomeConfig: internal invariant violated — merging GH_TOKEN would alter pre-existing shell_environment_policy.set entries; refusing to write.",
			);
		}
	}
	if (skillDisableNames.length > 0) {
		const outSkills = parsedOut.skills;
		const outCfg = isPlainTable(outSkills) ? outSkills.config : undefined;
		if (!Array.isArray(outCfg)) {
			throw new Error(
				"renderCodexHomeConfig: internal invariant violated — rendered config does not carry the managed [[skills.config]] entries; refusing to write.",
			);
		}
		for (const name of skillDisableNames) {
			const matches = outCfg.filter(
				(entry) => isPlainTable(entry) && entry.name === name,
			);
			if (matches.length !== 1 || matches[0].enabled !== false) {
				throw new Error(
					"renderCodexHomeConfig: internal invariant violated — a managed skill-disable entry is missing or duplicated in the rendered config; refusing to write.",
				);
			}
		}
		if (outCfg.length !== baseSkillsCount + skillDisableNames.length) {
			throw new Error(
				"renderCodexHomeConfig: internal invariant violated — rendered skills.config entry count drifted from base plus managed entries; refusing to write.",
			);
		}
	}
	if (hasTrust) {
		const outProjects = parsedOut.projects;
		const outTarget =
			isPlainTable(outProjects) && opts.trustedProjectPath
				? outProjects[opts.trustedProjectPath]
				: undefined;
		if (!isPlainTable(outTarget) || outTarget.trust_level !== "trusted") {
			throw new Error(
				"renderCodexHomeConfig: internal invariant violated — rendered config does not trust the target project",
			);
		}
		const outRest = { ...(outProjects as Record<string, unknown>) };
		delete outRest[opts.trustedProjectPath!];
		const baseProjects = isPlainTable(parsedBase.projects)
			? { ...parsedBase.projects }
			: {};
		delete baseProjects[opts.trustedProjectPath!];
		if (!isDeepStrictEqual(outRest, baseProjects)) {
			throw new Error(
				"renderCodexHomeConfig: internal invariant violated — workspace trust merge altered unrelated projects",
			);
		}
	}
	return buildRendered(ghToken, opts.notifyProgramPath);
}

export interface ProvisionCodexHomeOptions {
	executionId: string;
	/** Host gh token (from `gh auth token`); omitted = no credential injected. */
	ghToken?: string;
	env?: NodeJS.ProcessEnv;
	/** FLY-1188: contract source override (tests). Default: the package-shipped file. */
	contractSourcePath?: string;
	/** FLY-1395: resolved arm; absent keeps the pre-FLY-1395 call shape. */
	skillFrameworkMode?: "superpowers" | "matt" | "bare";
	/** Fully-qualified names disabled through [[skills.config]]. */
	codexSkillDisableNames?: string[];
	/** Verified source containing the six vendored Matt skill directories. */
	codexMattSkillsSourceDir?: string;
	/** Stable deployed hook path installed by setup-flywheel-hooks. */
	notifyProgramPath?: string;
	/** Canonical worktree written into this execution-scoped config.toml. */
	trustedProjectPath?: string;
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
	const namespacedMattSkills = new Map<string, string>();
	if (opts.skillFrameworkMode === "matt") {
		if (!opts.codexMattSkillsSourceDir) {
			throw new Error(
				"provisionCodexHome: matt skills source is required for the matt arm",
			);
		}
		for (const skillDir of MATT_CODEX_SKILL_DIRS) {
			const skillFile = join(
				opts.codexMattSkillsSourceDir,
				skillDir,
				"SKILL.md",
			);
			try {
				accessSync(skillFile, fsConstants.R_OK);
			} catch (err) {
				throw new Error(
					`provisionCodexHome: matt skills source missing ${skillFile}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			namespacedMattSkills.set(
				skillDir,
				namespaceMattSkill(readFileSync(skillFile, "utf-8"), skillDir),
			);
		}
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
	try {
		writeFileSync(
			cfgPath,
			renderCodexHomeConfig(baseToml, opts.ghToken, {
				skillDisableNames: opts.codexSkillDisableNames,
				notifyProgramPath: opts.notifyProgramPath,
				trustedProjectPath: opts.trustedProjectPath,
			}),
			{
				encoding: "utf-8",
				mode: 0o600,
			},
		);
		chmodSync(cfgPath, 0o600); // repair mode if the file pre-existed

		// FLY-1395: these paths are Flywheel-owned inside the per-runner home. Codex
		// discovers direct $CODEX_HOME/skills children and uses each SKILL.md name,
		// so install stable namespaced copies rather than a nested collection (which
		// Codex flattens to collision-prone names such as `tdd`). Clear both the
		// current layout and the early nested-layout artifact on every provision.
		const skillsRoot = join(home, "skills");
		rmSync(join(skillsRoot, "matt-skills"), { recursive: true, force: true });
		for (const skillDir of MATT_CODEX_SKILL_DIRS) {
			rmSync(join(skillsRoot, `matt-skills:${skillDir}`), {
				recursive: true,
				force: true,
			});
		}
		if (opts.skillFrameworkMode === "matt" && opts.codexMattSkillsSourceDir) {
			mkdirSync(skillsRoot, { recursive: true });
			for (const skillDir of MATT_CODEX_SKILL_DIRS) {
				const destination = join(skillsRoot, `matt-skills:${skillDir}`);
				cpSync(join(opts.codexMattSkillsSourceDir, skillDir), destination, {
					recursive: true,
					force: true,
				});
				writeFileSync(
					join(destination, "SKILL.md"),
					namespacedMattSkills.get(skillDir)!,
					"utf-8",
				);
			}
		}

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
	} catch (err) {
		scrubCodexHomeCredential(opts.executionId, env);
		throw err;
	}
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
