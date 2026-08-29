/**
 * FLY-887 — Blueprint three-stage keep-alive worktree IN-PLACE TAKEOVER.
 *
 * When a later phase (implement/qa) dispatches on the SHARED branch-B worktree
 * and the prior phase parked (worktree still registered), the worktree is REUSED
 * in place — never removeIfExists+create (which would tear the parked phase's cwd
 * away). FAIL-CLOSED: only take over a worktree that is clean AND at the exact
 * captured head; any drift → `worktree_takeover_failed`. Gated on the keep-alive
 * kill-switch. Design / not-registered / kill-switch=0 → the legacy create path.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterExecutionResult, IAdapter } from "flywheel-core";
import type { DagNode } from "flywheel-dag-resolver";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BlueprintContext, ShellRunner } from "../Blueprint.js";
import { Blueprint } from "../Blueprint.js";
import type { GitResultChecker } from "../GitResultChecker.js";
import { PreHydrator } from "../PreHydrator.js";
import type { WorktreeManager } from "../WorktreeManager.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

function makeNode(id = "FLY-887"): DagNode {
	return { id, blockedBy: [] };
}
function makeHydrator() {
	return new PreHydrator(async (id) => ({
		title: `Issue ${id} title`,
		description: `Description for ${id}`,
		labels: [],
	}));
}
function makeGitChecker(opts: { clean: boolean; head: string }) {
	return {
		assertCleanTree: vi.fn(async () => {
			if (!opts.clean) throw new Error("dirty tree");
		}),
		captureBaseline: vi.fn(async () => opts.head),
		check: vi.fn(async () => ({
			hasNewCommits: true,
			commitCount: 1,
			filesChanged: 1,
			commitMessages: ["feat: x"],
		})),
	} as unknown as GitResultChecker;
}
function makeMockShell(): ShellRunner {
	return { execFile: vi.fn(async () => ({ stdout: "", exitCode: 0 })) };
}
function makeMockAdapter(): IAdapter {
	return {
		type: "mock",
		supportsStreaming: false,
		checkEnvironment: async () => ({ healthy: true, message: "mock" }),
		execute: vi.fn(
			async (): Promise<AdapterExecutionResult> => ({
				success: true,
				sessionId: "sess",
				tmuxWindow: "flywheel:@1",
				durationMs: 1,
			}),
		),
	};
}

/** A real git dir so the post-setup git-exclude / baseline steps don't blow up. */
function makeRealWorktree(): string {
	const p = join(tmpdir(), `fly887-takeover-${Date.now()}-${Math.random()}`);
	mkdirSync(p, { recursive: true });
	execFileSync("git", ["init", "-q"], { cwd: p });
	return p;
}

function makeWtManager(opts: {
	registered: boolean;
	path: string;
	branch?: string;
}) {
	return {
		expectedWorktree: vi.fn(() => ({
			path: opts.path,
			branch: opts.branch ?? "feat/branch-b",
		})),
		isRegistered: vi.fn(async () => opts.registered),
		removeIfExists: vi.fn(async () => true),
		create: vi.fn(async () => ({
			projectName: "flywheel",
			issueId: "FLY-887",
			worktreePath: opts.path,
			branch: opts.branch ?? "feat/branch-b",
			mainRepoPath: "/project",
		})),
	} as unknown as WorktreeManager;
}

async function run(
	wt: WorktreeManager,
	gitChecker: GitResultChecker,
	ctxOverrides: Partial<BlueprintContext>,
): Promise<{
	result: Awaited<ReturnType<Blueprint["run"]>>;
	wt: WorktreeManager;
	emit: ReturnType<typeof vi.fn>;
	adapter: IAdapter;
}> {
	const adapter = makeMockAdapter();
	const emit = vi.fn(async () => {});
	const emitter = {
		emitStarted: vi.fn(async () => {}),
		emitWorktreeReady: emit,
		emitCompleted: vi.fn(async () => {}),
		emitStage: vi.fn(async () => {}),
		emitArtifact: vi.fn(async () => {}),
	} as never;
	const blueprint = new Blueprint(
		makeHydrator(),
		gitChecker,
		() => adapter,
		makeMockShell(),
		wt,
		undefined,
		undefined,
		undefined,
		undefined,
		emitter,
	);
	const ctx: BlueprintContext = {
		teamName: "eng",
		runnerName: "claude",
		leadId: "flywheel-eng-lead",
		executionId: "exec-take",
		...ctxOverrides,
	};
	const result = await blueprint.run(makeNode(), "/project", ctx);
	return { result, wt, emit, adapter };
}

describe("FLY-887 worktree in-place takeover", () => {
	const created: string[] = [];
	afterEach(() => {
		process.env.FLYWHEEL_THREE_STAGE_KEEPALIVE = undefined;
		for (const p of created) rmSync(p, { recursive: true, force: true });
		created.length = 0;
	});

	it("implement + registered + clean + HEAD==startPoint → reuse in place (no removeIfExists/create)", async () => {
		const path = makeRealWorktree();
		created.push(path);
		const wt = makeWtManager({ registered: true, path });
		const { result, emit } = await run(
			wt,
			makeGitChecker({ clean: true, head: HEAD }),
			{ sessionRole: "implement", shareParentBranch: true, startPoint: HEAD },
		);
		expect(result.success).toBe(true);
		expect(wt.removeIfExists).not.toHaveBeenCalled();
		expect(wt.create).not.toHaveBeenCalled();
		// worktree_path still persisted on the takeover path (Codex R1 #3)
		expect(emit).toHaveBeenCalledWith(expect.anything(), path);
	});

	it("qa + registered + clean + HEAD==startPoint → reuse in place", async () => {
		const path = makeRealWorktree();
		created.push(path);
		const wt = makeWtManager({ registered: true, path });
		const { result } = await run(
			wt,
			makeGitChecker({ clean: true, head: HEAD }),
			{ sessionRole: "qa", shareParentBranch: true, startPoint: HEAD },
		);
		expect(result.success).toBe(true);
		expect(wt.create).not.toHaveBeenCalled();
	});

	it("dirty worktree → worktree_takeover_failed (never removeIfExists an active phase worktree)", async () => {
		const path = makeRealWorktree();
		created.push(path);
		const wt = makeWtManager({ registered: true, path });
		const { result } = await run(
			wt,
			makeGitChecker({ clean: false, head: HEAD }),
			{ sessionRole: "implement", shareParentBranch: true, startPoint: HEAD },
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain("worktree_takeover_failed");
		expect(wt.removeIfExists).not.toHaveBeenCalled();
		expect(wt.create).not.toHaveBeenCalled();
	});

	it("HEAD drift → worktree_takeover_failed", async () => {
		const path = makeRealWorktree();
		created.push(path);
		const wt = makeWtManager({ registered: true, path });
		const { result } = await run(
			wt,
			makeGitChecker({ clean: true, head: `deadbeef${"0".repeat(32)}` }),
			{ sessionRole: "implement", shareParentBranch: true, startPoint: HEAD },
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain("worktree_takeover_failed");
		expect(wt.create).not.toHaveBeenCalled();
	});

	it("not registered (prior phase closed/died) → legacy create path", async () => {
		const path = makeRealWorktree();
		created.push(path);
		const wt = makeWtManager({ registered: false, path });
		const { result } = await run(
			wt,
			makeGitChecker({ clean: true, head: HEAD }),
			{ sessionRole: "implement", shareParentBranch: true, startPoint: HEAD },
		);
		expect(result.success).toBe(true);
		expect(wt.removeIfExists).toHaveBeenCalled();
		expect(wt.create).toHaveBeenCalled();
	});

	it("byte-compat: design phase → legacy create path even if registered", async () => {
		const path = makeRealWorktree();
		created.push(path);
		const wt = makeWtManager({ registered: true, path });
		const { result } = await run(
			wt,
			makeGitChecker({ clean: true, head: HEAD }),
			{ sessionRole: "design", shareParentBranch: true, startPoint: HEAD },
		);
		expect(result.success).toBe(true);
		expect(wt.create).toHaveBeenCalled();
	});

	it("byte-compat: kill-switch=0 → legacy create path (no takeover)", async () => {
		process.env.FLYWHEEL_THREE_STAGE_KEEPALIVE = "0";
		const path = makeRealWorktree();
		created.push(path);
		const wt = makeWtManager({ registered: true, path });
		const { result } = await run(
			wt,
			makeGitChecker({ clean: true, head: HEAD }),
			{ sessionRole: "implement", shareParentBranch: true, startPoint: HEAD },
		);
		expect(result.success).toBe(true);
		expect(wt.create).toHaveBeenCalled();
	});

	it("byte-compat: non-three-stage (no shareParentBranch) → legacy create path", async () => {
		const path = makeRealWorktree();
		created.push(path);
		const wt = makeWtManager({ registered: true, path });
		const { result } = await run(
			wt,
			makeGitChecker({ clean: true, head: HEAD }),
			{ sessionRole: "main", startPoint: HEAD },
		);
		expect(result.success).toBe(true);
		expect(wt.create).toHaveBeenCalled();
	});
});
