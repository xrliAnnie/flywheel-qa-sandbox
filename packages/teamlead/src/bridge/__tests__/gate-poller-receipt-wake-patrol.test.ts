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

describe("FLY-1392 receipt wake patrol scheduling", () => {
	it("runs on tick 1 and then on the bounded maintenance cadence", async () => {
		const onReceiptWakePatrolTick = vi.fn();
		const poller = makePoller({
			onReceiptWakePatrolTick,
			receiptWakePatrolEveryNTicks: 3,
		});

		for (let tick = 0; tick < 7; tick += 1) await poll(poller);

		expect(onReceiptWakePatrolTick).toHaveBeenCalledTimes(3);
	});

	it("keeps at most one receipt patrol pass in flight", async () => {
		let release: (() => void) | undefined;
		const onReceiptWakePatrolTick = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const poller = makePoller({
			onReceiptWakePatrolTick,
			receiptWakePatrolEveryNTicks: 1,
		});

		await poll(poller);
		await poll(poller);
		await poll(poller);
		expect(onReceiptWakePatrolTick).toHaveBeenCalledTimes(1);

		release?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		await poll(poller);
		expect(onReceiptWakePatrolTick).toHaveBeenCalledTimes(2);
	});
});
