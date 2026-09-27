import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HeartbeatService } from "../../HeartbeatService.js";
import { StateStore } from "../../StateStore.js";
import { hasUnresolvedCompleteMarker } from "../completion-before-death.js";
import { reapCrashedRunners } from "../crash-reaper.js";
import {
	convergeExecutionBody,
	type ExecutionBodyConvergenceDeps,
	projectCommittedExecutionBodyDeath,
	retryExecutionBodyConvergence,
} from "../execution-body-convergence.js";
import { createExecutionBodyObserver } from "../execution-body-liveness.js";
import { createExecutionBodyRuntime } from "../execution-body-runtime.js";

describe("FLY-2919 body death across StateStore and CommDB", () => {
	let root: string;
	let store: StateStore;
	let comm: CommDB;
	let clock: number;
	let enabled: boolean;
	let deps: ExecutionBodyConvergenceDeps;
	let capture: ReturnType<typeof vi.fn>;
	const raw = () => (store as unknown as { db: { raw: Database } }).db.raw;
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
		startIdentity: "worker",
		hostBootId: "boot",
		executable: "/bin/codex",
		cwd: "/work",
		nonce: "nonce",
		nativeSessionId: null,
		writers: [],
	};
	const replay = () =>
		projectCommittedExecutionBodyDeath({
			store,
			comm,
			obligationId: "body_death:exec-1:1",
			nowMs: clock,
		});
	function observer() {
		return createExecutionBodyObserver(store, {
			isEnabled: () => enabled,
			isRecoveryActive: () => false,
			now: () => clock,
			sample: async () => capture(),
		});
	}
	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "fly2919-convergence-"));
		clock = 1000;
		enabled = true;
		store = await StateStore.create(join(root, "state.db"));
		comm = new CommDB(join(root, "comm.db"));
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
		raw()
			.prepare(
				"INSERT INTO workflow_actor VALUES ('exec-1','fixture','FLY-2919','implement','1970-01-01T00:00:00Z')",
			)
			.run();
		raw()
			.prepare(
				"INSERT INTO workflow_execution_binding VALUES ('activation-1','exec-1','run-1','implement',1,'spawn',NULL,'1970-01-01T00:00:00Z')",
			)
			.run();
		raw()
			.prepare(
				"INSERT INTO workflow_execution_runtime VALUES ('exec-1','run-1','implement',1,'codex','codex','high','implement','digest','1970-01-01T00:00:00Z')",
			)
			.run();
		raw()
			.prepare(
				"INSERT INTO workflow_execution_process_body(execution_id,generation,state,started_at,updated_at) VALUES('exec-1',1,'active','1970-01-01T00:00:00Z','1970-01-01T00:00:00Z')",
			)
			.run();
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "FLY-2919",
			project_name: "fixture",
			status: "running",
			adapter_type: "codex-tmux",
		});
		const lifecycleRevision = store.getLifecycleRevision("exec-1");
		expect(
			store.executionProcessOwners.claim({
				...owner,
				lifecycleRevision,
				nowMs: clock,
				controller: {
					pid: 100,
					startIdentity: "controller",
					hostBootId: "boot",
				},
			}).ok,
		).toBe(true);
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
			}).ok,
		).toBe(true);
		comm.registerSession("exec-1", "visible:@1", "fixture", "FLY-2919", "lead");
		comm.upsertDeclaredState("exec-1", "parked", "waiting", clock, null);
		comm.grantTurn("FLY-2919", "exec-1", "implement", clock);
		capture = vi.fn(async () => ({
			sampledAtMs: clock,
			hostBootId: "boot",
			processes: [],
			worker: null,
			daemon: "absent",
			writersComplete: true,
			viewers: [],
		}));
		deps = {
			store,
			comm,
			observer: observer(),
			now: () => clock,
			markerDir: root,
			completionBlocksDeath: async (id) =>
				hasUnresolvedCompleteMarker(id, root),
		};
	});
	afterEach(() => {
		store.close();
		comm.close();
		rmSync(root, { recursive: true, force: true });
	});

	function reenter(attempt = 2, boundAt = "1970-01-01T00:00:00.500Z") {
		store.upsertWorkflowRunNode({
			runId: "run-1",
			nodeId: "implement",
			attempt,
			state: "running",
			executionId: "exec-1",
		});
		raw()
			.prepare(
				"INSERT INTO workflow_execution_binding VALUES (?, 'exec-1','run-1','implement',?,'wake',NULL,?)",
			)
			.run(`activation-${attempt}`, attempt, boundAt);
	}
	it("FLY-2919 settles the current logical activation without changing the physical owner", async () => {
		const physical = store.executionProcessOwners.get("exec-1")!;
		reenter();
		const observed = await deps.observer.observe("exec-1");
		expect(observed).toMatchObject({
			verdict: "dead",
			identity: { activationId: "activation-2", generation: 1 },
			ownerToken: physical.owner_token,
			spawnEpoch: physical.spawn_epoch,
			bindingDigest: physical.binding_digest,
		});
		const result = await convergeExecutionBody(deps, "exec-1");
		expect(result).toMatchObject({
			kind: "committed",
			obligation: {
				attempt: 2,
				observation: { identity: { activationId: "activation-2" } },
			},
			projection: { projected: true },
		});
		expect(store.executionProcessOwners.get("exec-1")).toMatchObject({
			activation_id: "activation-1",
			owner_token: physical.owner_token,
			spawn_epoch: physical.spawn_epoch,
			binding_digest: physical.binding_digest,
			close_requested: 1,
		});
		expect(store.getCurrentProjectedExecutionBodyDeath("exec-1")?.attempt).toBe(
			2,
		);
		clock += 60000;
		expect(replay()).toMatchObject({ projected: true });
	});
	it("keeps projected death readable for default non-standby executions with no body row", async () => {
		raw()
			.prepare(
				"DELETE FROM workflow_execution_process_body WHERE execution_id = ?",
			)
			.run("exec-1");

		await expect(convergeExecutionBody(deps, "exec-1")).resolves.toMatchObject({
			kind: "committed",
			projection: { projected: true },
		});
		expect(store.getCurrentProjectedExecutionBodyDeath("exec-1")).toMatchObject(
			{
				obligationId: "body_death:exec-1:1",
				disposition: "failed",
			},
		);
		expect(
			store.executionProcessOwners.listObservationCandidates(),
		).not.toContain("exec-1");
	});
	it("FLY-2919 invalidates an old logical observation during OS capture and resamples the same body", async () => {
		const original = capture.getMockImplementation()!;
		capture.mockImplementationOnce(async () => {
			reenter();
			return original();
		});
		const stale = await deps.observer.observe("exec-1");
		expect(stale?.verdict).toBe("unknown");
		expect(deps.observer.isCurrent(stale!)).toBe(false);
		expect(store.getSession("exec-1")?.status).toBe("running");
		expect(await convergeExecutionBody(deps, "exec-1")).toMatchObject({
			kind: "committed",
			obligation: { attempt: 2 },
		});
	});
	it.each(["same_time", "invalid_time", "missing_admission"])(
		"FLY-2919 refuses unresolved logical attribution: %s",
		async (mode) => {
			reenter(
				2,
				mode === "same_time"
					? "1970-01-01T00:00:00.000Z"
					: mode === "invalid_time"
						? "invalid"
						: "1970-01-01T00:00:00.500Z",
			);
			if (mode === "same_time")
				raw()
					.prepare(
						"INSERT INTO workflow_execution_binding VALUES ('other-node','exec-1','run-1','other',2,'wake',NULL,'1970-01-01T00:00:00Z')",
					)
					.run();
			if (mode === "missing_admission")
				raw()
					.prepare(
						"UPDATE execution_process_owner SET activation_id = 'missing'",
					)
					.run();
			expect(await deps.observer.observe("exec-1")).toBeUndefined();
			expect(await convergeExecutionBody(deps, "exec-1")).toMatchObject({
				kind: "deferred",
			});
			expect(store.getSession("exec-1")?.status).toBe("running");
		},
	);
	it("FLY-2919 orders same-node re-entry by attempt when bound timestamps share an instant", async () => {
		reenter(2, "1970-01-01T00:00:00.000Z");
		expect(await convergeExecutionBody(deps, "exec-1")).toMatchObject({
			kind: "committed",
			obligation: { attempt: 2 },
		});
	});
	it("FLY-2919 retains live physical evidence across logical re-entry", async () => {
		reenter();
		capture.mockResolvedValue({
			sampledAtMs: clock,
			hostBootId: "boot",
			writersComplete: true,
			viewers: [],
			processes: [
				{
					pid: 200,
					ppid: 1,
					pgid: 200,
					startIdentity: "worker",
					state: "running",
				},
			],
			worker: { executable: binding.executable, cwd: binding.cwd },
			daemon: "alive",
		});
		expect(await deps.observer.observe("exec-1")).toMatchObject({
			verdict: "alive",
			identity: { activationId: "activation-2" },
		});
		expect(await convergeExecutionBody(deps, "exec-1")).toEqual({
			kind: "deferred",
			reason: "body_alive",
		});
		expect(store.executionProcessOwners.get("exec-1")?.close_requested).toBe(0);
	});
	it.each([1, 2])(
		"FLY-2919 preserves only the current activation completion (receipt for %s)",
		async (receiptAttempt) => {
			reenter();
			raw()
				.prepare(
					"INSERT INTO workflow_node_completion VALUES (?, 'run-1','implement',?,'exec-1','needs_review','completion-1','source-1','digest','1970-01-01T00:00:00.500Z')",
				)
				.run(`activation-${receiptAttempt}`, receiptAttempt);
			expect(await convergeExecutionBody(deps, "exec-1")).toMatchObject({
				kind: "committed",
				obligation: {
					attempt: 2,
					disposition: receiptAttempt === 2 ? "completion_preserved" : "failed",
					terminalStatus: receiptAttempt === 2 ? "completed" : "failed",
				},
				projection: { projected: true },
			});
		},
	);
	it("FLY-2919 rejects logical re-entry during completion reconciliation before the death CAS", async () => {
		deps.completionBlocksDeath = async () => {
			reenter();
			return false;
		};
		expect(await convergeExecutionBody(deps, "exec-1")).toMatchObject({
			kind: "deferred",
		});
		expect(store.getSession("exec-1")?.status).toBe("running");
		expect(store.executionProcessOwners.get("exec-1")?.close_requested).toBe(0);
	});
	it("FLY-2919 projected death stays terminal through UI failure and restart cleanup", async () => {
		const death = await convergeExecutionBody(deps, "exec-1");
		expect(death).toMatchObject({
			kind: "committed",
			projection: { projected: true },
		});
		let cleaned = false;
		const cleanup = () =>
			reapCrashedRunners({
				store,
				enabled: true,
				nowMs: clock,
				candidates: store.listExecutionBodyCleanupCandidates({ limit: 64 }),
				readCurrentDeath: (id) =>
					enabled ? store.getCurrentProjectedExecutionBodyDeath(id) : undefined,
				isSuppressed: () => false,
				hasPendingCompleteMarker: (id) => hasUnresolvedCompleteMarker(id, root),
				lookupTmuxTarget: () => ({
					kind: "found",
					target: { tmuxWindow: "fixture:@1", sessionName: "fixture" },
				}),
				inspectWindow: async () => "owned",
				captureScrollback: async () => ({ ok: true, text: "fixture" }),
				writeCrashLog: () => ({ path: join(root, "fixture.log") }),
				killCmuxLinkedSession: async () => ({ killed: true }),
				killTmuxWindow: async () => ({ killed: cleaned }),
			});
		expect((await cleanup()).cleanupPending).toBe(1);
		expect(store.getSession("exec-1")?.status).toBe("failed");
		expect(comm.getSession("exec-1")?.status).toBe("failed");
		store.close();
		store = await StateStore.create(join(root, "state.db"));
		clock += 60000;
		enabled = false;
		cleaned = true;
		expect((await cleanup()).reaped).toBe(0);
		expect(store.listExecutionBodyCleanupCandidates({ limit: 64 })).toEqual([
			"exec-1",
		]);
		enabled = true;
		expect((await cleanup()).reaped).toBe(1);
		expect(store.listExecutionBodyCleanupCandidates({ limit: 64 })).toEqual([]);
		expect(capture).toHaveBeenCalledOnce();
	});

	it("reads settled current-generation death after observation expiry and restart without another OS probe", async () => {
		const result = await convergeExecutionBody(deps, "exec-1");
		if (result.kind !== "committed") throw new Error(result.reason);
		expect(result.projection.projected).toBe(true);
		clock += 60_000;
		expect(deps.observer.isCurrent(result.obligation.observation)).toBe(false);
		expect(store.getCurrentProjectedExecutionBodyDeath("exec-1")).toEqual(
			result.obligation,
		);
		store.close();
		store = await StateStore.create(join(root, "state.db"));
		expect(store.getCurrentProjectedExecutionBodyDeath("exec-1")).toEqual(
			result.obligation,
		);
		expect(capture).toHaveBeenCalledOnce();
	});
	it("requires the exact projection receipt before exposing durable death", async () => {
		const acknowledge = vi
			.spyOn(store, "markExecutionBodyDeathProjected")
			.mockReturnValue(true);
		const result = await convergeExecutionBody(deps, "exec-1");
		if (result.kind !== "committed") throw new Error(result.reason);
		acknowledge.mockRestore();
		expect(
			store.getCurrentProjectedExecutionBodyDeath("exec-1"),
		).toBeUndefined();
		expect(
			store.markExecutionBodyDeathProjected(
				result.obligation,
				new Date(clock).toISOString(),
			),
		).toBe(true);
		const id = `${result.obligation.obligationId}:projected`;
		const reads = store as unknown as {
			workflowSelectAll(
				sql: string,
				parameters: unknown[],
			): Record<string, unknown>[];
		};
		const original = reads.workflowSelectAll.bind(store);
		const row = original(
			"SELECT * FROM workflow_run_event WHERE event_uid = ?",
			[id],
		)[0]!;
		// Events are append-only. Inject corrupt reads without disabling that guard.
		const read = vi.spyOn(reads, "workflowSelectAll");
		for (const payload of [
			"{",
			"{}",
			JSON.stringify({
				...JSON.parse(String(row.payload)),
				obligationDigest: "stale",
			}),
		]) {
			read.mockImplementation((sql, parameters) =>
				parameters[0] === id
					? [{ ...row, payload }]
					: original(sql, parameters),
			);
			expect(
				store.getCurrentProjectedExecutionBodyDeath("exec-1"),
			).toBeUndefined();
		}
		read.mockRestore();
		expect(store.getCurrentProjectedExecutionBodyDeath("exec-1")).toEqual(
			result.obligation,
		);
	});
	it("refuses resurrected or rebound state without changing any stored evidence", async () => {
		const result = await convergeExecutionBody(deps, "exec-1");
		if (result.kind !== "committed") throw new Error(result.reason);
		const mutations = [
			"UPDATE execution_process_owner SET generation = generation + 1",
			"UPDATE execution_process_owner SET owner_token = 'different'",
			"UPDATE execution_process_owner SET spawn_epoch = spawn_epoch + 1",
			"UPDATE execution_process_owner SET binding_spawn_epoch = 99",
			"UPDATE execution_process_owner SET binding_digest = 'different'",
			"UPDATE execution_process_owner SET binding_json = '{}'",
			"UPDATE execution_process_owner SET activation_id = 'different'",
			"UPDATE execution_process_owner SET close_requested = 0",
			"UPDATE execution_process_owner SET owner_drained_receipt = NULL",
			"UPDATE execution_process_owner SET spawn_inflight = 1",
			"UPDATE execution_process_owner SET restart_in_progress = 1",
			"UPDATE workflow_execution_process_body SET generation = generation + 1",
			"UPDATE workflow_execution_process_body SET state = 'active'",
			"UPDATE sessions SET status = 'running'",
			"UPDATE sessions SET terminal_lifecycle_id = 'different'",
		];
		const rollback = new Error("test-rollback");
		for (const sql of mutations) {
			try {
				raw().transaction(() => {
					raw().prepare(sql).run();
					expect(
						store.getCurrentProjectedExecutionBodyDeath("exec-1"),
						sql,
					).toBeUndefined();
					throw rollback;
				})();
			} catch (error) {
				if (error !== rollback) throw error;
			}
			expect(store.getCurrentProjectedExecutionBodyDeath("exec-1")).toEqual(
				result.obligation,
			);
		}
		// A successor occupying the workflow slot does not revive the old physical body.
		raw()
			.prepare("UPDATE workflow_run_node SET execution_id = 'successor'")
			.run();
		expect(store.getCurrentProjectedExecutionBodyDeath("exec-1")).toEqual(
			result.obligation,
		);
	});

	it("revalidates settled death inside the replacement transaction", async () => {
		const death = await convergeExecutionBody(deps, "exec-1");
		expect(death.kind).toBe("committed");
		raw()
			.prepare(
				"UPDATE workflow_run SET engine_owned = 1 WHERE run_id = 'run-1'",
			)
			.run();
		const input = {
			runId: "run-1",
			nodeId: "implement",
			attempt: 1,
			deadExecutionId: "exec-1",
			newExecutionId: "successor",
			reason: "body_death",
			livenessEvidence: {
				liveness: "dead" as const,
				observedAt: new Date(clock).toISOString(),
			},
			now: new Date(clock).toISOString(),
		};
		expect(
			store.rollbackDeadWorkflowNodeExecution({
				...input,
				isBodyDeathCurrent: () => false,
			}),
		).toMatchObject({ ok: false, reason: "body_death_authority_changed" });
		raw()
			.prepare(
				"UPDATE execution_process_owner SET spawn_epoch = spawn_epoch + 1 WHERE execution_id = 'exec-1'",
			)
			.run();
		expect(
			store.rollbackDeadWorkflowNodeExecution({
				...input,
				isBodyDeathCurrent: () => true,
			}),
		).toMatchObject({ ok: false, reason: "body_death_authority_changed" });
		expect(
			store.getWorkflowRunNode("run-1", "implement", 1)?.execution_id,
		).toBe("exec-1");
	});
	it("retries a transient mutation lease outside the lease and commits after release", async () => {
		const claim = store.claimExecutionMutationLease(
			"exec-1",
			store.getLifecycleRevision("exec-1"),
			{ holder: "other", nowMs: clock, ttlMs: 60000 },
		);
		if (!claim.ok) throw new Error(claim.reason);
		const wait = vi.fn(async () => {
			expect(store.getSession("exec-1")?.status).toBe("running");
			store.commitExecutionMutationLease(
				"exec-1",
				claim.claimToken,
				store.getLifecycleRevision("exec-1"),
				clock,
			);
		});
		expect(
			await retryExecutionBodyConvergence(
				() => convergeExecutionBody(deps, "exec-1"),
				wait,
			),
		).toMatchObject({ kind: "committed" });
		expect(wait).toHaveBeenCalledExactlyOnceWith(25);
	});
	it("bounds contention retries and never retries semantic refusal", async () => {
		const busy = vi.fn(async () => ({
			kind: "deferred" as const,
			reason: "lease_held",
		}));
		const wait = vi.fn(async () => {});
		expect(await retryExecutionBodyConvergence(busy, wait)).toEqual({
			kind: "deferred",
			reason: "lease_held",
		});
		expect(busy).toHaveBeenCalledTimes(3);
		expect(wait.mock.calls).toEqual([[25], [75]]);
		const stale = vi.fn(async () => ({
			kind: "deferred" as const,
			reason: "body_death_authority_changed",
		}));
		wait.mockClear();
		expect(await retryExecutionBodyConvergence(stale, wait)).toEqual({
			kind: "deferred",
			reason: "body_death_authority_changed",
		});
		expect(stale).toHaveBeenCalledOnce();
		expect(wait).not.toHaveBeenCalled();
	});
	it("independent sampling commits a fresh-heartbeat death through both ledgers with one OS sample", async () => {
		const heartbeat = new HeartbeatService(
			store,
			{
				prepareSessionZombieDetected: vi.fn(),
				clearReconnectStamp: vi.fn(),
			} as never,
			15,
			300000,
			60,
			undefined,
			24,
			21600000,
			{
				bridgeBaseUrl: "http://localhost",
				ingestToken: "fixture",
				markerDir: root,
			},
		);
		let runtime: ReturnType<typeof createExecutionBodyRuntime>;
		const cached = {
			...deps.observer,
			observe: async (id: string) => runtime.read(id),
		};
		heartbeat.setExecutionBodyLifecycle({
			observe: cached.observe,
			converge: (id) =>
				convergeExecutionBody({ ...deps, observer: cached }, id),
		});
		runtime = createExecutionBodyRuntime({
			listCandidates: () =>
				store.executionProcessOwners.listObservationCandidates(),
			observer: deps.observer,
			now: () => clock,
			onDead: async (id) => {
				await heartbeat.reconcileExecutionBody(id);
			},
			onRecoveryActive: async () => {},
			replayPending: async () => {},
		});
		try {
			expect(store.getOrphanSessions(60)).toEqual([]);
			runtime.start();
			await runtime.runPass();
			await vi.waitFor(() =>
				expect(comm.getSession("exec-1")?.status).toBe("failed"),
			);
			expect(store.getSession("exec-1")?.status).toBe("failed");
			expect(capture).toHaveBeenCalledOnce();
			expect(comm.getTurn("FLY-2919")).toBeNull();
		} finally {
			await runtime.stop();
			heartbeat.stop();
		}
	});
	it("commits both ledgers for dead parked bodies despite a present window", async () => {
		comm.enqueueRunnerPhaseWake(
			"exec-1",
			{
				id: "founder",
				to: "exec-1",
				content: "original instruction",
				metadata: { origin: "founder" },
			},
			clock,
		);
		expect(await convergeExecutionBody(deps, "exec-1")).toMatchObject({
			kind: "committed",
			projection: { projected: true },
		});
		expect(store.getSession("exec-1")?.status).toBe("failed");
		expect(comm.getSession("exec-1")).toMatchObject({
			status: "failed",
			tmux_window: "visible:@1",
		});
		expect(comm.getTurn("FLY-2919")).toBeNull();
		expect(comm.listRunnerPhaseWakes("exec-1")).toMatchObject([
			{
				message_id: "founder",
				state: "finished",
				content: "original instruction",
			},
		]);
		expect(store.listPendingExecutionBodyDeaths({ limit: 10 })).toEqual([]);
	});
	it("samples and reconciles markers outside the mutation lease", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const original = capture.getMockImplementation()!;
		capture.mockImplementation(async () => {
			await gate;
			return original();
		});
		const claim = vi.spyOn(store, "claimExecutionMutationLease");
		const marker = vi.fn(async () => {
			expect(claim).not.toHaveBeenCalled();
			return false;
		});
		deps.completionBlocksDeath = marker;
		const pending = convergeExecutionBody(deps, "exec-1");
		expect(claim).not.toHaveBeenCalled();
		release();
		expect(await pending).toMatchObject({ kind: "committed" });
		expect(marker).toHaveBeenCalledOnce();
		expect(claim).toHaveBeenCalled();
	});
	it("protects a live body with a missing window", async () => {
		comm.registerSession(
			"exec-1",
			"runner:pending",
			"fixture",
			"FLY-2919",
			"lead",
		);
		capture.mockImplementation(async () => ({
			sampledAtMs: clock,
			hostBootId: "boot",
			processes: [
				{
					pid: 200,
					ppid: 1,
					pgid: 200,
					startIdentity: "worker",
					state: "running",
				},
			],
			worker: { executable: "/bin/codex", cwd: "/work" },
			daemon: "alive",
			writersComplete: true,
			viewers: [],
		}));
		expect(await convergeExecutionBody(deps, "exec-1")).toMatchObject({
			kind: "deferred",
			reason: "body_alive",
		});
		expect(store.getSession("exec-1")?.status).toBe("running");
	});
	it("reconciles a marker found after sampling before any death write", async () => {
		const original = capture.getMockImplementation()!;
		capture.mockImplementation(async () => {
			writeFileSync(join(root, "exec-1.json"), "pending");
			return original();
		});
		expect(await convergeExecutionBody(deps, "exec-1")).toMatchObject({
			kind: "deferred",
			reason: "completion_marker_pending",
		});
		expect(store.getSession("exec-1")?.status).toBe("running");
	});
	it("rechecks the dynamic switch after completion reconciliation awaited", async () => {
		deps.completionBlocksDeath = async () => {
			enabled = false;
			return false;
		};
		expect(await convergeExecutionBody(deps, "exec-1")).toMatchObject({
			kind: "deferred",
		});
		expect(comm.getSession("exec-1")?.status).toBe("running");
	});
	it("rejects CommDB identity changes during the OS await before writing StateStore", async () => {
		const original = capture.getMockImplementation()!;
		capture.mockImplementation(async () => {
			comm.registerSession("exec-1", "new:@2", "fixture", "FLY-2919", "lead");
			return original();
		});
		expect(await convergeExecutionBody(deps, "exec-1")).toMatchObject({
			kind: "deferred",
			reason: "comm_identity_changed",
		});
		expect(store.getSession("exec-1")?.status).toBe("running");
	});
	it("replays after StateStore commit and before CommDB commit, past expiry with the switch off", async () => {
		const failure = vi
			.spyOn(comm, "projectProvenBodyDeath")
			.mockImplementationOnce(() => {
				throw new Error("comm crash");
			});
		await expect(convergeExecutionBody(deps, "exec-1")).rejects.toThrow(
			"comm crash",
		);
		failure.mockRestore();
		expect(store.getSession("exec-1")?.status).toBe("failed");
		expect(comm.getSession("exec-1")?.status).toBe("running");
		store.close();
		comm.close();
		clock += 61000;
		enabled = false;
		store = await StateStore.create(join(root, "state.db"));
		comm = new CommDB(join(root, "comm.db"));
		expect(replay()).toMatchObject({ projected: true });
		expect(comm.getSession("exec-1")?.status).toBe("failed");
		expect(store.listPendingExecutionBodyDeaths({ limit: 10 })).toEqual([]);
	});
	it("replays after CommDB commit and before StateStore acknowledgement exactly once", async () => {
		const failure = vi
			.spyOn(store, "markExecutionBodyDeathProjected")
			.mockImplementationOnce(() => {
				throw new Error("ack crash");
			});
		await expect(convergeExecutionBody(deps, "exec-1")).rejects.toThrow(
			"ack crash",
		);
		failure.mockRestore();
		expect(comm.getSession("exec-1")?.status).toBe("failed");
		expect(store.listPendingExecutionBodyDeaths({ limit: 10 })).toHaveLength(1);
		clock += 61000;
		expect(replay()).toMatchObject({ projected: true, idempotentReplay: true });
		expect(store.listPendingExecutionBodyDeaths({ limit: 10 })).toEqual([]);
	});
	it("refuses lease contention without failing the body and can retry after release", async () => {
		const claim = store.claimExecutionMutationLease(
			"exec-1",
			store.getLifecycleRevision("exec-1"),
			{ holder: "other", nowMs: clock, ttlMs: 1000 },
		);
		if (!claim.ok) throw new Error(claim.reason);
		expect(await convergeExecutionBody(deps, "exec-1")).toMatchObject({
			kind: "deferred",
			reason: "lease_held",
		});
		expect(store.getSession("exec-1")?.status).toBe("running");
		store.commitExecutionMutationLease(
			"exec-1",
			claim.claimToken,
			store.getLifecycleRevision("exec-1"),
			clock,
		);
		expect(await convergeExecutionBody(deps, "exec-1")).toMatchObject({
			kind: "committed",
		});
	});
	it("rejects a new TURN epoch issued while the OS sample awaits", async () => {
		const original = capture.getMockImplementation()!;
		capture.mockImplementation(async () => {
			comm.grantTurn("FLY-2919", "exec-1", "implement", clock + 1);
			return original();
		});
		expect(await convergeExecutionBody(deps, "exec-1")).toMatchObject({
			kind: "deferred",
			reason: "turn_changed",
		});
		expect(store.getSession("exec-1")?.status).toBe("running");
		expect(comm.getTurn("FLY-2919")).not.toBeNull();
	});
	it("will not project old death over a newer physical generation", async () => {
		const failure = vi
			.spyOn(comm, "projectProvenBodyDeath")
			.mockImplementationOnce(() => {
				throw new Error("comm crash");
			});
		await expect(convergeExecutionBody(deps, "exec-1")).rejects.toThrow(
			"comm crash",
		);
		failure.mockRestore();
		clock += 61000;
		raw()
			.prepare(
				"UPDATE execution_process_owner SET generation=2,owner_token='owner-2',close_requested=0,owner_drained_receipt=NULL",
			)
			.run();
		raw()
			.prepare(
				"UPDATE workflow_execution_process_body SET generation=2,state='active'",
			)
			.run();
		expect(replay()).toMatchObject({
			projected: false,
			reason: "body_death_unverified",
		});
		expect(comm.getSession("exec-1")?.status).toBe("running");
		expect(store.listPendingExecutionBodyDeaths({ limit: 10 })).toHaveLength(1);
	});
	it("Heartbeat commits the real double-ledger path and preserves process evidence for alert retry", async () => {
		const prepare = vi.fn(() => ({ eventId: "zombie-exec-1" }));
		const persist = vi.fn(async () => false);
		const heartbeat = new HeartbeatService(
			store,
			{
				prepareSessionZombieDetected: prepare,
				persistPreparedZombieDetected: persist,
				clearReconnectStamp: vi.fn(),
			} as never,
			15,
			300000,
			60,
			undefined,
			24,
			21600000,
			{
				bridgeBaseUrl: "http://localhost",
				ingestToken: "fixture",
				markerDir: root,
			},
		);
		heartbeat.setExecutionBodyLifecycle({
			observe: deps.observer.observe,
			converge: (id) => convergeExecutionBody(deps, id),
		});
		expect(await heartbeat.reconcileExecutionBody("exec-1")).toBe(true);
		expect(store.getSession("exec-1")?.status).toBe("failed");
		expect(comm.getSession("exec-1")?.status).toBe("failed");
		expect(
			store.getZombieAlertBacklog("", 20).map((s) => s.execution_id),
		).toContain("exec-1");
		expect(prepare.mock.calls[0]?.[1]).toMatchObject({
			kind: "process",
			observation: {
				identity: { executionId: "exec-1", generation: 1 },
				verdict: "dead",
			},
		});
		// A restarted Heartbeat can recover from the immutable obligation even
		// after its ten-second mutation authority expires.
		clock += 60_000;
		await (heartbeat as any).reconcileZombieAlertBacklog();
		expect(prepare).toHaveBeenCalledTimes(2);
		expect(prepare.mock.calls[1]?.[1]).toEqual(prepare.mock.calls[0]?.[1]);
	});
	it("requires the literal body-death marker when scheduling alert replay", () => {
		store.forceStatus(
			"exec-1",
			"failed",
			new Date(clock).toISOString(),
			"bodyXdeath:not-a-body-death",
		);
		expect(store.getZombieAlertBacklog("", 20)).toEqual([]);
	});
});
