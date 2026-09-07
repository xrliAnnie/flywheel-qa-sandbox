import { describe, expect, it } from "vitest";
import type {
	ShipRelevantDeclaredPrRow,
	ShipRelevantDiffSnapshot,
	ShipRelevantPrSnapshot,
	WorkflowNodePrBindingRow,
} from "../../StateStore.js";
import {
	type RunShipRelevanceFacts,
	type RunShipRelevanceStore,
	resolveRunShipRelevance,
	resolveRunShipRelevanceCore,
	resolveRunShipRelevanceCounterfactual,
} from "../run-ship-relevance.js";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const NOW = new Date("2026-09-06T00:00:30.000Z");

function snapshot(
	overrides: Partial<ShipRelevantPrSnapshot> = {},
): ShipRelevantPrSnapshot {
	return {
		execution_id: "exec-1",
		repo_slug: "owner/main",
		pr_number: 41,
		pr_head_sha: HEAD_A,
		role: "primary",
		base_ref: "main",
		base_oid: "d".repeat(40),
		classifier_version: 2,
		ship_relevant: 0,
		file_count: 1,
		commit_shas: [HEAD_A],
		computed_at: "2026-09-06T00:00:00.000Z",
		...overrides,
	};
}

function binding(
	overrides: Partial<WorkflowNodePrBindingRow> = {},
): WorkflowNodePrBindingRow {
	return {
		run_id: "run-1",
		node_id: "implement",
		attempt: 1,
		pr_number: 41,
		head_sha: HEAD_A,
		target_repo_identity: "__main__",
		probe_repo_slug: "owner/main",
		target_repo_path: ".",
		worktree_binding_generation: "generation-1",
		receipt_id: "binding-1",
		bound_at: "2026-09-06T00:00:00.000Z",
		...overrides,
	};
}

function workflowStore(
	overrides: Partial<RunShipRelevanceStore> = {},
): RunShipRelevanceStore {
	return {
		resolveWorkflowRunForExecution: () => ({ kind: "one", runId: "run-1" }),
		resolveWorkflowNodePrBindingForSession: () => ({
			kind: "one",
			binding: binding(),
		}),
		projectCurrentShipRelevantCandidates: () => [],
		listNestedCodexReviewHeadsForRun: () => [],
		listNestedCodexReviewHeadsForExecution: () => [],
		getShipRelevantPrSnapshot: () => snapshot(),
		resolvePrimaryShipRelevantPrSnapshot: () => ({ kind: "none" }),
		...overrides,
	};
}

function declaredRow(
	overrides: Partial<ShipRelevantDeclaredPrRow> = {},
): ShipRelevantDeclaredPrRow {
	return {
		receipt_id: "declaration-1",
		repo_identity: "owner/nested",
		pr_number: 42,
		run_id: "run-1",
		node_id: "implement",
		attempt: 1,
		execution_id: "exec-1",
		probe_repo_slug: "owner/nested",
		frozen_head_sha: HEAD_B,
		target_repo_path: "apps/nested",
		declaration_seq: 1,
		declared_at: "2026-09-06T00:00:00.000Z",
		...overrides,
	};
}

function facts(
	overrides: Partial<RunShipRelevanceFacts> = {},
): RunShipRelevanceFacts {
	return {
		primary: {
			repoIdentity: "__main__",
			repoSlug: "owner/main",
			prNumber: 41,
			headSha: HEAD_A,
			classification: {
				repoSlug: "owner/main",
				prNumber: 41,
				headSha: HEAD_A,
				shipRelevant: 0,
				fileCount: 1,
				commitShas: new Set([HEAD_A]),
			},
		},
		declared: [],
		nestedReviews: [],
		...overrides,
	};
}

describe("resolveRunShipRelevanceCore", () => {
	it("settles known primary code before unresolved declared PRs", () => {
		const input = facts({
			primary: {
				...facts().primary,
				classification: {
					...facts().primary.classification!,
					shipRelevant: 1,
				},
			},
			declared: [
				{
					repoIdentity: "owner/nested",
					repoSlug: "owner/nested",
					prNumber: 42,
					headSha: HEAD_B,
					missingReason: "declared_snapshot_missing",
				},
			],
		});

		expect(resolveRunShipRelevanceCore(input)).toMatchObject({
			verdict: "ship_relevant",
			reason: "primary_ship_relevant",
		});
	});

	it("settles known declared code before another declared snapshot is missing", () => {
		const declared = {
			repoIdentity: "owner/nested",
			repoSlug: "owner/nested",
			prNumber: 42,
			headSha: HEAD_B,
		};
		expect(
			resolveRunShipRelevanceCore(
				facts({
					declared: [
						{
							...declared,
							classification: {
								repoSlug: declared.repoSlug,
								prNumber: declared.prNumber,
								headSha: declared.headSha,
								shipRelevant: 1,
								fileCount: 1,
								commitShas: new Set([HEAD_B]),
							},
						},
						{
							...declared,
							repoIdentity: "owner/second",
							repoSlug: "owner/second",
							prNumber: 43,
							missingReason: "declared_snapshot_missing",
						},
					],
				}),
			),
		).toMatchObject({
			verdict: "ship_relevant",
			reason: "declared_ship_relevant",
		});
	});

	it("fails closed when the primary or any declared snapshot is unavailable", () => {
		expect(
			resolveRunShipRelevanceCore(
				facts({
					primary: {
						...facts().primary,
						classification: undefined,
						missingReason: "primary_snapshot_stale",
					},
				}),
			),
		).toMatchObject({ verdict: "unknown", reason: "primary_snapshot_stale" });
		expect(
			resolveRunShipRelevanceCore(
				facts({
					declared: [
						{
							repoIdentity: "owner/nested",
							repoSlug: "owner/nested",
							prNumber: 42,
							headSha: HEAD_B,
							missingReason: "declared_snapshot_version_mismatch",
						},
					],
				}),
			),
		).toMatchObject({
			verdict: "unknown",
			reason: "declared_snapshot_version_mismatch",
		});
	});

	it("keeps the no-declaration docs-only control classified", () => {
		expect(resolveRunShipRelevanceCore(facts())).toMatchObject({
			verdict: "docs_only",
			fileCount: 1,
		});
	});

	it("requires nested review identity and head coverage", () => {
		const declared = {
			repoIdentity: "owner/nested",
			repoSlug: "owner/nested",
			prNumber: 42,
			headSha: HEAD_B,
			classification: {
				repoSlug: "owner/nested",
				prNumber: 42,
				headSha: HEAD_B,
				shipRelevant: 0 as const,
				fileCount: 1,
				commitShas: new Set([HEAD_B]),
			},
		};
		expect(
			resolveRunShipRelevanceCore(
				facts({
					declared: [declared],
					nestedReviews: [
						{ repoIdentity: "owner/nested", headSha: "c".repeat(40) },
					],
				}),
			),
		).toMatchObject({
			verdict: "unknown",
			reason: "nested_review_uncovered",
		});
	});

	it("recognizes a reviewed primary PR that itself belongs to a nested repo", () => {
		const primary = {
			repoIdentity: "owner/nested",
			repoSlug: "owner/nested",
			prNumber: 42,
			headSha: HEAD_B,
			classification: {
				repoSlug: "owner/nested",
				prNumber: 42,
				headSha: HEAD_B,
				shipRelevant: 0 as const,
				fileCount: 1,
				commitShas: new Set([HEAD_B]),
			},
		};
		expect(
			resolveRunShipRelevanceCore(
				facts({
					primary,
					nestedReviews: [{ repoIdentity: "owner/nested", headSha: HEAD_B }],
				}),
			),
		).toMatchObject({ verdict: "docs_only" });
	});

	it("covers an earlier reviewed head when it is in the current PR commit set", () => {
		const historicalHead = "c".repeat(40);
		const declared = {
			repoIdentity: "owner/nested",
			repoSlug: "owner/nested",
			prNumber: 42,
			headSha: HEAD_B,
			classification: {
				repoSlug: "owner/nested",
				prNumber: 42,
				headSha: HEAD_B,
				shipRelevant: 0 as const,
				fileCount: 1,
				commitShas: new Set([historicalHead, HEAD_B]),
			},
		};
		expect(
			resolveRunShipRelevanceCore(
				facts({
					declared: [declared],
					nestedReviews: [
						{ repoIdentity: "owner/nested", headSha: historicalHead },
					],
				}),
			),
		).toMatchObject({ verdict: "docs_only", fileCount: 2 });
	});

	it.each([
		[50, "docs_only", undefined],
		[51, "ship_relevant", "file_budget_exceeded"],
	] as const)(
		"classifies an aggregate file count of %s",
		(fileCount, verdict, reason) => {
			const result = resolveRunShipRelevanceCore(
				facts({
					primary: {
						...facts().primary,
						classification: {
							...facts().primary.classification!,
							fileCount,
						},
					},
				}),
			);
			expect(result.verdict).toBe(verdict);
			if (reason) expect(result).toMatchObject({ reason });
		},
	);
});

describe("resolveRunShipRelevance", () => {
	it("classifies a workflow-bound primary snapshot", () => {
		expect(
			resolveRunShipRelevance(
				workflowStore(),
				{ execution_id: "exec-1", pr_number: 41, pr_head_sha: HEAD_A },
				NOW,
			),
		).toMatchObject({ verdict: "docs_only", fileCount: 1 });
	});

	it("keeps a uniquely classified legacy primary PR docs-only", () => {
		const store: RunShipRelevanceStore = {
			resolveWorkflowRunForExecution: () => ({ kind: "none" }),
			resolveWorkflowNodePrBindingForSession: () => ({ kind: "none" }),
			projectCurrentShipRelevantCandidates: () => [],
			listNestedCodexReviewHeadsForRun: () => [],
			listNestedCodexReviewHeadsForExecution: () => [],
			getShipRelevantPrSnapshot: () => undefined,
			resolvePrimaryShipRelevantPrSnapshot: () => ({
				kind: "one",
				snapshot: {
					execution_id: "exec-1",
					repo_slug: "owner/main",
					pr_number: 41,
					pr_head_sha: HEAD_A,
					role: "primary",
					base_ref: "main",
					base_oid: "d".repeat(40),
					classifier_version: 2,
					ship_relevant: 0,
					file_count: 1,
					commit_shas: [HEAD_A],
					computed_at: "2026-09-06T00:00:00.000Z",
				},
			}),
		};

		expect(
			resolveRunShipRelevance(
				store,
				{ execution_id: "exec-1", pr_number: 41, pr_head_sha: HEAD_A },
				NOW,
			),
		).toMatchObject({ verdict: "docs_only", fileCount: 1 });
	});

	it.each([
		[
			"ambiguous run ownership",
			workflowStore({
				resolveWorkflowRunForExecution: () => ({
					kind: "many",
					runIds: ["run-1", "run-2"],
				}),
			}),
		],
		[
			"missing workflow binding",
			workflowStore({
				resolveWorkflowNodePrBindingForSession: () => ({ kind: "none" }),
			}),
		],
		[
			"ambiguous workflow binding",
			workflowStore({
				resolveWorkflowNodePrBindingForSession: () => ({
					kind: "many",
					bindings: [binding(), binding({ node_id: "qa" })],
				}),
			}),
		],
		[
			"store read failure",
			workflowStore({
				projectCurrentShipRelevantCandidates: () => {
					throw new Error("db unavailable");
				},
			}),
		],
	] as const)("fails closed on %s", (_name, store) => {
		expect(
			resolveRunShipRelevance(
				store,
				{ execution_id: "exec-1", pr_number: 41, pr_head_sha: HEAD_A },
				NOW,
			),
		).toMatchObject({ verdict: "unknown", reason: "scope_unresolved" });
	});

	it.each([
		[undefined, "primary_snapshot_missing"],
		[snapshot({ pr_head_sha: "c".repeat(40) }), "primary_snapshot_missing"],
		[snapshot({ repo_slug: "owner/wrong" }), "primary_snapshot_missing"],
		[snapshot({ classifier_version: 1 }), "primary_snapshot_version_mismatch"],
		[
			snapshot({ computed_at: "2026-09-05T00:00:00.000Z" }),
			"primary_snapshot_stale",
		],
	] as const)(
		"classifies an unusable primary snapshot as %s",
		(value, reason) => {
			expect(
				resolveRunShipRelevance(
					workflowStore({ getShipRelevantPrSnapshot: () => value }),
					{ execution_id: "exec-1", pr_number: 41, pr_head_sha: HEAD_A },
					NOW,
				),
			).toMatchObject({ verdict: "unknown", reason });
		},
	);

	it.each([
		[true, "docs_only", undefined],
		[false, "unknown", "nested_review_uncovered"],
	] as const)(
		"uses the current declared head and commit coverage=%s for prior reviews",
		(coversPriorHead, verdict, reason) => {
			const priorHead = "c".repeat(40);
			const store = workflowStore({
				projectCurrentShipRelevantCandidates: () => [declaredRow()],
				listNestedCodexReviewHeadsForRun: () => [
					{ repoIdentity: "owner/nested", headSha: priorHead },
				],
				getShipRelevantPrSnapshot: (_executionId, repoSlug) =>
					repoSlug === "owner/main"
						? snapshot()
						: snapshot({
								repo_slug: "owner/nested",
								pr_number: 42,
								pr_head_sha: HEAD_B,
								role: "declared",
								commit_shas: coversPriorHead ? [priorHead, HEAD_B] : [HEAD_B],
							}),
			});
			const result = resolveRunShipRelevance(
				store,
				{ execution_id: "exec-1", pr_number: 41, pr_head_sha: HEAD_A },
				NOW,
			);
			expect(result.verdict).toBe(verdict);
			if (reason) expect(result).toMatchObject({ reason });
		},
	);

	it("rejects a run projection above the declared PR limit before snapshot reads", () => {
		let snapshotReads = 0;
		const store = workflowStore({
			projectCurrentShipRelevantCandidates: () =>
				Array.from({ length: 9 }, (_, index) =>
					declaredRow({
						repo_identity: `owner/nested-${index}`,
						probe_repo_slug: `owner/nested-${index}`,
						pr_number: 42 + index,
					}),
				),
			getShipRelevantPrSnapshot: () => {
				snapshotReads += 1;
				return snapshot();
			},
		});
		expect(
			resolveRunShipRelevance(
				store,
				{ execution_id: "exec-1", pr_number: 41, pr_head_sha: HEAD_A },
				NOW,
			),
		).toMatchObject({
			verdict: "unknown",
			reason: "declaration_overflow",
		});
		expect(snapshotReads).toBe(0);
	});
});

describe("resolveRunShipRelevanceCounterfactual", () => {
	it("uses the newest historical v1 snapshot while ignoring its age and version", () => {
		const historical = (
			executionId: string,
			computedAt: string,
			overrides: Partial<ShipRelevantDiffSnapshot> = {},
		): ShipRelevantDiffSnapshot => ({
			execution_id: executionId,
			pr_head_sha: HEAD_A,
			repo: "owner/main",
			pr_number: 41,
			base_ref: "main",
			base_oid: "d".repeat(40),
			classifier_version: 1,
			ship_relevant: 0,
			file_count: 1,
			computed_at: computedAt,
			...overrides,
		});
		const result = resolveRunShipRelevanceCounterfactual({
			primarySnapshots: [
				historical("exec-a", "2025-01-01T00:00:00.000Z", {
					ship_relevant: 1,
				}),
				historical("exec-b", "2025-02-01T00:00:00.000Z"),
			],
			nestedReviews: [{ repoIdentity: "owner/nested", headSha: HEAD_B }],
		});

		expect(result).toMatchObject({
			mode: "counterfactual",
			verdict: "unknown",
			reason: "nested_review_uncovered",
			basis: {
				primaryExecutionId: "exec-b",
				primaryComputedAt: "2025-02-01T00:00:00.000Z",
				snapshotVersion: 1,
			},
		});
	});
});
