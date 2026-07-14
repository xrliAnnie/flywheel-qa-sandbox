/**
 * FLY-603 Layer A — on-merge worktree cleanup closure.
 *
 * Built once at the Bridge composition root and threaded into every
 * `runPostShipFinalization` call site (DES + the two /events paths) so the
 * cleanup capability reaches the HTTP event router, which has no
 * WorktreeManager of its own.
 *
 * DELETION CONTRACT (same as Layer B): never delete a worktree unless tmux
 * cleanup positively confirmed the runner is closed AND the tree is clean. Uses
 * the dirty-safe `git worktree remove` (no --force), never the forceful
 * `removeIfExists()`. Never throws (orchestrator stage contract).
 *
 * FLY-1185 §2.4 (R6#2): the closure now returns a structured PRE-DELETE
 * ATTESTATION — `{removed, actualBranch, headSha, branchDeleted,
 * bindingVerified, bindingBranch, bindingGeneration}` — captured INSIDE the
 * repo lock, BEFORE the removal (a `git worktree remove` instantly destroys
 * the admin generation marker, so post-ship consumers can never re-read it).
 * The remote-branch CAS delete consumes ONLY this attestation.
 *
 * Transition semantics pinned by R7:
 *   - session with NO binding → keep the existing session-scoped
 *     clean/registered-branch removal, but `bindingVerified:false`
 *     (→ immediate remote delete is skipped; the sweep owns the remainder);
 *   - session WITH a binding whose path/branch/generation does NOT match
 *     the live worktree → NO removal at all (`binding_mismatch`).
 */

import { execFile } from "node:child_process";
import {
	canonicalizeWorktreePath,
	deriveWorktreeKey,
	WorktreeManager,
} from "flywheel-edge-worker";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import { casDeleteLocalBranch } from "./branch-cleanup.js";
import type { WithRepoLock } from "./repo-mutation-lock.js";

/** FLY-603: `git status --porcelain` clean? `"unknown"` on probe error
 *  (fail-closed for deletion gates). Shared by Layer A + Layer B. */
export function gitWorktreeClean(
	worktreePath: string,
): Promise<boolean | "unknown"> {
	return new Promise((resolve) => {
		execFile(
			"git",
			["-C", worktreePath, "status", "--porcelain"],
			{ timeout: 15000 },
			(err, stdout) => {
				if (err) {
					resolve("unknown");
					return;
				}
				resolve(stdout.trim().length === 0);
			},
		);
	});
}

/** FLY-603: `FLYWHEEL_WORKTREE_AUTOCLEAN=0` disables both Layer A + Layer B
 *  (default on; byte-compat escape hatch). */
export function worktreeAutocleanEnabled(): boolean {
	return process.env.FLYWHEEL_WORKTREE_AUTOCLEAN !== "0";
}

export interface WorktreeCleanupInput {
	executionId: string;
	issueId: string;
	issueIdentifier?: string;
	projectName: string;
	/** From postMergeTmuxCleanup result — REQUIRED to be a positive close. */
	tmuxClosed: boolean;
	tmuxErrors?: string[];
}

/**
 * FLY-1185 §2.4 (R6#2): the structured pre-delete attestation. Captured
 * inside the repo lock BEFORE removal; the ship-time remote branch CAS
 * consumes exactly this — never a post-removal re-read.
 */
export interface WorktreeCleanupAttestation {
	removed: boolean;
	/** The ACTUAL registered branch at delete time. */
	actualBranch?: string;
	/** The worktree HEAD sha at delete time. */
	headSha?: string;
	branchDeleted?: boolean;
	/** True ONLY when path/branch/generation matched the persisted binding. */
	bindingVerified: boolean;
	bindingBranch?: string;
	bindingGeneration?: string;
	skippedReason?: string;
}

export interface WorktreeCleanupDeps {
	store: Pick<StateStore, "getSession" | "insertEvent" | "getWorktreeBinding">;
	worktreeManager: Pick<
		WorktreeManager,
		| "expectedWorktree"
		| "parseWorktreeKeyFromPath"
		| "getRegisteredWorktree"
		| "removeCleanWorktreeByPath"
		| "readWorktreeGeneration"
	>;
	/** project.projectRoot lookup by projectName. */
	resolveProjectRoot: (projectName: string) => string | undefined;
	/** `git status --porcelain` empty? `"unknown"` on probe error (fail-closed). */
	isWorktreeClean: (worktreePath: string) => Promise<boolean | "unknown">;
	/** FLYWHEEL_WORKTREE_AUTOCLEAN !== "0". */
	autoclean: boolean;
	/** FLY-1185 §2.11: repo mutation lock (re-entrant). Absent → unlocked. */
	withRepoLock?: WithRepoLock;
	/** Codex R1#9 test seam — the local-branch CAS delete primitive. */
	casDeleteLocalBranchFn?: typeof casDeleteLocalBranch;
}

export type WorktreeCleanupFn = (
	input: WorktreeCleanupInput,
) => Promise<WorktreeCleanupAttestation>;

const SKIPPED = (
	reason: string,
	extra: Partial<WorktreeCleanupAttestation> = {},
): WorktreeCleanupAttestation => ({
	removed: false,
	bindingVerified: false,
	skippedReason: reason,
	...extra,
});

export function makeWorktreeCleanup(
	deps: WorktreeCleanupDeps,
): WorktreeCleanupFn {
	const audit = (
		input: WorktreeCleanupInput,
		eventType: string,
		payload: Record<string, unknown>,
	) => {
		deps.store.insertEvent({
			event_id: `worktree-cleanup-${input.executionId}-${eventType}`,
			execution_id: input.executionId,
			issue_id: input.issueId,
			project_name: input.projectName,
			event_type: eventType,
			source: "bridge.worktree-cleanup",
			payload,
		});
	};

	return async (input) => {
		try {
			if (!deps.autoclean) return SKIPPED("autoclean_disabled");

			// (1) positive-live guard. postMergeTmuxCleanup returns
			// {tmuxClosed:false, errors:[]} when there was no tmux target — that is
			// NOT proof the runner is gone. Require a positive close.
			if (input.tmuxClosed !== true || (input.tmuxErrors?.length ?? 0) > 0) {
				audit(input, "worktree_cleanup_skipped", {
					reason: "tmux_not_confirmed_closed",
					tmuxClosed: input.tmuxClosed,
				});
				return SKIPPED("tmux_not_confirmed_closed");
			}

			const projectRoot = deps.resolveProjectRoot(input.projectName);
			if (!projectRoot) {
				audit(input, "worktree_cleanup_skipped", { reason: "no_project_root" });
				return SKIPPED("no_project_root");
			}

			const run = async (): Promise<WorktreeCleanupAttestation> => {
				const session = deps.store.getSession(input.executionId);

				// (2) target resolution — persisted worktree_path is authoritative.
				let worktreePath = session?.worktree_path || "";
				let branch: string | null = session?.branch ?? null;
				if (!worktreePath) {
					const ident =
						input.issueIdentifier ??
						session?.issue_identifier ??
						session?.issue_id;
					if (!ident) {
						audit(input, "worktree_cleanup_skipped", { reason: "no_target" });
						return SKIPPED("no_target");
					}
					const key = deriveWorktreeKey(ident, session?.session_role);
					const ew = deps.worktreeManager.expectedWorktree(
						projectRoot,
						input.projectName,
						key,
					);
					worktreePath = ew.path;
					branch = ew.branch;
				}

				// (3) path-guard — must parse to a valid project worktree key.
				const key = deps.worktreeManager.parseWorktreeKeyFromPath(
					projectRoot,
					input.projectName,
					worktreePath,
				);
				if (!key) {
					audit(input, "worktree_cleanup_skipped", {
						reason: "path_mismatch",
						worktreePath,
					});
					return SKIPPED("path_mismatch");
				}

				// (3b) registered-worktree validation (Codex code-review R1 HIGH-2):
				// resolve the ACTUAL registered worktree at this exact path and refuse
				// to delete if it is not registered, branchless, detached, or its real
				// branch is not the project-derived branch we expect. Never invent a
				// branch and remove on faith.
				const reg = await deps.worktreeManager.getRegisteredWorktree(
					projectRoot,
					worktreePath,
				);
				const expectedBranch = deps.worktreeManager.expectedWorktree(
					projectRoot,
					input.projectName,
					key,
				).branch;
				if (!reg) {
					audit(input, "worktree_cleanup_skipped", {
						reason: "not_registered",
						worktreePath,
					});
					return SKIPPED("not_registered");
				}
				if (!reg.branch || reg.isDetached) {
					audit(input, "worktree_cleanup_skipped", {
						reason: "branchless_or_detached",
						worktreePath,
					});
					return SKIPPED("branchless_or_detached");
				}
				if (reg.branch !== expectedBranch) {
					audit(input, "worktree_cleanup_skipped", {
						reason: "branch_mismatch",
						worktreePath,
						registeredBranch: reg.branch,
						expectedBranch,
					});
					return SKIPPED("branch_mismatch");
				}
				branch = reg.branch; // delete the ACTUAL registered branch
				// FLY-793 (824 R2 E2E): probe + remove by the ACTUAL registered path.
				// git reports symlink-resolved paths (e.g. /private/tmp/... for a
				// session stored as /tmp/...), so use its own canonical path for both
				// the clean-probe and `git worktree remove` rather than relying on git
				// to re-resolve ours. Parallel to `branch = reg.branch` above.
				const registeredPath = reg.path;

				// (3c) FLY-1185 §2.1: fresh binding verification INSIDE the lock,
				// BEFORE removal. Four-way agreement → bindingVerified:true; a
				// binding that exists but DISAGREES → no removal at all (R7);
				// no binding → legacy removal path with bindingVerified:false.
				const binding = deps.store.getWorktreeBinding(input.executionId);
				let bindingVerified = false;
				if (binding) {
					const pathMatch =
						canonicalizeWorktreePath(binding.path) ===
						canonicalizeWorktreePath(registeredPath);
					const branchMatch = binding.branch === reg.branch;
					let generationMatch = false;
					if (pathMatch && branchMatch) {
						const marker =
							await deps.worktreeManager.readWorktreeGeneration(registeredPath);
						generationMatch = !!marker && marker === binding.generation;
					}
					if (!pathMatch || !branchMatch || !generationMatch) {
						audit(input, "worktree_cleanup_skipped", {
							reason: "binding_mismatch",
							worktreePath: registeredPath,
							bindingPath: binding.path,
							bindingBranch: binding.branch,
							registeredBranch: reg.branch,
						});
						return SKIPPED("binding_mismatch", {
							bindingBranch: binding.branch,
							bindingGeneration: binding.generation,
						});
					}
					bindingVerified = true;
				}

				// (4) clean-guard — fail-closed on probe error.
				const clean = await deps.isWorktreeClean(registeredPath);
				if (clean !== true) {
					audit(input, "worktree_cleanup_skipped", {
						reason: clean === "unknown" ? "clean_unknown" : "dirty",
						worktreePath,
					});
					return SKIPPED(clean === "unknown" ? "clean_unknown" : "dirty", {
						bindingVerified,
						bindingBranch: binding?.branch,
						bindingGeneration: binding?.generation,
					});
				}

				// Capture the attestation facts BEFORE removal destroys the marker.
				const headSha = reg.head ?? undefined;

				// (5) dirty-safe removal — WORKTREE ONLY (branch passed as null).
				// Codex R1#9: the local ref is deleted below via the CAS primitive
				// (`update-ref -d <ref> <attested-sha>`), never a bare `branch -D`
				// that would follow a concurrently-moved tip.
				const res = await deps.worktreeManager.removeCleanWorktreeByPath(
					projectRoot,
					registeredPath,
					null,
				);

				// (5b) local branch CAS delete against the ATTESTED head — inside
				// the same repo lock. Missing head → leave the ref to the sweep.
				let branchDeleted = false;
				let branchDeleteReason: string | undefined;
				if (res.removed && branch && headSha) {
					const del = await (
						deps.casDeleteLocalBranchFn ?? casDeleteLocalBranch
					)({
						mainRepoPath: projectRoot,
						branch,
						expectedSha: headSha,
					});
					branchDeleted = del.deleted;
					if (!del.deleted) branchDeleteReason = del.reason;
				} else if (res.removed && branch && !headSha) {
					branchDeleteReason = "no_attested_head";
				}

				audit(
					input,
					res.removed ? "worktree_cleanup_done" : "worktree_cleanup_failed",
					{
						worktreePath,
						branch,
						branchDeleted,
						branchDeleteReason: branchDeleteReason ?? null,
						bindingVerified,
						headSha: headSha ?? null,
						error: res.error,
					},
				);
				return {
					removed: res.removed,
					actualBranch: branch ?? undefined,
					headSha,
					branchDeleted,
					bindingVerified,
					bindingBranch: binding?.branch,
					bindingGeneration: binding?.generation,
					skippedReason: res.removed ? undefined : `remove_failed:${res.error}`,
				};
			};

			return deps.withRepoLock
				? await deps.withRepoLock(projectRoot, run)
				: await run();
		} catch (err) {
			// Never throw — orchestrator stage contract.
			audit(input, "worktree_cleanup_failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			return SKIPPED(
				`exception:${err instanceof Error ? err.message : String(err)}`,
			);
		}
	};
}

/**
 * FLY-603: Compose the production Layer A cleanup closure at the Bridge root.
 * WorktreeManager is stateless, so a fresh instance here is fine (no need to
 * share run-infra's). Built once and threaded to all three finalization call
 * sites (DES + the two /events paths).
 */
export function makeBridgeWorktreeCleanup(
	store: StateStore,
	projects: ProjectEntry[],
	withRepoLock?: WithRepoLock,
): WorktreeCleanupFn {
	const worktreeManager = new WorktreeManager(
		withRepoLock ? { withRepoLock } : undefined,
	);
	return makeWorktreeCleanup({
		store,
		worktreeManager,
		resolveProjectRoot: (projectName) =>
			projects.find((p) => p.projectName === projectName)?.projectRoot,
		isWorktreeClean: gitWorktreeClean,
		autoclean: worktreeAutocleanEnabled(),
		withRepoLock,
	});
}
