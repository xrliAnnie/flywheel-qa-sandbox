import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const T0 = "2026-08-17T20:00:00.000Z";
const T1 = "2026-08-17T20:01:00.000Z";
const T2 = "2026-08-17T20:02:00.000Z";

async function fixture() {
	const store = await StateStore.create(":memory:");
	const operation = store.ensureLandOperation({
		runId: "run-1",
		issueId: "FLY-1833",
		projectName: "flywheel",
		prNumber: 900,
		approvedHead: HEAD_A,
		now: T0,
	});
	const claim = store.claimLandOperation({
		operationId: operation.operation_id,
		ownerId: "worker-a",
		now: T0,
		leaseExpiresAt: "2026-08-17T21:00:00.000Z",
	});
	if (!claim) throw new Error("fixture claim missing");
	return {
		store,
		operation: store.getLandOperation(operation.operation_id)!,
		claim,
	};
}

describe("land recovery episode", () => {
	it("keeps one open horizon across operation generations", async () => {
		const { store, operation } = await fixture();
		try {
			const first = store.openLandRecoveryEpisode({
				runId: "run-1",
				rootApprovalRef: "founder-claim-1",
				kind: "alignment",
				currentOperationId: operation.operation_id,
				firstObservedAt: T0,
				lastProbeAt: T0,
				nextProbeAt: T1,
			});
			const successor = store.ensureLandOperation({
				runId: "run-1",
				issueId: "FLY-1833",
				projectName: "flywheel",
				prNumber: 900,
				approvedHead: HEAD_B,
				now: T1,
			});
			const replay = store.openLandRecoveryEpisode({
				runId: "run-1",
				rootApprovalRef: "founder-claim-1",
				kind: "alignment",
				currentOperationId: successor.operation_id,
				firstObservedAt: T1,
				lastProbeAt: T1,
				nextProbeAt: T2,
			});

			expect(replay.episode_id).toBe(first.episode_id);
			expect(replay.first_observed_at).toBe(T0);
			expect(replay.current_operation_id).toBe(successor.operation_id);
			expect(replay.next_probe_at).toBe(T2);
		} finally {
			store.close();
		}
	});

	it("enforces one open no-scope episode at the SQLite boundary", async () => {
		const { store, operation } = await fixture();
		try {
			store.openLandRecoveryEpisode({
				runId: "run-1",
				rootApprovalRef: "founder-claim-1",
				kind: "outage",
				currentOperationId: operation.operation_id,
				firstObservedAt: T0,
				lastProbeAt: T0,
				nextProbeAt: T1,
			});
			const db = (
				store as unknown as {
					db: { run(sql: string, params?: unknown[]): void };
				}
			).db;
			expect(() =>
				db.run(
					`INSERT INTO land_recovery_episode
					   (episode_id, run_id, root_approval_ref, kind, scope_key,
					    current_operation_id, first_observed_at, last_probe_at,
					    next_probe_at, state)
					 VALUES ('duplicate', 'run-1', 'founder-claim-1', 'outage', '',
					         ?, ?, ?, ?, 'open')`,
					[operation.operation_id, T0, T0, T1],
				),
			).toThrow();
		} finally {
			store.close();
		}
	});

	it("closes an episode without erasing its audit history", async () => {
		const { store, operation } = await fixture();
		try {
			const episode = store.openLandRecoveryEpisode({
				runId: "run-1",
				rootApprovalRef: "founder-claim-1",
				kind: "conflict",
				currentOperationId: operation.operation_id,
				firstObservedAt: T0,
				lastProbeAt: T0,
				nextProbeAt: T1,
			});
			expect(
				store.closeLandRecoveryEpisode({
					episodeId: episode.episode_id,
					closedReason: "tier2_rework_opened",
					now: T1,
				}),
			).toBe(true);
			expect(store.getLandRecoveryEpisode(episode.episode_id)).toMatchObject({
				state: "closed",
				closed_reason: "tier2_rework_opened",
			});
			expect(
				store.getOpenLandRecoveryEpisode({
					runId: "run-1",
					rootApprovalRef: "founder-claim-1",
					kind: "conflict",
				}),
			).toBeUndefined();
		} finally {
			store.close();
		}
	});
});

describe("land operation generations", () => {
	it("atomically supersedes the old head and fences every stale writer", async () => {
		const { store, operation, claim } = await fixture();
		try {
			const superseded = store.supersedeLandOperation({
				operationId: operation.operation_id,
				ownerId: claim.ownerId,
				generation: claim.generation,
				nextApprovedHead: HEAD_B,
				reason: "head_refresh_equivalent",
				now: T1,
			});
			expect(superseded).toMatchObject({ ok: true, idempotentReplay: false });
			if (!superseded.ok) throw new Error(superseded.reason);

			const old = store.getLandOperation(operation.operation_id)!;
			const next = store.getLandOperation(superseded.operation.operation_id)!;
			expect(old).toMatchObject({
				superseded_at: T1,
				superseded_by_operation_id: next.operation_id,
				owner_id: null,
				lease_expires_at: null,
				generation: claim.generation + 1,
			});
			expect(next).toMatchObject({
				approved_head: HEAD_B,
				state: "intent",
				superseded_at: null,
			});
			expect(store.listLandOperationSteps(operation.operation_id)).toEqual([
				expect.objectContaining({
					step: "superseded",
					generation: claim.generation,
					receipt: {
						nextApprovedHead: HEAD_B,
						nextOperationId: next.operation_id,
						reason: "head_refresh_equivalent",
					},
				}),
			]);

			expect(
				store.recordLandOperationStep({
					operationId: operation.operation_id,
					ownerId: claim.ownerId,
					generation: claim.generation,
					step: "merge_confirmed",
					receipt: { headSha: HEAD_A },
					now: T2,
				}),
			).toEqual({ ok: false, reason: "stale_land_generation" });
			expect(
				store.recordLandOperationStep({
					operationId: operation.operation_id,
					ownerId: claim.ownerId,
					generation: claim.generation,
					step: "superseded",
					receipt: {
						nextApprovedHead: HEAD_B,
						nextOperationId: next.operation_id,
						reason: "head_refresh_equivalent",
					},
					now: T2,
				}),
			).toEqual({ ok: false, reason: "stale_land_generation" });
			expect(
				store.releaseLandOperationWithRetryAccounting({
					operationId: operation.operation_id,
					ownerId: claim.ownerId,
					generation: claim.generation,
					class: "waiting",
					reason: "ship_workflow_pending",
					now: T2,
				}),
			).toBeUndefined();
			expect(
				store.setLandOperationDisposition({
					operationId: operation.operation_id,
					ownerId: claim.ownerId,
					generation: claim.generation,
					state: "held",
					error: "late_writer",
					now: T2,
				}),
			).toBe(false);
			expect(
				store.recordLandLinearDoneDisposition({
					operationId: operation.operation_id,
					ownerId: claim.ownerId,
					generation: claim.generation,
					disposition: "done",
					reason: "late_writer",
					executionId: "land-exec",
					now: T2,
				}),
			).toEqual({ ok: false, reason: "stale_land_generation" });

			expect(store.getLandOperationForRun("run-1", HEAD_B)?.operation_id).toBe(
				next.operation_id,
			);
			expect(
				store.listRunnableLandOperations(T2).map((row) => row.operation_id),
			).toEqual([next.operation_id]);
		} finally {
			store.close();
		}
	});

	it("replays the same supersede intent without creating another generation", async () => {
		const { store, operation, claim } = await fixture();
		try {
			const first = store.supersedeLandOperation({
				operationId: operation.operation_id,
				ownerId: claim.ownerId,
				generation: claim.generation,
				nextApprovedHead: HEAD_B,
				reason: "head_refresh_equivalent",
				now: T1,
			});
			const replay = store.supersedeLandOperation({
				operationId: operation.operation_id,
				ownerId: claim.ownerId,
				generation: claim.generation,
				nextApprovedHead: HEAD_B,
				reason: "head_refresh_equivalent",
				now: T1,
			});
			const conflict = store.supersedeLandOperation({
				operationId: operation.operation_id,
				ownerId: claim.ownerId,
				generation: claim.generation,
				nextApprovedHead: HEAD_B,
				reason: "different_reason",
				now: T1,
			});
			expect(first.ok).toBe(true);
			expect(replay).toMatchObject({ ok: true, idempotentReplay: true });
			expect(conflict).toEqual({
				ok: false,
				reason: "land_supersede_receipt_conflict",
			});
			expect(store.getLandOperation(operation.operation_id)?.generation).toBe(
				claim.generation + 1,
			);
		} finally {
			store.close();
		}
	});
});
