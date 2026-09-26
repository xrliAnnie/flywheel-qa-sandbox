import { type ChildProcess, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createShutdownExit } from "../shutdown-exit.js";

const children: ChildProcess[] = [];
afterEach(() => {
	vi.useRealTimers();
	// A failing case must not leave its daemon stand-in running.
	for (const child of children.splice(0))
		if (child.exitCode === null && child.signalCode === null)
			child.kill("SIGKILL");
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
		// A second begin keeps the first deadline.
		shutdownExit.begin("signal");
		vi.advanceTimersByTime(4_999);
		expect(exit).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(exit).toHaveBeenCalledWith(1);
		expect(lines).toEqual([
			"[voice] shutdown (run_returned) overran 5000 ms with handles still open (UDPWrap×1); forcing exit",
		]);
	});

	it("keeps a non-integer exit code from turning into a clean exit", () => {
		const exit = vi.fn();
		createShutdownExit({ exit, log: () => undefined }).finish("bad");
		expect(exit).toHaveBeenCalledWith(1);
		createShutdownExit({ exit, log: () => undefined }).finish(undefined);
		expect(exit).toHaveBeenLastCalledWith(0);
	});

	describe("a real process that ran a leaking WebRTC session", () => {
		const fixture = join(
			dirname(fileURLToPath(import.meta.url)),
			"fixtures",
			"leaky-daemon.mjs",
		);
		function run(mode: "sigterm" | "idle" | "hang", graceMs: number) {
			const child = spawn(
				process.execPath,
				[
					"--experimental-strip-types",
					"--no-warnings",
					fixture,
					mode,
					String(graceMs),
				],
				{ stdio: ["ignore", "pipe", "pipe"] },
			);
			children.push(child);
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => {
				stdout += chunk;
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk;
			});
			const exited = new Promise<{ code: number | null; at: number }>(
				(resolve) =>
					child.once("exit", (code) => resolve({ code, at: Date.now() })),
			);
			return {
				child,
				exited,
				out: () => stdout,
				err: () => stderr,
			};
		}

		it.each([["sigterm"], ["hang"]] as const)(
			"ends within the grace after SIGTERM (%s)",
			async (mode) => {
				const graceMs = 3_000;
				const daemon = run(mode, graceMs);
				await vi.waitFor(() => expect(daemon.out()).toContain("READY"), {
					timeout: 15_000,
				});
				// The precondition that made the QA daemon immortal.
				expect(daemon.out()).toContain("LEAKED 2");
				const sentAt = Date.now();
				daemon.child.kill("SIGTERM");
				const { code, at } = await daemon.exited;
				expect(at - sentAt).toBeLessThan(graceMs + 1_500);
				expect(code).toBe(mode === "hang" ? 1 : 0);
				expect(daemon.err()).toContain("UDPWrap×2");
			},
			25_000,
		);

		it("ends on the idle exit even though sockets leaked", async () => {
			const daemon = run("idle", 3_000);
			const { code } = await daemon.exited;
			expect(daemon.out()).toContain("LEAKED 2");
			expect(code).toBe(0);
		}, 25_000);
	});
});
