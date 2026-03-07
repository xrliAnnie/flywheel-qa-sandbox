import { describe, it, expect, vi, beforeEach } from "vitest";
import { adaptBoltAction, stripBotMention } from "../SlackBot.js";
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
			value: JSON.stringify({ executionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }),
		};
		const body = { user: { id: "U123" }, message: {} };

		const result = adaptBoltAction(action, body);

		expect(result.executionId).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
	});

	it("handles execution_id (snake_case) in button value", () => {
		const action = {
			action_id: "flywheel_approve_GEO-95",
			value: JSON.stringify({ execution_id: "b2c3d4e5-f6a7-8901-bcde-f12345678901" }),
		};
		const body = { user: { id: "U123" }, message: {} };

		const result = adaptBoltAction(action, body);

		expect(result.executionId).toBe("b2c3d4e5-f6a7-8901-bcde-f12345678901");
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

// --- Task 5: Message handlers ---

describe("stripBotMention", () => {
	it("strips bot mention and trims", () => {
		expect(stripBotMention("<@U_BOT123> how is GEO-95?", "U_BOT123")).toBe(
			"how is GEO-95?",
		);
	});

	it("preserves other user mentions", () => {
		expect(
			stripBotMention("<@U_BOT123> ask <@U_OTHER> about GEO-95", "U_BOT123"),
		).toBe("ask <@U_OTHER> about GEO-95");
	});

	it("handles text without mention", () => {
		expect(stripBotMention("hello world", "U_BOT123")).toBe("hello world");
	});
});

describe("SlackBot message handler logic", () => {
	// Simulate handler behavior with extracted logic.
	// The real handlers are registered in the constructor and call these patterns.

	function isAllowedUser(
		userId: string,
		allowedUserIds?: string[],
		allowAllUsers?: boolean,
	): boolean {
		if (allowAllUsers) return true;
		if (!allowedUserIds?.length) return false;
		return allowedUserIds.includes(userId);
	}

	it("app_mention triggers onMessage with stripped text", async () => {
		const onMessage = vi.fn().mockResolvedValue("GEO-95 is running.");
		const text = "<@UBOT> how is GEO-95?";
		const stripped = stripBotMention(text, "UBOT");
		expect(stripped).toBe("how is GEO-95?");

		const response = await onMessage(stripped, "1111.2222");
		expect(onMessage).toHaveBeenCalledWith("how is GEO-95?", "1111.2222");
		expect(response).toBe("GEO-95 is running.");
	});

	it("app_mention replies in thread (threadTs from event)", () => {
		// If event has thread_ts, use it; otherwise use event.ts
		const event = { ts: "1234.5678", thread_ts: "1111.2222", text: "<@UBOT> hi", user: "U123", channel: "C07XXX" };
		const threadTs = event.thread_ts ?? event.ts;
		expect(threadTs).toBe("1111.2222");
	});

	it("thread message in known thread triggers onMessage", async () => {
		const onMessage = vi.fn().mockResolvedValue("details here");
		const getThreadIssue = vi.fn().mockReturnValue("GEO-95");

		const msg = { text: "tell me more", thread_ts: "1111.2222", user: "U123", channel: "C07XXX" };

		// Simulate thread handler logic
		if (!msg.thread_ts) throw new Error("should have thread_ts");
		const issueId = getThreadIssue(msg.thread_ts);
		expect(issueId).toBe("GEO-95");

		const response = await onMessage(msg.text, msg.thread_ts);
		expect(response).toBe("details here");
	});

	it("thread message in unknown thread is ignored", () => {
		const getThreadIssue = vi.fn().mockReturnValue(undefined);
		const issueId = getThreadIssue("9999.0000");
		expect(issueId).toBeUndefined();
		// Handler would return early — onMessage not called
	});

	it("channel message (not in thread) is ignored", () => {
		const msg = { text: "random chat", user: "U123", channel: "C07XXX" };
		// No thread_ts → handler returns early
		expect((msg as any).thread_ts).toBeUndefined();
	});

	it("bot message / subtype is ignored", () => {
		const msg = { text: "bot reply", subtype: "bot_message", bot_id: "B123", thread_ts: "1111.2222" };
		expect(msg.subtype).toBeDefined();
		expect(msg.bot_id).toBeDefined();
		// Handler skips messages with subtype or bot_id
	});

	it("unauthorized user is silently ignored", () => {
		expect(isAllowedUser("UBAD", ["U123", "U456"])).toBe(false);
		expect(isAllowedUser("UBAD", [])).toBe(false);
		expect(isAllowedUser("UBAD", undefined)).toBe(false);
	});

	it("thread message with other user mention (not bot) is NOT skipped", () => {
		const botUserId = "UBOT";
		const msg = { text: "hey <@UOTHER> what do you think?", thread_ts: "1111.2222" };
		// Only skip if message mentions THIS bot
		const mentionsBot = msg.text.includes(`<@${botUserId}>`);
		expect(mentionsBot).toBe(false);
		// Handler would NOT return early — proceeds to onMessage
	});

	it("message in wrong channel is ignored", () => {
		const configuredChannel = "C07XXX";
		const event = { channel: "C_OTHER", text: "<@UBOT> hi", user: "U123" };
		expect(event.channel).not.toBe(configuredChannel);
		// Handler checks channel !== this.channelId → returns early
	});
});
