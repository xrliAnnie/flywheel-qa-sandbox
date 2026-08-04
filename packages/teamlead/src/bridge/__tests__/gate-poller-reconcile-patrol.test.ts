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

async function poll(poller: GatePoller): Promise<void> {
	await (poller as unknown as { poll(): Promise<void> }).poll();
	await Promise.resolve();
}

describe("GatePoller reconcile patrol scheduling", () => {
	it("runs on tick 1 and then on the bounded maintenance cadence", async () => {
		const onReconcilePatrolTick = vi.fn();
		const poller = makePoller({
			onReconcilePatrolTick,
			reconcilePatrolEveryNTicks: 3,
		});

		for (let tick = 0; tick < 7; tick += 1) await poll(poller);

		expect(onReconcilePatrolTick).toHaveBeenCalledTimes(3);
	});

	it("keeps at most one reconcile patrol pass in flight", async () => {
		let release: (() => void) | undefined;
		const onReconcilePatrolTick = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const poller = makePoller({
			onReconcilePatrolTick,
			reconcilePatrolEveryNTicks: 1,
		});

		await poll(poller);
		await poll(poller);
		await poll(poller);
		expect(onReconcilePatrolTick).toHaveBeenCalledTimes(1);

		release?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		await poll(poller);
		expect(onReconcilePatrolTick).toHaveBeenCalledTimes(2);
	});
});
