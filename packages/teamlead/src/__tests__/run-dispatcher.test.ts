/**
 * FLY-22: RunDispatcher unit tests.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ProjectRuntime,
	RetryDispatcher,
	RunDispatcher,
} from "../bridge/run-dispatcher.js";
import { RunnerAdmissionController } from "../bridge/runner-admission.js";

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
		const dispatcher = new RunDispatcher(
			runtimes,
			[],
			RunnerAdmissionController.alwaysAdmit(),
		);

		const result = await dispatcher.start({
			issueId: "GEO-1",
			projectName: "TestProject",
		});

		expect(result.executionId).toBeDefined();
		expect(result.issueId).toBe("GEO-1");
	});

	it("start() rejects when shutting down", async () => {
		const runtimes = new Map([makeRuntime("TestProject")]);
		const dispatcher = new RunDispatcher(
			runtimes,
			[],
			RunnerAdmissionController.alwaysAdmit(),
		);
		dispatcher.stopAccepting();

		await expect(
			dispatcher.start({ issueId: "GEO-1", projectName: "TestProject" }),
		).rejects.toThrow("shutting down");
	});

	it("FLY-123 WS-D (P4): start() defers under resource pressure (not a count cap)", async () => {
		const runtimes = new Map([makeRuntime("TestProject")]);
		// Admission controller under load → defers regardless of count.
		const dispatcher = new RunDispatcher(
			runtimes,
			[],
			RunnerAdmissionController.alwaysDefer(),
		);

		// Even the FIRST start is deferred when the box is under pressure —
		// admission is resource-based, not count-based. Typed error (R1 #4) so
		// the route maps it to 429, not 500.
		await expect(
			dispatcher.start({ issueId: "GEO-1", projectName: "TestProject" }),
		).rejects.toMatchObject({
			name: "AdmissionDeferredError",
			reason: "load_pressure",
		});
	});

	it("start() rejects duplicate issue", async () => {
		const runtimes = new Map([makeRuntime("TestProject")]);
		const dispatcher = new RunDispatcher(
			runtimes,
			[],
			RunnerAdmissionController.alwaysAdmit(),
		);

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
		const dispatcher = new RunDispatcher(
			runtimes,
			[],
			RunnerAdmissionController.alwaysAdmit(),
		);

		await expect(
			dispatcher.start({ issueId: "GEO-1", projectName: "NoSuchProject" }),
		).rejects.toThrow("No runtime for project");
	});

	it("getInflightCount() tracks inflight runs", async () => {
		const runtimes = new Map([makeRuntime("TestProject")]);
		const dispatcher = new RunDispatcher(
			runtimes,
			[],
			RunnerAdmissionController.alwaysAdmit(),
		);

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
		const dispatcher = new RunDispatcher(
			runtimes,
			[],
			RunnerAdmissionController.alwaysAdmit(),
		);

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
		const dispatcher = new RunDispatcher(
			runtimes,
			[],
			RunnerAdmissionController.alwaysAdmit(),
		);

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
		const dispatcher = new RunDispatcher(
			runtimes,
			[],
			RunnerAdmissionController.alwaysAdmit(),
		);

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
		const dispatcher = new RunDispatcher(
			runtimes,
			[],
			RunnerAdmissionController.alwaysAdmit(),
		);

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
		const dispatcher = new RunDispatcher(
			runtimes,
			[],
			RunnerAdmissionController.alwaysAdmit(),
		);

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

	// ══════════════════════════════════════════════════════════════════════
	// FLY-142 PR 1.4 — Agent Team identity wiring
	//
	// QA E1 verify (2026-05-12) found Bug #4: PR #178 added TmuxAdapter
	// transport branch, PR #181 PR #181 added MailboxLeadRuntime — but the
	// dispatch flow NEVER set the agentName/agentTeamName/vendor fields the
	// transport branch requires. claude-code never entered Agent Team mode,
	// `useInboxPoller` never ran, mailbox writes silently landed in a file
	// no one read. These tests pin the wiring so the wake bug fix actually
	// connects end-to-end.
	// ══════════════════════════════════════════════════════════════════════

	describe("FLY-142 PR 1.4 — Agent Team identity in spawn ctx", () => {
		const ORIGINAL_BACKEND = process.env.FLYWHEEL_COMM_BACKEND;
		afterEach(() => {
			if (ORIGINAL_BACKEND === undefined)
				delete process.env.FLYWHEEL_COMM_BACKEND;
			else process.env.FLYWHEEL_COMM_BACKEND = ORIGINAL_BACKEND;
		});

		it("start() under mailbox backend passes agentName/agentTeamName/vendor to Blueprint", async () => {
			process.env.FLYWHEEL_COMM_BACKEND = "mailbox";
			const blueprint = { run: vi.fn().mockResolvedValue({ success: true }) };
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
			const dispatcher = new RunDispatcher(
				runtimes,
				[],
				RunnerAdmissionController.alwaysAdmit(),
			);

			const result = await dispatcher.start({
				issueId: "GEO-1",
				projectName: "TestProject",
				leadId: "flywheel-test-2",
			});

			// Allow microtasks to drain
			await new Promise((r) => setImmediate(r));
			// blueprint.run signature: (taskNode, projectRoot, ctx) — ctx is arg #2.
			const ctx = blueprint.run.mock.calls[0]?.[2];
			expect(ctx).toBeDefined();
			expect(ctx.vendor).toBe("claude-code");
			expect(ctx.agentTeamName).toBe("flywheel-test-2");
			// FLY-142 transport identity — distinct from FLY-137's
			// `ctx.agentName` (Lead-override dispatcher key).
			expect(ctx.runnerAgentName).toBe(
				`runner-${result.executionId.slice(0, 8)}`,
			);
		});

		it("start() under commdb rollback backend omits Agent Team fields", async () => {
			process.env.FLYWHEEL_COMM_BACKEND = "commdb";
			const blueprint = { run: vi.fn().mockResolvedValue({ success: true }) };
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
			const dispatcher = new RunDispatcher(
				runtimes,
				[],
				RunnerAdmissionController.alwaysAdmit(),
			);

			await dispatcher.start({
				issueId: "GEO-1",
				projectName: "TestProject",
				leadId: "flywheel-test-2",
			});

			await new Promise((r) => setImmediate(r));
			// blueprint.run signature: (taskNode, projectRoot, ctx) — ctx is arg #2.
			const ctx = blueprint.run.mock.calls[0]?.[2];
			expect(ctx).toBeDefined();
			// Transport wiring stays off on rollback — Agent Team fields absent.
			expect(ctx.runnerAgentName).toBeUndefined();
			expect(ctx.agentTeamName).toBeUndefined();
			expect(ctx.vendor).toBeUndefined();
		});

		it("start() omits Agent Team fields when leadId is missing (defensive)", async () => {
			process.env.FLYWHEEL_COMM_BACKEND = "mailbox";
			const blueprint = { run: vi.fn().mockResolvedValue({ success: true }) };
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
			const dispatcher = new RunDispatcher(
				runtimes,
				[],
				RunnerAdmissionController.alwaysAdmit(),
			);

			await dispatcher.start({
				issueId: "GEO-1",
				projectName: "TestProject",
				// no leadId — shouldn't happen on hot path but guard for safety
			});

			await new Promise((r) => setImmediate(r));
			// blueprint.run signature: (taskNode, projectRoot, ctx) — ctx is arg #2.
			const ctx = blueprint.run.mock.calls[0]?.[2];
			expect(ctx).toBeDefined();
			expect(ctx.runnerAgentName).toBeUndefined();
			expect(ctx.agentTeamName).toBeUndefined();
			expect(ctx.vendor).toBeUndefined();
		});
	});
});
