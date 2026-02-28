import { describe, expect, it } from "vitest";
import { DagResolver } from "../DagResolver.js";
import type { DagNode } from "../types.js";

describe("DagResolver", () => {
	// ─── Empty input ──────────────────────────────────────────

	it("returns empty array for empty input", () => {
		const resolver = new DagResolver([]);
		expect(resolver.getReady()).toEqual([]);
	});

	it("remaining is 0 for empty input", () => {
		const resolver = new DagResolver([]);
		expect(resolver.remaining()).toBe(0);
	});

	// ─── No dependencies ─────────────────────────────────────

	it("returns all nodes when no dependencies", () => {
		const nodes: DagNode[] = [
			{ id: "A", blockedBy: [] },
			{ id: "B", blockedBy: [] },
			{ id: "C", blockedBy: [] },
		];
		const resolver = new DagResolver(nodes);
		expect(
			resolver
				.getReady()
				.map((n) => n.id)
				.sort(),
		).toEqual(["A", "B", "C"]);
	});

	// ─── Linear chain ────────────────────────────────────────

	it("respects blocking relations (linear chain)", () => {
		const nodes: DagNode[] = [
			{ id: "A", blockedBy: [] },
			{ id: "B", blockedBy: ["A"] },
			{ id: "C", blockedBy: ["B"] },
		];
		const resolver = new DagResolver(nodes);
		expect(resolver.getReady().map((n) => n.id)).toEqual(["A"]);

		resolver.markDone("A");
		expect(resolver.getReady().map((n) => n.id)).toEqual(["B"]);

		resolver.markDone("B");
		expect(resolver.getReady().map((n) => n.id)).toEqual(["C"]);
	});

	// ─── Diamond dependency ──────────────────────────────────

	it("handles diamond dependency", () => {
		const nodes: DagNode[] = [
			{ id: "A", blockedBy: [] },
			{ id: "B", blockedBy: ["A"] },
			{ id: "C", blockedBy: ["A"] },
			{ id: "D", blockedBy: ["B", "C"] },
		];
		const resolver = new DagResolver(nodes);
		expect(resolver.getReady().map((n) => n.id)).toEqual(["A"]);

		resolver.markDone("A");
		expect(
			resolver
				.getReady()
				.map((n) => n.id)
				.sort(),
		).toEqual(["B", "C"]);

		resolver.markDone("B");
		resolver.markDone("C");
		expect(resolver.getReady().map((n) => n.id)).toEqual(["D"]);
	});

	// ─── Cycle detection ─────────────────────────────────────

	it("detects cycles", () => {
		const nodes: DagNode[] = [
			{ id: "A", blockedBy: ["C"] },
			{ id: "B", blockedBy: ["A"] },
			{ id: "C", blockedBy: ["B"] },
		];
		expect(() => new DagResolver(nodes)).toThrow(/cycle/i);
	});

	it("detects self-referencing cycle", () => {
		const nodes: DagNode[] = [{ id: "A", blockedBy: ["A"] }];
		expect(() => new DagResolver(nodes)).toThrow(/cycle/i);
	});

	// ─── Unknown blocker ─────────────────────────────────────

	it("blocks nodes with unknown blockers by default", () => {
		const nodes: DagNode[] = [
			{ id: "A", blockedBy: ["UNKNOWN"] },
			{ id: "B", blockedBy: [] },
		];
		const resolver = new DagResolver(nodes);
		// A stays blocked (unknown blocker = assume still pending), only B is ready
		expect(resolver.getReady().map((n) => n.id)).toEqual(["B"]);
		expect(resolver.getWarnings()).toContainEqual(
			expect.objectContaining({
				type: "unknown_blocker",
				nodeId: "A",
				blockerId: "UNKNOWN",
			}),
		);
	});

	it("unknown blockers can be explicitly resolved", () => {
		const nodes: DagNode[] = [{ id: "A", blockedBy: ["UNKNOWN"] }];
		const resolver = new DagResolver(nodes);
		expect(resolver.getReady()).toEqual([]);

		resolver.resolveExternalBlocker("A", "UNKNOWN");
		expect(resolver.getReady().map((n) => n.id)).toEqual(["A"]);
	});

	it("resolveExternalBlocker is idempotent (double-call is no-op)", () => {
		const nodes: DagNode[] = [
			{ id: "A", blockedBy: ["EXT-1", "EXT-2"] },
		];
		const resolver = new DagResolver(nodes);
		expect(resolver.getReady()).toEqual([]);

		// Resolve EXT-1 twice — should only decrement once
		resolver.resolveExternalBlocker("A", "EXT-1");
		resolver.resolveExternalBlocker("A", "EXT-1");
		// A still blocked by EXT-2
		expect(resolver.getReady()).toEqual([]);

		// Resolve EXT-2 — now A should be ready
		resolver.resolveExternalBlocker("A", "EXT-2");
		expect(resolver.getReady().map((n) => n.id)).toEqual(["A"]);
	});

	it("resolveExternalBlocker ignores known (internal) blockers", () => {
		const nodes: DagNode[] = [
			{ id: "A", blockedBy: [] },
			{ id: "B", blockedBy: ["A"] },
		];
		const resolver = new DagResolver(nodes);
		// "A" is a known node, not an external blocker — should be a no-op
		resolver.resolveExternalBlocker("B", "A");
		// B should still be blocked (A is pending, not done)
		expect(resolver.getReady().map((n) => n.id)).toEqual(["A"]);
	});

	it("resolveExternalBlocker ignores blockers not listed on the node", () => {
		const nodes: DagNode[] = [
			{ id: "A", blockedBy: ["EXT-1"] },
		];
		const resolver = new DagResolver(nodes);
		// "RANDOM" is not in A's blockedBy — should be a no-op
		resolver.resolveExternalBlocker("A", "RANDOM");
		expect(resolver.getReady()).toEqual([]);
	});

	// ─── Idempotent markDone / shelve ────────────────────────

	it("markDone is idempotent (double-call does not double-decrement)", () => {
		const nodes: DagNode[] = [
			{ id: "A", blockedBy: [] },
			{ id: "B", blockedBy: ["A"] },
		];
		const resolver = new DagResolver(nodes);
		resolver.markDone("A");
		resolver.markDone("A"); // second call should be no-op
		expect(resolver.getReady().map((n) => n.id)).toEqual(["B"]);
	});

	it("shelve is idempotent (double-call does not double-decrement)", () => {
		const nodes: DagNode[] = [
			{ id: "A", blockedBy: [] },
			{ id: "B", blockedBy: ["A"] },
		];
		const resolver = new DagResolver(nodes, { allowBypassBlockers: true });
		resolver.shelve("A");
		resolver.shelve("A"); // second call should be no-op
		expect(resolver.getReady().map((n) => n.id)).toEqual(["B"]);
	});

	// ─── Shelve ──────────────────────────────────────────────

	it("shelve blocks downstream by default", () => {
		const nodes: DagNode[] = [
			{ id: "A", blockedBy: [] },
			{ id: "B", blockedBy: ["A"] },
		];
		const resolver = new DagResolver(nodes);
		resolver.shelve("A");
		// B stays blocked — shelve does NOT release downstream
		expect(resolver.getReady()).toEqual([]);
	});

	it("shelve with bypass releases downstream", () => {
		const nodes: DagNode[] = [
			{ id: "A", blockedBy: [] },
			{ id: "B", blockedBy: ["A"] },
		];
		const resolver = new DagResolver(nodes, { allowBypassBlockers: true });
		resolver.shelve("A");
		expect(resolver.getReady().map((n) => n.id)).toEqual(["B"]);
	});

	it("shelved node is not counted as remaining", () => {
		const nodes: DagNode[] = [
			{ id: "A", blockedBy: [] },
			{ id: "B", blockedBy: [] },
		];
		const resolver = new DagResolver(nodes);
		expect(resolver.remaining()).toBe(2);

		resolver.shelve("A");
		expect(resolver.remaining()).toBe(1);
	});

	// ─── Remaining count ─────────────────────────────────────

	it("tracks remaining count through lifecycle", () => {
		const resolver = new DagResolver([
			{ id: "A", blockedBy: [] },
			{ id: "B", blockedBy: ["A"] },
			{ id: "C", blockedBy: ["B"] },
		]);
		expect(resolver.remaining()).toBe(3);

		resolver.markDone("A");
		expect(resolver.remaining()).toBe(2);

		resolver.markDone("B");
		expect(resolver.remaining()).toBe(1);

		resolver.markDone("C");
		expect(resolver.remaining()).toBe(0);
	});

	// ─── Edge cases ──────────────────────────────────────────

	it("markDone on unknown node throws", () => {
		const resolver = new DagResolver([{ id: "A", blockedBy: [] }]);
		expect(() => resolver.markDone("NONEXISTENT")).toThrow(/not found/i);
	});

	it("shelve on unknown node throws", () => {
		const resolver = new DagResolver([{ id: "A", blockedBy: [] }]);
		expect(() => resolver.shelve("NONEXISTENT")).toThrow(/not found/i);
	});
});
