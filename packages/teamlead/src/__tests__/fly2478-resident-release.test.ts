import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";
import { buildWorkflowRunSnapshotV1 } from "../workflow-run-snapshot.js";
import { legacyEngineeringManifest, legacyLandEngineeringManifest } from "./fixtures/legacy-workflow-manifests.js";

const T0 = Date.parse("2026-09-11T00:00:00.000Z");
const VERDICT_AT = "2026-09-11T00:45:00.000Z";
const HEAD = "a".repeat(40);

const stores: StateStore[] = [];
const roots: string[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function rawDb(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}

async function verdictStore(secondLoopTarget = false, shipCarrier = false) {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const manifest = shipCarrier ? legacyEngineeringManifest() : legacyLandEngineeringManifest();
	if (secondLoopTarget) manifest.loops[1]!.to = "design";
	store.createWorkflowRun({
		runId: "run-1",
		issueId: "FLY-2478",
		projectName: "flywheel",
		claimsReadEnrolled: false,
		snapshotJson: JSON.stringify(
			buildWorkflowRunSnapshotV1({
				template: { id: "resident-release", revision: 1 },
				manifest,
			}),
		),
	});
	const admitted = store.admitWorkflowExecution({
		runId: "run-1",
		nodeId: "implement",
		executionId: "impl-1",
		attempt: 1,
		family: "review_verdict",
		expiresAt: "2026-09-11T03:00:00.000Z",
		absoluteDeadlineAt: "2026-09-11T04:00:00.000Z",
		now: new Date(T0).toISOString(),
	});
	if (!admitted.ok) throw new Error(admitted.reason);
	store.upsertSession({
		execution_id: "impl-1",
		issue_id: "FLY-2478",
		project_name: "flywheel",
		status: "ship_parked",
		adapter_type: "codex-tmux",
	});
	store.upsertWorkflowRunNode({
		runId: "run-1",
		nodeId: "implement",
		attempt: 1,
		state: "done",
		executionId: "impl-1",
	});
	store.upsertWorkflowRunNode({
		runId: "run-1",
		nodeId: "qa",
		attempt: 1,
		state: "running",
		executionId: "qa-1",
	});
	rawDb(store)
		.prepare(
			"UPDATE workflow_run SET engine_owned = 1, current_node_id = 'qa' WHERE run_id = 'run-1'",
		)
		.run();
	rawDb(store).prepare(`INSERT INTO workflow_node_pr_binding
		(run_id,node_id,attempt,pr_number,head_sha,target_repo_identity,probe_repo_slug,target_repo_path,worktree_binding_generation,receipt_id,bound_at)
		VALUES ('run-1','implement',1,1164,?,'__main__','xrliAnnie/flywheel','/tmp/flywheel','generation-1','receipt-1',?)`).run(HEAD,new Date(T0).toISOString());
	const entered = store.enterResidentHold({
		executionId: "impl-1",
		activationId: "activation:impl-1:run-1:implement:1",
		nodeId: "implement",
		boundarySeq: 1,
		nowMs: T0,
	});
	if (!entered.ok) throw new Error(entered.reason);
	openPark(store, shipCarrier ? "runner_ship_gate_wait" : "rework_reachable_wait");
	return store;
}

function verdict(store: StateStore, outcome: "qa_pass" | "qa_fail") {
	return store.commitWorkflowTransitionTx({
		nodeReuseEnabled: false,
		runId: "run-1",
		nodeId: "qa",
		attempt: 1,
		executionId: "qa-1",
		outcome,
		subjectDigest: HEAD,
		now: VERDICT_AT,
	});
}

function openPark(store: StateStore, reason = "rework_reachable_wait") {
	rawDb(store)
		.prepare(`INSERT OR REPLACE INTO workflow_engine_park_outbox
		(event_id, project_name, execution_id, run_id, node_id, attempt, activation_id, generation, event, reason, created_at)
		VALUES ('park-1','flywheel','impl-1','run-1','implement',1,'activation:impl-1:run-1:implement:1',1,'park_opened',?,?)`)
		.run(reason, new Date(T0).toISOString());
}

function stageExpiry(store: StateStore, now: string) {
	const ids = store.expireResidentHoldsTx(now);
	expect(ids).toHaveLength(1);
	const operationId = ids[0]!;
	expect(store.applyResidentExpiry({ operationId, now })).toMatchObject({
		ok: true,
	});
	expect(store.markResidentExpirySent({ operationId, now })).toMatchObject({
		ok: true,
	});
	return operationId;
}

describe("FLY-2478 resident release", () => {
	it("never releases the runner ship carrier parked at its ship gate", async () => {
		const store = await verdictStore(false, true);
		const hold = store.getResidentHold("impl-1");
		const session = store.getSession("impl-1");
		expect(verdict(store, "qa_pass")).toMatchObject({ok: true});
		expect(store.getResidentHold("impl-1")).toEqual(hold);
		const afterCap = "2026-09-11T04:00:00.000Z";
		expect(store.listResidentExpiryFastLaneProjects(afterCap)).toEqual([]);
		expect(store.expireResidentHoldsTx(afterCap)).toEqual([]);
		expect(store.listPendingResidentExpiryOperations()).toEqual([]);
		expect(store.getSession("impl-1")).toEqual(session);
	});
	it.each(["missing", "cleared", "wrong_activation"])("requires the latest matching open rework park (%s)", async (kind) => {
		const store = await verdictStore();
		if (kind === "missing") rawDb(store).prepare("DELETE FROM workflow_engine_park_outbox").run();
		if (kind === "cleared") rawDb(store).prepare("UPDATE workflow_engine_park_outbox SET event='park_cleared'").run();
		if (kind === "wrong_activation") rawDb(store).prepare("UPDATE workflow_engine_park_outbox SET activation_id='other'").run();
		const hold = store.getResidentHold("impl-1");
		expect(verdict(store, "qa_pass")).toMatchObject({ok:true});
		expect(store.getResidentHold("impl-1")).toEqual(hold);
	});
	it("does not shut down or settle an operation after the latest park becomes a ship gate wait", async () => {
		const store = await verdictStore();
		const now = "2026-09-11T03:00:01.000Z";
		const operationId = stageExpiry(store, now);
		openPark(store, "runner_ship_gate_wait");
		const before = store.getSession("impl-1");
		expect(store.listPendingResidentExpiryOperations()).toEqual([]);
		expect(store.projectResidentExpiry({operationId, now})).toMatchObject({ok:false, reason: "resident_expiry_ship_park"});
		expect(store.getSession("impl-1")).toEqual(before);
		expect(store.getResidentHold("impl-1")?.state).toBe("expired");
	});

	it("renews a newer resident boundary without invalidating an in-flight revision wake", async () => {
		const store = await verdictStore();
		const renewedAt = T0 + 60_000;
		const input = {
			executionId: "impl-1",
			activationId: "activation:impl-1:run-1:implement:1",
			nodeId: "implement",
			boundarySeq: 2,
			nowMs: renewedAt,
		};
		expect(store.enterResidentHold(input)).toEqual({
			ok: true,
			revision: 1,
			graceExpiresAt: "2026-09-11T03:01:00.000Z",
		});
		expect(store.getResidentHold("impl-1")).toMatchObject({
			boundary_seq: 2,
			release_cause: null,
			release_source: null,
		});
		expect(store.enterResidentHold({ ...input, boundarySeq: 1 })).toEqual({
			ok: false,
			reason: "stale_boundary",
		});
		expect(store.expireResidentHoldsTx("2026-09-11T03:00:01.000Z")).toEqual([]);
		expect(store.wakeResidentHold("impl-1", 1, renewedAt + 1)).toBe(true);
	});

	it("preserves a committed release across same-revision boundary renewal", async () => {
		const store = await verdictStore();
		openPark(store);
		expect(verdict(store, "qa_pass")).toMatchObject({ok: true});
		const before = store.getResidentHold("impl-1")!;
		expect(store.enterResidentHold({
			executionId: "impl-1", activationId: before.activation_id,
			nodeId: "implement", boundarySeq: 2,
			nowMs: Date.parse(VERDICT_AT) + 1,
		})).toEqual({ok: true, revision: 1, graceExpiresAt: before.grace_expires_at});
		expect(store.getResidentHold("impl-1")).toMatchObject({
			boundary_seq: 2, revision: 1, release_cause: before.release_cause,
			release_source: before.release_source, grace_expires_at: before.grace_expires_at,
			grace_started_at: before.grace_started_at,
		});
		expect(store.expireResidentHoldsTx(new Date(Date.parse(VERDICT_AT)+2).toISOString())).toHaveLength(1);
	});

	it.each(["enter", "completion"] as const)(
		"clears old release metadata when a woken actor parks through %s",
		async (route) => {
			const store = await verdictStore();
			rawDb(store)
				.prepare(
					"UPDATE workflow_resident_hold SET release_cause = 'verdict_pass', release_source = 'old-pass' WHERE execution_id = 'impl-1'",
				)
				.run();
			expect(store.wakeResidentHold("impl-1", 1, T0 + 1)).toBe(true);
			if (route === "enter") {
				expect(
					store.enterResidentHold({
						executionId: "impl-1",
						activationId: "activation:impl-1:run-1:implement:1",
						nodeId: "implement",
						boundarySeq: 2,
						nowMs: T0 + 2,
					}),
				).toMatchObject({ ok: true, revision: 2 });
			} else {
				const context = store.resolveCurrentWorkflowActivation("impl-1");
				expect(context.kind).toBe("current");
				const completion = store as unknown as {
					enterResidentHoldForCompletionTx(
						context: unknown,
						now: string,
					): boolean;
				};
				expect(
					completion.enterResidentHoldForCompletionTx(
						context,
						new Date(T0 + 2).toISOString(),
					),
				).toBe(true);
			}
			expect(store.getResidentHold("impl-1")).toMatchObject({
				state: "resident",
				revision: 2,
				release_cause: null,
				release_source: null,
			});
		},
	);
	it("bounds the fast lane to owning projects and fresh operations; old pending work stays available to maintenance", async () => {
		const store = await verdictStore();
		const now = "2026-09-11T03:00:01.000Z";
		expect(store.listResidentExpiryFastLaneProjects(now)).toEqual(["flywheel"]);
		const operationId = stageExpiry(store, now);
		expect(
			store.listResidentExpiryFastLaneProjects("2026-09-11T03:00:51.000Z"),
		).toEqual(["flywheel"]);
		expect(
			store.listResidentExpiryFastLaneProjects("2026-09-11T03:01:02.000Z"),
		).toEqual([]);
		expect(
			store.listPendingResidentExpiryOperations("2026-09-11T03:00:02.000Z"),
		).toEqual([]);
		expect(store.listPendingResidentExpiryOperations()).toEqual([
			expect.objectContaining({ operationId }),
		]);
		expect(store.getResidentHold("impl-1")?.state).toBe("expired");
	});
	it("counts only due resident and pending expired holds", async () => {
		const store = await verdictStore();
		expect(store.countDueResidentHolds("2026-09-11T02:59:59.000Z")).toBe(0);
		const now = "2026-09-11T03:00:01.000Z";
		expect(store.countDueResidentHolds(now)).toBe(1);
		const operationId = stageExpiry(store, now);
		expect(store.countDueResidentHolds(now)).toBe(1);
		expect(store.projectResidentExpiry({ operationId, now })).toMatchObject({
			ok: true,
		});
		expect(store.countDueResidentHolds(now)).toBe(0);
	});
	it.each(["pass", "timeout"] as const)(
		"projects %s into a terminal session and settles its rework park",
		async (cause) => {
			const store = await verdictStore();
			openPark(store);
			if (cause === "pass")
				expect(verdict(store, "qa_pass")).toMatchObject({ ok: true });
			const now =
				cause === "pass"
					? "2026-09-11T00:45:01.000Z"
					: "2026-09-11T03:00:01.000Z";
			const revision = store.getSession("impl-1")!.lifecycle_revision;
			const operationId = stageExpiry(store, now);
			expect(store.projectResidentExpiry({ operationId, now })).toMatchObject({
				ok: true,
			});
			expect(store.getResidentHold("impl-1")).toMatchObject({
				state: "closed",
				closed_reason: cause === "pass" ? "released" : "expired",
			});
			expect(store.getSession("impl-1")).toMatchObject({
				status: "completed",
				terminal_at: expect.any(String),
				lifecycle_revision: revision + 1,
			});
			expect(
				rawDb(store)
					.prepare(
						"SELECT event FROM workflow_engine_park_outbox WHERE event_id = 'engine-park-settle:impl-1:1'",
					)
					.get(),
			).toEqual({ event: "park_cleared" });
			const event = rawDb(store)
				.prepare(
					"SELECT kind, payload FROM workflow_run_event WHERE event_uid = ?",
				)
				.get(operationId) as { kind: string; payload: string };
			expect(event.kind).toBe(
				cause === "pass" ? "resident_hold_released" : "resident_hold_expired",
			);
			expect(JSON.parse(event.payload)).toMatchObject({
				sessionSettled: true,
				parkSettled: true,
				cause: cause === "pass" ? "verdict_pass" : "grace_timeout",
			});
			expect(store.projectResidentExpiry({ operationId, now })).toMatchObject({
				ok: true,
				idempotentReplay: true,
			});
		},
	);
	it("requests release at the committed pass verdict and replays once", async () => {
		const store = await verdictStore();
		expect(verdict(store, "qa_pass")).toMatchObject({ ok: true });
		expect(store.getResidentHold("impl-1")).toMatchObject({
			state: "resident",
			grace_expires_at: VERDICT_AT,
			release_cause: "verdict_pass",
			release_source: expect.stringMatching(/^workflow_transition:/),
		});
		expect(verdict(store, "qa_pass")).toMatchObject({
			ok: true,
			idempotentReplay: true,
		});
		expect(
			rawDb(store)
				.prepare(
					"SELECT * FROM workflow_run_event WHERE kind = 'resident_hold_release_requested'",
				)
				.all(),
		).toHaveLength(1);
	});

	it.each(["activation", "failed"] as const)(
		"preserves unrelated %s state while closing an expired hold",
		async (guard) => {
			const store = await verdictStore();
			openPark(store);
			const now = "2026-09-11T03:00:01.000Z";
			const operationId = stageExpiry(store, now);
			if (guard === "activation")
				rawDb(store)
					.prepare(
						"UPDATE workflow_delivery_operation SET target_activation_id = 'other-activation' WHERE operation_id = ?",
					)
					.run(operationId);
			if (guard === "failed")
				store.upsertSession({
					execution_id: "impl-1",
					issue_id: "FLY-2478",
					project_name: "flywheel",
					status: "failed",
				});
			const before = store.getSession("impl-1");
			expect(store.projectResidentExpiry({ operationId, now })).toMatchObject({
				ok: true,
			});
			expect(store.getResidentHold("impl-1")?.state).toBe("closed");
			expect(store.getSession("impl-1")).toEqual(before);
			expect(
				rawDb(store)
					.prepare("SELECT event FROM workflow_engine_park_outbox")
					.all(),
			).toEqual([{ event: "park_opened" }]);
			const event = rawDb(store)
				.prepare("SELECT payload FROM workflow_run_event WHERE event_uid = ?")
				.get(operationId) as { payload: string };
			expect(JSON.parse(event.payload)).toMatchObject({
				sessionSettled: false,
				parkSettled: false,
			});
		},
	);

	it("rolls hold and session settlement back if park publication fails", async () => {
		const store = await verdictStore();
		openPark(store);
		const now = "2026-09-11T03:00:01.000Z";
		const operationId = stageExpiry(store, now);
		const before = store.getSession("impl-1");
		rawDb(
			store,
		).exec(`CREATE TRIGGER reject_park_clear BEFORE INSERT ON workflow_engine_park_outbox
			WHEN NEW.event = 'park_cleared' BEGIN SELECT RAISE(ABORT, 'injected park failure'); END;`);
		expect(() => store.projectResidentExpiry({ operationId, now })).toThrow(
			"injected park failure",
		);
		expect(store.getResidentHold("impl-1")?.state).toBe("expired");
		expect(store.getSession("impl-1")).toEqual(before);
		expect(
			rawDb(store)
				.prepare(
					"SELECT state FROM workflow_delivery_operation WHERE operation_id = ?",
				)
				.get(operationId),
		).toEqual({ state: "sent" });
	});

	it("settles again at run closeout without duplicate park clears or divergence alerts", async () => {
		const store = await verdictStore();
		openPark(store);
		const now = "2026-09-11T03:00:01.000Z";
		const operationId = stageExpiry(store, now);
		expect(store.projectResidentExpiry({ operationId, now })).toMatchObject({
			ok: true,
		});
		expect(
			store
				.listWorkflowDivergenceCandidates()
				.some((candidate) => candidate.executionId === "impl-1"),
		).toBe(true);
		expect(
			store.commitWorkflowDivergenceObservation({
				runId: "run-1",
				nodeId: "implement",
				attempt: 1,
				executionId: "impl-1",
				observedStatus: "completed",
				observedLifecycleRevision:
					store.getSession("impl-1")!.lifecycle_revision,
				now,
			}),
		).toMatchObject({ ok: true, divergence: false });
		expect(
			rawDb(store)
				.prepare(
					"SELECT * FROM workflow_run_event WHERE kind = 'workflow_node_session_divergence'",
				)
				.all(),
		).toHaveLength(0);
		const settlement = store as unknown as {
			settleWorkflowEngineParksForRunTx(
				runId: string,
				at: string,
				reasons: string[],
			): void;
		};
		expect(() =>
			settlement.settleWorkflowEngineParksForRunTx("run-1", now, [
				"rework_reachable_wait",
			]),
		).not.toThrow();
		expect(
			rawDb(store)
				.prepare(
					"SELECT * FROM workflow_engine_park_outbox WHERE event = 'park_cleared'",
				)
				.all(),
		).toHaveLength(1);
	});

	it("keeps the original resident actor available for a fail verdict", async () => {
		const store = await verdictStore();
		const before = store.getResidentHold("impl-1");
		const result = verdict(store, "qa_fail");
		expect(result).toMatchObject({
			ok: true,
			reworkRequestId: expect.any(String),
		});
		if (!result.ok || !result.reworkRequestId)
			throw new Error("missing rework request");
		expect(
			store.getLatestWorkflowReworkRoute(result.reworkRequestId),
		).toMatchObject({ preferred_actor_execution_id: "impl-1" });
		expect(store.getResidentHold("impl-1")).toEqual(before);
	});

	it("does not release a woken actor when a pass arrives", async () => {
		const store = await verdictStore();
		expect(store.wakeResidentHold("impl-1", 1, T0 + 1)).toBe(true);
		const before = store.getResidentHold("impl-1");
		expect(verdict(store, "qa_pass")).toMatchObject({ ok: true });
		expect(store.getResidentHold("impl-1")).toEqual(before);
	});

	it.each(["expired", "closed"])(
		"does not rewrite a %s hold on pass",
		async (state) => {
			const store = await verdictStore();
			rawDb(store)
				.prepare(
					"UPDATE workflow_resident_hold SET state = ? WHERE execution_id = 'impl-1'",
				)
				.run(state);
			const before = store.getResidentHold("impl-1");
			expect(verdict(store, "qa_pass")).toMatchObject({ ok: true });
			expect(store.getResidentHold("impl-1")).toEqual(before);
		},
	);

	it("does not release for a stale verdict writer or attempt", async () => {
		const store = await verdictStore();
		const before = store.getResidentHold("impl-1");
		for (const [attempt, executionId] of [
			[1, "stale-qa"],
			[2, "qa-1"],
		] as const) {
			expect(
				store.commitWorkflowTransitionTx({
					nodeReuseEnabled: false,
					runId: "run-1",
					nodeId: "qa",
					attempt,
					executionId,
					outcome: "qa_pass",
					subjectDigest: HEAD,
					now: VERDICT_AT,
				}),
			).toMatchObject({ ok: false, reason: "node_attempt_not_current" });
			expect(store.getResidentHold("impl-1")).toEqual(before);
		}
	});

	it("does not interpret founder kickback as a release verdict", async () => {
		const store = await verdictStore();
		store.upsertWorkflowRunNode({
			runId: "run-1",
			nodeId: "founder_gate",
			attempt: 1,
			state: "running",
			executionId: "qa-1",
		});
		rawDb(store)
			.prepare(
				"UPDATE workflow_run SET current_node_id = 'founder_gate' WHERE run_id = 'run-1'",
			)
			.run();
		const before = store.getResidentHold("impl-1");
		expect(
			store.commitWorkflowTransitionTx({
				nodeReuseEnabled: false,
				runId: "run-1",
				nodeId: "founder_gate",
				attempt: 1,
				executionId: "qa-1",
				outcome: "founder_feedback_kickback",
				subjectDigest: HEAD,
				founderFeedback: "Please revise",
				now: VERDICT_AT,
			}),
		).toMatchObject({ ok: true });
		expect(store.getResidentHold("impl-1")).toEqual(before);
	});

	it("releases only the verdict loop target and leaves other resident nodes unchanged", async () => {
		const store = await verdictStore(true);
		const admitted = store.admitWorkflowExecution({
			runId: "run-1",
			nodeId: "design",
			executionId: "design-1",
			attempt: 1,
			family: "review_verdict",
			expiresAt: "2026-09-11T03:00:00.000Z",
			absoluteDeadlineAt: "2026-09-11T04:00:00.000Z",
			now: new Date(T0).toISOString(),
		});
		if (!admitted.ok) throw new Error(admitted.reason);
		store.upsertSession({
			execution_id: "design-1",
			issue_id: "FLY-2478",
			project_name: "flywheel",
			status: "ship_parked",
			adapter_type: "codex-tmux",
		});
		expect(
			store.enterResidentHold({
				executionId: "design-1",
				activationId: "activation:design-1:run-1:design:1",
				nodeId: "design",
				boundarySeq: 1,
				nowMs: T0,
			}),
		).toMatchObject({ ok: true });
		const before = store.getResidentHold("design-1");
		expect(verdict(store, "qa_pass")).toMatchObject({ ok: true });
		expect(store.getResidentHold("design-1")).toEqual(before);
		expect(store.getResidentHold("impl-1")?.release_cause).toBe("verdict_pass");
	});

	it("rolls the release request back with a failed transition transaction", async () => {
		const store = await verdictStore();
		rawDb(
			store,
		).exec(`CREATE TRIGGER reject_release_event BEFORE INSERT ON workflow_run_event
			WHEN NEW.kind = 'resident_hold_release_requested' BEGIN SELECT RAISE(ABORT, 'injected release failure'); END;`);
		const before = store.getResidentHold("impl-1");
		expect(() => verdict(store, "qa_pass")).toThrow("injected release failure");
		expect(store.getResidentHold("impl-1")).toEqual(before);
		expect(store.getWorkflowRunNode("run-1", "qa", 1)?.state).toBe("running");
	});

	it("migrates legacy holds without changing their state and survives reopening", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2478-migration-"));
		roots.push(root);
		const path = join(root, "state.db");
		const legacy = new Database(path);
		legacy.exec(`CREATE TABLE workflow_resident_hold (
			execution_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL,
			attempt INTEGER NOT NULL CHECK (attempt > 0), activation_id TEXT NOT NULL,
			vendor TEXT NOT NULL CHECK (vendor IN ('claude','codex')),
			revision INTEGER NOT NULL CHECK (revision > 0), boundary_seq INTEGER NOT NULL CHECK (boundary_seq > 0),
			state TEXT NOT NULL CHECK (state IN ('resident','woken','expired','closed')),
			grace_started_at TEXT NOT NULL, grace_expires_at TEXT NOT NULL,
			closed_reason TEXT, updated_at TEXT NOT NULL);
			INSERT INTO workflow_resident_hold VALUES ('old-exec','old-run','repair',1,'old-activation','codex',1,1,
			'resident','2026-09-11T00:00:00.000Z','2026-09-11T00:30:00.000Z',NULL,'2026-09-11T00:00:00.000Z');`);
		legacy.close();
		for (let reopen = 0; reopen < 2; reopen++) {
			const store = await StateStore.create(path);
			try {
				expect(
					rawDb(store).prepare("SELECT * FROM workflow_resident_hold").get(),
				).toMatchObject({
					execution_id: "old-exec",
					state: "resident",
					revision: 1,
					grace_expires_at: "2026-09-11T00:30:00.000Z",
					release_cause: null,
					release_source: null,
				});
			} finally {
				store.close();
			}
		}
	});
});
