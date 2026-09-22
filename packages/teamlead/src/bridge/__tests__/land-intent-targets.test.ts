import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { legacyWorkflowSeeds } from "../../__tests__/fixtures/legacy-workflow-manifests.js";
import { StateStore } from "../../StateStore.js";
import { buildWorkflowRunSnapshotV1 } from "../../workflow-run-snapshot.js";
import {
	prepareLandIntent,
	prepareLandRecloseTargets,
} from "../land-intent-targets.js";

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

	it("returns a typed refusal when the registered worktree path cannot be resolved", async () => {
		const parent = await mkdtemp(join(tmpdir(), "fly2662-targets-"));
		roots.push(parent);
		const projectRoot = join(parent, "flywheel");
		const worktreePath = join(parent, "flywheel-FLY-2662");
		await mkdir(projectRoot);
		await mkdir(worktreePath);
		const store = await StateStore.create(":memory:");
		try {
			store.upsertSession({
				execution_id: "implement-1",
				issue_id: "FLY-2662",
				project_name: "flywheel",
				status: "completed",
			});
			store.bindWorktreeOnce("implement-1", {
				path: worktreePath,
				branch: "flywheel-FLY-2662",
				generation: "generation-1",
			});
			let worktreeResolutionCount = 0;
			const denied = Object.assign(new Error("denied"), { code: "EACCES" });

			await expect(
				prepareLandIntent(
					store,
					{
						issueId: "FLY-2662",
						projectName: "flywheel",
						prNumber: 2662,
						approvedHead: "a".repeat(40),
						now: "2026-09-17T20:40:00.000Z",
					},
					{
						resolveProjectRoot: () => projectRoot,
						getRegisteredWorktree: async () => ({
							path: worktreePath,
							branch: "flywheel-FLY-2662",
							isDetached: false,
						}),
						readWorktreeGeneration: async () => "generation-1",
						realpath: async (path) => {
							if (path === worktreePath && ++worktreeResolutionCount > 1) {
								throw denied;
							}
							return realpath(path);
						},
					},
				),
			).resolves.toMatchObject({
				ok: false,
				missing: ["implement-1:worktree_registration_unresolvable:EACCES"],
			});
		} finally {
			store.close();
		}
	});

	it("rejects a target snapshot when attribution changes during filesystem inspection", async () => {
		const parent = await mkdtemp(join(tmpdir(), "fly2662-targets-"));
		roots.push(parent);
		const projectRoot = join(parent, "flywheel");
		const worktreePath = join(parent, "flywheel-FLY-2662");
		await mkdir(projectRoot);
		await mkdir(worktreePath);
		const store = await StateStore.create(":memory:");
		try {
			store.upsertSession({
				execution_id: "implement-1",
				issue_id: "FLY-2662",
				project_name: "flywheel",
				status: "completed",
			});
			store.bindWorktreeOnce("implement-1", {
				path: worktreePath,
				branch: "flywheel-FLY-2662",
				generation: "generation-1",
			});

			const result = await prepareLandIntent(
				store,
				{
					issueId: "FLY-2662",
					projectName: "flywheel",
					prNumber: 2662,
					approvedHead: "a".repeat(40),
					now: "2026-09-17T20:40:00.000Z",
				},
				{
					resolveProjectRoot: () => projectRoot,
					getRegisteredWorktree: async () => {
						store.upsertSession({
							execution_id: "late-qa",
							issue_id: "FLY-2662",
							project_name: "flywheel",
							status: "completed",
						});
						return {
							path: worktreePath,
							branch: "flywheel-FLY-2662",
							isDetached: false,
						};
					},
					readWorktreeGeneration: async () => "generation-1",
				},
			);

			expect(result).toMatchObject({
				ok: false,
				missing: ["closeout_attribution_changed"],
			});
			expect(
				store.getLatestLandOperationForIssue("flywheel", "FLY-2662"),
			).toBeUndefined();
		} finally {
			store.close();
		}
	});

	it("FLY-2662: prepares a v2 absence target from a durable pre-deployment binding without mutating the old operation", async () => {
		const parent = await mkdtemp(join(tmpdir(), "fly2662-targets-"));
		roots.push(parent);
		const projectRoot = join(parent, "flywheel");
		const removedWorktreePath = join(parent, "flywheel-FLY-9002");
		await mkdir(projectRoot);
		const store = await StateStore.create(":memory:");
		try {
			store.upsertSession({
				execution_id: "implement-predeploy",
				issue_id: "FLY-9002",
				project_name: "flywheel",
				status: "completed",
			});
			store.bindWorktreeOnce("implement-predeploy", {
				path: removedWorktreePath,
				branch: "flywheel-FLY-9002",
				generation: "generation-predeploy",
			});
			const operation = store.ensureLandOperation({
				issueId: "FLY-9002",
				projectName: "flywheel",
				prNumber: 9002,
				approvedHead: "a".repeat(40),
				now: "2026-09-17T02:11:18.371Z",
			});
			expect(operation.closeout_targets_json).toBeNull();

			const prepared = await prepareLandRecloseTargets(
				store,
				{
					operation,
					requestId: "11111111-1111-4111-8111-111111111111",
					now: "2026-09-17T20:40:00.000Z",
				},
				{
					resolveProjectRoot: () => projectRoot,
					getRegisteredWorktree: async () => null,
					readWorktreeGeneration: async () => undefined,
				},
			);

			expect(prepared).toMatchObject({
				ok: true,
				verifiedTargets: { version: 2 },
			});
			if (!prepared.ok) return;
			const snapshot = JSON.parse(prepared.verifiedTargets.json);
			const canonicalRemovedPath = join(
				await realpath(parent),
				"flywheel-FLY-9002",
			);
			expect(snapshot).toMatchObject({
				version: 2,
				project: "flywheel",
				issueUuid: "FLY-9002",
				runId: null,
				targets: [
					{
						kind: "verified_absent_worktree",
						evidenceMode: "legacy_absence_observation",
						path: canonicalRemovedPath,
						branch: "flywheel-FLY-9002",
						generation: "generation-predeploy",
						sourceExecutionIds: ["implement-predeploy"],
						sourceRunId: null,
					},
				],
			});
			expect(
				store.getLandOperation(operation.operation_id)?.closeout_targets_json,
			).toBeNull();
		} finally {
			store.close();
		}
	});

	it("FLY-2662: refuses an unreadable legacy worktree path instead of signing absence", async () => {
		const parent = await mkdtemp(join(tmpdir(), "fly2662-targets-"));
		roots.push(parent);
		const projectRoot = join(parent, "flywheel");
		const removedWorktreePath = join(parent, "flywheel-FLY-9002");
		await mkdir(projectRoot);
		const store = await StateStore.create(":memory:");
		try {
			store.upsertSession({
				execution_id: "implement-predeploy",
				issue_id: "FLY-9002",
				project_name: "flywheel",
				status: "completed",
			});
			store.bindWorktreeOnce("implement-predeploy", {
				path: removedWorktreePath,
				branch: "flywheel-FLY-9002",
				generation: "generation-predeploy",
			});
			const operation = store.ensureLandOperation({
				issueId: "FLY-9002",
				projectName: "flywheel",
				prNumber: 9002,
				approvedHead: "a".repeat(40),
				now: "2026-09-17T02:11:18.371Z",
			});
			const pathError = Object.assign(new Error("denied"), { code: "EACCES" });

			await expect(
				prepareLandRecloseTargets(
					store,
					{
						operation,
						requestId: "11111111-1111-4111-8111-111111111111",
						now: "2026-09-17T20:40:00.000Z",
					},
					{
						resolveProjectRoot: () => projectRoot,
						getRegisteredWorktree: async () => null,
						readWorktreeGeneration: async () => undefined,
						lstat: async () => {
							throw pathError;
						},
					},
				),
			).resolves.toMatchObject({
				ok: false,
				missing: ["implement-predeploy:worktree_path_unreadable:EACCES"],
			});
		} finally {
			store.close();
		}
	});

	it("FLY-2662: refuses an unreadable legacy worktree parent instead of throwing", async () => {
		const parent = await mkdtemp(join(tmpdir(), "fly2662-targets-"));
		roots.push(parent);
		const projectRoot = join(parent, "flywheel");
		const removedWorktreePath = join(parent, "flywheel-FLY-9002");
		await mkdir(projectRoot);
		const store = await StateStore.create(":memory:");
		try {
			store.upsertSession({
				execution_id: "implement-predeploy",
				issue_id: "FLY-9002",
				project_name: "flywheel",
				status: "completed",
			});
			store.bindWorktreeOnce("implement-predeploy", {
				path: removedWorktreePath,
				branch: "flywheel-FLY-9002",
				generation: "generation-predeploy",
			});
			const operation = store.ensureLandOperation({
				issueId: "FLY-9002",
				projectName: "flywheel",
				prNumber: 9002,
				approvedHead: "a".repeat(40),
				now: "2026-09-17T02:11:18.371Z",
			});
			const denied = Object.assign(new Error("denied"), { code: "EACCES" });

			await expect(
				prepareLandRecloseTargets(
					store,
					{
						operation,
						requestId: "11111111-1111-4111-8111-111111111111",
						now: "2026-09-17T20:40:00.000Z",
					},
					{
						resolveProjectRoot: () => projectRoot,
						getRegisteredWorktree: async () => null,
						readWorktreeGeneration: async () => undefined,
						stat: async () => {
							throw denied;
						},
					},
				),
			).resolves.toMatchObject({
				ok: false,
				missing: ["implement-predeploy:worktree_parent_unreadable:EACCES"],
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
