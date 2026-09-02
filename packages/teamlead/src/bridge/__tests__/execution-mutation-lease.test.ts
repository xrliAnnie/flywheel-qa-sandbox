import { describe, expect, it, vi } from "vitest";
import { withExecutionMutationLease } from "../execution-mutation-lease.js";

describe("FLY-2211 execution mutation lease", () => {
	it("holds one lease across mutation and revision commit", () => {
		const order: string[] = [];
		const store = {
			getSession: vi.fn(() => ({ lifecycle_revision: 4 })),
			claimExecutionMutationLease: vi.fn(() => {
				order.push("claim");
				return {
					ok: true as const,
					claimToken: "writer-token",
					expiresAtMs: 61_000,
				};
			}),
			commitExecutionMutationLease: vi.fn(() => {
				order.push("commit");
				return { ok: true as const, lifecycleRevision: 5 };
			}),
		};

		const result = withExecutionMutationLease({
			store,
			executionId: "old-holder",
			holder: "turn-writer:event-1",
			nowMs: () => 1_000,
			mutate: () => {
				order.push("mutate");
				return 42;
			},
		});

		expect(result).toBe(42);
		expect(order).toEqual(["claim", "mutate", "commit"]);
		expect(store.claimExecutionMutationLease).toHaveBeenCalledWith(
			"old-holder",
			4,
			expect.objectContaining({ holder: "turn-writer:event-1" }),
		);
	});

	it("does not mutate when recovery already owns the lease", () => {
		const mutate = vi.fn();
		const store = {
			getSession: vi.fn(() => ({ lifecycle_revision: 4 })),
			claimExecutionMutationLease: vi.fn(() => ({
				ok: false as const,
				reason: "lease_held" as const,
				holder: "bridge-recovery",
				expiresAtMs: 2_000,
			})),
			commitExecutionMutationLease: vi.fn(),
		};

		expect(() =>
			withExecutionMutationLease({
				store,
				executionId: "old-holder",
				holder: "turn-writer:event-2",
				nowMs: () => 1_000,
				mutate,
			}),
		).toThrow("execution mutation lease refused: lease_held");
		expect(mutate).not.toHaveBeenCalled();
		expect(store.commitExecutionMutationLease).not.toHaveBeenCalled();
	});

	it("leaves a failed cross-store writer lease for TTL takeover", () => {
		const store = {
			getSession: vi.fn(() => ({ lifecycle_revision: 4 })),
			claimExecutionMutationLease: vi.fn(() => ({
				ok: true as const,
				claimToken: "writer-token",
				expiresAtMs: 61_000,
			})),
			commitExecutionMutationLease: vi.fn(),
		};

		expect(() =>
			withExecutionMutationLease({
				store,
				executionId: "old-holder",
				holder: "turn-writer:event-3",
				nowMs: () => 1_000,
				mutate: () => {
					throw new Error("projection crashed");
				},
			}),
		).toThrow("projection crashed");
		expect(store.commitExecutionMutationLease).not.toHaveBeenCalled();
	});
});
