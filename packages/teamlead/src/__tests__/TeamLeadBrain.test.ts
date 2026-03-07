import { describe, it, expect, vi, beforeEach } from "vitest";
import { TeamLeadBrain } from "../TeamLeadBrain.js";
import type { LlmCall } from "../TeamLeadBrain.js";
import { StateStore } from "../StateStore.js";

// In production: issue_id is a UUID from Linear, issue_identifier is "GEO-95"
const ISSUE_UUID = "abc12345-def6-7890-abcd-ef1234567890";

function mockLlmCall(responseText: string) {
	return vi.fn<[string, string], Promise<string | null>>(async () => responseText);
}

describe("TeamLeadBrain", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	it("answer with issue identifier loads focus session + history", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: ISSUE_UUID,
			project_name: "geoforge3d",
			status: "awaiting_review",
			issue_identifier: "GEO-95",
			issue_title: "Refactor auth",
			started_at: "2024-01-01 10:00:00",
			last_activity_at: "2024-01-01 10:30:00",
		});

		const llm = mockLlmCall("GEO-95 is awaiting review.");
		const brain = new TeamLeadBrain(store, llm);

		const result = await brain.answer("How is GEO-95?");
		expect(result).toBe("GEO-95 is awaiting review.");

		// Verify LLM was called with correct structure
		expect(llm.mock.calls[0]![0]).toContain("TeamLead");
		expect(llm.mock.calls[0]![1]).toContain("GEO-95");
		expect(llm.mock.calls[0]![1]).toContain("<issue_detail");
	});

	it("answer in known thread loads issue context from thread", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: ISSUE_UUID,
			project_name: "geoforge3d",
			status: "running",
			issue_identifier: "GEO-95",
			started_at: "2024-01-01 10:00:00",
			last_activity_at: "2024-01-01 10:30:00",
		});
		// Thread stores issue_id (UUID), not identifier
		store.upsertThread("1111.2222", "C07XXX", ISSUE_UUID);

		const llm = mockLlmCall("GEO-95 is still running.");
		const brain = new TeamLeadBrain(store, llm);

		const result = await brain.answer("tell me more", "1111.2222");
		expect(result).toBe("GEO-95 is still running.");

		expect(llm.mock.calls[0]![1]).toContain("<issue_detail");
	});

	it("answer without issue ID loads only active sessions", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: ISSUE_UUID,
			project_name: "geoforge3d",
			status: "running",
			last_activity_at: "2024-01-01 10:30:00",
		});

		const llm = mockLlmCall("One issue is running.");
		const brain = new TeamLeadBrain(store, llm);

		const result = await brain.answer("what's running?");
		expect(result).toBe("One issue is running.");

		expect(llm.mock.calls[0]![1]).toContain("<agent_status>");
		expect(llm.mock.calls[0]![1]).not.toContain("<issue_detail");
	});

	it("answer calls LLM with system prompt", async () => {
		const llm = mockLlmCall("ok");
		const brain = new TeamLeadBrain(store, llm);

		await brain.answer("hello");

		expect(llm).toHaveBeenCalledTimes(1);
		expect(llm.mock.calls[0]![0]).toBeDefined();
		expect(llm.mock.calls[0]![0]).toContain("TeamLead");
	});

	it("answer returns text from LLM response", async () => {
		const llm = mockLlmCall("Here is the answer.");
		const brain = new TeamLeadBrain(store, llm);

		const result = await brain.answer("test question");
		expect(result).toBe("Here is the answer.");
	});

	it("answer falls back to issue_id when thread session has no issue_identifier", async () => {
		// Session without issue_identifier (e.g., only session_failed received)
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: ISSUE_UUID,
			project_name: "geoforge3d",
			status: "failed",
			started_at: "2024-01-01 10:00:00",
			last_activity_at: "2024-01-01 10:30:00",
			last_error: "build failed",
		});
		store.upsertThread("1111.2222", "C07XXX", ISSUE_UUID);

		const llm = mockLlmCall("The session failed.");
		const brain = new TeamLeadBrain(store, llm);

		const result = await brain.answer("what happened?", "1111.2222");
		expect(result).toBe("The session failed.");

		// Should still get issue_detail via issue_id fallback
		expect(llm.mock.calls[0]![1]).toContain("<issue_detail");
	});

	it("answer ignores false-positive regex matches (e.g., model names) in thread context", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: ISSUE_UUID,
			project_name: "geoforge3d",
			status: "running",
			issue_identifier: "GEO-95",
			started_at: "2024-01-01 10:00:00",
			last_activity_at: "2024-01-01 10:30:00",
		});
		store.upsertThread("1111.2222", "C07XXX", ISSUE_UUID);

		const llm = mockLlmCall("GEO-95 is running.");
		const brain = new TeamLeadBrain(store, llm);

		// Question contains "sonnet-4" which matches the regex but doesn't exist in DB.
		// Thread context (GEO-95) should still be used.
		const result = await brain.answer(
			"what model is claude-sonnet-4 using?",
			"1111.2222",
		);
		expect(result).toBe("GEO-95 is running.");

		expect(llm.mock.calls[0]![1]).toContain("<issue_detail");
	});

	it("answer handles LLM error gracefully", async () => {
		const llm = vi.fn().mockRejectedValue(
			Object.assign(new Error("connection refused"), { status: 500 }),
		) as any;
		const brain = new TeamLeadBrain(store, llm);

		const result = await brain.answer("test");
		expect(result).toContain("wrong");
	});

	it("answer handles rate limit error gracefully", async () => {
		const llm = vi.fn().mockRejectedValue(
			Object.assign(new Error("rate limited"), { status: 429 }),
		) as any;
		const brain = new TeamLeadBrain(store, llm);

		const result = await brain.answer("test");
		expect(result).toContain("rate-limited");
	});
});
