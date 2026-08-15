import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";
import { legacyWorkflowSeeds } from "./fixtures/legacy-workflow-manifests.js";

const ENGINE_FLAGS = {
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
};

function rawDb(store: StateStore): {
	run(sql: string, params?: unknown[]): void;
} {
	return (
		store as unknown as {
			db: { run(sql: string, params?: unknown[]): void };
		}
	).db;
}

async function carrierRun(options: { pendingDispatch?: boolean } = {}) {
	const store = await StateStore.create(":memory:");
	const seed = legacyWorkflowSeeds().find(
		(candidate) => candidate.templateId === "tpl_eng_heavy",
	)!;
	store.importWorkflowTemplateSeed(seed);
	store.materializeWorkflowRun({
		runId: "run-1",
		issueId: "FLY-1707",
		projectName: "flywheel",
		taskCategory: "code",
		templateId: seed.templateId,
		claimsReadEnrolled: true,
		actor: "lead",
		env: ENGINE_FLAGS,
		entryKind: "pipeline_dag_v1",
		startReservation: {
			idempotencyKey: "engine-start",
			selectionDigest: "selection",
			nodeId: "design",
			attempt: 1,
			executionId: "design-1",
			createdAt: "2026-08-15T08:00:00.000Z",
		},
	});
	const admission = store.admitGeneralizedWorkflowExecution({
		runId: "run-1",
		nodeId: "design",
		executionId: "design-1",
		attempt: 1,
		expiresAt: "2026-08-15T10:00:00.000Z",
		absoluteDeadlineAt: "2026-08-16T08:00:00.000Z",
		now: "2026-08-15T08:01:00.000Z",
		env: ENGINE_FLAGS,
	});
	if (!admission.ok) throw new Error(`admission failed: ${admission.reason}`);
	if (!options.pendingDispatch) {
		store.applyWorkflowLedgerBatch({
			projectName: "flywheel",
			issueId: "FLY-1707",
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
		issue_id: "FLY-1707",
		project_name: "flywheel",
		status: "completed",
		workflow_node_id: "design",
	});
	return store;
}

function commitCloseIntent(store: StateStore) {
	expect(
		store.prepareWorkflowOperatorCloseIntent({
			executionId: "design-1",
			mode: "done",
			reason: "operator close",
			now: "2026-08-15T08:02:00.000Z",
		}),
	).toMatchObject({ ok: true });
	expect(
		store.finalizeWorkflowOperatorCloseIntent({
			executionId: "design-1",
			stage: "committed",
			now: "2026-08-15T08:03:00.000Z",
		}),
	).toEqual({ ok: true, idempotentReplay: false });
}

describe("FLY-1707 workflow carrier close cascade", () => {
	it("terminates an active run when its committed close removes the sole carrier", async () => {
		const store = await carrierRun();
		commitCloseIntent(store);

		expect(
			store.cascadeRunTerminationOnCarrierClose({
				executionId: "design-1",
				mode: "done",
				principal: "lead-a",
				now: "2026-08-15T08:04:00.000Z",
			}),
		).toEqual({ ok: true, runId: "run-1", idempotentReplay: false });
		expect(store.getWorkflowRun("run-1")?.status).toBe("terminated");
		expect(
			store.cascadeRunTerminationOnCarrierClose({
				executionId: "design-1",
				mode: "done",
				principal: "lead-a",
				now: "2026-08-15T08:05:00.000Z",
			}),
		).toEqual({ ok: true, runId: "run-1", idempotentReplay: true });
		store.close();
	});

	it("refuses the cascade while another live carrier remains", async () => {
		const store = await carrierRun();
		store.upsertWorkflowRunNode({
			runId: "run-1",
			nodeId: "implement",
			attempt: 1,
			state: "running",
			executionId: "implement-1",
		});
		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1707",
			project_name: "flywheel",
			status: "running",
		});
		commitCloseIntent(store);

		expect(
			store.cascadeRunTerminationOnCarrierClose({
				executionId: "design-1",
				mode: "done",
				principal: "lead-a",
				now: "2026-08-15T08:04:00.000Z",
			}),
		).toMatchObject({ ok: false, reason: "other_live_carriers" });
		expect(store.getWorkflowRun("run-1")?.status).toBe("active");
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.some((event) => event.kind === "cascade_refused"),
		).toBe(true);
		store.close();
	});

	it("never cascades through an explicitly held run", async () => {
		const store = await carrierRun();
		rawDb(store).run(
			"UPDATE workflow_run SET status = 'held' WHERE run_id = 'run-1'",
		);
		commitCloseIntent(store);

		expect(
			store.cascadeRunTerminationOnCarrierClose({
				executionId: "design-1",
				mode: "done",
				principal: "lead-a",
				now: "2026-08-15T08:04:00.000Z",
			}),
		).toMatchObject({ ok: false, reason: "run_not_active" });
		expect(store.getWorkflowRun("run-1")?.status).toBe("held");
		store.close();
	});

	it("refuses the cascade for pending dispatch and in-flight rework delivery", async () => {
		const pending = await carrierRun({ pendingDispatch: true });
		commitCloseIntent(pending);
		expect(
			pending.cascadeRunTerminationOnCarrierClose({
				executionId: "design-1",
				mode: "done",
				principal: "lead-a",
				now: "2026-08-15T08:04:00.000Z",
			}),
		).toMatchObject({ ok: false, reason: "pending_dispatch_intent" });
		pending.close();

		const rework = await carrierRun();
		rawDb(rework).run(
			`INSERT INTO workflow_rework_request
			 (request_id, run_id, source_event_id, authority, source_node_id,
			  source_attempt, base_revision, authority_context_json,
			  authority_context_digest, requested_at)
			 VALUES ('rework-1', 'run-1', 'source-1', 'founder', 'design', 1,
			         'base', '{}', 'digest', '2026-08-15T08:01:00.000Z')`,
		);
		rawDb(rework).run(
			`INSERT INTO workflow_rework_route_revision
			 (request_id, revision, target_node_id, target_attempt,
			  preferred_actor_execution_id, invalidation_scope_json,
			  verification_policy_json, interpreted_by, interpretation_reason, created_at)
			 VALUES ('rework-1', 1, 'design', 1, 'design-1', '[]', '[]',
			         'lead-a', 'test', '2026-08-15T08:01:00.000Z')`,
		);
		rawDb(rework).run(
			`INSERT INTO workflow_rework_delivery
			 (request_id, route_revision, state, updated_at)
			 VALUES ('rework-1', 1, 'pending', '2026-08-15T08:01:00.000Z')`,
		);
		commitCloseIntent(rework);
		expect(
			rework.cascadeRunTerminationOnCarrierClose({
				executionId: "design-1",
				mode: "done",
				principal: "lead-a",
				now: "2026-08-15T08:04:00.000Z",
			}),
		).toMatchObject({ ok: false, reason: "rework_delivery_inflight" });
		rework.close();
	});

	it("expires a stale prepared intent and releases dead-execution recovery", async () => {
		const store = await carrierRun();
		store.prepareWorkflowOperatorCloseIntent({
			executionId: "design-1",
			mode: "done",
			reason: "operator close",
			now: "2026-08-15T08:00:00.000Z",
		});

		expect(
			store.shouldSuppressDeadExecutionRecovery({
				executionId: "design-1",
				now: "2026-08-15T08:09:59.999Z",
			}),
		).toBe(true);
		expect(
			store.shouldSuppressDeadExecutionRecovery({
				executionId: "design-1",
				now: "2026-08-15T08:10:00.000Z",
			}),
		).toBe(false);
		expect(store.getWorkflowOperatorCloseIntent("design-1")?.stage).toBe(
			"failed",
		);
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.some((event) => event.kind === "close_intent_expired"),
		).toBe(true);
		store.close();
	});
});
