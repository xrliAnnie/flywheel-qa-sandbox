import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReworkWakeId, CommDB } from "flywheel-comm/db";
import { afterEach, describe, expect, it } from "vitest";
import { DeliveryProjector } from "../bridge/delivery-contract/projector.js";
import { DeliveryContractWatch } from "../bridge/delivery-contract/watch.js";
import { DeliveryOperations } from "../bridge/delivery-operations.js";
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
// FLY-2921 C7: a rework-target completion must carry a new head. The request
// was opened against the judged head; `HEAD` is the replacement's new one.
const BASE_REVISION = "9".repeat(40);
const REQUEST_ID = "fly2504-rework";
const DEAD_EXECUTION_ID = "qa-1";
const REPLACEMENT_ID = "qa-replacement-2";
const COORDINATOR = "coordinator";
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
/**
 * FLY-2921 C2 step 4: before FLY-2919 lands, the only death proofs the
 * replacement transaction accepts are an exact unlaunched-rollback fact or an
 * abandoned dispatch intent. The rollback fact is recorded here in the shape
 * `rollbackUnlaunchedWorkflowAdmission` writes for a replacement binding
 * (not a hold shape, so it leaves no phantom run hold behind).
 */
function seedDeathProof(
	store: StateStore,
	nodeId: string,
	executionId: string,
	at: string,
	runId = "run-1",
) {
	store.appendWorkflowRunEvent({
		runId,
		eventUid: `unlaunched_rollback:${runId}:${nodeId}:2:${executionId}`,
		kind: "rework_replacement_launch_rolled_back",
		nodeId,
		executionId,
		payload: {
			attempt: 2,
			reason: "unlaunched_admission_rolled_back",
			at,
		},
	});
}
function replacementCredentials(store: StateStore, executionId: string) {
	return rawDb(store)
		.prepare(
			`SELECT 'output' AS family, revoked, revoked_reason
			   FROM workflow_output_credential
			  WHERE execution_id = ? AND consumed_at IS NULL
			 UNION ALL
			 SELECT 'submission' AS family, revoked, revoked_reason
			   FROM workflow_submission_credential
			  WHERE execution_id = ? AND consumed_at IS NULL
			 ORDER BY family`,
		)
		.all(executionId, executionId) as Array<{
		family: string;
		revoked: number;
		revoked_reason: string | null;
	}>;
}
/**
 * `tpl_eng_heavy`'s implement node does not `produces_output`, so admission
 * mints no credential for the replacement; seed one unconsumed row so the
 * C4.5 revocation is observable rather than vacuous.
 */
function seedLiveOutputCredential(store: StateStore, executionId: string) {
	const binding = store.getWorkflowExecutionBinding(executionId)!;
	dbRun(
		store,
		`INSERT INTO workflow_output_credential
		   (activation_id, credential_hash, run_id, node_id, execution_id, attempt,
		    issued_at, expires_at, absolute_deadline_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			binding.activation_id,
			`fly2504-output-credential:${executionId}`,
			binding.run_id,
			binding.node_id,
			executionId,
			binding.attempt,
			at(-0.4),
			at(30),
			at(24 * 60),
		],
	);
}
function contentMissingFact(store: StateStore, routeRevision = 2) {
	return store
		.listWorkflowRunEvents("run-1")
		.find(
			(e) =>
				e.event_uid ===
				`rework_replacement_content_missing:${REQUEST_ID}:${routeRevision}`,
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

async function seedReplacementBeforeLaunchMark(
	nodeId: "qa" | "implement" = "qa",
	activationMode: "replacement" | "wake" = "replacement",
	options: {
		deadExecutionId?: string;
		beforeReplacement?: (store: StateStore) => void;
		omitSyntheticClaim?: boolean;
	} = {},
): Promise<{
	store: StateStore;
	attemptId: string;
}> {
	const store = await seedQaIntent();
	const deadExecutionId = options.deadExecutionId ?? DEAD_EXECUTION_ID;
	store.upsertSession({
		execution_id: deadExecutionId,
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
		executionId: deadExecutionId,
	});
	dbRun(
		store,
		`INSERT OR IGNORE INTO workflow_actor
		   (execution_id, project_name, issue_id, role, created_at)
		 VALUES (?, 'flywheel', 'FLY-1307', '${nodeId}', ?)`,
		[deadExecutionId, at(-2)],
	);
	dbRun(
		store,
		`INSERT INTO workflow_rework_request
		   (request_id, run_id, source_event_id, authority, source_node_id,
		    source_attempt, base_revision, authority_context_json,
		    authority_context_digest, requested_at)
		 VALUES (?, 'run-1', 'fly2096-source', 'qa', 'qa', 1, ?, '{}', ?, ?)`,
		[REQUEST_ID, BASE_REVISION, "b".repeat(64), at(-2)],
	);
	dbRun(
		store,
		`INSERT INTO workflow_rework_route_revision
		   (request_id, revision, target_node_id, target_attempt,
		    preferred_actor_execution_id, invalidation_scope_json,
		    verification_policy_json, interpreted_by, interpretation_reason, created_at)
		 VALUES (?, 1, '${nodeId}', 2, ?, '${JSON.stringify(nodeId === "qa" ? ["qa"] : ["implement", "qa"])}', '["qa_retest","founder_gate"]',
		         'fixture', 'fixture', ?)`,
		[REQUEST_ID, deadExecutionId, at(-2)],
	);
	// FLY-2921 C1: the delivery has two live states; a dead target is replaced
	// in place from `pending` (never a `replacement_pending` third state).
	dbRun(
		store,
		`INSERT INTO workflow_rework_delivery
		   (request_id, route_revision, state, updated_at)
		 VALUES (?, 1, 'pending', ?)`,
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
	options.beforeReplacement?.(store);
	store.baselineWorkflowDeliveryContracts(at(-2));
	seedDeathProof(store, nodeId, deadExecutionId, at(-1.5));
	const claim = store.claimWorkflowReworkDelivery({
		requestId: REQUEST_ID,
		ownerId: COORDINATOR,
		now: at(-1.2),
		leaseExpiresAt: at(10),
	});
	if (!claim.ok) throw new Error(JSON.stringify(claim));
	expect(
		store.replaceWorkflowReworkActor({
			requestId: REQUEST_ID,
			ownerId: COORDINATOR,
			generation: claim.generation,
			deadExecutionId: deadExecutionId,
			newExecutionId: REPLACEMENT_ID,
			proof: { kind: "unlaunched_rollback" },
			reason: "persisted_target_dead",
			observedAt: at(-1),
		}),
	).toMatchObject({
		ok: true,
		executionId: REPLACEMENT_ID,
		routeRevision: 2,
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
	if (!options.omitSyntheticClaim) {
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
	}

	expect(store.getWorkflowExecutionBinding(REPLACEMENT_ID)?.mode).toBe(
		activationMode,
	);
	// The minted replacement waits on `pending` (revision 2), unowned: the
	// replacement transaction clears the coordinator's claim with the revision.
	expect(store.getWorkflowReworkDelivery(REQUEST_ID)).toMatchObject({
		state: "pending",
		route_revision: 2,
		owner_id: null,
		hold_count: 0,
	});
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
				deliveryState: "pending",
				routeRevision: 2,
			},
		});
		expect(store.getWorkflowReworkDelivery(REQUEST_ID)?.state).toBe("pending");
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
		expect(store.getWorkflowReworkDelivery(REQUEST_ID)?.state).toBe("pending");
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
	// FLY-2921 C4.5: a content-missing replacement completion is refused, but
	// it no longer opens an undeliverable episode or a run hold. A stale
	// episode left on a superseded attempt is not this path's to touch.
	it("refuses without opening an episode or hold and leaves a superseded attempt's stale episode alone", async () => {
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
		).toEqual({ closed_at: null, closed_reason: null });
		const episodes = rawDb(store)
			.prepare(
				"SELECT attempt_id, stage FROM workflow_delivery_contract_episode WHERE family = 'rework' AND root_id = ? AND closed_at IS NULL",
			)
			.all(prior.root_id);
		expect(episodes).toEqual([
			{ attempt_id: prior.attempt_id, stage: "stalled" },
		]);
		expect(store.getWorkflowRun("run-1")?.status).toBe("active");
		expect(
			store.getWorkflowNodeCompletion("run-1", "implement", 2),
		).toBeUndefined();
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((e) => e.kind === "completion_transition_refused"),
		).toHaveLength(1);
		expect(store.listWorkflowAlertOutbox()).toHaveLength(1);
		expect(store.listWorkflowHolds("run-1")).toEqual([]);
		expect(contentMissingFact(store)).toBeDefined();
		expect(enrolledComplete(store, "replacement-refusal-replay")).toMatchObject(
			{ ok: false, reason: "rework_content_not_delivered" },
		);
		expect(store.listWorkflowAlertOutbox()).toHaveLength(1);
	});

	it("N1b/N13b rolls back completion and atomically records the content-missing fact with one alert, no hold", async () => {
		const { store } = await seedReplacementBeforeLaunchMark("implement");
		seedLiveOutputCredential(store, REPLACEMENT_ID);
		expect(replacementCredentials(store, REPLACEMENT_ID)).toEqual([
			{ family: "output", revoked: 0, revoked_reason: null },
		]);
		expect(enrolledComplete(store)).toMatchObject({
			ok: false,
			reason: "rework_content_not_delivered",
			retryable: false,
			detail: {
				requestId: REQUEST_ID,
				routeRevision: 2,
				deliveryState: "pending",
			},
		});
		expect(
			rawDb(store)
				.prepare(
					"SELECT * FROM workflow_node_completion WHERE execution_id = ?",
				)
				.all(REPLACEMENT_ID),
		).toEqual([]);
		// Plan C4.5: no hold, no frozen run, no undeliverable episode.
		expect(store.getWorkflowRun("run-1")?.status).toBe("active");
		expect(store.listWorkflowHolds("run-1")).toEqual([]);
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((e) => e.kind === "delivery_reroute_operator_required"),
		).toEqual([]);
		expect(
			rawDb(store)
				.prepare(
					"SELECT * FROM workflow_delivery_contract_episode WHERE family = 'rework'",
				)
				.all(),
		).toEqual([]);
		// The replacement is unusable: its unconsumed credentials are revoked,
		// the fact is recorded for the coordinator, and the delivery is nudged.
		expect(contentMissingFact(store)?.payload).toMatchObject({
			requestId: REQUEST_ID,
			routeRevision: 2,
			attempt: 2,
		});
		expect(replacementCredentials(store, REPLACEMENT_ID)).not.toHaveLength(0);
		expect(
			replacementCredentials(store, REPLACEMENT_ID).every(
				(row) =>
					row.revoked === 1 &&
					row.revoked_reason === "rework_replacement_content_missing",
			),
		).toBe(true);
		expect(store.getWorkflowReworkDelivery(REQUEST_ID)).toMatchObject({
			state: "pending",
			route_revision: 2,
			next_retry_at: at(1),
		});

		const refusals = store
			.listWorkflowRunEvents("run-1")
			.filter((e) => e.kind === "completion_transition_refused");
		expect(refusals).toHaveLength(1);
		expect(refusals[0]!.payload).toMatchObject({
			transitionReason: "rework_content_not_delivered",
		});
		expect(store.listWorkflowAlertOutbox()).toHaveLength(1);
		const before = store.listWorkflowRunEvents("run-1");
		expect(enrolledComplete(store, "completion-2")).toMatchObject({
			ok: false,
			reason: "rework_content_not_delivered",
			retryable: false,
		});
		expect(store.listWorkflowRunEvents("run-1")).toEqual(before);
		expect(store.listWorkflowAlertOutbox()).toHaveLength(1);
		expect(store.getWorkflowRun("run-1")?.status).toBe("active");
	});
});

describe("FLY-2504 operator recovery and atomicity", () => {
	// FLY-2921 C4.3/C4.5: after a content-missing refusal a real contract
	// sweep never turns the rework into an undeliverable hold — with a live
	// recipient or a terminal one. The dead half is the coordinator's.
	it.each(["running", "failed"] as const)(
		"keeps the run active through a real sweep after the refusal with recipient %s",
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
			const watch = new DeliveryContractWatch({
				store,
				projectName: "flywheel",
				resolveAlertIdentity: () => ALERT_IDENTITY,
			});
			expect(watch.runPass(at(1.2)).observed).toBeGreaterThan(0);
			// Well past the undeliverable grace window.
			watch.runPass(at(45));
			expect(store.getWorkflowRun("run-1")?.status).toBe("active");
			expect(store.listWorkflowHolds("run-1")).toEqual([]);
			expect(
				rawDb(store)
					.prepare(
						"SELECT stage FROM workflow_delivery_contract_episode WHERE family = 'rework' AND stage = 'undeliverable'",
					)
					.all(),
			).toEqual([]);
			expect(
				store
					.listWorkflowRunEvents("run-1")
					.filter((e) => e.kind === "delivery_reroute_operator_required"),
			).toEqual([]);
			expect(store.getWorkflowReworkDelivery(REQUEST_ID)).toMatchObject({
				state: "pending",
				route_revision: 2,
			});
		},
	);
	it("N15 a historical committed launch without content is refused and its delivery stays pending for the coordinator", async () => {
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
		// FLY-2921: no operator hold to cancel; the row stays `pending` on the
		// current revision, nudged for the coordinator, and the run is active.
		expect(store.listWorkflowHolds("run-1")).toEqual([]);
		expect(store.getWorkflowRun("run-1")?.status).toBe("active");
		expect(store.getWorkflowReworkDelivery(REQUEST_ID)).toMatchObject({
			state: "pending",
			route_revision: 2,
			next_retry_at: at(1),
		});
		expect(
			store.hasReworkReplacementContentMissingFact({
				runId: "run-1",
				requestId: REQUEST_ID,
				routeRevision: 2,
			}),
		).toBe(true);
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
	it("N13b rolls back the content-missing fact and refusal if durable alert insertion fails", async () => {
		const { store } = await seedReplacementBeforeLaunchMark("implement");
		seedLiveOutputCredential(store, REPLACEMENT_ID);
		const before = store.listWorkflowRunEvents("run-1");
		const credentialsBefore = replacementCredentials(store, REPLACEMENT_ID);
		expect(credentialsBefore).toEqual([
			{ family: "output", revoked: 0, revoked_reason: null },
		]);
		const deliveryBefore = store.getWorkflowReworkDelivery(REQUEST_ID);
		dbRun(
			store,
			`CREATE TRIGGER fail_refusal_alert BEFORE INSERT ON workflow_alert_outbox BEGIN SELECT RAISE(ABORT, 'injected_alert_failure'); END`,
		);
		expect(() => enrolledComplete(store)).toThrow("injected_alert_failure");
		expect(store.getWorkflowRun("run-1")?.status).toBe("active");
		expect(store.listWorkflowRunEvents("run-1")).toEqual(before);
		expect(contentMissingFact(store)).toBeUndefined();
		expect(replacementCredentials(store, REPLACEMENT_ID)).toEqual(
			credentialsBefore,
		);
		expect(store.getWorkflowReworkDelivery(REQUEST_ID)).toEqual(deliveryBefore);
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
				"pending",
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
		expect(store.getWorkflowReworkDelivery(REQUEST_ID)?.state).toBe("pending");
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
	// FLY-2921 C1: `awaiting_receipt` is now `turn_granted` + `wake_sent_at`.
	it.each([
		{ state: "turn_granted", wakeSentAt: null },
		{ state: "turn_granted", wakeSentAt: at(0.1) },
		{ state: "wake_delivered", wakeSentAt: at(0.1) },
	])(
		"N6 does not apply replacement content requirements to wake binding in %j",
		async ({ state, wakeSentAt }) => {
			const { store } = await seedReplacementBeforeLaunchMark(
				"implement",
				"wake",
			);
			// FLY-2828 C1: a wake binding completes by settling its own receipt,
			// so the fixture must carry the state a real wake activation has: the
			// activation TURN, and for `wake_delivered` the active verification
			// path that the earlier projection would have written.
			const binding = store.getWorkflowExecutionBinding(REPLACEMENT_ID)!;
			expect(
				store.recordWorkflowActivationTurn({
					activationId: binding.activation_id,
					issueId: "FLY-1307",
					executionId: REPLACEMENT_ID,
					epoch: 5,
					sourceEventId: `n6-turn:${state}`,
					grantedAt: at(0),
				}),
			).toMatchObject({ ok: true });
			const revision =
				store.getWorkflowReworkDelivery(REQUEST_ID)!.route_revision;
			dbRun(
				store,
				"UPDATE workflow_rework_delivery SET state = ?, wake_sent_at = ? WHERE request_id = ?",
				[state, wakeSentAt, REQUEST_ID],
			);
			dbRun(
				store,
				"UPDATE workflow_rework_verification_path SET route_revision = ?, state = ? WHERE request_id = ?",
				[
					revision,
					state === "wake_delivered" ? "active" : "pending",
					REQUEST_ID,
				],
			);
			expect(enrolledComplete(store)).toMatchObject({ ok: true });
			expect(store.getWorkflowReworkDelivery(REQUEST_ID)?.state).toBe(
				"completed",
			);
			const receipt = store
				.listWorkflowRunEvents("run-1")
				.find((event) => event.kind === "rework_delivery_wake_delivered");
			if (state === "wake_delivered") {
				expect(receipt).toBeUndefined();
			} else {
				expect(receipt?.payload).toMatchObject({
					source: "completion_implied",
					impliedFromState: state,
				});
			}
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
		expect(
			store.resumeWorkflowHold({
				canonical: normalized.canonical,
				digest: normalized.digest,
				now: at(2),
			}),
		).toMatchObject({ ok: false, reason: "unified_recovery_required" });
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
	// FLY-2921 C6: an open rework target has exactly one replacement path.
	// Generic dead recovery hands the row to the coordinator, which replaces
	// the dead replacement in place; both launch receipts stay per revision.
	it("N14 keeps both revision-specific receipts after a second proven-dead replacement", async () => {
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
		).toEqual({ ok: false, reason: "rework_target_owned_by_coordinator" });
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((e) => e.kind === "rework_dead_target_handoff"),
		).toHaveLength(1);
		expect(store.getWorkflowRun("run-1")?.status).toBe("active");
		expect(
			store.getWorkflowRunNode("run-1", "implement", 2)?.execution_id,
		).toBe(REPLACEMENT_ID);
		seedDeathProof(store, "implement", REPLACEMENT_ID, at(5));
		const claim = store.claimWorkflowReworkDelivery({
			requestId: REQUEST_ID,
			ownerId: COORDINATOR,
			now: at(5.1),
			leaseExpiresAt: at(10),
		});
		if (!claim.ok) throw new Error(JSON.stringify(claim));
		expect(
			store.replaceWorkflowReworkActor({
				requestId: REQUEST_ID,
				ownerId: COORDINATOR,
				generation: claim.generation,
				deadExecutionId: REPLACEMENT_ID,
				newExecutionId: "replacement-generation-2",
				proof: { kind: "unlaunched_rollback" },
				reason: "terminal_session_and_dead_probe",
				observedAt: at(5.2),
			}),
		).toMatchObject({
			ok: true,
			executionId: "replacement-generation-2",
			routeRevision: 3,
			idempotentReplay: false,
		});
		expect(store.getWorkflowReworkDelivery(REQUEST_ID)).toMatchObject({
			state: "pending",
			route_revision: 3,
			owner_id: null,
		});
		// One materialized receipt per dead route revision (plan C2).
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((e) => e.kind === "rework_replacement_materialized")
				.map((e) => e.event_uid),
		).toEqual([
			`rework_replacement_materialized:${REQUEST_ID}:1`,
			`rework_replacement_materialized:${REQUEST_ID}:2`,
		]);
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((e) => e.kind === "rework_replacement")
				.map((e) => e.event_uid),
		).toEqual([
			`rework_replacement:${REQUEST_ID}:2`,
			`rework_replacement:${REQUEST_ID}:3`,
		]);
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

describe("FLY-2517 second proven-dead replacement", () => {
	// FLY-2921 C6: generic dead-writer recovery no longer advances an open
	// rework; the coordinator's in-place replacement does, and the retirement
	// proof for each replaced wake binding must still resolve per revision.
	it("retires the wake binding when the coordinator replaces the same request again", async () => {
		const firstIdentity = {
			executionId: "fly2517-first-writer",
			activationId: "fly2517-first-wake",
			epoch: 8,
			wakeId: buildReworkWakeId({
				requestId: REQUEST_ID,
				activationId: "fly2517-first-wake",
				epoch: 8,
			}),
		};
		const { store } = await seedReplacementBeforeLaunchMark(
			"implement",
			"wake",
			{
				deadExecutionId: firstIdentity.executionId,
				beforeReplacement: (store) => {
					dbRun(
						store,
						`INSERT INTO workflow_execution_binding
					(activation_id,execution_id,run_id,node_id,attempt,mode,rework_request_id,bound_at)
					VALUES (?,?,'run-1','implement',2,'wake',?,?)`,
						[
							firstIdentity.activationId,
							firstIdentity.executionId,
							REQUEST_ID,
							at(-2),
						],
					);
					expect(
						store.recordWorkflowActivationTurn({
							activationId: firstIdentity.activationId,
							executionId: firstIdentity.executionId,
							issueId: "FLY-1307",
							epoch: 8,
							sourceEventId: "fly2517-first-turn",
							grantedAt: at(-2),
						}),
					).toMatchObject({ ok: true });
				},
			},
		);
		const activationId =
			store.getWorkflowExecutionBinding(REPLACEMENT_ID)!.activation_id;
		expect(
			store.recordWorkflowActivationTurn({
				activationId,
				executionId: REPLACEMENT_ID,
				issueId: "FLY-1307",
				epoch: 9,
				sourceEventId: "fly2517-writer-turn",
				grantedAt: at(4),
			}),
		).toMatchObject({ ok: true });
		const identity = {
			activationId,
			executionId: REPLACEMENT_ID,
			epoch: 9,
			wakeId: buildReworkWakeId({
				requestId: REQUEST_ID,
				activationId,
				epoch: 9,
			}),
		};
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
				newExecutionId: "fly2517-next-writer",
				reason: "terminal_session_and_dead_probe",
				livenessEvidence: { liveness: "dead", observedAt: at(5) },
				now: at(5),
			}),
		).toEqual({ ok: false, reason: "rework_target_owned_by_coordinator" });
		// Model the delivered wake lane before the coordinator reclaims it.
		dbRun(
			store,
			"UPDATE workflow_rework_delivery SET state='wake_delivered', wake_sent_at=? WHERE request_id=?",
			[at(4.5), REQUEST_ID],
		);
		seedDeathProof(store, "implement", REPLACEMENT_ID, at(5));
		const claim = store.claimWorkflowReworkDelivery({
			requestId: REQUEST_ID,
			ownerId: COORDINATOR,
			now: at(5.1),
			leaseExpiresAt: at(10),
		});
		if (!claim.ok) throw new Error(JSON.stringify(claim));
		expect(
			store.replaceWorkflowReworkActor({
				requestId: REQUEST_ID,
				ownerId: COORDINATOR,
				generation: claim.generation,
				deadExecutionId: REPLACEMENT_ID,
				newExecutionId: "fly2517-next-writer",
				proof: { kind: "unlaunched_rollback" },
				reason: "terminal_session_and_dead_probe",
				observedAt: at(5.2),
			}),
		).toMatchObject({
			ok: true,
			executionId: "fly2517-next-writer",
			routeRevision: 3,
		});
		expect(store.getWorkflowReworkDelivery(REQUEST_ID)).toMatchObject({
			state: "pending",
			route_revision: 3,
			wake_sent_at: null,
		});
		expect(store.resolveReworkWakeRetirementProofTx(identity)).toMatchObject({
			kind: "proven",
			proof: {
				oldRouteRevision: 2,
				newRouteRevision: 3,
				replacementExecutionId: "fly2517-next-writer",
				replacementEventUid: `rework_replacement_materialized:${REQUEST_ID}:2`,
			},
		});
		expect(
			store.resolveReworkWakeRetirementProofTx(firstIdentity),
		).toMatchObject({
			kind: "proven",
			proof: {
				oldRouteRevision: 1,
				newRouteRevision: 2,
				replacementExecutionId: REPLACEMENT_ID,
				replacementEventUid: `rework_replacement_materialized:${REQUEST_ID}:1`,
			},
		});
		const receipts = store.listPendingReworkWakeRetirements({ limit: 20 });
		expect(new Set(receipts.map((row) => row.retirementId)).size).toBe(2);
		expect(store.listPendingReworkWakeRetirements({ limit: 20 })).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ ...identity, newRouteRevision: 3 }),
			]),
		);
	});
});

describe("FLY-2517 incident order", () => {
	it("keeps QA activation resolvable after replacement completion and the old wake deadline", async () => {
		const old = "fly2517-old-implement";
		const activationId = "fly2517-old-wake";
		const wakeId = buildReworkWakeId({
			requestId: REQUEST_ID,
			activationId,
			epoch: 9,
		});
		const commDb = new CommDB(":memory:");
		try {
			const { store } = await seedReplacementBeforeLaunchMark(
				"implement",
				"replacement",
				{
					deadExecutionId: old,
					omitSyntheticClaim: true,
					beforeReplacement: (store) => {
						dbRun(
							store,
							`INSERT INTO workflow_execution_binding
      (activation_id,execution_id,run_id,node_id,attempt,mode,rework_request_id,bound_at)
      VALUES (?,?,'run-1','implement',2,'wake',?,?)`,
							[activationId, old, REQUEST_ID, at(-2)],
						);
						expect(
							store.recordWorkflowActivationTurn({
								activationId,
								executionId: old,
								issueId: "FLY-1307",
								epoch: 9,
								sourceEventId: "fly2517-old-turn",
								grantedAt: at(-2),
							}),
						).toMatchObject({ ok: true });
						const metadata = {
							kind: "workflow_rework",
							wakeId,
							activationId,
							epoch: 9,
						};
						commDb.registerSession(
							old,
							"window",
							"flywheel",
							"FLY-1307",
							"flywheel-eng-lead",
						);
						commDb.enqueueTurnWake({
							wakeId,
							executionId: old,
							activationId,
							epoch: 9,
							issueId: "FLY-1307",
							purpose: "workflow_rework",
							envelope: { fromAgent: "bridge", content: "rework", metadata },
							backend: "codex",
							createdAtMs: Date.parse(at(-2)),
						});
						commDb.enqueueRunnerPhaseWake(
							old,
							{
								id: "fly2517-incident-old",
								to: old,
								content: "rework",
								metadata,
							},
							Date.parse(at(-2)),
						);
						new DeliveryProjector({
							store,
							commDb,
							projectName: "flywheel",
						}).runPass(at(-2));
					},
				},
			);
			prepareReplacementLaunch(store, currentLaunchDigest(store));
			expect(markReplacementStarted(store)).toMatchObject({ ok: true });
			expect(enrolledComplete(store)).toMatchObject({ ok: true });
			expect(store.getWorkflowReworkDelivery(REQUEST_ID)?.state).toBe(
				"completed",
			);
			const qa = store.listWorkflowRunNodes("run-1", "qa").at(-1)!;
			const qaExecution = "fly2517-next-qa";
			store.upsertSession({
				execution_id: qaExecution,
				issue_id: "FLY-1307",
				project_name: "flywheel",
				session_role: "qa",
				status: "running",
				pr_head_sha: HEAD,
			});
			store.upsertWorkflowRunNode({
				runId: "run-1",
				nodeId: "qa",
				attempt: qa.attempt + 1,
				state: "pending",
				executionId: qaExecution,
			});
			const admission = store.admitGeneralizedWorkflowExecution({
				runId: "run-1",
				nodeId: "qa",
				attempt: qa.attempt + 1,
				executionId: qaExecution,
				activationId: "fly2517-qa-activation",
				activationMode: "spawn",
				expiresAt: at(60),
				absoluteDeadlineAt: at(120),
				now: at(2),
			});
			expect(admission, JSON.stringify(admission)).toMatchObject({ ok: true });
			for (let pass = 0; pass < 2; pass++) {
				new DeliveryProjector({
					store,
					commDb,
					projectName: "flywheel",
				}).runPass(at(21));
				new DeliveryContractWatch({
					store,
					commDb,
					projectName: "flywheel",
					resolveAlertIdentity: () => ALERT_IDENTITY,
				}).runPass(at(21));
				new DeliveryOperations({
					store,
					commDb,
					projectName: "flywheel",
					resolveRecipient: () => null,
					resolveAlertIdentity: () => ALERT_IDENTITY,
				}).runPass(at(21));
			}
			expect(store.getWorkflowRun("run-1")?.status).toBe("active");
			expect(commDb.listRunnerPhaseWakes(old)[0]).toMatchObject({
				state: "finished",
				started_at: null,
			});
			expect(commDb.getTurnWake(wakeId)?.state).toBe("cancelled");
			expect(store.resolveCurrentWorkflowActivation(qaExecution)).toMatchObject(
				{
					kind: "current",
					binding: { activation_id: "fly2517-qa-activation" },
				},
			);
			expect(
				store
					.listWorkflowRunEvents("run-1")
					.filter(
						(e) =>
							e.kind === "delivery_reroute_operator_required" &&
							e.payload.runHeld === true,
					),
			).toHaveLength(0);
			if (!admission.ok || !admission.submissionCredential)
				throw new Error("QA admission credential missing");
			store.upsertSession({
				execution_id: REPLACEMENT_ID,
				issue_id: "FLY-1307",
				project_name: "flywheel",
				status: "awaiting_review",
				pr_number: 2096,
				pr_head_sha: HEAD,
			});
			const verdict = store.submitWorkflowDecisionByCredential({
				nodeReuseEnabled: false,
				credential: admission.submissionCredential,
				clientRequestId: "fly2517-after-deadline-pass",
				predicate: "qa_passed",
				subjectDigest: HEAD,
				issuerVendor: "claude",
				issuerModel: "claude-opus-5",
				subjectProducerExecutionId: REPLACEMENT_ID,
				subjectProducerVendor: "codex",
				claimExpiresAt: at(60),
				alertIdentity: ALERT_IDENTITY,
				now: at(22),
				gateEntryBinding: {
					kind: "worktree",
					prNumber: 2096,
					headSha: HEAD,
					targetRepoIdentity: "__main__",
					probeRepoSlug: "xrliAnnie/flywheel",
					targetRepoPath: "/tmp/flywheel",
					worktreeBindingGeneration: "generation-1",
					expectedProducerMirrorHead: HEAD,
				},
			});
			expect(verdict, JSON.stringify(verdict)).toMatchObject({ ok: true });
		} finally {
			commDb.close();
		}
	});
});
