/**
 * FLY-1279 B2: dead auto-QA recovery rides the existing GatePoller timer.
 * The retained QA state-convergence pass is fully error-isolated.
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

describe("FLY-1279 GatePoller auto-QA recovery piggyback", () => {
	it("fires on tick 1 and then every N ticks", async () => {
		const onQaReconcileTick = vi.fn();
		const poller = makePoller({
			onQaReconcileTick,
			qaReconcileEveryNTicks: 3,
		});
		await tick(poller, 7);
		expect(onQaReconcileTick).toHaveBeenCalledTimes(3);
	});

	it("defaults to the 20-tick maintenance cadence", async () => {
		const onQaReconcileTick = vi.fn();
		const poller = makePoller({ onQaReconcileTick });
		await tick(poller, 21);
		expect(onQaReconcileTick).toHaveBeenCalledTimes(2);
	});

	it("contains sync and async failures without breaking later ticks", async () => {
		const onQaReconcileTick = vi
			.fn()
			.mockImplementationOnce(() => {
				throw new Error("sync boom");
			})
			.mockRejectedValueOnce(new Error("async boom"))
			.mockResolvedValue(undefined);
		const poller = makePoller({
			onQaReconcileTick,
			qaReconcileEveryNTicks: 1,
		});
		await expect(tick(poller, 3)).resolves.toBeUndefined();
		expect(onQaReconcileTick).toHaveBeenCalledTimes(3);
	});

	it("surfaces a CommDB migration outage through the Lead alert sink", async () => {
		const alert = vi.fn().mockResolvedValue({ sent: true });
		const project = {
			projectName: "flywheel",
			leads: [{ agentId: "flywheel-eng-lead" }],
		};
		const poller = makePoller({
			projects: [project],
			leadAlertSink: { alert },
		});
		const migrated = (
			poller as unknown as {
				ensureCommDbMigrated(path: string, project: typeof project): boolean;
			}
		).ensureCommDbMigrated("/dev/null/comm.db", project);

		expect(migrated).toBe(false);
		await vi.waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
		expect(alert.mock.calls[0]?.[0]).toMatchObject({
			leadId: "flywheel-eng-lead",
			projectName: "flywheel",
			eventType: "crash_loop",
		});
	});
});
