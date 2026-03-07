import { describe, it, expect, vi, beforeEach } from "vitest";
import { TeamLeadBrain } from "../TeamLeadBrain.js";
import { StateStore } from "../StateStore.js";
import type { Session } from "../StateStore.js";

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		execution_id: "exec-1",
		issue_id: "GEO-95",
		project_name: "geoforge3d",
		status: "running",
		issue_identifier: "GEO-95",
		issue_title: "Refactor auth middleware",
		started_at: "2024-01-01 10:00:00",
		last_activity_at: "2024-01-01 10:30:00",
		commit_count: 3,
		files_changed: 6,
		lines_added: 120,
		lines_removed: 45,
		summary: "Refactored JWT verification",
		decision_route: "needs_review",
		decision_reasoning: "Auth changes need human review",
		...overrides,
	};
}

function mockAnthropicClient(responseText: string) {
	return {
		messages: {
			create: vi.fn().mockResolvedValue({
				content: [{ type: "text", text: responseText }],
			}),
		},
	} as any;
}

describe("TeamLeadBrain", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	it("answer with issue ID loads focus session + history", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "GEO-95",
			project_name: "geoforge3d",
			status: "awaiting_review",
			issue_identifier: "GEO-95",
			issue_title: "Refactor auth",
			started_at: "2024-01-01 10:00:00",
			last_activity_at: "2024-01-01 10:30:00",
		});

		const client = mockAnthropicClient("GEO-95 is awaiting review.");
		const brain = new TeamLeadBrain(
			{ model: "claude-sonnet-4-5-20250514", maxTokens: 1024 },
			store,
			"test-key",
			client,
		);

		const result = await brain.answer("How is GEO-95?");
		expect(result).toBe("GEO-95 is awaiting review.");

		// Verify API was called with correct structure
		const call = client.messages.create.mock.calls[0]![0];
		expect(call.model).toBe("claude-sonnet-4-5-20250514");
		expect(call.system).toContain("TeamLead");
		expect(call.messages[0].content).toContain("GEO-95");
		expect(call.messages[0].content).toContain("<issue_detail");
	});

	it("answer in known thread loads issue context from thread", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "GEO-95",
			project_name: "geoforge3d",
			status: "running",
			issue_identifier: "GEO-95",
			started_at: "2024-01-01 10:00:00",
			last_activity_at: "2024-01-01 10:30:00",
		});
		store.upsertThread("1111.2222", "C07XXX", "GEO-95");

		const client = mockAnthropicClient("GEO-95 is still running.");
		const brain = new TeamLeadBrain(
			{ model: "claude-sonnet-4-5-20250514", maxTokens: 1024 },
			store,
			"test-key",
			client,
		);

		const result = await brain.answer("tell me more", "1111.2222");
		expect(result).toBe("GEO-95 is still running.");

		const call = client.messages.create.mock.calls[0]![0];
		expect(call.messages[0].content).toContain("<issue_detail");
	});

	it("answer without issue ID loads only active sessions", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "GEO-95",
			project_name: "geoforge3d",
			status: "running",
			last_activity_at: "2024-01-01 10:30:00",
		});

		const client = mockAnthropicClient("One issue is running.");
		const brain = new TeamLeadBrain(
			{ model: "claude-sonnet-4-5-20250514", maxTokens: 1024 },
			store,
			"test-key",
			client,
		);

		const result = await brain.answer("what's running?");
		expect(result).toBe("One issue is running.");

		const call = client.messages.create.mock.calls[0]![0];
		expect(call.messages[0].content).toContain("<agent_status>");
		expect(call.messages[0].content).not.toContain("<issue_detail");
	});

	it("answer calls Anthropic with correct model and system prompt", async () => {
		const client = mockAnthropicClient("ok");
		const brain = new TeamLeadBrain(
			{ model: "claude-sonnet-4-5-20250514", maxTokens: 512 },
			store,
			"test-key",
			client,
		);

		await brain.answer("hello");

		const call = client.messages.create.mock.calls[0]![0];
		expect(call.model).toBe("claude-sonnet-4-5-20250514");
		expect(call.max_tokens).toBe(512);
		expect(call.system).toBeDefined();
		expect(call.messages).toHaveLength(1);
		expect(call.messages[0].role).toBe("user");
	});

	it("answer returns text from Sonnet response", async () => {
		const client = mockAnthropicClient("Here is the answer.");
		const brain = new TeamLeadBrain(
			{ model: "claude-sonnet-4-5-20250514", maxTokens: 1024 },
			store,
			"test-key",
			client,
		);

		const result = await brain.answer("test question");
		expect(result).toBe("Here is the answer.");
	});

	it("answer handles rate limit error gracefully", async () => {
		const client = {
			messages: {
				create: vi.fn().mockRejectedValue(
					Object.assign(new Error("rate limited"), { status: 429 }),
				),
			},
		} as any;

		const brain = new TeamLeadBrain(
			{ model: "claude-sonnet-4-5-20250514", maxTokens: 1024 },
			store,
			"test-key",
			client,
		);

		const result = await brain.answer("test");
		expect(result).toContain("rate-limited");
	});

	it("answer handles API connection error gracefully", async () => {
		const client = {
			messages: {
				create: vi.fn().mockRejectedValue(
					Object.assign(new Error("connection refused"), { status: 500 }),
				),
			},
		} as any;

		const brain = new TeamLeadBrain(
			{ model: "claude-sonnet-4-5-20250514", maxTokens: 1024 },
			store,
			"test-key",
			client,
		);

		const result = await brain.answer("test");
		expect(result).toContain("wrong");
	});
});
