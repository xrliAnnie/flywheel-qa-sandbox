/**
 * FLY-1279 B2: dead auto-QA recovery rides the existing GatePoller timer.
 * It is independent of park-watch and fully error-isolated.
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

	it("keeps park-watch passes single-flight while a prior inventory is unresolved", async () => {
		let release!: () => void;
		const firstPass = new Promise<void>((resolve) => {
			release = resolve;
		});
		const onParkWatchTick = vi
			.fn<() => Promise<void>>()
			.mockReturnValueOnce(firstPass)
			.mockResolvedValue(undefined);
		const poller = makePoller({
			onParkWatchTick,
			parkWatchEveryNTicks: 1,
		});

		await tick(poller, 3);
		expect(onParkWatchTick).toHaveBeenCalledTimes(1);

		release();
		await firstPass;
		await vi.waitFor(() =>
			expect(
				(poller as unknown as { parkWatchPass: Promise<void> | null })
					.parkWatchPass,
			).toBeNull(),
		);
		await tick(poller, 1);
		expect(onParkWatchTick).toHaveBeenCalledTimes(2);
	});

	it("defaults delivery reconciliation to the shared 20-tick maintenance cadence", async () => {
		const onDeliveryReconcileTick = vi.fn();
		const poller = makePoller({ onDeliveryReconcileTick });
		await tick(poller, 21);
		expect(onDeliveryReconcileTick).toHaveBeenCalledTimes(2);
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
