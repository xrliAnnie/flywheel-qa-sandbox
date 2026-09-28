import { type ChildProcess, spawn } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createShutdownExit,
	SHUTDOWN_EXIT_GRACE_MS,
	SHUTDOWN_SIGNAL_GRACE_MS,
} from "../shutdown-exit.js";
import { isAlive, signalOwn } from "./process-probes.js";

const children: Array<{ child: ChildProcess; pidFile?: string }> = [];
afterEach(() => {
	vi.useRealTimers();
	// A failing case must not leave its daemon stand-in, or the detached
	// alert group it started, running. Only then: after a pass those pids are
	// gone and may already be reused.
	for (const { child, pidFile } of children.splice(0)) {
		if (child.exitCode !== null || child.signalCode !== null) continue;
		signalOwn(child.pid, "SIGKILL");
		try {
			for (const pid of readFileSync(pidFile ?? "", "utf8")
				.trim()
				.split(/\s+/u))
				signalOwn(Number(pid), "SIGKILL");
		} catch {
			// No alert was started, or it is already gone.
		}
	}
});

describe("bounded shutdown exit (FLY-2885 QA@1, Lead c8e10764 ②)", () => {
	it("exits as soon as cleanup finishes, naming handles still alive", () => {
		vi.useFakeTimers();
		const exit = vi.fn();
		const lines: string[] = [];
		const shutdownExit = createShutdownExit({
			graceMs: 5_000,
			resources: () => ["UDPWrap", "UDPWrap", "Timeout"],
			exit,
			log: (line) => lines.push(line),
		});
		shutdownExit.begin("signal");
		shutdownExit.finish(0);
		expect(exit).toHaveBeenCalledWith(0);
		// Kinds and counts only.
		expect(lines).toEqual([
			"[voice] exiting after shutdown with handles still open (UDPWrap×2)",
		]);
		// The deadline is cleared: nothing fires later.
		vi.advanceTimersByTime(10_000);
		expect(exit).toHaveBeenCalledTimes(1);
	});

	it("forces the exit when cleanup overruns the grace, and never holds the loop itself", () => {
		vi.useFakeTimers();
		const exit = vi.fn();
		const lines: string[] = [];
		const shutdownExit = createShutdownExit({
			graceMs: 5_000,
			resources: () => ["UDPWrap"],
			exit,
			log: (line) => lines.push(line),
		});
		const deadline = shutdownExit.begin("run_returned");
		expect(deadline.hasRef()).toBe(false);
		// A second begin of the same kind keeps the first deadline.
		vi.advanceTimersByTime(1_000);
		expect(shutdownExit.begin("run_returned")).toBe(deadline);
		vi.advanceTimersByTime(3_999);
		expect(exit).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(exit).toHaveBeenCalledWith(1);
		expect(lines).toEqual([
			"[voice] shutdown (run_returned) overran 5000 ms with handles still open (UDPWrap×1); forcing exit",
		]);
	});

	it("says nothing about handles when no shutdown began (a startup refusal, QA@2)", () => {
		// `--check-config` without credentials: main() rejects before the
		// daemon runs. Its one fatal line is the whole output contract, and
		// piped stdio always shows up as PipeWrap handles.
		const exit = vi.fn();
		const lines: string[] = [];
		createShutdownExit({
			resources: () => ["PipeWrap", "PipeWrap", "PipeWrap"],
			exit,
			log: (line) => lines.push(line),
		}).finish(1);
		expect(exit).toHaveBeenCalledWith(1);
		expect(lines).toEqual([]);
	});

	it("keeps a non-integer exit code from turning into a clean exit", () => {
		const exit = vi.fn();
		createShutdownExit({ exit, log: () => undefined }).finish("bad");
		expect(exit).toHaveBeenCalledWith(1);
		createShutdownExit({ exit, log: () => undefined }).finish(undefined);
		expect(exit).toHaveBeenLastCalledWith(0);
	});

	it("brings the deadline forward to the signal grace, never back (Lead bfcaeb10)", () => {
		vi.useFakeTimers();
		const exit = vi.fn();
		const shutdownExit = createShutdownExit({
			graceMs: 60_000,
			signalGraceMs: 4_000,
			resources: () => [],
			exit,
			log: () => undefined,
		});
		// The idle exit's cleanup is under way when launchd sends SIGTERM.
		shutdownExit.begin("run_returned");
		vi.advanceTimersByTime(1_000);
		shutdownExit.begin("signal");
		// A later run_returned does not push it back out.
		shutdownExit.begin("run_returned");
		vi.advanceTimersByTime(3_999);
		expect(exit).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(exit).toHaveBeenCalledWith(1);
	});

	it("keeps the signal grace inside launchd's 5 s exit timeout", () => {
		// `launchctl print gui/$UID/com.flywheel.voice` → "exit timeout = 5".
		expect(SHUTDOWN_SIGNAL_GRACE_MS).toBeLessThan(5_000);
	});

	it("stops child process trees before a forced exit", () => {
		vi.useFakeTimers();
		const order: string[] = [];
		const shutdownExit = createShutdownExit({
			signalGraceMs: 1_000,
			resources: () => [],
			exit: () => order.push("exit"),
			log: () => undefined,
		});
		shutdownExit.onForcedExit(() => order.push("kill alert group"));
		shutdownExit.begin("signal");
		vi.advanceTimersByTime(1_000);
		expect(order).toEqual(["kill alert group", "exit"]);
	});

	it("never cuts a cleanup still within its own bounds", () => {
		// Live session ≈ 22 s, Bridge writes ≈ 10 s, health 0.5 s, alerts 10 s.
		expect(SHUTDOWN_EXIT_GRACE_MS).toBeGreaterThan(
			22_050 + 10_000 + 500 + 10_000,
		);
	});

	describe("a real process that ran a leaking session, through the CLI's shutdown order", () => {
		const fixture = join(
			dirname(fileURLToPath(import.meta.url)),
			"fixtures",
			"leaky-daemon.mjs",
		);
		let scratch: string;
		beforeEach(() => {
			scratch = mkdtempSync(join(tmpdir(), "fly2885-exit-"));
		});
		afterEach(() => {
			rmSync(scratch, { recursive: true, force: true });
		});

		function run(
			mode: "sigterm" | "idle" | "hang",
			idleGraceMs: number,
			signalGraceMs: number,
		) {
			// The lead alert: bash waits on a grandchild, as it would on curl.
			const alertScript = join(scratch, "lead-alert.sh");
			const pidFile = join(scratch, "alert.pids");
			writeFileSync(
				alertScript,
				'#!/bin/bash\nsleep 60 &\necho "$! $$" > "$FIXTURE_PIDS"\nwait\n',
				{ mode: 0o700 },
			);
			const child = spawn(
				process.execPath,
				[
					"--experimental-transform-types",
					"--no-warnings",
					fixture,
					mode,
					String(idleGraceMs),
					String(signalGraceMs),
					"1000",
					alertScript,
				],
				{
					stdio: ["ignore", "pipe", "pipe"],
					env: { ...process.env, FIXTURE_PIDS: pidFile },
				},
			);
			children.push({ child, pidFile });
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => {
				stdout += chunk;
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk;
			});
			const exited = new Promise<number | null>((resolve) =>
				child.once("exit", (code) => resolve(code)),
			);
			const alertPids = () =>
				readFileSync(pidFile, "utf8").trim().split(/\s+/u).map(Number);
			return {
				child,
				exited,
				out: () => stdout,
				err: () => stderr,
				pidFile,
				alertPids,
			};
		}
		const leaked = (out: string) => Number(/LEAKED (\d+)/u.exec(out)?.[1] ?? 0);

		it.each([
			["sigterm", 0],
			["hang", 1],
		] as const)(
			"ends within the grace after SIGTERM and leaves no alert process (%s)",
			async (mode, expectedCode) => {
				// The idle grace is far away: only the signal grace can end it.
				const signalGraceMs = 2_500;
				const daemon = run(mode, 60_000, signalGraceMs);
				await vi.waitFor(
					() => {
						expect(daemon.out()).toContain("READY");
						expect(existsSync(daemon.pidFile)).toBe(true);
					},
					{ timeout: 15_000 },
				);
				// The preconditions that made the QA daemon immortal.
				expect(leaked(daemon.out())).toBeGreaterThan(0);
				const [grandchild, shell] = daemon.alertPids();
				expect(isAlive(grandchild!) && isAlive(shell!)).toBe(true);
				signalOwn(daemon.child.pid, "SIGTERM");
				const code = await daemon.exited;
				expect(code).toBe(expectedCode);
				// How it ended, not how long it took (host time is no required
				// check): the idle deadline is 60 s out, so only a finished
				// cleanup or the signal deadline can have ended it.
				if (mode === "sigterm") {
					// Cleanup finished; it exited at once, leaked sockets and all.
					expect(daemon.err()).toMatch(
						/exiting after shutdown with handles still open \([^)]*UDPWrap×\d+/u,
					);
					expect(daemon.err()).not.toContain("overran");
				} else {
					// A cleanup that never ends is cut by the signal deadline.
					expect(daemon.err()).toContain(
						`shutdown (signal) overran ${signalGraceMs} ms with handles still open (`,
					);
					expect(daemon.err()).toMatch(/UDPWrap×\d+/u);
				}
				await vi.waitFor(
					() =>
						expect([isAlive(grandchild!), isAlive(shell!)]).toEqual([
							false,
							false,
						]),
					{ timeout: 3_000 },
				);
			},
			30_000,
		);

		it("ends on the idle exit and leaves no alert process", async () => {
			const daemon = run("idle", 60_000, 2_500);
			const code = await daemon.exited;
			expect(leaked(daemon.out())).toBeGreaterThan(0);
			expect(code).toBe(0);
			const [grandchild, shell] = daemon.alertPids();
			await vi.waitFor(
				() =>
					expect([isAlive(grandchild!), isAlive(shell!)]).toEqual([
						false,
						false,
					]),
				{ timeout: 3_000 },
			);
		}, 30_000);
	});
});
