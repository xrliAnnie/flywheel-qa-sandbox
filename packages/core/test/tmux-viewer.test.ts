import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock child_process before importing the module under test
vi.mock("node:child_process", () => ({
	execFileSync: vi.fn(),
	execFile: vi.fn(),
}));

import { execFile, execFileSync } from "node:child_process";
import { openTmuxViewer } from "../src/tmux-viewer.js";

const mockExecFileSync = execFileSync as ReturnType<typeof vi.fn>;
const mockExecFile = execFile as ReturnType<typeof vi.fn>;

describe("openTmuxViewer", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});

		// Default: `which tmux` returns absolute path
		mockExecFileSync.mockImplementation(
			(cmd: string, args: string[], _opts?: unknown) => {
				if (cmd === "which" && args[0] === "tmux") {
					return "/usr/local/bin/tmux";
				}
				// Default for list-clients: return empty (no clients)
				return "";
			},
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("skips when client already attached", () => {
		mockExecFileSync.mockImplementation(
			(cmd: string, args: string[], _opts?: unknown) => {
				if (cmd === "which") return "/usr/local/bin/tmux";
				if (args[0] === "list-clients") return "/dev/ttys001: flywheel 160x40";
				return "";
			},
		);

		openTmuxViewer("flywheel");

		expect(mockExecFile).not.toHaveBeenCalled();
		expect(console.log).toHaveBeenCalledWith(
			expect.stringContaining("already attached"),
		);
	});

	it("opens viewer when no clients attached", () => {
		openTmuxViewer("flywheel");

		expect(mockExecFile).toHaveBeenCalledTimes(1);
		const [cmd] = mockExecFile.mock.calls[0]!;
		expect(cmd).toBe("osascript");
	});

	it("opens viewer when session does not exist yet (can't find session)", () => {
		mockExecFileSync.mockImplementation(
			(cmd: string, args: string[], _opts?: unknown) => {
				if (cmd === "which") return "/usr/local/bin/tmux";
				if (args[0] === "list-clients") {
					throw new Error("can't find session: flywheel");
				}
				return "";
			},
		);

		openTmuxViewer("flywheel");

		expect(mockExecFile).toHaveBeenCalledTimes(1);
	});

	it("warns and opens viewer on other tmux errors", () => {
		mockExecFileSync.mockImplementation(
			(cmd: string, args: string[], _opts?: unknown) => {
				if (cmd === "which") return "/usr/local/bin/tmux";
				if (args[0] === "list-clients") {
					throw new Error("server exited unexpectedly");
				}
				return "";
			},
		);

		openTmuxViewer("flywheel");

		expect(console.warn).toHaveBeenCalledWith(
			expect.stringContaining("list-clients failed"),
		);
		expect(mockExecFile).toHaveBeenCalledTimes(1);
	});

	it("warns but does not throw when osascript fails", () => {
		// Make execFile call the callback with an error
		mockExecFile.mockImplementation(
			(_cmd: string, _args: string[], cb: (err: Error | null) => void) => {
				cb(new Error("osascript failed"));
			},
		);

		expect(() => openTmuxViewer("flywheel")).not.toThrow();
		expect(console.warn).toHaveBeenCalledWith(
			expect.stringContaining("Could not auto-open"),
		);
	});

	it("includes session name in AppleScript", () => {
		openTmuxViewer("my-session");

		const [, args] = mockExecFile.mock.calls[0]!;
		const script = args[1] as string;
		expect(script).toContain("=my-session");
	});

	it("uses POSIX counter and exec in shell command", () => {
		openTmuxViewer("flywheel");

		const [, args] = mockExecFile.mock.calls[0]!;
		const script = args[1] as string;
		expect(script).toContain("while [ $i -lt 120 ]");
		expect(script).toContain("exec /usr/local/bin/tmux attach");
		expect(script).not.toContain("timeout ");
	});

	it("Phase 1 uses list-clients with absolute path", () => {
		openTmuxViewer("flywheel");

		const [, args] = mockExecFile.mock.calls[0]!;
		const script = args[1] as string;
		expect(script).toContain(
			'do shell script "/usr/local/bin/tmux list-clients',
		);
		// Should NOT use processes-based detection in Phase 1
		expect(script).not.toMatch(
			/set attached to true[\s\S]*processes of viewerTab[\s\S]*set attached/,
		);
	});

	it("Phase 2 uses processes check for auto-close", () => {
		openTmuxViewer("flywheel");

		const [, args] = mockExecFile.mock.calls[0]!;
		const script = args[1] as string;
		expect(script).toContain("processes of viewerTab");
		expect(script).toContain('does not contain "tmux"');
	});

	it("resolves tmux absolute path and uses it everywhere", () => {
		mockExecFileSync.mockImplementation(
			(cmd: string, _args: string[], _opts?: unknown) => {
				if (cmd === "which") return "/opt/homebrew/bin/tmux";
				return "";
			},
		);

		openTmuxViewer("test-session");

		// Dedup check should use absolute path
		expect(mockExecFileSync).toHaveBeenCalledWith(
			"/opt/homebrew/bin/tmux",
			["list-clients", "-t", "=test-session"],
			expect.any(Object),
		);

		// AppleScript should use absolute path
		const [, args] = mockExecFile.mock.calls[0]!;
		const script = args[1] as string;
		expect(script).toContain("/opt/homebrew/bin/tmux has-session");
		expect(script).toContain("/opt/homebrew/bin/tmux attach");
		expect(script).toContain("/opt/homebrew/bin/tmux list-clients");
	});

	it("warns and returns when tmux is not installed", () => {
		mockExecFileSync.mockImplementation(
			(cmd: string, _args: string[], _opts?: unknown) => {
				if (cmd === "which") throw new Error("not found");
				return "";
			},
		);

		openTmuxViewer("flywheel");

		expect(console.warn).toHaveBeenCalledWith(
			expect.stringContaining("tmux not found"),
		);
		expect(mockExecFile).not.toHaveBeenCalled();
	});
});
