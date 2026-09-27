import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { dirname } from "node:path";
import type { WorktreeManager } from "flywheel-edge-worker";
import type { ApplyEffectClaimInput, StateStore } from "../StateStore.js";
import type { WithRepoLock } from "./repo-mutation-lock.js";
import type {
	buildStockCleanupPreview,
	StockCleanupManifest,
	StockCleanupManifestTarget,
} from "./stock-worktree-cleanup.js";

export interface StockCleanupExecutionItem {
	canonicalPath: string;
	status: "removed" | "recovered_absent" | "rejected";
	reason?: string;
}

export interface StockCleanupExecutionResult {
	requestId: string;
	manifestDigest: string;
	projectName: string;
	status: "applied" | "partial";
	items: StockCleanupExecutionItem[];
}

type PreviewResult = ReturnType<typeof buildStockCleanupPreview>;

export interface StockCleanupExecutorDeps {
	store: Pick<
		StateStore,
		"claimApplyEffect" | "casApplyEffect" | "getApplyEffect"
	>;
	projectRoot(projectName: string): string | undefined;
	preview(input: {
		projectName: string;
		actor: string;
		authorityCheck: () => void | Promise<void>;
	}): Promise<PreviewResult>;
	withIssueMutex<T>(keys: string[], fn: () => Promise<T>): Promise<T>;
	withRepoLock: WithRepoLock;
	worktreeManager: Pick<
		WorktreeManager,
		"removeCleanWorktreeByPath" | "getRegisteredWorktree"
	>;
	pathState?: (
		target: StockCleanupManifestTarget,
	) => Promise<"present" | "absent" | "unknown">;
}

export interface StockCleanupExecuteInput {
	projectName: string;
	actor: string;
	requestId: string;
	manifestJson: string;
	manifestDigest: string;
	authorityCheck: () => void | Promise<void>;
}

const MAX_TARGETS = 10_000;

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function targetIdentity(target: StockCleanupManifestTarget): string {
	return JSON.stringify({
		projectName: target.projectName,
		repoSlug: target.repoSlug,
		canonicalPath: target.canonicalPath,
		parentIdentity: target.parentIdentity ?? null,
		leafIdentity: target.leafIdentity ?? null,
		generation: target.generation ?? null,
		branch: target.branch ?? null,
		head: target.head ?? null,
		issueId: target.issueId ?? null,
		operationId: target.operationId ?? null,
		pr: target.pr
			? {
					number: target.pr.number,
					state: target.pr.state,
					headRef: target.pr.headRef ?? null,
					headSha: target.pr.headSha ?? null,
				}
			: null,
		bindings: [...target.bindings]
			.map((binding) => ({
				executionId: binding.executionId,
				activationId: binding.activationId ?? null,
				executionRunId: binding.executionRunId ?? null,
				lifecycleRevision: binding.lifecycleRevision ?? null,
				adapter: binding.adapter ?? null,
				path: binding.path,
				branch: binding.branch,
				generation: binding.generation,
			}))
			.sort((a, b) => a.executionId.localeCompare(b.executionId)),
		terminalAuthority:
			target.terminalAuthority.state === "valid"
				? target.terminalAuthority.identity
				: null,
	});
}

function targetDigest(target: StockCleanupManifestTarget): string {
	return sha256(targetIdentity(target));
}

function parseManifest(input: StockCleanupExecuteInput): StockCleanupManifest {
	if (sha256(input.manifestJson) !== input.manifestDigest) {
		throw new Error("stock_cleanup_manifest_digest_mismatch");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(input.manifestJson);
	} catch {
		throw new Error("stock_cleanup_manifest_invalid");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("stock_cleanup_manifest_invalid");
	}
	const manifest = parsed as Partial<StockCleanupManifest>;
	if (
		manifest.schemaVersion !== 1 ||
		manifest.projectName !== input.projectName ||
		!Array.isArray(manifest.targets) ||
		manifest.targets.length > MAX_TARGETS ||
		manifest.targets.some(
			(target) =>
				!target ||
				typeof target !== "object" ||
				typeof target.canonicalPath !== "string" ||
				!target.canonicalPath.startsWith("/") ||
				target.projectName !== input.projectName ||
				typeof target.eligible !== "boolean",
		)
	) {
		throw new Error("stock_cleanup_manifest_invalid");
	}
	const paths = manifest.targets.map((target) => target.canonicalPath);
	if (new Set(paths).size !== paths.length) {
		throw new Error("stock_cleanup_manifest_duplicate_target");
	}
	return manifest as StockCleanupManifest;
}

async function defaultPathState(
	target: StockCleanupManifestTarget,
): Promise<"present" | "absent" | "unknown"> {
	try {
		await lstat(target.canonicalPath);
		return "present";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "unknown";
	}
	try {
		const parent = await lstat(dirname(target.canonicalPath), { bigint: true });
		return target.parentIdentity &&
			String(parent.dev) === target.parentIdentity.dev &&
			String(parent.ino) === target.parentIdentity.ino
			? "absent"
			: "unknown";
	} catch {
		return "unknown";
	}
}

function parseStoredResult(
	value: string | null,
): StockCleanupExecutionResult | undefined {
	if (!value) return undefined;
	try {
		const parsed = JSON.parse(value) as StockCleanupExecutionResult;
		return parsed && Array.isArray(parsed.items) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function parseStoredItem(
	value: string | null,
): StockCleanupExecutionItem | undefined {
	if (!value) return undefined;
	try {
		const parsed = JSON.parse(value) as StockCleanupExecutionItem;
		return parsed && typeof parsed.canonicalPath === "string"
			? parsed
			: undefined;
	} catch {
		return undefined;
	}
}

export function createStockCleanupExecutor(deps: StockCleanupExecutorDeps): {
	execute(
		input: StockCleanupExecuteInput,
	): Promise<StockCleanupExecutionResult>;
} {
	const pathState = deps.pathState ?? defaultPathState;
	return {
		async execute(input) {
			await input.authorityCheck();
			const manifest = parseManifest(input);
			const projectRoot = deps.projectRoot(input.projectName);
			if (!projectRoot) throw new Error("stock_cleanup_project_unconfigured");
			const selected = manifest.targets.filter((target) => target.eligible);
			const requestClaim: ApplyEffectClaimInput = {
				rootUuid: `stock:${input.projectName}`,
				effectScope: "stock_worktree_cleanup",
				effectKey: `request:${input.requestId}`,
				approvedHash: input.manifestDigest,
				requestId: input.requestId,
				targetDigest: input.manifestDigest,
				project: input.projectName,
				actor: input.actor,
			};
			const request = deps.store.claimApplyEffect(requestClaim);
			if (request.outcome === "conflict") throw new Error(request.reason);
			if (request.claim.status !== "claimed") {
				const stored = parseStoredResult(request.claim.reportJson);
				if (!stored) throw new Error("stock_cleanup_request_receipt_invalid");
				return stored;
			}

			const items: StockCleanupExecutionItem[] = [];
			for (const approved of selected) {
				const digest = targetDigest(approved);
				const effectKey = `target:${sha256(`${input.projectName}\0${approved.canonicalPath}`)}`;
				const claim: ApplyEffectClaimInput = {
					rootUuid: approved.issueId ?? `stock:${input.projectName}`,
					effectScope: "stock_worktree_cleanup",
					effectKey,
					approvedHash: input.manifestDigest,
					requestId: sha256(`${input.requestId}\0${digest}`),
					targetDigest: digest,
					project: input.projectName,
					actor: input.actor,
				};
				const item = await deps.withIssueMutex(
					[approved.issueId ?? effectKey],
					() =>
						deps.withRepoLock(projectRoot, async () => {
							await input.authorityCheck();
							const claimed = deps.store.claimApplyEffect(claim);
							if (claimed.outcome === "conflict") {
								return {
									canonicalPath: approved.canonicalPath,
									status: "rejected" as const,
									reason: claimed.reason,
								};
							}
							if (claimed.claim.status !== "claimed") {
								const stored = parseStoredItem(claimed.claim.reportJson);
								if (!stored)
									throw new Error("stock_cleanup_target_receipt_invalid");
								return stored;
							}

							const fresh = await deps.preview({
								projectName: input.projectName,
								actor: input.actor,
								authorityCheck: input.authorityCheck,
							});
							const current = fresh.manifest.targets.find(
								(target) => target.canonicalPath === approved.canonicalPath,
							);
							let outcome: StockCleanupExecutionItem;
							if (!current) {
								outcome =
									(await pathState(approved)) === "absent"
										? {
												canonicalPath: approved.canonicalPath,
												status: "recovered_absent",
											}
										: {
												canonicalPath: approved.canonicalPath,
												status: "rejected",
												reason: "fresh_target_missing",
											};
							} else if (!current.eligible) {
								outcome = {
									canonicalPath: approved.canonicalPath,
									status: "rejected",
									reason: "fresh_target_ineligible",
								};
							} else if (targetDigest(current) !== digest) {
								outcome = {
									canonicalPath: approved.canonicalPath,
									status: "rejected",
									reason: "target_identity_changed",
								};
							} else {
								await input.authorityCheck();
								const removed =
									await deps.worktreeManager.removeCleanWorktreeByPath(
										projectRoot,
										approved.canonicalPath,
										null,
										{ processHandling: "refuse" },
									);
								if (!removed.removed) {
									outcome = {
										canonicalPath: approved.canonicalPath,
										status: "rejected",
										reason: removed.error ?? "worktree_remove_refused",
									};
								} else {
									const [state, registered] = await Promise.all([
										pathState(approved),
										deps.worktreeManager.getRegisteredWorktree(
											projectRoot,
											approved.canonicalPath,
										),
									]);
									outcome =
										state === "absent" && !registered
											? {
													canonicalPath: approved.canonicalPath,
													status: "removed",
												}
											: {
													canonicalPath: approved.canonicalPath,
													status: "rejected",
													reason: "worktree_removal_unverified",
												};
								}
							}
							await input.authorityCheck();
							const toStatus =
								outcome.status === "rejected" ? "rejected" : "applied";
							if (
								!deps.store.casApplyEffect({
									...claim,
									fromStatus: "claimed",
									toStatus,
									reportJson: JSON.stringify(outcome),
								})
							) {
								const stored = deps.store.getApplyEffect(
									claim.effectScope,
									claim.effectKey,
									claim.approvedHash,
								);
								const replay = parseStoredItem(stored?.reportJson ?? null);
								if (!replay) throw new Error("stock_cleanup_target_cas_lost");
								return replay;
							}
							return outcome;
						}),
				);
				items.push(item);
			}
			const result: StockCleanupExecutionResult = {
				requestId: input.requestId,
				manifestDigest: input.manifestDigest,
				projectName: input.projectName,
				status: items.every((item) => item.status !== "rejected")
					? "applied"
					: "partial",
				items,
			};
			if (
				!deps.store.casApplyEffect({
					...requestClaim,
					fromStatus: "claimed",
					toStatus: "applied",
					reportJson: JSON.stringify(result),
				})
			) {
				const stored = deps.store.getApplyEffect(
					requestClaim.effectScope,
					requestClaim.effectKey,
					requestClaim.approvedHash,
				);
				const replay = parseStoredResult(stored?.reportJson ?? null);
				if (!replay) throw new Error("stock_cleanup_request_cas_lost");
				return replay;
			}
			return result;
		},
	};
}
