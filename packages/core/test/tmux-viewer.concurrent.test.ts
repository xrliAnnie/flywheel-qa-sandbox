/**
 * FLY-128 — Regression tests proving openTmuxViewer's process-local opener
 * queue serializes the full pipeline (dedup → tmux setup → final do-script →
 * in-queue verify). Without this serialization, 3 concurrent runners can race
 * on Terminal.app Apple Events; only 1 tab actually opens (production observed
 * 2026-05-05).
 *
 * Test design (Codex Round 6 APPROVED):
 *   - Manually drive osascript callbacks via captured `execFile` mock impl.
 *   - Assert ordering: opener N+1's dedup MUST NOT start until opener N's full
 *     pipeline (dedup, open, verify) settles.
 *   - Per-step timeout option is passed to `execFile` calls.
 *   - Queue continues after a per-step timeout/error.
 *   - `openingTitles` is released in the top-level `finally` for every path.
 */

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

vi.mock("node:child_process", () => ({
	execFileSync: vi.fn(),
	execFile: vi.fn(),
}));

import { execFile, execFileSync } from "node:child_process";
import {
	_hasOpeningTitleForTest,
	_resetTmuxViewerStateForTest,
	openTmuxViewer,
	type TmuxViewerOpts,
} from "../src/tmux-viewer.js";

const mockExecFileSync = execFileSync as ReturnType<typeof vi.fn>;
const mockExecFile = execFile as ReturnType<typeof vi.fn>;

type ExecFileCb = (err: Error | null, stdout?: string, stderr?: string) => void;

interface CapturedCall {
	cmd: string;
	args: string[];
	opts: { timeout?: number };
	cb: ExecFileCb;
	scriptKind: "dedup" | "open" | "verify";
}

function classifyScript(args: string[]): CapturedCall["scriptKind"] {
	const script = (args[1] ?? "") as string;
	if (/do script/.test(script)) return "open";
	if (/return "missing"/.test(script)) return "verify";
	return "dedup";
}

function makeOpts(suffix: number): TmuxViewerOpts {
	return {
		baseSessionName: "runner-flywheel",
		windowId: "@42",
		executionId: `exec_concurrent_${suffix.toString().padStart(3, "0")}`,
		projectName: "flywheel",
		sessionRole: "engineer",
	};
}

async function flush(): Promise<void> {
	// Yield to microtasks AND advance fake timers a bit so awaiting `delay()`s
	// inside doOpen can fire.
	for (let i = 0; i < 10; i++) {
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(10);
	}
}

describe("openTmuxViewer concurrent serialization (FLY-128)", () => {
	let calls: CapturedCall[];

	beforeEach(() => {
		_resetTmuxViewerStateForTest();
		vi.useFakeTimers();
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});

		mockExecFileSync.mockImplementation((cmd: string) => {
			if (cmd === "which") return "/usr/local/bin/tmux";
			return "";
		});

		calls = [];
		// Capture every execFile call WITHOUT firing the callback — tests drive
		// callbacks manually to assert ordering.
		mockExecFile.mockImplementation(
			(
				cmd: string,
				args: string[],
				optsOrCb: unknown,
				maybeCb?: ExecFileCb,
			) => {
				const cb = (
					typeof optsOrCb === "function" ? optsOrCb : maybeCb
				) as ExecFileCb;
				const opts = (typeof optsOrCb === "object" ? optsOrCb : {}) as {
					timeout?: number;
				};
				calls.push({
					cmd,
					args,
					opts,
					cb,
					scriptKind: classifyScript(args),
				});
			},
		);
	});

	afterEach(async () => {
		// Drain by repeatedly: resolve any unresolved captured callbacks,
		// advance timers, and yield microtasks. New calls may appear during
		// drain (e.g., doOpen continues past dedup → fires open). Loop until
		// quiescent or hard ceiling.
		const resolved = new WeakSet<ExecFileCb>();
		for (let i = 0; i < 30; i++) {
			let pending = 0;
			for (const c of calls) {
				if (resolved.has(c.cb)) continue;
				resolved.add(c.cb);
				pending++;
				try {
					c.cb(null, c.scriptKind === "verify" ? "exists\n" : "open\n", "");
				} catch {
					/* benign */
				}
			}
			await vi.advanceTimersByTimeAsync(2000);
			await Promise.resolve();
			if (pending === 0) break;
		}
		vi.useRealTimers();
		// Hard reset to guarantee no state leaks to the next test.
		_resetTmuxViewerStateForTest();
		vi.restoreAllMocks();
	});

	function findCallsOf(kind: CapturedCall["scriptKind"]): CapturedCall[] {
		return calls.filter((c) => c.scriptKind === kind);
	}

	it("serialization ordering: dedup#2 does not start until opener#1 (incl in-queue verify) settles", async () => {
		openTmuxViewer(makeOpts(1));
		openTmuxViewer(makeOpts(2));
		openTmuxViewer(makeOpts(3));
		await flush();

		// Only Runner 1's dedup should have started so far.
		expect(findCallsOf("dedup")).toHaveLength(1);
		expect(findCallsOf("open")).toHaveLength(0);
		expect(findCallsOf("verify")).toHaveLength(0);

		// Resolve Runner 1's dedup as "open" → proceed to actuallyOpen.
		findCallsOf("dedup")[0]!.cb(null, "open\n", "");
		await flush();

		// Runner 1's open should be in flight; Runner 2 still not started.
		expect(findCallsOf("open")).toHaveLength(1);
		expect(findCallsOf("dedup")).toHaveLength(1);

		// Resolve Runner 1's open success — but dedup#2 must NOT start yet
		// because the in-queue verify (1500ms delay + verify osascript) is next.
		findCallsOf("open")[0]!.cb(null, "open\n", "");
		await flush();
		expect(findCallsOf("dedup")).toHaveLength(1);
		expect(findCallsOf("verify")).toHaveLength(0);

		// Advance the in-queue verify delay (1500ms).
		await vi.advanceTimersByTimeAsync(1500);
		await flush();

		// Verify osascript now in flight; dedup#2 still must not have started.
		expect(findCallsOf("verify")).toHaveLength(1);
		expect(findCallsOf("dedup")).toHaveLength(1);

		// Resolve verify → queue advances to Runner 2.
		findCallsOf("verify")[0]!.cb(null, "exists\n", "");
		await flush();
		expect(findCallsOf("dedup")).toHaveLength(2);

		// Have Runner 2's dedup return "exists" — short-circuits doOpen, queue
		// proceeds to Runner 3 without going through open + verify.
		findCallsOf("dedup")[1]!.cb(null, "exists\n", "");
		await flush();
		expect(findCallsOf("dedup")).toHaveLength(3);
	});

	it("passes per-step { timeout } option to execFile osascript calls", async () => {
		openTmuxViewer(makeOpts(11));
		await flush();

		const dedupCall = findCallsOf("dedup")[0]!;
		expect(dedupCall.opts.timeout).toBe(5_000);

		// Drive past dedup
		dedupCall.cb(null, "open\n", "");
		await flush();

		const openCall = findCallsOf("open")[0]!;
		expect(openCall.opts.timeout).toBe(5_000);

		// Drive past open + verify-delay
		openCall.cb(null, "open\n", "");
		await vi.advanceTimersByTimeAsync(1500);
		await flush();

		const verifyCall = findCallsOf("verify")[0]!;
		expect(verifyCall.opts.timeout).toBe(5_000);
	});

	it("queue continues when opener#1's dedup osascript fires ETIMEDOUT (async)", async () => {
		// runDedup catches the error and returns false ("fail open"), so the
		// pipeline progresses through tmux setup → open → verify. We resolve
		// open + verify with success, then assert opener#2 starts.
		openTmuxViewer(makeOpts(50));
		openTmuxViewer(makeOpts(51));
		await flush();

		// Reject opener#1's dedup callback as if Node's child-process timeout fired.
		findCallsOf("dedup")[0]!.cb(
			Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }),
		);
		await flush();

		// runDedup fails open → doOpen continues to runOpen.
		findCallsOf("open")[0]!.cb(null, "open\n", "");
		await vi.advanceTimersByTimeAsync(1500);
		await flush();
		findCallsOf("verify")[0]!.cb(null, "exists\n", "");
		await flush();

		// Opener#2's dedup must have started.
		expect(findCallsOf("dedup")).toHaveLength(2);
	});

	it("queue continues after per-step timeout/error in opener#1", async () => {
		// Force select-window to keep failing so opener#1 aborts early in the
		// pipeline (after dedup, but before open). The queue must still
		// advance to opener#2.
		mockExecFileSync.mockImplementation((cmd: string, args?: string[]) => {
			if (cmd === "which") return "/usr/local/bin/tmux";
			if (args && args[0] === "select-window") {
				throw new Error("can't find window");
			}
			return "";
		});

		openTmuxViewer(makeOpts(21));
		openTmuxViewer(makeOpts(22));
		await flush();

		// Drive opener#1 past dedup
		findCallsOf("dedup")[0]!.cb(null, "open\n", "");
		// Each select-window retry awaits delay(500); 10 attempts → 5s.
		await vi.advanceTimersByTimeAsync(10 * 500 + 100);
		await flush();

		// Despite opener#1's select-window abort, opener#2's dedup must have started.
		expect(findCallsOf("dedup")).toHaveLength(2);
	});

	it("verification is enqueued: dedup#2 cannot start until verify of #1 completes", async () => {
		openTmuxViewer(makeOpts(31));
		openTmuxViewer(makeOpts(32));
		await flush();

		findCallsOf("dedup")[0]!.cb(null, "open\n", "");
		await flush();

		findCallsOf("open")[0]!.cb(null, "open\n", "");
		await flush();

		// Verify delay still pending — dedup#2 must still wait.
		expect(findCallsOf("dedup")).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(1500);
		await flush();

		// Verify osascript fires — dedup#2 still must not have started.
		expect(findCallsOf("verify")).toHaveLength(1);
		expect(findCallsOf("dedup")).toHaveLength(1);

		// Resolve verify → only now should dedup#2 begin.
		findCallsOf("verify")[0]!.cb(null, "exists\n", "");
		await flush();
		expect(findCallsOf("dedup")).toHaveLength(2);
	});

	it("openingTitles released in finally for success path", async () => {
		const opts = makeOpts(41);
		openTmuxViewer(opts);
		await flush();

		// Complete the full pipeline — success path.
		findCallsOf("dedup")[0]!.cb(null, "open\n", "");
		await flush();
		findCallsOf("open")[0]!.cb(null, "open\n", "");
		await vi.advanceTimersByTimeAsync(1500);
		await flush();
		findCallsOf("verify")[0]!.cb(null, "exists\n", "");
		await flush();

		// title held during opener; released in `.finally()` after queue settles.
		const expectedTitle = `flywheel:runner:runner-flywheel:flywheel:${opts.executionId}:@42:engineer`;
		expect(_hasOpeningTitleForTest(expectedTitle)).toBe(false);
	});

	it("openingTitles released in finally for dedup-hit path", async () => {
		const opts = makeOpts(42);
		openTmuxViewer(opts);
		await flush();

		// Dedup says exists → doOpen returns early.
		findCallsOf("dedup")[0]!.cb(null, "exists\n", "");
		await flush();

		const expectedTitle = `flywheel:runner:runner-flywheel:flywheel:${opts.executionId}:@42:engineer`;
		expect(_hasOpeningTitleForTest(expectedTitle)).toBe(false);
	});

	it("openingTitles released in finally for select-window abort path", async () => {
		const opts = makeOpts(43);
		// Force select-window to keep failing (10 attempts).
		mockExecFileSync.mockImplementation((cmd: string, args?: string[]) => {
			if (cmd === "which") return "/usr/local/bin/tmux";
			if (args && args[0] === "select-window") {
				throw new Error("can't find window");
			}
			return "";
		});

		openTmuxViewer(opts);
		await flush();

		// Drive past dedup
		findCallsOf("dedup")[0]!.cb(null, "open\n", "");
		// Each select-window retry awaits delay(500) — advance enough for all 10
		await vi.advanceTimersByTimeAsync(10 * 500 + 100);
		await flush();

		const expectedTitle = `flywheel:runner:runner-flywheel:flywheel:${opts.executionId}:@42:engineer`;
		expect(_hasOpeningTitleForTest(expectedTitle)).toBe(false);
	});
});
