import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { legacyWorkflowSeeds } from "../../__tests__/fixtures/legacy-workflow-manifests.js";
import { StateStore } from "../../StateStore.js";
import { buildWorkflowRunSnapshotV1 } from "../../workflow-run-snapshot.js";
import { prepareLandIntent } from "../land-intent-targets.js";

describe("land intent target snapshot", () => {
	const roots: string[] = [];

	afterEach(async () => {
		await Promise.all(
			roots.splice(0).map((root) => rm(root, { recursive: true })),
		);
	});

	it("persists a verified worktree target before the disposable session row disappears", async () => {
		const parent = await mkdtemp(join(tmpdir(), "fly2616-targets-"));
		roots.push(parent);
		const projectRoot = join(parent, "flywheel");
		const worktreePath = join(parent, "flywheel-FLY-2616");
		await mkdir(projectRoot);
		await mkdir(worktreePath);
		const store = await StateStore.create(":memory:");
		try {
			store.upsertSession({
				execution_id: "implement-1",
				issue_id: "issue-1",
				project_name: "flywheel",
				status: "completed",
			});
			store.bindWorktreeOnce("implement-1", {
				path: worktreePath,
				branch: "flywheel-FLY-2616",
				generation: "generation-1",
			});

			const result = await prepareLandIntent(
				store,
				{
					issueId: "issue-1",
					projectName: "flywheel",
					prNumber: 2616,
					approvedHead: "a".repeat(40),
					now: "2026-09-16T05:20:00.000Z",
				},
				{
					resolveProjectRoot: () => projectRoot,
					getRegisteredWorktree: async () => ({
						path: await realpath(worktreePath),
						branch: "flywheel-FLY-2616",
						head: "b".repeat(40),
						isDetached: false,
					}),
					readWorktreeGeneration: async () => "generation-1",
				},
			);

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.operation).toMatchObject({
				closeout_targets_version: 1,
			});
			const snapshot = JSON.parse(result.operation.closeout_targets_json!);
			expect(snapshot.targets).toMatchObject([
				{
					kind: "bound_worktree",
					branch: "flywheel-FLY-2616",
					generation: "generation-1",
					sourceExecutionIds: ["implement-1"],
				},
			]);

			const internals = store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			};
			internals.db.run("DELETE FROM sessions WHERE execution_id = ?", [
				"implement-1",
			]);
			expect(store.getSession("implement-1")).toBeUndefined();
			expect(
				store.getLandOperation(result.operation.operation_id)
					?.closeout_targets_json,
			).toBe(result.operation.closeout_targets_json);
		} finally {
			store.close();
		}
	});

	it("excludes the bindingless land engine execution from closeout targets", async () => {
		const parent = await mkdtemp(join(tmpdir(), "fly2616-targets-"));
		roots.push(parent);
		const projectRoot = join(parent, "flywheel");
		const worktreePath = join(parent, "flywheel-FLY-2616");
		await mkdir(projectRoot);
		await mkdir(worktreePath);
		const store = await StateStore.create(":memory:");
		try {
			const seed = legacyWorkflowSeeds().find(
				(candidate) => candidate.templateId === "tpl_eng_heavy_land_v1",
			)!;
			store.createWorkflowRun({
				runId: "run-1",
				issueId: "issue-1",
				projectName: "flywheel",
				snapshotJson: JSON.stringify(
					buildWorkflowRunSnapshotV1({
						template: { id: seed.templateId, revision: 1 },
						manifest: seed.manifest,
					}),
				),
				claimsReadEnrolled: true,
			});
			store.upsertWorkflowRunNode({
				runId: "run-1",
				nodeId: "implement",
				attempt: 1,
				state: "done",
				executionId: "implement-1",
			});
			store.upsertWorkflowRunNode({
				runId: "run-1",
				nodeId: "land",
				attempt: 1,
				state: "running",
				executionId: "land-engine-1",
			});
			store.upsertSession({
				execution_id: "implement-1",
				issue_id: "issue-1",
				project_name: "flywheel",
				status: "completed",
			});
			store.bindWorktreeOnce("implement-1", {
				path: worktreePath,
				branch: "flywheel-FLY-2616",
				generation: "generation-1",
			});

			const result = await prepareLandIntent(
				store,
				{
					runId: "run-1",
					issueId: "issue-1",
					projectName: "flywheel",
					prNumber: 2616,
					approvedHead: "a".repeat(40),
					now: "2026-09-16T05:20:00.000Z",
				},
				{
					resolveProjectRoot: () => projectRoot,
					getRegisteredWorktree: async () => ({
						path: await realpath(worktreePath),
						branch: "flywheel-FLY-2616",
						isDetached: false,
					}),
					readWorktreeGeneration: async () => "generation-1",
				},
			);

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(JSON.parse(result.operation.closeout_targets_json!)).toMatchObject(
				{
					targets: [
						{
							kind: "bound_worktree",
							sourceExecutionIds: ["implement-1"],
						},
					],
				},
			);
		} finally {
			store.close();
		}
	});

	it("refuses intent creation when registration no longer matches the durable binding", async () => {
		const parent = await mkdtemp(join(tmpdir(), "fly2616-targets-"));
		roots.push(parent);
		const projectRoot = join(parent, "flywheel");
		const worktreePath = join(parent, "flywheel-FLY-2616");
		await mkdir(projectRoot);
		await mkdir(worktreePath);
		const store = await StateStore.create(":memory:");
		try {
			store.upsertSession({
				execution_id: "implement-1",
				issue_id: "issue-1",
				project_name: "flywheel",
				status: "completed",
			});
			store.bindWorktreeOnce("implement-1", {
				path: worktreePath,
				branch: "flywheel-FLY-2616",
				generation: "generation-1",
			});

			const result = await prepareLandIntent(
				store,
				{
					issueId: "issue-1",
					projectName: "flywheel",
					prNumber: 2616,
					approvedHead: "a".repeat(40),
					now: "2026-09-16T05:20:00.000Z",
				},
				{
					resolveProjectRoot: () => projectRoot,
					getRegisteredWorktree: async () => null,
					readWorktreeGeneration: async () => "generation-1",
				},
			);

			expect(result).toMatchObject({
				ok: false,
				reason: "land_target_snapshot_unavailable",
				missing: ["implement-1:worktree_not_registered"],
				retryable: true,
			});
			expect(
				store.getLatestLandOperationForIssue("flywheel", "issue-1"),
			).toBeUndefined();
		} finally {
			store.close();
		}
	});

	it("captures a self-started live branch when its registered head exactly matches the approved PR head", async () => {
		const parent = await mkdtemp(join(tmpdir(), "fly2664-targets-"));
		roots.push(parent);
		const projectRoot = join(parent, "flywheel");
		const worktreePath = join(parent, "flywheel-FLY-2664");
		await mkdir(projectRoot);
		await mkdir(worktreePath);
		const store = await StateStore.create(":memory:");
		try {
			store.upsertSession({
				execution_id: "implement-1",
				issue_id: "issue-1",
				project_name: "flywheel",
				status: "completed",
			});
			store.bindWorktreeOnce("implement-1", {
				path: worktreePath,
				branch: "flywheel-FLY-2664",
				generation: "generation-1",
			});
			const approvedHead = "a".repeat(40);
			const result = await prepareLandIntent(
				store,
				{
					issueId: "issue-1",
					projectName: "flywheel",
					prNumber: 2664,
					approvedHead,
					now: "2026-09-17T05:20:00.000Z",
				},
				{
					resolveProjectRoot: () => projectRoot,
					getRegisteredWorktree: async () => ({
						path: await realpath(worktreePath),
						branch: "docs/FLY-2664-cleanup",
						head: approvedHead,
						isDetached: false,
					}),
					readWorktreeGeneration: async () => "generation-1",
				},
			);

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(JSON.parse(result.operation.closeout_targets_json!)).toMatchObject(
				{
					targets: [
						{
							kind: "bound_worktree",
							branch: "docs/FLY-2664-cleanup",
							generation: "generation-1",
						},
					],
				},
			);
		} finally {
			store.close();
		}
	});

	it("refuses a self-started live branch whose head is not the approved PR head", async () => {
		const parent = await mkdtemp(join(tmpdir(), "fly2664-targets-"));
		roots.push(parent);
		const projectRoot = join(parent, "flywheel");
		const worktreePath = join(parent, "flywheel-FLY-2664");
		await mkdir(projectRoot);
		await mkdir(worktreePath);
		const store = await StateStore.create(":memory:");
		try {
			store.upsertSession({
				execution_id: "implement-1",
				issue_id: "issue-1",
				project_name: "flywheel",
				status: "completed",
			});
			store.bindWorktreeOnce("implement-1", {
				path: worktreePath,
				branch: "flywheel-FLY-2664",
				generation: "generation-1",
			});
			const result = await prepareLandIntent(
				store,
				{
					issueId: "issue-1",
					projectName: "flywheel",
					prNumber: 2664,
					approvedHead: "a".repeat(40),
					now: "2026-09-17T05:20:00.000Z",
				},
				{
					resolveProjectRoot: () => projectRoot,
					getRegisteredWorktree: async () => ({
						path: await realpath(worktreePath),
						branch: "docs/FLY-2664-cleanup",
						head: "b".repeat(40),
						isDetached: false,
					}),
					readWorktreeGeneration: async () => "generation-1",
				},
			);

			expect(result).toMatchObject({
				ok: false,
				missing: ["implement-1:worktree_registration_mismatch"],
			});
		} finally {
			store.close();
		}
	});

	it("keeps a same-path historical attempt after the current attempt rebuilds the worktree", async () => {
		const parent = await mkdtemp(join(tmpdir(), "fly2616-targets-"));
		roots.push(parent);
		const projectRoot = join(parent, "flywheel");
		const worktreePath = join(parent, "flywheel-FLY-2616");
		await mkdir(projectRoot);
		await mkdir(worktreePath);
		const store = await StateStore.create(":memory:");
		try {
			store.createWorkflowRun({
				runId: "run-1",
				issueId: "issue-1",
				projectName: "flywheel",
				claimsReadEnrolled: true,
			});
			store.upsertWorkflowRunNode({
				runId: "run-1",
				nodeId: "implement",
				attempt: 1,
				state: "superseded",
				executionId: "implement-retired",
			});
			store.upsertWorkflowRunNode({
				runId: "run-1",
				nodeId: "implement",
				attempt: 2,
				state: "done",
				executionId: "implement-current",
			});
			store.upsertSession({
				execution_id: "implement-current",
				issue_id: "issue-1",
				project_name: "flywheel",
				status: "completed",
			});
			store.bindWorktreeOnce("implement-current", {
				path: worktreePath,
				branch: "flywheel-FLY-2616",
				generation: "generation-1",
			});
			store.bindWorktreeOnce("implement-retired", {
				path: worktreePath,
				branch: "flywheel-FLY-2616",
				generation: "generation-before-rebuild",
			});
			(
				store as unknown as {
					db: { run(sql: string, params?: unknown[]): void };
				}
			).db.run(
				`INSERT INTO workflow_side_effect_ledger
				   (run_id, node_id, attempt, kind, launch_ordinal, execution_id, state)
				 VALUES (?, 'implement', 2, 'materialize', 1, ?, 'intent_recorded')`,
				["run-1", `mat:${"f".repeat(64)}`],
			);

			const result = await prepareLandIntent(
				store,
				{
					runId: "run-1",
					issueId: "issue-1",
					projectName: "flywheel",
					prNumber: 2616,
					approvedHead: "a".repeat(40),
					now: "2026-09-16T05:20:00.000Z",
				},
				{
					resolveProjectRoot: () => projectRoot,
					getRegisteredWorktree: async () => ({
						path: await realpath(worktreePath),
						branch: "flywheel-FLY-2616",
						head: "b".repeat(40),
						isDetached: false,
					}),
					readWorktreeGeneration: async () => "generation-1",
				},
			);

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(JSON.parse(result.operation.closeout_targets_json!)).toMatchObject(
				{
					targets: [
						{
							kind: "bound_worktree",
							generation: "generation-1",
							sourceExecutionIds: ["implement-current", "implement-retired"],
						},
					],
				},
			);
		} finally {
			store.close();
		}
	});
});
