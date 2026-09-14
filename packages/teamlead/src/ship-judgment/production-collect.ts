import type { StateStore } from "../StateStore.js";
import type { CollectionResult } from "./collect.js";
import { checkFileConflicts, checkGitMerge } from "./conflicts.js";
import {
	canonicalDigest,
	type OpinionCandidate,
	type ProjectSnapshot,
	projectSnapshotSchema,
	refreshConfigSchema,
} from "./contract.js";
import { prepareJudgmentGit } from "./prepare-git.js";
import type {
	ProjectRefreshStore,
	SharedProjectRefresh,
} from "./project-refresh.js";
import {
	collectLiveJudgment,
	type LiveCollectionDependencies,
} from "./runtime-collect.js";

type Mechanical = OpinionCandidate["mechanical"];
export interface ProductionCollectionDependencies {
	source: Omit<LiveCollectionDependencies, "git"> & {
		store: LiveCollectionDependencies["store"] &
			Pick<StateStore, "getShipJudgmentInputs">;
	};
	repositories: { repo_identity: string; repo_slug: string }[];
	refresh: Pick<SharedProjectRefresh, "refresh">;
	/** Return only the shared store's currently valid (at most sixty seconds old) snapshot. */
	currentSnapshot(): ProjectSnapshot | undefined;
	token(signal: AbortSignal): Promise<string>;
	prepare?: typeof prepareJudgmentGit;
	merge?: typeof checkGitMerge;
	mergeCache?: Pick<ProjectRefreshStore, "readMergeProbe" | "saveMergeProbe">;
	collect?: typeof collectLiveJudgment;
	now?: () => number;
}

/** One bounded card collection; all Git handles are private and disposed before returning. */
export async function collectProductionJudgment(
	questionId: string,
	channelId: string,
	deps: ProductionCollectionDependencies,
	signal: AbortSignal,
): Promise<{ collection: CollectionResult; mechanical: Mechanical }> {
	const now = deps.now ?? Date.now;
	const unknown = (reason: string): Mechanical => ({
		verdict: "undetermined",
		reason,
		digest: canonicalDigest({ reason }),
		checkedAt: new Date(now()).toISOString(),
		scope: "main合并＋目标分支合并＋同项目在飞文件",
		checkedRepos: 0,
		openPrCount: null,
		overlaps: [],
	});
	const fail = (reason: string) => ({
		collection: { status: "undetermined" as const, reason },
		mechanical: unknown(reason),
	});
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 60_000);
	const bound = AbortSignal.any([signal, controller.signal]);
	const prepared: Awaited<ReturnType<typeof prepareJudgmentGit>>[] = [];
	try {
		bound.throwIfAborted();
		const binding = deps.source.store.readShipJudgmentBinding(
			questionId,
			channelId,
		);
		if (!binding || binding.projectName !== "flywheel")
			return fail("binding_missing");
		const config = refreshConfigSchema.parse({
			projectName: "flywheel",
			repositories: deps.repositories,
		});
		config.repositories.sort((a, b) =>
			a.repo_identity < b.repo_identity
				? -1
				: a.repo_identity > b.repo_identity
					? 1
					: 0,
		);
		if (
			binding.targets.some(
				(target) =>
					!config.repositories.some(
						(repo) =>
							repo.repo_identity === target.repo_identity &&
							repo.repo_slug === target.repo_slug,
					),
			)
		)
			return fail("repository_not_configured");
		const refreshed = await deps.refresh.refresh(config);
		bound.throwIfAborted();
		if (refreshed.status !== "ready") return fail(refreshed.reason);
		const snapshot = projectSnapshotSchema.parse(refreshed.snapshot);
		if (snapshot.configurationDigest !== canonicalDigest(config.repositories))
			return fail("repository_configuration_changed");
		const snapshotDigest = canonicalDigest(snapshot);
		const targets = binding.targets.map((target) =>
			snapshot.prs.find(
				(pr) =>
					pr.repo_identity === target.repo_identity &&
					pr.pr_number === target.pr_number &&
					pr.head_sha === target.head_sha,
			),
		);
		if (targets.some((target) => !target))
			return fail("target_snapshot_missing");
		const previous = deps.source.store
			.getShipJudgmentInputs()
			.latestForQuestion(questionId);
		const merges: Awaited<ReturnType<typeof checkGitMerge>>[] = [];
		for (const target of binding.targets) {
			bound.throwIfAborted();
			const pr = targets.find(
				(pr) =>
					pr?.repo_identity === target.repo_identity &&
					pr.pr_number === target.pr_number,
			)!;
			const repo = snapshot.repositories.find(
				(repo) => repo.repo_identity === target.repo_identity,
			)!;
			const old = previous?.targets.find(
				(old) =>
					old.repo_identity === target.repo_identity &&
					old.pr_number === target.pr_number &&
					old.head_sha === target.head_sha,
			);
			const git = await (deps.prepare ?? prepareJudgmentGit)(
				{
					repoIdentity: target.repo_identity,
					repoSlug: target.repo_slug,
					prNumber: target.pr_number,
					headSha: target.head_sha,
					mainSha: repo.main_sha,
					targetBaseSha: pr.base_sha,
					...(old ? { diffBaseSha: old.diff_base_sha } : {}),
				},
				{
					repositories: config.repositories.map((repo) => repo.repo_slug),
					token: deps.token,
				},
				bound,
			);
			prepared.push(git);
			bound.throwIfAborted();
			const key = {
				repoIdentity: target.repo_identity,
				mainSha: repo.main_sha,
				headSha: target.head_sha,
				targetBaseSha: pr.base_sha,
			};
			const cached = deps.mergeCache?.readMergeProbe(key, now());
			if (cached) {
				merges.push(cached);
				continue;
			}
			const result = await (deps.merge ?? checkGitMerge)({
				gitDir: git.gitDir,
				mainSha: repo.main_sha,
				headSha: target.head_sha,
				targetBaseSha: pr.base_sha,
				signal: bound,
			});
			bound.throwIfAborted();
			const saved = deps.mergeCache?.saveMergeProbe(key, result, now());
			merges.push(
				saved === false
					? { verdict: "undetermined", reason: "merge_probe_cache_unavailable" }
					: result,
			);
		}
		const collection = await (deps.collect ?? collectLiveJudgment)(
			questionId,
			channelId,
			{ ...deps.source, git: prepared.map((git) => git.material) },
			bound,
		);
		bound.throwIfAborted();
		const currentBinding = deps.source.store.readShipJudgmentBinding(
			questionId,
			channelId,
		);
		if (
			!currentBinding ||
			canonicalDigest(currentBinding) !== canonicalDigest(binding)
		)
			return fail("binding_changed");
		const current = deps.currentSnapshot();
		if (!current || canonicalDigest(current) !== snapshotDigest)
			return {
				collection,
				mechanical: unknown("mechanical_snapshot_changed_or_expired"),
			};
		const inventory = snapshot.prs.map(
			({
				base_ref: _baseRef,
				base_sha: _baseSha,
				filesError: _filesError,
				...pr
			}) => pr,
		);
		const ownInventory = inventory.filter((pr) =>
			binding.targets.some(
				(target) =>
					target.repo_identity === pr.repo_identity &&
					target.pr_number === pr.pr_number,
			),
		);
		const files = checkFileConflicts(ownInventory, inventory, true);
		const undetermined =
			files.verdict === "undetermined" ||
			merges.some((merge) => merge.verdict === "undetermined");
		const failed =
			files.verdict === "fail" ||
			merges.some((merge) => merge.verdict === "fail");
		return {
			collection,
			mechanical: {
				verdict: undetermined ? "undetermined" : failed ? "fail" : "pass",
				reason: undetermined
					? "mechanical_check_incomplete"
					: failed
						? "coordination_required"
						: "mechanical_checks_clear",
				digest: canonicalDigest({ snapshot, merges, files }),
				checkedAt: new Date(now()).toISOString(),
				scope: "main合并＋目标分支合并＋同项目在飞文件",
				checkedRepos: prepared.length,
				openPrCount: files.openPrCount,
				overlaps: files.overlaps,
			},
		};
	} catch {
		return fail(
			bound.aborted ? "collection_aborted" : "production_collection_failed",
		);
	} finally {
		clearTimeout(timer);
		controller.abort();
		await Promise.all(prepared.map((git) => git.dispose()));
	}
}
