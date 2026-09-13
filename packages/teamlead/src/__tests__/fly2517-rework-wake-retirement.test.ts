import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import express from "express";
import { buildReworkWakeId, CommDB } from "flywheel-comm/db";
import { afterEach, describe, expect, it } from "vitest";
import { DeliveryProjector } from "../bridge/delivery-contract/projector.js";
import { DeliveryContractWatch } from "../bridge/delivery-contract/watch.js";
import { DeliveryOperations } from "../bridge/delivery-operations.js";
import { ConfirmTokenStore } from "../bridge/fleet-admin.js";
import { createRunsRouter } from "../bridge/runs-route.js";
import { StateStore } from "../StateStore.js";

const NOW = "2026-09-11T15:41:42.000Z";
const stores: StateStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});
function rawDb(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}
async function fixture(path = ":memory:") {
	const store = await StateStore.create(path);
	stores.push(store);
	store.createWorkflowRun({
		runId: "run",
		issueId: "FLY-2517",
		projectName: "flywheel",
		claimsReadEnrolled: true,
	});
	const db = rawDb(store);
	db.prepare("UPDATE workflow_run SET engine_owned = 1 WHERE run_id = ?").run(
		"run",
	);
	store.upsertSession({
		execution_id: "old",
		issue_id: "FLY-2517",
		project_name: "flywheel",
		status: "failed",
	});
	store.upsertWorkflowRunNode({
		runId: "run",
		nodeId: "implement",
		attempt: 2,
		state: "pending",
		executionId: "old",
	});
	db.prepare(
		"INSERT INTO workflow_actor (execution_id,project_name,issue_id,role,created_at) VALUES (?,?,?,?,?)",
	).run("old", "flywheel", "FLY-2517", "implement", NOW);
	db.prepare(`INSERT INTO workflow_rework_request
		(request_id,run_id,source_event_id,authority,source_node_id,source_attempt,base_revision,authority_context_json,authority_context_digest,requested_at)
		VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
		"request",
		"run",
		"qa-fail",
		"qa",
		"qa",
		1,
		"a".repeat(40),
		"{}",
		"b".repeat(64),
		NOW,
	);
	db.prepare(`INSERT INTO workflow_rework_route_revision
		(request_id,revision,target_node_id,target_attempt,preferred_actor_execution_id,invalidation_scope_json,verification_policy_json,interpreted_by,interpretation_reason,created_at)
		VALUES (?,1,?,2,?,?,?,?,?,?)`).run(
		"request",
		"implement",
		"old",
		'["implement","qa"]',
		'["qa_retest","founder_gate"]',
		"fixture",
		"fixture",
		NOW,
	);
	db.prepare(
		"INSERT INTO workflow_rework_delivery (request_id,route_revision,state,updated_at) VALUES (?,1,'replacement_pending',?)",
	).run("request", NOW);
	db.prepare(`INSERT INTO workflow_execution_binding
		(activation_id,execution_id,run_id,node_id,attempt,mode,rework_request_id,bound_at)
		VALUES (?,?,?,?,2,'wake',?,?)`).run(
		"activation:request",
		"old",
		"run",
		"implement",
		"request",
		NOW,
	);
	expect(
		store.recordWorkflowActivationTurn({
			activationId: "activation:request",
			executionId: "old",
			issueId: "FLY-2517",
			epoch: 9,
			sourceEventId: "rework-turn:request:activation:request",
			grantedAt: NOW,
		}),
	).toMatchObject({ ok: true });
	const identity = {
		wakeId: buildReworkWakeId({
			requestId: "request",
			activationId: "activation:request",
			epoch: 9,
		}),
		activationId: "activation:request",
		executionId: "old",
		epoch: 9,
	};
	store.baselineWorkflowDeliveryContracts(NOW);
	const replace = () =>
		store.materializeWorkflowReworkReplacement({
			requestId: "request",
			deadExecutionId: "old",
			newExecutionId: "replacement",
			reason: "persisted_target_dead",
			observedAt: NOW,
		});
	return { store, db, identity, replace };
}

describe("FLY-2517 exact engine replacement retirement", () => {
	it("records the old wake in the replacement transaction with immutable proof and replay", async () => {
		const { store, identity, replace, db } = await fixture();
		expect(replace()).toMatchObject({ ok: true, idempotentReplay: false });
		const proof = store.resolveReworkWakeRetirementProofTx(identity);
		expect(proof).toMatchObject({
			kind: "proven",
			proof: {
				...identity,
				runId: "run",
				requestId: "request",
				nodeId: "implement",
				attempt: 2,
				oldRouteRevision: 1,
				newRouteRevision: 2,
				replacementExecutionId: "replacement",
				replacementEventUid: "rework_replacement_materialized:request",
			},
		});
		expect(store.listPendingReworkWakeRetirements({ limit: 10 })).toHaveLength(
			1,
		);
		expect(replace()).toMatchObject({ ok: true, idempotentReplay: true });
		expect(store.listPendingReworkWakeRetirements({ limit: 10 })).toHaveLength(
			1,
		);
		expect(store.getWorkflowReworkDelivery("request")?.state).toBe(
			"replacement_pending",
		);
		expect(() =>
			db.prepare("UPDATE workflow_rework_wake_retirement SET epoch=10").run(),
		).toThrow();
	});
});

describe("FLY-2517 retirement guards", () => {
	it("does not infer replacement from actor status and rejects a mismatched tuple", async () => {
		const { store, identity, replace } = await fixture();
		expect(store.resolveReworkWakeRetirementProofTx(identity)).toMatchObject({
			kind: "unproven",
		});
		expect(replace()).toMatchObject({ ok: true });
		for (const candidate of [
			{ ...identity, epoch: 10 },
			{ ...identity, executionId: "replacement" },
			{ ...identity, activationId: "activation:other" },
			{ ...identity, wakeId: "unrelated" },
		])
			expect(store.resolveReworkWakeRetirementProofTx(candidate)).toMatchObject(
				{ kind: "unproven" },
			);
	});

	it("rolls back the route, launch, actor, and retirement together on an insert failure", async () => {
		const { store, db, replace } = await fixture();
		db.exec(`CREATE TRIGGER fail_retirement BEFORE INSERT ON workflow_rework_wake_retirement
			BEGIN SELECT RAISE(ABORT, 'test_retirement_failure'); END;`);
		expect(replace).toThrow("test_retirement_failure");
		expect(store.getLatestWorkflowReworkRoute("request")?.revision).toBe(1);
		expect(store.getWorkflowRunNode("run", "implement", 2)?.execution_id).toBe(
			"old",
		);
		expect(store.getWorkflowActor("replacement")).toBeUndefined();
		expect(
			db
				.prepare(
					"SELECT COUNT(*) AS n FROM workflow_side_effect_ledger WHERE execution_id = ?",
				)
				.get("replacement"),
		).toEqual({ n: 0 });
		expect(store.listPendingReworkWakeRetirements({ limit: 10 })).toHaveLength(
			0,
		);
		db.exec("DROP TRIGGER fail_retirement");
		expect(replace()).toMatchObject({ ok: true });
		expect(store.listPendingReworkWakeRetirements({ limit: 10 })).toHaveLength(
			1,
		);
	});
});

describe("FLY-2517 cross-store retirement replay", () => {
	it("applies the durable pending retirement even while the run is held", async () => {
		const { store, replace, identity, db } = await fixture();
		expect(replace()).toMatchObject({ ok: true });
		db.prepare("UPDATE workflow_run SET status = 'held' WHERE run_id = ?").run(
			"run",
		);
		const commDb = new CommDB(":memory:");
		try {
			commDb.enqueueRunnerPhaseWake(
				"old",
				{
					id: "physical",
					to: "old",
					content: "wake",
					metadata: { ...identity, kind: "workflow_rework" },
				},
				Date.parse(NOW),
			);
			new DeliveryOperations({
				store,
				commDb,
				projectName: "flywheel",
				resolveRecipient: () => null,
				resolveAlertIdentity: () => ({
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				}),
			}).runPass(NOW);
			expect(
				store.listPendingReworkWakeRetirements({ limit: 10 }),
			).toHaveLength(0);
			expect(
				commDb.enqueueRunnerPhaseWake(
					"old",
					{
						id: "physical",
						to: "old",
						content: "wake",
						metadata: { ...identity, kind: "workflow_rework" },
					},
					Date.parse(NOW),
				),
			).toMatchObject({
				kind: "disposed",
				wake: { state: "finished", started_at: null },
			});
			expect(store.getWorkflowRun("run")?.status).toBe("held");
		} finally {
			commDb.close();
		}
	});
});

describe("FLY-2517 retirement at the projection boundary", () => {
	it.each(["before", "after"] as const)(
		"settles an exact projection created %s replacement without consumption clocks",
		async (when) => {
			const { store, replace, identity, db } = await fixture();
			const rootId = "flywheel:FLY-2517:phase_wake:physical";
			const attemptId = `${rootId}:g1:a1`;
			const project = () =>
				store.projectWorkflowDeliveryAttempt({
					rootId,
					attemptId,
					family: "phase_wake",
					mintedAt: NOW,
					contractRef: {
						table: "runner_phase_wakes",
						pk: "physical",
						runId: "run",
						projectName: "flywheel",
						issueId: "FLY-2517",
						reworkWake: identity,
					},
				});
			if (when === "before") project();
			expect(replace()).toMatchObject({ ok: true });
			if (when === "after") project();
			expect(
				db
					.prepare(
						"SELECT settlement_reason, received_at, consumed_at FROM workflow_delivery_attempt WHERE attempt_id = ?",
					)
					.get(attemptId),
			).toEqual({
				settlement_reason: "superseded_by_rework_replacement",
				received_at: null,
				consumed_at: null,
			});
			expect(
				db
					.prepare(
						"SELECT COUNT(*) AS n FROM workflow_run_event WHERE kind = 'rework_wake_attempt_retired'",
					)
					.get(),
			).toEqual({ n: 1 });
		},
	);
});

describe("FLY-2517 real projection identity", () => {
	it("hydrates the parent-backed identity before replacement and prevents old-wake holds before Comm replay", async () => {
		const { store, identity, replace, db } = await fixture();
		const commDb = new CommDB(":memory:");
		try {
			commDb.registerSession(
				"old",
				"window",
				"flywheel",
				"FLY-2517",
				"flywheel-eng-lead",
			);
			const metadata = {
				kind: "workflow_rework",
				wakeId: identity.wakeId,
				activationId: identity.activationId,
				epoch: identity.epoch,
			};
			commDb.enqueueTurnWake({
				wakeId: identity.wakeId,
				executionId: "old",
				activationId: identity.activationId,
				epoch: 9,
				issueId: "FLY-2517",
				purpose: "workflow_rework",
				envelope: { fromAgent: "bridge", content: "wake", metadata },
				backend: "codex",
				createdAtMs: Date.parse(NOW),
			});
			commDb.enqueueRunnerPhaseWake(
				"old",
				{ id: "physical", to: "old", content: "wake", metadata },
				Date.parse(NOW),
			);
			const projector = new DeliveryProjector({
				store,
				commDb,
				projectName: "flywheel",
			});
			projector.runPass(NOW);
			const before = db
				.prepare(
					"SELECT contract_ref_json FROM workflow_delivery_attempt WHERE family='phase_wake'",
				)
				.get() as { contract_ref_json: string };
			expect(JSON.parse(before.contract_ref_json)).toMatchObject({
				runId: "run",
				reworkWake: identity,
			});
			expect(replace()).toMatchObject({ ok: true });
			const old = db
				.prepare(
					"SELECT settlement_reason,consumed_at FROM workflow_delivery_attempt WHERE family IN ('phase_wake','turn_wake')",
				)
				.all();
			expect(old).toHaveLength(2);
			expect(
				old.every(
					(row) =>
						(row as { settlement_reason: string }).settlement_reason ===
						"superseded_by_rework_replacement",
				),
			).toBe(true);
			expect(commDb.listRunnerPhaseWakes("old")[0]?.state).toBe("pending");
			store.upsertSession({
				execution_id: "replacement",
				issue_id: "FLY-2517",
				project_name: "flywheel",
				status: "running",
			});
			const later = new Date(Date.parse(NOW) + 21 * 60_000).toISOString();
			new DeliveryContractWatch({
				store,
				commDb,
				projectName: "flywheel",
				resolveAlertIdentity: () => ({
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				}),
			}).runPass(later);
			expect(store.getWorkflowRun("run")?.status).toBe("active");
			expect(store.getWorkflowReworkDelivery("request")?.state).toBe(
				"replacement_pending",
			);
		} finally {
			commDb.close();
		}
	});
});

describe("FLY-2517 final hold transaction guard", () => {
	it("closes a historical live obligation before checking liveness, without holding the run", async () => {
		const { store, replace, identity, db } = await fixture();
		const rootId = "flywheel:FLY-2517:phase_wake:historical";
		const attemptId = `${rootId}:g1:a1`;
		store.projectWorkflowDeliveryAttempt({
			rootId,
			attemptId,
			family: "phase_wake",
			mintedAt: NOW,
			contractRef: {
				table: "runner_phase_wakes",
				pk: "historical",
				runId: "run",
				projectName: "flywheel",
				issueId: "FLY-2517",
				reworkWake: identity,
			},
		});
		expect(replace()).toMatchObject({ ok: true });
		// Reconstruct the historical persisted obligation that predates the new transaction hook.
		db.prepare(
			"UPDATE workflow_delivery_attempt SET settlement_reason=NULL WHERE attempt_id=?",
		).run(attemptId);
		db.prepare(`INSERT INTO workflow_delivery_contract_episode
			(episode_id,family,root_id,attempt_id,run_id,stage,stage_entered_at,opened_at,escalation_uid)
			VALUES (?,'phase_wake',?,?,'run','undeliverable',?,?,?)`).run(
			"old-episode",
			rootId,
			attemptId,
			NOW,
			NOW,
			"old-alert",
		);
		const later = new Date(Date.parse(NOW) + 21 * 60_000).toISOString();
		expect(
			store.holdWorkflowUndeliverable({
				episodeId: "old-episode",
				recipientExecutionId: "old",
				now: later,
				commEvidence: {
					recentOutboundInWindow: false,
					observedAtMs: Date.parse(later),
				},
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
			}),
		).toEqual({ held: false, reason: "superseded_by_rework_replacement" });
		expect(store.getWorkflowRun("run")?.status).toBe("active");
		expect(
			db
				.prepare(
					"SELECT closed_at FROM workflow_delivery_contract_episode WHERE episode_id=?",
				)
				.get("old-episode"),
		).toEqual({ closed_at: later });
	});
});

describe("FLY-2517 bounded historical retirement backfill", () => {
	it("advances past a bad receipt, backfills held runs, and deduplicates diagnostics", async () => {
		const { store, replace, db } = await fixture();
		store.appendWorkflowRunEvent({
			runId: "run",
			eventUid: "broken-replacement",
			kind: "rework_replacement_materialized",
			nodeId: "implement",
			executionId: "old",
			payload: { requestId: "missing" },
		});
		expect(replace()).toMatchObject({ ok: true });
		db.prepare("DELETE FROM workflow_rework_wake_retirement").run();
		db.prepare(
			"UPDATE workflow_run SET status='held' WHERE run_id='run'",
		).run();
		const first = store.backfillReworkWakeRetirements({
			projectName: "flywheel",
			limit: 1,
			now: NOW,
		});
		expect(first).toMatchObject({ examined: 1, unproven: 1 });
		expect(first.nextCursor).toBeDefined();
		const second = store.backfillReworkWakeRetirements({
			projectName: "flywheel",
			limit: 1,
			now: NOW,
			after: first.nextCursor,
		});
		expect(second).toMatchObject({ examined: 1, retired: 1 });
		expect(second.nextCursor).toBeUndefined();
		expect(store.listPendingReworkWakeRetirements({ limit: 10 })).toHaveLength(
			1,
		);
		store.backfillReworkWakeRetirements({
			projectName: "flywheel",
			limit: 1,
			now: NOW,
		});
		expect(
			db
				.prepare(
					"SELECT COUNT(*) AS n FROM workflow_run_event WHERE kind='rework_wake_retirement_unproven'",
				)
				.get(),
		).toEqual({ n: 1 });
		expect(store.getWorkflowRun("run")?.status).toBe("held");
	});
});

describe("FLY-2517 malformed source isolation", () => {
	it("does not let malformed metadata starve a later exact old wake", async () => {
		const { store, replace, identity, db } = await fixture();
		const commDb = new CommDB(":memory:");
		try {
			commDb.registerSession(
				"old",
				"window",
				"flywheel",
				"FLY-2517",
				"flywheel-eng-lead",
			);
			commDb.enqueueRunnerPhaseWake(
				"old",
				{ id: "bad", to: "old", content: "bad", metadata: {} },
				Date.parse(NOW),
			);
			(commDb as unknown as { db: Database.Database }).db
				.prepare(
					"UPDATE runner_phase_wakes SET metadata_json=? WHERE message_id=?",
				)
				.run("{broken", "bad");
			const metadata = {
				kind: "workflow_rework",
				wakeId: identity.wakeId,
				activationId: identity.activationId,
				epoch: 9,
			};
			commDb.enqueueTurnWake({
				wakeId: identity.wakeId,
				executionId: "old",
				activationId: identity.activationId,
				epoch: 9,
				issueId: "FLY-2517",
				purpose: "workflow_rework",
				envelope: { fromAgent: "bridge", content: "wake", metadata },
				backend: "codex",
				createdAtMs: Date.parse(NOW),
			});
			commDb.enqueueRunnerPhaseWake(
				"old",
				{ id: "good", to: "old", content: "wake", metadata },
				Date.parse(NOW),
			);
			expect(replace()).toMatchObject({ ok: true });
			expect(() =>
				new DeliveryProjector({
					store,
					commDb,
					projectName: "flywheel",
				}).runPass(NOW),
			).not.toThrow();
			expect(
				db
					.prepare(
						"SELECT settlement_reason FROM workflow_delivery_attempt WHERE family='phase_wake' AND json_extract(contract_ref_json,'$.pk')='good'",
					)
					.get(),
			).toEqual({ settlement_reason: "superseded_by_rework_replacement" });
			expect(
				commDb
					.listRunnerPhaseWakes("old")
					.find((row) => row.message_id === "bad")?.retirement_id,
			).toBeNull();
		} finally {
			commDb.close();
		}
	});
});

describe("FLY-2517 immutable projected identity", () => {
	it("keeps the trusted identity when a later source refresh no longer has its parent", async () => {
		const { store, replace, identity, db } = await fixture();
		const projection = {
			rootId: "flywheel:FLY-2517:phase_wake:kept",
			attemptId: "kept",
			family: "phase_wake" as const,
			mintedAt: NOW,
		};
		store.projectWorkflowDeliveryAttempt({
			...projection,
			contractRef: {
				table: "runner_phase_wakes",
				pk: "kept",
				runId: "run",
				projectName: "flywheel",
				issueId: "FLY-2517",
				reworkWake: identity,
			},
		});
		store.projectWorkflowDeliveryAttempt({
			...projection,
			contractRef: { table: "runner_phase_wakes", pk: "kept" },
		});
		const row = db
			.prepare(
				"SELECT contract_ref_json FROM workflow_delivery_attempt WHERE attempt_id='kept'",
			)
			.get() as { contract_ref_json: string };
		expect(JSON.parse(row.contract_ref_json)).toMatchObject({
			reworkWake: identity,
			runId: "run",
		});
		expect(replace()).toMatchObject({ ok: true });
		expect(
			db
				.prepare(
					"SELECT settlement_reason FROM workflow_delivery_attempt WHERE attempt_id='kept'",
				)
				.get(),
		).toEqual({ settlement_reason: "superseded_by_rework_replacement" });
	});
});

describe("FLY-2517 rerouted child guard", () => {
	it("does not retire a child addressed to another actor using inherited parent metadata", async () => {
		const { store, replace, identity, db } = await fixture();
		const projection = {
			rootId: "flywheel:FLY-2517:phase_wake:child",
			attemptId: "child",
			family: "phase_wake" as const,
			mintedAt: NOW,
		};
		store.projectWorkflowDeliveryAttempt({
			...projection,
			contractRef: {
				table: "runner_phase_wakes",
				pk: "child",
				runId: "run",
				projectName: "flywheel",
				issueId: "FLY-2517",
				reworkWake: identity,
				targetExecutionId: "different-actor",
			},
		});
		expect(replace()).toMatchObject({ ok: true });
		store.projectWorkflowDeliveryAttempt({
			...projection,
			contractRef: { table: "runner_phase_wakes", pk: "child" },
		});
		const row = db
			.prepare(
				"SELECT settlement_reason,contract_ref_json FROM workflow_delivery_attempt WHERE attempt_id='child'",
			)
			.get() as { settlement_reason: string | null; contract_ref_json: string };
		expect(row.settlement_reason).toBeNull();
		expect(JSON.parse(row.contract_ref_json).targetExecutionId).toBe(
			"different-actor",
		);
	});
});

async function retiredHoldFixture() {
	const f = await fixture();
	const rootId = "flywheel:FLY-2517:phase_wake:held-old";
	const attemptId = rootId + ":g1:a1";
	f.store.projectWorkflowDeliveryAttempt({
		rootId,
		attemptId,
		family: "phase_wake",
		mintedAt: NOW,
		contractRef: {
			table: "runner_phase_wakes",
			pk: "held-old",
			runId: "run",
			projectName: "flywheel",
			issueId: "FLY-2517",
			reworkWake: f.identity,
		},
	});
	f.store.appendWorkflowRunEvent({
		runId: "run",
		eventUid: "historical-hold",
		kind: "delivery_reroute_operator_required",
		payload: {
			family: "phase_wake",
			rootId,
			attemptId,
			physicalId: "held-old",
			recipientExecutionId: "old",
			runHeld: true,
		},
	});
	expect(f.replace()).toMatchObject({ ok: true });
	f.db
		.prepare("UPDATE workflow_run SET status='held' WHERE run_id='run'")
		.run();
	return { ...f, rootId, attemptId };
}

describe("FLY-2517 exact retired hold capability", () => {
	it("offers cancel for the exact retired source even after its episode closes", async () => {
		const { store } = await retiredHoldFixture();
		expect(
			store.resolveRetiredWakeHoldCloseTx({
				runId: "run",
				holdEventUid: "historical-hold",
			}),
		).toMatchObject({
			kind: "proven",
			physicalId: "held-old",
			proof: { executionId: "old", replacementExecutionId: "replacement" },
		});
		expect(store.listWorkflowHolds("run")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					holdEventUid: "historical-hold",
					resumable: true,
					requiredDecision: ["reroute_to", "cancel"],
				}),
			]),
		);
	});
	it("uses exact immutable audit after pruning and rejects a different physical source", async () => {
		const { store, db, attemptId } = await retiredHoldFixture();
		db.prepare("DELETE FROM workflow_delivery_attempt WHERE attempt_id=?").run(
			attemptId,
		);
		expect(
			store.resolveRetiredWakeHoldCloseTx({
				runId: "run",
				holdEventUid: "historical-hold",
			}),
		).toMatchObject({ kind: "proven" });
		store.appendWorkflowRunEvent({
			runId: "run",
			eventUid: "wrong-hold",
			kind: "delivery_reroute_operator_required",
			payload: {
				family: "phase_wake",
				rootId: "flywheel:FLY-2517:phase_wake:held-old",
				attemptId,
				physicalId: "another",
				recipientExecutionId: "old",
				runHeld: true,
			},
		});
		expect(
			store.resolveRetiredWakeHoldCloseTx({
				runId: "run",
				holdEventUid: "wrong-hold",
			}).kind,
		).toBe("unproven");
		expect(
			store.resolveRetiredWakeHoldCloseTx({
				runId: "another-run",
				holdEventUid: "historical-hold",
			}).kind,
		).toBe("unproven");
	});
});

describe("FLY-2517 retired phase cancel", () => {
	it.each([false, true])(
		"closes only the proven hold with pruned source=%s",
		async (prune) => {
			const { store, db, attemptId } = await retiredHoldFixture();
			if (prune)
				db.prepare(
					"DELETE FROM workflow_delivery_attempt WHERE attempt_id=?",
				).run(attemptId);
			const normalized = StateStore.canonicalizeHoldResume({
				runId: "run",
				shape: "delivery_undeliverable_no_recipient",
				holdEventUid: "historical-hold",
				decision: "cancel",
				reason: "close retired wake",
				principal: "master",
				clientRequestId: "retired-cancel",
			})!;
			const request = {
				canonical: normalized.canonical,
				digest: normalized.digest,
				now: NOW,
			};
			const staged = store.resumeWorkflowHold(request);
			expect(staged).toMatchObject({ ok: true, state: "staged" });
			const commDb = new CommDB(":memory:");
			try {
				await new DeliveryOperations({
					store,
					commDb,
					projectName: "flywheel",
					resolveRecipient: () => null,
					resolveAlertIdentity: () => ({
						leadId: "flywheel-eng-lead",
						projectName: "flywheel",
						leadResolution: "resolved",
					}),
				}).runPass(NOW);
				expect(
					store.getWorkflowHoldResumeReceipt("retired-cancel")?.state,
				).toBe("projected");
				expect(store.getWorkflowRun("run")?.status).toBe("active");
				expect(store.listWorkflowHolds("run")).toHaveLength(0);
				expect(store.resumeWorkflowHold(request)).toMatchObject({
					ok: true,
					idempotentReplay: true,
					state: "projected",
				});
			} finally {
				commDb.close();
			}
		},
	);
});

async function completedReplacementHoldFixture(
	options: { launch?: boolean; completion?: boolean } = {},
) {
	const f = await retiredHoldFixture();
	f.store.upsertSession({
		execution_id: "replacement",
		issue_id: "FLY-2517",
		project_name: "flywheel",
		status: "completed",
	});
	f.db
		.prepare(`INSERT INTO workflow_execution_binding
  (activation_id,execution_id,run_id,node_id,attempt,mode,rework_request_id,bound_at)
  VALUES ('activation:replacement','replacement','run','implement',2,'replacement','request',?)`)
		.run(NOW);
	if (options.completion !== false) {
		f.store.appendWorkflowRunEvent({
			runId: "run",
			eventUid: "replacement-completed",
			kind: "node_completed",
			nodeId: "implement",
			executionId: "replacement",
			payload: { attempt: 2, route: "needs_review" },
		});
		f.db
			.prepare(`INSERT INTO workflow_node_completion
   (activation_id,run_id,node_id,attempt,execution_id,route,event_uid,source_event_id,completion_submission_digest,completed_at)
   VALUES ('activation:replacement','run','implement',2,'replacement','needs_review','replacement-completed','complete-source',?,?)`)
			.run("d".repeat(64), NOW);
	}
	if (options.launch !== false)
		f.store.appendWorkflowRunEvent({
			runId: "run",
			eventUid: "rework_replacement_launched:request:2:replacement",
			kind: "rework_replacement_launched",
			nodeId: "implement",
			executionId: "replacement",
			payload: {
				requestId: "request",
				routeRevision: 2,
				activationId: "activation:replacement",
				attempt: 2,
				carrier: "launch_envelope",
				contentDigest: "c".repeat(64),
			},
		});
	f.db
		.prepare(
			"UPDATE workflow_rework_delivery SET state='completed' WHERE request_id='request'",
		)
		.run();
	return f;
}
describe("FLY-2518 completed replacement proof", () => {
	it("connects distinct old and replacement activations by the exact completed request", async () => {
		const { store } = await completedReplacementHoldFixture();
		expect(
			store.resolveCompletedReworkWakeTargetTx({
				runId: "run",
				holdEventUid: "historical-hold",
				targetExecutionId: "replacement",
			}),
		).toMatchObject({
			kind: "noop",
			reason: "target_obligation_completed",
			targetActivationId: "activation:replacement",
			completionEventUid: "replacement-completed",
		});
		expect(
			store.resolveCompletedReworkWakeTargetTx({
				runId: "run",
				holdEventUid: "historical-hold",
				targetExecutionId: "old",
			}).kind,
		).toBe("unproven");
	});
	it.each([{ launch: false }, { completion: false }])(
		"rejects a terminal session without exact receipts %j",
		async (options) => {
			const { store } = await completedReplacementHoldFixture(options);
			expect(
				store.resolveCompletedReworkWakeTargetTx({
					runId: "run",
					holdEventUid: "historical-hold",
					targetExecutionId: "replacement",
				}).kind,
			).toBe("unproven");
		},
	);
});

describe("FLY-2518 completed target no-op", () => {
	it("projects a new reroute request without a child attempt, route revision, or transport wake", async () => {
		const { store, db } = await completedReplacementHoldFixture();
		const normalized = StateStore.canonicalizeHoldResume({
			runId: "run",
			shape: "delivery_undeliverable_no_recipient",
			holdEventUid: "historical-hold",
			decision: "reroute_to replacement",
			reason: "replacement already completed",
			principal: "master",
			clientRequestId: "completed-noop",
		})!;
		const request = {
			canonical: normalized.canonical,
			digest: normalized.digest,
			now: NOW,
		};
		const before = db
			.prepare("SELECT count(*) AS n FROM workflow_delivery_attempt")
			.get();
		expect(store.resumeWorkflowHold(request)).toMatchObject({
			ok: true,
			state: "staged",
		});
		const commDb = new CommDB(":memory:");
		try {
			const operations = new DeliveryOperations({
				store,
				commDb,
				projectName: "flywheel",
				resolveRecipient: () => null,
				resolveAlertIdentity: () => ({
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				}),
			});
			operations.runPass(NOW);
			operations.runPass(NOW);
			expect(store.getWorkflowHoldResumeReceipt("completed-noop")?.state).toBe(
				"projected",
			);
			expect(store.getWorkflowRun("run")?.status).toBe("active");
			expect(
				db.prepare("SELECT count(*) AS n FROM workflow_delivery_attempt").get(),
			).toEqual(before);
			expect(store.getLatestWorkflowReworkRoute("request")?.revision).toBe(2);
			expect(commDb.listRunnerPhaseWakes("replacement")).toHaveLength(0);
			expect(
				store
					.listWorkflowRunEvents("run")
					.filter((e) => e.kind === "delivery_reroute_noop"),
			).toHaveLength(1);
		} finally {
			commDb.close();
		}
	});
});

describe("FLY-2518 reroute staging no-op", () => {
	it("returns typed no-op even when retirement already closed the source episode", async () => {
		const { store } = await completedReplacementHoldFixture();
		expect(
			store.stageWorkflowDeliveryReroute({
				episodeId: "closed-old-episode",
				targetExecutionId: "replacement",
				now: NOW,
				allowOverCap: true,
				sourceHold: { runId: "run", holdEventUid: "historical-hold" },
			}),
		).toMatchObject({
			kind: "noop",
			reason: "target_obligation_completed",
			completionEventUid: "replacement-completed",
		});
	});
	it("recovers a previously staged operator request without asking for a new resume", async () => {
		const { store, db, attemptId, rootId } =
			await completedReplacementHoldFixture();
		db.prepare(`INSERT INTO workflow_delivery_operation
   (operation_id,kind,run_id,family,root_id,shape_id,hold_event_uid,source_attempt_id,target_activation_id,
    client_request_id,canonical_digest,state,created_at,updated_at)
   VALUES ('prior-manual','hold_resume','run','phase_wake',?,'delivery_undeliverable_no_recipient','historical-hold',?,'replacement',
    'prior-request','prior-digest','staged',?,?)`).run(
			rootId,
			attemptId,
			NOW,
			NOW,
		);
		const commDb = new CommDB(":memory:");
		try {
			new DeliveryOperations({
				store,
				commDb,
				projectName: "flywheel",
				resolveRecipient: () => null,
				resolveAlertIdentity: () => ({
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				}),
			}).runPass(NOW);
			expect(store.getWorkflowHoldResumeReceipt("prior-request")?.state).toBe(
				"projected",
			);
			expect(store.getWorkflowRun("run")?.status).toBe("active");
		} finally {
			commDb.close();
		}
	});
});

describe("FLY-2517 master HTTP hold recovery", () => {
	it.each(["cancel", "reroute_to replacement"])(
		"authenticates, stages and projects %s using the same capability",
		async (decision) => {
			const { store } = await completedReplacementHoldFixture();
			const app = express();
			app.use(express.json());
			app.use(
				"/api/runs",
				createRunsRouter(
					{ getInflightCount: () => 0 } as Parameters<
						typeof createRunsRouter
					>[0],
					store,
					[
						{
							projectName: "flywheel",
							leads: [{ agentId: "flywheel-eng-lead" }],
						},
					] as unknown as Parameters<typeof createRunsRouter>[2],
					{
						tryAdmit: () => ({
							admit: false,
							reason: "load",
							detail: "unused",
						}),
					} as Parameters<typeof createRunsRouter>[3],
					undefined,
					false,
					undefined,
					{
						masterToken: "test-master",
						scopedToken: "test-scoped",
						confirmTokens: new ConfirmTokenStore(),
					},
				),
			);
			const server = createServer(app);
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "127.0.0.1", resolve);
			});
			const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/runs/run`;
			const body = {
				runId: "run",
				shape: "delivery_undeliverable_no_recipient",
				holdEventUid: "historical-hold",
				decision,
				reason: "retired wake recovery",
				principal: "master",
				clientRequestId: "http-" + decision,
			};
			const post = (path: string, body: unknown, token = "test-master") =>
				fetch(base + path, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: "Bearer " + token,
					},
					body: JSON.stringify(body),
				});
			const commDb = new CommDB(":memory:");
			try {
				expect((await post("/resume/stage", body, "test-scoped")).status).toBe(
					401,
				);
				const staged = await post("/resume/stage", body);
				expect(staged.status).toBe(200);
				const prepared = (await staged.json()) as {
					canonical: unknown;
					confirmToken: string;
				};
				const request = {
					canonical: prepared.canonical,
					confirmToken: prepared.confirmToken,
				};
				const resumed = await post("/resume", request);
				expect(resumed.status).toBe(200);
				new DeliveryOperations({
					store,
					commDb,
					projectName: "flywheel",
					resolveRecipient: () => null,
					resolveAlertIdentity: () => ({
						leadId: "flywheel-eng-lead",
						projectName: "flywheel",
						leadResolution: "resolved",
					}),
				}).runPass(NOW);
				expect(store.getWorkflowRun("run")?.status).toBe("active");
				const replay = await post("/resume", request);
				expect(await replay.json()).toMatchObject({
					ok: true,
					idempotentReplay: true,
					state: "projected",
				});
			} finally {
				commDb.close();
				server.closeAllConnections();
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
		},
	);
});

describe("FLY-2517 hold recovery negative guards", () => {
	it("fails a staged completed-target request when its route changes before apply", async () => {
		const { store, db } = await completedReplacementHoldFixture();
		const normalized = StateStore.canonicalizeHoldResume({
			runId: "run",
			shape: "delivery_undeliverable_no_recipient",
			holdEventUid: "historical-hold",
			decision: "reroute_to replacement",
			reason: "complete",
			principal: "master",
			clientRequestId: "changed-route",
		})!;
		expect(
			store.resumeWorkflowHold({
				canonical: normalized.canonical,
				digest: normalized.digest,
				now: NOW,
			}),
		).toMatchObject({ ok: true, state: "staged" });
		db.prepare(`INSERT INTO workflow_rework_route_revision
   (request_id,revision,target_node_id,target_attempt,preferred_actor_execution_id,invalidation_scope_json,verification_policy_json,interpreted_by,interpretation_reason,created_at)
   SELECT request_id,3,target_node_id,target_attempt,preferred_actor_execution_id,invalidation_scope_json,verification_policy_json,'fixture','next route',created_at
   FROM workflow_rework_route_revision WHERE request_id='request' AND revision=2`).run();
		db.prepare(
			"UPDATE workflow_rework_delivery SET route_revision=3 WHERE request_id='request'",
		).run();
		expect(
			store.resolveCompletedReworkWakeTargetTx({
				runId: "run",
				holdEventUid: "historical-hold",
				targetExecutionId: "replacement",
			}).kind,
		).toBe("unproven");
		const commDb = new CommDB(":memory:");
		try {
			new DeliveryOperations({
				store,
				commDb,
				projectName: "flywheel",
				resolveRecipient: () => null,
				resolveAlertIdentity: () => ({
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				}),
			}).runPass(NOW);
			expect(store.getWorkflowHoldResumeReceipt("changed-route")?.state).toBe(
				"failed",
			);
			expect(store.getWorkflowRun("run")?.status).toBe("held");
			expect(
				store
					.listWorkflowRunEvents("run")
					.filter((e) => e.kind === "delivery_reroute_noop"),
			).toHaveLength(0);
		} finally {
			commDb.close();
		}
	});
	it.each(["held", "terminated"])(
		"does not clear a new hold or revive a terminal run (%s)",
		async (status) => {
			const { store, db } = await retiredHoldFixture();
			const normalized = StateStore.canonicalizeHoldResume({
				runId: "run",
				shape: "delivery_undeliverable_no_recipient",
				holdEventUid: "historical-hold",
				decision: "cancel",
				reason: "old wake",
				principal: "master",
				clientRequestId: "other-hold",
			})!;
			expect(
				store.resumeWorkflowHold({
					canonical: normalized.canonical,
					digest: normalized.digest,
					now: NOW,
				}),
			).toMatchObject({ ok: true, state: "staged" });
			if (status === "held")
				store.appendWorkflowRunEvent({
					runId: "run",
					eventUid: "other-hold",
					kind: "delivery_reroute_operator_required",
					payload: {
						family: "phase_wake",
						rootId: "other",
						attemptId: "other",
						physicalId: "other",
						recipientExecutionId: "other",
						runHeld: true,
					},
				});
			else
				db.prepare(
					"UPDATE workflow_run SET status='terminated' WHERE run_id='run'",
				).run();
			const commDb = new CommDB(":memory:");
			try {
				new DeliveryOperations({
					store,
					commDb,
					projectName: "flywheel",
					resolveRecipient: () => null,
					resolveAlertIdentity: () => ({
						leadId: "flywheel-eng-lead",
						projectName: "flywheel",
						leadResolution: "resolved",
					}),
				}).runPass(NOW);
				expect(store.getWorkflowRun("run")?.status).toBe(status);
				expect(
					store
						.listWorkflowRunEvents("run")
						.filter((e) => e.kind === "hold_resumed"),
				).toHaveLength(1);
			} finally {
				commDb.close();
			}
		},
	);
});

describe("FLY-2517 disk restart convergence", () => {
	it.each(["state-committed", "comm-applied", "projected"] as const)(
		"reopens both stores after %s without reactivating the old wake",
		async (boundary) => {
			const dir = mkdtempSync(join(tmpdir(), "fly2517-restart-"));
			let current: StateStore | undefined;
			let commDb: CommDB | undefined;
			try {
				const f = await fixture(join(dir, "state.db"));
				current = f.store;
				commDb = new CommDB(join(dir, "comm.db"));
				commDb.enqueueRunnerPhaseWake(
					"old",
					{
						id: "restart-old",
						to: "old",
						content: "old",
						metadata: { kind: "workflow_rework", ...f.identity },
					},
					Date.parse(NOW),
				);
				expect(f.replace()).toMatchObject({ ok: true });
				const retired = current.listPendingReworkWakeRetirements({
					limit: 1,
				})[0]!;
				if (boundary !== "state-committed")
					commDb.applyReworkWakeRetirement(retired, Date.parse(NOW));
				if (boundary === "projected")
					current.markReworkWakeRetirementProjected({
						retirementId: retired.retirementId,
						now: NOW,
					});
				stores.splice(stores.indexOf(current), 1);
				current.close();
				current = undefined;
				commDb.close();
				commDb = undefined;
				for (let restart = 0; restart < 2; restart++) {
					current = await StateStore.create(join(dir, "state.db"));
					commDb = new CommDB(join(dir, "comm.db"));
					const operations = new DeliveryOperations({
						store: current,
						commDb,
						projectName: "flywheel",
						resolveRecipient: () => null,
						resolveAlertIdentity: () => ({
							leadId: "flywheel-eng-lead",
							projectName: "flywheel",
							leadResolution: "resolved",
						}),
					});
					operations.runPass(NOW);
					operations.runPass(NOW);
					expect(
						current.listPendingReworkWakeRetirements({ limit: 10 }),
					).toHaveLength(0);
					expect(
						commDb.claimRunnerPhaseWakeStart(
							"old",
							"restart-old",
							Date.parse(NOW),
						),
					).toBe("disposed");
					expect(commDb.listRunnerPhaseWakes("old")[0]?.started_at).toBeNull();
					expect(current.getWorkflowRun("run")?.status).toBe("active");
					current.close();
					current = undefined;
					commDb.close();
					commDb = undefined;
				}
			} finally {
				current?.close();
				commDb?.close();
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});

describe("FLY-2517 legacy schema upgrade", () => {
	it("migrates old stores twice and backfills durable replacement evidence", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2517-migration-"));
		let current: StateStore | undefined;
		let commDb: CommDB | undefined;
		try {
			const f = await fixture(join(dir, "state.db"));
			current = f.store;
			commDb = new CommDB(join(dir, "comm.db"));
			commDb.enqueueRunnerPhaseWake(
				"old",
				{
					id: "legacy-old",
					to: "old",
					content: "wake",
					metadata: { kind: "workflow_rework", ...f.identity },
				},
				Date.parse(NOW),
			);
			expect(f.replace()).toMatchObject({ ok: true });
			f.db.prepare("DROP TABLE workflow_rework_wake_retirement").run();
			const commRaw = (commDb as unknown as { db: Database.Database }).db;
			commRaw.prepare("DROP TABLE runner_rework_wake_retirement").run();
			// The legacy poison view deliberately references an absent table; SQLite
			// validates all views on ALTER TABLE. Reopening restores this compatibility view.
			commRaw.prepare("DROP VIEW messages").run();
			commRaw.prepare("DROP VIEW lead_inbox").run();
			commRaw
				.prepare("ALTER TABLE runner_phase_wakes DROP COLUMN retirement_id")
				.run();
			stores.splice(stores.indexOf(current), 1);
			current.close();
			current = undefined;
			commDb.close();
			commDb = undefined;
			for (let reopen = 0; reopen < 2; reopen++) {
				current = await StateStore.create(join(dir, "state.db"));
				commDb = new CommDB(join(dir, "comm.db"));
				current.backfillReworkWakeRetirements({
					projectName: "flywheel",
					now: NOW,
					limit: 1,
				});
				new DeliveryOperations({
					store: current,
					commDb,
					projectName: "flywheel",
					resolveRecipient: () => null,
					resolveAlertIdentity: () => ({
						leadId: "flywheel-eng-lead",
						projectName: "flywheel",
						leadResolution: "resolved",
					}),
				}).runPass(NOW);
				expect(
					commDb.claimRunnerPhaseWakeStart(
						"old",
						"legacy-old",
						Date.parse(NOW),
					),
				).toBe("disposed");
				expect(
					rawDb(current)
						.prepare(
							"SELECT count(*) AS n FROM workflow_rework_wake_retirement",
						)
						.get(),
				).toEqual({ n: 1 });
				current.close();
				current = undefined;
				commDb.close();
				commDb = undefined;
			}
		} finally {
			current?.close();
			commDb?.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
