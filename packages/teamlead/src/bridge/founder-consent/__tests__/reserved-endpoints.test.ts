import type { Request } from "express";
import { describe, expect, it } from "vitest";
import {
	ACTION_CLASS_METADATA,
	getActionClassMeta,
	isLifecycleAction,
	LIFECYCLE_ACTIONS,
	lifecycleCheckpoint,
	RESERVED_ENDPOINTS,
	resolveReservedAction,
} from "../reserved-endpoints.js";

describe("RESERVED_ENDPOINTS table integrity (§4.3)", () => {
	it("contains exactly 17 Surface A + 1 Surface B entries (FLY-1185 adds 3 issue-lifecycle)", () => {
		const a = RESERVED_ENDPOINTS.filter((e) => e.surface === "A");
		const b = RESERVED_ENDPOINTS.filter((e) => e.surface === "B");
		expect(a).toHaveLength(17);
		expect(b).toHaveLength(1);
		expect(RESERVED_ENDPOINTS).toHaveLength(18);
	});

	it("covers all 12 action keys", () => {
		const keys = new Set(RESERVED_ENDPOINTS.map((e) => e.action));
		expect([...keys].sort()).toEqual(
			[
				"approve",
				"approve_to_ship_gate",
				"close_runner",
				"close_tmux",
				"defer",
				"lifecycle_apply",
				"park_issue",
				"reject",
				"retry",
				"shelve",
				"terminate",
				"unpark_issue",
			].sort(),
		);
	});

	// FLY-1185: the issue-lifecycle kind must NOT expand the gateway's
	// runner-lifecycle enum (the FLY-245 authorization surface).
	it("issue_lifecycle actions are NOT in LIFECYCLE_ACTIONS", () => {
		expect(LIFECYCLE_ACTIONS).not.toContain("park_issue");
		expect(LIFECYCLE_ACTIONS).not.toContain("unpark_issue");
		expect(LIFECYCLE_ACTIONS).not.toContain("lifecycle_apply");
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

describe("FLY-245 D-d: action-class metadata (SSOT classification, R2#4)", () => {
	it("classifies EVERY reserved action EXACTLY once (no drift)", () => {
		const reservedActions = new Set(RESERVED_ENDPOINTS.map((e) => e.action));
		const metaActions = ACTION_CLASS_METADATA.map((m) => m.action);
		// exactly once: no duplicates
		expect(new Set(metaActions).size).toBe(metaActions.length);
		// same set as the reserved endpoints (a new reserved endpoint with an
		// unclassified action fails this).
		expect(new Set(metaActions)).toEqual(reservedActions);
	});

	it("LIFECYCLE_ACTIONS excludes the ship-gate actions", () => {
		expect(LIFECYCLE_ACTIONS).not.toContain("approve");
		expect(LIFECYCLE_ACTIONS).not.toContain("approve_to_ship_gate");
		expect([...LIFECYCLE_ACTIONS].sort()).toEqual(
			[
				"close_runner",
				"close_tmux",
				"defer",
				"reject",
				"retry",
				"shelve",
				"terminate",
			].sort(),
		);
		expect(isLifecycleAction("terminate")).toBe(true);
		expect(isLifecycleAction("approve")).toBe(false);
		expect(isLifecycleAction("unknown")).toBe(false);
	});

	it("every lifecycle action has a verifier, eligible statuses, and a canonical endpoint", () => {
		for (const m of ACTION_CLASS_METADATA.filter(
			(x) => x.kind === "lifecycle",
		)) {
			expect(m.postconditionVerifier).not.toBe("n/a");
			expect(m.postconditionVerifier.length).toBeGreaterThan(0);
			expect(m.eligibleStatuses.length).toBeGreaterThan(0);
			expect(m.canonicalEndpoint).toMatch(/^\/api\//);
		}
	});

	it("retry is the ONLY non-idempotent action (§5.2.1)", () => {
		const nonIdem = ACTION_CLASS_METADATA.filter(
			(m) => m.idempotencyClass === "non_idempotent",
		).map((m) => m.action);
		expect(nonIdem).toEqual(["retry"]);
	});

	it("close-* canonical endpoints point at the session-close mounts (not the action router)", () => {
		expect(getActionClassMeta("close_tmux")?.canonicalEndpoint).toBe(
			"/api/sessions/:id/close-tmux",
		);
		expect(getActionClassMeta("close_runner")?.canonicalEndpoint).toBe(
			"/api/sessions/:id/close-runner",
		);
	});

	it("lifecycleCheckpoint maps an action to its CommDB checkpoint", () => {
		expect(lifecycleCheckpoint("terminate")).toBe("runner_lifecycle:terminate");
	});
});
