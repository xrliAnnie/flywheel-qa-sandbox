import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { classifyDeliveryAttempt } from "../bridge/delivery-contract/classify.js";
import { DeliveryContractWatch } from "../bridge/delivery-contract/watch.js";
import {
	buildWorkflowReworkContext,
	renderWorkflowReworkLaunchStableSection,
	workflowReworkLaunchDigest,
} from "../bridge/workflow-rework-context.js";
import { StateStore } from "../StateStore.js";
import {
	legacyWorkflowSeeds,
	pinLegacyWorkflowSeedAgents,
} from "./fixtures/legacy-workflow-manifests.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const WORKFLOW_ON = {
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
};
const HEAD = "a".repeat(40);
const REQUEST_ID = "fly2504-rework";
const DEAD_EXECUTION_ID = "qa-1";
const REPLACEMENT_ID = "qa-replacement-2";
const T0 = "2026-08-27T19:28:15.000Z";
const at = (minutes: number) =>
	new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const stores: StateStore[] = [];
const scratchDirectories: string[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const dir of scratchDirectories.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function rawDb(store: StateStore) {
	return (
		store as unknown as { db: { raw: import("better-sqlite3").Database } }
	).db.raw;
}
function dbRun(store: StateStore, sql: string, params: unknown[] = []) {
	(
		store as unknown as { db: { run(sql: string, params: unknown[]): void } }
	).db.run(sql, params);
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

async function seedReplacementBeforeLaunchMark(
	nodeId: "qa" | "implement" = "qa",
	activationMode: "replacement" | "wake" = "replacement",
): Promise<{
	store: StateStore;
	attemptId: string;
}> {
	const store = await seedQaIntent();
	store.upsertSession({
		execution_id: DEAD_EXECUTION_ID,
		issue_id: "FLY-1307",
		project_name: "flywheel",
		status: "failed",
		session_role: nodeId,
	});
	store.upsertWorkflowRunNode({
		runId: "run-1",
		nodeId,
		attempt: 2,
		state: "pending",
		executionId: DEAD_EXECUTION_ID,
	});
	dbRun(
		store,
		`INSERT OR IGNORE INTO workflow_actor
		   (execution_id, project_name, issue_id, role, created_at)
		 VALUES (?, 'flywheel', 'FLY-1307', '${nodeId}', ?)`,
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
		 VALUES (?, 1, '${nodeId}', 2, ?, '${JSON.stringify(nodeId === "qa" ? ["qa"] : ["implement", "qa"])}', '["qa_retest","founder_gate"]',
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
		 VALUES (?, 'run-1', 1, 'pending', '${nodeId}', 2, ?)`,
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
			nodeId,
			executionId: REPLACEMENT_ID,
			attempt: 2,
			activationId: "activation-fly2096-qa-replacement-2",
			activationMode,
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
		session_role: nodeId,
		heartbeat_at: T0,
		last_activity_at: T0,
	});
	store.upsertWorkflowRunNode({
		runId: "run-1",
		nodeId,
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
	dbRun(
		store,
		`INSERT INTO workflow_claims
		   (server_seq, issued_at, issue_id, workflow_run_id, node_id,
		    decision_kind, attempt, predicate, issuer_kind,
		    issuer_execution_id, issuer_node_id, issuer_vendor, issuer_model,
		    subject_producer_execution_id, subject_kind, subject_digest,
		    permanent, submission_digest, client_request_id, authority_id)
		 VALUES (1, ?, 'FLY-1307', 'run-1', '${nodeId}',
		         'qa_verdict', 2, 'qa_passed', 'runner_node',
		         ?, '${nodeId}', 'claude', 'claude-opus-5',
		         'implement-1', 'git_head', ?, 1,
		         'fly2096-qa-submission', 'fly2096-qa-client', ?)`,
		[T0, REPLACEMENT_ID, HEAD, REPLACEMENT_ID],
	);
	expect(store.getWorkflowExecutionBinding(REPLACEMENT_ID)?.mode).toBe(
		activationMode,
	);
	expect(store.getWorkflowReworkDelivery(REQUEST_ID)?.state).toBe(
		"replacement_pending",
	);
	return { store, attemptId: "unused" };
}

function seedLegacyLaunchMark(store: StateStore, _input: unknown) {
	dbRun(
		store,
		"UPDATE workflow_rework_delivery SET state = 'wake_delivered' WHERE request_id = ?",
		[REQUEST_ID],
	);
	dbRun(
		store,
		"UPDATE workflow_rework_verification_path SET state = 'active' WHERE request_id = ?",
		[REQUEST_ID],
	);
	return { ok: true };
}

describe("FLY-2504 replacement rework receipt", () => {
	it("N1a refuses completion before replacement content delivery with no transition writes", async () => {
		const { store } = await seedReplacementBeforeLaunchMark();
		const before = rawDb(store)
			.prepare("SELECT * FROM workflow_run_event ORDER BY seq")
			.all();
		const nodeBefore = store.listWorkflowRunNodes("run-1");
		expect(
			store.commitWorkflowTransitionTx({
				nodeReuseEnabled: false,
				runId: "run-1",
				nodeId: "qa",
				attempt: 2,
				executionId: REPLACEMENT_ID,
				outcome: "qa_pass",
				subjectDigest: HEAD,
				now: at(1),
			}),
		).toMatchObject({
			ok: false,
			reason: "rework_content_not_delivered",
			detail: {
				requestId: REQUEST_ID,
				deliveryState: "replacement_pending",
				routeRevision: 2,
			},
		});
		expect(store.getWorkflowReworkDelivery(REQUEST_ID)?.state).toBe(
			"replacement_pending",
		);
		expect(store.listWorkflowRunNodes("run-1")).toEqual(nodeBefore);
		expect(
			rawDb(store)
				.prepare("SELECT * FROM workflow_run_event ORDER BY seq")
				.all(),
		).toEqual(before);
	});
});

describe("FLY-2504 transition receipt boundaries", () => {
	it("N4e refuses legacy wake_delivered without revision-bound launch evidence", async () => {
		const { store } = await seedReplacementBeforeLaunchMark();
		expect(
			seedLegacyLaunchMark(store, {
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
				executionId: REPLACEMENT_ID,
				now: T0,
			}),
		).toMatchObject({ ok: true });
		expect(
			store.commitWorkflowTransitionTx({
				nodeReuseEnabled: false,
				runId: "run-1",
				nodeId: "qa",
				attempt: 2,
				executionId: REPLACEMENT_ID,
				outcome: "qa_pass",
				subjectDigest: HEAD,
				now: at(1),
			}),
		).toMatchObject({ ok: false, reason: "rework_content_not_delivered" });
	});
	it("N5 refuses stale route identity without changing the delivery", async () => {
		const { store } = await seedReplacementBeforeLaunchMark();
		dbRun(
			store,
			`INSERT INTO workflow_rework_route_revision SELECT request_id, 3, target_node_id, target_attempt, 'qa-1', invalidation_scope_json, verification_policy_json, interpreted_by, interpretation_reason, created_at FROM workflow_rework_route_revision WHERE request_id = ? AND revision = 2`,
			[REQUEST_ID],
		);
		expect(
			store.commitWorkflowTransitionTx({
				nodeReuseEnabled: false,
				runId: "run-1",
				nodeId: "qa",
				attempt: 2,
				executionId: REPLACEMENT_ID,
				outcome: "qa_pass",
				subjectDigest: HEAD,
				now: at(1),
			}),
		).toMatchObject({ ok: false, reason: "rework_receipt_identity_conflict" });
		expect(store.getWorkflowRun("run-1")?.status).toBe("active");
		expect(store.getWorkflowReworkDelivery(REQUEST_ID)?.state).toBe(
			"replacement_pending",
		);
	});
	it("P3 accepts exact revision launch evidence and settles delivery", async () => {
		const { store } = await seedReplacementBeforeLaunchMark();
		expect(
			seedLegacyLaunchMark(store, {
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
				executionId: REPLACEMENT_ID,
				now: T0,
			}),
		).toMatchObject({ ok: true });
		store.appendWorkflowRunEvent({
			runId: "run-1",
			eventUid: `rework_replacement_launched:${REQUEST_ID}:2:${REPLACEMENT_ID}`,
			kind: "rework_replacement_launched",
			nodeId: "qa",
			executionId: REPLACEMENT_ID,
			payload: {
				requestId: REQUEST_ID,
				routeRevision: 2,
				carrier: "launch_envelope",
				contentDigest: "c".repeat(64),
			},
		});
		expect(
			store.commitWorkflowTransitionTx({
				nodeReuseEnabled: false,
				runId: "run-1",
				nodeId: "qa",
				attempt: 2,
				executionId: REPLACEMENT_ID,
				outcome: "qa_pass",
				subjectDigest: HEAD,
				now: at(1),
			}),
		).toMatchObject({ ok: true });
		expect(store.getWorkflowReworkDelivery(REQUEST_ID)?.state).toBe(
			"completed",
		);
	});
});

const ALERT_IDENTITY = {
	leadId: "flywheel-eng-lead",
	projectName: "flywheel",
	leadResolution: "resolved" as const,
};
function enrolledComplete(store: StateStore, sourceEventId = "completion-1") {
	return store.commitEnrolledCompletion({
		nodeReuseEnabled: false,
		executionId: REPLACEMENT_ID,
		route: "needs_review",
		sourceEventId,
		completionSubmission: { decision: { route: "needs_review" } },
		subjectDigest: HEAD,
		alertIdentity: ALERT_IDENTITY,
		now: at(1),
	});
}
describe("FLY-2504 enrolled completion refusal", () => {
	it("closes a superseded attempt's open episode before opening the replacement refusal hold", async () => {
		const { store } = await seedReplacementBeforeLaunchMark("implement");
		const prior = rawDb(store)
			.prepare(
				"SELECT root_id, attempt_id FROM workflow_delivery_attempt WHERE family = 'rework' AND json_extract(contract_ref_json, '$.pk') = ? AND superseded_by_attempt_id IS NOT NULL ORDER BY generation DESC LIMIT 1",
			)
			.get(REQUEST_ID) as { root_id: string; attempt_id: string };
		expect(prior).toBeDefined();
		dbRun(
			store,
			`INSERT INTO workflow_delivery_contract_episode
			(episode_id, family, root_id, attempt_id, run_id, stage, stage_entered_at, opened_at, escalation_uid)
			VALUES ('prior-stalled', 'rework', ?, ?, 'run-1', 'stalled', ?, ?, 'prior-stall-alert')`,
			[prior.root_id, prior.attempt_id, at(-1), at(-1)],
		);
		expect(enrolledComplete(store)).toMatchObject({
			ok: false,
			reason: "rework_content_not_delivered",
			retryable: false,
		});
		expect(
			rawDb(store)
				.prepare(
					"SELECT closed_at, closed_reason FROM workflow_delivery_contract_episode WHERE episode_id = 'prior-stalled'",
				)
				.get(),
		).toMatchObject({
			closed_at: expect.any(String),
			closed_reason: "superseded_by_undeliverable",
		});
		const episodes = rawDb(store)
			.prepare(
				"SELECT attempt_id, stage FROM workflow_delivery_contract_episode WHERE family = 'rework' AND root_id = ? AND closed_at IS NULL",
			)
			.all(prior.root_id);
		expect(episodes).toHaveLength(1);
		expect(episodes[0]).toMatchObject({ stage: "undeliverable" });
		expect((episodes[0] as { attempt_id: string }).attempt_id).not.toBe(
			prior.attempt_id,
		);
		expect(store.getWorkflowRun("run-1")?.status).toBe("held");
		expect(
			store.getWorkflowNodeCompletion("run-1", "implement", 2),
		).toBeUndefined();
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((e) => e.kind === "completion_transition_refused"),
		).toHaveLength(1);
		expect(store.listWorkflowAlertOutbox()).toHaveLength(1);
		expect(store.listWorkflowHolds("run-1")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					shape: "delivery_undeliverable_no_recipient",
				}),
			]),
		);
		expect(enrolledComplete(store, "replacement-refusal-replay")).toMatchObject(
			{ ok: false, reason: "rework_content_not_delivered" },
		);
		expect(store.listWorkflowAlertOutbox()).toHaveLength(1);
	});

	it("N1b/N13b rolls back completion and atomically opens the operator hold with one alert", async () => {
		const { store } = await seedReplacementBeforeLaunchMark("implement");
		expect(enrolledComplete(store)).toMatchObject({
			ok: false,
			reason: "rework_content_not_delivered",
			retryable: false,
			detail: {
				requestId: REQUEST_ID,
				routeRevision: 2,
				deliveryState: "replacement_pending",
			},
		});
		expect(
			rawDb(store)
				.prepare(
					"SELECT * FROM workflow_node_completion WHERE execution_id = ?",
				)
				.all(REPLACEMENT_ID),
		).toEqual([]);
		expect(store.getWorkflowRun("run-1")?.status).toBe("held");
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.find((e) => e.kind === "delivery_reroute_operator_required")?.payload,
		).toMatchObject({
			cause: "rework_content_not_delivered",
			runHeld: true,
			livenessVerdict: "not_applicable",
			liveness: { verdict: "not_applicable", reason: "content_never_sent" },
		});

		const refusals = store
			.listWorkflowRunEvents("run-1")
			.filter((e) => e.kind === "completion_transition_refused");
		expect(refusals).toHaveLength(1);
		expect(refusals[0]!.payload).toMatchObject({
			transitionReason: "rework_content_not_delivered",
		});
		expect(store.listWorkflowAlertOutbox()).toHaveLength(1);
		expect(store.listWorkflowHolds("run-1")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					shape: "delivery_undeliverable_no_recipient",
				}),
			]),
		);
		const before = store.listWorkflowRunEvents("run-1");
		expect(enrolledComplete(store, "completion-2")).toMatchObject({
			ok: false,
			reason: "rework_content_not_delivered",
			retryable: false,
		});
		expect(store.listWorkflowRunEvents("run-1")).toEqual(before);
		expect(store.listWorkflowAlertOutbox()).toHaveLength(1);
	});
});

function cancelReworkHold(store: StateStore) {
	const hold = store
		.listWorkflowHolds("run-1")
		.find((h) => h.shape === "delivery_undeliverable_no_recipient")!;
	const normalized = StateStore.canonicalizeHoldResume({
		runId: "run-1",
		shape: hold.shape,
		holdEventUid: hold.holdEventUid,
		decision: "cancel",
		reason: "cancel undelivered rework",
		principal: "master",
		clientRequestId: "cancel-rework-1",
	});
	if (!normalized) throw new Error("invalid resume fixture");
	return store.resumeWorkflowHold({
		canonical: normalized.canonical,
		digest: normalized.digest,
		now: at(2),
	});
}
describe("FLY-2504 operator recovery and atomicity", () => {
	it.each(["running", "failed"] as const)(
		"preserves refusal recovery through a real sweep with recipient %s",
		async (status) => {
			const { store } = await seedReplacementBeforeLaunchMark("implement");
			expect(enrolledComplete(store)).toMatchObject({
				ok: false,
				reason: "rework_content_not_delivered",
			});
			store.upsertSession({
				execution_id: REPLACEMENT_ID,
				project_name: "flywheel",
				issue_id: "FLY-1307",
				status,
			});
			const before = rawDb(store)
				.prepare(
					"SELECT * FROM workflow_delivery_contract_episode WHERE family = 'rework' AND closed_at IS NULL",
				)
				.all();
			expect(before).toHaveLength(1);
			const watch = new DeliveryContractWatch({
				store,
				projectName: "flywheel",
				resolveAlertIdentity: () => ALERT_IDENTITY,
			});
			expect(watch.runPass(at(1.2)).observed).toBeGreaterThan(0);
			expect(
				rawDb(store)
					.prepare(
						"SELECT * FROM workflow_delivery_contract_episode WHERE family = 'rework' AND closed_at IS NULL",
					)
					.all(),
			).toEqual(before);
			expect(store.listWorkflowHolds("run-1")).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						shape: "delivery_undeliverable_no_recipient",
						resumable: true,
					}),
				]),
			);
			expect(cancelReworkHold(store)).toMatchObject({ ok: true });
			expect(store.getWorkflowReworkDelivery(REQUEST_ID)).toMatchObject({
				state: "completed",
				last_error: "cancelled_by_operator",
			});
		},
	);
	it.each(["settled", "superseded"] as const)(
		"does not preserve the refusal episode when its attempt becomes %s",
		async (terminal) => {
			const { store } = await seedReplacementBeforeLaunchMark("implement");
			expect(enrolledComplete(store)).toMatchObject({
				ok: false,
				reason: "rework_content_not_delivered",
			});
			const live = store
				.listLiveWorkflowDeliveryAttempts({ limit: 100 })
				.find(
					(a) =>
						a.family === "rework" &&
						JSON.parse(a.contract_ref_json).pk === REQUEST_ID,
				)!;
			expect(live).toBeDefined();
			const attempt = {
				...live,
				...(terminal === "settled"
					? { settlement_reason: "cancelled_by_operator" }
					: { superseded_by_attempt_id: "next-generation" }),
			};
			const classification = classifyDeliveryAttempt(attempt, at(1.2));
			store.observeWorkflowDeliveryContract({
				attempt,
				classification,
				runId: null,
				projectName: "flywheel",
				issueId: "FLY-1307",
				now: at(1.2),
				alertIdentity: ALERT_IDENTITY,
			});
			expect(
				rawDb(store)
					.prepare(
						"SELECT * FROM workflow_delivery_contract_episode WHERE family = 'rework' AND closed_at IS NULL",
					)
					.all(),
			).toEqual([]);
		},
	);

	it("N15 cancels undelivered rework through the public hold API then accepts completion", async () => {
		const { store } = await seedReplacementBeforeLaunchMark("implement");
		prepareReplacementLaunch(store, undefined);
		expect(markReplacementStarted(store)).toMatchObject({
			ok: false,
			reason: "rework_replacement_launch_content_missing",
		});
		// A historical committed launch cannot be certified on adoption.
		expect(store.getWorkflowLaunchOwner(REPLACEMENT_ID)?.delivery_state).toBe(
			"delivered",
		);
		expect(enrolledComplete(store)).toMatchObject({
			ok: false,
			reason: "rework_content_not_delivered",
		});
		expect(cancelReworkHold(store)).toMatchObject({ ok: true });
		expect(store.getWorkflowReworkDelivery(REQUEST_ID)).toMatchObject({
			state: "completed",
			last_error: "cancelled_by_operator",
		});
		expect(enrolledComplete(store, "completion-after-cancel")).toMatchObject({
			ok: true,
		});
	});
	it("N13c refuses stale identity without changing run, delivery or episodes", async () => {
		const { store } = await seedReplacementBeforeLaunchMark("implement");
		dbRun(
			store,
			`INSERT INTO workflow_rework_route_revision SELECT request_id, 3, target_node_id, target_attempt, 'qa-1', invalidation_scope_json, verification_policy_json, interpreted_by, interpretation_reason, created_at FROM workflow_rework_route_revision WHERE request_id = ? AND revision = 2`,
			[REQUEST_ID],
		);
		const delivery = store.getWorkflowReworkDelivery(REQUEST_ID);
		const episodes = rawDb(store)
			.prepare("SELECT * FROM workflow_delivery_contract_episode")
			.all();
		expect(enrolledComplete(store)).toMatchObject({
			ok: false,
			reason: "rework_receipt_identity_conflict",
			retryable: false,
		});
		expect(store.getWorkflowRun("run-1")?.status).toBe("active");
		expect(store.getWorkflowReworkDelivery(REQUEST_ID)).toEqual(delivery);
		expect(
			rawDb(store)
				.prepare("SELECT * FROM workflow_delivery_contract_episode")
				.all(),
		).toEqual(episodes);
		expect(store.listWorkflowAlertOutbox()).toHaveLength(1);
		expect(enrolledComplete(store, "second-conflict")).toMatchObject({
			ok: false,
			reason: "rework_receipt_identity_conflict",
		});
		expect(store.listWorkflowAlertOutbox()).toHaveLength(1);
	});
	it("N13b rolls back hold and refusal if durable alert insertion fails", async () => {
		const { store } = await seedReplacementBeforeLaunchMark("implement");
		const before = store.listWorkflowRunEvents("run-1");
		dbRun(
			store,
			`CREATE TRIGGER fail_refusal_alert BEFORE INSERT ON workflow_alert_outbox BEGIN SELECT RAISE(ABORT, 'injected_alert_failure'); END`,
		);
		expect(() => enrolledComplete(store)).toThrow("injected_alert_failure");
		expect(store.getWorkflowRun("run-1")?.status).toBe("active");
		expect(store.listWorkflowRunEvents("run-1")).toEqual(before);
		expect(
			rawDb(store)
				.prepare("SELECT * FROM workflow_delivery_contract_episode")
				.all(),
		).toEqual([]);
		expect(
			rawDb(store)
				.prepare(
					"SELECT * FROM workflow_node_completion WHERE execution_id = ?",
				)
				.all(REPLACEMENT_ID),
		).toEqual([]);
	});
});

function currentLaunchDigest(store: StateStore) {
	const request = store.getWorkflowReworkRequest(REQUEST_ID)!;
	const route = store.getLatestWorkflowReworkRoute(REQUEST_ID)!;
	const built = buildWorkflowReworkContext({ request, route });
	if (!built.ok) throw new Error(built.reason);
	return workflowReworkLaunchDigest({
		requestId: REQUEST_ID,
		routeRevision: route.revision,
		stableSection: renderWorkflowReworkLaunchStableSection({
			context: built.context,
			baseRevision: request.base_revision,
		}),
	});
}
function prepareReplacementLaunch(
	store: StateStore,
	digest: string | undefined,
	commit = true,
	executionId = REPLACEMENT_ID,
	offset = 0,
) {
	const binding = store.getWorkflowExecutionBinding(executionId)!;
	store.upsertWorkflowRunNode({
		runId: binding.run_id,
		nodeId: binding.node_id,
		attempt: binding.attempt,
		executionId: executionId,
		state: "admitted",
	});
	const dir = mkdtempSync(join(tmpdir(), "fly2504-launch-"));
	scratchDirectories.push(dir);
	const markerPath = join(dir, "launch.json");
	const acquired = store.recoverOrAcquireWorkflowLaunch({
		executionId: executionId,
		ownerId: "dispatcher",
		now: at(offset),
		leaseExpiresAt: at(offset + 10),
		markerPath,
	});
	if (acquired.status !== "acquired") throw new Error(JSON.stringify(acquired));
	expect(
		store.prepareWorkflowIssueDelivery({
			executionId: executionId,
			activationId:
				store.getWorkflowExecutionBinding(executionId)!.activation_id,
			ownerId: "dispatcher",
			ownerGeneration: acquired.generation,
			deliveryAttempt: acquired.deliveryAttempt,
			anchorCommit: HEAD,
			reworkContentDigest: digest,
			candidate: { sourceKind: "authoritative", body: "issue body" },
			now: at(offset + 0.1),
		}),
	).toMatchObject({ ok: true });
	if (commit)
		expect(
			store.fencedCommitWorkflowLaunch({
				executionId: executionId,
				ownerId: "dispatcher",
				generation: acquired.generation,
				deliveryAttempt: acquired.deliveryAttempt,
				markerPath,
				now: at(offset + 0.2),
			}),
		).toMatchObject({ ok: true });
	return { markerPath, acquired };
}
function markReplacementStarted(store: StateStore, identity = {}) {
	return store.markWorkflowReplacementStartedTx({
		runId: "run-1",
		projectName: "flywheel",
		issueId: "FLY-1307",
		expectedEngineOwned: 1,
		executionId: REPLACEMENT_ID,
		now: at(0.3),
		alertIdentity: ALERT_IDENTITY,
		...identity,
	});
}
describe("FLY-2504 atomic replacement launch evidence", () => {
	it.each([undefined, "d".repeat(64)])(
		"N3/N4 refuses missing or mismatched committed content %s without starting",
		async (digest) => {
			const { store } = await seedReplacementBeforeLaunchMark("implement");
			prepareReplacementLaunch(store, digest);
			const effects = store.listWorkflowSideEffects("run-1");
			const nodes = store.listWorkflowRunNodes("run-1");
			const events = store.listWorkflowRunEvents("run-1");
			expect(markReplacementStarted(store)).toMatchObject({
				ok: false,
				reason: "rework_replacement_launch_content_missing",
			});
			expect(store.listWorkflowSideEffects("run-1")).toEqual(effects);
			expect(store.listWorkflowRunNodes("run-1")).toEqual(nodes);
			expect(store.listWorkflowRunEvents("run-1")).toEqual(events);
			expect(store.getWorkflowReworkDelivery(REQUEST_ID)?.state).toBe(
				"replacement_pending",
			);
			expect(store.getWorkflowReworkVerificationPath(REQUEST_ID)?.state).toBe(
				"pending",
			);
		},
	);
	it.each(["missing", "wake"] as const)(
		"refuses atomic replacement start for a %s binding without bookkeeping writes",
		async (mode) => {
			const { store } = await seedReplacementBeforeLaunchMark(
				"implement",
				"wake",
			);
			const effects = store.listWorkflowSideEffects("run-1");
			const nodes = store.listWorkflowRunNodes("run-1");
			const events = store.listWorkflowRunEvents("run-1");
			expect(
				markReplacementStarted(store, {
					executionId:
						mode === "missing" ? "unknown-execution" : REPLACEMENT_ID,
				}),
			).toEqual({ ok: false, reason: "rework_replacement_binding_required" });
			expect(store.listWorkflowSideEffects("run-1")).toEqual(effects);
			expect(store.listWorkflowRunNodes("run-1")).toEqual(nodes);
			expect(store.listWorkflowRunEvents("run-1")).toEqual(events);
		},
	);
	it("P3 atomically starts a committed launch with exact content and idempotent receipt", async () => {
		const { store } = await seedReplacementBeforeLaunchMark("implement");
		const digest = currentLaunchDigest(store);
		prepareReplacementLaunch(store, digest);
		expect(markReplacementStarted(store)).toEqual({ ok: true, updated: true });
		expect(store.getWorkflowReworkDelivery(REQUEST_ID)?.state).toBe(
			"wake_delivered",
		);
		expect(
			store
				.listWorkflowSideEffects("run-1")
				.find((e) => e.execution_id === REPLACEMENT_ID)?.state,
		).toBe("started");
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.find(
					(e) =>
						e.event_uid ===
						`rework_replacement_launched:${REQUEST_ID}:2:${REPLACEMENT_ID}`,
				)?.payload,
		).toMatchObject({
			routeRevision: 2,
			contentDigest: digest,
			carrier: "launch_envelope",
		});
		expect(markReplacementStarted(store)).toEqual({ ok: true, updated: false });
		const completion = enrolledComplete(store);
		expect(completion.ok, JSON.stringify(completion)).toBe(true);
	});
	it("N4b refuses prepared evidence until launch owner commits", async () => {
		const { store } = await seedReplacementBeforeLaunchMark("implement");
		prepareReplacementLaunch(store, currentLaunchDigest(store), false);
		expect(markReplacementStarted(store)).toMatchObject({
			ok: false,
			reason: "rework_replacement_launch_not_committed",
		});
		expect(store.getWorkflowReworkDelivery(REQUEST_ID)?.state).toBe(
			"replacement_pending",
		);
	});
});

describe("FLY-2504 evidence and identity fences", () => {
	it.each([
		{ projectName: "wrong" },
		{ issueId: "wrong" },
		{ expectedEngineOwned: 0 },
	])(
		"N16 preserves all state for wrong run identity %j at both entry points",
		async (identity) => {
			const { store } = await seedReplacementBeforeLaunchMark("implement");
			const before = store.listWorkflowSideEffects("run-1");
			const events = store.listWorkflowRunEvents("run-1");
			expect(() => markReplacementStarted(store, identity)).toThrow(
				/workflow ledger (batch identity|ownership) mismatch/,
			);
			expect(() =>
				store.applyWorkflowLedgerBatch({
					runId: "run-1",
					projectName: "flywheel",
					issueId: "FLY-1307",
					expectedEngineOwned: 1,
					ops: [
						{
							op: "side_effect",
							node: "implement",
							attempt: 2,
							executionId: REPLACEMENT_ID,
							to: "started",
						},
					],
					...identity,
				} as Parameters<StateStore["applyWorkflowLedgerBatch"]>[0]),
			).toThrow(/workflow ledger (batch identity|ownership) mismatch/);
			expect(store.listWorkflowSideEffects("run-1")).toEqual(before);
			expect(store.listWorkflowRunEvents("run-1")).toEqual(events);
		},
	);
	it("N4c ignores a later uncommitted prepared candidate", async () => {
		const { store } = await seedReplacementBeforeLaunchMark("implement");
		prepareReplacementLaunch(store, currentLaunchDigest(store));
		store.appendWorkflowRunEvent({
			runId: "run-1",
			nodeId: "implement",
			executionId: REPLACEMENT_ID,
			eventUid: `issue_delivery_prepared:${REPLACEMENT_ID}:1:1`,
			kind: "issue_delivery_prepared",
			payload: { reworkContentDigest: "f".repeat(64) },
		});
		expect(markReplacementStarted(store)).toEqual({ ok: true, updated: true });
	});
	it("N4d follows the committed repair attempt instead of older valid delivery", async () => {
		const { store } = await seedReplacementBeforeLaunchMark("implement");
		const { markerPath } = prepareReplacementLaunch(
			store,
			currentLaunchDigest(store),
		);
		const repair = store.claimWorkflowLaunchDeliveryRepair({
			executionId: REPLACEMENT_ID,
			repairOwner: "repair",
			now: at(0.21),
			leaseExpiresAt: at(10),
		});
		if (repair.status !== "claimed") throw new Error(JSON.stringify(repair));
		expect(
			store.prepareWorkflowIssueDelivery({
				executionId: REPLACEMENT_ID,
				activationId:
					store.getWorkflowExecutionBinding(REPLACEMENT_ID)!.activation_id,
				ownerId: "repair",
				ownerGeneration: repair.generation,
				deliveryAttempt: repair.attempt,
				anchorCommit: HEAD,
				reworkContentDigest: "f".repeat(64),
				candidate: { sourceKind: "authoritative", body: "repair" },
				now: at(0.22),
			}),
		).toMatchObject({ ok: true });
		expect(
			store.commitWorkflowLaunchDeliveryRepair({
				executionId: REPLACEMENT_ID,
				repairOwner: "repair",
				generation: repair.generation,
				attempt: repair.attempt,
				markerPath,
				now: at(0.23),
			}),
		).toMatchObject({ ok: true });
		expect(markReplacementStarted(store)).toMatchObject({
			ok: false,
			reason: "rework_replacement_launch_content_missing",
		});
	});
	it("N4e does not certify a legacy wake_delivered projection", async () => {
		const { store } = await seedReplacementBeforeLaunchMark("implement");
		seedLegacyLaunchMark(store, {});
		expect(markReplacementStarted(store)).toMatchObject({
			ok: false,
			reason: "rework_replacement_launch_content_missing",
		});
	});
});

describe("FLY-2504 remaining transition acceptance", () => {
	it.each(["turn_granted", "awaiting_receipt", "wake_delivered"])(
		"N6 does not apply replacement content requirements to wake binding in %s",
		async (state) => {
			const { store } = await seedReplacementBeforeLaunchMark(
				"implement",
				"wake",
			);
			dbRun(
				store,
				"UPDATE workflow_rework_delivery SET state = ? WHERE request_id = ?",
				[state, REQUEST_ID],
			);
			expect(enrolledComplete(store)).toMatchObject({ ok: true });
		},
	);
	it("N13 reconstruct_completion cannot bypass an open replacement receipt requirement", async () => {
		const { store } = await seedReplacementBeforeLaunchMark("implement");
		store.upsertSession({
			execution_id: REPLACEMENT_ID,
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "completed",
			workflow_node_id: "implement",
			pr_head_sha: HEAD,
		});
		dbRun(store, "UPDATE sessions SET pr_head_sha = ? WHERE execution_id = ?", [
			HEAD,
			REPLACEMENT_ID,
		]);
		expect(
			store.holdCompletedWorkflowExecutionWithoutReceipt({
				runId: "run-1",
				nodeId: "implement",
				attempt: 2,
				executionId: REPLACEMENT_ID,
				alertIdentity: ALERT_IDENTITY,
				now: at(1),
			}),
		).toMatchObject({ ok: true });
		const normalized = StateStore.canonicalizeHoldResume({
			runId: "run-1",
			shape: "completion_receipt_missing",
			holdEventUid: `completion_receipt_missing:run-1:implement:2:${REPLACEMENT_ID}`,
			decision: null,
			reason: "verify recovery fence",
			principal: "master",
			clientRequestId: "reconstruct-1",
		});
		if (!normalized) throw new Error("invalid hold resume");
		expect(() =>
			store.resumeWorkflowHold({
				canonical: normalized.canonical,
				digest: normalized.digest,
				now: at(2),
			}),
		).toThrow(
			"workflow_hold_completion_transition_refused:rework_content_not_delivered",
		);
		expect(store.getWorkflowRun("run-1")?.status).toBe("held");
		expect(
			store.getWorkflowNodeCompletion("run-1", "implement", 2),
		).toBeUndefined();
	});
	it("N2b a new route revision yields a distinct refusal receipt", async () => {
		const { store } = await seedReplacementBeforeLaunchMark("implement");
		// Identity conflicts leave the healthy delivery active, permitting revision reconciliation.
		for (const revision of [3, 4]) {
			dbRun(
				store,
				`INSERT INTO workflow_rework_route_revision SELECT request_id, ?, target_node_id, target_attempt, 'qa-1', invalidation_scope_json, verification_policy_json, interpreted_by, interpretation_reason, created_at FROM workflow_rework_route_revision WHERE request_id = ? AND revision = 2`,
				[revision, REQUEST_ID],
			);
			expect(enrolledComplete(store, `completion-${revision}`)).toMatchObject({
				ok: false,
				reason: "rework_receipt_identity_conflict",
				detail: { routeRevision: revision },
			});
		}
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((e) => e.kind === "completion_transition_refused"),
		).toHaveLength(2);
		expect(store.listWorkflowAlertOutbox()).toHaveLength(2);
	});
});

describe("FLY-2504 replacement generations", () => {
	it("N14 keeps both revision-specific receipts after generic rollback and convergence", async () => {
		const { store } = await seedReplacementBeforeLaunchMark("implement");
		prepareReplacementLaunch(store, currentLaunchDigest(store));
		expect(markReplacementStarted(store)).toMatchObject({ ok: true });
		store.upsertSession({
			execution_id: REPLACEMENT_ID,
			project_name: "flywheel",
			issue_id: "FLY-1307",
			status: "failed",
			session_role: "implement",
		});
		expect(
			store.rollbackDeadWorkflowNodeExecution({
				runId: "run-1",
				nodeId: "implement",
				attempt: 2,
				deadExecutionId: REPLACEMENT_ID,
				newExecutionId: "replacement-generation-2",
				reason: "terminal_session_and_dead_probe",
				livenessEvidence: { liveness: "dead", observedAt: at(5) },
				now: at(5),
			}),
		).toMatchObject({ ok: true });
		const claim = store.claimWorkflowReworkDelivery({
			requestId: REQUEST_ID,
			ownerId: "coordinator",
			now: at(5.1),
			leaseExpiresAt: at(10),
		});
		if (!claim.ok) throw new Error(JSON.stringify(claim));
		expect(
			store.convergeWorkflowReworkWriterReplacement({
				requestId: REQUEST_ID,
				ownerId: "coordinator",
				generation: claim.generation,
				now: at(5.2),
			}),
		).toMatchObject({ ok: true, executionId: "replacement-generation-2" });
		expect(
			store.admitGeneralizedWorkflowExecution({
				runId: "run-1",
				nodeId: "implement",
				attempt: 2,
				executionId: "replacement-generation-2",
				activationMode: "replacement",
				reworkRequestId: REQUEST_ID,
				now: at(6),
				expiresAt: at(30),
				absoluteDeadlineAt: at(24 * 60),
			}),
		).toMatchObject({ ok: true });
		store.upsertSession({
			execution_id: "replacement-generation-2",
			project_name: "flywheel",
			issue_id: "FLY-1307",
			status: "running",
			session_role: "implement",
		});
		prepareReplacementLaunch(
			store,
			currentLaunchDigest(store),
			true,
			"replacement-generation-2",
			6,
		);
		expect(
			markReplacementStarted(store, {
				executionId: "replacement-generation-2",
				now: at(7),
			}),
		).toMatchObject({ ok: true });
		const receipts = store
			.listWorkflowRunEvents("run-1")
			.filter((e) => e.kind === "rework_replacement_launched");
		expect(receipts.map((e) => e.event_uid)).toEqual([
			`rework_replacement_launched:${REQUEST_ID}:2:${REPLACEMENT_ID}`,
			`rework_replacement_launched:${REQUEST_ID}:3:replacement-generation-2`,
		]);
		expect(store.getWorkflowReworkDelivery(REQUEST_ID)).toMatchObject({
			state: "wake_delivered",
			route_revision: 3,
		});
	});
});
