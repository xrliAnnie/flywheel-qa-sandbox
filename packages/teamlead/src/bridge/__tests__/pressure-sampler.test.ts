import { afterEach, describe, expect, it, vi } from "vitest";
import {
	MemoryPressureMonitor,
	PRESSURE_READ_TIMEOUT_MS,
	PRESSURE_SAMPLE_INTERVAL_MS,
} from "../machine-watermark.js";
import {
	createPressureSampler,
	pressureSensorEnabled,
} from "../pressure-sampler.js";

const th = { freeLowPct: 8, freeHighPct: 15, swapoutMinPages: 0 };
const p = (freePct = 12, swapoutsTotal = 100) => ({
	freePct,
	swapoutsTotal,
	pageSize: 16384,
});
const monitor = () =>
	new MemoryPressureMonitor(th, 2, { warmupUntilMs: 60_000, maxAgeMs: 90_000 });
const memoryStore = () => {
	let row: any;
	return {
		getPressureSamplerState: () => row,
		setPressureSamplerState: (value: any) => {
			row = structuredClone(value);
		},
	};
};
afterEach(() => vi.useRealTimers());
describe("fresh pressure evidence", () => {
	it("uses 30s cadence and bounded 5s reads", () => {
		expect(PRESSURE_SAMPLE_INTERVAL_MS).toBe(30_000);
		expect(PRESSURE_READ_TIMEOUT_MS).toBe(5_000);
	});
	it("denies boot warming, first delta danger confirms boot, band immediately releases", () => {
		const m = monitor();
		expect(m.evaluatePressure(0).state).toBe("warming");
		m.tick(p(12), 0);
		m.tick(p(12, 101), 30_000);
		expect(m.evaluatePressure(30_000).state).toBe("pressure");
		m.tick(p(8, 101), 60_000);
		expect(m.evaluatePressure(60_000)).toMatchObject({
			state: "healthy",
			swapoutDeltaPages: 0,
			sampledAtMs: 60_000,
		});
	});
	it("normal chain requires two consecutive dangerous readings, not one", () => {
		const m = monitor();
		m.tick(p(), 0);
		m.tick(p(), 30_000);
		m.tick(p(5), 60_000);
		expect(m.evaluatePressure(60_000).state).toBe("healthy");
		m.tick(p(5), 90_000);
		expect(m.evaluatePressure(90_000).state).toBe("pressure");
	});
	it("failed reads never extend confirmed evidence and expiry becomes unknown", () => {
		const m = monitor();
		m.tick(p(5), 0);
		m.tick(p(5), 30_000);
		m.tick(null, 119_999);
		expect(m.evaluatePressure(119_999)).toMatchObject({
			state: "pressure",
			evidenceValidUntilMs: 120_000,
		});
		expect(m.evaluatePressure(120_000).state).toBe("unknown");
		m.tick(p(), 120_001);
		expect(m.evaluatePressure(120_001).state).toBe("unknown");
		m.tick(p(), 150_001);
		expect(m.evaluatePressure(150_001).state).toBe("healthy");
	});
	it("failure preserves a fresh baseline; regression and long gaps reset it", () => {
		const m = monitor();
		m.tick(p(), 0);
		m.tick(null, 30_000);
		expect(m.tick(p(), 60_000).swapoutDelta).toBe(0);
		expect(m.tick(p(12, 1), 90_000).swapoutDelta).toBeNull();
		expect(m.tick(p(12, 1), 180_001).swapoutDelta).toBeNull();
	});
	it("all failed warmup expires to unknown, never healthy", () => {
		const m = monitor();
		m.tick(null, 20_000);
		expect(m.evaluatePressure(59_999).state).toBe("warming");
		expect(m.evaluatePressure(60_000).state).toBe("unknown");
	});
});
describe("independent sampler", () => {
	it("is off in tests/non-mac unless explicitly injected/QA; explicit off wins", () => {
		expect(pressureSensorEnabled({ NODE_ENV: "test" }, "darwin")).toBe(false);
		expect(pressureSensorEnabled({}, "linux")).toBe(false);
		expect(
			pressureSensorEnabled({ FLYWHEEL_SWAP_SENSOR_CMD: "fixture" }, "linux"),
		).toBe(true);
	});
	it("starts immediately, freezes warmup before reads and survives repeated failed restarts", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		const store = memoryStore();
		const read = vi.fn(async () => null);
		const s = createPressureSampler({
			store,
			readPressure: read,
			hostBootId: "boot",
			monotonicNow: Date.now,
		});
		s.start();
		expect(store.getPressureSamplerState().warmupUntilMs).toBe(61_000);
		await vi.advanceTimersByTimeAsync(0);
		expect(read).toHaveBeenCalledTimes(1);
		await s.stop();
		vi.setSystemTime(62_000);
		const restarted = createPressureSampler({
			store,
			readPressure: read,
			hostBootId: "boot",
			monotonicNow: Date.now,
		});
		restarted.start();
		expect(restarted.evaluatePressure().state).toBe("unknown");
		expect(store.getPressureSamplerState().warmupUntilMs).toBe(61_000);
		await restarted.stop();
	});
	it("times out/aborts and never overlaps a probe that ignores cancellation or writes its late result", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		let finish!: (p: any) => void;
		let signal!: AbortSignal;
		const read = vi.fn((s: AbortSignal) => {
			signal = s;
			return new Promise<any>((r) => {
				finish = r;
			});
		});
		const s = createPressureSampler({
			store: memoryStore(),
			readPressure: read,
			hostBootId: "boot",
			monotonicNow: Date.now,
		});
		s.start();
		await vi.advanceTimersByTimeAsync(95_000);
		expect(read).toHaveBeenCalledTimes(1);
		expect(signal.aborted).toBe(true);
		expect(s.evaluatePressure().state).toBe("unknown");
		await s.stop();
		finish(p());
		await Promise.resolve();
		expect(s.evaluatePressure().sampledAtMs).toBeNull();
		await vi.advanceTimersByTimeAsync(90_000);
		expect(read).toHaveBeenCalledTimes(1);
	});
	it("cache read/freeze failure denies unknown and a later valid pair recovers", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		const store = memoryStore();
		let broken = true;
		const s = createPressureSampler({
			store: {
				getPressureSamplerState: () => {
					if (broken) throw Error("read");
					return store.getPressureSamplerState();
				},
				setPressureSamplerState: (v) => {
					if (broken) throw Error("write");
					store.setPressureSamplerState(v);
				},
			},
			readPressure: async () => p(),
			hostBootId: "boot",
			monotonicNow: Date.now,
		});
		s.start();
		expect(s.evaluatePressure()).toMatchObject({
			state: "unknown",
			reason: "cache_unavailable",
		});
		broken = false;
		await vi.advanceTimersByTimeAsync(30_000);
		expect(s.evaluatePressure().state).toBe("healthy");
		await s.stop();
	});
});

describe("durable notifications and cache", () => {
	it("notifications wait for two danger/non-danger samples, retry independently, and replay pending after restart", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		const store = memoryStore();
		let reading = p(5);
		const s = createPressureSampler({
			store,
			readPressure: async () => reading,
			hostBootId: "boot",
			monotonicNow: Date.now,
		});
		s.start();
		await vi.advanceTimersByTimeAsync(30_000);
		const notices: string[] = [];
		let accepted = false;
		s.attachNotifications(async (n) => {
			notices.push(n.kind);
			return accepted;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(notices).toEqual(["pause"]);
		reading = p(12);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(s.evaluatePressure().state).toBe("healthy");
		await vi.advanceTimersByTimeAsync(30_000);
		await s.stop();
		const restart = createPressureSampler({
			store,
			readPressure: async () => reading,
			hostBootId: "boot",
			monotonicNow: Date.now,
		});
		restart.start();
		accepted = true;
		const delivered: string[] = [];
		restart.attachNotifications(async (n) => {
			delivered.push(n.kind);
			return true;
		});
		await vi.advanceTimersByTimeAsync(5000);
		expect(delivered).toEqual(["pause", "resume"]);
		await restart.stop();
	});
	it("slow notification HTTP never holds a sampling slot and expiry reports degraded, not recovery", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		const read = vi.fn(async () => p(5));
		const s = createPressureSampler({
			store: memoryStore(),
			readPressure: read,
			hostBootId: "boot",
			monotonicNow: Date.now,
		});
		s.start();
		let resolve!: (ok: boolean) => void;
		s.attachNotifications(
			() =>
				new Promise((r) => {
					resolve = r;
				}),
		);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(read).toHaveBeenCalledTimes(5);
		read.mockImplementation(async () => null as any);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(s.evaluatePressure().state).toBe("unknown");
		const stopped = s.stop();
		resolve(true);
		await stopped;
	});
	it("invalid cache retains verifiable deadline; new host boot alone gets a new warmup", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(100_000);
		const store = memoryStore();
		store.setPressureSamplerState({
			hostBootId: "boot",
			warmupUntilMs: 60_000,
			cacheJson: "bad",
		});
		const s = createPressureSampler({
			store,
			readPressure: async () => null,
			hostBootId: "boot",
		});
		expect(s.evaluatePressure().state).toBe("unknown");
		await s.stop();
		const next = createPressureSampler({
			store,
			readPressure: async () => null,
			hostBootId: "new-boot",
		});
		expect(next.evaluatePressure().state).toBe("warming");
		expect(store.getPressureSamplerState().warmupUntilMs).toBe(160_000);
		await next.stop();
	});
	it("unverified host boot identity cannot renew warmup or admit", () => {
		const store = memoryStore();
		const s = createPressureSampler({
			store,
			readPressure: async () => p(),
			hostBootId: null,
		});
		expect(s.evaluatePressure()).toMatchObject({
			state: "unknown",
			reason: "cache_unavailable",
		});
		expect(store.getPressureSamplerState()).toMatchObject({
			hostBootId: "",
			warmupUntilMs: 0,
		});
		expect(
			JSON.parse(store.getPressureSamplerState().cacheJson)
				.evidenceHostVerified,
		).toBe(false);
	});
});

describe("degraded persistence boundaries", () => {
	it("never calls the notification sink until the pending notice is persisted", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		const store = memoryStore();
		let fail = false;
		const s = createPressureSampler({
			store: {
				...store,
				setPressureSamplerState: (r) => {
					if (fail) throw Error("disk full");
					store.setPressureSamplerState(r);
				},
			},
			readPressure: async () => p(5),
			hostBootId: "boot",
			monotonicNow: Date.now,
			logger: () => {},
		});
		const sink = vi.fn(async () => true);
		s.attachNotifications(sink);
		s.start();
		await vi.advanceTimersByTimeAsync(0);
		fail = true;
		await vi.advanceTimersByTimeAsync(30_000);
		expect(sink).not.toHaveBeenCalled();
		fail = false;
		await vi.advanceTimersByTimeAsync(30_000);
		expect(sink).toHaveBeenCalledTimes(1);
		await s.stop();
	});
	it("unknown boot prevents cache reuse but a live valid non-danger pair releases", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		const s = createPressureSampler({
			store: memoryStore(),
			readPressure: async () => p(),
			hostBootId: null,
			monotonicNow: Date.now,
		});
		s.start();
		expect(s.evaluatePressure().state).toBe("unknown");
		await vi.advanceTimersByTimeAsync(30_000);
		expect(s.evaluatePressure().state).toBe("healthy");
		await s.stop();
	});
});

describe("cache remains bounded and compatible", () => {
	it("sustained danger cache restores original pressure expiry without stamping restart time", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		const store = memoryStore();
		const s = createPressureSampler({
			store,
			readPressure: async () => p(5),
			hostBootId: "boot",
			monotonicNow: Date.now,
		});
		s.start();
		await vi.advanceTimersByTimeAsync(120_000);
		await s.stop();
		vi.setSystemTime(122_000);
		const r = createPressureSampler({
			store,
			readPressure: async () => null,
			hostBootId: "boot",
			monotonicNow: Date.now,
		});
		expect(r.evaluatePressure()).toMatchObject({
			state: "pressure",
			sampledAtMs: 121_000,
			evidenceValidUntilMs: 211_000,
		});
		expect(
			JSON.parse(store.getPressureSamplerState().cacheJson).monitor.samples,
		).toHaveLength(2);
		await r.stop();
	});
});

describe("notification evidence is independent of sensor compatibility", () => {
	it.each(["reboot", "threshold"])(
		"replays pending pause and later resume after %s",
		async (change) => {
			vi.useFakeTimers();
			vi.setSystemTime(1000);
			const store = memoryStore();
			const s = createPressureSampler({
				store,
				hostBootId: "boot",
				readPressure: async () => p(5),
				monotonicNow: Date.now,
			});
			s.start();
			await vi.advanceTimersByTimeAsync(30_000);
			await s.stop();
			const r = createPressureSampler({
				store,
				hostBootId: change === "reboot" ? "boot-2" : "boot",
				env: change === "threshold" ? { FLYWHEEL_MEM_FREE_LOW_PCT: "7" } : {},
				readPressure: async () => p(12),
				monotonicNow: Date.now,
			});
			const delivered: string[] = [];
			r.attachNotifications(async (n) => {
				delivered.push(n.kind);
				return true;
			});
			r.start();
			await vi.advanceTimersByTimeAsync(61_000);
			expect(delivered).toEqual(["pause", "resume"]);
			await r.stop();
		},
	);
});

describe("scheduler and evidence boundaries", () => {
	it("timestamps completion, skips missed monotonic beats and never catches up in bursts", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		let mono = 0;
		let finish!: (p: any) => void;
		const read = vi.fn(
			() =>
				new Promise<any>((r) => {
					finish = r;
				}),
		);
		const s = createPressureSampler({
			store: memoryStore(),
			hostBootId: "boot",
			readPressure: read,
			monotonicNow: () => mono,
		});
		s.start();
		await vi.advanceTimersByTimeAsync(0);
		mono = 3000;
		await vi.advanceTimersByTimeAsync(3000);
		finish(p());
		await vi.advanceTimersByTimeAsync(0);
		expect(s.evaluatePressure().sampledAtMs).toBe(4000);
		mono = 100_000;
		await vi.advanceTimersByTimeAsync(27_000);
		expect(read).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(0);
		expect(read).toHaveBeenCalledTimes(2);
		finish(p());
		await vi.advanceTimersByTimeAsync(0);
		mono = 120_000;
		await vi.advanceTimersByTimeAsync(20_000);
		expect(read).toHaveBeenCalledTimes(3);
		await s.stop();
	});
	it("disabled sensor has no probe or timer and explicitly admits", async () => {
		vi.useFakeTimers();
		const read = vi.fn(async () => p());
		const s = createPressureSampler({
			store: memoryStore(),
			hostBootId: "boot",
			readPressure: read,
			enabled: false,
		});
		s.start();
		expect(vi.getTimerCount()).toBe(0);
		expect(read).not.toHaveBeenCalled();
		expect(s.evaluatePressure()).toMatchObject({
			state: "healthy",
			reason: "sensor_disabled",
		});
		await s.stop();
	});
	it("cache cannot extend evidence expiry beyond current 3P or accept future samples", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		const store = memoryStore();
		const s = createPressureSampler({
			store,
			hostBootId: "boot",
			readPressure: async () => p(5),
			monotonicNow: Date.now,
		});
		s.start();
		await vi.advanceTimersByTimeAsync(30_000);
		await s.stop();
		const row = store.getPressureSamplerState();
		const cache = JSON.parse(row.cacheJson);
		cache.monitor.pressureValidUntilMs = 999_999;
		store.setPressureSamplerState({ ...row, cacheJson: JSON.stringify(cache) });
		const r = createPressureSampler({
			store,
			hostBootId: "boot",
			readPressure: async () => null,
		});
		expect(r.evaluatePressure().evidenceValidUntilMs).toBe(121_000);
		await r.stop();
		cache.monitor.samples[1].sampledAtMs = 999_999;
		store.setPressureSamplerState({
			...row,
			warmupUntilMs: 0,
			cacheJson: JSON.stringify(cache),
		});
		const future = createPressureSampler({
			store,
			hostBootId: "boot",
			readPressure: async () => null,
		});
		expect(future.evaluatePressure()).toMatchObject({
			state: "unknown",
			sampledAtMs: null,
		});
		await future.stop();
	});
	it("late notification acceptance after stop never writes the closed store", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		const store = memoryStore();
		const write = vi.spyOn(store, "setPressureSamplerState");
		let finish!: (v: boolean) => void;
		const s = createPressureSampler({
			store,
			hostBootId: "boot",
			readPressure: async () => p(5),
			monotonicNow: Date.now,
		});
		s.attachNotifications(
			() =>
				new Promise((r) => {
					finish = r;
				}),
		);
		s.start();
		await vi.advanceTimersByTimeAsync(30_000);
		const stopped = s.stop();
		const count = write.mock.calls.length;
		finish(true);
		await stopped;
		await vi.advanceTimersByTimeAsync(90_000);
		expect(write).toHaveBeenCalledTimes(count);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("normal isolated pressure spikes never page or fan out to Lead mailboxes", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		let n = 0;
		const s = createPressureSampler({
			store: memoryStore(),
			hostBootId: "boot",
			readPressure: async () => p(++n > 2 && n % 3 === 0 ? 5 : 12),
			monotonicNow: Date.now,
		});
		const sink = vi.fn(async () => true);
		s.attachNotifications(sink);
		s.start();
		await vi.advanceTimersByTimeAsync(300_000);
		expect(sink).not.toHaveBeenCalled();
		await s.stop();
	});
});

describe("live sensor control", () => {
	it("enable after disabled start samples immediately; disable during await aborts and rejects the late result", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		let enabled = false;
		let finish!: (p: any) => void;
		let signal!: AbortSignal;
		const store = memoryStore();
		const write = vi.spyOn(store, "setPressureSamplerState");
		const read = vi.fn((s: AbortSignal) => {
			signal = s;
			return new Promise<any>((r) => {
				finish = r;
			});
		});
		const s = createPressureSampler({
			store,
			enabled: () => enabled,
			hostBootId: "boot",
			readPressure: read,
			monotonicNow: Date.now,
		});
		s.start();
		expect(vi.getTimerCount()).toBe(0);
		expect(s.evaluatePressure().reason).toBe("sensor_disabled");
		enabled = true;
		expect(s.evaluatePressure().state).toBe("warming");
		await vi.advanceTimersByTimeAsync(0);
		expect(read).toHaveBeenCalledTimes(1);
		enabled = false;
		expect(s.evaluatePressure().reason).toBe("sensor_disabled");
		expect(signal.aborted).toBe(true);
		const writes = write.mock.calls.length;
		finish(p(5));
		await vi.advanceTimersByTimeAsync(100_000);
		expect(write).toHaveBeenCalledTimes(writes);
		expect(read).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
		await s.stop();
	});
	it("observes disable after await even when no admission reader ran in between", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		let enabled = true;
		let finish!: (p: any) => void;
		const s = createPressureSampler({
			store: memoryStore(),
			enabled: () => enabled,
			hostBootId: "boot",
			readPressure: () =>
				new Promise<any>((r) => {
					finish = r;
				}),
			monotonicNow: Date.now,
		});
		s.start();
		await vi.advanceTimersByTimeAsync(0);
		enabled = false;
		finish(p(5));
		await vi.advanceTimersByTimeAsync(0);
		expect(s.evaluatePressure()).toMatchObject({
			reason: "sensor_disabled",
			sampledAtMs: null,
		});
		expect(vi.getTimerCount()).toBe(0);
		await s.stop();
	});
	it("an initial storage read outage never overwrites existing durable notification history on recovery", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		const store = memoryStore();
		const a = createPressureSampler({
			store,
			hostBootId: "boot",
			readPressure: async () => p(5),
			monotonicNow: Date.now,
		});
		a.start();
		await vi.advanceTimersByTimeAsync(30_000);
		await a.stop();
		let broken = true;
		const b = createPressureSampler({
			store: {
				getPressureSamplerState: () => {
					if (broken) throw Error("busy");
					return store.getPressureSamplerState();
				},
				setPressureSamplerState: store.setPressureSamplerState,
			},
			hostBootId: "boot",
			readPressure: async () => p(12),
			monotonicNow: Date.now,
			logger: () => {},
		});
		const delivered: string[] = [];
		b.attachNotifications(async (n) => {
			delivered.push(n.kind);
			return true;
		});
		broken = false;
		b.start();
		await vi.advanceTimersByTimeAsync(61_000);
		expect(delivered).toContain("pause");
		expect(delivered).toContain("resume");
		expect(store.getPressureSamplerState().warmupUntilMs).toBe(61_000);
		await b.stop();
	});
});

describe("boot failure cleanup", () => {
	it("stops a registered sampler before rethrowing a later Bridge startup failure", async () => {
		vi.useFakeTimers();
		const { withPressureSamplerBoot } = await import("../pressure-sampler.js");
		const read = vi.fn(async () => p());
		await expect(
			withPressureSamplerBoot(async (register) => {
				const sampler = createPressureSampler({
					store: memoryStore(),
					hostBootId: "boot",
					readPressure: read,
				});
				sampler.start();
				register(sampler);
				await Promise.resolve();
				throw Error("later boot failed");
			}),
		).rejects.toThrow("later boot failed");
		const count = read.mock.calls.length;
		await vi.advanceTimersByTimeAsync(90_000);
		expect(read).toHaveBeenCalledTimes(count);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("late control checks", () => {
	it("disable during a hung probe is rechecked at timeout before any write", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		let enabled = true;
		const store = memoryStore();
		const write = vi.spyOn(store, "setPressureSamplerState");
		const sampler = createPressureSampler({
			store,
			enabled: () => enabled,
			hostBootId: "boot",
			readPressure: () => new Promise(() => {}),
			monotonicNow: Date.now,
		});
		sampler.start();
		await vi.advanceTimersByTimeAsync(0);
		const count = write.mock.calls.length;
		enabled = false;
		await vi.advanceTimersByTimeAsync(5000);
		expect(write).toHaveBeenCalledTimes(count);
		expect(vi.getTimerCount()).toBe(0);
		await sampler.stop();
	});
});

describe("ticket recovery checks current authority after notification I/O", () => {
	it.each(["pressure", "unknown"])(
		"a delayed resume cannot resolve after current state becomes %s",
		async (target) => {
			vi.useFakeTimers();
			vi.setSystemTime(1000);
			let reading: ReturnType<typeof p> | null = p(5);
			let finish!: (r: any) => void;
			const resolve = vi.fn(async () => {});
			const sampler = createPressureSampler({
				store: memoryStore(),
				hostBootId: "boot",
				readPressure: async () => reading,
				monotonicNow: Date.now,
			});
			sampler.attachAlertSink({
				alert: async (payload) =>
					payload.metadata?.pressureSampler?.kind === "resume"
						? new Promise((r) => {
								finish = r;
							})
						: { sent: true },
				resolve,
			});
			sampler.start();
			await vi.advanceTimersByTimeAsync(30_000);
			reading = p();
			await vi.advanceTimersByTimeAsync(60_000);
			expect(finish).toBeTypeOf("function");
			reading = target === "pressure" ? p(5) : null;
			await vi.advanceTimersByTimeAsync(120_000);
			expect(sampler.evaluatePressure().state).toBe(target);
			finish({ sent: true });
			await vi.advanceTimersByTimeAsync(0);
			expect(resolve).not.toHaveBeenCalled();
			await sampler.stop();
		},
	);
});

describe("independent degradation incidents", () => {
	it("degradation does not consume the later true-pressure pause or misattribute its resume", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		let reading: ReturnType<typeof p> | null = null;
		const notices: { kind: string; episodeId: string }[] = [];
		const sampler = createPressureSampler({
			store: memoryStore(),
			hostBootId: "boot",
			readPressure: async () => reading,
			monotonicNow: Date.now,
		});
		sampler.attachNotifications(async (n) => {
			notices.push(n);
			return true;
		});
		sampler.start();
		await vi.advanceTimersByTimeAsync(60_000);
		reading = p(5);
		await vi.advanceTimersByTimeAsync(60_000);
		reading = p(12);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(notices.map((n) => n.kind)).toEqual(["degraded", "pause", "resume"]);
		expect(notices[0]!.episodeId).not.toBe(notices[1]!.episodeId);
		expect(notices[1]!.episodeId).toBe(notices[2]!.episodeId);
		await sampler.stop();
	});
	it("version 1 history without new identity fields retains pending degradation and its matching resume", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		const store = memoryStore();
		const first = createPressureSampler({
			store,
			hostBootId: "boot",
			readPressure: async () => null,
			monotonicNow: Date.now,
		});
		first.start();
		await vi.advanceTimersByTimeAsync(60_000);
		await first.stop();
		const row = store.getPressureSamplerState();
		const cache = JSON.parse(row.cacheJson);
		delete cache.notifications.degradedEpisodeId;
		delete cache.notifications.degradedSequence;
		const oldEpisode = `boot:degraded:${row.warmupUntilMs}`;
		cache.notifications.pending[0].episodeId = oldEpisode;
		cache.notifications.pending[0].id = `swap-pressure:${oldEpisode}:degraded`;
		store.setPressureSamplerState({ ...row, cacheJson: JSON.stringify(cache) });
		const notices: { kind: string; episodeId: string }[] = [];
		const restarted = createPressureSampler({
			store,
			hostBootId: "boot",
			readPressure: async () => p(),
			monotonicNow: Date.now,
		});
		restarted.attachNotifications(async (n) => {
			notices.push(n);
			return true;
		});
		restarted.start();
		await vi.advanceTimersByTimeAsync(61_000);
		await restarted.stop();
		expect(notices.map((n) => n.kind)).toEqual(["degraded", "resume"]);
		expect(notices.every((n) => n.episodeId === oldEpisode)).toBe(true);
	});
});

describe("notification shutdown drains storage work", () => {
	it.each(["alert", "resolve"])(
		"stop during %s fences new resolution and drains started work",
		async (held) => {
			vi.useFakeTimers();
			vi.setSystemTime(1000);
			let reading = p(5);
			let finish!: () => void;
			let closed = false;
			const writes: boolean[] = [];
			const resolve = vi.fn(async () => {
				if (held === "resolve")
					await new Promise<void>((r) => {
						finish = r;
					});
				writes.push(closed);
			});
			const sampler = createPressureSampler({
				store: memoryStore(),
				hostBootId: "boot",
				readPressure: async () => reading,
				monotonicNow: Date.now,
			});
			sampler.attachAlertSink({
				alert: async (payload) => {
					if (
						held === "alert" &&
						payload.metadata?.pressureSampler?.kind === "resume"
					)
						await new Promise<void>((r) => {
							finish = r;
						});
					return { sent: true };
				},
				resolve,
			});
			sampler.start();
			await vi.advanceTimersByTimeAsync(30_000);
			reading = p();
			await vi.advanceTimersByTimeAsync(60_000);
			expect(finish).toBeTypeOf("function");
			const stopped = sampler.stop().then(() => {
				closed = true;
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(closed).toBe(false);
			sampler.start(); // A concurrent start must not revive work during shutdown.
			expect(vi.getTimerCount()).toBe(0);
			finish();
			await stopped;
			await vi.advanceTimersByTimeAsync(90_000);
			expect(resolve).toHaveBeenCalledTimes(held === "resolve" ? 1 : 0);
			expect(writes).toEqual(held === "resolve" ? [false] : []);
			expect(vi.getTimerCount()).toBe(0);
		},
	);
});

describe("unverified host identity keeps a durable notification history", () => {
	it("delivers degradation and pressure/recovery across restart without trusting cached readings", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		const store = memoryStore();
		let reading: ReturnType<typeof p> | null = null;
		const notices: { kind: string; episodeId: string }[] = [];
		const make = (boot: string | null = null) =>
			createPressureSampler({
				store,
				hostBootId: boot,
				readPressure: async () => reading,
				monotonicNow: Date.now,
			});
		const first = make();
		first.attachNotifications(async (n) => {
			notices.push(n);
			return true;
		});
		first.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(first.evaluatePressure().state).toBe("unknown");
		expect(notices.map((n) => n.kind)).toEqual(["degraded"]);
		reading = p(5);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(notices.map((n) => n.kind)).toEqual(["degraded", "pause"]);
		await first.stop();
		const row = store.getPressureSamplerState();
		expect(row.hostBootId).toBe("");
		expect(JSON.parse(row.cacheJson).evidenceHostVerified).toBe(false);
		const restarted = make();
		expect(restarted.evaluatePressure()).toMatchObject({
			state: "unknown",
			sampledAtMs: null,
		});
		restarted.attachNotifications(async (n) => {
			notices.push(n);
			return true;
		});
		restarted.start();
		reading = p();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(restarted.evaluatePressure().state).toBe("healthy");
		expect(notices.map((n) => n.kind)).toEqual(["degraded", "pause", "resume"]);
		expect(notices[1]!.episodeId).toBe(notices[2]!.episodeId);
		await restarted.stop();
	});

	it("preserves a verifiable envelope but marks unknown-host samples unusable by a verified restart", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		const store = memoryStore();
		const verified = createPressureSampler({
			store,
			hostBootId: "boot",
			readPressure: async () => p(),
			monotonicNow: Date.now,
		});
		verified.start();
		await vi.advanceTimersByTimeAsync(30_000);
		await verified.stop();
		const deadline = store.getPressureSamplerState().warmupUntilMs;
		const unknown = createPressureSampler({
			store,
			hostBootId: null,
			readPressure: async () => p(),
			monotonicNow: Date.now,
		});
		unknown.start();
		await vi.advanceTimersByTimeAsync(30_000);
		await unknown.stop();
		expect(store.getPressureSamplerState()).toMatchObject({
			hostBootId: "boot",
			warmupUntilMs: deadline,
		});
		expect(
			JSON.parse(store.getPressureSamplerState().cacheJson)
				.evidenceHostVerified,
		).toBe(false);
		const restarted = createPressureSampler({
			store,
			hostBootId: "boot",
			readPressure: async () => null,
			monotonicNow: Date.now,
		});
		expect(restarted.evaluatePressure()).toMatchObject({
			state: "unknown",
			sampledAtMs: null,
		});
		await restarted.stop();
	});
});
