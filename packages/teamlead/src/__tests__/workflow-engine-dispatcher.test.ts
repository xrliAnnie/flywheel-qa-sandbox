import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalSubmissionDigest } from "flywheel-config";
import { describe, expect, it, vi } from "vitest";
import { executeLandOperation } from "../bridge/land-executor.js";
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
import {
	compileWorkflowMenuSeed,
	loadWorkflowMenuLibrary,
} from "../workflow-menu.js";
import { buildWorkflowRunSnapshotV1 } from "../workflow-run-snapshot.js";
import type {
	ShipReadyHandledOutcome,
	WorkflowShipReadyArm,
	WorkflowShipReadyNotice,
} from "../workflow-ship-ready.js";
import { isWorkflowManifestV1Land } from "../workflow-template.js";
import { legacyWorkflowSeeds } from "./fixtures/legacy-workflow-manifests.js";

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
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
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
	const seed = legacyWorkflowSeeds().find(
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
		store.applyWorkflowLedgerBatch({
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

async function storeWithRootImplementIntent() {
	const store = await StateStore.create(":memory:");
	const menu = loadWorkflowMenuLibrary().find(
		(candidate) => candidate.shape === "simple_code",
	)!;
	const seed = compileWorkflowMenuSeed(menu);
	store.importWorkflowTemplateSeed(seed, WORKFLOW_ON);
	store.materializeWorkflowRun({
		runId: "simple-run",
		issueId: "FLY-1859",
		projectName: "flywheel",
		taskCategory: "simple_code",
		templateId: seed.templateId,
		claimsReadEnrolled: true,
		actor: "lead",
		canonicalRoot: REPO_ROOT,
		env: WORKFLOW_ON,
		entryKind: "workflow_v2",
		startReservation: {
			idempotencyKey: "simple-start",
			selectionDigest: "simple-selection",
			nodeId: "implement",
			attempt: 1,
			executionId: "simple-implement-1",
			createdAt: "2026-08-19T00:00:00.000Z",
		},
	});
	return store;
}

async function storeWithLandIntent() {
	const store = await StateStore.create(":memory:");
	const seed = legacyWorkflowSeeds().find(
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
		nodeId: "implement",
		attempt: 1,
		state: "done",
		executionId: "implement-land",
	});
	db.run(
		`INSERT INTO workflow_node_pr_binding
		   (run_id, node_id, attempt, pr_number, head_sha, target_repo_identity,
		    probe_repo_slug, target_repo_path, worktree_binding_generation,
		    receipt_id, bound_at)
		 VALUES ('run-land', 'implement', 1, 1375, ?, '__main__',
		         'geoforge3d/flywheel', '/tmp/flywheel', 'generation-1',
		         'land-pr-binding', '2026-07-21T19:59:00.000Z')`,
		[HEAD],
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
	store.applyWorkflowLedgerBatch({
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
	const seed = legacyWorkflowSeeds().find(
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
	const seed = legacyWorkflowSeeds().find(
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

function fakeStartDispatcher(
	store: StateStore,
	options: { prepareIssueDelivery?: "authoritative" | "fallback" } = {},
) {
	const requests: StartRequest[] = [];
	const start = vi.fn(async (request: StartRequest) => {
		requests.push(request);
		if (options.prepareIssueDelivery) {
			request.generalizedExecution?.prepareWorkflowIssueDelivery?.({
				sourceKind: options.prepareIssueDelivery,
				body: "Pinned workflow issue body",
				updatedAt: "2026-07-16T00:00:30.000Z",
				anchorCommit: HEAD,
			});
		}
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

async function storeWithMaterializedFounderReplacement(
	target: "design" | "qa",
): Promise<{ store: StateStore; requestId: string; replacementId: string }> {
	const store = await storeWithIntent(target);
	const deadExecutionId = target === "design" ? "design-1" : "qa-1";
	store.applyWorkflowLedgerBatch({
		projectName: "flywheel",
		issueId: "FLY-1307",
		runId: "run-1",
		ops: [
			{
				op: "side_effect",
				node: target,
				attempt: 1,
				executionId: deadExecutionId,
				to: "started",
			},
		],
	});
	store.upsertSession({
		execution_id: deadExecutionId,
		issue_id: "FLY-1307",
		project_name: "flywheel",
		status: "failed",
		session_role: target,
	});
	store.upsertWorkflowRunNode({
		runId: "run-1",
		nodeId: target,
		attempt: 2,
		state: "pending",
		executionId: deadExecutionId,
	});
	const requestId = `founder-rework-${target}`;
	const db = (
		store as unknown as {
			db: { run(sql: string, params?: unknown[]): void };
		}
	).db;
	db.run("UPDATE workflow_run SET current_node_id = ? WHERE run_id = 'run-1'", [
		target,
	]);
	db.run(
		`INSERT OR IGNORE INTO workflow_actor
		   (execution_id, project_name, issue_id, role, created_at)
		 VALUES (?, 'flywheel', 'FLY-1307', ?, '2026-08-15T08:00:00.000Z')`,
		[deadExecutionId, target],
	);
	db.run(
		`INSERT INTO workflow_rework_request
		   (request_id, run_id, source_event_id, authority, source_node_id,
		    source_attempt, base_revision, authority_context_json,
		    authority_context_digest, founder_feedback_verbatim, requested_at)
		 VALUES (?, 'run-1', ?, 'founder', 'founder_gate', 1, ?, '{}', ?, ?,
		         '2026-08-15T08:00:00.000Z')`,
		[
			requestId,
			`founder-source-${target}`,
			HEAD,
			`digest-${target}`,
			`${target}: keep  double spaces and punctuation!`,
		],
	);
	const invalidationScope =
		target === "design" ? ["design", "implement", "qa"] : ["qa"];
	const verificationPolicy =
		target === "design"
			? ["design_review", "code_review", "qa_retest", "founder_gate"]
			: ["qa_retest", "founder_gate"];
	db.run(
		`INSERT INTO workflow_rework_route_revision
		   (request_id, revision, target_node_id, target_attempt,
		    preferred_actor_execution_id, invalidation_scope_json,
		    verification_policy_json, interpreted_by, interpretation_reason, created_at)
		 VALUES (?, 1, ?, 2, ?, ?, ?, 'founder-reply-prefix', 'explicit prefix',
		         '2026-08-15T08:00:00.000Z')`,
		[
			requestId,
			target,
			deadExecutionId,
			JSON.stringify(invalidationScope),
			JSON.stringify(verificationPolicy),
		],
	);
	db.run(
		`INSERT INTO workflow_rework_delivery
		   (request_id, route_revision, state, updated_at)
		 VALUES (?, 1, 'replacement_pending', '2026-08-15T08:00:00.000Z')`,
		[requestId],
	);
	const replacementId = `${target}-replacement-2`;
	const materialized = store.materializeWorkflowReworkReplacement({
		requestId,
		deadExecutionId,
		newExecutionId: replacementId,
		reason: "persisted_target_dead",
		observedAt: "2026-08-15T08:01:00.000Z",
	});
	expect(materialized).toMatchObject({
		ok: true,
		executionId: replacementId,
		idempotentReplay: false,
	});
	return { store, requestId, replacementId };
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
	store.applyWorkflowLedgerBatch({
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

async function storeWithFreshVerificationIntent(): Promise<{
	store: StateStore;
	requestId: string;
	successorExecutionId: string;
}> {
	const store = await storeWithIntent("implement");
	store.upsertWorkflowRunNode({
		runId: "run-1",
		nodeId: "implement",
		attempt: 1,
		state: "done",
		executionId: "implement-1",
		endedAt: "2026-07-16T00:06:00.000Z",
	});
	store.upsertSession({
		execution_id: "implement-1",
		issue_id: "FLY-1307",
		project_name: "flywheel",
		status: "ship_parked",
		session_role: "implement",
		issue_identifier: "FLY-1307",
		issue_title: "DAG template engine",
		design_backend: "claude",
		doc_tier: "full",
		issue_url: "https://linear.app/flywheel/FLY-1307",
		worktree_path: "/unused/implement",
		pr_head_sha: HEAD,
	});
	store.patchSessionMetadata("implement-1", { pr_head_sha: HEAD });
	const db = (
		store as unknown as {
			db: { run(sql: string, params?: unknown[]): void };
		}
	).db;
	db.run("UPDATE workflow_run SET status = 'completed' WHERE run_id = 'run-1'");
	const opened = store.openOperatorRework({
		runId: "run-1",
		targetNodeId: "implement",
		feedback: "rework before QA has ever run",
		clientRequestId: "fly1912-dispatcher",
		principal: "master",
		evidence: store.listRunAttributedExecutions("run-1").map((executionId) => ({
			executionId,
			sessionStatus: null,
			lifecycleRevision: null,
			liveness: "dead" as const,
			observedAt: "2026-07-16T00:07:00.000Z",
		})),
		now: "2026-07-16T00:07:00.000Z",
	});
	if (!opened.ok) throw new Error(opened.reason);
	const claimed = store.claimWorkflowReworkDelivery({
		requestId: opened.requestId,
		ownerId: "fly1912-coordinator",
		now: "2026-07-16T00:08:00.000Z",
		leaseExpiresAt: "2026-07-16T00:08:30.000Z",
	});
	if (!claimed.ok) throw new Error(claimed.reason);
	const admitted = store.admitGeneralizedWorkflowExecution({
		runId: "run-1",
		nodeId: "implement",
		executionId: "implement-1",
		attempt: 2,
		activationId: "activation-fly1912-implement-2",
		activationMode: "wake",
		reworkRequestId: opened.requestId,
		expiresAt: "2026-07-16T02:00:00.000Z",
		absoluteDeadlineAt: "2026-07-17T00:00:00.000Z",
		now: "2026-07-16T00:08:01.000Z",
		env: WORKFLOW_ON,
	});
	if (!admitted.ok) throw new Error(admitted.reason);
	const turn = store.recordWorkflowActivationTurn({
		activationId: admitted.activationId,
		issueId: "FLY-1307",
		executionId: "implement-1",
		epoch: 2,
		sourceEventId: "fly1912-dispatcher-turn",
		grantedAt: "2026-07-16T00:08:30.000Z",
	});
	if (!turn.ok) throw new Error(turn.reason);
	for (const [from, to] of [
		["pending", "turn_granted"],
		["turn_granted", "awaiting_receipt"],
	] as const) {
		const advanced = store.advanceWorkflowReworkDelivery({
			requestId: opened.requestId,
			ownerId: "fly1912-coordinator",
			generation: claimed.generation,
			from,
			to,
			now: "2026-07-16T00:09:00.000Z",
			...(to === "awaiting_receipt"
				? {
						releaseOwner: true,
					}
				: {}),
		});
		if (!advanced.ok) throw new Error(advanced.reason);
	}
	const receipt = store.recordWorkflowReworkWakeReceipt({
		activationId: admitted.activationId,
		executionId: "implement-1",
		epoch: 2,
		ackedAt: "2026-07-16T00:09:01.000Z",
		alertIdentity: {
			leadId: "flywheel-eng-lead",
			projectName: "flywheel",
			leadResolution: "resolved",
		},
	});
	if (!receipt.ok) throw new Error(receipt.reason);
	const completed = store.commitWorkflowTransitionTx({
		runId: "run-1",
		nodeId: "implement",
		attempt: 2,
		executionId: "implement-1",
		outcome: "implement_done",
		now: "2026-07-16T00:10:00.000Z",
	});
	if (!completed.ok || !completed.successorExecutionId) {
		throw new Error("fresh verification dispatch missing");
	}
	return {
		store,
		requestId: opened.requestId,
		successorExecutionId: completed.successorExecutionId,
	};
}

describe("WorkflowEngineDispatcher", () => {
	it("dispatches a fresh verification successor through the ordinary spawn path", async () => {
		const { store, requestId, successorExecutionId } =
			await storeWithFreshVerificationIntent();
		const fake = fakeStartDispatcher(store);
		const resolvePredecessorHead = vi.fn(async () => HEAD);
		const recoverLaunch = vi.spyOn(store, "recoverOrAcquireWorkflowLaunch");
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			env: WORKFLOW_ON,
			now: () => new Date("2026-07-16T00:11:00.000Z"),
			stateRoot: mkdtempSync(join(tmpdir(), "fly1912-fresh-dispatch-")),
			resolvePredecessorHead,
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 2, held: 0 });
		expect(fake.requests).toHaveLength(1);
		expect(fake.requests[0]).toMatchObject({
			successorExecutionId,
			sessionRole: "qa",
			startPoint: HEAD,
			generalizedExecution: {
				executionId: successorExecutionId,
				nodeId: "qa",
				attempt: 1,
			},
		});
		expect(resolvePredecessorHead).toHaveBeenCalledWith(
			"implement-1",
			"flywheel",
		);
		expect(store.listWorkflowActivationsForActor(successorExecutionId)).toEqual(
			[
				expect.objectContaining({
					mode: "spawn",
					rework_request_id: null,
				}),
			],
		);
		expect(store.getWorkflowReworkDelivery(requestId)).toMatchObject({
			state: "wake_delivered",
		});
		expect(recoverLaunch).toHaveBeenCalledWith(
			expect.objectContaining({ executionId: successorExecutionId }),
		);
		store.close();
	});

	it.each(["design", "qa"] as const)(
		"dispatches a real %s founder-rework replacement from base_revision with verbatim feedback",
		async (target) => {
			const { store, replacementId } =
				await storeWithMaterializedFounderReplacement(target);
			const fake = fakeStartDispatcher(store);
			const dispatcher = new WorkflowEngineDispatcher({
				store,
				startDispatcher: fake.dispatcher,
				env: WORKFLOW_ON,
				now: () => new Date("2026-08-15T08:02:00.000Z"),
				stateRoot: mkdtempSync(
					join(tmpdir(), `fly1772-${target}-replacement-`),
				),
				resolvePredecessorHead: vi.fn(async () => {
					throw new Error("replacement must not need a predecessor session");
				}),
			});

			expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
			expect(fake.requests).toHaveLength(1);
			expect(fake.requests[0]).toMatchObject({
				successorExecutionId: replacementId,
				sessionRole: target,
				startPoint: HEAD,
				generalizedExecution: {
					activationId: expect.any(String),
					agentContent: expect.stringContaining(
						`${target}: keep  double spaces and punctuation!`,
					),
				},
			});
			store.close();
		},
	);

	it("launches an attempt-1 root design without inventing a predecessor", async () => {
		const store = await storeWithIntent("design");
		const fake = fakeStartDispatcher(store, {
			prepareIssueDelivery: "authoritative",
		});
		const resolvePredecessorHead = vi.fn(async () => HEAD);
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			env: WORKFLOW_ON,
			now: () => new Date("2026-07-16T00:01:00.000Z"),
			stateRoot: mkdtempSync(join(tmpdir(), "fly1638-root-design-")),
			resolvePredecessorHead,
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(fake.requests).toHaveLength(1);
		expect(fake.requests[0]).toMatchObject({
			sessionRole: "design",
			generalizedExecution: {
				executionId: "design-1",
				nodeId: "design",
				attempt: 1,
			},
		});
		expect(fake.requests[0]?.startPoint).toBeUndefined();
		expect(resolvePredecessorHead).not.toHaveBeenCalled();
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "issue_delivery"),
		).toEqual([
			expect.objectContaining({
				execution_id: "design-1",
				payload: expect.objectContaining({
					body: "Pinned workflow issue body",
					ownerGeneration: 1,
					deliveryAttempt: 0,
				}),
			}),
		]);
		const startAttachment = store.listWorkflowResumeAttachments({
			runId: "run-1",
			nodeId: "design",
			attempt: 1,
		})[0]!;
		const attachmentState = store.getWorkflowResumeAttachmentState(
			startAttachment.attachment_id,
		)!;
		expect(attachmentState.resolved_anchor_commit).toBe(HEAD);
		expect(JSON.parse(attachmentState.envelope_stamped_json!)).toMatchObject({
			schemaVersion: 1,
			issueBaseline: {
				uid: "issue_input_baseline:run-1",
			},
		});
		store.close();
	});

	it("launches an attempt-1 root implement without inventing a predecessor", async () => {
		const store = await storeWithRootImplementIntent();
		const fake = fakeStartDispatcher(store, {
			prepareIssueDelivery: "authoritative",
		});
		const resolvePredecessorHead = vi.fn(async () => HEAD);
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			env: WORKFLOW_ON,
			now: () => new Date("2026-08-19T00:01:00.000Z"),
			stateRoot: mkdtempSync(join(tmpdir(), "fly1859-root-implement-")),
			resolvePredecessorHead,
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(fake.requests).toHaveLength(1);
		expect(fake.requests[0]).toMatchObject({
			sessionRole: "implement",
			generalizedExecution: {
				executionId: "simple-implement-1",
				nodeId: "implement",
				attempt: 1,
			},
		});
		expect(fake.requests[0]?.startPoint).toBeUndefined();
		expect(resolvePredecessorHead).not.toHaveBeenCalled();
		store.close();
	});

	it("marks a fallback-delivered root explicitly non-recoverable", async () => {
		const store = await storeWithIntent("design");
		const fake = fakeStartDispatcher(store, {
			prepareIssueDelivery: "fallback",
		});
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			env: WORKFLOW_ON,
			now: () => new Date("2026-07-16T00:01:00.000Z"),
			stateRoot: mkdtempSync(join(tmpdir(), "fly1707-fallback-root-")),
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		const attachment = store.listWorkflowResumeAttachments({
			runId: "run-1",
			nodeId: "design",
			attempt: 1,
		})[0]!;
		expect(
			store.getWorkflowResumeAttachmentState(attachment.attachment_id),
		).toMatchObject({ state: "invalid", invalid_reason: "input_fallback" });
		store.close();
	});

	it("dispatches an admitted replacement at the frozen anchor with resume context", async () => {
		const store = await storeWithIntent("design");
		const initial = fakeStartDispatcher(store, {
			prepareIssueDelivery: "authoritative",
		});
		expect(
			await new WorkflowEngineDispatcher({
				store,
				startDispatcher: initial.dispatcher,
				env: WORKFLOW_ON,
				now: () => new Date("2026-07-16T00:01:00.000Z"),
				stateRoot: mkdtempSync(join(tmpdir(), "fly1707-resume-initial-")),
			}).reconcile(),
		).toEqual({ started: 1, held: 0 });
		store.upsertSession({
			execution_id: "design-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "failed",
			session_role: "design",
			issue_identifier: "FLY-1307",
			issue_title: "DAG template engine",
		});
		const source = store.listWorkflowResumeAttachments({
			runId: "run-1",
			nodeId: "design",
			attempt: 1,
		})[0]!;
		(
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db.run(
			`UPDATE workflow_resume_attachment_state
			    SET state = 'ready', store_locator = '{}'
			  WHERE attachment_id = ?`,
			[source.attachment_id],
		);
		const runtime = store.getWorkflowExecutionRuntime("design-1")!;
		const admission = store.admitWorkflowResume({
			admissionKey: "resume-design-key",
			admissionDigest: "d".repeat(64),
			runId: "run-1",
			actionKind: "redispatch_execution",
			sourceAttachmentId: source.attachment_id,
			targetNodeId: "design",
			targetAttempt: 1,
			observedBodyDigest: createHash("sha256")
				.update("Pinned workflow issue body")
				.digest("hex"),
			runtimeSemanticsDigest: canonicalSubmissionDigest({
				vendor: runtime.vendor,
				model: runtime.model,
				effort: runtime.effort ?? "",
				resolvedFamily: runtime.resolved_family,
				capabilitiesDigest: runtime.capabilities_digest,
			}),
			effectiveAnchor: HEAD,
			frozenBody: "Pinned workflow issue body",
			newExecutionId: "design-resumed-2",
			now: "2026-07-16T00:02:00.000Z",
		});
		if (!admission.ok) throw new Error(admission.reason);
		expect(admission).toMatchObject({ ok: true, newAttempt: 2 });

		const resumed = fakeStartDispatcher(store);
		const resolvePredecessorHead = vi.fn(async () => {
			throw new Error("resume must use the admitted anchor");
		});
		expect(
			await new WorkflowEngineDispatcher({
				store,
				startDispatcher: resumed.dispatcher,
				env: WORKFLOW_ON,
				now: () => new Date("2026-07-16T00:03:00.000Z"),
				stateRoot: mkdtempSync(join(tmpdir(), "fly1707-resume-dispatch-")),
				resolvePredecessorHead,
			}).reconcile(),
		).toEqual({ started: 1, held: 0 });
		expect(resolvePredecessorHead).not.toHaveBeenCalled();
		expect(resumed.requests).toHaveLength(1);
		expect(resumed.requests[0]).toMatchObject({
			startPoint: HEAD,
			workflowResume: {
				runId: "run-1",
				admissionKey: "resume-design-key",
				sourceAttachmentId: source.attachment_id,
				anchorRef: source.anchor_ref,
				anchorCommit: HEAD,
				frozenBody: "Pinned workflow issue body",
			},
			generalizedExecution: {
				executionId: "design-resumed-2",
				attempt: 2,
			},
		});
		store.close();
	});

	it("sends one Lead-only alert when an admission pause stays active for five minutes", async () => {
		const store = await StateStore.create(":memory:");
		store.setAdmissionPause({
			durationSeconds: 1_800,
			setBy: "restart-services",
			reason: "deploy",
			now: "2026-08-05T12:00:00.000Z",
		});
		const alert = vi.fn(async () => ({ sent: true as const }));
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: inertStartDispatcher(),
			env: WORKFLOW_ON,
			now: () => new Date("2026-08-05T12:05:00.000Z"),
			alertSink: { current: { alert } },
		});

		await dispatcher.reconcile();
		await dispatcher.reconcile();
		expect(alert).toHaveBeenCalledOnce();
		expect(alert).toHaveBeenCalledWith(
			expect.objectContaining({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				eventType: "workflow_engine_escalation",
			}),
		);
		store.close();
	});

	it("holds an engine auto-advance before activation and credential writes while admission is paused", async () => {
		const store = await storeWithIntent("implement");
		const startDispatcher = inertStartDispatcher();
		const admissionProbe = vi.fn(() => ({
			admit: false as const,
			reason: "admission_paused" as const,
			detail: "operator deployment pause",
			retryAfterSeconds: 300,
		}));
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher,
			env: WORKFLOW_ON,
			now: () => new Date("2026-08-05T12:00:00.000Z"),
			resolvePredecessorHead: async () => HEAD,
			admissionProbe,
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 1 });
		expect(admissionProbe).toHaveBeenCalledOnce();
		expect(startDispatcher.start).not.toHaveBeenCalled();
		expect(store.getWorkflowExecutionBinding("implement-1")).toBeUndefined();
		expect(
			store.getWorkflowActivationForAttempt({
				runId: "run-1",
				nodeId: "implement",
				attempt: 1,
			}),
		).toBeUndefined();
		expect(store.listWorkflowSideEffects("run-1")[0]?.state).toBe(
			"intent_recorded",
		);
		store.close();
	});

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
			const disposition = store.recordLandLinearDoneDisposition({
				operationId,
				ownerId: claim.ownerId,
				generation: claim.generation,
				disposition: "done",
				reason: "already_completed",
				executionId: "land-exec",
				now: "2026-07-21T20:02:00.500Z",
			});
			if (!disposition.ok) throw new Error(disposition.reason);
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
		expect(store.getWorkflowShipTargetBinding("land-question")).toMatchObject({
			run_id: "run-land",
			target_repo_identity: "__main__",
			frozen_head_sha: HEAD,
			worktree_binding_generation: "generation-1",
			superseded_at: null,
		});
		expect(store.getWorkflowRun("run-land")?.status).toBe("completed");
		expect(store.getWorkflowRunNode("run-land", "land", 1)?.state).toBe("done");
		expect(store.listWorkflowSideEffects("run-land")[0]?.state).toBe("started");
		store.close();
	});

	it("holds nested-repository land authority before creating an operation", async () => {
		const store = await storeWithLandIntent();
		const db = (
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		db.run(
			`UPDATE workflow_node_pr_binding
			    SET target_repo_identity = 'geoforge3d/nested'
			  WHERE run_id = 'run-land'`,
		);
		const landExecutor = vi.fn();
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fakeStartDispatcher(store).dispatcher,
			env: WORKFLOW_ON,
			now: () => new Date("2026-07-21T20:02:00.000Z"),
			landExecutor,
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 1 });
		expect(landExecutor).not.toHaveBeenCalled();
		expect(store.getWorkflowRun("run-land")?.status).toBe("held");
		expect(store.getLandOperationForRun("run-land")).toBeUndefined();
		expect(
			store
				.listWorkflowRunEvents("run-land")
				.some((event) => event.kind === "land_held"),
		).toBe(true);
		store.close();
	});

	it.each([
		"issue_closeout_incomplete",
		"ship_workflow_pending",
		"pr_head_mismatch",
		"merge_conflict",
		"external_outage",
		"policy_alignment_pending",
		"mergeability_pending",
		"ambiguous_cool_reconcile_pending",
		"land_queue_busy",
		"land_linear_done_disposition_incomplete",
	])(
		"durably escalates land partial %s without holding the run",
		async (reason) => {
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
					error: reason,
					now: "2026-07-21T20:02:01.000Z",
				});
				return {
					status: "partial" as const,
					reason,
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
		},
	);

	it("keeps the run active while a retryable land failure waits for backoff", async () => {
		const store = await storeWithLandIntent();
		const landExecutor = vi.fn(async (operationId: string) => {
			const claim = store.claimLandOperation({
				operationId,
				ownerId: "land-test-worker",
				now: "2026-07-21T20:02:00.000Z",
				leaseExpiresAt: "2026-07-21T20:03:00.000Z",
			});
			if (!claim) throw new Error("land operation was not claimable");
			const released = store.releaseLandOperationWithRetryAccounting({
				operationId,
				ownerId: claim.ownerId,
				generation: claim.generation,
				class: "retryable",
				reason: "linear_lookup_failed_retryable",
				now: "2026-07-21T20:02:01.000Z",
			});
			if (!released) throw new Error("land release failed");
			return {
				status: "partial" as const,
				reason: released.lastError,
			};
		});
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fakeStartDispatcher(store).dispatcher,
			env: WORKFLOW_ON,
			now: () => new Date("2026-07-21T20:02:02.000Z"),
			landExecutor,
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 1 });
		expect(store.getWorkflowRun("run-land")?.status).toBe("active");
		expect(store.getLandOperationForRun("run-land")).toMatchObject({
			state: "partial",
			retry_count: 1,
			next_attempt_at: "2026-07-21T20:03:01.000Z",
		});
		store.close();
	});

	it("self-heals a one-shot Linear arbitration failure through the full land cascade", async () => {
		const store = await storeWithLandIntent();
		let now = new Date("2026-07-21T20:02:00.000Z");
		let finalizeAttempt = 0;
		const finalize = vi.fn(async (operation) => {
			finalizeAttempt += 1;
			if (finalizeAttempt === 1) {
				return {
					complete: false,
					outcome: "partial" as const,
					reason: "arbitration_failed:linear timeout",
				};
			}
			if (!operation.owner_id) throw new Error("land owner missing");
			const disposition = store.recordLandLinearDoneDisposition({
				operationId: operation.operation_id,
				ownerId: operation.owner_id,
				generation: operation.generation,
				disposition: "done",
				reason: "already_completed",
				executionId: "land-exec",
				now: now.toISOString(),
			});
			if (!disposition.ok) throw new Error(disposition.reason);
			return {
				complete: true,
				outcome: "completed" as const,
				details: {
					worktreeRemoved: true,
					threadArchived: true,
					linearDoneDisposition: "done",
				},
			};
		});
		const landExecutor = (operationId: string) =>
			executeLandOperation(operationId, {
				store,
				mergeDriver: {
					inspectPr: vi.fn().mockResolvedValue({
						state: "MERGED",
						headSha: HEAD,
						mergeSha: "b".repeat(40),
					}),
					triggerCool: vi.fn(),
					inspectTriggeredWorkflow: vi.fn(),
				},
				finalize,
				authorize: () => ({ ok: true }),
				ownerId: "land-test-worker",
				now: () => now,
			});
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fakeStartDispatcher(store).dispatcher,
			env: WORKFLOW_ON,
			now: () => now,
			landExecutor,
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 1 });
		expect(store.getWorkflowRun("run-land")?.status).toBe("active");
		expect(store.getLandOperationForRun("run-land")).toMatchObject({
			state: "partial",
			retry_count: 1,
			next_attempt_at: "2026-07-21T20:03:00.000Z",
		});

		now = new Date("2026-07-21T20:02:59.999Z");
		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 1 });
		expect(finalize).toHaveBeenCalledTimes(1);
		expect(store.getWorkflowRun("run-land")?.status).toBe("active");

		now = new Date("2026-07-21T20:03:00.000Z");
		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(finalize).toHaveBeenCalledTimes(2);
		expect(store.getWorkflowRun("run-land")?.status).toBe("completed");
		expect(store.getLandOperationForRun("run-land")).toMatchObject({
			state: "completed",
			linear_done_disposition: "done",
			finalization_completed_at: "2026-07-21T20:03:00.000Z",
		});
		store.close();
	});

	it("completes the run with local cleanup when Linear Done remains deferred", async () => {
		const store = await storeWithLandIntent();
		const now = new Date("2026-07-21T20:02:00.000Z");
		const landExecutor = (operationId: string) =>
			executeLandOperation(operationId, {
				store,
				mergeDriver: {
					inspectPr: vi.fn().mockResolvedValue({
						state: "MERGED",
						headSha: HEAD,
						mergeSha: "b".repeat(40),
					}),
					triggerCool: vi.fn(),
					inspectTriggeredWorkflow: vi.fn(),
				},
				finalize: async (operation) => {
					if (!operation.owner_id) throw new Error("land owner missing");
					const disposition = store.recordLandLinearDoneDisposition({
						operationId: operation.operation_id,
						ownerId: operation.owner_id,
						generation: operation.generation,
						disposition: "deferred",
						reason: "linear offline",
						executionId: "land-exec",
						now: now.toISOString(),
						alertIdentity: {
							leadId: "flywheel-eng-lead",
							projectName: "flywheel",
							leadResolution: "resolved",
						},
					});
					if (!disposition.ok) throw new Error(disposition.reason);
					return {
						complete: true,
						outcome: "completed" as const,
						details: {
							worktreeRemoved: true,
							threadArchived: true,
							linearDoneDisposition: "deferred",
						},
					};
				},
				authorize: () => ({ ok: true }),
				ownerId: "land-test-worker",
				now: () => now,
			});
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fakeStartDispatcher(store).dispatcher,
			env: WORKFLOW_ON,
			now: () => now,
			landExecutor,
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(store.getWorkflowRun("run-land")?.status).toBe("completed");
		const operation = store.getLandOperationForRun("run-land")!;
		expect(operation).toMatchObject({
			state: "completed",
			linear_done_disposition: "deferred",
			linear_done_last_reason: "linear offline",
		});
		expect(
			store.getWorkflowAlertOutbox(
				`linear_done_deferred:${operation.operation_id}`,
			),
		).toMatchObject({ state: "pending" });
		store.close();
	});

	it.each([
		["v1", "FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH"],
		["v1", "FLYWHEEL_WORKFLOW_CLAIMS_WRITE"],
		["v1", "FLYWHEEL_WORKFLOW_CLAIMS_READ"],
	] as const)(
		"converges an existing %s successor despite retired %s=0",
		async (schema, disabled) => {
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
			env[disabled] = "0";
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

			expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
			expect(start).not.toHaveBeenCalled();
			expect(store.listNonTerminalWorkflowSideEffects()).toEqual([]);
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
		const scan = vi.spyOn(store, "listWorkflowReworkDeliveries");
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
		expect(scan).toHaveBeenCalledWith({
			states: [
				"pending",
				"turn_granted",
				"awaiting_receipt",
				"wake_delivered",
				"held",
			],
			now: expect.any(String),
		});
		expect(fake.start).not.toHaveBeenCalled();
		expect(
			store
				.listWorkflowSideEffects("run-1")
				.filter((row) => row.node_id === "implement" && row.attempt === 2),
		).toHaveLength(0);
		store.close();
	});

	it("pauses the stall clock durably and keeps pause alerts distinct from genuine stalls", async () => {
		const store = await storeWithQaFailKickback();
		const fake = fakeStartDispatcher(store);
		const requestId = store.listWorkflowReworkDeliveries()[0]!.request_id;
		const before = store.getWorkflowReworkDelivery(requestId);
		let paused = true;
		let now = new Date("2026-07-16T00:11:00.000Z");
		const env = {
			...WORKFLOW_ON,
			FLYWHEEL_WORKFLOW_REWORK_REENTRY: "0",
			FLYWHEEL_ENGINE_REWORK_ALERT_MS: "1000",
			FLYWHEEL_ENGINE_REWORK_HOLD_MS: "5000",
		};
		const reconcileWorkflowRework = vi.fn(async () =>
			paused
				? {
						kind: "disabled" as const,
						reason: "rework_reentry_disabled" as const,
					}
				: { kind: "busy" as const },
		);
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			env,
			workflowReworkReentryEnabled: () =>
				env.FLYWHEEL_WORKFLOW_REWORK_REENTRY !== "0",
			now: () => now,
			reconcileWorkflowRework,
			resolveRunAlertIdentity: () => ({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			}),
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 1 });
		now = new Date("2026-07-16T02:11:00.000Z");
		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 1 });
		expect(store.getWorkflowReworkDelivery(requestId)).toEqual(before);
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "rework_delivery_claimed"),
		).toEqual([]);
		expect(store.listWorkflowAlertOutbox()).toHaveLength(1);
		expect(store.listWorkflowAlertOutbox()[0]?.payload).toMatchObject({
			eventType: "workflow_engine_escalation",
			title: "Workflow rework re-entry paused by operator for FLY-1307",
		});
		expect(store.listWorkflowAlertOutbox()[0]?.payload.body).toContain(
			"will resume when re-entry is enabled",
		);

		paused = false;
		env.FLYWHEEL_WORKFLOW_REWORK_REENTRY = "1";
		now = new Date("2026-07-16T02:11:00.100Z");
		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 0 });
		expect(store.getWorkflowReworkDelivery(requestId)).toEqual(before);
		expect(store.listWorkflowAlertOutbox()).toHaveLength(2);
		expect(store.listWorkflowAlertOutbox()[1]?.payload).toMatchObject({
			eventType: "workflow_engine_escalation",
			severity: "warning",
			title: "Workflow rework re-entry resumed for FLY-1307",
		});

		now = new Date("2026-07-16T02:11:01.600Z");
		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 0 });
		expect(store.getWorkflowReworkDelivery(requestId)).toEqual(before);
		expect(store.listWorkflowAlertOutbox()).toHaveLength(3);
		expect(
			store.listWorkflowAlertOutbox().map((row) => row.escalation_uid),
		).toEqual([
			expect.stringContaining("rework_reentry_paused:"),
			expect.stringContaining("rework_reentry_resumed:"),
			expect.stringContaining("rework_stalled_alert:"),
		]);
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "rework_activation_stalled_alerted"),
		).toHaveLength(1);

		paused = true;
		env.FLYWHEEL_WORKFLOW_REWORK_REENTRY = "0";
		now = new Date("2026-07-16T02:12:00.000Z");
		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 1 });
		now = new Date("2026-07-16T04:12:00.000Z");
		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 1 });
		expect(store.getWorkflowReworkDelivery(requestId)).toEqual(before);

		paused = false;
		env.FLYWHEEL_WORKFLOW_REWORK_REENTRY = "1";
		now = new Date("2026-07-16T04:12:00.100Z");
		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 0 });
		expect(store.getWorkflowReworkDelivery(requestId)).toEqual(before);
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "rework_activation_paused")
				.map((event) => event.event_uid),
		).toEqual([
			expect.stringContaining("episode1"),
			expect.stringContaining("episode2"),
		]);
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "rework_activation_resumed")
				.map((event) => event.event_uid),
		).toEqual([
			expect.stringContaining("episode1"),
			expect.stringContaining("episode2"),
		]);

		now = new Date("2026-07-16T04:12:06.000Z");
		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 0 });
		expect(store.getWorkflowReworkDelivery(requestId)?.state).toBe("held");
		expect(fake.start).not.toHaveBeenCalled();
		store.close();
	});

	it("uses the inherited environment for the re-entry kill switch", async () => {
		vi.stubEnv("FLYWHEEL_WORKFLOW_REWORK_REENTRY", "0");
		const store = await storeWithQaFailKickback();
		try {
			const fake = fakeStartDispatcher(store);
			const reconcileWorkflowRework = vi.fn(async () => ({
				kind: "disabled" as const,
				reason: "rework_reentry_disabled" as const,
			}));
			const dispatcher = new WorkflowEngineDispatcher({
				store,
				startDispatcher: fake.dispatcher,
				workflowReworkReentryEnabled: () =>
					process.env.FLYWHEEL_WORKFLOW_REWORK_REENTRY !== "0",
				now: () => new Date("2026-07-16T00:11:00.000Z"),
				reconcileWorkflowRework,
				resolveRunAlertIdentity: () => ({
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				}),
			});

			expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 1 });
			expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 1 });
			expect(
				store
					.listWorkflowRunEvents("run-1")
					.filter((event) => event.kind === "rework_activation_paused"),
			).toHaveLength(1);
			expect(
				store
					.listWorkflowRunEvents("run-1")
					.filter((event) => event.kind === "rework_activation_resumed"),
			).toEqual([]);
		} finally {
			store.close();
			vi.unstubAllEnvs();
		}
	});

	it("mints a fresh launch only after the coordinator proves the actor dead", async () => {
		const store = await storeWithQaFailKickback();
		const fake = fakeStartDispatcher(store);
		const requestId = store.listWorkflowReworkDeliveries()[0]!.request_id;
		const routeBefore = store.getLatestWorkflowReworkRoute(requestId)!;
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
		expect(store.getLatestWorkflowReworkRoute(requestId)).toMatchObject({
			revision: routeBefore.revision + 1,
			preferred_actor_execution_id: launched,
		});
		expect(reconcileWorkflowRework.mock.calls[0]?.[0]).toBe(requestId);
		expect(store.getWorkflowReworkDelivery(requestId)).toMatchObject({
			state: "wake_delivered",
			next_retry_at: "2026-07-16T00:19:00.000Z",
		});
		store.close();
	});

	it("FLY-1596 anchor: recovers a held targetless rework after terminal and dead-process evidence", async () => {
		const store = await storeWithQaFailKickback();
		const fake = fakeStartDispatcher(store);
		const requestId = store.listWorkflowReworkDeliveries()[0]!.request_id;
		const failureTimes = [11, 12, 14, 18, 26].map(
			(minute) => `2026-07-16T00:${minute}:00.000Z`,
		);
		for (const now of failureTimes) {
			const claim = store.claimWorkflowReworkDelivery({
				requestId,
				ownerId: "coordinator",
				now,
				leaseExpiresAt: new Date(Date.parse(now) + 30_000).toISOString(),
			});
			if (!claim.ok) throw new Error(claim.reason);
			expect(
				store.settleWorkflowReworkFailure({
					requestId,
					ownerId: "coordinator",
					generation: claim.generation,
					reason: "persisted_target_missing",
					onExhausted: "handoff_held_pane_loss",
					alertIdentity: {
						leadId: "flywheel-eng-lead",
						projectName: "flywheel",
						leadResolution: "resolved",
					},
					now,
				}),
			).toMatchObject({ ok: true });
		}
		expect(store.getWorkflowRun("run-1")?.status).toBe("held");
		expect(store.getWorkflowReworkDelivery(requestId)).toMatchObject({
			state: "held",
			last_error: "persisted_target_missing",
			hold_count: 0,
		});
		const reconcileWorkflowRework = vi.fn(async () => ({
			kind: "busy" as const,
		}));
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1628-held-rework-")),
			env: WORKFLOW_ON,
			now: () => new Date("2026-07-16T00:30:00.000Z"),
			resolvePredecessorHead: async () => HEAD,
			probeLaunchLiveness: async () => "dead",
			reconcileWorkflowRework,
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(reconcileWorkflowRework).not.toHaveBeenCalled();
		expect(fake.start).toHaveBeenCalledOnce();
		const launched = fake.requests[0]?.generalizedExecution?.executionId;
		expect(launched).toEqual(expect.any(String));
		expect(launched).not.toBe("implement-1");
		expect(store.getWorkflowRun("run-1")?.status).toBe("active");
		expect(store.getWorkflowRunNode("run-1", "implement", 2)).toMatchObject({
			state: "running",
			execution_id: launched,
		});
		expect(store.getWorkflowReworkDelivery(requestId)).toMatchObject({
			state: "wake_delivered",
			hold_count: 0,
			next_retry_at: "2026-07-16T00:33:00.000Z",
		});
		expect(
			store
				.listWorkflowAlertOutbox()
				.map((row) => row.payload.metadata.workflowEngine.disposition),
		).toEqual(["rework_pane_loss_handoff", "rework_stall_recovered"]);
		expect(store.listWorkflowAlertOutbox()[1]?.payload).toMatchObject({
			severity: "warning",
			metadata: {
				workflowEngine: {
					disposition: "rework_stall_recovered",
					leadResolution: "fallback",
				},
			},
		});
		store.close();
	});

	it("keeps a held targetless rework frozen while its actor may still be alive", async () => {
		const store = await storeWithQaFailKickback();
		const fake = fakeStartDispatcher(store);
		const requestId = store.listWorkflowReworkDeliveries()[0]!.request_id;
		const db = (
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		db.run("UPDATE workflow_run SET status = 'held' WHERE run_id = 'run-1'");
		db.run(
			`UPDATE workflow_rework_delivery
			    SET state = 'held', last_error = 'persisted_target_missing'
			  WHERE request_id = ?`,
			[requestId],
		);
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			env: WORKFLOW_ON,
			probeLaunchLiveness: async () => "alive",
			reconcileWorkflowRework: async () => ({ kind: "busy" }),
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 1 });
		expect(fake.start).not.toHaveBeenCalled();
		expect(store.getWorkflowRun("run-1")?.status).toBe("held");
		expect(store.getWorkflowReworkDelivery(requestId)).toMatchObject({
			state: "held",
			last_error: "persisted_target_missing",
		});
		store.close();
	});

	it("contains a held pane-loss replacement CAS failure to that delivery", async () => {
		const store = await storeWithQaFailKickback();
		const fake = fakeStartDispatcher(store);
		const requestId = store.listWorkflowReworkDeliveries()[0]!.request_id;
		const db = (
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		db.run("UPDATE workflow_run SET status = 'held' WHERE run_id = 'run-1'");
		db.run(
			`UPDATE workflow_rework_delivery
			    SET state = 'held', last_error = 'persisted_target_missing'
			  WHERE request_id = ?`,
			[requestId],
		);
		vi.spyOn(store, "materializeWorkflowReworkReplacement").mockImplementation(
			() => {
				throw new Error("synthetic pane-loss CAS failure");
			},
		);
		const log = vi.fn();
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			env: WORKFLOW_ON,
			probeLaunchLiveness: async () => "dead",
			reconcileWorkflowRework: async () => ({ kind: "busy" }),
			log,
		});

		await expect(dispatcher.reconcile()).resolves.toEqual({
			started: 0,
			held: 1,
		});
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("synthetic pane-loss CAS failure"),
		);
		store.close();
	});

	it("stops probing and materializing a permanently failing held rework after five due attempts", async () => {
		const store = await storeWithQaFailKickback();
		const fake = fakeStartDispatcher(store);
		const requestId = store.listWorkflowReworkDeliveries()[0]!.request_id;
		const db = (
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		db.run("UPDATE workflow_run SET status = 'held' WHERE run_id = 'run-1'");
		db.run(
			`UPDATE workflow_rework_delivery
			    SET state = 'held', last_error = 'persisted_target_missing'
			  WHERE request_id = ?`,
			[requestId],
		);
		db.run(
			`UPDATE workflow_run_node SET state = 'failed', ended_at = ?
			  WHERE run_id = 'run-1' AND node_id = 'implement' AND attempt = 2`,
			["2026-07-16T00:20:00.000Z"],
		);
		let now = "2026-07-16T00:30:00.000Z";
		const probeLaunchLiveness = vi.fn(async () => "dead" as const);
		const materialize = vi.spyOn(store, "materializeWorkflowReworkReplacement");
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			env: WORKFLOW_ON,
			now: () => new Date(now),
			probeLaunchLiveness,
			reconcileWorkflowRework: async () => ({ kind: "busy" }),
		});

		for (const minute of [30, 31, 33, 37, 45]) {
			now = `2026-07-16T00:${minute}:00.000Z`;
			await expect(dispatcher.reconcile()).resolves.toEqual({
				started: 0,
				held: 1,
			});
		}
		expect(store.getWorkflowReworkDelivery(requestId)).toMatchObject({
			state: "needs_lead",
			hold_count: 5,
			next_retry_at: null,
			last_error: "rework_replacement_target_changed",
		});
		expect(probeLaunchLiveness).toHaveBeenCalledTimes(5);
		expect(materialize).toHaveBeenCalledTimes(5);

		now = "2026-07-17T00:45:00.000Z";
		await expect(dispatcher.reconcile()).resolves.toEqual({
			started: 0,
			held: 0,
		});
		expect(probeLaunchLiveness).toHaveBeenCalledTimes(5);
		expect(materialize).toHaveBeenCalledTimes(5);
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
			lease_expires_at: "2026-07-16T00:16:00.000Z",
			released_generation: 1,
			released_reason:
				"dispatcher_start_failed:synthetic replacement prelaunch failure",
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
			now: () => new Date("2026-07-16T00:22:00.000Z"),
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
			FLYWHEEL_ENGINE_REWORK_ALERT_MS: "1000",
			FLYWHEEL_ENGINE_REWORK_HOLD_MS: "2000",
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

	it("keeps a post-ACK wake_delivered delivery under the durable stall owner", async () => {
		const store = await storeWithQaFailKickback();
		const delivery = store.listWorkflowReworkDeliveries()[0];
		if (!delivery) throw new Error("rework delivery missing");
		const db = (
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		db.run(
			`UPDATE workflow_rework_delivery
			    SET state = 'wake_delivered', generation = 2,
			        next_retry_at = '2026-07-16T01:00:00.000Z',
			        updated_at = '2026-07-16T00:12:00.000Z'
			  WHERE request_id = ?`,
			[delivery.request_id],
		);
		db.run(
			`UPDATE workflow_run_node SET state = 'running'
			  WHERE run_id = 'run-1' AND node_id = 'implement' AND attempt = 2`,
		);
		db.run(
			"UPDATE sessions SET status = 'running' WHERE execution_id = 'implement-1'",
		);
		const reconcileWorkflowRework = vi.fn(async () => ({
			kind: "receipt_pending" as const,
			state: "wake_delivered" as const,
			executionId: "implement-1",
		}));
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fakeStartDispatcher(store).dispatcher,
			env: {
				...WORKFLOW_ON,
				FLYWHEEL_ENGINE_REWORK_ALERT_MS: "1000",
				FLYWHEEL_ENGINE_REWORK_HOLD_MS: "3600000",
			},
			now: () => new Date("2026-07-16T00:20:00.000Z"),
			reconcileWorkflowRework,
			resolveRunAlertIdentity: () => ({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			}),
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 0 });
		// Delivery pacing is in the future, so the delivery coordinator does not
		// probe yet; the independent stall owner must still observe it.
		expect(reconcileWorkflowRework).not.toHaveBeenCalled();
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "rework_activation_stalled_alerted"),
		).toHaveLength(1);
		expect(store.getWorkflowReworkDelivery(delivery.request_id)).toMatchObject({
			state: "wake_delivered",
			updated_at: "2026-07-16T00:12:00.000Z",
		});
		store.close();
	});

	it("keeps the genuine stall clock for a stranded replacement_pending delivery", async () => {
		const store = await storeWithQaFailKickback();
		const delivery = store.listWorkflowReworkDeliveries()[0];
		if (!delivery) throw new Error("rework delivery missing");
		const db = (
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		db.run(
			`UPDATE workflow_rework_delivery
			    SET state = 'replacement_pending', updated_at = ?
			  WHERE request_id = ?`,
			["2026-07-16T00:10:00.000Z", delivery.request_id],
		);
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fakeStartDispatcher(store).dispatcher,
			env: {
				...WORKFLOW_ON,
				FLYWHEEL_WORKFLOW_REWORK_REENTRY: "0",
				FLYWHEEL_ENGINE_REWORK_ALERT_MS: "1000",
				FLYWHEEL_ENGINE_REWORK_HOLD_MS: "2000",
			},
			now: () => new Date("2026-07-16T00:20:00.000Z"),
			reconcileWorkflowRework: vi.fn(async () => ({ kind: "busy" as const })),
			resolveRunAlertIdentity: () => ({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			}),
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 0 });
		expect(store.getWorkflowReworkDelivery(delivery.request_id)).toMatchObject({
			state: "held",
			last_error: "delivery_replacement_pending",
		});
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

	it("does not let the legacy stall timer race a budget-managed rework", async () => {
		const store = await storeWithQaFailKickback();
		const delivery = store.listWorkflowReworkDeliveries({
			states: ["pending"],
			now: "2026-07-16T00:11:00.000Z",
		})[0];
		if (!delivery) throw new Error("pending rework missing");
		const claim = store.claimWorkflowReworkDelivery({
			requestId: delivery.request_id,
			ownerId: "budget-owner",
			now: "2026-07-16T00:11:00.000Z",
			leaseExpiresAt: "2026-07-16T00:11:30.000Z",
		});
		if (!claim.ok) throw new Error(claim.reason);
		expect(
			store.settleWorkflowReworkFailure({
				requestId: delivery.request_id,
				ownerId: "budget-owner",
				generation: claim.generation,
				reason: "actor_session_missing",
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
				now: "2026-07-16T00:11:00.000Z",
			}),
		).toMatchObject({ ok: true, holdCount: 1 });
		const fake = fakeStartDispatcher(store);
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			env: {
				...WORKFLOW_ON,
				FLYWHEEL_ENGINE_REWORK_ALERT_MS: "1000",
				FLYWHEEL_ENGINE_REWORK_HOLD_MS: "2000",
			},
			now: () => new Date("2026-07-16T00:20:00.000Z"),
			reconcileWorkflowRework: vi.fn(async () => ({ kind: "busy" as const })),
			resolveRunAlertIdentity: () => ({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			}),
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 0 });
		expect(store.getWorkflowRun("run-1")?.status).toBe("active");
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind.startsWith("rework_activation_stalled_")),
		).toEqual([]);
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

	it("fences, cleans, and verifies a persisted exact precommit window before rollback", async () => {
		const store = await storeWithIntent("implement");
		const start = vi.fn(async () => {
			throw new Error("synthetic prelaunch failure");
		});
		const startDispatcher = {
			start,
			getInflightCount: () => 0,
			validateAgentName: () => ({ ok: true as const }),
		} as IStartDispatcher;
		const stateRoot = mkdtempSync(join(tmpdir(), "fly1638-exact-window-"));
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
		const fingerprint = "f".repeat(64);
		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-X",
			project_name: "flywheel",
			status: "running",
			session_params: JSON.stringify({
				pane_loss_generation: {
					socket_path: "/tmp/flywheel.sock",
					server_start_time: "123",
					window_id: "@7",
					execution_id: "implement-1",
					launch_generation: 1,
					launch_fingerprint: fingerprint,
				},
			}),
		});
		const cleanup = vi.fn(async () => "cleaned" as const);
		expect(
			await new WorkflowEngineDispatcher({
				store,
				startDispatcher,
				stateRoot,
				env,
				now: () => new Date("2026-07-16T01:08:00.000Z"),
				resolvePredecessorHead: async () => HEAD,
				probeUnlaunchedExternalEvidence: async () => "present",
				cleanupUnlaunchedWorkflowWindow: cleanup,
				resolveRunAlertIdentity: () => ({
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				}),
			}).reconcile(),
		).toEqual({ started: 0, held: 0 });
		expect(cleanup).toHaveBeenCalledWith({
			socketPath: "/tmp/flywheel.sock",
			serverStartTime: "123",
			windowId: "@7",
			executionId: "implement-1",
			launchGeneration: 1,
			launchFingerprint: fingerprint,
		});
		expect(store.getWorkflowRun("run-1")?.status).toBe("held");
		expect(store.getSession("implement-1")?.status).toBe("failed");
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
		const liveManifest = structuredClone(
			legacyWorkflowSeeds().find(
				(candidate) => candidate.templateId === "tpl_eng_heavy",
			)!.manifest,
		);
		liveManifest.nodes.find(
			(node) => node.id === "qa",
		)!.submissionWindowMinutes = 30;
		expect(
			store.createAndPublishWorkflowTemplateRevision({
				templateId: "tpl_eng_heavy",
				manifest: liveManifest,
				expectedRevision: 1,
				createdBy: "founder",
			}),
		).toMatchObject({ status: "published" });
		const fake = fakeStartDispatcher(store);
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1307-engine-qa-")),
			env: WORKFLOW_ON,
			now: () => new Date("2026-07-16T00:10:00.000Z"),
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
		expect(
			store.getWorkflowSubmissionCredentialByToken(
				fake.requests[0]!.generalizedExecution!.submissionCredential!,
			),
		).toMatchObject({
			expires_at: "2026-07-16T03:10:00.000Z",
			absolute_deadline_at: "2026-07-17T00:10:00.000Z",
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
		expect(
			store.getWorkflowSubmissionCredentialByToken(
				fake.requests[0]!.generalizedExecution!.submissionCredential!,
			),
		).toMatchObject({
			expires_at: "2026-07-16T03:12:00.000Z",
			absolute_deadline_at: "2026-07-17T00:11:00.000Z",
		});
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
			expiresAt: "2026-07-16T00:12:30.000Z",
			absoluteDeadlineAt: "2026-07-16T00:13:00.000Z",
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
		expect(
			store.getWorkflowSubmissionCredentialByToken(
				fake.requests[0]!.generalizedExecution!.submissionCredential!,
			),
		).toMatchObject({
			expires_at: "2026-07-16T00:13:00.000Z",
			absolute_deadline_at: "2026-07-16T00:13:00.000Z",
		});
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

	it("holds a completed session with no receipt and never respawns it", async () => {
		const store = await storeWithIntent("implement");
		const fake = fakeStartDispatcher(store);
		const probeLaunchLiveness = vi.fn(async () => "dead" as const);
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1638-completed-no-receipt-")),
			env: WORKFLOW_ON,
			now: () => new Date("2099-07-22T00:00:00.000Z"),
			resolvePredecessorHead: async () => HEAD,
			probeLaunchLiveness,
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
			status: "completed",
			workflow_node_id: "implement",
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 0 });
		expect(probeLaunchLiveness).not.toHaveBeenCalled();
		expect(fake.requests).toHaveLength(1);
		expect(store.getWorkflowRun("run-1")?.status).toBe("held");
		expect(store.getWorkflowRunNode("run-1", "implement", 1)).toMatchObject({
			state: "running",
			execution_id: "implement-1",
		});
		expect(store.listWorkflowSideEffects("run-1")).toHaveLength(1);
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "completion_receipt_missing"),
		).toHaveLength(1);
		const alerts = store.listWorkflowAlertOutbox();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]?.payload.metadata.workflowEngine).toMatchObject({
			runId: "run-1",
			nodeId: "implement",
			executionId: "implement-1",
			disposition: "completion_receipt_missing",
		});

		// Fresh Bridge instances observe held and cannot create another launch.
		const restarted = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1638-completed-restart-")),
			env: WORKFLOW_ON,
			resolvePredecessorHead: async () => HEAD,
			probeLaunchLiveness,
		});
		expect(await restarted.reconcile()).toEqual({ started: 0, held: 0 });
		expect(
			await new WorkflowEngineDispatcher({
				store,
				startDispatcher: fake.dispatcher,
				stateRoot: mkdtempSync(join(tmpdir(), "fly1638-completed-restart-2-")),
				env: WORKFLOW_ON,
				resolvePredecessorHead: async () => HEAD,
				probeLaunchLiveness,
			}).reconcile(),
		).toEqual({ started: 0, held: 0 });
		expect(fake.requests).toHaveLength(1);
		expect(store.listWorkflowAlertOutbox()).toHaveLength(1);
		store.close();
	});

	it("gives a ready resume target one durable bounded window before dead-exec replacement", async () => {
		const store = await storeWithIntent("design");
		const env = { ...WORKFLOW_ON, FLYWHEEL_WORKFLOW_RESUME: "1" };
		const initial = fakeStartDispatcher(store, {
			prepareIssueDelivery: "authoritative",
		});
		expect(
			await new WorkflowEngineDispatcher({
				store,
				startDispatcher: initial.dispatcher,
				env,
				workflowResumeEnabled: () => env.FLYWHEEL_WORKFLOW_RESUME === "1",
				now: () => new Date("2026-07-16T00:01:00.000Z"),
				stateRoot: mkdtempSync(join(tmpdir(), "fly1707-resume-window-start-")),
			}).reconcile(),
		).toEqual({ started: 1, held: 0 });
		const source = store.listWorkflowResumeAttachments({
			runId: "run-1",
			nodeId: "design",
			attempt: 1,
		})[0]!;
		(
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db.run(
			`UPDATE workflow_resume_attachment_state
			    SET state = 'ready', store_locator = '{}'
			  WHERE attachment_id = ?`,
			[source.attachment_id],
		);
		store.upsertSession({
			execution_id: "design-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "failed",
			workflow_node_id: "design",
		});

		const replacement = fakeStartDispatcher(store);
		const base = deadExecEngineClockBaseMs();
		const identity = (projectName: string) => ({
			leadId: "flywheel-eng-lead",
			projectName,
			leadResolution: "resolved" as const,
		});
		expect(
			await new WorkflowEngineDispatcher({
				store,
				startDispatcher: replacement.dispatcher,
				env,
				workflowResumeEnabled: () => env.FLYWHEEL_WORKFLOW_RESUME === "1",
				now: () => new Date(base),
				stateRoot: mkdtempSync(join(tmpdir(), "fly1707-resume-window-open-")),
				resolvePredecessorHead: async () => HEAD,
				probeLaunchLiveness: async () => "dead",
				captureDeadExecutionActivityBaseline: async () => ({
					commitMarker: { state: "absent" as const },
					commDbMessageCount: 0,
					tmuxTarget: null,
					tmuxOutputDigest: null,
					sessionCommitCount: 0,
				}),
				resolveRunAlertIdentity: identity,
			}).reconcile(),
		).toEqual({ started: 0, held: 0 });
		expect(replacement.requests).toHaveLength(0);
		const opened = store
			.listWorkflowRunEvents("run-1")
			.filter((event) => event.kind === "resume_first_window_opened");
		expect(opened).toHaveLength(1);
		expect(store.listWorkflowAlertOutbox()).toHaveLength(1);

		expect(
			await new WorkflowEngineDispatcher({
				store,
				startDispatcher: replacement.dispatcher,
				env,
				workflowResumeEnabled: () => env.FLYWHEEL_WORKFLOW_RESUME === "1",
				now: () => new Date(base + 9 * 60_000),
				stateRoot: mkdtempSync(
					join(tmpdir(), "fly1707-resume-window-restart-"),
				),
				resolvePredecessorHead: async () => HEAD,
				probeLaunchLiveness: async () => "dead",
				captureDeadExecutionActivityBaseline: async () => ({
					commitMarker: { state: "absent" as const },
					commDbMessageCount: 0,
					tmuxTarget: null,
					tmuxOutputDigest: null,
					sessionCommitCount: 0,
				}),
				resolveRunAlertIdentity: identity,
			}).reconcile(),
		).toEqual({ started: 0, held: 0 });
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "resume_first_window_opened"),
		).toHaveLength(1);

		expect(
			await new WorkflowEngineDispatcher({
				store,
				startDispatcher: replacement.dispatcher,
				env,
				workflowResumeEnabled: () => env.FLYWHEEL_WORKFLOW_RESUME === "1",
				now: () => new Date(base + 10 * 60_000),
				stateRoot: mkdtempSync(
					join(tmpdir(), "fly1707-resume-window-expired-"),
				),
				resolvePredecessorHead: async () => HEAD,
				probeLaunchLiveness: async () => "dead",
				captureDeadExecutionActivityBaseline: async () => ({
					commitMarker: { state: "absent" as const },
					commDbMessageCount: 0,
					tmuxTarget: null,
					tmuxOutputDigest: null,
					sessionCommitCount: 0,
				}),
				resolveRunAlertIdentity: identity,
			}).reconcile(),
		).toEqual({ started: 1, held: 0 });
		expect(replacement.requests).toHaveLength(1);
		store.close();
	});

	it.each(["completed", "failed"] as const)(
		"suppresses dead-execution recovery for a fresh operator close intent on %s",
		async (status) => {
			const store = await storeWithIntent("implement");
			const fake = fakeStartDispatcher(store);
			const clock = new Date(deadExecEngineClockBaseMs());
			const dispatcher = new WorkflowEngineDispatcher({
				store,
				startDispatcher: fake.dispatcher,
				stateRoot: mkdtempSync(join(tmpdir(), "fly1707-close-intent-")),
				env: WORKFLOW_ON,
				now: () => clock,
				resolvePredecessorHead: async () => HEAD,
				probeLaunchLiveness: async () => "dead",
			});
			expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
			store.upsertSession({
				execution_id: "implement-1",
				issue_id: "FLY-1307",
				project_name: "flywheel",
				status,
				workflow_node_id: "implement",
			});
			expect(
				store.prepareWorkflowOperatorCloseIntent({
					executionId: "implement-1",
					mode: "done",
					reason: "operator close",
					now: clock.toISOString(),
				}),
			).toMatchObject({ ok: true });

			expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 0 });
			expect(store.getWorkflowRun("run-1")?.status).toBe("active");
			expect(fake.requests).toHaveLength(1);
			expect(store.getWorkflowRunNode("run-1", "implement", 1)).toMatchObject({
				state: "running",
				execution_id: "implement-1",
			});
			store.close();
		},
	);

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
				startPoint: fake.requests[0]?.startPoint,
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
			startPoint: HEAD,
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
});
