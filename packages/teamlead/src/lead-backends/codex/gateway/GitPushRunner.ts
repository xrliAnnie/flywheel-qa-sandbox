/**
 * FLY-350 (Z) unit 4 — GitPushRunner + open_pr: the gateway-proxied "open a PR"
 * path for a write-capable Codex Lead (plan §3.1, codex design R3/R4).
 *
 * Mufasa's shell is net-off and holds NO GH_TOKEN — it can write files + make
 * LOCAL commits, but cannot push or curl. The gateway (out-of-sandbox, holds the
 * fine-grained GH_TOKEN over the broker) does the push + PR on the model's
 * behalf. The model can only REQUEST; it can never reach `gh pr merge` / `:cool:`
 * (the gateway exposes no such tool), so it is STRUCTURALLY unable to self-merge.
 *
 * ── The RCE surface this module is built around (R3-1, codex HIGH) ───────────
 * The model's worktree is model-WRITABLE: it can plant a hostile repo-local git
 * config (`core.fsmonitor`, hooks, `uploadpack.packObjectsHook`, `.gitattributes`
 * filter drivers, `url.*.insteadOf`, proxies, `protocol.ext`). If the gateway —
 * which runs UNSANDBOXED with GH_TOKEN in memory — ran git with the model
 * worktree as cwd or fetched over git transport from it, that hostile config
 * would execute arbitrary code in the gateway / exfiltrate the token. So:
 *
 *   git NEVER runs with the model worktree as cwd, and the model's objects are
 *   moved WITHOUT git transport (no upload-pack ⇒ no `packObjectsHook`):
 *     1. derive the validated head SHA with a single hardened `rev-parse HEAD`
 *        (the ONE read against the model repo — loads no gitattributes, runs no
 *        filter/hook/fsmonitor; same primitive as ship-preflight deriveTargetPrHead);
 *     2. a CLEAN staging repo (gateway-owned, OUTSIDE the model's writableRoots)
 *        borrows the model object store read-only via `objects/info/alternates`
 *        (a pure object-DB link — NO transport, NO upload-pack, NO config exec);
 *     3. push the validated SHA FROM the clean staging repo (clean cwd ⇒ no
 *        hostile repo-local config governs anything) to a SERVER-DERIVED GitHub
 *        URL + SERVER-DERIVED branch, with every config-exec vector `-c`-pinned
 *        off and the host's global/system config neutralized.
 * (Empirically verified: the model's pre-push hook / packObjectsHook / fsmonitor
 *  never fire; the exact committed SHA lands on the remote branch.)
 *
 * ── Token non-persistence (R4-1) ─────────────────────────────────────────────
 * GH_TOKEN travels ONLY in the push subprocess's env, read by a one-shot
 * GIT_ASKPASS script whose BODY contains no secret (it echoes an env var). The
 * token is NEVER in argv, the remote URL, any git config, the audit row, or an
 * error string. The remote URL carries only the non-secret `x-access-token`
 * username.
 *
 * ── Scope (R2-3 / R3-3) ──────────────────────────────────────────────────────
 * The GH_TOKEN is provisioned out-of-band as a fine-grained token with EXACTLY
 * `contents:write` + `pull_requests:write` (no issues/workflows/actions/merge).
 * A runtime probe records the actor + confirms repo push access, fail-closed on
 * uncertainty — the gateway refuses to start the push path on an unproven token.
 */

import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FULL_SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Conservative git refname validator (R4-4): a server-derived branch only. Must
 * start with the trusted `flywheel/` prefix; the rest is `[A-Za-z0-9._/-]` with
 * no `..`, no leading/trailing/double slash, no trailing `.lock`, no `@{`. The
 * model never supplies a raw ref — the gateway derives it.
 */
const SAFE_BRANCH_RE =
	/^flywheel\/(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]$/;

/** Branches the gateway must NEVER push to (the merge red line lives here). The
 * push refuses these even if a derivation bug produced one. */
export const PROTECTED_BRANCHES = [
	"main",
	"master",
	"trunk",
	"release",
	"production",
	"prod",
];

/** A bounded git runner: absolute git, minimal env, NO inherited config. `env`
 * entries are MERGED onto the minimal base (used only for the one-shot askpass
 * on push). Injectable so tests can drive the REAL git (adversarial fixtures)
 * or a fake (pure-logic tests). */
export type GitExec = (
	args: string[],
	opts: { cwd: string; env?: Record<string, string> },
) => { stdout: string; stderr: string; status: number };

/** Per-invocation `-c` overrides that neutralize EVERY config-driven code-exec
 * vector git has, INCLUDING push/transfer-specific ones (credential helper,
 * proxies, url rewrites, transport extensions). These win over global, system,
 * and repo-local config. */
export const GIT_PUSH_SAFE_CONFIG = [
	"-c",
	"core.fsmonitor=false",
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"core.pager=cat",
	"-c",
	"core.sshCommand=false",
	"-c",
	"core.askpass=", // we set GIT_ASKPASS in env explicitly; never a repo-named one
	"-c",
	"protocol.ext.allow=never",
	"-c",
	"protocol.file.allow=always", // local alternate object access (no transport)
	"-c",
	"credential.helper=", // no credential helper exec (token comes via askpass)
	"-c",
	"http.proxy=", // no proxy exfil
	"-c",
	"https.proxy=",
	"-c",
	"core.fsmonitorHookVersion=", // defensive
] as const;

/**
 * Build a real `GitExec` bound to an ABSOLUTE git path with a minimal, trusted
 * env and host global/system config neutralized (`GIT_CONFIG_GLOBAL`/`SYSTEM`
 * = /dev/null — defeats a hostile `~/.gitconfig` `insteadOf`/proxy). Extra env
 * (the one-shot askpass + its password) is merged on top per-call.
 */
export function makeGitPushExec(gitPath: string): GitExec {
	const baseEnv: Record<string, string> = {
		PATH: `${gitPath.replace(/\/[^/]+$/, "")}:/usr/bin:/bin`,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
		GIT_OPTIONAL_LOCKS: "0",
	};
	return (args, opts) => {
		try {
			const stdout = execFileSync(gitPath, args, {
				cwd: opts.cwd,
				timeout: 30_000,
				encoding: "utf8",
				env: { ...baseEnv, ...(opts.env ?? {}) },
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

/** Parse + validate a `owner/repo` slug (R3-4: scope the PR to THIS Lead's
 * project repo; never infer owner/repo from model-controlled local git state). */
export function parseOwnerRepo(projectRepo: string | undefined): {
	owner: string;
	repo: string;
} {
	const slug = (projectRepo ?? "").trim();
	const m = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(
		slug,
	);
	if (!m) {
		throw new Error(
			`invalid project repo slug "${projectRepo}" — expected "owner/repo" (fail-closed)`,
		);
	}
	return { owner: m[1]!, repo: m[2]! };
}

/** Sanitize one path segment for a git refname (used for the lead id segment). */
function sanitizeSegment(s: string): string {
	return s
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^[.-]+|[.-]+$/g, "")
		.slice(0, 40);
}

/**
 * SERVER-DERIVED branch name (R4-4) — from the lead id, issue, and head SHA
 * under a fixed `flywheel/` prefix: `flywheel/<lead>/<issue>-<sha>`. The model
 * never supplies a raw ref. `issue` is REQUIRED (Codex review LOW — the branch
 * shape + scope boundary depend on it); a blank issue throws. Throws if the
 * derived name fails the conservative refname validator.
 */
export function deriveBranchName(opts: {
	leadId: string;
	issue: string;
	headSha: string;
}): string {
	if (!FULL_SHA_RE.test(opts.headSha)) {
		throw new Error(
			`deriveBranchName: headSha must be 40-hex (got "${opts.headSha}")`,
		);
	}
	const issueSeg = sanitizeSegment(opts.issue ?? "");
	if (!issueSeg) {
		throw new Error(
			"deriveBranchName: an issue identifier is required (the branch shape is flywheel/<lead>/<issue>-<sha>)",
		);
	}
	const lead = sanitizeSegment(opts.leadId) || "lead";
	const shortSha = opts.headSha.slice(0, 12);
	const branch = `flywheel/${lead}/${issueSeg}-${shortSha}`;
	assertPushableBranch(branch);
	return branch;
}

/** Fail-closed branch gate (R4-4 + the merge red line): a conservative refname
 * AND not a protected/default branch (case-insensitive, with or without a
 * `refs/heads/` prefix). Throws on any violation. */
export function assertPushableBranch(branch: string): void {
	const ref = branch.replace(/^refs\/heads\//, "");
	if (!SAFE_BRANCH_RE.test(ref)) {
		throw new Error(
			`refusing branch "${branch}": not a valid server-derived flywheel/* refname (fail-closed)`,
		);
	}
	const leaf = ref.toLowerCase();
	if (
		PROTECTED_BRANCHES.includes(leaf) ||
		PROTECTED_BRANCHES.some((p) => leaf === p || leaf.endsWith(`/${p}`))
	) {
		throw new Error(
			`refusing to push protected branch "${branch}" (the merge red line; fail-closed)`,
		);
	}
}

// ── materialize + push ───────────────────────────────────────────────────────

export interface GitPushRequest {
	/** Absolute path to the model worktree's `.git` (object source). */
	modelGitDir: string;
	/** The validated 40-hex head SHA (derived by the caller via rev-parse). */
	headSha: string;
	/** The HTTPS GitHub remote URL — server-derived from owner/repo; carries the
	 * non-secret `x-access-token` username, NEVER the token. */
	remoteUrl: string;
	/** Server-derived target branch (validated). */
	branch: string;
	/** The fine-grained GH_TOKEN (push subprocess env only). */
	token: string;
}

export interface GitPushResult {
	ok: boolean;
	/** The local (model HEAD) SHA we set out to push. */
	localSha: string;
	/** The SHA observed on the remote branch after push (R4-3 dual-SHA). */
	pushedSha?: string;
	branch: string;
	error?: string;
}

export interface GitPushRunnerDeps {
	gitPath: string;
	/** Root dir (OUTSIDE the model's writableRoots) under which ephemeral clean
	 * staging repos are created. */
	stagingRoot: string;
	/** Injectable git exec (default: real hardened exec). */
	gitExec?: GitExec;
	/** Injectable temp-dir maker (default: mkdtempSync under stagingRoot). */
	makeStagingDir?: () => string;
}

/**
 * Materialize the validated commit into a CLEAN staging repo (read-only object
 * alternate, NO transport) and push it to the server-derived branch with a
 * one-shot askpass token. Never runs git in the model worktree; never executes
 * model repo-local config. Returns a structured result (never throws for an
 * operational git failure — the token-bearing path must not leak via an
 * exception string). The token is never placed in argv/url/config/result.
 */
export function materializeAndPush(
	req: GitPushRequest,
	deps: GitPushRunnerDeps,
): GitPushResult {
	const exec = deps.gitExec ?? makeGitPushExec(deps.gitPath);
	const out: GitPushResult = {
		ok: false,
		localSha: req.headSha,
		branch: req.branch,
	};

	// Fail-closed input validation (defense in depth — callers also validate).
	if (!FULL_SHA_RE.test(req.headSha)) {
		out.error = "headSha is not a 40-hex commit id (fail-closed)";
		return out;
	}
	try {
		assertPushableBranch(req.branch);
	} catch (e) {
		out.error = e instanceof Error ? e.message : String(e);
		return out;
	}
	if (urlEmbedsPassword(req.remoteUrl)) {
		// remoteUrl may carry the `x-access-token@` username (no secret) but must
		// NOT embed a PASSWORD (`user:pass@`) — the token travels via askpass only.
		out.error = "remoteUrl must not embed a password (fail-closed)";
		return out;
	}

	mkdirSync(deps.stagingRoot, { recursive: true });
	const stagingDir =
		deps.makeStagingDir?.() ?? mkdtempSync(join(deps.stagingRoot, "push-"));
	let askpassPath: string | undefined;
	try {
		// 1) clean staging repo — its config is empty (no hostile repo-local config).
		const init = exec(["init", "-q", stagingDir], { cwd: deps.stagingRoot });
		if (init.status !== 0) {
			out.error = `staging init failed: ${redact(init.stderr, req.token)}`;
			return out;
		}
		// 2) borrow the model object store read-only (NO transport / NO upload-pack).
		const alt = join(stagingDir, ".git", "objects", "info", "alternates");
		mkdirSync(join(stagingDir, ".git", "objects", "info"), {
			recursive: true,
		});
		writeFileSync(alt, `${join(req.modelGitDir, "objects")}\n`);
		// 3) confirm the validated commit is reachable (object read only; no exec).
		const reach = exec(
			[...GIT_PUSH_SAFE_CONFIG, "cat-file", "-e", `${req.headSha}^{commit}`],
			{ cwd: stagingDir },
		);
		if (reach.status !== 0) {
			out.error = `validated commit ${req.headSha} not reachable in staging (fail-closed): ${redact(reach.stderr, req.token)}`;
			return out;
		}
		// 4) one-shot askpass: token lives ONLY in the subprocess env (R4-1).
		askpassPath = join(stagingDir, "askpass.sh");
		writeFileSync(
			askpassPath,
			'#!/bin/sh\nprintf "%s" "$FLYWHEEL_GIT_PASSWORD"\n',
		);
		chmodSync(askpassPath, 0o700);
		// 5) push the validated SHA → server-derived branch. No force. Clean cwd ⇒
		//    no hostile config. Token via askpass env, never argv/url/config.
		const push = exec(
			[
				...GIT_PUSH_SAFE_CONFIG,
				"push",
				req.remoteUrl,
				`${req.headSha}:refs/heads/${req.branch}`,
			],
			{
				cwd: stagingDir,
				env: { GIT_ASKPASS: askpassPath, FLYWHEEL_GIT_PASSWORD: req.token },
			},
		);
		if (push.status !== 0) {
			out.error = `push failed: ${redact(push.stderr, req.token)}`;
			return out;
		}
		// 6) read back the pushed SHA from the remote (R4-3 dual-SHA contract).
		const ls = exec(
			[
				...GIT_PUSH_SAFE_CONFIG,
				"ls-remote",
				req.remoteUrl,
				`refs/heads/${req.branch}`,
			],
			{
				cwd: stagingDir,
				env: { GIT_ASKPASS: askpassPath, FLYWHEEL_GIT_PASSWORD: req.token },
			},
		);
		const pushedSha = ls.stdout.trim().split(/\s+/)[0]?.toLowerCase();
		out.pushedSha = FULL_SHA_RE.test(pushedSha ?? "") ? pushedSha : undefined;
		out.ok = true;
		return out;
	} catch (e) {
		out.error = redact(e instanceof Error ? e.message : String(e), req.token);
		return out;
	} finally {
		// Best-effort cleanup of the ephemeral staging repo (incl. the askpass).
		try {
			rmSync(stagingDir, { recursive: true, force: true });
		} catch {
			// non-fatal
		}
	}
}

/** True if the URL embeds a PASSWORD in its userinfo (`scheme://user:pass@host`).
 * A bare `user@host` (e.g. the non-secret `x-access-token` username) is allowed;
 * a colon in the userinfo means an embedded secret → rejected. */
export function urlEmbedsPassword(url: string): boolean {
	const m = /^[a-z][a-z0-9+.-]*:\/\/([^/]*)@/i.exec(url);
	if (!m) return false; // no userinfo at all
	return m[1]!.includes(":");
}

/** Redact a token from any string before it can reach an audit row / error /
 * log (R4-1 defense in depth — the token should never be in these anyway). */
function redact(s: string, token: string): string {
	if (!token) return s;
	return s.split(token).join("***");
}

// ── GitHub API: token probe + open PR (injected fetch) ───────────────────────

export type FetchImpl = typeof fetch;

export interface GitHubApiCtx {
	fetchImpl: FetchImpl;
	/** API base, default https://api.github.com (overridable for tests). */
	apiBase?: string;
	owner: string;
	repo: string;
	token: string;
}

const DEFAULT_API_BASE = "https://api.github.com";

function ghHeaders(token: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "flywheel-gateway",
	};
}

export interface TokenProbeResult {
	ok: boolean;
	actor?: string;
	reason?: string;
}

/**
 * Runtime token-scope probe (R3-3) — what it verifies, and the HONEST boundary of
 * what it can't (Codex review MEDIUM, rounds 1-2):
 *  - confirms the token authenticates + can reach THIS repo + has contents push
 *    (fail-closed on any network/auth/access failure or missing `permissions`);
 *  - REJECTS a classic/broad token: a classic PAT/OAuth token returns its (coarse)
 *    scope set in `X-OAuth-Scopes`; a fine-grained PAT / GitHub-App token omits it,
 *    so a present header ⇒ broad token ⇒ rejected.
 *
 * It does NOT (and CANNOT, via GitHub's API) introspect a FINE-GRAINED token's
 * exact permission set — GitHub exposes no endpoint returning a fine-grained
 * token's allowed/forbidden scopes. So the "forbidden" half of the matrix
 * (no issues:write / actions / workflows / merge) is NOT runtime-proven; it is
 * enforced by THREE structural layers instead:
 *   1. PROVISIONING — the token is minted out-of-band with EXACTLY contents:write
 *      + pull_requests:write (the deploy/founder step; see the launcher);
 *   2. the gateway exposes NO tool that could use a forbidden scope — only
 *      git_push (feature branch, protected refused) + open_pr (≠ merge); there is
 *      no merge/:cool:/comment/dispatch/workflow tool, so even an over-scoped
 *      token can't be MISUSED through the gateway;
 *   3. the model shell is NET-OFF and holds no token, so it can't reach GitHub
 *      directly to exploit a stray scope.
 * `pull_requests:write` likewise isn't separately probed (no read-only check
 * proves write); a contents-only token passes git_push and then open_pr
 * fail-closes with a clear error. Full fine-grained-scope introspection (a
 * GitHub-App installation token whose installation permissions ARE queryable) is
 * tracked as a follow-up. Fail-closed throughout.
 */
export async function probeGitHubToken(
	ctx: GitHubApiCtx,
): Promise<TokenProbeResult> {
	const base = ctx.apiBase ?? DEFAULT_API_BASE;
	try {
		const repoRes = await ctx.fetchImpl(
			`${base}/repos/${ctx.owner}/${ctx.repo}`,
			{ headers: ghHeaders(ctx.token) },
		);
		if (!repoRes.ok) {
			return {
				ok: false,
				reason: `repo access probe failed: HTTP ${repoRes.status} (fail-closed)`,
			};
		}
		// REJECT a classic/broad token: only classic PAT/OAuth tokens carry
		// `X-OAuth-Scopes`; a fine-grained token omits it. A broad `repo`-scoped
		// classic token would otherwise pass the push check below.
		const oauthScopes = repoRes.headers?.get?.("x-oauth-scopes");
		if (
			oauthScopes !== null &&
			oauthScopes !== undefined &&
			oauthScopes.trim() !== ""
		) {
			return {
				ok: false,
				reason:
					"classic/broad token detected (X-OAuth-Scopes present) — require a FINE-GRAINED token scoped to contents:write + pull_requests:write only (fail-closed)",
			};
		}
		const repo = (await repoRes.json()) as {
			permissions?: { push?: boolean };
		};
		if (!repo.permissions?.push) {
			return {
				ok: false,
				reason: "token lacks push (contents:write) on the repo (fail-closed)",
			};
		}
		// Record the actor (fine-grained tokens expose it via the installation;
		// /user works for user-scoped tokens). A missing actor is non-fatal for
		// the push, but we record what we can.
		let actor: string | undefined;
		try {
			const userRes = await ctx.fetchImpl(`${base}/user`, {
				headers: ghHeaders(ctx.token),
			});
			if (userRes.ok) {
				const u = (await userRes.json()) as { login?: string };
				actor = u.login;
			}
		} catch {
			// non-fatal — repo push access already proven above
		}
		return { ok: true, actor };
	} catch (e) {
		return {
			ok: false,
			reason: `token probe threw (fail-closed): ${e instanceof Error ? e.message : String(e)}`,
		};
	}
}

export interface OpenPrRequest extends GitHubApiCtx {
	head: string; // the (server-derived) branch
	base: string; // always "main" for the project repo
	title: string;
	body: string;
}

export interface OpenPrResult {
	ok: boolean;
	number?: number;
	url?: string;
	reason?: string;
}

/**
 * Open (or find, idempotently) a PR via the GitHub API (R3-4: never infer
 * repo/head/base from model-controlled local state). A 422 "already exists" is
 * reconciled to the existing PR (R3-5 idempotent). The `base` is constrained to
 * the project repo's default; `head` is the validated server-derived branch.
 */
export async function openPullRequest(
	req: OpenPrRequest,
): Promise<OpenPrResult> {
	const base = req.apiBase ?? DEFAULT_API_BASE;
	try {
		assertPushableBranch(req.head);
	} catch (e) {
		return { ok: false, reason: e instanceof Error ? e.message : String(e) };
	}
	try {
		const res = await req.fetchImpl(
			`${base}/repos/${req.owner}/${req.repo}/pulls`,
			{
				method: "POST",
				headers: {
					...ghHeaders(req.token),
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					title: req.title,
					head: req.head,
					base: req.base,
					body: req.body,
				}),
			},
		);
		if (res.ok) {
			const pr = (await res.json()) as { number?: number; html_url?: string };
			return { ok: true, number: pr.number, url: pr.html_url };
		}
		if (res.status === 422) {
			// Already-exists → find the open PR for this head (idempotent, R3-5).
			const existing = await req.fetchImpl(
				`${base}/repos/${req.owner}/${req.repo}/pulls?head=${encodeURIComponent(`${req.owner}:${req.head}`)}&state=open`,
				{ headers: ghHeaders(req.token) },
			);
			if (existing.ok) {
				const arr = (await existing.json()) as Array<{
					number?: number;
					html_url?: string;
				}>;
				if (Array.isArray(arr) && arr[0]) {
					return { ok: true, number: arr[0].number, url: arr[0].html_url };
				}
			}
			return {
				ok: false,
				reason: "PR create returned 422 but no existing open PR found",
			};
		}
		return { ok: false, reason: `PR create failed: HTTP ${res.status}` };
	} catch (e) {
		return {
			ok: false,
			reason: `PR create threw: ${e instanceof Error ? e.message : String(e)}`,
		};
	}
}

/** Build the server-derived HTTPS remote URL with the non-secret
 * `x-access-token` username (the token itself travels via askpass, never here). */
export function buildRemoteUrl(owner: string, repo: string): string {
	return `https://x-access-token@github.com/${owner}/${repo}.git`;
}

/** A metadata-only audit row for a git_push / open_pr action (NEVER the token —
 * R4-1). Both the local head SHA and the pushed remote SHA are recorded (R4-3);
 * with the alternate-materialize path they are identical, but the contract
 * persists both so a future re-materialization is auditable. */
export function buildPushAuditRow(args: {
	ts: number;
	leadId: string;
	projectName: string;
	repo: string;
	branch: string;
	localSha: string;
	pushedSha?: string;
	actor?: string;
	prNumber?: number;
	prUrl?: string;
	outcome: string;
}): Record<string, unknown> {
	return {
		ts: args.ts,
		leadId: args.leadId,
		project: args.projectName,
		repo: args.repo,
		branch: args.branch,
		localSha: args.localSha,
		pushedSha: args.pushedSha,
		actor: args.actor,
		prNumber: args.prNumber,
		prUrl: args.prUrl,
		outcome: args.outcome,
	};
}

/**
 * Read the model worktree's committed HEAD with a single hardened `rev-parse`.
 * This is the ONE git read against the model repo (the Lead's own write-capable
 * scratch). Like ship-preflight's deriveTargetPrHead it runs no filter/hook/
 * fsmonitor; GIT_PUSH_SAFE_CONFIG neutralizes the vectors belt-and-braces.
 * Fail-closed (throws) on git failure or a non-40-hex result.
 */
export function readModelHeadSha(modelWorktree: string, exec: GitExec): string {
	const r = exec([...GIT_PUSH_SAFE_CONFIG, "rev-parse", "HEAD"], {
		cwd: modelWorktree,
	});
	if (r.status !== 0) {
		throw new Error(
			`git rev-parse HEAD failed in model worktree: ${r.stderr.trim()}`,
		);
	}
	const sha = r.stdout.trim().toLowerCase();
	if (!FULL_SHA_RE.test(sha)) {
		throw new Error(`git rev-parse HEAD returned a non-40-hex value: "${sha}"`);
	}
	return sha;
}

/** Default ephemeral staging root under the OS temp dir (gateway callers pass an
 * explicit stagingRoot OUTSIDE the model writableRoots in production). */
export function defaultStagingRoot(): string {
	return join(tmpdir(), "flywheel-gateway-staging");
}
