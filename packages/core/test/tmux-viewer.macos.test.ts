/**
 * FLY-116 macOS-only real-osascript regression test.
 *
 * Mocked unit tests cannot catch AppleScript dictionary mismatches — e.g.
 * `close t` against Terminal.app's `tab` class silently fails (errAEEventNotHandled
 * -1708) and the surrounding `try` swallows it. qa-fly-116 hit this in PR #167.
 *
 * This test runs the REAL `osascript` and REAL `Terminal.app` to verify the
 * close path actually closes a tab. Skipped unless the current macOS process
 * context can drive Terminal.app through `osascript`. Run locally on macOS via
 * `pnpm --filter flywheel-core test`.
 *
 * Cleanup: each test creates its own Terminal window via `do script`, sets a
 * unique custom title (`flywheel:runner:test-fly-116:...`), and asserts the
 * window is gone after closeRunnerTerminalView. afterEach also nukes any
 * leftover test-titled windows in case an assertion failed mid-flight.
 */

import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeRunnerTerminalView, formatViewTitle } from "../src/index.js";

type TerminalAppProbe = (
	command: string,
	args: string[],
	options: {
		killSignal: "SIGKILL";
		timeout: number;
		stdio: ["ignore", "ignore", "pipe"];
	},
) => unknown;

const TERMINAL_APP_PROBE = 'tell application "Terminal" to count windows';
// FLY-2314 A-side evidence: a cold first Apple event exceeded 20s, while a
// 60s attempt succeeded and subsequent calls were fast. Preserve that measured
// cold-start budget, then require the warm connection to meet the production
// close path's 5s AppleScript budget.
const TERMINAL_APP_PROBE_TIMEOUTS_MS = [60_000, 5_000] as const;

// A binary lookup is insufficient on macOS: resident/no-GUI process contexts
// can find /usr/bin/osascript while LaunchServices cannot resolve or drive
// Terminal.app. A read-only Terminal dictionary command exercises that exact
// boundary without creating or closing a test window.
function terminalAppSkipReason(
	platform = process.platform,
	runProbe: TerminalAppProbe = execFileSync,
): string | null {
	if (platform !== "darwin") return "macOS-only Terminal.app GUI test";
	let coldStartTimedOut = false;
	for (const [attempt, timeout] of TERMINAL_APP_PROBE_TIMEOUTS_MS.entries()) {
		try {
			runProbe("osascript", ["-e", TERMINAL_APP_PROBE], {
				killSignal: "SIGKILL",
				timeout,
				stdio: ["ignore", "ignore", "pipe"],
			});
			if (attempt === TERMINAL_APP_PROBE_TIMEOUTS_MS.length - 1) return null;
		} catch (error) {
			const execError = error as Error & {
				code?: string;
				stderr?: Buffer | string | null;
			};
			if (execError.code === "ETIMEDOUT") {
				if (attempt === 0) {
					coldStartTimedOut = true;
					continue;
				}
				break;
			}
			const stderr = Buffer.isBuffer(execError.stderr)
				? execError.stderr.toString("utf8")
				: (execError.stderr ?? "");
			const detail = `${stderr}\n${execError.message}`;
			if (/Can(?:'|’)t get application "?Terminal"?/.test(detail)) {
				return "Terminal.app cannot be resolved by osascript in this process context";
			}
			return "Terminal.app cannot be driven by osascript in this process context";
		}
	}
	if (!coldStartTimedOut) {
		throw new Error(
			`Terminal.app cold-start probe succeeded, but warm verification timed out (${TERMINAL_APP_PROBE_TIMEOUTS_MS[1]}ms); refusing to silently skip real GUI tests`,
		);
	}
	throw new Error(
		`Terminal.app capability probe timed out during both cold start (${TERMINAL_APP_PROBE_TIMEOUTS_MS[0]}ms) and warm verification (${TERMINAL_APP_PROBE_TIMEOUTS_MS[1]}ms); refusing to silently skip real GUI tests`,
	);
}

function terminalAppAvailable(
	platform = process.platform,
	runProbe: TerminalAppProbe = execFileSync,
): boolean {
	return terminalAppSkipReason(platform, runProbe) === null;
}

type TerminalAppTestContext = {
	skip(note?: string): never;
};

function createTerminalAppSuiteGuard(
	getSkipReason: () => string | null = terminalAppSkipReason,
): (context: TerminalAppTestContext) => void {
	let cachedResult:
		| { kind: "available" }
		| { kind: "unavailable"; reason: string }
		| { kind: "error"; error: unknown }
		| undefined;

	return (context) => {
		if (cachedResult === undefined) {
			try {
				const reason = getSkipReason();
				cachedResult = reason
					? { kind: "unavailable", reason }
					: { kind: "available" };
			} catch (error) {
				cachedResult = { kind: "error", error };
			}
		}

		if (cachedResult.kind === "error") throw cachedResult.error;
		if (cachedResult.kind === "unavailable") {
			context.skip(`skipped: ${cachedResult.reason}`);
		}
	};
}

describe("Terminal.app GUI test capability guard", () => {
	it("returns false when osascript exists but Terminal.app cannot be driven", () => {
		const runProbe = (command: string): Buffer => {
			if (command === "which") return Buffer.from("/usr/bin/osascript\n");
			throw new Error("osascript: Can't get application Terminal");
		};

		expect(terminalAppAvailable("darwin", runProbe)).toBe(false);
	});

	it("returns true when osascript can drive Terminal.app", () => {
		const runProbe: TerminalAppProbe = (command, args) => {
			if (
				command !== "osascript" ||
				args[0] !== "-e" ||
				args[1] !== TERMINAL_APP_PROBE
			) {
				throw new Error(`unexpected probe: ${command} ${args.join(" ")}`);
			}
			return Buffer.from("2\n");
		};

		expect(terminalAppAvailable("darwin", runProbe)).toBe(true);
	});

	it("uses the command-bearing Terminal probe with a hard timeout kill", () => {
		const invocations: Array<{
			command: string;
			args: string[];
			options: {
				timeout: number;
				killSignal: "SIGKILL";
				stdio: ["ignore", "ignore", "pipe"];
			};
		}> = [];
		const runProbe: TerminalAppProbe = (command, args, options) => {
			invocations.push({ command, args, options });
			return Buffer.from("2\n");
		};

		expect(terminalAppAvailable("darwin", runProbe)).toBe(true);
		expect(invocations).toEqual([
			{
				command: "osascript",
				args: ["-e", 'tell application "Terminal" to count windows'],
				options: {
					timeout: 60_000,
					killSignal: "SIGKILL",
					stdio: ["ignore", "ignore", "pipe"],
				},
			},
			{
				command: "osascript",
				args: ["-e", 'tell application "Terminal" to count windows'],
				options: {
					timeout: 5_000,
					killSignal: "SIGKILL",
					stdio: ["ignore", "ignore", "pipe"],
				},
			},
		]);
	});

	it("confirms the warmed Terminal connection within the GUI helper budget", () => {
		const timeouts: number[] = [];
		const runProbe: TerminalAppProbe = (_command, _args, options) => {
			timeouts.push(options.timeout);
			return Buffer.from("2\n");
		};

		expect(terminalAppAvailable("darwin", runProbe)).toBe(true);
		expect(timeouts).toEqual([60_000, 5_000]);
	});

	it("returns false without probing outside macOS", () => {
		const failIfCalled: TerminalAppProbe = () => {
			throw new Error("Terminal.app probe must not run outside macOS");
		};

		expect(terminalAppAvailable("linux", failIfCalled)).toBe(false);
	});

	it("reports when Terminal.app cannot be resolved in the current process context", () => {
		const resolutionError = Object.assign(
			new Error("osascript failed to resolve Terminal.app"),
			{
				stderr: Buffer.from(
					'0:44: execution error: Can’t get application "Terminal". (-1728)\n',
				),
			},
		);
		const runProbe: TerminalAppProbe = (command) => {
			if (command === "which") return Buffer.from("/usr/bin/osascript\n");
			throw resolutionError;
		};

		expect(terminalAppSkipReason("darwin", runProbe)).toBe(
			"Terminal.app cannot be resolved by osascript in this process context",
		);
	});

	it("fails loudly after two Terminal.app probe timeouts", () => {
		const timeoutError = Object.assign(
			new Error("spawnSync osascript ETIMEDOUT"),
			{
				code: "ETIMEDOUT",
				killed: true,
				signal: "SIGTERM",
				stderr: Buffer.alloc(0),
			},
		);
		let attempts = 0;
		const runProbe: TerminalAppProbe = () => {
			attempts += 1;
			throw timeoutError;
		};

		expect(() => terminalAppSkipReason("darwin", runProbe)).toThrowError(
			"Terminal.app capability probe timed out during both cold start (60000ms) and warm verification (5000ms); refusing to silently skip real GUI tests",
		);
		expect(attempts).toBe(2);
	});

	it("reports a warm verification timeout after cold-start success", () => {
		let attempts = 0;
		const runProbe: TerminalAppProbe = () => {
			attempts += 1;
			if (attempts === 1) return Buffer.from("2\n");
			throw Object.assign(new Error("spawnSync osascript ETIMEDOUT"), {
				code: "ETIMEDOUT",
			});
		};

		expect(() => terminalAppSkipReason("darwin", runProbe)).toThrowError(
			"Terminal.app cold-start probe succeeded, but warm verification timed out (5000ms); refusing to silently skip real GUI tests",
		);
		expect(attempts).toBe(2);
	});

	it("retries once when a cold-start Terminal.app probe times out", () => {
		let attempts = 0;
		const runProbe: TerminalAppProbe = () => {
			attempts += 1;
			if (attempts === 1) {
				throw Object.assign(new Error("spawnSync osascript ETIMEDOUT"), {
					code: "ETIMEDOUT",
				});
			}
			return Buffer.from("2\n");
		};

		expect(terminalAppSkipReason("darwin", runProbe)).toBeNull();
		expect(attempts).toBe(2);
	});

	it("does not misreport an externally signaled probe as a timeout", () => {
		const signalError = Object.assign(
			new Error("osascript exited on SIGSEGV"),
			{
				signal: "SIGSEGV",
				stderr: Buffer.alloc(0),
			},
		);
		const runProbe: TerminalAppProbe = () => {
			throw signalError;
		};

		expect(terminalAppSkipReason("darwin", runProbe)).toBe(
			"Terminal.app cannot be driven by osascript in this process context",
		);
	});

	it("reports a distinct skip reason outside macOS", () => {
		const failIfCalled: TerminalAppProbe = () => {
			throw new Error("Terminal.app probe must not run outside macOS");
		};

		expect(terminalAppSkipReason("linux", failIfCalled)).toBe(
			"macOS-only Terminal.app GUI test",
		);
	});

	it("returns no skip reason when Terminal.app can be driven", () => {
		const successfulProbe: TerminalAppProbe = () => Buffer.from("2\n");

		expect(terminalAppSkipReason("darwin", successfulProbe)).toBeNull();
	});

	it("defers and memoizes the host probe until a real GUI test executes", () => {
		let probes = 0;
		const requireTerminalApp = createTerminalAppSuiteGuard(() => {
			probes += 1;
			return null;
		});
		const context = {
			skip: (_note?: string): never => {
				throw new Error("capable contexts must not skip");
			},
		};

		expect(probes).toBe(0);
		requireTerminalApp(context);
		requireTerminalApp(context);
		expect(probes).toBe(1);
	});
});

function runOsa(script: string): string {
	return execFileSync("osascript", ["-e", script], {
		encoding: "utf-8",
		timeout: 10000,
	}).trim();
}

function countWindowsWithTitlePrefix(prefix: string): number {
	const safe = prefix.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const script = [
		'tell application "Terminal"',
		"  set n to 0",
		"  repeat with w in windows",
		"    repeat with t in tabs of w",
		"      try",
		`        if (custom title of t as text) starts with "${safe}" then`,
		"          set n to n + 1",
		"        end if",
		"      end try",
		"    end repeat",
		"  end repeat",
		"  return (n as text)",
		"end tell",
	].join("\n");
	return Number.parseInt(runOsa(script), 10) || 0;
}

function openTestTab(customTitle: string): void {
	const safe = customTitle.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	// Open a new Terminal window. Each `do script` without a target creates a
	// NEW window with one tab — matches Flywheel's `openTmuxViewer` behavior.
	//
	// CRITICAL: the inner command must exit cleanly (so the tab's process is
	// gone by the time closeRunnerTerminalView runs). In production, the
	// linked-viewer-session kill causes `tmux attach` (which the opener spawned
	// via `exec`) to exit, which exits the shell. We mirror that by running
	// a short-lived `sleep 1` and exiting — the tab ends up `[exited]` before
	// our close call. If we left an active process running, Terminal would
	// show the "process is still running" confirmation dialog and block the
	// close even with `saving no`.
	const script = [
		'tell application "Terminal"',
		`  set viewerTab to do script "sleep 1; exit"`,
		`  set custom title of viewerTab to "${safe}"`,
		"end tell",
	].join("\n");
	runOsa(script);
}

function killTestTabsByPrefix(prefix: string): void {
	const safe = prefix.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	// Forceful cleanup — close any window whose front tab matches the prefix.
	// Used in afterEach to avoid leaking tabs when a test bails.
	const script = [
		'tell application "Terminal"',
		"  set toClose to {}",
		"  repeat with w in windows",
		"    repeat with t in tabs of w",
		"      try",
		`        if (custom title of t as text) starts with "${safe}" then`,
		"          set end of toClose to w",
		"        end if",
		"      end try",
		"    end repeat",
		"  end repeat",
		"  repeat with w in toClose",
		"    try",
		"      close w saving no",
		"    end try",
		"  end repeat",
		"end tell",
	].join("\n");
	try {
		runOsa(script);
	} catch {
		/* best-effort */
	}
}

const TEST_TITLE_PREFIX = "flywheel:runner:test-fly-116";
let counter = 0;
function makeOpts() {
	counter += 1;
	return {
		baseSessionName: "test-fly-116",
		projectName: "flywheel",
		executionId: `it_${Date.now()}_${counter}`,
		windowId: `@${counter}`,
		sessionRole: "test",
	};
}

const requireTerminalApp = createTerminalAppSuiteGuard();
let shouldCleanUpTerminalTabs = false;

describe("closeRunnerTerminalView — real osascript on macOS", () => {
	beforeEach((context) => {
		shouldCleanUpTerminalTabs = false;
		requireTerminalApp(context);
		shouldCleanUpTerminalTabs = true;
	}, 75_000);

	afterEach(() => {
		if (shouldCleanUpTerminalTabs) {
			killTestTabsByPrefix(TEST_TITLE_PREFIX);
		}
	});

	it("closes a single-tab Terminal window opened with the matching custom title", async () => {
		const opts = makeOpts();
		const title = formatViewTitle({
			sessionName: opts.baseSessionName,
			projectName: opts.projectName,
			executionId: opts.executionId,
			windowId: opts.windowId,
			sessionRole: opts.sessionRole,
		});

		openTestTab(title);
		// Give Terminal a moment to register the tab AND let the inner
		// `sleep 1; exit` finish so the tab process is gone (mirrors
		// production where linked viewer kill makes the shell exit before
		// closeRunnerTerminalView is invoked).
		execFileSync("sleep", ["3"], { stdio: "ignore" });

		expect(countWindowsWithTitlePrefix(title)).toBe(1);

		const res = await closeRunnerTerminalView(opts);

		// Give close a moment to propagate.
		execFileSync("sleep", ["2"], { stdio: "ignore" });

		expect(res.closedTab).toBe(true);
		expect(countWindowsWithTitlePrefix(title)).toBe(0);
	}, 30_000);

	it("returns closedTab=false (not_found) when no matching tab exists", async () => {
		const opts = makeOpts();
		const res = await closeRunnerTerminalView(opts);
		expect(res.closedTab).toBe(false);
		expect(res.error).toBeUndefined();
	}, 15_000);

	// We don't currently have a way to reliably move a tab into another
	// window via AppleScript across Terminal versions, so the multi-tab
	// safety path is covered by the mocked unit test only. Run on Annie's
	// machine if you want to sanity-check the skip warning.
});
