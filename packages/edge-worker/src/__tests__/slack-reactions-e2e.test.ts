import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionResult, ExecutionContext } from "flywheel-core";
import { SlackNotifier } from "../SlackNotifier.js";
import { SlackInteractionServer } from "../SlackInteractionServer.js";
import { ReactionsEngine } from "../ReactionsEngine.js";
import type { ActionHandler } from "../ReactionsEngine.js";

// Keep real fetch — E2E tests use real HTTP to interaction server.
// SlackMessageService is mocked at object level (not via global fetch).

function makeCtx(overrides?: Partial<ExecutionContext>): ExecutionContext {
	return {
		executionId: "test-exec-id",
		issueId: "e2e-test-1",
		issueIdentifier: "GEO-99",
		issueTitle: "E2E smoke test issue",
		labels: [],
		projectId: "test",
		exitReason: "completed",
		baseSha: "abc",
		commitCount: 3,
		commitMessages: ["feat: add widget", "test: widget tests"],
		changedFilePaths: ["src/widget.ts"],
		filesChangedCount: 1,
		linesAdded: 50,
		linesRemoved: 5,
		diffSummary: "+50 -5",
		headSha: "def456",
		durationMs: 60000,
		consecutiveFailures: 0,
		partial: false,
		...overrides,
	};
}

function buildInteractionPayload(
	actionId: string,
	issueId: string,
	action: string,
): string {
	const payload = {
		type: "block_actions",
		user: { id: "U_CEO" },
		actions: [
			{
				action_id: actionId,
				value: JSON.stringify({ issueId, action }),
			},
		],
		response_url: "https://hooks.slack.com/respond",
		message: { ts: "1704110400.000100" },
	};
	return `payload=${encodeURIComponent(JSON.stringify(payload))}`;
}

describe("Slack Reactions E2E", () => {
	let interactionServer: SlackInteractionServer;

	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(async () => {
		if (interactionServer) {
			await interactionServer.stop();
		}
	});

	it("full needs_review loop: notify → button click → approve", async () => {
		// 1. Setup
		const mockMessageService = { postMessage: vi.fn().mockResolvedValue(undefined) } as any;
		const notifier = new SlackNotifier(
			{ channelId: "C07TEST", botToken: "xoxb-test", projectRepo: "test/repo" },
			mockMessageService,
		);

		interactionServer = new SlackInteractionServer();
		const port = await interactionServer.start();

		const mockApproveHandler: ActionHandler = {
			execute: vi.fn().mockResolvedValue({ success: true, message: "PR #42 merged" }),
		};
		const engine = new ReactionsEngine({ approve: mockApproveHandler });

		const decision: DecisionResult = {
			route: "needs_review",
			confidence: 0.8,
			reasoning: "Looks good but needs human check",
			concerns: ["Modified API"],
			decisionSource: "haiku_triage",
		};

		// 2. Send notification
		const notifyResult = await notifier.notify(makeCtx(), decision);
		expect(notifyResult.sent).toBe(true);

		// 3. Verify Block Kit was sent
		expect(mockMessageService.postMessage).toHaveBeenCalledTimes(1);
		const sentMsg = mockMessageService.postMessage.mock.calls[0][0];
		expect(sentMsg.blocks).toBeDefined();
		const header = sentMsg.blocks.find((b: any) => b.type === "header");
		expect(header.text.text).toContain("GEO-99");

		// 4. Simulate CEO clicking "Approve & Merge"
		const waitPromise = interactionServer.waitForAction("e2e-test-1", 5000);
		await new Promise((r) => setTimeout(r, 10));

		await fetch(`http://127.0.0.1:${port}/slack/interaction`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: buildInteractionPayload(
				"flywheel_approve_e2e-test-1",
				"e2e-test-1",
				"approve",
			),
		});

		const action = await waitPromise;
		expect(action).not.toBeNull();
		expect(action!.action).toBe("approve");

		// 5. Dispatch action
		const actionResult = await engine.dispatch(action!);
		expect(actionResult.success).toBe(true);
		expect(actionResult.message).toBe("PR #42 merged");
		expect(mockApproveHandler.execute).toHaveBeenCalledTimes(1);
	});

	it("full blocked loop: notify → button click → retry", async () => {
		const mockMessageService = { postMessage: vi.fn().mockResolvedValue(undefined) } as any;
		const notifier = new SlackNotifier(
			{ channelId: "C07TEST", botToken: "xoxb-test" },
			mockMessageService,
		);

		interactionServer = new SlackInteractionServer();
		const port = await interactionServer.start();

		const mockRetryHandler: ActionHandler = {
			execute: vi.fn().mockResolvedValue({ success: true, message: "Retry queued" }),
		};
		const engine = new ReactionsEngine({ retry: mockRetryHandler });

		const decision: DecisionResult = {
			route: "blocked",
			confidence: 1.0,
			reasoning: "Zero commits — runner failed",
			concerns: [],
			decisionSource: "hard_rule",
			hardRuleId: "HR-009",
		};

		// Notify
		const notifyResult = await notifier.notify(
			makeCtx({ commitCount: 0 }),
			decision,
		);
		expect(notifyResult.sent).toBe(true);

		// Verify blocked header
		const sentMsg = mockMessageService.postMessage.mock.calls[0][0];
		const header = sentMsg.blocks.find((b: any) => b.type === "header");
		expect(header.text.text).toContain("Blocked");

		// Simulate CEO clicking "Retry"
		const waitPromise = interactionServer.waitForAction("e2e-test-1", 5000);
		await new Promise((r) => setTimeout(r, 10));

		await fetch(`http://127.0.0.1:${port}/slack/interaction`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: buildInteractionPayload(
				"flywheel_retry_e2e-test-1",
				"e2e-test-1",
				"retry",
			),
		});

		const action = await waitPromise;
		expect(action).not.toBeNull();

		const actionResult = await engine.dispatch(action!);
		expect(actionResult.success).toBe(true);
		expect(mockRetryHandler.execute).toHaveBeenCalledTimes(1);
	});

	it("timeout: no button click → waitForAction returns null", async () => {
		interactionServer = new SlackInteractionServer();
		await interactionServer.start();

		const action = await interactionServer.waitForAction("timeout-test", 100);
		expect(action).toBeNull();
	});
});
