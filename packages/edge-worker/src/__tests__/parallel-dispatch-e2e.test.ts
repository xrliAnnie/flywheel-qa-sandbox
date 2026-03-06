import { describe, expect, it, vi } from "vitest";
import { DagDispatcher } from "../DagDispatcher.js";
import { DagResolver } from "flywheel-dag-resolver";
import { Semaphore } from "flywheel-core";
import type { DagNode } from "flywheel-dag-resolver";
import type {
	Blueprint,
	BlueprintContext,
	BlueprintResult,
} from "../Blueprint.js";

// Mock node:child_process to prevent osascript from opening Terminal windows
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		execFile: vi.fn(),
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
		const results = new Map<string, BlueprintResult>([
			["A", { success: true }],
			["B", { success: true }],
			["C", { success: true }],
		]);
		const blueprint = makeTimedBlueprint(results, 50);
		const semaphore = new Semaphore(2);
		const dispatcher = new DagDispatcher(
			resolver, blueprint, "/project", ctx, semaphore,
		);

		const start = Date.now();
		const result = await dispatcher.dispatch();
		const elapsed = Date.now() - start;

		expect(result.completed.sort()).toEqual(["A", "B", "C"]);
		expect(result.shelved).toEqual([]);
		// Semaphore(2): first batch (2 parallel) ~50ms, second batch ~50ms = ~100ms total
		// Sequential would be ~150ms
		expect(elapsed).toBeLessThan(130);
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
		const blueprint = {
			run: vi.fn(async (node: DagNode) => {
				callOrder.push(node.id);
				await new Promise((r) => setTimeout(r, 30));
				return { success: true };
			}),
		} as unknown as Blueprint;
		const semaphore = new Semaphore(3);
		const dispatcher = new DagDispatcher(
			resolver, blueprint, "/project", ctx, semaphore,
		);

		const start = Date.now();
		const result = await dispatcher.dispatch();
		const elapsed = Date.now() - start;

		// A first, B+C parallel, D last
		expect(callOrder[0]).toBe("A");
		expect(callOrder[callOrder.length - 1]).toBe("D");
		expect(result.completed.sort()).toEqual(["A", "B", "C", "D"]);
		// 3 layers * 30ms = ~90ms (B+C are parallel)
		expect(elapsed).toBeLessThan(150);
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
			resolver, blueprint, "/project", ctx, semaphore,
		);

		const result = await dispatcher.dispatch();

		expect(result.shelved).toEqual(["B"]);
		expect(result.completed).toContain("A");
		expect(result.completed).toContain("C");
		expect(result.completed).toContain("D");
		expect(result.halted).toBe(true);
		expect(result.nodeResults!["B"]!.error).toBe("test failure");
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
			resolver, blueprint, "/project", ctx, semaphore,
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
