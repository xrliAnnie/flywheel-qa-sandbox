import { afterEach, describe, expect, it, vi } from "vitest";
import { exitAfterShutdown } from "../shutdown-exit.js";

afterEach(() => {
	vi.useRealTimers();
});

describe("exit after shutdown (FLY-2885 QA@1)", () => {
	it("never keeps the process alive itself", () => {
		const timer = exitAfterShutdown({ exit: () => undefined });
		expect(timer.hasRef()).toBe(false);
		clearTimeout(timer);
	});

	it("exits with the process exit code once lingering handles outlive the grace", () => {
		vi.useFakeTimers();
		const exit = vi.fn();
		const lines: string[] = [];
		exitAfterShutdown({
			graceMs: 5_000,
			resources: () => ["UDPWrap", "UDPWrap", "Timeout"],
			exitCode: () => 1,
			exit,
			log: (line) => lines.push(line),
		});
		vi.advanceTimersByTime(4_999);
		expect(exit).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(exit).toHaveBeenCalledWith(1);
		// Kinds and counts only: which handle types kept the daemon alive.
		expect(lines).toEqual([
			"[voice] handles kept the daemon alive after shutdown (UDPWrap×2, Timeout×1); exiting",
		]);
	});

	it("defaults to exit code 0", () => {
		vi.useFakeTimers();
		const exit = vi.fn();
		exitAfterShutdown({
			resources: () => [],
			exitCode: () => undefined,
			exit,
			log: () => undefined,
		});
		vi.runAllTimers();
		expect(exit).toHaveBeenCalledWith(0);
	});
});
