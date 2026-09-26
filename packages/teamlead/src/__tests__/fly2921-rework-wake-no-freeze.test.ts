import type Database from "better-sqlite3";
import { buildReworkWakeId } from "flywheel-comm/db";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

/**
 * FLY-2921 (Codex code review R1 #1): a rework TURN wake pushed twice and
 * never acked is the rework coordinator's to probe, alert on, and return to
 * the Lead. The generic `three_stage_turn_stuck` freeze must not hold the run.
 */

const NOW = "2026-09-26T19:00:00.000Z";
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

async function fixture() {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	store.createWorkflowRun({
		runId: "run",
		issueId: "FLY-2921",
		projectName: "flywheel",
		claimsReadEnrolled: true,
	});
	const db = rawDb(store);
	db.prepare("UPDATE workflow_run SET engine_owned = 1 WHERE run_id = ?").run(
		"run",
	);
	// Recorded alive, but every liveness signal is stale: the combination the
	// generic freeze predicate accepts.
	store.upsertSession({
		execution_id: "actor",
		issue_id: "FLY-2921",
		project_name: "flywheel",
		status: "running",
		heartbeat_at: "2026-09-26T17:00:00.000Z",
		last_activity_at: "2026-09-26T17:00:00.000Z",
	});
	store.upsertWorkflowRunNode({
		runId: "run",
		nodeId: "implement",
		attempt: 2,
		state: "admitted",
		executionId: "actor",
	});
	db.prepare(
		"INSERT INTO workflow_actor (execution_id,project_name,issue_id,role,created_at) VALUES (?,?,?,?,?)",
	).run("actor", "flywheel", "FLY-2921", "implement", NOW);
	db.prepare(`INSERT INTO workflow_rework_request
		(request_id,run_id,source_event_id,authority,source_node_id,source_attempt,base_revision,authority_context_json,authority_context_digest,requested_at)
		VALUES ('request','run','qa-fail','qa','qa',1,?,'{}',?,?)`).run(
		"a".repeat(40),
		"b".repeat(64),
		NOW,
	);
	db.prepare(`INSERT INTO workflow_rework_route_revision
		(request_id,revision,target_node_id,target_attempt,preferred_actor_execution_id,invalidation_scope_json,verification_policy_json,interpreted_by,interpretation_reason,created_at)
		VALUES ('request',1,'implement',2,'actor','["implement"]','["qa_retest"]','fixture','fixture',?)`).run(
		NOW,
	);
	db.prepare(
		"INSERT INTO workflow_rework_delivery (request_id,route_revision,state,wake_sent_at,updated_at) VALUES ('request',1,'turn_granted',?,?)",
	).run(NOW, NOW);
	db.prepare(`INSERT INTO workflow_execution_binding
		(activation_id,execution_id,run_id,node_id,attempt,mode,rework_request_id,bound_at)
		VALUES ('activation:request','actor','run','implement',2,'wake','request',?)`).run(
		NOW,
	);
	expect(
		store.recordWorkflowActivationTurn({
			activationId: "activation:request",
			executionId: "actor",
			issueId: "FLY-2921",
			epoch: 7,
			sourceEventId: "rework-turn:request:activation:request",
			grantedAt: NOW,
		}),
	).toMatchObject({ ok: true });
	const identity = {
		wakeId: buildReworkWakeId({
			requestId: "request",
			activationId: "activation:request",
			epoch: 7,
		}),
		activationId: "activation:request",
		executionId: "actor",
		epoch: 7,
	};
	return { store, identity };
}

function project(
	store: StateStore,
	physicalId: string,
	reworkWake?: {
		wakeId: string;
		activationId: string;
		executionId: string;
		epoch: number;
	},
) {
	const rootId = `flywheel:FLY-2921:turn_wake:${physicalId}`;
	const attemptId = `${rootId}:g1:a1`;
	store.projectWorkflowDeliveryAttempt({
		rootId,
		attemptId,
		family: "turn_wake",
		mintedAt: NOW,
		contractRef: {
			table: "turn_wake_outbox",
			pk: physicalId,
			runId: "run",
			projectName: "flywheel",
			issueId: "FLY-2921",
			...(reworkWake ? { reworkWake } : {}),
		},
	});
	return { rootId, attemptId };
}

function freeze(
	store: StateStore,
	attempt: { rootId: string; attemptId: string },
	physicalId: string,
) {
	const now = new Date(Date.parse(NOW) + 25 * 60_000).toISOString();
	return store.freezeWorkflowDelivery({
		runId: "run",
		shape: "three_stage_turn_stuck",
		attemptId: attempt.attemptId,
		rootId: attempt.rootId,
		physicalId,
		recipientExecutionId: "actor",
		shapeSince: NOW,
		thresholdMs: 20 * 60_000,
		commEvidence: {
			recentOutboundInWindow: false,
			observedAtMs: Date.parse(now),
		},
		now,
		alertIdentity: ALERT,
	});
}

describe("FLY-2921 a stuck rework TURN wake never freezes the run", () => {
	it("control: the same stuck shape on a non-rework TURN wake still freezes", async () => {
		const { store } = await fixture();
		const attempt = project(store, "plain-wake");
		expect(freeze(store, attempt, "plain-wake")).toMatchObject({
			held: true,
		});
		expect(store.getWorkflowRun("run")?.status).toBe("held");
	});

	it("hands the rework wake back to the coordinator with zero writes", async () => {
		const { store, identity } = await fixture();
		const attempt = project(store, identity.wakeId, identity);
		const before = rawDb(store)
			.prepare(
				"SELECT (SELECT COUNT(*) FROM workflow_run_event) AS events, (SELECT COUNT(*) FROM workflow_delivery_contract_episode) AS episodes",
			)
			.get();
		expect(freeze(store, attempt, identity.wakeId)).toEqual({
			held: false,
			reason: "rework_wake_owned_by_coordinator",
		});
		expect(store.getWorkflowRun("run")?.status).toBe("active");
		expect(store.listWorkflowHolds("run")).toEqual([]);
		expect(store.getWorkflowReworkDelivery("request")).toMatchObject({
			state: "turn_granted",
			wake_sent_at: NOW,
		});
		expect(
			rawDb(store)
				.prepare(
					"SELECT (SELECT COUNT(*) FROM workflow_run_event) AS events, (SELECT COUNT(*) FROM workflow_delivery_contract_episode) AS episodes",
				)
				.get(),
		).toEqual(before);
	});
});
