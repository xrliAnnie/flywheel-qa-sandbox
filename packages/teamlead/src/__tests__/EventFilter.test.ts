import { describe, expect, it } from "vitest";
import {
	EventFilter,
	leadEventDeliveryDisposition,
	leadNotificationDecision,
} from "../bridge/EventFilter.js";
import type { HookPayload } from "../bridge/hook-payload.js";

function makePayload(
	overrides: Partial<HookPayload> = {},
): Partial<HookPayload> {
	return {
		execution_id: "exec-1",
		issue_id: "issue-1",
		status: "running",
		...overrides,
	};
}

describe("EventFilter", () => {
	const filter = new EventFilter();

	describe("HIGH priority — needs CEO decision", () => {
		it("session_completed + needs_review → notify_agent (high)", () => {
			const result = filter.classify(
				"session_completed",
				makePayload({
					status: "awaiting_review",
					decision_route: "needs_review",
				}),
			);
			expect(result.priority).toBe("high");
		});

		it("session_completed + blocked → notify_agent (high)", () => {
			const result = filter.classify(
				"session_completed",
				makePayload({
					status: "blocked",
					decision_route: "blocked",
				}),
			);
			expect(result.priority).toBe("high");
		});

		it("session_failed → notify_agent (high)", () => {
			const result = filter.classify(
				"session_failed",
				makePayload({
					status: "failed",
				}),
			);
			expect(result.priority).toBe("high");
		});
	});

	describe("NORMAL priority — important updates", () => {
		it("session_stuck → notify_agent (high — must Chat notify Annie)", () => {
			const result = filter.classify(
				"session_stuck",
				makePayload({
					status: "running",
					minutes_since_activity: 20,
				}),
			);
			expect(result.priority).toBe("high");
		});

		// FLY-159 (FLY-163: Forum surface removed — only verify chat priority + reason)
		it("gate_timed_out → notify_agent (high) via chat", () => {
			const result = filter.classify(
				"gate_timed_out",
				makePayload({
					status: "running",
					checkpoint: "brainstorm",
					waited_ms: 172_800_000,
					timeout_behavior: "fail-close",
				}),
			);
			expect(result.priority).toBe("high");
			expect(result.reason).toMatch(/gate timed out/);
		});

		it("session_orphaned → notify_agent (normal)", () => {
			const result = filter.classify(
				"session_orphaned",
				makePayload({
					status: "running",
				}),
			);
			expect(result.priority).toBe("normal");
		});

		it("action_executed → notify_agent (normal)", () => {
			const result = filter.classify(
				"action_executed",
				makePayload({
					action: "approve",
				}),
			);
			expect(result.priority).toBe("normal");
		});

		it("cipher_principle_proposed → notify_agent (normal)", () => {
			const result = filter.classify(
				"cipher_principle_proposed",
				makePayload(),
			);
			expect(result.priority).toBe("normal");
		});

		it("session_monitoring_lost → normal (FLY-172, advisory not Annie-emergency)", () => {
			const result = filter.classify(
				"session_monitoring_lost",
				makePayload({ status: "running" }),
			);
			expect(result.priority).toBe("normal");
			expect(result.reason).toContain("monitoring lost");
		});
	});

	describe("Chat-track events — Lead MUST notify Annie in Chat (FLY-47)", () => {
		it("session_started → notify_agent (high)", () => {
			// FLY-163: single chat-only rule replaces the old forum-vs-no-forum split.
			const result = filter.classify("session_started", makePayload());
			expect(result.priority).toBe("high");
			expect(result.reason).toContain("Chat");
		});

		it("session_completed + approved → notify_agent (high) — ship complete", () => {
			const result = filter.classify(
				"session_completed",
				makePayload({
					status: "approved",
					decision_route: "approved",
				}),
			);
			expect(result.priority).toBe("high");
			expect(result.reason).toContain("Chat");
		});
	});

	describe("DEFAULT — unmatched events", () => {
		it("unknown event type → notify_agent (normal)", () => {
			const result = filter.classify("some_unknown_event", makePayload());
			expect(result.priority).toBe("normal");
			expect(result.reason).toContain("default");
		});
	});

	describe("Priority ordering", () => {
		it("high rules are not overridden by low rules", () => {
			// session_completed + needs_review should be HIGH, not LOW
			const result = filter.classify(
				"session_completed",
				makePayload({
					status: "awaiting_review",
					decision_route: "needs_review",
				}),
			);
			expect(result.priority).toBe("high");
		});

		it("session_completed with status=completed → ship complete (high)", () => {
			// FLY-58: completed status matches the "ship complete" rule
			const result = filter.classify(
				"session_completed",
				makePayload({
					status: "completed",
					decision_route: "some_other_route",
				}),
			);
			expect(result.priority).toBe("high");
		});
	});

	describe("Edge cases", () => {
		it("empty payload session_completed → catch-all (normal)", () => {
			const result = filter.classify("session_completed", {});
			expect(result.priority).toBe("normal");
		});

		it("null-ish fields in payload → no crash", () => {
			const result = filter.classify("session_started", {
				status: undefined,
			});
			expect(result.priority).toBe("high");
		});

		it("result always includes a reason", () => {
			const events = [
				"session_completed",
				"session_failed",
				"session_started",
				"session_stuck",
				"action_executed",
				"unknown",
			];
			for (const e of events) {
				const result = filter.classify(e, makePayload());
				expect(result.reason).toBeTruthy();
			}
		});
	});
});

describe("routine event delivery disposition", () => {
	it("keeps session_started immediate after authoritative session registration", () => {
		expect(
			leadNotificationDecision(
				"session_started",
				{ status: "running" },
				{
					kind: "session_registered",
					proofRef: "session-event:started-1",
				},
			),
		).toEqual({
			disposition: "model",
			reason: "session_started_handoff_required",
			policyVersion: "notification-v1",
			proofRef: "session-event:started-1",
		});
		expect(
			leadNotificationDecision("session_started", { status: "running" }),
		).toMatchObject({ disposition: "model", reason: "proof_missing" });
	});

	it("audits review and PR stages only with authoritative no-action proof", () => {
		for (const stage of ["design_review", "code_review", "pr_created"]) {
			expect(
				leadNotificationDecision(
					"stage_changed",
					{ stage, status: "awaiting_review" },
					{
						kind: "stage_recorded",
						proofRef: `stage:${stage}`,
						actionState: "none",
						reviewOwnerRef: `review-owner:${stage}`,
					},
				),
			).toEqual({
				disposition: "audit_only",
				reason: "routine_stage_owned",
				policyVersion: "notification-v1",
				proofRef: `stage:${stage}`,
			});
		}

		expect(
			leadNotificationDecision(
				"stage_changed",
				{ stage: "design_review", status: "awaiting_review" },
				{
					kind: "stage_recorded",
					proofRef: "stage:design-review",
					actionState: "none",
				},
			),
		).toMatchObject({
			disposition: "model",
			reason: "review_owner_missing",
		});
	});

	it("ignores an inherited decision only when the exact obligation is resolved", () => {
		expect(
			leadNotificationDecision(
				"stage_changed",
				{
					stage: "implement",
					status: "running",
					decision_route: "needs_review",
				},
				{
					kind: "stage_recorded",
					proofRef: "stage:event-1",
					actionState: "resolved",
					actionProofRef: "decision:receipt-1",
				},
			),
		).toEqual({
			disposition: "audit_only",
			reason: "routine_stage_inherited_resolved",
			policyVersion: "notification-v1",
			proofRef: "decision:receipt-1",
		});

		expect(
			leadNotificationDecision(
				"stage_changed",
				{
					stage: "implement",
					status: "running",
					decision_route: "needs_review",
				},
				{
					kind: "stage_recorded",
					proofRef: "stage:event-1",
					actionState: "pending",
				},
			),
		).toMatchObject({ disposition: "model", reason: "action_pending" });
	});

	it("audits only structured routine events from trusted Bridge producers", () => {
		for (const stage of [
			"onboard",
			"brainstorm",
			"research",
			"plan",
			"implement",
			"test",
		]) {
			expect(
				leadEventDeliveryDisposition(
					"stage_changed",
					{ stage, status: "running" },
					true,
				),
			).toBe("audit_only");
			expect(
				leadEventDeliveryDisposition("stage_changed", { stage }, false),
			).toBe("model");
		}
		expect(
			leadEventDeliveryDisposition(
				"session_monitoring_reestablished",
				{},
				true,
			),
		).toBe("audit_only");
		expect(
			leadEventDeliveryDisposition(
				"session_monitoring_reestablished",
				{},
				false,
			),
		).toBe("model");
	});
	it("keeps unknown, actionable, failed, review, ship and founder traffic", () => {
		for (const stage of [
			undefined,
			"unknown",
			"completed",
			"approve",
			"design_review",
			"code_review",
			"ship",
			"pr_created",
		]) {
			expect(
				leadEventDeliveryDisposition("stage_changed", { stage }, true),
			).toBe("model");
		}
		for (const extra of [
			{ status: "failed" },
			{ last_error: "failure" },
			{ decision_route: "needs_review" },
			{ needs_action: true },
			{ checkpoint: "question" },
			{ messages: [{ author: "founder" }] },
		]) {
			expect(
				leadEventDeliveryDisposition(
					"stage_changed",
					{ stage: "test", ...extra },
					true,
				),
			).toBe("model");
		}
		for (const type of [
			"chat",
			"founder_message",
			"unknown",
			"session_failed",
			"review_code",
		]) {
			expect(leadEventDeliveryDisposition(type, { stage: "test" }, true)).toBe(
				"model",
			);
		}
	});
});
