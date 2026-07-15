import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import type { WorktreeManager } from "../WorktreeManager.js";

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

	// FLY-272: the tmux window name / cmux sidebar must show the readable Linear
	// identifier even when the Lead passed the opaque Linear issue UUID as the
	// `issueId` body field (sub's Lead does this; joycon's passes the identifier).
	// The 36-char UUID also blows the 50-char window-name budget so the issue
	// title gets truncated to a meaningless fragment — the readable identifier
	// (e.g. LEARN-70) keeps the title intact. Display naming derives from the
	// resolved identifier; keys/dedup still use the raw issueId.
	it("FLY-272: window label + display name use the hydrated identifier, not the raw UUID issueId", async () => {
		const uuid = "3b39be21-a28f-4069-8264-bd6c89346534";
		const fetchIssue = vi.fn(async () => ({
			title: "Social media affirmation pack",
			description: "desc",
			identifier: "LEARN-70",
		}));
		const adapter = makeMockAdapter();
		const blueprint = new Blueprint(
			new PreHydrator(fetchIssue),
			makeMockGitChecker(),
			() => adapter,
			makeMockShell(),
		);

		await blueprint.run(makeNode(uuid), "/project", makeContext());

		const execCall = (adapter.execute as ReturnType<typeof vi.fn>).mock
			.calls[0]![0] as AdapterExecutionContext;
		expect(execCall.label).toBe(
			"LEARN-70-claude-Social media affirmation pack",
		);
		expect(execCall.sessionDisplayName).toBe(
			"LEARN-70 Social media affirmation pack",
		);
		expect(execCall.label).not.toContain(uuid);
		expect(execCall.sessionDisplayName).not.toContain(uuid);
	});

	it("FLY-272: ctx.issueIdentifier (runs-route preflight) wins for display naming", async () => {
		const uuid = "4a3037cb-f65c-4fd3-8a0e-075cc5706eee";
		// Hydrator returns NO identifier (Linear stub fallback), but runs-route
		// already resolved the identifier and threaded it on the context.
		const fetchIssue = vi.fn(async () => ({
			title: "Packet copy",
			description: "desc",
		}));
		const adapter = makeMockAdapter();
		const blueprint = new Blueprint(
			new PreHydrator(fetchIssue),
			makeMockGitChecker(),
			() => adapter,
			makeMockShell(),
		);

		await blueprint.run(
			makeNode(uuid),
			"/project",
			makeContext({ issueIdentifier: "LEARN-72" }),
		);

		const execCall = (adapter.execute as ReturnType<typeof vi.fn>).mock
			.calls[0]![0] as AdapterExecutionContext;
		expect(execCall.label).toBe("LEARN-72-claude-Packet copy");
		expect(execCall.sessionDisplayName).toBe("LEARN-72 Packet copy");
		expect(execCall.label).not.toContain(uuid);
		expect(execCall.sessionDisplayName).not.toContain(uuid);
	});

	it("FLY-272: empty/whitespace identifier falls through to the next id, never blank (Codex R1 LOW)", async () => {
		// Defensive: `??` would have accepted an empty-string identifier and
		// produced a blank/leading-hyphen window name. `|| .trim()` skips it.
		// Here ctx.issueIdentifier is whitespace-only and the hydrator returns
		// no identifier, so naming falls all the way through to the raw issueId.
		const rawId = "GEO-555";
		const fetchIssue = vi.fn(async () => ({
			title: "Edge case",
			description: "desc",
			identifier: "   ", // Linear returned whitespace-only identifier
		}));
		const adapter = makeMockAdapter();
		const blueprint = new Blueprint(
			new PreHydrator(fetchIssue),
			makeMockGitChecker(),
			() => adapter,
			makeMockShell(),
		);

		await blueprint.run(
			makeNode(rawId),
			"/project",
			makeContext({ issueIdentifier: "  " }),
		);

		const execCall = (adapter.execute as ReturnType<typeof vi.fn>).mock
			.calls[0]![0] as AdapterExecutionContext;
		// Falls through to hydrated.issueId (= node.id = rawId); never blank.
		expect(execCall.label).toBe("GEO-555-claude-Edge case");
		expect(execCall.sessionDisplayName).toBe("GEO-555 Edge case");
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
		// No Lead → no Lead-comm (ask / gate / inbox) instructions. FLY-795: the
		// unconditional PROGRESS LEDGER discipline line references `flywheel-comm
		// progress` regardless of Lead, so assert the ask-specific marker is absent
		// rather than the broad "flywheel-comm" string.
		expect(execCall.appendSystemPrompt).not.toContain("ask --lead");
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

	// FLY-728: Blueprint must copy ctx.runnerModel into the started EventEnvelope
	// so the Bridge persists it as session.runner_model. Without this, a per-issue
	// model routed runner would run with --model but never surface which model.
	it("copies ctx.runnerModel into the session_started envelope", async () => {
		const emitStarted = vi.fn(async () => {});
		const emitter: ExecutionEventEmitter = {
			emitStarted,
			emitWorktreeReady: vi.fn(async () => {}),
			emitCompleted: vi.fn(async () => {}),
			emitFailed: vi.fn(async () => {}),
			emitHeartbeat: vi.fn(async () => {}),
			flush: vi.fn(async () => {}),
		};
		const blueprint = new Blueprint(
			makeHydrator(),
			makeMockGitChecker(),
			() => makeMockAdapter(),
			makeMockShell(),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			emitter,
		);

		await blueprint.run(
			makeNode(),
			"/project",
			makeContext({ runnerModel: "claude-fable-5" }),
		);

		expect(emitStarted).toHaveBeenCalledWith(
			expect.objectContaining({ runnerModel: "claude-fable-5" }),
		);
	});

	it("does not set runnerModel in the envelope when ctx has none (byte-compat)", async () => {
		const emitStarted = vi.fn(async () => {});
		const emitter: ExecutionEventEmitter = {
			emitStarted,
			emitWorktreeReady: vi.fn(async () => {}),
			emitCompleted: vi.fn(async () => {}),
			emitFailed: vi.fn(async () => {}),
			emitHeartbeat: vi.fn(async () => {}),
			flush: vi.fn(async () => {}),
		};
		const blueprint = new Blueprint(
			makeHydrator(),
			makeMockGitChecker(),
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

		const env = emitStarted.mock.calls[0]![0] as { runnerModel?: string };
		expect(env.runnerModel).toBeUndefined();
	});

	// FLY-807: the session_started envelope's `labels` field drives Discord chat-
	// thread routing (DirectEventSink.emitStarted -> resolveLeadForIssue). It must
	// prefer ctx.issueLabels (caller-provided, e.g. auto-QA's parent-issue labels)
	// over hydrated.labels (a live Linear re-fetch of THIS run's own issue, which
	// races empty right after auto-QA creates a brand-new "QA · FLY-XX" issue) --
	// exactly like the two other ctx.issueLabels ?? hydrated.labels call sites in
	// this same file (ponytail resolution + AgentDispatcher backend selection).
	it("prefers ctx.issueLabels over hydrated.labels in the session_started envelope", async () => {
		const emitStarted = vi.fn(async () => {});
		const emitter: ExecutionEventEmitter = {
			emitStarted,
			emitWorktreeReady: vi.fn(async () => {}),
			emitCompleted: vi.fn(async () => {}),
			emitFailed: vi.fn(async () => {}),
			emitHeartbeat: vi.fn(async () => {}),
			flush: vi.fn(async () => {}),
		};
		// makeHydrator()'s stub fetchIssue omits `labels` entirely, so PreHydrator
		// falls back to `[]` -- simulating the QA-issue race where the live Linear
		// read comes back empty.
		const blueprint = new Blueprint(
			makeHydrator(),
			makeMockGitChecker(),
			() => makeMockAdapter(),
			makeMockShell(),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			emitter,
		);

		await blueprint.run(
			makeNode(),
			"/project",
			makeContext({ issueLabels: ["flywheel"] }),
		);

		const env = emitStarted.mock.calls[0]![0] as { labels?: string[] };
		expect(env.labels).toEqual(["flywheel"]);
	});

	it("falls back to hydrated.labels when ctx.issueLabels is omitted (byte-compat)", async () => {
		const emitStarted = vi.fn(async () => {});
		const emitter: ExecutionEventEmitter = {
			emitStarted,
			emitWorktreeReady: vi.fn(async () => {}),
			emitCompleted: vi.fn(async () => {}),
			emitFailed: vi.fn(async () => {}),
			emitHeartbeat: vi.fn(async () => {}),
			flush: vi.fn(async () => {}),
		};
		const hydrator = new PreHydrator(async (id) => ({
			title: `Issue ${id} title`,
			description: `Description for ${id}`,
			labels: ["hydrated"],
		}));
		const blueprint = new Blueprint(
			hydrator,
			makeMockGitChecker(),
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

		const env = emitStarted.mock.calls[0]![0] as { labels?: string[] };
		expect(env.labels).toEqual(["hydrated"]);
	});

	it("does not fall back to hydrated.labels when ctx.issueLabels is explicitly empty", async () => {
		const emitStarted = vi.fn(async () => {});
		const emitter: ExecutionEventEmitter = {
			emitStarted,
			emitWorktreeReady: vi.fn(async () => {}),
			emitCompleted: vi.fn(async () => {}),
			emitFailed: vi.fn(async () => {}),
			emitHeartbeat: vi.fn(async () => {}),
			flush: vi.fn(async () => {}),
		};
		const hydrator = new PreHydrator(async (id) => ({
			title: `Issue ${id} title`,
			description: `Description for ${id}`,
			labels: ["hydrated"],
		}));
		const blueprint = new Blueprint(
			hydrator,
			makeMockGitChecker(),
			() => makeMockAdapter(),
			makeMockShell(),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			emitter,
		);

		await blueprint.run(
			makeNode(),
			"/project",
			makeContext({ issueLabels: [] }),
		);

		const env = emitStarted.mock.calls[0]![0] as { labels?: string[] };
		expect(env.labels).toEqual([]);
	});

	// ─── GEO-261: emitTerminal await tests ──────────

	describe("emitTerminal (GEO-261)", () => {
		function makeStubEmitter(
			overrides: Partial<ExecutionEventEmitter> = {},
		): ExecutionEventEmitter {
			return {
				emitStarted: vi.fn(async () => {}),
				emitWorktreeReady: vi.fn(async () => {}),
				emitCompleted: vi.fn(async () => {}),
				emitFailed: vi.fn(async () => {}),
				emitHeartbeat: vi.fn(async () => {}),
				flush: vi.fn(async () => {}),
				...overrides,
			};
		}

		// FLY-137: Verify Blueprint awaits emitWorktreeReady BEFORE adapter
		// starts, so Bridge has persisted session.worktree_path before any
		// stage event can fire.
		it("awaits emitWorktreeReady AFTER worktree.create() and BEFORE adapter.execute()", async () => {
			const order: string[] = [];
			const realWorktreePath = join(
				tmpdir(),
				`bp-wt-ready-${Date.now()}-${Math.random()}`,
			);
			mkdirSync(realWorktreePath, { recursive: true });
			execFileSync("git", ["init", "-q"], { cwd: realWorktreePath });

			const stubWorktreeManager = {
				removeIfExists: vi.fn(async () => {
					order.push("worktree.removeIfExists");
				}),
				create: vi.fn(async () => {
					order.push("worktree.create");
					return {
						worktreePath: realWorktreePath,
						branch: "feat/bp-wt-test",
					};
				}),
			} as unknown as WorktreeManager;

			const emitter = makeStubEmitter({
				emitWorktreeReady: vi.fn(async (_env, wt) => {
					// Slow patch so we can verify adapter.execute waits.
					await new Promise((r) => setTimeout(r, 25));
					order.push(`emitWorktreeReady:${wt}`);
				}),
			});

			const adapter: IAdapter = {
				type: "mock",
				supportsStreaming: false,
				checkEnvironment: async () => ({ healthy: true, message: "mock" }),
				execute: vi.fn(async () => {
					order.push("adapter.execute");
					return {
						success: true,
						sessionId: "s",
						durationMs: 1,
					};
				}),
			};

			const blueprint = new Blueprint(
				makeHydrator(),
				makeMockGitChecker({ commitCount: 1 }),
				() => adapter,
				makeMockShell(),
				stubWorktreeManager,
				undefined,
				undefined,
				undefined,
				undefined,
				emitter,
			);

			try {
				await blueprint.run(makeNode(), "/project", makeContext());
				// Order: removeIfExists → create → emitWorktreeReady → execute
				const createIdx = order.indexOf("worktree.create");
				const emitIdx = order.findIndex((s) =>
					s.startsWith("emitWorktreeReady:"),
				);
				const execIdx = order.indexOf("adapter.execute");
				expect(createIdx).toBeGreaterThanOrEqual(0);
				expect(emitIdx).toBeGreaterThan(createIdx);
				expect(execIdx).toBeGreaterThan(emitIdx);
				// And the payload carries the actual worktree path.
				expect(order[emitIdx]).toBe(`emitWorktreeReady:${realWorktreePath}`);
				expect(emitter.emitWorktreeReady).toHaveBeenCalledWith(
					expect.objectContaining({ executionId: "test-exec-id" }),
					realWorktreePath,
				);
			} finally {
				rmSync(realWorktreePath, { recursive: true, force: true });
			}
		});

		it("does NOT call emitWorktreeReady when no worktreeManager is configured", async () => {
			const emitter = makeStubEmitter();
			const blueprint = new Blueprint(
				makeHydrator(),
				makeMockGitChecker({ commitCount: 1 }),
				() => makeMockAdapter(),
				makeMockShell(),
				undefined, // no worktreeManager
				undefined,
				undefined,
				undefined,
				undefined,
				emitter,
			);
			await blueprint.run(makeNode(), "/project", makeContext());
			expect(emitter.emitWorktreeReady).not.toHaveBeenCalled();
		});

		it("swallows emitWorktreeReady failures and continues to adapter", async () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			const realWorktreePath = join(
				tmpdir(),
				`bp-wt-fail-${Date.now()}-${Math.random()}`,
			);
			mkdirSync(realWorktreePath, { recursive: true });
			execFileSync("git", ["init", "-q"], { cwd: realWorktreePath });

			const stubWorktreeManager = {
				removeIfExists: vi.fn(async () => {}),
				create: vi.fn(async () => ({
					worktreePath: realWorktreePath,
					branch: "feat/bp-wt-fail",
				})),
			} as unknown as WorktreeManager;

			const adapterExec = vi.fn(async () => ({
				success: true,
				sessionId: "s",
				durationMs: 1,
			}));
			const adapter: IAdapter = {
				type: "mock",
				supportsStreaming: false,
				checkEnvironment: async () => ({ healthy: true, message: "mock" }),
				execute: adapterExec,
			};

			const emitter = makeStubEmitter({
				emitWorktreeReady: vi.fn(async () => {
					throw new Error("bridge unreachable");
				}),
			});

			const blueprint = new Blueprint(
				makeHydrator(),
				makeMockGitChecker({ commitCount: 1 }),
				() => adapter,
				makeMockShell(),
				stubWorktreeManager,
				undefined,
				undefined,
				undefined,
				undefined,
				emitter,
			);

			try {
				await blueprint.run(makeNode(), "/project", makeContext());
				// Adapter still ran despite emit failure
				expect(adapterExec).toHaveBeenCalled();
				expect(warnSpy).toHaveBeenCalledWith(
					expect.stringContaining("emitWorktreeReady failed"),
				);
			} finally {
				warnSpy.mockRestore();
				rmSync(realWorktreePath, { recursive: true, force: true });
			}
		});

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
