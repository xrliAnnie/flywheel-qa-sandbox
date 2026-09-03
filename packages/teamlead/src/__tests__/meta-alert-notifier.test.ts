/**
 * FLY-182 Track B — MetaAlertNotifier tests (B2 self-monitoring).
 */

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetaAlertNotifier } from "../MetaAlertNotifier.js";

describe("MetaAlertNotifier", () => {
	let stateDir: string;
	beforeEach(async () => {
		stateDir = await mkdtemp(join(tmpdir(), "fly182-meta-"));
	});
	afterEach(async () => {
		await rm(stateDir, { recursive: true, force: true });
	});

	it("writes a per-reason file AND calls osascript on first notify", async () => {
		const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
		const n = new MetaAlertNotifier({
			stateDir,
			execFileFn: exec,
			logger: () => {},
		});
		const r = await n.notify({
			reason: "drain_stuck",
			title: "drainQueue stuck",
			body: "sent=0 remaining=1667",
		});
		expect(r).toEqual({ debounced: false, desktop: true, file: true });
		// osascript called with body/title passed as argv items (no injection).
		expect(exec).toHaveBeenCalledWith(
			"osascript",
			expect.arrayContaining([
				"sent=0 remaining=1667",
				"Flywheel: drainQueue stuck",
			]),
		);
		const files = await readdir(join(stateDir, "meta-alert"));
		expect(files).toContain("drain_stuck.txt");
		const body = await readFile(
			join(stateDir, "meta-alert", "drain_stuck.txt"),
			"utf-8",
		);
		expect(body).toContain("sent=0 remaining=1667");
	});

	it("prefixes the file with founder local time and timezone", async () => {
		const n = new MetaAlertNotifier({
			stateDir,
			execFileFn: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
			now: () => new Date("2026-07-17T02:23:05.000Z").getTime(),
			founderTimezone: () => "Asia/Tokyo",
			logger: () => {},
		});

		await n.notify({ reason: "drain_stuck", title: "T", body: "B" });

		const body = await readFile(
			join(stateDir, "meta-alert", "drain_stuck.txt"),
			"utf-8",
		);
		expect(body).toMatch(/^\[2026-07-17 11:23 GMT\+9\] T\n/);
	});

	it("debounces the same reason within the window", async () => {
		const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
		let t = 1_000_000;
		const n = new MetaAlertNotifier({
			stateDir,
			execFileFn: exec,
			debounceMs: 600_000,
			now: () => t,
			logger: () => {},
		});
		const input = { reason: "queue_overflow" as const, title: "x", body: "y" };
		const first = await n.notify(input);
		expect(first.debounced).toBe(false);
		t += 60_000; // 1 min later, within 10min window
		const second = await n.notify(input);
		expect(second).toEqual({ debounced: true, desktop: false, file: false });
		expect(exec).toHaveBeenCalledTimes(1); // not called again
	});

	it("re-fires after the debounce window", async () => {
		const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
		let t = 1_000_000;
		const n = new MetaAlertNotifier({
			stateDir,
			execFileFn: exec,
			debounceMs: 600_000,
			now: () => t,
			logger: () => {},
		});
		const input = { reason: "queue_overflow" as const, title: "x", body: "y" };
		await n.notify(input);
		t += 600_001; // past the window
		const again = await n.notify(input);
		expect(again.debounced).toBe(false);
		expect(exec).toHaveBeenCalledTimes(2);
	});

	it("does not debounce across different reasons", async () => {
		const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
		const n = new MetaAlertNotifier({
			stateDir,
			execFileFn: exec,
			logger: () => {},
		});
		await n.notify({ reason: "drain_stuck", title: "a", body: "b" });
		expect(exec).toHaveBeenCalledTimes(1);
	});

	it("accepts the idle thread sweep permission-denied reason", async () => {
		const n = new MetaAlertNotifier({
			stateDir,
			execFileFn: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
			logger: () => {},
		});
		const result = await n.notify({
			reason: "idle_thread_sweep_denied",
			title: "Idle thread sweep denied",
			body: "Discord returned 403",
		});
		expect(result.file).toBe(true);
		expect(await readdir(join(stateDir, "meta-alert"))).toContain(
			"idle_thread_sweep_denied.txt",
		);
	});

	it("never throws when osascript fails — file channel still used", async () => {
		const exec = vi.fn().mockRejectedValue(new Error("no aqua session"));
		const n = new MetaAlertNotifier({
			stateDir,
			execFileFn: exec,
			logger: () => {},
		});
		const r = await n.notify({
			reason: "alert_dead_lettered",
			title: "t",
			body: "b",
		});
		expect(r.desktop).toBe(false);
		expect(r.file).toBe(true);
	});

	it("never throws when both channels fail", async () => {
		const exec = vi.fn().mockRejectedValue(new Error("nope"));
		// stateDir points at a path that cannot be created (a file).
		const n = new MetaAlertNotifier({
			stateDir: join(stateDir, "x\0bad"),
			execFileFn: exec,
			logger: () => {},
		});
		await expect(
			n.notify({ reason: "drain_stuck", title: "t", body: "b" }),
		).resolves.toMatchObject({ desktop: false, file: false });
	});

	it("probeDesktopCapability reflects osascript availability", async () => {
		const ok = new MetaAlertNotifier({
			stateDir,
			execFileFn: vi.fn().mockResolvedValue({ stdout: "1", stderr: "" }),
			logger: () => {},
		});
		expect(await ok.probeDesktopCapability()).toBe(true);
		const bad = new MetaAlertNotifier({
			stateDir,
			execFileFn: vi.fn().mockRejectedValue(new Error("daemon, no UI")),
			logger: () => {},
		});
		expect(await bad.probeDesktopCapability()).toBe(false);
	});
});
