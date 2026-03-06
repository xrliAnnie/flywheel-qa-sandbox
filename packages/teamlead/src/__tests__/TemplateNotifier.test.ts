import { describe, it, expect, vi, beforeEach } from "vitest";
import { TemplateNotifier } from "../TemplateNotifier.js";
import type { Session } from "../StateStore.js";

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		execution_id: "exec-1",
		issue_id: "GEO-95",
		project_name: "geoforge",
		status: "awaiting_review",
		issue_identifier: "GEO-95",
		issue_title: "Fix rendering bug",
		decision_route: "needs_review",
		decision_reasoning: "Large diff needs human review",
		commit_count: 3,
		files_changed: 5,
		lines_added: 120,
		lines_removed: 40,
		...overrides,
	};
}

function makeMockBot() {
	return {
		postMessage: vi.fn().mockResolvedValue("1234567890.123456"),
		start: vi.fn(),
		stop: vi.fn(),
	};
}

function makeMockStore() {
	return {
		upsertThread: vi.fn(),
	};
}

describe("TemplateNotifier", () => {
	let bot: ReturnType<typeof makeMockBot>;
	let store: ReturnType<typeof makeMockStore>;
	let notifier: TemplateNotifier;

	beforeEach(() => {
		bot = makeMockBot();
		store = makeMockStore();
		notifier = new TemplateNotifier(bot as any, store as any);
	});

	it("onSessionCompleted sends Block Kit with correct header for needs_review", async () => {
		const session = makeSession({ status: "awaiting_review", decision_route: "needs_review" });
		await notifier.onSessionCompleted(session);

		expect(bot.postMessage).toHaveBeenCalledTimes(1);
		const [text, blocks] = bot.postMessage.mock.calls[0];
		expect(text).toBe("Review Required: GEO-95");
		expect(blocks).toBeDefined();
		expect(blocks[0]).toEqual({
			type: "header",
			text: { type: "plain_text", text: "Review Required: GEO-95" },
		});
	});

	it("onSessionCompleted includes action buttons for needs_review", async () => {
		const session = makeSession({ status: "awaiting_review", decision_route: "needs_review" });
		await notifier.onSessionCompleted(session);

		const blocks = bot.postMessage.mock.calls[0][1] as any[];
		const actionsBlock = blocks.find((b: any) => b.type === "actions");
		expect(actionsBlock).toBeDefined();
		const actionIds = actionsBlock.elements.map((e: any) => e.action_id);
		expect(actionIds).toContain("flywheel_approve_GEO-95");
		expect(actionIds).toContain("flywheel_reject_GEO-95");
		expect(actionIds).toContain("flywheel_defer_GEO-95");
	});

	it("onSessionFailed sends error info with retry/shelve buttons", async () => {
		const session = makeSession({
			status: "failed",
			last_error: "Build failed: tsc error",
		});
		await notifier.onSessionFailed(session);

		expect(bot.postMessage).toHaveBeenCalledTimes(1);
		const [text, blocks] = bot.postMessage.mock.calls[0];
		expect(text).toBe("Failed: GEO-95");

		const sectionBlock = blocks.find(
			(b: any) => b.type === "section" && b.text?.text?.includes("Build failed"),
		);
		expect(sectionBlock).toBeDefined();

		const actionsBlock = blocks.find((b: any) => b.type === "actions");
		const actionIds = actionsBlock.elements.map((e: any) => e.action_id);
		expect(actionIds).toContain("flywheel_retry_GEO-95");
		expect(actionIds).toContain("flywheel_shelve_GEO-95");
	});

	it("onSessionStuck sends warning with minutes", async () => {
		const session = makeSession({
			status: "running",
			started_at: "2026-03-06 10:00:00",
		});
		await notifier.onSessionStuck(session, 25);

		expect(bot.postMessage).toHaveBeenCalledTimes(1);
		const [text, blocks] = bot.postMessage.mock.calls[0];
		expect(text).toBe("Possible Stuck: GEO-95");

		const sectionBlock = blocks.find(
			(b: any) => b.type === "section" && b.text?.text?.includes("25"),
		);
		expect(sectionBlock).toBeDefined();
	});

	it("stores thread_ts after sending", async () => {
		const session = makeSession();
		await notifier.onSessionCompleted(session);

		expect(store.upsertThread).toHaveBeenCalledWith(
			"1234567890.123456",
			"",
			"GEO-95",
		);
	});
});
