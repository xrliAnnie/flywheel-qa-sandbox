/** FLY-2919: pending completion wins at both async sampling and the final death CAS. */
import {
	existsSync,
	mkdtempSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge/complete-marker-reconciler.js", async (original) => ({
	...(await original<
		typeof import("../bridge/complete-marker-reconciler.js")
	>()),
	tryReconcileComplete: vi.fn(async () => ({ kind: "absent" })),
}));
vi.mock("../bridge/worktree-inspect.js", () => ({
	inspectWorktreeForUnpushedWork: vi.fn(async () => ({ ok: false })),
}));

import { tryReconcileComplete } from "../bridge/complete-marker-reconciler.js";
import {
	convergeExecutionBody,
	type ExecutionBodyConvergenceDeps,
} from "../bridge/execution-body-convergence.js";
import { createExecutionBodyObserver } from "../bridge/execution-body-liveness.js";
import { HeartbeatService } from "../HeartbeatService.js";
import { StateStore } from "../StateStore.js";

describe("FLY-2919 completion before death", () => {
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
	function observer() {
		return createExecutionBodyObserver(store, {
			isEnabled: () => enabled,
			isRecoveryActive: () => false,
			now: () => clock,
			sample: async () => capture(),
		});
	}
	let service: HeartbeatService;
	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "fly2919-convergence-"));
		clock = 1000;
		vi.stubEnv("FLYWHEEL_COMPLETE_MARKER_DIR", root);
		vi.mocked(tryReconcileComplete)
			.mockReset()
			.mockResolvedValue({ kind: "absent" });
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
			completionBlocksDeath: async (id) =>
				service.reconcileCompletionBeforeDeath(id),
		};
		service = new HeartbeatService(
			store,
			{
				clearReconnectStamp: vi.fn(),
				prepareSessionZombieDetected: vi.fn(),
				persistPreparedZombieDetected: vi.fn(async () => true),
			} as never,
			15,
			60000,
			60,
			undefined,
			24,
			21600000,
			{ bridgeBaseUrl: "http://localhost", ingestToken: "fixture" },
		);
		service.setExecutionBodyLifecycle({
			observe: deps.observer.observe,
			converge: (id) => convergeExecutionBody(deps, id),
		});
		vi.spyOn(store, "getOrphanSessions").mockImplementation(() => [
			store.getSession("exec-1")!,
		]);
	});
	afterEach(() => {
		service.stop();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		store.close();
		comm.close();
		rmSync(root, { recursive: true, force: true });
	});

	function marker() {
		writeFileSync(join(root, "exec-1.json"), "{}");
	}
	function assertNoDeath() {
		expect(store.getSession("exec-1")?.status).not.toBe("failed");
		expect(comm.getSession("exec-1")?.status).not.toBe("failed");
		expect(
			store.getExecutionBodyDeathObligation("body_death:exec-1:1"),
		).toBeUndefined();
	}
	it("actually commits a dead body when completion is absent", async () => {
		expect(await service.reconcileExecutionBody("exec-1")).toBe(true);
		expect(store.getSession("exec-1")?.status).toBe("failed");
		expect(comm.getSession("exec-1")?.status).toBe("failed");
	});
	it("reconciles a real completion arriving during process sampling before failed", async () => {
		const sample = capture.getMockImplementation()!;
		capture.mockImplementation(async () => {
			marker();
			return sample();
		});
		vi.mocked(tryReconcileComplete).mockImplementation(async () => {
			if (!existsSync(join(root, "exec-1.json"))) return { kind: "absent" };
			unlinkSync(join(root, "exec-1.json"));
			// Simulate the separately-tested reconciler committing its genuine completion.
			raw()
				.prepare(
					"UPDATE sessions SET status='completed', lifecycle_revision=lifecycle_revision+1 WHERE execution_id=?",
				)
				.run("exec-1");
			return { kind: "reconciled", status: "completed" };
		});
		await service.reconcileExecutionBody("exec-1");
		expect(capture).toHaveBeenCalledOnce();
		expect(store.getSession("exec-1")?.status).toBe("completed");
		assertNoDeath();
	});
	it.each(["transient_failed", "held_for_lead"] as const)(
		"holds %s arriving during sampling through orphan retry",
		async (kind) => {
			const sample = capture.getMockImplementation()!;
			capture.mockImplementation(async () => {
				marker();
				vi.mocked(tryReconcileComplete).mockResolvedValue(
					kind === "transient_failed"
						? { kind, error: "retry" }
						: { kind, invariant: "fixture", alertState: "accepted" },
				);
				return sample();
			});
			await service.reconcileExecutionBody("exec-1");
			await service.reapOrphans();
			expect(capture).toHaveBeenCalledOnce();
			assertNoDeath();
		},
	);
	it("checks disk after the final async process sample despite an absent replay answer", async () => {
		const sample = capture.getMockImplementation()!;
		capture.mockImplementation(async () => {
			marker();
			return sample();
		});
		await service.reconcileExecutionBody("exec-1");
		expect(capture).toHaveBeenCalledOnce();
		assertNoDeath();
	});
	it("reconciles a pending marker on direct orphan entry before any sampling", async () => {
		marker();
		vi.mocked(tryReconcileComplete).mockResolvedValue({
			kind: "reconciled",
			status: "completed",
		});
		await service.reapOrphans();
		expect(tryReconcileComplete).toHaveBeenCalled();
		expect(capture).not.toHaveBeenCalled();
		assertNoDeath();
	});
	it("blocks death when marker directory access is unknown", async () => {
		const notDirectory = join(root, "not-a-directory");
		writeFileSync(notDirectory, "x");
		vi.stubEnv("FLYWHEEL_COMPLETE_MARKER_DIR", notDirectory);
		await service.reapOrphans();
		expect(capture).not.toHaveBeenCalled();
		assertNoDeath();
	});
	it("vetoes a marker arriving at the synchronous StateStore mutation boundary", async () => {
		const commit = store.convergeProvenDeadExecution.bind(store);
		const boundary = vi
			.spyOn(store, "convergeProvenDeadExecution")
			.mockImplementation((input) => {
				marker();
				return commit(input);
			});
		await service.reconcileExecutionBody("exec-1");
		expect(boundary).toHaveBeenCalledOnce();
		assertNoDeath();
	});
	it("keeps failed quarantine moves pending instead of authorizing death", async () => {
		marker();
		vi.mocked(tryReconcileComplete).mockResolvedValue({
			kind: "quarantined",
			reason: "invalid",
			quarantinePath: "/unused",
		});
		await service.reapOrphans();
		expect(capture).not.toHaveBeenCalled();
		assertNoDeath();
	});
	it("holds death on replay rejection", async () => {
		vi.mocked(tryReconcileComplete).mockRejectedValueOnce(
			new Error("replay unavailable"),
		);
		await service.reapOrphans();
		expect(capture).not.toHaveBeenCalled();
		assertNoDeath();
	});
	it("rejects a changed lifecycle after an absent post-sample replay", async () => {
		vi.mocked(tryReconcileComplete)
			.mockResolvedValueOnce({ kind: "absent" })
			.mockImplementation(async () => {
				raw()
					.prepare(
						"UPDATE sessions SET lifecycle_revision=lifecycle_revision+1 WHERE execution_id=?",
					)
					.run("exec-1");
				return { kind: "absent" };
			});
		await service.reconcileExecutionBody("exec-1");
		expect(capture).toHaveBeenCalledOnce();
		assertNoDeath();
	});
});
