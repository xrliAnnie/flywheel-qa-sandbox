import { describe, it, expect, vi } from "vitest";
import { StateStore } from "../StateStore.js";
import { TeamLeadBrain } from "../TeamLeadBrain.js";

function mockAnthropicClient(responseText: string) {
	return {
		messages: {
			create: vi.fn().mockResolvedValue({
				content: [{ type: "text", text: responseText }],
			}),
		},
	} as any;
}

describe("Brain E2E", () => {
	it("CEO asks about specific issue → gets answer with issue detail", async () => {
		const store = await StateStore.create(":memory:");

		// Simulate orchestrator ingesting session events
		store.upsertSession({
			execution_id: "exec-abc",
			issue_id: "GEO-95",
			project_name: "geoforge3d",
			status: "awaiting_review",
			issue_identifier: "GEO-95",
			issue_title: "Refactor auth middleware",
			started_at: "2024-01-01 10:00:00",
			last_activity_at: "2024-01-01 10:30:00",
			commit_count: 3,
			files_changed: 6,
			lines_added: 120,
			lines_removed: 45,
			summary: "Refactored JWT verification and added token refresh logic",
			decision_route: "needs_review",
			decision_reasoning: "Auth changes require human review",
		});

		const client = mockAnthropicClient(
			"GEO-95 完成了 auth 中间件重构，3 个 commit 改了 6 个文件，正在等 review。",
		);
		const brain = new TeamLeadBrain(
			{ model: "claude-sonnet-4-5-20250514", maxTokens: 1024 },
			store,
			"test-key",
			client,
		);

		const answer = await brain.answer("GEO-95 怎么样了？");

		// Verify answer returned
		expect(answer).toContain("GEO-95");

		// Verify Anthropic was called with issue context
		const call = client.messages.create.mock.calls[0]![0];
		expect(call.system).toContain("TeamLead");
		expect(call.messages[0].content).toContain("<issue_detail");
		expect(call.messages[0].content).toContain("GEO-95");
		expect(call.messages[0].content).toContain("Refactor auth middleware");
		expect(call.messages[0].content).toContain("<agent_status>");

		store.close();
	});

	it("CEO asks in notification thread → gets answer with thread context", async () => {
		const store = await StateStore.create(":memory:");

		// Session exists
		store.upsertSession({
			execution_id: "exec-def",
			issue_id: "GEO-96",
			project_name: "geoforge3d",
			status: "running",
			issue_identifier: "GEO-96",
			issue_title: "Add payment API",
			started_at: "2024-01-01 11:00:00",
			last_activity_at: "2024-01-01 11:15:00",
		});

		// Thread was created by TemplateNotifier
		store.upsertThread("1234.5678", "C07XXX", "GEO-96");

		const client = mockAnthropicClient(
			"GEO-96 正在运行，已启动 15 分钟。",
		);
		const brain = new TeamLeadBrain(
			{ model: "claude-sonnet-4-5-20250514", maxTokens: 1024 },
			store,
			"test-key",
			client,
		);

		// CEO replies in thread without mentioning issue ID
		const answer = await brain.answer("现在怎么样了？", "1234.5678");

		expect(answer).toContain("GEO-96");

		// Verify thread context was used to find the issue
		const call = client.messages.create.mock.calls[0]![0];
		expect(call.messages[0].content).toContain("<issue_detail");
		expect(call.messages[0].content).toContain("GEO-96");

		store.close();
	});
});
