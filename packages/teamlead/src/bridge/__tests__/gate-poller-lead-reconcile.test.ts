import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_LEAD_RECONCILE_EVERY_N_TICKS,
	DEFAULT_RUNNER_QUOTA_SCAN_EVERY_N_TICKS,
	GatePoller,
	type GatePollerConfig,
} from "../gate-poller.js";

function makePoller(overrides: Partial<GatePollerConfig> = {}) {
	return new GatePoller({
		pollIntervalMs: 3_000,
		projects: [],
		store: {} as GatePollerConfig["store"],
		runtimeRegistry: {} as GatePollerConfig["runtimeRegistry"],
		...overrides,
	});
}

async function poll(poller: GatePoller): Promise<void> {
	await (poller as unknown as { poll(): Promise<void> }).poll();
	await Promise.resolve();
}

describe("GatePoller lead reconcile rider", () => {
	it("defaults to about 10 minutes and fires on the first tick", async () => {
		expect(DEFAULT_LEAD_RECONCILE_EVERY_N_TICKS).toBe(200);
		const onLeadReconcileTick = vi.fn();
		const poller = makePoller({
			onLeadReconcileTick,
			leadReconcileEveryNTicks: 3,
		});

		for (let tick = 0; tick < 7; tick += 1) await poll(poller);

		expect(onLeadReconcileTick).toHaveBeenCalledTimes(3);
	});

	it("keeps at most one pass in flight", async () => {
		let release: (() => void) | undefined;
		const onLeadReconcileTick = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const poller = makePoller({
			onLeadReconcileTick,
			leadReconcileEveryNTicks: 1,
		});

		await poll(poller);
		await poll(poller);
		await poll(poller);
		expect(onLeadReconcileTick).toHaveBeenCalledTimes(1);

		release?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		await poll(poller);
		expect(onLeadReconcileTick).toHaveBeenCalledTimes(2);
	});

	it("registers only the GatePoller rider and removes the old poll-complete host", () => {
		const plugin = readFileSync(
			new URL("../plugin.ts", import.meta.url),
			"utf8",
		);
		expect(plugin.match(/onLeadReconcileTick:/g)).toHaveLength(1);
		expect(plugin.match(/onRunnerQuotaScanTick:/g)).toHaveLength(1);
		expect(plugin).not.toContain("onPollComplete:");
		expect(plugin).not.toContain("RunnerIdleWatchdog");
	});
});

describe("GatePoller runner quota scan rider", () => {
	it("defaults to about one minute and fires on the first tick", async () => {
		expect(DEFAULT_RUNNER_QUOTA_SCAN_EVERY_N_TICKS).toBe(20);
		const onRunnerQuotaScanTick = vi.fn();
		const poller = makePoller({
			onRunnerQuotaScanTick,
			runnerQuotaScanEveryNTicks: 3,
		});

		for (let tick = 0; tick < 7; tick += 1) await poll(poller);

		expect(onRunnerQuotaScanTick).toHaveBeenCalledTimes(3);
	});

	it("keeps at most one scan pass in flight", async () => {
		let release: (() => void) | undefined;
		const onRunnerQuotaScanTick = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const poller = makePoller({
			onRunnerQuotaScanTick,
			runnerQuotaScanEveryNTicks: 1,
		});

		await poll(poller);
		await poll(poller);
		expect(onRunnerQuotaScanTick).toHaveBeenCalledTimes(1);
		release?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		await poll(poller);
		expect(onRunnerQuotaScanTick).toHaveBeenCalledTimes(2);
	});
});

/**
 * FLY-1560 (Codex R1 MEDIUM-1): both riders are assembled ~1.5k lines after
 * `gatePoller.start()` in the Bridge composition root, so on a slow boot the
 * very first 3s tick can land while the holder is still null. The cadence
 * anchor is absolute (`(tickCount - 1) % N`), so an unarmed first tick does not
 * just no-op — it BURNS the anchor and pushes the boot pass out by a full
 * cadence (~10 min for lead reconcile). That silently contradicts the declared
 * "run one reconcile at boot" semantics. The anchor must be set by the first
 * tick that actually runs, not by tick 1 unconditionally.
 */
describe("FLY-1560 late-armed riders do not burn the cadence anchor", () => {
	it("anchors lead reconcile on the first ARMED tick, not on tick 1", async () => {
		const onLeadReconcileTick = vi.fn();
		let armed = false;
		const poller = makePoller({
			onLeadReconcileTick,
			onLeadReconcileReady: () => armed,
			leadReconcileEveryNTicks: 3,
		});

		// Boot window: the pass does not exist yet.
		await poll(poller);
		await poll(poller);
		expect(onLeadReconcileTick).toHaveBeenCalledTimes(0);

		// The composition root finishes and arms the holder.
		armed = true;
		await poll(poller);
		expect(onLeadReconcileTick).toHaveBeenCalledTimes(1);

		// …and the cadence then runs from THAT tick.
		await poll(poller);
		await poll(poller);
		expect(onLeadReconcileTick).toHaveBeenCalledTimes(1);
		await poll(poller);
		expect(onLeadReconcileTick).toHaveBeenCalledTimes(2);
	});

	it("anchors the runner quota scan on the first ARMED tick too", async () => {
		const onRunnerQuotaScanTick = vi.fn();
		let armed = false;
		const poller = makePoller({
			onRunnerQuotaScanTick,
			onRunnerQuotaScanReady: () => armed,
			runnerQuotaScanEveryNTicks: 2,
		});

		await poll(poller);
		await poll(poller);
		expect(onRunnerQuotaScanTick).toHaveBeenCalledTimes(0);

		armed = true;
		await poll(poller);
		expect(onRunnerQuotaScanTick).toHaveBeenCalledTimes(1);
		await poll(poller);
		expect(onRunnerQuotaScanTick).toHaveBeenCalledTimes(1);
		await poll(poller);
		expect(onRunnerQuotaScanTick).toHaveBeenCalledTimes(2);
	});

	it("anchors the weekly flag-scan rider on the first ARMED tick", async () => {
		const onFlagScanTick = vi.fn();
		let armed = false;
		const poller = makePoller({
			onFlagScanTick,
			onFlagScanReady: () => armed,
			flagScanEveryNTicks: 2,
		});

		await poll(poller);
		await poll(poller);
		expect(onFlagScanTick).toHaveBeenCalledTimes(0);

		armed = true;
		await poll(poller);
		expect(onFlagScanTick).toHaveBeenCalledTimes(1);
		await poll(poller);
		expect(onFlagScanTick).toHaveBeenCalledTimes(1);
		await poll(poller);
		expect(onFlagScanTick).toHaveBeenCalledTimes(2);
	});

	it("keeps byte-compatible tick-1 behavior when no readiness probe is given", async () => {
		const onLeadReconcileTick = vi.fn();
		const poller = makePoller({
			onLeadReconcileTick,
			leadReconcileEveryNTicks: 3,
		});
		await poll(poller);
		expect(onLeadReconcileTick).toHaveBeenCalledTimes(1);
	});
});
