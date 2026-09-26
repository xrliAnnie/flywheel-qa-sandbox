import {
	FEATURE_FLAGS,
	getFlagStoreCodec,
	STORE_MANAGED_FLAGS,
} from "flywheel-config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	initializeFlagStore,
	storeSwapPressureSensorEnabled,
} from "../flag-store-runtime.js";
import { startPressureSampling } from "../pressure-sampler.js";
import { RunnerAdmissionController } from "../runner-admission.js";

afterEach(() => vi.useRealTimers());
describe("FLY-2920 managed SWAP switch", () => {
	it("is registered global default-on with the standard matching codec", () => {
		expect(
			FEATURE_FLAGS.find((f) => f.name === "swap_pressure_sensor"),
		).toMatchObject({
			scope: "bridge_global",
			default: true,
			polarity: "default_on",
			toggleable: "direct",
		});
		expect(STORE_MANAGED_FLAGS.has("swap_pressure_sensor")).toBe(true);
		const codec = getFlagStoreCodec("swap_pressure_sensor")!;
		expect(codec.parse({ hasOverride: false, raw: null })).toBe(true);
		expect(codec.parse({ hasOverride: true, raw: "0" })).toBe(false);
	});
	it("seeds the existing env disable once, then observes store writes in the live sampler", async () => {
		const store = await StateStore.create(":memory:");
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		const runtime = initializeFlagStore(store, {
			FLYWHEEL_FLEET_SENSOR_SWAP: "0",
		});
		const admission = RunnerAdmissionController.alwaysAdmit();
		let finish!: (p: any) => void;
		let signal!: AbortSignal;
		const read = vi.fn((s: AbortSignal) => {
			signal = s;
			return new Promise<any>((r) => {
				finish = r;
			});
		});
		const sampler = startPressureSampling({
			store,
			admission,
			enabled: () => storeSwapPressureSensorEnabled(runtime),
			hostBootId: "boot",
			readPressure: read,
			monotonicNow: Date.now,
		});
		const write = (rawTo: string) =>
			expect(
				store.applyFlagValueChange({
					name: "swap_pressure_sensor",
					rawTo,
					expectedRevision: store.getFlagValueRow("swap_pressure_sensor")!
						.revision,
					actor: "test",
					reason: "sensor maintenance",
				}),
			).toMatchObject({ ok: true });
		try {
			expect(admission.tryAdmit()).toEqual({ admit: true });
			expect(vi.getTimerCount()).toBe(0);
			write("1");
			expect(admission.tryAdmit()).toMatchObject({
				admit: false,
				subreason: "warming",
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(read).toHaveBeenCalledTimes(1);
			write("0");
			expect(admission.tryAdmit()).toEqual({ admit: true });
			expect(signal.aborted).toBe(true);
			finish({ freePct: 1, swapoutsTotal: 100, pageSize: 16384 });
			await vi.advanceTimersByTimeAsync(0);
			expect(sampler.evaluatePressure().sampledAtMs).toBeNull();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			await sampler.stop();
			store.close();
		}
	});
});
