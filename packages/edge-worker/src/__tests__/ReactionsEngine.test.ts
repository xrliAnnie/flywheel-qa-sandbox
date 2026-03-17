import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionHandler, ActionResult } from "../ReactionsEngine.js";
import { ReactionsEngine } from "../ReactionsEngine.js";
import type { SlackAction } from "../SlackInteractionServer.js";

function makeAction(overrides?: Partial<SlackAction>): SlackAction {
	return {
		actionId: "flywheel_approve_issue-123",
		issueId: "issue-123",
		action: "approve",
		userId: "U12345",
		responseUrl: "https://hooks.slack.com/respond",
		messageTs: "1704110400.000100",
		...overrides,
	};
}

function makeHandler(result?: Partial<ActionResult>): ActionHandler {
	return {
		execute: vi.fn().mockResolvedValue({
			success: true,
			message: "Done",
			...result,
		}),
	};
}

describe("ReactionsEngine", () => {
	let engine: ReactionsEngine;
	let approveHandler: ActionHandler;
	let rejectHandler: ActionHandler;

	beforeEach(() => {
		approveHandler = makeHandler({ message: "PR merged" });
		rejectHandler = makeHandler({ message: "Issue rejected" });
		engine = new ReactionsEngine({
			approve: approveHandler,
			reject: rejectHandler,
		});
	});

	it("dispatches to correct handler", async () => {
		const result = await engine.dispatch(makeAction({ action: "approve" }));
		expect(approveHandler.execute).toHaveBeenCalledTimes(1);
		expect(rejectHandler.execute).not.toHaveBeenCalled();
		expect(result.success).toBe(true);
		expect(result.message).toBe("PR merged");
	});

	it("dedup prevents second execution", async () => {
		const action = makeAction();
		await engine.dispatch(action);
		const result = await engine.dispatch(action);

		expect(approveHandler.execute).toHaveBeenCalledTimes(1);
		expect(result.success).toBe(false);
		expect(result.message).toContain("already processed");
	});

	it("unknown action returns error result", async () => {
		const result = await engine.dispatch(
			makeAction({ action: "unknown_action" }),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("No handler");
	});

	it("handler failure returns failure result", async () => {
		const failHandler: ActionHandler = {
			execute: vi.fn().mockRejectedValue(new Error("GitHub API down")),
		};
		const eng = new ReactionsEngine({ approve: failHandler });
		const result = await eng.dispatch(makeAction({ action: "approve" }));

		expect(result.success).toBe(false);
		expect(result.message).toContain("GitHub API down");
	});

	it("different issueIds are independent (no cross-dedup)", async () => {
		const action1 = makeAction({
			actionId: "flywheel_approve_issue-1",
			issueId: "issue-1",
			messageTs: "ts1",
		});
		const action2 = makeAction({
			actionId: "flywheel_approve_issue-2",
			issueId: "issue-2",
			messageTs: "ts2",
		});

		await engine.dispatch(action1);
		await engine.dispatch(action2);

		expect(approveHandler.execute).toHaveBeenCalledTimes(2);
	});
});
