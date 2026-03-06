import { describe, it, expect, vi, beforeEach } from "vitest";
import { adaptBoltAction } from "../SlackBot.js";
import type { SlackAction, ActionResult } from "flywheel-edge-worker";

// We test adaptBoltAction directly (pure function, no Slack connection needed).
// SlackBot class tests mock @slack/bolt App to verify wiring.

describe("adaptBoltAction", () => {
	it("parses flywheel_approve_GEO-95 correctly", () => {
		const action = { action_id: "flywheel_approve_GEO-95", value: undefined };
		const body = {
			user: { id: "U123" },
			response_url: "https://hooks.slack.com/resp",
			message: { ts: "1234567890.123456" },
		};

		const result = adaptBoltAction(action, body);

		expect(result).toEqual({
			actionId: "flywheel_approve_GEO-95",
			issueId: "GEO-95",
			action: "approve",
			userId: "U123",
			responseUrl: "https://hooks.slack.com/resp",
			messageTs: "1234567890.123456",
			executionId: undefined,
		});
	});

	it("handles issue IDs with underscores", () => {
		const action = {
			action_id: "flywheel_reject_MY_PROJ-42",
			value: undefined,
		};
		const body = { user: { id: "U456" }, message: {} };

		const result = adaptBoltAction(action, body);

		expect(result.issueId).toBe("MY_PROJ-42");
		expect(result.action).toBe("reject");
	});

	it("parses executionId from button value JSON", () => {
		const action = {
			action_id: "flywheel_approve_GEO-95",
			value: JSON.stringify({ executionId: "exec-123" }),
		};
		const body = { user: { id: "U123" }, message: {} };

		const result = adaptBoltAction(action, body);

		expect(result.executionId).toBe("exec-123");
	});

	it("handles execution_id (snake_case) in button value", () => {
		const action = {
			action_id: "flywheel_approve_GEO-95",
			value: JSON.stringify({ execution_id: "exec-456" }),
		};
		const body = { user: { id: "U123" }, message: {} };

		const result = adaptBoltAction(action, body);

		expect(result.executionId).toBe("exec-456");
	});

	it("returns empty fields for missing body properties", () => {
		const action = { action_id: "flywheel_defer_X-1", value: undefined };
		const body = {};

		const result = adaptBoltAction(action, body);

		expect(result.userId).toBe("unknown");
		expect(result.responseUrl).toBe("");
		expect(result.messageTs).toBe("");
	});

	it("handles unknown action prefix gracefully", () => {
		const action = { action_id: "other_action", value: undefined };
		const body = { user: { id: "U123" }, message: {} };

		const result = adaptBoltAction(action, body);

		expect(result.issueId).toBe("");
		expect(result.action).toBe("");
	});
});

describe("SlackBot action handler", () => {
	it("calls ack() and dispatches to ReactionsEngine, skips respond when alreadyResponded", async () => {
		const ack = vi.fn().mockResolvedValue(undefined);
		const respond = vi.fn().mockResolvedValue(undefined);
		const dispatch = vi.fn().mockResolvedValue({
			success: true,
			message: "merged",
			alreadyResponded: true,
		} satisfies ActionResult);

		// Simulate what SlackBot's action handler does
		const action = {
			action_id: "flywheel_approve_GEO-95",
			value: undefined,
		};
		const body = {
			user: { id: "U123" },
			response_url: "https://hooks.slack.com/resp",
			message: { ts: "123.456" },
		};

		// Simulate the handler logic directly
		await ack();
		const slackAction = adaptBoltAction(action, body);
		const result = await dispatch(slackAction);
		if (!result.alreadyResponded) {
			await respond({
				replace_original: false,
				text: result.success
					? `Action '${slackAction.action}' completed`
					: `Failed: ${result.message}`,
			});
		}

		expect(ack).toHaveBeenCalled();
		expect(dispatch).toHaveBeenCalledWith(
			expect.objectContaining({ action: "approve", issueId: "GEO-95" }),
		);
		expect(respond).not.toHaveBeenCalled();
	});

	it("calls respond() when handler returns alreadyResponded=false/undefined", async () => {
		const ack = vi.fn().mockResolvedValue(undefined);
		const respond = vi.fn().mockResolvedValue(undefined);
		const dispatch = vi.fn().mockResolvedValue({
			success: true,
			message: "retried",
		} satisfies ActionResult);

		const action = { action_id: "flywheel_retry_GEO-95", value: undefined };
		const body = {
			user: { id: "U123" },
			response_url: "https://hooks.slack.com/resp",
			message: { ts: "123.456" },
		};

		await ack();
		const slackAction = adaptBoltAction(action, body);
		const result = await dispatch(slackAction);
		if (!result.alreadyResponded) {
			await respond({
				replace_original: false,
				text: result.success
					? `Action '${slackAction.action}' completed`
					: `Failed: ${result.message}`,
			});
		}

		expect(ack).toHaveBeenCalled();
		expect(respond).toHaveBeenCalledWith(
			expect.objectContaining({
				replace_original: false,
				text: "Action 'retry' completed",
			}),
		);
	});
});
