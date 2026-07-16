import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
	IStartDispatcher,
	StartRequest,
} from "../bridge/retry-dispatcher.js";
import { WorkflowEngineDispatcher } from "../bridge/workflow-engine-dispatcher.js";
import { StateStore } from "../StateStore.js";
import { loadBundledWorkflowSeeds } from "../workflow-template.js";

const HEAD = "a".repeat(40);

async function storeWithIntent(target: "implement" | "qa") {
	const store = await StateStore.create(":memory:");
	const seed = loadBundledWorkflowSeeds().find(
		(candidate) => candidate.templateId === "tpl_eng_heavy",
	)!;
	store.importWorkflowTemplateSeed(seed);
	store.materializeWorkflowRun({
		runId: "run-1",
		issueId: "FLY-1307",
		projectName: "flywheel",
		taskCategory: "code",
		templateId: seed.templateId,
		claimsReadEnrolled: false,
		actor: "lead",
		startReservation: {
			idempotencyKey: "engine-start",
			selectionDigest: "selection",
			nodeId: "design",
			attempt: 1,
			executionId: "design-1",
			createdAt: "2026-07-16T00:00:00.000Z",
		},
	});
	store.upsertWorkflowRunNode({
		runId: "run-1",
		nodeId: "design",
		attempt: 1,
		state: "running",
		executionId: "design-1",
	});
	store.upsertSession({
		execution_id: "design-1",
		issue_id: "FLY-1307",
		project_name: "flywheel",
		status: "design_done",
		issue_identifier: "FLY-1307",
		issue_title: "DAG template engine",
		design_backend: "claude",
		doc_tier: "full",
		issue_url: "https://linear.app/flywheel/FLY-1307",
		worktree_path: "/unused/design",
	});
	store.commitWorkflowTransitionTx({
		runId: "run-1",
		nodeId: "design",
		attempt: 1,
		executionId: "design-1",
		outcome: "design_done",
		successorExecutionId: "implement-1",
		now: "2026-07-16T00:05:00.000Z",
	});
	if (target === "qa") {
		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "awaiting_review",
			issue_identifier: "FLY-1307",
			issue_title: "DAG template engine",
			design_backend: "claude",
			doc_tier: "full",
			issue_url: "https://linear.app/flywheel/FLY-1307",
			worktree_path: "/unused/implement",
		});
		store.applyWorkflowShadowBatch({
			projectName: "flywheel",
			issueId: "FLY-1307",
			runId: "run-1",
			ops: [
				{
					op: "side_effect",
					node: "implement",
					attempt: 1,
					executionId: "implement-1",
					to: "started",
				},
			],
		});
		store.commitWorkflowTransitionTx({
			runId: "run-1",
			nodeId: "implement",
			attempt: 1,
			executionId: "implement-1",
			outcome: "implement_done",
			successorExecutionId: "qa-1",
			now: "2026-07-16T00:10:00.000Z",
		});
	}
	return store;
}

async function storeWithProductOutputIntent() {
	const store = await StateStore.create(":memory:");
	const canonicalRoot = mkdtempSync(join(tmpdir(), "fly1307-product-agent-"));
	mkdirSync(join(canonicalRoot, "agents"));
	writeFileSync(
		join(canonicalRoot, "agents", "generic-executor.md"),
		"Execute the pinned node.\n",
	);
	const seed = loadBundledWorkflowSeeds().find(
		(candidate) => candidate.templateId === "tpl_product_v1",
	)!;
	const env = {
		FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
		FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	};
	store.importWorkflowTemplateSeed(seed, env);
	store.materializeWorkflowRun({
		runId: "product-run",
		issueId: "FLY-1307",
		projectName: "flywheel",
		taskCategory: "product",
		templateId: seed.templateId,
		claimsReadEnrolled: false,
		actor: "lead",
		canonicalRoot,
		env,
		startReservation: {
			idempotencyKey: "product-start",
			selectionDigest: "product-selection",
			nodeId: "research",
			attempt: 1,
			executionId: "research-1",
			createdAt: "2026-07-16T00:00:00.000Z",
		},
	});
	store.upsertWorkflowRunNode({
		runId: "product-run",
		nodeId: "research",
		attempt: 1,
		state: "running",
		executionId: "research-1",
	});
	store.upsertSession({
		execution_id: "research-1",
		issue_id: "FLY-1307",
		project_name: "flywheel",
		status: "completed",
	});
	store.commitWorkflowTransitionTx({
		runId: "product-run",
		nodeId: "research",
		attempt: 1,
		executionId: "research-1",
		outcome: "node_done",
		successorExecutionId: "produce-1",
		now: "2026-07-16T00:05:00.000Z",
	});
	return { store, canonicalRoot, env };
}

function fakeStartDispatcher(store: StateStore) {
	const requests: StartRequest[] = [];
	const start = vi.fn(async (request: StartRequest) => {
		requests.push(request);
		const committed = request.generalizedExecution?.commitWorkflowLaunch?.();
		if (!committed?.ok) throw new Error(committed?.reason ?? "not_committed");
		store.upsertSession({
			execution_id: request.generalizedExecution!.executionId,
			issue_id: request.issueId,
			project_name: request.projectName,
			status: "running",
			session_role: request.sessionRole,
			chat_thread_role: request.sessionRole,
		});
		return {
			executionId: request.generalizedExecution!.executionId,
			issueId: request.issueId,
		};
	});
	const dispatcher = {
		start,
		getInflightCount: () => 0,
		validateAgentName: () => ({ ok: true as const }),
	} as IStartDispatcher;
	return { dispatcher, requests, start };
}

describe("WorkflowEngineDispatcher", () => {
	it("consumes a durable successor intent exactly once with pinned dispatch", async () => {
		const store = await storeWithIntent("implement");
		const fake = fakeStartDispatcher(store);
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1307-engine-dispatch-")),
			env: { FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1" },
			resolvePredecessorHead: async () => HEAD,
		});
		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(fake.requests[0]).toMatchObject({
			issueId: "FLY-1307",
			projectName: "flywheel",
			successorExecutionId: "implement-1",
			sessionRole: "implement",
			shareParentBranch: true,
			startPoint: HEAD,
			ignoreRunnerLabelSelection: true,
			issueIdentifier: "FLY-1307",
			issueTitle: "DAG template engine",
			designBackend: "claude",
			generalizedExecution: {
				executionId: "implement-1",
				nodeId: "implement",
				dispatch: {
					vendor: "codex",
					model: "gpt-5.6-sol",
					effort: "xhigh",
				},
			},
		});
		expect(store.listWorkflowSideEffects("run-1")[0]?.state).toBe("started");
		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 0 });
		expect(fake.start).toHaveBeenCalledTimes(1);
		store.close();
	});

	it("preserves Lead routing and QA-fix context on an engine loop dispatch", async () => {
		const store = await storeWithIntent("qa");
		store.applyWorkflowShadowBatch({
			projectName: "flywheel",
			issueId: "FLY-1307",
			runId: "run-1",
			ops: [
				{
					op: "side_effect",
					node: "qa",
					attempt: 1,
					executionId: "qa-1",
					to: "started",
				},
			],
		});
		store.upsertWorkflowRunNode({
			runId: "run-1",
			nodeId: "qa",
			attempt: 1,
			state: "running",
			executionId: "qa-1",
		});
		store.upsertSession({
			execution_id: "qa-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "completed",
			issue_identifier: "FLY-1307",
			issue_title: "DAG template engine",
			design_backend: "claude",
			doc_tier: "full",
			issue_url: "https://linear.app/flywheel/FLY-1307",
		});
		store.insertEvent({
			event_id: "workflow-decision:qa-1:fail",
			execution_id: "qa-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			event_type: "workflow_decision",
			source: "bridge.workflow-decision",
			payload: { status: "fail", summary: "two acceptance tests failed" },
		});
		expect(
			store.commitWorkflowTransitionTx({
				runId: "run-1",
				nodeId: "qa",
				attempt: 1,
				executionId: "qa-1",
				outcome: "qa_fail",
				successorExecutionId: "implement-fix-1",
				now: "2026-07-16T00:15:00.000Z",
			}),
		).toMatchObject({ ok: true, loopIteration: 1 });

		const fake = fakeStartDispatcher(store);
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1307-engine-fix-")),
			env: { FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1" },
			resolvePredecessorHead: async () => HEAD,
			resolveLeadId: () => "flywheel-eng-lead",
		});
		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(fake.requests[0]).toMatchObject({
			leadId: "flywheel-eng-lead",
			sessionRole: "implement",
			phaseFixContext: {
				round: 1,
				qaSummary: "two acceptance tests failed",
			},
		});
		store.close();
	});

	it("delivers a scoped decision credential to an engine-produced QA node", async () => {
		const store = await storeWithIntent("qa");
		const fake = fakeStartDispatcher(store);
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1307-engine-qa-")),
			env: { FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1" },
			resolvePredecessorHead: async () => HEAD,
		});
		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(fake.requests[0]).toMatchObject({
			sessionRole: "qa",
			generalizedExecution: {
				executionId: "qa-1",
				submissionCredential: expect.any(String),
			},
		});
		store.close();
	});

	it("rotates a lost QA decision credential after admission response loss", async () => {
		const store = await storeWithIntent("qa");
		const admitted = store.admitGeneralizedWorkflowExecution({
			runId: "run-1",
			nodeId: "qa",
			executionId: "qa-1",
			attempt: 1,
			now: "2026-07-16T00:11:00.000Z",
			expiresAt: "2026-07-16T01:11:00.000Z",
			absoluteDeadlineAt: "2026-07-17T00:11:00.000Z",
			env: { FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1" },
		});
		expect(admitted).toMatchObject({
			ok: true,
			idempotentReplay: false,
			submissionCredential: expect.any(String),
		});

		const fake = fakeStartDispatcher(store);
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1307-engine-recover-")),
			env: { FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1" },
			now: () => new Date("2026-07-16T00:12:00.000Z"),
			resolvePredecessorHead: async () => HEAD,
		});
		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(
			fake.requests[0]?.generalizedExecution?.submissionCredential,
		).toEqual(expect.any(String));
		expect(
			fake.requests[0]?.generalizedExecution?.submissionCredential,
		).not.toBe(admitted.ok ? admitted.submissionCredential : undefined);
		store.close();
	});

	it("repairs a committed launch only after the prior runner is proven dead", async () => {
		const store = await storeWithIntent("qa");
		const stateRoot = mkdtempSync(join(tmpdir(), "fly1307-engine-dead-"));
		const markerPath = join(stateRoot, "qa-1");
		const admitted = store.admitGeneralizedWorkflowExecution({
			runId: "run-1",
			nodeId: "qa",
			executionId: "qa-1",
			attempt: 1,
			now: "2026-07-16T00:11:00.000Z",
			expiresAt: "2026-07-16T01:11:00.000Z",
			absoluteDeadlineAt: "2026-07-17T00:11:00.000Z",
			env: { FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1" },
		});
		expect(admitted).toMatchObject({
			ok: true,
			submissionCredential: expect.any(String),
		});
		const launch = store.recoverOrAcquireWorkflowLaunch({
			executionId: "qa-1",
			ownerId: "dead-owner",
			now: "2026-07-16T00:11:00.000Z",
			leaseExpiresAt: "2026-07-16T01:11:00.000Z",
			markerPath,
		});
		if (launch.status !== "acquired") throw new Error("launch not acquired");
		expect(
			store.fencedCommitWorkflowLaunch({
				executionId: "qa-1",
				ownerId: "dead-owner",
				generation: launch.generation,
				deliveryAttempt: launch.deliveryAttempt,
				markerPath,
				now: "2026-07-16T00:11:30.000Z",
			}),
		).toMatchObject({ ok: true });

		const fake = fakeStartDispatcher(store);
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot,
			env: { FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1" },
			now: () => new Date("2026-07-16T00:12:00.000Z"),
			resolvePredecessorHead: async () => HEAD,
			probeLaunchLiveness: async () => "dead",
		});
		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(fake.start).toHaveBeenCalledTimes(1);
		expect(
			fake.requests[0]?.generalizedExecution?.submissionCredential,
		).toEqual(expect.any(String));
		expect(
			fake.requests[0]?.generalizedExecution?.submissionCredential,
		).not.toBe(admitted.ok ? admitted.submissionCredential : undefined);
		expect(store.getWorkflowLaunchOwner("qa-1")).toMatchObject({
			delivery_state: "delivered",
			delivery_attempt: 1,
		});
		store.close();
	});

	it("adopts a completed node receipt without relaunching or regressing its projection", async () => {
		const store = await storeWithIntent("implement");
		store.upsertWorkflowRunNode({
			runId: "run-1",
			nodeId: "implement",
			attempt: 1,
			state: "done",
			executionId: "implement-1",
			endedAt: "2026-07-16T00:06:00.000Z",
		});
		const fake = fakeStartDispatcher(store);
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1307-engine-adopt-")),
			env: { FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1" },
			resolvePredecessorHead: async () => HEAD,
		});
		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(fake.start).not.toHaveBeenCalled();
		expect(store.listWorkflowSideEffects("run-1")[0]?.state).toBe("started");
		expect(store.getWorkflowRunNode("run-1", "implement", 1)?.state).toBe(
			"done",
		);
		store.close();
	});

	it("rotates a lost output credential under the committed delivery-repair fence", async () => {
		const { store, canonicalRoot, env } = await storeWithProductOutputIntent();
		const stateRoot = mkdtempSync(join(tmpdir(), "fly1307-output-repair-"));
		const markerPath = join(stateRoot, "produce-1");
		const admitted = store.admitGeneralizedWorkflowExecution({
			runId: "product-run",
			nodeId: "produce",
			executionId: "produce-1",
			attempt: 1,
			now: "2026-07-16T00:06:00.000Z",
			expiresAt: "2026-07-16T01:06:00.000Z",
			absoluteDeadlineAt: "2026-07-17T00:06:00.000Z",
			env,
		});
		expect(admitted).toMatchObject({
			ok: true,
			outputCredential: expect.any(String),
		});
		const launch = store.recoverOrAcquireWorkflowLaunch({
			executionId: "produce-1",
			ownerId: "dead-produce-owner",
			now: "2026-07-16T00:06:00.000Z",
			leaseExpiresAt: "2026-07-16T01:06:00.000Z",
			markerPath,
		});
		if (launch.status !== "acquired") throw new Error("launch not acquired");
		expect(
			store.fencedCommitWorkflowLaunch({
				executionId: "produce-1",
				ownerId: "dead-produce-owner",
				generation: launch.generation,
				deliveryAttempt: launch.deliveryAttempt,
				markerPath,
				now: "2026-07-16T00:06:30.000Z",
			}),
		).toMatchObject({ ok: true });
		const fake = fakeStartDispatcher(store);
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot,
			env,
			now: () => new Date("2026-07-16T00:07:00.000Z"),
			probeLaunchLiveness: async () => "dead",
		});
		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(fake.requests[0]?.generalizedExecution?.outputCredential).toEqual(
			expect.any(String),
		);
		expect(fake.requests[0]?.generalizedExecution?.outputCredential).not.toBe(
			admitted.ok ? admitted.outputCredential : undefined,
		);
		store.close();
		rmSync(canonicalRoot, { recursive: true, force: true });
	});
});
