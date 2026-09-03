/** FLY-1961: Blueprint only requests vendor trust for a real worktree. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
	IAdapter,
} from "flywheel-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BlueprintContext, ShellRunner } from "../Blueprint.js";
import { Blueprint } from "../Blueprint.js";
import type { DagNode } from "../dag-node.js";
import type { GitResultChecker } from "../GitResultChecker.js";
import { PreHydrator } from "../PreHydrator.js";
import type { WorktreeManager } from "../WorktreeManager.js";

const cleanups: string[] = [];

afterEach(() => {
	while (cleanups.length > 0) {
		rmSync(cleanups.pop() as string, { recursive: true, force: true });
	}
});

function makeRepo(label: string): string {
	const path = mkdtempSync(join(tmpdir(), `fly1961-${label}-`));
	execFileSync("git", ["init", "-q"], { cwd: path });
	cleanups.push(path);
	return path;
}

function makeAdapter(): IAdapter {
	return {
		type: "capture",
		supportsStreaming: false,
		checkEnvironment: async () => ({ healthy: true, message: "capture" }),
		execute: vi.fn(
			async (): Promise<AdapterExecutionResult> => ({
				success: true,
				durationMs: 1,
			}),
		),
	};
}

function makeGitChecker(): GitResultChecker {
	return {
		assertCleanTree: vi.fn(async () => {}),
		captureBaseline: vi.fn(async () => "abc123"),
		check: vi.fn(async () => ({
			hasNewCommits: true,
			commitCount: 1,
			filesChanged: 1,
			commitMessages: ["fix: trust"],
		})),
	} as unknown as GitResultChecker;
}

function makeWorktreeManager(
	projectRoot: string,
	worktreePath: string,
): WorktreeManager {
	return {
		expectedWorktree: vi.fn(() => ({
			path: worktreePath,
			branch: "flywheel-FLY-1961",
		})),
		isRegistered: vi.fn(async () => false),
		removeIfExists: vi.fn(async () => true),
		create: vi.fn(async () => ({
			projectName: "proj",
			issueId: "FLY-1961",
			worktreePath,
			branch: "flywheel-FLY-1961",
			mainRepoPath: projectRoot,
		})),
	} as unknown as WorktreeManager;
}

async function captureExecution(opts: {
	backend: NonNullable<BlueprintContext["runnerBackend"]>;
	withWorktree: boolean;
}): Promise<AdapterExecutionContext> {
	const projectRoot = makeRepo("project");
	const worktreePath = opts.withWorktree ? makeRepo("worktree") : undefined;
	const adapter = makeAdapter();
	const shell: ShellRunner = {
		execFile: vi.fn(async () => ({ stdout: "", exitCode: 0 })),
	};
	const blueprint = new Blueprint(
		new PreHydrator(async () => ({
			title: "Dual vendor workspace trust",
			description: "Trust new worktrees before launch",
			labels: [],
		})),
		makeGitChecker(),
		() => adapter,
		shell,
		worktreePath ? makeWorktreeManager(projectRoot, worktreePath) : undefined,
	);
	const node: DagNode = { id: "FLY-1961", blockedBy: [] };
	await blueprint.run(node, projectRoot, {
		teamName: "eng",
		runnerName: "runner",
		projectName: "proj",
		runnerBackend: opts.backend,
	});
	const captured = (adapter.execute as ReturnType<typeof vi.fn>).mock
		.calls[0]?.[0];
	if (!captured) throw new Error("capture adapter was not called");
	return captured as AdapterExecutionContext;
}

describe("Blueprint FLY-1961 workspace pretrust signal", () => {
	it.each(["claude-tmux", "codex-tmux"] as const)(
		"sets the signal for a real %s worktree",
		async (backend) => {
			const captured = await captureExecution({ backend, withWorktree: true });
			expect(captured.pretrustWorkspace).toBe(true);
			expect(captured.cwd).toContain("fly1961-worktree-");
		},
	);

	it("does not trust the project root for no-worktree Claude runs", async () => {
		const captured = await captureExecution({
			backend: "claude-tmux",
			withWorktree: false,
		});
		expect(captured).not.toHaveProperty("pretrustWorkspace");
		expect(captured.cwd).toContain("fly1961-project-");
	});

	it.each(["antigravity-tmux", "kimi-tmux"] as const)(
		"keeps %s payload byte-compatible",
		async (backend) => {
			const captured = await captureExecution({ backend, withWorktree: true });
			expect(captured).not.toHaveProperty("pretrustWorkspace");
		},
	);
});
