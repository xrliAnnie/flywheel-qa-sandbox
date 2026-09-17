import {
	canonicalJsonString,
	canonicalSubmissionDigest,
} from "flywheel-config";
import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import type { LandTargetSnapshotV1 } from "../land-intent-targets.js";
import { settleLandOperationWorktrees } from "../post-ship-finalization.js";

const HEAD = "a".repeat(40);

async function fixture() {
	const store = await StateStore.create(":memory:");
	const snapshot: LandTargetSnapshotV1 = {
		version: 1,
		project: "flywheel",
		issueUuid: "issue-2616",
		runId: null,
		targets: [
			{
				kind: "bound_worktree",
				path: "/Users/x/Dev/flywheel-FLY-2391",
				branch: "flywheel-FLY-2391",
				generation: "generation-2391",
				projectRoot: "/Users/x/Dev/flywheel",
				parentIdentity: { path: "/Users/x/Dev", dev: 7, ino: 11 },
				sourceExecutionIds: ["implement-2391"],
				sourceRunId: null,
				sourceReceipt: "state_session_binding:implement-2391:generation-2391",
			},
			{
				kind: "bound_worktree",
				path: "/Users/x/Dev/flywheel-FLY-2602",
				branch: "flywheel-FLY-2602",
				generation: "generation-2602",
				projectRoot: "/Users/x/Dev/flywheel",
				parentIdentity: { path: "/Users/x/Dev", dev: 7, ino: 11 },
				sourceExecutionIds: ["implement-2602"],
				sourceRunId: null,
				sourceReceipt: "state_session_binding:implement-2602:generation-2602",
			},
			{
				kind: "worktree_not_applicable",
				executionId: "land-engine",
				reason: "pinned_engine_execution",
				nodeType: "land",
				dispatchReceipt: "activation-land",
			},
		],
	};
	const now = Date.now();
	const operation = store.ensureLandOperation({
		issueId: snapshot.issueUuid,
		projectName: snapshot.project,
		prNumber: 2616,
		approvedHead: HEAD,
		now: new Date(now - 1_000).toISOString(),
		verifiedTargets: {
			json: canonicalJsonString(snapshot),
			digest: canonicalSubmissionDigest(snapshot),
			version: 1,
			attributionDigest: canonicalSubmissionDigest([
				"implement-2391",
				"implement-2602",
				"land-engine",
			]),
			observedAt: new Date(now - 1_000).toISOString(),
		},
	});
	const claim = store.claimLandOperation({
		operationId: operation.operation_id,
		ownerId: "land-worker",
		now: new Date(now).toISOString(),
		leaseExpiresAt: new Date(now + 60_000).toISOString(),
	});
	if (!claim) throw new Error("land claim unavailable");
	return { store, snapshot, claim };
}

describe("FLY-2616 operation worktree closeout", () => {
	it("settles only after every frozen target is removed, absent, or not applicable", async () => {
		const { store, claim } = await fixture();
		try {
			const removeCleanWorktree = vi
				.fn()
				.mockResolvedValueOnce({
					removed: true,
					cleanupState: "removed",
					bindingVerified: true,
					actualBranch: "flywheel-FLY-2391",
					headSha: HEAD,
				})
				.mockResolvedValueOnce({
					removed: false,
					cleanupState: "absent",
					bindingVerified: false,
					absentEvidence: {
						path: "/Users/x/Dev/flywheel-FLY-2602",
						observedAt: new Date().toISOString(),
						bindingGeneration: "generation-2602",
						operationId: claim.operationId,
					},
				});
			const remoteBranchCleanup = vi.fn(async () => {});

			const result = await settleLandOperationWorktrees(
				{
					issueId: "issue-2616",
					projectName: "flywheel",
					operationContext: {
						operationId: claim.operationId,
						ownerId: claim.ownerId,
						generation: claim.generation,
						mergeReceiptId: "merge-2616",
					},
					landOperation: claim,
				},
				{ store, removeCleanWorktree, remoteBranchCleanup },
				true,
			);

			expect(result).toMatchObject({ complete: true });
			expect(removeCleanWorktree).toHaveBeenCalledTimes(2);
			expect(
				removeCleanWorktree.mock.calls.map(
					(call) => call[0].operationContext.target.path,
				),
			).toEqual([
				"/Users/x/Dev/flywheel-FLY-2391",
				"/Users/x/Dev/flywheel-FLY-2602",
			]);
			expect(remoteBranchCleanup).toHaveBeenCalledTimes(1);
			expect(remoteBranchCleanup).toHaveBeenCalledWith(
				expect.objectContaining({ executionId: "implement-2391" }),
			);
			expect(
				store
					.listLandOperationSteps(claim.operationId)
					.some((step) =>
						step.step.includes("worktree_cleanup_not_applicable"),
					),
			).toBe(true);
		} finally {
			store.close();
		}
	});

	it("fails closed when any frozen target has no cleanup proof", async () => {
		const { store, claim } = await fixture();
		try {
			const removeCleanWorktree = vi.fn().mockResolvedValue({
				removed: false,
				cleanupState: "blocked",
				bindingVerified: false,
				skippedReason: "parent_unavailable",
			});
			const result = await settleLandOperationWorktrees(
				{
					issueId: "issue-2616",
					projectName: "flywheel",
					operationContext: {
						operationId: claim.operationId,
						ownerId: claim.ownerId,
						generation: claim.generation,
						mergeReceiptId: "merge-2616",
					},
					landOperation: claim,
				},
				{ store, removeCleanWorktree },
				true,
			);

			expect(result).toMatchObject({
				complete: false,
				reason: "parent_unavailable",
			});
			expect(removeCleanWorktree).toHaveBeenCalledTimes(1);
		} finally {
			store.close();
		}
	});
});
