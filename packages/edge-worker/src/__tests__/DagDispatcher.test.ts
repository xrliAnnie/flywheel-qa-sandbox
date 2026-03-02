import { describe, expect, it, vi } from "vitest";
import { DagDispatcher } from "../DagDispatcher.js";
import { DagResolver } from "flywheel-dag-resolver";
import type { DagNode } from "flywheel-dag-resolver";
import type {
	Blueprint,
	BlueprintContext,
	BlueprintResult,
} from "../Blueprint.js";

// Mock node:child_process to prevent osascript from opening Terminal windows during tests
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		execFile: vi.fn(),
	};
});

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
			["A", { success: true }],
			["B", { success: true }],
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
		expect(result.halted).toBe(false);
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
				return { success: true };
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

	it("shelves failed nodes and halts on first failure", async () => {
		const nodes: DagNode[] = [
			{ id: "A", blockedBy: [] },
			{ id: "B", blockedBy: [] },
		];
		const resolver = new DagResolver(nodes);
		const results = new Map<string, BlueprintResult>([
			["A", { success: false }],
			["B", { success: true }],
		]);
		const blueprint = makeMockBlueprint(results);
		const dispatcher = new DagDispatcher(
			resolver,
			blueprint,
			"/project",
			defaultContext,
		);

		const result = await dispatcher.dispatch();

		expect(result.shelved).toEqual(["A"]);
		expect(result.halted).toBe(true);
		// B was never attempted because dispatch halted
		expect(
			(blueprint.run as ReturnType<typeof vi.fn>).mock.calls,
		).toHaveLength(1);
	});

	it("shelving A blocks downstream B", async () => {
		const nodes: DagNode[] = [
			{ id: "A", blockedBy: [] },
			{ id: "B", blockedBy: ["A"] },
		];
		const resolver = new DagResolver(nodes);
		const results = new Map<string, BlueprintResult>([
			["A", { success: false }],
		]);
		const blueprint = makeMockBlueprint(results);
		const dispatcher = new DagDispatcher(
			resolver,
			blueprint,
			"/project",
			defaultContext,
		);

		const result = await dispatcher.dispatch();

		expect(result.shelved).toEqual(["A"]);
		expect(result.completed).toEqual([]);
		expect(result.halted).toBe(true);
		expect(
			(blueprint.run as ReturnType<typeof vi.fn>).mock.calls,
		).toHaveLength(1);
	});

	it("fires onNodeComplete callback for each node", async () => {
		const nodes: DagNode[] = [{ id: "A", blockedBy: [] }];
		const resolver = new DagResolver(nodes);
		const results = new Map<string, BlueprintResult>([
			["A", { success: true }],
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

		expect(events).toHaveLength(1);
		expect(events[0]!.nodeId).toBe("A");
		expect(events[0]!.success).toBe(true);
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
		expect(result.halted).toBe(false);
	});

	it("passes project root to Blueprint.run", async () => {
		const nodes: DagNode[] = [{ id: "A", blockedBy: [] }];
		const resolver = new DagResolver(nodes);
		const blueprint = {
			run: vi.fn(async () => ({ success: true })),
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

	it("handles blueprint.run() throwing an exception", async () => {
		const nodes: DagNode[] = [
			{ id: "A", blockedBy: [] },
			{ id: "B", blockedBy: [] },
		];
		const resolver = new DagResolver(nodes);
		const blueprint = {
			run: vi.fn(async () => {
				throw new Error("dirty working tree");
			}),
		} as unknown as Blueprint;
		const dispatcher = new DagDispatcher(
			resolver,
			blueprint,
			"/project",
			defaultContext,
		);

		// The exception should propagate — dispatch does not swallow blueprint throws
		await expect(dispatcher.dispatch()).rejects.toThrow(
			"dirty working tree",
		);
	});

	it("uses buildContext function for each node", async () => {
		const nodes: DagNode[] = [
			{ id: "A", blockedBy: [] },
		];
		const resolver = new DagResolver(nodes);
		const blueprint = {
			run: vi.fn(async () => ({ success: true })),
		} as unknown as Blueprint;

		const buildContext = vi.fn((_node: DagNode) => ({
			teamName: "eng",
			runnerName: "claude",
		}));

		const dispatcher = new DagDispatcher(
			resolver,
			blueprint,
			"/project",
			buildContext,
		);

		await dispatcher.dispatch();

		expect(buildContext).toHaveBeenCalledTimes(1);
	});
});
