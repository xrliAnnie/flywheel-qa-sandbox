import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { legacyWorkflowSeeds } from "../../__tests__/fixtures/legacy-workflow-manifests.js";
import { StateStore } from "../../StateStore.js";
import { buildWorkflowRunSnapshotV1 } from "../../workflow-run-snapshot.js";
import {
	executeLandOperation,
	type LandMergeDriver,
} from "../land-executor.js";

const HEAD = "a".repeat(40);
const MERGE = "b".repeat(40);

async function fixture() {
	const store = await StateStore.create(":memory:");
	const operation = store.ensureLandOperation({
		runId: "run-1",
		issueId: "issue-1",
		projectName: "flywheel",
		prNumber: 1375,
		approvedHead: HEAD,
		now: "2026-07-21T20:00:00.000Z",
	});
	return { store, operation };
}

describe("land executor", () => {
	it("holds a direct engine land attempt when founder_review has not passed even if the artifact checkout disables it", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1758-land-"));
		try {
			mkdirSync(join(root, ".flywheel"), { recursive: true });
			writeFileSync(
				join(root, ".flywheel", "config.yaml"),
				"project: flywheel\nlinear:\n  team_id: FLY\nrunners:\n  default: claude\n  available:\n    claude:\n      type: claude\nteams:\n  - name: default\n    orchestrators:\n      - type: dag\n        runner: claude\ndecision_layer:\n  autonomy_level: advisor\n  escalation_channel: discord\ncheckpoints:\n  founder_review:\n    enabled: false\n    timeout_ms: 172800000\n    timeout_behavior: fail-close\n",
			);
			const store = await StateStore.create(":memory:");
			const seed = legacyWorkflowSeeds().find(
				(candidate) => candidate.templateId === "tpl_eng_heavy_land_v1",
			)!;
			const manifest = {
				...seed.manifest,
				nodes: seed.manifest.nodes.map((node) =>
					node.id === "implement"
						? { ...node, founder_review: true as const }
						: node,
				),
			};
			store.createWorkflowRun({
				runId: "run-review",
				issueId: "issue-review",
				projectName: "flywheel",
				snapshotJson: JSON.stringify(
					buildWorkflowRunSnapshotV1({
						template: { id: seed.templateId, revision: 1 },
						manifest,
					}),
				),
				claimsReadEnrolled: true,
			});
			const sql = (
				store as unknown as {
					db: { run(sql: string, params?: unknown[]): void };
				}
			).db;
			sql.run(
				"UPDATE workflow_run SET engine_owned = 1, current_node_id = 'land' WHERE run_id = 'run-review'",
			);
			store.upsertWorkflowRunNode({
				runId: "run-review",
				nodeId: "implement",
				attempt: 1,
				state: "done",
				executionId: "implement-review",
			});
			sql.run(
				`INSERT INTO workflow_node_pr_binding
				   (run_id, node_id, attempt, pr_number, head_sha,
				    target_repo_identity, probe_repo_slug, target_repo_path,
				    worktree_binding_generation, receipt_id, bound_at)
				 VALUES ('run-review', 'implement', 1, 1758, ?,
				         '__main__', 'geoforge3d/flywheel', ?,
				         'generation-1', 'review-binding',
				         '2026-08-14T00:00:00.000Z')`,
				[HEAD, root],
			);
			store.ensureWorkflowGateHolder({
				runId: "run-review",
				gateNodeId: "founder_gate",
				attempt: 1,
				headSha: HEAD,
				sourceExecutionId: "implement-review",
				questionId: "ship-question",
				now: "2026-08-14T00:00:00.000Z",
			});
			sql.run(
				"UPDATE workflow_gate_holder SET state = 'approved' WHERE question_id = 'ship-question'",
			);
			const operation = store.ensureLandOperation({
				runId: "run-review",
				issueId: "issue-review",
				projectName: "flywheel",
				prNumber: 1758,
				approvedHead: HEAD,
				now: "2026-08-14T00:00:00.000Z",
			});
			const inspectPr = vi.fn();
			const result = await executeLandOperation(operation.operation_id, {
				store,
				mergeDriver: {
					inspectPr,
					triggerCool: vi.fn(),
					inspectTriggeredWorkflow: vi.fn(),
				},
				finalize: vi.fn(),
				ownerId: "worker",
				now: () => new Date("2026-08-14T00:01:00.000Z"),
			});
			expect(result).toMatchObject({
				status: "partial",
				reason: "founder_review_missing",
			});
			expect(inspectPr).not.toHaveBeenCalled();
			store.close();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects a nested repository before calling the merge driver", async () => {
		const store = await StateStore.create(":memory:");
		const seed = legacyWorkflowSeeds().find(
			(candidate) => candidate.templateId === "tpl_eng_heavy_land_v1",
		)!;
		store.createWorkflowRun({
			runId: "run-nested",
			issueId: "issue-nested",
			projectName: "flywheel",
			snapshotJson: JSON.stringify(
				buildWorkflowRunSnapshotV1({
					template: { id: seed.templateId, revision: 1 },
					manifest: seed.manifest,
				}),
			),
			claimsReadEnrolled: true,
		});
		const db = (
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		db.run(
			"UPDATE workflow_run SET engine_owned = 1, current_node_id = 'land' WHERE run_id = 'run-nested'",
		);
		store.upsertWorkflowRunNode({
			runId: "run-nested",
			nodeId: "implement",
			attempt: 1,
			state: "done",
			executionId: "implement-nested",
		});
		db.run(
			`INSERT INTO workflow_node_pr_binding
			   (run_id, node_id, attempt, pr_number, head_sha,
			    target_repo_identity, probe_repo_slug, target_repo_path,
			    worktree_binding_generation, receipt_id, bound_at)
			 VALUES ('run-nested', 'implement', 1, 1375, ?,
			         'geoforge3d/nested', 'geoforge3d/nested', '/tmp/nested',
			         'generation-1', 'nested-binding',
			         '2026-07-21T19:59:00.000Z')`,
			[HEAD],
		);
		store.ensureWorkflowGateHolder({
			runId: "run-nested",
			gateNodeId: "founder_gate",
			attempt: 1,
			headSha: HEAD,
			sourceExecutionId: "qa-nested",
			questionId: "nested-question",
			now: "2026-07-21T20:00:00.000Z",
		});
		db.run(
			"UPDATE workflow_gate_holder SET state = 'approved' WHERE question_id = 'nested-question'",
		);
		const operation = store.ensureLandOperation({
			runId: "run-nested",
			issueId: "issue-nested",
			projectName: "flywheel",
			prNumber: 1375,
			approvedHead: HEAD,
			now: "2026-07-21T20:00:00.000Z",
		});
		const inspectPr = vi.fn();
		const result = await executeLandOperation(operation.operation_id, {
			store,
			mergeDriver: {
				inspectPr,
				triggerCool: vi.fn(),
				inspectTriggeredWorkflow: vi.fn(),
			},
			finalize: vi.fn(),
			ownerId: "worker",
			now: () => new Date("2026-07-21T20:01:00.000Z"),
		});
		expect(result).toMatchObject({
			status: "held",
			reason: "nested_land_unsupported",
		});
		expect(inspectPr).not.toHaveBeenCalled();
		store.close();
	});

	it("triggers sanctioned merge once, yields while pending, then resumes finalization", async () => {
		const { store, operation } = await fixture();
		let merged = false;
		const triggerCool = vi.fn().mockResolvedValue({
			commentId: "9001",
			commentUrl: "https://github.test/pull/1375#issuecomment-9001",
		});
		const mergeDriver: LandMergeDriver = {
			inspectPr: vi
				.fn()
				.mockImplementation(async () =>
					merged
						? { state: "MERGED", headSha: HEAD, mergeSha: MERGE }
						: { state: "OPEN", headSha: HEAD },
				),
			triggerCool,
			inspectTriggeredWorkflow: vi
				.fn()
				.mockImplementation(async () => ({ state: "pending" })),
		};
		const finalize = vi.fn().mockResolvedValue({
			complete: true,
			outcome: "completed",
		});
		let tick = 0;
		const deps = {
			store,
			mergeDriver,
			finalize,
			authorize: () => ({ ok: true as const }),
			ownerId: "worker",
			now: () => new Date(`2026-07-21T20:0${tick++}:00.000Z`),
		};

		expect(
			await executeLandOperation(operation.operation_id, deps),
		).toMatchObject({
			status: "partial",
			reason: "ship_workflow_pending",
		});
		merged = true;
		expect(
			await executeLandOperation(operation.operation_id, deps),
		).toMatchObject({
			status: "completed",
		});
		expect(triggerCool).toHaveBeenCalledTimes(1);
		expect(finalize).toHaveBeenCalledTimes(1);
		expect(
			store.listLandOperationSteps(operation.operation_id).map((s) => s.step),
		).toEqual([
			"authority_verified",
			"cool_triggered",
			"merge_confirmed",
			"cleanup_requested",
			"finalization_completed",
		]);
		expect(store.getLandOperation(operation.operation_id)).toMatchObject({
			state: "completed",
			merge_confirmed_at: expect.any(String),
			finalization_completed_at: expect.any(String),
		});
		store.close();
	});

	it("holds on a head mismatch without triggering merge", async () => {
		const { store, operation } = await fixture();
		const triggerCool = vi.fn();
		const result = await executeLandOperation(operation.operation_id, {
			store,
			mergeDriver: {
				inspectPr: vi.fn().mockResolvedValue({
					state: "OPEN",
					headSha: "c".repeat(40),
				}),
				triggerCool,
				inspectTriggeredWorkflow: vi.fn(),
			},
			finalize: vi.fn(),
			authorize: () => ({ ok: true }),
			ownerId: "worker",
			now: () => new Date("2026-07-21T20:01:00.000Z"),
		});
		expect(result).toMatchObject({
			status: "held",
			reason: "pr_head_mismatch",
		});
		expect(triggerCool).not.toHaveBeenCalled();
		store.close();
	});

	it("skips :cool: when the exact head is already merged", async () => {
		const { store, operation } = await fixture();
		const triggerCool = vi.fn();
		const finalize = vi.fn().mockResolvedValue({
			complete: true,
			outcome: "completed",
		});
		const result = await executeLandOperation(operation.operation_id, {
			store,
			mergeDriver: {
				inspectPr: vi.fn().mockResolvedValue({
					state: "MERGED",
					headSha: HEAD,
					mergeSha: MERGE,
				}),
				triggerCool,
				inspectTriggeredWorkflow: vi.fn(),
			},
			finalize,
			authorize: () => ({ ok: true }),
			ownerId: "worker",
			now: () => new Date("2026-07-21T20:01:00.000Z"),
		});
		expect(result.status).toBe("completed");
		expect(triggerCool).not.toHaveBeenCalled();
		expect(finalize).toHaveBeenCalledOnce();
		store.close();
	});

	it("releases the lease after a transient driver error and resumes on the next sweep", async () => {
		const { store, operation } = await fixture();
		const inspectPr = vi
			.fn()
			.mockRejectedValueOnce(new Error("github temporarily unavailable"))
			.mockResolvedValue({
				state: "MERGED",
				headSha: HEAD,
				mergeSha: MERGE,
			});
		let tick = 1;
		const deps = {
			store,
			mergeDriver: {
				inspectPr,
				triggerCool: vi.fn(),
				inspectTriggeredWorkflow: vi.fn(),
			} satisfies LandMergeDriver,
			finalize: vi.fn().mockResolvedValue({
				complete: true,
				outcome: "completed" as const,
			}),
			authorize: () => ({ ok: true as const }),
			ownerId: "worker",
			now: () => new Date(`2026-07-21T20:0${tick++}:00.000Z`),
		};

		await expect(
			executeLandOperation(operation.operation_id, deps),
		).resolves.toMatchObject({
			status: "partial",
			reason: "land_execution_error:github temporarily unavailable",
		});
		expect(store.getLandOperation(operation.operation_id)).toMatchObject({
			state: "partial",
			owner_id: null,
			lease_expires_at: null,
		});
		await expect(
			executeLandOperation(operation.operation_id, deps),
		).resolves.toMatchObject({ status: "completed" });
		store.close();
	});

	it("retries a failed stage notification before triggering the sanctioned merge", async () => {
		const { store, operation } = await fixture();
		const triggerCool = vi.fn();
		const notify = vi
			.fn()
			.mockRejectedValueOnce(new Error("discord unavailable"))
			.mockResolvedValue(undefined);
		let tick = 1;
		const deps = {
			store,
			mergeDriver: {
				inspectPr: vi.fn().mockResolvedValue({
					state: "MERGED",
					headSha: HEAD,
					mergeSha: MERGE,
				}),
				triggerCool,
				inspectTriggeredWorkflow: vi.fn(),
			} satisfies LandMergeDriver,
			finalize: vi.fn().mockResolvedValue({
				complete: true,
				outcome: "completed" as const,
			}),
			notify,
			authorize: () => ({ ok: true as const }),
			ownerId: "worker",
			now: () => new Date(`2026-07-21T20:0${tick++}:00.000Z`),
		};

		await expect(
			executeLandOperation(operation.operation_id, deps),
		).resolves.toMatchObject({
			status: "partial",
			reason: "land_execution_error:discord unavailable",
		});
		expect(triggerCool).not.toHaveBeenCalled();
		await expect(
			executeLandOperation(operation.operation_id, deps),
		).resolves.toMatchObject({ status: "completed" });
		const notifications = store
			.listLandOperationSteps(operation.operation_id)
			.filter((step) => step.step.startsWith("notification:"))
			.map((step) => step.step);
		expect(notifications).toHaveLength(5);
		expect(notifications).toEqual(
			expect.arrayContaining([
				"notification:activated",
				"notification:execution_retry",
				"notification:merge_confirmed",
				"notification:cleanup_requested",
				"notification:completed",
			]),
		);
		store.close();
	});

	it("ignores a losing duplicate workflow failure when the exact head is already merged", async () => {
		const { store, operation } = await fixture();
		const inspectPr = vi
			.fn()
			.mockResolvedValueOnce({ state: "OPEN", headSha: HEAD })
			.mockResolvedValue({
				state: "MERGED",
				headSha: HEAD,
				mergeSha: MERGE,
			});
		const result = await executeLandOperation(operation.operation_id, {
			store,
			mergeDriver: {
				inspectPr,
				triggerCool: vi.fn().mockResolvedValue({ commentId: "9001" }),
				inspectTriggeredWorkflow: vi.fn().mockResolvedValue({
					state: "failed",
					reason: "failure",
				}),
			},
			finalize: vi.fn().mockResolvedValue({
				complete: true,
				outcome: "completed",
			}),
			authorize: () => ({ ok: true }),
			ownerId: "worker",
			now: () => new Date("2026-07-21T20:01:00.000Z"),
		});

		expect(result.status).toBe("completed");
		expect(store.getLandOperation(operation.operation_id)?.state).toBe(
			"completed",
		);
		store.close();
	});
});
