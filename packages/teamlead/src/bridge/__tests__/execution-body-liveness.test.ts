import type { ExecutionProcessSample } from "flywheel-claude-runner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionBodyObserver } from "../execution-body-liveness.js";

describe("FLY-2919 current execution body observations", () => {
	let clock: number;
	let enabled: boolean;
	let recovering: boolean;
	let row: any;
	let session: any;
	let body: any;
	let store: any;
	let sample: ExecutionProcessSample;
	const binding = {
		version: 1 as const,
		adapter: "codex-tmux" as const,
		pid: 200,
		pgid: 200,
		startIdentity: "worker-start",
		hostBootId: "boot-1",
		executable: "/bin/codex",
		cwd: "/work",
		nonce: "nonce-1",
		nativeSessionId: null,
		writers: [],
	};
	beforeEach(() => {
		clock = 1000;
		enabled = true;
		recovering = false;
		session = {
			execution_id: "exec-1",
			adapter_type: "codex-tmux",
			status: "running",
			lifecycle_revision: 4,
		};
		body = { generation: 2 };
		row = {
			execution_id: "exec-1",
			activation_id: "activation-1",
			generation: 2,
			owner_token: "owner-1",
			spawn_epoch: 3,
			binding_spawn_epoch: 3,
			binding_digest: "a".repeat(64),
			controller_pid: 100,
			controller_start: "controller-start",
			host_boot_id: "boot-1",
			spawn_inflight: 0,
			restart_in_progress: 0,
			close_requested: 0,
			owner_drained_receipt: null,
		};
		sample = {
			sampledAtMs: clock,
			hostBootId: "boot-1",
			processes: [],
			worker: null,
			daemon: "absent",
			writersComplete: true,
			viewers: [],
		};
		store = {
			getSession: () => session,
			getWorkflowExecutionProcessBody: () => body,
			getWorkflowActor: () => ({ execution_id: "exec-1" }),
			getWorkflowActivation: () => ({ execution_id: "exec-1" }),
			executionProcessOwners: {
				get: () => row,
				getBinding: () => binding,
			},
		};
	});
	function observer(capture = vi.fn(async () => sample)) {
		return createExecutionBodyObserver(store, {
			now: () => clock,
			isEnabled: () => enabled,
			isRecoveryActive: () => recovering,
			sample: capture,
		});
	}
	it.each(["running", "ship_parked", "awaiting_review", "failed", "completed"])(
		"does not let %s override independently absent controller and writers",
		async (status) => {
			session.status = status;
			expect(await observer().observe("exec-1")).toMatchObject({
				verdict: "dead",
				identity: { generation: 2, lifecycleRevision: 4 },
				ownerToken: "owner-1",
				spawnEpoch: 3,
			});
		},
	);
	it("keeps a live worker alive without any window lookup", async () => {
		sample.processes = [
			{
				pid: 200,
				ppid: 1,
				pgid: 200,
				startIdentity: "worker-start",
				state: "running",
			},
		];
		sample.worker = { executable: binding.executable, cwd: binding.cwd };
		sample.daemon = "alive";
		expect(await observer().observe("exec-1")).toMatchObject({
			verdict: "alive",
		});
	});
	it.each([
		"revision",
		"generation",
		"owner",
		"epoch",
		"binding",
		"activation",
	])("discards a sample when %s changes during OS capture", async (field) => {
		const capture = vi.fn(async () => {
			if (field === "revision") session.lifecycle_revision++;
			if (field === "generation") body.generation++;
			if (field === "owner") row.owner_token = "owner-2";
			if (field === "epoch") row.spawn_epoch++;
			if (field === "binding") row.binding_digest = "b".repeat(64);
			if (field === "activation") store.getWorkflowActivation = () => undefined;
			return sample;
		});
		expect(await observer(capture).observe("exec-1")).toMatchObject({
			verdict: "unknown",
		});
	});
	it("checks the runtime switch after capture and again at consumption", async () => {
		const probe = observer(
			vi.fn(async () => {
				enabled = false;
				return sample;
			}),
		);
		expect(await probe.observe("exec-1")).toMatchObject({ verdict: "unknown" });
		enabled = true;
		const current = observer();
		const observation = (await current.observe("exec-1"))!;
		expect(current.isCurrent(observation)).toBe(true);
		enabled = false;
		expect(current.isCurrent(observation)).toBe(false);
	});
	it("does not latch an off switch when enabled later", async () => {
		enabled = false;
		const probe = observer();
		expect(await probe.observe("exec-1")).toMatchObject({ verdict: "unknown" });
		enabled = true;
		expect(await probe.observe("exec-1")).toMatchObject({ verdict: "dead" });
	});
	it.each(["recovery", "restart", "spawn"])(
		"refuses death when %s begins during capture",
		async (kind) => {
			const probe = observer(
				vi.fn(async () => {
					if (kind === "recovery") recovering = true;
					if (kind === "restart") row.restart_in_progress = 1;
					if (kind === "spawn") row.spawn_inflight = 1;
					return sample;
				}),
			);
			expect(await probe.observe("exec-1")).toMatchObject({
				verdict: "unknown",
			});
		},
	);
	it("rejects expiry, new recovery and new spawn at synchronous consumption", async () => {
		const probe = observer();
		const observation = (await probe.observe("exec-1"))!;
		expect(probe.isCurrent(observation)).toBe(true);
		recovering = true;
		expect(probe.isCurrent(observation)).toBe(false);
		recovering = false;
		row.spawn_inflight = 1;
		expect(probe.isCurrent(observation)).toBe(false);
		row.spawn_inflight = 0;
		clock += 10_000;
		expect(probe.isCurrent(observation)).toBe(false);
	});
	it("coalesces only the same in-flight identity, without caching finished observations", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const capture = vi.fn(async () => {
			await gate;
			return sample;
		});
		const probe = observer(capture);
		const first = probe.observe("exec-1");
		const second = probe.observe("exec-1");
		expect(capture).toHaveBeenCalledTimes(1);
		release();
		expect(await first).toEqual(await second);
		await probe.observe("exec-1");
		expect(capture).toHaveBeenCalledTimes(2);
	});
	it("returns unknown for missing bindings and probe failures, never dead", async () => {
		store.executionProcessOwners.getBinding = () => undefined;
		expect(await observer().observe("exec-1")).toMatchObject({
			verdict: "unknown",
		});
		store.executionProcessOwners.getBinding = () => binding;
		expect(
			await observer(
				vi.fn(async () => {
					throw new Error("probe denied");
				}),
			).observe("exec-1"),
		).toMatchObject({ verdict: "unknown" });
	});
});
