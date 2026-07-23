import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	runPostShipFinalization,
	runResumablePostShipFinalization,
} from "../post-ship-finalization.js";

const HEAD = "a".repeat(40);

describe("FLY-1434 multi-PR finalization guard", () => {
	it("returns partial before every cleanup side effect while one declared PR is open", async () => {
		const store = await StateStore.create(":memory:");
		store.createWorkflowRun({
			runId: "run-multi",
			issueId: "FLY-1434",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		const db = (
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		store.openWorkflowPrManifest({
			runId: "run-multi",
			expectedCount: 2,
			now: "2026-07-23T00:00:00.000Z",
		});
		for (const [nodeId, prNumber, headSha] of [
			["implement-a", 1, HEAD],
			["implement-b", 2, "b".repeat(40)],
		] as const) {
			store.upsertWorkflowRunNode({
				runId: "run-multi",
				nodeId,
				attempt: 1,
				state: "done",
				executionId: `${nodeId}-exec`,
			});
			db.run(
				`INSERT INTO workflow_node_pr_binding
				   (run_id, node_id, attempt, pr_number, head_sha,
				    target_repo_identity, probe_repo_slug, target_repo_path,
				    worktree_binding_generation, receipt_id, bound_at)
				 VALUES ('run-multi', ?, 1, ?, ?, '__main__',
				         'geoforge3d/flywheel', ?, 'generation-1', ?, ?)`,
				[
					nodeId,
					prNumber,
					headSha,
					`/tmp/${nodeId}`,
					`receipt-${nodeId}`,
					"2026-07-23T00:01:00.000Z",
				],
			);
		}
		store.sealWorkflowPrManifestFromBindings({
			runId: "run-multi",
			now: "2026-07-23T00:02:00.000Z",
		});
		const removeCleanWorktree = vi.fn();
		const markIssueDone = vi.fn();

		const result = await runResumablePostShipFinalization(
			{
				executionId: "implement-a-exec",
				runId: "run-multi",
				mergedPr: { prNumber: 1, headSha: HEAD },
				issueId: "FLY-1434",
				projectName: "flywheel",
				sessionStatus: "completed",
			},
			{
				store,
				projects: [],
				removeCleanWorktree,
				markIssueDone,
			},
		);

		expect(result).toMatchObject({
			complete: false,
			outcome: "partial",
			reason: expect.stringContaining("partial delivery must stay flag-off"),
		});
		expect(removeCleanWorktree).not.toHaveBeenCalled();
		expect(markIssueDone).not.toHaveBeenCalled();
		expect(store.getWorkflowPrFinalization("run-multi")).toBeUndefined();
		expect(
			store
				.getEventsByExecution("implement-a-exec")
				.some((event) => event.event_type === "post_ship_finalization_claim"),
		).toBe(false);

		store.markWorkflowDeclaredPrMerged({
			runId: "run-multi",
			prNumber: 2,
			headSha: "b".repeat(40),
		});
		store.insertEvent({
			event_id: "post-ship-finalization-implement-a-exec",
			execution_id: "implement-a-exec",
			issue_id: "FLY-1434",
			project_name: "flywheel",
			event_type: "post_ship_finalization_claim",
			source: "test",
		});
		await runPostShipFinalization(
			{
				executionId: "implement-a-exec",
				runId: "run-multi",
				issueId: "FLY-1434",
				projectName: "flywheel",
				sessionStatus: "completed",
			},
			{
				store,
				projects: [],
				removeCleanWorktree,
				markIssueDone,
			},
		);
		expect(removeCleanWorktree).not.toHaveBeenCalled();
		expect(markIssueDone).not.toHaveBeenCalled();
		store.close();
	});
});
