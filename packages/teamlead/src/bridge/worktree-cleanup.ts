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
 */

import { execFile } from "node:child_process";
import { deriveWorktreeKey, WorktreeManager } from "flywheel-edge-worker";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";

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

export interface WorktreeCleanupDeps {
	store: Pick<StateStore, "getSession" | "insertEvent">;
	worktreeManager: Pick<
		WorktreeManager,
		| "expectedWorktree"
		| "parseWorktreeKeyFromPath"
		| "getRegisteredWorktree"
		| "removeCleanWorktreeByPath"
	>;
	/** project.projectRoot lookup by projectName. */
	resolveProjectRoot: (projectName: string) => string | undefined;
	/** `git status --porcelain` empty? `"unknown"` on probe error (fail-closed). */
	isWorktreeClean: (worktreePath: string) => Promise<boolean | "unknown">;
	/** FLYWHEEL_WORKTREE_AUTOCLEAN !== "0". */
	autoclean: boolean;
}

export type WorktreeCleanupFn = (input: WorktreeCleanupInput) => Promise<void>;

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
			if (!deps.autoclean) return;

			// (1) positive-live guard. postMergeTmuxCleanup returns
			// {tmuxClosed:false, errors:[]} when there was no tmux target — that is
			// NOT proof the runner is gone. Require a positive close.
			if (input.tmuxClosed !== true || (input.tmuxErrors?.length ?? 0) > 0) {
				audit(input, "worktree_cleanup_skipped", {
					reason: "tmux_not_confirmed_closed",
					tmuxClosed: input.tmuxClosed,
				});
				return;
			}

			const projectRoot = deps.resolveProjectRoot(input.projectName);
			if (!projectRoot) {
				audit(input, "worktree_cleanup_skipped", { reason: "no_project_root" });
				return;
			}

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
					return;
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
				return;
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
				return;
			}
			if (!reg.branch || reg.isDetached) {
				audit(input, "worktree_cleanup_skipped", {
					reason: "branchless_or_detached",
					worktreePath,
				});
				return;
			}
			if (reg.branch !== expectedBranch) {
				audit(input, "worktree_cleanup_skipped", {
					reason: "branch_mismatch",
					worktreePath,
					registeredBranch: reg.branch,
					expectedBranch,
				});
				return;
			}
			branch = reg.branch; // delete the ACTUAL registered branch

			// (4) clean-guard — fail-closed on probe error.
			const clean = await deps.isWorktreeClean(worktreePath);
			if (clean !== true) {
				audit(input, "worktree_cleanup_skipped", {
					reason: clean === "unknown" ? "clean_unknown" : "dirty",
					worktreePath,
				});
				return;
			}

			// (5) dirty-safe removal.
			const res = await deps.worktreeManager.removeCleanWorktreeByPath(
				projectRoot,
				worktreePath,
				branch,
			);
			audit(
				input,
				res.removed ? "worktree_cleanup_done" : "worktree_cleanup_failed",
				{
					worktreePath,
					branch,
					branchDeleted: res.branchDeleted,
					error: res.error,
				},
			);
		} catch (err) {
			// Never throw — orchestrator stage contract.
			audit(input, "worktree_cleanup_failed", {
				error: err instanceof Error ? err.message : String(err),
			});
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
): WorktreeCleanupFn {
	const worktreeManager = new WorktreeManager();
	return makeWorktreeCleanup({
		store,
		worktreeManager,
		resolveProjectRoot: (projectName) =>
			projects.find((p) => p.projectName === projectName)?.projectRoot,
		isWorktreeClean: gitWorktreeClean,
		autoclean: worktreeAutocleanEnabled(),
	});
}
