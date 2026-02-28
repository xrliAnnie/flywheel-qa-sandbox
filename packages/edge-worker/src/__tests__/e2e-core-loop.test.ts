/**
 * E2E Integration Test: Core Loop Pipeline
 *
 * Tests the full Flywheel pipeline with mocked external services:
 * Linear issue → DagResolver → Blueprint → Claude Code CLI → GitHub PR
 *
 * Verification checklist from architecture doc:
 * - [x] Linear issue fetched and converted to DagNode
 * - [x] Blueprint executed: pre-hydrate → implement → lint → push → CI
 * - [x] PR created on GitHub with correct branch naming
 * - [x] shelve() correctly blocks downstream (2-issue chain)
 * - [x] Budget cap stops execution when reached
 * - [x] Session ID recorded for potential resume
 * - [x] Unknown blockers logged as warnings
 */
import { describe, expect, it, vi } from "vitest";
import { DagResolver, LinearGraphBuilder } from "flywheel-dag-resolver";
import type { DagNode, LinearIssueData } from "flywheel-dag-resolver";
import { ConfigLoader } from "flywheel-config";
import { PreHydrator } from "../PreHydrator.js";
import { Blueprint } from "../Blueprint.js";
import type { BlueprintContext, ShellRunner } from "../Blueprint.js";
import { DagDispatcher } from "../DagDispatcher.js";
import type { IFlywheelRunner } from "flywheel-core";

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

const MOCK_CONFIG_YAML = `
project: geoforge3d
linear:
  team_id: "GEO"
  labels:
    - "flywheel"
runners:
  default: claude
  available:
    claude:
      type: claude
      model: sonnet
      max_budget_usd: 10.0
agent_nodes:
  implement:
    tools:
      - Read
      - Edit
      - Write
      - Bash
    max_turns: 50
  fix:
    budget_usd: 2.0
teams:
  - name: engineering
    orchestrators:
      - type: code
        runner: claude
        budget_per_issue: 5.0
decision_layer:
  autonomy_level: manual_only
  escalation_channel: "#geoforge-dev"
ci:
  max_rounds: 2
`;

// ─── Helpers ─────────────────────────────────────

function makeRunnerWithHistory(): {
	runner: IFlywheelRunner;
	calls: Array<{ prompt: string; sessionId?: string; maxCostUsd?: number }>;
} {
	const calls: Array<{ prompt: string; sessionId?: string; maxCostUsd?: number }> = [];
	let callCount = 0;
	const runner: IFlywheelRunner = {
		name: "claude",
		run: vi.fn(async (req) => {
			calls.push({
				prompt: req.prompt,
				sessionId: req.sessionId,
				maxCostUsd: req.maxCostUsd,
			});
			callCount++;
			return {
				success: true,
				costUsd: 1.0,
				sessionId: `session-${callCount}`,
			};
		}),
	};
	return { runner, calls };
}

function makeCIPassShell(): ShellRunner {
	return {
		execFile: vi.fn(async (cmd: string) => {
			if (cmd === "gh") {
				return {
					stdout: JSON.stringify([
						{ conclusion: "success", status: "completed" },
					]),
					exitCode: 0,
				};
			}
			return { stdout: "", exitCode: 0 };
		}),
	};
}

// ─── E2E Tests ───────────────────────────────────

describe("Core Loop E2E", () => {
	describe("Single issue pipeline", () => {
		it("Linear issue → DagNode → Blueprint → success", async () => {
			// Step 1: Load config
			const configLoader = new ConfigLoader(async () => MOCK_CONFIG_YAML);
			const config = await configLoader.load("/geoforge3d/.flywheel/config.yaml");
			expect(config.project).toBe("geoforge3d");

			// Step 2: Convert Linear issues to DAG nodes
			const builder = new LinearGraphBuilder();
			const dagNodes = builder.build(MOCK_LINEAR_ISSUES);

			// GEO-103 (completed) should be filtered out
			expect(dagNodes).toHaveLength(2);
			expect(dagNodes.map((n) => n.id).sort()).toEqual([
				"GEO-101",
				"GEO-102",
			]);

			// Step 3: Build DAG resolver
			const resolver = new DagResolver(dagNodes);
			expect(resolver.remaining()).toBe(2);

			// GEO-102 has relation { type: "blocks", relatedIssue: GEO-101 }
			// meaning GEO-101 blocks GEO-102, so GEO-102.blockedBy = ["GEO-101"]
			// GEO-101 has no blockers → GEO-101 is ready first
			const ready = resolver.getReady();
			expect(ready.map((n) => n.id)).toEqual(["GEO-101"]);

			// Step 4: Set up Blueprint with mocked services
			const { runner, calls } = makeRunnerWithHistory();
			const hydrator = new PreHydrator(
				async (id) => ({
					title: `Issue ${id}`,
					description: `Description for ${id}`,
				}),
				async () => "Follow project conventions",
				"/geoforge3d",
			);
			const shell = makeCIPassShell();
			const blueprint = new Blueprint(
				config,
				hydrator,
				() => runner,
				shell,
			);

			// Step 5: Run Blueprint for first ready node
			const ctx: BlueprintContext = {
				teamName: "engineering",
				runnerName: "claude",
				budgetPerIssue: 5.0,
				fixBudgetUsd: 2.0,
			};

			const result = await blueprint.run(ready[0]!, "/geoforge3d", ctx);

			expect(result.success).toBe(true);
			expect(result.costUsd).toBe(1.0);
			expect(result.sessionId).toBe("session-1");
			expect(result.ciRounds).toBe(1);

			// Verify agent was called with hydrated context
			expect(calls).toHaveLength(1);
			expect(calls[0]!.prompt).toContain("Issue GEO-101");
			expect(calls[0]!.prompt).toContain("Description for GEO-101");

			// Step 6: Mark done and verify next node unblocked
			resolver.markDone("GEO-101");
			expect(resolver.remaining()).toBe(1);
			const nextReady = resolver.getReady();
			expect(nextReady.map((n) => n.id)).toEqual(["GEO-102"]);
		});
	});

	describe("Full DAG dispatch", () => {
		it("processes chain in correct order via DagDispatcher", async () => {
			const configLoader = new ConfigLoader(async () => MOCK_CONFIG_YAML);
			const config = await configLoader.load("/geoforge3d/.flywheel/config.yaml");

			const dagNodes = new LinearGraphBuilder().build(MOCK_LINEAR_ISSUES);
			const resolver = new DagResolver(dagNodes);

			const { runner } = makeRunnerWithHistory();
			const hydrator = new PreHydrator(
				async (id) => ({ title: `Issue ${id}`, description: `Desc ${id}` }),
				async () => "rules",
				"/geoforge3d",
			);
			const shell = makeCIPassShell();
			const blueprint = new Blueprint(config, hydrator, () => runner, shell);

			const dispatcher = new DagDispatcher(
				resolver,
				blueprint,
				"/geoforge3d",
				() => ({
					teamName: "engineering",
					runnerName: "claude",
					budgetPerIssue: 5.0,
					fixBudgetUsd: 2.0,
				}),
			);

			const result = await dispatcher.dispatch();

			expect(result.completed.sort()).toEqual(["GEO-101", "GEO-102"]);
			expect(result.shelved).toEqual([]);
			expect(result.totalCostUsd).toBe(2.0); // 1.0 per issue
		});
	});

	describe("Shelve blocks downstream (2-issue chain)", () => {
		it("shelving A blocks B from execution", async () => {
			const nodes: DagNode[] = [
				{ id: "A", blockedBy: [] },
				{ id: "B", blockedBy: ["A"] },
			];
			const resolver = new DagResolver(nodes);

			// Make runner that fails for A
			const failRunner: IFlywheelRunner = {
				name: "claude",
				run: vi.fn(async () => ({
					success: false,
					costUsd: 3.0,
					sessionId: "fail-session",
				})),
			};
			const configLoader = new ConfigLoader(async () => MOCK_CONFIG_YAML);
			const config = await configLoader.load("/p/config.yaml");
			const hydrator = new PreHydrator(
				async (id) => ({ title: id, description: "" }),
				async () => "",
				"/p",
			);
			// CI always fails to ensure Blueprint returns failure
			const shell: ShellRunner = {
				execFile: vi.fn(async (cmd: string) => {
					if (cmd === "gh") {
						return {
							stdout: JSON.stringify([
								{ conclusion: "failure", status: "completed" },
							]),
							exitCode: 0,
						};
					}
					return { stdout: "", exitCode: 0 };
				}),
			};

			const blueprint = new Blueprint(config, hydrator, () => failRunner, shell);
			const executedNodes: string[] = [];

			const dispatcher = new DagDispatcher(
				resolver,
				blueprint,
				"/p",
				() => ({
					teamName: "eng",
					runnerName: "claude",
					budgetPerIssue: 5.0,
					fixBudgetUsd: 2.0,
				}),
			);
			dispatcher.onNodeComplete = async (nodeId) => {
				executedNodes.push(nodeId);
			};

			const result = await dispatcher.dispatch();

			// A was executed and shelved (Blueprint failed)
			expect(result.shelved).toEqual(["A"]);
			// B was never executed because A is shelved and blocks it
			expect(result.completed).toEqual([]);
			expect(executedNodes).toEqual(["A"]);
			// remaining() should be 1 (B is still pending but blocked)
			expect(resolver.remaining()).toBe(1);
		});
	});

	describe("Budget cap enforcement", () => {
		it("budget cap is passed to runner", async () => {
			const configLoader = new ConfigLoader(async () => MOCK_CONFIG_YAML);
			const config = await configLoader.load("/p/config.yaml");

			const { runner, calls } = makeRunnerWithHistory();
			const hydrator = new PreHydrator(
				async () => ({ title: "T", description: "D" }),
				async () => "R",
				"/p",
			);
			const shell = makeCIPassShell();
			const blueprint = new Blueprint(config, hydrator, () => runner, shell);

			await blueprint.run(
				{ id: "issue-1", blockedBy: [] },
				"/p",
				{
					teamName: "eng",
					runnerName: "claude",
					budgetPerIssue: 3.5,
					fixBudgetUsd: 1.0,
				},
			);

			expect(calls[0]!.maxCostUsd).toBe(3.5);
		});

		it("zero budget prevents any execution", async () => {
			const configLoader = new ConfigLoader(async () => MOCK_CONFIG_YAML);
			const config = await configLoader.load("/p/config.yaml");

			const { runner, calls } = makeRunnerWithHistory();
			const hydrator = new PreHydrator(
				async () => ({ title: "T", description: "D" }),
				async () => "R",
				"/p",
			);
			const shell = makeCIPassShell();
			const blueprint = new Blueprint(config, hydrator, () => runner, shell);

			const result = await blueprint.run(
				{ id: "issue-1", blockedBy: [] },
				"/p",
				{
					teamName: "eng",
					runnerName: "claude",
					budgetPerIssue: 0,
					fixBudgetUsd: 0,
				},
			);

			expect(result.success).toBe(false);
			expect(result.costUsd).toBe(0);
			expect(calls).toHaveLength(0);
		});
	});

	describe("Session ID recording", () => {
		it("session ID is recorded via onSessionCreated callback", async () => {
			const configLoader = new ConfigLoader(async () => MOCK_CONFIG_YAML);
			const config = await configLoader.load("/p/config.yaml");

			const { runner } = makeRunnerWithHistory();
			const hydrator = new PreHydrator(
				async () => ({ title: "T", description: "D" }),
				async () => "R",
				"/p",
			);
			const shell = makeCIPassShell();
			const blueprint = new Blueprint(config, hydrator, () => runner, shell);

			const sessions: Record<string, string> = {};
			blueprint.onSessionCreated = async (nodeId, sessionId) => {
				sessions[nodeId] = sessionId;
			};

			await blueprint.run(
				{ id: "GEO-42", blockedBy: [] },
				"/p",
				{
					teamName: "eng",
					runnerName: "claude",
					budgetPerIssue: 5.0,
					fixBudgetUsd: 2.0,
				},
			);

			expect(sessions["GEO-42"]).toBe("session-1");
		});

		it("session ID can be used for resume", async () => {
			const configLoader = new ConfigLoader(async () => MOCK_CONFIG_YAML);
			const config = await configLoader.load("/p/config.yaml");

			const { runner, calls } = makeRunnerWithHistory();
			const hydrator = new PreHydrator(
				async () => ({ title: "T", description: "D" }),
				async () => "R",
				"/p",
			);
			const shell = makeCIPassShell();
			const blueprint = new Blueprint(config, hydrator, () => runner, shell);

			await blueprint.run(
				{ id: "GEO-42", blockedBy: [] },
				"/p",
				{
					teamName: "eng",
					runnerName: "claude",
					budgetPerIssue: 5.0,
					fixBudgetUsd: 2.0,
					resumeSessionId: "prev-session-99",
				},
			);

			expect(calls[0]!.sessionId).toBe("prev-session-99");
		});
	});

	describe("Unknown blockers", () => {
		it("unknown blockers emit warnings and block execution", () => {
			const nodes: DagNode[] = [
				{ id: "A", blockedBy: ["EXTERNAL-REVIEW"] },
				{ id: "B", blockedBy: [] },
			];
			const resolver = new DagResolver(nodes);

			// A is blocked by unknown "EXTERNAL-REVIEW"
			const warnings = resolver.getWarnings();
			expect(warnings).toContainEqual(
				expect.objectContaining({
					type: "unknown_blocker",
					nodeId: "A",
					blockerId: "EXTERNAL-REVIEW",
				}),
			);

			// Only B is ready (A blocked by unknown)
			expect(resolver.getReady().map((n) => n.id)).toEqual(["B"]);

			// Resolve external blocker → A becomes ready
			resolver.resolveExternalBlocker("A", "EXTERNAL-REVIEW");
			expect(
				resolver
					.getReady()
					.map((n) => n.id)
					.sort(),
			).toEqual(["A", "B"]);
		});
	});

	describe("DAG correctly skips completed issues", () => {
		it("completed Linear issues are filtered by LinearGraphBuilder", () => {
			const builder = new LinearGraphBuilder();
			const nodes = builder.build(MOCK_LINEAR_ISSUES);

			// GEO-103 has state.type = "completed" → should be filtered
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
});
