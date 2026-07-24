import { describe, expect, it, vi } from "vitest";
import type { FounderDecisionConvergenceRow } from "../../StateStore.js";
import { runFounderDecisionConvergencePass } from "../founder-decision-convergence.js";

const row = (
	over: Partial<FounderDecisionConvergenceRow> = {},
): FounderDecisionConvergenceRow => ({
	thread_id: "thread",
	msg_id: "msg",
	question_id: "q",
	project_name: "flywheel",
	lead_id: "lead",
	execution_id: "exec",
	classification: "approve",
	card_reference_valid: 0,
	disposed_at_ms: 1,
	deadline_at_ms: 100,
	resolved_at_ms: null,
	resolution: null,
	alerted_at_ms: null,
	...over,
});

describe("founder decision convergence pass", () => {
	it("resolves candidates per question before claiming alerts", async () => {
		const first = row({ question_id: "q-a" });
		const second = row({ question_id: "q-b" });
		const resolveFounderDecisionConvergence = vi.fn();
		const store = {
			listFounderDecisionConvergence: vi.fn(() => [first, second]),
			resolveFounderDecisionConvergence,
			claimOverdueFounderDecisionAlerts: vi.fn(() => []),
			releaseFounderDecisionAlertClaim: vi.fn(),
		};

		await runFounderDecisionConvergencePass({
			store,
			resolve: vi.fn(async (candidate) =>
				candidate.question_id === "q-a" ? "response" : null,
			),
			notifyDropped: vi.fn(),
			now: () => 200,
		});

		expect(resolveFounderDecisionConvergence).toHaveBeenCalledOnce();
		expect(resolveFounderDecisionConvergence).toHaveBeenCalledWith(
			expect.objectContaining({ questionId: "q-a", resolution: "response" }),
		);
	});

	it("releases a claimed alert when durable Lead notification was not accepted", async () => {
		const overdue = row({ alerted_at_ms: 200 });
		const releaseFounderDecisionAlertClaim = vi.fn();
		const result = await runFounderDecisionConvergencePass({
			store: {
				listFounderDecisionConvergence: vi.fn(() => []),
				resolveFounderDecisionConvergence: vi.fn(),
				claimOverdueFounderDecisionAlerts: vi.fn(() => [overdue]),
				releaseFounderDecisionAlertClaim,
			},
			resolve: vi.fn(),
			notifyDropped: vi.fn(async () => false),
			now: () => 200,
		});

		expect(result).toEqual({ resolved: 0, alerted: 0, retried: 1 });
		expect(releaseFounderDecisionAlertClaim).toHaveBeenCalledWith({
			threadId: "thread",
			msgId: "msg",
			questionId: "q",
			expectedAlertedAtMs: 200,
		});
	});
});
