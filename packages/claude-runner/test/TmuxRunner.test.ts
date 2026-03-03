import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { FlywheelRunRequest } from "flywheel-core";

// We'll test TmuxRunner by injecting a mock execFileFn
// Import after creating the module
import { TmuxRunner } from "../src/TmuxRunner.js";

// ─── Helpers ─────────────────────────────────────

function makeRequest(overrides: Partial<FlywheelRunRequest> = {}): FlywheelRunRequest {
	return {
		prompt: "Fix the bug in auth module",
		cwd: "/project/geoforge3d",
		...overrides,
	};
}

interface ExecCall {
	cmd: string;
	args: string[];
}

function makeMockExec(options: {
	paneDead?: boolean;
	windowId?: string;
	tmuxVersion?: string;
	hasSessionError?: boolean;
} = {}) {
	const calls: ExecCall[] = [];
	const {
		paneDead = false,
		windowId = "@42",
		tmuxVersion = "tmux 3.4",
		hasSessionError = true, // session doesn't exist by default
	} = options;

	const fn = (cmd: string, args: string[]): { stdout: string } => {
		calls.push({ cmd, args });

		if (cmd === "claude") {
			return { stdout: "claude 2.1.63" };
		}

		if (cmd === "tmux") {
			const subcommand = args[0];

			if (subcommand === "-V") {
				return { stdout: tmuxVersion };
			}

			if (subcommand === "has-session") {
				if (hasSessionError) {
					throw new Error("session not found");
				}
				return { stdout: "" };
			}

			if (subcommand === "new-session") {
				return { stdout: "" };
			}

			if (subcommand === "set-environment") {
				return { stdout: "" };
			}

			if (subcommand === "set-option") {
				return { stdout: "" };
			}

			if (subcommand === "new-window") {
				return { stdout: windowId };
			}

			if (subcommand === "list-panes") {
				if (paneDead) {
					return { stdout: "1" };
				}
				return { stdout: "0" };
			}

			if (subcommand === "kill-window") {
				return { stdout: "" };
			}
		}

		return { stdout: "" };
	};

	return { fn, calls };
}

/**
 * Create a mock exec that resolves pane_dead after N polls
 */
function makeMockExecWithDelayedDead(pollsBeforeDead: number, windowId = "@42") {
	const calls: ExecCall[] = [];
	let pollCount = 0;

	const fn = (cmd: string, args: string[]): { stdout: string } => {
		calls.push({ cmd, args });

		if (cmd === "claude") return { stdout: "claude 2.1.63" };

		if (cmd === "tmux") {
			const subcommand = args[0];
			if (subcommand === "-V") return { stdout: "tmux 3.4" };
			if (subcommand === "has-session") throw new Error("not found");
			if (subcommand === "new-session") return { stdout: "" };
			if (subcommand === "set-environment") return { stdout: "" };
			if (subcommand === "set-option") return { stdout: "" };
			if (subcommand === "new-window") return { stdout: windowId };
			if (subcommand === "list-panes") {
				pollCount++;
				return { stdout: pollCount >= pollsBeforeDead ? "1" : "0" };
			}
		}
		return { stdout: "" };
	};

	return { fn, calls };
}

// ─── Tests ───────────────────────────────────────

describe("TmuxRunner", () => {
	// ─── Construction (lazy preflight) ──────────────

	it("does NOT check tmux in constructor", () => {
		const { fn, calls } = makeMockExec();
		const _runner = new TmuxRunner("flywheel", fn);
		// No calls at all during construction
		expect(calls).toHaveLength(0);
	});

	it("has name 'claude-tmux'", () => {
		const { fn } = makeMockExec();
		const runner = new TmuxRunner("flywheel", fn);
		expect(runner.name).toBe("claude-tmux");
	});

	// ─── Preflight ──────────────────────────────────

	it("checks tmux -V and claude --version on first run() call only", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const runner = new TmuxRunner("flywheel", fn, 10);

		await runner.run(makeRequest());
		const firstRunTmuxV = calls.filter(c => c.args[0] === "-V");
		const firstRunClaude = calls.filter(c => c.cmd === "claude");
		expect(firstRunTmuxV).toHaveLength(1);
		expect(firstRunClaude).toHaveLength(1);

		// Second run should not check again
		const callsBefore = calls.length;
		await runner.run(makeRequest());
		const secondRunTmuxV = calls.slice(callsBefore).filter(c => c.args[0] === "-V");
		const secondRunClaude = calls.slice(callsBefore).filter(c => c.cmd === "claude");
		expect(secondRunTmuxV).toHaveLength(0);
		expect(secondRunClaude).toHaveLength(0);
	});

	it("throws when tmux is not installed", async () => {
		const fn = (cmd: string) => {
			if (cmd === "tmux") throw new Error("tmux not found");
			return { stdout: "" };
		};
		const runner = new TmuxRunner("flywheel", fn);

		await expect(runner.run(makeRequest())).rejects.toThrow("tmux not found");
	});

	it("throws when claude is not installed", async () => {
		const fn = (cmd: string, args: string[]) => {
			if (cmd === "tmux" && args[0] === "-V") return { stdout: "tmux 3.4" };
			if (cmd === "claude") throw new Error("claude not found");
			return { stdout: "" };
		};
		const runner = new TmuxRunner("flywheel", fn);

		await expect(runner.run(makeRequest())).rejects.toThrow("claude not found");
	});

	// ─── Session management ─────────────────────────

	it("creates tmux session if it doesn't exist", async () => {
		const { fn, calls } = makeMockExec({ hasSessionError: true, paneDead: true });
		const runner = new TmuxRunner("flywheel", fn, 10);

		await runner.run(makeRequest());

		const newSession = calls.find(c => c.args[0] === "new-session");
		expect(newSession).toBeDefined();
		expect(newSession!.args).toContain("flywheel");
	});

	it("reuses existing session", async () => {
		const { fn, calls } = makeMockExec({ hasSessionError: false, paneDead: true });
		const runner = new TmuxRunner("flywheel", fn, 10);

		await runner.run(makeRequest());

		const newSession = calls.find(c => c.args[0] === "new-session");
		expect(newSession).toBeUndefined();
	});

	// ─── Window launch ──────────────────────────────

	it("launches tmux window with -c request.cwd", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const runner = new TmuxRunner("flywheel", fn, 10);

		await runner.run(makeRequest({ cwd: "/my/project" }));

		const newWindow = calls.find(c => c.args[0] === "new-window");
		expect(newWindow).toBeDefined();
		const cwdIdx = newWindow!.args.indexOf("-c");
		expect(cwdIdx).toBeGreaterThan(-1);
		expect(newWindow!.args[cwdIdx + 1]).toBe("/my/project");
	});

	it("uses request.label for window name (not request.sessionId)", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const runner = new TmuxRunner("flywheel", fn, 10);

		await runner.run(makeRequest({ label: "GEO-101", sessionId: "should-be-ignored" }));

		const newWindow = calls.find(c => c.args[0] === "new-window");
		const nIdx = newWindow!.args.indexOf("-n");
		expect(newWindow!.args[nIdx + 1]).toBe("GEO-101");
	});

	it("falls back to timestamp-based name when no label", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const runner = new TmuxRunner("flywheel", fn, 10);

		await runner.run(makeRequest({ label: undefined }));

		const newWindow = calls.find(c => c.args[0] === "new-window");
		const nIdx = newWindow!.args.indexOf("-n");
		const windowName = newWindow!.args[nIdx + 1]!;
		expect(windowName).toMatch(/^issue-\d+$/);
	});

	it("sanitizes window name (removes special chars)", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const runner = new TmuxRunner("flywheel", fn, 10);

		await runner.run(makeRequest({ label: "GEO/101:special.chars!" }));

		const newWindow = calls.find(c => c.args[0] === "new-window");
		const nIdx = newWindow!.args.indexOf("-n");
		const windowName = newWindow!.args[nIdx + 1]!;
		expect(windowName).toMatch(/^[a-zA-Z0-9-]+$/);
		expect(windowName).not.toContain("/");
		expect(windowName).not.toContain(":");
	});

	it("truncates window name to 50 characters", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const runner = new TmuxRunner("flywheel", fn, 10);
		const longLabel = "a".repeat(100);

		await runner.run(makeRequest({ label: longLabel }));

		const newWindow = calls.find(c => c.args[0] === "new-window");
		const nIdx = newWindow!.args.indexOf("-n");
		const windowName = newWindow!.args[nIdx + 1]!;
		expect(windowName.length).toBeLessThanOrEqual(50);
	});

	// ─── Claude args ────────────────────────────────

	it("passes --session-id <uuid> to claude (ignores request.sessionId)", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const runner = new TmuxRunner("flywheel", fn, 10);

		await runner.run(makeRequest({ sessionId: "old-session-id" }));

		const newWindow = calls.find(c => c.args[0] === "new-window");
		const claudeArgs = newWindow!.args;
		// Should contain --session-id with a UUID, not "old-session-id"
		const sessionIdx = claudeArgs.indexOf("--session-id");
		expect(sessionIdx).toBeGreaterThan(-1);
		const sessionId = claudeArgs[sessionIdx + 1]!;
		expect(sessionId).not.toBe("old-session-id");
		expect(sessionId).toMatch(/^[0-9a-f-]{36}$/); // UUID format
	});

	it("does NOT include --print or --output-format", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const runner = new TmuxRunner("flywheel", fn, 10);

		await runner.run(makeRequest());

		const newWindow = calls.find(c => c.args[0] === "new-window");
		const allArgs = newWindow!.args.join(" ");
		expect(allArgs).not.toContain("--print");
		expect(allArgs).not.toContain("--output-format");
	});

	it("includes --permission-mode and --append-system-prompt", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const runner = new TmuxRunner("flywheel", fn, 10);

		await runner.run(makeRequest({
			permissionMode: "bypassPermissions",
			appendSystemPrompt: "Always use TypeScript",
		}));

		const newWindow = calls.find(c => c.args[0] === "new-window");
		const args = newWindow!.args;
		expect(args).toContain("--permission-mode");
		expect(args).toContain("bypassPermissions");
		expect(args).toContain("--append-system-prompt");
		expect(args).toContain("Always use TypeScript");
	});

	it("passes --model when specified", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const runner = new TmuxRunner("flywheel", fn, 10);

		await runner.run(makeRequest({ model: "opus" }));

		const newWindow = calls.find(c => c.args[0] === "new-window");
		const args = newWindow!.args;
		expect(args).toContain("--model");
		expect(args).toContain("opus");
	});

	it("passes --allowed-tools when specified", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const runner = new TmuxRunner("flywheel", fn, 10);

		await runner.run(makeRequest({ allowedTools: ["Read", "Bash"] }));

		const newWindow = calls.find(c => c.args[0] === "new-window");
		const args = newWindow!.args;
		expect(args).toContain("--allowed-tools");
		expect(args).toContain("Read");
		expect(args).toContain("Bash");
	});

	it("does NOT pass --max-turns (flag does not exist in CLI)", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const runner = new TmuxRunner("flywheel", fn, 10);

		await runner.run(makeRequest({ maxTurns: 50 }));

		const newWindow = calls.find(c => c.args[0] === "new-window");
		const allArgs = newWindow!.args.join(" ");
		expect(allArgs).not.toContain("--max-turns");
	});

	it("does NOT pass --allowed-tools when array is empty", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const runner = new TmuxRunner("flywheel", fn, 10);

		await runner.run(makeRequest({ allowedTools: [] }));

		const newWindow = calls.find(c => c.args[0] === "new-window");
		const allArgs = newWindow!.args.join(" ");
		expect(allArgs).not.toContain("--allowed-tools");
	});

	it("does NOT pass --max-budget-usd", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const runner = new TmuxRunner("flywheel", fn, 10);

		await runner.run(makeRequest({ maxCostUsd: 5.0 }));

		const newWindow = calls.find(c => c.args[0] === "new-window");
		const allArgs = newWindow!.args.join(" ");
		expect(allArgs).not.toContain("--max-budget-usd");
	});

	// ─── remain-on-exit ─────────────────────────────

	it("injects FLYWHEEL_MARKER_DIR into tmux session environment", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const runner = new TmuxRunner("flywheel", fn, 10);

		await runner.run(makeRequest());

		const setEnvCalls = calls.filter(c => c.args[0] === "set-environment");
		const markerDirCall = setEnvCalls.find(c => c.args.includes("FLYWHEEL_MARKER_DIR") && !c.args.includes("-u"));
		expect(markerDirCall).toBeDefined();
		expect(markerDirCall!.args).toContain("-t");
		expect(markerDirCall!.args).toContain("=flywheel");
	});

	it("unsets CLAUDECODE env var to prevent nested Claude hang", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const runner = new TmuxRunner("flywheel", fn, 10);

		await runner.run(makeRequest());

		const setEnvCalls = calls.filter(c => c.args[0] === "set-environment");
		const unsetCall = setEnvCalls.find(c => c.args.includes("-u") && c.args.includes("CLAUDECODE"));
		expect(unsetCall).toBeDefined();
		expect(unsetCall!.args).toContain("-t");
		expect(unsetCall!.args).toContain("=flywheel");
	});

	it("sets remain-on-exit on", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const runner = new TmuxRunner("flywheel", fn, 10);

		await runner.run(makeRequest());

		const setOption = calls.find(c => c.args[0] === "set-option");
		expect(setOption).toBeDefined();
		expect(setOption!.args).toContain("remain-on-exit");
		expect(setOption!.args).toContain("on");
	});

	// ─── Completion detection ───────────────────────

	it("resolves when pane_dead = 1 (fallback path) with timedOut=false", async () => {
		const { fn } = makeMockExecWithDelayedDead(1);
		const runner = new TmuxRunner("flywheel", fn, 10);

		const result = await runner.run(makeRequest());

		expect(result.success).toBe(true);
		expect(result.timedOut).toBe(false);
	});

	it("resolves when window is gone entirely (catch path)", async () => {
		let pollCount = 0;
		const calls: ExecCall[] = [];
		const fn = (cmd: string, args: string[]): { stdout: string } => {
			calls.push({ cmd, args });
			if (cmd === "claude") return { stdout: "claude 2.1.63" };
			if (cmd === "tmux") {
				if (args[0] === "-V") return { stdout: "tmux 3.4" };
				if (args[0] === "has-session") throw new Error("not found");
				if (args[0] === "new-session") return { stdout: "" };
				if (args[0] === "set-environment") return { stdout: "" };
				if (args[0] === "set-option") return { stdout: "" };
				if (args[0] === "new-window") return { stdout: "@42" };
				if (args[0] === "list-panes") {
					pollCount++;
					if (pollCount >= 1) throw new Error("window gone");
				}
			}
			return { stdout: "" };
		};
		const runner = new TmuxRunner("flywheel", fn, 10);

		const result = await runner.run(makeRequest());
		expect(result.success).toBe(true);
	});

	// ─── Timeout ────────────────────────────────────

	it("honors request.timeoutMs over default timeout", async () => {
		// Use a very short timeout + never-dead pane
		const { fn } = makeMockExec({ paneDead: false });
		const runner = new TmuxRunner("flywheel", fn, 10, 60000);

		// Short timeout should resolve quickly
		const start = Date.now();
		const result = await runner.run(makeRequest({ timeoutMs: 50 }));
		const elapsed = Date.now() - start;

		expect(result.success).toBe(true); // timeout resolves, not rejects
		expect(elapsed).toBeLessThan(5000); // should be fast
	});

	it("resolves on timeout with timedOut=true (preserves window for inspection)", async () => {
		const { fn } = makeMockExec({ paneDead: false });
		const runner = new TmuxRunner("flywheel", fn, 10, 50); // 50ms default timeout

		const result = await runner.run(makeRequest());

		// Timeout resolves (not rejects) — Blueprint checks git for actual success
		expect(result.success).toBe(true);
		expect(result.tmuxWindow).toBeDefined();
		expect(result.timedOut).toBe(true);
	});

	// ─── Return values ──────────────────────────────

	it("returns sessionId as UUID (same used for --session-id)", async () => {
		const { fn } = makeMockExec({ paneDead: true });
		const runner = new TmuxRunner("flywheel", fn, 10);

		const result = await runner.run(makeRequest());

		expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("captures window_id from tmux new-window -P -F", async () => {
		const { fn } = makeMockExec({ paneDead: true, windowId: "@99" });
		const runner = new TmuxRunner("flywheel", fn, 10);

		const result = await runner.run(makeRequest());

		expect(result.tmuxWindow).toBe("flywheel:@99");
	});

	it("uses window_id (not window_name) for polling", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true, windowId: "@55" });
		const runner = new TmuxRunner("flywheel", fn, 10);

		await runner.run(makeRequest({ label: "GEO-101" }));

		const listPanes = calls.find(c => c.args[0] === "list-panes");
		expect(listPanes).toBeDefined();
		// Should use @55, not "GEO-101"
		const tIdx = listPanes!.args.indexOf("-t");
		expect(listPanes!.args[tIdx + 1]).toBe("@55");
	});

	it("returns tmuxWindow in format session:@id", async () => {
		const { fn } = makeMockExec({ paneDead: true, windowId: "@42" });
		const runner = new TmuxRunner("test-session", fn, 10);

		const result = await runner.run(makeRequest());

		expect(result.tmuxWindow).toBe("test-session:@42");
	});

	it("returns durationMs", async () => {
		const { fn } = makeMockExec({ paneDead: true });
		const runner = new TmuxRunner("flywheel", fn, 10);

		const result = await runner.run(makeRequest());

		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});

	// ─── Prompt positioning ─────────────────────────

	it("puts prompt as last positional argument (options before prompt)", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const runner = new TmuxRunner("flywheel", fn, 10);

		await runner.run(makeRequest({
			prompt: "Fix the bug",
			permissionMode: "bypassPermissions",
		}));

		const newWindow = calls.find(c => c.args[0] === "new-window");
		const args = newWindow!.args;
		// Find "claude" in args, then check prompt is last
		const claudeIdx = args.indexOf("claude");
		const claudeArgs = args.slice(claudeIdx + 1);
		// Prompt should be last
		expect(claudeArgs[claudeArgs.length - 1]).toBe("Fix the bug");
		// --permission-mode should come before prompt
		const permIdx = claudeArgs.indexOf("--permission-mode");
		expect(permIdx).toBeLessThan(claudeArgs.length - 1);
	});

	// ─── v0.2: hookServer integration ──────────────

	describe("v0.2 hookServer mode", () => {
		function makeMockHookServer(options: {
			port?: number;
			resolveImmediately?: boolean;
		} = {}) {
			const { port = 9876, resolveImmediately = true } = options;
			return {
				getPort: vi.fn(() => port),
				waitForCompletion: vi.fn(async (_token: string, _timeoutMs: number) => {
					if (resolveImmediately) {
						return { token: _token, sessionId: "hook-session", issueId: "GEO-42" };
					}
					// Never resolve — let pane_dead or timeout win
					return new Promise(() => {});
				}),
			};
		}

		it("accepts optional hookServer in constructor", () => {
			const { fn } = makeMockExec();
			const hookServer = makeMockHookServer();
			const runner = new TmuxRunner("flywheel", fn, 10, 30000, hookServer);
			expect(runner.name).toBe("claude-tmux");
		});

		it("run() without hookServer — no env vars injected (v0.1.1 path)", async () => {
			const { fn, calls } = makeMockExec({ paneDead: true });
			const runner = new TmuxRunner("flywheel", fn, 10);

			await runner.run(makeRequest());

			const newWindow = calls.find(c => c.args[0] === "new-window");
			const args = newWindow!.args;
			expect(args.join(" ")).not.toContain("FLYWHEEL_CALLBACK_PORT");
			expect(args.join(" ")).not.toContain("FLYWHEEL_CALLBACK_TOKEN");
		});

		it("run() with hookServer — env vars in tmux new-window args", async () => {
			const hookServer = makeMockHookServer({ port: 12345 });
			const { fn, calls } = makeMockExec({ paneDead: true });
			const runner = new TmuxRunner("flywheel", fn, 10, 30000, hookServer);

			await runner.run(makeRequest({ issueId: "GEO-42" }));

			const newWindow = calls.find(c => c.args[0] === "new-window");
			const args = newWindow!.args;

			// Check -e flags are present
			const envArgStr = args.join(" ");
			expect(envArgStr).toContain("FLYWHEEL_CALLBACK_PORT=12345");
			expect(envArgStr).toContain("FLYWHEEL_CALLBACK_TOKEN=");
			expect(envArgStr).toContain("FLYWHEEL_ISSUE_ID=GEO-42");
		});

		it("waitForCompletion resolves on HTTP callback", async () => {
			const hookServer = makeMockHookServer({ resolveImmediately: true });
			const { fn } = makeMockExec({ paneDead: false });
			const runner = new TmuxRunner("flywheel", fn, 100, 5000, hookServer);

			const result = await runner.run(makeRequest());

			expect(result.timedOut).toBe(false);
			expect(hookServer.waitForCompletion).toHaveBeenCalled();
		});

		it("waitForCompletion resolves on pane_dead even with hookServer", async () => {
			// hookServer never resolves, but pane dies
			const hookServer = makeMockHookServer({ resolveImmediately: false });
			const { fn } = makeMockExecWithDelayedDead(1);
			const runner = new TmuxRunner("flywheel", fn, 10, 5000, hookServer);

			const result = await runner.run(makeRequest());

			expect(result.timedOut).toBe(false);
		});

		it("callbackToken is unique per run() call", async () => {
			const hookServer = makeMockHookServer();
			const { fn } = makeMockExec({ paneDead: true });
			const runner = new TmuxRunner("flywheel", fn, 10, 30000, hookServer);

			await runner.run(makeRequest());
			await runner.run(makeRequest());

			const calls = hookServer.waitForCompletion.mock.calls;
			expect(calls).toHaveLength(2);
			const token1 = calls[0]![0];
			const token2 = calls[1]![0];
			expect(token1).not.toBe(token2);
		});

		it("timeout still works with hookServer", async () => {
			const hookServer = makeMockHookServer({ resolveImmediately: false });
			const { fn } = makeMockExec({ paneDead: false });
			const runner = new TmuxRunner("flywheel", fn, 100, 50, hookServer);

			const result = await runner.run(makeRequest());

			expect(result.timedOut).toBe(true);
		});

		it("v0.2 mode does not set FLYWHEEL_MARKER_DIR in session env", async () => {
			const hookServer = makeMockHookServer();
			const { fn, calls } = makeMockExec({ paneDead: true });
			const runner = new TmuxRunner("flywheel", fn, 10, 30000, hookServer);

			await runner.run(makeRequest());

			const setEnvCalls = calls.filter(c => c.args[0] === "set-environment");
			const markerDirCall = setEnvCalls.find(c => c.args.includes("FLYWHEEL_MARKER_DIR") && !c.args.includes("-u"));
			expect(markerDirCall).toBeUndefined();
		});

		it("uses issueId from request (not label) for env var", async () => {
			const hookServer = makeMockHookServer({ port: 8888 });
			const { fn, calls } = makeMockExec({ paneDead: true });
			const runner = new TmuxRunner("flywheel", fn, 10, 30000, hookServer);

			await runner.run(makeRequest({ label: "GEO-42-Fix auth bug", issueId: "GEO-42" }));

			const newWindow = calls.find(c => c.args[0] === "new-window");
			const args = newWindow!.args;
			expect(args.join(" ")).toContain("FLYWHEEL_ISSUE_ID=GEO-42");
		});
	});
});
