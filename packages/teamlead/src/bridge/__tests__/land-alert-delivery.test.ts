import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { WorkflowEngineDispatcher } from "../workflow-engine-dispatcher.js";

const HEAD = "a".repeat(40);

describe("legacy land held alert delivery", () => {
	it("retries one held episode with a stable transport identity", async () => {
		const store = await StateStore.create(":memory:");
		const operation = store.ensureLandOperation({
			issueId: "FLY-1861",
			projectName: "flywheel",
			prNumber: 1861,
			approvedHead: HEAD,
			now: "2026-08-18T00:00:00.000Z",
		});
		const claim = store.claimLandOperation({
			operationId: operation.operation_id,
			ownerId: "land-worker",
			now: "2026-08-18T00:00:01.000Z",
			leaseExpiresAt: "2026-08-18T00:10:01.000Z",
		})!;
		store.releaseLandOperationWithRetryAccounting({
			operationId: operation.operation_id,
			ownerId: claim.ownerId,
			generation: claim.generation,
			class: "terminal",
			reason: "ship_workflow_failed:ci_failure",
			now: "2026-08-18T00:00:02.000Z",
		});

		const alert = vi
			.fn()
			.mockResolvedValueOnce({ skipped: "transport_unavailable" })
			.mockImplementationOnce(async (payload) => {
				store.recordAlertDeliveryReceipt(
					payload.eventId,
					"sent",
					"2026-08-18T00:00:04.000Z",
				);
				return { sent: true };
			});
		let tick = 3;
		const clockBase = Date.parse("2026-08-18T00:00:00.000Z");
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: {} as never,
			alertSink: { current: { alert } },
			now: () => new Date(clockBase + tick++ * 1_000),
			resolveRunAlertIdentity: (projectName) => ({
				leadId: "flywheel-eng-lead",
				projectName,
				leadResolution: "resolved",
			}),
		});

		await expect(dispatcher.reconcileWorkflowEngineAlerts(1)).resolves.toBe(1);
		expect(store.listLandAlertOutbox()[0]).toMatchObject({
			state: "pending",
			attempt: 1,
		});
		await expect(dispatcher.reconcileWorkflowEngineAlerts(1)).resolves.toBe(1);
		expect(store.listLandAlertOutbox()[0]).toMatchObject({
			state: "sent",
			attempt: 2,
		});
		expect(alert.mock.calls.map(([payload]) => payload.eventId)).toEqual([
			`land-held:${operation.operation_id}:0`,
			`land-held:${operation.operation_id}:0`,
		]);
		expect(alert.mock.calls[0]?.[0].body).toContain(
			`POST /api/lifecycle/land/${operation.operation_id}/resume`,
		);

		const closeout = store.ensureLandOperation({
			issueId: "FLY-2616",
			projectName: "flywheel",
			prNumber: 2616,
			approvedHead: HEAD,
			now: "2026-08-18T00:00:05.000Z",
		});
		const closeoutClaim = store.claimLandOperation({
			operationId: closeout.operation_id,
			ownerId: "closeout-worker",
			now: "2026-08-18T00:00:06.000Z",
			leaseExpiresAt: "2026-08-18T00:10:06.000Z",
		})!;
		store.recordLandOperationStep({
			operationId: closeout.operation_id,
			ownerId: closeoutClaim.ownerId,
			generation: closeoutClaim.generation,
			step: "merge_confirmed",
			receipt: { headSha: HEAD, mergeSha: "b".repeat(40) },
			now: "2026-08-18T00:00:07.000Z",
		});
		store.releaseLandOperationWithRetryAccounting({
			operationId: closeout.operation_id,
			ownerId: closeoutClaim.ownerId,
			generation: closeoutClaim.generation,
			class: "terminal",
			reason: "retry_exhausted:issue_closeout_incomplete",
			now: "2026-08-18T00:00:08.000Z",
		});
		alert.mockImplementationOnce(async (payload) => {
			store.recordAlertDeliveryReceipt(
				payload.eventId,
				"sent",
				"2026-08-18T00:00:09.000Z",
			);
			return { sent: true };
		});
		await expect(dispatcher.reconcileWorkflowEngineAlerts(1)).resolves.toBe(1);
		expect(alert.mock.calls.at(-1)?.[0].body).toContain(
			`flywheel-comm land reclose --operation ${closeout.operation_id} --expected-generation 0 --expected-head ${HEAD}`,
		);
		store.close();
	});

	it("requires a durable delivery receipt before settling the outbox", async () => {
		const store = await StateStore.create(":memory:");
		const operation = store.ensureLandOperation({
			issueId: "FLY-2778",
			projectName: "flywheel",
			prNumber: 2778,
			approvedHead: HEAD,
			now: "2026-08-18T01:00:00.000Z",
		});
		const claim = store.claimLandOperation({
			operationId: operation.operation_id,
			ownerId: "land-worker",
			now: "2026-08-18T01:00:01.000Z",
			leaseExpiresAt: "2026-08-18T01:10:01.000Z",
		})!;
		store.releaseLandOperationWithRetryAccounting({
			operationId: operation.operation_id,
			ownerId: claim.ownerId,
			generation: claim.generation,
			class: "terminal",
			reason: "retry_exhausted:issue_closeout_incomplete",
			now: "2026-08-18T01:00:02.000Z",
		});
		const alert = vi.fn(async () => ({ sent: true }));
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: {} as never,
			alertSink: { current: { alert } },
			now: () => new Date("2026-08-18T01:00:03.000Z"),
			resolveRunAlertIdentity: (projectName) => ({
				leadId: "flywheel-eng-lead",
				projectName,
				leadResolution: "resolved",
			}),
		});

		await expect(dispatcher.reconcileWorkflowEngineAlerts(1)).resolves.toBe(1);
		expect(alert).toHaveBeenCalledOnce();
		expect(store.listLandAlertOutbox()[0]).toMatchObject({
			state: "pending",
			attempt: 1,
		});
		store.recordAlertDeliveryReceipt(
			`land-held:${operation.operation_id}:0`,
			"deadlettered_durable",
			"2026-08-18T01:00:04.000Z",
		);
		await expect(dispatcher.reconcileWorkflowEngineAlerts(1)).resolves.toBe(1);
		expect(store.listLandAlertOutbox()[0]).toMatchObject({
			state: "pending",
			attempt: 2,
			last_error: "delivery_receipt_deadlettered_durable",
		});
		await expect(dispatcher.reconcileWorkflowEngineAlerts(1)).resolves.toBe(1);
		expect(alert).toHaveBeenCalledOnce();
		expect(store.listLandAlertOutbox()[0]).toMatchObject({
			state: "failed",
			attempt: 3,
			last_error: "delivery_receipt_deadlettered_durable",
		});
		store.close();
	});

	it("settles an existing queued receipt without sending again", async () => {
		const store = await StateStore.create(":memory:");
		const operation = store.ensureLandOperation({
			issueId: "FLY-2778",
			projectName: "flywheel",
			prNumber: 2778,
			approvedHead: HEAD,
			now: "2026-08-18T02:00:00.000Z",
		});
		const claim = store.claimLandOperation({
			operationId: operation.operation_id,
			ownerId: "land-worker",
			now: "2026-08-18T02:00:01.000Z",
			leaseExpiresAt: "2026-08-18T02:10:01.000Z",
		})!;
		store.releaseLandOperationWithRetryAccounting({
			operationId: operation.operation_id,
			ownerId: claim.ownerId,
			generation: claim.generation,
			class: "terminal",
			reason: "retry_exhausted:issue_closeout_incomplete",
			now: "2026-08-18T02:00:02.000Z",
		});
		store.recordAlertDeliveryReceipt(
			`land-held:${operation.operation_id}:0`,
			"queued_durable",
			"2026-08-18T02:00:03.000Z",
		);
		const alert = vi.fn();
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: {} as never,
			alertSink: { current: { alert } },
			now: () => new Date("2026-08-18T02:00:04.000Z"),
			resolveRunAlertIdentity: (projectName) => ({
				leadId: "flywheel-eng-lead",
				projectName,
				leadResolution: "resolved",
			}),
		});

		await expect(dispatcher.reconcileWorkflowEngineAlerts(1)).resolves.toBe(1);
		expect(alert).not.toHaveBeenCalled();
		expect(store.listLandAlertOutbox()[0]).toMatchObject({ state: "sent" });
		store.close();
	});

	it("waits out the ambiguous fence before replaying with the same identity", async () => {
		const store = await StateStore.create(":memory:");
		const operation = store.ensureLandOperation({
			issueId: "FLY-2778",
			projectName: "flywheel",
			prNumber: 2778,
			approvedHead: HEAD,
			now: "2026-08-18T03:00:00.000Z",
		});
		const claim = store.claimLandOperation({
			operationId: operation.operation_id,
			ownerId: "land-worker",
			now: "2026-08-18T03:00:01.000Z",
			leaseExpiresAt: "2026-08-18T03:10:01.000Z",
		})!;
		store.releaseLandOperationWithRetryAccounting({
			operationId: operation.operation_id,
			ownerId: claim.ownerId,
			generation: claim.generation,
			class: "terminal",
			reason: "retry_exhausted:issue_closeout_incomplete",
			now: "2026-08-18T03:00:02.000Z",
		});
		let nowMs = Date.parse("2026-08-18T03:00:03.000Z");
		const alert = vi
			.fn()
			.mockRejectedValueOnce(new Error("response lost"))
			.mockImplementationOnce(async (payload) => {
				store.recordAlertDeliveryReceipt(
					payload.eventId,
					"sent",
					new Date(nowMs).toISOString(),
				);
				return { sent: true };
			});
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: {} as never,
			alertSink: { current: { alert } },
			now: () => new Date(nowMs),
			resolveRunAlertIdentity: (projectName) => ({
				leadId: "flywheel-eng-lead",
				projectName,
				leadResolution: "resolved",
			}),
		});

		await expect(dispatcher.reconcileWorkflowEngineAlerts(1)).resolves.toBe(1);
		expect(store.listLandAlertOutbox()[0]).toMatchObject({
			state: "delivering",
			attempt: 1,
		});
		nowMs += 30 * 60_000 - 1;
		await expect(dispatcher.reconcileWorkflowEngineAlerts(1)).resolves.toBe(0);
		expect(alert).toHaveBeenCalledTimes(1);
		nowMs += 2;
		await expect(dispatcher.reconcileWorkflowEngineAlerts(1)).resolves.toBe(1);
		expect(alert).toHaveBeenCalledTimes(2);
		expect(alert.mock.calls[1]?.[0].eventId).toBe(
			`land-held:${operation.operation_id}:0`,
		);
		expect(alert.mock.calls[1]?.[1]).toEqual({
			replayAfterAmbiguousAttempt: true,
		});
		expect(store.listLandAlertOutbox()[0]).toMatchObject({
			state: "sent",
			attempt: 2,
		});
		store.close();
	});
});
