import { afterEach, expect, it, vi } from "vitest";
import { CustomerReleaseRuntime } from "../customer-release/runtime.js";

afterEach(() => vi.useRealTimers());
function fixture() {
	vi.useFakeTimers();
	vi.setSystemTime(1000000);
	const store = { recoverAfterRestart: vi.fn(), invalidateRuntime: vi.fn() };
	const pump = {
		pauseClaims: vi.fn(),
		resumeClaims: vi.fn(),
		tick: vi.fn(async () => "idle" as const),
	};
	const advance = vi.fn(async () => {});
	const runtime = new CustomerReleaseRuntime({
		store,
		pump,
		advance,
		now: Date.now,
	});
	return { store, pump, advance, runtime };
}
it("startup recovery precedes cadence and duplicate starts never create overlapping loops", async () => {
	const f = fixture();
	f.runtime.start();
	f.runtime.start();
	expect(f.store.recoverAfterRestart).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(1000);
	expect(f.pump.tick).toHaveBeenCalledTimes(1);
	expect(f.advance).toHaveBeenCalledTimes(1);
	await f.runtime.stop();
	const ticks = f.pump.tick.mock.calls.length;
	await vi.advanceTimersByTimeAsync(60000);
	expect(f.pump.tick).toHaveBeenCalledTimes(ticks);
});
it("unavailable tick backs off, recovery resets cadence, and unresolved work suppresses scheduling", async () => {
	const f = fixture();
	f.pump.tick
		.mockResolvedValueOnce("unavailable" as never)
		.mockResolvedValueOnce("reconciling" as never);
	f.runtime.start();
	await vi.advanceTimersByTimeAsync(1000);
	expect(f.advance).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1999);
	expect(f.pump.tick).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(1);
	expect(f.pump.tick).toHaveBeenCalledTimes(2);
	expect(f.advance).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1000);
	expect(f.advance).toHaveBeenCalledTimes(1);
	await f.runtime.stop();
});
it("clock discontinuity pauses claims and invalidates unclaimed work before recovery", async () => {
	const f = fixture();
	f.runtime.start();
	await vi.advanceTimersByTimeAsync(1000);
	vi.setSystemTime(900000);
	await vi.advanceTimersByTimeAsync(1000);
	expect(f.store.invalidateRuntime).toHaveBeenCalledWith(
		"clock_rollback",
		901000,
	);
	expect(f.pump.pauseClaims).toHaveBeenCalled();
	await f.runtime.stop();
});
it("shutdown pauses and invalidates before waiting for an in-flight tick, then performs one drain observation", async () => {
	const f = fixture();
	let finish!: () => void;
	f.pump.tick.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = () => resolve("idle");
			}),
	);
	f.runtime.start();
	await vi.advanceTimersByTimeAsync(1000);
	const stop = f.runtime.stop();
	expect(f.pump.pauseClaims).toHaveBeenCalled();
	expect(f.store.invalidateRuntime).toHaveBeenCalledWith(
		"runtime_stopping",
		1001000,
	);
	finish();
	await stop;
	expect(f.advance).not.toHaveBeenCalled();
	expect(f.pump.tick).toHaveBeenCalledTimes(2);
});

it("invalid time remains latched until a valid clock can durably invalidate old work", async () => {
	const f = fixture();
	let now = 1000000;
	const runtime = new CustomerReleaseRuntime({
		store: f.store,
		pump: f.pump,
		advance: f.advance,
		now: () => now,
	});
	runtime.start();
	now = NaN;
	await vi.advanceTimersByTimeAsync(1000);
	expect(f.advance).not.toHaveBeenCalled();
	now = 1001000;
	await vi.advanceTimersByTimeAsync(2000);
	expect(f.store.invalidateRuntime).toHaveBeenCalledWith("clock_invalid", now);
	await runtime.stop();
});

it("shutdown aborts in-flight scheduling before draining the persisted decision", async () => {
	const f = fixture();
	let observed: AbortSignal | undefined;
	const runtime = new CustomerReleaseRuntime({
		store: f.store,
		pump: f.pump,
		now: Date.now,
		advance: (signal) =>
			new Promise<void>((resolve) => {
				observed = signal;
				signal.addEventListener("abort", () => resolve(), { once: true });
			}),
	});
	runtime.start();
	await vi.advanceTimersByTimeAsync(1000);
	expect(observed?.aborted).toBe(false);
	await runtime.stop();
	expect(observed?.aborted).toBe(true);
	expect(f.pump.tick).toHaveBeenCalledTimes(2);
});
