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
import type { WorktreeManager } from "../WorktreeManager.js";

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
	delayMs = 0,
): Blueprint {
	return {
		run: vi.fn(
			async (
				node: DagNode,
				_root: string,
				_ctx: BlueprintContext,
			): Promise<BlueprintResult> => {
				if (delayMs > 0) {
					await new Promise((r) => setTimeout(r, delayMs));
				}
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
	it("processes all ready nodes", async () => {
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

	it("shelves failed nodes — others continue in parallel mode", async () => {
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
		const semaphore = new Semaphore(2);
		const dispatcher = new DagDispatcher(
			resolver,
			blueprint,
			"/project",
			defaultContext,
			semaphore,
		);

		const result = await dispatcher.dispatch();

		expect(result.shelved).toEqual(["A"]);
		expect(result.completed).toContain("B");
		expect(result.halted).toBe(true);
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

	it("handles blueprint.run() throwing — shelves node, others continue", async () => {
		const nodes: DagNode[] = [
			{ id: "A", blockedBy: [] },
			{ id: "B", blockedBy: [] },
		];
		const resolver = new DagResolver(nodes);
		let callCount = 0;
		const blueprint = {
			run: vi.fn(async (node: DagNode) => {
				callCount++;
				if (node.id === "A") throw new Error("dirty working tree");
				return { success: true };
			}),
		} as unknown as Blueprint;
		const semaphore = new Semaphore(2);
		const dispatcher = new DagDispatcher(
			resolver,
			blueprint,
			"/project",
			defaultContext,
			semaphore,
		);

		const result = await dispatcher.dispatch();

		expect(result.shelved).toContain("A");
		expect(result.completed).toContain("B");
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

	// ─── Parallel-specific tests ────────────────────

	it("independent nodes A, B run in parallel (concurrency check)", async () => {
		const nodes: DagNode[] = [
			{ id: "A", blockedBy: [] },
			{ id: "B", blockedBy: [] },
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
			defaultContext,
			semaphore,
		);

		const result = await dispatcher.dispatch();

		expect(result.completed.sort()).toEqual(["A", "B"]);
		// With Semaphore(2), both should run concurrently
		expect(maxConcurrent).toBe(2);
	});

	it("diamond DAG: A -> B, A -> C, B+C -> D", async () => {
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
				await new Promise((r) => setTimeout(r, 20));
				return { success: true };
			}),
		} as unknown as Blueprint;
		const semaphore = new Semaphore(3);
		const dispatcher = new DagDispatcher(
			resolver,
			blueprint,
			"/project",
			defaultContext,
			semaphore,
		);

		const result = await dispatcher.dispatch();

		expect(result.completed).toContain("A");
		expect(result.completed).toContain("D");
		// A must be first, D must be last
		expect(callOrder[0]).toBe("A");
		expect(callOrder[callOrder.length - 1]).toBe("D");
		// B and C should both be before D
		expect(callOrder.indexOf("B")).toBeLessThan(callOrder.indexOf("D"));
		expect(callOrder.indexOf("C")).toBeLessThan(callOrder.indexOf("D"));
	});

	it("node failure shelves only that node, others continue", async () => {
		const nodes: DagNode[] = [
			{ id: "A", blockedBy: [] },
			{ id: "B", blockedBy: [] },
			{ id: "C", blockedBy: [] },
		];
		const resolver = new DagResolver(nodes);
		const results = new Map<string, BlueprintResult>([
			["A", { success: true }],
			["B", { success: false }],
			["C", { success: true }],
		]);
		const blueprint = makeMockBlueprint(results);
		const semaphore = new Semaphore(3);
		const dispatcher = new DagDispatcher(
			resolver,
			blueprint,
			"/project",
			defaultContext,
			semaphore,
		);

		const result = await dispatcher.dispatch();

		expect(result.shelved).toEqual(["B"]);
		expect(result.completed.sort()).toEqual(["A", "C"]);
	});

	it("Semaphore(1) forces sequential execution", async () => {
		const nodes: DagNode[] = [
			{ id: "A", blockedBy: [] },
			{ id: "B", blockedBy: [] },
		];
		const resolver = new DagResolver(nodes);
		let concurrent = 0;
		let maxConcurrent = 0;
		const blueprint = {
			run: vi.fn(async () => {
				concurrent++;
				maxConcurrent = Math.max(maxConcurrent, concurrent);
				await new Promise((r) => setTimeout(r, 20));
				concurrent--;
				return { success: true };
			}),
		} as unknown as Blueprint;
		const semaphore = new Semaphore(1);
		const dispatcher = new DagDispatcher(
			resolver,
			blueprint,
			"/project",
			defaultContext,
			semaphore,
		);

		await dispatcher.dispatch();

		expect(maxConcurrent).toBe(1);
	});

	it("Semaphore(2) allows 2 parallel, blocks 3rd", async () => {
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
			defaultContext,
			semaphore,
		);

		await dispatcher.dispatch();

		expect(maxConcurrent).toBe(2);
	});

	it("onNodeComplete fires for failed nodes too", async () => {
		const nodes: DagNode[] = [{ id: "A", blockedBy: [] }];
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

		const events: Array<{ nodeId: string; success: boolean }> = [];
		dispatcher.onNodeComplete = async (nodeId, result) => {
			events.push({ nodeId, success: result.success });
		};

		await dispatcher.dispatch();

		// Wait for fire-and-forget callback
		await new Promise((r) => setTimeout(r, 10));

		expect(events).toHaveLength(1);
		expect(events[0]!.success).toBe(false);
	});

	it("onNodeComplete throws -> node state unchanged, no double-shelve", async () => {
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
		const semaphore = new Semaphore(2);
		const dispatcher = new DagDispatcher(
			resolver,
			blueprint,
			"/project",
			defaultContext,
			semaphore,
		);

		dispatcher.onNodeComplete = async (nodeId) => {
			if (nodeId === "A") throw new Error("callback boom");
		};

		const result = await dispatcher.dispatch();

		// A should still be completed despite callback error
		expect(result.completed.sort()).toEqual(["A", "B"]);
		expect(result.shelved).toEqual([]);
	});

	it("Blueprint.run() throws -> node shelved, others continue", async () => {
		const nodes: DagNode[] = [
			{ id: "A", blockedBy: [] },
			{ id: "B", blockedBy: [] },
		];
		const resolver = new DagResolver(nodes);
		const blueprint = {
			run: vi.fn(async (node: DagNode) => {
				if (node.id === "A") throw new Error("crash");
				return { success: true };
			}),
		} as unknown as Blueprint;
		const semaphore = new Semaphore(2);
		const dispatcher = new DagDispatcher(
			resolver,
			blueprint,
			"/project",
			defaultContext,
			semaphore,
		);

		const result = await dispatcher.dispatch();

		expect(result.shelved).toContain("A");
		expect(result.completed).toContain("B");
	});

	it("all nodes shelved -> halted=true, loop terminates", async () => {
		const nodes: DagNode[] = [
			{ id: "A", blockedBy: [] },
			{ id: "B", blockedBy: [] },
		];
		const resolver = new DagResolver(nodes);
		const results = new Map<string, BlueprintResult>([
			["A", { success: false }],
			["B", { success: false }],
		]);
		const blueprint = makeMockBlueprint(results);
		const dispatcher = new DagDispatcher(
			resolver,
			blueprint,
			"/project",
			defaultContext,
		);

		const result = await dispatcher.dispatch();

		expect(result.halted).toBe(true);
		expect(result.shelved.sort()).toEqual(["A", "B"]);
		expect(result.completed).toEqual([]);
	});

	it("backward compat: default Semaphore(1) produces same results as old serial", async () => {
		const nodes: DagNode[] = [
			{ id: "A", blockedBy: [] },
			{ id: "B", blockedBy: ["A"] },
		];
		const resolver = new DagResolver(nodes);
		const callOrder: string[] = [];
		const blueprint = {
			run: vi.fn(async (node: DagNode) => {
				callOrder.push(node.id);
				return { success: true };
			}),
		} as unknown as Blueprint;
		// No semaphore arg — uses default Semaphore(1)
		const dispatcher = new DagDispatcher(
			resolver,
			blueprint,
			"/project",
			defaultContext,
		);

		const result = await dispatcher.dispatch();

		expect(callOrder).toEqual(["A", "B"]);
		expect(result.completed).toEqual(["A", "B"]);
		expect(result.halted).toBe(false);
	});

	it("inflight cleanup: promises removed after settlement", async () => {
		const nodes: DagNode[] = [
			{ id: "A", blockedBy: [] },
			{ id: "B", blockedBy: ["A"] },
		];
		const resolver = new DagResolver(nodes);
		const blueprint = {
			run: vi.fn(async () => ({ success: true })),
		} as unknown as Blueprint;
		const dispatcher = new DagDispatcher(
			resolver,
			blueprint,
			"/project",
			defaultContext,
		);

		const result = await dispatcher.dispatch();

		// If inflight cleanup works, dispatch completes without hanging
		expect(result.completed).toEqual(["A", "B"]);
	});

	it("same node never dispatched twice (scheduled set)", async () => {
		const nodes: DagNode[] = [
			{ id: "A", blockedBy: [] },
			{ id: "B", blockedBy: [] },
		];
		const resolver = new DagResolver(nodes);
		const callCounts: Record<string, number> = {};
		const blueprint = {
			run: vi.fn(async (node: DagNode) => {
				callCounts[node.id] = (callCounts[node.id] ?? 0) + 1;
				await new Promise((r) => setTimeout(r, 30));
				return { success: true };
			}),
		} as unknown as Blueprint;
		const semaphore = new Semaphore(10);
		const dispatcher = new DagDispatcher(
			resolver,
			blueprint,
			"/project",
			defaultContext,
			semaphore,
		);

		await dispatcher.dispatch();

		expect(callCounts["A"]).toBe(1);
		expect(callCounts["B"]).toBe(1);
	});

	it("pruneOrphans called before and after dispatch", async () => {
		const nodes: DagNode[] = [{ id: "A", blockedBy: [] }];
		const resolver = new DagResolver(nodes);
		const blueprint = makeMockBlueprint(
			new Map([["A", { success: true }]]),
		);
		const mockWorktreeManager = {
			pruneOrphans: vi.fn(async () => []),
		} as unknown as WorktreeManager;
		const dispatcher = new DagDispatcher(
			resolver,
			blueprint,
			"/project",
			defaultContext,
			new Semaphore(1),
			"flywheel",
			mockWorktreeManager,
			"testproject",
		);

		await dispatcher.dispatch();

		expect(mockWorktreeManager.pruneOrphans).toHaveBeenCalledTimes(2);
	});

	it("pruneOrphans failure doesn't halt dispatch", async () => {
		const nodes: DagNode[] = [{ id: "A", blockedBy: [] }];
		const resolver = new DagResolver(nodes);
		const blueprint = makeMockBlueprint(
			new Map([["A", { success: true }]]),
		);
		const mockWorktreeManager = {
			pruneOrphans: vi.fn(async () => {
				throw new Error("prune failed");
			}),
		} as unknown as WorktreeManager;
		const dispatcher = new DagDispatcher(
			resolver,
			blueprint,
			"/project",
			defaultContext,
			new Semaphore(1),
			"flywheel",
			mockWorktreeManager,
			"testproject",
		);

		const result = await dispatcher.dispatch();

		expect(result.completed).toEqual(["A"]);
	});

	it("durationMs and nodeResults populated correctly", async () => {
		const nodes: DagNode[] = [
			{ id: "A", blockedBy: [] },
			{ id: "B", blockedBy: [] },
		];
		const resolver = new DagResolver(nodes);
		const results = new Map<string, BlueprintResult>([
			["A", { success: true, costUsd: 0.5 }],
			["B", { success: false, error: "oops" }],
		]);
		const blueprint = makeMockBlueprint(results);
		const dispatcher = new DagDispatcher(
			resolver,
			blueprint,
			"/project",
			defaultContext,
		);

		const result = await dispatcher.dispatch();

		expect(result.durationMs).toBeGreaterThanOrEqual(0);
		expect(result.nodeResults).toBeDefined();
		expect(result.nodeResults!["A"]!.success).toBe(true);
		expect(result.nodeResults!["B"]!.success).toBe(false);
	});

	it("slow onNodeComplete callback doesn't block dispatch loop", async () => {
		const nodes: DagNode[] = [
			{ id: "A", blockedBy: [] },
			{ id: "B", blockedBy: [] },
		];
		const resolver = new DagResolver(nodes);
		const results = new Map<string, BlueprintResult>([
			["A", { success: true }],
			["B", { success: true }],
		]);
		const blueprint = makeMockBlueprint(results, 10);
		const semaphore = new Semaphore(2);
		const dispatcher = new DagDispatcher(
			resolver,
			blueprint,
			"/project",
			defaultContext,
			semaphore,
		);

		dispatcher.onNodeComplete = async (nodeId) => {
			if (nodeId === "A") {
				// Simulate a very slow callback
				await new Promise((r) => setTimeout(r, 500));
			}
		};

		const start = Date.now();
		const result = await dispatcher.dispatch();
		const elapsed = Date.now() - start;

		// Dispatch should complete quickly despite slow callback
		expect(result.completed.sort()).toEqual(["A", "B"]);
		expect(elapsed).toBeLessThan(200);
	});

	it("sync-throwing onNodeComplete doesn't crash dispatch", async () => {
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
		const semaphore = new Semaphore(2);
		const dispatcher = new DagDispatcher(
			resolver,
			blueprint,
			"/project",
			defaultContext,
			semaphore,
		);

		dispatcher.onNodeComplete = ((_nodeId: string) => {
			throw new Error("sync kaboom");
		}) as unknown as typeof dispatcher.onNodeComplete;

		const result = await dispatcher.dispatch();

		// Wait for fire-and-forget to settle
		await new Promise((r) => setTimeout(r, 10));

		expect(result.completed.sort()).toEqual(["A", "B"]);
		expect(result.shelved).toEqual([]);
	});
});
