import { describe, expect, it, vi } from "vitest";
import {
	type StateStore,
	type WorkflowEngineAlertIdentity,
	type WorkflowEngineAlertPayload,
	StateStore as WorkflowStateStore,
} from "../StateStore.js";
import { buildWorkflowRunSnapshotV1 } from "../workflow-run-snapshot.js";
import { legacyWorkflowSeeds } from "./fixtures/legacy-workflow-manifests.js";

const HEAD_SHA = "a".repeat(40);
const GATE_OPENED_AT = "2026-07-22T01:00:00.000Z";
const NOW = "2026-07-22T01:31:00.000Z";
const engineFlags = {
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
};
const alertIdentity: WorkflowEngineAlertIdentity = {
	leadId: "flywheel-eng-lead",
	projectName: "flywheel",
	leadResolution: "resolved",
};

type TestDb = {
	run(sql: string, params?: unknown[]): void;
};

function testDb(store: StateStore): TestDb {
	return (store as unknown as { db: TestDb }).db;
}

async function readyRun(runId = "run-ship-ready"): Promise<StateStore> {
	const store = await WorkflowStateStore.create(":memory:");
	const seed = legacyWorkflowSeeds().find(
		(candidate) => candidate.templateId === "tpl_eng_heavy",
	);
	if (!seed) throw new Error("tpl_eng_heavy seed unavailable");
	store.importWorkflowTemplateSeed(seed);
	store.bindWorkflowCategory({
		project: "flywheel",
		taskCategory: "code",
		templateId: seed.templateId,
		updatedBy: "lead",
	});
	store.materializeWorkflowRun({
		runId,
		issueId: "issue-1424",
		projectName: "flywheel",
		taskCategory: "code",
		claimsReadEnrolled: true,
		actor: "lead",
		env: engineFlags,
		startReservation: {
			idempotencyKey: `start-${runId}`,
			selectionDigest: `selection-${runId}`,
			nodeId: "design",
			attempt: 1,
			executionId: `design-${runId}`,
			createdAt: "2026-07-22T00:00:00.000Z",
		},
	});
	testDb(store).run(
		"UPDATE workflow_run SET gate_carrier_epoch = 0 WHERE run_id = ?",
		[runId],
	);
	store.upsertWorkflowRunNode({
		runId,
		nodeId: "design",
		attempt: 1,
		state: "running",
		executionId: `design-${runId}`,
	});
	store.commitWorkflowTransitionTx({
		nodeReuseEnabled: false,
		runId,
		nodeId: "design",
		attempt: 1,
		executionId: `design-${runId}`,
		outcome: "design_done",
		successorExecutionId: `implement-${runId}`,
		now: "2026-07-22T00:10:00.000Z",
	});
	store.commitWorkflowTransitionTx({
		nodeReuseEnabled: false,
		runId,
		nodeId: "implement",
		attempt: 1,
		executionId: `implement-${runId}`,
		outcome: "implement_done",
		successorExecutionId: `qa-${runId}`,
		now: "2026-07-22T00:20:00.000Z",
	});
	const admission = store.admitGeneralizedWorkflowExecution({
		runId,
		nodeId: "qa",
		executionId: `qa-${runId}`,
		attempt: 1,
		expiresAt: "2026-07-23T00:00:00.000Z",
		absoluteDeadlineAt: "2026-07-24T00:00:00.000Z",
		now: "2026-07-22T00:30:00.000Z",
		env: engineFlags,
	});
	if (!admission.ok || !admission.submissionCredential) {
		throw new Error("QA admission failed");
	}
	store.upsertSession({
		execution_id: `qa-${runId}`,
		issue_id: "issue-1424",
		issue_identifier: "FLY-1424",
		project_name: "flywheel",
		status: "running",
		workflow_node_id: "qa",
	});
	const submitted = store.submitWorkflowDecisionByCredential({
		nodeReuseEnabled: false,
		credential: admission.submissionCredential,
		clientRequestId: `qa-pass-${runId}`,
		predicate: "qa_passed",
		subjectDigest: HEAD_SHA,
		issuerVendor: "claude",
		issuerModel: "claude-opus-4-8",
		subjectProducerExecutionId: `implement-${runId}`,
		subjectProducerVendor: "codex",
		claimExpiresAt: "2026-07-23T00:00:00.000Z",
		now: GATE_OPENED_AT,
	});
	if (!submitted.ok)
		throw new Error(`QA submission failed: ${submitted.reason}`);

	store.upsertSession({
		execution_id: `qa-${runId}`,
		issue_id: "issue-1424",
		issue_identifier: "FLY-1424",
		project_name: "flywheel",
		status: "completed",
		pr_number: 1424,
		pr_head_sha: HEAD_SHA,
	});
	// workflow_run_node predates explicit transition timestamps; pin the fixture
	// so age and deterministic stalled payload assertions do not depend on wall time.
	testDb(store).run(
		"UPDATE workflow_run_node SET started_at = ? WHERE run_id = ? AND node_id = ? AND attempt = 1",
		[GATE_OPENED_AT, runId, "founder_gate"],
	);
	return store;
}

function conflictingAlertPayload(runId: string): WorkflowEngineAlertPayload {
	return {
		leadId: alertIdentity.leadId,
		projectName: alertIdentity.projectName,
		eventId: `ship_ready_delivery_failed:${runId}:founder_gate:1`,
		eventType: "workflow_engine_issue_alert",
		title: "conflicting pre-existing payload",
		body: "conflict",
		severity: "severe",
		sessionKey: `wf:${runId}`,
		metadata: {
			workflowEngine: {
				runId,
				issueId: "issue-1424",
				nodeId: "founder_gate",
				executionId: `qa-${runId}`,
				disposition: "ship_ready_delivery_failed",
				leadResolution: "resolved",
			},
		},
	};
}

function seedGateCandidate(input: {
	store: StateStore;
	runId: string;
	issueId: string;
	snapshot: string;
}): void {
	input.store.createWorkflowRun({
		runId: input.runId,
		issueId: input.issueId,
		projectName: "flywheel",
		snapshotJson: input.snapshot,
		claimsReadEnrolled: true,
	});
	testDb(input.store).run(
		"UPDATE workflow_run SET engine_owned = 1, gate_carrier_epoch = 0, current_node_id = 'founder_gate' WHERE run_id = ?",
		[input.runId],
	);
	testDb(input.store).run(
		"INSERT INTO workflow_run_node (run_id, node_id, attempt, state, started_at) VALUES (?, 'founder_gate', 1, 'review', ?)",
		[input.runId, GATE_OPENED_AT],
	);
}

describe("workflow ship-ready StateStore contract", () => {
	it("finds a v1 non-land terminal gate with QA and PR evidence", async () => {
		const store = await readyRun();
		expect(store.listWorkflowShipReadyGates({ now: NOW })).toEqual([
			{
				runId: "run-ship-ready",
				issueId: "issue-1424",
				issueIdentifier: "FLY-1424",
				projectName: "flywheel",
				templateId: "tpl_eng_heavy",
				gateNodeId: "founder_gate",
				attempt: 1,
				gateOpenedAt: GATE_OPENED_AT,
				sourceExecutionId: "qa-run-ship-ready",
				ageMinutes: 31,
				evidence: {
					headSha: HEAD_SHA,
					prNumber: 1424,
					qaPassed: true,
				},
				pending: { lead: true, founder: true },
			},
		]);
		store.close();
	});

	it("yields epoch-1 Gate-carrier runs to the authoritative holder path", async () => {
		const store = await readyRun();
		testDb(store).run(
			"UPDATE workflow_run SET gate_carrier_epoch = 1 WHERE run_id = 'run-ship-ready'",
		);

		expect(store.listWorkflowShipReadyGates({ now: NOW })).toEqual([]);
		expect(
			store.listWorkflowShipReadyStalled({
				now: NOW,
				remindAfterMs: 1,
			}),
		).toEqual([]);
		store.close();
	});

	it("requires engine ownership, active review at the current terminal gate, and no founder claim", async () => {
		const mutations = [
			"UPDATE workflow_run SET engine_owned = 0 WHERE run_id = 'run-ship-ready'",
			"UPDATE workflow_run SET status = 'completed' WHERE run_id = 'run-ship-ready'",
			"UPDATE workflow_run SET current_node_id = 'qa' WHERE run_id = 'run-ship-ready'",
			"UPDATE workflow_run_node SET state = 'pending' WHERE run_id = 'run-ship-ready' AND node_id = 'founder_gate'",
		] as const;
		for (const mutation of mutations) {
			const store = await readyRun();
			testDb(store).run(mutation);
			expect(store.listWorkflowShipReadyGates({ now: NOW })).toEqual([]);
			store.close();
		}

		const claimed = await readyRun();
		testDb(claimed).run(
			`INSERT INTO workflow_claims
			   (server_seq, issue_id, workflow_run_id, decision_kind, predicate,
			    issuer_kind, subject_kind, subject_digest, permanent, authority_id)
			 VALUES (999, 'issue-1424', 'run-ship-ready', 'founder_decision',
			         'founder_approved', 'founder_challenge', 'git_head', ?, 1,
			         'founder-gate-question')`,
			[HEAD_SHA],
		);
		expect(claimed.listWorkflowShipReadyGates({ now: NOW })).toEqual([]);
		claimed.close();
	});

	it("excludes land_v1 and non-engineering template scopes", async () => {
		const store = await WorkflowStateStore.create(":memory:");
		const seeds = legacyWorkflowSeeds();
		const land = seeds.find(
			(candidate) => candidate.templateId === "tpl_eng_heavy_land_v1",
		);
		const heavy = seeds.find(
			(candidate) => candidate.templateId === "tpl_eng_heavy",
		);
		if (!land || land.manifest.schema_version !== 1 || !heavy) {
			throw new Error("bundled workflow seeds unavailable");
		}
		seedGateCandidate({
			store,
			runId: "run-land",
			issueId: "issue-land",
			snapshot: JSON.stringify(
				buildWorkflowRunSnapshotV1({
					template: { id: land.templateId, revision: 1 },
					manifest: land.manifest,
				}),
			),
		});
		seedGateCandidate({
			store,
			runId: "run-product-scope",
			issueId: "issue-product",
			snapshot: JSON.stringify(
				buildWorkflowRunSnapshotV1({
					template: { id: "tpl_product_v1", revision: 1 },
					manifest: heavy.manifest,
				}),
			),
		});
		expect(store.listWorkflowShipReadyGates({ now: NOW })).toEqual([]);
		store.close();
	});

	it("degrades missing QA evidence safely and keys delivery facts by gate attempt", async () => {
		const source = await readyRun();
		const snapshot = source.getWorkflowRun("run-ship-ready")?.snapshot;
		source.close();
		if (!snapshot) throw new Error("snapshot unavailable");
		const store = await WorkflowStateStore.create(":memory:");
		seedGateCandidate({
			store,
			runId: "run-no-evidence",
			issueId: "issue-no-evidence",
			snapshot,
		});
		expect(store.listWorkflowShipReadyGates({ now: NOW })[0]).toMatchObject({
			evidence: { qaPassed: false },
			pending: { lead: true, founder: true },
		});

		store.recordWorkflowShipReadyFact({
			runId: "run-no-evidence",
			gateNodeId: "founder_gate",
			attempt: 1,
			path: "lead",
			now: NOW,
		});
		testDb(store).run(
			"UPDATE workflow_run_node SET state = 'done' WHERE run_id = 'run-no-evidence' AND node_id = 'founder_gate' AND attempt = 1",
		);
		testDb(store).run(
			"INSERT INTO workflow_run_node (run_id, node_id, attempt, state, started_at) VALUES ('run-no-evidence', 'founder_gate', 2, 'review', ?)",
			[GATE_OPENED_AT],
		);
		expect(store.listWorkflowShipReadyGates({ now: NOW })[0]).toMatchObject({
			attempt: 2,
			pending: { lead: true, founder: true },
		});
		store.close();
	});

	it("tracks the lead and founder paths independently and makes failure terminal only for founder", async () => {
		const store = await readyRun();
		expect(
			store.recordWorkflowShipReadyFact({
				runId: "run-ship-ready",
				gateNodeId: "founder_gate",
				attempt: 1,
				path: "lead",
				now: NOW,
			}),
		).toEqual({ ok: true, idempotentReplay: false });
		expect(
			store.recordWorkflowShipReadyFact({
				runId: "run-ship-ready",
				gateNodeId: "founder_gate",
				attempt: 1,
				path: "lead",
				now: "2026-07-22T01:32:00.000Z",
			}),
		).toEqual({ ok: true, idempotentReplay: true });
		expect(store.listWorkflowShipReadyGates({ now: NOW })[0]?.pending).toEqual({
			lead: false,
			founder: true,
		});

		expect(
			store.recordWorkflowShipReadyDeliveryFailure({
				runId: "run-ship-ready",
				gateNodeId: "founder_gate",
				attempt: 1,
				reason: "missing_owner",
				gateOpenedAt: GATE_OPENED_AT,
				sourceExecutionId: "qa-run-ship-ready",
				alertIdentity,
				now: NOW,
			}),
		).toEqual({ ok: true, idempotentReplay: false });
		expect(store.listWorkflowShipReadyGates({ now: NOW })).toEqual([]);
		expect(store.listWorkflowAlertOutbox()).toHaveLength(1);
		expect(
			store.listWorkflowAlertOutbox()[0]?.payload.metadata.workflowEngine,
		).toMatchObject({
			disposition: "ship_ready_delivery_failed",
			runId: "run-ship-ready",
		});
		store.close();

		const leadPending = await readyRun("run-lead-pending");
		leadPending.recordWorkflowShipReadyDeliveryFailure({
			runId: "run-lead-pending",
			gateNodeId: "founder_gate",
			attempt: 1,
			reason: "missing_owner",
			gateOpenedAt: GATE_OPENED_AT,
			sourceExecutionId: "qa-run-lead-pending",
			alertIdentity,
			now: NOW,
		});
		expect(
			leadPending.listWorkflowShipReadyGates({ now: NOW })[0]?.pending,
		).toEqual({ lead: true, founder: false });
		leadPending.close();
	});

	it("keeps stalled detection independent from delivery facts and converges after handled observation", async () => {
		const store = await readyRun();
		for (const path of ["lead", "founder"] as const) {
			store.recordWorkflowShipReadyFact({
				runId: "run-ship-ready",
				gateNodeId: "founder_gate",
				attempt: 1,
				path,
				now: NOW,
			});
		}
		expect(store.listWorkflowShipReadyGates({ now: NOW })).toEqual([]);
		expect(
			store.listWorkflowShipReadyStalled({
				now: NOW,
				remindAfterMs: 1_800_000,
			}),
		).toHaveLength(1);

		expect(
			store.recordWorkflowShipReadyHandledObserved({
				runId: "run-ship-ready",
				gateNodeId: "founder_gate",
				attempt: 1,
				reason: "pr_merged",
				now: NOW,
			}),
		).toEqual({ ok: true, idempotentReplay: false });
		expect(
			store.listWorkflowShipReadyStalled({
				now: NOW,
				remindAfterMs: 1_800_000,
			}),
		).toEqual([]);
		// handled_observed is reminder-only convergence and must never impersonate
		// completion of either delivery arm.
		const pendingStore = await readyRun("run-handled-pending");
		pendingStore.recordWorkflowShipReadyHandledObserved({
			runId: "run-handled-pending",
			gateNodeId: "founder_gate",
			attempt: 1,
			reason: "pr_merged",
			now: NOW,
		});
		expect(
			pendingStore.listWorkflowShipReadyGates({ now: NOW })[0]?.pending,
		).toEqual({ lead: true, founder: true });
		pendingStore.close();
		store.close();
	});

	it("records a stalled fact and deterministic alert exactly once", async () => {
		const store = await readyRun();
		const input = {
			runId: "run-ship-ready",
			gateNodeId: "founder_gate",
			attempt: 1,
			gateOpenedAt: GATE_OPENED_AT,
			sourceExecutionId: "qa-run-ship-ready",
			alertIdentity,
			now: NOW,
		};
		expect(store.recordWorkflowShipReadyStalledAlert(input)).toEqual({
			ok: true,
			idempotentReplay: false,
		});
		expect(
			store.recordWorkflowShipReadyStalledAlert({
				...input,
				now: "2026-07-22T01:40:00.000Z",
			}),
		).toEqual({ ok: true, idempotentReplay: true });
		expect(
			store.listWorkflowShipReadyStalled({ now: NOW, remindAfterMs: 1 }),
		).toEqual([]);
		expect(store.listWorkflowAlertOutbox()).toHaveLength(1);
		expect(store.listWorkflowAlertOutbox()[0]?.payload.body).toContain(
			GATE_OPENED_AT,
		);
		store.close();
	});

	it("rolls back delivery-failure and stalled facts when their alerts conflict", async () => {
		const store = await readyRun("run-atomic");
		const escalationUid =
			"ship_ready_delivery_failed:run-atomic:founder_gate:1";
		store.enqueueWorkflowEngineAlert({
			escalationUid,
			runId: "run-atomic",
			payload: conflictingAlertPayload("run-atomic"),
			now: NOW,
		});
		expect(() =>
			store.recordWorkflowShipReadyDeliveryFailure({
				runId: "run-atomic",
				gateNodeId: "founder_gate",
				attempt: 1,
				reason: "permanent_failure",
				gateOpenedAt: GATE_OPENED_AT,
				sourceExecutionId: "qa-run-atomic",
				alertIdentity,
				now: NOW,
			}),
		).toThrow(`workflow_alert_uid_conflict:${escalationUid}`);
		expect(
			store
				.listWorkflowRunEvents("run-atomic")
				.some((event) => event.kind === "ship_ready_delivery_failed"),
		).toBe(false);
		store.close();

		const stalled = await readyRun("run-stalled-atomic");
		const stalledUid = "ship_ready_stalled:run-stalled-atomic:founder_gate:1";
		stalled.enqueueWorkflowEngineAlert({
			escalationUid: stalledUid,
			runId: "run-stalled-atomic",
			payload: {
				...conflictingAlertPayload("run-stalled-atomic"),
				eventId: stalledUid,
			},
			now: NOW,
		});
		expect(() =>
			stalled.recordWorkflowShipReadyStalledAlert({
				runId: "run-stalled-atomic",
				gateNodeId: "founder_gate",
				attempt: 1,
				gateOpenedAt: GATE_OPENED_AT,
				sourceExecutionId: "qa-run-stalled-atomic",
				alertIdentity,
				now: NOW,
			}),
		).toThrow(`workflow_alert_uid_conflict:${stalledUid}`);
		expect(
			stalled
				.listWorkflowRunEvents("run-stalled-atomic")
				.some((event) => event.kind === "ship_ready_stalled_alerted"),
		).toBe(false);
		stalled.close();
	});

	it("warns above the diagnostic guard but never truncates ready rows", async () => {
		const store = await readyRun();
		const prototype = store.getWorkflowRun("run-ship-ready");
		if (!prototype?.snapshot) throw new Error("prototype snapshot unavailable");
		const db = testDb(store);
		for (let index = 1; index <= 500; index += 1) {
			const runId = `run-extra-${index}`;
			store.createWorkflowRun({
				runId,
				issueId: `issue-extra-${index}`,
				projectName: "flywheel",
				templateId: prototype.template_id ?? undefined,
				templateRevision: prototype.template_revision ?? undefined,
				snapshotJson: prototype.snapshot,
				claimsReadEnrolled: true,
			});
			db.run(
				"UPDATE workflow_run SET engine_owned = 1, gate_carrier_epoch = 0, current_node_id = 'founder_gate' WHERE run_id = ?",
				[runId],
			);
			db.run(
				"INSERT INTO workflow_run_node (run_id, node_id, attempt, state, started_at) VALUES (?, 'founder_gate', 1, 'review', ?)",
				[runId, GATE_OPENED_AT],
			);
		}
		const warning = vi
			.spyOn(console, "warn")
			.mockImplementation(() => undefined);
		expect(store.listWorkflowShipReadyGates({ now: NOW })).toHaveLength(501);
		expect(
			store.listWorkflowShipReadyStalled({ now: NOW, remindAfterMs: 1 }),
		).toHaveLength(501);
		expect(warning).toHaveBeenCalledTimes(2);
		warning.mockRestore();
		store.close();
	});
});
