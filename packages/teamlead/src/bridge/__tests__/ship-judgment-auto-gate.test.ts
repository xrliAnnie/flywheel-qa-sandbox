import { describe, expect, it, vi } from "vitest";
import { reconcileShipJudgmentAutoGate } from "../ship-judgment-auto-gate.js";

describe("three-point auto approval pump", () => {
	it("writes through the dedicated source seam and advances a bounded cursor", () => {
		const close = vi.fn();
		const insert = vi.fn(() => ({ written: true, replayed: false }));
		const commit = vi.fn(({ writeSource }) => ({
			status: writeSource({
				expectedOwner: "execution",
				projectedThroughSourceRowId: 4,
				envelope: { question_id: "q" },
			}).replayed
				? "replayed"
				: "written",
		}));
		const result = reconcileShipJudgmentAutoGate({
			store: {
				listPendingShipJudgmentAutoCandidates: () => ["q"],
				commitShipJudgmentSourceIfEligible: commit as never,
			},
			openCommDb: () => ({
				insertShipJudgmentApprovalWithSource: insert,
				close,
			}),
			now: () => "2026-09-18T16:30:00.000Z",
		});
		expect(result).toEqual({
			scanned: 1,
			written: 1,
			replayed: 0,
			skipped: 0,
			failed: 0,
			cursor: "q",
		});
		expect(insert).toHaveBeenCalledWith(
			expect.objectContaining({
				project: "flywheel",
				expectedOwner: "execution",
			}),
		);
		expect(close).toHaveBeenCalledOnce();
	});

	it("stops the batch on a lock without treating a policy skip as failure", () => {
		const commit = vi
			.fn()
			.mockReturnValueOnce({ status: "ineligible" })
			.mockImplementationOnce(() => {
				throw new Error("SQLITE_BUSY");
			});
		const result = reconcileShipJudgmentAutoGate({
			store: {
				listPendingShipJudgmentAutoCandidates: () => ["a", "b", "c"],
				commitShipJudgmentSourceIfEligible: commit,
			},
			openCommDb: () => ({
				insertShipJudgmentApprovalWithSource: vi.fn(),
				close: vi.fn(),
			}),
		});
		expect(result).toMatchObject({
			scanned: 2,
			skipped: 1,
			failed: 1,
			cursor: "b",
		});
		expect(commit).toHaveBeenCalledTimes(2);
	});
});
