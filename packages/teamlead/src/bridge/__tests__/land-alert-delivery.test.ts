import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { WorkflowEngineDispatcher } from "../workflow-engine-dispatcher.js";

const HEAD = "a".repeat(40);

describe("legacy land held alert delivery", () => {
	it("retries through the fenced outbox with a distinct transport identity", async () => {
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
			.mockResolvedValueOnce({ sent: true });
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
			`land-held:${operation.operation_id}:0:1`,
			`land-held:${operation.operation_id}:0:2`,
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
		alert.mockResolvedValueOnce({ sent: true });
		await expect(dispatcher.reconcileWorkflowEngineAlerts(1)).resolves.toBe(1);
		expect(alert.mock.calls.at(-1)?.[0].body).toContain(
			`flywheel-comm land reclose --operation ${closeout.operation_id} --expected-generation 0 --expected-head ${HEAD}`,
		);
		store.close();
	});
});
