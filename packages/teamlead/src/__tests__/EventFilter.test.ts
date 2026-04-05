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
			expect(result.action).toBe("notify_agent");
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
			expect(result.action).toBe("notify_agent");
			expect(result.priority).toBe("high");
		});

		it("session_failed → notify_agent (high)", () => {
			const result = filter.classify(
				"session_failed",
				makePayload({
					status: "failed",
				}),
			);
			expect(result.action).toBe("notify_agent");
			expect(result.priority).toBe("high");
		});
	});

	describe("NORMAL priority — important updates", () => {
		it("session_stuck → notify_agent (normal)", () => {
			const result = filter.classify(
				"session_stuck",
				makePayload({
					status: "running",
					minutes_since_activity: 20,
				}),
			);
			expect(result.action).toBe("notify_agent");
			expect(result.priority).toBe("normal");
		});

		it("session_orphaned → notify_agent (normal)", () => {
			const result = filter.classify(
				"session_orphaned",
				makePayload({
					status: "running",
				}),
			);
			expect(result.action).toBe("notify_agent");
			expect(result.priority).toBe("normal");
		});

		it("action_executed → notify_agent (normal)", () => {
			const result = filter.classify(
				"action_executed",
				makePayload({
					action: "approve",
				}),
			);
			expect(result.action).toBe("notify_agent");
			expect(result.priority).toBe("normal");
		});

		it("cipher_principle_proposed → notify_agent (normal)", () => {
			const result = filter.classify(
				"cipher_principle_proposed",
				makePayload(),
			);
			expect(result.action).toBe("notify_agent");
			expect(result.priority).toBe("normal");
		});
	});

	describe("LOW priority — silent Forum updates", () => {
		it("session_started + thread_id exists → forum_only (low)", () => {
			const result = filter.classify(
				"session_started",
				makePayload({
					thread_id: "thread-123",
				}),
			);
			expect(result.action).toBe("forum_only");
			expect(result.priority).toBe("low");
		});

		it("session_started + NO thread_id → notify_agent (normal) — agent creates Forum Post", () => {
			const result = filter.classify(
				"session_started",
				makePayload({
					thread_id: undefined,
				}),
			);
			expect(result.action).toBe("notify_agent");
			expect(result.priority).toBe("normal");
		});

		// FLY-58/FLY-61: approved completion now notifies agent (was forum_only)
		it("session_completed + approved → notify_agent (normal)", () => {
			const result = filter.classify(
				"session_completed",
				makePayload({
					status: "approved",
					decision_route: "approved",
				}),
			);
			expect(result.action).toBe("notify_agent");
			expect(result.priority).toBe("normal");
		});
	});

	describe("DEFAULT — unmatched events", () => {
		it("unknown event type → notify_agent (normal)", () => {
			const result = filter.classify("some_unknown_event", makePayload());
			expect(result.action).toBe("notify_agent");
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

		it("session_completed without special route/status → default notify_agent", () => {
			const result = filter.classify(
				"session_completed",
				makePayload({
					status: "completed",
					decision_route: "some_other_route",
				}),
			);
			expect(result.action).toBe("notify_agent");
			expect(result.priority).toBe("normal");
		});
	});

	describe("Edge cases", () => {
		it("empty payload → default behavior", () => {
			const result = filter.classify("session_completed", {});
			expect(result.action).toBe("notify_agent");
			expect(result.priority).toBe("normal");
		});

		it("null-ish fields in payload → no crash", () => {
			const result = filter.classify("session_started", {
				thread_id: undefined,
				status: undefined,
			});
			expect(result.action).toBe("notify_agent");
			expect(result.priority).toBe("normal");
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
