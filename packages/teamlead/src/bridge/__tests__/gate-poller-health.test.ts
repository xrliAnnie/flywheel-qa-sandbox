/**
 * FLY-513: GatePoller piggybacks a global-codex drift probe on its existing
 * poll tick (zero new periodic timer). These tests pin the cadence + isolation:
 * the probe fires on the expected ticks, outside the per-project loop, and a
 * throwing probe never breaks the poll loop.
 */
import { describe, expect, it, vi } from "vitest";
import { GatePoller, type GatePollerConfig } from "../gate-poller.js";

// Minimal config: no projects → poll() skips the (project,lead) relay loop and
// exercises only the tick counter + the FLY-513 health piggyback.
function makePoller(overrides: Record<string, unknown> = {}) {
	return new GatePoller({
		pollIntervalMs: 3_000,
		projects: [],
		// test stubs — unused because projects is empty (poll() skips the loop).
		store: {} as unknown as GatePollerConfig["store"],
		runtimeRegistry: {} as unknown as GatePollerConfig["runtimeRegistry"],
		...overrides,
	});
}

async function tick(poller: GatePoller, n: number) {
	for (let i = 0; i < n; i++) {
		// poll() is private; drive it directly to advance the tick counter.
		await (poller as unknown as { poll(): Promise<void> }).poll();
	}
}

describe("FLY-513 GatePoller onHealthTick piggyback", () => {
	it("fires on tick 1 and then every N ticks (cadence)", async () => {
		const onHealthTick = vi.fn();
		const poller = makePoller({ onHealthTick, healthCheckEveryNTicks: 3 });
		await tick(poller, 7); // (tick-1) % 3 === 0 → fires at 1, 4, 7
		expect(onHealthTick).toHaveBeenCalledTimes(3);
	});

	it("N=1 fires on EVERY tick (Codex R1 LOW: degenerate cadence must not disable it)", async () => {
		const onHealthTick = vi.fn();
		const poller = makePoller({ onHealthTick, healthCheckEveryNTicks: 1 });
		await tick(poller, 4);
		expect(onHealthTick).toHaveBeenCalledTimes(4);
	});

	it("is a complete no-op when onHealthTick is not provided (byte-compat)", async () => {
		const poller = makePoller(); // no onHealthTick
		await expect(tick(poller, 5)).resolves.toBeUndefined();
	});

	it("a throwing probe never breaks the poll loop", async () => {
		const onHealthTick = vi.fn(() => {
			throw new Error("probe boom");
		});
		// N=1 fires every tick — the probe genuinely runs + throws each time.
		const poller = makePoller({ onHealthTick, healthCheckEveryNTicks: 1 });
		await expect(tick(poller, 3)).resolves.toBeUndefined();
		expect(onHealthTick).toHaveBeenCalledTimes(3);
	});

	it("a rejecting async probe is swallowed (never rejects poll)", async () => {
		const onHealthTick = vi.fn().mockRejectedValue(new Error("async boom"));
		const poller = makePoller({ onHealthTick, healthCheckEveryNTicks: 1 });
		await expect(tick(poller, 3)).resolves.toBeUndefined();
		expect(onHealthTick).toHaveBeenCalled();
	});
});

describe("FLY-1944 GatePoller cmux watcher rider", () => {
	it("shares the existing 60s rider cadence and contains failures", async () => {
		const onCmuxWatcherPatrolTick = vi
			.fn()
			.mockRejectedValue(new Error("watcher patrol boom"));
		const poller = makePoller({ onCmuxWatcherPatrolTick });
		await expect(tick(poller, 21)).resolves.toBeUndefined();
		expect(onCmuxWatcherPatrolTick).toHaveBeenCalledTimes(2);
	});
});

describe("FLY-2216 GatePoller resident Codex Lead patrol rider", () => {
	it("shares the existing 60s rider cadence and contains failures", async () => {
		const onResidentCodexLeadPatrolTick = vi
			.fn()
			.mockRejectedValue(new Error("resident Codex Lead patrol boom"));
		const poller = makePoller({ onResidentCodexLeadPatrolTick });
		await expect(tick(poller, 21)).resolves.toBeUndefined();
		expect(onResidentCodexLeadPatrolTick).toHaveBeenCalledTimes(2);
	});
});

describe("FLY-1314 GatePoller issue-gate supersede piggyback", () => {
	it("runs on every existing poll tick without adding a timer", async () => {
		const onIssueGateSupersedeTick = vi.fn();
		const poller = makePoller({ onIssueGateSupersedeTick });
		await tick(poller, 3);
		expect(onIssueGateSupersedeTick).toHaveBeenCalledTimes(3);
	});

	it("contains sync and async patrol failures", async () => {
		const syncPoller = makePoller({
			onIssueGateSupersedeTick: vi.fn(() => {
				throw new Error("supersede boom");
			}),
		});
		await expect(tick(syncPoller, 2)).resolves.toBeUndefined();

		const asyncPoller = makePoller({
			onIssueGateSupersedeTick: vi
				.fn()
				.mockRejectedValue(new Error("async supersede boom")),
		});
		await expect(tick(asyncPoller, 2)).resolves.toBeUndefined();
	});
});
