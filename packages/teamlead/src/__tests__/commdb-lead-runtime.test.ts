import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock flywheel-comm/db before any imports
const mockInsertInstruction = vi.fn();
const mockClose = vi.fn();
vi.mock("flywheel-comm/db", () => ({
	CommDB: vi.fn().mockImplementation(() => ({
		insertInstruction: mockInsertInstruction,
		close: mockClose,
	})),
}));

import { CommDBLeadRuntime } from "../bridge/commdb-lead-runtime.js";
import type { HookPayload } from "../bridge/hook-payload.js";
import type {
	LeadBootstrap,
	LeadEventEnvelope,
} from "../bridge/lead-runtime.js";

function makeEnvelope(
	overrides: Partial<HookPayload> = {},
	seq = 1,
): LeadEventEnvelope {
	return {
		seq,
		event: {
			event_type: "session_started",
			execution_id: "exec-1",
			issue_id: "issue-1",
			issue_identifier: "FLY-99",
			issue_title: "Test issue",
			status: "running",
			...overrides,
		} as HookPayload,
		sessionKey: "proj:FLY-99",
		leadId: "lead-peter",
		timestamp: "2026-04-05T12:00:00Z",
	};
}

describe("CommDBLeadRuntime", () => {
	let runtime: CommDBLeadRuntime;

	beforeEach(() => {
		vi.clearAllMocks();
		runtime = new CommDBLeadRuntime("/tmp/test-comm.db", "lead-peter");
	});

	describe("deliver()", () => {
		it("inserts instruction via CommDB and returns success", async () => {
			const envelope = makeEnvelope();
			const result = await runtime.deliver(envelope);

			expect(result.delivered).toBe(true);
			expect(mockInsertInstruction).toHaveBeenCalledWith(
				"bridge",
				"lead-peter",
				expect.stringContaining("[Event #1] session_started"),
			);
		});

		it("formats envelope with all available fields", async () => {
			const envelope = makeEnvelope({
				event_type: "session_completed",
				status: "awaiting_review",
				decision_route: "needs_review",
				summary: "Implemented feature X",
				commit_count: 3,
				lines_added: 100,
				lines_removed: 20,
				filter_priority: "high",
				notification_context: "PR ready for review",
				thread_id: "thread-123",
				forum_channel: "forum-456",
			});
			await runtime.deliver(envelope);

			const content = mockInsertInstruction.mock.calls[0][2] as string;
			expect(content).toContain("[Event #1] session_completed");
			expect(content).toContain("Status: awaiting_review");
			expect(content).toContain("Route: needs_review");
			expect(content).toContain("Summary: Implemented feature X");
			expect(content).toContain("Commits: 3 | +100/-20");
			expect(content).toContain("Priority: high");
			expect(content).toContain("Context: PR ready for review");
			expect(content).toContain("Thread: thread-123");
			expect(content).toContain("Forum: forum-456");
		});

		it("formats gate_question with special format", async () => {
			const envelope = makeEnvelope({
				event_type: "gate_question",
				checkpoint: "review",
				question_id: "q-1",
				summary: "Should I proceed?",
				comm_db_path: "/tmp/comm.db",
			});
			await runtime.deliver(envelope);

			const content = mockInsertInstruction.mock.calls[0][2] as string;
			expect(content).toContain("[Event #1] gate_question");
			expect(content).toContain("[REVIEW] Runner asks:");
			expect(content).toContain("Should I proceed?");
			expect(content).toContain("Question ID: q-1");
			expect(content).toContain("CommDB: /tmp/comm.db");
		});

		it("returns failure when CommDB throws", async () => {
			mockInsertInstruction.mockImplementationOnce(() => {
				throw new Error("disk full");
			});
			const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await runtime.deliver(makeEnvelope());

			expect(result.delivered).toBe(false);
			expect(result.error).toBe("disk full");
			consoleSpy.mockRestore();
		});

		it("tracks lastDeliveredSeq after successful delivery", async () => {
			await runtime.deliver(makeEnvelope({}, 5));
			await runtime.deliver(makeEnvelope({}, 10));

			const h = await runtime.health();
			expect(h.lastDeliveredSeq).toBe(10);
		});
	});

	describe("sendBootstrap()", () => {
		it("inserts bootstrap snapshot as instruction", async () => {
			const snapshot: LeadBootstrap = {
				leadId: "lead-peter",
				activeSessions: [
					{
						executionId: "exec-1",
						issueId: "issue-1",
						issueIdentifier: "FLY-99",
						issueTitle: "Test",
						projectName: "flywheel",
						status: "running",
					},
				],
				pendingDecisions: [],
				recentFailures: [],
				recentEvents: [],
				memoryRecall: null,
			};
			await runtime.sendBootstrap(snapshot);

			expect(mockInsertInstruction).toHaveBeenCalledWith(
				"bridge",
				"lead-peter",
				expect.stringContaining("## Bootstrap — Lead: lead-peter"),
			);
			const content = mockInsertInstruction.mock.calls[0][2] as string;
			expect(content).toContain("FLY-99: Test [running]");
		});

		it("includes pending gate questions in bootstrap", async () => {
			const snapshot: LeadBootstrap = {
				leadId: "lead-peter",
				activeSessions: [],
				pendingDecisions: [],
				recentFailures: [],
				recentEvents: [],
				memoryRecall: null,
				pendingGateQuestions: [
					{
						questionId: "q-1",
						checkpoint: "review",
						executionId: "exec-1",
						issueIdentifier: "FLY-99",
						content: "Should I merge?",
						commDbPath: "/tmp/comm.db",
						createdAt: "2026-04-05T12:00:00Z",
					},
				],
			};
			await runtime.sendBootstrap(snapshot);

			const content = mockInsertInstruction.mock.calls[0][2] as string;
			expect(content).toContain("### Pending Gate Questions");
			expect(content).toContain("[REVIEW] FLY-99");
			expect(content).toContain("Should I merge?");
		});
	});

	describe("health()", () => {
		it("returns degraded when no deliveries yet", async () => {
			const h = await runtime.health();
			expect(h.status).toBe("degraded");
			expect(h.lastDeliveryAt).toBeNull();
			expect(h.lastDeliveredSeq).toBe(0);
		});

		it("returns healthy after a delivery", async () => {
			await runtime.deliver(makeEnvelope({}, 3));
			const h = await runtime.health();
			expect(h.status).toBe("healthy");
			expect(h.lastDeliveryAt).toBeTruthy();
			expect(h.lastDeliveredSeq).toBe(3);
		});
	});

	describe("shutdown()", () => {
		it("closes the CommDB connection", async () => {
			await runtime.shutdown();
			expect(mockClose).toHaveBeenCalled();
		});
	});

	describe("type", () => {
		it("is commdb", () => {
			expect(runtime.type).toBe("commdb");
		});
	});
});
