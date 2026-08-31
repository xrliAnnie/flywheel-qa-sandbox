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

		it("renders a workflow claim with bounded Unicode-safe verdict context", async () => {
			await runtime.deliver(
				makeEnvelope({
					event_type: "workflow_claim_recorded",
					execution_id: "qa-exec",
					issue_id: "FLY-2152",
					project_name: "flywheel",
					workflow_run_id: "run-2152",
					workflow_node_id: "qa",
					workflow_attempt: 2,
					workflow_claim_id: 554,
					workflow_decision_kind: "qa_verdict",
					workflow_predicate: "qa_failed",
					workflow_issued_at: "2026-08-29T06:43:00.000Z",
					summary: "🧪".repeat(350),
				}),
			);

			const content = mockInsertInstruction.mock.calls[0][2] as string;
			expect(content).toContain("workflow_claim_recorded");
			expect(content).toContain("FLY-2152");
			expect(content).toContain("run-2152");
			expect(content).toContain("qa attempt 2");
			expect(content).toContain("Claim: 554 | qa_verdict → qa_failed");
			expect(content).toContain("Issued: 2026-08-29T06:43:00.000Z");
			expect(content).toContain(`Summary: ${"🧪".repeat(300)}`);
			expect(content).not.toContain("🧪".repeat(301));
			expect(content).toContain("返工、结果汇报或 ship");
		});

		it("FLY-1259: renders the locked backend for a design start", async () => {
			await runtime.deliver(
				makeEnvelope(
					{
						event_type: "session_started",
						execution_id: "exec-design",
						issue_id: "issue-1",
						issue_identifier: undefined,
						issue_title: undefined,
						session_role: "design",
						design_backend: "codex",
					},
					7,
				),
			);

			const content = mockInsertInstruction.mock.calls[0][2] as string;
			expect(content).toContain(
				"[Event #7] [DESIGN] session_started\n" +
					"ID: exec-design | Issue: issue-1\n" +
					"Design Backend: codex",
			);
		});

		it.each([
			{
				event_type: "session_started",
				session_role: "main",
				design_backend: "codex",
			},
			{
				event_type: "session_started",
				session_role: "implement",
				design_backend: "codex",
			},
			{ event_type: "session_started", session_role: "design" },
			{
				event_type: "session_completed",
				session_role: "design",
				design_backend: "codex",
			},
		])(
			"FLY-1259: omits the backend line outside design start %#",
			async (event) => {
				await runtime.deliver(makeEnvelope(event));
				const content = mockInsertInstruction.mock.calls[0][2] as string;
				expect(content).not.toContain("Design Backend:");
			},
		);

		it("dedupes crash retries by attempt id and includes ACK instructions", async () => {
			const envelope = {
				...makeEnvelope({}, 44),
				deliveryAttemptId: "attempt-44",
				ack: {
					eventSeq: 44,
					token: "receipt-token",
					policy: "explicit_receipt" as const,
				},
			};
			await runtime.deliver(envelope);

			expect(mockInsertInstruction).toHaveBeenCalledWith(
				"bridge",
				"lead-peter",
				expect.stringContaining("flywheel-comm ack-event 44"),
				{ dedupeId: "lead-event-attempt-attempt-44" },
			);
			expect(mockInsertInstruction.mock.calls[0][2]).toContain("receipt-token");
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
			// FLY-163: Forum-Thread / Forum: lines removed
			expect(content).not.toContain("Forum-Thread");
			expect(content).not.toContain("Forum:");
		});

		it("formats runner_question with [ASK] non-blocking framing (FLY-161)", async () => {
			const envelope = makeEnvelope({
				event_type: "runner_question",
				question_id: "q-r-1",
				summary: "Should I use UTC?",
				comm_db_path: "/tmp/comm.db",
			});
			await runtime.deliver(envelope);

			const content = mockInsertInstruction.mock.calls[0][2] as string;
			expect(content).toContain("[Event #1] runner_question");
			expect(content).toContain(
				"[ASK] Runner is asking (non-blocking — Runner continues working):",
			);
			expect(content).toContain("Should I use UTC?");
			expect(content).toContain("Question ID: q-r-1");
			expect(content).toContain("flywheel-comm respond");
			// runner_question must NOT carry a checkpoint tag.
			expect(content).not.toContain("[BRAINSTORM]");
			expect(content).not.toContain("[REVIEW]");
		});

		it("formats a trusted runner-stop declaration as an ACK-only report", async () => {
			const envelope = makeEnvelope({
				event_type: "runner_question",
				question_id: `rstop-${"b".repeat(32)}`,
				question_kind: "report",
				summary:
					"RUNNER-STOPPED kind=runner_stopped reason=done issue=FLY-2017 exec=exec-r route=- detail=parked",
				comm_db_path: "/tmp/comm.db",
			});
			await runtime.deliver(envelope);

			const content = mockInsertInstruction.mock.calls[0][2] as string;
			expect(content).toContain("[REPORT] Runner lifecycle declaration");
			expect(content).toContain("Do not respond");
			expect(content).toContain("ACK");
			expect(content).not.toContain("flywheel-comm respond");
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

		it("FLY-159: formats gate_timed_out with checkpoint + duration + original message", async () => {
			const envelope = makeEnvelope({
				event_type: "gate_timed_out",
				checkpoint: "brainstorm",
				waited_ms: 172_800_000,
				original_message: "my brainstorm understanding draft",
				timeout_behavior: "fail-close",
				timeout_behavior_source: "default",
				question_id: "q-uuid-1",
				chat_thread_id: "chat-thread-159",
			});
			await runtime.deliver(envelope);

			const content = mockInsertInstruction.mock.calls[0][2] as string;
			expect(content).toContain("[Event #1] gate_timed_out");
			expect(content).toContain(
				"[BRAINSTORM] Gate timed out — waited 48h (behavior: fail-close, source: default)",
			);
			expect(content).toContain("Original Runner message:");
			expect(content).toContain("my brainstorm understanding draft");
			expect(content).toContain("Question ID: q-uuid-1");
			expect(content).toContain("Notify Annie via Discord");
			expect(content).toContain("Chat-Thread: chat-thread-159");
			expect(content).not.toContain("Timestamp:");
		});

		it("FLY-159: gate_timed_out fail-open + flag source renders distinctly", async () => {
			const envelope = makeEnvelope({
				event_type: "gate_timed_out",
				checkpoint: "approve_to_ship",
				waited_ms: 10_000,
				original_message: "ready to ship",
				timeout_behavior: "fail-open",
				timeout_behavior_source: "flag",
				question_id: "q-uuid-2",
			});
			await runtime.deliver(envelope);

			const content = mockInsertInstruction.mock.calls[0][2] as string;
			expect(content).toContain(
				"[APPROVE_TO_SHIP] Gate timed out — waited 10s (behavior: fail-open, source: flag)",
			);
			expect(content).toContain("ready to ship");
		});

		it("FLY-159: gate_timed_out missing optionals → safe defaults", async () => {
			const envelope = makeEnvelope({
				event_type: "gate_timed_out",
			});
			await runtime.deliver(envelope);

			const content = mockInsertInstruction.mock.calls[0][2] as string;
			expect(content).toContain("[GATE] Gate timed out — waited —");
			expect(content).toContain("(behavior: fail-close, source: default)");
			expect(content).toContain("(no original message captured)");
			expect(content).toContain("Question ID: ---");
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

		it("includes pending runner questions in bootstrap (FLY-161)", async () => {
			const snapshot: LeadBootstrap = {
				leadId: "lead-peter",
				activeSessions: [],
				pendingDecisions: [],
				recentFailures: [],
				recentEvents: [],
				memoryRecall: null,
				pendingRunnerQuestions: [
					{
						questionId: "q-runner-1",
						executionId: "exec-runner",
						issueIdentifier: "FLY-161",
						content: "Should we use UTC?",
						commDbPath: "/tmp/comm.db",
						createdAt: "2026-05-21T00:00:00Z",
						chatThreadId: "thread-fly-161",
					},
				],
			};
			await runtime.sendBootstrap(snapshot);

			const content = mockInsertInstruction.mock.calls[0][2] as string;
			expect(content).toContain("### Pending Runner Questions");
			expect(content).toContain("[ASK] FLY-161");
			expect(content).toContain("Should we use UTC?");
			expect(content).toContain("Chat-Thread: thread-fly-161");
			expect(content).toContain("non-blocking");
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

	describe("FLY-91: Chat-Thread formatting", () => {
		it("includes Chat-Thread in generic envelope when chat_thread_id is set", async () => {
			const envelope = makeEnvelope({
				chat_thread_id: "chat-thread-789",
			});
			await runtime.deliver(envelope);

			const content = mockInsertInstruction.mock.calls[0][2] as string;
			expect(content).toContain("Chat-Thread: chat-thread-789");
			// FLY-163: Forum-Thread line removed
			expect(content).not.toContain("Forum-Thread");
		});

		it("includes Chat-Thread in gate_question special format", async () => {
			const envelope = makeEnvelope({
				event_type: "gate_question",
				checkpoint: "plan",
				question_id: "q-2",
				summary: "Should I proceed?",
				comm_db_path: "/tmp/comm.db",
				chat_thread_id: "chat-thread-gate",
			});
			await runtime.deliver(envelope);

			const content = mockInsertInstruction.mock.calls[0][2] as string;
			expect(content).toContain("Chat-Thread: chat-thread-gate");
			expect(content).toContain("[PLAN] Runner asks:");
		});

		it("omits Chat-Thread when chat_thread_id is not set", async () => {
			const envelope = makeEnvelope({});
			await runtime.deliver(envelope);

			const content = mockInsertInstruction.mock.calls[0][2] as string;
			expect(content).not.toContain("Chat-Thread:");
			// FLY-163: Forum-Thread line removed
			expect(content).not.toContain("Forum-Thread");
		});

		it("includes chatThreadId in bootstrap active sessions", async () => {
			const snapshot: LeadBootstrap = {
				leadId: "lead-peter",
				activeSessions: [
					{
						executionId: "exec-1",
						issueId: "issue-1",
						issueIdentifier: "FLY-91",
						issueTitle: "Thread reply",
						projectName: "flywheel",
						status: "running",
						chatThreadId: "chat-thread-bootstrap",
					},
				],
				pendingDecisions: [],
				recentFailures: [],
				recentEvents: [],
				memoryRecall: null,
			};
			await runtime.sendBootstrap(snapshot);

			const content = mockInsertInstruction.mock.calls[0][2] as string;
			expect(content).toContain("Chat-Thread: chat-thread-bootstrap");
		});
	});
});
