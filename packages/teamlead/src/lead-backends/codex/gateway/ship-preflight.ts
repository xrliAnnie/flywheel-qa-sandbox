/**
 * FLY-245 Phase C2 — merge/ship founder preflight (plan §4.1, Codex R1#8).
 *
 * The Codex Lead's `relay_ship_decision` tool is `reserved_ship`. Its preflight
 * reuses the EXISTING `CodexFounderPreflight` (the same `verifyApproval` authority
 * a Claude Lead/Runner uses — there is no Codex-specific bypass). The critical
 * fix here is the `prHead` SOURCE: the gateway/Lead cwd is the Lead scratch
 * workspace, NOT the target Runner's worktree. Running `git rev-parse HEAD` in the
 * Lead workspace would verify the wrong repo / a stale checkout. So `prHead` is
 * derived from the TARGET session's trusted `worktree_path`, with an absolute git
 * binary in a bounded subprocess; a missing / dirty / unreadable worktree is
 * fail-closed.
 */

import { execFileSync } from "node:child_process";
import {
	existsSync as nodeExistsSync,
	realpathSync as nodeRealpathSync,
	statSync as nodeStatSync,
} from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";
import type {
	CodexFounderPreflight,
	FounderPreflightContext,
} from "../CodexFounderPreflight.js";
import type {
	DerivedToolContext,
	PreflightVerdict,
} from "./GatewayDispatcher.js";

const FULL_SHA_RE = /^[0-9a-f]{40}$/;

/** A bounded git subprocess runner (injected — real impl uses execFileSync with
 * an absolute git path + timeout; tests inject a fake). */
export type GitRunner = (
	args: string[],
	cwd: string,
) => { stdout: string; stderr: string; status: number };

/**
 * FLY-245 R1 HIGH-5: resolve an ABSOLUTE, trusted git binary — NEVER via `$PATH`.
 * The gateway runs UNSANDBOXED with action secrets in memory; a model-writable
 * `$PATH` entry would let a planted `git` execute as the gateway. Order:
 * `FLYWHEEL_GIT_PATH` (must be absolute + exist) → a fixed system allowlist.
 * Fail-closed (throws) if none is found.
 */
const TRUSTED_GIT_CANDIDATES = [
	"/usr/bin/git",
	"/opt/homebrew/bin/git",
	"/usr/local/bin/git",
	"/bin/git",
];

export function resolveTrustedGitPath(
	env: NodeJS.ProcessEnv = process.env,
	deps: { existsSync?: (p: string) => boolean } = {},
): string {
	const existsSync = deps.existsSync ?? nodeExistsSync;
	const override = env.FLYWHEEL_GIT_PATH?.trim();
	if (override) {
		if (!isAbsolute(override)) {
			throw new Error(
				`FLYWHEEL_GIT_PATH must be an ABSOLUTE path (no PATH-relative binary): "${override}"`,
			);
		}
		if (!existsSync(override)) {
			throw new Error(`FLYWHEEL_GIT_PATH does not exist: ${override}`);
		}
		return override;
	}
	for (const candidate of TRUSTED_GIT_CANDIDATES) {
		if (existsSync(candidate)) return candidate;
	}
	throw new Error(
		`no trusted git binary found (looked at ${TRUSTED_GIT_CANDIDATES.join(", ")}); set FLYWHEEL_GIT_PATH`,
	);
}

/**
 * Per-invocation `-c key=value` overrides that neutralize EVERY config-driven
 * code-execution vector git has — these win over global, system, AND
 * REPOSITORY-LOCAL (`$GIT_DIR/config`, worktree config) config, which env-var
 * config files do NOT (Codex R2 new HIGH: a planted `core.fsmonitor` in the
 * target worktree's own `.git/config` executed code during `git status`).
 * `-c` flags have the highest precedence, so they override a hostile repo config
 * regardless of where it lives.
 */
export const GIT_SAFE_CONFIG = [
	"-c",
	"core.fsmonitor=false", // the demonstrated RCE — a program run on every status
	"-c",
	"core.hooksPath=/dev/null", // no repo hooks
	"-c",
	"core.pager=cat", // never spawn a pager
	"-c",
	"core.sshCommand=false", // no ssh helper exec (defensive; local ops don't need it)
	"-c",
	"core.askpass=false", // no askpass helper exec
	"-c",
	"protocol.ext.allow=never", // no ext:: transport command exec
] as const;

/**
 * Build a `GitRunner` that runs the resolved ABSOLUTE git with a MINIMAL,
 * trusted environment AND repository-config-execution disabled. The process env
 * (and its possibly-model-influenceable `$PATH`) is NOT inherited; global +
 * system config is `/dev/null`; and the `-c` safety overrides above neutralize
 * repo-LOCAL config (`core.fsmonitor`/hooks/pager/ssh/askpass), which env-var
 * config files cannot reach. Read-only ops (`rev-parse`, `status`) need no
 * identity. (Codex R2 new HIGH.)
 */
export function makeTrustedGitRunner(gitPath: string): GitRunner {
	const minimalEnv: NodeJS.ProcessEnv = {
		PATH: `${dirname(gitPath)}:/usr/bin:/bin`,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
		GIT_OPTIONAL_LOCKS: "0",
	};
	return (args, cwd) => {
		try {
			// Prepend the safety `-c` flags BEFORE the subcommand so they apply.
			const stdout = execFileSync(gitPath, [...GIT_SAFE_CONFIG, ...args], {
				cwd,
				timeout: 10_000,
				encoding: "utf8",
				env: minimalEnv,
			});
			return { stdout, stderr: "", status: 0 };
		} catch (err) {
			const e = err as { stdout?: string; stderr?: string; status?: number };
			return {
				stdout: e.stdout ?? "",
				stderr: e.stderr ?? (err as Error).message,
				status: typeof e.status === "number" ? e.status : 1,
			};
		}
	};
}

/** Injected fs probes (real defaults; tests inject fakes). */
export interface WorktreeFsDeps {
	realpathSync: (p: string) => string;
	existsSync: (p: string) => boolean;
	statSync: (p: string) => { isDirectory: () => boolean };
}

/** True when `a` is an ancestor of, descendant of, or equal to `b`. */
function pathsOverlap(a: string, b: string): boolean {
	if (a === b) return true;
	const under = (rel: string) =>
		rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
	return under(relative(a, b)) || under(relative(b, a));
}

/**
 * FLY-245 R1 HIGH-5: canonicalize + ownership-validate the TARGET worktree path
 * before it is used as a git cwd. The path comes from the trusted StateStore, but
 * it must still be:
 *   - resolvable (realpath — defeats a symlink swap);
 *   - an existing DIRECTORY that is an actual git worktree (has a `.git`);
 *   - NOT overlapping any model-writable root (a worktree the model can write to
 *     would let it fabricate a clean HEAD and ship un-reviewed code).
 * Fail-closed (throws) on any violation. Returns the canonical path.
 */
export function canonicalizeTargetWorktree(
	worktreePath: string | undefined,
	opts: { untrustedRoots?: string[]; fs?: Partial<WorktreeFsDeps> } = {},
): string {
	if (!worktreePath || !worktreePath.trim()) {
		throw new Error(
			"target session has no worktree_path — cannot derive prHead",
		);
	}
	const realpathSync = opts.fs?.realpathSync ?? nodeRealpathSync;
	const existsSync = opts.fs?.existsSync ?? nodeExistsSync;
	const statSync = opts.fs?.statSync ?? nodeStatSync;

	let canonical: string;
	try {
		canonical = realpathSync(worktreePath.trim());
	} catch (e) {
		throw new Error(
			`target worktree_path "${worktreePath}" is not resolvable (fail-closed): ${(e as Error).message}`,
		);
	}
	let isDir = false;
	try {
		isDir = statSync(canonical).isDirectory();
	} catch (e) {
		throw new Error(
			`target worktree ${canonical} stat failed (fail-closed): ${(e as Error).message}`,
		);
	}
	if (!isDir) {
		throw new Error(`target worktree ${canonical} is not a directory`);
	}
	if (!existsSync(`${canonical}/.git`)) {
		throw new Error(
			`target worktree ${canonical} has no .git — not a trusted git worktree`,
		);
	}
	for (const root of opts.untrustedRoots ?? []) {
		if (root && pathsOverlap(canonical, root)) {
			throw new Error(
				`target worktree ${canonical} overlaps a model-writable root ${root} — refusing (a forged-clean HEAD risk)`,
			);
		}
	}
	return canonical;
}

/**
 * Derive the TARGET runner's committed PR head from its trusted worktree.
 * Fail-closed (throws) on: missing worktree path, git failure, or a non-40-hex
 * head. Never uses the Lead workspace head.
 *
 * Codex R3 HIGH (repo-local git RCE): this runs ONLY `git rev-parse HEAD` — a
 * pure REF read that loads NO `.gitattributes` and runs NO working-tree filter /
 * hook / fsmonitor program. The previous `git status --porcelain` dirty check
 * was removed: `status` applies `clean`/`process` filter drivers that a
 * worktree-controlled `.gitattributes` can name ARBITRARILY (`filter.<x>.clean`),
 * executing attacker code in the unsandboxed gateway — and no fixed `-c` list
 * can enumerate those names. Dirtiness is NOT the gateway's authority anyway:
 * the founder approval binds to the COMMITTED `prHead`, and the Runner's own
 * `verify-approval` is the final ship gate (plan §4.2). Uncommitted changes
 * cannot ship under a prHead-bound approval without a new commit (which changes
 * HEAD and invalidates the approval). `GIT_SAFE_CONFIG` stays as belt-and-braces
 * even though rev-parse doesn't trigger those vectors.
 */
export function deriveTargetPrHead(
	worktreePath: string | undefined,
	git: GitRunner,
): string {
	if (!worktreePath || !worktreePath.trim()) {
		throw new Error(
			"target session has no worktree_path — cannot derive prHead",
		);
	}
	const head = git(["rev-parse", "HEAD"], worktreePath);
	if (head.status !== 0) {
		throw new Error(
			`git rev-parse HEAD failed in ${worktreePath}: ${head.stderr.trim()}`,
		);
	}
	const sha = head.stdout.trim().toLowerCase();
	if (!FULL_SHA_RE.test(sha)) {
		throw new Error(`git rev-parse HEAD returned a non-40-hex value: "${sha}"`);
	}
	return sha;
}

export interface ShipPreflightDeps {
	preflight: CodexFounderPreflight;
	dbPath: string;
	stateDbPath?: string;
}

/**
 * Build the `reserved_ship` preflight from a derived tool context. The derived
 * `authority` MUST already carry the runtime-resolved `execId` + target-worktree
 * `prHead` (assembled by the gateway's deriveContext); this adapter only forwards
 * them to `CodexFounderPreflight.check()` and maps the decision to a verdict.
 * Fail-closed on a malformed authority bag.
 */
export function makeShipPreflight(deps: ShipPreflightDeps) {
	return (ctx: DerivedToolContext): PreflightVerdict => {
		const execId = ctx.authority.execId;
		const prHead = ctx.authority.prHead;
		if (typeof execId !== "string" || typeof prHead !== "string") {
			return { allowed: false, reason: "missing_derived_authority" };
		}
		const pfCtx: FounderPreflightContext = {
			action: "ship",
			execId,
			prHead,
			dbPath: deps.dbPath,
			stateDbPath: deps.stateDbPath,
		};
		const decision = deps.preflight.check(pfCtx);
		return { allowed: decision.allowed, reason: decision.reason };
	};
}
