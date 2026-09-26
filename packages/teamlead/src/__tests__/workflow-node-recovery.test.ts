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
import { StateStore } from "../StateStore.js";
import { workflowRecoveryCanonicalSchema } from "../workflow-recovery-contract.js";
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
				(
					await post("/resume", {
						...applyRequest,
						canonical: {
							...canonical,
							clientRequestId: "stale-second-request",
						},
					})
				).status,
			).toBe(409);
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
});
