import { describe, expect, it, vi } from "vitest";
import type { LandOperationRow } from "../../StateStore.js";
import { sweepDeferredLandLinearDone } from "../land-linear-done-sweep.js";

function deferredRow(
	overrides: Partial<LandOperationRow> = {},
): LandOperationRow {
	return {
		operation_id: "land:one",
		run_id: "run-1",
		issue_id: "issue-1",
		project_name: "flywheel",
		pr_number: 1770,
		approved_head: "a".repeat(40),
		state: "completed",
		owner_id: null,
		lease_expires_at: null,
		generation: 1,
		current_step: "finalization_completed",
		merge_confirmed_at: "2026-08-13T00:00:00.000Z",
		finalization_completed_at: "2026-08-13T00:01:00.000Z",
		retry_count: 0,
		retry_epoch_key: null,
		next_attempt_at: null,
		linear_done_disposition: "deferred",
		linear_done_deferred_at: "2026-08-13T00:01:00.000Z",
		linear_done_settled_at: null,
		linear_done_last_reason: "offline",
		last_error: null,
		created_at: "2026-08-13T00:00:00.000Z",
		updated_at: "2026-08-13T00:01:00.000Z",
		...overrides,
	};
}

describe("sweepDeferredLandLinearDone", () => {
	it("settles exact deferred operations under the issue mutex", async () => {
		const first = deferredRow();
		const second = deferredRow({
			operation_id: "land:two",
			issue_id: "issue-2",
		});
		const settle = vi.fn().mockReturnValue({
			ok: true,
			idempotentReplay: false,
		});
		const withIssueMutex = vi.fn(
			async (_issueId: string, fn: () => Promise<void>) => fn(),
		);
		const markIssueDone = vi
			.fn()
			.mockResolvedValueOnce({ done: true, reason: "already_completed" })
			.mockResolvedValueOnce({
				done: false,
				reason: "issue_canceled_never_overwritten",
			});

		await sweepDeferredLandLinearDone({
			store: {
				listDeferredLandLinearDone: vi.fn().mockReturnValue([first, second]),
				getLandOperation: vi.fn((id: string) =>
					id === first.operation_id ? first : second,
				),
				settleDeferredLandLinearDone: settle,
			},
			preArbitrate: vi.fn().mockResolvedValue({ ok: true }),
			withIssueMutex,
			markIssueDone,
			now: new Date("2026-08-14T12:00:00.000Z"),
		});

		expect(withIssueMutex).toHaveBeenCalledTimes(2);
		expect(settle).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				operationId: "land:one",
				disposition: "done",
			}),
		);
		expect(settle).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				operationId: "land:two",
				disposition: "canceled_refused",
			}),
		);
	});

	it("settles founder-parked authority without issuing a Linear write", async () => {
		const row = deferredRow();
		const settle = vi.fn().mockReturnValue({
			ok: true,
			idempotentReplay: false,
		});
		const markIssueDone = vi.fn();

		await sweepDeferredLandLinearDone({
			store: {
				listDeferredLandLinearDone: vi.fn().mockReturnValue([row]),
				getLandOperation: vi.fn().mockReturnValue(row),
				settleDeferredLandLinearDone: settle,
			},
			preArbitrate: vi
				.fn()
				.mockResolvedValue({ ok: false, reason: "founder_parked" }),
			withIssueMutex: async (_issueId, fn) => fn(),
			markIssueDone,
			now: new Date("2026-08-14T12:00:00.000Z"),
		});

		expect(markIssueDone).not.toHaveBeenCalled();
		expect(settle).toHaveBeenCalledWith(
			expect.objectContaining({ disposition: "canceled_refused" }),
		);
	});

	it("keeps persistent failures deferred and raises one daily aged warning", async () => {
		const row = deferredRow();
		const onAgedDeferred = vi.fn();
		const listDeferredLandLinearDone = vi.fn().mockReturnValue([row]);

		await sweepDeferredLandLinearDone({
			store: {
				listDeferredLandLinearDone,
				getLandOperation: vi.fn().mockReturnValue(row),
				settleDeferredLandLinearDone: vi.fn(),
			},
			preArbitrate: vi.fn().mockResolvedValue({
				ok: true,
				degraded: "linear_unreachable",
			}),
			withIssueMutex: async (_issueId, fn) => fn(),
			markIssueDone: vi.fn().mockResolvedValue({
				done: false,
				reason: "linear offline",
			}),
			onAgedDeferred,
			now: new Date("2026-08-14T12:00:00.000Z"),
		});

		expect(listDeferredLandLinearDone).toHaveBeenCalledWith(10);
		expect(onAgedDeferred).toHaveBeenCalledWith(
			row,
			expect.objectContaining({
				ageHours: 35,
				dayBucket: "2026-08-14",
				reason: "linear offline",
			}),
		);
	});
});
