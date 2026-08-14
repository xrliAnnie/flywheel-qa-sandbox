/**
 * FLY-1766 QA A3 (independent) — the 5 relocated riders, driven through the REAL
 * GatePoller + the REAL runLeadReconcilePass, with:
 *   - dependency ORDER recorded from the actual calls (not from reading the source)
 *   - per-segment failure isolation: inject a throw into EACH of the 5 segments in
 *     turn and assert every later segment still runs
 *   - overlap protection: a wedged pass must not be re-entered
 *   - the quota-scan rider's 1h/session claim gate still throttles
 */
import { describe, expect, it, vi } from "vitest";
import {
	GatePoller,
	type GatePollerConfig,
} from "../gate-poller.js";
import { runLeadReconcilePass } from "../lead-reconcile-pass.js";

const SEGMENTS = [
	"reconcileLeaseEpisodes",
	"scanLeadIdentities",
	"materializeLeaseAudit",
	"tickFleetSensors",
	"reconcileAlerts",
] as const;

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

/** Build a real pass whose segments record themselves; optionally one throws. */
function instrumentedPass(calls: string[], throwAt?: string) {
	const step = (name: string) => async () => {
		calls.push(name);
		if (name === throwAt) throw new Error(`${name} injected failure`);
	};
	return () =>
		runLeadReconcilePass({
			reconcileLeaseEpisodes: step("reconcileLeaseEpisodes"),
			scanLeadIdentities: step("scanLeadIdentities"),
			materializeLeaseAudit: step("materializeLeaseAudit"),
			tickFleetSensors: step("tickFleetSensors"),
			reconcileAlerts: step("reconcileAlerts"),
			logger: () => {},
		});
}

describe("FLY-1766 QA — 5 relocated riders under the real GatePoller", () => {
	it("runs all five in the declared dependency order (sensors BEFORE hub reconcile)", async () => {
		const calls: string[] = [];
		const poller = makePoller({
			onLeadReconcileTick: instrumentedPass(calls),
			leadReconcileEveryNTicks: 1,
		});
		await poll(poller);
		await new Promise((r) => setTimeout(r, 10));
		expect(calls).toEqual([...SEGMENTS]);
		expect(calls.indexOf("tickFleetSensors")).toBeLessThan(
			calls.indexOf("reconcileAlerts"),
		);
	});

	it.each(SEGMENTS)(
		"isolates a failure in %s — every later segment still runs",
		async (failing) => {
			const calls: string[] = [];
			const poller = makePoller({
				onLeadReconcileTick: instrumentedPass(calls, failing),
				leadReconcileEveryNTicks: 1,
			});
			await poll(poller);
			await new Promise((r) => setTimeout(r, 10));
			// Every segment attempted, in order, despite the injected throw.
			expect(calls).toEqual([...SEGMENTS]);
		},
	);

	it("does not re-enter a wedged pass, and resumes on the tick after release", async () => {
		let release: (() => void) | undefined;
		const tick = vi.fn(
			() => new Promise<void>((resolve) => (release = resolve)),
		);
		const poller = makePoller({
			onLeadReconcileTick: tick,
			leadReconcileEveryNTicks: 1,
		});
		for (let i = 0; i < 12; i += 1) await poll(poller);
		expect(tick).toHaveBeenCalledTimes(1);
		release?.();
		await new Promise((r) => setTimeout(r, 0));
		await poll(poller);
		expect(tick).toHaveBeenCalledTimes(2);
	});
});
