import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	canonicalJsonString,
	canonicalSubmissionDigest,
} from "flywheel-config";
import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import type {
	LandTargetSnapshotV1,
	LandTargetSnapshotV2,
} from "../land-intent-targets.js";
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
	for (const target of snapshot.targets) {
		if (target.kind !== "bound_worktree") continue;
		for (const executionId of target.sourceExecutionIds) {
			store.upsertSession({
				execution_id: executionId,
				issue_id: snapshot.issueUuid,
				project_name: snapshot.project,
				status: "completed",
			});
			store.bindWorktreeOnce(executionId, {
				path: target.path,
				branch: target.branch,
				generation: target.generation,
			});
		}
	}
	const attribution = store.getCloseoutAttributionSnapshot({
		projectName: snapshot.project,
		issueId: snapshot.issueUuid,
	});
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
			attributionDigest: attribution.digest,
			attributionEpoch: attribution.epoch,
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
	it("refuses every worktree effect after the captured attribution epoch changes", async () => {
		const { store, snapshot, claim } = await fixture();
		try {
			store.upsertSession({
				execution_id: "late-qa",
				issue_id: snapshot.issueUuid,
				project_name: snapshot.project,
				status: "completed",
			});
			const removeCleanWorktree = vi.fn();
			const remoteBranchCleanup = vi.fn();

			await expect(
				settleLandOperationWorktrees(
					{
						issueId: snapshot.issueUuid,
						projectName: snapshot.project,
						landOperation: claim,
					},
					{ store, removeCleanWorktree, remoteBranchCleanup },
					true,
				),
			).resolves.toMatchObject({
				complete: false,
				reason: "land_closeout_attribution_changed",
			});
			expect(removeCleanWorktree).not.toHaveBeenCalled();
			expect(remoteBranchCleanup).not.toHaveBeenCalled();
		} finally {
			store.close();
		}
	});

	it("rejects worktree-binding ABA even when the canonical attribution digest returns to its captured value", async () => {
		const { store, snapshot, claim } = await fixture();
		try {
			const operationBefore = store.getLandOperation(claim.operationId)!;
			const internals = store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			};
			internals.db.run(
				`UPDATE sessions SET worktree_binding_branch = 'temporary-branch'
				  WHERE execution_id = 'implement-2391'`,
			);
			internals.db.run(
				`UPDATE sessions SET worktree_binding_branch = 'flywheel-FLY-2391'
				  WHERE execution_id = 'implement-2391'`,
			);
			const current = store.getCloseoutAttributionSnapshot({
				projectName: snapshot.project,
				issueId: snapshot.issueUuid,
			});
			expect(current.digest).toBe(operationBefore.closeout_attribution_digest);
			expect(current.epoch).toBeGreaterThan(
				operationBefore.closeout_attribution_epoch!,
			);

			await expect(
				settleLandOperationWorktrees(
					{
						issueId: snapshot.issueUuid,
						projectName: snapshot.project,
						landOperation: claim,
					},
					{
						store,
						removeCleanWorktree: vi.fn(),
						remoteBranchCleanup: vi.fn(),
					},
					true,
				),
			).resolves.toMatchObject({
				complete: false,
				reason: "land_closeout_attribution_changed",
			});
		} finally {
			store.close();
		}
	});

	it("FLY-2662: settles a freshly rechecked legacy absence without invoking removal or branch cleanup", async () => {
		const root = await mkdtemp(join(tmpdir(), "fly2662-absent-settle-"));
		const projectRoot = join(root, "flywheel");
		const absentPath = join(root, "flywheel-FLY-9002");
		await mkdir(projectRoot);
		const canonicalRoot = await realpath(projectRoot);
		const canonicalParent = await realpath(root);
		const parent = await stat(canonicalParent);
		const store = await StateStore.create(":memory:");
		try {
			const snapshot: LandTargetSnapshotV2 = {
				version: 2,
				project: "flywheel",
				issueUuid: "FLY-9002",
				runId: null,
				targets: [
					{
						kind: "verified_absent_worktree",
						evidenceMode: "legacy_absence_observation",
						path: join(canonicalParent, "flywheel-FLY-9002"),
						branch: "flywheel-FLY-9002",
						generation: "generation-predeploy",
						projectRoot: canonicalRoot,
						parentIdentity: {
							path: canonicalParent,
							dev: Number(parent.dev),
							ino: Number(parent.ino),
						},
						sourceExecutionIds: ["implement-predeploy"],
						sourceRunId: null,
						sourceReceipt: "reclose_migration:request:binding",
						observedAt: "2026-09-17T20:40:00.000Z",
					},
				],
			};
			store.upsertSession({
				execution_id: "implement-predeploy",
				issue_id: snapshot.issueUuid,
				project_name: snapshot.project,
				status: "completed",
			});
			store.bindWorktreeOnce("implement-predeploy", {
				path: absentPath,
				branch: "flywheel-FLY-9002",
				generation: "generation-predeploy",
			});
			const attribution = store.getCloseoutAttributionSnapshot({
				projectName: snapshot.project,
				issueId: snapshot.issueUuid,
			});
			const operation = store.ensureLandOperation({
				issueId: snapshot.issueUuid,
				projectName: snapshot.project,
				prNumber: 9002,
				approvedHead: HEAD,
				now: "2026-09-17T20:40:00.000Z",
				verifiedTargets: {
					json: canonicalJsonString(snapshot),
					digest: canonicalSubmissionDigest(snapshot),
					version: 2,
					attributionDigest: attribution.digest,
					attributionEpoch: attribution.epoch,
					observedAt: "2026-09-17T20:40:00.000Z",
				},
			});
			const claim = store.claimLandOperation({
				operationId: operation.operation_id,
				ownerId: "land-worker",
				now: "2026-09-17T20:40:01.000Z",
				leaseExpiresAt: "2099-09-17T20:41:01.000Z",
			})!;
			const removeCleanWorktree = vi.fn();
			const remoteBranchCleanup = vi.fn();

			const settled = await settleLandOperationWorktrees(
				{
					issueId: snapshot.issueUuid,
					projectName: snapshot.project,
					landOperation: claim,
					operationContext: {
						operationId: claim.operationId,
						ownerId: claim.ownerId,
						generation: claim.generation,
						mergeReceiptId: "merge-9002",
					},
				},
				{ store, removeCleanWorktree, remoteBranchCleanup },
				true,
			);
			expect(settled).toEqual({ complete: true, attestations: [] });
			expect(removeCleanWorktree).not.toHaveBeenCalled();
			expect(remoteBranchCleanup).not.toHaveBeenCalled();

			await mkdir(absentPath);
			await expect(
				settleLandOperationWorktrees(
					{
						issueId: snapshot.issueUuid,
						projectName: snapshot.project,
						landOperation: claim,
						operationContext: {
							operationId: claim.operationId,
							ownerId: claim.ownerId,
							generation: claim.generation,
							mergeReceiptId: "merge-9002",
						},
					},
					{ store, removeCleanWorktree, remoteBranchCleanup },
					true,
				),
			).resolves.toMatchObject({
				complete: false,
				reason: "legacy_absent_worktree_reappeared",
			});
			expect(removeCleanWorktree).not.toHaveBeenCalled();
		} finally {
			store.close();
			await rm(root, { recursive: true, force: true });
		}
	});

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

	it.each([
		["branch_mismatch", "branch_mismatch"],
		["not_registered", "not_registered"],
		["dirty", "dirty"],
		["clean_unknown", "clean_unknown"],
		["binding_mismatch", "binding_mismatch"],
		["remove_failed:ref_moved", "remove_failed"],
		["parent_unavailable", "unknown"],
	] as const)(
		"returns typed worktree failure for %s and stops at the first failed target",
		async (skippedReason, failure) => {
			const { store, claim } = await fixture();
			try {
				const removeCleanWorktree = vi.fn().mockResolvedValue({
					removed: false,
					cleanupState: "blocked",
					bindingVerified: false,
					skippedReason,
				});
				const result = await settleLandOperationWorktrees(
					{
						issueId: "issue-2616",
						projectName: "flywheel",
						landOperation: claim,
					},
					{ store, removeCleanWorktree },
					true,
				);

				expect(result).toMatchObject({
					complete: false,
					failure: { token: failure, detail: skippedReason },
				});
				expect(removeCleanWorktree).toHaveBeenCalledTimes(1);
			} finally {
				store.close();
			}
		},
	);
});
