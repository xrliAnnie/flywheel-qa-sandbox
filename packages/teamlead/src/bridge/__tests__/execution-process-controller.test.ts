import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterExecutionContext } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { createExecutionProcessOwnerFactory } from "../execution-process-controller.js";

describe("FLY-2919 durable production process owner", () => {
	let store: StateStore;
	let root: string;
	let clock: number;
	const ctx = {
		executionId: "exec-1",
		issueId: "FLY-2919",
		cwd: "/work",
		prompt: "task",
	} as AdapterExecutionContext;
	const controller = {
		pid: 100,
		pgid: 100,
		startIdentity: "controller-start",
		hostBootId: "boot-1",
		executable: "/bin/node",
		cwd: "/bridge",
	};
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
	let sample: any;
	let options: any;
	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "fly2919-controller-"));
		store = await StateStore.create(join(root, "fixture.db"));
		const owners = store.executionProcessOwners;
		vi.spyOn(store, "executionProcessOwners", "get").mockReturnValue(owners);
		store.upsertSession({
			execution_id: ctx.executionId,
			issue_id: ctx.issueId,
			project_name: "fixture",
			status: "running",
		});
		clock = 1000;
		sample = {
			sampledAtMs: clock,
			hostBootId: "boot-1",
			processes: [],
			worker: null,
			daemon: "absent",
			writersComplete: true,
			viewers: [],
		};
		options = {
			now: () => clock,
			nonce: () => "nonce-1",
			readController: async () => controller,
			resolveCwd: async () => "/work",
			resolveExecutable: async () => "/bin/codex",
			bindSpawn: async () => binding,
			sample: async () => ({ ...sample, sampledAtMs: clock }),
			sleep: async (ms: number) => {
				clock += ms;
			},
		};
	});
	afterEach(() => {
		store.close();
		rmSync(root, { recursive: true, force: true });
	});
	const acquire = () =>
		createExecutionProcessOwnerFactory(store, options)(ctx, "owner-1");
	it("registers a controller before allowing a physical spawn and binds each epoch", async () => {
		const lease = await acquire();
		expect(store.executionProcessOwners.get(ctx.executionId)).toMatchObject({
			owner_token: "owner-1",
			spawn_epoch: 0,
			controller_pid: 100,
		});
		expect(lease.authorizeSpawn()).toBe(false);
		await lease.prepareSpawn();
		expect(lease.authorizeSpawn()).toBe(true);
		await lease.acceptSpawn(200);
		expect(store.executionProcessOwners.get(ctx.executionId)).toMatchObject({
			spawn_epoch: 1,
			spawn_inflight: 0,
		});
		expect(await lease.beginRestart()).toBe(true);
		await lease.prepareSpawn();
		await lease.acceptSpawn(200);
		expect(store.executionProcessOwners.get(ctx.executionId)?.spawn_epoch).toBe(
			2,
		);
	});
	it.each(["claude-tmux", "kimi-tmux", "antigravity-tmux"] as const)(
		"binds and drains %s using the same durable owner",
		async (adapter) => {
			options.adapter = adapter;
			options.nativeSessionId =
				adapter === "claude-tmux" ? "native-session" : null;
			options.expectedLeader = () => ({
				pid: 200,
				startIdentity: "worker-start",
				hostBootId: "boot-1",
			});
			options.bindSpawn = vi.fn(async () => ({
				...binding,
				adapter,
				nativeSessionId: options.nativeSessionId,
			}));
			const lease = await acquire();
			await lease.prepareSpawn();
			await lease.acceptSpawn(200);
			expect(options.bindSpawn.mock.calls[0][0]).toMatchObject({
				adapter,
				nativeSessionId: options.nativeSessionId,
				expectedLeader: options.expectedLeader(),
			});
			expect(
				store.executionProcessOwners.getBinding(ctx.executionId)?.adapter,
			).toBe(adapter);
			await lease.finish();
			expect(
				store.executionProcessOwners.get(ctx.executionId)
					?.owner_drained_receipt,
			).toEqual(expect.any(String));
		},
	);
	it.each(["leader", "session", "revision"])(
		"rejects %s changed across native binding",
		async (mode) => {
			options.expectedLeader = () => ({
				pid: 200,
				startIdentity: "worker-start",
				hostBootId: "boot-1",
			});
			const lease = await acquire();
			await lease.prepareSpawn();
			options.bindSpawn = async () => {
				if (mode === "revision")
					store.upsertSession({
						execution_id: ctx.executionId,
						issue_id: ctx.issueId,
						project_name: "fixture",
						status: "failed",
					});
				return {
					...binding,
					...(mode === "leader" ? { pid: 201 } : {}),
					...(mode === "session" ? { nativeSessionId: "foreign" } : {}),
				};
			};
			await expect(lease.acceptSpawn(200)).rejects.toThrow();
			expect(
				store.executionProcessOwners.getBinding(ctx.executionId),
			).toBeUndefined();
		},
	);
	it("samples outside mutation leases and rechecks close after awaited binding", async () => {
		const lease = await acquire();
		await lease.prepareSpawn();
		options.bindSpawn = async () => {
			await lease.close();
			return binding;
		};
		await lease.acceptSpawn(200);
		expect(lease.authorizeSpawn()).toBe(false);
		expect(store.executionProcessOwners.get(ctx.executionId)).toMatchObject({
			close_requested: 1,
			spawn_inflight: 0,
			binding_digest: expect.any(String),
		});
	});
	it("retries temporary lease contention without refusing normal restart", async () => {
		const lease = await acquire();
		await lease.prepareSpawn();
		await lease.acceptSpawn(200);
		const original = store.executionProcessOwners.beginRestart.bind(
			store.executionProcessOwners,
		);
		const retry = vi
			.spyOn(store.executionProcessOwners, "beginRestart")
			.mockReturnValueOnce({ ok: false, reason: "lease_held" })
			.mockReturnValueOnce({ ok: false, reason: "lease_held" })
			.mockImplementation(original);
		expect(await lease.beginRestart()).toBe(true);
		expect(retry).toHaveBeenCalledTimes(3);
	});
	it("keeps lease contention retryable through the mutation lease TTL", async () => {
		const lease = await acquire();
		await lease.prepareSpawn();
		await lease.acceptSpawn(200);
		const original = store.executionProcessOwners.beginRestart.bind(
			store.executionProcessOwners,
		);
		const retry = vi
			.spyOn(store.executionProcessOwners, "beginRestart")
			.mockImplementation((input) =>
				clock < 61_000 ? { ok: false, reason: "lease_held" } : original(input),
			);

		expect(await lease.beginRestart()).toBe(true);
		expect(clock).toBeGreaterThanOrEqual(61_000);
		expect(retry.mock.calls.length).toBeGreaterThan(5);
	});
	it("bounds contention retries and never retries a semantic close refusal", async () => {
		const lease = await acquire();
		await lease.prepareSpawn();
		await lease.acceptSpawn(200);
		const retry = vi
			.spyOn(store.executionProcessOwners, "beginRestart")
			.mockReturnValue({ ok: false, reason: "lease_held" });
		expect(await lease.beginRestart()).toBe(false);
		expect(clock).toBe(61_000);
		expect(retry.mock.calls.length).toBeGreaterThan(5);
		retry.mockClear().mockReturnValue({ ok: false, reason: "close_requested" });
		expect(await lease.beginRestart()).toBe(false);
		expect(retry).toHaveBeenCalledOnce();
	});
	it("records finish only after exact writer absence and replays without resampling", async () => {
		const lease = await acquire();
		await lease.prepareSpawn();
		await lease.acceptSpawn(200);
		await lease.finish();
		const receipt = store.executionProcessOwners.get(
			ctx.executionId,
		)?.owner_drained_receipt;
		expect(receipt).toMatch(/^[a-f0-9]{64}$/);
		clock += 60_000;
		options.sample = async () => {
			throw new Error("already settled");
		};
		await lease.finish();
		expect(
			store.executionProcessOwners.get(ctx.executionId)?.owner_drained_receipt,
		).toBe(receipt);
	});
	it.each(["writer", "unknown", "new_generation"])(
		"refuses %s drain evidence",
		async (kind) => {
			const lease = await acquire();
			await lease.prepareSpawn();
			await lease.acceptSpawn(200);
			if (kind === "writer")
				sample.processes = [
					{
						pid: 300,
						ppid: 1,
						pgid: 200,
						startIdentity: "writer",
						state: "running",
					},
				];
			if (kind === "unknown") sample.writersComplete = false;
			if (kind === "new_generation")
				vi.spyOn(store, "getWorkflowExecutionProcessBody").mockReturnValue({
					generation: 2,
				} as any);
			await expect(lease.finish()).rejects.toThrow();
			expect(
				store.executionProcessOwners.get(ctx.executionId)
					?.owner_drained_receipt,
			).toBeNull();
		},
	);
	it("independently rejects foreign accepted identities before persistence", async () => {
		const lease = await acquire();
		await lease.prepareSpawn();
		options.bindSpawn = async () => ({ ...binding, nonce: "foreign" });
		await expect(lease.acceptSpawn(200)).rejects.toThrow();
		expect(
			store.executionProcessOwners.get(ctx.executionId)?.binding_digest,
		).toBeNull();
	});
	it("closes a controller that never acquired a native spawn permit", async () => {
		const lease = await acquire();
		await lease.finish();
		expect(
			store.executionProcessOwners.get(ctx.executionId)?.owner_drained_receipt,
		).toEqual(expect.any(String));
	});
	it.each(["valid", "expired", "writer", "binding", "dispatch"])(
		"reown checks %s recovery before replacing a controller",
		async (kind) => {
			const first = await acquire();
			await first.prepareSpawn();
			await first.acceptSpawn(200);
			const recovery = store.claimCodexRecovery(
				ctx.executionId,
				store.getLifecycleRevision(ctx.executionId),
				{ holder: "reowner", nowMs: clock, ttlMs: 1000 },
			);
			if (!recovery.ok)
				throw new Error(`fixture recovery refused:${recovery.reason}`);
			if (kind === "expired") clock += 1000;
			if (kind === "writer")
				sample.processes = [
					{
						pid: 300,
						ppid: 1,
						pgid: 200,
						startIdentity: "writer",
						state: "running",
					},
				];
			if (kind === "binding") {
				sample.hostBootId = "other-boot";
				// A reboot sample cannot simultaneously contain the exact identity
				// accepted on the prior boot. Treat that census as contradictory,
				// rather than authorizing a reown from a false death verdict.
				sample.processes = [
					{
						pid: binding.pid,
						ppid: 1,
						pgid: binding.pgid,
						startIdentity: binding.startIdentity,
						state: "running",
					},
				];
			}
			options.readController = async () => ({ ...controller, pid: 101 });
			const next = createExecutionProcessOwnerFactory(store, options)(
				ctx,
				"owner-2",
				kind === "dispatch" ? "dispatch" : "rescue",
			);
			if (kind !== "valid") {
				await expect(next).rejects.toThrow();
				expect(
					store.executionProcessOwners.get(ctx.executionId)?.owner_token,
				).toBe("owner-1");
			} else {
				const lease = await next;
				await lease.prepareSpawn();
				expect(store.executionProcessOwners.get(ctx.executionId)).toMatchObject(
					{ owner_token: "owner-2", spawn_epoch: 2 },
				);
				await lease.acceptSpawn(200);
				expect(store.getCodexRecoveryEpisode(ctx.executionId)?.claimToken).toBe(
					recovery.claimToken,
				);
				expect(
					store.commitCodexRecovery(
						ctx.executionId,
						recovery.claimToken,
						store.getLifecycleRevision(ctx.executionId),
						{ nowMs: clock, observedTurnHolder: ctx.executionId },
					).ok,
				).toBe(true);
				expect(await lease.beginRestart()).toBe(true);
				await lease.prepareSpawn();
				expect(
					store.executionProcessOwners.get(ctx.executionId)?.spawn_epoch,
				).toBe(3);
			}
		},
	);
	it("allows a later rescue after a pre-spawn rescue failure drained an unbound owner", async () => {
		const first = await acquire();
		await first.prepareSpawn();
		await first.acceptSpawn(200);
		const revision = store.getLifecycleRevision(ctx.executionId);
		const initialRecovery = store.claimCodexRecovery(
			ctx.executionId,
			revision,
			{
				holder: "reowner",
				nowMs: clock,
				ttlMs: 1_000,
			},
		);
		if (!initialRecovery.ok) throw new Error("initial recovery claim refused");
		options.readController = async () => ({ ...controller, pid: 101 });
		const failedRescue = await createExecutionProcessOwnerFactory(
			store,
			options,
		)(ctx, "owner-2", "rescue");
		await failedRescue.finish();
		expect(store.executionProcessOwners.get(ctx.executionId)).toMatchObject({
			owner_token: "owner-2",
			binding_json: null,
			owner_drained_receipt: expect.any(String),
		});
		expect(
			store.abortCodexRecovery(ctx.executionId, initialRecovery.claimToken),
		).toBe(true);
		clock += 1;
		const retryRecovery = store.claimCodexRecovery(ctx.executionId, revision, {
			holder: "reowner",
			nowMs: clock,
			ttlMs: 1_000,
		});
		if (!retryRecovery.ok) throw new Error("retry recovery claim refused");
		options.readController = async () => ({ ...controller, pid: 102 });
		await expect(
			createExecutionProcessOwnerFactory(store, options)(
				ctx,
				"owner-3",
				"rescue",
			),
		).resolves.toBeDefined();
	});
	it.each(["no_child", "binding_failed", "writers_unknown", "previous_writer"])(
		"settles %s only after independent failed-spawn absence",
		async (mode) => {
			options.pendingAbsence = async (pending: any) => ({
				...pending,
				observedAtMs: clock,
				expiresAtMs: clock + 10000,
			});
			const lease = await acquire();
			await lease.prepareSpawn();
			if (mode === "previous_writer") {
				await lease.acceptSpawn(200);
				await lease.beginRestart();
				await lease.prepareSpawn();
				sample.processes = [
					{
						pid: 300,
						ppid: 1,
						pgid: 200,
						startIdentity: "writer",
						state: "running",
					},
				];
			}
			if (mode === "binding_failed") {
				options.bindSpawn = async () => null;
				await expect(lease.acceptSpawn(200)).rejects.toThrow(
					"process_spawn_identity_unavailable",
				);
			}
			if (mode === "writers_unknown") options.pendingAbsence = async () => null;
			if (mode === "writers_unknown" || mode === "previous_writer") {
				await expect(lease.finish()).rejects.toThrow(
					"process_drain_unconfirmed",
				);
				expect(store.executionProcessOwners.get(ctx.executionId)).toMatchObject(
					{ spawn_inflight: 1, owner_drained_receipt: null },
				);
			} else {
				await lease.finish();
				expect(store.executionProcessOwners.get(ctx.executionId)).toMatchObject(
					{
						spawn_inflight: 0,
						spawn_nonce: "nonce-1",
						pending_pgid: mode === "binding_failed" ? 200 : null,
						owner_drained_receipt: expect.any(String),
					},
				);
			}
		},
	);
	it.each(["accepted", "pending"])(
		"fences a lifecycle revision changed during %s drain sampling",
		async (mode) => {
			const lease = await acquire();
			await lease.prepareSpawn();
			if (mode === "accepted") await lease.acceptSpawn(200);
			const change = () =>
				store.upsertSession({
					execution_id: ctx.executionId,
					issue_id: ctx.issueId,
					project_name: "fixture",
					status: "failed",
				});
			options.sample = async () => {
				change();
				return { ...sample, sampledAtMs: clock };
			};
			options.pendingAbsence = async (pending: any) => {
				change();
				return { ...pending, observedAtMs: clock, expiresAtMs: clock + 10000 };
			};
			await expect(lease.finish()).rejects.toThrow("stale_revision");
			expect(
				store.executionProcessOwners.get(ctx.executionId)
					?.owner_drained_receipt,
			).toBeNull();
		},
	);
});
