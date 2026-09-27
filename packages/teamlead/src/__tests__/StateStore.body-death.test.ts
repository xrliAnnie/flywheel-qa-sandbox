import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import type { BodyObservation } from "flywheel-claude-runner";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createExecutionBodyObserver } from "../bridge/execution-body-liveness.js";
import { StateStore } from "../StateStore.js";

describe("FLY-2919 atomic proven body death", () => {
	let root: string;
	let store: StateStore;
	let db: Database;
	let observation: BodyObservation;
	let clock: number;
	let enabled: boolean;
	let recovering: boolean;
	let observer: ReturnType<typeof createExecutionBodyObserver>;
	const owner = {
		executionId: "exec-1",
		activationId: "activation-1",
		generation: 1,
		ownerToken: "owner-1",
	};
	const binding = {
		version: 1 as const,
		adapter: "codex-tmux" as const,
		pid: 200,
		pgid: 200,
		startIdentity: "worker-start",
		hostBootId: "boot",
		executable: "/bin/codex",
		cwd: "/work",
		nonce: "nonce",
		nativeSessionId: null,
		writers: [],
	};
	const raw = () => (store as unknown as { db: { raw: Database } }).db.raw;
	const deathEvents = () =>
		store.listWorkflowRunEvents("run-1").filter((e) => e.kind === "body_death");
	const commit = () =>
		store.convergeProvenDeadExecution({
			observation,
			expectedCommIdentityRevision: "comm-revision-1",
			observedTurnEpoch: 4,
			isCurrent: observer.isCurrent,
			markerDir: root,
			nowMs: clock,
		});
	async function refresh() {
		observation = (await observer.observe("exec-1"))!;
		expect(observation.verdict).toBe("dead");
	}
	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "fly2919-body-death-"));
		store = await StateStore.create(join(root, "state.db"));
		db = raw();
		clock = 1000;
		enabled = true;
		recovering = false;
		store.createWorkflowRun({
			runId: "run-1",
			issueId: "FLY-2919",
			projectName: "fixture",
			claimsReadEnrolled: true,
		});
		store.upsertWorkflowRunNode({
			runId: "run-1",
			nodeId: "implement",
			attempt: 1,
			state: "running",
			executionId: "exec-1",
		});
		db.prepare(
			"INSERT INTO workflow_actor VALUES ('exec-1','fixture','FLY-2919','implement','1970-01-01T00:00:00Z')",
		).run();
		db.prepare(
			"INSERT INTO workflow_execution_binding VALUES ('activation-1','exec-1','run-1','implement',1,'spawn',NULL,'1970-01-01T00:00:00Z')",
		).run();
		db.prepare(
			"INSERT INTO workflow_execution_runtime VALUES ('exec-1','run-1','implement',1,'codex','codex','high','implement','digest','1970-01-01T00:00:00Z')",
		).run();
		db.prepare(
			"INSERT INTO workflow_execution_process_body (execution_id,generation,state,started_at,updated_at) VALUES ('exec-1',1,'active','1970-01-01T00:00:00Z','1970-01-01T00:00:00Z')",
		).run();
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "FLY-2919",
			project_name: "fixture",
			adapter_type: "codex-tmux",
			status: "running",
		});
		const lifecycleRevision = store.getLifecycleRevision("exec-1");
		expect(
			store.executionProcessOwners.claim({
				...owner,
				lifecycleRevision,
				nowMs: clock,
				controller: {
					pid: 100,
					startIdentity: "controller-start",
					hostBootId: "boot",
				},
			}),
		).toMatchObject({ ok: true });
		const spawn = store.executionProcessOwners.beginSpawn({
			...owner,
			lifecycleRevision,
			spawnEpoch: 0,
			nowMs: clock,
		});
		if (!spawn.ok) throw new Error(spawn.reason);
		expect(
			store.executionProcessOwners.acceptSpawn({
				...spawn.permit,
				lifecycleRevision,
				nowMs: clock,
				binding,
			}),
		).toMatchObject({ ok: true });
		observer = createExecutionBodyObserver(store, {
			isEnabled: () => enabled,
			isRecoveryActive: () => recovering,
			now: () => clock,
			sample: async () => ({
				sampledAtMs: clock,
				hostBootId: "boot",
				processes: [],
				worker: null,
				daemon: "absent",
				writersComplete: true,
				viewers: [],
			}),
		});
		await refresh();
	});
	afterEach(() => {
		store.close();
		rmSync(root, { recursive: true, force: true });
	});
	it.each(["running", "ship_parked", "awaiting_review"])(
		"closes dead %s without a window precondition and persists one obligation",
		async (status) => {
			store.upsertSession({
				execution_id: "exec-1",
				issue_id: "FLY-2919",
				project_name: "fixture",
				status,
			});
			await refresh();
			expect(commit()).toMatchObject({
				ok: true,
				idempotentReplay: false,
				obligation: {
					obligationId: "body_death:exec-1:1",
					terminalStatus: "failed",
					expectedCommIdentityRevision: "comm-revision-1",
					observedTurnEpoch: 4,
				},
			});
			expect(store.getSession("exec-1")?.status).toBe("failed");
			expect(store.executionProcessOwners.get("exec-1")).toMatchObject({
				close_requested: 1,
				owner_drained_receipt: expect.any(String),
			});
			expect(
				store.executionProcessOwners.authorizeSpawn(
					{ ...owner, spawnEpoch: 1 },
					store.getLifecycleRevision("exec-1"),
				),
			).toBe(false);
			expect(deathEvents()).toHaveLength(1);
		},
	);
	it("refuses a marker arriving after sampling without changing owner or status", () => {
		writeFileSync(join(root, "exec-1.json"), '{"pending":"completion"}');
		expect(commit()).toMatchObject({
			ok: false,
			reason: "completion_marker_pending",
		});
		expect(store.getSession("exec-1")?.status).toBe("running");
		expect(store.executionProcessOwners.get("exec-1")?.close_requested).toBe(0);
		expect(deathEvents()).toHaveLength(0);
	});
	it.each(["completed", "blocked", "failed"])(
		"preserves irreversible %s",
		async (status) => {
			store.upsertSession({
				execution_id: "exec-1",
				issue_id: "FLY-2919",
				project_name: "fixture",
				status,
			});
			await refresh();
			expect(commit()).toMatchObject({
				ok: true,
				obligation: {
					terminalStatus: status,
					disposition: "terminal_preserved",
				},
			});
		},
	);
	it("preserves an accepted completion instead of inventing failure", () => {
		db.prepare(
			"INSERT INTO workflow_node_completion VALUES ('activation-1','run-1','implement',1,'exec-1','needs_review','completion-1','source-1','digest','1970-01-01T00:00:00Z')",
		).run();
		expect(commit()).toMatchObject({
			ok: true,
			obligation: {
				terminalStatus: "completed",
				disposition: "completion_preserved",
				completionEventId: "completion-1",
			},
		});
		expect(
			store.getWorkflowNodeCompletion("run-1", "implement", 1)?.event_uid,
		).toBe("completion-1");
	});
	it.each(["retiring", "standby"])(
		"preserves approved %s and its node",
		(state) => {
			db.prepare(
				"UPDATE workflow_execution_process_body SET state=?, retirement_requested_at='1970-01-01T00:00:00Z' WHERE execution_id='exec-1'",
			).run(state);
			expect(commit()).toMatchObject({
				ok: true,
				obligation: { terminalStatus: "completed", disposition: "standby" },
			});
			expect(store.getWorkflowExecutionProcessBody("exec-1")?.state).toBe(
				"standby",
			);
			expect(store.getWorkflowRunNode("run-1", "implement", 1)?.state).toBe(
				"running",
			);
		},
	);
	it("keeps completed retirement resumable after physical death", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "FLY-2919",
			project_name: "fixture",
			status: "completed",
		});
		db.prepare(
			"UPDATE workflow_execution_process_body SET state='retiring', retirement_requested_at='1970-01-01T00:00:00Z' WHERE execution_id='exec-1'",
		).run();
		await refresh();
		expect(commit()).toMatchObject({
			ok: true,
			obligation: { terminalStatus: "completed", disposition: "standby" },
		});
		expect(store.getWorkflowExecutionProcessBody("exec-1")?.state).toBe(
			"standby",
		);
		expect(store.getLifecycleRevision("exec-1")).toBe(
			observation.identity.lifecycleRevision,
		);
	});
	it.each([
		"flag",
		"recovery",
		"revision",
		"generation",
		"spawn",
		"binding",
		"expiry",
		"alive",
	])("rejects changed %s before mutation", (change) => {
		if (change === "flag") enabled = false;
		if (change === "recovery") recovering = true;
		if (change === "revision")
			store.upsertSession({
				execution_id: "exec-1",
				issue_id: "FLY-2919",
				project_name: "fixture",
				status: "awaiting_review",
			});
		if (change === "generation")
			db.prepare(
				"UPDATE workflow_execution_process_body SET generation=2",
			).run();
		if (change === "spawn")
			db.prepare("UPDATE execution_process_owner SET spawn_inflight=1").run();
		if (change === "binding")
			db.prepare(
				"UPDATE execution_process_owner SET binding_digest='changed'",
			).run();
		if (change === "expiry") clock += 10000;
		if (change === "alive") observation = { ...observation, verdict: "alive" };
		expect(commit().ok).toBe(false);
		expect(deathEvents()).toHaveLength(0);
		expect(store.executionProcessOwners.get("exec-1")?.close_requested).toBe(0);
	});
	it("refuses lease contention without spending a recovery attempt and allows retry", () => {
		const claim = store.claimExecutionMutationLease(
			"exec-1",
			observation.identity.lifecycleRevision,
			{ holder: "other", nowMs: clock, ttlMs: 5000 },
		);
		if (!claim.ok) throw new Error(claim.reason);
		expect(commit()).toMatchObject({ ok: false, reason: "lease_held" });
		store.commitExecutionMutationLease(
			"exec-1",
			claim.claimToken,
			observation.identity.lifecycleRevision,
			clock,
		);
		expect(commit().ok).toBe(true);
	});
	it("replays after restart and evidence expiry even with the switch off", async () => {
		const first = commit();
		expect(first.ok).toBe(true);
		store.close();
		store = await StateStore.create(join(root, "state.db"));
		clock += 60000;
		enabled = false;
		expect(commit()).toEqual({ ...first, idempotentReplay: true });
		expect(deathEvents()).toHaveLength(1);
	});
	it("refuses a replay whose captured CommDB identity changed", () => {
		expect(commit().ok).toBe(true);
		expect(
			store.convergeProvenDeadExecution({
				observation,
				expectedCommIdentityRevision: "comm-new",
				observedTurnEpoch: 4,
				isCurrent: observer.isCurrent,
				markerDir: root,
				nowMs: clock,
			}),
		).toMatchObject({ ok: false, reason: "body_death_receipt_conflict" });
		expect(deathEvents()).toHaveLength(1);
	});
	it("rejects a newer logical activation on the same physical generation", () => {
		db.prepare(
			"INSERT INTO workflow_execution_binding VALUES ('activation-2','exec-1','run-1','implement',2,'wake',NULL,'1970-01-01T00:00:01Z')",
		).run();
		expect(commit()).toMatchObject({
			ok: false,
			reason: "body_death_activation_changed",
		});
		expect(store.getSession("exec-1")?.status).toBe("running");
	});
	it("replay returns the original duty without closing a later physical owner", () => {
		const original = commit();
		expect(original.ok).toBe(true);
		db.prepare(
			"UPDATE execution_process_owner SET owner_token='owner-2',generation=2,close_requested=0,owner_drained_at=NULL,owner_drained_receipt=NULL",
		).run();
		expect(commit()).toEqual({ ...original, idempotentReplay: true });
		expect(store.executionProcessOwners.get("exec-1")).toMatchObject({
			owner_token: "owner-2",
			close_requested: 0,
		});
	});
	it("rolls back status and owner closure if durable obligation insertion fails", () => {
		db.exec(
			"CREATE TRIGGER fail_death BEFORE INSERT ON workflow_run_event WHEN NEW.kind='body_death' BEGIN SELECT RAISE(ABORT,'injected write failure'); END",
		);
		expect(() => commit()).toThrow("injected write failure");
		expect(store.getSession("exec-1")?.status).toBe("running");
		expect(store.executionProcessOwners.get("exec-1")?.close_requested).toBe(0);
		db.exec("DROP TRIGGER fail_death");
		expect(commit().ok).toBe(true);
	});
	it("FLY-2919 cleanup inventory survives restart, uses current generation, and skips its receipt", async () => {
		await refresh();
		const result = commit();
		if (!result.ok) throw new Error(result.reason);
		expect(store.listExecutionBodyCleanupCandidates({ limit: 2 })).toEqual([]);
		store.markExecutionBodyDeathProjected(
			result.obligation,
			new Date(clock).toISOString(),
		);
		store.close();
		store = await StateStore.create(join(root, "state.db"));
		expect(store.listExecutionBodyCleanupCandidates({ limit: 2 })).toEqual([
			"exec-1",
		]);
		expect(
			store.listExecutionBodyCleanupCandidates({ limit: 2, afterId: "exec-1" }),
		).toEqual([]);
		store.insertEvent({
			event_id: `${result.obligation.obligationId}:ui-cleaned`,
			execution_id: "exec-1",
			issue_id: "FLY-2919",
			project_name: "fixture",
			event_type: "runner_crash_reaped",
			source: "bridge.crash-reaper",
			payload: { obligationId: result.obligation.obligationId },
		});
		expect(store.listExecutionBodyCleanupCandidates({ limit: 2 })).toEqual([]);
		expect(() =>
			store.listExecutionBodyCleanupCandidates({ limit: 0 }),
		).toThrow();
	});

	it("FLY-2919 delivery repair requires settled death and a current final authorization", () => {
		db.prepare(`INSERT INTO workflow_launch_owner
		 (execution_id, owner_generation, owner_id, acquired_at, lease_expires_at, committed_generation, delivery_state)
		 VALUES ('exec-1',1,'dispatcher','1970-01-01T00:00:00Z','1970-01-01T00:00:01Z',1,'delivered')`).run();
		const repair = (isBodyDeathCurrent?: () => boolean) =>
			store.claimWorkflowLaunchDeliveryRepair({
				executionId: "exec-1",
				repairOwner: "repair-a",
				now: "1970-01-01T00:00:02Z",
				leaseExpiresAt: "1970-01-01T00:00:10Z",
				isBodyDeathCurrent,
			});
		expect(repair(() => true)).toEqual({
			status: "hold",
			reason: "body_death_not_current",
		});
		const result = commit();
		if (!result.ok) throw new Error(result.reason);
		expect(repair(() => true)).toEqual({
			status: "hold",
			reason: "body_death_not_current",
		});
		expect(
			store.markExecutionBodyDeathProjected(
				result.obligation,
				new Date(clock).toISOString(),
			),
		).toBe(true);
		expect(repair()).toEqual({
			status: "hold",
			reason: "body_death_not_current",
		});
		expect(repair(() => false)).toEqual({
			status: "hold",
			reason: "body_death_not_current",
		});
		expect(
			repair(() => {
				throw new Error("flag read failed");
			}),
		).toEqual({ status: "hold", reason: "body_death_not_current" });
		expect(store.getWorkflowLaunchOwner("exec-1")?.delivery_attempt).toBe(0);
		expect(repair(() => true)).toMatchObject({ status: "claimed", attempt: 1 });
		// A new physical generation invalidates the settled old-generation duty.
		db.prepare(
			"UPDATE workflow_execution_process_body SET generation = 2 WHERE execution_id = 'exec-1'",
		).run();
		expect(repair(() => true)).toEqual({
			status: "hold",
			reason: "body_death_not_current",
		});
	});

	it("lists a durable unprojected death after restart and marks only its exact duty", async () => {
		const result = commit();
		if (!result.ok) throw new Error(result.reason);
		store.close();
		store = await StateStore.create(join(root, "state.db"));
		expect(
			store.getExecutionBodyDeathObligation(result.obligation.obligationId),
		).toEqual(result.obligation);
		expect(store.listPendingExecutionBodyDeaths({ limit: 1 })).toEqual([
			result.obligation,
		]);
		expect(
			store.markExecutionBodyDeathProjected(
				{ ...result.obligation, expectedCommIdentityRevision: "new-identity" },
				new Date(clock).toISOString(),
			),
		).toBe(false);
		expect(store.listPendingExecutionBodyDeaths({ limit: 1 })).toHaveLength(1);
		expect(
			store.markExecutionBodyDeathProjected(
				result.obligation,
				new Date(clock).toISOString(),
			),
		).toBe(true);
		expect(
			store.markExecutionBodyDeathProjected(
				result.obligation,
				new Date(clock + 1000).toISOString(),
			),
		).toBe(true);
		expect(store.listPendingExecutionBodyDeaths({ limit: 1 })).toEqual([]);
		expect(
			store.getExecutionBodyDeathObligation(result.obligation.obligationId),
		).toEqual(result.obligation);
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((e) => e.kind === "body_death_projected"),
		).toHaveLength(1);
	});
});
