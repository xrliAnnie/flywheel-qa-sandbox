import { describe, expect, it, vi } from "vitest";
import { deliverResidentWake } from "../resident-wake-fence.js";

describe("deliverResidentWake", () => {
	it.each([
		["expired", "resident_hold_expired"],
		["closed", "resident_hold_expired"],
		["woken", "resident_hold_already_woken"],
	])("classifies %s before transport without inventing release", async (state, error) => {
		const store = {getResidentHold: () => ({state, revision: 4}), wakeResidentHold: vi.fn()};
		const deliver = vi.fn(async () => ({ok: true as const}));
		expect(await deliverResidentWake(store, "exec-1", deliver)).toEqual({ok: false, error});
		expect(deliver).not.toHaveBeenCalled();
	});
	it("keeps a lost post-delivery CAS retryable even after transport succeeds", async () => {
		const store = {getResidentHold: () => ({state: "resident", revision: 4}), wakeResidentHold: vi.fn(() => false)};
		const deliver = vi.fn(async () => ({ok: true as const}));
		expect(await deliverResidentWake(store, "exec-1", deliver)).toEqual({ok: false, error: "resident_hold_wake_conflict"});
		expect(deliver).toHaveBeenCalledOnce();
	});

	it("leaves the hold resident after a transient failure so the next attempt can wake it", async () => {
		let state: "resident" | "woken" = "resident";
		const store = {
			getResidentHold: vi.fn(() => ({ state, revision: 4 })),
			wakeResidentHold: vi.fn((_executionId: string, revision: number) => {
				if (state !== "resident" || revision !== 4) return false;
				state = "woken";
				return true;
			}),
		};
		const outcomes = [
			{ ok: false as const, error: "wake_pending_retry" },
			{ ok: true as const },
		];
		const deliver = vi.fn(
			async () => outcomes.shift() ?? { ok: true as const },
		);

		expect(await deliverResidentWake(store, "exec-1", deliver)).toEqual({
			ok: false,
			error: "wake_pending_retry",
		});
		expect(state).toBe("resident");
		expect(store.wakeResidentHold).not.toHaveBeenCalled();

		expect(await deliverResidentWake(store, "exec-1", deliver)).toEqual({
			ok: true,
		});
		expect(state).toBe("woken");
		expect(store.wakeResidentHold).toHaveBeenCalledOnce();
		expect(deliver).toHaveBeenCalledTimes(2);
	});
});
