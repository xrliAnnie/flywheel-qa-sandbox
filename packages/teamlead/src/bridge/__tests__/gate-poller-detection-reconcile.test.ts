/**
 * FLY-1048 PR-C (C3-w): the detection-escalation reconcile piggybacks the
 * existing GatePoller tick (zero new periodic timer — FLY-169/172/208
 * discipline, FLY-513 `onHealthTick` precedent).
 *
 * Pins the same contract the other piggybacks hold: fires on tick 1 then every
 * N, works at the degenerate N=1, cadence 0 disables it, absent callback is a
 * complete no-op (byte-compat), and a throwing/rejecting reconcile can never
 * break the poll loop.
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

describe("FLY-1048 C3-w GatePoller onDetectionReconcileTick piggyback", () => {
	it("fires on tick 1 and then every N ticks", async () => {
		const onDetectionReconcileTick = vi.fn();
		const poller = makePoller({
			onDetectionReconcileTick,
			detectionReconcileEveryNTicks: 3,
		});
		await tick(poller, 7); // fires at 1, 4, 7
		expect(onDetectionReconcileTick).toHaveBeenCalledTimes(3);
	});

	it("defaults to every 20 ticks", async () => {
		const onDetectionReconcileTick = vi.fn();
		const poller = makePoller({ onDetectionReconcileTick });
		await tick(poller, 21); // fires at 1 and 21
		expect(onDetectionReconcileTick).toHaveBeenCalledTimes(2);
	});

	it("N=1 fires on EVERY tick (degenerate cadence must not disable it)", async () => {
		const onDetectionReconcileTick = vi.fn();
		const poller = makePoller({
			onDetectionReconcileTick,
			detectionReconcileEveryNTicks: 1,
		});
		await tick(poller, 4);
		expect(onDetectionReconcileTick).toHaveBeenCalledTimes(4);
	});

	it("cadence 0 disables it (FLY-907 precedent)", async () => {
		const onDetectionReconcileTick = vi.fn();
		const poller = makePoller({
			onDetectionReconcileTick,
			detectionReconcileEveryNTicks: 0,
		});
		await tick(poller, 5);
		expect(onDetectionReconcileTick).not.toHaveBeenCalled();
	});

	it("is a complete no-op when the callback is absent (byte-compat)", async () => {
		const poller = makePoller();
		await expect(tick(poller, 5)).resolves.toBeUndefined();
	});

	it("a throwing reconcile never breaks the poll loop", async () => {
		const onDetectionReconcileTick = vi.fn(() => {
			throw new Error("reconcile boom");
		});
		const poller = makePoller({
			onDetectionReconcileTick,
			detectionReconcileEveryNTicks: 1,
		});
		await expect(tick(poller, 3)).resolves.toBeUndefined();
		expect(onDetectionReconcileTick).toHaveBeenCalledTimes(3);
	});

	it("a rejecting async reconcile is swallowed (never rejects poll)", async () => {
		const onDetectionReconcileTick = vi.fn(async () => {
			throw new Error("async boom");
		});
		const poller = makePoller({
			onDetectionReconcileTick,
			detectionReconcileEveryNTicks: 1,
		});
		await expect(tick(poller, 2)).resolves.toBeUndefined();
		expect(onDetectionReconcileTick).toHaveBeenCalledTimes(2);
	});
});
