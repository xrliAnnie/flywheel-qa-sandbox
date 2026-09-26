import { WORKFLOW_TRANSITIONS, WorkflowFSM } from "flywheel-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { legacyWorkflowSeeds } from "../../__tests__/fixtures/legacy-workflow-manifests.js";
import { StateStore } from "../../StateStore.js";
import { handleTerminate } from "../actions.js";
import { closeRunner } from "../close-runner.js";

// Replace physical/CommDB boundaries only. Enrollment, FSM, close intent,
// completion, run events, and run collection decisions use the real StateStore.
vi.mock("../tmux-lookup.js", () => ({
	getTmuxTargetFromCommDb: vi.fn(() => undefined),
	lookupTmuxTarget: vi.fn(() => ({ kind: "gone" })),
	killTmuxWindow: vi.fn(async () => {
		throw new Error("dead fixture must not kill a window");
	}),
	killCmuxLinkedSession: vi.fn(async () => ({ killed: false })),
	probeRunnerProcessLiveness: vi.fn(async () => "absent"),
}));
vi.mock("../codex-daemon-teardown.js", () => ({
	reapCodexDaemonForSession: vi.fn(async () => ({ outcome: "not_codex" })),
}));
vi.mock("../runner-teardown.js", () => ({
	reapRunnerMcp: vi.fn(async () => ({ killed: [], failed: [] })),
}));
vi.mock("../run-quiescence.js", () => ({
	probeRunExecutionLiveness: vi.fn(async () => "dead"),
}));
vi.mock("../snapshot-closeout.js", () => ({
	cleanupExecutionSnapshots: vi.fn(async () => ({ status: "already_absent" })),
}));
vi.mock("../commdb-session-prune.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../commdb-session-prune.js")>();
	const finalized = () => ({
		ok: true,
		outcome: "finalized",
		retiredGateCount: 0,
		retiredAskCount: 0,
		deletedSessionCount: 1,
	});
	return {
		...actual,
		finalizeCommDbSession: vi.fn(finalized),
		finalizeCommDbTerminalSession: vi.fn(finalized),
		finalizeCommDbSessionCommunications: vi.fn(finalized),
	};
});

const RUN = "run-carrier-close";
const EXECUTION = "design-carrier-close";
const ISSUE = "FLY-2095";
const ENV = {
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
};
const stores: StateStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

async function enrolledCarrier(status: string) {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const seed = legacyWorkflowSeeds().find(
		(entry) => entry.templateId === "tpl_eng_heavy",
	)!;
	store.importWorkflowTemplateSeed(seed);
	store.materializeWorkflowRun({
		runId: RUN,
		issueId: ISSUE,
		projectName: "flywheel",
		taskCategory: "code",
		templateId: seed.templateId,
		claimsReadEnrolled: true,
		actor: "lead",
		env: ENV,
		entryKind: "pipeline_dag_v1",
		startReservation: {
			idempotencyKey: "carrier-close-start",
			selectionDigest: "selection",
			nodeId: "design",
			attempt: 1,
			executionId: EXECUTION,
			createdAt: "2026-08-15T08:00:00.000Z",
		},
	});
	expect(
		store.admitGeneralizedWorkflowExecution({
			runId: RUN,
			nodeId: "design",
			executionId: EXECUTION,
			attempt: 1,
			expiresAt: "2026-08-15T10:00:00.000Z",
			absoluteDeadlineAt: "2026-08-16T08:00:00.000Z",
			now: "2026-08-15T08:01:00.000Z",
			env: ENV,
		}),
	).toMatchObject({ ok: true });
	store.applyWorkflowLedgerBatch({
		projectName: "flywheel",
		issueId: ISSUE,
		runId: RUN,
		ops: [
			{
				op: "side_effect",
				node: "design",
				attempt: 1,
				executionId: EXECUTION,
				to: "started",
			},
		],
	});
	store.upsertWorkflowRunNode({
		runId: RUN,
		nodeId: "design",
		attempt: 1,
		state: "running",
		executionId: EXECUTION,
	});
	store.upsertSession({
		execution_id: EXECUTION,
		issue_id: ISSUE,
		project_name: "flywheel",
		workflow_node_id: "design",
		status,
	});
	expect(
		store.getGeneralizedWorkflowNodeForExecution(EXECUTION)?.binding,
	).toMatchObject({
		run_id: RUN,
		node_id: "design",
		attempt: 1,
		execution_id: EXECUTION,
	});
	expect(store.getWorkflowNodeCompletion(RUN, "design", 1)).toBeUndefined();
	return store;
}

function close(store: StateStore, done = false) {
	return closeRunner(
		{
			executionId: EXECUTION,
			issueId: ISSUE,
			projectName: "flywheel",
			leadId: "lead-a",
			reason: "Close this dead execution body",
			finalizeDone: done,
			transitionOpts: { store, fsm: new WorkflowFSM(WORKFLOW_TRANSITIONS) },
			runCloseAuthority: {
				mode: done ? "done" : "abandon",
				principal: "lead-a",
			},
		},
		store,
	);
}

function expectCurrentRecovery(store: StateStore, result: unknown) {
	// Assert durable semantics before response fields, so the original RED
	// identifies implicit run termination rather than missing JSON decoration.
	expect(store.getWorkflowRun(RUN)).toMatchObject({
		status: "held",
		current_node_id: "design",
	});
	expect(store.getWorkflowNodeCompletion(RUN, "design", 1)).toBeUndefined();
	expect(
		store
			.listWorkflowRunEvents(RUN)
			.filter((event) => event.kind === "run_terminated"),
	).toHaveLength(0);
	const episodes = store
		.listWorkflowRunEvents(RUN)
		.filter((event) => event.kind === "run_recovery_required");
	expect(episodes).toHaveLength(1);
	expect(episodes[0]).toMatchObject({
		node_id: "design",
		execution_id: EXECUTION,
	});
	expect(result).toMatchObject({
		executionClosed: true,
		runTerminated: false,
		runStatus: "held",
		recoveryTarget: {
			runId: RUN,
			nodeId: "design",
			attempt: 1,
			previousExecutionId: EXECUTION,
			previousLaunchOrdinal: 1,
			operationKind: "redispatch_current",
		},
	});
}

describe("FLY-2095/2181/2525 enrolled carrier close is not run termination", () => {
	it("closing a dead current body with only session.completed holds the same run", async () => {
		const store = await enrolledCarrier("completed");
		const result = await close(store);
		expect(result).toMatchObject({ closed: true, commDbFinalized: true });
		expect(store.getWorkflowOperatorCloseIntent(EXECUTION)).toMatchObject({
			stage: "committed",
		});
		expectCurrentRecovery(store, result);
		const events = store.listWorkflowRunEvents(RUN);
		expectCurrentRecovery(store, await close(store));
		expect(store.listWorkflowRunEvents(RUN)).toEqual(events);
	}, 60_000);

	it("execution terminate closes an incomplete current carrier without cancelling its run", async () => {
		const store = await enrolledCarrier("failed");
		const result = await handleTerminate(
			store,
			EXECUTION,
			{ store, fsm: new WorkflowFSM(WORKFLOW_TRANSITIONS) },
			undefined,
			[],
			undefined,
			undefined,
			"Close this dead execution body",
			{ mode: "abandon", principal: "lead-a" },
		);
		expect(result.success).toBe(true);
		expectCurrentRecovery(store, result);
	}, 60_000);

	it("done=true cannot synthesize enrolled completion or a successful session projection", async () => {
		const store = await enrolledCarrier("running");
		const result = await close(store, true);
		expect(result).toMatchObject({ closed: true, commDbFinalized: true });
		expect(store.getSession(EXECUTION)?.status).not.toBe("completed");
		expect(
			store
				.getEventsByExecution(EXECUTION)
				.filter((event) => event.event_type === "lead_close_runner_finalized"),
		).toHaveLength(0);
		expectCurrentRecovery(store, result);
		expect(result).toMatchObject({ completionAccepted: false });
	}, 60_000);

	it("closing an old body without completion preserves its current replacement", async () => {
		const store = await enrolledCarrier("completed");
		expect(
			store.rollbackDeadWorkflowNodeExecution({
				runId: RUN,
				nodeId: "design",
				attempt: 1,
				deadExecutionId: EXECUTION,
				newExecutionId: "design-current-replacement",
				reason: "Replace proven dead current body",
				livenessEvidence: {
					liveness: "dead",
					observedAt: "2026-08-15T08:03:00.000Z",
				},
				now: "2026-08-15T08:03:00.000Z",
			}),
		).toMatchObject({ ok: true });
		const run = store.getWorkflowRun(RUN);
		const successor = store.getWorkflowRunNode(RUN, "design", 1);
		expect(successor?.execution_id).toBe("design-current-replacement");
		const ledger = store.listWorkflowSideEffects(RUN);
		expect(await close(store)).toMatchObject({ closed: true });
		expect(store.getWorkflowRun(RUN)).toEqual(run);
		expect(store.getWorkflowRunNode(RUN, "design", 1)).toEqual(successor);
		expect(store.listWorkflowSideEffects(RUN)).toEqual(ledger);
		expect(
			store
				.listWorkflowRunEvents(RUN)
				.filter((event) => event.kind === "run_recovery_required"),
		).toHaveLength(0);
	}, 60_000);

	it("closing a genuinely completed source preserves its completion and successor", async () => {
		const store = await enrolledCarrier("running");
		expect(
			store.commitEnrolledCompletion({
				nodeReuseEnabled: false,
				executionId: EXECUTION,
				route: "phase_design_complete",
				sourceEventId: "genuine-design-completion",
				completionSubmission: { decision: { route: "phase_design_complete" } },
				now: "2026-08-15T08:03:00.000Z",
			}),
		).toMatchObject({ ok: true });
		const completion = store.getWorkflowNodeCompletion(RUN, "design", 1);
		expect(completion).toBeDefined();
		const run = store.getWorkflowRun(RUN);
		const successor = store.getWorkflowRunNode(RUN, "implement", 1);
		expect(successor?.execution_id).toEqual(expect.any(String));
		const ledger = store.listWorkflowSideEffects(RUN);
		expect(await close(store, true)).toMatchObject({ closed: true });
		expect(store.getWorkflowNodeCompletion(RUN, "design", 1)).toEqual(
			completion,
		);
		expect(store.getWorkflowRun(RUN)).toEqual(run);
		expect(store.getWorkflowRunNode(RUN, "implement", 1)).toEqual(successor);
		expect(store.listWorkflowSideEffects(RUN)).toEqual(ledger);
		expect(
			store
				.listWorkflowRunEvents(RUN)
				.filter((event) => event.kind === "run_recovery_required"),
		).toHaveLength(0);
	}, 60_000);
});
