import type { WorktreeManager } from "flywheel-edge-worker";
import { describe, expect, it, vi } from "vitest";
import type { ProjectRuntime } from "../run-dispatcher.js";
import { createBranchContinuityComputer } from "../run-infra.js";

describe("FLY-1718 production branch continuity wiring", () => {
	function fixture() {
		const expectedWorktree = vi.fn(
			(_root: string, _project: string, key: string) => ({
				path: `/worktrees/flywheel-${key}`,
				branch: `flywheel-${key}`,
			}),
		);
		const runtime = {
			projectRoot: "/repo",
		} as ProjectRuntime;
		const materialize = vi.fn(async () => ({
			kind: "exists" as const,
			sha: "a".repeat(40),
		}));
		const lookupOpenPrs = vi.fn(async () => [
			{
				number: 813,
				url: "https://github.test/pull/813",
				updatedAt: "2026-08-12T00:00:00Z",
			},
		]);
		const log = vi.fn();
		const computer = createBranchContinuityComputer({
			projectRuntimes: new Map([["proj", runtime]]),
			worktreeManager: { expectedWorktree } as unknown as WorktreeManager,
			materialize,
			lookupOpenPrs,
			log,
		});
		return { computer, expectedWorktree, materialize, lookupOpenPrs, log };
	}

	it("derives the probed branch from req.issueId, not the display identifier", async () => {
		const { computer, expectedWorktree, materialize, log } = fixture();
		const result = await computer({
			issueId: "linear-uuid",
			projectName: "proj",
			role: "implement",
			shareParentBranch: undefined,
		});

		expect(expectedWorktree).toHaveBeenCalledWith(
			"/repo",
			"proj",
			"linear-uuid-implement",
		);
		expect(materialize).toHaveBeenCalledWith({
			repoPath: "/repo",
			branch: "flywheel-linear-uuid-implement",
		});
		expect(result).toEqual({
			kind: "found",
			branch: "flywheel-linear-uuid-implement",
			sha: "a".repeat(40),
			prNumber: 813,
			prUrl: "https://github.test/pull/813",
		});
		expect(log).toHaveBeenCalledWith(
			"[continuity] flywheel-linear-uuid-implement open PR inventory: #813",
		);
	});

	it("uses the shared main key only when the caller already owns three-stage semantics", async () => {
		const { computer, expectedWorktree } = fixture();
		await computer({
			issueId: "linear-uuid",
			projectName: "proj",
			role: "qa",
			shareParentBranch: true,
		});
		expect(expectedWorktree).toHaveBeenCalledWith(
			"/repo",
			"proj",
			"linear-uuid",
		);
	});

	it("propagates missing and indeterminate decisions without PR lookup", async () => {
		for (const decision of [
			{ kind: "missing" as const },
			{ kind: "indeterminate" as const, error: "offline" },
		]) {
			const { computer, materialize, lookupOpenPrs } = fixture();
			materialize.mockResolvedValueOnce(decision as never);
			const result = await computer({
				issueId: "linear-uuid",
				projectName: "proj",
				role: "main",
			});
			expect(result).toEqual(
				decision.kind === "missing"
					? { ...decision, branch: "flywheel-linear-uuid" }
					: decision,
			);
			expect(lookupOpenPrs).not.toHaveBeenCalled();
		}
	});

	it("fails closed when the project runtime is unavailable", async () => {
		const computer = createBranchContinuityComputer({
			projectRuntimes: new Map(),
			worktreeManager: {} as WorktreeManager,
			materialize: vi.fn(),
			lookupOpenPrs: vi.fn(),
		});
		await expect(
			computer({ issueId: "id", projectName: "missing", role: "main" }),
		).resolves.toEqual({
			kind: "indeterminate",
			error: "project runtime missing is unavailable",
		});
	});
});
