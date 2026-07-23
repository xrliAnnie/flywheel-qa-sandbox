import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	type MaterializedHeadAuthority,
	receiptBackedMaterializedHeadAuthority,
} from "../bridge/materialized-head-authority.js";
import type {
	IStartDispatcher,
	StartRequest,
} from "../bridge/retry-dispatcher.js";
import { WorkflowDocsMaterializer } from "../bridge/workflow-docs-materializer.js";
import { WorkflowEngineDispatcher } from "../bridge/workflow-engine-dispatcher.js";
import {
	StateStore,
	type WorkflowDeadExecutionWatchRow,
} from "../StateStore.js";
import { buildWorkflowRunSnapshotV1 } from "../workflow-run-snapshot.js";
import type {
	ShipReadyHandledOutcome,
	WorkflowShipReadyArm,
	WorkflowShipReadyNotice,
} from "../workflow-ship-ready.js";
import {
	isWorkflowManifestV1Land,
	loadBundledWorkflowSeeds,
} from "../workflow-template.js";

const generalizedRecoveryMocks = vi.hoisted(() => ({
	waitForDelivery: vi.fn(),
}));

vi.mock("../bridge/generalized-launch-recovery.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../bridge/generalized-launch-recovery.js")
		>();
	generalizedRecoveryMocks.waitForDelivery.mockImplementation(
		actual.waitForGeneralizedLaunchDelivery,
	);
	return {
		...actual,
		waitForGeneralizedLaunchDelivery: generalizedRecoveryMocks.waitForDelivery,
	};
});

const HEAD = "a".repeat(40);
const WORKFLOW_ON = {
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
};

function shipReadyNotice(
	overrides: Partial<WorkflowShipReadyNotice> = {},
): WorkflowShipReadyNotice {
	return {
		runId: "ship-run-1",
		issueId: "issue-1424",
		issueIdentifier: "FLY-1424",
		projectName: "flywheel",
		templateId: "tpl_eng_heavy",
		gateNodeId: "founder_gate",
		attempt: 1,
		gateOpenedAt: "2026-07-22T01:00:00.000Z",
		sourceExecutionId: "qa-ship-1",
		ageMinutes: 1,
		evidence: { headSha: HEAD, prNumber: 1424, qaPassed: true },
		pending: { lead: true, founder: true },
		...overrides,
	};
}

function shipReadyOnlyStore(input: {
	ready?: () => WorkflowShipReadyNotice[];
	stalled?: (threshold: number) => WorkflowShipReadyNotice[];
}) {
	return {
		listNonTerminalWorkflowSideEffects: vi.fn(() => []),
		listWorkflowShipReadyGates: vi.fn(() => input.ready?.() ?? []),
		listWorkflowShipReadyStalled: vi.fn(
			(options: { remindAfterMs: number }) =>
				input.stalled?.(options.remindAfterMs) ?? [],
		),
		recordWorkflowShipReadyFact: vi.fn(() => ({
			ok: true as const,
			idempotentReplay: false,
		})),
		recordWorkflowShipReadyDeliveryFailure: vi.fn(() => ({
			ok: true as const,
			idempotentReplay: false,
		})),
		recordWorkflowShipReadyHandledObserved: vi.fn(() => ({
			ok: true as const,
			idempotentReplay: false,
		})),
		recordWorkflowShipReadyStalledAlert: vi.fn(() => ({
			ok: true as const,
			idempotentReplay: false,
		})),
	} as unknown as StateStore & {
		listWorkflowShipReadyGates: ReturnType<typeof vi.fn>;
		listWorkflowShipReadyStalled: ReturnType<typeof vi.fn>;
		recordWorkflowShipReadyFact: ReturnType<typeof vi.fn>;
		recordWorkflowShipReadyDeliveryFailure: ReturnType<typeof vi.fn>;
		recordWorkflowShipReadyHandledObserved: ReturnType<typeof vi.fn>;
		recordWorkflowShipReadyStalledAlert: ReturnType<typeof vi.fn>;
	};
}

function inertStartDispatcher(): IStartDispatcher {
	return {
		start: vi.fn(),
		getInflightCount: () => 0,
		validateAgentName: () => ({ ok: true as const }),
	} as unknown as IStartDispatcher;
}

// FLY-1417: the dead-exec sweep's replacement backoff
// (workflow-engine-dispatcher §reconcileDeadExecutions) spaces retries by comparing
// the injected engine clock against workflow_side_effect_ledger.created_at — which
// SQLite fills with `datetime('now')` (the REAL UTC wall clock) at insert time and
// exposes no injectable seam. A hard-coded calendar date for the engine clock is
// therefore a time bomb: once the real wall clock passes it, `now - created_at` goes
// negative, the ladder wrongly holds, and the dead-exec replacement never fires
// (started: 0). Anchor the engine clock to the real clock plus a wide margin (well
// beyond the 15-minute top ladder tier) so the elapsed always clears the ladder,
// deterministically, in any zone or on any calendar day — mirroring the retry-ladder
// test in this file, which already anchors to `Date.now()` for the same reason.
const DEAD_EXEC_ENGINE_CLOCK_MARGIN_MS = 6 * 60 * 60 * 1000; // 6h ≫ 15-min top tier
function deadExecEngineClockBaseMs(): number {
	return Date.now() + DEAD_EXEC_ENGINE_CLOCK_MARGIN_MS;
}

async function storeWithIntent(target: "design" | "implement" | "qa") {
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
		claimsReadEnrolled: true,
		actor: "lead",
		env: WORKFLOW_ON,
		...(target === "design" ? { entryKind: "pipeline_dag_v1" as const } : {}),
		startReservation: {
			idempotencyKey: "engine-start",
			selectionDigest: "selection",
			nodeId: "design",
			attempt: 1,
			executionId: "design-1",
			createdAt: "2026-07-16T00:00:00.000Z",
		},
	});
	if (target === "design") {
		return store;
	}
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

async function storeWithLandIntent() {
	const store = await StateStore.create(":memory:");
	const seed = loadBundledWorkflowSeeds().find(
		(candidate) => candidate.templateId === "tpl_eng_heavy_land_v1",
	)!;
	if (!isWorkflowManifestV1Land(seed.manifest)) {
		throw new Error("land fixture seed is not a land manifest");
	}
	store.createWorkflowRun({
		runId: "run-land",
		issueId: "FLY-1375",
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
		"UPDATE workflow_run SET engine_owned = 1, current_node_id = 'land' WHERE run_id = 'run-land'",
	);
	store.upsertWorkflowRunNode({
		runId: "run-land",
		nodeId: "land",
		attempt: 1,
		state: "pending",
		executionId: "land-exec",
	});
	db.run(
		`INSERT INTO workflow_side_effect_ledger
		   (run_id, node_id, attempt, kind, launch_ordinal, execution_id, state)
		 VALUES ('run-land', 'land', 1, 'dispatch', 1, 'land-exec', 'intent_recorded')`,
	);
	store.upsertSession({
		execution_id: "qa-land",
		issue_id: "FLY-1375",
		project_name: "flywheel",
		status: "awaiting_review",
		pr_number: 1375,
		pr_head_sha: HEAD,
	});
	store.ensureWorkflowGateHolder({
		runId: "run-land",
		gateNodeId: "founder_gate",
		attempt: 1,
		headSha: HEAD,
		sourceExecutionId: "qa-land",
		questionId: "land-question",
		now: "2026-07-21T20:00:00.000Z",
	});
	store.advanceWorkflowGateHolderMaterialization({
		questionId: "land-question",
		stage: "card_bound",
		cardMessageId: "land-card",
		now: "2026-07-21T20:01:00.000Z",
	});
	db.run(
		"UPDATE workflow_gate_holder SET state = 'approved' WHERE question_id = 'land-question'",
	);
	return store;
}

function failRunningDesign(store: StateStore, lastError?: string): void {
	expect(
		store.admitGeneralizedWorkflowExecution({
			runId: "run-1",
			nodeId: "design",
			executionId: "design-1",
			attempt: 1,
			now: "2026-07-16T00:01:00.000Z",
			expiresAt: "2026-07-16T01:01:00.000Z",
			absoluteDeadlineAt: "2026-07-17T00:01:00.000Z",
			env: WORKFLOW_ON,
		}),
	).toMatchObject({ ok: true });
	store.applyWorkflowShadowBatch({
		projectName: "flywheel",
		issueId: "FLY-1307",
		runId: "run-1",
		ops: [
			{
				op: "side_effect",
				node: "design",
				attempt: 1,
				executionId: "design-1",
				to: "started",
			},
		],
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
		status: "failed",
		...(lastError === undefined ? {} : { last_error: lastError }),
	});
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
		...WORKFLOW_ON,
	};
	store.importWorkflowTemplateSeed(seed, env);
	store.materializeWorkflowRun({
		runId: "product-run",
		issueId: "FLY-1307",
		projectName: "flywheel",
		taskCategory: "product",
		templateId: seed.templateId,
		claimsReadEnrolled: true,
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

async function storeWithBundledOutputFirstIntent(input: {
	templateId: "tpl_product_designer" | "tpl_product_prototype";
	runId: string;
}) {
	const store = await StateStore.create(":memory:");
	const canonicalRoot = mkdtempSync(join(tmpdir(), `${input.runId}-agent-`));
	mkdirSync(join(canonicalRoot, "agents"));
	const seed = loadBundledWorkflowSeeds().find(
		(candidate) => candidate.templateId === input.templateId,
	)!;
	const producer = seed.manifest.nodes.find(
		(node) => node.type === "generic" && node.produces_output === true,
	)!;
	if (!producer.agent_file) throw new Error("output producer agent missing");
	writeFileSync(
		join(canonicalRoot, producer.agent_file),
		"Produce a pinned docs_v1 artifact.\n",
	);
	const env = { ...WORKFLOW_ON };
	store.importWorkflowTemplateSeed(seed, env);
	store.materializeWorkflowRun({
		runId: input.runId,
		issueId: "FLY-1380",
		projectName: "flywheel",
		taskCategory: input.templateId,
		templateId: seed.templateId,
		claimsReadEnrolled: true,
		actor: "lead",
		canonicalRoot,
		env,
		startReservation: {
			idempotencyKey: `${input.runId}-start`,
			selectionDigest: `${input.runId}-selection`,
			nodeId: producer.id,
			attempt: 1,
			executionId: `${input.runId}-produce-1`,
			createdAt: "2026-07-22T00:00:00.000Z",
		},
	});
	return {
		store,
		canonicalRoot,
		env,
		producer,
		review: seed.manifest.nodes.find((node) => node.type === "review")!,
	};
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

function seedCompletedKickbackHusk(
	store: StateStore,
	input: {
		nodeId: string;
		executionId: string;
		attempt: number;
		route: string;
	},
): void {
	const db = (
		store as unknown as {
			db: { run(sql: string, params?: unknown[]): void };
		}
	).db;
	seedWorkflowBinding(store, {
		nodeId: input.nodeId,
		executionId: input.executionId,
		attempt: input.attempt,
	});
	db.run(
		`INSERT INTO workflow_node_completion
		   (activation_id, run_id, node_id, attempt, execution_id, route, event_uid,
		    source_event_id, completion_submission_digest, completed_at)
		 VALUES (?, 'run-1', ?, ?, ?, ?, ?, ?, ?, '2026-07-16T00:09:00.000Z')`,
		[
			`activation:${input.executionId}:run-1:${input.nodeId}:${input.attempt}`,
			input.nodeId,
			input.attempt,
			input.executionId,
			input.route,
			`wfc:run-1:${input.nodeId}:${input.attempt}`,
			`complete:${input.executionId}`,
			`digest:${input.executionId}`,
		],
	);
}

function seedWorkflowBinding(
	store: StateStore,
	input: { nodeId: string; executionId: string; attempt: number },
): void {
	const db = (
		store as unknown as {
			db: { run(sql: string, params?: unknown[]): void };
		}
	).db;
	db.run(
		`INSERT OR IGNORE INTO workflow_actor
		   (execution_id, project_name, issue_id, role, created_at)
		 VALUES (?, 'flywheel', 'FLY-1307', ?, '2026-07-16T00:06:00.000Z')`,
		[input.executionId, input.nodeId],
	);
	db.run(
		`INSERT INTO workflow_execution_binding
		   (activation_id, execution_id, run_id, node_id, attempt, mode,
		    rework_request_id, bound_at)
		 VALUES (?, ?, 'run-1', ?, ?, 'spawn', NULL,
		         '2026-07-16T00:06:00.000Z')`,
		[
			`activation:${input.executionId}:run-1:${input.nodeId}:${input.attempt}`,
			input.executionId,
			input.nodeId,
			input.attempt,
		],
	);
}

async function storeWithQaFailKickback() {
	const store = await storeWithIntent("qa");
	seedCompletedKickbackHusk(store, {
		nodeId: "implement",
		executionId: "implement-1",
		attempt: 1,
		route: "needs_review",
	});
	store.upsertSession({
		execution_id: "implement-1",
		issue_id: "FLY-1307",
		project_name: "flywheel",
		status: "completed",
		session_role: "implement",
	});
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
		session_role: "qa",
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
			subjectDigest: HEAD,
			successorExecutionId: "implement-fix-1",
			now: "2026-07-16T00:15:00.000Z",
		}),
	).toMatchObject({ ok: true, loopIteration: 1 });
	return store;
}

describe("WorkflowEngineDispatcher", () => {
	it("executes an engine-owned land node and terminalizes the run from its durable receipt", async () => {
		const store = await storeWithLandIntent();
		const landExecutor = vi.fn(async (operationId: string) => {
			const claim = store.claimLandOperation({
				operationId,
				ownerId: "land-test-worker",
				now: "2026-07-21T20:02:00.000Z",
				leaseExpiresAt: "2026-07-21T20:03:00.000Z",
			});
			if (!claim) throw new Error("land operation was not claimable");
			const completed = store.recordLandOperationStep({
				operationId,
				ownerId: claim.ownerId,
				generation: claim.generation,
				step: "finalization_completed",
				receipt: { complete: true },
				now: "2026-07-21T20:02:01.000Z",
			});
			if (!completed.ok) throw new Error(completed.reason);
			return { status: "completed" as const };
		});
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fakeStartDispatcher(store).dispatcher,
			env: WORKFLOW_ON,
			now: () => new Date("2026-07-21T20:02:00.000Z"),
			landExecutor,
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(landExecutor).toHaveBeenCalledOnce();
		expect(store.getWorkflowRun("run-land")?.status).toBe("completed");
		expect(store.getWorkflowRunNode("run-land", "land", 1)?.state).toBe("done");
		expect(store.listWorkflowSideEffects("run-land")[0]?.state).toBe("started");
		store.close();
	});

	it("continues an activated land operation after the land flag is disabled", async () => {
		const store = await storeWithLandIntent();
		const operation = store.ensureLandOperation({
			runId: "run-land",
			issueId: "FLY-1375",
			projectName: "flywheel",
			prNumber: 1375,
			approvedHead: HEAD,
			now: "2026-07-21T20:01:30.000Z",
		});
		const landExecutor = vi.fn(async (operationId: string) => {
			expect(operationId).toBe(operation.operation_id);
			const claim = store.claimLandOperation({
				operationId,
				ownerId: "land-test-worker",
				now: "2026-07-21T20:02:00.000Z",
				leaseExpiresAt: "2026-07-21T20:03:00.000Z",
			});
			if (!claim) throw new Error("land operation was not claimable");
			const completed = store.recordLandOperationStep({
				operationId,
				ownerId: claim.ownerId,
				generation: claim.generation,
				step: "finalization_completed",
				receipt: { complete: true },
				now: "2026-07-21T20:02:01.000Z",
			});
			if (!completed.ok) throw new Error(completed.reason);
			return { status: "completed" as const };
		});
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fakeStartDispatcher(store).dispatcher,
			env: { ...WORKFLOW_ON, FLYWHEEL_LAND_NODE: "0" },
			now: () => new Date("2026-07-21T20:02:00.000Z"),
			landExecutor,
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(landExecutor).toHaveBeenCalledOnce();
		expect(store.getWorkflowRun("run-land")?.status).toBe("completed");
		store.close();
	});

	it("holds an unactivated land node when the land flag is disabled", async () => {
		const store = await storeWithLandIntent();
		const landExecutor = vi.fn();
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fakeStartDispatcher(store).dispatcher,
			env: { ...WORKFLOW_ON, FLYWHEEL_LAND_NODE: "0" },
			now: () => new Date("2026-07-21T20:02:00.000Z"),
			landExecutor,
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 1 });
		expect(landExecutor).not.toHaveBeenCalled();
		expect(store.getWorkflowRun("run-land")?.status).toBe("held");
		expect(store.getLandOperationForRun("run-land")).toBeUndefined();
		store.close();
	});

	it("durably escalates a post-merge cleanup partial without holding the run", async () => {
		const store = await storeWithLandIntent();
		const landExecutor = vi.fn(async (operationId: string) => {
			const claim = store.claimLandOperation({
				operationId,
				ownerId: "land-test-worker",
				now: "2026-07-21T20:02:00.000Z",
				leaseExpiresAt: "2026-07-21T20:03:00.000Z",
			});
			if (!claim) throw new Error("land operation was not claimable");
			store.setLandOperationDisposition({
				operationId,
				ownerId: claim.ownerId,
				generation: claim.generation,
				state: "partial",
				error: "issue_closeout_incomplete",
				now: "2026-07-21T20:02:01.000Z",
			});
			return {
				status: "partial" as const,
				reason: "issue_closeout_incomplete",
			};
		});
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fakeStartDispatcher(store).dispatcher,
			env: WORKFLOW_ON,
			now: () => new Date("2026-07-21T20:02:02.000Z"),
			landExecutor,
			resolveRunAlertIdentity: (projectName) => ({
				leadId: "flywheel-eng-lead",
				projectName,
				leadResolution: "resolved",
			}),
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 1 });
		expect(store.getWorkflowRun("run-land")?.status).toBe("active");
		const partial = store
			.listWorkflowRunEvents("run-land")
			.find((event) => event.kind === "land_partial");
		expect(partial).toBeDefined();
		expect(store.getWorkflowAlertOutbox(partial!.event_uid)).toMatchObject({
			state: "pending",
			run_id: "run-land",
		});
		store.close();
	});

	it.each([
		["v1", "FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH"],
		["v1", "FLYWHEEL_WORKFLOW_CLAIMS_WRITE"],
		["v1", "FLYWHEEL_WORKFLOW_CLAIMS_READ"],
		["v2", "FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH"],
		["v2", "FLYWHEEL_WORKFLOW_CLAIMS_WRITE"],
		["v2", "FLYWHEEL_WORKFLOW_CLAIMS_READ"],
		["v2", "FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES"],
	] as const)(
		"holds an existing %s engine successor without mutating it when %s is removed",
		async (schema, missing) => {
			const fixture =
				schema === "v1"
					? {
							store: await storeWithIntent("implement"),
							canonicalRoot: undefined,
						}
					: await storeWithProductOutputIntent();
			const { store } = fixture;
			const intent = store.listNonTerminalWorkflowSideEffects()[0]!;
			store.upsertSession({
				execution_id: intent.execution_id,
				issue_id: "FLY-1307",
				project_name: "flywheel",
				status: "running",
			});
			const env = { ...WORKFLOW_ON };
			delete env[missing];
			const start = vi.fn();
			const dispatcher = new WorkflowEngineDispatcher({
				store,
				startDispatcher: {
					start,
					getInflightCount: () => 0,
					validateAgentName: () => ({ ok: true as const }),
				} as unknown as IStartDispatcher,
				env,
			});

			expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 1 });
			expect(start).not.toHaveBeenCalled();
			expect(store.listNonTerminalWorkflowSideEffects()[0]).toMatchObject({
				state: "intent_recorded",
			});
			store.close();
			if (fixture.canonicalRoot) {
				rmSync(fixture.canonicalRoot, { recursive: true, force: true });
			}
		},
	);

	it("reuses one launch owner so a transient start failure retries without a 60-minute self-fence", async () => {
		const store = await storeWithIntent("implement");
		let attempts = 0;
		const start = vi.fn(async (request: StartRequest) => {
			attempts += 1;
			if (attempts === 1) throw new Error("transient spawn failure");
			const committed = request.generalizedExecution?.commitWorkflowLaunch?.();
			if (!committed?.ok) throw new Error(committed?.reason ?? "not_committed");
			store.upsertSession({
				execution_id: request.generalizedExecution!.executionId,
				issue_id: request.issueId,
				project_name: request.projectName,
				status: "running",
				session_role: request.sessionRole,
			});
			return {
				executionId: request.generalizedExecution!.executionId,
				issueId: request.issueId,
			};
		});
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: {
				start,
				getInflightCount: () => 0,
				validateAgentName: () => ({ ok: true as const }),
			} as IStartDispatcher,
			env: WORKFLOW_ON,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1307-stable-owner-")),
			now: () => new Date("2026-07-16T00:06:00.000Z"),
			resolvePredecessorHead: async () => HEAD,
		});
		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 1 });
		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(start).toHaveBeenCalledTimes(2);
		store.close();
	});

	// FLY-1385 QA: the retry ladder's spacing, not just its cap.
	//
	// The backoff reads workflow_side_effect_ledger.created_at, which SQLite fills
	// with `datetime('now')` — a UTC instant rendered as "YYYY-MM-DD HH:MM:SS" with
	// no zone marker. Date.parse treats that shape as LOCAL time, so on a host west
	// of UTC every launch looks like it happened hours in the future and the elapsed
	// time goes negative, blocking the retry for the length of the UTC offset. CI
	// runs in UTC where the offset is zero, so the pin below is what makes this
	// assertion mean anything off the developer's machine.
	//
	// Anchor every clock to the real wall clock: created_at is written by SQLite at
	// insert time and ignores the injected `now`.
	it("spaces replacement launches by the 1/5-minute retry ladder in a non-UTC zone", async () => {
		const originalTz = process.env.TZ;
		// The production Bridge host runs in this zone.
		process.env.TZ = "America/Los_Angeles";
		try {
			const store = await storeWithIntent("implement");
			const fake = fakeStartDispatcher(store);
			const launchedAt = Date.now();
			let now = new Date(launchedAt);
			const dispatcher = new WorkflowEngineDispatcher({
				store,
				startDispatcher: fake.dispatcher,
				stateRoot: mkdtempSync(join(tmpdir(), "fly1385-backoff-")),
				env: WORKFLOW_ON,
				now: () => now,
				resolvePredecessorHead: async () => HEAD,
				probeLaunchLiveness: async () => "dead",
			});
			const at = (ms: number) => {
				now = new Date(launchedAt + ms);
			};
			const killCurrent = () => {
				const node = store.getWorkflowRunNode("run-1", "implement", 1)!;
				store.upsertSession({
					execution_id: node.execution_id!,
					issue_id: "FLY-1307",
					project_name: "flywheel",
					status: "failed",
					workflow_node_id: "implement",
				});
			};

			expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
			expect(fake.requests).toHaveLength(1);

			// Tier 1 = 1 minute after launch 1.
			killCurrent();
			at(30_000);
			await dispatcher.reconcile();
			expect(fake.requests).toHaveLength(1);

			at(61_000);
			await dispatcher.reconcile();
			expect(fake.requests).toHaveLength(2);

			// Tier 2 = 5 minutes, proving the ladder steps forward instead of
			// reusing the first delay.
			killCurrent();
			at(61_000 + 120_000);
			await dispatcher.reconcile();
			expect(fake.requests).toHaveLength(2);

			at(61_000 + 302_000);
			await dispatcher.reconcile();
			expect(fake.requests).toHaveLength(3);

			// Every wait was a hold, never a silent drop: the node still belongs to a
			// live replacement and the run is untouched.
			expect(store.getWorkflowRun("run-1")?.status).toBe("active");
			expect(store.getWorkflowRunNode("run-1", "implement", 1)).toMatchObject({
				state: "running",
				execution_id: fake.requests[2]?.successorExecutionId,
			});
			store.close();
		} finally {
			if (originalTz === undefined) delete process.env.TZ;
			else process.env.TZ = originalTz;
		}
	});

	it("attaches rejection containment to initial and periodic reconciles", async () => {
		vi.useFakeTimers();
		const store = {
			listNonTerminalWorkflowSideEffects: () => [],
		} as unknown as StateStore;
		const startDispatcher = {
			start: vi.fn(),
			getInflightCount: () => 0,
			validateAgentName: () => ({ ok: true as const }),
		} as unknown as IStartDispatcher;
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher,
		});
		const catchRejection = vi.fn(() => Promise.resolve());
		vi.spyOn(dispatcher, "reconcile").mockReturnValue({
			catch: catchRejection,
		} as unknown as Promise<{ started: number; held: number }>);

		try {
			dispatcher.start(1_000);
			expect(catchRejection).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1_000);
			expect(catchRejection).toHaveBeenCalledTimes(2);
		} finally {
			dispatcher.stop();
			vi.useRealTimers();
		}
	});

	it("contains top-level store read failures", async () => {
		const store = {
			listWorkflowReworkDeliveries: () => [],
			listNonTerminalWorkflowSideEffects: () => {
				throw new Error("database unavailable");
			},
		} as unknown as StateStore;
		const log = vi.fn();
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: {
				start: vi.fn(),
				getInflightCount: () => 0,
				validateAgentName: () => ({ ok: true as const }),
			} as unknown as IStartDispatcher,
			log,
		});

		await expect(dispatcher.reconcile()).resolves.toEqual({
			started: 0,
			held: 0,
		});
		expect(log).toHaveBeenCalledWith(
			"workflow engine reconcile failed: database unavailable",
		);
	});

	it("consumes a durable successor intent exactly once with pinned dispatch", async () => {
		const store = await storeWithIntent("implement");
		const fake = fakeStartDispatcher(store);
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1307-engine-dispatch-")),
			env: WORKFLOW_ON,
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

	it("closes a delivery wait-boundary race with one final durable owner read", async () => {
		const store = await storeWithIntent("implement");
		const fake = fakeStartDispatcher(store);
		generalizedRecoveryMocks.waitForDelivery.mockResolvedValueOnce(undefined);
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1336-engine-boundary-")),
			env: WORKFLOW_ON,
			resolvePredecessorHead: async () => HEAD,
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(fake.start).toHaveBeenCalledOnce();
		expect(store.listWorkflowSideEffects("run-1")[0]?.state).toBe("started");
		store.close();
	});

	it("keeps a foreign live launch owner held without dispatch", async () => {
		const store = await storeWithIntent("implement");
		expect(
			store.admitGeneralizedWorkflowExecution({
				runId: "run-1",
				nodeId: "implement",
				executionId: "implement-1",
				attempt: 1,
				now: "2026-07-16T00:06:00.000Z",
				expiresAt: "2026-07-16T00:20:00.000Z",
				absoluteDeadlineAt: "2026-07-16T01:00:00.000Z",
				env: WORKFLOW_ON,
			}),
		).toMatchObject({ ok: true });
		const stateRoot = mkdtempSync(join(tmpdir(), "fly1336-engine-busy-"));
		expect(
			store.recoverOrAcquireWorkflowLaunch({
				executionId: "implement-1",
				ownerId: "foreign-live-owner",
				now: "2026-07-16T00:06:00.000Z",
				leaseExpiresAt: "2026-07-16T00:30:00.000Z",
				markerPath: join(stateRoot, "implement-1"),
			}).status,
		).toBe("acquired");
		const start = vi.fn();
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: {
				start,
				getInflightCount: () => 0,
				validateAgentName: () => ({ ok: true as const }),
			} as IStartDispatcher,
			stateRoot,
			env: WORKFLOW_ON,
			now: () => new Date("2026-07-16T00:07:00.000Z"),
			resolvePredecessorHead: async () => HEAD,
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 1 });
		expect(start).not.toHaveBeenCalled();
		store.close();
	});

	it("does not repair a committed launch without positive dead evidence", async () => {
		const store = await storeWithIntent("implement");
		expect(
			store.admitGeneralizedWorkflowExecution({
				runId: "run-1",
				nodeId: "implement",
				executionId: "implement-1",
				attempt: 1,
				now: "2026-07-16T00:06:00.000Z",
				expiresAt: "2026-07-16T00:20:00.000Z",
				absoluteDeadlineAt: "2026-07-16T01:00:00.000Z",
				env: WORKFLOW_ON,
			}),
		).toMatchObject({ ok: true });
		const stateRoot = mkdtempSync(join(tmpdir(), "fly1336-engine-unknown-"));
		const launch = store.recoverOrAcquireWorkflowLaunch({
			executionId: "implement-1",
			ownerId: "completed-owner",
			now: "2026-07-16T00:06:00.000Z",
			leaseExpiresAt: "2026-07-16T00:30:00.000Z",
			markerPath: join(stateRoot, "implement-1"),
		});
		if (launch.status !== "acquired") throw new Error("launch not acquired");
		expect(
			store.fencedCommitWorkflowLaunch({
				executionId: "implement-1",
				ownerId: "completed-owner",
				generation: launch.generation,
				deliveryAttempt: launch.deliveryAttempt,
				markerPath: join(stateRoot, "implement-1"),
				now: "2026-07-16T00:06:30.000Z",
			}),
		).toMatchObject({ ok: true });
		const start = vi.fn();
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: {
				start,
				getInflightCount: () => 0,
				validateAgentName: () => ({ ok: true as const }),
			} as IStartDispatcher,
			stateRoot,
			env: WORKFLOW_ON,
			now: () => new Date("2026-07-16T00:07:00.000Z"),
			resolvePredecessorHead: async () => HEAD,
			probeLaunchLiveness: async () => "unknown",
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 1 });
		expect(start).not.toHaveBeenCalled();
		store.close();
	});

	it("hands QA rework to the coordinator without closing or spawning the healthy actor", async () => {
		const store = await storeWithQaFailKickback();
		const fake = fakeStartDispatcher(store);
		const reconcileWorkflowRework = vi.fn(async () => ({
			kind: "wake_delivered" as const,
			executionId: "implement-1",
			activationId: "activation:rework-1",
			epoch: 2,
		}));
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1423-same-actor-")),
			env: WORKFLOW_ON,
			reconcileWorkflowRework,
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 0 });
		expect(reconcileWorkflowRework).toHaveBeenCalledOnce();
		expect(reconcileWorkflowRework).toHaveBeenCalledWith(
			expect.stringMatching(/^rework:/),
		);
		expect(fake.start).not.toHaveBeenCalled();
		expect(
			store
				.listWorkflowSideEffects("run-1")
				.filter((row) => row.node_id === "implement" && row.attempt === 2),
		).toHaveLength(0);
		store.close();
	});

	it("mints a fresh launch only after the coordinator proves the actor dead", async () => {
		const store = await storeWithQaFailKickback();
		const fake = fakeStartDispatcher(store);
		const reconcileWorkflowRework = vi.fn(async (requestId: string) => {
			const db = (
				store as unknown as {
					db: { run(sql: string, params?: unknown[]): void };
				}
			).db;
			db.run(
				"UPDATE workflow_rework_delivery SET state = 'replacement_pending' WHERE request_id = ?",
				[requestId],
			);
			return {
				kind: "replacement_pending" as const,
				executionId: "implement-1",
				reason: "persisted_target_dead",
			};
		});
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1423-dead-replacement-")),
			env: WORKFLOW_ON,
			now: () => new Date("2026-07-16T00:16:00.000Z"),
			resolvePredecessorHead: async () => HEAD,
			reconcileWorkflowRework,
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(fake.start).toHaveBeenCalledOnce();
		const launched = fake.requests[0]?.generalizedExecution?.executionId;
		expect(launched).toEqual(expect.any(String));
		expect(launched).not.toBe("implement-1");
		expect(store.getWorkflowRunNode("run-1", "implement", 2)).toMatchObject({
			state: "running",
			execution_id: launched,
		});
		const requestId = reconcileWorkflowRework.mock.calls[0]?.[0];
		expect(store.getWorkflowReworkDelivery(requestId!)).toMatchObject({
			state: "wake_delivered",
		});
		store.close();
	});

	it("fences and rolls back a proven-dead replacement that never launches", async () => {
		const store = await storeWithQaFailKickback();
		const start = vi.fn(async () => {
			throw new Error("synthetic replacement prelaunch failure");
		});
		const startDispatcher = {
			start,
			getInflightCount: () => 0,
			validateAgentName: () => ({ ok: true as const }),
		} as IStartDispatcher;
		const reconcileWorkflowRework = vi.fn(async (requestId: string) => {
			const db = (
				store as unknown as {
					db: { run(sql: string, params?: unknown[]): void };
				}
			).db;
			db.run(
				"UPDATE workflow_rework_delivery SET state = 'replacement_pending' WHERE request_id = ?",
				[requestId],
			);
			return {
				kind: "replacement_pending" as const,
				executionId: "implement-1",
				reason: "persisted_target_dead",
			};
		});
		const stateRoot = mkdtempSync(join(tmpdir(), "fly1423-replacement-fail-"));
		const env = {
			...WORKFLOW_ON,
			FLYWHEEL_ENGINE_UNLAUNCHED_ALERT_MS: "1000",
			FLYWHEEL_ENGINE_UNLAUNCHED_ROLLBACK_MS: "2000",
		};
		const first = new WorkflowEngineDispatcher({
			store,
			startDispatcher,
			stateRoot,
			env,
			now: () => new Date("2026-07-16T00:16:00.000Z"),
			resolvePredecessorHead: async () => HEAD,
			reconcileWorkflowRework,
			probeUnlaunchedExternalEvidence: async () => "absent",
			resolveRunAlertIdentity: () => ({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			}),
		});
		expect(await first.reconcile()).toEqual({ started: 0, held: 1 });
		const replacement = store.getWorkflowRunNode(
			"run-1",
			"implement",
			2,
		)?.execution_id;
		expect(replacement).toEqual(expect.any(String));
		expect(store.getSession(replacement!)).toBeUndefined();
		expect(store.getWorkflowRunNode("run-1", "implement", 2)).toMatchObject({
			state: "admitted",
		});
		const replacementBinding = store.getWorkflowExecutionBinding(replacement!);
		expect(replacementBinding).toMatchObject({
			mode: "replacement",
		});
		expect(store.getWorkflowLaunchOwner(replacement!)).toMatchObject({
			lease_expires_at: "2026-07-16T01:16:00.000Z",
		});
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.find(
					(event) =>
						event.event_uid ===
						`workflow_activation_admitted:${replacementBinding!.activation_id}`,
				),
		).toMatchObject({ payload: { at: "2026-07-16T00:16:00.000Z" } });

		const recovered = new WorkflowEngineDispatcher({
			store,
			startDispatcher,
			stateRoot,
			env,
			now: () => new Date("2026-07-16T01:17:00.000Z"),
			resolvePredecessorHead: async () => HEAD,
			probeUnlaunchedExternalEvidence: async () => "absent",
			resolveRunAlertIdentity: () => ({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			}),
		});
		expect(await recovered.reconcile()).toEqual({ started: 0, held: 0 });
		expect(store.getWorkflowRun("run-1")?.status).toBe("held");
		expect(store.getWorkflowLaunchCancellation(replacement!)).toBeDefined();
		expect(
			store
				.listWorkflowSideEffects("run-1")
				.find((row) => row.execution_id === replacement),
		).toMatchObject({ state: "abandoned" });
		expect(store.listWorkflowAlertOutbox().length).toBeGreaterThanOrEqual(2);
		const requestId = reconcileWorkflowRework.mock.calls[0]?.[0];
		expect(store.getWorkflowReworkDelivery(requestId!)).toMatchObject({
			state: "held",
		});
		store.close();
	});

	it("durably alerts then holds a stalled rework activation without spawning", async () => {
		const store = await storeWithQaFailKickback();
		const fake = fakeStartDispatcher(store);
		const env = {
			...WORKFLOW_ON,
			FLYWHEEL_ENGINE_UNLAUNCHED_ALERT_MS: "1000",
			FLYWHEEL_ENGINE_UNLAUNCHED_ROLLBACK_MS: "2000",
		};
		const reconcileWorkflowRework = vi.fn(async () => ({
			kind: "busy" as const,
		}));
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			env,
			now: () => new Date("2026-07-16T00:20:00.000Z"),
			reconcileWorkflowRework,
			resolveRunAlertIdentity: () => ({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			}),
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 0 });
		expect(store.getWorkflowRun("run-1")?.status).toBe("held");
		expect(fake.start).not.toHaveBeenCalled();
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "rework_activation_stalled_alerted"),
		).toHaveLength(1);
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "rework_activation_stalled_held"),
		).toHaveLength(1);
		store.close();
	});

	it("rolls back an admitted ghost only after the owner lease expires and external evidence stays absent", async () => {
		const store = await storeWithIntent("implement");
		const start = vi.fn(async () => {
			throw new Error("synthetic prelaunch failure");
		});
		const stateRoot = mkdtempSync(join(tmpdir(), "fly1423-admitted-ghost-"));
		const initial = new WorkflowEngineDispatcher({
			store,
			startDispatcher: {
				start,
				getInflightCount: () => 0,
				validateAgentName: () => ({ ok: true as const }),
			} as IStartDispatcher,
			stateRoot,
			env: {
				...WORKFLOW_ON,
				FLYWHEEL_ENGINE_UNLAUNCHED_ALERT_MS: "1000",
				FLYWHEEL_ENGINE_UNLAUNCHED_ROLLBACK_MS: "2000",
			},
			now: () => new Date("2026-07-16T00:07:00.000Z"),
			resolvePredecessorHead: async () => HEAD,
			probeUnlaunchedExternalEvidence: async () => "absent",
		});
		expect(await initial.reconcile()).toEqual({ started: 0, held: 1 });
		expect(store.getWorkflowRunNode("run-1", "implement", 1)).toMatchObject({
			state: "admitted",
			execution_id: "implement-1",
		});

		const afterExpiry = new WorkflowEngineDispatcher({
			store,
			startDispatcher: {
				start,
				getInflightCount: () => 0,
				validateAgentName: () => ({ ok: true as const }),
			} as IStartDispatcher,
			stateRoot,
			env: {
				...WORKFLOW_ON,
				FLYWHEEL_ENGINE_UNLAUNCHED_ALERT_MS: "1000",
				FLYWHEEL_ENGINE_UNLAUNCHED_ROLLBACK_MS: "2000",
			},
			now: () => new Date("2026-07-16T01:08:00.000Z"),
			resolvePredecessorHead: async () => HEAD,
			probeUnlaunchedExternalEvidence: async () => "absent",
			resolveRunAlertIdentity: () => ({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			}),
		});
		expect(await afterExpiry.reconcile()).toEqual({ started: 0, held: 0 });
		expect(store.getWorkflowRun("run-1")?.status).toBe("held");
		expect(store.listWorkflowSideEffects("run-1")[0]).toMatchObject({
			state: "abandoned",
		});
		expect(store.getSession("implement-1")).toBeUndefined();
		expect(store.getWorkflowLaunchCancellation("implement-1")).toBeDefined();
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "unlaunched_admission_rolled_back"),
		).toHaveLength(1);
		store.close();
	});

	it("holds without rollback when external launch evidence is present at the hard TTL", async () => {
		const store = await storeWithIntent("implement");
		const start = vi.fn(async () => {
			throw new Error("synthetic prelaunch failure");
		});
		const stateRoot = mkdtempSync(join(tmpdir(), "fly1423-admitted-present-"));
		const common = {
			store,
			startDispatcher: {
				start,
				getInflightCount: () => 0,
				validateAgentName: () => ({ ok: true as const }),
			} as IStartDispatcher,
			stateRoot,
			env: {
				...WORKFLOW_ON,
				FLYWHEEL_ENGINE_UNLAUNCHED_ALERT_MS: "1000",
				FLYWHEEL_ENGINE_UNLAUNCHED_ROLLBACK_MS: "2000",
			},
			resolvePredecessorHead: async () => HEAD,
			resolveRunAlertIdentity: () => ({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved" as const,
			}),
		};
		expect(
			await new WorkflowEngineDispatcher({
				...common,
				now: () => new Date("2026-07-16T00:07:00.000Z"),
				probeUnlaunchedExternalEvidence: async () => "present",
			}).reconcile(),
		).toEqual({ started: 0, held: 1 });
		expect(
			await new WorkflowEngineDispatcher({
				...common,
				now: () => new Date("2026-07-16T01:08:00.000Z"),
				probeUnlaunchedExternalEvidence: async () => "present",
			}).reconcile(),
		).toEqual({ started: 0, held: 0 });
		expect(store.getWorkflowRun("run-1")?.status).toBe("held");
		expect(store.listWorkflowSideEffects("run-1")[0]?.state).toBe(
			"intent_recorded",
		);
		expect(store.getWorkflowLaunchCancellation("implement-1")).toBeUndefined();
		store.close();
	});

	it("reads the unlaunched tripwire switch on every reconcile", async () => {
		const store = await storeWithIntent("implement");
		const start = vi.fn(async () => {
			throw new Error("synthetic prelaunch failure");
		});
		const env = {
			...WORKFLOW_ON,
			FLYWHEEL_ENGINE_UNLAUNCHED_TRIPWIRE: "0",
			FLYWHEEL_ENGINE_UNLAUNCHED_ALERT_MS: "1000",
			FLYWHEEL_ENGINE_UNLAUNCHED_ROLLBACK_MS: "2000",
		};
		const now = vi.fn(() => new Date("2026-07-16T00:16:00.000Z"));
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: {
				start,
				getInflightCount: () => 0,
				validateAgentName: () => ({ ok: true as const }),
			} as IStartDispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1423-tripwire-switch-")),
			env,
			now,
			resolvePredecessorHead: async () => HEAD,
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 1 });
		now.mockReturnValue(new Date("2026-07-16T00:30:00.000Z"));
		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 1 });
		expect(store.getWorkflowRun("run-1")?.status).toBe("active");
		expect(store.listWorkflowAlertOutbox()).toHaveLength(0);

		env.FLYWHEEL_ENGINE_UNLAUNCHED_TRIPWIRE = "1";
		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 0 });
		expect(store.getWorkflowRun("run-1")?.status).toBe("held");
		expect(store.listWorkflowAlertOutbox()).toHaveLength(2);
		store.close();
	});

	it("keeps the cancellation fence and refuses rollback when evidence appears after fencing", async () => {
		const store = await storeWithIntent("implement");
		const start = vi.fn(async () => {
			throw new Error("synthetic prelaunch failure");
		});
		const startDispatcher = {
			start,
			getInflightCount: () => 0,
			validateAgentName: () => ({ ok: true as const }),
		} as IStartDispatcher;
		const stateRoot = mkdtempSync(join(tmpdir(), "fly1423-post-fence-race-"));
		const env = {
			...WORKFLOW_ON,
			FLYWHEEL_ENGINE_UNLAUNCHED_ALERT_MS: "1000",
			FLYWHEEL_ENGINE_UNLAUNCHED_ROLLBACK_MS: "2000",
		};
		expect(
			await new WorkflowEngineDispatcher({
				store,
				startDispatcher,
				stateRoot,
				env,
				now: () => new Date("2026-07-16T00:07:00.000Z"),
				resolvePredecessorHead: async () => HEAD,
				probeUnlaunchedExternalEvidence: async () => "absent",
			}).reconcile(),
		).toEqual({ started: 0, held: 1 });
		const probe = vi
			.fn<() => Promise<"absent" | "present">>()
			.mockResolvedValueOnce("absent")
			.mockResolvedValueOnce("present");

		expect(
			await new WorkflowEngineDispatcher({
				store,
				startDispatcher,
				stateRoot,
				env,
				now: () => new Date("2026-07-16T01:08:00.000Z"),
				resolvePredecessorHead: async () => HEAD,
				probeUnlaunchedExternalEvidence: probe,
			}).reconcile(),
		).toEqual({ started: 0, held: 0 });
		expect(probe).toHaveBeenCalledTimes(2);
		expect(store.getWorkflowRun("run-1")?.status).toBe("held");
		expect(store.getWorkflowLaunchCancellation("implement-1")).toBeDefined();
		expect(store.listWorkflowSideEffects("run-1")[0]?.state).toBe(
			"intent_recorded",
		);
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.some((event) => event.kind === "unlaunched_admission_rolled_back"),
		).toBe(false);
		store.close();
	});

	it("delivers a scoped decision credential to an engine-produced QA node", async () => {
		const store = await storeWithIntent("qa");
		const fake = fakeStartDispatcher(store);
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1307-engine-qa-")),
			env: WORKFLOW_ON,
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
			env: WORKFLOW_ON,
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
			env: WORKFLOW_ON,
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
			env: WORKFLOW_ON,
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
			env: WORKFLOW_ON,
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
			env: WORKFLOW_ON,
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

	it("replaces a started execution whose terminal session and liveness prove it dead", async () => {
		const store = await storeWithIntent("implement");
		const fake = fakeStartDispatcher(store);
		const base = deadExecEngineClockBaseMs();
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1385-dead-sweep-")),
			env: WORKFLOW_ON,
			now: () => new Date(base),
			resolvePredecessorHead: async () => HEAD,
			probeLaunchLiveness: async () => "dead",
		});
		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(fake.requests).toHaveLength(1);
		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "failed",
			workflow_node_id: "implement",
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(fake.requests).toHaveLength(2);
		expect(fake.requests[1]?.successorExecutionId).not.toBe("implement-1");
		expect(store.getWorkflowRunNode("run-1", "implement", 1)).toMatchObject({
			state: "running",
			execution_id: fake.requests[1]?.successorExecutionId,
		});
		expect(store.listWorkflowSideEffects("run-1")).toHaveLength(2);
		store.close();
	});

	it.each(["working", "awaiting_review"])(
		"never probes or replaces a slow live runner in %s",
		async (status) => {
			const store = await storeWithIntent("implement");
			const fake = fakeStartDispatcher(store);
			const probeLaunchLiveness = vi.fn(async () => "dead" as const);
			const dispatcher = new WorkflowEngineDispatcher({
				store,
				startDispatcher: fake.dispatcher,
				stateRoot: mkdtempSync(join(tmpdir(), "fly1415-live-runner-")),
				env: WORKFLOW_ON,
				now: () => new Date("2099-07-22T00:00:00.000Z"),
				resolvePredecessorHead: async () => HEAD,
				probeLaunchLiveness,
			});
			expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
			probeLaunchLiveness.mockClear();
			store.upsertSession({
				execution_id: "implement-1",
				issue_id: "FLY-1307",
				project_name: "flywheel",
				status,
				workflow_node_id: "implement",
			});

			expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 0 });
			expect(probeLaunchLiveness).not.toHaveBeenCalled();
			expect(fake.requests).toHaveLength(1);
			expect(store.getWorkflowRunNode("run-1", "implement", 1)).toMatchObject({
				state: "running",
				execution_id: "implement-1",
			});
			store.close();
		},
	);

	it("does not replace a terminal session while any runner pane remains alive", async () => {
		const store = await storeWithIntent("implement");
		const fake = fakeStartDispatcher(store);
		const probeLaunchLiveness = vi.fn(async () => "alive" as const);
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1415-live-pane-")),
			env: WORKFLOW_ON,
			now: () => new Date("2099-07-22T00:00:00.000Z"),
			resolvePredecessorHead: async () => HEAD,
			probeLaunchLiveness,
		});
		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "failed",
			workflow_node_id: "implement",
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 0 });
		expect(probeLaunchLiveness).toHaveBeenCalledOnce();
		expect(fake.requests).toHaveLength(1);
		expect(store.getWorkflowRunNode("run-1", "implement", 1)).toMatchObject({
			state: "running",
			execution_id: "implement-1",
		});
		store.close();
	});

	it("observes the dead-exec sweep kill switch on every tick without a restart", async () => {
		const store = await storeWithIntent("implement");
		const fake = fakeStartDispatcher(store);
		const env = {
			...WORKFLOW_ON,
			FLYWHEEL_ENGINE_DEAD_EXEC_SWEEP: "0",
		};
		const probeLaunchLiveness = vi.fn(async () => "dead" as const);
		const base = deadExecEngineClockBaseMs();
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1385-live-sweep-flag-")),
			env,
			now: () => new Date(base),
			resolvePredecessorHead: async () => HEAD,
			probeLaunchLiveness,
		});
		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "failed",
			workflow_node_id: "implement",
		});

		// OFF is observed at call time: no probe and no replacement mutation.
		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 0 });
		expect(probeLaunchLiveness).not.toHaveBeenCalled();
		expect(fake.requests).toHaveLength(1);
		expect(store.getWorkflowRunNode("run-1", "implement", 1)).toMatchObject({
			state: "running",
			execution_id: "implement-1",
		});

		// The same dispatcher sees the direct-console mutation on its next tick.
		env.FLYWHEEL_ENGINE_DEAD_EXEC_SWEEP = "1";
		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(probeLaunchLiveness).toHaveBeenCalledOnce();
		expect(fake.requests).toHaveLength(2);
		expect(fake.requests[1]?.successorExecutionId).not.toBe("implement-1");
		store.close();
	});

	it("keeps the dead execution in place when its tripwire baseline cannot be captured", async () => {
		const store = await storeWithIntent("implement");
		const fake = fakeStartDispatcher(store);
		const log = vi.fn();
		const captureDeadExecutionActivityBaseline = vi.fn(async () => {
			throw new Error("commdb_unreadable");
		});
		const base = deadExecEngineClockBaseMs();
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1385-baseline-fail-safe-")),
			env: WORKFLOW_ON,
			now: () => new Date(base),
			resolvePredecessorHead: async () => HEAD,
			probeLaunchLiveness: async () => "dead",
			captureDeadExecutionActivityBaseline,
			log,
		});
		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "failed",
			workflow_node_id: "implement",
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 0 });
		expect(captureDeadExecutionActivityBaseline).toHaveBeenCalledOnce();
		expect(fake.requests).toHaveLength(1);
		expect(store.getWorkflowRunNode("run-1", "implement", 1)).toMatchObject({
			state: "running",
			execution_id: "implement-1",
		});
		expect(store.getWorkflowDeadExecutionWatch("implement-1")).toBeUndefined();
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining(
				"dead-exec activity baseline held for implement-1: commdb_unreadable",
			),
		);
		store.close();
	});

	it("rotates a bounded tripwire patrol so watches after the first page are not starved", async () => {
		const store = await storeWithIntent("design");
		const fake = fakeStartDispatcher(store);
		const watches: WorkflowDeadExecutionWatchRow[] = Array.from(
			{ length: 201 },
			(_, index) => ({
				dead_execution_id: `dead-${String(index).padStart(3, "0")}`,
				run_id: "run-1",
				node_id: "design",
				attempt: 1,
				new_execution_id: `new-${index}`,
				project_name: "flywheel",
				issue_id: "FLY-1307",
				observed_at: "2099-07-22T00:00:00.000Z",
				baseline: {
					commitMarker: { state: "unknown" },
					commDbMessageCount: null,
					tmuxTarget: null,
					tmuxOutputDigest: null,
					sessionCommitCount: null,
				},
				state: "active",
				tripped_at: null,
				evidence: null,
			}),
		);
		vi.spyOn(
			store,
			"listActiveWorkflowDeadExecutionWatches",
		).mockImplementation((...args: unknown[]) => {
			const limit = typeof args[0] === "number" ? args[0] : 200;
			const after = args[1] as
				| { observedAt: string; deadExecutionId: string }
				| undefined;
			const start = after
				? watches.findIndex(
						(watch) =>
							watch.observed_at > after.observedAt ||
							(watch.observed_at === after.observedAt &&
								watch.dead_execution_id > after.deadExecutionId),
					)
				: 0;
			return start < 0 ? [] : watches.slice(start, start + limit);
		});
		const probeDeadExecutionActivity = vi.fn(async () => null);
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1385-tripwire-patrol-")),
			env: {
				...WORKFLOW_ON,
				FLYWHEEL_ENGINE_DEAD_EXEC_SWEEP: "0",
			},
			resolvePredecessorHead: async () => HEAD,
			probeDeadExecutionActivity,
		});

		await dispatcher.reconcile();
		expect(probeDeadExecutionActivity).toHaveBeenCalledTimes(200);
		await dispatcher.reconcile();
		expect(probeDeadExecutionActivity).toHaveBeenCalledTimes(201);
		expect(probeDeadExecutionActivity.mock.calls.at(-1)?.[0]).toMatchObject({
			dead_execution_id: "dead-200",
		});
		store.close();
	});

	it("keeps a durable tripwire and loudly reports activity from a replaced execution after restart", async () => {
		const store = await storeWithIntent("implement");
		const fake = fakeStartDispatcher(store);
		const baseline = {
			commitMarker: { state: "present" as const, mtimeMs: 100 },
			commDbMessageCount: 4,
			tmuxTarget: "runner-flywheel:@17",
			tmuxOutputDigest: "before",
			sessionCommitCount: 1,
		};
		const base = deadExecEngineClockBaseMs();
		const first = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1385-tripwire-first-")),
			env: WORKFLOW_ON,
			now: () => new Date(base),
			resolvePredecessorHead: async () => HEAD,
			probeLaunchLiveness: async () => "dead",
			captureDeadExecutionActivityBaseline: async () => baseline,
			probeDeadExecutionActivity: async () => null,
		});
		expect(await first.reconcile()).toEqual({ started: 1, held: 0 });
		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "failed",
			workflow_node_id: "implement",
		});
		expect(await first.reconcile()).toEqual({ started: 1, held: 0 });
		expect(store.getWorkflowDeadExecutionWatch("implement-1")).toMatchObject({
			state: "active",
			dead_execution_id: "implement-1",
			baseline,
		});

		// A fresh dispatcher proves the watch is durable, not in-memory state.
		const restarted = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1385-tripwire-restart-")),
			env: WORKFLOW_ON,
			now: () => new Date(base + 60_000),
			resolvePredecessorHead: async () => HEAD,
			probeDeadExecutionActivity: async () => ({
				kind: "commdb_write" as const,
				detail: "message count advanced from 4 to 5",
			}),
			resolveRunAlertIdentity: (projectName) => ({
				leadId: "flywheel-eng-lead",
				projectName,
				leadResolution: "resolved",
			}),
		});
		await restarted.reconcile();
		expect(store.getWorkflowDeadExecutionWatch("implement-1")).toMatchObject({
			state: "tripped",
			evidence: {
				kind: "commdb_write",
				detail: "message count advanced from 4 to 5",
			},
		});
		const tripwireAlerts = store.listWorkflowAlertOutbox();
		expect(tripwireAlerts).toHaveLength(2);
		expect(tripwireAlerts.map((row) => row.payload.eventType).sort()).toEqual([
			"workflow_engine_escalation",
			"workflow_engine_issue_alert",
		]);
		for (const row of tripwireAlerts) {
			expect(row).toEqual(
				expect.objectContaining({
					state: "pending",
					payload: expect.objectContaining({
						severity: "severe",
						sessionKey: "wf:run-1",
						metadata: {
							workflowEngine: expect.objectContaining({
								disposition: "dead_execution_activity_after_replacement",
								executionId: "implement-1",
							}),
						},
					}),
				}),
			);
		}
		await restarted.reconcile();
		expect(store.listWorkflowAlertOutbox()).toHaveLength(2);
		store.close();
	});

	it("logs tmux-only activity without paging or consuming the durable watch", async () => {
		const store = await storeWithIntent("implement");
		const fake = fakeStartDispatcher(store);
		const base = deadExecEngineClockBaseMs();
		const first = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1385-tmux-weak-first-")),
			env: WORKFLOW_ON,
			now: () => new Date(base),
			resolvePredecessorHead: async () => HEAD,
			probeLaunchLiveness: async () => "dead",
			captureDeadExecutionActivityBaseline: async () => ({
				commitMarker: { state: "absent" as const },
				commDbMessageCount: 0,
				tmuxTarget: "runner-flywheel:@17",
				tmuxOutputDigest: "before",
				sessionCommitCount: 0,
			}),
			probeDeadExecutionActivity: async () => null,
		});
		expect(await first.reconcile()).toEqual({ started: 1, held: 0 });
		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "failed",
			workflow_node_id: "implement",
		});
		expect(await first.reconcile()).toEqual({ started: 1, held: 0 });

		const log = vi.fn();
		const restarted = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1385-tmux-weak-restart-")),
			env: WORKFLOW_ON,
			now: () => new Date(base + 60_000),
			resolvePredecessorHead: async () => HEAD,
			probeDeadExecutionActivity: async () => ({
				kind: "tmux_output" as const,
				detail: "tmux output changed on reused runner-flywheel:@17",
			}),
			log,
		});
		await restarted.reconcile();

		expect(store.getWorkflowDeadExecutionWatch("implement-1")).toMatchObject({
			state: "active",
			evidence: null,
		});
		expect(store.listWorkflowAlertOutbox()).toHaveLength(0);
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining(
				"dead-exec tripwire tmux-only activity logged for implement-1",
			),
		);
		store.close();
	});

	it("prunes a 24-hour dead-execution watch before the tripwire patrol probes it", async () => {
		const store = await storeWithIntent("implement");
		const fake = fakeStartDispatcher(store);
		const base = deadExecEngineClockBaseMs();
		const first = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1385-watch-ttl-first-")),
			env: WORKFLOW_ON,
			now: () => new Date(base),
			resolvePredecessorHead: async () => HEAD,
			probeLaunchLiveness: async () => "dead",
			captureDeadExecutionActivityBaseline: async () => ({
				commitMarker: { state: "absent" as const },
				commDbMessageCount: 0,
				tmuxTarget: null,
				tmuxOutputDigest: null,
				sessionCommitCount: 0,
			}),
			probeDeadExecutionActivity: async () => null,
		});
		expect(await first.reconcile()).toEqual({ started: 1, held: 0 });
		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "failed",
			workflow_node_id: "implement",
		});
		expect(await first.reconcile()).toEqual({ started: 1, held: 0 });
		expect(store.getWorkflowDeadExecutionWatch("implement-1")).toBeDefined();

		const probeDeadExecutionActivity = vi.fn(async () => ({
			kind: "commdb_write" as const,
			detail: "must not be probed after expiry",
		}));
		const restarted = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1385-watch-ttl-restart-")),
			env: WORKFLOW_ON,
			now: () => new Date(base + 24 * 60 * 60_000),
			resolvePredecessorHead: async () => HEAD,
			probeDeadExecutionActivity,
		});
		await restarted.reconcile();

		expect(probeDeadExecutionActivity).not.toHaveBeenCalled();
		expect(store.getWorkflowDeadExecutionWatch("implement-1")).toBeUndefined();
		expect(store.listWorkflowAlertOutbox()).toHaveLength(0);
		store.close();
	});

	it("records but does not alert when a node needs a second dead-execution replacement", async () => {
		const store = await storeWithIntent("implement");
		const fake = fakeStartDispatcher(store);
		const base = deadExecEngineClockBaseMs();
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1385-repeat-death-")),
			env: WORKFLOW_ON,
			now: () => new Date(base),
			resolvePredecessorHead: async () => HEAD,
			probeLaunchLiveness: async () => "dead",
			captureDeadExecutionActivityBaseline: async () => ({
				commitMarker: { state: "absent" as const },
				commDbMessageCount: 0,
				tmuxTarget: null,
				tmuxOutputDigest: null,
				sessionCommitCount: 0,
			}),
			probeDeadExecutionActivity: async () => null,
			resolveRunAlertIdentity: (projectName) => ({
				leadId: "flywheel-eng-lead",
				projectName,
				leadResolution: "resolved",
			}),
		});
		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "failed",
		});
		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(store.listWorkflowAlertOutbox()).toHaveLength(0);

		const replacementId = fake.requests[1]!.successorExecutionId!;
		store.upsertSession({
			execution_id: replacementId,
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "failed",
		});
		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(fake.requests).toHaveLength(3);
		expect(store.listWorkflowAlertOutbox()).toHaveLength(0);
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "repeated_dead_execution_pattern"),
		).toHaveLength(1);
		store.close();
	});

	it("keeps an unknown-liveness terminal execution in place and alerts on the third probe", async () => {
		const store = await storeWithIntent("implement");
		const fake = fakeStartDispatcher(store);
		const base = deadExecEngineClockBaseMs();
		let now = new Date(base);
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1385-unknown-probe-")),
			env: WORKFLOW_ON,
			now: () => now,
			resolvePredecessorHead: async () => HEAD,
			probeLaunchLiveness: async () => "unknown",
			resolveRunAlertIdentity: (projectName) => ({
				leadId: "flywheel-eng-lead",
				projectName,
				leadResolution: "resolved",
			}),
		});
		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "failed",
		});
		now = new Date(base + 120_000);

		await dispatcher.reconcile();
		await dispatcher.reconcile();
		expect(store.listWorkflowAlertOutbox()).toHaveLength(0);
		await dispatcher.reconcile();

		expect(fake.requests).toHaveLength(1);
		expect(store.getWorkflowRunNode("run-1", "implement", 1)).toMatchObject({
			state: "running",
			execution_id: "implement-1",
		});
		expect(store.listWorkflowAlertOutbox()).toEqual([
			expect.objectContaining({
				state: "pending",
				payload: expect.objectContaining({
					eventType: "workflow_engine_escalation",
					metadata: {
						workflowEngine: expect.objectContaining({
							disposition: "probe_unknown",
						}),
					},
				}),
			}),
		]);
		store.close();
	});

	it("blindly replaces quota, provider-unavailable, and cause-free deaths through one path", async () => {
		const outcomes: Array<Record<string, unknown>> = [];
		for (const lastError of [
			"Fable usage limit reached; quota exhausted; authentication required",
			"Fable provider is temporarily unavailable",
			undefined,
		]) {
			const store = await storeWithIntent("design");
			failRunningDesign(store, lastError);
			const fake = fakeStartDispatcher(store);
			const dispatcher = new WorkflowEngineDispatcher({
				store,
				startDispatcher: fake.dispatcher,
				stateRoot: mkdtempSync(join(tmpdir(), "fly1415-cause-neutral-")),
				env: WORKFLOW_ON,
				now: () => new Date("2099-07-22T00:00:00.000Z"),
				probeLaunchLiveness: async () => "dead",
				captureDeadExecutionActivityBaseline: async () => ({
					commitMarker: { state: "absent" as const },
					commDbMessageCount: 0,
					tmuxTarget: null,
					tmuxOutputDigest: null,
					sessionCommitCount: 0,
				}),
				resolvePredecessorHead: async () => HEAD,
				resolveRunAlertIdentity: (projectName) => ({
					leadId: "flywheel-eng-lead",
					projectName,
					leadResolution: "resolved",
				}),
			});

			expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
			const rollback = store
				.listWorkflowRunEvents("run-1")
				.find((event) => event.kind === "execution_dead_rolled_back");
			outcomes.push({
				runStatus: store.getWorkflowRun("run-1")?.status,
				requestCount: fake.requests.length,
				dispatch: fake.requests[0]?.generalizedExecution?.dispatch,
				alertCount: store.listWorkflowAlertOutbox().length,
				rollback: rollback
					? {
							kind: rollback.kind,
							reason: rollback.payload.reason,
							retryDisposition: rollback.payload.retryDisposition,
						}
					: null,
			});
			store.close();
		}

		expect(outcomes[0]).toMatchObject({
			runStatus: "active",
			requestCount: 1,
			alertCount: 0,
			rollback: {
				kind: "execution_dead_rolled_back",
				reason: "terminal_session_and_dead_probe",
				retryDisposition: "retry",
			},
		});
		expect(outcomes[1]).toEqual(outcomes[0]);
		expect(outcomes[2]).toEqual(outcomes[0]);
	});

	it("does not adopt a terminal session as an in-flight dispatch without a receipt", async () => {
		const store = await storeWithIntent("implement");
		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "failed",
			workflow_node_id: "implement",
		});
		const fake = fakeStartDispatcher(store);
		const log = vi.fn();
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1385-terminal-intent-")),
			env: WORKFLOW_ON,
			now: () => new Date("2099-07-22T00:00:00.000Z"),
			resolvePredecessorHead: async () => HEAD,
			probeLaunchLiveness: async () => "alive",
			log,
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 1 });
		expect(fake.start).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith(
			"workflow engine dispatch held for implement-1: engine_execution_dead",
		);
		expect(store.listWorkflowSideEffects("run-1")[0]?.state).toBe(
			"intent_recorded",
		);
		store.close();
	});

	it("does not regress a node that completes before startDispatcher returns", async () => {
		const store = await storeWithIntent("implement");
		const start = vi.fn(async (request: StartRequest) => {
			const committed = request.generalizedExecution?.commitWorkflowLaunch?.();
			if (!committed?.ok) throw new Error(committed?.reason ?? "not_committed");
			store.upsertSession({
				execution_id: request.generalizedExecution!.executionId,
				issue_id: request.issueId,
				project_name: request.projectName,
				status: "running",
				session_role: request.sessionRole,
			});
			expect(
				store.commitEnrolledCompletion({
					executionId: request.generalizedExecution!.executionId,
					route: "needs_review",
					sourceEventId: "complete-before-start-return",
					completionSubmission: {
						decision: { route: "needs_review" },
					},
				}),
			).toMatchObject({ ok: true });
			return {
				executionId: request.generalizedExecution!.executionId,
				issueId: request.issueId,
			};
		});
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: {
				start,
				getInflightCount: () => 0,
				validateAgentName: () => ({ ok: true as const }),
			} as IStartDispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1307-complete-race-")),
			env: WORKFLOW_ON,
			resolvePredecessorHead: async () => HEAD,
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(start).toHaveBeenCalledOnce();
		expect(store.getWorkflowRunNode("run-1", "implement", 1)?.state).toBe(
			"done",
		);
		store.close();
	});

	it("holds an output-backed review until durable materialization authority resolves, then launches at that head", async () => {
		const { store, canonicalRoot, env } = await storeWithProductOutputIntent();
		const produce = fakeStartDispatcher(store);
		const produceDispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: produce.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1307-product-produce-")),
			env,
		});
		expect(await produceDispatcher.reconcile()).toEqual({
			started: 1,
			held: 0,
		});
		const outputToken =
			produce.requests[0]?.generalizedExecution?.outputCredential;
		expect(outputToken).toEqual(expect.any(String));
		expect(
			store.submitWorkflowNodeOutput({
				token: outputToken!,
				clientRequestId: "product-output-1",
				payload: JSON.stringify({
					kind: "docs_v1",
					operations: [
						{ op: "write", path: "product/doc/prd.md", content: "PRD\n" },
					],
				}),
			}),
		).toMatchObject({ ok: true });
		store.commitWorkflowTransitionTx({
			runId: "product-run",
			nodeId: "produce",
			attempt: 1,
			executionId: "produce-1",
			outcome: "node_done",
			successorExecutionId: "review-1",
			now: "2026-07-16T00:10:00.000Z",
		});

		const review = fakeStartDispatcher(store);
		const unavailable: MaterializedHeadAuthority = {
			resolve: vi.fn(async () => {
				throw new Error("materialized_head_unavailable");
			}),
		};
		const held = new WorkflowEngineDispatcher({
			store,
			startDispatcher: review.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1307-product-review-")),
			env,
			materializedHeadAuthority: unavailable,
		});
		expect(await held.reconcile()).toEqual({ started: 0, held: 1 });
		expect(review.start).not.toHaveBeenCalled();

		let remoteHead: string | undefined;
		const materializer = new WorkflowDocsMaterializer({
			store,
			projects: [
				{
					projectName: "flywheel",
					projectRoot: canonicalRoot,
					projectRepo: "xrliAnnie/flywheel",
					leads: [],
				},
			],
			withRepoLock: async (_root, fn) => fn(),
			git: {
				resolveBaseHead: async () => "b".repeat(40),
				prepareOrAdoptCommit: async () => ({
					treeHead: "c".repeat(40),
					commitHead: HEAD,
				}),
				readRemoteHead: async () => remoteHead,
				pushCommit: async () => {
					remoteHead = HEAD;
				},
			},
		});
		expect(await materializer.reconcile()).toEqual({
			materialized: 1,
			held: 0,
		});
		const authority = receiptBackedMaterializedHeadAuthority(store);
		const ready = new WorkflowEngineDispatcher({
			store,
			startDispatcher: review.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1307-product-review-ready-")),
			env,
			materializedHeadAuthority: authority,
		});
		expect(await ready.reconcile()).toEqual({ started: 1, held: 0 });
		expect(review.requests[0]).toMatchObject({
			successorExecutionId: "review-1",
			sessionRole: "main",
			startPoint: HEAD,
		});
		store.close();
		rmSync(canonicalRoot, { recursive: true, force: true });
	});

	it.each([
		{
			templateId: "tpl_product_designer" as const,
			runId: "designer-run",
			artifactDir: "designer",
		},
		{
			templateId: "tpl_product_prototype" as const,
			runId: "prototype-run",
			artifactDir: "prototype",
		},
	])(
		"admits $templateId producer, materializes docs_v1, then admits cross-vendor review at the exact head",
		async ({ templateId, runId, artifactDir }) => {
			const { store, canonicalRoot, env, producer, review } =
				await storeWithBundledOutputFirstIntent({ templateId, runId });
			const producerAdmission = store.admitGeneralizedWorkflowExecution({
				runId,
				nodeId: producer.id,
				executionId: `${runId}-produce-1`,
				attempt: 1,
				now: "2026-07-22T00:01:00.000Z",
				expiresAt: "2027-07-22T00:01:00.000Z",
				absoluteDeadlineAt: "2027-07-23T00:01:00.000Z",
				env,
			});
			expect(producerAdmission).toMatchObject({
				ok: true,
				outputCredential: expect.any(String),
			});
			const outputToken =
				producerAdmission.ok && producerAdmission.outputCredential;
			const payload = {
				kind: "docs_v1" as const,
				operations: [
					{
						op: "write" as const,
						path: `docs/${artifactDir}/index.html`,
						content: `<h1>${artifactDir}</h1>\n`,
					},
					{
						op: "write" as const,
						path: `docs/${artifactDir}/README.md`,
						content: `Open with: open docs/${artifactDir}/index.html\n`,
					},
				],
			};
			expect(
				store.submitWorkflowNodeOutput({
					token: outputToken!,
					clientRequestId: `${runId}-output-1`,
					payload: JSON.stringify(payload),
				}),
			).toMatchObject({ ok: true });
			expect(
				store.commitWorkflowTransitionTx({
					runId,
					nodeId: producer.id,
					attempt: 1,
					executionId: `${runId}-produce-1`,
					outcome: "node_done",
					successorExecutionId: `${runId}-review-1`,
					now: "2026-07-22T00:10:00.000Z",
				}),
			).toMatchObject({ ok: true });

			let remoteHead: string | undefined;
			let preparedPayload: unknown;
			const materializer = new WorkflowDocsMaterializer({
				store,
				projects: [
					{
						projectName: "flywheel",
						projectRoot: canonicalRoot,
						projectRepo: "xrliAnnie/flywheel",
						leads: [],
					},
				],
				withRepoLock: async (_root, fn) => fn(),
				git: {
					resolveBaseHead: async () => "b".repeat(40),
					prepareOrAdoptCommit: async (input) => {
						preparedPayload = input.payload;
						return { treeHead: "c".repeat(40), commitHead: HEAD };
					},
					readRemoteHead: async () => remoteHead,
					pushCommit: async () => {
						remoteHead = HEAD;
					},
				},
			});
			expect(await materializer.reconcile()).toEqual({
				materialized: 1,
				held: 0,
			});
			expect(preparedPayload).toEqual(payload);

			const reviewDispatch = fakeStartDispatcher(store);
			const reviewDispatcher = new WorkflowEngineDispatcher({
				store,
				startDispatcher: reviewDispatch.dispatcher,
				stateRoot: mkdtempSync(join(tmpdir(), `${runId}-review-`)),
				env,
				materializedHeadAuthority:
					receiptBackedMaterializedHeadAuthority(store),
			});
			expect(await reviewDispatcher.reconcile()).toEqual({
				started: 1,
				held: 0,
			});
			expect(reviewDispatch.requests[0]).toMatchObject({
				successorExecutionId: `${runId}-review-1`,
				startPoint: HEAD,
				generalizedExecution: {
					dispatch: {
						vendor: review.vendor,
						model: review.model,
						effort: review.effort,
					},
				},
			});
			expect(review.vendor).not.toBe(producer.vendor);
			store.close();
			rmSync(canonicalRoot, { recursive: true, force: true });
		},
	);

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

describe("WorkflowEngineDispatcher ship-ready reconcile pass", () => {
	it("runs only after dispatch consumption", async () => {
		const store = await storeWithIntent("implement");
		const order: string[] = [];
		const fake = fakeStartDispatcher(store);
		const startDispatcher = {
			...fake.dispatcher,
			start: async (request: StartRequest) => {
				order.push("dispatch");
				return fake.dispatcher.start(request);
			},
		} as IStartDispatcher;
		vi.spyOn(store, "listWorkflowShipReadyGates").mockReturnValue([
			shipReadyNotice({
				runId: "run-1",
				pending: { lead: true, founder: false },
			}),
		]);
		vi.spyOn(store, "listWorkflowShipReadyStalled").mockReturnValue([]);
		const arm: WorkflowShipReadyArm = {
			queueLeadNotice: vi.fn(async () => {
				order.push("ship-ready");
				return { queued: true };
			}),
			postFounderCard: vi.fn(),
			classifyShipHandled: vi.fn(async () => new Map()),
		};
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1424-ordering-")),
			env: {
				...WORKFLOW_ON,
				FLYWHEEL_ENGINE_DEAD_EXEC_SWEEP: "0",
				FLYWHEEL_SHIP_READY_NOTIFY: "1",
			},
			resolvePredecessorHead: async () => HEAD,
			shipReadyArm: arm,
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(order).toEqual(["dispatch", "ship-ready"]);
		expect(store.listWorkflowRunEvents("run-1")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "ship_ready_lead_queued" }),
			]),
		);
		store.close();
	});

	it("isolates Lead and founder arm failures in both directions", async () => {
		for (const failing of ["lead", "founder"] as const) {
			const item = shipReadyNotice();
			const store = shipReadyOnlyStore({ ready: () => [item] });
			const queueLeadNotice = vi.fn(async () => {
				if (failing === "lead") throw new Error("lead queue down");
				return { queued: true };
			});
			const postFounderCard = vi.fn(async () => {
				if (failing === "founder") throw new Error("Discord down");
				return { kind: "posted" as const };
			});
			const dispatcher = new WorkflowEngineDispatcher({
				store,
				startDispatcher: inertStartDispatcher(),
				env: {
					...WORKFLOW_ON,
					FLYWHEEL_ENGINE_DEAD_EXEC_SWEEP: "0",
				},
				now: () => new Date("2026-07-22T01:01:00.000Z"),
				shipReadyArm: {
					queueLeadNotice,
					postFounderCard,
					classifyShipHandled: vi.fn(async () => new Map()),
				},
			});

			await dispatcher.reconcile();
			expect(queueLeadNotice).toHaveBeenCalledOnce();
			expect(postFounderCard).toHaveBeenCalledOnce();
			expect(store.recordWorkflowShipReadyFact).toHaveBeenCalledTimes(1);
			expect(store.recordWorkflowShipReadyFact).toHaveBeenCalledWith(
				expect.objectContaining({
					path: failing === "lead" ? "founder" : "lead",
				}),
			);
		}
	});

	it.each(["same_process", "restart"] as const)(
		"redrives a durable Lead queue tail after the fact write crashes (%s)",
		async (mode) => {
			const item = shipReadyNotice({
				pending: { lead: true, founder: false },
			});
			let factPersisted = false;
			const store = shipReadyOnlyStore({
				ready: () => (factPersisted ? [] : [item]),
			});
			store.recordWorkflowShipReadyFact
				.mockImplementationOnce(() => {
					throw new Error("crash after durable enqueue");
				})
				.mockImplementation(() => {
					factPersisted = true;
					return { ok: true, idempotentReplay: false };
				});
			const queueLeadNotice = vi.fn(async () => ({ queued: true }));
			const options = {
				store,
				startDispatcher: inertStartDispatcher(),
				env: {
					...WORKFLOW_ON,
					FLYWHEEL_ENGINE_DEAD_EXEC_SWEEP: "0",
				},
				shipReadyArm: {
					queueLeadNotice,
					postFounderCard: vi.fn(),
					classifyShipHandled: vi.fn(async () => new Map()),
				},
			};
			const first = new WorkflowEngineDispatcher(options);
			await first.reconcile();
			expect(queueLeadNotice).toHaveBeenCalledOnce();
			const redriver =
				mode === "restart" ? new WorkflowEngineDispatcher(options) : first;
			await redriver.reconcile();
			expect(queueLeadNotice).toHaveBeenCalledTimes(2);
			await redriver.reconcile();
			expect(queueLeadNotice).toHaveBeenCalledTimes(2);
		},
	);

	it("backs off only the founder arm while Lead delivery remains eligible", async () => {
		let pending = { lead: false, founder: true };
		const item = () => shipReadyNotice({ pending });
		const store = shipReadyOnlyStore({ ready: () => [item()] });
		const queueLeadNotice = vi.fn(async () => ({ queued: true }));
		const postFounderCard = vi.fn(async () => ({
			kind: "transient" as const,
			reason: "rate_limited",
		}));
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: inertStartDispatcher(),
			env: {
				...WORKFLOW_ON,
				FLYWHEEL_ENGINE_DEAD_EXEC_SWEEP: "0",
			},
			now: () => new Date("2026-07-22T01:01:00.000Z"),
			shipReadyArm: {
				queueLeadNotice,
				postFounderCard,
				classifyShipHandled: vi.fn(async () => new Map()),
			},
		});

		await dispatcher.reconcile();
		await dispatcher.reconcile();
		expect(postFounderCard).toHaveBeenCalledTimes(1);
		pending = { lead: true, founder: true };
		await dispatcher.reconcile();
		expect(queueLeadNotice).toHaveBeenCalledOnce();
		expect(postFounderCard).toHaveBeenCalledTimes(1);
		expect(store.recordWorkflowShipReadyFact).toHaveBeenCalledWith(
			expect.objectContaining({ path: "lead" }),
		);
	});

	it("honors Retry-After and then advances the 30s exponential retry ladder", async () => {
		let nowMs = Date.parse("2026-07-22T01:01:00.000Z");
		const item = shipReadyNotice({ pending: { lead: false, founder: true } });
		const store = shipReadyOnlyStore({ ready: () => [item] });
		const postFounderCard = vi
			.fn<WorkflowShipReadyArm["postFounderCard"]>()
			.mockResolvedValueOnce({
				kind: "transient",
				reason: "rate_limited",
				retryAfterMs: 90_000,
			})
			.mockResolvedValueOnce({ kind: "transient", reason: "server_error" })
			.mockResolvedValue({ kind: "posted" });
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: inertStartDispatcher(),
			env: {
				...WORKFLOW_ON,
				FLYWHEEL_ENGINE_DEAD_EXEC_SWEEP: "0",
			},
			now: () => new Date(nowMs),
			shipReadyArm: {
				queueLeadNotice: vi.fn(),
				postFounderCard,
				classifyShipHandled: vi.fn(async () => new Map()),
			},
		});

		await dispatcher.reconcile();
		nowMs += 89_999;
		await dispatcher.reconcile();
		expect(postFounderCard).toHaveBeenCalledTimes(1);
		nowMs += 1;
		await dispatcher.reconcile();
		expect(postFounderCard).toHaveBeenCalledTimes(2);
		nowMs += 59_999;
		await dispatcher.reconcile();
		expect(postFounderCard).toHaveBeenCalledTimes(2);
		nowMs += 1;
		await dispatcher.reconcile();
		expect(postFounderCard).toHaveBeenCalledTimes(3);
	});

	it("scans past founder-backoff rows and caps each tick at three eligible notices", async () => {
		const all = Array.from({ length: 4 }, (_, index) =>
			shipReadyNotice({
				runId: `run-${index + 1}`,
				pending: { lead: false, founder: true },
			}),
		);
		const store = shipReadyOnlyStore({ ready: () => all });
		const posted: string[] = [];
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: inertStartDispatcher(),
			env: {
				...WORKFLOW_ON,
				FLYWHEEL_ENGINE_DEAD_EXEC_SWEEP: "0",
			},
			now: () => new Date("2026-07-22T01:01:00.000Z"),
			shipReadyArm: {
				queueLeadNotice: vi.fn(),
				postFounderCard: vi.fn(async (item) => {
					posted.push(item.runId);
					return { kind: "transient" as const, reason: "rate_limited" };
				}),
				classifyShipHandled: vi.fn(async () => new Map()),
			},
		});

		await dispatcher.reconcile();
		expect(posted).toEqual(["run-1", "run-2", "run-3"]);
		await dispatcher.reconcile();
		expect(posted).toEqual(["run-1", "run-2", "run-3", "run-4"]);
	});

	it("terminalizes permanent failures and transient attempts beyond the durable 45-minute budget", async () => {
		for (const outcome of [
			{ kind: "permanent" as const, reason: "bad_owner" },
			{ kind: "transient" as const, reason: "Discord down" },
		]) {
			const item = shipReadyNotice({
				gateOpenedAt: "2026-07-22T01:00:00.000Z",
				pending: { lead: false, founder: true },
			});
			const store = shipReadyOnlyStore({ ready: () => [item] });
			const dispatcher = new WorkflowEngineDispatcher({
				store,
				startDispatcher: inertStartDispatcher(),
				env: {
					...WORKFLOW_ON,
					FLYWHEEL_ENGINE_DEAD_EXEC_SWEEP: "0",
				},
				now: () => new Date("2026-07-22T01:46:00.000Z"),
				resolveRunAlertIdentity: (projectName) => ({
					leadId: "flywheel-eng-lead",
					projectName,
					leadResolution: "resolved",
				}),
				shipReadyArm: {
					queueLeadNotice: vi.fn(),
					postFounderCard: vi.fn(async () => outcome),
					classifyShipHandled: vi.fn(async () => new Map()),
				},
			});
			await dispatcher.reconcile();
			expect(store.recordWorkflowShipReadyDeliveryFailure).toHaveBeenCalledWith(
				expect.objectContaining({
					runId: item.runId,
					reason:
						outcome.kind === "transient"
							? "retry_budget_exhausted:Discord down"
							: "bad_owner",
				}),
			);
		}
	});

	it("classifies the full stalled batch and only alerts definitive unhandled rows", async () => {
		const stalled = ["merged", "approved", "unknown", "unhandled"].map(
			(runId) => shipReadyNotice({ runId }),
		);
		let current = stalled;
		const store = shipReadyOnlyStore({ stalled: () => current });
		const outcomes = new Map<string, ShipReadyHandledOutcome>([
			["merged:founder_gate:1", { kind: "handled", reason: "pr_merged" }],
			[
				"approved:founder_gate:1",
				{ kind: "handled", reason: "founder_approved" },
			],
			["unknown:founder_gate:1", { kind: "unknown" }],
			["unhandled:founder_gate:1", { kind: "unhandled" }],
		]);
		const classifyShipHandled = vi.fn(async () => outcomes);
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: inertStartDispatcher(),
			env: {
				...WORKFLOW_ON,
				FLYWHEEL_ENGINE_DEAD_EXEC_SWEEP: "0",
				FLYWHEEL_SHIP_READY_REMIND_MS: "1000",
			},
			now: () => new Date("2026-07-22T01:31:00.000Z"),
			resolveRunAlertIdentity: (projectName) => ({
				leadId: "flywheel-eng-lead",
				projectName,
				leadResolution: "resolved",
			}),
			shipReadyArm: {
				queueLeadNotice: vi.fn(),
				postFounderCard: vi.fn(),
				classifyShipHandled,
			},
		});

		await dispatcher.reconcile();
		expect(classifyShipHandled).toHaveBeenCalledWith(stalled);
		expect(store.recordWorkflowShipReadyHandledObserved).toHaveBeenCalledTimes(
			1,
		);
		expect(store.recordWorkflowShipReadyHandledObserved).toHaveBeenCalledWith(
			expect.objectContaining({ runId: "merged", reason: "pr_merged" }),
		);
		expect(store.recordWorkflowShipReadyStalledAlert).toHaveBeenCalledTimes(1);
		expect(store.recordWorkflowShipReadyStalledAlert).toHaveBeenCalledWith(
			expect.objectContaining({ runId: "unhandled" }),
		);

		current = [];
		await dispatcher.reconcile();
		expect(classifyShipHandled).toHaveBeenLastCalledWith([]);
	});

	it("contains a poison ready candidate so the following candidate still completes both paths", async () => {
		const poison = shipReadyNotice({ runId: "poison" });
		const healthy = shipReadyNotice({ runId: "healthy" });
		const store = shipReadyOnlyStore({ ready: () => [poison, healthy] });
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: inertStartDispatcher(),
			env: {
				...WORKFLOW_ON,
				FLYWHEEL_ENGINE_DEAD_EXEC_SWEEP: "0",
			},
			now: () => new Date("2026-07-22T01:01:00.000Z"),
			shipReadyArm: {
				queueLeadNotice: vi.fn(async (item) => {
					if (item.runId === "poison") throw new Error("queue poison");
					return { queued: true };
				}),
				postFounderCard: vi.fn(async (item) => {
					if (item.runId === "poison") throw new Error("post poison");
					return { kind: "posted" as const };
				}),
				classifyShipHandled: vi.fn(async () => new Map()),
			},
		});
		await dispatcher.reconcile();
		expect(store.recordWorkflowShipReadyFact).toHaveBeenCalledWith(
			expect.objectContaining({ runId: "healthy", path: "lead" }),
		);
		expect(store.recordWorkflowShipReadyFact).toHaveBeenCalledWith(
			expect.objectContaining({ runId: "healthy", path: "founder" }),
		);
	});

	it("does not treat a failed readiness or stalled query as an empty lifecycle batch", async () => {
		const item = shipReadyNotice({ pending: { lead: false, founder: true } });
		let readyFails = false;
		let readyEmpty = false;
		let stalledFails = false;
		const store = shipReadyOnlyStore({
			ready: () => {
				if (readyFails) throw new Error("ready DB unavailable");
				return readyEmpty ? [] : [item];
			},
			stalled: () => {
				if (stalledFails) throw new Error("stalled DB unavailable");
				return [];
			},
		});
		const postFounderCard = vi.fn(async () => ({
			kind: "transient" as const,
			reason: "rate_limited",
		}));
		const classifyShipHandled = vi.fn(async () => new Map());
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: inertStartDispatcher(),
			env: {
				...WORKFLOW_ON,
				FLYWHEEL_ENGINE_DEAD_EXEC_SWEEP: "0",
			},
			now: () => new Date("2026-07-22T01:01:00.000Z"),
			shipReadyArm: {
				queueLeadNotice: vi.fn(),
				postFounderCard,
				classifyShipHandled,
			},
		});
		await dispatcher.reconcile();
		expect(postFounderCard).toHaveBeenCalledOnce();
		expect(classifyShipHandled).toHaveBeenLastCalledWith([]);

		readyFails = true;
		stalledFails = true;
		await dispatcher.reconcile();
		expect(postFounderCard).toHaveBeenCalledOnce();
		expect(classifyShipHandled).toHaveBeenCalledTimes(1);

		readyFails = false;
		stalledFails = false;
		await dispatcher.reconcile();
		expect(postFounderCard).toHaveBeenCalledOnce();
		expect(classifyShipHandled).toHaveBeenCalledTimes(2);

		readyEmpty = true;
		await dispatcher.reconcile();
		readyEmpty = false;
		await dispatcher.reconcile();
		expect(postFounderCard).toHaveBeenCalledTimes(2);
	});

	it("reads notify and reminder flags at call time on the same instance", async () => {
		const env = {
			...WORKFLOW_ON,
			FLYWHEEL_ENGINE_DEAD_EXEC_SWEEP: "0",
			FLYWHEEL_SHIP_READY_NOTIFY: "0",
			FLYWHEEL_SHIP_READY_REMIND_MS: "2500",
		};
		const item = shipReadyNotice({ pending: { lead: true, founder: false } });
		const thresholds: number[] = [];
		const store = shipReadyOnlyStore({
			ready: () => [item],
			stalled: (threshold) => {
				thresholds.push(threshold);
				return [];
			},
		});
		const queueLeadNotice = vi.fn(async () => ({ queued: true }));
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: inertStartDispatcher(),
			env,
			shipReadyArm: {
				queueLeadNotice,
				postFounderCard: vi.fn(),
				classifyShipHandled: vi.fn(async () => new Map()),
			},
		});
		await dispatcher.reconcile();
		expect(queueLeadNotice).not.toHaveBeenCalled();

		env.FLYWHEEL_SHIP_READY_NOTIFY = "1";
		await dispatcher.reconcile();
		expect(queueLeadNotice).toHaveBeenCalledOnce();
		expect(thresholds).toEqual([2_500]);
		env.FLYWHEEL_SHIP_READY_REMIND_MS = "invalid";
		await dispatcher.reconcile();
		expect(thresholds).toEqual([2_500, 1_800_000]);
		env.FLYWHEEL_SHIP_READY_NOTIFY = "0";
		await dispatcher.reconcile();
		expect(queueLeadNotice).toHaveBeenCalledTimes(2);
	});
});
