/**
 * FLY-887 — Blueprint three-stage keep-alive PROMPT changes.
 *
 * Default ON: the Design + Implement phases PARK (stay alive to ship) instead of
 * exiting at their handoff, and every phase self-checks the shared-worktree TURN
 * (`flywheel-comm turn`) before writing. `FLYWHEEL_THREE_STAGE_KEEPALIVE=0`
 * reverts to the legacy close-and-respawn prompt (byte-compat). The single-session
 * prompt is never affected (no shareParentBranch).
 */

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
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BlueprintContext, ShellRunner } from "../Blueprint.js";
import { Blueprint } from "../Blueprint.js";
import type { GitResultChecker } from "../GitResultChecker.js";
import { PreHydrator } from "../PreHydrator.js";
import type { WorktreeManager } from "../WorktreeManager.js";

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
function makeMockGitChecker() {
	return {
		assertCleanTree: vi.fn(async () => {}),
		captureBaseline: vi.fn(async () => "abc123"),
		check: vi.fn(async () => ({
			hasNewCommits: true,
			commitCount: 1,
			filesChanged: 3,
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
			async (
				_ctx: AdapterExecutionContext,
			): Promise<AdapterExecutionResult> => ({
				success: true,
				sessionId: "sess-uuid",
				tmuxWindow: "flywheel:@42",
				durationMs: 5000,
			}),
		),
	};
}

const cleanups: string[] = [];
afterEach(() => {
	while (cleanups.length) {
		rmSync(cleanups.pop() as string, { recursive: true, force: true });
	}
});

function makeRealWorktree(): string {
	const p = join(
		tmpdir(),
		`fly887-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	mkdirSync(p, { recursive: true });
	execFileSync("git", ["init", "-q"], { cwd: p });
	cleanups.push(p);
	return p;
}

function makeWtManager(worktreePath: string) {
	return {
		expectedWorktree: vi.fn(() => ({
			path: worktreePath,
			branch: "flywheel-FLY-887",
		})),
		isRegistered: vi.fn(async () => false),
		removeIfExists: vi.fn(async () => true),
		create: vi.fn(async () => ({
			projectName: "proj",
			issueId: "FLY-887",
			worktreePath,
			branch: "flywheel-FLY-887",
			mainRepoPath: "/tmp/fly887-main",
		})),
	} as unknown as WorktreeManager;
}

async function buildPrompt(
	ctxOverrides: Partial<BlueprintContext> = {},
): Promise<string> {
	const call = await buildExecutionContext(ctxOverrides);
	return call.appendSystemPrompt ?? "";
}

type CapturedPhaseContext = AdapterExecutionContext & {
	phaseKeepAlive?: { role: "design" | "implement" | "qa" };
};

async function buildExecutionContext(
	ctxOverrides: Partial<BlueprintContext> = {},
): Promise<CapturedPhaseContext> {
	const adapter = makeMockAdapter();
	const worktreePath = makeRealWorktree();
	const blueprint = new Blueprint(
		makeHydrator(),
		makeMockGitChecker(),
		() => adapter,
		makeMockShell(),
		makeWtManager(worktreePath),
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{ brainstorm: { enabled: true }, approve_to_ship: { enabled: true } },
	);
	const ctx: BlueprintContext = {
		teamName: "eng",
		runnerName: "claude",
		leadId: "flywheel-eng-lead",
		...ctxOverrides,
	};
	await blueprint.run(makeNode(), "/tmp/fly887-blueprint-test", ctx);
	return (adapter.execute as ReturnType<typeof vi.fn>).mock
		.calls[0]![0] as CapturedPhaseContext;
}

describe("FLY-1269 adapter phase keep-alive identity", () => {
	afterEach(() => {
		process.env.FLYWHEEL_THREE_STAGE_KEEPALIVE = undefined;
	});

	it.each(["design", "implement", "qa"] as const)(
		"codex %s phase receives its exact keep-alive role",
		async (role) => {
			const call = await buildExecutionContext({
				runnerBackend: "codex-tmux",
				sessionRole: role,
				shareParentBranch: true,
			});
			expect(call.phaseKeepAlive).toEqual({ role });
		},
	);

	it("Auto-QA remains outside the three-stage phase lifetime", async () => {
		const call = await buildExecutionContext({
			runnerBackend: "codex-tmux",
			sessionRole: "qa",
			shareParentBranch: true,
			qaContext: {
				parentExecutionId: "parent-exec",
				prHeadSha: "deadbeef",
			},
		});
		expect(call.phaseKeepAlive).toBeUndefined();
	});

	it("single-session Codex receives no phase lifetime", async () => {
		const call = await buildExecutionContext({ runnerBackend: "codex-tmux" });
		expect(call.phaseKeepAlive).toBeUndefined();
	});

	it("kill-switch OFF removes the Codex phase lifetime", async () => {
		process.env.FLYWHEEL_THREE_STAGE_KEEPALIVE = "0";
		const call = await buildExecutionContext({
			runnerBackend: "codex-tmux",
			sessionRole: "design",
			shareParentBranch: true,
		});
		expect(call.phaseKeepAlive).toBeUndefined();
	});

	it("Claude three-stage phases keep their existing adapter context", async () => {
		const call = await buildExecutionContext({
			runnerBackend: "claude-tmux",
			sessionRole: "implement",
			shareParentBranch: true,
		});
		expect(call.phaseKeepAlive).toBeUndefined();
	});
});

describe("FLY-887 keep-alive prompts — default ON", () => {
	afterEach(() => {
		process.env.FLYWHEEL_THREE_STAGE_KEEPALIVE = undefined;
	});

	it("design phase parks + carries the TURN self-check contract", async () => {
		const p = await buildPrompt({
			sessionRole: "design",
			shareParentBranch: true,
		});
		expect(p).toContain("Three-stage keep-alive (design phase)");
		expect(p).toContain("park --exec-id");
		expect(p).toContain("parked until ship");
		expect(p).toContain("turn --exec-id");
		// executable spelling only — never the non-existent declare-state subcommand
		expect(p).not.toContain("declare-state");
	});

	it("implement phase parks + carries the QA-fix wake + TURN contract", async () => {
		const p = await buildPrompt({
			sessionRole: "implement",
			shareParentBranch: true,
		});
		expect(p).toContain("Three-stage keep-alive (implement phase)");
		expect(p).toContain("park --exec-id");
		expect(p).toContain("parked awaiting QA");
		expect(p).toContain("turn --exec-id");
		expect(p).toContain("ALREADY COMMITTED on this branch");
		expect(p).not.toContain("declare-state");
	});
});

describe("FLY-887 keep-alive prompts — kill-switch OFF reverts to legacy", () => {
	afterEach(() => {
		process.env.FLYWHEEL_THREE_STAGE_KEEPALIVE = undefined;
	});

	it("design phase has NO park epilogue when keep-alive=0", async () => {
		process.env.FLYWHEEL_THREE_STAGE_KEEPALIVE = "0";
		const p = await buildPrompt({
			sessionRole: "design",
			shareParentBranch: true,
		});
		expect(p).toContain("DESIGN phase");
		expect(p).not.toContain("Three-stage keep-alive");
		expect(p).not.toContain("park --exec-id");
	});

	it("implement phase has NO park epilogue when keep-alive=0", async () => {
		process.env.FLYWHEEL_THREE_STAGE_KEEPALIVE = "0";
		const p = await buildPrompt({
			sessionRole: "implement",
			shareParentBranch: true,
		});
		expect(p).toContain("IMPLEMENT phase");
		expect(p).not.toContain("Three-stage keep-alive");
	});

	it("QA FAIL reverts to the legacy close-and-respawn wording when keep-alive=0", async () => {
		process.env.FLYWHEEL_THREE_STAGE_KEEPALIVE = "0";
		const p = await buildPrompt({ sessionRole: "qa", shareParentBranch: true });
		expect(p).toContain("Do NOT park for retest");
		expect(p).toContain("the pipeline closes this session");
		expect(p).not.toContain("RE-TEST wake");
	});
});

describe("FLY-887 byte-compat: single-session prompt is never affected", () => {
	it("no shareParentBranch → no keep-alive/park lines regardless of env", async () => {
		const p = await buildPrompt({});
		expect(p).toContain("Create a feature branch");
		expect(p).not.toContain("Three-stage keep-alive");
		expect(p).not.toContain("turn --exec-id");
	});
});
