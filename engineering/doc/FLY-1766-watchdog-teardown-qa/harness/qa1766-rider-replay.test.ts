/**
 * FLY-1766 INDEPENDENT QA harness (not part of the PR; scratch worktree only).
 *
 * Independent 50-tick replay of the FLY-1560 rider anchor, written without
 * reading the implementer's assertions: it records the EXACT tick numbers on
 * which each rider fires and compares the armed-late schedule against the
 * pre-fix (absolute-anchor) schedule at the PRODUCTION cadence (N=200).
 */
import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_LEAD_RECONCILE_EVERY_N_TICKS,
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

/** Drive `ticks` polls, arming at `armAtTick`; return the ticks that fired. */
async function replay(opts: {
	ticks: number;
	armAtTick: number;
	everyNTicks: number;
	withReadyProbe: boolean;
}): Promise<number[]> {
	let armed = false;
	let tick = 0;
	const fired: number[] = [];
	const poller = makePoller({
		leadReconcileEveryNTicks: opts.everyNTicks,
		// Emulates the production holder: unarmed => the rider callback no-ops.
		onLeadReconcileTick: () => {
			if (armed) fired.push(tick);
		},
		...(opts.withReadyProbe ? { onLeadReconcileReady: () => armed } : {}),
	});
	for (tick = 1; tick <= opts.ticks; tick += 1) {
		if (tick === opts.armAtTick) armed = true;
		await poll(poller);
	}
	return fired;
}

describe("FLY-1766 QA — rider anchor 50-tick replay", () => {
	it("production cadence is 200 ticks (~10 min at 3s)", () => {
		expect(DEFAULT_LEAD_RECONCILE_EVERY_N_TICKS).toBe(200);
	});

	it("armed-late rider anchors on the first ARMED tick over 50 ticks", async () => {
		const fired = await replay({
			ticks: 50,
			armAtTick: 13,
			everyNTicks: 7,
			withReadyProbe: true,
		});
		expect(fired).toEqual([13, 20, 27, 34, 41, 48]);
	});

	it("without the readiness probe the boot pass is pushed a whole cadence out", async () => {
		// Pre-fix semantics at the PRODUCTION cadence: tick 1 burns the anchor
		// while the holder is still null, so the first effective pass is tick 201.
		const preFix = await replay({
			ticks: 50,
			armAtTick: 5,
			everyNTicks: DEFAULT_LEAD_RECONCILE_EVERY_N_TICKS,
			withReadyProbe: false,
		});
		expect(preFix).toEqual([]); // nothing in the first 50 ticks (~2.5 min)

		const postFix = await replay({
			ticks: 50,
			armAtTick: 5,
			everyNTicks: DEFAULT_LEAD_RECONCILE_EVERY_N_TICKS,
			withReadyProbe: true,
		});
		expect(postFix).toEqual([5]); // boot pass runs as soon as it is armed
	});

	it("never fires before the holder is armed", async () => {
		const fired = await replay({
			ticks: 50,
			armAtTick: 30,
			everyNTicks: 3,
			withReadyProbe: true,
		});
		expect(Math.min(...fired)).toBe(30);
		expect(fired.every((t) => t >= 30)).toBe(true);
	});

	it("a stuck pass is not re-entered, and the next tick after release resumes", async () => {
		let release: (() => void) | undefined;
		const onLeadReconcileTick = vi.fn(
			() => new Promise<void>((resolve) => (release = resolve)),
		);
		const poller = makePoller({
			onLeadReconcileTick,
			leadReconcileEveryNTicks: 1,
		});
		for (let i = 0; i < 20; i += 1) await poll(poller);
		expect(onLeadReconcileTick).toHaveBeenCalledTimes(1);
		release?.();
		await new Promise((r) => setTimeout(r, 0));
		await poll(poller);
		expect(onLeadReconcileTick).toHaveBeenCalledTimes(2);
	});
});
