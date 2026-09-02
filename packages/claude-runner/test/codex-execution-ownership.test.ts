import { describe, expect, it } from "vitest";
import { CodexExecutionOwnershipRegistry } from "../src/codex-execution-ownership.js";

describe("CodexExecutionOwnershipRegistry", () => {
	it("FLY-2211: reservation makes a dispatch visible as owned before adapter activation", () => {
		const registry = new CodexExecutionOwnershipRegistry();

		expect(registry.reserve("exec-1")).toBe(true);
		expect(registry.isExecutionOwned("exec-1")).toBe(true);
		const lease = registry.claim("exec-1", "dispatch");
		expect(lease).toBeDefined();
		expect(registry.claim("exec-1", "rescue")).toBeUndefined();

		lease?.release();
		expect(registry.isExecutionOwned("exec-1")).toBe(false);
	});

	it("FLY-2211: release is token-bound so a stale lease cannot delete a successor owner", () => {
		const registry = new CodexExecutionOwnershipRegistry();
		const first = registry.claim("exec-1", "rescue");
		expect(first).toBeDefined();
		first?.release();

		const successor = registry.claim("exec-1", "dispatch");
		expect(successor).toBeDefined();
		first?.release();
		expect(registry.isExecutionOwned("exec-1")).toBe(true);

		successor?.release();
		expect(registry.isExecutionOwned("exec-1")).toBe(false);
	});

	it("FLY-2211: only an unactivated reservation can be cancelled", () => {
		const registry = new CodexExecutionOwnershipRegistry();
		registry.reserve("reserved");
		expect(registry.releaseReservation("reserved")).toBe(true);
		expect(registry.isExecutionOwned("reserved")).toBe(false);

		registry.reserve("active");
		const lease = registry.claim("active", "dispatch");
		expect(registry.releaseReservation("active")).toBe(false);
		expect(registry.isExecutionOwned("active")).toBe(true);
		lease?.release();
	});
});
