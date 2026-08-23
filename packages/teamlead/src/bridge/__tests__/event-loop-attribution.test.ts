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
import { afterEach, describe, expect, it } from "vitest";
import {
	EventLoopAttribution,
	nanosecondsToMilliseconds,
} from "../event-loop-attribution.js";

const roots: string[] = [];

afterEach(() => {
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
