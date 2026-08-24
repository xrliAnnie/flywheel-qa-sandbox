/**
 * MailboxLeadRuntime unit tests (FLY-142 PR 1.4 cutover).
 *
 * Validates:
 * - deliver() formats envelope identical to CommDBLeadRuntime (parity)
 * - deliver() writes to mailbox via MailboxTransport.writeVerified
 * - deliver() returns DeliveryResult { delivered: true } on success
 * - deliver() returns DeliveryResult { delivered: false, error } on transport throw (no rethrow)
 * - deliver() bounds latency via writeTimeoutMs (timeout returns error, no hang)
 * - sendBootstrap() throws on transport failure (stricter than deliver)
 * - health() flips healthy after first successful deliver, stays degraded otherwise
 * - shutdown() is a no-op (no thrown errors)
 * - flywheelId is deterministic per (leadId, seq, executionId) for sidecar dedupe
 */

import type {
	IAgentTeamTransport,
	MailboxMessage,
	MailboxWriteResult,
	PreflightResult,
} from "flywheel-agent-team-transport";
import { describe, expect, it, vi } from "vitest";
import type { LeadEventEnvelope } from "../bridge/lead-runtime.js";
import { MailboxLeadRuntime } from "../bridge/mailbox-lead-runtime.js";

function makeMockTransport(
	overrides: Partial<IAgentTeamTransport> = {},
): IAgentTeamTransport {
	return {
		vendorId: () => "claude-code",
		capabilities: () => ({
			wakeMode: "builtin-receiver",
			preflightIsHardGate: true,
			preservesMetadata: true,
			maxPayloadBytes: 1_000_000,
			requiresStableAgentIdentity: true,
		}),
		getInboxPath: () => "/dummy/inbox.json",
		getStateDir: () => "/dummy/state",
		write: vi.fn(
			async (): Promise<MailboxWriteResult> => ({
				flywheelId: "test-id",
				idempotent: false,
				wroteAt: 1_700_000_000_000,
				finalized: true,
			}),
		),
		verifyLastWrite: vi.fn(async () => {}),
		readUnread: vi.fn(async (): Promise<MailboxMessage[]> => []),
		ack: vi.fn(async () => {}),
		dedupeKey: (msg: MailboxMessage) => msg.id,
		createReceiver: () => null,
		buildRunnerSpawnConfig: () => ({ args: [], env: {} }),
		buildLeadSpawnConfig: () => ({ args: [], env: {} }),
		preflight: vi.fn(
			async (): Promise<PreflightResult> => ({
				ok: true,
				availabilitySignals: [],
			}),
		),
		...overrides,
	};
}

function makeEnvelope(
	overrides: Partial<LeadEventEnvelope> = {},
): LeadEventEnvelope {
	return {
		seq: 42,
		event: {
			event_type: "stage_changed",
			execution_id: "exec-abc",
			issue_id: "issue-xyz",
			issue_identifier: "FLY-100",
			issue_title: "Test issue",
			project_name: "test-project",
			status: "in_progress",
			session_role: "main",
		},
		sessionKey: "session-key-1",
		leadId: "cos-lead",
		timestamp: "2026-05-11T00:00:00.000Z",
		...overrides,
	};
}

describe("MailboxLeadRuntime", () => {
	describe("deliver", () => {
		it("happy path: writes to mailbox + returns delivered=true", async () => {
			const transport = makeMockTransport();
			const runtime = new MailboxLeadRuntime({
				leadId: "cos-lead",
				transport,
			});

			const result = await runtime.deliver(makeEnvelope());

			expect(result.delivered).toBe(true);
			expect(result.error).toBeUndefined();
			expect(transport.write).toHaveBeenCalledTimes(1);
			const writeCall = (transport.write as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			expect(writeCall.leadName).toBe("cos-lead");
			expect(writeCall.recipient).toBe("cos-lead"); // Bridge writes to Lead's own inbox
			expect(writeCall.payload.from).toBe("bridge");
			expect(writeCall.payload.to).toBe("cos-lead");
			expect(writeCall.payload.metadata?.flywheelId).toBe(
				"cos-lead-42-exec-abc",
			);
			expect(writeCall.payload.metadata?.eventType).toBe("stage_changed");
			expect(writeCall.payload.metadata?.seq).toBe("42");
		});

		it("FLY-1259: renders the locked backend for a design start", async () => {
			const transport = makeMockTransport();
			const runtime = new MailboxLeadRuntime({
				leadId: "cos-lead",
				transport,
			});

			await runtime.deliver(
				makeEnvelope({
					seq: 7,
					event: {
						event_type: "session_started",
						execution_id: "exec-design",
						issue_id: "issue-1",
						session_role: "design",
						design_backend: "codex",
					},
				}),
			);

			const content = (transport.write as ReturnType<typeof vi.fn>).mock
				.calls[0][0].payload.content as string;
			expect(content).toContain(
				"[Event #7] [DESIGN] session_started\n" +
					"ID: exec-design | Issue: issue-1\n" +
					"Design Backend: codex",
			);
		});

		it.each([
			["replacement_candidate", "铸替换体"],
			["environment_hold_candidate", "环境类收口"],
			["retry_limit_hold_candidate", "配额收口"],
		] as const)(
			"FLY-2018: renders stable replacement eligibility for %s",
			async (nextCheckDisposition, expectedAction) => {
				const transport = makeMockTransport();
				const runtime = new MailboxLeadRuntime({
					leadId: "cos-lead",
					transport,
				});
				const stableId =
					"workflow-replacement-eligibility:run-1:implement:1:exec-1:2";
				await runtime.deliver(
					makeEnvelope({
						eventId: stableId,
						event: {
							event_type: "workflow_replacement_eligibility",
							execution_id: "exec-1",
							issue_id: "FLY-2018",
							workflow_event_id: stableId,
							next_check_at: "2026-08-24T00:14:00.000Z",
							next_check_disposition: nextCheckDisposition,
							blind_replacements: 1,
							max_blind_replacements: 3,
						},
					}),
				);

				const content = (transport.write as ReturnType<typeof vi.fn>).mock
					.calls[0][0].payload.content as string;
				expect(content).toContain(`Stable Event: ${stableId}`);
				expect(content).toContain("盲换 1/3");
				expect(content).toContain(expectedAction);
				expect(content).not.toContain("已断路");
			},
		);

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
				const transport = makeMockTransport();
				const runtime = new MailboxLeadRuntime({
					leadId: "cos-lead",
					transport,
				});
				await runtime.deliver(makeEnvelope({ event }));
				const content = (transport.write as ReturnType<typeof vi.fn>).mock
					.calls[0][0].payload.content as string;
				expect(content).not.toContain("Design Backend:");
			},
		);

		it("uses attempt identity for dedupe and renders the backend-neutral ACK handle", async () => {
			const transport = makeMockTransport();
			const runtime = new MailboxLeadRuntime({ leadId: "cos-lead", transport });
			await runtime.deliver(
				makeEnvelope({
					deliveryAttemptId: "attempt-2",
					ack: {
						eventSeq: 42,
						token: "bearer-token",
						policy: "explicit_receipt",
					},
				}),
			);

			const writeCall = (transport.write as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			expect(writeCall.payload.metadata?.flywheelId).toBe("cos-lead-attempt-2");
			expect(writeCall.payload.content).toContain(
				"flywheel-comm ack-event 42 --project test-project --token-stdin",
			);
			expect(writeCall.payload.content).toContain("bearer-token");
			expect(writeCall.payload.content).toContain("flywheel_inbox_ack_event");
		});

		it("formats event content identical to CommDBLeadRuntime parity", async () => {
			const transport = makeMockTransport();
			const runtime = new MailboxLeadRuntime({
				leadId: "cos-lead",
				transport,
			});

			await runtime.deliver(
				makeEnvelope({
					event: {
						event_type: "action_executed",
						execution_id: "exec-123",
						issue_id: "issue-456",
						issue_identifier: "FLY-200",
						issue_title: "My title",
						status: "completed",
						action: "approve",
						action_source_status: "awaiting_review",
						action_target_status: "approved_to_ship",
						commit_count: 3,
						lines_added: 100,
						lines_removed: 20,
						pr_number: 99,
						session_role: "main",
					},
				}),
			);

			const writeCall = (transport.write as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			const content = writeCall.payload.content as string;
			expect(content).toContain("[Event #42] action_executed");
			expect(content).toContain("ID: exec-123 | Issue: FLY-200");
			expect(content).toContain("Title: My title");
			expect(content).toContain("Status: completed");
			expect(content).toContain(
				"Action: approve (awaiting_review → approved_to_ship)",
			);
			expect(content).toContain("Commits: 3 | +100/-20");
			expect(content).toContain("PR: #99");
			// FLY-163: Forum-Thread line removed
			expect(content).not.toContain("Forum-Thread");
		});

		it("formats runner_question with [ASK] non-blocking framing (FLY-161)", async () => {
			const transport = makeMockTransport();
			const runtime = new MailboxLeadRuntime({
				leadId: "product-lead",
				transport,
			});

			await runtime.deliver(
				makeEnvelope({
					event: {
						event_type: "runner_question",
						execution_id: "exec-r",
						issue_id: "issue-r",
						issue_identifier: "FLY-161",
						summary: "Use UTC?",
						question_id: "q-r-1",
						comm_db_path: "/tmp/comm.db",
					},
				}),
			);

			const content = (transport.write as ReturnType<typeof vi.fn>).mock
				.calls[0][0].payload.content as string;
			expect(content).toContain("[Event #42] runner_question");
			expect(content).toContain(
				"[ASK] Runner is asking (non-blocking — Runner continues working):",
			);
			expect(content).toContain("Use UTC?");
			expect(content).toContain("Question ID: q-r-1");
			expect(content).toContain("flywheel-comm respond");
			expect(content).not.toContain("[BRAINSTORM]");
		});

		it("formats gate_question event with special structure", async () => {
			const transport = makeMockTransport();
			const runtime = new MailboxLeadRuntime({
				leadId: "cos-lead",
				transport,
			});

			await runtime.deliver(
				makeEnvelope({
					event: {
						event_type: "gate_question",
						execution_id: "exec-g",
						issue_id: "issue-g",
						issue_identifier: "FLY-300",
						checkpoint: "approve_to_ship",
						summary: "Ready to ship?",
						question_id: "q-789",
						comm_db_path: "/tmp/comm.db",
					},
				}),
			);

			const content = (transport.write as ReturnType<typeof vi.fn>).mock
				.calls[0][0].payload.content as string;
			expect(content).toContain("[Event #42] gate_question");
			expect(content).toContain("[APPROVE_TO_SHIP] Runner asks:");
			expect(content).toContain("Ready to ship?");
			expect(content).toContain("Question ID: q-789");
			expect(content).toContain("CommDB: /tmp/comm.db");
		});

		it("FLY-159: formats gate_timed_out with checkpoint + duration + original message", async () => {
			const transport = makeMockTransport();
			const runtime = new MailboxLeadRuntime({
				leadId: "cos-lead",
				transport,
			});

			await runtime.deliver(
				makeEnvelope({
					event: {
						event_type: "gate_timed_out",
						execution_id: "exec-t",
						issue_id: "issue-t",
						issue_identifier: "FLY-159",
						checkpoint: "brainstorm",
						waited_ms: 172_800_000,
						original_message: "my brainstorm understanding draft",
						timeout_behavior: "fail-close",
						timeout_behavior_source: "default",
						question_id: "q-uuid-1",
						chat_thread_id: "chat-thread-159",
					},
				}),
			);

			const content = (transport.write as ReturnType<typeof vi.fn>).mock
				.calls[0][0].payload.content as string;
			expect(content).toContain("[Event #42] gate_timed_out");
			expect(content).toContain("Issue: FLY-159");
			expect(content).toContain(
				"[BRAINSTORM] Gate timed out — waited 48h (behavior: fail-close, source: default)",
			);
			expect(content).toContain("Original Runner message:");
			expect(content).toContain("my brainstorm understanding draft");
			expect(content).toContain("Question ID: q-uuid-1");
			expect(content).toContain("Notify Annie via Discord");
			expect(content).toContain("Chat-Thread: chat-thread-159");
			// generic formatter fields should NOT appear (no double-formatting)
			expect(content).not.toContain("Timestamp:");
		});

		it("FLY-159: gate_timed_out fail-open path renders behavior=fail-open + source=flag", async () => {
			const transport = makeMockTransport();
			const runtime = new MailboxLeadRuntime({
				leadId: "cos-lead",
				transport,
			});

			await runtime.deliver(
				makeEnvelope({
					event: {
						event_type: "gate_timed_out",
						execution_id: "exec-t2",
						issue_id: "issue-t2",
						checkpoint: "approve_to_ship",
						waited_ms: 10_000,
						original_message: "ready to ship",
						timeout_behavior: "fail-open",
						timeout_behavior_source: "flag",
						question_id: "q-uuid-2",
					},
				}),
			);

			const content = (transport.write as ReturnType<typeof vi.fn>).mock
				.calls[0][0].payload.content as string;
			expect(content).toContain(
				"[APPROVE_TO_SHIP] Gate timed out — waited 10s (behavior: fail-open, source: flag)",
			);
			expect(content).toContain("ready to ship");
		});

		it("FLY-159: gate_timed_out with missing optional fields uses sensible defaults", async () => {
			const transport = makeMockTransport();
			const runtime = new MailboxLeadRuntime({
				leadId: "cos-lead",
				transport,
			});

			await runtime.deliver(
				makeEnvelope({
					event: {
						event_type: "gate_timed_out",
						execution_id: "exec-t3",
						issue_id: "issue-t3",
						// no checkpoint, no waited_ms, no original_message,
						// no timeout_behavior, no source, no question_id
					},
				}),
			);

			const content = (transport.write as ReturnType<typeof vi.fn>).mock
				.calls[0][0].payload.content as string;
			expect(content).toContain("[GATE] Gate timed out — waited —");
			expect(content).toContain("(behavior: fail-close, source: default)");
			expect(content).toContain("(no original message captured)");
			expect(content).toContain("Question ID: ---");
		});

		it("session_role label appears for non-main sessions", async () => {
			const transport = makeMockTransport();
			const runtime = new MailboxLeadRuntime({
				leadId: "cos-lead",
				transport,
			});

			await runtime.deliver(
				makeEnvelope({
					event: {
						event_type: "stage_changed",
						execution_id: "exec-r",
						issue_id: "issue-r",
						session_role: "qa",
					},
				}),
			);

			const content = (transport.write as ReturnType<typeof vi.fn>).mock
				.calls[0][0].payload.content as string;
			expect(content).toContain("[QA] stage_changed");
		});

		it("transport throw → returns delivered=false + error string (no rethrow)", async () => {
			const transport = makeMockTransport({
				write: vi.fn(async () => {
					throw new Error("simulated mailbox lock contention");
				}),
			});
			const runtime = new MailboxLeadRuntime({
				leadId: "cos-lead",
				transport,
				logger: vi.fn(), // suppress log spam
			});

			// Must NOT throw — LeadRuntime contract says deliver() never throws.
			const result = await runtime.deliver(makeEnvelope());
			expect(result.delivered).toBe(false);
			expect(result.error).toMatch(/simulated mailbox lock contention/);
		});

		it("write times out → returns delivered=false, no hang", async () => {
			const transport = makeMockTransport({
				write: vi.fn(
					() =>
						new Promise(() => {
							/* never resolves */
						}),
				),
			});
			const runtime = new MailboxLeadRuntime({
				leadId: "cos-lead",
				transport,
				writeTimeoutMs: 50,
				logger: vi.fn(),
			});

			const t0 = Date.now();
			const result = await runtime.deliver(makeEnvelope());
			const elapsed = Date.now() - t0;

			expect(result.delivered).toBe(false);
			expect(result.error).toMatch(/timed out after 50ms/);
			expect(elapsed).toBeLessThan(500); // bounded
		});

		it("flywheelId is deterministic for same (leadId, seq, executionId) — sidecar dedupe contract", async () => {
			const transport = makeMockTransport();
			const runtime = new MailboxLeadRuntime({
				leadId: "cos-lead",
				transport,
			});

			await runtime.deliver(makeEnvelope({ seq: 7 }));
			await runtime.deliver(makeEnvelope({ seq: 7 })); // identical envelope → identical id

			const calls = (transport.write as ReturnType<typeof vi.fn>).mock.calls;
			expect(calls[0][0].payload.metadata?.flywheelId).toBe(
				calls[1][0].payload.metadata?.flywheelId,
			);
		});

		it("flywheelId differs for different seqs", async () => {
			const transport = makeMockTransport();
			const runtime = new MailboxLeadRuntime({
				leadId: "cos-lead",
				transport,
			});

			await runtime.deliver(makeEnvelope({ seq: 1 }));
			await runtime.deliver(makeEnvelope({ seq: 2 }));

			const calls = (transport.write as ReturnType<typeof vi.fn>).mock.calls;
			expect(calls[0][0].payload.metadata?.flywheelId).not.toBe(
				calls[1][0].payload.metadata?.flywheelId,
			);
		});

		it("uses 'no-exec' placeholder when execution_id is missing", async () => {
			const transport = makeMockTransport();
			const runtime = new MailboxLeadRuntime({
				leadId: "cos-lead",
				transport,
			});

			const env = makeEnvelope({
				seq: 99,
				event: {
					event_type: "system_status",
					issue_id: "n/a",
				},
			});
			delete (env.event as { execution_id?: string }).execution_id;
			await runtime.deliver(env);

			const writeCall = (transport.write as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			expect(writeCall.payload.metadata?.flywheelId).toBe(
				"cos-lead-99-no-exec",
			);
		});
	});

	describe("sendBootstrap", () => {
		it("writes bootstrap snapshot to mailbox", async () => {
			const transport = makeMockTransport();
			const runtime = new MailboxLeadRuntime({
				leadId: "cos-lead",
				transport,
			});

			await runtime.sendBootstrap({
				leadId: "cos-lead",
				activeSessions: [
					{
						executionId: "e1",
						issueId: "i1",
						issueIdentifier: "FLY-1",
						issueTitle: "Title 1",
						projectName: "p",
						status: "running",
					},
				],
				pendingDecisions: [],
				recentFailures: [],
				recentEvents: [],
				memoryRecall: null,
			});

			expect(transport.write).toHaveBeenCalledTimes(1);
			const content = (transport.write as ReturnType<typeof vi.fn>).mock
				.calls[0][0].payload.content as string;
			expect(content).toContain("## Bootstrap — Lead: cos-lead");
			expect(content).toContain("### Active Sessions");
			expect(content).toContain("FLY-1: Title 1 [running]");
		});

		it("THROWS on transport failure (stricter than deliver) — daemon decides whether to abort", async () => {
			const transport = makeMockTransport({
				write: vi.fn(async () => {
					throw new Error("bootstrap write failed");
				}),
			});
			const runtime = new MailboxLeadRuntime({
				leadId: "cos-lead",
				transport,
				logger: vi.fn(),
			});

			await expect(
				runtime.sendBootstrap({
					leadId: "cos-lead",
					activeSessions: [],
					pendingDecisions: [],
					recentFailures: [],
					recentEvents: [],
					memoryRecall: null,
				}),
			).rejects.toThrow(/bootstrap write failed/);
		});

		it("renders Pending Runner Questions section with Chat-Thread row (FLY-161)", async () => {
			const transport = makeMockTransport();
			const runtime = new MailboxLeadRuntime({
				leadId: "product-lead",
				transport,
			});

			await runtime.sendBootstrap({
				leadId: "product-lead",
				activeSessions: [],
				pendingDecisions: [],
				recentFailures: [],
				recentEvents: [],
				memoryRecall: null,
				pendingRunnerQuestions: [
					{
						questionId: "q-r-2",
						executionId: "exec-r-2",
						issueIdentifier: "FLY-161",
						content: "Default timezone?",
						commDbPath: "/tmp/comm.db",
						createdAt: "2026-05-21T00:00:00Z",
						chatThreadId: "thread-product-fly161",
					},
				],
			});

			const content = (transport.write as ReturnType<typeof vi.fn>).mock
				.calls[0][0].payload.content as string;
			expect(content).toContain("### Pending Runner Questions");
			expect(content).toContain("[ASK] FLY-161");
			expect(content).toContain("Default timezone?");
			expect(content).toContain("Chat-Thread: thread-product-fly161");
			expect(content).toContain("non-blocking");
		});

		it("bootstrap flywheelId is timestamp-based (non-idempotent across restarts)", async () => {
			const transport = makeMockTransport();
			const runtime = new MailboxLeadRuntime({
				leadId: "cos-lead",
				transport,
			});

			await runtime.sendBootstrap({
				leadId: "cos-lead",
				activeSessions: [],
				pendingDecisions: [],
				recentFailures: [],
				recentEvents: [],
				memoryRecall: null,
			});

			const writeCall = (transport.write as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			expect(writeCall.payload.metadata?.flywheelId).toMatch(
				/^bootstrap-cos-lead-\d+$/,
			);
		});
	});

	describe("health", () => {
		it("starts degraded (no deliveries yet)", async () => {
			const transport = makeMockTransport();
			const runtime = new MailboxLeadRuntime({
				leadId: "cos-lead",
				transport,
			});
			const h = await runtime.health();
			expect(h.status).toBe("degraded");
			expect(h.lastDeliveryAt).toBeNull();
			expect(h.lastDeliveredSeq).toBe(0);
		});

		it("flips to healthy after first successful deliver", async () => {
			const transport = makeMockTransport();
			const runtime = new MailboxLeadRuntime({
				leadId: "cos-lead",
				transport,
			});
			await runtime.deliver(makeEnvelope({ seq: 5 }));
			const h = await runtime.health();
			expect(h.status).toBe("healthy");
			expect(h.lastDeliveryAt).not.toBeNull();
			expect(h.lastDeliveredSeq).toBe(5);
		});

		it("stays degraded after failed deliver only (no successful)", async () => {
			const transport = makeMockTransport({
				write: vi.fn(async () => {
					throw new Error("fail");
				}),
			});
			const runtime = new MailboxLeadRuntime({
				leadId: "cos-lead",
				transport,
				logger: vi.fn(),
			});
			await runtime.deliver(makeEnvelope());
			const h = await runtime.health();
			expect(h.status).toBe("degraded");
		});
	});

	describe("shutdown", () => {
		it("no-op (does not throw)", async () => {
			const transport = makeMockTransport();
			const runtime = new MailboxLeadRuntime({
				leadId: "cos-lead",
				transport,
			});
			await expect(runtime.shutdown()).resolves.toBeUndefined();
		});
	});

	describe("type tag", () => {
		it("type === 'mailbox' for runtime-registry filtering", () => {
			const transport = makeMockTransport();
			const runtime = new MailboxLeadRuntime({
				leadId: "cos-lead",
				transport,
			});
			expect(runtime.type).toBe("mailbox");
		});
	});

	describe("lastDeliveredSeq monotonicity (Codex r1 PR 1.4 non-blocking)", () => {
		it("does NOT regress when concurrent deliveries complete out of order", async () => {
			// Health field should monotonically reflect "highest-seq delivered",
			// not "most recent caller's seq". Without Math.max, seq=2 completing
			// before seq=1 would correctly leave 2, but seq=1 finishing later
			// would clobber it back to 1.
			const transport = makeMockTransport();
			const runtime = new MailboxLeadRuntime({
				leadId: "cos-lead",
				transport,
			});

			await runtime.deliver(makeEnvelope({ seq: 5 }));
			expect((await runtime.health()).lastDeliveredSeq).toBe(5);

			// Out-of-order arrival: a stale seq=3 finishes after seq=5 already landed.
			await runtime.deliver(makeEnvelope({ seq: 3 }));
			expect((await runtime.health()).lastDeliveredSeq).toBe(5);

			// Higher seq still advances normally.
			await runtime.deliver(makeEnvelope({ seq: 9 }));
			expect((await runtime.health()).lastDeliveredSeq).toBe(9);
		});
	});
});
