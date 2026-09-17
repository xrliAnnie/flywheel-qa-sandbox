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
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalSubmissionDigest } from "flywheel-config";
import {
	canonicalizeWorktreePath,
	deriveWorktreeKey,
	isReapIncomplete,
	WorktreeManager,
	type WorktreeReapRecord,
} from "flywheel-edge-worker";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import {
	casDeleteLocalBranch,
	isBaseBranch,
	isProtectedBranch,
} from "./branch-cleanup.js";
import { type CleanupPolicyByProject, policyFor } from "./cleanup-policy.js";
import {
	type WorktreeFailure,
	worktreeFailureFromSkippedReason,
} from "./land-closeout-cause.js";
import type { BoundWorktreeCloseoutTarget } from "./land-intent-targets.js";
import {
	type LandOperationAuditIdentity,
	recordLandCloseoutAudit,
} from "./land-operation-audit.js";
import {
	type BranchCoverage,
	type MergedWorktreeProof,
	verifyMergedBranchCoverage,
} from "./merged-worktree-proof.js";
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

function gitBranchNameValid(
	projectRoot: string,
	branch: string,
): Promise<boolean> {
	return new Promise((resolve) => {
		execFile(
			"git",
			["-C", projectRoot, "check-ref-format", "--branch", branch],
			{ timeout: 15_000 },
			(error) => resolve(!error),
		);
	});
}

/** FLY-603: worktree autoclean is permanently enabled in production. */
export function worktreeAutocleanEnabled(): boolean {
	return true;
}

interface WorktreeCleanupCommonInput {
	issueId: string;
	issueIdentifier?: string;
	projectName: string;
	/** From postMergeTmuxCleanup result — REQUIRED to be a positive close. */
	tmuxClosed: boolean;
	tmuxErrors?: string[];
}

export type WorktreeCleanupInput = WorktreeCleanupCommonInput &
	(
		| { executionId: string; operationContext?: never }
		| {
				executionId?: never;
				operationContext: {
					operationAudit: LandOperationAuditIdentity;
					target: BoundWorktreeCloseoutTarget;
					mergedWorktreeProof?: MergedWorktreeProof;
				};
		  }
	);

/**
 * FLY-1185 §2.4 (R6#2): the structured pre-delete attestation. Captured
 * inside the repo lock BEFORE removal; the ship-time remote branch CAS
 * consumes exactly this — never a post-removal re-read.
 */
export interface WorktreeCleanupAttestation {
	removed: boolean;
	cleanupState?: "removed" | "absent" | "blocked";
	/** The ACTUAL registered branch at delete time. */
	actualBranch?: string;
	/** The worktree HEAD sha at delete time. */
	headSha?: string;
	branchDeleted?: boolean;
	branchDeleteReason?: string;
	verificationMode?: "derived_branch" | "merged_branch_verified";
	mergeProof?: Extract<BranchCoverage, { ok: true }>;
	/** True ONLY when path/branch/generation matched the persisted binding. */
	bindingVerified: boolean;
	bindingBranch?: string;
	bindingGeneration?: string;
	skippedReason?: string;
	failure?: { token: WorktreeFailure; detail?: string };
	absentEvidence?: {
		path: string;
		observedAt: string;
		bindingGeneration: string;
		operationId: string;
	};
	/** FLY-1759: pre-delete process census/reap evidence. */
	reaps?: WorktreeReapRecord[];
}

export interface WorktreeCleanupDeps {
	store: Pick<
		StateStore,
		| "getSession"
		| "insertEvent"
		| "getWorktreeBinding"
		| "getLandOperation"
		| "recordLandOperationStep"
	> &
		Partial<Pick<StateStore, "listLandOperationSteps">>;
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
	/** Generic test/integration seam; production always supplies true. */
	autoclean: boolean;
	/** FLY-1185 §2.11: repo mutation lock (re-entrant). Absent → unlocked. */
	withRepoLock?: WithRepoLock;
	/** Codex R1#9 test seam — the local-branch CAS delete primitive. */
	casDeleteLocalBranchFn?: typeof casDeleteLocalBranch;
	realpath?: typeof realpath;
	lstat?: typeof lstat;
	protectedBranchesForProject?: (
		projectName: string,
	) => readonly string[] | undefined;
	verifyMergedBranchCoverageFn?: typeof verifyMergedBranchCoverage;
	isBranchNameValid?: typeof gitBranchNameValid;
	isOperationAuthorityCurrent?: (
		identity: LandOperationAuditIdentity,
	) => boolean;
}

export type WorktreeCleanupFn = (
	input: WorktreeCleanupInput,
) => Promise<WorktreeCleanupAttestation>;

const SKIPPED = (
	reason: string,
	extra: Partial<WorktreeCleanupAttestation> = {},
): WorktreeCleanupAttestation => ({
	removed: false,
	cleanupState: "blocked",
	bindingVerified: false,
	skippedReason: reason,
	failure: {
		token: worktreeFailureFromSkippedReason(reason),
		detail: reason,
	},
	...extra,
});

export function makeWorktreeCleanup(
	deps: WorktreeCleanupDeps,
): WorktreeCleanupFn {
	const audit = (
		input: WorktreeCleanupInput,
		eventType: string,
		payload: Record<string, unknown>,
		eventKey = eventType,
	): boolean => {
		if (input.operationContext) {
			return recordLandCloseoutAudit(
				deps.store,
				input.operationContext.operationAudit,
				{
					evidenceId: `worktree:${canonicalSubmissionDigest({
						path: input.operationContext.target.path,
						eventKey,
						payload,
					})}`,
					eventKind: eventType,
					receipt: {
						issueId: input.issueId,
						projectName: input.projectName,
						...payload,
					},
				},
			).ok;
		}
		deps.store.insertEvent({
			event_id: `worktree-cleanup-${input.executionId!}-${eventKey}`,
			execution_id: input.executionId!,
			issue_id: input.issueId,
			project_name: input.projectName,
			event_type: eventType,
			source: "bridge.worktree-cleanup",
			payload,
		});
		// Legacy session-event insertion is idempotent: false can mean the
		// stable event id was already recorded by an earlier attempt.
		return true;
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
				const session = input.operationContext
					? undefined
					: deps.store.getSession(input.executionId!);
				const operationTarget = input.operationContext?.target;
				const realpathFn = deps.realpath ?? realpath;
				const lstatFn = deps.lstat ?? lstat;
				const resumePreparedCleanup = async (): Promise<
					WorktreeCleanupAttestation | undefined
				> => {
					const context = input.operationContext;
					const listSteps = deps.store.listLandOperationSteps;
					if (!context || !listSteps) return undefined;
					const proof = context.mergedWorktreeProof;
					if (!proof) return undefined;
					const prepared = listSteps
						.call(deps.store, context.operationAudit.operationId)
						.map((step) => step.receipt)
						.find(
							(receipt) =>
								receipt.eventKind === "worktree_cleanup_prepared" &&
								receipt.reason === "merged_branch_verified" &&
								receipt.worktreePath === context.target.path &&
								receipt.bindingGeneration === context.target.generation &&
								receipt.mergeSha === proof.mergeSha &&
								receipt.mergedPrHead === proof.mergedPrHead,
						);
					if (!prepared) return undefined;
					const actualBranch =
						typeof prepared.registeredBranch === "string"
							? prepared.registeredBranch
							: undefined;
					const headSha =
						typeof prepared.headSha === "string" ? prepared.headSha : undefined;
					const coverage =
						prepared.coverage === "exact_pr_head" ||
						prepared.coverage === "ancestor_of_main"
							? prepared.coverage
							: undefined;
					const protectedBranches = deps.protectedBranchesForProject?.(
						input.projectName,
					);
					if (
						!actualBranch ||
						!headSha ||
						!coverage ||
						!protectedBranches ||
						isBaseBranch(actualBranch) ||
						isProtectedBranch(actualBranch, protectedBranches) ||
						!(await (deps.isBranchNameValid ?? gitBranchNameValid)(
							projectRoot,
							actualBranch,
						)) ||
						deps.isOperationAuthorityCurrent?.(context.operationAudit) !== true
					) {
						return SKIPPED("remove_failed:prepared_recovery_unavailable", {
							removed: true,
							actualBranch,
							headSha,
							verificationMode: "merged_branch_verified",
						});
					}
					const registered = await deps.worktreeManager.getRegisteredWorktree(
						projectRoot,
						context.target.path,
					);
					if (registered) {
						return SKIPPED("remove_failed:path_reappeared", {
							actualBranch,
							headSha,
							verificationMode: "merged_branch_verified",
						});
					}
					const deleted = await (
						deps.casDeleteLocalBranchFn ?? casDeleteLocalBranch
					)({
						mainRepoPath: projectRoot,
						branch: actualBranch,
						expectedSha: headSha,
					});
					const branchDeleted =
						deleted.deleted ||
						(!deleted.deleted && deleted.reason === "branch_missing");
					const branchDeleteReason = deleted.deleted
						? undefined
						: deleted.reason;
					const mergeProof: Extract<BranchCoverage, { ok: true }> =
						coverage === "exact_pr_head"
							? { ok: true, via: coverage }
							: {
									ok: true,
									via: coverage,
									...(typeof prepared.mainSha === "string"
										? { mainSha: prepared.mainSha }
										: {}),
								};
					const recorded = audit(
						input,
						branchDeleted
							? "worktree_cleanup_branch_deleted"
							: "worktree_cleanup_failed",
						{
							reason: branchDeleted ? "prepared_recovery" : "remove_failed",
							worktreePath: context.target.path,
							branch: actualBranch,
							headSha,
							branchDeleted,
							branchDeleteReason: branchDeleteReason ?? null,
						},
						`prepared-recovery-${context.target.generation}`,
					);
					if (!branchDeleted || !recorded) {
						return SKIPPED(
							`remove_failed:${
								!recorded
									? "operation_audit_unavailable"
									: (branchDeleteReason ?? "branch_delete_failed")
							}`,
							{
								removed: true,
								actualBranch,
								headSha,
								branchDeleted,
								branchDeleteReason,
								verificationMode: "merged_branch_verified",
								mergeProof,
							},
						);
					}
					return {
						removed: true,
						cleanupState: "removed",
						actualBranch,
						headSha,
						branchDeleted: true,
						branchDeleteReason,
						verificationMode: "merged_branch_verified",
						mergeProof,
						bindingVerified: false,
						bindingBranch: context.target.branch,
						bindingGeneration: context.target.generation,
					};
				};

				// (2) target resolution — persisted worktree_path is authoritative.
				let worktreePath =
					operationTarget?.path ?? session?.worktree_path ?? "";
				let branch: string | null =
					operationTarget?.branch ?? session?.branch ?? null;
				if (operationTarget) {
					if (
						operationTarget.projectRoot !== projectRoot ||
						operationTarget.parentIdentity.path !==
							dirname(operationTarget.path) ||
						dirname(operationTarget.projectRoot) !==
							operationTarget.parentIdentity.path
					) {
						audit(input, "worktree_cleanup_skipped", {
							reason: "operation_target_scope_mismatch",
							worktreePath,
						});
						return SKIPPED("operation_target_scope_mismatch");
					}
					let canonicalRoot: string;
					let canonicalParent: string;
					try {
						[canonicalRoot, canonicalParent] = await Promise.all([
							realpathFn(projectRoot),
							realpathFn(operationTarget.parentIdentity.path),
						]);
					} catch {
						audit(input, "worktree_cleanup_skipped", {
							reason: "parent_unavailable",
							worktreePath,
						});
						return SKIPPED("parent_unavailable");
					}
					if (
						canonicalRoot !== operationTarget.projectRoot ||
						canonicalParent !== operationTarget.parentIdentity.path
					) {
						audit(input, "worktree_cleanup_skipped", {
							reason: "parent_identity_mismatch",
							worktreePath,
						});
						return SKIPPED("parent_identity_mismatch");
					}
					let parentStat: Awaited<ReturnType<typeof lstat>>;
					let rootStat: Awaited<ReturnType<typeof lstat>>;
					try {
						[parentStat, rootStat] = await Promise.all([
							lstatFn(operationTarget.parentIdentity.path),
							lstatFn(projectRoot),
						]);
					} catch {
						audit(input, "worktree_cleanup_skipped", {
							reason: "parent_unavailable",
							worktreePath,
						});
						return SKIPPED("parent_unavailable");
					}
					if (
						parentStat.isSymbolicLink() ||
						!parentStat.isDirectory() ||
						rootStat.isSymbolicLink() ||
						!rootStat.isDirectory() ||
						Number(parentStat.dev) !== operationTarget.parentIdentity.dev ||
						Number(parentStat.ino) !== operationTarget.parentIdentity.ino ||
						Number(rootStat.dev) !== Number(parentStat.dev)
					) {
						audit(input, "worktree_cleanup_skipped", {
							reason: "parent_identity_mismatch",
							worktreePath,
						});
						return SKIPPED("parent_identity_mismatch");
					}
					if (
						!audit(
							input,
							"worktree_cleanup_probe",
							{
								worktreePath,
								bindingGeneration: operationTarget.generation,
							},
							`probe-${operationTarget.generation}`,
						)
					) {
						return SKIPPED("operation_audit_unavailable");
					}
					try {
						const leaf = await lstatFn(operationTarget.path);
						if (leaf.isSymbolicLink() || !leaf.isDirectory()) {
							audit(input, "worktree_cleanup_skipped", {
								reason: "leaf_identity_mismatch",
								worktreePath,
							});
							return SKIPPED("leaf_identity_mismatch");
						}
						if (
							(await realpathFn(operationTarget.path)) !== operationTarget.path
						) {
							audit(input, "worktree_cleanup_skipped", {
								reason: "leaf_identity_mismatch",
								worktreePath,
							});
							return SKIPPED("leaf_identity_mismatch");
						}
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") {
							const recovered = await resumePreparedCleanup();
							if (recovered) return recovered;
							const observedAt = new Date().toISOString();
							const absentEvidence = {
								path: operationTarget.path,
								observedAt,
								bindingGeneration: operationTarget.generation,
								operationId: input.operationContext!.operationAudit.operationId,
							};
							if (!audit(input, "worktree_cleanup_absent", absentEvidence)) {
								return SKIPPED("operation_audit_unavailable");
							}
							return {
								removed: false,
								cleanupState: "absent",
								bindingVerified: false,
								bindingBranch: operationTarget.branch,
								bindingGeneration: operationTarget.generation,
								absentEvidence,
							};
						}
						audit(input, "worktree_cleanup_skipped", {
							reason: "leaf_unavailable",
							worktreePath,
						});
						return SKIPPED("leaf_unavailable");
					}
				}
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
					try {
						await lstatFn(worktreePath);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") {
							const recovered = await resumePreparedCleanup();
							if (recovered) return recovered;
							const observedAt = new Date().toISOString();
							audit(input, "worktree_cleanup_absent", {
								worktreePath,
								observedAt,
							});
							return {
								removed: false,
								cleanupState: "absent",
								bindingVerified: false,
							};
						}
						audit(input, "worktree_cleanup_skipped", {
							reason: "leaf_unavailable",
							worktreePath,
						});
						return SKIPPED("leaf_unavailable");
					}
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
				const binding = operationTarget
					? {
							path: operationTarget.path,
							branch: operationTarget.branch,
							generation: operationTarget.generation,
						}
					: deps.store.getWorktreeBinding(input.executionId!);
				let bindingVerified = false;
				let pathMatch = false;
				let generationMatch = false;
				if (binding) {
					pathMatch =
						canonicalizeWorktreePath(binding.path) ===
						canonicalizeWorktreePath(registeredPath);
					const branchMatch = binding.branch === reg.branch;
					if (pathMatch) {
						const marker =
							await deps.worktreeManager.readWorktreeGeneration(registeredPath);
						generationMatch = !!marker && marker === binding.generation;
					}
					if (!pathMatch || !generationMatch) {
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
					bindingVerified = branchMatch;
				}

				const legacyNamesMatch =
					reg.branch === expectedBranch &&
					(!operationTarget || reg.branch === operationTarget.branch) &&
					(!binding || reg.branch === binding.branch);
				let verificationMode: WorktreeCleanupAttestation["verificationMode"] =
					"derived_branch";
				let mergeProof: Extract<BranchCoverage, { ok: true }> | undefined;
				if (!legacyNamesMatch) {
					const proof = input.operationContext?.mergedWorktreeProof;
					const protectedBranches = deps.protectedBranchesForProject?.(
						input.projectName,
					);
					const authorityCurrent =
						input.operationContext && deps.isOperationAuthorityCurrent
							? deps.isOperationAuthorityCurrent(
									input.operationContext.operationAudit,
								)
							: false;
					if (
						!input.operationContext ||
						!operationTarget ||
						!proof ||
						!deps.withRepoLock ||
						!authorityCurrent ||
						!protectedBranches ||
						!(await (deps.isBranchNameValid ?? gitBranchNameValid)(
							projectRoot,
							reg.branch,
						))
					) {
						audit(input, "worktree_cleanup_skipped", {
							reason: "branch_mismatch",
							worktreePath,
							registeredBranch: reg.branch,
							expectedBranch,
							detail: "merged_proof_unavailable",
						});
						return SKIPPED("branch_mismatch");
					}
					const coverage = await (
						deps.verifyMergedBranchCoverageFn ?? verifyMergedBranchCoverage
					)({
						proof,
						projectRoot,
						registeredBranch: reg.branch,
						registeredHead: reg.head ?? "",
						protectedBranches,
					});
					if (!coverage.ok) {
						audit(input, "worktree_cleanup_skipped", {
							reason: "branch_mismatch",
							worktreePath,
							registeredBranch: reg.branch,
							expectedBranch,
							detail: coverage.detail,
						});
						return SKIPPED("branch_mismatch");
					}
					verificationMode = "merged_branch_verified";
					mergeProof = coverage;
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
						verificationMode,
						mergeProof,
					});
				}

				// Capture the attestation facts BEFORE removal destroys the marker.
				const headSha = reg.head ?? undefined;
				if (verificationMode === "merged_branch_verified") {
					const authorityCurrent = deps.isOperationAuthorityCurrent?.(
						input.operationContext!.operationAudit,
					);
					const [fresh, marker, freshClean] = await Promise.all([
						deps.worktreeManager.getRegisteredWorktree(
							projectRoot,
							registeredPath,
						),
						deps.worktreeManager.readWorktreeGeneration(registeredPath),
						deps.isWorktreeClean(registeredPath),
					]);
					if (
						authorityCurrent !== true ||
						!fresh ||
						fresh.isDetached ||
						fresh.path !== registeredPath ||
						fresh.branch !== reg.branch ||
						fresh.head !== reg.head
					) {
						audit(input, "worktree_cleanup_skipped", {
							reason: "branch_mismatch",
							worktreePath: registeredPath,
							detail: "pre_remove_identity_changed",
						});
						return SKIPPED("branch_mismatch");
					}
					if (marker !== binding?.generation) {
						return SKIPPED("binding_mismatch", {
							bindingBranch: binding?.branch,
							bindingGeneration: binding?.generation,
						});
					}
					if (freshClean !== true) {
						return SKIPPED(
							freshClean === "unknown" ? "clean_unknown" : "dirty",
							{
								bindingVerified,
								bindingBranch: binding?.branch,
								bindingGeneration: binding?.generation,
								verificationMode,
								mergeProof,
							},
						);
					}
					const proof = input.operationContext!.mergedWorktreeProof!;
					if (
						!audit(input, "worktree_cleanup_prepared", {
							reason: "merged_branch_verified",
							worktreePath: registeredPath,
							registeredBranch: reg.branch,
							expectedBranch,
							mergeSha: proof.mergeSha,
							mergedPrHead: proof.mergedPrHead,
							coverage: mergeProof?.via,
							mainSha: mergeProof?.mainSha ?? null,
							headSha: headSha ?? null,
							bindingGeneration: binding?.generation,
						})
					) {
						return SKIPPED("operation_audit_unavailable");
					}
				}

				// (5) dirty-safe removal — WORKTREE ONLY (branch passed as null).
				// Codex R1#9: the local ref is deleted below via the CAS primitive
				// (`update-ref -d <ref> <attested-sha>`), never a bare `branch -D`
				// that would follow a concurrently-moved tip.
				const res = await deps.worktreeManager.removeCleanWorktreeByPath(
					projectRoot,
					registeredPath,
					null,
				);
				let directoryRemovalVerified = res.removed;
				if (verificationMode === "merged_branch_verified" && res.removed) {
					let pathAbsent = false;
					try {
						await lstatFn(registeredPath);
					} catch (error) {
						pathAbsent = (error as NodeJS.ErrnoException).code === "ENOENT";
					}
					try {
						const registeredAfter =
							await deps.worktreeManager.getRegisteredWorktree(
								projectRoot,
								registeredPath,
							);
						directoryRemovalVerified = pathAbsent && !registeredAfter;
					} catch {
						directoryRemovalVerified = false;
					}
				}
				for (const reap of res.reaps ?? []) {
					if (!isReapIncomplete(reap.summary)) continue;
					const pathHash = createHash("sha256")
						.update(reap.path)
						.digest("hex")
						.slice(0, 16);
					audit(
						input,
						"worktree_reap_incomplete",
						{
							worktreePath: registeredPath,
							path: reap.path,
							summary: reap.summary,
						},
						`worktree_reap_incomplete-${pathHash}`,
					);
				}

				// (5b) local branch CAS delete against the ATTESTED head — inside
				// the same repo lock. Missing head → leave the ref to the sweep.
				let branchDeleted = false;
				let branchDeleteReason: string | undefined;
				if (directoryRemovalVerified && branch && headSha) {
					const del = await (
						deps.casDeleteLocalBranchFn ?? casDeleteLocalBranch
					)({
						mainRepoPath: projectRoot,
						branch,
						expectedSha: headSha,
					});
					branchDeleted = del.deleted;
					if (!del.deleted) branchDeleteReason = del.reason;
				} else if (directoryRemovalVerified && branch && !headSha) {
					branchDeleteReason = "no_attested_head";
				}
				if (res.removed && !directoryRemovalVerified) {
					branchDeleteReason = "remove_readback_failed";
				}
				const cleanupComplete =
					directoryRemovalVerified &&
					(verificationMode !== "merged_branch_verified" || branchDeleted);
				const skippedReason = cleanupComplete
					? undefined
					: `remove_failed:${
							branchDeleteReason ?? res.error ?? "worktree_remove_failed"
						}`;

				const outcomeRecorded = audit(
					input,
					cleanupComplete ? "worktree_cleanup_done" : "worktree_cleanup_failed",
					{
						worktreePath,
						branch,
						branchDeleted,
						branchDeleteReason: branchDeleteReason ?? null,
						bindingVerified,
						verificationMode,
						mergeProof,
						headSha: headSha ?? null,
						error: res.error,
						reaps: res.reaps ?? [],
					},
				);
				if (input.operationContext && !outcomeRecorded) {
					return SKIPPED("operation_audit_unavailable", {
						bindingBranch: binding?.branch,
						bindingGeneration: binding?.generation,
					});
				}
				return {
					removed: directoryRemovalVerified,
					cleanupState: cleanupComplete ? "removed" : "blocked",
					actualBranch: branch ?? undefined,
					headSha,
					branchDeleted,
					branchDeleteReason,
					bindingVerified,
					bindingBranch: binding?.branch,
					bindingGeneration: binding?.generation,
					verificationMode,
					mergeProof,
					skippedReason,
					...(skippedReason
						? {
								failure: {
									token: worktreeFailureFromSkippedReason(skippedReason),
									detail: skippedReason,
								},
							}
						: {}),
					reaps: res.reaps,
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
	policies?: CleanupPolicyByProject,
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
		protectedBranchesForProject: (projectName) => {
			const policy = policyFor(policies, projectName);
			return policy.enabled ? policy.protectedBranches : undefined;
		},
		isOperationAuthorityCurrent: (identity) => {
			const operation = store.getLandOperation(identity.operationId);
			return Boolean(
				operation &&
					operation.state === "running" &&
					!operation.superseded_at &&
					operation.owner_id === identity.ownerId &&
					operation.generation === identity.generation &&
					operation.run_id === identity.runId &&
					operation.lease_expires_at &&
					operation.lease_expires_at > new Date().toISOString(),
			);
		},
	});
}
