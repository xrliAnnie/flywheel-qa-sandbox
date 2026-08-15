import { describe, expect, it, vi } from "vitest";
import type { LandOperationRow } from "../../StateStore.js";
import {
	buildAgedDeferredLinearDoneAlert,
	sweepDeferredLandLinearDone,
} from "../land-linear-done-sweep.js";

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
		linear_done_retry_count: 0,
		linear_done_next_attempt_at: "2026-08-13T00:01:00.000Z",
		linear_done_last_attempt_at: null,
		last_error: null,
		created_at: "2026-08-13T00:00:00.000Z",
		updated_at: "2026-08-13T00:01:00.000Z",
		...overrides,
	};
}

describe("sweepDeferredLandLinearDone", () => {
	it("keeps one aged-alert identity and payload stable throughout a UTC day", () => {
		const row = deferredRow();
		const first = buildAgedDeferredLinearDoneAlert({
			operation: row,
			leadId: "flywheel-eng-lead",
			leadResolution: "resolved",
			dayBucket: "2026-08-14",
		});
		const replay = buildAgedDeferredLinearDoneAlert({
			operation: {
				...row,
				linear_done_last_reason: "different transient failure",
				updated_at: "2026-08-14T23:59:00.000Z",
			},
			leadId: "flywheel-eng-lead",
			leadResolution: "resolved",
			dayBucket: "2026-08-14",
		});

		expect(replay).toEqual(first);
		expect(first.escalationUid).toContain("2026-08-14");
		expect(first.workflowMetadata).toMatchObject({
			nodeId: "land",
			executionId: row.operation_id,
			reason: "linear_done_deferred_stale",
		});
	});

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
				deferLandLinearDoneRetry: vi.fn(),
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
				deferLandLinearDoneRetry: vi.fn(),
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
		const deferLandLinearDoneRetry = vi.fn().mockReturnValue({
			ok: true,
			retryCount: 1,
		});

		await sweepDeferredLandLinearDone({
			store: {
				listDeferredLandLinearDone,
				getLandOperation: vi.fn().mockReturnValue(row),
				settleDeferredLandLinearDone: vi.fn(),
				deferLandLinearDoneRetry,
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

		expect(listDeferredLandLinearDone).toHaveBeenCalledWith(
			"2026-08-14T12:00:00.000Z",
			10,
		);
		expect(deferLandLinearDoneRetry).toHaveBeenCalledWith({
			operationId: row.operation_id,
			reason: "linear offline",
			now: "2026-08-14T12:00:00.000Z",
			nextAttemptAt: "2026-08-14T12:15:00.000Z",
		});
		expect(onAgedDeferred).toHaveBeenCalledWith(
			row,
			expect.objectContaining({
				ageHours: 35,
				dayBucket: "2026-08-14",
				reason: "linear offline",
			}),
		);
	});

	it("settles legacy deferred rows when the Linear finalizer is intentionally unavailable", async () => {
		const row = deferredRow();
		const settleDeferredLandLinearDone = vi.fn().mockReturnValue({
			ok: true,
			idempotentReplay: false,
		});

		await sweepDeferredLandLinearDone({
			store: {
				listDeferredLandLinearDone: vi.fn().mockReturnValue([row]),
				getLandOperation: vi.fn().mockReturnValue(row),
				settleDeferredLandLinearDone,
				deferLandLinearDoneRetry: vi.fn(),
			},
			preArbitrate: vi.fn().mockResolvedValue({ ok: true }),
			withIssueMutex: async (_issueId, fn) => fn(),
			now: new Date("2026-08-14T12:00:00.000Z"),
		});

		expect(settleDeferredLandLinearDone).toHaveBeenCalledWith({
			operationId: row.operation_id,
			disposition: "canceled_refused",
			reason: "linear_finalizer_unavailable",
			now: "2026-08-14T12:00:00.000Z",
		});
	});
});
