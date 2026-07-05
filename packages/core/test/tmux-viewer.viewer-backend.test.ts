// FLY-650: viewer-backend gate (D1=A / Linux portability; Codex R2#2).
// The macOS Terminal.app/osascript opener must be SKIPPED on Linux/WSL2
// (tmux-only/none) and unchanged on macOS (cmux) — gated centrally inside
// openTmuxViewer so every dispatch call site is covered.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
	execFileSync: vi.fn(),
	execFile: vi.fn(),
}));

import { execFile, execFileSync } from "node:child_process";
import {
	openTmuxViewer,
	openTmuxViewerLegacy,
	resolveViewerBackend,
	viewerUsesTerminalApp,
} from "../src/tmux-viewer.js";

const origEnv = process.env.FLYWHEEL_VIEWER_BACKEND;

beforeEach(() => {
	vi.mocked(execFile).mockReset();
	vi.mocked(execFileSync).mockReset();
	// resolveTmuxPath() uses execFileSync to find tmux — pretend it's present so a
	// non-gated path would actually reach the opener (proving the gate, not a
	// missing-tmux skip, is what stops it).
	vi.mocked(execFileSync).mockReturnValue("/opt/homebrew/bin/tmux\n" as never);
});

afterEach(() => {
	if (origEnv === undefined) delete process.env.FLYWHEEL_VIEWER_BACKEND;
	else process.env.FLYWHEEL_VIEWER_BACKEND = origEnv;
});

describe("resolveViewerBackend", () => {
	it("env value wins", () => {
		for (const v of ["cmux", "terminal-app", "tmux-only", "none"] as const) {
			process.env.FLYWHEEL_VIEWER_BACKEND = v;
			expect(resolveViewerBackend()).toBe(v);
		}
	});

	it("falls back to platform default when env unset/invalid", () => {
		process.env.FLYWHEEL_VIEWER_BACKEND = "bogus";
		const expected = process.platform === "darwin" ? "cmux" : "tmux-only";
		expect(resolveViewerBackend()).toBe(expected);
		delete process.env.FLYWHEEL_VIEWER_BACKEND;
		expect(resolveViewerBackend()).toBe(expected);
	});
});

describe("viewerUsesTerminalApp", () => {
	// FLY-754: cmux no longer runs the Terminal.app opener — cmux-sync owns the
	// viewing surface there. Only the explicit terminal-app backend opens tabs.
	it("true ONLY for terminal-app; false for cmux/tmux-only/none", () => {
		process.env.FLYWHEEL_VIEWER_BACKEND = "cmux";
		expect(viewerUsesTerminalApp()).toBe(false);
		process.env.FLYWHEEL_VIEWER_BACKEND = "terminal-app";
		expect(viewerUsesTerminalApp()).toBe(true);
		process.env.FLYWHEEL_VIEWER_BACKEND = "tmux-only";
		expect(viewerUsesTerminalApp()).toBe(false);
		process.env.FLYWHEEL_VIEWER_BACKEND = "none";
		expect(viewerUsesTerminalApp()).toBe(false);
	});
});

describe("openTmuxViewer gate", () => {
	const opts = {
		baseSessionName: "runner-flywheel",
		windowId: "@42",
		executionId: "exec-1",
		projectName: "flywheel",
	};

	it("tmux-only → skips the Terminal.app opener (no execFile)", () => {
		process.env.FLYWHEEL_VIEWER_BACKEND = "tmux-only";
		openTmuxViewer(opts);
		expect(execFile).not.toHaveBeenCalled();
	});

	it("none → skips the opener", () => {
		process.env.FLYWHEEL_VIEWER_BACKEND = "none";
		openTmuxViewer(opts);
		expect(execFile).not.toHaveBeenCalled();
	});

	it("legacy opener is gated too", () => {
		process.env.FLYWHEEL_VIEWER_BACKEND = "tmux-only";
		openTmuxViewerLegacy("runner-flywheel");
		expect(execFile).not.toHaveBeenCalled();
	});

	// FLY-754: cmux is skipped BEFORE any tmux/osascript call — no
	// viewer-<execId> session may ever be created on a cmux host.
	it("cmux → skips the opener entirely (no tmux session, no osascript)", () => {
		process.env.FLYWHEEL_VIEWER_BACKEND = "cmux";
		openTmuxViewer(opts);
		expect(execFileSync).not.toHaveBeenCalled();
		expect(execFile).not.toHaveBeenCalled();
	});

	it("cmux → legacy opener is skipped too", () => {
		process.env.FLYWHEEL_VIEWER_BACKEND = "cmux";
		openTmuxViewerLegacy("runner-flywheel");
		expect(execFile).not.toHaveBeenCalled();
	});

	// FLY-754 byte-compat lock: terminal-app keeps the full opener path.
	it("terminal-app → passes the gate (tmux lookup happens)", () => {
		process.env.FLYWHEEL_VIEWER_BACKEND = "terminal-app";
		openTmuxViewer(opts);
		// Past the gate it resolves tmux via execFileSync (mocked present).
		expect(execFileSync).toHaveBeenCalled();
	});
});
