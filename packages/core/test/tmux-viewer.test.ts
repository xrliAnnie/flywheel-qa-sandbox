import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

// FLY-650/FLY-754: these tests exercise the Terminal.app opener, which only runs
// when the viewer backend is terminal-app (FLY-754 removed cmux from the opener
// gate — cmux-sync owns viewing there). Force terminal-app to test the opener
// path platform-independently. Restored after the file.
const _origViewerBackend = process.env.FLYWHEEL_VIEWER_BACKEND;
beforeAll(() => {
	process.env.FLYWHEEL_VIEWER_BACKEND = "terminal-app";
});
afterAll(() => {
	if (_origViewerBackend === undefined)
		delete process.env.FLYWHEEL_VIEWER_BACKEND;
	else process.env.FLYWHEEL_VIEWER_BACKEND = _origViewerBackend;
});

// Mock child_process before importing the module under test
vi.mock("node:child_process", () => ({
	execFileSync: vi.fn(),
	execFile: vi.fn(),
}));

import { execFile, execFileSync } from "node:child_process";
import {
	_drainTmuxViewerOpenQueueForTest,
	_resetTmuxViewerStateForTest,
	cancelOpener,
	closeRunnerTerminalView,
	escapeAppleScript,
	openTmuxViewer,
	openTmuxViewerLegacy,
	posixEscape,
} from "../src/tmux-viewer.js";

// FLY-128: helper — wait for the opener queue to settle so assertions run
// against the final state. Uses fake timers (set up in beforeEach) to
// fast-forward the in-queue delays (select-window backoff, verify delay)
// without sleeping in real time.
async function settleQueue(): Promise<void> {
	// Pump fake timers + microtasks until the queue resolves. The queue may
	// schedule new timers each iteration (e.g., 10× select-window backoff +
	// verify delay), so loop until quiescent.
	for (let i = 0; i < 50; i++) {
		await vi.advanceTimersByTimeAsync(2000);
		// Yield to microtasks so chained .then handlers run.
		await Promise.resolve();
	}
	await _drainTmuxViewerOpenQueueForTest();
	// One more flush so the trailing .finally() runs before assertions.
	await Promise.resolve();
}

const mockExecFileSync = execFileSync as ReturnType<typeof vi.fn>;
const mockExecFile = execFile as ReturnType<typeof vi.fn>;

// Each test gets a unique executionId so the in-process `openingTitles` /
// `cancelledExecutions` Sets (which persist across tests in the same module
// instance and clean up via setTimeout 1s/5min) don't bleed state.
let testCounter = 0;
function makeOpts() {
	testCounter += 1;
	return {
		baseSessionName: "runner-flywheel",
		windowId: "@42",
		executionId: `exec_test_${testCounter.toString().padStart(3, "0")}`,
		projectName: "flywheel",
		sessionRole: "engineer",
	};
}

describe("openTmuxViewer (FLY-116 — new object signature)", () => {
	beforeEach(() => {
		// FLY-128: reset module-level state to prevent queue leakage.
		_resetTmuxViewerStateForTest();
		vi.useFakeTimers();
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});

		// `which tmux` returns a path; other sync tmux calls succeed silently.
		mockExecFileSync.mockImplementation((cmd: string, _args?: string[]) => {
			if (cmd === "which") return "/usr/local/bin/tmux";
			return "";
		});

		// Default: dedup osascript returns "open" (no existing tab).
		// Verify osascript (also matches generic mock) returns "exists" so the
		// in-queue verify settles silently. Mock handles both 3-arg and 4-arg
		// execFile signatures (FLY-128's execFilePromise calls with 4 args).
		mockExecFile.mockImplementation(
			(
				_cmd: string,
				args: string[],
				optsOrCb: unknown,
				maybeCb?: (err: Error | null, stdout?: string, stderr?: string) => void,
			) => {
				const callback = (
					typeof optsOrCb === "function" ? optsOrCb : maybeCb
				) as (err: Error | null, stdout?: string, stderr?: string) => void;
				const script = (args[1] ?? "") as string;
				if (/return "missing"/.test(script)) {
					// Verify script — return "exists" so verify settles silently
					callback(null, "exists\n", "");
				} else {
					callback(null, "open\n", "");
				}
			},
		);
	});

	afterEach(async () => {
		// Drain any leftover queue work — must do this BEFORE switching to
		// real timers, because pending fake-timer delays would otherwise be
		// lost when useRealTimers() runs, leaving openQueue unresolved.
		await settleQueue();
		vi.useRealTimers();
		await _drainTmuxViewerOpenQueueForTest();
		vi.restoreAllMocks();
	});

	it("sets a unique custom title containing baseSessionName + projectName + executionId + windowId + sessionRole", async () => {
		const opts = makeOpts();
		openTmuxViewer(opts);
		await settleQueue();

		expect(mockExecFile).toHaveBeenCalled();
		// FLY-128: multiple osascript calls per opener (dedup, open, verify);
		// inspect the OPEN call (the one with `do script`).
		const openCall = mockExecFile.mock.calls.find(
			(c) => c[0] === "osascript" && /do script/.test(c[1][1] as string),
		)!;
		const script = openCall[1][1] as string;
		expect(script).toContain(
			`flywheel:runner:runner-flywheel:flywheel:${opts.executionId}:@42:engineer`,
		);
		expect(script).toContain("set custom title of viewerTab to");
	});

	it("calls sync execFile to kill stale viewer session, create new linked viewer, and select-window", async () => {
		const opts = makeOpts();
		openTmuxViewer(opts);
		await settleQueue();

		const tmuxCalls = mockExecFileSync.mock.calls.filter(
			(c) => c[0] === "/usr/local/bin/tmux",
		);
		const subcommands = tmuxCalls.map((c) => (c[1] as string[])[0]);
		expect(subcommands).toContain("kill-session");
		expect(subcommands).toContain("new-session");
		expect(subcommands).toContain("select-window");
	});

	it("in-tab shell command only contains 'attach -t =viewer-<exec>' (no new-session, no select-window in shell)", async () => {
		const opts = makeOpts();
		openTmuxViewer(opts);
		await settleQueue();

		// FLY-128: there are now multiple osascript calls per opener — dedup,
		// open, verify. Find the OPEN script specifically (the one with `do script`).
		const openCall = mockExecFile.mock.calls.find(
			(c) => c[0] === "osascript" && /do script/.test(c[1][1] as string),
		)!;
		const script = openCall[1][1] as string;
		expect(script).toContain(
			`exec /usr/local/bin/tmux attach -t '=viewer-${opts.executionId}'`,
		);
		// In-tab shell must NOT invoke new-session or select-window — those
		// are sync execFile pre-spawn (Codex Round 4 #6).
		expect(script).not.toMatch(/tmux\s+new-session/);
		expect(script).not.toMatch(/tmux\s+select-window/);
		// Must NOT attach to base session directly with window suffix
		expect(script).not.toContain("attach -t 'runner-flywheel:@42'");
	});

	it("aborts opener if select-window keeps failing (10-retry exhausted, FLY-128)", async () => {
		const opts = makeOpts();
		mockExecFileSync.mockImplementation((cmd: string, args?: string[]) => {
			if (cmd === "which") return "/usr/local/bin/tmux";
			if (args && args[0] === "select-window") {
				throw new Error("can't find window");
			}
			return "";
		});

		openTmuxViewer(opts);
		await settleQueue();

		// Should NOT spawn the Terminal tab — only the dedup osascript call.
		const osascriptCalls = mockExecFile.mock.calls.filter(
			(c) => c[0] === "osascript",
		);
		// 1 call = dedup. No spawn call after select-window failures.
		expect(osascriptCalls).toHaveLength(1);
		expect(console.warn).toHaveBeenCalledWith(
			expect.stringContaining("select-window failed after 10 attempts"),
		);
	});

	it("dedup hit (osascript returns 'exists') skips spawning new tab", async () => {
		const opts = makeOpts();
		// FLY-128: handle both 3-arg and 4-arg execFile signatures.
		mockExecFile.mockImplementation(
			(
				_cmd: string,
				_args: string[],
				optsOrCb: unknown,
				maybeCb?: (err: Error | null, stdout?: string, stderr?: string) => void,
			) => {
				const callback = (
					typeof optsOrCb === "function" ? optsOrCb : maybeCb
				) as (err: Error | null, stdout?: string, stderr?: string) => void;
				callback(null, "exists\n", "");
			},
		);

		openTmuxViewer(opts);
		await settleQueue();

		// Only the dedup osascript call — no spawn call.
		expect(mockExecFile).toHaveBeenCalledTimes(1);
		expect(console.log).toHaveBeenCalledWith(
			expect.stringContaining("already open"),
		);
	});

	it("cancel guard: cancelOpener() before actuallyOpen() spawns prevents the Terminal tab", async () => {
		const opts = makeOpts();
		// Cancel before the dedup callback resolves.
		cancelOpener(opts.executionId);
		openTmuxViewer(opts);
		await settleQueue();

		// Only dedup call — actuallyOpen() observed cancelled flag and skipped.
		const osascriptCalls = mockExecFile.mock.calls.filter(
			(c) => c[0] === "osascript",
		);
		expect(osascriptCalls).toHaveLength(1);
		expect(console.log).toHaveBeenCalledWith(
			expect.stringContaining("opener cancelled"),
		);
	});

	it("warns and returns when tmux is not installed", () => {
		const opts = makeOpts();
		mockExecFileSync.mockImplementation((cmd: string) => {
			if (cmd === "which") throw new Error("not found");
			return "";
		});

		openTmuxViewer(opts);

		expect(console.warn).toHaveBeenCalledWith(
			expect.stringContaining("tmux not found"),
		);
		expect(mockExecFile).not.toHaveBeenCalled();
	});

	// ── FLY-754: runOpen failure classification ────────────────────────────
	// The viewer session is created BEFORE the Terminal tab spawns. When the
	// spawn osascript DEFINITELY failed (non-zero exit, no signal), the
	// just-created viewer session must be cleaned up or it leaks forever.
	// A timeout kill (real Node shape: code:null, killed:true, signal:SIGTERM)
	// is ambiguous — Terminal.app may have partially accepted `do script` — so
	// it must keep the log-only behavior (never kill a possibly-live attach).

	function killSessionCalls(executionId: string) {
		return mockExecFileSync.mock.calls.filter(
			(c) =>
				c[0] === "/usr/local/bin/tmux" &&
				(c[1] as string[])[0] === "kill-session" &&
				(c[1] as string[])[2] === `=viewer-${executionId}`,
		);
	}

	function mockOpenOsascriptFailure(err: Error) {
		mockExecFile.mockImplementation(
			(
				_cmd: string,
				args: string[],
				optsOrCb: unknown,
				maybeCb?: (e: Error | null, stdout?: string, stderr?: string) => void,
			) => {
				const callback = (
					typeof optsOrCb === "function" ? optsOrCb : maybeCb
				) as (e: Error | null, stdout?: string, stderr?: string) => void;
				const script = (args[1] ?? "") as string;
				if (/do script/.test(script)) {
					callback(err, "", "");
				} else if (/return "missing"/.test(script)) {
					callback(null, "exists\n", "");
				} else {
					callback(null, "open\n", "");
				}
			},
		);
	}

	it("definite osascript spawn failure → kills the just-created viewer session exactly once", async () => {
		const opts = makeOpts();
		mockOpenOsascriptFailure(new Error("Command failed: osascript"));

		openTmuxViewer(opts);
		await settleQueue();

		// pre-open stale cleanup + exactly one post-failure cleanup
		expect(killSessionCalls(opts.executionId)).toHaveLength(2);
	});

	it("osascript spawn timeout (killed/SIGTERM, code:null) → log-only, no post-failure kill", async () => {
		const opts = makeOpts();
		const timeoutErr = Object.assign(new Error("Command failed: osascript"), {
			code: null,
			killed: true,
			signal: "SIGTERM",
		});
		mockOpenOsascriptFailure(timeoutErr);

		openTmuxViewer(opts);
		await settleQueue();

		// Only the pre-open stale cleanup — ambiguous timeout must NOT kill.
		expect(killSessionCalls(opts.executionId)).toHaveLength(1);
	});

	it("osascript spawn success → no post-open kill-session", async () => {
		const opts = makeOpts();
		openTmuxViewer(opts);
		await settleQueue();

		// Only the pre-open stale cleanup.
		expect(killSessionCalls(opts.executionId)).toHaveLength(1);
	});
});

describe("openTmuxViewerLegacy (back-compat for older callers)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		mockExecFileSync.mockImplementation((cmd: string) => {
			if (cmd === "which") return "/usr/local/bin/tmux";
			return "";
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("attaches to the base session without setting a custom title", () => {
		openTmuxViewerLegacy("legacy-name");

		expect(mockExecFile).toHaveBeenCalledTimes(1);
		const [cmd, args] = mockExecFile.mock.calls[0]!;
		expect(cmd).toBe("osascript");
		const script = args[1] as string;
		// Legacy: attaches to base session, no custom title, no per-viewer linked session.
		expect(script).toContain("/usr/local/bin/tmux attach -t '=legacy-name'");
		expect(script).not.toContain("set custom title");
	});
});

describe("closeRunnerTerminalView (FLY-116)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		mockExecFileSync.mockImplementation((cmd: string) => {
			if (cmd === "which") return "/usr/local/bin/tmux";
			return "";
		});
		mockExecFile.mockImplementation(
			(
				_cmd: string,
				_args: string[],
				cb: (err: Error | null, stdout?: string, stderr?: string) => void,
			) => {
				cb(null, "closed\n", "");
			},
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("kills the linked viewer session and closes the tab by exact title", async () => {
		const result = await closeRunnerTerminalView({
			baseSessionName: "runner-flywheel",
			projectName: "flywheel",
			executionId: "exec_close_001",
			windowId: "@42",
			sessionRole: "qa",
		});

		expect(result.killedViewerSession).toBe(true);
		expect(result.closedTab).toBe(true);

		// kill-session call
		expect(mockExecFileSync).toHaveBeenCalledWith(
			"/usr/local/bin/tmux",
			["kill-session", "-t", "=viewer-exec_close_001"],
			expect.any(Object),
		);

		// osascript close uses exact-match selector with full title
		const lastCall = mockExecFile.mock.calls.at(-1)!;
		const script = lastCall[1][1] as string;
		expect(script).toContain(
			"flywheel:runner:runner-flywheel:flywheel:exec_close_001:@42:qa",
		);
		expect(script).toContain("(custom title of t as text) is targetTitle");
		// FLY-116 qa-fix: Terminal.app's `tab` class doesn't accept `close`,
		// so we close the parent window — but ONLY when it has exactly one tab,
		// to avoid taking down user-merged tabs. Verify both: the count guard
		// is present AND we never broadly close every window.
		expect(script).toContain("count of tabs of w");
		expect(script).toContain("close w saving no");
		expect(script).toContain("skipped_multi_tab");
		// Critical: does NOT use broad selectors
		expect(script).not.toContain("close every window");
		expect(script).not.toContain("contains");
	});

	it("returns closedTab=false when osascript reports not_found", async () => {
		mockExecFile.mockImplementation(
			(
				_cmd: string,
				_args: string[],
				cb: (err: Error | null, stdout?: string, stderr?: string) => void,
			) => {
				cb(null, "not_found\n", "");
			},
		);

		const result = await closeRunnerTerminalView({
			baseSessionName: "runner-flywheel",
			projectName: "flywheel",
			executionId: "exec_close_002",
			windowId: "@42",
		});

		expect(result.closedTab).toBe(false);
		expect(result.error).toBeUndefined();
	});

	it("non-fatal on osascript failure", async () => {
		mockExecFile.mockImplementation(
			(
				_cmd: string,
				_args: string[],
				cb: (err: Error | null, stdout?: string, stderr?: string) => void,
			) => {
				cb(new Error("osascript boom"));
			},
		);

		const result = await closeRunnerTerminalView({
			baseSessionName: "runner-flywheel",
			projectName: "flywheel",
			executionId: "exec_close_003",
			windowId: "@42",
		});

		expect(result.closedTab).toBe(false);
		expect(result.error).toContain("osascript boom");
	});
});

describe("escape helpers", () => {
	it("escapeAppleScript escapes backslash and double-quote", () => {
		expect(escapeAppleScript('a"b\\c')).toBe('a\\"b\\\\c');
	});

	it("posixEscape replaces single quotes with '\\'' so output is safe inside '...'", () => {
		expect(posixEscape("a'b")).toBe("a'\\''b");
	});

	it("posixEscape leaves regular content untouched", () => {
		expect(posixEscape("runner-flywheel")).toBe("runner-flywheel");
	});
});
