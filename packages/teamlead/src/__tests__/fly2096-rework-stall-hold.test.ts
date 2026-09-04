import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { CommDB } from "flywheel-comm/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IStartDispatcher } from "../bridge/retry-dispatcher.js";
import { WorkflowEngineDispatcher } from "../bridge/workflow-engine-dispatcher.js";
import { StateStore } from "../StateStore.js";
import {
	legacyWorkflowSeeds,
	pinLegacyWorkflowSeedAgents,
} from "./fixtures/legacy-workflow-manifests.js";

const HEAD = "a".repeat(40);
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const REQUEST_ID = "fly2096-rework";
const DEAD_EXECUTION_ID = "qa-1";
const REPLACEMENT_ID = "qa-replacement-2";
const T0 = "2026-08-27T19:28:15.000Z";
const WORKFLOW_ON = {
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
};
const at = (minutes: number) =>
	new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const hasLivenessModule = await import(
	"../bridge/delivery-contract/liveness.js"
).then(
	() => true,
	() => false,
);

const stores: StateStore[] = [];
const commDbs: CommDB[] = [];

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const commDb of commDbs.splice(0)) commDb.close();
});

function rawDb(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}

function dbRun(store: StateStore, sql: string, params: unknown[] = []): void {
	(
		store as unknown as {
			db: { run(statement: string, values?: unknown[]): void };
		}
	).db.run(sql, params);
}

function currentReworkAttempt(
	store: StateStore,
	requestId = REQUEST_ID,
): {
	attempt_id: string;
	contract_ref_json: string;
	received_at: string | null;
	settlement_reason: string | null;
} {
	const attempts = rawDb(store)
		.prepare(
			`SELECT attempt_id, contract_ref_json, received_at, settlement_reason
			   FROM workflow_delivery_attempt
			  WHERE family = 'rework'
			    AND json_extract(contract_ref_json, '$.table') = 'workflow_rework_delivery'
			    AND json_extract(contract_ref_json, '$.pk') = ?
			    AND superseded_by_attempt_id IS NULL`,
		)
		.all(requestId) as Array<{
		attempt_id: string;
		contract_ref_json: string;
		received_at: string | null;
		settlement_reason: string | null;
	}>;
	expect(attempts).toHaveLength(1);
	return attempts[0]!;
}

function targetEpisodes(store: StateStore, attemptId: string) {
	return rawDb(store)
		.prepare(
			`SELECT stage, closed_at, closed_reason
			   FROM workflow_delivery_contract_episode
			  WHERE attempt_id = ?
			  ORDER BY opened_at, episode_id`,
		)
		.all(attemptId) as Array<{
		stage: string;
		closed_at: string | null;
		closed_reason: string | null;
	}>;
}

function targetAlerts(store: StateStore, attemptId: string) {
	return store
		.listWorkflowAlertOutbox()
		.filter((row) =>
			row.escalation_uid.startsWith(`delivery_contract_stalled:${attemptId}:`),
		);
}

async function seedQaIntent(): Promise<StateStore> {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const seed = pinLegacyWorkflowSeedAgents(
		legacyWorkflowSeeds().find(
			(candidate) => candidate.templateId === "tpl_eng_heavy",
		)!,
	);
	store.importWorkflowTemplateSeed(seed);
	store.materializeWorkflowRun({
		runId: "run-1",
		issueId: "FLY-1307",
		projectName: "flywheel",
		taskCategory: "code",
		templateId: seed.templateId,
		claimsReadEnrolled: true,
		actor: "lead",
		canonicalRoot: REPO_ROOT,
		env: WORKFLOW_ON,
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
	});
	store.commitWorkflowTransitionTx({
		nodeReuseEnabled: false,
		runId: "run-1",
		nodeId: "design",
		attempt: 1,
		executionId: "design-1",
		outcome: "design_done",
		successorExecutionId: "implement-1",
		now: "2026-07-16T00:05:00.000Z",
	});
	store.upsertSession({
		execution_id: "implement-1",
		issue_id: "FLY-1307",
		project_name: "flywheel",
		status: "awaiting_review",
		pr_head_sha: HEAD,
	});
	store.patchSessionMetadata("implement-1", { pr_head_sha: HEAD });
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
		nodeReuseEnabled: false,
		runId: "run-1",
		nodeId: "implement",
		attempt: 1,
		executionId: "implement-1",
		outcome: "implement_done",
		successorExecutionId: DEAD_EXECUTION_ID,
		now: "2026-07-16T00:10:00.000Z",
	});
	dbRun(
		store,
		`INSERT INTO workflow_node_pr_binding
		   (run_id, node_id, attempt, pr_number, head_sha, target_repo_identity,
		    probe_repo_slug, target_repo_path, worktree_binding_generation,
		    receipt_id, bound_at)
		 VALUES ('run-1', 'implement', 1, 2096, ?, '__main__',
		         'xrliAnnie/flywheel', '/tmp/flywheel', 'generation-1',
		         'fly2096-pr-binding', ?)`,
		[HEAD, at(-2)],
	);
	store.applyWorkflowLedgerBatch({
		projectName: "flywheel",
		issueId: "FLY-1307",
		runId: "run-1",
		ops: [
			{
				op: "side_effect",
				node: "qa",
				attempt: 1,
				executionId: DEAD_EXECUTION_ID,
				to: "started",
			},
		],
	});
	store.upsertWorkflowRunNode({
		runId: "run-1",
		nodeId: "qa",
		attempt: 1,
		state: "running",
		executionId: DEAD_EXECUTION_ID,
	});
	return store;
}

async function seedLaunchedReplacement(): Promise<{
	store: StateStore;
	attemptId: string;
}> {
	const store = await seedQaIntent();
	store.upsertSession({
		execution_id: DEAD_EXECUTION_ID,
		issue_id: "FLY-1307",
		project_name: "flywheel",
		status: "failed",
		session_role: "qa",
	});
	store.upsertWorkflowRunNode({
		runId: "run-1",
		nodeId: "qa",
		attempt: 2,
		state: "pending",
		executionId: DEAD_EXECUTION_ID,
	});
	dbRun(
		store,
		`INSERT OR IGNORE INTO workflow_actor
		   (execution_id, project_name, issue_id, role, created_at)
		 VALUES (?, 'flywheel', 'FLY-1307', 'qa', ?)`,
		[DEAD_EXECUTION_ID, at(-2)],
	);
	dbRun(
		store,
		`INSERT INTO workflow_rework_request
		   (request_id, run_id, source_event_id, authority, source_node_id,
		    source_attempt, base_revision, authority_context_json,
		    authority_context_digest, requested_at)
		 VALUES (?, 'run-1', 'fly2096-source', 'qa', 'qa', 1, ?, '{}', ?, ?)`,
		[REQUEST_ID, HEAD, "b".repeat(64), at(-2)],
	);
	dbRun(
		store,
		`INSERT INTO workflow_rework_route_revision
		   (request_id, revision, target_node_id, target_attempt,
		    preferred_actor_execution_id, invalidation_scope_json,
		    verification_policy_json, interpreted_by, interpretation_reason, created_at)
		 VALUES (?, 1, 'qa', 2, ?, '["qa"]', '["qa_retest","founder_gate"]',
		         'fixture', 'fixture', ?)`,
		[REQUEST_ID, DEAD_EXECUTION_ID, at(-2)],
	);
	dbRun(
		store,
		`INSERT INTO workflow_rework_delivery
		   (request_id, route_revision, state, updated_at)
		 VALUES (?, 1, 'replacement_pending', ?)`,
		[REQUEST_ID, at(-2)],
	);
	dbRun(
		store,
		`INSERT INTO workflow_rework_verification_path
		   (request_id, run_id, route_revision, state, current_node_id,
		    current_attempt, updated_at)
		 VALUES (?, 'run-1', 1, 'pending', 'qa', 2, ?)`,
		[REQUEST_ID, at(-2)],
	);
	store.baselineWorkflowDeliveryContracts(at(-2));
	expect(
		store.materializeWorkflowReworkReplacement({
			requestId: REQUEST_ID,
			deadExecutionId: DEAD_EXECUTION_ID,
			newExecutionId: REPLACEMENT_ID,
			reason: "persisted_target_dead",
			observedAt: at(-1),
		}),
	).toMatchObject({
		ok: true,
		executionId: REPLACEMENT_ID,
		idempotentReplay: false,
	});
	expect(
		store.admitGeneralizedWorkflowExecution({
			runId: "run-1",
			nodeId: "qa",
			executionId: REPLACEMENT_ID,
			attempt: 2,
			activationId: "activation-fly2096-qa-replacement-2",
			activationMode: "replacement",
			reworkRequestId: REQUEST_ID,
			expiresAt: at(30),
			absoluteDeadlineAt: at(24 * 60),
			now: at(-0.5),
		}),
	).toMatchObject({ ok: true, idempotentReplay: false });
	store.upsertSession({
		execution_id: REPLACEMENT_ID,
		issue_id: "FLY-1307",
		project_name: "flywheel",
		status: "running",
		session_role: "qa",
		heartbeat_at: T0,
		last_activity_at: T0,
	});
	store.upsertWorkflowRunNode({
		runId: "run-1",
		nodeId: "qa",
		attempt: 2,
		state: "running",
		executionId: REPLACEMENT_ID,
	});
	expect(
		store.insertEvent({
			event_id: `fly2096:session_started:${REPLACEMENT_ID}`,
			execution_id: REPLACEMENT_ID,
			issue_id: "FLY-1307",
			project_name: "flywheel",
			event_type: "session_started",
			source: "test",
			payload: {},
		}),
	).toBe(true);
	const launchAttempt = rawDb(store)
		.prepare(
			`SELECT consumed_at
			   FROM workflow_delivery_attempt
			  WHERE family = 'launch'
			    AND json_extract(contract_ref_json, '$.pk') = ?`,
		)
		.get(REPLACEMENT_ID) as { consumed_at: string | null } | undefined;
	expect(launchAttempt?.consumed_at).not.toBeNull();
	expect(
		store.markWorkflowReworkReplacementLaunched({
			executionId: REPLACEMENT_ID,
			now: T0,
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			},
		}),
	).toEqual({ ok: true, updated: true });
	dbRun(
		store,
		`INSERT INTO workflow_claims
		   (server_seq, issued_at, issue_id, workflow_run_id, node_id,
		    decision_kind, attempt, predicate, issuer_kind,
		    issuer_execution_id, issuer_node_id, issuer_vendor, issuer_model,
		    subject_producer_execution_id, subject_kind, subject_digest,
		    permanent, submission_digest, client_request_id, authority_id)
		 VALUES (1, ?, 'FLY-1307', 'run-1', 'qa',
		         'qa_verdict', 2, 'qa_passed', 'runner_node',
		         ?, 'qa', 'claude', 'claude-opus-5',
		         'implement-1', 'git_head', ?, 1,
		         'fly2096-qa-submission', 'fly2096-qa-client', ?)`,
		[T0, REPLACEMENT_ID, HEAD, REPLACEMENT_ID],
	);
	expect(store.getWorkflowExecutionBinding(REPLACEMENT_ID)?.mode).toBe(
		"replacement",
	);
	expect(store.getWorkflowReworkVerificationPath(REQUEST_ID)).toMatchObject({
		state: "active",
		route_revision: 2,
	});
	expect(store.getWorkflowReworkDelivery(REQUEST_ID)).toMatchObject({
		state: "wake_delivered",
		route_revision: 2,
		updated_at: T0,
		last_error: null,
	});
	const attempt = currentReworkAttempt(store);
	expect(attempt.received_at).toBe(T0);
	return { store, attemptId: attempt.attempt_id };
}

function seedUnfinishedControl(store: StateStore): string {
	const requestId = "fly2096-unfinished-control";
	const executionId = "qa-unfinished-control";
	store.materializeWorkflowRun({
		runId: "run-control",
		issueId: "FLY-1308",
		projectName: "flywheel",
		taskCategory: "code",
		templateId: "tpl_eng_heavy",
		claimsReadEnrolled: true,
		actor: "lead",
		canonicalRoot: REPO_ROOT,
		env: WORKFLOW_ON,
		startReservation: {
			idempotencyKey: "control-start",
			selectionDigest: "control-selection",
			nodeId: "design",
			attempt: 1,
			executionId: "control-design-1",
			createdAt: at(-2),
		},
	});
	dbRun(
		store,
		`INSERT INTO workflow_actor
		   (execution_id, project_name, issue_id, role, created_at)
		 VALUES (?, 'flywheel', 'FLY-1308', 'qa', ?)`,
		[executionId, at(-2)],
	);
	store.upsertSession({
		execution_id: executionId,
		issue_id: "FLY-1308",
		project_name: "flywheel",
		status: "completed",
		session_role: "qa",
		heartbeat_at: at(-120),
		last_activity_at: at(-120),
	});
	dbRun(
		store,
		`INSERT INTO workflow_rework_request
		   (request_id, run_id, source_event_id, authority, source_node_id,
		    source_attempt, base_revision, authority_context_json,
		    authority_context_digest, requested_at)
		 VALUES (?, 'run-control', 'fly2096-control-source', 'qa', 'qa', 1,
		         ?, '{}', ?, ?)`,
		[requestId, HEAD, "c".repeat(64), T0],
	);
	dbRun(
		store,
		`INSERT INTO workflow_rework_route_revision
		   (request_id, revision, target_node_id, target_attempt,
		    preferred_actor_execution_id, invalidation_scope_json,
		    verification_policy_json, interpreted_by, interpretation_reason, created_at)
		 VALUES (?, 1, 'qa', 2, ?, '["qa"]', '["qa_retest","founder_gate"]',
		         'fixture', 'unfinished control', ?)`,
		[requestId, executionId, T0],
	);
	dbRun(
		store,
		`INSERT INTO workflow_rework_delivery
		   (request_id, route_revision, state, updated_at)
		 VALUES (?, 1, 'wake_delivered', ?)`,
		[requestId, T0],
	);
	store.baselineWorkflowDeliveryContracts(T0);
	const attempt = currentReworkAttempt(store, requestId);
	expect(attempt.received_at).toBe(T0);
	expect(attempt.settlement_reason).toBeNull();
	return attempt.attempt_id;
}

function dispatcherFor(
	store: StateStore,
	now: () => string,
): WorkflowEngineDispatcher {
	return new WorkflowEngineDispatcher({
		store,
		env: WORKFLOW_ON,
		startDispatcher: {
			start: vi.fn(),
			getInflightCount: () => 0,
			validateAgentName: () => ({ ok: true as const }),
		} as IStartDispatcher,
		now: () => new Date(now()),
		probeLaunchLiveness: async () => "alive",
		reconcileWorkflowRework: async () => ({ kind: "busy" }),
	});
}

function stalledEventCount(store: StateStore): number {
	return (
		rawDb(store)
			.prepare(
				`SELECT COUNT(*) AS count
				   FROM workflow_run_event
				  WHERE kind IN ('rework_activation_stalled_alerted',
				                 'rework_activation_stalled_held')`,
			)
			.get() as { count: number }
	).count;
}

function completeQa(store: StateStore, now: string, outcome = "qa_pass") {
	const result = store.commitWorkflowTransitionTx({
		nodeReuseEnabled: false,
		runId: "run-1",
		nodeId: "qa",
		attempt: 2,
		executionId: REPLACEMENT_ID,
		outcome,
		subjectDigest: HEAD,
		now,
	});
	if (!result.ok) throw new Error(result.reason);
	return result;
}

describe("FLY-2096 positive control", () => {
	it("keeps the run active past the retired 60-minute clock", async () => {
		const { store } = await seedLaunchedReplacement();
		dbRun(
			store,
			"UPDATE sessions SET heartbeat_at = ?, last_activity_at = ? WHERE execution_id = ?",
			[at(60), at(60), REPLACEMENT_ID],
		);
		let now = at(61);
		const dispatcher = dispatcherFor(store, () => now);
		await dispatcher.reconcile();
		expect(store.getWorkflowRun("run-1")?.status).toBe("active");
		expect(store.getWorkflowReworkDelivery(REQUEST_ID)?.state).toBe(
			"wake_delivered",
		);
		expect(stalledEventCount(store)).toBe(0);

		now = at(95);
		await dispatcher.reconcile();
		expect(store.getWorkflowRun("run-1")?.status).toBe("active");
		expect(store.getWorkflowReworkDelivery(REQUEST_ID)?.state).toBe(
			"wake_delivered",
		);
		expect(stalledEventCount(store)).toBe(0);
	});

	it("accepts the replacement completion after 96 minutes", async () => {
		const { store } = await seedLaunchedReplacement();
		let now = at(61);
		const dispatcher = dispatcherFor(store, () => now);
		await dispatcher.reconcile();

		expect(completeQa(store, at(96))).toMatchObject({ ok: true });
		expect(store.getWorkflowReworkDelivery(REQUEST_ID)?.state).toBe(
			"completed",
		);
		expect(
			rawDb(store)
				.prepare("SELECT kind FROM workflow_run_event WHERE event_uid = ?")
				.get(`rework_verification_completed:${REQUEST_ID}`),
		).toEqual({ kind: "rework_verification_completed" });

		now = at(180);
		await dispatcher.reconcile();
		expect(store.getWorkflowRun("run-1")?.status).toBe("active");
		expect(stalledEventCount(store)).toBe(0);
	});
});

describe.skipIf(!hasLivenessModule)("FLY-2096 main-only liveness gate", () => {
	it("treats fresh replacement activity as receipt-equivalent liveness", async () => {
		const { DeliveryContractWatch } = await import(
			"../bridge/delivery-contract/watch.js"
		);
		const { store, attemptId } = await seedLaunchedReplacement();
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		const launchAttempt = rawDb(store)
			.prepare(
				`SELECT attempt_id, settlement_reason
				   FROM workflow_delivery_attempt
				  WHERE family = 'launch'
				    AND json_extract(contract_ref_json, '$.pk') = ?`,
			)
			.get(REPLACEMENT_ID) as {
			attempt_id: string;
			settlement_reason: string | null;
		};
		expect(launchAttempt.settlement_reason).toBe("settled");
		expect(
			store
				.listLiveWorkflowDeliveryAttempts()
				.some((attempt) => attempt.attempt_id === launchAttempt.attempt_id),
		).toBe(false);
		expect(
			JSON.parse(currentReworkAttempt(store).contract_ref_json),
		).toMatchObject({ routeRevision: 2 });
		dbRun(
			store,
			"UPDATE sessions SET heartbeat_at = ?, last_activity_at = ? WHERE execution_id = ?",
			[at(60), at(60), REPLACEMENT_ID],
		);
		new DeliveryContractWatch({
			store,
			commDb,
			projectName: "flywheel",
			resolveAlertIdentity: () => ({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			}),
		}).runPass(at(61));

		expect(targetEpisodes(store, attemptId)).toEqual([]);
		expect(targetAlerts(store, attemptId)).toEqual([]);
		expect(store.getWorkflowRun("run-1")?.status).toBe("active");
	});

	it("alerts for an absent replacement without holding or rejecting completion", async () => {
		const { DeliveryContractWatch } = await import(
			"../bridge/delivery-contract/watch.js"
		);
		const { store, attemptId } = await seedLaunchedReplacement();
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		const watch = new DeliveryContractWatch({
			store,
			commDb,
			projectName: "flywheel",
			resolveAlertIdentity: () => ({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			}),
		});

		watch.runPass(at(61));
		expect(targetEpisodes(store, attemptId)).toEqual([
			expect.objectContaining({ stage: "received", closed_at: null }),
		]);
		expect(targetAlerts(store, attemptId)).toHaveLength(1);
		expect(store.getWorkflowRun("run-1")?.status).toBe("active");

		watch.runPass(at(95));
		expect(targetAlerts(store, attemptId)).toHaveLength(2);
		expect(
			targetAlerts(store, attemptId)
				.map((row) => row.payload.severity)
				.sort(),
		).toEqual(["severe", "warning"]);
		expect(store.getWorkflowRun("run-1")?.status).toBe("active");

		expect(completeQa(store, at(96))).toMatchObject({ ok: true });
		expect(store.getWorkflowReworkDelivery(REQUEST_ID)?.state).toBe(
			"completed",
		);
		expect(store.getWorkflowRun("run-1")?.status).toBe("active");
		expect(stalledEventCount(store)).toBe(0);
		expect(
			store
				.listLiveWorkflowDeliveryAttempts()
				.some((attempt) => attempt.attempt_id === attemptId),
		).toBe(false);
		expect(targetEpisodes(store, attemptId)).toEqual([
			expect.objectContaining({
				closed_at: at(96),
				closed_reason: "terminal:settled:settled",
			}),
		]);

		watch.runPass(at(180));
		expect(targetAlerts(store, attemptId)).toHaveLength(2);
		expect(targetEpisodes(store, attemptId)).toHaveLength(1);
	});
});

describe.skipIf(!hasLivenessModule)(
	"FLY-2096 rework attempt settles on completion",
	() => {
		it("settles the completed verification attempt before the worker goes absent", async () => {
			const { DeliveryProjector } = await import(
				"../bridge/delivery-contract/projector.js"
			);
			const { DeliveryContractWatch } = await import(
				"../bridge/delivery-contract/watch.js"
			);
			const { store, attemptId } = await seedLaunchedReplacement();
			const commDb = new CommDB(":memory:");
			commDbs.push(commDb);
			expect(currentReworkAttempt(store).settlement_reason).toBeNull();
			expect(completeQa(store, at(20))).toMatchObject({ ok: true });
			store.upsertSession({
				execution_id: REPLACEMENT_ID,
				issue_id: "FLY-1307",
				project_name: "flywheel",
				status: "completed",
				session_role: "qa",
				heartbeat_at: at(20),
				last_activity_at: at(20),
			});
			const controlAttemptId = seedUnfinishedControl(store);
			new DeliveryProjector({
				store,
				commDb,
				projectName: "flywheel",
			}).runPass(at(61));
			const watch = new DeliveryContractWatch({
				store,
				commDb,
				projectName: "flywheel",
				resolveAlertIdentity: () => ({
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				}),
			});
			watch.runPass(at(61));

			expect({
				live: store
					.listLiveWorkflowDeliveryAttempts()
					.some((attempt) => attempt.attempt_id === attemptId),
				openEpisodes: targetEpisodes(store, attemptId).filter(
					(episode) => episode.closed_at === null,
				).length,
				alerts: targetAlerts(store, attemptId).length,
				settlement: currentReworkAttempt(store).settlement_reason,
			}).toEqual({
				live: false,
				openEpisodes: 0,
				alerts: 0,
				settlement: "settled",
			});
			expect(targetEpisodes(store, controlAttemptId)).toEqual([
				expect.objectContaining({ stage: "received", closed_at: null }),
			]);
			expect(targetAlerts(store, controlAttemptId)).toHaveLength(1);
			expect(store.getWorkflowRun("run-control")?.status).toBe("active");
			expect(
				JSON.parse(currentReworkAttempt(store).contract_ref_json),
			).toMatchObject({ routeRevision: 2 });

			watch.runPass(at(95));
			expect(targetAlerts(store, attemptId)).toEqual([]);
			expect(targetAlerts(store, controlAttemptId)).toHaveLength(2);
		}, 15_000);

		it("settles the original attempt when a failed verification supersedes it", async () => {
			const { store, attemptId } = await seedLaunchedReplacement();
			expect(currentReworkAttempt(store).settlement_reason).toBeNull();

			const completed = completeQa(store, at(20), "qa_fail");
			expect(completed).toMatchObject({
				ok: true,
				reworkRequestId: expect.stringMatching(/^rework:/),
			});
			expect(store.getWorkflowReworkDelivery(REQUEST_ID)?.state).toBe(
				"completed",
			);
			expect(currentReworkAttempt(store).settlement_reason).toBe("settled");
			expect(
				store
					.listLiveWorkflowDeliveryAttempts()
					.some((attempt) => attempt.attempt_id === attemptId),
			).toBe(false);
		});

		it("keeps legacy delivery completion compatible when no attempt row exists", async () => {
			const { store } = await seedLaunchedReplacement();
			const db = rawDb(store);
			db.pragma("defer_foreign_keys = ON");
			db.transaction(() => {
				db.prepare(
					`DELETE FROM workflow_delivery_attempt
					  WHERE family = 'rework'
					    AND json_extract(contract_ref_json, '$.pk') = ?`,
				).run(REQUEST_ID);
			})();
			expect(
				db
					.prepare(
						`SELECT COUNT(*) AS count
						   FROM workflow_delivery_attempt
						  WHERE family = 'rework'
						    AND json_extract(contract_ref_json, '$.pk') = ?`,
					)
					.get(REQUEST_ID),
			).toEqual({ count: 0 });

			expect(completeQa(store, at(20))).toMatchObject({ ok: true });
			expect(store.getWorkflowReworkDelivery(REQUEST_ID)?.state).toBe(
				"completed",
			);
		});
	},
);
