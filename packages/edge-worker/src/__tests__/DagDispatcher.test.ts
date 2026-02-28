import { describe, expect, it, vi } from "vitest";
import { DagDispatcher } from "../DagDispatcher.js";
import { DagResolver } from "flywheel-dag-resolver";
import type { DagNode } from "flywheel-dag-resolver";
import type { Blueprint, BlueprintContext, BlueprintResult } from "../Blueprint.js";

function makeMockBlueprint(
	results: Map<string, BlueprintResult>,
): Blueprint {
	return {
		run: vi.fn(
			async (
				node: DagNode,
				_root: string,
				_ctx: BlueprintContext,
			): Promise<BlueprintResult> => {
				return (
					results.get(node.id) ?? {
						success: true,
						costUsd: 1.0,
						ciRounds: 1,
					}
				);
			},
		),
	} as unknown as Blueprint;
}

function defaultContext(_node: DagNode): BlueprintContext {
	return {
		teamName: "eng",
		runnerName: "claude",
		budgetPerIssue: 5.0,
		fixBudgetUsd: 2.0,
	};
}

describe("DagDispatcher", () => {
	it("processes all ready nodes sequentially", async () => {
		const nodes: DagNode[] = [
			{ id: "A", blockedBy: [] },
			{ id: "B", blockedBy: [] },
		];
		const resolver = new DagResolver(nodes);
		const results = new Map<string, BlueprintResult>([
			["A", { success: true, costUsd: 1.0, ciRounds: 1 }],
			["B", { success: true, costUsd: 2.0, ciRounds: 1 }],
		]);
		const blueprint = makeMockBlueprint(results);
		const dispatcher = new DagDispatcher(
			resolver,
			blueprint,
			"/project",
			defaultContext,
		);

		const result = await dispatcher.dispatch();

		expect(result.completed.sort()).toEqual(["A", "B"]);
		expect(result.shelved).toEqual([]);
		expect(result.totalCostUsd).toBe(3.0);
	});

	it("processes chain in dependency order", async () => {
		const nodes: DagNode[] = [
			{ id: "A", blockedBy: [] },
			{ id: "B", blockedBy: ["A"] },
			{ id: "C", blockedBy: ["B"] },
		];
		const resolver = new DagResolver(nodes);
		const callOrder: string[] = [];
		const blueprint = {
			run: vi.fn(async (node: DagNode) => {
				callOrder.push(node.id);
				return { success: true, costUsd: 1.0, ciRounds: 1 };
			}),
		} as unknown as Blueprint;

		const dispatcher = new DagDispatcher(
			resolver,
			blueprint,
			"/project",
			defaultContext,
		);

		const result = await dispatcher.dispatch();

		expect(callOrder).toEqual(["A", "B", "C"]);
		expect(result.completed).toEqual(["A", "B", "C"]);
	});

	it("shelves failed nodes and blocks downstream", async () => {
		const nodes: DagNode[] = [
			{ id: "A", blockedBy: [] },
			{ id: "B", blockedBy: ["A"] },
		];
		const resolver = new DagResolver(nodes);
		const results = new Map<string, BlueprintResult>([
			["A", { success: false, costUsd: 2.0, ciRounds: 2 }],
		]);
		const blueprint = makeMockBlueprint(results);
		const dispatcher = new DagDispatcher(
			resolver,
			blueprint,
			"/project",
			defaultContext,
		);

		const result = await dispatcher.dispatch();

		// A shelved → B blocked (default: shelve blocks downstream)
		expect(result.shelved).toEqual(["A"]);
		expect(result.completed).toEqual([]);
		expect(result.totalCostUsd).toBe(2.0);
		// B was never attempted because A was shelved and blocks it
		expect(
			(blueprint.run as ReturnType<typeof vi.fn>).mock.calls,
		).toHaveLength(1);
	});

	it("handles diamond dependency with partial failure", async () => {
		const nodes: DagNode[] = [
			{ id: "A", blockedBy: [] },
			{ id: "B", blockedBy: ["A"] },
			{ id: "C", blockedBy: ["A"] },
			{ id: "D", blockedBy: ["B", "C"] },
		];
		const resolver = new DagResolver(nodes);
		const results = new Map<string, BlueprintResult>([
			["A", { success: true, costUsd: 1.0, ciRounds: 1 }],
			["B", { success: true, costUsd: 1.0, ciRounds: 1 }],
			["C", { success: false, costUsd: 0.5, ciRounds: 2 }],
		]);
		const blueprint = makeMockBlueprint(results);
		const dispatcher = new DagDispatcher(
			resolver,
			blueprint,
			"/project",
			defaultContext,
		);

		const result = await dispatcher.dispatch();

		expect(result.completed.sort()).toEqual(["A", "B"]);
		expect(result.shelved).toEqual(["C"]);
		// D is blocked because C was shelved
		expect(result.totalCostUsd).toBe(2.5);
	});

	it("fires onNodeComplete callback for each node", async () => {
		const nodes: DagNode[] = [
			{ id: "A", blockedBy: [] },
			{ id: "B", blockedBy: [] },
		];
		const resolver = new DagResolver(nodes);
		const results = new Map<string, BlueprintResult>([
			["A", { success: true, costUsd: 1.0, ciRounds: 1 }],
			["B", { success: false, costUsd: 0.5, ciRounds: 2 }],
		]);
		const blueprint = makeMockBlueprint(results);
		const dispatcher = new DagDispatcher(
			resolver,
			blueprint,
			"/project",
			defaultContext,
		);

		const events: Array<{ nodeId: string; success: boolean }> = [];
		dispatcher.onNodeComplete = async (nodeId, result) => {
			events.push({ nodeId, success: result.success });
		};

		await dispatcher.dispatch();

		expect(events).toHaveLength(2);
		expect(events.find((e) => e.nodeId === "A")?.success).toBe(true);
		expect(events.find((e) => e.nodeId === "B")?.success).toBe(false);
	});

	it("handles empty DAG", async () => {
		const resolver = new DagResolver([]);
		const blueprint = makeMockBlueprint(new Map());
		const dispatcher = new DagDispatcher(
			resolver,
			blueprint,
			"/project",
			defaultContext,
		);

		const result = await dispatcher.dispatch();

		expect(result.completed).toEqual([]);
		expect(result.shelved).toEqual([]);
		expect(result.totalCostUsd).toBe(0);
	});

	it("passes project root to Blueprint.run", async () => {
		const nodes: DagNode[] = [{ id: "A", blockedBy: [] }];
		const resolver = new DagResolver(nodes);
		const blueprint = {
			run: vi.fn(async () => ({
				success: true,
				costUsd: 1.0,
				ciRounds: 1,
			})),
		} as unknown as Blueprint;
		const dispatcher = new DagDispatcher(
			resolver,
			blueprint,
			"/my/project",
			defaultContext,
		);

		await dispatcher.dispatch();

		expect(
			(blueprint.run as ReturnType<typeof vi.fn>).mock.calls[0]![1],
		).toBe("/my/project");
	});

	it("uses buildContext function for each node", async () => {
		const nodes: DagNode[] = [
			{ id: "A", blockedBy: [] },
			{ id: "B", blockedBy: [] },
		];
		const resolver = new DagResolver(nodes);
		const blueprint = {
			run: vi.fn(async () => ({
				success: true,
				costUsd: 1.0,
				ciRounds: 1,
			})),
		} as unknown as Blueprint;

		const buildContext = vi.fn((node: DagNode) => ({
			teamName: "eng",
			runnerName: node.id === "A" ? "claude" : "codex",
			budgetPerIssue: 5.0,
			fixBudgetUsd: 2.0,
		}));

		const dispatcher = new DagDispatcher(
			resolver,
			blueprint,
			"/project",
			buildContext,
		);

		await dispatcher.dispatch();

		expect(buildContext).toHaveBeenCalledTimes(2);
	});
});
