import { describe, expect, it, vi } from "vitest";

import {
	isWorkflowProcessRetirementApproved,
	runWorkflowProcessRetirementTick,
	type WorkflowProcessRetirementStore,
} from "../bridge/workflow-process-retirement.js";

const candidate = {
	executionId: "design-exec",
	generation: 1,
	issueId: "FLY-2808",
	projectName: "flywheel",
	vendor: "claude" as const,
	retirementRequestedAt: "2026-09-24T10:14:55.000Z",
};

function makeStore() {
	return {
		listWorkflowExecutionRetirementWork: vi.fn(() => [candidate]),
		getWorkflowExecutionProcessBody: vi.fn(() => ({
			execution_id: candidate.executionId,
			generation: candidate.generation,
			state: "retiring" as const,
			retirement_requested_at: candidate.retirementRequestedAt,
		})),
		confirmWorkflowExecutionStandby: vi.fn(() => ({
			ok: true as const,
			idempotentReplay: false,
		})),
		failWorkflowExecutionRetirement: vi.fn(() => ({
			ok: true as const,
			idempotentReplay: false,
		})),
	} satisfies WorkflowProcessRetirementStore;
}

describe("workflow process retirement reconciliation", () => {
	it.each(["retiring", "standby"])(
		"keeps the matching generation approved after it reaches %s",
		(state) => {
			expect(
				isWorkflowProcessRetirementApproved({ generation: 2, state }, 2),
			).toBe(true);
			expect(
				isWorkflowProcessRetirementApproved({ generation: 1, state }, 2),
			).toBe(false);
		},
	);

	it("settles an overdue Claude retirement after execution-wide death is proven", async () => {
		const store = makeStore();
		const retireProcess = vi.fn(async () => ({
			physicalGone: true,
		}));

		await expect(
			runWorkflowProcessRetirementTick({
				store,
				retireProcess,
				now: "2026-09-24T10:16:00.000Z",
				graceMs: 60_000,
			}),
		).resolves.toEqual({ processed: 1, standby: 1, failed: 0 });

		expect(retireProcess).toHaveBeenCalledWith(candidate);
		expect(store.confirmWorkflowExecutionStandby).toHaveBeenCalledWith({
			executionId: candidate.executionId,
			generation: candidate.generation,
			reasonCode: "process_tree_gone",
			now: "2026-09-24T10:16:00.000Z",
		});
		expect(store.failWorkflowExecutionRetirement).not.toHaveBeenCalled();
	});

	it("keeps an overdue retirement retiring when cleanup is unconfirmed", async () => {
		const store = makeStore();

		await expect(
			runWorkflowProcessRetirementTick({
				store,
				retireProcess: vi.fn(async () => ({
					physicalGone: false,
					error: "tmux_window_indeterminate",
				})),
				now: "2026-09-24T10:16:00.000Z",
				graceMs: 60_000,
			}),
		).resolves.toEqual({ processed: 1, standby: 0, failed: 0 });

		expect(store.failWorkflowExecutionRetirement).not.toHaveBeenCalled();
		expect(store.confirmWorkflowExecutionStandby).not.toHaveBeenCalled();
	});

	it("latches an overdue retirement only with positive failure evidence", async () => {
		const store = makeStore();

		await expect(
			runWorkflowProcessRetirementTick({
				store,
				retireProcess: vi.fn(async () => ({
					physicalGone: false,
					failureConfirmed: true,
					error: "tmux_window_still_present",
				})),
				now: "2026-09-24T10:16:00.000Z",
				graceMs: 60_000,
			}),
		).resolves.toEqual({ processed: 1, standby: 0, failed: 1 });

		expect(store.failWorkflowExecutionRetirement).toHaveBeenCalledWith({
			executionId: candidate.executionId,
			generation: candidate.generation,
			reasonCode: "retirement_unconfirmed",
			now: "2026-09-24T10:16:00.000Z",
		});
		expect(store.confirmWorkflowExecutionStandby).not.toHaveBeenCalled();
	});

	it("does not settle a replacement retirement request after cleanup awaited", async () => {
		const store = makeStore();
		store.getWorkflowExecutionProcessBody.mockReturnValue({
			execution_id: candidate.executionId,
			generation: candidate.generation,
			state: "retiring",
			retirement_requested_at: "2026-09-24T10:15:30.000Z",
		});

		await expect(
			runWorkflowProcessRetirementTick({
				store,
				retireProcess: vi.fn(async () => ({ physicalGone: true })),
				now: "2026-09-24T10:16:00.000Z",
				graceMs: 60_000,
			}),
		).resolves.toEqual({ processed: 1, standby: 0, failed: 0 });

		expect(store.confirmWorkflowExecutionStandby).not.toHaveBeenCalled();
		expect(store.failWorkflowExecutionRetirement).not.toHaveBeenCalled();
	});
});
