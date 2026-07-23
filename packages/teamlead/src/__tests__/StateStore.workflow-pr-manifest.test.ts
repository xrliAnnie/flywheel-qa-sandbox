import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

async function fixture(): Promise<{
	store: StateStore;
	insertBinding(input: {
		nodeId: string;
		attempt?: number;
		prNumber: number;
		headSha: string;
		repoIdentity?: string;
		probeRepoSlug?: string;
	}): void;
}> {
	const store = await StateStore.create(":memory:");
	store.createWorkflowRun({
		runId: "run-manifest",
		issueId: "FLY-1434",
		projectName: "flywheel",
		claimsReadEnrolled: true,
	});
	const db = (
		store as unknown as {
			db: { run(sql: string, params?: unknown[]): void };
		}
	).db;
	const insertBinding = (input: {
		nodeId: string;
		attempt?: number;
		prNumber: number;
		headSha: string;
		repoIdentity?: string;
		probeRepoSlug?: string;
	}) => {
		const attempt = input.attempt ?? 1;
		store.upsertWorkflowRunNode({
			runId: "run-manifest",
			nodeId: input.nodeId,
			attempt,
			state: "done",
			executionId: `${input.nodeId}-${attempt}`,
		});
		db.run(
			`INSERT INTO workflow_node_pr_binding
			   (run_id, node_id, attempt, pr_number, head_sha, target_repo_identity,
			    probe_repo_slug, target_repo_path, worktree_binding_generation,
			    receipt_id, bound_at)
			 VALUES ('run-manifest', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				input.nodeId,
				attempt,
				input.prNumber,
				input.headSha,
				input.repoIdentity ?? "__main__",
				input.probeRepoSlug ?? "geoforge3d/flywheel",
				`/tmp/${input.nodeId}`,
				`generation-${attempt}`,
				`binding-${input.nodeId}-${attempt}`,
				`2026-07-23T00:0${attempt}:00.000Z`,
			],
		);
	};
	return { store, insertBinding };
}

describe("FLY-1434 workflow PR manifest", () => {
	it("atomically binds a legacy approve question to its reviewed repository authority", async () => {
		const { store } = await fixture();
		store.upsertSession({
			execution_id: "legacy-ship",
			issue_id: "FLY-1434",
			project_name: "flywheel",
			status: "awaiting_review",
		});
		store.recordCodexReviewApproved({
			executionId: "review-author",
			targetPrHeadSha: HEAD_A,
			issueId: "FLY-1434",
			projectName: "flywheel",
			requestId: "review-request-1",
			authorFamily: "codex",
			reviewerFamily: "claude",
		});
		expect(
			store.findApprovedReviewShipTargetSource({
				projectName: "flywheel",
				issueId: "FLY-1434",
				targetRepoIdentity: "__main__",
				targetPrHeadSha: HEAD_A,
			}),
		).toEqual({
			status: "resolved",
			sourceRequestId: "review-request-1",
		});

		store.setReviewBinding("legacy-ship", {
			questionId: "approve-question",
			prHeadSha: HEAD_A,
			shipTarget: {
				runId: "run-manifest",
				sourceRequestId: "review-request-1",
				targetRepoPath: "/tmp/flywheel",
				targetRepoIdentity: "__main__",
				probeRepoSlug: "geoforge3d/flywheel",
				worktreeBindingGeneration: "generation-1",
			},
		});
		expect(store.getWorkflowShipTargetBinding("approve-question")).toEqual({
			approve_question_id: "approve-question",
			run_id: "run-manifest",
			source_request_id: "review-request-1",
			target_repo_path: "/tmp/flywheel",
			target_repo_identity: "__main__",
			probe_repo_slug: "geoforge3d/flywheel",
			frozen_head_sha: HEAD_A,
			worktree_binding_generation: "generation-1",
			superseded_at: null,
		});

		expect(() =>
			store.setReviewBinding("legacy-ship", {
				questionId: "approve-question",
				prHeadSha: HEAD_B,
				shipTarget: {
					targetRepoPath: "/tmp/flywheel",
					targetRepoIdentity: "__main__",
					probeRepoSlug: "geoforge3d/flywheel",
					worktreeBindingGeneration: "generation-1",
				},
			}),
		).toThrow("workflow_ship_target_binding_conflict");
		expect(store.getSession("legacy-ship")?.pr_head_sha).toBe(HEAD_A);

		store.setReviewBinding("legacy-ship", {
			questionId: "approve-question-2",
			prHeadSha: HEAD_B,
			shipTarget: {
				runId: "run-manifest",
				targetRepoPath: "/tmp/flywheel",
				targetRepoIdentity: "__main__",
				probeRepoSlug: "geoforge3d/flywheel",
				worktreeBindingGeneration: "generation-1",
			},
		});
		expect(
			store.getWorkflowShipTargetBinding("approve-question")?.superseded_at,
		).not.toBeNull();
		expect(
			store.getWorkflowShipTargetBinding("approve-question-2"),
		).toMatchObject({
			run_id: "run-manifest",
			frozen_head_sha: HEAD_B,
			superseded_at: null,
		});
		store.close();
	});

	it.each([0, 51, 1.5])("rejects invalid expected count %s", async (count) => {
		const { store } = await fixture();
		expect(
			store.openWorkflowPrManifest({
				runId: "run-manifest",
				expectedCount: count,
			}),
		).toEqual({
			ok: false,
			reason: "manifest_expected_count_invalid",
		});
		store.close();
	});

	it("seals only the exact current binding set and blocks finalization until all PRs merge", async () => {
		const { store, insertBinding } = await fixture();
		expect(
			store.openWorkflowPrManifest({
				runId: "run-manifest",
				expectedCount: 2,
				now: "2026-07-23T00:00:00.000Z",
			}),
		).toMatchObject({ ok: true, idempotentReplay: false });
		insertBinding({
			nodeId: "implement-main",
			prNumber: 1434,
			headSha: HEAD_A,
		});
		expect(
			store.sealWorkflowPrManifestFromBindings({
				runId: "run-manifest",
				now: "2026-07-23T00:03:00.000Z",
			}),
		).toEqual({
			ok: false,
			reason: "manifest_count_mismatch",
			expectedCount: 2,
			actualCount: 1,
		});
		insertBinding({
			nodeId: "implement-dashboard",
			prNumber: 77,
			headSha: HEAD_B,
			repoIdentity: "geoforge3d/flywheel-dashboard",
			probeRepoSlug: "geoforge3d/flywheel-dashboard",
		});
		expect(
			store.sealWorkflowPrManifestFromBindings({
				runId: "run-manifest",
				now: "2026-07-23T00:04:00.000Z",
			}),
		).toMatchObject({
			ok: true,
			manifest: { current_revision: 1, expected_count: 2 },
			idempotentReplay: false,
		});
		expect(store.listCurrentWorkflowDeclaredPrs("run-manifest")).toHaveLength(
			2,
		);
		expect(
			store.markWorkflowDeclaredPrMerged({
				runId: "run-manifest",
				prNumber: 1434,
				headSha: HEAD_A,
				repoIdentity: "__main__",
				now: "2026-07-23T00:05:00.000Z",
			}),
		).toEqual({
			ok: true,
			idempotentReplay: false,
			allMerged: false,
		});
		expect(
			store.claimWorkflowPrFinalization({
				runId: "run-manifest",
				sourceExecutionId: "implement-main-1",
				now: "2026-07-23T00:06:00.000Z",
			}),
		).toEqual({
			ok: false,
			reason: "manifest_incomplete",
			pendingCount: 1,
		});
		expect(
			store.markWorkflowDeclaredPrMerged({
				runId: "run-manifest",
				prNumber: 77,
				headSha: HEAD_B,
				repoIdentity: "geoforge3d/flywheel-dashboard",
				now: "2026-07-23T00:07:00.000Z",
			}),
		).toMatchObject({ ok: true, allMerged: true });
		expect(
			store.claimWorkflowPrFinalization({
				runId: "run-manifest",
				sourceExecutionId: "implement-main-1",
				now: "2026-07-23T00:08:00.000Z",
			}),
		).toEqual({
			ok: true,
			mode: "declared",
			revision: 1,
			idempotentReplay: false,
			completed: false,
		});
		expect(
			store.sealWorkflowPrManifestFromBindings({
				runId: "run-manifest",
				reopen: true,
			}),
		).toEqual({
			ok: true,
			manifest: expect.objectContaining({ current_revision: 1 }),
			idempotentReplay: true,
		});
		expect(
			store.setWorkflowPrFinalizationOutcome({
				runId: "run-manifest",
				completed: true,
				now: "2026-07-23T00:09:00.000Z",
			}),
		).toBe(true);
		expect(store.getWorkflowPrFinalization("run-manifest")).toMatchObject({
			state: "completed",
			revision: 1,
		});
		store.close();
	});

	it("reopens a changed current binding set before finalization and freezes after termination", async () => {
		const { store, insertBinding } = await fixture();
		store.openWorkflowPrManifest({
			runId: "run-manifest",
			expectedCount: 1,
			now: "2026-07-23T00:00:00.000Z",
		});
		insertBinding({ nodeId: "implement", prNumber: 1, headSha: HEAD_A });
		expect(
			store.sealWorkflowPrManifestFromBindings({
				runId: "run-manifest",
				now: "2026-07-23T00:02:00.000Z",
			}),
		).toMatchObject({ ok: true });
		insertBinding({
			nodeId: "implement",
			attempt: 2,
			prNumber: 2,
			headSha: HEAD_B,
		});
		expect(
			store.sealWorkflowPrManifestFromBindings({
				runId: "run-manifest",
				reopen: true,
				now: "2026-07-23T00:03:00.000Z",
			}),
		).toMatchObject({
			ok: true,
			manifest: { current_revision: 2 },
		});
		const db = (
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		db.run(
			"UPDATE workflow_run SET status = 'terminated' WHERE run_id = 'run-manifest'",
		);
		expect(
			store.sealWorkflowPrManifestFromBindings({
				runId: "run-manifest",
				reopen: true,
			}),
		).toEqual({
			ok: false,
			reason: "run_terminal_authority_frozen",
		});
		store.close();
	});

	it("keeps an active run without a manifest on single-PR semantics", async () => {
		const { store } = await fixture();
		expect(
			store.claimWorkflowPrFinalization({
				runId: "run-manifest",
				sourceExecutionId: "legacy-exec",
				now: "2026-07-23T00:00:00.000Z",
			}),
		).toEqual({
			ok: true,
			mode: "single",
			idempotentReplay: false,
		});
		store.close();
	});
});
