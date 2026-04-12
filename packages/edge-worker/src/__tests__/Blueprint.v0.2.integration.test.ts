import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
	IAdapter,
} from "flywheel-core";
import type { DagNode } from "flywheel-dag-resolver";
import { describe, expect, it, vi } from "vitest";
import type { BlueprintContext, ShellRunner } from "../Blueprint.js";
import { Blueprint } from "../Blueprint.js";
import type {
	ExecutionEvidence,
	ExecutionEvidenceCollector,
} from "../ExecutionEvidenceCollector.js";
import type { GitResultChecker } from "../GitResultChecker.js";
import { PreHydrator } from "../PreHydrator.js";
import type { SkillInjector } from "../SkillInjector.js";
import type { WorktreeInfo, WorktreeManager } from "../WorktreeManager.js";

// ─── Helpers ─────────────────────────────────────

function makeNode(id = "GEO-42"): DagNode {
	return { id, blockedBy: [] };
}

function makeContext(
	overrides: Partial<BlueprintContext> = {},
): BlueprintContext {
	return {
		executionId: "test-exec-id",
		teamName: "eng",
		runnerName: "claude",
		projectName: "test-project",
		sessionTimeoutMs: 600_000,
		...overrides,
	};
}

function makeHydrator() {
	return new PreHydrator(async (id) => ({
		title: `Issue ${id} title`,
		description: `Description for ${id}`,
	}));
}

function makeMockGitChecker(options: { commitCount?: number } = {}) {
	const { commitCount = 2 } = options;
	return {
		assertCleanTree: vi.fn(async () => {}),
		captureBaseline: vi.fn(async () => "base-sha-abc"),
		check: vi.fn(async () => ({
			hasNewCommits: commitCount > 0,
			commitCount,
			filesChanged: 3,
			commitMessages: ["feat: add auth", "test: add auth tests"],
		})),
	} as unknown as GitResultChecker;
}

function makeMockShell(): ShellRunner {
	return {
		execFile: vi.fn(async () => ({ stdout: "", exitCode: 0 })),
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
				durationMs: 45000,
				...result,
			}),
		),
	};
}

function makeMockWorktreeManager(
	overrides: Partial<WorktreeManager> = {},
): WorktreeManager {
	const defaultWorktreeInfo: WorktreeInfo = {
		projectName: "test-project",
		issueId: "GEO-42",
		worktreePath: "/tmp/wt/test-project/flywheel-GEO-42",
		branch: "flywheel-GEO-42",
		mainRepoPath: "/repo",
	};
	return {
		removeIfExists: vi.fn(async () => false),
		create: vi.fn(async () => defaultWorktreeInfo),
		...overrides,
	} as unknown as WorktreeManager;
}

function makeMockSkillInjector(): SkillInjector {
	return {
		inject: vi.fn(async () => {}),
	} as unknown as SkillInjector;
}

function makeMockEvidenceCollector(): ExecutionEvidenceCollector {
	const evidence: ExecutionEvidence = {
		commitCount: 2,
		filesChangedCount: 3,
		commitMessages: ["feat: add auth", "test: add auth tests"],
		changedFilePaths: ["src/auth.ts", "src/auth.test.ts", "src/index.ts"],
		linesAdded: 120,
		linesRemoved: 5,
		diffSummary: "diff --git...",
		headSha: "abc123",
		partial: false,
		durationMs: 45000,
	};
	return {
		collect: vi.fn(async () => evidence),
	} as unknown as ExecutionEvidenceCollector;
}

// ─── Tests ───────────────────────────────────────

describe("Blueprint v0.2 integration", () => {
	it("full v0.2 flow: worktree → skills → session → evidence", async () => {
		const mockAdapter = makeMockAdapter();
		const mockWorktreeManager = makeMockWorktreeManager();
		const mockSkillInjector = makeMockSkillInjector();
		const mockEvidenceCollector = makeMockEvidenceCollector();

		const blueprint = new Blueprint(
			makeHydrator(),
			makeMockGitChecker({ commitCount: 2 }),
			() => mockAdapter,
			makeMockShell(),
			mockWorktreeManager,
			mockSkillInjector,
			mockEvidenceCollector,
		);

		const result = await blueprint.run(makeNode(), "/repo", makeContext());

		// Worktree created
		expect(mockWorktreeManager.removeIfExists).toHaveBeenCalledWith(
			"/repo",
			"test-project",
			"GEO-42",
		);
		expect(mockWorktreeManager.create).toHaveBeenCalledWith({
			mainRepoPath: "/repo",
			projectName: "test-project",
			issueId: "GEO-42",
		});

		// Skills injected into worktree
		expect(mockSkillInjector.inject).toHaveBeenCalledWith(
			"/tmp/wt/test-project/flywheel-GEO-42",
			expect.objectContaining({ issueId: "GEO-42" }),
		);

		// Adapter executed in worktree cwd
		expect(mockAdapter.execute).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: "/tmp/wt/test-project/flywheel-GEO-42",
			}),
		);

		// Evidence collected
		expect(mockEvidenceCollector.collect).toHaveBeenCalled();

		// Result includes v0.2 fields
		expect(result.success).toBe(true);
		expect(result.worktreePath).toBe("/tmp/wt/test-project/flywheel-GEO-42");
		expect(result.evidence).toBeDefined();
		expect(result.evidence!.commitCount).toBe(2);
	});

	it("full v0.2 flow — adapter timeout", async () => {
		const mockAdapter = makeMockAdapter({ timedOut: true });
		const mockWorktreeManager = makeMockWorktreeManager();
		const mockEvidenceCollector = makeMockEvidenceCollector();

		const blueprint = new Blueprint(
			makeHydrator(),
			makeMockGitChecker({ commitCount: 2 }),
			() => mockAdapter,
			makeMockShell(),
			mockWorktreeManager,
			undefined,
			mockEvidenceCollector,
		);

		const result = await blueprint.run(makeNode(), "/repo", makeContext());

		expect(result.success).toBe(false); // timeout = failure
		expect(result.worktreePath).toBe("/tmp/wt/test-project/flywheel-GEO-42");
		expect(result.evidence).toBeDefined();
	});

	it("full v0.2 flow — 0 commits (failure)", async () => {
		const mockAdapter = makeMockAdapter();
		const mockWorktreeManager = makeMockWorktreeManager();
		const mockEvidenceCollector = makeMockEvidenceCollector();

		const blueprint = new Blueprint(
			makeHydrator(),
			makeMockGitChecker({ commitCount: 0 }),
			() => mockAdapter,
			makeMockShell(),
			mockWorktreeManager,
			undefined,
			mockEvidenceCollector,
		);

		const result = await blueprint.run(makeNode(), "/repo", makeContext());

		expect(result.success).toBe(false);
		expect(result.evidence).toBeDefined();
	});

	it("v0.1.1 fallback — no v0.2 deps", async () => {
		const mockAdapter = makeMockAdapter();

		const blueprint = new Blueprint(
			makeHydrator(),
			makeMockGitChecker({ commitCount: 1 }),
			() => mockAdapter,
			makeMockShell(),
			// No v0.2 deps
		);

		const result = await blueprint.run(
			makeNode(),
			"/repo",
			makeContext({ projectName: undefined, sessionTimeoutMs: undefined }),
		);

		expect(result.success).toBe(true);
		expect(result.worktreePath).toBeUndefined();
		expect(result.evidence).toBeUndefined();
	});

	it("worktree create failure — early abort", async () => {
		const mockAdapter = makeMockAdapter();
		const mockWorktreeManager = makeMockWorktreeManager({
			create: vi.fn(async () => {
				throw new Error("git lock error");
			}),
		});

		const blueprint = new Blueprint(
			makeHydrator(),
			makeMockGitChecker(),
			() => mockAdapter,
			makeMockShell(),
			mockWorktreeManager,
		);

		const result = await blueprint.run(makeNode(), "/repo", makeContext());

		expect(result.success).toBe(false);
		expect(result.error).toBe("git lock error");
		expect(mockAdapter.execute).not.toHaveBeenCalled();
	});

	it("skill injection failure — warns + continues", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const mockAdapter = makeMockAdapter();
		const mockWorktreeManager = makeMockWorktreeManager();
		const mockSkillInjector = {
			inject: vi.fn(async () => {
				throw new Error("EACCES: permission denied");
			}),
		} as unknown as SkillInjector;

		const blueprint = new Blueprint(
			makeHydrator(),
			makeMockGitChecker({ commitCount: 1 }),
			() => mockAdapter,
			makeMockShell(),
			mockWorktreeManager,
			mockSkillInjector,
		);

		const result = await blueprint.run(makeNode(), "/repo", makeContext());

		// Session still ran despite skill failure
		expect(mockAdapter.execute).toHaveBeenCalled();
		expect(result.success).toBe(true);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("Skill injection failed"),
		);

		warnSpy.mockRestore();
	});

	// ── FLY-95: Role-aware worktree naming ──────────────

	it("worktree uses plain issueId when sessionRole is 'main'", async () => {
		const mockWorktreeManager = makeMockWorktreeManager();
		const blueprint = new Blueprint(
			makeHydrator(),
			makeMockGitChecker({ commitCount: 1 }),
			() => makeMockAdapter(),
			makeMockShell(),
			mockWorktreeManager,
		);

		await blueprint.run(
			makeNode("GEO-42"),
			"/repo",
			makeContext({ sessionRole: "main" }),
		);

		expect(mockWorktreeManager.removeIfExists).toHaveBeenCalledWith(
			"/repo",
			"test-project",
			"GEO-42",
		);
		expect(mockWorktreeManager.create).toHaveBeenCalledWith({
			mainRepoPath: "/repo",
			projectName: "test-project",
			issueId: "GEO-42",
		});
	});

	it("worktree uses issueId-role suffix when sessionRole is 'qa'", async () => {
		const mockWorktreeManager = makeMockWorktreeManager();
		const blueprint = new Blueprint(
			makeHydrator(),
			makeMockGitChecker({ commitCount: 1 }),
			() => makeMockAdapter(),
			makeMockShell(),
			mockWorktreeManager,
		);

		await blueprint.run(
			makeNode("GEO-42"),
			"/repo",
			makeContext({ sessionRole: "qa" }),
		);

		expect(mockWorktreeManager.removeIfExists).toHaveBeenCalledWith(
			"/repo",
			"test-project",
			"GEO-42-qa",
		);
		expect(mockWorktreeManager.create).toHaveBeenCalledWith({
			mainRepoPath: "/repo",
			projectName: "test-project",
			issueId: "GEO-42-qa",
		});
	});

	it("worktree defaults to 'main' when sessionRole is undefined", async () => {
		const mockWorktreeManager = makeMockWorktreeManager();
		const blueprint = new Blueprint(
			makeHydrator(),
			makeMockGitChecker({ commitCount: 1 }),
			() => makeMockAdapter(),
			makeMockShell(),
			mockWorktreeManager,
		);

		await blueprint.run(
			makeNode("GEO-42"),
			"/repo",
			makeContext({ sessionRole: undefined }),
		);

		// No role suffix — uses plain issueId
		expect(mockWorktreeManager.create).toHaveBeenCalledWith({
			mainRepoPath: "/repo",
			projectName: "test-project",
			issueId: "GEO-42",
		});
	});

	it("worktree sanitizes unsafe sessionRole characters", async () => {
		const mockWorktreeManager = makeMockWorktreeManager();
		const blueprint = new Blueprint(
			makeHydrator(),
			makeMockGitChecker({ commitCount: 1 }),
			() => makeMockAdapter(),
			makeMockShell(),
			mockWorktreeManager,
		);

		await blueprint.run(
			makeNode("GEO-42"),
			"/repo",
			makeContext({ sessionRole: "QA/../hack" }),
		);

		// Sanitized to "qahack" — unsafe chars stripped, lowercased
		expect(mockWorktreeManager.create).toHaveBeenCalledWith({
			mainRepoPath: "/repo",
			projectName: "test-project",
			issueId: "GEO-42-qahack",
		});
	});

	it("worktree falls back to 'main' when role is all unsafe characters", async () => {
		const mockWorktreeManager = makeMockWorktreeManager();
		const blueprint = new Blueprint(
			makeHydrator(),
			makeMockGitChecker({ commitCount: 1 }),
			() => makeMockAdapter(),
			makeMockShell(),
			mockWorktreeManager,
		);

		await blueprint.run(
			makeNode("GEO-42"),
			"/repo",
			makeContext({ sessionRole: "../../" }),
		);

		// All chars stripped → empty → falls back to "main" → no suffix
		expect(mockWorktreeManager.create).toHaveBeenCalledWith({
			mainRepoPath: "/repo",
			projectName: "test-project",
			issueId: "GEO-42",
		});
	});
});
