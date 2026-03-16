import { describe, expect, it, beforeEach } from "vitest";
import { WorkflowFSM, WORKFLOW_TRANSITIONS } from "flywheel-core";
import type { TransitionContext } from "flywheel-core";
import { applyTransition, type ApplyTransitionOpts } from "../applyTransition.js";
import { DirectiveExecutor } from "../DirectiveExecutor.js";
import { StateStore } from "../StateStore.js";

function makeCtx(overrides: Partial<TransitionContext> = {}): TransitionContext {
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
		applyTransition(opts, "exec-1", "awaiting_review", makeCtx({ trigger: "review" }));

		// Action: approve
		applyTransition(opts, "exec-1", "approved", makeCtx({ trigger: "approve" }));

		await new Promise((r) => setTimeout(r, 50));

		const events = store.getEventsByExecution("exec-1");
		const auditEvents = events.filter((e) => e.event_type === "state_transition");
		expect(auditEvents.length).toBe(3);
		expect(auditEvents.every((e) => e.source === "fsm")).toBe(true);
	});

	it("retry transition (failed → running) generates audit", async () => {
		applyTransition(opts, "exec-1", "running", makeCtx({ trigger: "start" }));
		applyTransition(opts, "exec-1", "failed", makeCtx({ trigger: "fail" }));
		applyTransition(opts, "exec-1", "running", makeCtx({ trigger: "retry" }));

		await new Promise((r) => setTimeout(r, 50));

		const events = store.getEventsByExecution("exec-1");
		const auditEvents = events.filter((e) => e.event_type === "state_transition");
		expect(auditEvents.length).toBe(3);

		const retryAudit = auditEvents[2];
		const payload = retryAudit!.payload as { from: string; to: string; trigger: string };
		expect(payload.from).toBe("failed");
		expect(payload.to).toBe("running");
		expect(payload.trigger).toBe("retry");
	});

	it("audit payload contains from, to, and trigger", async () => {
		applyTransition(opts, "exec-1", "running", makeCtx({ trigger: "session_started" }));

		await new Promise((r) => setTimeout(r, 50));

		const events = store.getEventsByExecution("exec-1");
		const audit = events.find((e) => e.event_type === "state_transition")!;
		expect(audit).toBeDefined();
		expect(audit.source).toBe("fsm");

		const payload = audit.payload as { from: string; to: string; trigger: string };
		expect(payload.from).toBe("pending");
		expect(payload.to).toBe("running");
		expect(payload.trigger).toBe("session_started");
	});

	it("rejected transitions do not write audit events", async () => {
		// pending → completed is not allowed
		const result = applyTransition(opts, "exec-1", "completed", makeCtx({ trigger: "bad" }));
		expect(result.ok).toBe(false);

		await new Promise((r) => setTimeout(r, 50));

		const events = store.getEventsByExecution("exec-1");
		expect(events.filter((e) => e.event_type === "state_transition")).toHaveLength(0);
	});

	it("full lifecycle generates audit trail for all transitions", async () => {
		// pending → running → awaiting_review → rejected → running → completed
		applyTransition(opts, "exec-1", "running", makeCtx({ trigger: "start" }));
		applyTransition(opts, "exec-1", "awaiting_review", makeCtx({ trigger: "review" }));
		applyTransition(opts, "exec-1", "rejected", makeCtx({ trigger: "reject" }));
		applyTransition(opts, "exec-1", "running", makeCtx({ trigger: "retry" }));
		applyTransition(opts, "exec-1", "completed", makeCtx({ trigger: "complete" }));

		await new Promise((r) => setTimeout(r, 50));

		const events = store.getEventsByExecution("exec-1");
		const audits = events.filter((e) => e.event_type === "state_transition");
		expect(audits).toHaveLength(5);

		const transitions = audits.map((e) => {
			const p = e.payload as { from: string; to: string };
			return `${p.from} → ${p.to}`;
		});
		expect(transitions).toEqual([
			"pending → running",
			"running → awaiting_review",
			"awaiting_review → rejected",
			"rejected → running",
			"running → completed",
		]);
	});
});
