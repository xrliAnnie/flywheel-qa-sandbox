/**
 * FLY-1048 (A6): GatePoller piggybacks the cheap gap/state scan on its
 * existing poll tick (zero new periodic timer — FLY-513 pattern). Pins the
 * cadence + isolation: fires on the expected ticks, absent callback = no-op
 * (byte-compat), and a throwing/rejecting scan never breaks the poll loop.
 */
import { describe, expect, it, vi } from "vitest";
import { GatePoller, type GatePollerConfig } from "../gate-poller.js";

function makePoller(overrides: Record<string, unknown> = {}) {
	return new GatePoller({
		pollIntervalMs: 3_000,
		projects: [],
		store: {} as unknown as GatePollerConfig["store"],
		runtimeRegistry: {} as unknown as GatePollerConfig["runtimeRegistry"],
		...overrides,
	});
}

async function tick(poller: GatePoller, n: number) {
	for (let i = 0; i < n; i++) {
		await (poller as unknown as { poll(): Promise<void> }).poll();
	}
}

describe("FLY-1048 GatePoller onGapScanTick piggyback", () => {
	it("fires on tick 1 and then every N ticks (cadence)", async () => {
		const onGapScanTick = vi.fn();
		const poller = makePoller({ onGapScanTick, gapScanEveryNTicks: 4 });
		await tick(poller, 9); // (tick-1) % 4 === 0 → fires at 1, 5, 9
		expect(onGapScanTick).toHaveBeenCalledTimes(3);
	});

	it("defaults to a ~5min cadence (100 ticks at 3s)", async () => {
		const onGapScanTick = vi.fn();
		const poller = makePoller({ onGapScanTick });
		await tick(poller, 101); // fires at 1 and 101
		expect(onGapScanTick).toHaveBeenCalledTimes(2);
	});

	it("is a complete no-op when the callback is not provided (byte-compat)", async () => {
		const poller = makePoller();
		await expect(tick(poller, 5)).resolves.toBeUndefined();
	});

	it("a throwing scan never breaks the poll loop", async () => {
		const onGapScanTick = vi.fn(() => {
			throw new Error("scan boom");
		});
		const poller = makePoller({ onGapScanTick, gapScanEveryNTicks: 1 });
		await expect(tick(poller, 3)).resolves.toBeUndefined();
		expect(onGapScanTick).toHaveBeenCalledTimes(3);
	});

	it("a rejecting async scan is swallowed (never rejects poll)", async () => {
		const onGapScanTick = vi.fn().mockRejectedValue(new Error("async boom"));
		const poller = makePoller({ onGapScanTick, gapScanEveryNTicks: 1 });
		await expect(tick(poller, 3)).resolves.toBeUndefined();
		expect(onGapScanTick).toHaveBeenCalled();
	});
});
