/**
 * FLY-1185 §2.4 — branch deletion primitives: CAS + occupancy + gates.
 *
 * LOCAL deletion (Flywheel-owned-lifecycle call sites ONLY — Layer A ship
 * closeout, QA scratch teardown, manual approved apply; the PERIODIC sweep
 * never auto-deletes local refs, R4#3):
 *   1. runs inside the repo mutation lock (re-entrant acquire — free when
 *      the caller already holds it);
 *   2. fresh occupancy check via `git worktree list --porcelain` — R3
 *      empirically proved `update-ref -d` deletes a CHECKED-OUT branch and
 *      exits 0, so occupancy must be explicit;
 *   3. fresh `rev-parse refs/heads/<b>` must equal the expected sha;
 *   4. `git update-ref -d refs/heads/<b> <expectedSha>` — the CAS: git
 *      itself refuses when the ref moved between (3) and (4).
 *
 * REMOTE deletion: fresh `ls-remote --heads origin <b>` must equal the
 * expected sha, then `git push --force-with-lease=refs/heads/<b>:<sha>
 * origin :refs/heads/<b>` — the lease is the server-side CAS; a stale lease
 * (`stale info`) means the remote moved and we refuse.
 *
 * Recovery floor: a merged branch's tip stays reachable from main — the
 * audited sha alone revives it (`git branch <name> <sha>`); unmerged tips
 * are bundled BEFORE deletion (`bundleBranch`).
 *
 * Gates: `main`/`master`/the repo default branch and any configured
 * protected pattern are never deletable; only `<repoSlug>-` shaped branches
 * are managed at all.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CleanupPolicyByProject } from "./cleanup-policy.js";
import { policyFor } from "./cleanup-policy.js";
import type { WorktreeCleanupAttestation } from "./worktree-cleanup.js";

export type GitExecFn = (
	args: string[],
	cwd: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const defaultGitExec: GitExecFn = (args, cwd) =>
	new Promise((resolve) => {
		execFile(
			"git",
			args,
			{ cwd, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
			(err, stdout, stderr) => {
				resolve({
					code: err ? ((err as { code?: number }).code ?? 1) : 0,
					stdout: stdout ?? "",
					stderr: stderr ?? "",
				});
			},
		);
	});

// ── Gates ────────────────────────────────────────────────────────────────

/** Exact name or trailing-`*` prefix patterns (config `cleanup.protected_branches`). */
export function isProtectedBranch(
	branch: string,
	protectedPatterns: readonly string[],
): boolean {
	for (const pat of protectedPatterns) {
		if (pat.endsWith("*")) {
			if (branch.startsWith(pat.slice(0, -1))) return true;
		} else if (branch === pat) {
			return true;
		}
	}
	return false;
}

/** Never-deletable base branches, independent of config. */
export function isBaseBranch(branch: string, defaultBranch?: string): boolean {
	return (
		branch === "main" ||
		branch === "master" ||
		(!!defaultBranch && branch === defaultBranch)
	);
}

/** Only `<repoSlug>-…` branches are managed by Flywheel lifecycle at all. */
export function isManagedBranchShape(
	repoSlug: string,
	branch: string,
): boolean {
	return branch.startsWith(`${repoSlug}-`);
}

/** QA scratch family: `deriveWorktreeKey(ident, "qa")` keys end in `-qa`. */
export function isQaEphemeralBranch(repoSlug: string, branch: string): boolean {
	return isManagedBranchShape(repoSlug, branch) && branch.endsWith("-qa");
}

// ── Local CAS delete ─────────────────────────────────────────────────────

export type LocalBranchDeleteOutcome =
	| { deleted: true; sha: string }
	| {
			deleted: false;
			reason:
				| "branch_occupied"
				| "cas_mismatch"
				| "branch_missing"
				| "probe_failed"
				| "delete_failed";
			detail?: string;
	  };

/**
 * CAS-delete a LOCAL branch. The caller is responsible for policy gates
 * (protected / base / shape / merge evidence); this primitive owns the
 * mechanical safety: occupancy + expected-sha CAS. Call INSIDE the repo
 * mutation lock (or pass `withRepoLock` and it will enter re-entrantly).
 */
export async function casDeleteLocalBranch(opts: {
	mainRepoPath: string;
	branch: string;
	expectedSha: string;
	exec?: GitExecFn;
	withRepoLock?: <T>(repo: string, fn: () => Promise<T>) => Promise<T>;
}): Promise<LocalBranchDeleteOutcome> {
	const exec = opts.exec ?? defaultGitExec;
	const run = async (): Promise<LocalBranchDeleteOutcome> => {
		// (2) occupancy — any worktree with this branch checked out → skip.
		const list = await exec(
			["-C", opts.mainRepoPath, "worktree", "list", "--porcelain"],
			opts.mainRepoPath,
		);
		if (list.code !== 0) {
			return { deleted: false, reason: "probe_failed", detail: list.stderr };
		}
		if (
			list.stdout
				.split("\n")
				.some((l) => l.trim() === `branch refs/heads/${opts.branch}`)
		) {
			return { deleted: false, reason: "branch_occupied" };
		}

		// (3) fresh sha must match expectation.
		const rev = await exec(
			[
				"-C",
				opts.mainRepoPath,
				"rev-parse",
				"--verify",
				"-q",
				`refs/heads/${opts.branch}`,
			],
			opts.mainRepoPath,
		);
		if (rev.code !== 0) {
			return { deleted: false, reason: "branch_missing" };
		}
		const actual = rev.stdout.trim();
		if (actual !== opts.expectedSha) {
			return {
				deleted: false,
				reason: "cas_mismatch",
				detail: `expected=${opts.expectedSha} actual=${actual}`,
			};
		}

		// (4) CAS delete — git verifies old value atomically.
		const del = await exec(
			[
				"-C",
				opts.mainRepoPath,
				"update-ref",
				"-d",
				`refs/heads/${opts.branch}`,
				opts.expectedSha,
			],
			opts.mainRepoPath,
		);
		if (del.code !== 0) {
			return { deleted: false, reason: "delete_failed", detail: del.stderr };
		}
		return { deleted: true, sha: opts.expectedSha };
	};
	return opts.withRepoLock ? opts.withRepoLock(opts.mainRepoPath, run) : run();
}

// ── Remote CAS delete ────────────────────────────────────────────────────

export type RemoteBranchDeleteOutcome =
	| { deleted: true; sha: string }
	| {
			deleted: false;
			reason:
				| "remote_missing"
				| "remote_moved"
				| "lease_rejected"
				| "probe_failed"
				| "delete_failed";
			detail?: string;
	  };

/**
 * Lease-CAS delete a REMOTE branch: fresh `ls-remote` must show the expected
 * sha, then delete under `--force-with-lease=<ref>:<sha>` so the server
 * refuses if the ref moved after our probe.
 */
export async function casDeleteRemoteBranch(opts: {
	mainRepoPath: string;
	branch: string;
	expectedSha: string;
	remote?: string;
	exec?: GitExecFn;
}): Promise<RemoteBranchDeleteOutcome> {
	const exec = opts.exec ?? defaultGitExec;
	const remote = opts.remote ?? "origin";

	const probe = await exec(
		["-C", opts.mainRepoPath, "ls-remote", "--heads", remote, opts.branch],
		opts.mainRepoPath,
	);
	if (probe.code !== 0) {
		return { deleted: false, reason: "probe_failed", detail: probe.stderr };
	}
	const line = probe.stdout
		.split("\n")
		.find((l) => l.endsWith(`\trefs/heads/${opts.branch}`));
	if (!line) {
		return { deleted: false, reason: "remote_missing" };
	}
	const remoteSha = line.split("\t")[0]?.trim();
	if (remoteSha !== opts.expectedSha) {
		return {
			deleted: false,
			reason: "remote_moved",
			detail: `expected=${opts.expectedSha} remote=${remoteSha}`,
		};
	}

	const del = await exec(
		[
			"-C",
			opts.mainRepoPath,
			"push",
			`--force-with-lease=refs/heads/${opts.branch}:${opts.expectedSha}`,
			remote,
			`:refs/heads/${opts.branch}`,
		],
		opts.mainRepoPath,
	);
	if (del.code !== 0) {
		const stale = /stale info|force-with-lease/i.test(del.stderr);
		return {
			deleted: false,
			reason: stale ? "lease_rejected" : "delete_failed",
			detail: del.stderr.slice(0, 500),
		};
	}
	return { deleted: true, sha: opts.expectedSha };
}

// ── Ship-time immediate remote delete (plan §2.4, R5#2 + R6#2) ───────────

export interface ShipRemoteBranchCleanupInput {
	executionId: string;
	issueId: string;
	projectName: string;
	/** The Layer A pre-delete attestation — the ONLY authority consumed. */
	attestation: WorktreeCleanupAttestation;
}

export interface ShipRemoteCleanupDeps {
	store: {
		insertEvent: (e: {
			event_id: string;
			execution_id: string;
			issue_id: string;
			project_name: string;
			event_type: string;
			source: string;
			payload: Record<string, unknown>;
		}) => boolean;
		getWorktreeBinding: (
			executionId: string,
		) => { path: string; branch: string; generation: string } | undefined;
	};
	resolveProjectRoot: (projectName: string) => string | undefined;
	policies?: CleanupPolicyByProject;
	exec?: GitExecFn;
	/** Merged-PR head check seam (default: gh pr list --state merged --head). */
	getMergedPrHeads?: (
		projectRoot: string,
		branch: string,
	) => Promise<Set<string> | undefined>;
}

async function defaultMergedPrHeads(
	projectRoot: string,
	branch: string,
): Promise<Set<string> | undefined> {
	return new Promise((resolve) => {
		execFile(
			"gh",
			[
				"pr",
				"list",
				"--state",
				"merged",
				"--head",
				branch,
				"--json",
				"headRefOid",
			],
			{ cwd: projectRoot, timeout: 30_000 },
			(err, stdout) => {
				if (err) {
					resolve(undefined);
					return;
				}
				try {
					const arr = JSON.parse(stdout) as Array<{ headRefOid: string }>;
					resolve(new Set(arr.map((p) => p.headRefOid)));
				} catch {
					resolve(undefined);
				}
			},
		);
	});
}

/**
 * Ship-time immediate remote-branch delete. Consumes ONLY the Layer A
 * pre-delete attestation (never re-reads the destroyed admin marker):
 *   removed ∧ bindingVerified ∧ actualBranch === persisted binding.branch
 *   ∧ (merged PR headRefOid === headSha ∨ headSha ancestor-of-main)
 *   ∧ ¬protected ∧ ¬base ∧ managed shape
 * → fresh ls-remote + lease-CAS delete. Anything else →
 * `remote_delete_skipped` audit, remainder owned by the sweep.
 */
export function makeShipRemoteBranchCleanup(deps: ShipRemoteCleanupDeps) {
	return async (input: ShipRemoteBranchCleanupInput): Promise<void> => {
		const att = input.attestation;
		const audit = (event: string, payload: Record<string, unknown>) => {
			deps.store.insertEvent({
				event_id: `ship-remote-branch-${input.executionId}-${event}`,
				execution_id: input.executionId,
				issue_id: input.issueId,
				project_name: input.projectName,
				event_type: event,
				source: "bridge.branch-cleanup",
				payload,
			});
		};
		const skip = (reason: string, extra: Record<string, unknown> = {}) =>
			audit("remote_delete_skipped", { reason, ...extra });
		try {
			const projectRoot = deps.resolveProjectRoot(input.projectName);
			if (!projectRoot) return skip("no_project_root");
			const policy = policyFor(deps.policies, input.projectName);
			if (!policy.enabled) return skip(`policy_disabled:${policy.reason}`);

			if (!att.removed) return skip("layer_a_not_removed");
			if (!att.bindingVerified) return skip("binding_not_verified");
			const branch = att.actualBranch;
			const headSha = att.headSha;
			if (!branch || !headSha) return skip("attestation_incomplete");

			const binding = deps.store.getWorktreeBinding(input.executionId);
			if (!binding || binding.branch !== branch) {
				return skip("binding_branch_mismatch", {
					attestationBranch: branch,
					bindingBranch: binding?.branch ?? null,
				});
			}

			const repoSlug = path.basename(projectRoot).toLowerCase();
			if (!isManagedBranchShape(repoSlug, branch))
				return skip("not_managed_shape");
			if (isBaseBranch(branch)) return skip("base_branch");
			if (isProtectedBranch(branch, policy.protectedBranches)) {
				return skip("protected_branch");
			}

			// Merge evidence bound to the EXACT attested head.
			const exec = deps.exec ?? defaultGitExec;
			const mergedHeads = await (deps.getMergedPrHeads ?? defaultMergedPrHeads)(
				projectRoot,
				branch,
			);
			let merged = mergedHeads?.has(headSha) ?? false;
			if (!merged) {
				const anc = await exec(
					[
						"-C",
						projectRoot,
						"merge-base",
						"--is-ancestor",
						headSha,
						"origin/main",
					],
					projectRoot,
				);
				merged = anc.code === 0;
			}
			if (!merged) return skip("no_merge_evidence", { headSha });

			const del = await casDeleteRemoteBranch({
				mainRepoPath: projectRoot,
				branch,
				expectedSha: headSha,
				exec: deps.exec,
			});
			if (del.deleted) {
				audit("ship_remote_branch_deleted", { branch, headSha });
			} else {
				skip(`remote_${del.reason}`, { branch, headSha, detail: del.detail });
			}
		} catch (err) {
			skip("exception", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	};
}

// ── Bundle (unmerged-tip archival before any delete) ─────────────────────

export async function bundleBranch(opts: {
	mainRepoPath: string;
	branch: string;
	expectedSha: string;
	outDir: string;
	exec?: GitExecFn;
	nowMs?: number;
}): Promise<{ ok: boolean; bundlePath?: string; error?: string }> {
	const exec = opts.exec ?? defaultGitExec;
	try {
		fs.mkdirSync(opts.outDir, { recursive: true, mode: 0o700 });
		const stamp = new Date(opts.nowMs ?? Date.now())
			.toISOString()
			.replace(/[:.]/g, "-");
		const safe = opts.branch.replace(/[^A-Za-z0-9._-]/g, "_");
		const bundlePath = path.join(opts.outDir, `${safe}-${stamp}.bundle`);

		const create = await exec(
			[
				"-C",
				opts.mainRepoPath,
				"bundle",
				"create",
				bundlePath,
				`refs/heads/${opts.branch}`,
			],
			opts.mainRepoPath,
		);
		if (create.code !== 0) {
			return { ok: false, error: `bundle_create_failed: ${create.stderr}` };
		}
		const verify = await exec(
			["-C", opts.mainRepoPath, "bundle", "verify", bundlePath],
			opts.mainRepoPath,
		);
		if (verify.code !== 0) {
			return { ok: false, error: `bundle_verify_failed: ${verify.stderr}` };
		}
		// The bundle must carry the EXPECTED tip, not whatever the ref moved to.
		const heads = await exec(
			["-C", opts.mainRepoPath, "bundle", "list-heads", bundlePath],
			opts.mainRepoPath,
		);
		if (heads.code !== 0 || !heads.stdout.includes(opts.expectedSha)) {
			return {
				ok: false,
				error: `bundle_head_mismatch: expected ${opts.expectedSha} in ${heads.stdout.trim()}`,
			};
		}
		return { ok: true, bundlePath };
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
}
