/**
 * FLY-116 macOS-only real-osascript regression test.
 *
 * Mocked unit tests cannot catch AppleScript dictionary mismatches — e.g.
 * `close t` against Terminal.app's `tab` class silently fails (errAEEventNotHandled
 * -1708) and the surrounding `try` swallows it. qa-fly-116 hit this in PR #167.
 *
 * This test runs the REAL `osascript` and REAL `Terminal.app` to verify the
 * close path actually closes a tab. Skipped on Linux/CI where `osascript` is
 * absent. Run locally on macOS via `pnpm --filter flywheel-core test`.
 *
 * Cleanup: each test creates its own Terminal window via `do script`, sets a
 * unique custom title (`flywheel:runner:test-fly-116:...`), and asserts the
 * window is gone after closeRunnerTerminalView. afterEach also nukes any
 * leftover test-titled windows in case an assertion failed mid-flight.
 */

import { execFileSync } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeRunnerTerminalView, formatViewTitle } from "../src/index.js";

const isMacOS = process.platform === "darwin";

function osascriptAvailable(): boolean {
	if (!isMacOS) return false;
	try {
		execFileSync("which", ["osascript"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

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

const skipMsg = isMacOS
	? null
	: "skipped: macOS-only (no osascript on this platform)";

describe.skipIf(!osascriptAvailable())(
	"closeRunnerTerminalView — real osascript on macOS",
	() => {
		beforeAll(() => {
			if (!isMacOS) console.log(skipMsg);
		});

		afterEach(() => {
			killTestTabsByPrefix(TEST_TITLE_PREFIX);
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
	},
);

if (!osascriptAvailable()) {
	describe("closeRunnerTerminalView — macOS regression (skipped)", () => {
		it.skip(skipMsg ?? "skipped", () => {});
	});
}
