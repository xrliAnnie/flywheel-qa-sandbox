/**
 * FLY-887 — Blueprint shared-workflow keep-alive prompt changes.
 *
 * Default ON: the Design + Implement phases PARK (stay alive to ship) instead of
 * exiting at their handoff, and every phase self-checks the shared-worktree TURN
 * (`flywheel-comm turn`) before writing. The single-session prompt is never
 * affected (no shareParentBranch).
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

	it("single-session Codex receives no phase lifetime", async () => {
		const call = await buildExecutionContext({ runnerBackend: "codex-tmux" });
		expect(call.phaseKeepAlive).toBeUndefined();
	});

	it("Claude shared-DAG workflows keep their existing adapter context", async () => {
		const call = await buildExecutionContext({
			runnerBackend: "claude-tmux",
			sessionRole: "implement",
			shareParentBranch: true,
		});
		expect(call.phaseKeepAlive).toBeUndefined();
	});
});

describe("FLY-887 keep-alive prompts — default ON", () => {
	it("design phase parks + carries the TURN self-check contract", async () => {
		const p = await buildPrompt({
			sessionRole: "design",
			shareParentBranch: true,
		});
		expect(p).toContain("DAG workflow keep-alive (design phase)");
		expect(p).toContain("park --exec-id");
		expect(p).toContain("parked until ship");
		expect(p).toContain("turn --exec-id");
		expect(p).toContain("TURN WAIT LAW (all runner vendors)");
		expect(p).toContain(
			"not-yours` is a normal wait state and is NEVER blocked",
		);
		expect(p).toContain("60–90 seconds");
		// executable spelling only — never the non-existent declare-state subcommand
		expect(p).not.toContain("declare-state");
	});

	it("implement phase parks + carries the QA-fix wake + TURN contract", async () => {
		const p = await buildPrompt({
			sessionRole: "implement",
			shareParentBranch: true,
		});
		expect(p).toContain("DAG workflow keep-alive (implement phase)");
		expect(p).toContain("park --exec-id");
		expect(p).toContain("parked awaiting QA");
		expect(p).toContain("turn --exec-id");
		expect(p).toContain("ALREADY COMMITTED on this branch");
		expect(p).toContain(
			"re-run the code review, then repeat the APPROVE GATE flow below",
		);
		expect(p).not.toContain(
			"re-request review (`gate approve_to_ship --no-block`",
		);
		expect(p).not.toContain("declare-state");
	});
});

describe("FLY-887 byte-compat: single-session prompt is never affected", () => {
	it("no shareParentBranch → no keep-alive/park lines regardless of env", async () => {
		const p = await buildPrompt({});
		expect(p).toContain("Create a feature branch");
		expect(p).not.toContain("DAG workflow keep-alive");
		expect(p).not.toContain("turn --exec-id");
	});
});
