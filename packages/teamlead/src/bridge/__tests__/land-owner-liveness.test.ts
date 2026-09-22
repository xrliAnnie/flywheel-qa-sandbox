import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { executeLandOperation } from "../land-executor.js";
import {
	LAND_OWNER_DEADLINE_MS,
	LandOwnerLivenessMonitor,
	runLandOwnerLivenessPass,
} from "../land-owner-liveness.js";

const HEAD = "a".repeat(40);
const OWNER = {
	ownerId: "land-engine:36302",
	ownerInstanceId: "11111111-1111-4111-8111-111111111111",
	ownerPid: 36302,
	ownerProcessStart: "Tue Sep 16 02:49:51 2026",
	ownerHostBootId: "host-boot-1",
};

async function fixture() {
	const store = await StateStore.create(":memory:");
	const operation = store.ensureLandOperation({
		issueId: "issue-2616",
		projectName: "flywheel",
		prNumber: 2616,
		approvedHead: HEAD,
		now: "2026-09-16T02:49:50.000Z",
	});
	return { store, operation };
}

describe("FLY-2616 land owner liveness", () => {
	it("keeps the default lease wide enough for multi-minute land effects", () => {
		expect(LAND_OWNER_DEADLINE_MS).toBeGreaterThanOrEqual(5 * 60_000);
	});

	it("renews a live owner while a long finalization await is in flight", async () => {
		vi.useFakeTimers({ now: new Date("2026-09-16T02:49:51.000Z") });
		const { store, operation } = await fixture();
		let finishFinalization:
			| ((value: {
					complete: false;
					outcome: "partial";
					reason: string;
			  }) => void)
			| undefined;
		const finalize = vi.fn(
			() =>
				new Promise<{
					complete: false;
					outcome: "partial";
					reason: string;
				}>((resolve) => {
					finishFinalization = resolve;
				}),
		);
		try {
			const execution = executeLandOperation(operation.operation_id, {
				store,
				mergeDriver: {
					inspectPr: async () => ({ state: "MERGED", headSha: HEAD }),
					triggerCool: vi.fn(),
					inspectTriggeredWorkflow: vi.fn(),
				},
				authorize: () => ({ ok: true }),
				finalize,
				leaseMs: 200,
				ownerHeartbeatMs: 100,
			});
			for (let attempt = 0; attempt < 20 && !finishFinalization; attempt += 1) {
				await Promise.resolve();
			}
			expect(finalize).toHaveBeenCalledOnce();
			const before = store.getLandOperation(operation.operation_id)!;
			expect(before.owner_heartbeat_at).toBe("2026-09-16T02:49:51.000Z");

			await vi.advanceTimersByTimeAsync(100);
			const renewed = store.getLandOperation(operation.operation_id)!;
			expect(renewed.owner_heartbeat_at).toBe("2026-09-16T02:49:51.100Z");
			expect(renewed.lease_expires_at).toBe("2026-09-16T02:49:51.300Z");
			finishFinalization?.({
				complete: false,
				outcome: "partial",
				reason: "ship_workflow_pending",
			});
			await expect(execution).resolves.toMatchObject({ status: "partial" });
		} finally {
			store.close();
			vi.useRealTimers();
		}
	});

	it("renews an operation as one exact owner tuple", async () => {
		const { store, operation } = await fixture();
		try {
			const claim = store.claimLandOperation({
				operationId: operation.operation_id,
				...OWNER,
				now: "2026-09-16T02:49:51.000Z",
				leaseExpiresAt: "2026-09-16T02:50:11.000Z",
			});
			expect(claim).toMatchObject({
				operationId: operation.operation_id,
				ownerInstanceId: OWNER.ownerInstanceId,
			});
			if (!claim) return;

			expect(
				store.renewLandOperationOwner({
					claim,
					identity: OWNER,
					now: "2026-09-16T02:50:00.000Z",
					leaseExpiresAt: "2026-09-16T02:50:20.000Z",
				}),
			).toBe(true);
			expect(store.getLandOperation(operation.operation_id)).toMatchObject({
				owner_instance_id: OWNER.ownerInstanceId,
				owner_pid: OWNER.ownerPid,
				owner_process_start: OWNER.ownerProcessStart,
				owner_host_boot_id: OWNER.ownerHostBootId,
				owner_heartbeat_at: "2026-09-16T02:50:00.000Z",
				lease_expires_at: "2026-09-16T02:50:20.000Z",
			});
		} finally {
			store.close();
		}
	});

	it("queues one durable health episode for a live owner without progress", async () => {
		const { store, operation } = await fixture();
		try {
			const claim = store.claimLandOperation({
				operationId: operation.operation_id,
				...OWNER,
				now: "2026-09-16T02:49:51.000Z",
				leaseExpiresAt: "2026-09-16T04:49:51.000Z",
			});
			if (!claim) throw new Error("claim missing");

			const first = await runLandOwnerLivenessPass(store, {
				now: () => new Date("2026-09-16T02:54:51.000Z"),
				hostBootId: OWNER.ownerHostBootId,
				probeProcessTuple: () => "alive",
			});
			const replay = await runLandOwnerLivenessPass(store, {
				now: () => new Date("2026-09-16T02:54:52.000Z"),
				hostBootId: OWNER.ownerHostBootId,
				probeProcessTuple: () => "alive",
			});

			expect(first).toEqual({
				reclaimed: [],
				unresolved: [],
				stalled: [operation.operation_id],
			});
			expect(replay).toEqual({ reclaimed: [], unresolved: [], stalled: [] });
			expect(store.listLandOwnerHealthOutbox()).toHaveLength(1);

			expect(
				store.recordLandOperationStep({
					operationId: operation.operation_id,
					ownerId: claim.ownerId,
					ownerInstanceId: claim.ownerInstanceId,
					generation: claim.generation,
					step: "merge_confirmed",
					receipt: { headSha: HEAD },
					now: "2026-09-16T02:55:00.000Z",
				}),
			).toMatchObject({ ok: true });
			expect(store.listLandOwnerHealthOutbox()[0]).toMatchObject({
				state: "resolved",
				resolved_at: "2026-09-16T02:55:00.000Z",
			});

			const nextEpisode = await runLandOwnerLivenessPass(store, {
				now: () => new Date("2026-09-16T03:00:00.000Z"),
				hostBootId: OWNER.ownerHostBootId,
				probeProcessTuple: () => "alive",
			});
			expect(nextEpisode.stalled).toEqual([operation.operation_id]);
			expect(store.listLandOwnerHealthOutbox()).toHaveLength(2);
		} finally {
			store.close();
		}
	});

	it("reclaims a positively dead owner immediately and fences every old write", async () => {
		const { store, operation } = await fixture();
		try {
			const claim = store.claimLandOperation({
				operationId: operation.operation_id,
				...OWNER,
				now: "2026-09-16T02:49:51.000Z",
				leaseExpiresAt: "2026-09-16T03:49:51.000Z",
			});
			if (!claim) throw new Error("claim missing");
			const onReclaimed = vi.fn();

			const result = await runLandOwnerLivenessPass(store, {
				now: () => new Date("2026-09-16T02:49:53.000Z"),
				hostBootId: OWNER.ownerHostBootId,
				probeProcessTuple: () => "dead",
				probeLegacyPid: () => "unknown",
				onReclaimed,
			});

			expect(result).toMatchObject({ reclaimed: [operation.operation_id] });
			expect(onReclaimed).toHaveBeenCalledWith(
				expect.objectContaining({ operationId: operation.operation_id }),
			);
			const reclaimed = store.getLandOperation(operation.operation_id)!;
			expect(reclaimed).toMatchObject({
				state: "partial",
				owner_id: null,
				owner_instance_id: null,
				lease_expires_at: null,
				last_error: "lease_lost:process_absent",
				retry_count: 0,
			});
			expect(reclaimed.generation).toBe(claim.generation + 1);
			expect(
				store.renewLandOperationOwner({
					claim,
					identity: OWNER,
					now: "2026-09-16T02:49:54.000Z",
					leaseExpiresAt: "2026-09-16T02:50:14.000Z",
				}),
			).toBe(false);
			expect(
				store.recordLandOperationStep({
					operationId: operation.operation_id,
					ownerId: claim.ownerId,
					generation: claim.generation,
					step: "stale-effect",
					receipt: { stale: true },
					now: "2026-09-16T02:49:54.000Z",
				}),
			).toEqual({ ok: false, reason: "stale_land_generation" });
			expect(
				store.releaseLandOperationWithRetryAccounting({
					operationId: operation.operation_id,
					ownerId: claim.ownerId,
					generation: claim.generation,
					class: "retryable",
					reason: "late_failure",
					now: "2026-09-16T02:49:54.000Z",
				}),
			).toBeUndefined();
			const successor = store.claimLandOperation({
				operationId: operation.operation_id,
				ownerId: "land-engine:40000",
				ownerInstanceId: "22222222-2222-4222-8222-222222222222",
				ownerPid: 40000,
				ownerProcessStart: "Tue Sep 16 02:49:54 2026",
				ownerHostBootId: OWNER.ownerHostBootId,
				now: "2026-09-16T02:49:55.000Z",
				leaseExpiresAt: "2026-09-16T02:50:15.000Z",
			});
			expect(successor).toBeDefined();
			expect(
				store
					.listLandOperationSteps(operation.operation_id)
					.some((step) => step.step.startsWith("aux:land_owner_reclaimed:")),
			).toBe(true);
		} finally {
			store.close();
		}
	});

	it("reclaims a legacy land-engine pid only on positive absence", async () => {
		const { store, operation } = await fixture();
		try {
			store.claimLandOperation({
				operationId: operation.operation_id,
				ownerId: "land-engine:36302",
				now: "2026-09-16T02:49:51.000Z",
				leaseExpiresAt: "2026-09-16T03:49:51.000Z",
			});
			const unknown = await runLandOwnerLivenessPass(store, {
				now: () => new Date("2026-09-16T02:49:52.000Z"),
				hostBootId: OWNER.ownerHostBootId,
				probeLegacyPid: () => "unknown",
			});
			expect(unknown).toMatchObject({
				reclaimed: [],
				unresolved: [operation.operation_id],
			});

			const dead = await runLandOwnerLivenessPass(store, {
				now: () => new Date("2026-09-16T02:49:53.000Z"),
				hostBootId: OWNER.ownerHostBootId,
				probeLegacyPid: () => "dead",
			});
			expect(dead.reclaimed).toEqual([operation.operation_id]);
			expect(store.getLandOperation(operation.operation_id)).toMatchObject({
				state: "partial",
				last_error: "lease_lost:legacy_process_absent",
				retry_count: 0,
			});
		} finally {
			store.close();
		}
	});

	it("keeps sensor errors before the deadline but fences an expired lease", async () => {
		const { store, operation } = await fixture();
		try {
			store.claimLandOperation({
				operationId: operation.operation_id,
				...OWNER,
				now: "2026-09-16T02:49:51.000Z",
				leaseExpiresAt: "2026-09-16T02:50:11.000Z",
			});
			const unknown = await runLandOwnerLivenessPass(store, {
				now: () => new Date("2026-09-16T02:50:00.000Z"),
				hostBootId: OWNER.ownerHostBootId,
				probeProcessTuple: () => "unknown",
				probeLegacyPid: () => "unknown",
			});
			expect(unknown.reclaimed).toEqual([]);
			expect(store.getLandOperation(operation.operation_id)?.state).toBe(
				"running",
			);

			const expired = await runLandOwnerLivenessPass(store, {
				now: () => new Date("2026-09-16T02:50:12.000Z"),
				hostBootId: OWNER.ownerHostBootId,
				probeProcessTuple: () => "unknown",
				probeLegacyPid: () => "unknown",
			});
			expect(expired).toMatchObject({ reclaimed: [operation.operation_id] });
			expect(store.getLandOperation(operation.operation_id)).toMatchObject({
				state: "partial",
				last_error: "lease_lost:deadline_expired",
				retry_count: 0,
			});
		} finally {
			store.close();
		}
	});

	it("treats a placeholder process start as unknown until its deadline", async () => {
		const { store, operation } = await fixture();
		try {
			store.claimLandOperation({
				operationId: operation.operation_id,
				...OWNER,
				ownerProcessStart: "bridge-process-start:placeholder",
				now: "2026-09-16T02:49:51.000Z",
				leaseExpiresAt: "2026-09-16T02:50:11.000Z",
			});
			const probeProcessTuple = vi.fn(() => "identity_mismatch" as const);

			const unresolved = await runLandOwnerLivenessPass(store, {
				now: () => new Date("2026-09-16T02:50:00.000Z"),
				hostBootId: OWNER.ownerHostBootId,
				probeProcessTuple,
			});

			expect(unresolved).toEqual({
				reclaimed: [],
				unresolved: [operation.operation_id],
				stalled: [],
			});
			expect(probeProcessTuple).not.toHaveBeenCalled();
			expect(store.getLandOperation(operation.operation_id)?.state).toBe(
				"running",
			);

			const expired = await runLandOwnerLivenessPass(store, {
				now: () => new Date("2026-09-16T02:50:12.000Z"),
				hostBootId: OWNER.ownerHostBootId,
				probeProcessTuple,
			});
			expect(expired).toEqual({
				reclaimed: [operation.operation_id],
				unresolved: [],
				stalled: [],
			});
			expect(store.getLandOperation(operation.operation_id)).toMatchObject({
				state: "partial",
				last_error: "lease_lost:deadline_expired",
			});
		} finally {
			store.close();
		}
	});

	it("waits for an in-flight liveness tick when stopping", async () => {
		const { store, operation } = await fixture();
		let finishProbe: ((state: "alive") => void) | undefined;
		const probeStarted = vi.fn();
		store.claimLandOperation({
			operationId: operation.operation_id,
			...OWNER,
			now: "2026-09-16T02:49:51.000Z",
			leaseExpiresAt: "2026-09-16T03:49:51.000Z",
		});
		const monitor = new LandOwnerLivenessMonitor(store, {
			now: () => new Date("2026-09-16T02:49:53.000Z"),
			hostBootId: OWNER.ownerHostBootId,
			probeProcessTuple: () => {
				probeStarted();
				return new Promise<"alive">((resolve) => {
					finishProbe = resolve;
				});
			},
		});
		try {
			monitor.start();
			await vi.waitFor(() => expect(probeStarted).toHaveBeenCalledOnce());

			let stopped = false;
			const stopping = Promise.resolve(monitor.stop()).then(() => {
				stopped = true;
			});
			await Promise.resolve();
			expect(stopped).toBe(false);

			finishProbe?.("alive");
			await stopping;
			expect(stopped).toBe(true);
		} finally {
			finishProbe?.("alive");
			await monitor.stop();
			store.close();
		}
	});

	it("reports a rejected liveness tick without an unhandled rejection", async () => {
		const { store, operation } = await fixture();
		const failure = new Error("process probe failed");
		const onError = vi.fn();
		store.claimLandOperation({
			operationId: operation.operation_id,
			...OWNER,
			now: "2026-09-16T02:49:51.000Z",
			leaseExpiresAt: "2026-09-16T03:49:51.000Z",
		});
		const monitor = new LandOwnerLivenessMonitor(store, {
			now: () => new Date("2026-09-16T02:49:53.000Z"),
			hostBootId: OWNER.ownerHostBootId,
			probeProcessTuple: () => Promise.reject(failure),
			onError,
		});
		try {
			monitor.start();
			await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure));
		} finally {
			await monitor.stop();
			store.close();
		}
	});
});
