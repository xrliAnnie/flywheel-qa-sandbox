import { describe, expect, it } from "vitest";
import { EventFilter } from "../bridge/EventFilter.js";
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
	});

	describe("Chat-track events — Lead MUST notify Annie in Chat (FLY-47)", () => {
		it("session_started + thread_id exists → notify_agent (high)", () => {
			const result = filter.classify(
				"session_started",
				makePayload({
					thread_id: "thread-123",
				}),
			);
			expect(result.priority).toBe("high");
			expect(result.reason).toContain("Chat");
		});

		it("session_started + NO thread_id → notify_agent (high)", () => {
			const result = filter.classify(
				"session_started",
				makePayload({
					thread_id: undefined,
				}),
			);
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

		it("session_completed with status=completed → ship complete (high + Forum)", () => {
			// FLY-58: completed status matches the "ship complete" rule
			const result = filter.classify(
				"session_completed",
				makePayload({
					status: "completed",
					decision_route: "some_other_route",
				}),
			);
			expect(result.priority).toBe("high");
			expect(result.updateForum).toBe(true);
		});
	});

	describe("Forum gating — updateForum (FLY-47)", () => {
		it("status-changing events → updateForum: true", () => {
			const forumEvents = [
				{ type: "session_started", payload: makePayload() },
				{
					type: "session_completed",
					payload: makePayload({
						status: "awaiting_review",
						decision_route: "needs_review",
					}),
				},
				{
					type: "session_failed",
					payload: makePayload({ status: "failed" }),
				},
				{
					type: "action_executed",
					payload: makePayload({ action: "approve" }),
				},
			];
			for (const { type, payload } of forumEvents) {
				const result = filter.classify(type, payload);
				expect(result.updateForum).toBe(true);
			}
		});

		it("informational events → updateForum: false", () => {
			const noForumEvents = [
				"session_stuck",
				"session_orphaned",
				"session_stale_completed",
				"cipher_principle_proposed",
				"unknown_event",
			];
			for (const type of noForumEvents) {
				const result = filter.classify(type, makePayload());
				expect(result.updateForum).toBe(false);
			}
		});
	});

	describe("Edge cases", () => {
		it("empty payload session_completed → catch-all (normal + Forum)", () => {
			const result = filter.classify("session_completed", {});
			expect(result.priority).toBe("normal");
			expect(result.updateForum).toBe(true);
		});

		it("null-ish fields in payload → no crash", () => {
			const result = filter.classify("session_started", {
				thread_id: undefined,
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
