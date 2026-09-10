/**
 * FLY-123 (parallelization + credentials): per-runner CODEX_HOME.
 *
 * THE root-cause fix for "Codex runner concurrency = 1": multiple Codex
 * runners need isolated mutable session/config state without duplicating the
 * host credential. Each managed home therefore owns its `config.toml` and
 * runtime files while `auth.json` links to one canonical host-owned truth.
 *
 * The per-runner `config.toml` is ALSO where the GitHub token now lives
 * (WS-C): `[shell_environment_policy.set] GH_TOKEN`. codex reads
 * `$CODEX_HOME/config.toml` as base config, so the token reaches the sandbox
 * shell env WITHOUT riding the codex process argv (ps-visible) or the cycle
 * state file. The 0600 config is the single, minimal plaintext surface.
 *
 * FLY-2358 adds persistent keyed homes for generalized Codex runners. A
 * resolved `(project, workflow-role)` pair shares one home across executions;
 * unresolved and pre-rollout executions retain the legacy execution-scoped
 * layout. Per-execution leases protect credential scrubbing while a keyed
 * home is shared, and keyed homes are never removed by task cleanup.
 *
 * Only config and contract artifacts are copied into a newly created home;
 * everything else Codex needs it creates there (sessions/, logs, caches).
 */

import { randomBytes } from "node:crypto";
import {
	accessSync,
	chmodSync,
	closeSync,
	cpSync,
	type Dirent,
	existsSync,
	constants as fsConstants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	sep as pathSeparator,
	relative,
	resolve as resolvePath,
} from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
	encodeMemoryPathComponent,
	RUNNER_MEMORY_ID_MAX_LENGTH,
	type SkillAssemblyBaseArm,
	withMkdirLock,
} from "flywheel-config";
import { SAFE_IDENTIFIER_RE } from "flywheel-core";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import {
	type CodexAuthIdentity,
	DEFAULT_CODEX_ACCOUNT_REGISTRY_PATH,
	identifyCodexAuth,
	loadCodexAccountRegistry,
} from "./codex-account-identity.js";
import {
	recordCodexAccountObservation,
	resolveCodexAccountLedgerRoot,
} from "./codex-account-ledger.js";
import {
	type CodexMemorySeedSourceSet,
	type PublishCodexMemorySeedInput,
	publishCodexMemorySeed,
	readCodexMemorySeedManifest,
} from "./codex-memory-seed.js";

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

export interface CodexAgentHomeIdentity {
	project: string;
	role: string;
}

/** Stable CODEX_HOME for one project/runner-role identity (FLY-2358). */
export function codexAgentHomeDir(
	identity: CodexAgentHomeIdentity,
	env: NodeJS.ProcessEnv = process.env,
): string {
	for (const [field, value] of [
		["project", identity.project],
		["role", identity.role],
	] as const) {
		if (
			!SAFE_IDENTIFIER_RE.test(value) ||
			value.length > RUNNER_MEMORY_ID_MAX_LENGTH
		) {
			throw new Error(`invalid codex agent home ${field}`);
		}
	}
	return join(
		codexHomesRoot(env),
		"agents",
		encodeMemoryPathComponent(identity.project),
		encodeMemoryPathComponent(identity.role),
	);
}

const CODEX_AGENT_HOME_MARKER = ".flywheel-agent-home.json";
const CODEX_AGENT_HOME_LEASES = ".flywheel-leases";
const CODEX_AGENT_HOME_LOCKS = ".locks";
const CODEX_AGENT_HOME_LOCK_OPTS = {
	timeoutMs: 10_000,
	retryMs: 20,
	staleMs: 60_000,
} as const;

interface CodexAgentHomeMarker extends CodexAgentHomeIdentity {
	version: 1;
	createdAt: string;
	assemblyArm: SkillAssemblyBaseArm;
	materializedArm: SkillAssemblyBaseArm | null;
}

export interface CodexAgentHomeHandle extends CodexAgentHomeIdentity {
	home: string;
	executionId: string;
	token: string;
}

export interface AdmitCodexAgentHomeResult {
	handle: CodexAgentHomeHandle;
	effectiveAssemblyArm: SkillAssemblyBaseArm;
	inherited: boolean;
	liveLeases: number;
	createdLease: boolean;
	memorySeed: "not_requested" | "published" | "reused" | "deferred_busy";
}

function assertSafeExecutionId(executionId: string): void {
	if (
		!SAFE_IDENTIFIER_RE.test(executionId) ||
		executionId.length > RUNNER_MEMORY_ID_MAX_LENGTH
	) {
		throw new Error("invalid codex agent home execution id");
	}
}

function ensurePlainDirectory(path: string, label: string): void {
	try {
		const stat = lstatSync(path);
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			throw new Error(`unsafe codex agent home path: ${label}`);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		try {
			mkdirSync(path, { mode: 0o700 });
		} catch (mkdirError) {
			if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
				throw mkdirError;
			}
		}
		const stat = lstatSync(path);
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			throw new Error(`unsafe codex agent home path: ${label}`);
		}
	}
	chmodSync(path, 0o700);
}

function canonicalPathWithMissingTail(path: string): string {
	let cursor = resolvePath(path);
	const tail: string[] = [];
	for (;;) {
		try {
			lstatSync(cursor);
			return resolvePath(realpathSync(cursor), ...tail.reverse());
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = dirname(cursor);
			if (parent === cursor) throw error;
			tail.push(basename(cursor));
			cursor = parent;
		}
	}
}

function pathIsWithin(parent: string, candidate: string): boolean {
	const delta = relative(parent, candidate);
	return (
		delta === "" ||
		(delta !== ".." &&
			!delta.startsWith(`..${pathSeparator}`) &&
			!isAbsolute(delta))
	);
}

function assertHomeIsPlainDirectory(
	home: string,
	env: NodeJS.ProcessEnv,
): void {
	const canonicalSource = realpathSync(sourceCodexDir(env));
	const canonicalCandidate = canonicalPathWithMissingTail(home);
	if (pathIsWithin(canonicalSource, canonicalCandidate)) {
		throw new Error(
			`unsafe codex home path inside credential source directory: ${home}`,
		);
	}
	mkdirSync(home, { recursive: true, mode: 0o700 });
	const stat = lstatSync(home);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error(`unsafe codex home path: ${home}`);
	}
	if (pathIsWithin(canonicalSource, realpathSync(home))) {
		throw new Error(
			`unsafe codex home path inside credential source directory: ${home}`,
		);
	}
	chmodSync(home, 0o700);
}

function codexAgentHomeLockPath(
	identity: CodexAgentHomeIdentity,
	env: NodeJS.ProcessEnv,
): string {
	const home = codexAgentHomeDir(identity, env);
	const projectDir = dirname(home);
	return join(projectDir, CODEX_AGENT_HOME_LOCKS, basename(home));
}

function prepareCodexAgentHomeLock(
	identity: CodexAgentHomeIdentity,
	env: NodeJS.ProcessEnv,
): string {
	const root = codexHomesRoot(env);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const agentsDir = join(root, "agents");
	ensurePlainDirectory(agentsDir, "agents");
	const projectDir = dirname(codexAgentHomeDir(identity, env));
	ensurePlainDirectory(projectDir, "project");
	const locksDir = join(projectDir, CODEX_AGENT_HOME_LOCKS);
	ensurePlainDirectory(locksDir, "locks");
	const lockPath = codexAgentHomeLockPath(identity, env);
	try {
		const stat = lstatSync(lockPath);
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			throw new Error("unsafe codex agent home path: lock");
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return lockPath;
}

function atomicWriteFile(path: string, content: string, mode = 0o600): void {
	const tmp = join(
		dirname(path),
		`.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
	);
	try {
		writeFileSync(tmp, content, { encoding: "utf8", mode, flag: "wx" });
		chmodSync(tmp, mode);
		renameSync(tmp, path);
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch {
			// The temporary file was never created or was already renamed.
		}
		throw error;
	}
}

function readCodexAgentHomeMarker(home: string): CodexAgentHomeMarker | null {
	const path = join(home, CODEX_AGENT_HOME_MARKER);
	if (!existsSync(path)) return null;
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe");
		const marker = JSON.parse(
			readFileSync(path, "utf8"),
		) as Partial<CodexAgentHomeMarker>;
		if (
			marker.version !== 1 ||
			typeof marker.project !== "string" ||
			typeof marker.role !== "string" ||
			typeof marker.createdAt !== "string" ||
			!(["superpowers", "matt", "bare"] as const).includes(
				marker.assemblyArm as SkillAssemblyBaseArm,
			) ||
			(marker.materializedArm !== null &&
				!(["superpowers", "matt", "bare"] as const).includes(
					marker.materializedArm as SkillAssemblyBaseArm,
				))
		) {
			throw new Error("invalid");
		}
		return marker as CodexAgentHomeMarker;
	} catch {
		throw new Error("invalid codex agent home marker");
	}
}

function writeCodexAgentHomeMarker(
	home: string,
	marker: CodexAgentHomeMarker,
): void {
	atomicWriteFile(
		join(home, CODEX_AGENT_HOME_MARKER),
		`${JSON.stringify(marker, null, 2)}\n`,
	);
}

function listCodexAgentHomeLeases(home: string): string[] {
	const leasesDir = join(home, CODEX_AGENT_HOME_LEASES);
	if (!existsSync(leasesDir)) return [];
	const stat = lstatSync(leasesDir);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error("unsafe codex agent home path: leases");
	}
	const leases: string[] = [];
	for (const entry of readdirSync(leasesDir, { withFileTypes: true })) {
		if (
			!entry.isFile() ||
			entry.isSymbolicLink() ||
			!SAFE_IDENTIFIER_RE.test(entry.name) ||
			entry.name.length > RUNNER_MEMORY_ID_MAX_LENGTH
		) {
			// Atomic lease writes use a temp file in this directory. A hard kill
			// can strand that file, and Finder or an operator may add unrelated
			// entries. None of those names can be a canonical execution lease;
			// ignore them without following or removing them so one foreign entry
			// cannot wedge admission, retirement, or credential scrubbing.
			continue;
		}
		leases.push(entry.name);
	}
	return leases.sort();
}

function validateMarkerIdentity(
	marker: CodexAgentHomeMarker,
	identity: CodexAgentHomeIdentity,
): void {
	if (marker.project !== identity.project || marker.role !== identity.role) {
		throw new Error("codex agent home marker identity mismatch");
	}
}

export async function admitCodexAgentHome(
	input: CodexAgentHomeIdentity & {
		executionId: string;
		requestedAssemblyArm: SkillAssemblyBaseArm;
		loadMemorySeedSources?: () =>
			| CodexMemorySeedSourceSet
			| Promise<CodexMemorySeedSourceSet>;
		memorySeedTesting?: PublishCodexMemorySeedInput["testing"];
	},
	env: NodeJS.ProcessEnv = process.env,
): Promise<AdmitCodexAgentHomeResult> {
	const identity = { project: input.project, role: input.role };
	const home = codexAgentHomeDir(identity, env);
	assertSafeExecutionId(input.executionId);
	const lockPath = prepareCodexAgentHomeLock(identity, env);
	return withMkdirLock(
		lockPath,
		async () => {
			ensurePlainDirectory(home, "home");
			const leasesDir = join(home, CODEX_AGENT_HOME_LEASES);
			ensurePlainDirectory(leasesDir, "leases");
			const leases = listCodexAgentHomeLeases(home);
			let marker = readCodexAgentHomeMarker(home);
			if (marker === null) {
				if (leases.length > 0) {
					throw new Error("missing codex agent home marker with live leases");
				}
				marker = {
					version: 1,
					...identity,
					createdAt: new Date().toISOString(),
					assemblyArm: input.requestedAssemblyArm,
					materializedArm: null,
				};
				writeCodexAgentHomeMarker(home, marker);
			} else {
				validateMarkerIdentity(marker, identity);
			}
			const seedDirectory = join(home, ".flywheel-memory-seed");
			let seedExists = false;
			try {
				lstatSync(seedDirectory);
				seedExists = true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			let memorySeed: AdmitCodexAgentHomeResult["memorySeed"] = "not_requested";
			if (seedExists) {
				readCodexMemorySeedManifest(seedDirectory, identity);
				memorySeed = "reused";
			} else if (input.loadMemorySeedSources !== undefined) {
				if (leases.length > 0) {
					memorySeed = "deferred_busy";
					console.warn(
						`[codex-memory-seed] deferred_busy project=${identity.project} role=${identity.role} liveLeases=${leases.length}`,
					);
				} else {
					const sourceSet = await input.loadMemorySeedSources();
					const published = publishCodexMemorySeed({
						...identity,
						home,
						homesRoot: codexHomesRoot(env),
						...sourceSet,
						testing: input.memorySeedTesting,
					});
					memorySeed = published.reused ? "reused" : "published";
				}
			}

			const leasePath = join(leasesDir, input.executionId);
			const existing = leases.includes(input.executionId);
			if (
				!existing &&
				leases.length === 0 &&
				marker.assemblyArm !== input.requestedAssemblyArm
			) {
				marker = { ...marker, assemblyArm: input.requestedAssemblyArm };
				writeCodexAgentHomeMarker(home, marker);
			}
			let token: string;
			if (existing) {
				const stat = lstatSync(leasePath);
				if (!stat.isFile() || stat.isSymbolicLink()) {
					throw new Error("unsafe codex agent home lease entry");
				}
				token = readFileSync(leasePath, "utf8").trim();
				if (!/^[a-f0-9]{32}$/.test(token)) {
					throw new Error("invalid codex agent home lease token");
				}
			} else {
				token = randomBytes(16).toString("hex");
				atomicWriteFile(leasePath, `${token}\n`);
			}
			return {
				handle: { ...identity, home, executionId: input.executionId, token },
				effectiveAssemblyArm: marker.assemblyArm,
				inherited: marker.assemblyArm !== input.requestedAssemblyArm,
				liveLeases: leases.length + (existing ? 0 : 1),
				createdLease: !existing,
				memorySeed,
			};
		},
		CODEX_AGENT_HOME_LOCK_OPTS,
	);
}

/** The source ~/.codex we seed auth.json + config.toml from (the host's
 * active account state). Configurable for tests / future remote pools. */
export function sourceCodexDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.FLYWHEEL_CODEX_SOURCE_HOME?.trim() || join(homedir(), ".codex");
}

/** Canonical host-owned credential truth shared by managed Codex homes. */
export function codexCredentialTruthPath(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const sourceHome = sourceCodexDir(env);
	if (!isAbsolute(sourceHome)) {
		throw new Error("credential source home must be absolute");
	}
	return join(realpathSync(sourceHome), "auth.json");
}

/** Shared canonical manual-backup seed pool. Configurable so the pool stays a
 * single shared point, never copied wholesale into each execution home. */
export function codexProfilesDir(env: NodeJS.ProcessEnv = process.env): string {
	return (
		env.FLYWHEEL_CODEX_PROFILES_DIR?.trim() ||
		join(sourceCodexDir(env), "profiles")
	);
}

/**
 * Discover canonical profiles that physically exist in the manual seed pool.
 * Unknown/zombie directories are intentionally excluded.
 */
export function discoverAccountPool(
	env: NodeJS.ProcessEnv = process.env,
	registryPath: string = DEFAULT_CODEX_ACCOUNT_REGISTRY_PATH,
): string[] {
	const dir = codexProfilesDir(env);
	if (!existsSync(dir)) return [];
	const canonical = new Set<string>(
		loadCodexAccountRegistry(registryPath).profiles.map(
			(profile) => profile.name,
		),
	);
	return readdirSync(dir, { withFileTypes: true })
		.filter((d) => d.isDirectory() && canonical.has(d.name))
		.map((d) => d.name)
		.sort();
}

export function assertCodexSourceIdentity({
	env = process.env,
	registryPath = DEFAULT_CODEX_ACCOUNT_REGISTRY_PATH,
}: {
	env?: NodeJS.ProcessEnv;
	registryPath?: string;
} = {}): CodexAuthIdentity {
	return readCodexSourceAuth({ env, registryPath }).identity;
}

function readCodexSourceAuth({
	env,
	registryPath = DEFAULT_CODEX_ACCOUNT_REGISTRY_PATH,
}: {
	env: NodeJS.ProcessEnv;
	registryPath?: string;
}): { raw: string; identity: CodexAuthIdentity } {
	const authPath = codexCredentialTruthPath(env);
	let pathStat: ReturnType<typeof lstatSync>;
	try {
		pathStat = lstatSync(authPath);
	} catch (error) {
		throw new Error(
			`Codex source auth is unavailable at ${authPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
		throw new Error(
			`Codex source auth must be a regular file, not a symlink: ${authPath}`,
		);
	}
	let fd: number | undefined;
	try {
		fd = openSync(authPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
		const fileStat = fstatSync(fd);
		if (!fileStat.isFile() || (fileStat.mode & 0o777) !== 0o600) {
			throw new Error(
				`credential truth must be a 0600 regular file: ${authPath}`,
			);
		}
		const raw = readFileSync(fd, "utf8");
		return {
			raw,
			identity: identifyCodexAuth(raw, loadCodexAccountRegistry(registryPath)),
		};
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function placeCredentialLink(
	home: string,
	truthPath: string,
	testing?: {
		beforeSymlink?: () => void;
		beforeRename?: () => void;
	},
): void {
	const destination = join(home, "auth.json");
	const temporary = join(
		home,
		`auth.json.link.${process.pid}.${randomBytes(8).toString("hex")}`,
	);
	try {
		testing?.beforeSymlink?.();
		symlinkSync(truthPath, temporary);
		testing?.beforeRename?.();
		renameSync(temporary, destination);
		const installed = lstatSync(destination);
		if (
			!installed.isSymbolicLink() ||
			readlinkSync(destination) !== truthPath
		) {
			throw new Error(`credential link verification failed: ${home}`);
		}
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {
			// The temporary link was never created or was already renamed.
		}
		throw error;
	}
}

export type CodexCredentialMigrationState =
	| "already"
	| "linked"
	| "unlinked"
	| "uncertain";

export interface MigrateCodexHomeCredentialOptions {
	home: string;
	env?: NodeJS.ProcessEnv;
	registryPath?: string;
	keepBackup?: boolean;
	unlink?: boolean;
	/** Narrow deterministic fault seam for durability tests. */
	testing?: {
		fsyncDirectory?: (path: string) => void;
		beforeSymlink?: () => void;
		beforeRename?: () => void;
	};
}

export interface CodexCredentialMigrationResult {
	home: string;
	state: CodexCredentialMigrationState;
	profile: string;
	backupPath?: string;
}

function fsyncDirectory(path: string): void {
	const fd = openSync(path, fsConstants.O_RDONLY);
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function durableCredentialBackup(
	home: string,
	destination: string,
	env: NodeJS.ProcessEnv,
	syncDirectory: (path: string) => void,
): string {
	const stat = lstatSync(destination);
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		(stat.mode & 0o777) !== 0o600
	) {
		throw new Error("credential backup source must be a 0600 regular file");
	}
	const sourceFd = openSync(
		destination,
		fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
	);
	let raw: Buffer;
	try {
		const opened = fstatSync(sourceFd);
		if (!opened.isFile() || (opened.mode & 0o777) !== 0o600) {
			throw new Error("credential backup source changed during validation");
		}
		raw = readFileSync(sourceFd);
	} finally {
		closeSync(sourceFd);
	}

	const backupDirectory = join(
		env.HOME?.trim() || homedir(),
		".flywheel",
		"codex-credential-backups",
	);
	mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
	chmodSync(backupDirectory, 0o700);
	const slug = basename(home).replace(/[^A-Za-z0-9._-]/g, "_") || "home";
	const backupPath = join(
		backupDirectory,
		`${slug}.${new Date().toISOString().replace(/[:.]/g, "-")}.${randomBytes(4).toString("hex")}.json`,
	);
	let backupFd: number | undefined;
	try {
		backupFd = openSync(
			backupPath,
			fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
			0o600,
		);
		writeFileSync(backupFd, raw);
		fsyncSync(backupFd);
		closeSync(backupFd);
		backupFd = undefined;
		syncDirectory(backupDirectory);
		return backupPath;
	} catch (error) {
		if (backupFd !== undefined) closeSync(backupFd);
		try {
			unlinkSync(backupPath);
		} catch {
			// The exclusive backup was never created or was already cleaned up.
		}
		throw error;
	}
}

/**
 * Replace one already-drained, non-keyed home's credential with the canonical
 * link. Process and launchd fencing belongs to the caller; keyed homes must use
 * migrateCodexAgentHomeCredential so lease validation occurs under admission's
 * lock.
 */
function migrateCodexHomeCredentialAt(
	opts: MigrateCodexHomeCredentialOptions,
	allowKeyed: boolean,
): CodexCredentialMigrationResult {
	const env = opts.env ?? process.env;
	if (!isAbsolute(opts.home)) {
		throw new Error("credential migration home must be absolute");
	}
	assertHomeIsPlainDirectory(opts.home, env);
	if (!allowKeyed && readCodexAgentHomeMarker(opts.home) !== null) {
		throw new Error("keyed codex home requires keyed credential migration");
	}
	const source = readCodexSourceAuth({
		env,
		registryPath: opts.registryPath,
	});
	const truthPath = codexCredentialTruthPath(env);
	const destination = join(opts.home, "auth.json");
	let destinationStat: ReturnType<typeof lstatSync> | null = null;
	try {
		destinationStat = lstatSync(destination);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	if (opts.unlink) {
		if (destinationStat?.isFile() && !destinationStat.isSymbolicLink()) {
			return {
				home: opts.home,
				state: "unlinked",
				profile: source.identity.profile,
			};
		}
		if (
			!destinationStat?.isSymbolicLink() ||
			readlinkSync(destination) !== truthPath
		) {
			throw new Error("credential rollback requires the canonical link");
		}
		atomicWriteFile(destination, source.raw, 0o600);
		atomicWriteFile(
			join(opts.home, ".credential-copy-pending"),
			`${new Date().toISOString()}\n`,
		);
		return {
			home: opts.home,
			state: "unlinked",
			profile: source.identity.profile,
		};
	}

	if (
		destinationStat?.isSymbolicLink() &&
		readlinkSync(destination) === truthPath
	) {
		return {
			home: opts.home,
			state: "already",
			profile: source.identity.profile,
		};
	}
	if (
		destinationStat &&
		!destinationStat.isFile() &&
		!destinationStat.isSymbolicLink()
	) {
		throw new Error("unsafe credential migration entry");
	}
	const backupPath =
		opts.keepBackup && destinationStat?.isFile()
			? durableCredentialBackup(
					opts.home,
					destination,
					env,
					opts.testing?.fsyncDirectory ?? fsyncDirectory,
				)
			: undefined;
	placeCredentialLink(opts.home, truthPath, opts.testing);
	try {
		unlinkSync(join(opts.home, ".credential-copy-pending"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	let state: CodexCredentialMigrationState = "linked";
	try {
		(opts.testing?.fsyncDirectory ?? fsyncDirectory)(opts.home);
	} catch {
		state = "uncertain";
	}
	return {
		home: opts.home,
		state,
		profile: source.identity.profile,
		...(backupPath ? { backupPath } : {}),
	};
}

export function migrateCodexHomeCredential(
	opts: MigrateCodexHomeCredentialOptions,
): CodexCredentialMigrationResult {
	return migrateCodexHomeCredentialAt(opts, false);
}

/** Migrate a drained persistent agent home under its admission lock. */
export async function migrateCodexAgentHomeCredential(
	opts: MigrateCodexHomeCredentialOptions,
): Promise<CodexCredentialMigrationResult> {
	const env = opts.env ?? process.env;
	if (!isAbsolute(opts.home)) {
		throw new Error("credential migration home must be absolute");
	}
	assertHomeIsPlainDirectory(opts.home, env);
	const marker = readCodexAgentHomeMarker(opts.home);
	if (marker === null) throw new Error("missing codex agent home marker");
	const identity = { project: marker.project, role: marker.role };
	if (codexAgentHomeDir(identity, env) !== opts.home) {
		throw new Error("codex agent home marker path mismatch");
	}
	const lockPath = prepareCodexAgentHomeLock(identity, env);
	return withMkdirLock(
		lockPath,
		async () => {
			const currentMarker = readCodexAgentHomeMarker(opts.home);
			if (currentMarker === null) {
				throw new Error("missing codex agent home marker");
			}
			validateMarkerIdentity(currentMarker, identity);
			if (listCodexAgentHomeLeases(opts.home).length > 0) {
				throw new Error("codex agent home has live leases");
			}
			return migrateCodexHomeCredentialAt(opts, true);
		},
		CODEX_AGENT_HOME_LOCK_OPTS,
	);
}

/**
 * Absolute path to the repo-owned, CODEX_HOME-aware daemon launcher. It is a
 * same-account direct passthrough; automatic profile switching is retired.
 * This is what runners use via FLYWHEEL_CODEX_BIN. An explicit
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
 * QA · FLY-1188 — explicitly resolve the RAW codex binary for the TUI. The
 * historical launcher once captured stdout and broke `codex resume --remote`;
 * keeping this boundary explicit prevents a future daemon-launcher change from
 * regressing the founder window. `FLYWHEEL_CODEX_TUI_BIN` overrides (ops /
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
 * resolution shape as the daemon launcher above. Materialized into every
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

function readManagedTrustedProjectPaths(toml: string): string[] {
	const begin = toml.indexOf(MANAGED_TRUST_BEGIN);
	const end = toml.indexOf(MANAGED_TRUST_END);
	if (begin === -1 && end === -1) return [];
	if (
		begin === -1 ||
		end < begin ||
		begin !== toml.lastIndexOf(MANAGED_TRUST_BEGIN) ||
		end !== toml.lastIndexOf(MANAGED_TRUST_END)
	) {
		throw new Error("invalid managed workspace trust block");
	}
	const managed = toml.slice(begin + MANAGED_TRUST_BEGIN.length, end).trim();
	const parsed = parseTomlSanitized(managed, "base");
	if (!isPlainTable(parsed.projects)) {
		throw new Error("invalid managed workspace trust block");
	}
	const paths: string[] = [];
	for (const [path, value] of Object.entries(parsed.projects)) {
		if (
			!isAbsolute(path) ||
			path.includes("\0") ||
			!isPlainTable(value) ||
			value.trust_level !== "trusted"
		) {
			throw new Error("invalid managed workspace trust block");
		}
		paths.push(path);
	}
	return paths.sort();
}

export interface RenderCodexHomeConfigOptions {
	skillDisableNames?: string[];
	/** Absolute deployed hook path used by Codex's root-scope notify setting. */
	notifyProgramPath?: string;
	/** Canonical worktree Codex must trust before its TUI starts. */
	trustedProjectPath?: string;
	/** Canonical worktrees sharing one persistent agent home. */
	trustedProjectPaths?: string[];
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

/** FLY-2168: managed requirements reject the historical global
 * `danger-full-access` runner seed. Pin the execution-scoped home to the
 * unattended policy that requirements permit; thread/start pins the same
 * values again at the protocol boundary. This is deliberately provisioning-
 * only: renderCodexHomeConfig remains a general merge helper whose callers
 * may need byte-preserving behavior. */
function pinRunnerPolicy(baseToml: string): string {
	let body = baseToml.trimEnd();
	const parsed = parseTomlSanitized(body, "base");
	const pins = [
		["sandbox_mode", "workspace-write"],
		["approval_policy", "never"],
	] as const;

	for (const [key, value] of pins) {
		const assignment = new RegExp(`^[ \\t]*${key}[ \\t]*=.*$`, "gm");
		const firstTableIndex = TABLE_HEADER_RE.exec(body)?.index ?? body.length;
		const roots = [...body.matchAll(assignment)].filter(
			(match) => (match.index ?? body.length) < firstTableIndex,
		);
		if (parsed[key] !== undefined && roots.length !== 1) {
			throw new Error(
				`provisionCodexHome: root ${key} has an unsupported assignment shape; refusing to provision an ambiguous runner policy`,
			);
		}
		const line = `${key} = "${value}"`;
		const root = roots[0];
		if (root) {
			const start = root.index ?? 0;
			body = `${body.slice(0, start)}${line}${body.slice(start + root[0].length)}`;
		} else {
			body = body ? `${line}\n${body}` : line;
		}
	}

	return body ? `${body}\n` : "";
}

/** FLY-2296: unattended runners must never stop on Codex's interactive
 * rate-limit model-switch prompt. */
export function pinRunnerNotice(baseToml: string): string {
	const body = baseToml.trimEnd();
	const parsed = parseTomlSanitized(body, "base");
	const firstTableIndex = TABLE_HEADER_RE.exec(body)?.index ?? body.length;
	const rootSegment = body.slice(0, firstTableIndex);
	if (/^[ \t]*notice[ \t]*(?:=|\.)/m.test(rootSegment)) {
		throw new Error(
			"provisionCodexHome: notice is defined as a dotted/inline table in the seed config (~/.codex/config.toml) — rewrite it as a literal [notice] table header before dispatching Codex runners",
		);
	}
	if (parsed.notice !== undefined && !isPlainTable(parsed.notice)) {
		throw new Error(
			"provisionCodexHome: notice is not a table; refusing to pin",
		);
	}
	const noticeHeaders = [
		...body.matchAll(/^[ \t]*\[notice\][ \t]*(?:#.*)?$/gm),
	];
	if (noticeHeaders.length > 1) {
		throw new Error(
			"provisionCodexHome: notice has multiple literal table headers; refusing to pin",
		);
	}

	let candidate: string;
	const noticeHeader = noticeHeaders[0];
	if (noticeHeader !== undefined) {
		const headerEnd = (noticeHeader.index ?? 0) + noticeHeader[0].length;
		const tail = body.slice(headerEnd);
		const nextHeader = /\n[ \t]*\[{1,2}[^\n]+/m.exec(tail);
		const tableEnd =
			nextHeader === null ? body.length : headerEnd + (nextHeader.index ?? 0);
		const assignments = [
			...body
				.slice(headerEnd, tableEnd)
				.matchAll(/^[ \t]*hide_rate_limit_model_nudge[ \t]*=.*$/gm),
		];
		if (assignments.length > 1) {
			throw new Error(
				"provisionCodexHome: notice has multiple rate-limit model nudge assignments; refusing to pin",
			);
		}
		const assignment = assignments[0];
		if (assignment !== undefined) {
			const start = headerEnd + (assignment.index ?? 0);
			candidate = `${body.slice(0, start)}hide_rate_limit_model_nudge = true${body.slice(start + assignment[0].length)}\n`;
		} else {
			candidate = `${body.slice(0, headerEnd)}\nhide_rate_limit_model_nudge = true${body.slice(headerEnd)}\n`;
		}
	} else {
		candidate = `${body}${body ? "\n\n" : ""}[notice]\nhide_rate_limit_model_nudge = true\n`;
	}

	const rendered = parseTomlSanitized(candidate, "rendered");
	if (
		!isPlainTable(rendered.notice) ||
		rendered.notice.hide_rate_limit_model_nudge !== true
	) {
		throw new Error(
			"provisionCodexHome: notice pin did not take effect; refusing to provision",
		);
	}
	return candidate;
}

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
 * - base config preserved verbatim by this general merge helper.
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
	const trustedProjectPaths = [
		...(opts.trustedProjectPaths ?? []),
		...(opts.trustedProjectPath ? [opts.trustedProjectPath] : []),
	]
		.filter((path, index, paths) => paths.indexOf(path) === index)
		.sort();
	const hasTrust = trustedProjectPaths.length > 0;
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
	if (hasTrust) {
		for (const trustedProjectPath of trustedProjectPaths) {
			if (
				!trustedProjectPath ||
				!isAbsolute(trustedProjectPath) ||
				trustedProjectPath.includes("\0")
			) {
				throw new Error(
					"renderCodexHomeConfig: trustedProjectPath must be a non-empty absolute and NUL-free path",
				);
			}
		}
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
	const managedTrustPaths: string[] = [];
	if (hasTrust) {
		const projects = parsedBase.projects;
		if (projects !== undefined && !isPlainTable(projects)) {
			throw new Error(
				"renderCodexHomeConfig: base config.toml projects must be a table",
			);
		}
		for (const trustedProjectPath of trustedProjectPaths) {
			const target =
				projects === undefined ? undefined : projects[trustedProjectPath];
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
			if (target === undefined) managedTrustPaths.push(trustedProjectPath);
		}
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
		if (managedTrustPaths.length > 0) {
			const serialized = stringifyToml({
				projects: Object.fromEntries(
					managedTrustPaths.map((path) => [path, { trust_level: "trusted" }]),
				),
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
		for (const trustedProjectPath of trustedProjectPaths) {
			const outTarget = isPlainTable(outProjects)
				? outProjects[trustedProjectPath]
				: undefined;
			if (!isPlainTable(outTarget) || outTarget.trust_level !== "trusted") {
				throw new Error(
					"renderCodexHomeConfig: internal invariant violated — rendered config does not trust the target project",
				);
			}
		}
		const outRest = { ...(outProjects as Record<string, unknown>) };
		const baseProjects = isPlainTable(parsedBase.projects)
			? { ...parsedBase.projects }
			: {};
		for (const trustedProjectPath of trustedProjectPaths) {
			delete outRest[trustedProjectPath];
			delete baseProjects[trustedProjectPath];
		}
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
	/** Internal fault-injection seam for the atomic credential-link install. */
	testing?: {
		beforeSymlink?: () => void;
		beforeRename?: () => void;
	};
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
	/** Internal multi-worktree form used by persistent shared homes. */
	trustedProjectPaths?: string[];
	/** Canonical Codex account registry override (tests / vendored deployment). */
	registryPath?: string;
	/** Account-ledger root override (tests / slot isolation). */
	ledgerRoot?: string;
}

/**
 * Provision a per-runner CODEX_HOME: canonical `auth.json` link plus isolated
 * `config.toml` (seeded global config + GH_TOKEN). Existing regular-file auth
 * copies stay regular until the fenced migration path drains that home.
 */
export function provisionCodexHome(opts: ProvisionCodexHomeOptions): string {
	const env = opts.env ?? process.env;
	return provisionCodexHomeAt(opts, codexHomeDir(opts.executionId, env), {
		scrubOnFailure: () => scrubCodexHomeCredential(opts.executionId, env),
		materializeSkills: true,
		atomicManagedWrites: false,
	});
}

function provisionCodexHomeAt(
	opts: ProvisionCodexHomeOptions,
	home: string,
	behavior: {
		scrubOnFailure: () => void;
		materializeSkills: boolean;
		atomicManagedWrites: boolean;
	},
): string {
	const env = opts.env ?? process.env;
	if (opts.ghToken != null && !TOKEN_RE.test(opts.ghToken)) {
		throw new Error(
			"provisionCodexHome: ghToken must match ^[A-Za-z0-9_-]{1,255}$",
		);
	}
	// FLY-2003: live JWT identity is the authority. Validate it before creating
	// or changing an execution home; direct callers get the same fail-closed
	// boundary as the adapter preflight.
	const sourceAuth = readCodexSourceAuth({
		env,
		registryPath: opts.registryPath,
	});
	const sourceIdentity = sourceAuth.identity;
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
	const src = sourceCodexDir(env);
	const srcConfig = join(src, "config.toml");
	const baseToml = existsSync(srcConfig)
		? readFileSync(srcConfig, "utf-8")
		: "";
	let runnerBaseToml: string;
	try {
		runnerBaseToml = pinRunnerNotice(pinRunnerPolicy(baseToml));
	} catch (error) {
		// A reprovision may be replacing a live home whose config still carries
		// a managed GH_TOKEN. Pin rejection happens before this invocation owns
		// the normal try/finally path, so retire that credential explicitly.
		behavior.scrubOnFailure();
		throw error;
	}
	// R1 MED #2: mkdir(recursive) does NOT repair a pre-existing dir mode
	// (re-provision / crash-recovered home), so force 0700 after refusing a
	// final-path symlink.
	assertHomeIsPlainDirectory(home, env);

	// Seed the exact auth bytes validated from one O_NOFOLLOW file descriptor.
	// This closes the validate→copy path race while keeping per-runner isolation.
	const writeManagedFile = (
		path: string,
		content: string,
		mode = 0o600,
	): void => {
		if (behavior.atomicManagedWrites) {
			atomicWriteFile(path, content, mode);
			return;
		}
		writeFileSync(path, content, { encoding: "utf8", mode });
		chmodSync(path, mode);
	};
	const destAuth = join(home, "auth.json");
	let destinationStat: ReturnType<typeof lstatSync> | null;
	try {
		destinationStat = lstatSync(destAuth);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		destinationStat = null;
	}
	if (destinationStat) {
		if (destinationStat.isSymbolicLink()) {
			const target = readlinkSync(destAuth);
			if (target !== codexCredentialTruthPath(env)) {
				console.error(
					`[codex-home] credential_link_drift home=${home} target=${target}`,
				);
				behavior.scrubOnFailure();
				throw new Error(`credential_link_drift home=${home}`);
			}
		} else {
			if (!destinationStat.isFile()) {
				behavior.scrubOnFailure();
				throw new Error(`unsafe credential entry home=${home}`);
			}
			writeManagedFile(destAuth, sourceAuth.raw);
			writeManagedFile(
				join(home, ".credential-copy-pending"),
				`${new Date().toISOString()}\n`,
			);
			console.warn(
				`[codex-home] credential_copy_pending_migration home=${home}`,
			);
		}
	} else {
		try {
			placeCredentialLink(home, codexCredentialTruthPath(env), opts.testing);
		} catch (error) {
			behavior.scrubOnFailure();
			throw error;
		}
	}
	writeManagedFile(join(home, ".active"), `${sourceIdentity.profile}\n`);

	// config.toml = seeded global + GH_TOKEN block (0600). chmod AFTER write —
	// writeFileSync mode only applies on CREATE, not to a pre-existing wider
	// file (R1 MED #2).
	const cfgPath = join(home, "config.toml");
	try {
		writeManagedFile(
			cfgPath,
			renderCodexHomeConfig(runnerBaseToml, opts.ghToken, {
				skillDisableNames: opts.codexSkillDisableNames,
				notifyProgramPath: opts.notifyProgramPath,
				trustedProjectPath: opts.trustedProjectPath,
				trustedProjectPaths: opts.trustedProjectPaths,
			}),
		);

		// FLY-1395: these paths are Flywheel-owned inside the per-runner home. Codex
		// discovers direct $CODEX_HOME/skills children and uses each SKILL.md name,
		// so install stable namespaced copies rather than a nested collection (which
		// Codex flattens to collision-prone names such as `tdd`). Clear both the
		// current layout and the early nested-layout artifact on every provision.
		if (behavior.materializeSkills) {
			const skillsRoot = join(home, "skills");
			rmSync(join(skillsRoot, "matt-skills"), {
				recursive: true,
				force: true,
			});
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
					writeManagedFile(
						join(destination, "SKILL.md"),
						namespacedMattSkills.get(skillDir)!,
					);
				}
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
		writeManagedFile(
			agentsPath,
			`<!-- flywheel-managed (FLY-1188): materialized from ${contractSrc} at provisioning; do not edit — changes belong in the source file -->\n${contract}`,
		);
		try {
			recordCodexAccountObservation({
				identity: sourceIdentity,
				home,
				source: "provision",
				ledgerRoot: opts.ledgerRoot ?? resolveCodexAccountLedgerRoot(env),
				registryPath: opts.registryPath ?? DEFAULT_CODEX_ACCOUNT_REGISTRY_PATH,
			});
		} catch (error) {
			console.warn(
				`[codex-home] account ledger observation failed for ${sourceIdentity.profile}; runner provisioning will continue: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (sourceIdentity.mode === "manual_backup") {
			console.log(
				`[codex-home] manual_backup_active profile=${sourceIdentity.profile}`,
			);
		}
		return home;
	} catch (err) {
		behavior.scrubOnFailure();
		throw err;
	}
}

export type ProvisionCodexAgentHomeOptions = Omit<
	ProvisionCodexHomeOptions,
	"executionId" | "skillFrameworkMode"
> & {
	skillFrameworkMode: SkillAssemblyBaseArm;
};

function validateCodexAgentHomeHandle(
	handle: CodexAgentHomeHandle,
	env: NodeJS.ProcessEnv,
): void {
	assertSafeExecutionId(handle.executionId);
	if (
		handle.home !==
		codexAgentHomeDir({ project: handle.project, role: handle.role }, env)
	) {
		throw new Error("codex agent home handle path mismatch");
	}
}

function assertCodexAgentHomeLease(handle: CodexAgentHomeHandle): void {
	const leasePath = join(
		handle.home,
		CODEX_AGENT_HOME_LEASES,
		handle.executionId,
	);
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(leasePath);
	} catch {
		throw new Error("codex agent home lease missing");
	}
	if (!stat.isFile() || stat.isSymbolicLink()) {
		throw new Error("unsafe codex agent home lease entry");
	}
	if (readFileSync(leasePath, "utf8").trim() !== handle.token) {
		throw new Error("codex agent home lease token mismatch");
	}
}

/** Provision a previously-admitted shared home while holding its short lock. */
export async function provisionCodexAgentHome(
	handle: CodexAgentHomeHandle,
	opts: ProvisionCodexAgentHomeOptions,
): Promise<string> {
	const env = opts.env ?? process.env;
	validateCodexAgentHomeHandle(handle, env);
	const identity = { project: handle.project, role: handle.role };
	const lockPath = prepareCodexAgentHomeLock(identity, env);
	return withMkdirLock(
		lockPath,
		async () => {
			ensurePlainDirectory(handle.home, "home");
			const marker = readCodexAgentHomeMarker(handle.home);
			if (marker === null) throw new Error("missing codex agent home marker");
			validateMarkerIdentity(marker, identity);
			assertCodexAgentHomeLease(handle);
			if (marker.assemblyArm !== opts.skillFrameworkMode) {
				throw new Error("codex agent home assembly arm mismatch");
			}
			const configPath = join(handle.home, "config.toml");
			const requestedTrustPaths = [
				...(opts.trustedProjectPaths ?? []),
				...(opts.trustedProjectPath ? [opts.trustedProjectPath] : []),
			];
			const retainedTrustPaths = existsSync(configPath)
				? readManagedTrustedProjectPaths(
						readFileSync(configPath, "utf8"),
					).filter((path) => existsSync(path))
				: [];
			const trustedProjectPaths = [
				...new Set([...retainedTrustPaths, ...requestedTrustPaths]),
			].sort();
			const materializeSkills = marker.materializedArm !== marker.assemblyArm;
			const home = provisionCodexHomeAt(
				{
					...opts,
					executionId: handle.executionId,
					trustedProjectPath: undefined,
					trustedProjectPaths,
				},
				handle.home,
				{
					scrubOnFailure: () => undefined,
					materializeSkills,
					atomicManagedWrites: true,
				},
			);
			if (materializeSkills) {
				writeCodexAgentHomeMarker(handle.home, {
					...marker,
					materializedArm: marker.assemblyArm,
				});
			}
			return home;
		},
		CODEX_AGENT_HOME_LOCK_OPTS,
	);
}

/** Release exactly one admitted execution lease; scrub only after the last. */
export async function releaseCodexAgentHomeLease(
	handle: CodexAgentHomeHandle,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	validateCodexAgentHomeHandle(handle, env);
	const identity = { project: handle.project, role: handle.role };
	const lockPath = prepareCodexAgentHomeLock(identity, env);
	await withMkdirLock(
		lockPath,
		async () => {
			const marker = readCodexAgentHomeMarker(handle.home);
			if (marker === null) throw new Error("missing codex agent home marker");
			validateMarkerIdentity(marker, identity);
			assertCodexAgentHomeLease(handle);
			unlinkSync(
				join(handle.home, CODEX_AGENT_HOME_LEASES, handle.executionId),
			);
			const remaining = listCodexAgentHomeLeases(handle.home).length;
			if (remaining === 0) {
				scrubCodexHomeCredentialAt(handle.home, true);
			} else {
				console.warn(
					`[codex-home] keyed_home_scrub_deferred exec=${handle.executionId} live_leases=${remaining}`,
				);
			}
		},
		CODEX_AGENT_HOME_LOCK_OPTS,
	);
}

export interface CodexAgentHomeSessionSnapshot extends CodexAgentHomeIdentity {
	status: string;
}

const CODEX_AGENT_HOME_REOWN_STATUSES = new Set([
	"running",
	"ship_parked",
	"awaiting_review",
	"design_done",
	"approved_to_ship",
]);

/**
 * Remove stale execution leases from persistent agent homes at Bridge startup.
 *
 * A live/reownable session is retained only when its durable identity matches
 * the marker for the home containing the lease. Identity ambiguity fails
 * closed: the lease is preserved and a visible warning is emitted. One bad
 * home never prevents the remaining homes from being inspected.
 */
export async function scrubOrphanedCodexAgentHomes(
	sessions: ReadonlyMap<string, CodexAgentHomeSessionSnapshot>,
	env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
	const agentsDir = join(codexHomesRoot(env), "agents");
	if (!existsSync(agentsDir)) return 0;
	let removed = 0;
	let projects: Dirent[];
	try {
		const agentsStat = lstatSync(agentsDir);
		if (!agentsStat.isDirectory() || agentsStat.isSymbolicLink()) {
			throw new Error("unsafe agents directory");
		}
		projects = readdirSync(agentsDir, { withFileTypes: true });
	} catch (error) {
		console.warn(
			`[codex-home] keyed_home_janitor_failed scope=agents error=${error instanceof Error ? error.message : String(error)}`,
		);
		return 0;
	}

	for (const projectEntry of projects) {
		if (!projectEntry.isDirectory() || projectEntry.isSymbolicLink()) {
			console.warn(
				`[codex-home] keyed_home_janitor_failed scope=project entry=${projectEntry.name}`,
			);
			continue;
		}
		const projectDir = join(agentsDir, projectEntry.name);
		let roleEntries: Dirent[];
		try {
			roleEntries = readdirSync(projectDir, { withFileTypes: true });
		} catch (error) {
			console.warn(
				`[codex-home] keyed_home_janitor_failed scope=project entry=${projectEntry.name} error=${error instanceof Error ? error.message : String(error)}`,
			);
			continue;
		}
		for (const roleEntry of roleEntries) {
			if (roleEntry.name === CODEX_AGENT_HOME_LOCKS) continue;
			const home = join(projectDir, roleEntry.name);
			try {
				if (!roleEntry.isDirectory() || roleEntry.isSymbolicLink()) {
					throw new Error("unsafe agent home entry");
				}
				const marker = readCodexAgentHomeMarker(home);
				if (marker === null) throw new Error("missing agent home marker");
				if (codexAgentHomeDir(marker, env) !== home) {
					throw new Error("agent home marker path mismatch");
				}
				const lockPath = prepareCodexAgentHomeLock(marker, env);
				await withMkdirLock(
					lockPath,
					async () => {
						const lockedMarker = readCodexAgentHomeMarker(home);
						if (lockedMarker === null) {
							throw new Error("missing agent home marker");
						}
						validateMarkerIdentity(lockedMarker, marker);
						for (const executionId of listCodexAgentHomeLeases(home)) {
							const session = sessions.get(executionId);
							if (
								session &&
								(session.project !== marker.project ||
									session.role !== marker.role)
							) {
								console.warn(
									`[codex-home] keyed_home_janitor_identity_mismatch exec=${executionId}`,
								);
								continue;
							}
							if (
								session &&
								CODEX_AGENT_HOME_REOWN_STATUSES.has(session.status)
							) {
								continue;
							}
							unlinkSync(join(home, CODEX_AGENT_HOME_LEASES, executionId));
							removed += 1;
						}
						if (listCodexAgentHomeLeases(home).length === 0) {
							scrubCodexHomeCredentialAt(home, true);
						}
					},
					CODEX_AGENT_HOME_LOCK_OPTS,
				);
			} catch (error) {
				console.warn(
					`[codex-home] keyed_home_janitor_failed scope=home entry=${roleEntry.name} error=${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}
	return removed;
}

export type ExecutionCodexHomeResolution =
	| ({ kind: "keyed" | "prepublished" } & CodexAgentHomeIdentity & {
				home: string;
			})
	| { kind: "legacy"; home: string }
	| { kind: "unknown"; reason: string };

function codexSessionStatePath(
	executionId: string,
	env: NodeJS.ProcessEnv,
): string {
	const root =
		env.FLYWHEEL_CODEX_SESSION_DIR?.trim() ||
		join(homedir(), ".flywheel", "state", "codex-sessions");
	return join(root, executionId, "session.json");
}

function exactLeaseExists(
	home: string,
	executionId: string,
): boolean | "unknown" {
	const leasePath = join(home, CODEX_AGENT_HOME_LEASES, executionId);
	try {
		const stat = lstatSync(leasePath);
		if (!stat.isFile() || stat.isSymbolicLink()) return "unknown";
		return /^[a-f0-9]{32}$/.test(readFileSync(leasePath, "utf8").trim())
			? true
			: "unknown";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? false
			: "unknown";
	}
}

/** Resolve an execution to a keyed or legacy home without following symlinks. */
export function resolveExecutionCodexHome(
	executionId: string,
	expected?: CodexAgentHomeIdentity,
	env: NodeJS.ProcessEnv = process.env,
): ExecutionCodexHomeResolution {
	try {
		assertSafeExecutionId(executionId);
	} catch {
		return { kind: "unknown", reason: "invalid_execution_id" };
	}
	const statePath = codexSessionStatePath(executionId, env);
	let record: unknown;
	if (existsSync(statePath)) {
		try {
			const stateStat = lstatSync(statePath);
			if (!stateStat.isFile() || stateStat.isSymbolicLink()) {
				return { kind: "unknown", reason: "unsafe_session_state" };
			}
			const state = JSON.parse(readFileSync(statePath, "utf8")) as unknown;
			if (typeof state !== "object" || state === null || Array.isArray(state)) {
				return { kind: "unknown", reason: "invalid_session_state" };
			}
			record = (state as Record<string, unknown>).codexAgentHome;
		} catch {
			return { kind: "unknown", reason: "invalid_session_state" };
		}
	}
	if (record === undefined) {
		if (expected) {
			let home: string;
			try {
				home = codexAgentHomeDir(expected, env);
			} catch {
				// Dispatch deliberately falls back to an execution-scoped home when
				// project/role cannot form a keyed path. With no published keyed
				// record, recovery must preserve that same legacy classification.
				return { kind: "legacy", home: codexHomeDir(executionId, env) };
			}
			const lease = exactLeaseExists(home, executionId);
			if (lease === "unknown") {
				return { kind: "unknown", reason: "unsafe_prepublished_lease" };
			}
			if (lease) return { kind: "prepublished", ...expected, home };
		}
		return { kind: "legacy", home: codexHomeDir(executionId, env) };
	}
	if (typeof record !== "object" || record === null || Array.isArray(record)) {
		return { kind: "unknown", reason: "invalid_agent_home_record" };
	}
	const value = record as Record<string, unknown>;
	if (
		typeof value.home !== "string" ||
		typeof value.project !== "string" ||
		typeof value.role !== "string"
	) {
		return { kind: "unknown", reason: "invalid_agent_home_record" };
	}
	const identity = { project: value.project, role: value.role };
	if (
		expected &&
		(expected.project !== identity.project || expected.role !== identity.role)
	) {
		return { kind: "unknown", reason: "expected_identity_mismatch" };
	}
	let exactHome: string;
	try {
		exactHome = codexAgentHomeDir(identity, env);
	} catch {
		return { kind: "unknown", reason: "invalid_agent_home_identity" };
	}
	if (value.home !== exactHome) {
		return { kind: "unknown", reason: "agent_home_path_mismatch" };
	}
	try {
		const homeStat = lstatSync(exactHome);
		if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) {
			return { kind: "unknown", reason: "unsafe_agent_home" };
		}
		const marker = readCodexAgentHomeMarker(exactHome);
		if (marker === null) {
			return { kind: "unknown", reason: "missing_agent_home_marker" };
		}
		validateMarkerIdentity(marker, identity);
	} catch {
		return { kind: "unknown", reason: "invalid_agent_home_marker" };
	}
	return { kind: "keyed", ...identity, home: exactHome };
}

/** Retire one execution from its resolved home; persistent keyed homes remain. */
export async function retireCodexExecutionHome(
	executionId: string,
	expected: CodexAgentHomeIdentity,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const resolution = resolveExecutionCodexHome(executionId, expected, env);
	if (resolution.kind === "legacy") {
		scrubCodexHomeCredential(executionId, env);
		return;
	}
	if (resolution.kind !== "keyed") {
		console.warn(
			`[codex-home] keyed_home_scrub_unresolved exec=${executionId} reason=${resolution.kind === "unknown" ? resolution.reason : resolution.kind}`,
		);
		return;
	}
	const lockPath = prepareCodexAgentHomeLock(resolution, env);
	await withMkdirLock(
		lockPath,
		async () => {
			const marker = readCodexAgentHomeMarker(resolution.home);
			if (marker === null) throw new Error("missing codex agent home marker");
			validateMarkerIdentity(marker, resolution);
			const leasePath = join(
				resolution.home,
				CODEX_AGENT_HOME_LEASES,
				executionId,
			);
			try {
				const stat = lstatSync(leasePath);
				if (!stat.isFile() || stat.isSymbolicLink()) {
					throw new Error("unsafe codex agent home lease entry");
				}
				unlinkSync(leasePath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			const remaining = listCodexAgentHomeLeases(resolution.home).length;
			if (remaining === 0) {
				scrubCodexHomeCredentialAt(resolution.home, true);
			} else {
				console.warn(
					`[codex-home] keyed_home_scrub_deferred exec=${executionId} live_leases=${remaining}`,
				);
			}
		},
		CODEX_AGENT_HOME_LOCK_OPTS,
	);
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
	scrubCodexHomeCredentialAt(codexHomeDir(executionId, env), false);
}

function scrubCodexHomeCredentialAt(home: string, atomic: boolean): void {
	const cfg = join(home, "config.toml");
	if (!existsSync(cfg)) return;
	const stripped = stripManagedBlock(readFileSync(cfg, "utf-8")).trimEnd();
	const content = stripped ? `${stripped}\n` : "";
	if (atomic) atomicWriteFile(cfg, content);
	else {
		writeFileSync(cfg, content, { encoding: "utf-8", mode: 0o600 });
		chmodSync(cfg, 0o600); // repair mode on the pre-existing file
	}
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

export type RemoveCodexHomeResult =
	| { removed: true }
	| {
			removed: false;
			reason: "agent_home_protected" | "unresolved" | "rm_failed";
	  };

export function isAgentHomeSubtreePath(
	target: string,
	env: NodeJS.ProcessEnv,
): boolean {
	const agents = resolvePath(codexHomesRoot(env), "agents");
	const candidate = resolvePath(target);
	const rel = relative(agents, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** P5 retirement: remove only an execution-scoped legacy home. */
export function removeCodexHome(
	executionId: string,
	env: NodeJS.ProcessEnv = process.env,
	expected?: CodexAgentHomeIdentity,
): RemoveCodexHomeResult {
	const resolution = resolveExecutionCodexHome(executionId, expected, env);
	if (
		resolution.kind === "keyed" ||
		resolution.kind === "prepublished" ||
		isAgentHomeSubtreePath(codexHomeDir(executionId, env), env)
	) {
		console.error(
			`[codex-home] refuse_remove_agent_home exec=${executionId} kind=${resolution.kind}`,
		);
		return { removed: false, reason: "agent_home_protected" };
	}
	if (resolution.kind === "unknown") {
		console.warn(
			`[codex-home] remove_home_unresolved exec=${executionId} reason=${resolution.reason}`,
		);
		return { removed: false, reason: "unresolved" };
	}
	try {
		rmSync(resolution.home, { recursive: true, force: true });
		return { removed: true };
	} catch (error) {
		console.warn(
			`[codex-home] remove_home_failed exec=${executionId}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return { removed: false, reason: "rm_failed" };
	}
}
