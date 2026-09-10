import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	AdapterExecutionResult,
	DecisionResult,
	ExecutionContext,
} from "flywheel-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BlueprintContext } from "../Blueprint.js";
import { Blueprint } from "../Blueprint.js";
import type { IDecisionLayer } from "../decision/DecisionLayer.js";

// ─── Mocks ─────────────────────────────────

function makeMockHydrator() {
	return {
		hydrate: vi.fn().mockResolvedValue({
			issueId: "GEO-101",
			issueTitle: "Fix bug",
			issueDescription: "Description",
			labels: ["feature"],
			projectId: "proj-1",
			issueIdentifier: "GEO-101",
		}),
	};
}

function makeMockGitChecker(overrides: Record<string, unknown> = {}) {
	return {
		assertCleanTree: vi.fn().mockResolvedValue(undefined),
		captureBaseline: vi.fn().mockResolvedValue("abc123"),
		check: vi.fn().mockResolvedValue({
			hasNewCommits: true,
			commitCount: 2,
			filesChanged: 1,
			commitMessages: ["fix: thing"],
			...overrides,
		}),
	};
}

function makeMockAdapter(overrides: Partial<AdapterExecutionResult> = {}) {
	const execResult: AdapterExecutionResult = {
		success: true,
		sessionId: "sess-1",
		costUsd: 0.05,
		durationMs: 60_000,
		tmuxWindow: "flywheel:@42",
		...overrides,
	};
	return {
		type: "mock" as const,
		supportsStreaming: false as const,
		checkEnvironment: async () => ({ healthy: true, message: "mock" }),
		execute: vi.fn().mockResolvedValue(execResult),
	};
}

function makeMockShell() {
	return { execFile: vi.fn().mockResolvedValue({ stdout: "", exitCode: 0 }) };
}

function makeMockEvidenceCollector() {
	return {
		collect: vi.fn().mockResolvedValue({
			commitCount: 2,
			filesChangedCount: 1,
			commitMessages: ["fix: thing"],
			changedFilePaths: ["src/a.ts"],
			linesAdded: 10,
			linesRemoved: 5,
			diffSummary: "diff",
			headSha: "def456",
			partial: false,
			durationMs: 60_000,
		}),
		getFullDiff: vi.fn().mockResolvedValue("full diff"),
	};
}

function makeMockDecisionLayer(
	result: Partial<DecisionResult> = {},
): IDecisionLayer {
	return {
		decide: vi.fn().mockResolvedValue({
			route: "auto_approve",
			confidence: 0.95,
			reasoning: "Clean change",
			concerns: [],
			decisionSource: "haiku_triage",
			...result,
		}),
	};
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

describe("Blueprint Decision Layer Integration", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("FLY-1279: goal_blocked bypasses DecisionLayer even when commits exist", async () => {
		const decisionLayer = makeMockDecisionLayer({ route: "auto_approve" });
		const emitFailed = vi.fn(async () => {});
		const blueprint = new Blueprint(
			makeMockHydrator(),
			makeMockGitChecker(),
			() =>
				makeMockAdapter({
					success: false,
					failure: {
						failureKind: "goal_blocked",
						failureReason: "goal ended non-complete: blocked",
					},
				}),
			makeMockShell(),
			undefined,
			undefined,
			makeMockEvidenceCollector(),
			undefined,
			decisionLayer,
			{
				emitStarted: vi.fn(async () => {}),
				emitWorktreeReady: vi.fn(async () => {}),
				emitCompleted: vi.fn(async () => {}),
				emitFailed,
				emitHeartbeat: vi.fn(async () => {}),
				flush: vi.fn(async () => {}),
			},
		);

		const result = await blueprint.run(
			{ id: "GEO-101", blockedBy: [] },
			"/project",
			makeContext(),
		);

		expect(decisionLayer.decide).not.toHaveBeenCalled();
		expect(result.success).toBe(false);
		expect(result.decision).toBeUndefined();
		expect(result.failure?.failureKind).toBe("goal_blocked");
		expect(emitFailed).toHaveBeenCalledWith(
			expect.anything(),
			"goal ended non-complete: blocked",
			undefined,
			result.failure,
		);
	});
	it("FLY-2465: goal_usage_limited bypasses DecisionLayer even when commits exist", async () => {
		const decisionLayer = makeMockDecisionLayer({ route: "auto_approve" });
		const emitFailed = vi.fn(async () => {});
		const blueprint = new Blueprint(
			makeMockHydrator(),
			makeMockGitChecker(),
			() =>
				makeMockAdapter({
					success: false,
					failure: {
						failureKind: "goal_usage_limited",
						failureReason: "goal ended non-complete: usageLimited",
						quotaSignal: {
							version: 1,
							vendor: "codex",
							source: "goal_ended",
							sourceEventId: "event-1",
							bindingId: "binding-1",
							evidence: "usageLimited",
							observedAt: "2026-09-09T17:16:00.000Z",
						},
					},
				}),
			makeMockShell(),
			undefined,
			undefined,
			makeMockEvidenceCollector(),
			undefined,
			decisionLayer,
			{
				emitStarted: vi.fn(async () => {}),
				emitWorktreeReady: vi.fn(async () => {}),
				emitCompleted: vi.fn(async () => {}),
				emitFailed,
				emitHeartbeat: vi.fn(async () => {}),
				flush: vi.fn(async () => {}),
			},
		);

		const result = await blueprint.run(
			{ id: "GEO-101", blockedBy: [] },
			"/project",
			makeContext(),
		);

		expect(decisionLayer.decide).not.toHaveBeenCalled();
		expect(result.success).toBe(false);
		expect(result.decision).toBeUndefined();
		expect(result.failure?.failureKind).toBe("goal_usage_limited");
		expect(result.failure?.quotaSignal?.bindingId).toBe("binding-1");
		expect(emitFailed).toHaveBeenCalledWith(
			expect.anything(),
			"goal ended non-complete: usageLimited",
			undefined,
			result.failure,
		);
	});

	it("auto_approve → success=true, window killed", async () => {
		const shell = makeMockShell();
		const decisionLayer = makeMockDecisionLayer({ route: "auto_approve" });
		const blueprint = new Blueprint(
			makeMockHydrator(),
			makeMockGitChecker(),
			() => makeMockAdapter(),
			shell,
			undefined,
			undefined,
			makeMockEvidenceCollector(),
			undefined,
			decisionLayer,
		);

		const result = await blueprint.run(
			{ id: "GEO-101", blockedBy: [] },
			"/project",
			makeContext(),
		);

		expect(result.success).toBe(true);
		expect(result.decision?.route).toBe("auto_approve");
		expect(result.tmuxWindow).toBeUndefined(); // killed
		expect(shell.execFile).toHaveBeenCalledWith(
			"tmux",
			["kill-window", "-t", "flywheel:@42"],
			"/",
		);
	});

	it("refuses auto-approve cleanup when the tmux socket is outside the slot", async () => {
		const isolationRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "flywheel-blueprint-slot-"),
		);
		vi.stubEnv("FLYWHEEL_ISOLATION_ROOT", isolationRoot);
		vi.stubEnv("FLYWHEEL_KILL_LEDGER_ROOT", isolationRoot);
		const shell = makeMockShell();
		shell.execFile.mockImplementation(async (_command, args) => ({
			stdout: args[0] === "display-message" ? "/production/tmux/default\n" : "",
			exitCode: 0,
		}));
		const blueprint = new Blueprint(
			makeMockHydrator(),
			makeMockGitChecker(),
			() => makeMockAdapter(),
			shell,
			undefined,
			undefined,
			makeMockEvidenceCollector(),
			undefined,
			makeMockDecisionLayer({ route: "auto_approve" }),
		);

		try {
			await blueprint.run(
				{ id: "GEO-101", blockedBy: [] },
				"/project",
				makeContext(),
			);

			expect(shell.execFile).toHaveBeenCalledWith(
				"tmux",
				["display-message", "-p", "-t", "flywheel:@42", "#{socket_path}"],
				"/",
			);
			expect(shell.execFile).not.toHaveBeenCalledWith(
				"tmux",
				["kill-window", "-t", "flywheel:@42"],
				"/",
			);
		} finally {
			fs.rmSync(isolationRoot, { recursive: true, force: true });
		}
	});

	it("needs_review → success=true, window preserved", async () => {
		const shell = makeMockShell();
		const decisionLayer = makeMockDecisionLayer({ route: "needs_review" });
		const blueprint = new Blueprint(
			makeMockHydrator(),
			makeMockGitChecker(),
			() => makeMockAdapter(),
			shell,
			undefined,
			undefined,
			makeMockEvidenceCollector(),
			undefined,
			decisionLayer,
		);

		const result = await blueprint.run(
			{ id: "GEO-101", blockedBy: [] },
			"/project",
			makeContext(),
		);

		expect(result.success).toBe(true);
		expect(result.decision?.route).toBe("needs_review");
		expect(result.tmuxWindow).toBe("flywheel:@42"); // preserved
	});

	it("blocked → success=false, window preserved", async () => {
		const decisionLayer = makeMockDecisionLayer({ route: "blocked" });
		const blueprint = new Blueprint(
			makeMockHydrator(),
			makeMockGitChecker(),
			() => makeMockAdapter(),
			makeMockShell(),
			undefined,
			undefined,
			makeMockEvidenceCollector(),
			undefined,
			decisionLayer,
		);

		const result = await blueprint.run(
			{ id: "GEO-101", blockedBy: [] },
			"/project",
			makeContext(),
		);

		expect(result.success).toBe(false);
		expect(result.decision?.route).toBe("blocked");
		expect(result.tmuxWindow).toBe("flywheel:@42"); // preserved
	});

	it("decisionLayer throws → needs_review fallback", async () => {
		const decisionLayer: IDecisionLayer = {
			decide: vi.fn().mockRejectedValue(new Error("DB crash")),
		};
		const blueprint = new Blueprint(
			makeMockHydrator(),
			makeMockGitChecker(),
			() => makeMockAdapter(),
			makeMockShell(),
			undefined,
			undefined,
			makeMockEvidenceCollector(),
			undefined,
			decisionLayer,
		);

		const result = await blueprint.run(
			{ id: "GEO-101", blockedBy: [] },
			"/project",
			makeContext(),
		);

		expect(result.success).toBe(true);
		expect(result.decision?.route).toBe("needs_review");
		expect(result.decision?.decisionSource).toBe("decision_error_fallback");
	});

	it("no decisionLayer → v0.1.1 behavior", async () => {
		const blueprint = new Blueprint(
			makeMockHydrator(),
			makeMockGitChecker({ commitCount: 3 }),
			() => makeMockAdapter(),
			makeMockShell(),
		);

		const result = await blueprint.run(
			{ id: "GEO-101", blockedBy: [] },
			"/project",
			makeContext(),
		);

		expect(result.success).toBe(true);
		expect(result.decision).toBeUndefined();
	});

	it("ExecutionContext built with correct fields", async () => {
		const decisionLayer: IDecisionLayer = {
			decide: vi.fn().mockResolvedValue({
				route: "needs_review",
				confidence: 0.5,
				reasoning: "test",
				concerns: [],
				decisionSource: "haiku_triage",
			}),
		};
		const blueprint = new Blueprint(
			makeMockHydrator(),
			makeMockGitChecker(),
			() => makeMockAdapter(),
			makeMockShell(),
			undefined,
			undefined,
			makeMockEvidenceCollector(),
			undefined,
			decisionLayer,
		);

		await blueprint.run(
			{ id: "GEO-101", blockedBy: [] },
			"/project",
			makeContext({ consecutiveFailures: 2 }),
		);

		const execCtx = (decisionLayer.decide as ReturnType<typeof vi.fn>).mock
			.calls[0]![0] as ExecutionContext;
		expect(execCtx.issueId).toBe("GEO-101");
		expect(execCtx.issueIdentifier).toBe("GEO-101");
		expect(execCtx.labels).toEqual(["feature"]);
		expect(execCtx.projectId).toBe("proj-1");
		expect(execCtx.consecutiveFailures).toBe(2);
		expect(execCtx.commitCount).toBe(2);
	});
});

it("FLY-2465 forwards trusted pre-auth callback into the adapter context", async () => {
	const callback = async () => ({
		bindingId: "binding",
		executionId: "test-exec-id",
		runId: null,
		accountKey: "account",
		profile: "school",
		generation: 1,
		credentialRootKey: "root",
		purpose: "runner" as const,
	});
	const adapter = makeMockAdapter();
	const blueprint = new Blueprint(
		makeMockHydrator(),
		makeMockGitChecker(),
		() => adapter,
		makeMockShell(),
	);
	await blueprint.run(
		{ id: "GEO-101", blockedBy: [] },
		"/project",
		makeContext({ beforeCodexDaemonStart: callback }),
	);
	expect(adapter.execute.mock.calls[0][0].beforeCodexDaemonStart).toBe(
		callback,
	);
});
