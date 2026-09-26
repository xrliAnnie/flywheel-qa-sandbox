import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runLeadReconcilePass } from "../lead-reconcile-pass.js";
import { startPressureSampling } from "../pressure-sampler.js";
import { RunnerAdmissionController } from "../runner-admission.js";

// Real timers, production composition/scheduler, controlled I/O. Actual 30s /
// >=65s wall-clock production-cadence evidence belongs to QA, not this CI test.
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const store = () => {
	let row: any;
	return {
		getPressureSamplerState: () => row,
		setPressureSamplerState: (r: any) => {
			row = structuredClone(r);
		},
	};
};
describe("production pressure sampler wiring", () => {
	it("reads at 0/P/2P while a Lead pass is held; second normal sample releases boot and later delta blocks", async () => {
		const times: number[] = [];
		const admission = RunnerAdmissionController.alwaysAdmit();
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const pass = runLeadReconcilePass({
			reconcileLeaseEpisodes: () => held,
			scanLeadIdentities: () => {},
			materializeLeaseAudit: () => {},
			tickFleetSensors: () => {},
			reconcileAlerts: () => {},
		});
		const sampler = startPressureSampling({
			store: store(),
			admission,
			hostBootId: "boot",
			intervalMs: 60,
			readTimeoutMs: 30,
			readPressure: async () => {
				times.push(performance.now());
				return {
					freePct: 12,
					swapoutsTotal: times.length < 3 ? 100 : 100 + times.length,
					pageSize: 16384,
				};
			},
		});
		try {
			expect(admission.tryAdmit()).toMatchObject({
				admit: false,
				subreason: "warming",
			});
			await wait(85);
			expect(times.length).toBe(2);
			expect(admission.tryAdmit()).toEqual({ admit: true });
			await wait(125);
			expect(times.length).toBeGreaterThanOrEqual(4);
			expect(sampler.evaluatePressure().swapoutDeltaPages).toBeGreaterThan(0);
			expect(admission.tryAdmit()).toMatchObject({
				admit: false,
				subreason: "pressure",
			});
			expect(times[1]! - times[0]!).toBeGreaterThan(20);
			expect(times[2]! - times[1]!).toBeGreaterThan(20);
		} finally {
			await sampler.stop();
			release();
			await pass;
		}
		const count = times.length;
		await wait(85);
		expect(times).toHaveLength(count);
	});
	it("failed boot crosses 2P into unknown with admission still denied, and shutdown cancels probes", async () => {
		let reads = 0;
		const admission = RunnerAdmissionController.alwaysAdmit();
		const sampler = startPressureSampling({
			store: store(),
			admission,
			hostBootId: "boot",
			intervalMs: 40,
			readTimeoutMs: 20,
			readPressure: async () => {
				reads++;
				return null;
			},
		});
		try {
			expect(admission.tryAdmit()).toMatchObject({
				admit: false,
				subreason: "warming",
			});
			await wait(135);
			expect(reads).toBeGreaterThanOrEqual(3);
			expect(admission.tryAdmit()).toMatchObject({
				admit: false,
				subreason: "unknown",
			});
		} finally {
			await sampler.stop();
		}
		const count = reads;
		await wait(65);
		expect(reads).toBe(count);
	});
	it("plugin starts the same seam after mandatory bootstrap and before admission; stops before close", () => {
		const source = readFileSync(
			new URL("../plugin.ts", import.meta.url),
			"utf8",
		);
		const storeAt = source.indexOf("const store = opts?.store ??");
		const startAt = source.indexOf("startPressureSampling({", storeAt);
		expect(startAt).toBeGreaterThan(
			source.indexOf("const flagStore = initializeFlagStore", storeAt),
		);
		expect(startAt).toBeLessThan(
			source.indexOf("config.runnerAdmission?.setAdmissionPauseProbe", storeAt),
		);
		expect(source.indexOf("await pressureSampler.stop()")).toBeLessThan(
			source.lastIndexOf("store.close()"),
		);
		expect(source).toContain(
			"pressureSnapshot: () => pressureSampler.evaluatePressure()",
		);
	});
});
