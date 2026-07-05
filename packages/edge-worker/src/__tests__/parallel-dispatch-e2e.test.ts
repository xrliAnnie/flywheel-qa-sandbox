import { Semaphore } from "flywheel-core";
import type { DagNode } from "flywheel-dag-resolver";
import { DagResolver } from "flywheel-dag-resolver";
import { describe, expect, it, vi } from "vitest";
import type {
	Blueprint,
	BlueprintContext,
	BlueprintResult,
} from "../Blueprint.js";
import { DagDispatcher } from "../DagDispatcher.js";

// Mock node:child_process to prevent osascript/tmux from running during tests
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		execFile: vi.fn(),
		execFileSync: vi.fn(() => ""), // prevent real tmux list-clients calls
	};
});

function makeTimedBlueprint(
	results: Map<string, BlueprintResult>,
	delayMs: number,
): Blueprint {
	return {
		run: vi.fn(
			async (
				node: DagNode,
				_root: string,
				_ctx: BlueprintContext,
			): Promise<BlueprintResult> => {
				await new Promise((r) => setTimeout(r, delayMs));
				return results.get(node.id) ?? { success: true };
			},
		),
	} as unknown as Blueprint;
}

function ctx(_node: DagNode): BlueprintContext {
	return { teamName: "eng", runnerName: "claude" };
}

describe("Parallel Dispatch E2E", () => {
	it("dispatches 3 independent issues with Semaphore(2)", async () => {
		const nodes: DagNode[] = [
			{ id: "A", blockedBy: [] },
			{ id: "B", blockedBy: [] },
			{ id: "C", blockedBy: [] },
		];
		const resolver = new DagResolver(nodes);
		let concurrent = 0;
		let maxConcurrent = 0;
		const blueprint = {
			run: vi.fn(async () => {
				concurrent++;
				maxConcurrent = Math.max(maxConcurrent, concurrent);
				await new Promise((r) => setTimeout(r, 30));
				concurrent--;
				return { success: true };
			}),
		} as unknown as Blueprint;
		const semaphore = new Semaphore(2);
		const dispatcher = new DagDispatcher(
			resolver,
			blueprint,
			"/project",
			ctx,
			semaphore,
		);

		const result = await dispatcher.dispatch();

		expect(result.completed.sort()).toEqual(["A", "B", "C"]);
		expect(result.shelved).toEqual([]);
		// Semaphore(2) allows max 2 concurrent, not 3
		expect(maxConcurrent).toBe(2);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("diamond DAG with parallel middle layer", async () => {
		// A -> B, A -> C, B+C -> D
		const nodes: DagNode[] = [
			{ id: "A", blockedBy: [] },
			{ id: "B", blockedBy: ["A"] },
			{ id: "C", blockedBy: ["A"] },
			{ id: "D", blockedBy: ["B", "C"] },
		];
		const resolver = new DagResolver(nodes);
		const callOrder: string[] = [];
		let concurrent = 0;
		let maxConcurrent = 0;
		const blueprint = {
			run: vi.fn(async (node: DagNode) => {
				callOrder.push(node.id);
				concurrent++;
				maxConcurrent = Math.max(maxConcurrent, concurrent);
				await new Promise((r) => setTimeout(r, 20));
				concurrent--;
				return { success: true };
			}),
		} as unknown as Blueprint;
		const semaphore = new Semaphore(3);
		const dispatcher = new DagDispatcher(
			resolver,
			blueprint,
			"/project",
			ctx,
			semaphore,
		);

		const result = await dispatcher.dispatch();

		// A first, B+C parallel, D last
		expect(callOrder[0]).toBe("A");
		expect(callOrder[callOrder.length - 1]).toBe("D");
		expect(result.completed.sort()).toEqual(["A", "B", "C", "D"]);
		// B and C should run concurrently (max concurrent >= 2)
		expect(maxConcurrent).toBeGreaterThanOrEqual(2);
	});

	it("failure in one branch does not affect other branch", async () => {
		// A -> B (B fails), C -> D (independent)
		const nodes: DagNode[] = [
			{ id: "A", blockedBy: [] },
			{ id: "B", blockedBy: ["A"] },
			{ id: "C", blockedBy: [] },
			{ id: "D", blockedBy: ["C"] },
		];
		const resolver = new DagResolver(nodes);
		const results = new Map<string, BlueprintResult>([
			["A", { success: true }],
			["B", { success: false, error: "test failure" }],
			["C", { success: true }],
			["D", { success: true }],
		]);
		const blueprint = makeTimedBlueprint(results, 10);
		const semaphore = new Semaphore(3);
		const dispatcher = new DagDispatcher(
			resolver,
			blueprint,
			"/project",
			ctx,
			semaphore,
		);

		const result = await dispatcher.dispatch();

		expect(result.shelved).toEqual(["B"]);
		expect(result.completed).toContain("A");
		expect(result.completed).toContain("C");
		expect(result.completed).toContain("D");
		expect(result.halted).toBe(true);
		expect(result.nodeResults!.B!.error).toBe("test failure");
	});

	it("onNodeComplete callback error does not affect dispatch", async () => {
		const nodes: DagNode[] = [
			{ id: "A", blockedBy: [] },
			{ id: "B", blockedBy: [] },
		];
		const resolver = new DagResolver(nodes);
		const results = new Map<string, BlueprintResult>([
			["A", { success: true }],
			["B", { success: true }],
		]);
		const blueprint = makeTimedBlueprint(results, 10);
		const semaphore = new Semaphore(2);
		const dispatcher = new DagDispatcher(
			resolver,
			blueprint,
			"/project",
			ctx,
			semaphore,
		);

		const completedNodes: string[] = [];
		dispatcher.onNodeComplete = async (nodeId) => {
			completedNodes.push(nodeId);
			if (nodeId === "A") throw new Error("callback error");
		};

		const result = await dispatcher.dispatch();

		// Wait for fire-and-forget callbacks
		await new Promise((r) => setTimeout(r, 20));

		// A should still be in completed despite callback error
		expect(result.completed.sort()).toEqual(["A", "B"]);
		expect(result.shelved).toEqual([]);
		expect(completedNodes.sort()).toEqual(["A", "B"]);
	});
});
