import { describe, expect, it } from "vitest";
import type { Directive } from "../directive-types.js";
import type { TransitionContext } from "../workflow-fsm.js";
import {
	ACTION_DEFINITIONS,
	allowedActionsForState,
	getActionTarget,
	WORKFLOW_TRANSITIONS,
	WorkflowFSM,
} from "../workflow-fsm.js";

function makeCtx(
	overrides: Partial<TransitionContext> = {},
): TransitionContext {
	return {
		executionId: "exec-1",
		issueId: "GEO-42",
		projectName: "geoforge3d",
		trigger: "test",
		...overrides,
	};
}

describe("WorkflowFSM", () => {
	const fsm = new WorkflowFSM(WORKFLOW_TRANSITIONS);

	// ── Valid transitions (all 13) ───────────────────────────────────

	const validTransitions: [string, string][] = [
		["pending", "running"],
		["running", "awaiting_review"],
		// FLY-58: running → approved removed (auto_approve now goes to completed)
		["running", "blocked"],
		["running", "completed"],
		["running", "failed"],
		["awaiting_review", "approved_to_ship"],
		["awaiting_review", "rejected"],
		["awaiting_review", "deferred"],
		["awaiting_review", "shelved"],
		// FLY-58: approved_to_ship transitions
		["approved_to_ship", "completed"],
		["approved_to_ship", "failed"],
		// GEO-168: blocked/failed/rejected → running removed (retry is composite)
		["blocked", "deferred"],
		["blocked", "shelved"],
		["failed", "shelved"],
		["rejected", "shelved"],
		["deferred", "shelved"],
	];

	it.each(validTransitions)("allows transition %s → %s", (from, to) => {
		const result = fsm.transition(from, to, makeCtx());
		expect(result.ok).toBe(true);
		expect(result.newState).toBe(to);
		expect(result.error).toBeUndefined();
	});

	// ── Invalid transitions ──────────────────────────────────────────

	const invalidTransitions: [string, string][] = [
		["approved", "running"],
		["completed", "running"],
		["shelved", "running"],
		["pending", "completed"],
		["pending", "approved"],
		["failed", "approved"],
		["deferred", "running"],
		// GEO-168: retry transitions removed from FSM (composite action)
		["blocked", "running"],
		["failed", "running"],
		["rejected", "running"],
	];

	it.each(invalidTransitions)("rejects transition %s → %s", (from, to) => {
		const result = fsm.transition(from, to, makeCtx());
		expect(result.ok).toBe(false);
		expect(result.newState).toBe(from);
		expect(result.error).toContain("not allowed");
	});

	// ── AuditDirective auto-generation ───────────────────────────────

	it("generates AuditDirective on successful transition with context", () => {
		const ctx = makeCtx({ trigger: "session_completed" });
		const result = fsm.transition("running", "completed", ctx);
		expect(result.ok).toBe(true);
		expect(result.directives).toHaveLength(1);

		const audit = result.directives[0];
		expect(audit.type).toBe("audit");
		expect(audit.executionId).toBe("exec-1");
		expect(audit.issueId).toBe("GEO-42");
		expect(audit.projectName).toBe("geoforge3d");
		expect(audit.fromState).toBe("running");
		expect(audit.toState).toBe("completed");
		expect(audit.trigger).toBe("session_completed");
	});

	it("returns empty directives when no context provided", () => {
		const result = fsm.transition("pending", "running");
		expect(result.ok).toBe(true);
		expect(result.directives).toHaveLength(0);
	});

	it("returns empty directives on failed transition", () => {
		const result = fsm.transition("approved", "running", makeCtx());
		expect(result.ok).toBe(false);
		expect(result.directives).toHaveLength(0);
	});

	// ── allowedTransitions ───────────────────────────────────────────

	it("returns all allowed target states for a given state", () => {
		expect(fsm.allowedTransitions("running")).toEqual([
			"awaiting_review",
			"completed",
			"blocked",
			"failed",
			"terminated",
		]);
		expect(fsm.allowedTransitions("pending")).toEqual(["running"]);
	});

	it("returns empty array for terminal states", () => {
		expect(fsm.allowedTransitions("approved")).toEqual([]);
		expect(fsm.allowedTransitions("completed")).toEqual([]);
		expect(fsm.allowedTransitions("shelved")).toEqual([]);
	});

	it("returns empty array for unknown states", () => {
		expect(fsm.allowedTransitions("nonexistent")).toEqual([]);
	});

	// ── isTerminal ───────────────────────────────────────────────────

	it("identifies terminal states correctly", () => {
		expect(fsm.isTerminal("approved")).toBe(true);
		expect(fsm.isTerminal("completed")).toBe(true);
		expect(fsm.isTerminal("shelved")).toBe(true);
	});

	it("identifies non-terminal states correctly", () => {
		expect(fsm.isTerminal("pending")).toBe(false);
		expect(fsm.isTerminal("running")).toBe(false);
		expect(fsm.isTerminal("awaiting_review")).toBe(false);
		expect(fsm.isTerminal("approved_to_ship")).toBe(false);
		expect(fsm.isTerminal("blocked")).toBe(false);
		expect(fsm.isTerminal("failed")).toBe(false);
		expect(fsm.isTerminal("rejected")).toBe(false);
		expect(fsm.isTerminal("deferred")).toBe(false);
	});

	it("returns false for unknown states (not in map)", () => {
		expect(fsm.isTerminal("nonexistent")).toBe(false);
	});

	// ── canTransition (no side effects) ──────────────────────────────

	it("canTransition returns true for valid transitions", () => {
		expect(fsm.canTransition("pending", "running")).toBe(true);
		expect(fsm.canTransition("running", "failed")).toBe(true);
	});

	it("canTransition returns false for invalid transitions", () => {
		expect(fsm.canTransition("approved", "running")).toBe(false);
		expect(fsm.canTransition("pending", "completed")).toBe(false);
	});

	// ── Guards ───────────────────────────────────────────────────────

	it("guard rejection returns error", () => {
		const guardedFsm = new WorkflowFSM(WORKFLOW_TRANSITIONS, {
			"running → completed": () => false,
		});
		const result = guardedFsm.transition("running", "completed", makeCtx());
		expect(result.ok).toBe(false);
		expect(result.error).toContain("Guard rejected");
	});

	it("guard pass allows transition", () => {
		const guardedFsm = new WorkflowFSM(WORKFLOW_TRANSITIONS, {
			"running → completed": () => true,
		});
		const result = guardedFsm.transition("running", "completed", makeCtx());
		expect(result.ok).toBe(true);
	});

	it("guards are skipped when no context provided", () => {
		const guardedFsm = new WorkflowFSM(WORKFLOW_TRANSITIONS, {
			"pending → running": () => false,
		});
		// Without context, guard is skipped
		const result = guardedFsm.transition("pending", "running");
		expect(result.ok).toBe(true);
	});

	// ── onEnter hooks ────────────────────────────────────────────────

	it("onEnter generates additional directives", () => {
		const customDirective: Directive = {
			type: "audit",
			executionId: "custom",
			issueId: "GEO-99",
			projectName: "test",
			fromState: "x",
			toState: "y",
			trigger: "onEnter",
		};
		const hookFsm = new WorkflowFSM(WORKFLOW_TRANSITIONS, undefined, {
			completed: () => [customDirective],
		});
		const result = hookFsm.transition("running", "completed", makeCtx());
		expect(result.ok).toBe(true);
		// 1 auto-generated audit + 1 from onEnter
		expect(result.directives).toHaveLength(2);
		expect(result.directives[1]).toEqual(customDirective);
	});

	it("onEnter is skipped when no context provided", () => {
		const hookFsm = new WorkflowFSM(WORKFLOW_TRANSITIONS, undefined, {
			running: () => [
				{
					type: "audit",
					executionId: "",
					issueId: "",
					projectName: "",
					fromState: "",
					toState: "",
					trigger: "",
				},
			],
		});
		const result = hookFsm.transition("pending", "running");
		expect(result.ok).toBe(true);
		expect(result.directives).toHaveLength(0);
	});
});

// ── ACTION_DEFINITIONS + helpers ─────────────────────────────────────

describe("ACTION_DEFINITIONS", () => {
	it("defines 6 actions", () => {
		expect(ACTION_DEFINITIONS).toHaveLength(6);
	});

	it("all target states are valid states in WORKFLOW_TRANSITIONS", () => {
		const allStates = Object.keys(WORKFLOW_TRANSITIONS);
		for (const def of ACTION_DEFINITIONS) {
			expect(allStates).toContain(def.targetState);
		}
	});

	it("all fromStates are valid states in WORKFLOW_TRANSITIONS", () => {
		const allStates = Object.keys(WORKFLOW_TRANSITIONS);
		for (const def of ACTION_DEFINITIONS) {
			for (const from of def.fromStates) {
				expect(allStates).toContain(from);
			}
		}
	});

	it("all non-composite action transitions are allowed by FSM", () => {
		const fsm = new WorkflowFSM(WORKFLOW_TRANSITIONS);
		for (const def of ACTION_DEFINITIONS) {
			if (def.composite) continue; // GEO-168: composite actions bypass FSM
			for (const from of def.fromStates) {
				expect(fsm.canTransition(from, def.targetState)).toBe(true);
			}
		}
	});
});

describe("allowedActionsForState", () => {
	it("returns correct actions for awaiting_review", () => {
		const actions = allowedActionsForState("awaiting_review");
		expect(actions).toContain("approve");
		expect(actions).toContain("reject");
		expect(actions).toContain("defer");
		expect(actions).toContain("shelve");
		expect(actions).not.toContain("retry");
	});

	it("returns correct actions for failed", () => {
		const actions = allowedActionsForState("failed");
		expect(actions).toContain("retry");
		expect(actions).toContain("shelve");
		expect(actions).not.toContain("approve");
	});

	it("returns empty for terminal states", () => {
		expect(allowedActionsForState("approved")).toEqual([]);
		expect(allowedActionsForState("completed")).toEqual([]);
		expect(allowedActionsForState("shelved")).toEqual([]);
	});

	it("returns empty for pending, terminate for running", () => {
		expect(allowedActionsForState("pending")).toEqual([]);
		expect(allowedActionsForState("running")).toEqual(["terminate"]);
	});
});

describe("getActionTarget", () => {
	it("returns target state for known actions", () => {
		expect(getActionTarget("approve")).toBe("approved_to_ship");
		expect(getActionTarget("reject")).toBe("rejected");
		expect(getActionTarget("defer")).toBe("deferred");
		expect(getActionTarget("retry")).toBe("running");
		expect(getActionTarget("shelve")).toBe("shelved");
	});

	it("returns undefined for unknown action", () => {
		expect(getActionTarget("unknown")).toBeUndefined();
	});
});
