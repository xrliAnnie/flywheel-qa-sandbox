import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";
import { legacyWorkflowSeeds } from "./fixtures/legacy-workflow-manifests.js";

const engineFlags = {
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
};
const HEAD = "c".repeat(40);
const ALERT_IDENTITY = {
	leadId: "flywheel-eng-lead",
	projectName: "flywheel",
	leadResolution: "resolved" as const,
};

function rawDb(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}

async function createActiveOperatorRework(): Promise<{
	store: StateStore;
	requestId: string;
	activationId: string;
	turnEpoch: number;
}> {
	const store = await StateStore.create(":memory:");
	const seed = legacyWorkflowSeeds().find(
		(candidate) => candidate.templateId === "tpl_eng_heavy",
	);
	if (!seed) throw new Error("tpl_eng_heavy seed missing");
	store.importWorkflowTemplateSeed(seed);
	store.bindWorkflowCategory({
		project: "flywheel",
		taskCategory: "code",
		templateId: seed.templateId,
		updatedBy: "lead",
	});
	store.materializeWorkflowRun({
		runId: "run-heavy",
		issueId: "FLY-1912",
		projectName: "flywheel",
		taskCategory: "code",
		claimsReadEnrolled: true,
		actor: "lead",
		env: engineFlags,
		startReservation: {
			idempotencyKey: "start-heavy",
			selectionDigest: "selection-heavy",
			nodeId: "design",
			attempt: 1,
			executionId: "design-exec",
			createdAt: "2026-08-20T00:00:00.000Z",
		},
	});
	store.upsertWorkflowRunNode({
		runId: "run-heavy",
		nodeId: "design",
		attempt: 1,
		state: "running",
		executionId: "design-exec",
	});
	const design = store.commitWorkflowTransitionTx({
		nodeReuseEnabled: false,
		runId: "run-heavy",
		nodeId: "design",
		attempt: 1,
		executionId: "design-exec",
		outcome: "design_done",
		successorExecutionId: "implement-exec",
		now: "2026-08-20T00:01:00.000Z",
	});
	if (!design.ok) throw new Error(design.reason);
	store.upsertWorkflowRunNode({
		runId: "run-heavy",
		nodeId: "implement",
		attempt: 1,
		state: "done",
		executionId: "implement-exec",
		endedAt: "2026-08-20T00:02:00.000Z",
	});
	store.upsertSession({
		execution_id: "implement-exec",
		issue_id: "FLY-1912",
		project_name: "flywheel",
		status: "ship_parked",
		workflow_node_id: "implement",
	});
	store.patchSessionMetadata("implement-exec", { pr_head_sha: HEAD });
	rawDb(store)
		.prepare("UPDATE workflow_run SET status = 'completed' WHERE run_id = ?")
		.run("run-heavy");
	const opened = store.openOperatorRework({
		runId: "run-heavy",
		targetNodeId: "implement",
		feedback: "rework before QA has run",
		clientRequestId: "fly1912-engine-invariant",
		principal: "master",
		evidence: store
			.listRunAttributedExecutions("run-heavy")
			.map((executionId) => ({
				executionId,
				sessionStatus: null,
				lifecycleRevision: null,
				liveness: "dead" as const,
				observedAt: "2026-08-20T00:03:00.000Z",
			})),
		now: "2026-08-20T00:03:00.000Z",
	});
	if (!opened.ok) throw new Error(opened.reason);
	const claimed = store.claimWorkflowReworkDelivery({
		requestId: opened.requestId,
		ownerId: "fly1912-coordinator",
		now: "2026-08-20T00:04:00.000Z",
		leaseExpiresAt: "2026-08-20T00:04:30.000Z",
	});
	if (!claimed.ok) throw new Error(claimed.reason);
	const admitted = store.admitGeneralizedWorkflowExecution({
		runId: "run-heavy",
		nodeId: "implement",
		executionId: "implement-exec",
		attempt: 2,
		activationId: "activation-fly1912-implement-2",
		activationMode: "wake",
		reworkRequestId: opened.requestId,
		expiresAt: "2026-08-20T02:00:00.000Z",
		absoluteDeadlineAt: "2026-08-21T00:00:00.000Z",
		now: "2026-08-20T00:04:01.000Z",
		env: engineFlags,
	});
	if (!admitted.ok) throw new Error(admitted.reason);
	const turnRecorded = store.recordWorkflowActivationTurn({
		activationId: admitted.activationId,
		issueId: "FLY-1912",
		executionId: "implement-exec",
		epoch: 1,
		sourceEventId: "fly1912-turn-implement-2",
		grantedAt: "2026-08-20T00:04:30.000Z",
	});
	if (!turnRecorded.ok) throw new Error(turnRecorded.reason);
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
			now: "2026-08-20T00:05:00.000Z",
			...(to === "awaiting_receipt" ? { releaseOwner: true } : {}),
		});
		if (!advanced.ok) throw new Error(advanced.reason);
	}
	const receipt = store.recordWorkflowReworkWakeReceipt({
		activationId: admitted.activationId,
		executionId: "implement-exec",
		epoch: 1,
		ackedAt: "2026-08-20T00:05:01.000Z",
		alertIdentity: ALERT_IDENTITY,
	});
	if (!receipt.ok) throw new Error(receipt.reason);
	const turn = store.getWorkflowActivationTurn(admitted.activationId);
	if (!turn) throw new Error("rework activation turn missing");
	return {
		store,
		requestId: opened.requestId,
		activationId: admitted.activationId,
		turnEpoch: turn.epoch,
	};
}

async function createFreshQa(): Promise<{
	store: StateStore;
	requestId: string;
	qaExecutionId: string;
	submissionCredential: string;
}> {
	const fixture = await createActiveOperatorRework();
	const completed = fixture.store.commitWorkflowTransitionTx({
		nodeReuseEnabled: false,
		runId: "run-heavy",
		nodeId: "implement",
		attempt: 2,
		executionId: "implement-exec",
		outcome: "implement_done",
		now: "2026-08-20T00:06:00.000Z",
	});
	if (!completed.ok || !completed.successorExecutionId) {
		fixture.store.close();
		throw new Error("fresh QA dispatch missing");
	}
	const qa = fixture.store.admitGeneralizedWorkflowExecution({
		runId: "run-heavy",
		nodeId: "qa",
		executionId: completed.successorExecutionId,
		attempt: 1,
		activationId: "activation-fly1912-qa-1",
		activationMode: "spawn",
		expiresAt: "2026-08-20T02:00:00.000Z",
		absoluteDeadlineAt: "2026-08-21T00:00:00.000Z",
		now: "2026-08-20T00:07:00.000Z",
		env: engineFlags,
	});
	if (!qa.ok || !qa.submissionCredential) {
		fixture.store.close();
		throw new Error("fresh QA admission failed");
	}
	fixture.store.upsertSession({
		execution_id: completed.successorExecutionId,
		issue_id: "FLY-1912",
		project_name: "flywheel",
		status: "running",
		workflow_node_id: "qa",
	});
	fixture.store.upsertWorkflowRunNode({
		runId: "run-heavy",
		nodeId: "qa",
		attempt: 1,
		state: "running",
		executionId: completed.successorExecutionId,
	});
	return {
		store: fixture.store,
		requestId: fixture.requestId,
		qaExecutionId: completed.successorExecutionId,
		submissionCredential: qa.submissionCredential,
	};
}

function submitQaPass(
	fixture: Awaited<ReturnType<typeof createFreshQa>>,
	options: { alertIdentity?: boolean; clientRequestId?: string } = {},
) {
	return fixture.store.submitWorkflowDecisionByCredential({
		nodeReuseEnabled: false,
		credential: fixture.submissionCredential,
		clientRequestId: options.clientRequestId ?? "fly1912-qa-pass",
		predicate: "qa_passed",
		subjectDigest: HEAD,
		issuerVendor: "claude",
		issuerModel: "claude-opus-4-8",
		subjectProducerExecutionId: "implement-exec",
		subjectProducerVendor: "codex",
		claimExpiresAt: "2026-08-20T02:00:00.000Z",
		...(options.alertIdentity === false
			? {}
			: { alertIdentity: ALERT_IDENTITY }),
		now: "2026-08-20T00:08:00.000Z",
	});
}

function ignoreFreshAdvance(store: StateStore): void {
	rawDb(store).exec(`
		CREATE TRIGGER ignore_fly1912_fresh_advance
		BEFORE UPDATE ON workflow_rework_verification_path
		WHEN NEW.current_node_id = 'qa'
		BEGIN SELECT RAISE(IGNORE); END
	`);
}

describe("FLY-1912 workflow engine invariants", () => {
	it("returns a named refusal and atomically queues one alert at the decision boundary", async () => {
		const fixture = await createFreshQa();
		try {
			rawDb(fixture.store)
				.prepare(
					"UPDATE workflow_rework_delivery SET state = 'completed' WHERE request_id = ?",
				)
				.run(fixture.requestId);
			expect(submitQaPass(fixture)).toEqual({
				ok: false,
				reason: "transition_refused",
				detail: {
					transitionReason:
						"engine_invariant:workflow_rework_delivery_complete_cas_failed",
				},
			});
			expect(
				fixture.store.getWorkflowRunNode("run-heavy", "qa", 1),
			).toMatchObject({ state: "running" });
			expect(
				fixture.store.getCurrentWorkflowGateHolder("run-heavy", "founder_gate"),
			).toBeUndefined();
			expect(
				fixture.store.getWorkflowReworkVerificationPath(fixture.requestId),
			).toMatchObject({ state: "active", current_node_id: "qa" });
			const escalationUid =
				"engine_invariant:run-heavy:qa:1:workflow_rework_delivery_complete_cas_failed";
			expect(
				fixture.store.getWorkflowAlertOutbox(escalationUid)?.payload,
			).toMatchObject({
				eventId: escalationUid,
				metadata: {
					workflowEngine: {
						disposition: "engine_invariant_refusal",
						nodeId: "qa",
						attempt: 1,
					},
				},
			});
			expect(
				fixture.store
					.listWorkflowRunEvents("run-heavy")
					.filter((event) => event.kind === "decision_transition_refused"),
			).toHaveLength(1);
		} finally {
			fixture.store.close();
		}
	});

	it("deduplicates the refusal event and alert when the same decision retries", async () => {
		const fixture = await createFreshQa();
		try {
			rawDb(fixture.store)
				.prepare(
					"UPDATE workflow_rework_delivery SET state = 'completed' WHERE request_id = ?",
				)
				.run(fixture.requestId);
			expect(submitQaPass(fixture).ok).toBe(false);
			expect(submitQaPass(fixture).ok).toBe(false);
			expect(fixture.store.listWorkflowAlertOutbox()).toHaveLength(1);
			expect(
				fixture.store
					.listWorkflowRunEvents("run-heavy")
					.filter((event) => event.kind === "decision_transition_refused"),
			).toHaveLength(1);
		} finally {
			fixture.store.close();
		}
	});

	it("returns a named refusal from the completion boundary", async () => {
		const fixture = await createActiveOperatorRework();
		try {
			ignoreFreshAdvance(fixture.store);
			expect(
				fixture.store.commitEnrolledCompletion({
					nodeReuseEnabled: false,
					executionId: "implement-exec",
					route: "needs_review",
					sourceEventId: "fly1912-completion",
					completionSubmission: { decision: { route: "needs_review" } },
					subjectDigest: HEAD,
					workflowActivation: {
						activationId: fixture.activationId,
						runId: "run-heavy",
						nodeId: "implement",
						attempt: 2,
						turnEpoch: fixture.turnEpoch,
					},
					alertIdentity: ALERT_IDENTITY,
					now: "2026-08-20T00:06:00.000Z",
				}),
			).toEqual({
				ok: false,
				reason: "transition_refused",
				detail: {
					transitionReason:
						"engine_invariant:workflow_rework_verification_advance_cas_failed",
				},
			});
			expect(
				fixture.store
					.listWorkflowRunEvents("run-heavy")
					.filter((event) => event.kind === "completion_transition_refused"),
			).toHaveLength(1);
			expect(
				fixture.store.getWorkflowAlertOutbox(
					"engine_invariant:run-heavy:implement:2:workflow_rework_verification_advance_cas_failed",
				),
			).toBeDefined();
		} finally {
			fixture.store.close();
		}
	});

	it("marks the refusal alert pending when an internal caller has no identity", async () => {
		const fixture = await createFreshQa();
		try {
			rawDb(fixture.store)
				.prepare(
					"UPDATE workflow_rework_delivery SET state = 'completed' WHERE request_id = ?",
				)
				.run(fixture.requestId);
			expect(submitQaPass(fixture, { alertIdentity: false })).toEqual({
				ok: false,
				reason: "transition_refused",
				detail: {
					transitionReason:
						"engine_invariant:workflow_rework_delivery_complete_cas_failed",
					alertPending: true,
				},
			});
			expect(fixture.store.listWorkflowAlertOutbox()).toEqual([]);
		} finally {
			fixture.store.close();
		}
	});

	it("rolls back both the refusal event and alert when their transaction fails", async () => {
		const fixture = await createFreshQa();
		try {
			rawDb(fixture.store)
				.prepare(
					"UPDATE workflow_rework_delivery SET state = 'completed' WHERE request_id = ?",
				)
				.run(fixture.requestId);
			rawDb(fixture.store).exec(`
				CREATE TRIGGER reject_fly1912_alert
				BEFORE INSERT ON workflow_alert_outbox
				BEGIN SELECT RAISE(ABORT, 'injected alert failure'); END
			`);
			expect(() => submitQaPass(fixture)).toThrow("injected alert failure");
			expect(fixture.store.listWorkflowAlertOutbox()).toEqual([]);
			expect(
				fixture.store
					.listWorkflowRunEvents("run-heavy")
					.filter((event) => event.kind === "decision_transition_refused"),
			).toEqual([]);
		} finally {
			fixture.store.close();
		}
	});

	it("rethrows non-invariant transition failures", async () => {
		const fixture = await createActiveOperatorRework();
		try {
			rawDb(fixture.store).exec(`
				CREATE TRIGGER reject_fly1912_node_event
				BEFORE INSERT ON workflow_run_event
				WHEN NEW.kind = 'node_completed'
				BEGIN SELECT RAISE(ABORT, 'injected non-invariant failure'); END
			`);
			expect(() =>
				fixture.store.commitWorkflowTransitionTx({
					nodeReuseEnabled: false,
					runId: "run-heavy",
					nodeId: "implement",
					attempt: 2,
					executionId: "implement-exec",
					outcome: "implement_done",
					now: "2026-08-20T00:06:00.000Z",
				}),
			).toThrow("injected non-invariant failure");
		} finally {
			fixture.store.close();
		}
	});

	it("rolls back the invariant savepoint while allowing the outer transaction to commit", async () => {
		const fixture = await createActiveOperatorRework();
		try {
			ignoreFreshAdvance(fixture.store);
			const raw = rawDb(fixture.store);
			raw.transaction(() => {
				expect(
					fixture.store.commitWorkflowTransitionTx({
						nodeReuseEnabled: false,
						runId: "run-heavy",
						nodeId: "implement",
						attempt: 2,
						executionId: "implement-exec",
						outcome: "implement_done",
						now: "2026-08-20T00:06:00.000Z",
					}),
				).toEqual({
					ok: false,
					reason:
						"engine_invariant:workflow_rework_verification_advance_cas_failed",
				});
				raw
					.prepare(
						`INSERT INTO workflow_run_event
						   (run_id, seq, event_uid, kind, payload, at)
						 SELECT 'run-heavy', COALESCE(MAX(seq), 0) + 1,
						        'fly1912-outer-continued', 'outer_continued', '{}', ?
						   FROM workflow_run_event WHERE run_id = 'run-heavy'`,
					)
					.run("2026-08-20T00:06:01.000Z");
			})();
			expect(
				fixture.store.getWorkflowRunNode("run-heavy", "implement", 2),
			).toMatchObject({ state: "running" });
			expect(
				fixture.store.getWorkflowRunNode("run-heavy", "qa", 1),
			).toBeUndefined();
			expect(
				fixture.store
					.listWorkflowRunEvents("run-heavy")
					.some((event) => event.event_uid === "fly1912-outer-continued"),
			).toBe(true);
		} finally {
			fixture.store.close();
		}
	});
});
