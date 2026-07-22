import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	executeLandOperation,
	type LandMergeDriver,
} from "../land-executor.js";

const HEAD = "a".repeat(40);
const MERGE = "b".repeat(40);

async function fixture() {
	const store = await StateStore.create(":memory:");
	const operation = store.ensureLandOperation({
		runId: "run-1",
		issueId: "issue-1",
		projectName: "flywheel",
		prNumber: 1375,
		approvedHead: HEAD,
		now: "2026-07-21T20:00:00.000Z",
	});
	return { store, operation };
}

describe("land executor", () => {
	it("triggers sanctioned merge once, yields while pending, then resumes finalization", async () => {
		const { store, operation } = await fixture();
		let merged = false;
		const triggerCool = vi.fn().mockResolvedValue({
			commentId: "9001",
			commentUrl: "https://github.test/pull/1375#issuecomment-9001",
		});
		const mergeDriver: LandMergeDriver = {
			inspectPr: vi
				.fn()
				.mockImplementation(async () =>
					merged
						? { state: "MERGED", headSha: HEAD, mergeSha: MERGE }
						: { state: "OPEN", headSha: HEAD },
				),
			triggerCool,
			inspectTriggeredWorkflow: vi
				.fn()
				.mockImplementation(async () => ({ state: "pending" })),
		};
		const finalize = vi.fn().mockResolvedValue({
			complete: true,
			outcome: "completed",
		});
		let tick = 0;
		const deps = {
			store,
			mergeDriver,
			finalize,
			authorize: () => ({ ok: true as const }),
			ownerId: "worker",
			now: () => new Date(`2026-07-21T20:0${tick++}:00.000Z`),
		};

		expect(
			await executeLandOperation(operation.operation_id, deps),
		).toMatchObject({
			status: "partial",
			reason: "ship_workflow_pending",
		});
		merged = true;
		expect(
			await executeLandOperation(operation.operation_id, deps),
		).toMatchObject({
			status: "completed",
		});
		expect(triggerCool).toHaveBeenCalledTimes(1);
		expect(finalize).toHaveBeenCalledTimes(1);
		expect(
			store.listLandOperationSteps(operation.operation_id).map((s) => s.step),
		).toEqual([
			"authority_verified",
			"cool_triggered",
			"merge_confirmed",
			"cleanup_requested",
			"finalization_completed",
		]);
		expect(store.getLandOperation(operation.operation_id)).toMatchObject({
			state: "completed",
			merge_confirmed_at: expect.any(String),
			finalization_completed_at: expect.any(String),
		});
		store.close();
	});

	it("holds on a head mismatch without triggering merge", async () => {
		const { store, operation } = await fixture();
		const triggerCool = vi.fn();
		const result = await executeLandOperation(operation.operation_id, {
			store,
			mergeDriver: {
				inspectPr: vi.fn().mockResolvedValue({
					state: "OPEN",
					headSha: "c".repeat(40),
				}),
				triggerCool,
				inspectTriggeredWorkflow: vi.fn(),
			},
			finalize: vi.fn(),
			authorize: () => ({ ok: true }),
			ownerId: "worker",
			now: () => new Date("2026-07-21T20:01:00.000Z"),
		});
		expect(result).toMatchObject({
			status: "held",
			reason: "pr_head_mismatch",
		});
		expect(triggerCool).not.toHaveBeenCalled();
		store.close();
	});

	it("skips :cool: when the exact head is already merged", async () => {
		const { store, operation } = await fixture();
		const triggerCool = vi.fn();
		const finalize = vi.fn().mockResolvedValue({
			complete: true,
			outcome: "completed",
		});
		const result = await executeLandOperation(operation.operation_id, {
			store,
			mergeDriver: {
				inspectPr: vi.fn().mockResolvedValue({
					state: "MERGED",
					headSha: HEAD,
					mergeSha: MERGE,
				}),
				triggerCool,
				inspectTriggeredWorkflow: vi.fn(),
			},
			finalize,
			authorize: () => ({ ok: true }),
			ownerId: "worker",
			now: () => new Date("2026-07-21T20:01:00.000Z"),
		});
		expect(result.status).toBe("completed");
		expect(triggerCool).not.toHaveBeenCalled();
		expect(finalize).toHaveBeenCalledOnce();
		store.close();
	});

	it("releases the lease after a transient driver error and resumes on the next sweep", async () => {
		const { store, operation } = await fixture();
		const inspectPr = vi
			.fn()
			.mockRejectedValueOnce(new Error("github temporarily unavailable"))
			.mockResolvedValue({
				state: "MERGED",
				headSha: HEAD,
				mergeSha: MERGE,
			});
		let tick = 1;
		const deps = {
			store,
			mergeDriver: {
				inspectPr,
				triggerCool: vi.fn(),
				inspectTriggeredWorkflow: vi.fn(),
			} satisfies LandMergeDriver,
			finalize: vi.fn().mockResolvedValue({
				complete: true,
				outcome: "completed" as const,
			}),
			authorize: () => ({ ok: true as const }),
			ownerId: "worker",
			now: () => new Date(`2026-07-21T20:0${tick++}:00.000Z`),
		};

		await expect(
			executeLandOperation(operation.operation_id, deps),
		).resolves.toMatchObject({
			status: "partial",
			reason: "land_execution_error:github temporarily unavailable",
		});
		expect(store.getLandOperation(operation.operation_id)).toMatchObject({
			state: "partial",
			owner_id: null,
			lease_expires_at: null,
		});
		await expect(
			executeLandOperation(operation.operation_id, deps),
		).resolves.toMatchObject({ status: "completed" });
		store.close();
	});

	it("retries a failed stage notification before triggering the sanctioned merge", async () => {
		const { store, operation } = await fixture();
		const triggerCool = vi.fn();
		const notify = vi
			.fn()
			.mockRejectedValueOnce(new Error("discord unavailable"))
			.mockResolvedValue(undefined);
		let tick = 1;
		const deps = {
			store,
			mergeDriver: {
				inspectPr: vi.fn().mockResolvedValue({
					state: "MERGED",
					headSha: HEAD,
					mergeSha: MERGE,
				}),
				triggerCool,
				inspectTriggeredWorkflow: vi.fn(),
			} satisfies LandMergeDriver,
			finalize: vi.fn().mockResolvedValue({
				complete: true,
				outcome: "completed" as const,
			}),
			notify,
			authorize: () => ({ ok: true as const }),
			ownerId: "worker",
			now: () => new Date(`2026-07-21T20:0${tick++}:00.000Z`),
		};

		await expect(
			executeLandOperation(operation.operation_id, deps),
		).resolves.toMatchObject({
			status: "partial",
			reason: "land_execution_error:discord unavailable",
		});
		expect(triggerCool).not.toHaveBeenCalled();
		await expect(
			executeLandOperation(operation.operation_id, deps),
		).resolves.toMatchObject({ status: "completed" });
		const notifications = store
			.listLandOperationSteps(operation.operation_id)
			.filter((step) => step.step.startsWith("notification:"))
			.map((step) => step.step);
		expect(notifications).toHaveLength(5);
		expect(notifications).toEqual(
			expect.arrayContaining([
				"notification:activated",
				"notification:execution_retry",
				"notification:merge_confirmed",
				"notification:cleanup_requested",
				"notification:completed",
			]),
		);
		store.close();
	});

	it("ignores a losing duplicate workflow failure when the exact head is already merged", async () => {
		const { store, operation } = await fixture();
		const inspectPr = vi
			.fn()
			.mockResolvedValueOnce({ state: "OPEN", headSha: HEAD })
			.mockResolvedValue({
				state: "MERGED",
				headSha: HEAD,
				mergeSha: MERGE,
			});
		const result = await executeLandOperation(operation.operation_id, {
			store,
			mergeDriver: {
				inspectPr,
				triggerCool: vi.fn().mockResolvedValue({ commentId: "9001" }),
				inspectTriggeredWorkflow: vi.fn().mockResolvedValue({
					state: "failed",
					reason: "failure",
				}),
			},
			finalize: vi.fn().mockResolvedValue({
				complete: true,
				outcome: "completed",
			}),
			authorize: () => ({ ok: true }),
			ownerId: "worker",
			now: () => new Date("2026-07-21T20:01:00.000Z"),
		});

		expect(result.status).toBe("completed");
		expect(store.getLandOperation(operation.operation_id)?.state).toBe(
			"completed",
		);
		store.close();
	});
});
