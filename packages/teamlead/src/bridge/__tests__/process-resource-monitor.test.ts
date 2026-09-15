import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessResourceMonitor } from "../process-resource-monitor.js";

afterEach(() => vi.useRealTimers());
function fixture(extra: object = {}) {
	let now = 100000;
	const deps = {
		platform: "darwin",
		now: () => now,
		readFds: vi.fn(async () => ["0", "1", "1", "2", "x", "-1"]),
		readLimits: vi.fn(async () => ({
			soft: 1048575,
			kernel: 184320,
			systemFiles: 3,
		})),
		warn: vi.fn(),
		alert: vi.fn(async () => true),
		resolve: vi.fn(async () => true),
		...extra,
	};
	const monitor = new ProcessResourceMonitor(deps);
	return {
		monitor,
		deps,
		advance: (ms: number) => {
			now += ms;
		},
	};
}
describe("Bridge process resources", () => {
	it("uses Linux process limits and retains recovery across a rejected resolution", async () => {
		let used = 81;
		const resolve = vi
			.fn()
			.mockResolvedValueOnce(false)
			.mockResolvedValue(true);
		const { monitor } = fixture({
			platform: "linux",
			readFds: async () => Array.from({ length: used }, (_, i) => String(i)),
			readLimits: async () => ({ soft: 100, kernel: null, systemFiles: null }),
			resolve,
		});
		await monitor.sample();
		expect(monitor.snapshot()).toMatchObject({
			limit: 100,
			limit_source: "process-rlimit",
			status: "fresh",
		});
		used = 1;
		await monitor.sample();
		await monitor.sample();
		expect(resolve).toHaveBeenCalledTimes(1);
		await monitor.sample();
		expect(resolve).toHaveBeenCalledTimes(2);
	});
	it("keeps a rejected paired sample in flight until its other resource settles", async () => {
		let finish!: (fds: string[]) => void;
		const readFds = vi.fn(
			() =>
				new Promise<string[]>((resolve) => {
					finish = resolve;
				}),
		);
		const { monitor } = fixture({
			readFds,
			readLimits: async () => {
				throw new Error("limit probe failed");
			},
		});
		const first = monitor.sample();
		await new Promise((resolve) => setImmediate(resolve));
		const second = monitor.sample();
		expect(readFds).toHaveBeenCalledTimes(1);
		finish(["1"]);
		await Promise.all([first, second]);
		expect(monitor.snapshot()).toMatchObject({
			used: null,
			status: "unavailable",
			reason: "sample_failed",
		});
	});
	it("counts distinct numeric descriptors and uses Darwin effective cap with cache-only freshness", async () => {
		const { monitor, deps, advance } = fixture();
		expect(monitor.snapshot()).toMatchObject({
			used: null,
			limit: null,
			status: "unavailable",
		});
		await monitor.sample();
		expect(monitor.snapshot()).toMatchObject({
			used: 3,
			limit: 184320,
			rlimit_soft: 1048575,
			kernel_per_process_limit: 184320,
			status: "fresh",
			limit_source: "darwin-effective",
		});
		for (let i = 0; i < 10; i++) monitor.snapshot();
		expect(deps.readFds).toHaveBeenCalledTimes(1);
		advance(60001);
		expect(monitor.snapshot().status).toBe("stale");
	});
	it("alerts above 80 percent of the effective cap, retries rejected receipts and resolves after two low samples", async () => {
		let used = 147457;
		const alert = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
		const { monitor, deps } = fixture({
			readFds: async () => Array.from({ length: used }, (_, i) => String(i)),
			alert,
		});
		await monitor.sample();
		await monitor.sample();
		await monitor.sample();
		expect(alert).toHaveBeenCalledTimes(2);
		expect(deps.warn).toHaveBeenCalledTimes(3);
		used = 10;
		await monitor.sample();
		expect(deps.resolve).not.toHaveBeenCalled();
		await monitor.sample();
		expect(deps.resolve).toHaveBeenCalledTimes(1);
		used = 147457;
		await monitor.sample();
		expect(alert).toHaveBeenCalledTimes(3);
	});
	it("fails closed for missing kernel input and does not reuse failed counts as fresh", async () => {
		const { monitor, deps } = fixture();
		await monitor.sample();
		deps.readFds.mockRejectedValueOnce(new Error("private path"));
		await monitor.sample();
		expect(monitor.snapshot()).toMatchObject({
			used: 3,
			status: "unavailable",
			reason: "sample_failed",
		});
		expect(JSON.stringify(monitor.snapshot())).not.toContain("private path");
		const unknown = fixture({
			readLimits: async () => ({
				soft: 1048575,
				kernel: null,
				systemFiles: null,
			}),
		});
		await unknown.monitor.sample();
		expect(unknown.monitor.snapshot()).toMatchObject({
			limit: null,
			usage_ratio: null,
			status: "unavailable",
		});
	});
	it("retains timed-out flights until actual settlement and stop waits for cleanup", async () => {
		vi.useFakeTimers();
		let finish!: (value: string[]) => void;
		const readFds = vi.fn(
			() =>
				new Promise<string[]>((resolve) => {
					finish = resolve;
				}),
		);
		const { monitor } = fixture({ readFds });
		const first = monitor.sample();
		await vi.advanceTimersByTimeAsync(2001);
		expect(monitor.snapshot()).toMatchObject({
			status: "unavailable",
			reason: "sample_timeout",
		});
		const second = monitor.sample();
		expect(readFds).toHaveBeenCalledTimes(1);
		let stopped = false;
		const stop = monitor.stop().then(() => {
			stopped = true;
		});
		await Promise.resolve();
		expect(stopped).toBe(false);
		finish(["1"]);
		await Promise.all([first, second, stop]);
		expect(monitor.snapshot().status).toBe("unavailable");
	});
	it("handles unlimited with a finite kernel cap and rejects stale or malformed limits", async () => {
		const { monitor, advance, deps } = fixture({
			readLimits: vi.fn(async () => ({
				soft: "unlimited",
				kernel: 8192,
				systemFiles: null,
			})),
		});
		await monitor.sample();
		expect(monitor.snapshot()).toMatchObject({
			limit: 8192,
			unlimited: false,
			rlimit_unlimited: true,
		});
		advance(600001);
		expect(monitor.snapshot()).toMatchObject({
			limit: null,
			usage_ratio: null,
			status: "stale",
		});
		deps.readLimits.mockResolvedValueOnce({
			soft: "unlimited",
			kernel: "unlimited",
			systemFiles: null,
		} as never);
		await monitor.sample();
		expect(monitor.snapshot()).toMatchObject({
			limit: null,
			unlimited: true,
			status: "fresh",
		});
		const bad = fixture({
			readLimits: async () => ({
				soft: 10000,
				kernel: "$(touch /tmp/unsafe)",
				systemFiles: null,
			}),
		});
		await bad.monitor.sample();
		expect(bad.monitor.snapshot().limit).toBeNull();
	});
});
