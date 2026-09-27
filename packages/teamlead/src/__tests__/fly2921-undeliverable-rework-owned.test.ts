/**
 * FLY-2921 C4.4 / C4.5 (FLY-2330): a rework delivery failure never freezes
 * the run — plan §8.1 row FLY-2330, at StateStore level.
 *
 *  - An undeliverable attempt owned by a rework (the rework family itself, or
 *    a TURN wake whose identity resolves to a rework wake binding) whose
 *    recipient is terminal past grace is settled
 *    `recipient_terminal_rework_owned`: no hold, run stays active, episode
 *    closed, one `rework_recipient_terminal` fact, and the delivery's retry
 *    clock pulled to now so the coordinator re-delivers (replacing the actor
 *    once its death is proven).
 *  - A replacement that completes without its content receipt is refused
 *    (`rework_content_not_delivered`) but opens no undeliverable episode and
 *    no hold: its unconsumed credentials are revoked, the
 *    `rework_replacement_content_missing:<req>:<rev>` fact is written, the
 *    delivery is nudged only when nobody holds a live claim, and the run
 *    stays active.
 */
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { buildReworkWakeId } from "flywheel-comm/db";
import { afterEach, describe, expect, it } from "vitest";
import { UNDELIVERABLE_GRACE_MS } from "../bridge/delivery-contract/policy.js";
import { StateStore } from "../StateStore.js";
import {
	legacyWorkflowSeeds,
	pinLegacyWorkflowSeedAgents,
} from "./fixtures/legacy-workflow-manifests.js";

const ALERT = {
	leadId: "flywheel-eng-lead",
	projectName: "flywheel",
	leadResolution: "resolved" as const,
};

const stores: StateStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

function rawDb(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}

function eventsOfKind(store: StateStore, runId: string, kind: string) {
	return store
		.listWorkflowRunEvents(runId)
		.filter((event) => event.kind === kind);
}

function eventByUid(store: StateStore, eventUid: string) {
	const row = rawDb(store)
		.prepare(
			"SELECT kind, execution_id, payload FROM workflow_run_event WHERE event_uid = ?",
		)
		.get(eventUid) as
		| { kind: string; execution_id: string | null; payload: string }
		| undefined;
	return row
		? { ...row, payload: JSON.parse(row.payload) as Record<string, unknown> }
		: undefined;
}

// ---------------------------------------------------------------------------
// C4.4: undeliverable attempt owned by a rework
// ---------------------------------------------------------------------------

const OPENED_AT = "2026-09-03T16:00:00.000Z";
const OPENED_AT_MS = Date.parse(OPENED_AT);
const JUST_BEFORE_GRACE = new Date(
	OPENED_AT_MS + UNDELIVERABLE_GRACE_MS - 1,
).toISOString();
const AT_GRACE = new Date(OPENED_AT_MS + UNDELIVERABLE_GRACE_MS).toISOString();
const WAKE_SENT_AT = "2026-09-03T15:45:00.000Z";
const STALL_CLOCK = "2026-09-03T15:48:00.000Z";

/**
 * A rework whose wake was pushed (`turn_granted` + `wake_sent_at`) to a body
 * that then died: terminal session, no heartbeat since an hour before the
 * episode opens, no successor execution on the target node. The wake binding
 * and TURN are real so a TURN wake attempt can resolve to this rework.
 */
async function deadReworkTarget(caseId: string): Promise<{
	store: StateStore;
	runId: string;
	requestId: string;
	deadExecutionId: string;
	activationId: string;
	epoch: number;
}> {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const db = rawDb(store);
	const runId = `run-${caseId}`;
	const requestId = `request-${caseId}`;
	const deadExecutionId = `dead-${caseId}`;
	const activationId = `activation:${requestId}`;
	const epoch = 9;
	store.createWorkflowRun({
		runId,
		issueId: "FLY-2330",
		projectName: "flywheel",
		claimsReadEnrolled: true,
	});
	store.upsertSession({
		execution_id: deadExecutionId,
		issue_id: "FLY-2330",
		project_name: "flywheel",
		status: "failed",
		heartbeat_at: "2026-09-03T15:00:00.000Z",
		workflow_node_id: "implement",
	});
	store.upsertWorkflowRunNode({
		runId,
		nodeId: "implement",
		attempt: 2,
		state: "pending",
		executionId: deadExecutionId,
	});
	db.prepare(
		`INSERT INTO workflow_actor
		   (execution_id, project_name, issue_id, role, created_at)
		 VALUES (?, 'flywheel', 'FLY-2330', 'implement', ?)`,
	).run(deadExecutionId, "2026-09-03T15:00:00.000Z");
	db.prepare(
		`INSERT INTO workflow_rework_request
		   (request_id, run_id, source_event_id, authority, source_node_id,
		    source_attempt, base_revision, authority_context_json,
		    authority_context_digest, requested_at)
		 VALUES (?, ?, ?, 'qa', 'qa', 1, ?, '{}', ?, ?)`,
	).run(
		requestId,
		runId,
		`event-${caseId}`,
		"a".repeat(40),
		"b".repeat(64),
		"2026-09-03T15:30:00.000Z",
	);
	db.prepare(
		`INSERT INTO workflow_rework_route_revision
		   (request_id, revision, target_node_id, target_attempt,
		    preferred_actor_execution_id, invalidation_scope_json,
		    verification_policy_json, interpreted_by, interpretation_reason,
		    created_at)
		 VALUES (?, 1, 'implement', 2, ?, '["implement","qa"]',
		         '["qa_retest","founder_gate"]', 'test', 'initial', ?)`,
	).run(requestId, deadExecutionId, "2026-09-03T15:30:00.000Z");
	// FLY-2921: the pushed wake is the `wake_sent_at` fact on `turn_granted`;
	// the coordinator's stall clock points into the future.
	db.prepare(
		`INSERT INTO workflow_rework_delivery
		   (request_id, route_revision, state, wake_sent_at, next_retry_at,
		    updated_at)
		 VALUES (?, 1, 'turn_granted', ?, ?, ?)`,
	).run(requestId, WAKE_SENT_AT, STALL_CLOCK, WAKE_SENT_AT);
	db.prepare(
		`INSERT INTO workflow_execution_binding
		   (activation_id, execution_id, run_id, node_id, attempt, mode,
		    rework_request_id, bound_at)
		 VALUES (?, ?, ?, 'implement', 2, 'wake', ?, ?)`,
	).run(
		activationId,
		deadExecutionId,
		runId,
		requestId,
		"2026-09-03T15:44:00.000Z",
	);
	const turn = store.recordWorkflowActivationTurn({
		activationId,
		executionId: deadExecutionId,
		issueId: "FLY-2330",
		epoch,
		sourceEventId: `rework-turn:${requestId}`,
		grantedAt: "2026-09-03T15:44:30.000Z",
	});
	if (!turn.ok) throw new Error(turn.reason);
	return { store, runId, requestId, deadExecutionId, activationId, epoch };
}

function openUndeliverableEpisode(
	store: StateStore,
	runId: string,
	attemptId: string,
): string {
	const attempt = store
		.listLiveWorkflowDeliveryAttempts()
		.find((row) => row.attempt_id === attemptId);
	if (!attempt) throw new Error(`attempt ${attemptId} is not live`);
	store.observeWorkflowDeliveryContract({
		attempt,
		classification: {
			stage: "minted",
			stageEnteredAt: attempt.minted_at,
			terminal: "undeliverable",
			overdue: false,
			severe: false,
		},
		runId,
		projectName: "flywheel",
		issueId: "FLY-2330",
		now: OPENED_AT,
		alertIdentity: ALERT,
	});
	const episode = rawDb(store)
		.prepare(
			"SELECT episode_id FROM workflow_delivery_contract_episode WHERE attempt_id = ? AND closed_at IS NULL AND stage = 'undeliverable'",
		)
		.get(attemptId) as { episode_id: string } | undefined;
	if (!episode) throw new Error("undeliverable episode did not open");
	return episode.episode_id;
}

function holdAt(
	store: StateStore,
	input: { episodeId: string; recipientExecutionId: string; at: string },
) {
	return store.holdWorkflowUndeliverable({
		episodeId: input.episodeId,
		recipientExecutionId: input.recipientExecutionId,
		commEvidence: {
			recentOutboundInWindow: false,
			observedAtMs: Date.parse(input.at),
		},
		now: input.at,
		alertIdentity: ALERT,
	});
}

/** Every ledger the undeliverable door may touch, as one comparable string. */
function undeliverableLedgers(store: StateStore, requestId: string): string {
	const db = rawDb(store);
	return JSON.stringify({
		runs: db.prepare("SELECT * FROM workflow_run ORDER BY run_id").all(),
		attempts: db
			.prepare("SELECT * FROM workflow_delivery_attempt ORDER BY attempt_id")
			.all(),
		episodes: db
			.prepare(
				"SELECT * FROM workflow_delivery_contract_episode ORDER BY episode_id",
			)
			.all(),
		events: db
			.prepare("SELECT * FROM workflow_run_event ORDER BY event_uid")
			.all(),
		alerts: db
			.prepare("SELECT * FROM workflow_alert_outbox ORDER BY escalation_uid")
			.all(),
		delivery: store.getWorkflowReworkDelivery(requestId),
	});
}

function expectReworkOwnedSettlement(input: {
	store: StateStore;
	runId: string;
	requestId: string;
	deadExecutionId: string;
	attemptId: string;
	rootId: string;
	family: "rework" | "turn_wake";
	episodeId: string;
}) {
	const { store, runId, requestId, attemptId, episodeId } = input;
	const db = rawDb(store);
	// No hold, no frozen run, no operator door.
	expect(store.getWorkflowRun(runId)?.status).toBe("active");
	expect(store.listWorkflowHolds(runId)).toEqual([]);
	expect(
		eventsOfKind(store, runId, "delivery_reroute_operator_required"),
	).toEqual([]);
	expect(eventsOfKind(store, runId, "delivery_undeliverable_hold")).toEqual([]);
	// The attempt and its episode are settled as rework-owned.
	expect(
		db
			.prepare(
				"SELECT settlement_reason, superseded_by_attempt_id FROM workflow_delivery_attempt WHERE attempt_id = ?",
			)
			.get(attemptId),
	).toEqual({
		settlement_reason: "recipient_terminal_rework_owned",
		superseded_by_attempt_id: null,
	});
	expect(
		db
			.prepare(
				"SELECT closed_at, closed_reason FROM workflow_delivery_contract_episode WHERE episode_id = ?",
			)
			.get(episodeId),
	).toEqual({
		closed_at: AT_GRACE,
		closed_reason: "terminal:settled:recipient_terminal_rework_owned",
	});
	// One fact for the coordinator, keyed by the attempt.
	expect(eventByUid(store, `rework_recipient_terminal:${attemptId}`)).toEqual({
		kind: "rework_recipient_terminal",
		execution_id: input.deadExecutionId,
		payload: {
			requestId,
			attemptId,
			family: input.family,
			rootId: input.rootId,
			disposition: "recipient_terminal_rework_owned",
		},
	});
	// The delivery is the coordinator's again right away: state, revision and
	// the wake fact untouched, the retry clock pulled to now, nothing counted.
	expect(store.getWorkflowReworkDelivery(requestId)).toMatchObject({
		state: "turn_granted",
		route_revision: 1,
		wake_sent_at: WAKE_SENT_AT,
		next_retry_at: AT_GRACE,
		hold_count: 0,
		owner_id: null,
	});
}

describe("FLY-2921 C4.4 (FLY-2330): a rework-owned undeliverable attempt never holds the run", () => {
	it("rework family: settles the terminal-recipient attempt as rework-owned and nudges the delivery", async () => {
		const f = await deadReworkTarget("rework-family");
		// The real contract row for this delivery (turn_granted + wake_sent_at
		// is still a live, mintable attempt; the baseline also mints the
		// TURN-derived attempts, which are not under test here).
		expect(
			f.store.baselineWorkflowDeliveryContracts("2026-09-03T15:46:00.000Z")
				.minted,
		).toBeGreaterThanOrEqual(1);
		const reworkAttempts = f.store
			.listLiveWorkflowDeliveryAttempts()
			.filter((row) => row.family === "rework");
		expect(reworkAttempts).toHaveLength(1);
		const attempt = reworkAttempts[0];
		if (!attempt) throw new Error("rework attempt was not minted");
		expect(JSON.parse(attempt.contract_ref_json)).toMatchObject({
			table: "workflow_rework_delivery",
			pk: f.requestId,
		});
		const episodeId = openUndeliverableEpisode(
			f.store,
			f.runId,
			attempt.attempt_id,
		);

		// Before grace nothing is written: a terminal recipient alone is not
		// enough, exactly as for every other family.
		const before = undeliverableLedgers(f.store, f.requestId);
		expect(
			holdAt(f.store, {
				episodeId,
				recipientExecutionId: f.deadExecutionId,
				at: JUST_BEFORE_GRACE,
			}),
		).toEqual({ held: false, reason: "grace_pending" });
		expect(undeliverableLedgers(f.store, f.requestId)).toBe(before);

		// At grace the door does not hold: it hands the attempt back to the
		// rework coordinator.
		const alertsBefore = f.store.listWorkflowAlertOutbox().length;
		expect(
			holdAt(f.store, {
				episodeId,
				recipientExecutionId: f.deadExecutionId,
				at: AT_GRACE,
			}),
		).toEqual({ held: false, reason: "recipient_terminal_rework_owned" });
		expectReworkOwnedSettlement({
			store: f.store,
			runId: f.runId,
			requestId: f.requestId,
			deadExecutionId: f.deadExecutionId,
			attemptId: attempt.attempt_id,
			rootId: attempt.root_id,
			family: "rework",
			episodeId,
		});
		// The coordinator, not the Lead, owns the next step: no alert.
		expect(f.store.listWorkflowAlertOutbox()).toHaveLength(alertsBefore);

		// The episode is closed: a later sweep finds nothing to do and writes
		// nothing.
		const settled = undeliverableLedgers(f.store, f.requestId);
		expect(
			holdAt(f.store, {
				episodeId,
				recipientExecutionId: f.deadExecutionId,
				at: new Date(OPENED_AT_MS + UNDELIVERABLE_GRACE_MS * 2).toISOString(),
			}),
		).toEqual({ held: false, reason: "episode_not_open" });
		expect(undeliverableLedgers(f.store, f.requestId)).toBe(settled);
	});

	it("turn_wake family: a rework wake whose recipient died is the coordinator's, not a hold", async () => {
		const f = await deadReworkTarget("turn-wake");
		const identity = {
			wakeId: buildReworkWakeId({
				requestId: f.requestId,
				activationId: f.activationId,
				epoch: f.epoch,
			}),
			activationId: f.activationId,
			executionId: f.deadExecutionId,
			epoch: f.epoch,
		};
		const rootId = `flywheel:FLY-2330:turn_wake:${identity.wakeId}`;
		const attemptId = `${rootId}:g1:a1`;
		f.store.projectWorkflowDeliveryAttempt({
			rootId,
			attemptId,
			family: "turn_wake",
			contractRef: {
				table: "turn_wake_outbox",
				pk: identity.wakeId,
				runId: f.runId,
				projectName: "flywheel",
				issueId: "FLY-2330",
				reworkWake: identity,
			},
			mintedAt: WAKE_SENT_AT,
			sentAt: WAKE_SENT_AT,
		});
		const episodeId = openUndeliverableEpisode(f.store, f.runId, attemptId);
		const alertsBefore = f.store.listWorkflowAlertOutbox().length;
		expect(
			holdAt(f.store, {
				episodeId,
				recipientExecutionId: f.deadExecutionId,
				at: AT_GRACE,
			}),
		).toEqual({ held: false, reason: "recipient_terminal_rework_owned" });
		expectReworkOwnedSettlement({
			store: f.store,
			runId: f.runId,
			requestId: f.requestId,
			deadExecutionId: f.deadExecutionId,
			attemptId,
			rootId,
			family: "turn_wake",
			episodeId,
		});
		expect(f.store.listWorkflowAlertOutbox()).toHaveLength(alertsBefore);
	});

	it("scope control: a TURN wake with no rework identity is not carved out — the generic FLY-2278 door still decides", async () => {
		// The generic door's own verdict for a non-rework wake (here it holds,
		// FLY-2278 legacy; plan C4.1 leaves non-replacement bindings to
		// FLY-2922) is not under test. What is: it is NOT the rework-owned
		// settlement, and it does not touch the rework it does not own.
		const f = await deadReworkTarget("plain-turn-wake");
		const rootId = "flywheel:FLY-2330:turn_wake:plain-wake";
		const attemptId = `${rootId}:g1:a1`;
		f.store.projectWorkflowDeliveryAttempt({
			rootId,
			attemptId,
			family: "turn_wake",
			contractRef: {
				table: "turn_wake_outbox",
				pk: "plain-wake",
				runId: f.runId,
				projectName: "flywheel",
				issueId: "FLY-2330",
			},
			mintedAt: WAKE_SENT_AT,
			sentAt: WAKE_SENT_AT,
		});
		const episodeId = openUndeliverableEpisode(f.store, f.runId, attemptId);
		const result = holdAt(f.store, {
			episodeId,
			recipientExecutionId: f.deadExecutionId,
			at: AT_GRACE,
		});
		expect(result.reason).not.toBe("recipient_terminal_rework_owned");
		expect(result.reason).toBe("operator_required");
		expect(
			rawDb(f.store)
				.prepare(
					"SELECT settlement_reason FROM workflow_delivery_attempt WHERE attempt_id = ?",
				)
				.get(attemptId),
		).not.toEqual({ settlement_reason: "recipient_terminal_rework_owned" });
		expect(eventsOfKind(f.store, f.runId, "rework_recipient_terminal")).toEqual(
			[],
		);
		// The rework's own clock is not touched by a wake it does not own.
		expect(f.store.getWorkflowReworkDelivery(f.requestId)).toMatchObject({
			next_retry_at: STALL_CLOCK,
		});
	});
});

// ---------------------------------------------------------------------------
// C4.5: replacement completion without its content receipt
// ---------------------------------------------------------------------------

const enabled = {
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
};
const RUN = "run-heavy";
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const BASE = "a".repeat(40);
const NEW_HEAD = "b".repeat(40);
const REPLACEMENT = "replacement-1";
const T = (minutes: number) =>
	new Date(
		Date.parse("2026-07-23T00:11:00.000Z") + minutes * 60_000,
	).toISOString();

async function createHeavyEngineRun(): Promise<StateStore> {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const legacy = legacyWorkflowSeeds().find(
		(candidate) => candidate.templateId === "tpl_eng_heavy",
	);
	if (!legacy) throw new Error("tpl_eng_heavy seed missing");
	// Pinned through the current registry contract so `implement` produces
	// output: that is what gives the replacement credentials to revoke.
	const seed = pinLegacyWorkflowSeedAgents(legacy);
	store.importWorkflowTemplateSeed(seed);
	store.bindWorkflowCategory({
		project: "flywheel",
		taskCategory: "code",
		templateId: seed.templateId,
		updatedBy: "lead",
	});
	store.materializeWorkflowRun({
		runId: RUN,
		issueId: "FLY-1423",
		projectName: "flywheel",
		taskCategory: "code",
		templateId: seed.templateId,
		claimsReadEnrolled: true,
		actor: "lead",
		canonicalRoot: REPO_ROOT,
		env: enabled,
		startReservation: {
			idempotencyKey: "start-heavy",
			selectionDigest: "selection-heavy",
			nodeId: "design",
			attempt: 1,
			executionId: "design-exec",
			createdAt: "2026-07-23T00:00:00.000Z",
		},
	});
	store.upsertWorkflowRunNode({
		runId: RUN,
		nodeId: "design",
		attempt: 1,
		state: "running",
		executionId: "design-exec",
	});
	return store;
}

function advance(
	store: StateStore,
	input: {
		nodeId: string;
		attempt: number;
		executionId: string;
		outcome: string;
		successorExecutionId?: string;
		subjectDigest?: string;
	},
) {
	return store.commitWorkflowTransitionTx({
		nodeReuseEnabled: false,
		runId: RUN,
		...input,
		now: "2026-07-23T00:10:00.000Z",
	});
}

/** QA fails implement#1 at BASE: a rework on implement#2 opens, `pending`. */
async function createPendingHeavyRework(): Promise<{
	store: StateStore;
	requestId: string;
}> {
	const store = await createHeavyEngineRun();
	advance(store, {
		nodeId: "design",
		attempt: 1,
		executionId: "design-exec",
		outcome: "design_done",
		successorExecutionId: "implement-exec",
	});
	advance(store, {
		nodeId: "implement",
		attempt: 1,
		executionId: "implement-exec",
		outcome: "implement_done",
		successorExecutionId: "qa-exec",
	});
	const failed = advance(store, {
		nodeId: "qa",
		attempt: 1,
		executionId: "qa-exec",
		outcome: "qa_fail",
		subjectDigest: BASE,
	});
	if (!failed.ok || !failed.reworkRequestId) {
		throw new Error("rework request not returned");
	}
	return { store, requestId: failed.reworkRequestId };
}

/**
 * The preferred actor is proven dead (an exact unlaunched-rollback fact, C2
 * step 4), the coordinator replaces it in place, and the dispatcher admits
 * the replacement with the rework's launch context. The replacement comes up
 * running — but nothing ever marked its launch-envelope content delivered
 * (FLY-2472: it replays the dead body's completion), so the delivery is still
 * `pending` on revision 2 when it tries to complete.
 */
async function replacementWithoutContent(): Promise<{
	store: StateStore;
	requestId: string;
}> {
	const { store, requestId } = await createPendingHeavyRework();
	// The death proof in the shape `rollbackUnlaunchedWorkflowAdmission`
	// writes for a replacement binding: a plain fact, not a registered hold
	// shape, so it leaves no phantom run hold behind (the `held` ledger below
	// must be empty for the "no hold" assertions to mean anything).
	store.appendWorkflowRunEvent({
		runId: RUN,
		eventUid: "unlaunched_rollback:run-heavy:implement:2:implement-exec",
		kind: "rework_replacement_launch_rolled_back",
		nodeId: "implement",
		executionId: "implement-exec",
		payload: {
			attempt: 2,
			reason: "unlaunched_admission_rolled_back",
			at: T(-1),
		},
	});
	expect(store.listWorkflowHolds(RUN)).toEqual([]);
	const claim = store.claimWorkflowReworkDelivery({
		requestId,
		ownerId: "coordinator",
		now: T(0),
		leaseExpiresAt: T(0.5),
	});
	if (!claim.ok) throw new Error(claim.reason);
	const replaced = store.replaceWorkflowReworkActor({
		requestId,
		ownerId: "coordinator",
		generation: claim.generation,
		deadExecutionId: "implement-exec",
		newExecutionId: REPLACEMENT,
		proof: { kind: "unlaunched_rollback" },
		reason: "unlaunched_rollback",
		observedAt: T(0),
	});
	if (!replaced.ok) throw new Error(replaced.reason);
	expect(replaced).toMatchObject({
		executionId: REPLACEMENT,
		routeRevision: 2,
		idempotentReplay: false,
	});
	const admitted = store.admitGeneralizedWorkflowExecution({
		runId: RUN,
		nodeId: "implement",
		executionId: REPLACEMENT,
		attempt: 2,
		activationId: `activation:${REPLACEMENT}`,
		activationMode: "replacement",
		reworkRequestId: requestId,
		expiresAt: T(120),
		absoluteDeadlineAt: T(24 * 60),
		now: T(1),
		env: enabled,
	});
	if (!admitted.ok) throw new Error(admitted.reason);
	store.upsertSession({
		execution_id: REPLACEMENT,
		issue_id: "FLY-1423",
		project_name: "flywheel",
		status: "running",
		workflow_node_id: "implement",
		heartbeat_at: T(2),
		last_activity_at: T(2),
	});
	store.upsertWorkflowRunNode({
		runId: RUN,
		nodeId: "implement",
		attempt: 2,
		state: "running",
		executionId: REPLACEMENT,
	});
	expect(store.getWorkflowExecutionBinding(REPLACEMENT)?.mode).toBe(
		"replacement",
	);
	expect(store.getWorkflowReworkDelivery(requestId)).toMatchObject({
		state: "pending",
		route_revision: 2,
		owner_id: null,
	});
	seedReplacementCredentials(store);
	return { store, requestId };
}

/**
 * Stand-in for the credentials a producing node's admission issues: an
 * `implement` node in tpl_eng_heavy produces no output and carries no
 * decision contract, so its admission issues nothing (the admission receipt
 * says `output:false, decision:false`). The revocation branch is proven on
 * seeded rows bound to the replacement's real activation: one live, one
 * already consumed (which the revocation must leave alone).
 */
function seedReplacementCredentials(store: StateStore): void {
	const insert = rawDb(store).prepare(
		`INSERT INTO workflow_output_credential
		   (activation_id, credential_hash, run_id, node_id, execution_id,
		    attempt, issued_at, expires_at, absolute_deadline_at, consumed_at)
		 VALUES (?, ?, ?, 'implement', ?, 2, ?, ?, ?, ?)`,
	);
	insert.run(
		`activation:${REPLACEMENT}`,
		"credential-replacement-live",
		RUN,
		REPLACEMENT,
		T(1),
		T(120),
		T(24 * 60),
		null,
	);
	insert.run(
		`activation:${REPLACEMENT}`,
		"credential-replacement-consumed",
		RUN,
		REPLACEMENT,
		T(1),
		T(120),
		T(24 * 60),
		T(2),
	);
}

function replacementCredentialRows(store: StateStore) {
	return rawDb(store)
		.prepare(
			`SELECT credential_hash, consumed_at, revoked, revoked_reason
			   FROM workflow_output_credential
			  WHERE execution_id = ?
			  ORDER BY credential_hash`,
		)
		.all(REPLACEMENT) as Array<{
		credential_hash: string;
		consumed_at: string | null;
		revoked: number;
		revoked_reason: string | null;
	}>;
}

function completeReplacement(
	store: StateStore,
	sourceEventId = "complete-replacement-1",
) {
	return store.commitEnrolledCompletion({
		nodeReuseEnabled: false,
		executionId: REPLACEMENT,
		route: "needs_review",
		sourceEventId,
		completionSubmission: { decision: { route: "needs_review" } },
		subjectDigest: NEW_HEAD,
		alertIdentity: ALERT,
		now: T(3),
	});
}

function unconsumedCredentials(store: StateStore, executionId: string) {
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

function replacementLedgers(store: StateStore, requestId: string): string {
	const db = rawDb(store);
	return JSON.stringify({
		run: store.getWorkflowRun(RUN)?.status,
		node: store.getWorkflowRunNode(RUN, "implement", 2),
		delivery: store.getWorkflowReworkDelivery(requestId),
		path: store.getWorkflowReworkVerificationPath(requestId),
		completion: store.getWorkflowNodeCompletion(RUN, "implement", 2) ?? null,
		credentials: unconsumedCredentials(store, REPLACEMENT),
		events: db
			.prepare("SELECT event_uid FROM workflow_run_event ORDER BY seq")
			.all(),
		alerts: store.listWorkflowAlertOutbox().length,
		holds: store.listWorkflowHolds(RUN).length,
		episodes: db
			.prepare("SELECT * FROM workflow_delivery_contract_episode")
			.all(),
	});
}

describe("FLY-2921 C4.5 (FLY-2330): a replacement completing without its content is unusable, not undeliverable", () => {
	it("refuses the completion with no episode and no hold, revokes the replacement's credentials, writes the fact, nudges the delivery", async () => {
		const { store, requestId } = await replacementWithoutContent();
		expect(replacementCredentialRows(store)).toEqual([
			{
				credential_hash: "credential-replacement-consumed",
				consumed_at: T(2),
				revoked: 0,
				revoked_reason: null,
			},
			{
				credential_hash: "credential-replacement-live",
				consumed_at: null,
				revoked: 0,
				revoked_reason: null,
			},
		]);
		expect(unconsumedCredentials(store, REPLACEMENT)).toEqual([
			{ family: "output", revoked: 0, revoked_reason: null },
		]);

		const result = completeReplacement(store);
		expect(result).toMatchObject({
			ok: false,
			reason: "rework_content_not_delivered",
			detail: { requestId, routeRevision: 2, deliveryState: "pending" },
		});
		// Nothing transitioned.
		expect(
			store.getWorkflowNodeCompletion(RUN, "implement", 2),
		).toBeUndefined();
		expect(store.getWorkflowRunNode(RUN, "implement", 2)).toMatchObject({
			state: "running",
			execution_id: REPLACEMENT,
		});
		expect(store.getWorkflowRun(RUN)?.current_node_id).toBe("implement");

		// C4.5: no undeliverable episode, no hold, run active.
		expect(store.getWorkflowRun(RUN)?.status).toBe("active");
		expect(store.listWorkflowHolds(RUN)).toEqual([]);
		expect(
			rawDb(store)
				.prepare(
					"SELECT * FROM workflow_delivery_contract_episode WHERE family = 'rework'",
				)
				.all(),
		).toEqual([]);
		expect(
			eventsOfKind(store, RUN, "delivery_reroute_operator_required"),
		).toEqual([]);
		expect(eventsOfKind(store, RUN, "delivery_undeliverable_hold")).toEqual([]);

		// The replacement is unusable: its unconsumed credential is revoked
		// under the fact's name, the consumed one is history and untouched...
		expect(replacementCredentialRows(store)).toEqual([
			{
				credential_hash: "credential-replacement-consumed",
				consumed_at: T(2),
				revoked: 0,
				revoked_reason: null,
			},
			{
				credential_hash: "credential-replacement-live",
				consumed_at: null,
				revoked: 1,
				revoked_reason: "rework_replacement_content_missing",
			},
		]);
		// ...the fact is written once for the coordinator, keyed by revision...
		expect(
			eventByUid(store, `rework_replacement_content_missing:${requestId}:2`),
		).toEqual({
			kind: "rework_replacement_content_missing",
			execution_id: REPLACEMENT,
			payload: { requestId, routeRevision: 2, attempt: 2 },
		});
		expect(
			store.hasReworkReplacementContentMissingFact({
				runId: RUN,
				requestId,
				routeRevision: 2,
			}),
		).toBe(true);
		// ...and the unclaimed delivery is nudged: still `pending` on the same
		// revision, retry clock pulled to now.
		expect(store.getWorkflowReworkDelivery(requestId)).toMatchObject({
			state: "pending",
			route_revision: 2,
			owner_id: null,
			next_retry_at: T(3),
		});

		// One refusal audit and one warning alert that says the run is active.
		expect(
			eventsOfKind(store, RUN, "completion_transition_refused"),
		).toHaveLength(1);
		const alerts = store.listWorkflowAlertOutbox();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]?.payload.severity).toBe("warning");
		expect(alerts[0]?.payload.body).toContain("The run stays active");
		expect(alerts[0]?.payload.body).not.toContain("frozen");

		// Replaying the completion is the same refusal with no new writes.
		const after = replacementLedgers(store, requestId);
		expect(
			completeReplacement(store, "complete-replacement-1-replay"),
		).toMatchObject({ ok: false, reason: "rework_content_not_delivered" });
		expect(replacementLedgers(store, requestId)).toBe(after);
	});

	it("leaves a delivery alone while someone holds a live claim on it; the fact and revocation still land", async () => {
		const { store, requestId } = await replacementWithoutContent();
		const claim = store.claimWorkflowReworkDelivery({
			requestId,
			ownerId: "coordinator",
			now: T(2.5),
			leaseExpiresAt: T(12.5),
		});
		if (!claim.ok) throw new Error(claim.reason);
		const held = store.getWorkflowReworkDelivery(requestId);
		expect(held).toMatchObject({ owner_id: "coordinator", state: "pending" });
		expect(held?.next_retry_at).not.toBe(T(3));

		expect(completeReplacement(store)).toMatchObject({
			ok: false,
			reason: "rework_content_not_delivered",
		});
		// The claim and its clock are untouched: the owner sees the fact on
		// its own next pass.
		expect(store.getWorkflowReworkDelivery(requestId)).toMatchObject({
			state: "pending",
			route_revision: 2,
			owner_id: "coordinator",
			generation: claim.generation,
			lease_expires_at: T(12.5),
			next_retry_at: held?.next_retry_at ?? null,
		});
		expect(
			store.hasReworkReplacementContentMissingFact({
				runId: RUN,
				requestId,
				routeRevision: 2,
			}),
		).toBe(true);
		expect(unconsumedCredentials(store, REPLACEMENT)).toEqual([
			{
				family: "output",
				revoked: 1,
				revoked_reason: "rework_replacement_content_missing",
			},
		]);
		expect(store.getWorkflowRun(RUN)?.status).toBe("active");
		expect(store.listWorkflowHolds(RUN)).toEqual([]);
	});
});
