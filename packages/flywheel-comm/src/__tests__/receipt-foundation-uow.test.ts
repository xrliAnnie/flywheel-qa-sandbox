import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB, type RunnerPhaseWake } from "../db.js";
import { LeadInboxQueue } from "../lead-inbox-queue.js";

interface InstructionIntentResult {
	instructionId: string;
	wake: RunnerPhaseWake;
}

interface InstructionIntentInput {
	instructionId: string;
	fromAgent: string;
	executionId: string;
	content: string;
	intentKey: string;
	envelope: {
		id: string;
		to: string;
		content: string;
		metadata: Record<string, unknown>;
	};
	queuedAtMs: number;
}

function markDelivered(
	queue: LeadInboxQueue,
	id: string,
	toLead: string,
): void {
	const ownerEpoch = `owner-${id}`;
	expect(
		queue.acquireOrRenewOwner({
			ownerEpoch,
			now: "2026-07-21T11:58:00.000Z",
			leaseTtlMs: 60 * 60_000,
		}),
	).toBe(true);
	expect(
		queue.claimModelBatch({
			toLead,
			ownerEpoch,
			batchId: `batch-${id}`,
			now: "2026-07-21T11:58:00.000Z",
			claimTtlMs: 60_000,
		}),
	).toHaveLength(1);
	expect(
		queue.markConsumed([id], {
			ownerEpoch,
			disposition: "delivered",
			now: "2026-07-21T11:59:00.000Z",
		}),
	).toBe(1);
}

describe("FLY-1392 CommDB receipt UOWs", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1392-uow-"));
		dbPath = join(dir, "comm.db");
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("atomically persists an instruction and its durable wake intent", () => {
		const db = new CommDB(dbPath);
		try {
			const instructionAndIntent = (
				db as unknown as {
					instructionAndIntent?: (
						input: InstructionIntentInput,
					) => InstructionIntentResult;
				}
			).instructionAndIntent;
			expect(instructionAndIntent).toBeTypeOf("function");
			const result = instructionAndIntent?.call(db, {
				instructionId: "instruction-1",
				fromAgent: "lead-a",
				executionId: "exec-a",
				content: "do the next thing",
				intentKey: "instruction:instruction-1",
				envelope: {
					id: "wake-1",
					to: "exec-a",
					content: "pending instruction",
					metadata: {
						execId: "exec-a",
						flywheelId: "instruction-1",
					},
				},
				queuedAtMs: 1_721_390_000_000,
			});

			expect(result?.instructionId).toBe("instruction-1");
			expect(db.getMessageById("instruction-1")).toMatchObject({
				type: "instruction",
				from_agent: "lead-a",
				to_agent: "exec-a",
				content: "do the next thing",
			});
			expect(result?.wake).toMatchObject({
				execution_id: "exec-a",
				message_id: "instruction:instruction-1",
				state: "pending",
				admission_state: "queued",
				push_attempts: 0,
				source_instruction_id: "instruction-1",
			});
			expect(JSON.parse(result?.wake.envelope_json ?? "null")).toMatchObject({
				id: "wake-1",
				to: "exec-a",
			});
		} finally {
			db.close();
		}
	});

	it("rolls the instruction back when wake-intent admission fails", () => {
		const db = new CommDB(dbPath);
		const raw = new Database(dbPath);
		try {
			raw.exec(`
				CREATE TRIGGER reject_receipt_wake
				BEFORE INSERT ON runner_phase_wakes
				BEGIN SELECT RAISE(ABORT, 'injected wake admission failure'); END;
			`);
		} finally {
			raw.close();
		}

		try {
			expect(() =>
				db.instructionAndIntent({
					instructionId: "instruction-rollback",
					fromAgent: "lead-a",
					executionId: "exec-a",
					content: "must be atomic",
					intentKey: "instruction:instruction-rollback",
					envelope: {
						id: "wake-rollback",
						to: "exec-a",
						content: "pending instruction",
						metadata: {
							execId: "exec-a",
							flywheelId: "instruction-rollback",
						},
					},
					queuedAtMs: 1_721_390_000_001,
				}),
			).toThrow(/injected wake admission failure/);
			expect(db.getMessageById("instruction-rollback")).toBeUndefined();
			expect(db.listRunnerPhaseWakes("exec-a")).toEqual([]);
		} finally {
			db.close();
		}
	});

	it("supports a non-owning LeadInboxQueue facade on an existing connection", () => {
		new CommDB(dbPath).close();
		const raw = new Database(dbPath);
		try {
			const SharedQueue = LeadInboxQueue as unknown as new (
				connection: Database.Database,
			) => LeadInboxQueue;
			let queue: LeadInboxQueue | undefined;
			expect(() => {
				queue = new SharedQueue(raw);
			}).not.toThrow();
			queue?.enqueue({
				id: "shared-connection-row",
				toLead: "lead-a",
				source: "test",
				type: "runner_question",
				msgClass: "protocol",
				priority: 1,
				content: "same transaction handle",
			});
			queue?.close();
			expect(
				raw.prepare("SELECT COUNT(*) AS count FROM lead_inbox").get(),
			).toEqual({ count: 1 });
		} finally {
			raw.close();
		}
	});

	it("writes processed only with typed actor-and-fence evidence", () => {
		const queue = new LeadInboxQueue(dbPath);
		try {
			queue.enqueue({
				id: "receipt-row",
				toLead: "lead-a",
				source: "founder_reply",
				type: "founder_reply",
				msgClass: "protocol",
				priority: 0,
				content: "please do this",
			});
			const markProcessed = (
				queue as unknown as {
					markProcessed?: (
						id: string,
						input: {
							now: string;
							evidence: Record<string, unknown>;
						},
					) => boolean;
				}
			).markProcessed;
			expect(markProcessed).toBeTypeOf("function");
			expect(
				markProcessed?.call(queue, "receipt-row", {
					now: "2026-07-20T12:00:00.000Z",
					evidence: {
						v: 1,
						kind: "question_bound",
						ref: "response-1",
						actor: "bridge-protocol",
						actor_kind: "bridge-protocol",
						fence: { owner_epoch: "epoch-a" },
					},
				}),
			).toBe(true);
			expect(queue.getById("receipt-row")).toMatchObject({
				processed_at: "2026-07-20T12:00:00.000Z",
			});
			const evidence = JSON.parse(
				queue.getById("receipt-row")?.processed_evidence ?? "null",
			);
			expect(evidence).toMatchObject({
				kind: "question_bound",
				actor: "bridge-protocol",
				fence: { owner_epoch: "epoch-a" },
			});
		} finally {
			queue.close();
		}
	});

	it("rejects processed evidence without actor fence and leaves the row open", () => {
		const queue = new LeadInboxQueue(dbPath);
		try {
			queue.enqueue({
				id: "invalid-evidence-row",
				toLead: "lead-a",
				source: "founder_reply",
				type: "founder_reply",
				msgClass: "protocol",
				priority: 0,
				content: "please do this",
			});
			const markProcessed = (
				queue as unknown as {
					markProcessed: (
						id: string,
						input: {
							now: string;
							evidence: Record<string, unknown>;
						},
					) => boolean;
				}
			).markProcessed;
			expect(() =>
				markProcessed.call(queue, "invalid-evidence-row", {
					now: "2026-07-20T12:00:00.000Z",
					evidence: {
						v: 1,
						kind: "question_bound",
						ref: "response-1",
						actor: "bridge-protocol",
						actor_kind: "bridge-protocol",
						fence: {},
					},
				}),
			).toThrow(/fence/i);
			expect(queue.getById("invalid-evidence-row")).toMatchObject({
				processed_at: null,
				processed_evidence: null,
			});
		} finally {
			queue.close();
		}
	});

	it("stores disposed as a distinct terminal state and rejects cross-terminal races", () => {
		const queue = new LeadInboxQueue(dbPath);
		try {
			queue.enqueue({
				id: "disposed-row",
				toLead: "lead-a",
				source: "question:q1",
				type: "future_category",
				msgClass: "model",
				priority: 2,
				content: "already answered elsewhere",
			});
			expect(
				queue.markDisposed("disposed-row", {
					now: "2026-07-21T12:00:00.000Z",
					evidence: {
						v: 1,
						kind: "business_object_terminal",
						ref: "response-by-founder",
						actor: "founder",
						actor_kind: "founder-writer",
						fence: { authority: "discord:1" },
					},
				}),
			).toBe(true);
			expect(queue.getById("disposed-row")).toMatchObject({
				processed_at: null,
				processed_evidence: null,
				disposed_at: "2026-07-21T12:00:00.000Z",
			});
			expect(() =>
				queue.markProcessed("disposed-row", {
					now: "2026-07-21T12:00:01.000Z",
					evidence: {
						v: 1,
						kind: "lead_ack",
						ref: "ack-1",
						actor: "lead-a",
						actor_kind: "lead",
						fence: { lease_generation: 1 },
					},
				}),
			).toThrow(/disposed|terminal/i);
		} finally {
			queue.close();
		}
	});

	it("allows only audited internal-mirror exemptions", () => {
		const queue = new LeadInboxQueue(dbPath);
		try {
			expect(() =>
				queue.enqueue({
					id: "unaudited-mirror",
					toLead: "lead-a",
					source: "mirror",
					type: "progress",
					msgClass: "model",
					content: "internal only",
					receiptExemptReason: "internal_mirror",
				}),
			).toThrow(/exemption.*audit/i);

			queue.enqueue({
				id: "audited-mirror",
				toLead: "lead-a",
				source: "mirror",
				type: "progress",
				msgClass: "model",
				content: "internal only",
				receiptExemptReason: "internal_mirror",
				receiptExemptionAudit: {
					eventId: "exemption:set:audited-mirror",
					actor: "bridge",
					at: "2026-07-21T12:00:00.000Z",
					changeSource: "internal-mirror-producer",
				},
			});
			expect(queue.getById("audited-mirror")).toMatchObject({
				priority: 2,
				receipt_exempt_reason: "internal_mirror",
			});

			const raw = new Database(dbPath);
			try {
				expect(
					raw
						.prepare(
							"SELECT reason, actor, operation FROM receipt_exemption_audit WHERE receipt_id = ?",
						)
						.get("audited-mirror"),
				).toEqual({
					reason: "internal_mirror",
					actor: "bridge",
					operation: "set",
				});
				expect(() =>
					raw
						.prepare(
							"UPDATE receipt_exemption_audit SET actor = 'tampered' WHERE receipt_id = ?",
						)
						.run("audited-mirror"),
				).toThrow(/append-only/i);
			} finally {
				raw.close();
			}
		} finally {
			queue.close();
		}
	});

	it("handles any receipt with Lead authorization and request-digest idempotency", () => {
		const db = new CommDB(dbPath);
		const queue = new LeadInboxQueue(dbPath);
		try {
			queue.enqueue({
				id: "future-receipt",
				toLead: "lead-a",
				source: "future",
				type: "brand_new_category",
				msgClass: "model",
				content: "please inspect",
			});
			markDelivered(queue, "future-receipt", "lead-a");
			const input = {
				requestId: "handle-request-1",
				receiptId: "future-receipt",
				authenticatedLead: "lead-a",
				action: "ack" as const,
				reason: "reviewed",
				now: "2026-07-21T12:00:00.000Z",
				provenance: { senderLeaseKey: "lease-a", senderGeneration: 12 },
			};
			const first = db.handleReceipt(input);
			expect(first).toMatchObject({
				kind: "handled",
				receiptId: "future-receipt",
				action: "ack",
			});
			expect(db.handleReceipt(input)).toEqual(first);
			expect(queue.getById("future-receipt")).toMatchObject({
				processed_at: "2026-07-21T12:00:00.000Z",
				next_unprocessed_at: null,
			});
			expect(() =>
				db.handleReceipt({ ...input, reason: "different payload" }),
			).toThrow(/idempotency_conflict/);
			expect(() =>
				db.handleReceipt({
					...input,
					requestId: "handle-request-other-lead",
					authenticatedLead: "lead-b",
				}),
			).toThrow(/not_authorized/);
			expect(() =>
				db.handleReceipt({ ...input, requestId: "handle-request-2" }),
			).toThrow(/already_processed/);
		} finally {
			queue.close();
			db.close();
		}
	});

	it("rolls response, terminal receipt, and wake back at every handle crash seam", () => {
		for (const [index, crashAfter] of [
			"effect",
			"terminal",
			"wake",
		].entries()) {
			const seamPath = join(dir, `crash-${crashAfter}.db`);
			const db = new CommDB(seamPath);
			const queue = new LeadInboxQueue(seamPath);
			try {
				const receiptId = `receipt-${index}`;
				const questionId = db.insertQuestion(
					`exec-${index}`,
					"lead-a",
					"what should I do?",
				);
				queue.enqueue({
					id: receiptId,
					toLead: "lead-a",
					source: "founder_reply",
					type: "founder_reply",
					msgClass: "model",
					priority: 0,
					content: "do the next thing",
				});
				markDelivered(queue, receiptId, "lead-a");
				expect(() =>
					db.handleReceipt({
						requestId: `request-${index}`,
						receiptId,
						authenticatedLead: "lead-a",
						action: "relay",
						targetQuestionId: questionId,
						content: "do the next thing",
						now: "2026-07-21T12:00:00.000Z",
						provenance: {
							senderLeaseKey: "lease-a",
							senderGeneration: 12,
						},
						intentKey: `relay-wake-${index}`,
						envelope: {
							id: `wake-${index}`,
							to: `exec-${index}`,
							content: "Founder message relayed",
						},
						queuedAtMs: 1_721_390_000_000 + index,
						testCrashAfter: crashAfter as "effect" | "terminal" | "wake",
					}),
				).toThrow(
					new RegExp(`injected receipt handle crash after ${crashAfter}`),
				);
				expect(db.getResponse(questionId)).toBeUndefined();
				expect(queue.getById(receiptId)).toMatchObject({
					processed_at: null,
					processed_evidence: null,
				});
				expect(db.listRunnerPhaseWakes(`exec-${index}`)).toEqual([]);
				const raw = new Database(seamPath, { readonly: true });
				try {
					expect(
						raw
							.prepare("SELECT COUNT(*) AS count FROM receipt_handle_requests")
							.get(),
					).toEqual({ count: 0 });
				} finally {
					raw.close();
				}
			} finally {
				queue.close();
				db.close();
			}
		}
	});

	it("records one founder canonical row for the delivery loop", () => {
		const queue = new LeadInboxQueue(dbPath);
		try {
			const enqueueHubRoot = (
				queue as unknown as {
					enqueueHubRoot?: (input: {
						id: string;
						toLead: string;
						content: string;
						refMessageId: string;
						now: string;
						nextUnprocessedAt: string;
						routingState: string;
					}) => { id: string; delivered_at: string | null };
				}
			).enqueueHubRoot;
			expect(enqueueHubRoot).toBeTypeOf("function");
			expect(
				enqueueHubRoot?.call(queue, {
					id: "founder_msg:lead-a:discord-1",
					toLead: "lead-a",
					content: "please fix this",
					refMessageId: "discord-1",
					now: "2026-07-20T12:00:00.000Z",
					nextUnprocessedAt: "2026-07-20T12:30:00.000Z",
					routingState: "awaiting_rebind",
				}),
			).toMatchObject({
				id: "founder_msg:lead-a:discord-1",
				delivered_at: null,
			});
			expect(queue.getById("founder_msg:lead-a:discord-1")).toMatchObject({
				type: "founder_reply",
				msg_class: "model",
				priority: 0,
				disposition: null,
				delivered_at: null,
				consumed_at: null,
				processed_at: null,
				next_unprocessed_at: null,
				routing_state: "awaiting_rebind",
			});
			expect(queue.countPending("lead-a")).toBe(1);
		} finally {
			queue.close();
		}
	});

	it("atomically answers, processes the founder root, and admits the runner wake", () => {
		const db = new CommDB(dbPath);
		const queue = new LeadInboxQueue(dbPath);
		try {
			queue.enqueueHubRoot({
				id: "founder_msg:lead-a:discord-2",
				toLead: "lead-a",
				content: "answer the runner",
				refMessageId: "discord-2",
				now: "2026-07-20T12:00:00.000Z",
				nextUnprocessedAt: "2026-07-20T12:30:00.000Z",
			});
			const questionId = db.insertQuestion("exec-a", "lead-a", "which option?");
			const respondAndReceipt = (
				db as unknown as {
					respondAndReceipt?: (input: Record<string, unknown>) => {
						responseId: string;
						wake: RunnerPhaseWake;
					};
				}
			).respondAndReceipt;
			expect(respondAndReceipt).toBeTypeOf("function");
			const result = respondAndReceipt?.call(db, {
				questionId,
				fromAgent: "lead-a",
				content: "choose option A",
				rootId: "founder_msg:lead-a:discord-2",
				evidence: {
					v: 1,
					kind: "question_bound",
					actor: "lead-a",
					actor_kind: "lead",
					fence: { lease_generation: 7 },
				},
				now: "2026-07-20T12:00:01.000Z",
				intentKey: `gate-answer:${questionId}`,
				envelope: {
					id: "wake-response-1",
					to: "exec-a",
					content: "your gate was answered",
					metadata: { execId: "exec-a" },
				},
				queuedAtMs: 1_721_390_001_000,
			});

			expect(db.getResponse(questionId)).toMatchObject({
				id: result?.responseId,
				from_agent: "lead-a",
				to_agent: "exec-a",
				content: "choose option A",
			});
			const root = queue.getById("founder_msg:lead-a:discord-2");
			expect(root).toMatchObject({
				processed_at: "2026-07-20T12:00:01.000Z",
				routing_state: "bound",
				next_unprocessed_at: null,
			});
			expect(JSON.parse(root?.processed_evidence ?? "null")).toMatchObject({
				kind: "question_bound",
				ref: result?.responseId,
				actor: "lead-a",
				fence: { lease_generation: 7 },
			});
			expect(result?.wake).toMatchObject({
				execution_id: "exec-a",
				message_id: `gate-answer:${questionId}`,
				state: "pending",
			});
		} finally {
			queue.close();
			db.close();
		}
	});

	it("extends the trusted founder approval writer with receipt and wake in one UOW", () => {
		const db = new CommDB(dbPath);
		const queue = new LeadInboxQueue(dbPath);
		try {
			queue.enqueueHubRoot({
				id: "founder_msg:lead-a:discord-ship",
				toLead: "lead-a",
				content: "ship it",
				refMessageId: "discord-ship",
				now: "2026-07-20T12:00:00.000Z",
			});
			const questionId = db.insertQuestion("exec-a", "lead-a", "approve?", {
				checkpoint: "approve_to_ship",
			});
			const trusted = (
				db as unknown as {
					trustedFounderApprovalAndReceipt?: (
						input: Record<string, unknown>,
					) => { responseId: string; wake: RunnerPhaseWake };
				}
			).trustedFounderApprovalAndReceipt;
			expect(trusted).toBeTypeOf("function");
			const result = trusted?.call(db, {
				project: "flywheel",
				sourceEventId: "discord:discord-ship",
				questionId,
				fromAgent: "founder",
				content: "approved",
				expectedOwner: "exec-a",
				payload: { messageId: "discord-ship", approved: true },
				rootId: "founder_msg:lead-a:discord-ship",
				evidence: {
					v: 1,
					kind: "ship_bound",
					actor: "founder",
					actor_kind: "founder-writer",
					fence: { authority: "discord:discord-ship" },
				},
				now: "2026-07-20T12:00:01.000Z",
				intentKey: `gate-answer:${questionId}`,
				envelope: {
					id: "wake-ship",
					to: "exec-a",
					content: "ship gate approved",
					metadata: { execId: "exec-a" },
				},
				queuedAtMs: 1_721_390_001_000,
			});

			expect(db.getResponse(questionId)).toMatchObject({
				id: result?.responseId,
				from_agent: "founder",
			});
			expect(db.listWorkflowSourceEvents()).toEqual([
				expect.objectContaining({
					source_event_id: "discord:discord-ship",
					kind: "founder_approval",
				}),
			]);
			const root = queue.getById("founder_msg:lead-a:discord-ship");
			expect(root).toMatchObject({
				processed_at: "2026-07-20T12:00:01.000Z",
				routing_state: "bound",
			});
			expect(JSON.parse(root?.processed_evidence ?? "null")).toMatchObject({
				kind: "ship_bound",
				ref: result?.responseId,
				actor_kind: "founder-writer",
			});
			expect(result?.wake.message_id).toBe(`gate-answer:${questionId}`);
		} finally {
			queue.close();
			db.close();
		}
	});

	it("atomically records engine founder feedback with its receipt and wake", () => {
		const db = new CommDB(dbPath);
		const queue = new LeadInboxQueue(dbPath);
		try {
			const feedback = '{"approved":false,"feedback":"fix the release notes"}';
			queue.enqueueHubRoot({
				id: "founder_msg:lead-a:discord-feedback",
				toLead: "lead-a",
				content: JSON.stringify({
					msgId: "discord-feedback",
					answer: feedback,
					projectName: "flywheel",
					issueId: "FLY-1375",
					threadId: "thread-1375",
				}),
				refMessageId: "discord-feedback",
				now: "2026-07-20T12:00:00.000Z",
			});
			const questionId = db.insertQuestion("exec-a", "lead-a", "approve?", {
				checkpoint: "approve_to_ship",
			});
			const result = db.trustedFounderGateResponseAndReceipt({
				questionId,
				fromAgent: "founder",
				content: feedback,
				expectedOwner: "exec-a",
				rootId: "founder_msg:lead-a:discord-feedback",
				msgId: "discord-feedback",
				now: "2026-07-20T12:00:01.000Z",
				intentKey: `gate-feedback:${questionId}`,
				envelope: {
					id: "wake-feedback",
					to: "exec-a",
					content: "ship gate feedback",
				},
				queuedAtMs: 1_721_390_001_000,
				approvalSource: {
					project: "flywheel",
					sourceEventId: `founder-feedback:${questionId}:discord-feedback`,
					payload: {
						response: { approved: false, feedback },
					},
				},
			});

			expect(db.getResponse(questionId)).toMatchObject({
				id: result.responseId,
				from_agent: "founder",
				content: feedback,
			});
			expect(db.listWorkflowSourceEvents()).toEqual([
				expect.objectContaining({
					source_event_id: `founder-feedback:${questionId}:discord-feedback`,
					kind: "founder_feedback",
				}),
			]);
			expect(
				queue.getById("founder_msg:lead-a:discord-feedback"),
			).toMatchObject({
				processed_at: "2026-07-20T12:00:01.000Z",
				routing_state: "bound",
			});
			expect(result.wake.message_id).toBe(`gate-feedback:${questionId}`);
		} finally {
			queue.close();
			db.close();
		}
	});

	it("rejects malformed pre-existing founder settlement evidence", () => {
		const db = new CommDB(dbPath);
		const queue = new LeadInboxQueue(dbPath);
		const rootId = "founder_msg:lead-a:discord-settlement";
		const rootContent = JSON.stringify({
			msgId: "discord-settlement",
			answer: "approved",
			projectName: "flywheel",
			issueId: "FLY-1448",
			threadId: "thread-1448",
		});
		try {
			queue.enqueueHubRoot({
				id: rootId,
				toLead: "lead-a",
				content: rootContent,
				refMessageId: "discord-settlement",
				now: "2026-07-24T00:00:00.000Z",
				routingState: "awaiting_rebind",
			});
			queue.markProcessed(rootId, {
				now: "2026-07-24T00:00:01.000Z",
				evidence: {
					v: 1,
					kind: "ship_gate_bound",
					ref: "response-question-1",
					actor: "founder",
					actor_kind: "founder-writer",
					fence: { discord_message_id: "discord-settlement" },
					basis: ["question:question-1"],
				},
			});
			const raw = new Database(dbPath);
			try {
				raw
					.prepare("UPDATE lead_inbox SET processed_evidence = ? WHERE id = ?")
					.run(JSON.stringify({ kind: "ship_gate_bound" }), rootId);
			} finally {
				raw.close();
			}

			expect(
				db.settleFounderHubRoot({
					rootId,
					now: "2026-07-24T00:00:02.000Z",
					evidence: {
						v: 1,
						kind: "already_applied",
						ref: "question-1",
						actor: "founder",
						actor_kind: "founder-writer",
						fence: { discord_message_id: "discord-settlement" },
						basis: ["question:question-1"],
					},
					acceptedProcessedKinds: ["ship_gate_bound", "already_applied"],
				}),
			).toEqual({ kind: "conflict" });
			expect(queue.getById(rootId)?.routing_state).toBe("awaiting_rebind");
		} finally {
			queue.close();
			db.close();
		}
	});

	it("rejects pre-existing founder evidence for a different question", () => {
		const db = new CommDB(dbPath);
		const queue = new LeadInboxQueue(dbPath);
		const rootId = "founder_msg:lead-a:discord-question-lineage";
		try {
			queue.enqueueHubRoot({
				id: rootId,
				toLead: "lead-a",
				content: JSON.stringify({
					msgId: "discord-question-lineage",
					answer: "approved",
					projectName: "flywheel",
					issueId: "FLY-1448",
					threadId: "thread-1448",
				}),
				refMessageId: "discord-question-lineage",
				now: "2026-07-24T00:00:00.000Z",
				routingState: "awaiting_rebind",
			});
			queue.markProcessed(rootId, {
				now: "2026-07-24T00:00:01.000Z",
				evidence: {
					v: 1,
					kind: "ship_gate_bound",
					ref: "response-question-other",
					actor: "founder",
					actor_kind: "founder-writer",
					fence: { discord_message_id: "discord-question-lineage" },
					basis: ["question:question-other"],
				},
			});

			expect(
				db.settleFounderHubRoot({
					rootId,
					now: "2026-07-24T00:00:02.000Z",
					evidence: {
						v: 1,
						kind: "already_applied",
						ref: "question-expected",
						actor: "founder",
						actor_kind: "founder-writer",
						fence: { discord_message_id: "discord-question-lineage" },
						basis: ["question:question-expected"],
					},
					acceptedProcessedKinds: ["ship_gate_bound", "already_applied"],
				}),
			).toEqual({
				kind: "conflict",
				evidenceKind: "ship_gate_bound",
			});
			expect(queue.getById(rootId)?.routing_state).toBe("awaiting_rebind");
		} finally {
			queue.close();
			db.close();
		}
	});

	it("rejects pre-existing founder evidence written by a different actor", () => {
		const db = new CommDB(dbPath);
		const queue = new LeadInboxQueue(dbPath);
		const rootId = "founder_msg:lead-a:discord-actor-lineage";
		try {
			queue.enqueueHubRoot({
				id: rootId,
				toLead: "lead-a",
				content: JSON.stringify({
					msgId: "discord-actor-lineage",
					answer: "approved",
					projectName: "flywheel",
					issueId: "FLY-1448",
					threadId: "thread-1448",
				}),
				refMessageId: "discord-actor-lineage",
				now: "2026-07-24T00:00:00.000Z",
				routingState: "awaiting_rebind",
			});
			queue.markProcessed(rootId, {
				now: "2026-07-24T00:00:01.000Z",
				evidence: {
					v: 1,
					kind: "already_applied",
					ref: "question-expected",
					actor: "founder-other",
					actor_kind: "founder-writer",
					fence: { discord_message_id: "discord-actor-lineage" },
					basis: ["question:question-expected"],
				},
			});

			expect(
				db.settleFounderHubRoot({
					rootId,
					now: "2026-07-24T00:00:02.000Z",
					evidence: {
						v: 1,
						kind: "already_applied",
						ref: "question-expected",
						actor: "founder-expected",
						actor_kind: "founder-writer",
						fence: { discord_message_id: "discord-actor-lineage" },
						basis: ["question:question-expected"],
					},
					acceptedProcessedKinds: ["already_applied"],
				}),
			).toEqual({
				kind: "conflict",
				evidenceKind: "already_applied",
			});
		} finally {
			queue.close();
			db.close();
		}
	});

	it("rejects ship-gate evidence whose response ref is not bound to its question", () => {
		const db = new CommDB(dbPath);
		const queue = new LeadInboxQueue(dbPath);
		const rootId = "founder_msg:lead-a:discord-response-lineage";
		try {
			queue.enqueueHubRoot({
				id: rootId,
				toLead: "lead-a",
				content: JSON.stringify({
					msgId: "discord-response-lineage",
					answer: "approved",
					projectName: "flywheel",
					issueId: "FLY-1448",
					threadId: "thread-1448",
				}),
				refMessageId: "discord-response-lineage",
				now: "2026-07-24T00:00:00.000Z",
				routingState: "awaiting_rebind",
			});
			queue.markProcessed(rootId, {
				now: "2026-07-24T00:00:01.000Z",
				evidence: {
					v: 1,
					kind: "ship_gate_bound",
					ref: "unrelated-response",
					actor: "founder",
					actor_kind: "founder-writer",
					fence: { discord_message_id: "discord-response-lineage" },
					basis: ["question:question-expected"],
				},
			});

			expect(
				db.settleFounderHubRoot({
					rootId,
					now: "2026-07-24T00:00:02.000Z",
					evidence: {
						v: 1,
						kind: "already_applied",
						ref: "question-expected",
						actor: "founder",
						actor_kind: "founder-writer",
						fence: { discord_message_id: "discord-response-lineage" },
						basis: ["question:question-expected"],
					},
					acceptedProcessedKinds: ["ship_gate_bound", "already_applied"],
				}),
			).toEqual({
				kind: "conflict",
				evidenceKind: "ship_gate_bound",
			});
		} finally {
			queue.close();
			db.close();
		}
	});
});
