import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	EventLoopAttribution,
	nanosecondsToMilliseconds,
} from "../event-loop-attribution.js";

const roots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function makeHome(label: string): string {
	const root = mkdtempSync(join(tmpdir(), `fly1995-${label}-`));
	roots.push(root);
	return root;
}

describe("FLY-1995 event-loop attribution", () => {
	it("reports complete-window lag, cached freshness, and unavailable empty samples", async () => {
		let now = 100_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const monitor = new EventLoopAttribution({
			diagnosticsDir: join(makeHome("lag"), "diagnostics"),
			profilerEnabled: false,
		});
		await monitor.start();
		const internal = monitor as unknown as {
			delay: {
				max: number;
				percentile: (n: number) => number;
				reset: () => void;
				disable: () => void;
			};
			rollWindow: () => Promise<void>;
		};
		internal.delay.disable();
		internal.delay = {
			max: 42_000_000,
			percentile: () => 20_000_000,
			reset() {},
			disable() {},
		};
		try {
			expect(monitor.healthSnapshot()).toMatchObject({
				lag_ms: null,
				status: "unavailable",
				window_ms: 30_000,
			});
			now += 30_000;
			await internal.rollWindow();
			expect(monitor.healthSnapshot()).toMatchObject({
				lag_ms: 42,
				max_ms: 42,
				p99_ms: 20,
				sampled_at: new Date(now).toISOString(),
				status: "fresh",
			});
			now += 60_001;
			expect(monitor.healthSnapshot()).toMatchObject({
				lag_ms: 42,
				status: "stale",
			});
			internal.delay.max = 0;
			await internal.rollWindow();
			expect(monitor.healthSnapshot()).toMatchObject({
				lag_ms: null,
				status: "unavailable",
			});
			internal.delay.percentile = () => {
				throw new Error("sample failed");
			};
			await expect(internal.rollWindow()).rejects.toThrow("sample failed");
			expect(monitor.healthSnapshot()).toMatchObject({
				lag_ms: null,
				status: "unavailable",
			});
		} finally {
			await monitor.stop();
		}
	});
	it("converts perf_hooks nanoseconds at the 1s episode boundary", () => {
		expect(nanosecondsToMilliseconds(999_999_999)).toBeCloseTo(999.999999);
		expect(nanosecondsToMilliseconds(1_000_000_000)).toBe(1000);
	});

	it("keeps detection alive with a stable disabled/degraded snapshot shape", async () => {
		const disabled = new EventLoopAttribution({
			diagnosticsDir: join(makeHome("disabled"), "diagnostics"),
			profilerEnabled: false,
		});
		await disabled.start();
		expect(disabled.healthSnapshot()).toEqual({
			p99_ms: null,
			max_ms: null,
			episodes: 0,
			lag_ms: null,
			sampled_at: null,
			window_ms: 30_000,
			status: "unavailable",
		});
		expect(disabled.snapshot()).toMatchObject({ state: "disabled" });
		await disabled.stop();

		const degraded = new EventLoopAttribution({
			diagnosticsDir: join(makeHome("degraded"), "diagnostics"),
			profilerEnabled: true,
			createInspectorSession: () =>
				({
					connect() {
						throw new Error("inspector unavailable");
					},
				}) as never,
		});
		await expect(degraded.start()).resolves.toBeUndefined();
		expect(degraded.snapshot()).toMatchObject({
			state: "degraded",
			error: "inspector unavailable",
		});
		await degraded.stop();
	});

	it("orders profiler setup before start and disables it during close", async () => {
		const calls: string[] = [];
		const attribution = new EventLoopAttribution({
			diagnosticsDir: join(makeHome("lifecycle"), "diagnostics"),
			profilerEnabled: true,
			createInspectorSession: () =>
				({
					connect: () => calls.push("connect"),
					disconnect: () => calls.push("disconnect"),
					post(method: string, ...args: unknown[]) {
						calls.push(method);
						const callback = args.at(-1) as (
							error: Error | null,
							result?: object,
						) => void;
						callback(null, method === "Profiler.stop" ? { profile: {} } : {});
					},
				}) as never,
		});
		await attribution.start();
		await attribution.stop();
		expect(calls).toEqual([
			"connect",
			"Profiler.enable",
			"Profiler.setSamplingInterval",
			"Profiler.start",
			"Profiler.stop",
			"Profiler.disable",
			"disconnect",
		]);
	});

	it("observes the profiler control on each attribution window", async () => {
		const calls: string[] = [];
		let enabled = false;
		const attribution = new EventLoopAttribution({
			diagnosticsDir: join(makeHome("dynamic"), "diagnostics"),
			profilerEnabled: () => enabled,
			createInspectorSession: () =>
				({
					connect: () => calls.push("connect"),
					disconnect: () => calls.push("disconnect"),
					post(method: string, ...args: unknown[]) {
						calls.push(method);
						const callback = args.at(-1) as (
							error: Error | null,
							result?: object,
						) => void;
						callback(null, method === "Profiler.stop" ? { profile: {} } : {});
					},
				}) as never,
		});
		await attribution.start();
		expect(attribution.snapshot().state).toBe("disabled");
		expect(calls).toEqual([]);

		enabled = true;
		await (
			attribution as unknown as { rollWindow: () => Promise<void> }
		).rollWindow();
		expect(attribution.snapshot().state).toBe("running");
		expect(calls).toEqual([
			"connect",
			"Profiler.enable",
			"Profiler.setSamplingInterval",
			"Profiler.start",
		]);

		enabled = false;
		await (
			attribution as unknown as { rollWindow: () => Promise<void> }
		).rollWindow();
		expect(attribution.snapshot().state).toBe("disabled");
		expect(calls.slice(-3)).toEqual([
			"Profiler.stop",
			"Profiler.disable",
			"disconnect",
		]);
		await attribution.stop();
	});

	it("bounds cross-restart profile inventory, removes own temp files, and never follows unrelated symlinks", async () => {
		const home = makeHome("retention");
		const profileDir = join(home, "diagnostics", "loop-profiles");
		mkdirSync(profileDir, { recursive: true });
		for (let index = 0; index < 22; index += 1) {
			writeFileSync(
				join(
					profileDir,
					`loop-profile-2026-08-22T20-00-${String(index).padStart(2, "0")}-000Z-max1000.cpuprofile`,
				),
				"{}",
			);
		}
		writeFileSync(
			join(profileDir, "loop-profile-crash.cpuprofile.tmp-1"),
			"partial",
		);
		writeFileSync(join(profileDir, "operator-note.txt"), "keep");
		const external = join(home, "external.cpuprofile");
		writeFileSync(external, "do not touch");
		symlinkSync(external, join(profileDir, "loop-profile-linked.cpuprofile"));

		const attribution = new EventLoopAttribution({
			diagnosticsDir: join(home, "diagnostics"),
			profilerEnabled: false,
		});
		await attribution.start();
		expect(attribution.snapshot().profiles).toHaveLength(20);
		expect(
			existsSync(join(profileDir, "loop-profile-crash.cpuprofile.tmp-1")),
		).toBe(false);
		expect(readFileSync(join(profileDir, "operator-note.txt"), "utf8")).toBe(
			"keep",
		);
		expect(readFileSync(external, "utf8")).toBe("do not touch");
		expect(
			lstatSync(
				join(profileDir, "loop-profile-linked.cpuprofile"),
			).isSymbolicLink(),
		).toBe(true);
		await attribution.stop();
	});

	it("retains a real CPU profile for a >1s synchronous stall and records wall-clock rider correlation", async () => {
		const home = makeHome("profile");
		const attribution = new EventLoopAttribution({
			diagnosticsDir: join(home, "diagnostics"),
			profilerEnabled: true,
		});
		await attribution.start();
		// monitorEventLoopDelay needs one turn to establish its sampling timer.
		await new Promise((resolve) => setTimeout(resolve, 30));

		const spanStart = Date.now();
		function fly1995BusyWork(): void {
			const until = Date.now() + 1_100;
			while (Date.now() < until) Math.sqrt(Date.now());
		}
		fly1995BusyWork();
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_100);
		attribution.recordSpan("gate-poller.tick", spanStart, Date.now());
		await new Promise((resolve) => setTimeout(resolve, 30));
		await (
			attribution as unknown as { rollWindow: () => Promise<void> }
		).rollWindow();

		const snapshot = attribution.snapshot();
		expect(snapshot.episodes.count).toBe(1);
		expect(snapshot.windows).toEqual([
			expect.objectContaining({
				p50_ms: expect.any(Number),
				p99_ms: expect.any(Number),
				max_ms: expect.any(Number),
				profiler_gap_ms: expect.any(Number),
			}),
		]);
		expect(snapshot.profiles).toHaveLength(1);
		expect(snapshot.long_wall_spans).toEqual([
			expect.objectContaining({ name: "gate-poller.tick" }),
		]);
		const profilePath = join(
			home,
			"diagnostics",
			"loop-profiles",
			snapshot.profiles[0]!,
		);
		expect(readFileSync(profilePath, "utf8")).toContain("fly1995BusyWork");
		expect(
			readdirSync(join(home, "diagnostics")).some((name) =>
				name.startsWith("event-loop-episodes.jsonl"),
			),
		).toBe(true);
		await attribution.stop();
	}, 15_000);
});
