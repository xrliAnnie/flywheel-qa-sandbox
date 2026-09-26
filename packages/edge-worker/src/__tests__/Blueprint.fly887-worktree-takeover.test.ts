/**
 * FLY-887 — Blueprint DAG workflow keep-alive worktree IN-PLACE TAKEOVER.
 *
 * When a later phase (implement/qa) dispatches on the SHARED branch-B worktree
 * and the prior phase parked (worktree still registered), the worktree is REUSED
 * in place — never removeIfExists+create (which would tear the parked phase's cwd
 * away). FAIL-CLOSED: only take over a worktree that is clean AND at the exact
 * captured head; any drift → `worktree_takeover_failed`. Gated on the keep-alive
 * kill-switch. Design / not-registered / kill-switch=0 → the legacy create path.
 *
 * FLY-2901: the shared-worktree decision (registration × existence, reuse,
 * rescue, refusal) now lives in `WorktreeManager.runTakeoverTransaction`
 * (real-git coverage: WorktreeManager.takeover-rescue.test.ts). These tests pin
 * the Blueprint contract: WHEN the transaction is used, WHAT it is given, and
 * how each outcome maps to launch / failure / prompt.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterExecutionResult, IAdapter } from "flywheel-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BlueprintContext, ShellRunner } from "../Blueprint.js";
import { Blueprint } from "../Blueprint.js";
import type { DagNode } from "../dag-node.js";
import type { GitResultChecker } from "../GitResultChecker.js";
import { PreHydrator } from "../PreHydrator.js";
import type { WorktreeManager } from "../WorktreeManager.js";
import type { TakeoverRescueManifest } from "../worktree-takeover-rescue.js";
import type { TakeoverTransactionResult } from "../worktree-takeover-transaction.js";

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
function makeGitChecker(opts: {
	clean: boolean;
	head: string;
	ancestor?: boolean;
}) {
	return {
		assertCleanTree: vi.fn(async () => {
			if (!opts.clean) throw new Error("dirty tree");
		}),
		captureBaseline: vi.fn(async () => opts.head),
		isAncestorOf: vi.fn(async () => opts.ancestor ?? false),
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
	takeover?: TakeoverTransactionResult | (() => Promise<never>);
}) {
	const worktree = {
		projectName: "flywheel",
		issueId: "FLY-887",
		worktreePath: opts.path,
		branch: opts.branch ?? "feat/branch-b",
		mainRepoPath: "/project",
		generation: "",
	};
	return {
		runTakeoverTransaction: vi.fn(async () => {
			if (typeof opts.takeover === "function") return opts.takeover();
			return opts.takeover ?? { kind: "reused" as const, worktree };
		}),
		expectedWorktree: vi.fn(() => ({
			path: opts.path,
			branch: opts.branch ?? "feat/branch-b",
		})),
		isRegistered: vi.fn(async () => opts.registered),
		removeIfExists: vi.fn(async () => true),
		quarantineAndRebuild: vi.fn(async () => ({
			ok: true as const,
			worktree: {
				projectName: "flywheel",
				issueId: "FLY-887",
				worktreePath: opts.path,
				branch: opts.branch ?? "feat/branch-b",
				mainRepoPath: "/project",
				generation: "resume-generation",
			},
		})),
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
	emitterExtras: Record<string, unknown> = {},
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
		...emitterExtras,
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
		expect(wt.runTakeoverTransaction).toHaveBeenCalledTimes(1);
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

	it("FLY-2901: the transaction receives the Bridge-trusted permit, kill switch, run and successor identity", async () => {
		const path = makeRealWorktree();
		created.push(path);
		const wt = makeWtManager({ registered: true, path });
		const permit = {
			allowed: true,
			reason: "no_live_writer" as const,
			predecessors: [],
		};
		await run(wt, makeGitChecker({ clean: true, head: HEAD }), {
			sessionRole: "implement",
			shareParentBranch: true,
			startPoint: HEAD,
			takeoverRescuePermit: permit,
			takeoverRescueDisabled: true,
		});
		expect(wt.runTakeoverTransaction).toHaveBeenCalledWith(
			expect.objectContaining({
				mainRepoPath: "/project",
				issueId: "FLY-887",
				issueKey: "FLY-887",
				successorExec: "exec-take",
				startPoint: HEAD,
				permit,
				rescueDisabled: true,
				recorder: undefined,
			}),
		);
	});

	it("FLY-2901: a refused rescue maps to worktree_takeover_failed naming class, reason, kept rescues and dirty paths", async () => {
		const path = makeRealWorktree();
		created.push(path);
		const wt = makeWtManager({
			registered: true,
			path,
			takeover: {
				kind: "refused",
				reason: "permit_denied:live_writer",
				class: "dirty",
				dirtyPaths: ["a.txt", "paired/other/"],
				dirtyPathsOverflow: 3,
				completedRescues: [
					{
						kind: "dirty",
						localRef: "refs/flywheel/rescue/x",
						remoteBranch: "flywheel-rescue/FLY-887/a-b-20260925T000000Z-dirty",
						tip: "a".repeat(40),
					},
				],
				head: HEAD,
				clean: false,
				legacy: false,
			},
		});
		const { result, adapter } = await run(
			wt,
			makeGitChecker({ clean: false, head: HEAD }),
			{ sessionRole: "implement", shareParentBranch: true, startPoint: HEAD },
		);
		expect(result.success).toBe(false);
		expect(result.failure).toEqual({
			failureKind: "worktree_takeover_failed",
			failureReason: result.error,
		});
		expect(result.error).toContain(
			"worktree_takeover_failed: rescue refused (dirty/permit_denied:live_writer)",
		);
		expect(result.error).toContain(
			`preserved (kept): dirty flywheel-rescue/FLY-887/a-b-20260925T000000Z-dirty@${"a".repeat(40)}`,
		);
		expect(result.error).toContain(
			"dirty paths: a.txt, paired/other/ …(+3 more)",
		);
		expect(wt.removeIfExists).not.toHaveBeenCalled();
		expect(wt.create).not.toHaveBeenCalled();
		expect(adapter.execute).not.toHaveBeenCalled();
	});

	it("FLY-2901 kill switch: the legacy refusal keeps today's sentence (plus dirty-path diagnostics)", async () => {
		const path = makeRealWorktree();
		created.push(path);
		const wt = makeWtManager({
			registered: true,
			path,
			takeover: {
				kind: "refused",
				reason: "kill_switch",
				class: "head_diverged",
				dirtyPaths: [],
				dirtyPathsOverflow: 0,
				completedRescues: [],
				head: `deadbeef${"0".repeat(32)}`,
				clean: true,
				legacy: true,
			},
		});
		const { result } = await run(
			wt,
			makeGitChecker({ clean: true, head: `deadbeef${"0".repeat(32)}` }),
			{ sessionRole: "implement", shareParentBranch: true, startPoint: HEAD },
		);
		expect(result.success).toBe(false);
		expect(result.failure?.failureKind).toBe("worktree_takeover_failed");
		expect(result.failure?.failureReason).toBe(
			`worktree_takeover_failed: shared branch-B worktree ${path} is not reusable in place (clean=true, head=deadbeef${"0".repeat(32)}, expected=${HEAD}) — refusing to reuse an active phase worktree; a parked phase may hold uncommitted work`,
		);
	});

	it("FLY-2901: a throwing transaction fails the launch as worktree_takeover_failed", async () => {
		const path = makeRealWorktree();
		created.push(path);
		const wt = makeWtManager({
			registered: true,
			path,
			takeover: async () => {
				throw new Error("create failed\nwith detail");
			},
		});
		const { result } = await run(
			wt,
			makeGitChecker({ clean: true, head: HEAD }),
			{ sessionRole: "qa", shareParentBranch: true, startPoint: HEAD },
		);
		expect(result.failure?.failureKind).toBe("worktree_takeover_failed");
		expect(result.error).toContain("takeover transaction threw at");
		expect(result.error).toContain("create failed with detail");
	});

	it("FLY-2901: not registered + absent → the transaction's create path (Blueprint never runs removeIfExists itself)", async () => {
		const path = makeRealWorktree();
		created.push(path);
		const wt = makeWtManager({
			registered: false,
			path,
			takeover: {
				kind: "created",
				worktree: {
					projectName: "flywheel",
					issueId: "FLY-887",
					worktreePath: path,
					branch: "feat/branch-b",
					mainRepoPath: "/project",
					generation: "fresh-generation",
				},
			},
		});
		const { result, emit } = await run(
			wt,
			makeGitChecker({ clean: true, head: HEAD }),
			{ sessionRole: "implement", shareParentBranch: true, startPoint: HEAD },
		);
		expect(result.success).toBe(true);
		expect(wt.removeIfExists).not.toHaveBeenCalled();
		expect(wt.create).not.toHaveBeenCalled();
		expect(emit).toHaveBeenCalledWith(expect.anything(), path, {
			branch: "feat/branch-b",
			generation: "fresh-generation",
		});
	});

	it("FLY-2901: a rescued takeover launches on the carried worktree and injects the rescue prompt section", async () => {
		const path = makeRealWorktree();
		created.push(path);
		const rescueTip = "b".repeat(40);
		const manifest: TakeoverRescueManifest = {
			schema: "fly-2901.takeover-rescue.v1",
			runId: "run-1",
			issueKey: "FLY-887",
			successorExec: "exec-take",
			predecessors: [],
			canonicalPath: path,
			branch: "feat/branch-b",
			generationBefore: "gen-old",
			class: "dirty",
			startPoint: HEAD,
			headBefore: HEAD,
			target: HEAD,
			remoteTip: null,
			rescues: [
				{
					kind: "dirty",
					localRef:
						"refs/flywheel/rescue/run-1/p/exec-take/20260925T000000Z/dirty",
					remoteBranch:
						"flywheel-rescue/FLY-887/p-exec-tak-20260925T000000Z-dirty",
					tip: rescueTip,
				},
			],
			snapshot: { stagedCommit: "c".repeat(40), worktreeCommit: rescueTip },
			nestedMoves: [],
			fingerprint3: "f3",
			fingerprints: { first: "f1", second: "f2", third: "f3" },
			generationCarried: false,
			stamp: "20260925T000000Z",
			at: "2026-09-25T00:00:00.000Z",
		};
		const pointer = `event:worktree_takeover_rescued:${"e".repeat(64)} refs:${manifest.rescues[0]!.remoteBranch}@${rescueTip}`;
		const wt = makeWtManager({
			registered: true,
			path,
			takeover: {
				kind: "rescued",
				worktree: {
					projectName: "flywheel",
					issueId: "FLY-887",
					worktreePath: path,
					branch: "feat/branch-b",
					mainRepoPath: "/project",
					generation: "gen-old",
				},
				evidence: {
					eventUid: `worktree_takeover_rescued:${"e".repeat(64)}`,
					manifest,
					manifestPath:
						"/state/takeover-rescue/run-1/exec-take/20260925T000000Z/manifest.json",
					manifestSha256: "d".repeat(64),
					mirrorJsonPath: `${path}/.flywheel/runs/takeover/exec-take.json`,
					mirrorMdPath: `${path}/.flywheel/runs/takeover/exec-take.md`,
					pointer,
					resumed: false,
				},
			},
		});
		const { result, emit, adapter } = await run(
			wt,
			makeGitChecker({ clean: true, head: HEAD }),
			{ sessionRole: "implement", shareParentBranch: true, startPoint: HEAD },
		);
		expect(result.success).toBe(true);
		expect(emit).toHaveBeenCalledWith(expect.anything(), path, {
			branch: "feat/branch-b",
			generation: "gen-old",
		});
		const prompt = String(
			(adapter.execute as ReturnType<typeof vi.fn>).mock.calls[0]![0].prompt,
		);
		expect(prompt).toContain("## Worktree takeover rescue");
		expect(prompt).toContain(`--pointer 'rescue=${pointer}'`);
		expect(prompt).toContain(
			`git diff --binary ${HEAD} ${"c".repeat(40)} | git apply --index`,
		);
		expect(prompt).toContain(
			`git diff --binary ${"c".repeat(40)} ${rescueTip} | git apply`,
		);
	});

	it("FLY-2901: a Bridge-local emitter becomes the transaction recorder, bound to this launch's envelope", async () => {
		const path = makeRealWorktree();
		created.push(path);
		const wt = makeWtManager({ registered: true, path });
		const loadPendingTakeoverRescue = vi.fn(async () => []);
		const recordTakeoverRescue = vi.fn(async () => {});
		const recordTakeoverCleaned = vi.fn(async () => {});
		await run(
			wt,
			makeGitChecker({ clean: true, head: HEAD }),
			{ sessionRole: "implement", shareParentBranch: true, startPoint: HEAD },
			{
				loadPendingTakeoverRescue,
				recordTakeoverRescue,
				recordTakeoverCleaned,
			},
		);
		const input = (wt.runTakeoverTransaction as ReturnType<typeof vi.fn>).mock
			.calls[0]![0];
		await input.recorder.loadPendingTakeoverRescue({
			runId: "run-1",
			canonicalPath: path,
		});
		expect(loadPendingTakeoverRescue).toHaveBeenCalledWith(
			expect.objectContaining({ executionId: "exec-take" }),
			{ runId: "run-1", canonicalPath: path },
		);
	});

	it("FLY-1257 review R1: design retry with startPoint reuses the registered branch-B worktree", async () => {
		const path = makeRealWorktree();
		created.push(path);
		const wt = makeWtManager({ registered: true, path });
		const { result } = await run(
			wt,
			makeGitChecker({ clean: true, head: HEAD }),
			{ sessionRole: "design", shareParentBranch: true, startPoint: HEAD },
		);
		expect(result.success).toBe(true);
		expect(wt.runTakeoverTransaction).toHaveBeenCalledTimes(1);
		expect(wt.removeIfExists).not.toHaveBeenCalled();
		expect(wt.create).not.toHaveBeenCalled();
	});

	it("byte-compat: fresh design without startPoint uses the legacy create path", async () => {
		const path = makeRealWorktree();
		created.push(path);
		const wt = makeWtManager({ registered: true, path });
		const { result } = await run(
			wt,
			makeGitChecker({ clean: true, head: HEAD }),
			{
				sessionRole: "design",
				shareParentBranch: true,
			},
		);
		expect(result.success).toBe(true);
		expect(wt.runTakeoverTransaction).not.toHaveBeenCalled();
		expect(wt.create).toHaveBeenCalled();
	});

	it("fresh root implement without startPoint uses the legacy create path", async () => {
		const path = makeRealWorktree();
		created.push(path);
		const wt = makeWtManager({ registered: true, path });
		const { result } = await run(
			wt,
			makeGitChecker({ clean: true, head: HEAD }),
			{
				sessionRole: "implement",
				shareParentBranch: true,
			},
		);
		expect(result.success).toBe(true);
		expect(wt.runTakeoverTransaction).not.toHaveBeenCalled();
		expect(wt.removeIfExists).toHaveBeenCalled();
		expect(wt.create).toHaveBeenCalledWith(
			expect.objectContaining({ startPoint: undefined }),
		);
	});

	it("FLY-1718 continuity startPoint does not turn a design dispatch into a phase takeover", async () => {
		const path = makeRealWorktree();
		created.push(path);
		const wt = makeWtManager({ registered: true, path });
		const { result } = await run(
			wt,
			makeGitChecker({ clean: true, head: HEAD }),
			{
				sessionRole: "design",
				shareParentBranch: true,
				startPoint: HEAD,
				continuityInherit: {
					branch: "flywheel-FLY-1718",
					sha: HEAD,
				},
			},
		);
		expect(result.success).toBe(true);
		expect(wt.runTakeoverTransaction).not.toHaveBeenCalled();
		expect(wt.removeIfExists).toHaveBeenCalled();
		expect(wt.create).toHaveBeenCalledWith(
			expect.objectContaining({ startPoint: HEAD }),
		);
	});

	it("standalone run without shareParentBranch uses the create path", async () => {
		const path = makeRealWorktree();
		created.push(path);
		const wt = makeWtManager({ registered: true, path });
		const { result } = await run(
			wt,
			makeGitChecker({ clean: true, head: HEAD }),
			{ sessionRole: "main", startPoint: HEAD },
		);
		expect(result.success).toBe(true);
		expect(wt.runTakeoverTransaction).not.toHaveBeenCalled();
		expect(wt.create).toHaveBeenCalled();
	});

	it("process-body resume reuses a registered generic worktree in place even when dirty", async () => {
		const path = makeRealWorktree();
		created.push(path);
		const wt = makeWtManager({ registered: true, path });
		const gitChecker = makeGitChecker({ clean: false, head: HEAD });
		const { result } = await run(wt, gitChecker, {
			sessionRole: "main",
			shareParentBranch: true,
			startPoint: HEAD,
			workflowProcessLifecycle: {
				mode: "resume",
				generation: 2,
				demandId: "rework-1",
				expectedSessionId: "session-1",
				expectedModel: "sonnet",
				expectedCwd: path,
			},
		});

		expect(result.success).toBe(true);
		expect(wt.isRegistered).toHaveBeenCalled();
		expect(wt.removeIfExists).not.toHaveBeenCalled();
		expect(wt.create).not.toHaveBeenCalled();
		expect(gitChecker.assertCleanTree).not.toHaveBeenCalled();
	});

	it("process-body resume reports a missing exact worktree as physically absent", async () => {
		const path = makeRealWorktree();
		created.push(path);
		const wt = makeWtManager({ registered: false, path });
		const { result } = await run(
			wt,
			makeGitChecker({ clean: true, head: HEAD }),
			{
				sessionRole: "main",
				shareParentBranch: true,
				startPoint: HEAD,
				workflowProcessLifecycle: {
					mode: "resume",
					generation: 2,
					demandId: "rework-1",
					expectedSessionId: "session-1",
					expectedModel: "sonnet",
					expectedCwd: path,
				},
			},
		);

		expect(result).toMatchObject({
			success: false,
			error: "workflow_process_resume_worktree_mismatch",
			launchFailure: {
				code: "LAUNCH_PRECOMMIT_FAILED",
				reason: "workflow_process_resume_worktree_mismatch",
				physicalEvidence: "absent",
			},
		});
	});

	it("resume launch quarantines and rebuilds instead of taking over in place", async () => {
		const path = makeRealWorktree();
		created.push(path);
		const wt = makeWtManager({ registered: true, path });
		const prepareWorkflowIssueDelivery = vi.fn();
		const { result, adapter } = await run(
			wt,
			makeGitChecker({ clean: true, head: HEAD }),
			{
				sessionRole: "implement",
				shareParentBranch: true,
				startPoint: HEAD,
				workflowResume: {
					runId: "run-1",
					admissionKey: "admission-1",
					sourceAttachmentId: "attachment-1",
					anchorRef: "refs/flywheel/checkpoints/run-1/attachment-1",
					anchorCommit: HEAD,
					frozenBody: "Frozen issue body",
				},
				prepareWorkflowIssueDelivery,
			},
		);

		expect(result.success).toBe(true);
		expect(wt.quarantineAndRebuild).toHaveBeenCalledWith({
			mainRepoPath: "/project",
			projectName: "eng",
			issueId: "FLY-887",
			runId: "run-1",
			admissionKey: "admission-1",
			anchorRef: "refs/flywheel/checkpoints/run-1/attachment-1",
			anchorCommit: HEAD,
		});
		expect(wt.removeIfExists).not.toHaveBeenCalled();
		expect(wt.create).not.toHaveBeenCalled();
		expect(prepareWorkflowIssueDelivery).toHaveBeenCalledWith({
			sourceKind: "frozen_replay",
			body: "Frozen issue body",
			admissionKey: "admission-1",
			sourceAttachmentId: "attachment-1",
			anchorCommit: HEAD,
		});
		expect(adapter.execute).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: expect.stringContaining("Frozen issue body"),
			}),
		);
		expect(adapter.execute).not.toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: expect.stringContaining("Description for FLY-887"),
			}),
		);
	});

	it("resume launch fails closed when startPoint does not match the admitted anchor", async () => {
		const path = makeRealWorktree();
		created.push(path);
		const wt = makeWtManager({ registered: true, path });
		const { result, adapter } = await run(
			wt,
			makeGitChecker({ clean: true, head: HEAD }),
			{
				sessionRole: "implement",
				shareParentBranch: true,
				startPoint: "f".repeat(40),
				workflowResume: {
					runId: "run-1",
					admissionKey: "admission-1",
					sourceAttachmentId: "attachment-1",
					anchorRef: "refs/flywheel/checkpoints/run-1/attachment-1",
					anchorCommit: HEAD,
					frozenBody: "frozen",
				},
			},
		);

		expect(result).toMatchObject({ success: false });
		expect(result.error).toContain("resume_start_point_mismatch");
		expect(wt.quarantineAndRebuild).not.toHaveBeenCalled();
		expect(adapter.execute).not.toHaveBeenCalled();
	});
});
