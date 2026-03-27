import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
	IAdapter,
} from "flywheel-core";
import type { DagNode } from "flywheel-dag-resolver";
import { describe, expect, it, vi } from "vitest";
import type { BlueprintContext, ShellRunner } from "../Blueprint.js";
import { Blueprint } from "../Blueprint.js";
import type { ExecutionEventEmitter } from "../ExecutionEventEmitter.js";
import type { GitResultChecker } from "../GitResultChecker.js";
import { PreHydrator } from "../PreHydrator.js";

// ─── Helpers ─────────────────────────────────────

function makeNode(id = "GEO-101"): DagNode {
	return { id, blockedBy: [] };
}

function makeContext(
	overrides: Partial<BlueprintContext> = {},
): BlueprintContext {
	return {
		executionId: "test-exec-id",
		teamName: "eng",
		runnerName: "claude",
		...overrides,
	};
}

function makeMockAdapter(
	result: Partial<AdapterExecutionResult> = {},
): IAdapter {
	return {
		type: "mock",
		supportsStreaming: false,
		checkEnvironment: async () => ({ healthy: true, message: "mock" }),
		execute: vi.fn(
			async (
				_ctx: AdapterExecutionContext,
			): Promise<AdapterExecutionResult> => ({
				success: true,
				sessionId: "sess-uuid",
				tmuxWindow: "flywheel:@42",
				durationMs: 5000,
				...result,
			}),
		),
	};
}

function makeThrowingAdapter(error: Error): IAdapter {
	return {
		type: "mock",
		supportsStreaming: false,
		checkEnvironment: async () => ({ healthy: true, message: "mock" }),
		execute: vi.fn(async () => {
			throw error;
		}),
	};
}

function makeMockGitChecker(
	options: {
		cleanTree?: boolean;
		baseSha?: string;
		commitCount?: number;
		filesChanged?: number;
		commitMessages?: string[];
	} = {},
) {
	const {
		cleanTree = true,
		baseSha = "abc123",
		commitCount = 1,
		filesChanged = 3,
		commitMessages = ["feat: implement feature"],
	} = options;

	return {
		assertCleanTree: cleanTree
			? vi.fn(async () => {})
			: vi.fn(async () => {
					throw new Error("Git working tree is not clean in /project");
				}),
		captureBaseline: vi.fn(async () => baseSha),
		check: vi.fn(async () => ({
			hasNewCommits: commitCount > 0,
			commitCount,
			filesChanged,
			commitMessages,
		})),
	} as unknown as GitResultChecker;
}

function makeMockShell(): ShellRunner {
	return {
		execFile: vi.fn(async () => ({ stdout: "", exitCode: 0 })),
	};
}

function makeHydrator() {
	return new PreHydrator(async (id) => ({
		title: `Issue ${id} title`,
		description: `Description for ${id}`,
	}));
}

// ─── Tests ───────────────────────────────────────

describe("Blueprint", () => {
	// ─── Git preflight ──────────────────────────────

	it("asserts clean git tree before anything else", async () => {
		const gitChecker = makeMockGitChecker();
		const adapter = makeMockAdapter();
		const blueprint = new Blueprint(
			makeHydrator(),
			gitChecker,
			() => adapter,
			makeMockShell(),
		);

		await blueprint.run(makeNode(), "/project", makeContext());

		expect(gitChecker.assertCleanTree).toHaveBeenCalledWith("/project");
	});

	it("throws when git tree is dirty", async () => {
		const gitChecker = makeMockGitChecker({ cleanTree: false });
		const adapter = makeMockAdapter();
		const blueprint = new Blueprint(
			makeHydrator(),
			gitChecker,
			() => adapter,
			makeMockShell(),
		);

		await expect(
			blueprint.run(makeNode(), "/project", makeContext()),
		).rejects.toThrow("Git working tree is not clean");

		// Adapter should NOT have been called
		expect(adapter.execute).not.toHaveBeenCalled();
	});

	// ─── Hydration ──────────────────────────────────

	it("hydrates issue before launching adapter", async () => {
		const fetchIssue = vi.fn(async () => ({
			title: "Custom Title",
			description: "Custom Desc",
		}));
		const hydrator = new PreHydrator(fetchIssue);
		const adapter = makeMockAdapter();
		const blueprint = new Blueprint(
			hydrator,
			makeMockGitChecker(),
			() => adapter,
			makeMockShell(),
		);

		await blueprint.run(makeNode("GEO-42"), "/project", makeContext());

		expect(fetchIssue).toHaveBeenCalledWith("GEO-42");
	});

	// ─── Git baseline ───────────────────────────────

	it("captures git baseline after preflight", async () => {
		const gitChecker = makeMockGitChecker();
		const blueprint = new Blueprint(
			makeHydrator(),
			gitChecker,
			() => makeMockAdapter(),
			makeMockShell(),
		);

		await blueprint.run(makeNode(), "/project", makeContext());

		expect(gitChecker.captureBaseline).toHaveBeenCalledWith("/project");
	});

	// ─── Prompt construction ────────────────────────

	it("builds prompt with issueId + title + description", async () => {
		const adapter = makeMockAdapter();
		const blueprint = new Blueprint(
			makeHydrator(),
			makeMockGitChecker(),
			() => adapter,
			makeMockShell(),
		);

		await blueprint.run(makeNode("GEO-101"), "/project", makeContext());

		const execCall = (adapter.execute as ReturnType<typeof vi.fn>).mock
			.calls[0]![0] as AdapterExecutionContext;
		expect(execCall.prompt).toContain("GEO-101");
		expect(execCall.prompt).toContain("Issue GEO-101 title");
		expect(execCall.prompt).toContain("Description for GEO-101");
	});

	it("system prompt includes branch/commit/push/PR/CI instructions", async () => {
		const adapter = makeMockAdapter();
		const blueprint = new Blueprint(
			makeHydrator(),
			makeMockGitChecker(),
			() => adapter,
			makeMockShell(),
		);

		await blueprint.run(makeNode(), "/project", makeContext());

		const execCall = (adapter.execute as ReturnType<typeof vi.fn>).mock
			.calls[0]![0] as AdapterExecutionContext;
		expect(execCall.appendSystemPrompt).toContain("commit");
		expect(execCall.appendSystemPrompt).toContain("Push");
		expect(execCall.appendSystemPrompt).toContain("GitHub PR");
	});

	// ─── Adapter args ────────────────────────────────

	it("passes bypassPermissions and label to adapter", async () => {
		const adapter = makeMockAdapter();
		const blueprint = new Blueprint(
			makeHydrator(),
			makeMockGitChecker(),
			() => adapter,
			makeMockShell(),
		);

		await blueprint.run(makeNode("GEO-101"), "/project", makeContext());

		const execCall = (adapter.execute as ReturnType<typeof vi.fn>).mock
			.calls[0]![0] as AdapterExecutionContext;
		expect(execCall.permissionMode).toBe("bypassPermissions");
		expect(execCall.label).toBe("GEO-101-claude-Issue GEO-101 title");
		expect(execCall.sessionDisplayName).toBe("GEO-101 Issue GEO-101 title");
		expect(execCall.cwd).toBe("/project");
	});

	// ─── Success / failure ──────────────────────────

	it("returns success when git has new commits (commitCount > 0)", async () => {
		const blueprint = new Blueprint(
			makeHydrator(),
			makeMockGitChecker({ commitCount: 2 }),
			() => makeMockAdapter(),
			makeMockShell(),
		);

		const result = await blueprint.run(makeNode(), "/project", makeContext());

		expect(result.success).toBe(true);
	});

	it("returns failure when no commits", async () => {
		const blueprint = new Blueprint(
			makeHydrator(),
			makeMockGitChecker({ commitCount: 0 }),
			() => makeMockAdapter(),
			makeMockShell(),
		);

		const result = await blueprint.run(makeNode(), "/project", makeContext());

		expect(result.success).toBe(false);
	});

	// ─── Adapter exceptions ──────────────────────────

	it("catches adapter exceptions → returns { success: false, error }", async () => {
		const blueprint = new Blueprint(
			makeHydrator(),
			makeMockGitChecker(),
			() => makeThrowingAdapter(new Error("tmux not installed")),
			makeMockShell(),
		);

		const result = await blueprint.run(makeNode(), "/project", makeContext());

		expect(result.success).toBe(false);
		expect(result.error).toBe("tmux not installed");
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});

	// ─── Window lifecycle ───────────────────────────

	it("kills tmux window on success", async () => {
		const shell = makeMockShell();
		const blueprint = new Blueprint(
			makeHydrator(),
			makeMockGitChecker({ commitCount: 1 }),
			() => makeMockAdapter({ tmuxWindow: "flywheel:@42" }),
			shell,
		);

		await blueprint.run(makeNode(), "/project", makeContext());

		const shellCalls = (shell.execFile as ReturnType<typeof vi.fn>).mock.calls;
		const killCalls = shellCalls.filter(
			(c: [string, string[], string]) =>
				c[0] === "tmux" && c[1][0] === "kill-window",
		);
		expect(killCalls).toHaveLength(1);
		expect(killCalls[0]![1]).toContain("flywheel:@42");
	});

	it("preserves tmux window on failure", async () => {
		const shell = makeMockShell();
		const blueprint = new Blueprint(
			makeHydrator(),
			makeMockGitChecker({ commitCount: 0 }),
			() => makeMockAdapter({ tmuxWindow: "flywheel:@42" }),
			shell,
		);

		await blueprint.run(makeNode(), "/project", makeContext());

		const shellCalls = (shell.execFile as ReturnType<typeof vi.fn>).mock.calls;
		const killCalls = shellCalls.filter(
			(c: [string, string[], string]) =>
				c[0] === "tmux" && c[1][0] === "kill-window",
		);
		expect(killCalls).toHaveLength(0);
	});

	it("returns tmuxWindow only for failed sessions", async () => {
		// Success: no tmuxWindow in result
		const successBlueprint = new Blueprint(
			makeHydrator(),
			makeMockGitChecker({ commitCount: 1 }),
			() => makeMockAdapter({ tmuxWindow: "flywheel:@42" }),
			makeMockShell(),
		);
		const successResult = await successBlueprint.run(
			makeNode(),
			"/project",
			makeContext(),
		);
		expect(successResult.tmuxWindow).toBeUndefined();

		// Failure: tmuxWindow preserved
		const failBlueprint = new Blueprint(
			makeHydrator(),
			makeMockGitChecker({ commitCount: 0 }),
			() => makeMockAdapter({ tmuxWindow: "flywheel:@42" }),
			makeMockShell(),
		);
		const failResult = await failBlueprint.run(
			makeNode(),
			"/project",
			makeContext(),
		);
		expect(failResult.tmuxWindow).toBe("flywheel:@42");
	});

	// ─── Timeout behavior ──────────────────────────

	it("treats timeout as failure even when commits exist (Phase 1 serial safety)", async () => {
		const shell = makeMockShell();
		const blueprint = new Blueprint(
			makeHydrator(),
			makeMockGitChecker({ commitCount: 2 }),
			() => makeMockAdapter({ tmuxWindow: "flywheel:@42", timedOut: true }),
			shell,
		);

		const result = await blueprint.run(makeNode(), "/project", makeContext());

		// Timeout = failure — session may still be running, unsafe to dispatch next issue
		expect(result.success).toBe(false);
		expect(result.tmuxWindow).toBe("flywheel:@42");

		// Should NOT have killed the window (session may still be running)
		const shellCalls = (shell.execFile as ReturnType<typeof vi.fn>).mock.calls;
		const killCalls = shellCalls.filter(
			(c: [string, string[], string]) =>
				c[0] === "tmux" && c[1][0] === "kill-window",
		);
		expect(killCalls).toHaveLength(0);
	});

	it("kills tmux window only when success AND not timed out", async () => {
		const shell = makeMockShell();
		const blueprint = new Blueprint(
			makeHydrator(),
			makeMockGitChecker({ commitCount: 1 }),
			() => makeMockAdapter({ tmuxWindow: "flywheel:@42", timedOut: false }),
			shell,
		);

		const result = await blueprint.run(makeNode(), "/project", makeContext());

		expect(result.success).toBe(true);
		expect(result.tmuxWindow).toBeUndefined();

		const shellCalls = (shell.execFile as ReturnType<typeof vi.fn>).mock.calls;
		const killCalls = shellCalls.filter(
			(c: [string, string[], string]) =>
				c[0] === "tmux" && c[1][0] === "kill-window",
		);
		expect(killCalls).toHaveLength(1);
	});

	// ─── GEO-206: Lead ↔ Runner communication prompt ──

	it("injects flywheel-comm ask instructions when leadId is set", async () => {
		const adapter = makeMockAdapter();
		const blueprint = new Blueprint(
			makeHydrator(),
			makeMockGitChecker(),
			() => adapter,
			makeMockShell(),
		);

		await blueprint.run(
			makeNode(),
			"/project",
			makeContext({ leadId: "product-lead", projectName: "geoforge3d" }),
		);

		const execCall = (adapter.execute as ReturnType<typeof vi.fn>).mock
			.calls[0]![0] as AdapterExecutionContext;
		expect(execCall.appendSystemPrompt).toContain("flywheel-comm");
		expect(execCall.appendSystemPrompt).toContain("product-lead");
		expect(execCall.appendSystemPrompt).toContain("ask");
		expect(execCall.appendSystemPrompt).toContain("check");
		expect(execCall.appendSystemPrompt).not.toContain("Do not ask questions");
	});

	it("keeps 'Do not ask questions' when leadId is not set", async () => {
		const adapter = makeMockAdapter();
		const blueprint = new Blueprint(
			makeHydrator(),
			makeMockGitChecker(),
			() => adapter,
			makeMockShell(),
		);

		await blueprint.run(makeNode(), "/project", makeContext());

		const execCall = (adapter.execute as ReturnType<typeof vi.fn>).mock
			.calls[0]![0] as AdapterExecutionContext;
		expect(execCall.appendSystemPrompt).toContain("Do not ask questions");
		expect(execCall.appendSystemPrompt).not.toContain("flywheel-comm");
	});

	it("passes commDbPath to adapter when leadId + projectName set", async () => {
		const adapter = makeMockAdapter();
		const blueprint = new Blueprint(
			makeHydrator(),
			makeMockGitChecker(),
			() => adapter,
			makeMockShell(),
		);

		await blueprint.run(
			makeNode(),
			"/project",
			makeContext({ leadId: "product-lead", projectName: "geoforge3d" }),
		);

		const execCall = (adapter.execute as ReturnType<typeof vi.fn>).mock
			.calls[0]![0] as AdapterExecutionContext;
		expect(execCall.commDbPath).toContain(".flywheel/comm/geoforge3d/comm.db");
	});

	it("does not pass commDbPath when leadId is not set", async () => {
		const adapter = makeMockAdapter();
		const blueprint = new Blueprint(
			makeHydrator(),
			makeMockGitChecker(),
			() => adapter,
			makeMockShell(),
		);

		await blueprint.run(makeNode(), "/project", makeContext());

		const execCall = (adapter.execute as ReturnType<typeof vi.fn>).mock
			.calls[0]![0] as AdapterExecutionContext;
		expect(execCall.commDbPath).toBeUndefined();
	});

	// ─── GEO-261: emitTerminal await tests ──────────

	describe("emitTerminal (GEO-261)", () => {
		function makeStubEmitter(
			overrides: Partial<ExecutionEventEmitter> = {},
		): ExecutionEventEmitter {
			return {
				emitStarted: vi.fn(async () => {}),
				emitCompleted: vi.fn(async () => {}),
				emitFailed: vi.fn(async () => {}),
				emitHeartbeat: vi.fn(async () => {}),
				flush: vi.fn(async () => {}),
				...overrides,
			};
		}

		it("awaits emitCompleted on success path", async () => {
			const order: string[] = [];
			const emitter = makeStubEmitter({
				emitCompleted: vi.fn(async () => {
					// Simulate slow HTTP with retry
					await new Promise((r) => setTimeout(r, 50));
					order.push("emitCompleted-done");
				}),
			});

			const blueprint = new Blueprint(
				makeHydrator(),
				makeMockGitChecker({ commitCount: 1 }),
				() => makeMockAdapter(),
				makeMockShell(),
				undefined, // worktreeManager
				undefined, // skillInjector
				undefined, // evidenceCollector
				undefined, // skillsConfig
				undefined, // decisionLayer
				emitter,
			);

			await blueprint.run(makeNode(), "/project", makeContext());
			order.push("run-done");

			// emitCompleted must finish BEFORE run() returns
			expect(order).toEqual(["emitCompleted-done", "run-done"]);
			expect(emitter.emitCompleted).toHaveBeenCalledTimes(1);
		});

		it("awaits emitFailed on failure path", async () => {
			const order: string[] = [];
			const emitter = makeStubEmitter({
				emitFailed: vi.fn(async () => {
					await new Promise((r) => setTimeout(r, 50));
					order.push("emitFailed-done");
				}),
			});

			const blueprint = new Blueprint(
				makeHydrator(),
				makeMockGitChecker({ commitCount: 0 }),
				() => makeMockAdapter(),
				makeMockShell(),
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				emitter,
			);

			await blueprint.run(makeNode(), "/project", makeContext());
			order.push("run-done");

			expect(order).toEqual(["emitFailed-done", "run-done"]);
			expect(emitter.emitFailed).toHaveBeenCalledTimes(1);
		});

		it("handles emitter exception defensively", async () => {
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

			const emitter = makeStubEmitter({
				emitFailed: vi.fn(async () => {
					throw new Error("network explosion");
				}),
			});

			const blueprint = new Blueprint(
				makeHydrator(),
				makeMockGitChecker({ commitCount: 0 }),
				() => makeMockAdapter(),
				makeMockShell(),
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				emitter,
			);

			// Should NOT throw despite emitter failure
			const result = await blueprint.run(makeNode(), "/project", makeContext());
			expect(result.success).toBe(false);
			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining("emitTerminal failed"),
			);

			errorSpy.mockRestore();
		});
	});
});
