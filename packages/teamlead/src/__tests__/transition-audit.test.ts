import type { TransitionContext } from "flywheel-core";
import { WORKFLOW_TRANSITIONS, WorkflowFSM } from "flywheel-core";
import { beforeEach, describe, expect, it } from "vitest";
import {
	type ApplyTransitionOpts,
	applyTransition,
} from "../applyTransition.js";
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

describe("Transition audit trail", () => {
	let store: StateStore;
	let opts: ApplyTransitionOpts;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		const fsm = new WorkflowFSM(WORKFLOW_TRANSITIONS);
		const executor = new DirectiveExecutor(store);
		opts = { store, fsm, executor };
	});

	it("action transitions write state_transition to session_events", async () => {
		// Setup: pending → running → awaiting_review
		applyTransition(opts, "exec-1", "running", makeCtx({ trigger: "start" }));
		applyTransition(
			opts,
			"exec-1",
			"awaiting_review",
			makeCtx({ trigger: "review" }),
		);

		// Action: approve
		applyTransition(
			opts,
			"exec-1",
			"approved",
			makeCtx({ trigger: "approve" }),
		);

		await new Promise((r) => setTimeout(r, 50));

		const events = store.getEventsByExecution("exec-1");
		const auditEvents = events.filter(
			(e) => e.event_type === "state_transition",
		);
		expect(auditEvents.length).toBe(3);
		expect(auditEvents.every((e) => e.source === "fsm")).toBe(true);
	});

	it("GEO-168: retry (failed → running) rejected by FSM — no audit for composite action", async () => {
		applyTransition(opts, "exec-1", "running", makeCtx({ trigger: "start" }));
		applyTransition(opts, "exec-1", "failed", makeCtx({ trigger: "fail" }));
		const result = applyTransition(
			opts,
			"exec-1",
			"running",
			makeCtx({ trigger: "retry" }),
		);
		expect(result.ok).toBe(false);

		await new Promise((r) => setTimeout(r, 50));

		const events = store.getEventsByExecution("exec-1");
		const auditEvents = events.filter(
			(e) => e.event_type === "state_transition",
		);
		// Only 2 audits: start and fail — retry does not produce an audit
		expect(auditEvents.length).toBe(2);
	});

	it("audit payload contains from, to, and trigger", async () => {
		applyTransition(
			opts,
			"exec-1",
			"running",
			makeCtx({ trigger: "session_started" }),
		);

		await new Promise((r) => setTimeout(r, 50));

		const events = store.getEventsByExecution("exec-1");
		const audit = events.find((e) => e.event_type === "state_transition")!;
		expect(audit).toBeDefined();
		expect(audit.source).toBe("fsm");

		const payload = audit.payload as {
			from: string;
			to: string;
			trigger: string;
		};
		expect(payload.from).toBe("pending");
		expect(payload.to).toBe("running");
		expect(payload.trigger).toBe("session_started");
	});

	it("rejected transitions do not write audit events", async () => {
		// pending → completed is not allowed
		const result = applyTransition(
			opts,
			"exec-1",
			"completed",
			makeCtx({ trigger: "bad" }),
		);
		expect(result.ok).toBe(false);

		await new Promise((r) => setTimeout(r, 50));

		const events = store.getEventsByExecution("exec-1");
		expect(
			events.filter((e) => e.event_type === "state_transition"),
		).toHaveLength(0);
	});

	it("GEO-168: full lifecycle without retry (composite action removed from FSM)", async () => {
		// pending → running → awaiting_review → rejected → shelved
		applyTransition(opts, "exec-1", "running", makeCtx({ trigger: "start" }));
		applyTransition(
			opts,
			"exec-1",
			"awaiting_review",
			makeCtx({ trigger: "review" }),
		);
		applyTransition(opts, "exec-1", "rejected", makeCtx({ trigger: "reject" }));
		applyTransition(opts, "exec-1", "shelved", makeCtx({ trigger: "shelve" }));

		await new Promise((r) => setTimeout(r, 50));

		const events = store.getEventsByExecution("exec-1");
		const audits = events.filter((e) => e.event_type === "state_transition");
		expect(audits).toHaveLength(4);

		const transitions = audits.map((e) => {
			const p = e.payload as { from: string; to: string };
			return `${p.from} → ${p.to}`;
		});
		expect(transitions).toEqual([
			"pending → running",
			"running → awaiting_review",
			"awaiting_review → rejected",
			"rejected → shelved",
		]);
	});
});
