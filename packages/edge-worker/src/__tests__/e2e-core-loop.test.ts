/**
 * E2E Integration Test: Core Loop Pipeline (v0.1.1 Interactive Mode)
 *
 * Tests the full Flywheel pipeline with mocked external services:
 * Linear issue → DagResolver → Blueprint (interactive) → Git check → success/fail
 *
 * Verification checklist:
 * - [x] Linear issue fetched and converted to DagNode
 * - [x] Blueprint: git preflight → hydrate → launch runner → git SHA check
 * - [x] Success = commitCount > 0 (via GitResultChecker)
 * - [x] shelve() correctly blocks downstream (2-issue chain)
 * - [x] Dispatch halts on first failure
 * - [x] Chain dependency order preserved
 */
import { describe, expect, it, vi } from "vitest";
import { DagResolver, LinearGraphBuilder } from "flywheel-dag-resolver";
import type { DagNode, LinearIssueData } from "flywheel-dag-resolver";
import { PreHydrator } from "../PreHydrator.js";
import { Blueprint } from "../Blueprint.js";
import type { BlueprintContext, ShellRunner } from "../Blueprint.js";
import { GitResultChecker } from "../GitResultChecker.js";
import type { ExecFileFn } from "../GitResultChecker.js";
import { DagDispatcher } from "../DagDispatcher.js";
import type { IAdapter, AdapterExecutionResult } from "flywheel-core";

// ─── Mock Data ───────────────────────────────────

const MOCK_LINEAR_ISSUES: LinearIssueData[] = [
	{
		id: "GEO-101",
		state: { type: "unstarted" },
		relations: { nodes: [] },
	},
	{
		id: "GEO-102",
		state: { type: "unstarted" },
		relations: {
			nodes: [{ type: "blocks", relatedIssue: { id: "GEO-101" } }],
		},
	},
	{
		id: "GEO-103",
		state: { type: "completed" },
		relations: { nodes: [] },
	},
];

// ─── Helpers ─────────────────────────────────────

function makeAdapter(commitCount: number): IAdapter {
	let callCount = 0;
	return {
		type: "mock",
		supportsStreaming: false,
		checkEnvironment: async () => ({ healthy: true, message: "mock" }),
		execute: vi.fn(async (): Promise<AdapterExecutionResult> => {
			callCount++;
			return {
				success: true,
				sessionId: `session-${callCount}`,
				tmuxWindow: `flywheel:@${callCount}`,
				durationMs: 5000,
			};
		}),
	};
}

function makeGitChecker(options: {
	commitCount?: number;
	baseSha?: string;
} = {}): GitResultChecker {
	const { commitCount = 1, baseSha = "abc123" } = options;
	return {
		assertCleanTree: vi.fn(async () => {}),
		captureBaseline: vi.fn(async () => baseSha),
		check: vi.fn(async () => ({
			hasNewCommits: commitCount > 0,
			commitCount,
			filesChanged: commitCount > 0 ? 3 : 0,
			commitMessages: commitCount > 0 ? ["feat: implement"] : [],
		})),
	} as unknown as GitResultChecker;
}

function makeShell(): ShellRunner {
	return {
		execFile: vi.fn(async () => ({ stdout: "", exitCode: 0 })),
	};
}

function makeHydrator() {
	return new PreHydrator(
		async (id) => ({
			title: `Issue ${id}`,
			description: `Description for ${id}`,
		}),
	);
}

function makeContext(): BlueprintContext {
	return {
		executionId: "test-exec-id",
		teamName: "eng",
		runnerName: "claude",
	};
}

// ─── E2E Tests ───────────────────────────────────

describe("Core Loop E2E", () => {
	describe("Single issue pipeline", () => {
		it("Linear issue → DagNode → Blueprint → git commits → success", async () => {
			// Step 1: Convert Linear issues to DAG nodes
			const builder = new LinearGraphBuilder();
			const dagNodes = builder.build(MOCK_LINEAR_ISSUES);
			expect(dagNodes).toHaveLength(2);

			// Step 2: Build DAG resolver
			const resolver = new DagResolver(dagNodes);
			expect(resolver.remaining()).toBe(2);
			const ready = resolver.getReady();
			expect(ready.map((n) => n.id)).toEqual(["GEO-101"]);

			// Step 3: Set up Blueprint with mocked services
			const adapter = makeAdapter(1);
			const blueprint = new Blueprint(
				makeHydrator(),
				makeGitChecker({ commitCount: 1 }),
				() => adapter,
				makeShell(),
			);

			// Step 4: Run Blueprint for first ready node
			const result = await blueprint.run(
				ready[0]!,
				"/geoforge3d",
				makeContext(),
			);

			expect(result.success).toBe(true);
			expect(result.sessionId).toBeDefined();

			// Verify adapter was called with hydrated prompt
			const runCall = (adapter.execute as ReturnType<typeof vi.fn>).mock
				.calls[0]![0];
			expect(runCall.prompt).toContain("GEO-101");
			expect(runCall.prompt).toContain("Issue GEO-101");

			// Step 5: Mark done and verify next node unblocked
			resolver.markDone("GEO-101");
			expect(resolver.remaining()).toBe(1);
			const nextReady = resolver.getReady();
			expect(nextReady.map((n) => n.id)).toEqual(["GEO-102"]);
		});
	});

	describe("Full DAG dispatch", () => {
		it("processes chain in correct order via DagDispatcher", async () => {
			const dagNodes = new LinearGraphBuilder().build(MOCK_LINEAR_ISSUES);
			const resolver = new DagResolver(dagNodes);

			const adapter = makeAdapter(1);
			const blueprint = new Blueprint(
				makeHydrator(),
				makeGitChecker({ commitCount: 1 }),
				() => adapter,
				makeShell(),
			);

			const dispatcher = new DagDispatcher(
				resolver,
				blueprint,
				"/geoforge3d",
				() => makeContext(),
			);

			const result = await dispatcher.dispatch();

			expect(result.completed.sort()).toEqual(["GEO-101", "GEO-102"]);
			expect(result.shelved).toEqual([]);
			expect(result.halted).toBe(false);
		});
	});

	describe("Shelve blocks downstream + halt", () => {
		it("shelving A blocks B and halts dispatch", async () => {
			const nodes: DagNode[] = [
				{ id: "A", blockedBy: [] },
				{ id: "B", blockedBy: ["A"] },
			];
			const resolver = new DagResolver(nodes);

			const adapter = makeAdapter(0);
			const blueprint = new Blueprint(
				makeHydrator(),
				makeGitChecker({ commitCount: 0 }), // no commits = failure
				() => adapter,
				makeShell(),
			);

			const executedNodes: string[] = [];
			const dispatcher = new DagDispatcher(
				resolver,
				blueprint,
				"/p",
				() => makeContext(),
			);
			dispatcher.onNodeComplete = async (nodeId) => {
				executedNodes.push(nodeId);
			};

			const result = await dispatcher.dispatch();

			expect(result.shelved).toEqual(["A"]);
			expect(result.completed).toEqual([]);
			expect(result.halted).toBe(true);
			expect(executedNodes).toEqual(["A"]);
			expect(resolver.remaining()).toBe(1);
		});
	});

	describe("DAG correctly skips completed issues", () => {
		it("completed Linear issues are filtered by LinearGraphBuilder", () => {
			const builder = new LinearGraphBuilder();
			const nodes = builder.build(MOCK_LINEAR_ISSUES);

			const ids = nodes.map((n) => n.id);
			expect(ids).not.toContain("GEO-103");
			expect(ids).toHaveLength(2);
		});

		it("canceled issues are also filtered", () => {
			const issues: LinearIssueData[] = [
				...MOCK_LINEAR_ISSUES,
				{
					id: "GEO-104",
					state: { type: "canceled" },
					relations: { nodes: [] },
				},
			];
			const builder = new LinearGraphBuilder();
			const nodes = builder.build(issues);

			expect(nodes.map((n) => n.id)).not.toContain("GEO-104");
			expect(nodes).toHaveLength(2);
		});
	});

	describe("Unknown blockers", () => {
		it("unknown blockers emit warnings and block execution", () => {
			const nodes: DagNode[] = [
				{ id: "A", blockedBy: ["EXTERNAL-REVIEW"] },
				{ id: "B", blockedBy: [] },
			];
			const resolver = new DagResolver(nodes);

			const warnings = resolver.getWarnings();
			expect(warnings).toContainEqual(
				expect.objectContaining({
					type: "unknown_blocker",
					nodeId: "A",
					blockerId: "EXTERNAL-REVIEW",
				}),
			);

			expect(resolver.getReady().map((n) => n.id)).toEqual(["B"]);

			resolver.resolveExternalBlocker("A", "EXTERNAL-REVIEW");
			expect(
				resolver
					.getReady()
					.map((n) => n.id)
					.sort(),
			).toEqual(["A", "B"]);
		});
	});
});
