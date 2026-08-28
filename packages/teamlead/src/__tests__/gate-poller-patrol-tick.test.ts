import { describe, expect, it, vi } from "vitest";
import { GatePoller } from "../bridge/gate-poller.js";
import { RuntimeRegistry } from "../bridge/runtime-registry.js";
import type { StateStore } from "../StateStore.js";

describe("FLY-1687 GatePoller patrol rider", () => {
	it.each([0, -1, Number.NaN])(
		"keeps the display sweep enabled when the test cadence is %s",
		async (displayReconcileEveryNTicks) => {
			const onDisplayReconcileTick = vi.fn(async () => undefined);
			const poller = new GatePoller({
				pollIntervalMs: 3_000,
				projects: [],
				store: {
					recoverFromCorruption: vi.fn(),
					listPendingFounderActions: () => [],
					getActiveSessions: () => [],
				} as unknown as StateStore,
				runtimeRegistry: new RuntimeRegistry(),
				onDisplayReconcileTick,
				displayReconcileEveryNTicks,
			});

			await (poller as unknown as { poll: () => Promise<void> }).poll();
			await vi.waitFor(() =>
				expect(onDisplayReconcileTick).toHaveBeenCalledTimes(1),
			);
		},
	);

	it("fires on the existing 20-tick cadence without adding a timer", async () => {
		const onLeadPatrolTick = vi.fn(async () => undefined);
		const poller = new GatePoller({
			pollIntervalMs: 3_000,
			projects: [],
			store: {
				recoverFromCorruption: vi.fn(),
				listPendingFounderActions: () => [],
				getActiveSessions: () => [],
			} as unknown as StateStore,
			runtimeRegistry: new RuntimeRegistry(),
			onLeadPatrolTick,
		});

		await (poller as unknown as { poll: () => Promise<void> }).poll();
		await vi.waitFor(() => expect(onLeadPatrolTick).toHaveBeenCalledTimes(1));
		for (let i = 0; i < 19; i++) {
			await (poller as unknown as { poll: () => Promise<void> }).poll();
		}
		expect(onLeadPatrolTick).toHaveBeenCalledTimes(1);
		await (poller as unknown as { poll: () => Promise<void> }).poll();
		await vi.waitFor(() => expect(onLeadPatrolTick).toHaveBeenCalledTimes(2));
	});
});
