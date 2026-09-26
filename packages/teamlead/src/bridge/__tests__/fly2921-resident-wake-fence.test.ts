import { describe, expect, it, vi } from "vitest";
import { deliverResidentWake } from "../resident-wake-fence.js";

/**
 * FLY-2921 C5 (FLY-2821): `woken` is not "undeliverable". An awake actor is
 * reachable, so the wake goes straight into its durable mailbox and the
 * transport result is the fence result. Only `expired` / `closed` mean the
 * body has retired and the coordinator must replace it.
 */
describe("FLY-2921 deliverResidentWake on a woken hold", () => {
	it("delivers directly to a woken hold without a hold CAS", async () => {
		const store = {
			getResidentHold: () => ({ state: "woken", revision: 4 }),
			wakeResidentHold: vi.fn(() => true),
		};
		const deliver = vi.fn(async () => ({ ok: true as const }));
		expect(await deliverResidentWake(store, "exec-1", deliver)).toEqual({
			ok: true,
		});
		expect(deliver).toHaveBeenCalledOnce();
		expect(store.wakeResidentHold).not.toHaveBeenCalled();
	});

	it("returns the transport result verbatim when delivery to a woken hold fails", async () => {
		const store = {
			getResidentHold: () => ({ state: "woken", revision: 4 }),
			wakeResidentHold: vi.fn(() => true),
		};
		const deliver = vi.fn(async () => ({
			ok: false as const,
			error: "mailbox unavailable",
		}));
		expect(await deliverResidentWake(store, "exec-1", deliver)).toEqual({
			ok: false,
			error: "mailbox unavailable",
		});
		expect(deliver).toHaveBeenCalledOnce();
		expect(store.wakeResidentHold).not.toHaveBeenCalled();
	});

	it("never classifies a woken hold as resident_hold_already_woken", async () => {
		const store = {
			getResidentHold: () => ({ state: "woken", revision: 1 }),
			wakeResidentHold: vi.fn(() => true),
		};
		const result = await deliverResidentWake(store, "exec-1", async () => ({
			ok: true as const,
		}));
		expect(result.ok).toBe(true);
		expect(JSON.stringify(result)).not.toContain("resident_hold_already_woken");
	});

	it.each([
		["expired", "resident_hold_expired"],
		["closed", "resident_hold_expired"],
	])(
		"keeps %s as the only retired classification and skips transport",
		async (state, error) => {
			const store = {
				getResidentHold: () => ({ state, revision: 4 }),
				wakeResidentHold: vi.fn(),
			};
			const deliver = vi.fn(async () => ({ ok: true as const }));
			expect(await deliverResidentWake(store, "exec-1", deliver)).toEqual({
				ok: false,
				error,
			});
			expect(deliver).not.toHaveBeenCalled();
			expect(store.wakeResidentHold).not.toHaveBeenCalled();
		},
	);

	it("still commits the resident -> woken CAS only after transport for a resident hold", async () => {
		const store = {
			getResidentHold: () => ({ state: "resident", revision: 2 }),
			wakeResidentHold: vi.fn(() => true),
		};
		const deliver = vi.fn(async () => ({ ok: true as const }));
		expect(await deliverResidentWake(store, "exec-1", deliver)).toEqual({
			ok: true,
		});
		expect(deliver).toHaveBeenCalledOnce();
		expect(store.wakeResidentHold).toHaveBeenCalledWith("exec-1", 2);
	});
});
