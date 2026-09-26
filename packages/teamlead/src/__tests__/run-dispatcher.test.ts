/**
 * FLY-22: RunDispatcher unit tests.
 */

import { buildWindowLabel } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ProjectRuntime,
	preRegistrationVendor,
	RetryDispatcher,
	RunDispatcher,
	runnerDisplayName,
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
	it("FLY-1244 admits durable QA before spawn and passes its scoped credential", async () => {
		const [name, runtime] = makeRuntime("TestProject");
		const shadow = {
			onSpawnDispatch: vi.fn(),
			onDispatchFailed: vi.fn(),
		};
		const admission = {
			admit: vi.fn().mockReturnValue({ credential: "qa-credential" }),
		};
		const dispatcher = new RunDispatcher(
			new Map([[name, runtime]]),
			[],
			RunnerAdmissionController.alwaysAdmit(),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			shadow,
			admission,
		);

		const result = await dispatcher.start({
			issueId: "FLY-1244",
			projectName: "TestProject",
			sessionRole: "qa",
			shareParentBranch: true,
			shadowContext: { node: "qa", attempt: 2 },
		});

		expect(admission.admit).toHaveBeenCalledWith({
			projectName: "TestProject",
			issueId: "FLY-1244",
			executionId: result.executionId,
			node: "qa",
			attempt: 2,
		});
		const run = (
			runtime.blueprint as unknown as { run: ReturnType<typeof vi.fn> }
		).run;
		expect(run.mock.calls[0]?.[2]).toMatchObject({
			workflowSubmissionCredential: "qa-credential",
		});
	});

	it("FLY-1244 fails closed before Blueprint when durable QA admission fails", async () => {
		const [name, runtime] = makeRuntime("TestProject");
		const dispatcher = new RunDispatcher(
			new Map([[name, runtime]]),
			[],
			RunnerAdmissionController.alwaysAdmit(),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ onSpawnDispatch: vi.fn(), onDispatchFailed: vi.fn() },
			{
				admit: vi.fn(() => {
					throw new Error("binding conflict");
				}),
			},
		);

		await expect(
			dispatcher.start({
				issueId: "FLY-1244",
				projectName: "TestProject",
				sessionRole: "qa",
				shareParentBranch: true,
				shadowContext: { node: "qa", attempt: 1 },
			}),
		).rejects.toThrow("workflow claims admission failed");
		expect(
			(runtime.blueprint as unknown as { run: ReturnType<typeof vi.fn> }).run,
		).not.toHaveBeenCalled();
		expect(dispatcher.getInflightCount()).toBe(0);
	});

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

// ── FLY-751: runner MCP slim profile wiring (start + retry) ──────────────

describe("FLY-751: runnerMcpProfile wiring", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	// FLY-812 (founder review 2026-07-03): chrome defaults ON and the default
	// slim is serena ONLY (discord + playwright kept fleet-wide for
	// runner/geoforge3d testing). disableChrome:false unless the runner opts out.
	// FLY-1185 §2.7: profiles carry the positive playwright opt-in channel.
	const DEFAULT_PROFILE = {
		disabledPlugins: ["serena@claude-plugins-official"],
		disableChrome: false,
		enabledPluginsExtra: [],
	};

	function startWith(req: Record<string, unknown>) {
		const [name, runtime] = makeRuntime("TestProject");
		const runtimes = new Map([[name, runtime]]);
		const dispatcher = new RunDispatcher(
			runtimes,
			[],
			RunnerAdmissionController.alwaysAdmit(),
		);
		return {
			dispatcher,
			runtime,
			start: () =>
				dispatcher.start({
					issueId: "FLY-751",
					projectName: "TestProject",
					...req,
				}),
		};
	}

	function ctxOf(runtime: ProjectRuntime) {
		const run = (
			runtime.blueprint as unknown as { run: ReturnType<typeof vi.fn> }
		).run;
		expect(run).toHaveBeenCalledOnce();
		return run.mock.calls[0][2];
	}

	it("start(): default claude-tmux run gets the plugin slim, chrome on", async () => {
		const { runtime, start } = startWith({});
		await start();
		expect(ctxOf(runtime).runnerMcpProfile).toEqual(DEFAULT_PROFILE);
	});

	it("start(): no-chrome label flows through → serena slimmed + chrome off", async () => {
		const { runtime, start } = startWith({ issueLabels: ["no-chrome"] });
		await start();
		expect(ctxOf(runtime).runnerMcpProfile).toEqual({
			disabledPlugins: ["serena@claude-plugins-official"],
			disableChrome: true,
			enabledPluginsExtra: [],
		});
	});

	it("start(): QA run gets the serena-only slim, chrome on, playwright opt-in", async () => {
		const { runtime, start } = startWith({ sessionRole: "qa" });
		await start();
		expect(ctxOf(runtime).runnerMcpProfile).toEqual({
			...DEFAULT_PROFILE,
			enabledPluginsExtra: ["playwright@claude-plugins-official"],
		});
	});

	// FLY-1185 §2.7: full-mcp no longer degenerates to null — with the machine
	// default-off in place, "everything available" carries the positive
	// playwright entry (or the machine default would silently win).
	it("start(): full-mcp label → no slim + playwright opt-in survives", async () => {
		const { runtime, start } = startWith({ issueLabels: ["full-mcp"] });
		await start();
		expect(ctxOf(runtime).runnerMcpProfile).toEqual({
			disabledPlugins: [],
			disableChrome: false,
			enabledPluginsExtra: ["playwright@claude-plugins-official"],
		});
	});

	it("start(): FLYWHEEL_RUNNER_SLIM_MCP=0 kill-switch (profile null)", async () => {
		vi.stubEnv("FLYWHEEL_RUNNER_SLIM_MCP", "0");
		const { runtime, start } = startWith({});
		await start();
		expect(ctxOf(runtime).runnerMcpProfile).toBeNull();
	});

	it("start(): non-claude backend gets NO profile field at all", async () => {
		const { runtime, start } = startWith({ issueLabels: ["codex"] });
		await start();
		const ctx = ctxOf(runtime);
		expect(ctx.runnerBackend).toBe("codex-tmux");
		expect("runnerMcpProfile" in ctx).toBe(false);
	});

	it("retry: profile recomputed (QA retry gets the serena-only slim)", async () => {
		const [name, runtime] = makeRuntime("TestProject");
		const runtimes = new Map([[name, runtime]]);
		const dispatcher = new RetryDispatcher(runtimes, []);
		await dispatcher.dispatch({
			oldExecutionId: "old-exec",
			issueId: "FLY-751",
			projectName: "TestProject",
			runAttempt: 1,
			sessionRole: "qa",
		});
		expect(ctxOf(runtime).runnerMcpProfile).toEqual({
			...DEFAULT_PROFILE,
			enabledPluginsExtra: ["playwright@claude-plugins-official"],
		});
	});

	it("retry: default run gets the full slim profile", async () => {
		const [name, runtime] = makeRuntime("TestProject");
		const runtimes = new Map([[name, runtime]]);
		const dispatcher = new RetryDispatcher(runtimes, []);
		await dispatcher.dispatch({
			oldExecutionId: "old-exec",
			issueId: "FLY-751",
			projectName: "TestProject",
			runAttempt: 1,
		});
		expect(ctxOf(runtime).runnerMcpProfile).toEqual(DEFAULT_PROFILE);
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

describe("runnerDisplayName + cmux window label (FLY-793 phase visibility)", () => {
	// A three-stage phase runner is (shareParentBranch === true) AND a phase role.
	it("maps a three-stage phase role (shareParentBranch=true) to its phase name", () => {
		expect(runnerDisplayName("design", true)).toBe("design");
		expect(runnerDisplayName("implement", true)).toBe("implement");
		expect(runnerDisplayName("qa", true)).toBe("qa");
	});

	it("byte-compat: non-phase (main / undefined / unknown) stays 'claude'", () => {
		expect(runnerDisplayName("main", true)).toBe("claude");
		expect(runnerDisplayName(undefined, true)).toBe("claude");
		expect(runnerDisplayName("something-else", true)).toBe("claude");
	});

	it("byte-compat: FLY-579 Auto-QA (role='qa' but NO shareParentBranch) stays 'claude'", () => {
		// The Codex R2 regression: Auto-QA shares sessionRole "qa" but is not a
		// three-stage phase (no shareParentBranch), so it must NOT flip to "-qa-".
		expect(runnerDisplayName("qa", false)).toBe("claude");
		expect(runnerDisplayName("qa", undefined)).toBe("claude");
		// A phase role without the three-stage marker is likewise unchanged.
		expect(runnerDisplayName("design", false)).toBe("claude");
		expect(runnerDisplayName("implement", undefined)).toBe("claude");
	});

	it("cmux visibility: the window label carries the phase per-phase, not 'claude'", () => {
		// buildWindowLabel = `{issueId}-{runner}-{cleanTitle}`. Feeding it the
		// phase-aware runner name is what makes cmux show the live phase.
		const title = "three-stage pipeline";
		expect(
			buildWindowLabel("FLY-793", runnerDisplayName("design", true), title),
		).toBe("FLY-793-design-three-stage pipeline");
		expect(
			buildWindowLabel("FLY-793", runnerDisplayName("implement", true), title),
		).toBe("FLY-793-implement-three-stage pipeline");
		expect(
			buildWindowLabel("FLY-793", runnerDisplayName("qa", true), title),
		).toBe("FLY-793-qa-three-stage pipeline");
		// A non-phase (main) run is unchanged — still shows 'claude'.
		expect(
			buildWindowLabel("FLY-800", runnerDisplayName("main", true), title),
		).toBe("FLY-800-claude-three-stage pipeline");
		// Auto-QA (qa role, no shareParentBranch) is unchanged — still 'claude'.
		expect(
			buildWindowLabel("FLY-801", runnerDisplayName("qa", false), title),
		).toBe("FLY-801-claude-three-stage pipeline");
	});
});

// ══════════════════════════════════════════════════════════════════════
// FLY-1188 — CommDB pre-registration carries the resolved transport vendor
// (Codex M1 review MEDIUM-1): a Lead `send` between start() returning and
// the adapter's self-registration must already route to the right mailbox.
// FLYWHEEL_COMM_DIR is redirected so nothing touches the live comm.db.
// ══════════════════════════════════════════════════════════════════════

describe("FLY-1188: pre-registration vendor", () => {
	const ORIGINAL_BACKEND = process.env.FLYWHEEL_COMM_BACKEND;
	const ORIGINAL_COMM_DIR = process.env.FLYWHEEL_COMM_DIR;
	let commDir: string;

	beforeEach(async () => {
		const { mkdtempSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		commDir = mkdtempSync(join(tmpdir(), "fly1188-prereg-"));
		process.env.FLYWHEEL_COMM_DIR = commDir;
		process.env.FLYWHEEL_COMM_BACKEND = "mailbox";
	});
	afterEach(async () => {
		const { rmSync } = await import("node:fs");
		rmSync(commDir, { recursive: true, force: true });
		if (ORIGINAL_BACKEND === undefined)
			delete process.env.FLYWHEEL_COMM_BACKEND;
		else process.env.FLYWHEEL_COMM_BACKEND = ORIGINAL_BACKEND;
		if (ORIGINAL_COMM_DIR === undefined) delete process.env.FLYWHEEL_COMM_DIR;
		else process.env.FLYWHEEL_COMM_DIR = ORIGINAL_COMM_DIR;
	});

	async function startAndReadVendor(issueLabels?: string[]) {
		const blueprint = { run: vi.fn().mockResolvedValue({ success: true }) };
		const runtimes = new Map<string, ProjectRuntime>([
			[
				"PreRegProj",
				{
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					blueprint: blueprint as any,
					projectRoot: "/tmp/prereg",
					tmuxSessionName: "runner-prereg",
				},
			],
		]);
		const dispatcher = new RunDispatcher(
			runtimes,
			[],
			RunnerAdmissionController.alwaysAdmit(),
		);
		const result = await dispatcher.start({
			issueId: "FLY-1188",
			projectName: "PreRegProj",
			leadId: "flywheel-eng-lead",
			issueLabels,
		});
		const { CommDB } = await import("flywheel-comm/db");
		const { join } = await import("node:path");
		const db = new CommDB(join(commDir, "PreRegProj", "comm.db"));
		const session = db.getSession(result.executionId);
		db.close();
		return session;
	}

	it("codex label → pending row already carries vendor=codex", async () => {
		const session = await startAndReadVendor(["codex"]);
		expect(session?.tmux_window).toContain(":pending");
		expect(session?.vendor).toBe("codex");
	});

	it("default claude → pending row carries vendor=claude-code", async () => {
		const session = await startAndReadVendor();
		expect(session?.vendor).toBe("claude-code");
	});

	it('no-transport backend (antigravity) → pending row carries vendor="none"', async () => {
		const session = await startAndReadVendor(["antigravity"]);
		expect(session?.vendor).toBe("none");
	});

	it("commdb rollback backend → vendor NULL (legacy env fallback preserved)", async () => {
		process.env.FLYWHEEL_COMM_BACKEND = "commdb";
		const session = await startAndReadVendor(["codex"]);
		expect(session?.vendor).toBeNull();
	});
});

describe("FLY-1188: preRegistrationVendor()", () => {
	it("maps transport mode / vendor to the pre-registration value", () => {
		expect(preRegistrationVendor({ runnerTransportMode: "none" })).toBe("none");
		expect(preRegistrationVendor({ vendor: "codex" })).toBe("codex");
		expect(preRegistrationVendor({ vendor: "claude-code" })).toBe(
			"claude-code",
		);
		expect(preRegistrationVendor({})).toBeUndefined();
	});
});
