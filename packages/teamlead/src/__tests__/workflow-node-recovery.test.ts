import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmTokenStore } from "../bridge/fleet-admin.js";
import type {
	IStartDispatcher,
	StartRequest,
} from "../bridge/retry-dispatcher.js";
import { RunnerAdmissionController } from "../bridge/runner-admission.js";
import { createRunsRouter } from "../bridge/runs-route.js";
import { WorkflowEngineDispatcher } from "../bridge/workflow-engine-dispatcher.js";
import { prepareWorkflowNodeRecovery } from "../bridge/workflow-node-recovery.js";
import { resolveWorkflowStartPolicy } from "../bridge/workflow-start-policy.js";
import { StateStore } from "../StateStore.js";
import { workflowRecoveryCanonicalSchema } from "../workflow-recovery-contract.js";
import { buildWorkflowRunSnapshotV1 } from "../workflow-run-snapshot.js";
import { isWorkflowManifestV1Land } from "../workflow-template.js";
import {
	legacyWorkflowSeeds,
	pinLegacyWorkflowSeedAgents,
} from "./fixtures/legacy-workflow-manifests.js";
import { installSelfHostedWorkflowAgentProject } from "./fixtures/workflow-agent-project.js";

const RUN_ID = "run-fly2329-recovery";
const ISSUE_ID = "FLY-2329";
const PREDECESSOR = "design-fly2329";
const ORIGINAL_EXECUTION = "implement-fly2329";
const ENV = {
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
	FLYWHEEL_ENGINE_UNLAUNCHED_ALERT_MS: "1000",
	FLYWHEEL_ENGINE_UNLAUNCHED_ROLLBACK_MS: "2000",
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

// Only the physical launcher is replaced. The engine still resolves the real
// predecessor HEAD, admits the execution, owns the launch, and writes its marker.
function fakeStartDispatcher(
	store: StateStore,
	head: string,
	worktreePath?: string,
) {
	const requests: StartRequest[] = [];
	let failBeforeLaunch = true;
	const start = vi.fn(async (request: StartRequest) => {
		requests.push(request);
		if (failBeforeLaunch)
			throw new Error("FLY-2329 synthetic prelaunch failure");
		const execution = request.generalizedExecution;
		if (!execution) throw new Error("generalized execution missing");
		if (
			worktreePath ||
			store.getWorkflowExecutionBinding(execution.executionId)?.mode ===
				"replacement"
		) {
			execution.prepareWorkflowIssueDelivery?.({
				sourceKind: "authoritative",
				body: "Pinned FLY-2329 recovery issue body",
				updatedAt: "2026-07-16T00:00:30.000Z",
				anchorCommit: head,
			});
		}
		const committed = execution.commitWorkflowLaunch?.();
		if (!committed?.ok)
			throw new Error(committed?.reason ?? "launch not committed");
		store.upsertSession({
			execution_id: execution.executionId,
			issue_id: request.issueId,
			project_name: request.projectName,
			status: "running",
			session_role: request.sessionRole,
			chat_thread_role: request.sessionRole,
			...(worktreePath ? { worktree_path: worktreePath } : {}),
		});
		return { executionId: execution.executionId, issueId: request.issueId };
	});
	return {
		requests,
		start,
		allowLaunch: () => {
			failBeforeLaunch = false;
		},
		dispatcher: {
			start,
			getInflightCount: () => 0,
			validateAgentName: () => ({ ok: true as const }),
		} as IStartDispatcher,
	};
}

async function materializePredecessor(
	store: StateStore,
	projectRoot: string,
	rootOnly = false,
) {
	installSelfHostedWorkflowAgentProject(projectRoot);
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", projectRoot, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	git("init", "--initial-branch=recovery-fixture");
	git("add", ".");
	git(
		"-c",
		"user.name=Recovery Fixture",
		"-c",
		"user.email=recovery@example.invalid",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-m",
		"Pin predecessor workflow agents",
	);
	const head = git("rev-parse", "HEAD");
	const seed = pinLegacyWorkflowSeedAgents(
		legacyWorkflowSeeds().find(
			(candidate) => candidate.templateId === "tpl_eng_heavy",
		)!,
	);
	store.importWorkflowTemplateSeed(seed);
	store.materializeWorkflowRun({
		runId: RUN_ID,
		issueId: ISSUE_ID,
		projectName: "flywheel",
		taskCategory: "code",
		templateId: seed.templateId,
		claimsReadEnrolled: true,
		actor: "lead",
		canonicalRoot: projectRoot,
		...(rootOnly ? { entryKind: "pipeline_dag_v1" as const } : {}),
		env: ENV,
		startReservation: {
			idempotencyKey: "fly2329-start",
			selectionDigest: "fly2329-selection",
			nodeId: "design",
			attempt: 1,
			executionId: PREDECESSOR,
			createdAt: "2026-07-16T00:00:00.000Z",
		},
	});
	if (rootOnly) return head;
	store.upsertWorkflowRunNode({
		runId: RUN_ID,
		nodeId: "design",
		attempt: 1,
		state: "running",
		executionId: PREDECESSOR,
	});
	store.upsertSession({
		execution_id: PREDECESSOR,
		issue_id: ISSUE_ID,
		project_name: "flywheel",
		status: "design_done",
		issue_identifier: ISSUE_ID,
		issue_title: "Recover the current node after an unlaunched admission",
		design_backend: "claude",
		doc_tier: "full",
		worktree_path: projectRoot,
	});
	store.commitWorkflowTransitionTx({
		nodeReuseEnabled: false,
		runId: RUN_ID,
		nodeId: "design",
		attempt: 1,
		executionId: PREDECESSOR,
		outcome: "design_done",
		successorExecutionId: ORIGINAL_EXECUTION,
		now: "2026-07-16T00:05:00.000Z",
	});
	return head;
}

describe("FLY-2329 unified recovery through HTTP and dispatcher consumption", () => {
	it("replaces a rolled-back unlaunched admission once and launches from its real predecessor", async () => {
		const projectRoot = mkdtempSync(
			join(tmpdir(), "fly2329-recovery-project-"),
		);
		const stateRoot = mkdtempSync(join(tmpdir(), "fly2329-recovery-markers-"));
		const server = createServer();
		let allocatedStore: StateStore | undefined;
		let cleaned = false;
		const cleanup = async () => {
			if (cleaned) return;
			cleaned = true;
			try {
				if (server.listening) {
					server.closeAllConnections();
					await new Promise<void>((resolve, reject) =>
						server.close((error) => (error ? reject(error) : resolve())),
					);
				}
			} finally {
				try {
					allocatedStore?.close();
				} finally {
					rmSync(projectRoot, { recursive: true, force: true });
					rmSync(stateRoot, { recursive: true, force: true });
				}
			}
		};
		cleanups.push(cleanup);
		try {
			const store = await StateStore.create(":memory:");
			allocatedStore = store;
			const head = await materializePredecessor(store, projectRoot);
			const fake = fakeStartDispatcher(store, head);
			const engine = (now: string) =>
				new WorkflowEngineDispatcher({
					store,
					startDispatcher: fake.dispatcher,
					stateRoot,
					env: ENV,
					now: () => new Date(now),
					probeUnlaunchedExternalEvidence: async () => "absent",
					resolveRunAlertIdentity: () => ({
						leadId: "flywheel-eng-lead",
						projectName: "flywheel",
						leadResolution: "resolved",
					}),
				});
			expect(await engine("2026-07-16T00:07:00.000Z").reconcile()).toEqual({
				started: 0,
				held: 1,
			});
			expect(fake.requests).toHaveLength(1);
			expect(fake.requests[0]?.startPoint).toBe(head);
			expect(store.getWorkflowRunNode(RUN_ID, "implement", 1)).toMatchObject({
				state: "admitted",
				execution_id: ORIGINAL_EXECUTION,
			});
			expect(store.getSession(ORIGINAL_EXECUTION)).toBeUndefined();
			expect(await engine("2026-07-16T01:08:00.000Z").reconcile()).toEqual({
				started: 0,
				held: 0,
			});
			expect(store.getWorkflowRun(RUN_ID)).toMatchObject({
				status: "held",
				current_node_id: "implement",
			});
			expect(
				store.getWorkflowLaunchCancellation(ORIGINAL_EXECUTION),
			).toBeDefined();
			const originalIntent = store
				.listWorkflowSideEffects(RUN_ID)
				.find((row) => row.execution_id === ORIGINAL_EXECUTION)!;
			expect(originalIntent).toMatchObject({
				state: "abandoned",
				launch_ordinal: 1,
			});
			const rollbackEvents = store
				.listWorkflowRunEvents(RUN_ID)
				.filter((event) => event.kind === "unlaunched_admission_rolled_back");
			expect(rollbackEvents).toHaveLength(1);

			let liveness: "alive" | "dead" | "unknown" = "dead";
			const app = express();
			app.use(express.json());
			app.use(
				"/api/runs",
				createRunsRouter(
					fake.dispatcher,
					store,
					[
						{
							projectName: "flywheel",
							projectRoot,
							leads: [{ agentId: "flywheel-eng-lead" }],
						},
					] as Parameters<typeof createRunsRouter>[2],
					RunnerAdmissionController.alwaysAdmit(),
					undefined,
					false,
					undefined,
					{
						masterToken: "test-master",
						scopedToken: "test-scoped",
						confirmTokens: new ConfirmTokenStore(),
						probeRunLiveness: async () => liveness,
					},
				),
			);
			server.on("request", app);
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "127.0.0.1", resolve);
			});
			const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/runs/${RUN_ID}`;
			const post = async (
				path: string,
				body: unknown,
				token = "test-master",
			) => {
				const response = await fetch(base + path, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${token}`,
					},
					body: JSON.stringify(body),
				});
				return { status: response.status, body: await response.json() };
			};
			const stageRequest = {
				runId: RUN_ID,
				shape: "unlaunched_admission_rolled_back",
				holdEventUid: rollbackEvents[0]!.event_uid,
				decision: null,
				reason:
					"Recover the current node after its unlaunched admission was rolled back",
				principal: "master",
				clientRequestId: "fly2329-unlaunched-recovery",
			};
			expect(
				(await post("/resume/stage", stageRequest, "test-scoped")).status,
			).toBe(401);
			const staged = await post("/resume/stage", stageRequest);
			expect(staged.status).toBe(200);
			// Expected initial RED: legacy stage currently returns no version 2 canonical.
			expect(staged.body.canonical).toMatchObject({
				version: 2,
				shape: "workflow_node_recovery",
			});
			const canonical = workflowRecoveryCanonicalSchema.parse(
				staged.body.canonical,
			);
			expect(canonical.target).toMatchObject({
				runId: RUN_ID,
				nodeId: "implement",
				attempt: 1,
				operationKind: "redispatch_current",
				previousExecutionId: ORIGINAL_EXECUTION,
				previousLaunchOrdinal: 1,
				startAuthority: {
					mode: "execution_head",
					sourceExecutionId: PREDECESSOR,
					headSha: head,
				},
			});
			const applyRequest = {
				canonical,
				confirmToken: staged.body.confirmToken,
			};
			const unchanged = () => ({
				run: store.getWorkflowRun(RUN_ID),
				node: store.getWorkflowRunNode(RUN_ID, "implement", 1),
				ledger: store.listWorkflowSideEffects(RUN_ID),
				events: store.listWorkflowRunEvents(RUN_ID),
			});
			const beforeApply = unchanged();
			liveness = "alive";
			expect(await post("/resume", applyRequest)).toMatchObject({
				status: 409,
				body: { reason: "recovery_target_alive" },
			});
			liveness = "unknown";
			expect(await post("/resume", applyRequest)).toMatchObject({
				status: 409,
				body: { reason: "recovery_liveness_unknown" },
			});
			liveness = "dead";
			execFileSync("git", [
				"-C",
				projectRoot,
				"commit",
				"--allow-empty",
				"-m",
				"changed after confirmation",
			]);
			const changedHead = execFileSync(
				"git",
				["-C", projectRoot, "rev-parse", "HEAD"],
				{ encoding: "utf8" },
			).trim();
			expect(await post("/resume", applyRequest)).toMatchObject({
				status: 409,
				body: { reason: "recovery_target_changed" },
			});
			execFileSync("git", [
				"-C",
				projectRoot,
				"update-ref",
				"HEAD",
				head,
				changedHead,
			]);
			expect(unchanged()).toEqual(beforeApply);
			// Fail after the receipt/watch/writer writes to prove the full SQLite
			// transaction rolls back, rather than merely rejecting before mutation.
			const db = (
				store as unknown as {
					db: { run(sql: string, params?: unknown[]): void };
				}
			).db;
			const stagedOwner = store.getWorkflowLaunchOwner(ORIGINAL_EXECUTION)!;
			db.run(
				"UPDATE workflow_launch_owner SET owner_generation = owner_generation + 1 WHERE execution_id = ?",
				[ORIGINAL_EXECUTION],
			);
			expect(await post("/resume", applyRequest)).toMatchObject({
				status: 409,
				body: { reason: "recovery_target_changed" },
			});
			db.run(
				"UPDATE workflow_launch_owner SET owner_generation = ? WHERE execution_id = ?",
				[stagedOwner.owner_generation, ORIGINAL_EXECUTION],
			);
			db.run(
				`CREATE TRIGGER fail_recovery_run BEFORE UPDATE OF status ON workflow_run WHEN NEW.status = 'active' BEGIN SELECT RAISE(ABORT, 'test_recovery_commit_failure'); END`,
			);
			expect(await post("/resume", applyRequest)).toMatchObject({
				status: 409,
				body: { reason: "test_recovery_commit_failure" },
			});
			db.run("DROP TRIGGER fail_recovery_run");
			expect(unchanged()).toEqual(beforeApply);
			expect(
				store.getWorkflowHoldResumeReceipt(stageRequest.clientRequestId),
			).toBeUndefined();
			const restaged = await post("/resume/stage", stageRequest);
			expect(restaged.body.canonical).toEqual(canonical);
			applyRequest.confirmToken = restaged.body.confirmToken;
			const applied = await post("/resume", applyRequest);
			expect(applied.status, JSON.stringify(applied.body)).toBe(200);
			expect(applied.body).toMatchObject({
				ok: true,
				state: "dispatch_recorded",
			});
			const receipt = store.getWorkflowHoldResumeReceipt(
				stageRequest.clientRequestId,
			)?.recoveryReceipt;
			expect(receipt?.state).toBe("dispatch_recorded");
			if (receipt?.state !== "dispatch_recorded")
				throw new Error("dispatch receipt missing");
			expect(applied.body).toMatchObject({
				operationId: receipt.operationId,
				executionId: receipt.executionId,
				launchOrdinal: receipt.launchOrdinal,
				dispatchLedgerId: receipt.dispatchLedgerId,
			});
			expect(receipt.executionId).not.toBe(ORIGINAL_EXECUTION);
			expect(receipt.launchOrdinal).toBe(2);
			expect(
				store.getWorkflowDeadExecutionWatch(ORIGINAL_EXECUTION),
			).toBeUndefined();
			const recorded = store
				.listWorkflowSideEffects(RUN_ID)
				.find((row) => row.id === receipt.dispatchLedgerId);
			expect(recorded).toMatchObject({
				run_id: RUN_ID,
				node_id: "implement",
				attempt: 1,
				execution_id: receipt.executionId,
				launch_ordinal: 2,
				state: "intent_recorded",
			});
			expect(store.getWorkflowRunNode(RUN_ID, "implement", 1)).toMatchObject({
				execution_id: receipt.executionId,
				state: "pending",
			});
			expect(store.getWorkflowRun(RUN_ID)).toMatchObject({
				status: "active",
				current_node_id: "implement",
			});
			expect(fake.requests).toHaveLength(1);
			const intentsBeforeReplay = store.listWorkflowSideEffects(RUN_ID);
			const replay = await post("/resume", applyRequest);
			expect(replay.status).toBe(200);
			expect(replay.body).toMatchObject({
				ok: true,
				idempotentReplay: true,
				operationId: receipt.operationId,
				state: "dispatch_recorded",
				executionId: receipt.executionId,
				dispatchLedgerId: receipt.dispatchLedgerId,
			});
			expect(store.listWorkflowSideEffects(RUN_ID)).toEqual(
				intentsBeforeReplay,
			);
			expect(
				await post("/resume", {
					...applyRequest,
					canonical: { ...canonical, clientRequestId: "stale-second-request" },
				}),
			).toMatchObject({
				status: 409,
				body: {
					reason: "recovery_target_changed",
					originalOperationId: receipt.operationId,
					currentTarget: {
						runId: RUN_ID,
						nodeId: "implement",
						attempt: 1,
						executionId: receipt.executionId,
						launchOrdinal: 2,
						runStatus: "active",
					},
				},
			});
			expect(store.listWorkflowSideEffects(RUN_ID)).toEqual(
				intentsBeforeReplay,
			);
			db.run(
				"UPDATE workflow_delivery_operation SET recovery_receipt_json = '{}' WHERE client_request_id = ?",
				[stageRequest.clientRequestId],
			);
			expect(await post("/resume", applyRequest)).toMatchObject({
				status: 409,
				body: { reason: "recovery_receipt_invalid" },
			});
			db.run(
				"UPDATE workflow_delivery_operation SET recovery_receipt_json = ? WHERE client_request_id = ?",
				[JSON.stringify(receipt), stageRequest.clientRequestId],
			);

			// Mutable dispatch diagnostics must not disable the immutable recovery proof.
			db.run(
				"UPDATE workflow_side_effect_ledger SET reason = 'diagnostic_updated' WHERE id = ?",
				[receipt.dispatchLedgerId],
			);
			expect(
				store.getWorkflowNodeRecoveryDispatchAuthority(
					store
						.listWorkflowSideEffects(RUN_ID)
						.find((row) => row.id === receipt.dispatchLedgerId)!,
				),
			).toMatchObject({ authority: canonical.target.startAuthority });

			// Storage assertions alone do not prove that the engine can consume the
			// new intent: this pass must recover predecessor lineage and commit launch.
			fake.allowLaunch();
			expect(
				await engine(new Date(Date.now() + 60_000).toISOString()).reconcile(),
			).toEqual({ started: 1, held: 0 });
			expect(fake.requests).toHaveLength(2);
			expect(fake.requests[1]).toMatchObject({
				startPoint: head,
				generalizedExecution: { executionId: receipt.executionId },
			});
			expect(
				store
					.listWorkflowSideEffects(RUN_ID)
					.find((row) => row.id === receipt.dispatchLedgerId),
			).toMatchObject({ state: "started" });
			expect(store.getWorkflowLaunchOwner(receipt.executionId)).toMatchObject({
				committed_generation: 1,
			});
			expect(store.getSession(receipt.executionId)).toMatchObject({
				status: "running",
			});
		} finally {
			await cleanup();
		}
	}, 60_000);
});

describe("FLY-2295/2914 started root recovery", () => {
	it("uses the current root body's real worktree and preserves work across repeated recovery", async () => {
		const projectRoot = mkdtempSync(join(tmpdir(), "fly2295-root-recovery-"));
		const stateRoot = mkdtempSync(join(tmpdir(), "fly2295-root-markers-"));
		const store = await StateStore.create(":memory:");
		const server = createServer();
		cleanups.push(async () => {
			if (server.listening) {
				server.closeAllConnections();
				await new Promise<void>((resolve, reject) =>
					server.close((error) => (error ? reject(error) : resolve())),
				);
			}
			store.close();
			rmSync(projectRoot, { recursive: true, force: true });
			rmSync(stateRoot, { recursive: true, force: true });
		});
		const initialHead = await materializePredecessor(store, projectRoot, true);
		const fake = fakeStartDispatcher(store, initialHead, projectRoot);
		fake.allowLaunch();
		const identity = {
			leadId: "flywheel-eng-lead",
			projectName: "flywheel",
			leadResolution: "resolved" as const,
		};
		const engine = () =>
			new WorkflowEngineDispatcher({
				store,
				startDispatcher: fake.dispatcher,
				stateRoot,
				env: ENV,
				resolveRunAlertIdentity: () => identity,
			});
		expect(await engine().reconcile()).toEqual({ started: 1, held: 0 });
		expect(
			store.getWorkflowLaunchOwner(PREDECESSOR)?.committed_generation,
		).toBe(1);
		const app = express();
		app.use(express.json());
		app.use(
			"/api/runs",
			createRunsRouter(
				fake.dispatcher,
				store,
				[
					{
						projectName: "flywheel",
						projectRoot,
						leads: [{ agentId: "flywheel-eng-lead" }],
					},
				] as Parameters<typeof createRunsRouter>[2],
				RunnerAdmissionController.alwaysAdmit(),
				undefined,
				false,
				undefined,
				{
					masterToken: "test-master",
					confirmTokens: new ConfirmTokenStore(),
					probeRunLiveness: async () => "dead",
				},
			),
		);
		server.on("request", app);
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const post = async (path: string, body: unknown) => {
			const response = await fetch(
				`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/runs/${RUN_ID}${path}`,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: "Bearer test-master",
					},
					body: JSON.stringify(body),
				},
			);
			return { status: response.status, body: await response.json() };
		};
		let oldExecutionId = PREDECESSOR;
		for (const ordinal of [2, 3]) {
			// Real work after the previous launch, not the original reservation's base.
			execFileSync("git", [
				"-C",
				projectRoot,
				"commit",
				"--allow-empty",
				"-m",
				`root work before recovery ${ordinal}`,
			]);
			const head = execFileSync(
				"git",
				["-C", projectRoot, "rev-parse", "HEAD"],
				{ encoding: "utf8" },
			).trim();
			expect(head).not.toBe(initialHead);
			expect(
				store.recordEnrolledTerminalSignal({
					executionId: oldExecutionId,
					sourceEventId: `root-exit-${ordinal}`,
					signal: "completed",
					source: "test",
				}),
			).toMatchObject({ ok: true });
			expect(
				store.holdCompletedWorkflowExecutionWithoutReceipt({
					runId: RUN_ID,
					nodeId: "design",
					attempt: 1,
					executionId: oldExecutionId,
					alertIdentity: identity,
				}),
			).toMatchObject({ ok: true });
			expect(
				store.getWorkflowNodeCompletion(RUN_ID, "design", 1),
			).toBeUndefined();
			const episode = store
				.listWorkflowRunEvents(RUN_ID)
				.find(
					(event) =>
						event.kind === "completion_receipt_missing" &&
						event.execution_id === oldExecutionId,
				)!;
			const hold = store
				.listWorkflowHolds(RUN_ID)
				.find((h) => h.holdEventUid === episode.event_uid)!;
			const stageRequest = {
				runId: RUN_ID,
				shape: hold.shape,
				holdEventUid: hold.holdEventUid,
				decision: null,
				reason:
					"Recover the root after physical exit without a completion receipt",
				principal: "master",
				clientRequestId: `root-recovery-${ordinal}`,
			};
			const staged = await post("/resume/stage", stageRequest);
			expect(staged.status, JSON.stringify(staged.body)).toBe(200);
			expect(staged.body.canonical.target.startAuthority).toMatchObject({
				mode: "execution_head",
				sourceExecutionId: oldExecutionId,
				headSha: head,
			});
			const applied = await post("/resume", {
				canonical: staged.body.canonical,
				confirmToken: staged.body.confirmToken,
			});
			expect(applied.status, JSON.stringify(applied.body)).toBe(200);
			expect(applied.body).toMatchObject({
				state: "dispatch_recorded",
				launchOrdinal: ordinal,
			});
			expect(await engine().reconcile()).toEqual({ started: 1, held: 0 });
			expect(fake.requests.at(-1)).toMatchObject({
				startPoint: head,
				generalizedExecution: { executionId: applied.body.executionId },
			});
			expect(
				store.getWorkflowLaunchOwner(applied.body.executionId)
					?.committed_generation,
			).toBe(1);
			expect(
				store
					.listWorkflowSideEffects(RUN_ID)
					.find((row) => row.id === applied.body.dispatchLedgerId),
			).toMatchObject({ state: "started", launch_ordinal: ordinal });
			expect(store.getWorkflowRun(RUN_ID)).toMatchObject({
				status: "active",
				current_node_id: "design",
			});
			expect(
				store.getWorkflowNodeCompletion(RUN_ID, "design", 1),
			).toBeUndefined();
			expect(store.getWorkflowDeadExecutionWatch(oldExecutionId)).toMatchObject(
				{ new_execution_id: applied.body.executionId },
			);
			// The original root body must cease being a HEAD source after replacement.
			store.upsertSession({
				execution_id: oldExecutionId,
				issue_id: ISSUE_ID,
				project_name: "flywheel",
				status: "completed",
				worktree_path: join(projectRoot, `retired-body-${ordinal}`),
			});
			oldExecutionId = applied.body.executionId;
		}
	}, 60_000);

	it("uses the last started root body when its unlaunched replacement is held", async () => {
		const projectRoot = mkdtempSync(join(tmpdir(), "fly2295-root-lineage-"));
		const stateRoot = mkdtempSync(
			join(tmpdir(), "fly2295-root-lineage-markers-"),
		);
		const store = await StateStore.create(":memory:");
		cleanups.push(async () => {
			store.close();
			rmSync(projectRoot, { recursive: true, force: true });
			rmSync(stateRoot, { recursive: true, force: true });
		});
		const initialHead = await materializePredecessor(store, projectRoot, true);
		const fake = fakeStartDispatcher(store, initialHead, projectRoot);
		fake.allowLaunch();
		const engine = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot,
			env: ENV,
			now: () => new Date("2026-09-27T15:00:00.000Z"),
		});
		expect(await engine.reconcile()).toEqual({ started: 1, held: 0 });
		execFileSync("git", [
			"-C",
			projectRoot,
			"commit",
			"--allow-empty",
			"-m",
			"root work before automatic replacement",
		]);
		const startedHead = execFileSync(
			"git",
			["-C", projectRoot, "rev-parse", "HEAD"],
			{ encoding: "utf8" },
		).trim();
		expect(startedHead).not.toBe(initialHead);
		expect(
			store.recordEnrolledTerminalSignal({
				executionId: PREDECESSOR,
				sourceEventId: "root-lineage-terminal",
				signal: "failed",
				failureKind: "runner_zombie",
				lastError: "root body exited",
				source: "test",
				now: "2026-09-27T15:01:00.000Z",
			}),
		).toMatchObject({ ok: true, status: "failed" });
		const replacementExecutionId = "design-root-unlaunched-replacement";
		expect(
			store.rollbackDeadWorkflowNodeExecution({
				runId: RUN_ID,
				nodeId: "design",
				attempt: 1,
				deadExecutionId: PREDECESSOR,
				newExecutionId: replacementExecutionId,
				reason: "terminal_session_and_dead_probe",
				livenessEvidence: {
					liveness: "dead",
					observedAt: "2026-09-27T15:01:01.000Z",
				},
				now: "2026-09-27T15:01:01.000Z",
			}),
		).toMatchObject({ ok: true, launchOrdinal: 2 });
		expect(
			store.recordWorkflowPreAdmissionFailure({
				runId: RUN_ID,
				nodeId: "design",
				attempt: 1,
				executionId: replacementExecutionId,
				launchOrdinal: 2,
				errorCode: "lineage_missing",
				rollbackMs: 1_000,
				now: "2026-09-27T15:01:02.000Z",
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
				noStartEvidence: {
					markerPath: join(stateRoot, replacementExecutionId),
					externalEvidence: "absent",
					observedAt: "2026-09-27T15:01:02.000Z",
				},
			}),
		).toEqual({ ok: true, held: true });
		const hold = store.listWorkflowHolds(RUN_ID).find((row) => row.runLevel)!;
		const observeInitialStart = vi.fn(async () => {
			throw new Error("must not re-resolve the initial root start");
		});
		const prepared = await prepareWorkflowNodeRecovery(
			store,
			{
				runId: RUN_ID,
				shape: hold.shape,
				holdEventUid: hold.holdEventUid,
				decision: null,
				reason: "recover from the last started root body",
				principal: "master",
				clientRequestId: "root-lineage-recovery",
			},
			async () => "dead",
			observeInitialStart,
		);
		expect(observeInitialStart).not.toHaveBeenCalled();
		expect(prepared.canonical.target.startAuthority).toMatchObject({
			mode: "execution_head",
			sourceExecutionId: PREDECESSOR,
			headSha: startedHead,
		});
		const recovered = store.recoverWorkflowNode({
			canonical: prepared.canonical,
			preflight: prepared.preflight,
			now: new Date().toISOString(),
		});
		expect(recovered).toMatchObject({
			ok: true,
			state: "dispatch_recorded",
			launchOrdinal: 3,
		});
		if (!recovered.ok || recovered.state !== "dispatch_recorded") {
			throw new Error("root replacement dispatch missing");
		}
		expect(await engine.reconcile()).toEqual({ started: 1, held: 0 });
		expect(fake.requests.at(-1)).toMatchObject({
			startPoint: startedHead,
			generalizedExecution: {
				executionId: recovered.executionId,
			},
		});
	}, 60_000);
});

describe("operator pause plus execution fault recovery", () => {
	it("uses the selected operator hold as consent to redispatch and consumes both holds", async () => {
		const projectRoot = mkdtempSync(join(tmpdir(), "fly2922-pause-fault-"));
		const stateRoot = mkdtempSync(
			join(tmpdir(), "fly2922-pause-fault-markers-"),
		);
		const store = await StateStore.create(":memory:");
		cleanups.push(async () => {
			store.close();
			rmSync(projectRoot, { recursive: true, force: true });
			rmSync(stateRoot, { recursive: true, force: true });
		});
		const head = await materializePredecessor(store, projectRoot);
		const fake = fakeStartDispatcher(store, head, projectRoot);
		fake.allowLaunch();
		const engine = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot,
			env: ENV,
		});
		expect(await engine.reconcile()).toEqual({ started: 1, held: 0 });
		const activation = store.getWorkflowActivationForAttempt({
			runId: RUN_ID,
			nodeId: "implement",
			attempt: 1,
			executionId: ORIGINAL_EXECUTION,
		})!;
		expect(
			store.recordWorkflowActivationTurn({
				activationId: activation.activation_id,
				issueId: ISSUE_ID,
				executionId: ORIGINAL_EXECUTION,
				epoch: 1,
				sourceEventId: "pause-fault-turn",
				grantedAt: "2026-09-27T15:59:59.000Z",
			}),
		).toMatchObject({ ok: true });
		expect(
			store.holdWorkflowRunByOperator({
				runId: RUN_ID,
				reason: "pause before inspecting the current runner",
				clientRequestId: "pause-before-fault",
				principal: "master",
				evidence: [],
				now: "2026-09-27T16:00:00.000Z",
			}),
		).toMatchObject({ ok: true, status: "held" });
		expect(
			store.commitEnrolledFailure({
				executionId: ORIGINAL_EXECUTION,
				sourceEventId: "pause-fault-blocked",
				reason:
					"runner cannot continue while the inspected dependency is absent",
				completionSubmission: { decision: { route: "blocked" } },
				workflowActivation: {
					activationId: activation.activation_id,
					runId: RUN_ID,
					nodeId: "implement",
					attempt: 1,
					turnEpoch: 1,
				},
				now: "2026-09-27T16:00:01.000Z",
			}),
		).toMatchObject({ ok: true, idempotentReplay: false });
		const holds = store.listWorkflowHolds(RUN_ID).filter((row) => row.runLevel);
		const operatorHold = holds.find(
			(row) => row.shape === "run_held_by_operator",
		)!;
		const faultHold = holds.find(
			(row) => row.shape !== "run_held_by_operator",
		)!;
		expect(holds).toHaveLength(2);
		await expect(
			prepareWorkflowNodeRecovery(
				store,
				{
					runId: RUN_ID,
					shape: faultHold.shape,
					holdEventUid: faultHold.holdEventUid,
					decision: null,
					reason: "fault-only selection must not clear the operator pause",
					principal: "master",
					clientRequestId: "reject-fault-without-pause-consent",
				},
				async () => "dead",
			),
		).rejects.toThrow("recovery_operator_consent_required");
		const prepared = await prepareWorkflowNodeRecovery(
			store,
			{
				runId: RUN_ID,
				shape: operatorHold.shape,
				holdEventUid: operatorHold.holdEventUid,
				decision: null,
				reason:
					"operator approves clearing the pause and replacing the dead body",
				principal: "master",
				clientRequestId: "recover-pause-plus-fault",
			},
			async () => "dead",
		);
		expect(prepared.canonical.target).toMatchObject({
			operationKind: "redispatch_current",
			sourceHoldEventUids: expect.arrayContaining(
				holds.map((hold) => hold.holdEventUid),
			),
		});
		const recovered = store.recoverWorkflowNode({
			canonical: prepared.canonical,
			preflight: prepared.preflight,
			now: new Date().toISOString(),
		});
		expect(recovered).toMatchObject({
			ok: true,
			state: "dispatch_recorded",
		});
		expect(
			store.listWorkflowHolds(RUN_ID).filter((row) => row.runLevel),
		).toEqual([]);
		expect(store.getWorkflowRun(RUN_ID)?.status).toBe("active");
	}, 60_000);
});

describe("FLY-2901 root initial recovery", () => {
	it.each(["continuity", "resume", "default"] as const)(
		"freezes %s without an old worktree and carries its context into launch",
		async (mode) => {
			const projectRoot = mkdtempSync(join(tmpdir(), "fly2901-root-initial-"));
			const stateRoot = mkdtempSync(join(tmpdir(), "fly2901-root-markers-"));
			const store = await StateStore.create(":memory:");
			const server = createServer();
			cleanups.push(async () => {
				if (server.listening) {
					server.closeAllConnections();
					await new Promise<void>((resolve, reject) =>
						server.close((error) => (error ? reject(error) : resolve())),
					);
				}
				store.close();
				rmSync(projectRoot, { recursive: true, force: true });
				rmSync(stateRoot, { recursive: true, force: true });
			});
			const head = await materializePredecessor(store, projectRoot, true);
			const git = (...args: string[]) =>
				execFileSync("git", ["-C", projectRoot, ...args], {
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
				}).trim();
			git("update-ref", "refs/remotes/origin/main", head);
			const priorDefault = process.env.FLYWHEEL_RUNNER_START_POINT;
			delete process.env.FLYWHEEL_RUNNER_START_POINT;
			cleanups.push(async () => {
				if (priorDefault === undefined)
					delete process.env.FLYWHEEL_RUNNER_START_POINT;
				else process.env.FLYWHEEL_RUNNER_START_POINT = priorDefault;
			});
			const expectedPolicy =
				mode === "continuity"
					? { continuityInherit: { prNumber: 19, sha: head } }
					: mode === "resume"
						? {
								resume: {
									progressPath: "engineering/doc/FLY-2329/progress.md",
									priorExecutionId: "earlier-run",
									startPoint: head,
									effectiveStage: "implement",
									shareParentBranch: true,
								},
							}
						: { resume: null };
			const fake = fakeStartDispatcher(store, head, projectRoot);
			fake.dispatcher.observeInitialWorkflowStart = async (request) => ({
				repositoryPath: projectRoot,
				branch: "recovery-fixture",
				policy: await resolveWorkflowStartPolicy(request, {
					observeResume: async () =>
						mode === "resume"
							? {
									progressPath: "engineering/doc/FLY-2329/progress.md",
									priorExecutionId: "earlier-run",
									startPoint: git("rev-parse", "HEAD"),
									resumeKind: "restart",
									effectiveStage: "implement",
									shareParentBranch: true,
								}
							: null,
					observeContinuity: async () =>
						mode === "default"
							? { kind: "missing", branch: "recovery-fixture" }
							: {
									kind: "found",
									branch: "recovery-fixture",
									sha: execFileSync(
										"git",
										["-C", projectRoot, "rev-parse", "HEAD"],
										{
											encoding: "utf8",
										},
									).trim(),
									prNumber: 19,
									prUrl: "https://example.invalid/pr/19",
								},
				}),
			});
			const engine = (now: string) =>
				new WorkflowEngineDispatcher({
					store,
					startDispatcher: fake.dispatcher,
					stateRoot,
					env: ENV,
					now: () => new Date(now),
					probeUnlaunchedExternalEvidence: async () => "absent",
					resolveRunAlertIdentity: () => ({
						leadId: "flywheel-eng-lead",
						projectName: "flywheel",
						leadResolution: "resolved",
					}),
				});
			expect(await engine("2026-07-16T00:07:00.000Z").reconcile()).toEqual({
				started: 0,
				held: 1,
			});
			expect(await engine("2026-07-16T01:08:00.000Z").reconcile()).toEqual({
				started: 0,
				held: 0,
			});
			expect(store.getSession(PREDECESSOR)).toBeUndefined();
			const hold = store.listWorkflowHolds(RUN_ID).find((row) => row.runLevel)!;
			const app = express();
			app.use(express.json());
			app.use(
				"/api/runs",
				createRunsRouter(
					fake.dispatcher,
					store,
					[
						{
							projectName: "flywheel",
							projectRoot,
							leads: [{ agentId: "flywheel-eng-lead" }],
						},
					] as Parameters<typeof createRunsRouter>[2],
					RunnerAdmissionController.alwaysAdmit(),
					undefined,
					false,
					undefined,
					{
						masterToken: "test-master",
						confirmTokens: new ConfirmTokenStore(),
						probeRunLiveness: async () => "dead",
					},
				),
			);
			server.on("request", app);
			await new Promise<void>((resolve) =>
				server.listen(0, "127.0.0.1", resolve),
			);
			const post = async (path: string, body: unknown) => {
				const response = await fetch(
					`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/runs/${RUN_ID}${path}`,
					{
						method: "POST",
						headers: {
							"content-type": "application/json",
							authorization: "Bearer test-master",
						},
						body: JSON.stringify(body),
					},
				);
				return { status: response.status, body: await response.json() };
			};
			const request = {
				runId: RUN_ID,
				principal: "master",
				shape: hold.shape,
				holdEventUid: hold.holdEventUid,
				decision: null,
				reason: "retry root with preserved initial policy",
				clientRequestId: "root-initial-recovery",
			};
			const staged = await post("/resume/stage", request);
			expect(staged).toMatchObject({
				status: 200,
				body: {
					canonical: {
						target: {
							startAuthority: {
								mode: "root_initial",
								headSha: head,
								provenance: "legacy_initial_policy_resolution",
								initialPolicy: expectedPolicy,
							},
						},
					},
				},
			});
			const beforeConflict = store.listWorkflowSideEffects(RUN_ID);
			git(
				"-c",
				"user.name=Recovery Fixture",
				"-c",
				"user.email=recovery@example.invalid",
				"-c",
				"commit.gpgsign=false",
				"commit",
				"--allow-empty",
				"-m",
				"changed before confirmation",
			);
			git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
			expect(
				await post("/resume", {
					canonical: staged.body.canonical,
					confirmToken: staged.body.confirmToken,
				}),
			).toMatchObject({ status: 409 });
			expect(store.listWorkflowSideEffects(RUN_ID)).toEqual(beforeConflict);
			git("reset", "--hard", head);
			git("update-ref", "refs/remotes/origin/main", head);
			const applied = await post("/resume", {
				canonical: staged.body.canonical,
				confirmToken: staged.body.confirmToken,
			});
			expect(applied).toMatchObject({
				status: 200,
				body: { state: "dispatch_recorded", launchOrdinal: 2 },
			});
			fake.allowLaunch();
			expect(
				await engine(new Date(Date.now() + 60_000).toISOString()).reconcile(),
			).toEqual({ started: 1, held: 0 });
			expect(fake.requests.at(-1)).toMatchObject({
				startPoint: head,
				recoveryStartPolicy: expectedPolicy,
				generalizedExecution: { executionId: applied.body.executionId },
			});
			expect(
				store
					.listWorkflowSideEffects(RUN_ID)
					.find((row) => row.id === applied.body.dispatchLedgerId)?.state,
			).toBe("started");
		},
		60_000,
	);
});

describe("FLY-2525 held quota recovery service", () => {
	it("delegates an exact waiting quota target through the same mint transaction and refuses an async authority loss", async () => {
		const projectRoot = mkdtempSync(join(tmpdir(), "fly2525-held-project-"));
		const stateRoot = mkdtempSync(join(tmpdir(), "fly2525-held-markers-"));
		const store = await StateStore.create(":memory:");
		cleanups.push(async () => {
			store.close();
			rmSync(projectRoot, { recursive: true, force: true });
			rmSync(stateRoot, { recursive: true, force: true });
		});
		const head = await materializePredecessor(store, projectRoot);
		const fake = fakeStartDispatcher(store, head);
		const engine = (now: string) =>
			new WorkflowEngineDispatcher({
				store,
				startDispatcher: fake.dispatcher,
				stateRoot,
				env: ENV,
				now: () => new Date(now),
				probeUnlaunchedExternalEvidence: async () => "absent",
				resolveRunAlertIdentity: () => ({
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				}),
			});
		expect(await engine("2026-07-16T00:07:00.000Z").reconcile()).toEqual({
			started: 0,
			held: 1,
		});
		expect(await engine("2026-07-16T01:08:00.000Z").reconcile()).toEqual({
			started: 0,
			held: 0,
		});
		const quota = store.codexQuota;
		quota.initializeRoot({
			rootKey: "root",
			accountKey: "account",
			profile: "business",
			generation: 1,
		});
		quota.registerBinding({
			bindingId: "binding",
			executionId: ORIGINAL_EXECUTION,
			runId: RUN_ID,
			purpose: "runner",
			accountKey: "account",
			profile: "business",
			generation: 1,
			credentialRootKey: "root",
		});
		quota.recordSignal({
			executionId: ORIGINAL_EXECUTION,
			bindingId: "binding",
			nodeId: "implement",
			attempt: 1,
		});
		quota.recordInstalling({
			incidentId: "codex:root:1",
			profile: "school",
			accountKey: "school-account",
			priorAuthDigest: "prior",
			installedAuthDigest: "digest",
			recoveryMaterialPath: "/fixture/auth",
		});
		quota.commitGeneration({
			incidentId: "codex:root:1",
			expectedGeneration: 1,
			accountKey: "school-account",
			profile: "school",
			authDigest: "digest",
			probeResult: "ok",
		});
		const expectation = {
			target: quota.getTargetFence("codex:root:1", "runner", RUN_ID)!,
			nodeId: "implement",
			attempt: 1,
			launchOrdinal: 1,
			permitIncidentId: "codex:root:1",
			installedGeneration: 2,
		};
		const before = store.listWorkflowSideEffects(RUN_ID);
		const { recoverQuotaHeldWorkflowNode } = await import(
			"../bridge/workflow-quota-recovery.js"
		);
		let enabled = true;
		await expect(
			recoverQuotaHeldWorkflowNode(store, expectation, {
				isEnabled: () => enabled,
				probe: async () => {
					enabled = false;
					return "dead";
				},
			}),
		).rejects.toThrow("quota_recovery_disabled");
		expect(store.listWorkflowSideEffects(RUN_ID)).toEqual(before);
		expect(quota.getTargetFence("codex:root:1", "runner", RUN_ID)?.state).toBe(
			"waiting",
		);
		enabled = true;
		const result = await recoverQuotaHeldWorkflowNode(store, expectation, {
			isEnabled: () => enabled,
			probe: async () => "dead",
		});
		expect(result).toMatchObject({
			ok: true,
			state: "dispatch_recorded",
			launchOrdinal: 2,
		});
		if (!result.ok || result.state !== "dispatch_recorded")
			throw new Error("dispatch missing");
		expect(quota.listTargets("codex:root:1")[0]).toMatchObject({
			state: "abandoned",
			new_run_id: RUN_ID,
			new_execution_id: result.executionId,
			last_error: `delegated_to_node_recovery:${result.operationId}`,
		});
		expect(store.getWorkflowRun(RUN_ID)?.status).toBe("active");
		expect(
			store
				.listWorkflowRunEvents(RUN_ID)
				.some((event) => event.kind === "run_terminated_by_operator"),
		).toBe(false);
		fake.allowLaunch();
		expect(
			await engine(new Date(Date.now() + 60_000).toISOString()).reconcile(),
		).toEqual({ started: 1, held: 0 });
		expect(
			store
				.listWorkflowSideEffects(RUN_ID)
				.find((row) => row.id === result.dispatchLedgerId)?.state,
		).toBe("started");
	}, 60_000);
});

describe("FLY-2545 land recovery", () => {
	it("mints a new land dispatch before resuming the same held operation", async () => {
		const store = await StateStore.create(":memory:");
		const seed = legacyWorkflowSeeds().find(
			(candidate) => candidate.templateId === "tpl_eng_heavy_land_v1",
		)!;
		if (!isWorkflowManifestV1Land(seed.manifest))
			throw new Error("land fixture seed is not a land manifest");
		store.createWorkflowRun({
			runId: "run-land-recovery",
			issueId: "FLY-2545",
			projectName: "flywheel",
			snapshotJson: JSON.stringify(
				buildWorkflowRunSnapshotV1({
					template: { id: seed.templateId, revision: 1 },
					manifest: seed.manifest,
				}),
			),
			claimsReadEnrolled: true,
		});
		const raw = (
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		raw.run(
			"UPDATE workflow_side_effect_ledger SET state='started' WHERE run_id=? AND state='intent_recorded'",
			[RUN_ID],
		);
		raw.run(
			"UPDATE workflow_run SET engine_owned = 1, current_node_id = 'land' WHERE run_id = 'run-land-recovery'",
		);
		store.upsertWorkflowRunNode({
			runId: "run-land-recovery",
			nodeId: "land",
			attempt: 1,
			state: "pending",
			executionId: "land-exec-1",
		});
		store.upsertWorkflowRunNode({
			runId: "run-land-recovery",
			nodeId: "implement",
			attempt: 1,
			state: "done",
			executionId: "implement-land-recovery",
		});
		raw.run(
			`INSERT INTO workflow_node_pr_binding
			 (run_id,node_id,attempt,pr_number,head_sha,target_repo_identity,
			  probe_repo_slug,target_repo_path,worktree_binding_generation,
			  receipt_id,bound_at)
			 VALUES ('run-land-recovery','implement',1,2545,?,'__main__',
			  'geoforge3d/flywheel','/tmp/flywheel','generation-1',
			  'land-recovery-binding','2026-09-26T21:59:00.000Z')`,
			["a".repeat(40)],
		);
		raw.run(
			`INSERT INTO workflow_side_effect_ledger
			 (run_id,node_id,attempt,kind,launch_ordinal,execution_id,state)
			 VALUES ('run-land-recovery','land',1,'dispatch',1,'land-exec-1','intent_recorded')`,
		);
		store.upsertSession({
			execution_id: "qa-land-recovery",
			issue_id: "FLY-2545",
			project_name: "flywheel",
			status: "awaiting_review",
			pr_number: 2545,
			pr_head_sha: "a".repeat(40),
		});
		store.ensureWorkflowGateHolder({
			runId: "run-land-recovery",
			gateNodeId: "founder_gate",
			attempt: 1,
			headSha: "a".repeat(40),
			sourceExecutionId: "qa-land-recovery",
			questionId: "land-recovery-question",
			now: "2026-09-26T21:59:30.000Z",
		});
		store.advanceWorkflowGateHolderMaterialization({
			questionId: "land-recovery-question",
			stage: "card_bound",
			cardMessageId: "land-recovery-card",
			now: "2026-09-26T21:59:40.000Z",
		});
		raw.run(
			"UPDATE workflow_gate_holder SET state='approved' WHERE question_id='land-recovery-question'",
		);
		const operation = store.ensureLandOperation({
			runId: "run-land-recovery",
			issueId: "FLY-2545",
			projectName: "flywheel",
			prNumber: 2545,
			approvedHead: "a".repeat(40),
			now: "2026-09-26T22:00:00.000Z",
		});
		raw.run(
			"UPDATE land_operation SET state='held',last_error='retry_exhausted:test' WHERE operation_id=?",
			[operation.operation_id],
		);
		expect(
			store.holdWorkflowLandNode({
				runId: "run-land-recovery",
				nodeId: "land",
				attempt: 1,
				executionId: "land-exec-1",
				operationId: operation.operation_id,
				reason: "retry_exhausted:test",
				now: "2026-09-26T22:01:00.000Z",
			}),
		).toMatchObject({ ok: true });
		const hold = store
			.listWorkflowHolds("run-land-recovery")
			.find((candidate) => candidate.shape === "land_held_with_operation")!;

		const fake = fakeStartDispatcher(store, "a".repeat(40));
		const app = express();
		app.use(express.json());
		app.use(
			"/api/runs",
			createRunsRouter(
				fake.dispatcher,
				store,
				[
					{
						projectName: "flywheel",
						projectRoot: process.cwd(),
						leads: [{ agentId: "flywheel-eng-lead" }],
					},
				] as Parameters<typeof createRunsRouter>[2],
				RunnerAdmissionController.alwaysAdmit(),
				undefined,
				false,
				undefined,
				{
					masterToken: "test-master",
					confirmTokens: new ConfirmTokenStore(),
					probeRunLiveness: async () => "unknown",
				},
			),
		);
		const server = createServer(app);
		cleanups.push(async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			store.close();
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const post = async (path: string, body: unknown) => {
			const response = await fetch(
				`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/runs/run-land-recovery${path}`,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: "Bearer test-master",
					},
					body: JSON.stringify(body),
				},
			);
			return { status: response.status, body: await response.json() };
		};
		const request = {
			runId: "run-land-recovery",
			shape: hold.shape,
			holdEventUid: hold.holdEventUid,
			decision: null,
			reason: "retry the held land operation",
			principal: "master",
			clientRequestId: "land-recovery-1",
		};
		const staged = await post("/resume/stage", request);
		expect(staged).toMatchObject({
			status: 200,
			body: {
				canonical: {
					version: 2,
					shape: "workflow_node_recovery",
					target: {
						operationKind: "redispatch_current",
						land: {
							operationId: operation.operation_id,
							resumeGeneration: 0,
							approvedHead: "a".repeat(40),
						},
					},
				},
			},
		});
		const applied = await post("/resume", {
			canonical: staged.body.canonical,
			confirmToken: staged.body.confirmToken,
		});
		expect(applied).toMatchObject({
			status: 200,
			body: { state: "dispatch_recorded", launchOrdinal: 2 },
		});
		expect(store.getLandOperation(operation.operation_id)).toMatchObject({
			state: "partial",
			resume_generation: 1,
		});
		expect(store.getWorkflowRun("run-land-recovery")?.status).toBe("active");
		expect(
			store
				.listWorkflowSideEffects("run-land-recovery")
				.filter((row) => row.kind === "dispatch"),
		).toHaveLength(2);
		const landExecutor = vi.fn(async (operationId: string) => {
			raw.run(
				"UPDATE land_operation SET state='held',last_error='retry_exhausted:again' WHERE operation_id=?",
				[operationId],
			);
			return {
				status: "held" as const,
				reason: "retry_exhausted:again",
			};
		});
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			env: ENV,
			now: () => new Date("2026-09-26T22:02:00.000Z"),
			landExecutor,
		});
		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 1 });
		expect(landExecutor).toHaveBeenCalledWith(operation.operation_id);
		expect(
			store
				.listWorkflowRunEvents("run-land-recovery")
				.filter((event) => event.kind === "land_held"),
		).toHaveLength(2);
	});
});

describe("FLY-2329 legacy active orphan recovery", () => {
	it("discovers the old null-execution release and mints a consumable dispatch", async () => {
		const projectRoot = mkdtempSync(join(tmpdir(), "fly2329-orphan-project-"));
		const stateRoot = mkdtempSync(join(tmpdir(), "fly2329-orphan-markers-"));
		const store = await StateStore.create(":memory:");
		const head = await materializePredecessor(store, projectRoot);
		const fake = fakeStartDispatcher(store, head);
		const engine = (now: string) =>
			new WorkflowEngineDispatcher({
				store,
				startDispatcher: fake.dispatcher,
				stateRoot,
				env: ENV,
				now: () => new Date(now),
				probeUnlaunchedExternalEvidence: async () => "absent",
				resolveRunAlertIdentity: () => ({
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				}),
			});
		expect(await engine("2026-07-16T00:07:00.000Z").reconcile()).toEqual({
			started: 0,
			held: 1,
		});
		expect(await engine("2026-07-16T01:08:00.000Z").reconcile()).toEqual({
			started: 0,
			held: 0,
		});
		const rollback = store
			.listWorkflowRunEvents(RUN_ID)
			.find((event) => event.kind === "unlaunched_admission_rolled_back")!;
		const raw = (
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		raw.run(
			"UPDATE workflow_run_node SET state='pending',execution_id=NULL,ended_at=NULL WHERE run_id=? AND node_id='implement' AND attempt=1",
			[RUN_ID],
		);
		raw.run("UPDATE workflow_run SET status='active' WHERE run_id=?", [RUN_ID]);
		expect(
			store
				.listWorkflowHolds(RUN_ID)
				.find((hold) => hold.shape === "legacy_active_orphan"),
		).toBeUndefined();
		store.appendWorkflowRunEvent({
			runId: RUN_ID,
			eventUid: `hold_resumed:unlaunched_admission_rolled_back:${rollback.event_uid}`,
			kind: "hold_resumed",
			nodeId: "implement",
			payload: {
				shape: "unlaunched_admission_rolled_back",
				holdEventUid: rollback.event_uid,
				operationId: "legacy-release-without-dispatch",
			},
		});
		expect(store.listWorkflowHolds(RUN_ID)).toContainEqual(
			expect.objectContaining({
				shape: "legacy_active_orphan",
				holdEventUid: rollback.event_uid,
				resumable: true,
			}),
		);

		const app = express();
		app.use(express.json());
		app.use(
			"/api/runs",
			createRunsRouter(
				fake.dispatcher,
				store,
				[
					{
						projectName: "flywheel",
						projectRoot,
						leads: [{ agentId: "flywheel-eng-lead" }],
					},
				] as Parameters<typeof createRunsRouter>[2],
				RunnerAdmissionController.alwaysAdmit(),
				undefined,
				false,
				undefined,
				{
					masterToken: "test-master",
					confirmTokens: new ConfirmTokenStore(),
					probeRunLiveness: async () => "dead",
				},
			),
		);
		const server = createServer(app);
		cleanups.push(async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			store.close();
			rmSync(projectRoot, { recursive: true, force: true });
			rmSync(stateRoot, { recursive: true, force: true });
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const post = async (path: string, body: unknown) => {
			const response = await fetch(
				`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/runs/${RUN_ID}${path}`,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: "Bearer test-master",
					},
					body: JSON.stringify(body),
				},
			);
			return { status: response.status, body: await response.json() };
		};
		const request = {
			runId: RUN_ID,
			shape: "legacy_active_orphan",
			holdEventUid: rollback.event_uid,
			decision: null,
			reason: "repair the legacy release that did not mint a dispatch",
			principal: "master",
			clientRequestId: "fly2329-active-orphan-recovery",
		};
		const staged = await post("/resume/stage", request);
		expect(staged).toMatchObject({
			status: 200,
			body: {
				canonical: {
					version: 2,
					shape: "workflow_node_recovery",
					target: {
						operationKind: "redispatch_current",
						previousExecutionId: ORIGINAL_EXECUTION,
						previousLaunchOrdinal: 1,
					},
				},
			},
		});
		const applied = await post("/resume", {
			canonical: staged.body.canonical,
			confirmToken: staged.body.confirmToken,
		});
		expect(applied).toMatchObject({
			status: 200,
			body: { state: "dispatch_recorded", launchOrdinal: 2 },
		});
		expect(store.getWorkflowRunNode(RUN_ID, "implement", 1)).toMatchObject({
			state: "pending",
			execution_id: applied.body.executionId,
		});
		expect(store.getWorkflowRun(RUN_ID)?.status).toBe("active");
		fake.allowLaunch();
		expect(await engine("2026-07-16T01:09:00.000Z").reconcile()).toEqual({
			started: 1,
			held: 0,
		});
		expect(
			store
				.listWorkflowSideEffects(RUN_ID)
				.find((row) => row.id === applied.body.dispatchLedgerId)?.state,
		).toBe("started");
	});
});

describe("state-only recovery through the unified endpoint", () => {
	it("resumes an operator-paused current execution without minting a replacement", async () => {
		const projectRoot = mkdtempSync(join(tmpdir(), "fly2922-pause-project-"));
		const store = await StateStore.create(":memory:");
		const head = await materializePredecessor(store, projectRoot, true);
		const raw = (
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		raw.run("UPDATE workflow_run SET status = 'held' WHERE run_id = ?", [
			RUN_ID,
		]);
		store.appendWorkflowRunEvent({
			runId: RUN_ID,
			eventUid: "operator-pause:fly2922",
			kind: "run_held_by_operator",
			nodeId: "design",
			executionId: PREDECESSOR,
			payload: { attempt: 1, reason: "operator maintenance pause" },
		});
		const beforeNode = store.getWorkflowRunNode(RUN_ID, "design", 1);
		const beforeLedger = store.listWorkflowSideEffects(RUN_ID);
		const fake = fakeStartDispatcher(store, head);
		const liveness = vi.fn(async () => "alive" as const);
		const app = express();
		app.use(express.json());
		app.use(
			"/api/runs",
			createRunsRouter(
				fake.dispatcher,
				store,
				[
					{
						projectName: "flywheel",
						projectRoot,
						leads: [{ agentId: "flywheel-eng-lead" }],
					},
				] as Parameters<typeof createRunsRouter>[2],
				RunnerAdmissionController.alwaysAdmit(),
				undefined,
				false,
				undefined,
				{
					masterToken: "test-master",
					confirmTokens: new ConfirmTokenStore(),
					probeRunLiveness: liveness,
				},
			),
		);
		const server = createServer(app);
		cleanups.push(async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			store.close();
			rmSync(projectRoot, { recursive: true, force: true });
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const post = async (path: string, body: unknown) => {
			const response = await fetch(
				`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/runs/${RUN_ID}${path}`,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: "Bearer test-master",
					},
					body: JSON.stringify(body),
				},
			);
			return { status: response.status, body: await response.json() };
		};
		const request = {
			runId: RUN_ID,
			shape: "run_held_by_operator",
			holdEventUid: "operator-pause:fly2922",
			decision: null,
			reason: "resume the existing execution",
			principal: "master",
			clientRequestId: "fly2922-resume-existing",
		};
		const staged = await post("/resume/stage", request);
		expect(staged).toMatchObject({
			status: 200,
			body: {
				canonical: {
					version: 2,
					shape: "workflow_node_recovery",
					target: {
						operationKind: "resume_existing",
						previousExecutionId: PREDECESSOR,
					},
				},
			},
		});
		const applied = await post("/resume", {
			canonical: staged.body.canonical,
			confirmToken: staged.body.confirmToken,
		});
		expect(applied).toMatchObject({
			status: 200,
			body: { ok: true, state: "state_applied" },
		});
		expect(store.getWorkflowRun(RUN_ID)?.status).toBe("active");
		expect(store.getWorkflowRunNode(RUN_ID, "design", 1)).toEqual(beforeNode);
		expect(store.listWorkflowSideEffects(RUN_ID)).toEqual(beforeLedger);
		expect(fake.start).not.toHaveBeenCalled();
		expect(liveness).not.toHaveBeenCalled();
		expect(
			store.getWorkflowHoldResumeReceipt(request.clientRequestId),
		).toMatchObject({ receiptKind: "state_applied" });
		expect(
			await post("/resume", {
				canonical: staged.body.canonical,
				confirmToken: staged.body.confirmToken,
			}),
		).toMatchObject({
			status: 200,
			body: { idempotentReplay: true, state: "state_applied" },
		});
		expect(store.listWorkflowSideEffects(RUN_ID)).toEqual(beforeLedger);
	});

	it("rearms the exact gate probe without creating a gate dispatch", async () => {
		const projectRoot = mkdtempSync(join(tmpdir(), "fly2922-gate-project-"));
		const store = await StateStore.create(":memory:");
		await materializePredecessor(store, projectRoot, true);
		cleanups.push(async () => {
			store.close();
			rmSync(projectRoot, { recursive: true, force: true });
		});
		const raw = (
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		raw.run(
			`INSERT INTO workflow_run_node
			 (run_id,node_id,attempt,state,execution_id)
			 VALUES (?, 'founder_gate', 1, 'review', NULL)`,
			[RUN_ID],
		);
		raw.run(
			"UPDATE workflow_run SET status='held',current_node_id='founder_gate' WHERE run_id=?",
			[RUN_ID],
		);
		raw.run(
			`INSERT INTO workflow_gate_holder
			 (run_id,gate_node_id,attempt,head_sha,source_execution_id,question_id,
			  state,materialization_stage,origin_probe_attempts,
			  origin_probe_last_reason,created_at,updated_at)
			 VALUES (?,'founder_gate',1,? ,?,'fly2922-gate-question',
			  'materializing','question_intent',7,'origin_terminal',?,?)`,
			[
				RUN_ID,
				"b".repeat(40),
				PREDECESSOR,
				"2026-09-26T23:00:00.000Z",
				"2026-09-26T23:00:00.000Z",
			],
		);
		store.appendWorkflowRunEvent({
			runId: RUN_ID,
			eventUid: "gate-origin-terminal:fly2922",
			kind: "workflow_gate_origin_preflight_terminal",
			nodeId: "founder_gate",
			payload: {
				questionId: "fly2922-gate-question",
				reason: "origin_terminal",
			},
		});
		const beforeLedger = store.listWorkflowSideEffects(RUN_ID);
		const prepared = await prepareWorkflowNodeRecovery(store, {
			runId: RUN_ID,
			shape: "workflow_gate_origin_preflight_terminal",
			holdEventUid: "gate-origin-terminal:fly2922",
			decision: null,
			reason: "retry the exact gate origin probe",
			principal: "master",
			clientRequestId: "fly2922-rearm-gate",
		});
		expect(prepared.canonical).toMatchObject({
			version: 2,
			shape: "workflow_node_recovery",
			target: {
				operationKind: "rearm_gate_probe",
				previousExecutionId: null,
				previousLaunchOrdinal: 0,
			},
		});
		const result = store.recoverWorkflowNode({
			...prepared,
			now: new Date().toISOString(),
		});
		expect(result).toMatchObject({ ok: true, state: "state_applied" });
		expect(store.getWorkflowRun(RUN_ID)?.status).toBe("active");
		expect(store.listWorkflowSideEffects(RUN_ID)).toEqual(beforeLedger);
		expect(
			store.getCurrentWorkflowGateHolderByQuestionId("fly2922-gate-question"),
		).toMatchObject({
			origin_probe_attempts: 0,
			origin_probe_last_reason: null,
		});
	});
});

describe("recorded workflow decisions through the unified endpoint", () => {
	async function heldDecision(
		shape: "loop_limit_escalated" | "rework_suppressed_idle_spin",
	) {
		const projectRoot = mkdtempSync(
			join(tmpdir(), "fly2922-decision-project-"),
		);
		const store = await StateStore.create(":memory:");
		const head = await materializePredecessor(store, projectRoot, true);
		cleanups.push(async () => {
			store.close();
			rmSync(projectRoot, { recursive: true, force: true });
		});
		const sourceAttempt = shape === "loop_limit_escalated" ? 4 : 1;
		const targetAttempt = shape === "loop_limit_escalated" ? 5 : 2;
		const sourceExecutionId = `qa-${shape}`;
		const holdEventUid = `hold:${shape}`;
		const raw = (
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		raw.run(
			`INSERT INTO workflow_run_node
			 (run_id,node_id,attempt,state,execution_id,ended_at)
			 VALUES (?, 'qa', ?, 'done', ?, ?)`,
			[RUN_ID, sourceAttempt, sourceExecutionId, "2026-09-26T23:00:00.000Z"],
		);
		raw.run(
			`INSERT INTO workflow_node_completion
			 (activation_id,run_id,node_id,attempt,execution_id,route,event_uid,
			  source_event_id,completion_submission_digest,completed_at)
			 VALUES (NULL,?,'qa',?,?,'blocked',?,?,?,?)`,
			[
				RUN_ID,
				sourceAttempt,
				sourceExecutionId,
				`completion:${shape}`,
				`source:${shape}`,
				"c".repeat(64),
				"2026-09-26T23:00:00.000Z",
			],
		);
		raw.run(
			"UPDATE workflow_run SET status='held',current_node_id='qa' WHERE run_id=?",
			[RUN_ID],
		);
		store.upsertSession({
			execution_id: sourceExecutionId,
			issue_id: ISSUE_ID,
			issue_identifier: ISSUE_ID,
			issue_title: "Recover a recorded workflow decision",
			project_name: "flywheel",
			status: "completed",
			session_role: "qa",
			workflow_node_id: "qa",
			design_backend: "claude",
			doc_tier: "none",
			worktree_path: projectRoot,
		});
		store.appendWorkflowRunEvent({
			runId: RUN_ID,
			eventUid: holdEventUid,
			kind: shape,
			nodeId: "qa",
			edgeId: "qa_retry",
			executionId: sourceExecutionId,
			payload: {
				edgeId: "qa_retry",
				targetNodeId: "implement",
				targetAttempt,
				sourceAttempt,
				outcome: "qa_fail",
				loopIteration: sourceAttempt,
				escalated: true,
				...(shape === "rework_suppressed_idle_spin"
					? {
							reason: "current_qa_pass_already_exists",
							subjectDigest: "a".repeat(40),
						}
					: { maxIterations: 3, onLimit: "escalate" }),
			},
		});
		if (shape === "rework_suppressed_idle_spin") {
			raw.run(
				`INSERT INTO workflow_claims
				 (server_seq,issued_at,issue_id,workflow_run_id,node_id,decision_kind,
				  attempt,predicate,issuer_kind,subject_kind,subject_digest,permanent,
				  authority_id)
				 VALUES (1,?,?,?,?,? ,?,'qa_passed','bridge_policy','git_head',?,1,?)`,
				[
					"2026-09-26T22:59:00.000Z",
					ISSUE_ID,
					RUN_ID,
					"qa",
					"qa_verdict",
					sourceAttempt,
					"a".repeat(40),
					"fly2922-test-pass",
				],
			);
		}
		return {
			store,
			raw,
			head,
			projectRoot,
			sourceAttempt,
			targetAttempt,
			sourceExecutionId,
			holdEventUid,
		};
	}

	it("continues a loop limit with one real dispatch and one consumable lineage edge", async () => {
		const fixture = await heldDecision("loop_limit_escalated");
		fixture.store.insertEvent({
			event_id: "workflow-decision:fly2922:qa-fail",
			execution_id: fixture.sourceExecutionId,
			issue_id: ISSUE_ID,
			project_name: "flywheel",
			event_type: "workflow_decision",
			source: "bridge.workflow-decision",
			payload: { status: "fail", summary: "recorded QA failure" },
		});
		const sourceCompletion = fixture.store.getWorkflowNodeCompletion(
			RUN_ID,
			"qa",
			fixture.sourceAttempt,
		);
		const prepared = await prepareWorkflowNodeRecovery(fixture.store, {
			runId: RUN_ID,
			shape: "loop_limit_escalated",
			holdEventUid: fixture.holdEventUid,
			decision: null,
			reason: "continue the recorded loop target",
			principal: "master",
			clientRequestId: "fly2922-loop-continue",
		});
		expect(prepared.canonical.target).toMatchObject({
			operationKind: "apply_recorded_decision",
			nodeId: "implement",
			attempt: fixture.targetAttempt,
			previousExecutionId: fixture.sourceExecutionId,
			previousLaunchOrdinal: 0,
		});
		const applied = fixture.store.recoverWorkflowNode({
			...prepared,
			now: new Date().toISOString(),
		});
		expect(applied).toMatchObject({
			ok: true,
			idempotentReplay: false,
			state: "dispatch_recorded",
			launchOrdinal: 1,
			dispatchLedgerId: expect.any(Number),
		});
		if (!applied.ok || applied.state !== "dispatch_recorded") {
			throw new Error("recorded decision dispatch missing");
		}
		expect(
			fixture.store.getWorkflowNodeCompletion(
				RUN_ID,
				"qa",
				fixture.sourceAttempt,
			),
		).toEqual(sourceCompletion);
		expect(
			fixture.store.getWorkflowRunNode(RUN_ID, "qa", fixture.sourceAttempt),
		).toMatchObject({ state: "done", execution_id: fixture.sourceExecutionId });
		expect(
			fixture.store.getWorkflowRunNode(
				RUN_ID,
				"implement",
				fixture.targetAttempt,
			),
		).toMatchObject({ state: "pending", execution_id: applied.executionId });
		expect(
			fixture.store
				.listWorkflowSideEffects(RUN_ID)
				.find((row) => row.id === applied.dispatchLedgerId),
		).toMatchObject({
			node_id: "implement",
			attempt: fixture.targetAttempt,
			execution_id: applied.executionId,
			launch_ordinal: 1,
			state: "intent_recorded",
		});
		const decisionEdges = fixture.store
			.listWorkflowRunEvents(RUN_ID)
			.filter(
				(event) =>
					event.kind === "edge_traversed" &&
					event.payload?.origin === "hold_decision_resume",
			);
		expect(decisionEdges).toEqual([
			expect.objectContaining({
				node_id: "qa",
				execution_id: fixture.sourceExecutionId,
				payload: expect.objectContaining({
					operationId: applied.operationId,
					sourceHoldEventUid: fixture.holdEventUid,
					sourceAttempt: fixture.sourceAttempt,
					targetNodeId: "implement",
					targetAttempt: fixture.targetAttempt,
					outcome: "qa_fail",
					loopIteration: fixture.sourceAttempt,
					successorExecutionId: applied.executionId,
					gateOpened: false,
				}),
			}),
		]);
		expect(fixture.store.getWorkflowRun(RUN_ID)).toMatchObject({
			status: "active",
			current_node_id: "implement",
		});
		const replay = fixture.store.recoverWorkflowNode({
			...prepared,
			now: new Date().toISOString(),
		});
		expect(replay).toMatchObject({
			ok: true,
			idempotentReplay: true,
			executionId: applied.executionId,
			dispatchLedgerId: applied.dispatchLedgerId,
		});
		expect(
			fixture.store
				.listWorkflowRunEvents(RUN_ID)
				.filter((event) => event.kind === "edge_traversed"),
		).toHaveLength(1);

		const stateRoot = mkdtempSync(join(tmpdir(), "fly2922-decision-markers-"));
		cleanups.push(async () => {
			rmSync(stateRoot, { recursive: true, force: true });
		});
		const fake = fakeStartDispatcher(
			fixture.store,
			fixture.head,
			fixture.projectRoot,
		);
		fake.allowLaunch();
		const engine = new WorkflowEngineDispatcher({
			store: fixture.store,
			startDispatcher: fake.dispatcher,
			stateRoot,
			env: ENV,
			now: () => new Date(),
			resolveRunAlertIdentity: () => ({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			}),
		});
		expect(await engine.reconcile()).toMatchObject({ held: 0 });
		const recoveredRequests = fake.requests.filter(
			(request) =>
				request.generalizedExecution?.executionId === applied.executionId,
		);
		expect(recoveredRequests).toHaveLength(1);
		expect(recoveredRequests[0]).toMatchObject({
			startPoint: fixture.head,
			phaseFixContext: {
				round: fixture.sourceAttempt,
				qaSummary: "recorded QA failure",
			},
		});
	});

	it("forces idle-spin rework through the recorded target without /rework", async () => {
		const fixture = await heldDecision("rework_suppressed_idle_spin");
		const prepared = await prepareWorkflowNodeRecovery(fixture.store, {
			runId: RUN_ID,
			shape: "rework_suppressed_idle_spin",
			holdEventUid: fixture.holdEventUid,
			decision: "force_rework",
			reason: "force the frozen target once",
			principal: "master",
			clientRequestId: "fly2922-idle-force",
		});
		const applied = fixture.store.recoverWorkflowNode({
			...prepared,
			now: new Date().toISOString(),
		});
		expect(applied).toMatchObject({
			ok: true,
			state: "dispatch_recorded",
			launchOrdinal: 1,
		});
		expect(
			fixture.store
				.listWorkflowRunEvents(RUN_ID)
				.filter(
					(event) =>
						event.kind === "edge_traversed" &&
						event.payload?.origin === "hold_decision_resume",
				),
		).toHaveLength(1);
		expect(fixture.store.listWorkflowRunEvents(RUN_ID)).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "operator_rework_requested" }),
			]),
		);
	});

	it("accepts only the still-current same-head PASS without minting a dispatch", async () => {
		const revokedFixture = await heldDecision("rework_suppressed_idle_spin");
		const request = {
			runId: RUN_ID,
			shape: "rework_suppressed_idle_spin",
			holdEventUid: revokedFixture.holdEventUid,
			decision: "accept_current_pass",
			reason: "accept the exact current QA PASS",
			principal: "master" as const,
			clientRequestId: "fly2922-idle-accept",
		};
		const prepared = await prepareWorkflowNodeRecovery(
			revokedFixture.store,
			request,
		);
		expect(prepared.canonical.target.operationKind).toBe(
			"apply_recorded_decision",
		);
		revokedFixture.raw.run(
			"INSERT INTO workflow_claim_revocation (claim_id,reason,actor) VALUES (1,'head_changed','test')",
		);
		expect(
			revokedFixture.store.recoverWorkflowNode({
				...prepared,
				now: new Date().toISOString(),
			}),
		).toMatchObject({ ok: false });

		const fixture = await heldDecision("rework_suppressed_idle_spin");
		const beforeLedger = fixture.store.listWorkflowSideEffects(RUN_ID);
		const sourceCompletion = fixture.store.getWorkflowNodeCompletion(
			RUN_ID,
			"qa",
			fixture.sourceAttempt,
		);
		const restaged = await prepareWorkflowNodeRecovery(fixture.store, request);
		const applied = fixture.store.recoverWorkflowNode({
			...restaged,
			now: new Date().toISOString(),
		});
		expect(applied).toMatchObject({
			ok: true,
			idempotentReplay: false,
			state: "state_applied",
		});
		expect(fixture.store.listWorkflowSideEffects(RUN_ID)).toEqual(beforeLedger);
		expect(
			fixture.store.getWorkflowNodeCompletion(
				RUN_ID,
				"qa",
				fixture.sourceAttempt,
			),
		).toEqual(sourceCompletion);
		expect(
			fixture.store
				.listWorkflowRunEvents(RUN_ID)
				.filter((event) => event.kind === "edge_traversed"),
		).toEqual([]);
		expect(fixture.store.getWorkflowRun(RUN_ID)).toMatchObject({
			status: "active",
			current_node_id: "qa",
		});
	});
});
