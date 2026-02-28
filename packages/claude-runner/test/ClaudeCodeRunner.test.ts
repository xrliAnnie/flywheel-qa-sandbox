import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock child_process before importing the module under test
vi.mock("node:child_process", () => ({
	execFile: vi.fn(),
}));

import { execFile } from "node:child_process";
import { ClaudeCodeRunner } from "../src/ClaudeCodeRunner.js";
import type { FlywheelRunRequest } from "flywheel-core";

/**
 * Helper to create a mock execFile that resolves with given stdout
 */
function mockExecFileSuccess(stdout: string) {
	const mockFn = execFile as unknown as ReturnType<typeof vi.fn>;
	mockFn.mockImplementation(
		(
			_cmd: string,
			_args: string[],
			_opts: any,
			callback: (error: Error | null, stdout: string, stderr: string) => void,
		) => {
			callback(null, stdout, "");
			return { kill: vi.fn() };
		},
	);
}

/**
 * Helper to create a mock execFile that rejects with an error
 */
function mockExecFileError(error: Error) {
	const mockFn = execFile as unknown as ReturnType<typeof vi.fn>;
	mockFn.mockImplementation(
		(
			_cmd: string,
			_args: string[],
			_opts: any,
			callback: (error: Error | null, stdout: string, stderr: string) => void,
		) => {
			callback(error, "", "");
			return { kill: vi.fn() };
		},
	);
}

/**
 * Helper to build a valid Claude CLI JSON result
 */
function buildCliResult(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		type: "result",
		subtype: "success",
		total_cost_usd: 0.042,
		is_error: false,
		duration_ms: 15000,
		duration_api_ms: 12000,
		num_turns: 5,
		result: "Task completed successfully.",
		session_id: "abc-123-def",
		...overrides,
	});
}

describe("ClaudeCodeRunner", () => {
	let runner: ClaudeCodeRunner;

	beforeEach(() => {
		vi.clearAllMocks();
		runner = new ClaudeCodeRunner();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// ─── Identity ──────────────────────────────────────────────

	it("has name 'claude'", () => {
		expect(runner.name).toBe("claude");
	});

	// ─── Parameter assembly ────────────────────────────────────

	describe("CLI argument assembly", () => {
		it("assembles minimal args (prompt + cwd only)", async () => {
			mockExecFileSuccess(buildCliResult());

			await runner.run({ prompt: "Fix the bug", cwd: "/repo" });

			const mockFn = execFile as unknown as ReturnType<typeof vi.fn>;
			const [cmd, args, opts] = mockFn.mock.calls[0];

			expect(cmd).toBe("claude");
			expect(args).toContain("--print");
			expect(args).toContain("--output-format");
			expect(args).toContain("json");
			expect(args).toContain("--");
			// Prompt comes after "--"
			const dashDashIdx = args.indexOf("--");
			expect(args[dashDashIdx + 1]).toBe("Fix the bug");
			expect(opts.cwd).toBe("/repo");
		});

		it("passes --max-turns when maxTurns is set", async () => {
			mockExecFileSuccess(buildCliResult());

			await runner.run({ prompt: "Do it", cwd: "/repo", maxTurns: 10 });

			const mockFn = execFile as unknown as ReturnType<typeof vi.fn>;
			const args: string[] = mockFn.mock.calls[0][1];
			const idx = args.indexOf("--max-turns");
			expect(idx).toBeGreaterThan(-1);
			expect(args[idx + 1]).toBe("10");
		});

		it("passes --max-budget-usd when maxCostUsd is set", async () => {
			mockExecFileSuccess(buildCliResult());

			await runner.run({ prompt: "Do it", cwd: "/repo", maxCostUsd: 5.0 });

			const mockFn = execFile as unknown as ReturnType<typeof vi.fn>;
			const args: string[] = mockFn.mock.calls[0][1];
			const idx = args.indexOf("--max-budget-usd");
			expect(idx).toBeGreaterThan(-1);
			expect(args[idx + 1]).toBe("5");
		});

		it("passes --resume when sessionId is set", async () => {
			mockExecFileSuccess(buildCliResult());

			await runner.run({
				prompt: "Continue",
				cwd: "/repo",
				sessionId: "session-xyz",
			});

			const mockFn = execFile as unknown as ReturnType<typeof vi.fn>;
			const args: string[] = mockFn.mock.calls[0][1];
			const idx = args.indexOf("--resume");
			expect(idx).toBeGreaterThan(-1);
			expect(args[idx + 1]).toBe("session-xyz");
		});

		it("passes --allowedTools when allowedTools is set", async () => {
			mockExecFileSuccess(buildCliResult());

			await runner.run({
				prompt: "Do it",
				cwd: "/repo",
				allowedTools: ["Read(**)", "Edit(**)", "Bash"],
			});

			const mockFn = execFile as unknown as ReturnType<typeof vi.fn>;
			const args: string[] = mockFn.mock.calls[0][1];
			const idx = args.indexOf("--allowedTools");
			expect(idx).toBeGreaterThan(-1);
			expect(args[idx + 1]).toBe("Read(**)");
			expect(args[idx + 2]).toBe("Edit(**)");
			expect(args[idx + 3]).toBe("Bash");
		});

		it("passes --model when model is set", async () => {
			mockExecFileSuccess(buildCliResult());

			await runner.run({ prompt: "Do it", cwd: "/repo", model: "sonnet" });

			const mockFn = execFile as unknown as ReturnType<typeof vi.fn>;
			const args: string[] = mockFn.mock.calls[0][1];
			const idx = args.indexOf("--model");
			expect(idx).toBeGreaterThan(-1);
			expect(args[idx + 1]).toBe("sonnet");
		});

		it("passes --permission-mode when permissionMode is set", async () => {
			mockExecFileSuccess(buildCliResult());

			await runner.run({
				prompt: "Do it",
				cwd: "/repo",
				permissionMode: "bypassPermissions",
			});

			const mockFn = execFile as unknown as ReturnType<typeof vi.fn>;
			const args: string[] = mockFn.mock.calls[0][1];
			const idx = args.indexOf("--permission-mode");
			expect(idx).toBeGreaterThan(-1);
			expect(args[idx + 1]).toBe("bypassPermissions");
		});

		it("passes --append-system-prompt when appendSystemPrompt is set", async () => {
			mockExecFileSuccess(buildCliResult());

			await runner.run({
				prompt: "Do it",
				cwd: "/repo",
				appendSystemPrompt: "Always use TypeScript",
			});

			const mockFn = execFile as unknown as ReturnType<typeof vi.fn>;
			const args: string[] = mockFn.mock.calls[0][1];
			const idx = args.indexOf("--append-system-prompt");
			expect(idx).toBeGreaterThan(-1);
			expect(args[idx + 1]).toBe("Always use TypeScript");
		});

		it("uses default timeout of 30 minutes", async () => {
			mockExecFileSuccess(buildCliResult());

			await runner.run({ prompt: "Do it", cwd: "/repo" });

			const mockFn = execFile as unknown as ReturnType<typeof vi.fn>;
			const opts = mockFn.mock.calls[0][2];
			expect(opts.timeout).toBe(30 * 60 * 1000);
		});

		it("uses custom timeout when timeoutMs is set", async () => {
			mockExecFileSuccess(buildCliResult());

			await runner.run({
				prompt: "Quick task",
				cwd: "/repo",
				timeoutMs: 60_000,
			});

			const mockFn = execFile as unknown as ReturnType<typeof vi.fn>;
			const opts = mockFn.mock.calls[0][2];
			expect(opts.timeout).toBe(60_000);
		});

		it("assembles all args together correctly", async () => {
			mockExecFileSuccess(buildCliResult());

			await runner.run({
				prompt: "Full request",
				cwd: "/my/repo",
				allowedTools: ["Bash"],
				maxTurns: 20,
				maxCostUsd: 3.5,
				sessionId: "prev-session",
				model: "opus",
				permissionMode: "plan",
				appendSystemPrompt: "Be careful",
			});

			const mockFn = execFile as unknown as ReturnType<typeof vi.fn>;
			const args: string[] = mockFn.mock.calls[0][1];

			// Verify all expected flags present
			expect(args).toContain("--print");
			expect(args).toContain("--output-format");
			expect(args).toContain("--max-turns");
			expect(args).toContain("--max-budget-usd");
			expect(args).toContain("--resume");
			expect(args).toContain("--allowedTools");
			expect(args).toContain("--model");
			expect(args).toContain("--permission-mode");
			expect(args).toContain("--append-system-prompt");

			// Prompt is last, after "--"
			const dashDashIdx = args.indexOf("--");
			expect(dashDashIdx).toBeGreaterThan(-1);
			expect(args[dashDashIdx + 1]).toBe("Full request");
		});
	});

	// ─── JSON output parsing ──────────────────────────────────

	describe("JSON output parsing", () => {
		it("parses successful result", async () => {
			mockExecFileSuccess(
				buildCliResult({
					total_cost_usd: 0.123,
					session_id: "session-42",
					duration_ms: 25000,
					num_turns: 8,
					result: "Done!",
				}),
			);

			const result = await runner.run({ prompt: "Do it", cwd: "/repo" });

			expect(result.success).toBe(true);
			expect(result.costUsd).toBe(0.123);
			expect(result.sessionId).toBe("session-42");
			expect(result.durationMs).toBe(25000);
			expect(result.numTurns).toBe(8);
			expect(result.resultText).toBe("Done!");
		});

		it("parses error result (is_error: true)", async () => {
			mockExecFileSuccess(
				buildCliResult({
					subtype: "error",
					is_error: true,
					total_cost_usd: 0.01,
					session_id: "session-err",
					result: "Something went wrong",
				}),
			);

			const result = await runner.run({ prompt: "Do it", cwd: "/repo" });

			expect(result.success).toBe(false);
			expect(result.costUsd).toBe(0.01);
			expect(result.sessionId).toBe("session-err");
			expect(result.resultText).toBe("Something went wrong");
		});

		it("handles missing optional fields gracefully", async () => {
			mockExecFileSuccess(
				JSON.stringify({
					type: "result",
					subtype: "success",
					total_cost_usd: 0.05,
					is_error: false,
					session_id: "s-1",
				}),
			);

			const result = await runner.run({ prompt: "Do it", cwd: "/repo" });

			expect(result.success).toBe(true);
			expect(result.costUsd).toBe(0.05);
			expect(result.sessionId).toBe("s-1");
			expect(result.durationMs).toBeUndefined();
			expect(result.numTurns).toBeUndefined();
			expect(result.resultText).toBeUndefined();
		});

		it("treats non-JSON stdout as error", async () => {
			mockExecFileSuccess("This is not JSON at all");

			const result = await runner.run({ prompt: "Do it", cwd: "/repo" });

			expect(result.success).toBe(false);
			expect(result.costUsd).toBe(0);
			expect(result.sessionId).toBe("");
		});

		it("handles empty stdout as error", async () => {
			mockExecFileSuccess("");

			const result = await runner.run({ prompt: "Do it", cwd: "/repo" });

			expect(result.success).toBe(false);
		});
	});

	// ─── Error handling ───────────────────────────────────────

	describe("error handling", () => {
		it("returns failure on process error", async () => {
			mockExecFileError(new Error("Process exited with code 1"));

			const result = await runner.run({ prompt: "Do it", cwd: "/repo" });

			expect(result.success).toBe(false);
			expect(result.costUsd).toBe(0);
			expect(result.sessionId).toBe("");
		});

		it("returns failure on timeout (ETIMEDOUT)", async () => {
			const timeoutError = new Error("Process timed out");
			(timeoutError as any).code = "ETIMEDOUT";
			(timeoutError as any).killed = true;
			mockExecFileError(timeoutError);

			const result = await runner.run({
				prompt: "Long task",
				cwd: "/repo",
				timeoutMs: 1000,
			});

			expect(result.success).toBe(false);
		});
	});

	// ─── Environment variables ────────────────────────────────

	describe("environment", () => {
		it("passes ANTHROPIC_API_KEY from process.env", async () => {
			const originalKey = process.env.ANTHROPIC_API_KEY;
			process.env.ANTHROPIC_API_KEY = "test-key-123";

			mockExecFileSuccess(buildCliResult());

			await runner.run({ prompt: "Do it", cwd: "/repo" });

			const mockFn = execFile as unknown as ReturnType<typeof vi.fn>;
			const opts = mockFn.mock.calls[0][2];
			expect(opts.env.ANTHROPIC_API_KEY).toBe("test-key-123");

			// Restore
			if (originalKey !== undefined) {
				process.env.ANTHROPIC_API_KEY = originalKey;
			} else {
				delete process.env.ANTHROPIC_API_KEY;
			}
		});

		it("unsets CLAUDECODE env var to allow nested execution", async () => {
			mockExecFileSuccess(buildCliResult());

			await runner.run({ prompt: "Do it", cwd: "/repo" });

			const mockFn = execFile as unknown as ReturnType<typeof vi.fn>;
			const opts = mockFn.mock.calls[0][2];
			expect(opts.env.CLAUDECODE).toBeUndefined();
		});
	});
});
