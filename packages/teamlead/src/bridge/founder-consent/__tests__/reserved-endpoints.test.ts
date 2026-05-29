import type { Request } from "express";
import { describe, expect, it } from "vitest";
import {
	RESERVED_ENDPOINTS,
	resolveReservedAction,
} from "../reserved-endpoints.js";

describe("RESERVED_ENDPOINTS table integrity (§4.3)", () => {
	it("contains exactly 14 Surface A + 1 Surface B entries", () => {
		const a = RESERVED_ENDPOINTS.filter((e) => e.surface === "A");
		const b = RESERVED_ENDPOINTS.filter((e) => e.surface === "B");
		expect(a).toHaveLength(14);
		expect(b).toHaveLength(1);
		expect(RESERVED_ENDPOINTS).toHaveLength(15);
	});

	it("covers all 8 action keys", () => {
		const keys = new Set(RESERVED_ENDPOINTS.map((e) => e.action));
		expect([...keys].sort()).toEqual(
			[
				"approve",
				"approve_to_ship_gate",
				"close_runner",
				"close_tmux",
				"defer",
				"reject",
				"retry",
				"shelve",
				"terminate",
			].sort(),
		);
	});

	it("Surface B is the gate-response endpoint", () => {
		const b = RESERVED_ENDPOINTS.find((e) => e.surface === "B");
		expect(b?.path).toBe("/api/founder-consent/runner-gate-response");
		expect(b?.action).toBe("approve_to_ship_gate");
	});
});

const mkReq = (over: Partial<Request>): Request =>
	({ path: "/", params: {}, body: {}, ...over }) as Request;

describe("resolveReservedAction", () => {
	it("action_router resolves reserved action + execution_id from body", () => {
		const r = resolveReservedAction(
			"action_router",
			mkReq({ path: "/approve", body: { execution_id: "exec-1" } }),
		);
		expect(r).toEqual({ action: "approve", executionId: "exec-1" });
	});

	it("action_router passes through unknown action", () => {
		expect(
			resolveReservedAction("action_router", mkReq({ path: "/status" })),
		).toBeNull();
	});

	it("close_tmux reads executionId from params", () => {
		const r = resolveReservedAction(
			"close_tmux",
			mkReq({ params: { executionId: "exec-9" } as Request["params"] }),
		);
		expect(r).toEqual({ action: "close_tmux", executionId: "exec-9" });
	});

	it("close_runner reads executionId from params", () => {
		const r = resolveReservedAction(
			"close_runner",
			mkReq({ params: { executionId: "exec-7" } as Request["params"] }),
		);
		expect(r).toEqual({ action: "close_runner", executionId: "exec-7" });
	});

	it("accepts camelCase executionId in body as fallback", () => {
		const r = resolveReservedAction(
			"action_router",
			mkReq({ path: "/terminate", body: { executionId: "exec-x" } }),
		);
		expect(r).toEqual({ action: "terminate", executionId: "exec-x" });
	});
});
