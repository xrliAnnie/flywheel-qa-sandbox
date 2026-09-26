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

describe("FLY-2922 carrier close settlement", () => {
	it("holds the current incomplete run and replays one durable episode", async () => {
		const store = await carrierRun();
		try {
			commitCloseIntent(store);
			expect(store.getWorkflowRun("run-1")?.status).toBe("held");
			expect(store.getWorkflowCarrierCloseOutcome("design-1")).toMatchObject({
				executionClosed: true,
				runTerminated: false,
				completionAccepted: false,
				recoveryTarget: {
					previousExecutionId: "design-1",
					previousLaunchOrdinal: 1,
				},
			});
			const events = store.listWorkflowRunEvents("run-1");
			expect(
				events.filter((event) => event.kind === "run_recovery_required"),
			).toHaveLength(1);
			expect(events.some((event) => event.kind === "run_terminated")).toBe(
				false,
			);
			expect(
				store.finalizeWorkflowOperatorCloseIntent({
					executionId: "design-1",
					stage: "committed",
					now: "2026-08-15T08:04:00.000Z",
				}),
			).toEqual({ ok: true, idempotentReplay: true });
			expect(store.listWorkflowRunEvents("run-1")).toEqual(events);
		} finally {
			store.close();
		}
	});
	it("keeps other parked carriers and their state intact", async () => {
		const store = await carrierRun();
		try {
			store.upsertSession({
				execution_id: "parked-qa",
				issue_id: "FLY-1707",
				project_name: "flywheel",
				status: "ship_parked",
			});
			const before = store.getSession("parked-qa");
			commitCloseIntent(store);
			expect(store.getWorkflowRun("run-1")?.status).toBe("held");
			expect(store.getSession("parked-qa")).toEqual(before);
		} finally {
			store.close();
		}
	});
	it("preserves a preexisting held run and its dispatch history", async () => {
		const store = await carrierRun({ pendingDispatch: true });
		try {
			rawDb(store).run(
				"UPDATE workflow_run SET status = 'held' WHERE run_id = 'run-1'",
			);
			const ledger = store.listWorkflowSideEffects("run-1");
			commitCloseIntent(store);
			expect(store.getWorkflowRun("run-1")?.status).toBe("held");
			expect(store.listWorkflowSideEffects("run-1")).toEqual(ledger);
		} finally {
			store.close();
		}
	});
	it("failed physical close does not publish recovery or suppress automatic recovery", async () => {
		const store = await carrierRun();
		try {
			store.prepareWorkflowOperatorCloseIntent({
				executionId: "design-1",
				mode: "done",
				reason: "close",
				now: "2026-08-15T08:02:00.000Z",
			});
			expect(
				store.finalizeWorkflowOperatorCloseIntent({
					executionId: "design-1",
					stage: "failed",
					now: "2026-08-15T08:03:00.000Z",
				}),
			).toMatchObject({ ok: true });
			expect(store.getWorkflowRun("run-1")?.status).toBe("active");
			expect(
				store.shouldSuppressDeadExecutionRecovery({
					executionId: "design-1",
					now: "2026-08-15T08:04:00.000Z",
				}),
			).toBe(false);
			expect(
				store
					.listWorkflowRunEvents("run-1")
					.filter((event) => event.kind === "run_recovery_required"),
			).toHaveLength(0);
		} finally {
			store.close();
		}
	});
	it("rolls back the held episode if close-intent commit fails", async () => {
		const store = await carrierRun();
		try {
			store.prepareWorkflowOperatorCloseIntent({
				executionId: "design-1",
				mode: "done",
				reason: "close",
				now: "2026-08-15T08:02:00.000Z",
			});
			rawDb(store).run(
				"CREATE TRIGGER reject_close BEFORE UPDATE ON workflow_operator_close_intent WHEN NEW.stage = 'committed' BEGIN SELECT RAISE(ABORT, 'injected_close_failure'); END",
			);
			expect(() =>
				store.finalizeWorkflowOperatorCloseIntent({
					executionId: "design-1",
					stage: "committed",
					now: "2026-08-15T08:03:00.000Z",
				}),
			).toThrow("injected_close_failure");
			expect(store.getWorkflowRun("run-1")?.status).toBe("active");
			expect(store.getWorkflowOperatorCloseIntent("design-1")?.stage).toBe(
				"prepared",
			);
			expect(
				store
					.listWorkflowRunEvents("run-1")
					.filter((event) => event.kind === "run_recovery_required"),
			).toHaveLength(0);
		} finally {
			store.close();
		}
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
