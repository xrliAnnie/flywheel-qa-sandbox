/**
 * FLY-22: RunDispatcher unit tests.
 */

import { describe, expect, it, vi } from "vitest";
import {
	type ProjectRuntime,
	RetryDispatcher,
	RunDispatcher,
} from "../bridge/run-dispatcher.js";

// Mock flywheel-core openTmuxViewer (no-op in tests)
vi.mock("flywheel-core", async (importOriginal) => {
	const mod = (await importOriginal()) as Record<string, unknown>;
	return { ...mod, openTmuxViewer: vi.fn() };
});

function mockBlueprint() {
	return {
		run: vi.fn().mockResolvedValue({ success: true }),
	};
}

function makeRuntime(projectName: string): [string, ProjectRuntime] {
	return [
		projectName,
		{
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			blueprint: mockBlueprint() as any,
			projectRoot: `/tmp/${projectName}`,
			tmuxSessionName: `runner-${projectName}`,
		},
	];
}

describe("RunDispatcher", () => {
	it("start() returns executionId and issueId", async () => {
		const runtimes = new Map([makeRuntime("TestProject")]);
		const dispatcher = new RunDispatcher(runtimes, [], 3);

		const result = await dispatcher.start({
			issueId: "GEO-1",
			projectName: "TestProject",
		});

		expect(result.executionId).toBeDefined();
		expect(result.issueId).toBe("GEO-1");
	});

	it("start() rejects when shutting down", async () => {
		const runtimes = new Map([makeRuntime("TestProject")]);
		const dispatcher = new RunDispatcher(runtimes, [], 3);
		dispatcher.stopAccepting();

		await expect(
			dispatcher.start({ issueId: "GEO-1", projectName: "TestProject" }),
		).rejects.toThrow("shutting down");
	});

	it("start() rejects when max concurrent reached", async () => {
		const runtimes = new Map([makeRuntime("TestProject")]);
		const dispatcher = new RunDispatcher(runtimes, [], 1);

		// First start succeeds
		await dispatcher.start({
			issueId: "GEO-1",
			projectName: "TestProject",
		});

		// Second should fail (max=1)
		await expect(
			dispatcher.start({ issueId: "GEO-2", projectName: "TestProject" }),
		).rejects.toThrow("Max concurrent runners");
	});

	it("start() rejects duplicate issue", async () => {
		const runtimes = new Map([makeRuntime("TestProject")]);
		const dispatcher = new RunDispatcher(runtimes, [], 3);

		await dispatcher.start({
			issueId: "GEO-1",
			projectName: "TestProject",
		});

		await expect(
			dispatcher.start({ issueId: "GEO-1", projectName: "TestProject" }),
		).rejects.toThrow("already in progress");
	});

	it("start() rejects unknown project", async () => {
		const runtimes = new Map([makeRuntime("TestProject")]);
		const dispatcher = new RunDispatcher(runtimes, [], 3);

		await expect(
			dispatcher.start({ issueId: "GEO-1", projectName: "NoSuchProject" }),
		).rejects.toThrow("No runtime for project");
	});

	it("getInflightCount() tracks inflight runs", async () => {
		const runtimes = new Map([makeRuntime("TestProject")]);
		const dispatcher = new RunDispatcher(runtimes, [], 3);

		expect(dispatcher.getInflightCount()).toBe(0);

		await dispatcher.start({
			issueId: "GEO-1",
			projectName: "TestProject",
		});
		expect(dispatcher.getInflightCount()).toBe(1);
	});

	it("inflight clears after blueprint.run() completes", async () => {
		let resolveRun!: () => void;
		const blueprint = {
			run: vi.fn(
				() =>
					new Promise<{ success: boolean }>((resolve) => {
						resolveRun = () => resolve({ success: true });
					}),
			),
		};
		const runtimes = new Map<string, ProjectRuntime>([
			[
				"TestProject",
				{
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					blueprint: blueprint as any,
					projectRoot: "/tmp/test",
					tmuxSessionName: "runner-test",
				},
			],
		]);
		const dispatcher = new RunDispatcher(runtimes, [], 3);

		await dispatcher.start({
			issueId: "GEO-1",
			projectName: "TestProject",
		});
		expect(dispatcher.getInflightCount()).toBe(1);

		// Complete the run
		resolveRun();
		await dispatcher.drain();
		expect(dispatcher.getInflightCount()).toBe(0);
	});
});

describe("RetryDispatcher", () => {
	it("dispatch() returns old and new execution IDs", async () => {
		const runtimes = new Map([makeRuntime("TestProject")]);
		const dispatcher = new RetryDispatcher(runtimes, []);

		const result = await dispatcher.dispatch({
			oldExecutionId: "old-exec",
			issueId: "GEO-1",
			projectName: "TestProject",
			runAttempt: 1,
		});

		expect(result.oldExecutionId).toBe("old-exec");
		expect(result.newExecutionId).toBeDefined();
	});

	it("dispatch() rejects duplicate issue", async () => {
		const runtimes = new Map([makeRuntime("TestProject")]);
		const dispatcher = new RetryDispatcher(runtimes, []);

		await dispatcher.dispatch({
			oldExecutionId: "old-1",
			issueId: "GEO-1",
			projectName: "TestProject",
			runAttempt: 1,
		});

		await expect(
			dispatcher.dispatch({
				oldExecutionId: "old-2",
				issueId: "GEO-1",
				projectName: "TestProject",
				runAttempt: 2,
			}),
		).rejects.toThrow("already in progress");
	});

	it("teardownRuntimes() calls cleanup handles", async () => {
		const cleanup = vi.fn().mockResolvedValue(undefined);
		const runtimes = new Map([makeRuntime("TestProject")]);
		const dispatcher = new RetryDispatcher(runtimes, [cleanup]);

		await dispatcher.teardownRuntimes();
		expect(cleanup).toHaveBeenCalledOnce();
	});
});

// ── FLY-95: Resolved failure handling ──────────────

describe("FLY-95: Dispatcher resolved failure handling", () => {
	it("RunDispatcher.start() logs worktreePath on success", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const blueprint = {
			run: vi.fn().mockResolvedValue({
				success: true,
				worktreePath: "/tmp/wt/TestProject/test-GEO-1",
			}),
		};
		const runtimes = new Map<string, ProjectRuntime>([
			[
				"TestProject",
				{
					blueprint: blueprint as any,
					projectRoot: "/tmp/test",
					tmuxSessionName: "runner-test",
				},
			],
		]);
		const dispatcher = new RunDispatcher(runtimes, [], 3);

		await dispatcher.start({
			issueId: "GEO-1",
			projectName: "TestProject",
		});
		await dispatcher.drain();

		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining("ran in worktree"),
		);
		logSpy.mockRestore();
	});

	it("RunDispatcher.start() warns on resolved failure", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const blueprint = {
			run: vi.fn().mockResolvedValue({
				success: false,
				error: "git lock error",
			}),
		};
		const runtimes = new Map<string, ProjectRuntime>([
			[
				"TestProject",
				{
					blueprint: blueprint as any,
					projectRoot: "/tmp/test",
					tmuxSessionName: "runner-test",
				},
			],
		]);
		const dispatcher = new RunDispatcher(runtimes, [], 3);

		await dispatcher.start({
			issueId: "GEO-1",
			projectName: "TestProject",
		});
		await dispatcher.drain();

		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("resolved with failure"),
		);
		warnSpy.mockRestore();
	});

	it("RetryDispatcher.dispatch() warns on resolved failure", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const blueprint = {
			run: vi.fn().mockResolvedValue({
				success: false,
				error: "worktree create failed",
			}),
		};
		const runtimes = new Map<string, ProjectRuntime>([
			[
				"TestProject",
				{
					blueprint: blueprint as any,
					projectRoot: "/tmp/test",
					tmuxSessionName: "runner-test",
				},
			],
		]);
		const dispatcher = new RetryDispatcher(runtimes, []);

		await dispatcher.dispatch({
			oldExecutionId: "old-exec",
			issueId: "GEO-1",
			projectName: "TestProject",
			runAttempt: 1,
		});
		await dispatcher.drain();

		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("resolved with failure"),
		);
		warnSpy.mockRestore();
	});

	it("FLY-59: same issue different roles can run concurrently", async () => {
		const runtimes = new Map([makeRuntime("TestProject")]);
		const dispatcher = new RunDispatcher(runtimes, [], 5);

		// Start main role
		const r1 = await dispatcher.start({
			issueId: "GEO-1",
			projectName: "TestProject",
			sessionRole: "main",
		});
		expect(r1.executionId).toBeDefined();

		// Start qa role for same issue — should succeed
		const r2 = await dispatcher.start({
			issueId: "GEO-1",
			projectName: "TestProject",
			sessionRole: "qa",
		});
		expect(r2.executionId).toBeDefined();
		expect(r2.executionId).not.toBe(r1.executionId);
	});

	it("FLY-95: role normalization prevents worktree collision", async () => {
		// Use a controlled promise so the first start stays inflight
		let resolveRun!: (v: { success: boolean }) => void;
		const blueprint = {
			run: vi.fn(
				() =>
					new Promise<{ success: boolean }>((resolve) => {
						resolveRun = resolve;
					}),
			),
		};
		const runtimes = new Map<string, ProjectRuntime>([
			[
				"TestProject",
				{
					blueprint: blueprint as any,
					projectRoot: "/tmp/test",
					tmuxSessionName: "runner-test",
				},
			],
		]);
		const dispatcher = new RunDispatcher(runtimes, [], 5);

		// Start "qa" role — stays inflight
		await dispatcher.start({
			issueId: "GEO-1",
			projectName: "TestProject",
			sessionRole: "qa",
		});

		// "QA" normalizes to same key — should reject as duplicate
		await expect(
			dispatcher.start({
				issueId: "GEO-1",
				projectName: "TestProject",
				sessionRole: "QA",
			}),
		).rejects.toThrow("already in progress");

		// "q/a" also normalizes to "qa" — should reject
		await expect(
			dispatcher.start({
				issueId: "GEO-1",
				projectName: "TestProject",
				sessionRole: "q/a",
			}),
		).rejects.toThrow("already in progress");

		// Clean up
		resolveRun({ success: true });
		await dispatcher.drain();
	});
});
