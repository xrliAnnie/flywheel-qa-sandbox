import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
	IAdapter,
} from "flywheel-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BlueprintContext, ShellRunner } from "../Blueprint.js";
import { Blueprint, SHIP_MERGE_POLL_INTERVAL_SECONDS } from "../Blueprint.js";
import type { DagNode } from "../dag-node.js";
import type { GitResultChecker } from "../GitResultChecker.js";
import { PreHydrator } from "../PreHydrator.js";
import type { WorktreeManager } from "../WorktreeManager.js";

function makeNode(): DagNode {
	return { id: "FLY-1505", blockedBy: [] };
}

function makeHydrator() {
	return new PreHydrator(async () => ({
		title: "Runner ship poll window",
		description: "Preserve approval while a 25-minute ship job runs",
		labels: [],
	}));
}

function makeMockGitChecker() {
	return {
		assertCleanTree: vi.fn(async () => {}),
		captureBaseline: vi.fn(async () => "a".repeat(40)),
		check: vi.fn(async () => ({
			hasNewCommits: true,
			commitCount: 1,
			filesChanged: 1,
			commitMessages: ["fix: preserve ship approval"],
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
			async (
				_ctx: AdapterExecutionContext,
			): Promise<AdapterExecutionResult> => ({
				success: true,
				sessionId: "sess-1505",
				tmuxWindow: "flywheel:@1505",
				durationMs: 1,
			}),
		),
	};
}

const cleanups: string[] = [];
afterEach(() => {
	while (cleanups.length > 0) {
		rmSync(cleanups.pop() as string, { recursive: true, force: true });
	}
});

function makeRealWorktree(): string {
	const path = join(
		tmpdir(),
		`fly1505-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	mkdirSync(path, { recursive: true });
	execFileSync("git", ["init", "-q"], { cwd: path });
	cleanups.push(path);
	return path;
}

function makeWorktreeManager(worktreePath: string) {
	return {
		expectedWorktree: vi.fn(() => ({
			path: worktreePath,
			branch: "flywheel-FLY-1505",
		})),
		isRegistered: vi.fn(async () => false),
		removeIfExists: vi.fn(async () => true),
		create: vi.fn(async () => ({
			projectName: "flywheel",
			issueId: "FLY-1505",
			worktreePath,
			branch: "flywheel-FLY-1505",
			mainRepoPath: "/tmp/flywheel-main",
		})),
	} as unknown as WorktreeManager;
}

async function buildPrompt(
	ctxOverrides: Partial<BlueprintContext> = {},
): Promise<string> {
	const adapter = makeMockAdapter();
	const worktreePath = makeRealWorktree();
	const blueprint = new Blueprint(
		makeHydrator(),
		makeMockGitChecker(),
		() => adapter,
		makeMockShell(),
		makeWorktreeManager(worktreePath),
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{ brainstorm: { enabled: true }, approve_to_ship: { enabled: true } },
	);
	await blueprint.run(makeNode(), "/tmp/fly1505-blueprint", {
		teamName: "eng",
		runnerName: "claude",
		leadId: "flywheel-eng-lead",
		...ctxOverrides,
	});
	const call = (adapter.execute as ReturnType<typeof vi.fn>).mock
		.calls[0]![0] as AdapterExecutionContext;
	return call.appendSystemPrompt ?? "";
}

describe("FLY-1505 ship poll budget contract", () => {
	it("keeps exactly one workflow-owned timeout budget", () => {
		const workflowPath = fileURLToPath(
			new URL(
				"../../../../.github/workflows/ship-on-comment.yml",
				import.meta.url,
			),
		);
		const workflow = readFileSync(workflowPath, "utf8");
		const matches = [...workflow.matchAll(/timeout-minutes:\s*(\d+)/g)].map(
			(match) => Number(match[1]),
		);
		expect(matches).toHaveLength(1);
		expect(matches[0]).toBeGreaterThan(0);
		expect(SHIP_MERGE_POLL_INTERVAL_SECONDS).toBe(60);
	});

	it("follows this attempt's workflow run to its GitHub-owned terminal state", async () => {
		const prompt = await buildPrompt();
		expect(prompt).toContain("issuecomment-");
		expect(prompt).toContain("trigger_comment_id=<COOL_ID>");
		expect(prompt).toContain("status=started");
		expect(prompt).toContain("run_id=<SHIP_RUN_ID>");
		expect(prompt).toContain(
			"gh run view <SHIP_RUN_ID> --json status,conclusion",
		);
		expect(prompt).toContain("`queued` or `in_progress` means keep waiting");
		expect(prompt).toContain("`failure`, `cancelled`, or `timed_out`");
		expect(prompt).toContain(".github/workflows/ship-on-comment.yml");
		expect(prompt).toContain("timeout-minutes");
		expect(prompt).toContain("$((SHIP_TIMEOUT_MINUTES + 5))");
		expect(prompt).toContain(
			"Do not use an independent hard-coded ship deadline",
		);
		expect(prompt).toContain(
			"receipts with a DIFFERENT trigger_comment_id belong to an OLD attempt",
		);
		expect(prompt).toContain("NEVER run `complete --route blocked`");
		expect(prompt).toContain(
			"complete --route ship_attempt_failed --pr <NUMBER> --question-id <questionId from step a>",
		);
		expect(prompt).toContain("SHIP-STALLED");
		expect(prompt).toContain("SHIP-FAILED");
		expect(prompt).not.toContain("for up to 40 minutes");
		expect(prompt).not.toContain("after 40 minutes");
		expect(prompt).not.toContain("max 10 min");
		expect(prompt).not.toContain(
			"ship workflow did not merge in the poll window",
		);
	});

	it("keeps each runner variant at the checkpoint with its own durable wait posture", async () => {
		const phasePrompt = await buildPrompt({
			runnerBackend: "codex-tmux",
			sessionRole: "implement",
			shareParentBranch: true,
		});
		expect(phasePrompt).toContain("wait for a TURN-authorized wake");
		expect(phasePrompt).toContain("park --exec-id");

		const codexPrompt = await buildPrompt({ runnerBackend: "codex-tmux" });
		expect(codexPrompt).toContain(
			"keep polling your gates and inbox across turns",
		);

		const plainPrompt = await buildPrompt({ runnerBackend: "claude-tmux" });
		expect(plainPrompt).toContain("END YOUR TURN and wait idle for a wake");
	});
});
