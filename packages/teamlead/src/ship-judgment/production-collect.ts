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
import type { JudgmentMaterials } from "./evidence-ledger.js";
import {
	cachePreparedMaterial,
	type EvidenceStore,
	readAuthorityMaterials,
} from "./materials.js";
import { prepareJudgmentGit } from "./prepare-git.js";
import type {
	ProjectRefreshStore,
	SharedProjectRefresh,
} from "./project-refresh.js";
import { readClaimQaSource } from "./qa-source.js";
import {
	collectLiveJudgment,
	type LiveCollectionDependencies,
} from "./runtime-collect.js";

type Mechanical = OpinionCandidate["mechanical"];
export interface ProductionCollectionDependencies {
	source: Omit<LiveCollectionDependencies, "git"> & {
		store: LiveCollectionDependencies["store"] &
			Pick<StateStore, "getShipJudgmentInputs"> &
			EvidenceStore;
	};
	repositories: { repo_identity: string; repo_slug: string }[];
	refresh: Pick<SharedProjectRefresh, "refresh"> &
		Partial<Pick<SharedProjectRefresh, "metadata">>;
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
): Promise<{
	collection: CollectionResult;
	mechanical: Mechanical;
	materials: JudgmentMaterials;
}> {
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
	let materials: JudgmentMaterials = {
		targets: [],
		mechanical: unknown("binding_missing"),
		input: { status: "unavailable", reason: "binding_missing" },
		computedAt: new Date(now()).toISOString(),
	};
	const fail = (reason: string) => ({
		collection: { status: "undetermined" as const, reason },
		mechanical: unknown(reason),
		materials: {
			...materials,
			mechanical: unknown(reason),
			...(reason === "binding_changed" ? { targets: [] } : {}),
			input: { status: "unavailable" as const, reason },
		},
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
		materials = readAuthorityMaterials(
			deps.source.store,
			binding,
			unknown("mechanical_pending"),
			new Date(now()).toISOString(),
		);
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
		const refreshing = deps.refresh.refresh(config).catch(() => ({
			status: "unavailable" as const,
			reason: "project_refresh_failed",
		}));
		// Start Git as soon as the identities are known, independently of file inventory success.
		const metadata = deps.refresh.metadata
			? await deps.refresh.metadata(config)
			: await refreshing.then((value) =>
					value.status === "ready" ? value.snapshot : undefined,
				);
		bound.throwIfAborted();
		if (!metadata) {
			const result = await refreshing;
			return fail(
				result.status === "ready" ? "target_snapshot_missing" : result.reason,
			);
		}
		let snapshot = projectSnapshotSchema.parse(metadata);
		if (snapshot.configurationDigest !== canonicalDigest(config.repositories))
			return fail("repository_configuration_changed");
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
		const unsaved: {
			key: Parameters<ProjectRefreshStore["saveMergeProbe"]>[0];
			result: Awaited<ReturnType<typeof checkGitMerge>>;
		}[] = [];
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
			git.material = cachePreparedMaterial(git.material);
			prepared.push(git);
			bound.throwIfAborted();
			const material = materials.targets.find(
				(m) =>
					m.repoIdentity === target.repo_identity &&
					m.prNumber === target.pr_number,
			)!;
			material.diffBaseSha = git.material.diffBaseSha;
			const reader = git.material.reader(bound);
			try {
				material.diff = await reader.diff(
					git.material.diffBaseSha,
					target.head_sha,
				);
			} catch (error) {
				const code =
					error instanceof Error
						? (error.cause as { code?: unknown } | undefined)?.code
						: undefined;
				materials.input = {
					status: "unavailable",
					reason:
						code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
							? "diff_budget_exceeded"
							: "git_diff_unavailable",
				};
			}
			if (material.designApproval?.status === "approved") {
				const prior = deps.source.store.readShipJudgmentPlanReference(
					binding.runId,
					target.repo_identity,
				);
				const reference =
					prior?.requestId === material.designApproval.requestId
						? prior
						: material.designApproval;
				try {
					material.planBlob = await reader.readText(
						target.head_sha,
						reference.path,
					);
				} catch {
					/* Missing frozen plan affects alignment only. */
				}
			}
			const report = readClaimQaSource(
				{
					runId: binding.runId,
					repoIdentity: target.repo_identity,
					headSha: target.head_sha,
				},
				material.qaAuthority,
				deps.source.registry,
				deps.source.hosting,
			);
			if (report)
				material.qaReport = {
					id: report.reportToken,
					observedAt: material.qaAuthority!.issuedAt!,
				};
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
			unsaved.push({ key, result });
			merges.push(result);
		}
		let collection: CollectionResult;
		try {
			collection = await (deps.collect ?? collectLiveJudgment)(
				questionId,
				channelId,
				{ ...deps.source, git: prepared.map((git) => git.material) },
				bound,
			);
		} catch {
			collection = {
				status: "undetermined",
				reason: "source_collection_failed",
			};
		}
		bound.throwIfAborted();
		const refreshed = await refreshing;
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
		const latestAuthorities = readAuthorityMaterials(
			deps.source.store,
			binding,
			materials.mechanical,
			new Date(now()).toISOString(),
		);
		for (const material of materials.targets) {
			const latest = latestAuthorities.targets.find(
				(t) =>
					t.repoIdentity === material.repoIdentity &&
					t.prNumber === material.prNumber,
			)!;
			if (
				canonicalDigest(material.designApproval ?? null) !==
				canonicalDigest(latest.designApproval ?? null)
			)
				delete material.planBlob;
			if (
				canonicalDigest(material.qaAuthority ?? null) !==
				canonicalDigest(latest.qaAuthority ?? null)
			)
				delete material.qaReport;
			for (const key of [
				"designApproval",
				"codeReview",
				"qaAuthority",
			] as const) {
				if (
					canonicalDigest(material[key] ?? null) !==
					canonicalDigest(latest[key] ?? null)
				)
					collection = {
						status: "undetermined",
						reason: "source_authority_changed",
					};
			}
			Object.assign(material, {
				designApproval: latest.designApproval,
				codeReview: latest.codeReview,
				qaAuthority: latest.qaAuthority,
			});
		}
		if (latestAuthorities.input.status === "unavailable")
			materials.input = latestAuthorities.input;
		materials.computedAt = new Date(now()).toISOString();
		if (refreshed.status !== "ready") return fail(refreshed.reason);
		const complete = projectSnapshotSchema.parse(refreshed.snapshot);
		const identityDigest = (value: ProjectSnapshot) =>
			canonicalDigest({
				repositories: value.repositories,
				prs: value.prs.map(
					({
						files: _files,
						filesComplete: _complete,
						filesError: _error,
						...identity
					}) => identity,
				),
			});
		if (identityDigest(complete) !== identityDigest(snapshot))
			return fail("mechanical_snapshot_changed_or_expired");
		snapshot = complete;
		const snapshotDigest = canonicalDigest(snapshot);
		const current = deps.currentSnapshot();
		if (!current || canonicalDigest(current) !== snapshotDigest)
			return {
				collection,
				mechanical: unknown("mechanical_snapshot_changed_or_expired"),
				materials: {
					...materials,
					mechanical: unknown("mechanical_snapshot_changed_or_expired"),
					input: {
						status: "unavailable",
						reason: "mechanical_snapshot_changed_or_expired",
					},
				},
			};
		for (const { key, result } of unsaved) {
			if (deps.mergeCache?.saveMergeProbe(key, result, now()) === false)
				return fail("merge_probe_cache_unavailable");
		}
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
		const mechanical: Mechanical = {
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
		};
		return { collection, mechanical, materials: { ...materials, mechanical } };
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
