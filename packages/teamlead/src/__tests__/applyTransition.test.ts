import type { TransitionContext } from "flywheel-core";
import { WORKFLOW_TRANSITIONS, WorkflowFSM } from "flywheel-core";
import { beforeEach, describe, expect, it } from "vitest";
import type { ApplyTransitionOpts } from "../applyTransition.js";
import { applyTransition } from "../applyTransition.js";
import { DirectiveExecutor } from "../DirectiveExecutor.js";
import { StateStore } from "../StateStore.js";

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

describe("applyTransition", () => {
	let store: StateStore;
	let fsm: WorkflowFSM;
	let executor: DirectiveExecutor;
	let opts: ApplyTransitionOpts;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		fsm = new WorkflowFSM(WORKFLOW_TRANSITIONS);
		executor = new DirectiveExecutor(store);
		opts = { store, fsm, executor };
	});

	it("first event: pending → running passes FSM (no existing session)", () => {
		const result = applyTransition(
			opts,
			"exec-1",
			"running",
			makeCtx({ trigger: "session_started" }),
		);
		expect(result.ok).toBe(true);
		expect(result.newState).toBe("running");

		const session = store.getSession("exec-1");
		expect(session).toBeDefined();
		expect(session!.status).toBe("running");
		expect(session!.issue_id).toBe("GEO-42");
	});

	it("first event: pending → completed is rejected by FSM", () => {
		const result = applyTransition(
			opts,
			"exec-1",
			"completed",
			makeCtx({ trigger: "session_completed" }),
		);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("not allowed");

		// No session created
		const session = store.getSession("exec-1");
		expect(session).toBeUndefined();
	});

	it("normal transition: running → failed", () => {
		// Setup: create a running session
		applyTransition(
			opts,
			"exec-1",
			"running",
			makeCtx({ trigger: "session_started" }),
		);

		// Transition to failed
		const result = applyTransition(
			opts,
			"exec-1",
			"failed",
			makeCtx({ trigger: "session_failed" }),
			{ last_error: "Something broke" },
		);
		expect(result.ok).toBe(true);
		expect(result.newState).toBe("failed");

		const session = store.getSession("exec-1");
		expect(session!.status).toBe("failed");
		expect(session!.last_error).toBe("Something broke");
	});

	it("illegal transition: approved → running is rejected", () => {
		// Setup: pending → running → awaiting_review → approved
		applyTransition(opts, "exec-1", "running", makeCtx({ trigger: "start" }));
		applyTransition(
			opts,
			"exec-1",
			"awaiting_review",
			makeCtx({ trigger: "review" }),
		);
		applyTransition(
			opts,
			"exec-1",
			"approved",
			makeCtx({ trigger: "approve" }),
		);

		// Try illegal transition
		const result = applyTransition(
			opts,
			"exec-1",
			"running",
			makeCtx({ trigger: "retry" }),
		);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("not allowed");

		// Status unchanged
		expect(store.getSession("exec-1")!.status).toBe("approved");
	});

	it("GEO-168: retry (failed → running) rejected by FSM — composite action, not simple transition", () => {
		applyTransition(opts, "exec-1", "running", makeCtx({ trigger: "start" }));
		applyTransition(opts, "exec-1", "failed", makeCtx({ trigger: "fail" }));

		const result = applyTransition(
			opts,
			"exec-1",
			"running",
			makeCtx({ trigger: "retry" }),
		);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("not allowed");
		expect(store.getSession("exec-1")!.status).toBe("failed");
	});

	it("audit directive is drained on successful transition", async () => {
		applyTransition(opts, "exec-1", "running", makeCtx({ trigger: "start" }));

		// Wait a tick for async drain
		await new Promise((r) => setTimeout(r, 50));

		const events = store.getEventsByExecution("exec-1");
		expect(events.length).toBeGreaterThanOrEqual(1);
		const auditEvent = events.find((e) => e.event_type === "state_transition");
		expect(auditEvent).toBeDefined();
		expect(auditEvent!.source).toBe("fsm");
		const payload = auditEvent!.payload as {
			from: string;
			to: string;
			trigger: string;
		};
		expect(payload.from).toBe("pending");
		expect(payload.to).toBe("running");
	});

	it("sessionFields are persisted correctly", () => {
		applyTransition(opts, "exec-1", "running", makeCtx({ trigger: "start" }), {
			issue_identifier: "GEO-42",
			issue_title: "Test Issue",
			started_at: "2026-03-15T00:00:00Z",
			adapter_type: "claude-code",
		});

		const session = store.getSession("exec-1");
		expect(session!.issue_identifier).toBe("GEO-42");
		expect(session!.issue_title).toBe("Test Issue");
		expect(session!.adapter_type).toBe("claude-code");
	});

	it("works without executor (no audit)", () => {
		const optsNoExec = { store, fsm };
		const result = applyTransition(
			optsNoExec,
			"exec-1",
			"running",
			makeCtx({ trigger: "start" }),
		);
		expect(result.ok).toBe(true);
		expect(store.getSession("exec-1")!.status).toBe("running");
	});
});
