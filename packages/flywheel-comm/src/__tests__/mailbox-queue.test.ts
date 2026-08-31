import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { CommDB } from "../db.js";
import { MailboxQueue, QUARANTINE_DEAD_REASONS } from "../mailbox-queue.js";
import { MAILBOX_SCHEMA } from "../mailbox-schema.js";
import { encodeSenderRef } from "../sender-ref.js";
import { writeContentRef } from "../utils/content-ref.js";

const NOW = "2026-08-05T12:00:00.000Z";
const SENDER_REF = encodeSenderRef();

function enqueueLead(
	queue: MailboxQueue,
	id: string,
	opts: {
		priority?: 0 | 1 | 2 | 3;
		carrier?: "inbox" | "external";
		relayState?: "open" | "protected" | "terminal_disposed";
	} = {},
) {
	return queue.enqueue({
		id,
		fromAgent: "runner-a",
		toAgent: "lead-a",
		recipientKind: "lead",
		type: "question",
		content: id,
		createdAt: NOW,
		priority: opts.priority,
		carrier: opts.carrier,
		relayState: opts.relayState,
		senderRef: SENDER_REF,
	});
}

describe("FLY-1572 MailboxQueue", () => {
	it("births only questions with an open relay state", () => {
		const queue = new MailboxQueue(":memory:");
		try {
			const instruction = queue.enqueue({
				id: "instruction-terminal-at-birth",
				fromAgent: "lead-a",
				toAgent: "runner-a",
				recipientKind: "runner",
				type: "instruction",
				content: "continue",
				createdAt: NOW,
				senderRef: SENDER_REF,
			});
			expect(instruction.outcome).toBe("inserted");
			if (instruction.outcome !== "inserted") throw new Error("not inserted");
			expect(instruction.row.relay_state).toBe("terminal_disposed");
			const question = enqueueLead(queue, "question-open");
			expect(question.outcome).toBe("inserted");
			if (question.outcome !== "inserted") throw new Error("not inserted");
			expect(question.row.relay_state).toBe("open");
		} finally {
			queue.close();
		}
	});

	it("replays a pre-upgrade non-question identity without changing its projection", () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1645-mailbox-hash-"));
		const dbPath = join(dir, "comm.db");
		const input = {
			id: "stable-lead-event",
			fromAgent: "bridge",
			toAgent: "lead-a",
			recipientKind: "lead" as const,
			type: "stage_changed",
			content: "stage changed",
			createdAt: NOW,
			senderRef: SENDER_REF,
		};
		try {
			const legacy = new MailboxQueue(dbPath);
			const raw = new Database(dbPath);
			try {
				raw.exec(`
					DROP TRIGGER IF EXISTS mailbox_non_question_relay_insert_guard;
					DROP TRIGGER IF EXISTS mailbox_non_question_relay_update_guard;
				`);
			} finally {
				raw.close();
			}
			expect(legacy.enqueue({ ...input, relayState: "open" }).outcome).toBe(
				"inserted",
			);
			legacy.close();

			const upgraded = new MailboxQueue(dbPath);
			try {
				expect(upgraded.enqueue(input).outcome).toBe("active");
				expect(upgraded.getById(input.id)?.relay_state).toBe("open");
			} finally {
				upgraded.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("guards relay deltas without blocking delivery updates on a legacy row", () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1645-mailbox-trigger-"));
		const dbPath = join(dir, "comm.db");
		try {
			const seed = new MailboxQueue(dbPath);
			const raw = new Database(dbPath);
			try {
				raw.exec(`
					DROP TRIGGER IF EXISTS mailbox_non_question_relay_insert_guard;
					DROP TRIGGER IF EXISTS mailbox_non_question_relay_update_guard;
				`);
			} finally {
				raw.close();
			}
			seed.enqueue({
				id: "legacy-open-instruction",
				fromAgent: "lead-a",
				toAgent: "runner-a",
				recipientKind: "runner",
				type: "instruction",
				content: "legacy",
				createdAt: NOW,
				relayState: "open",
				senderRef: SENDER_REF,
			});
			seed.close();

			const upgraded = new MailboxQueue(dbPath);
			try {
				expect(upgraded.ack("legacy-open-instruction", NOW)).toBe(true);
				expect(() =>
					upgraded.enqueue({
						id: "new-open-instruction",
						fromAgent: "lead-a",
						toAgent: "runner-a",
						recipientKind: "runner",
						type: "instruction",
						content: "invalid",
						createdAt: NOW,
						relayState: "open",
						senderRef: SENDER_REF,
					}),
				).toThrow(/only questions may have an active relay state/i);
			} finally {
				upgraded.close();
			}

			const verify = new Database(dbPath);
			try {
				expect(() =>
					verify
						.prepare("UPDATE mailbox SET relay_state='protected' WHERE id=?")
						.run("legacy-open-instruction"),
				).toThrow(/only questions may have an active relay state/i);
			} finally {
				verify.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reserves identities before insert and canonical-compares every replay", () => {
		const queue = new MailboxQueue(":memory:");
		try {
			const terminal = { relayState: "terminal_disposed" as const };
			expect(enqueueLead(queue, "q1", terminal).outcome).toBe("inserted");
			expect(enqueueLead(queue, "q1", terminal).outcome).toBe("active");
			expect(() =>
				queue.enqueue({
					id: "q1",
					fromAgent: "runner-a",
					toAgent: "lead-a",
					recipientKind: "lead",
					type: "question",
					content: "changed",
					createdAt: NOW,
					senderRef: SENDER_REF,
				}),
			).toThrow(/identity conflict/);

			queue.ack("q1", "2026-08-05T12:01:00.000Z");
			expect(
				queue.archiveFamily({
					id: "q1",
					now: "2026-08-08T12:02:00.000Z",
					retentionMs: 72 * 60 * 60_000,
				}),
			).toBe("archived");
			expect(enqueueLead(queue, "q1", terminal).outcome).toBe("archived");
			expect(() =>
				queue.enqueue({
					id: "q1",
					fromAgent: "runner-a",
					toAgent: "lead-a",
					recipientKind: "lead",
					type: "question",
					content: "changed after archive",
					createdAt: NOW,
					senderRef: SENDER_REF,
				}),
			).toThrow(/identity conflict/);
		} finally {
			queue.close();
		}
	});

	it("claims only the addressed Lead lane in stable priority/seq order", () => {
		const queue = new MailboxQueue(":memory:");
		try {
			enqueueLead(queue, "p2", { priority: 2 });
			enqueueLead(queue, "p0", { priority: 0 });
			enqueueLead(queue, "external", { carrier: "external" });
			queue.enqueue({
				id: "runner",
				fromAgent: "lead-a",
				toAgent: "exec-1",
				recipientKind: "runner",
				type: "instruction",
				content: "runner",
				createdAt: NOW,
				senderRef: SENDER_REF,
			});
			queue.acquireOrRenewOwner({
				ownerEpoch: "epoch-1",
				now: NOW,
				leaseTtlMs: 10_000,
			});

			const claimed = queue.claimLeadBatch({
				toAgent: "lead-a",
				msgClass: "model",
				ownerEpoch: "epoch-1",
				batchId: "batch-1",
				now: NOW,
				claimTtlMs: 30 * 60_000,
			});
			expect(claimed.map((row) => row.id)).toEqual(["p0", "p2"]);
			expect(claimed.every((row) => row.state === "LEASED")).toBe(true);
			expect(queue.countDeliverable("lead-a")).toBe(0);
			expect(queue.getById("external")?.state).toBe("QUEUED");
			expect(queue.getById("runner")?.state).toBe("QUEUED");
		} finally {
			queue.close();
		}
	});

	it("ACKs the whole accepted batch and clears its claim", () => {
		const queue = new MailboxQueue(":memory:");
		try {
			enqueueLead(queue, "q1");
			queue.acquireOrRenewOwner({
				ownerEpoch: "epoch-1",
				now: NOW,
				leaseTtlMs: 10_000,
			});
			queue.claimLeadBatch({
				toAgent: "lead-a",
				msgClass: "model",
				ownerEpoch: "epoch-1",
				batchId: "batch-1",
				now: NOW,
				claimTtlMs: 30_000,
			});
			expect(
				queue.ackBatch({
					batchId: "batch-1",
					ownerEpoch: "epoch-1",
					memberIds: ["q1"],
					now: "2026-08-05T12:00:05.000Z",
				}),
			).toBe(true);
			expect(queue.getById("q1")).toMatchObject({
				state: "ACKED",
				acked_at: "2026-08-05T12:00:05.000Z",
				claimed_by: null,
				claim_expires_at: null,
			});
		} finally {
			queue.close();
		}
	});

	it.each(["ackBatch", "ackBatchByRecipient"] as const)(
		"retires a trusted runner-stop report when the Lead consumes it via %s",
		(method) => {
			const queue = new MailboxQueue(":memory:");
			try {
				const questionId = `rstop-${"a".repeat(32)}`;
				queue.enqueue({
					id: questionId,
					fromAgent: "runner-a",
					toAgent: "lead-a",
					recipientKind: "lead",
					type: "question",
					kind: "report",
					content:
						"RUNNER-STOPPED kind=runner_stopped reason=done issue=FLY-2017 exec=runner-a route=- detail=parked",
					createdAt: NOW,
					senderRef: SENDER_REF,
				});
				queue.acquireOrRenewOwner({
					ownerEpoch: "epoch-1",
					now: NOW,
					leaseTtlMs: 10_000,
				});
				queue.claimLeadBatch({
					toAgent: "lead-a",
					msgClass: "model",
					ownerEpoch: "epoch-1",
					batchId: "batch-rstop",
					now: NOW,
					claimTtlMs: 30_000,
				});

				if (method === "ackBatch") {
					expect(
						queue.ackBatch({
							batchId: "batch-rstop",
							ownerEpoch: "epoch-1",
							memberIds: [questionId],
							now: "2026-08-05T12:00:05.000Z",
						}),
					).toBe(true);
				} else {
					expect(
						queue.ackBatchByRecipient({
							batchId: "batch-rstop",
							fromAgent: "lead-a",
							now: "2026-08-05T12:00:05.000Z",
						}),
					).toBe("applied");
				}
				expect(queue.getById(questionId)).toMatchObject({
					state: "ACKED",
					relay_state: "terminal_disposed",
					resolved_via: "report_ack",
				});
			} finally {
				queue.close();
			}
		},
	);

	it("tolerates an out-of-band ACK inside an accepted Lead batch", () => {
		const queue = new MailboxQueue(":memory:");
		try {
			enqueueLead(queue, "q1");
			enqueueLead(queue, "q2");
			queue.acquireOrRenewOwner({
				ownerEpoch: "epoch-1",
				now: NOW,
				leaseTtlMs: 10_000,
			});
			queue.claimLeadBatch({
				toAgent: "lead-a",
				msgClass: "model",
				ownerEpoch: "epoch-1",
				batchId: "batch-1",
				now: NOW,
				claimTtlMs: 30_000,
			});
			expect(queue.ack("q1", "2026-08-05T12:00:04.000Z")).toBe(true);
			expect(
				queue.ackBatch({
					batchId: "batch-1",
					ownerEpoch: "epoch-1",
					memberIds: ["q1", "q2"],
					now: "2026-08-05T12:00:05.000Z",
				}),
			).toBe(true);
			expect(queue.getById("q1")?.state).toBe("ACKED");
			expect(queue.getById("q2")?.state).toBe("ACKED");
		} finally {
			queue.close();
		}
	});

	it("keeps Lead delivery failures in the frozen batch until retry is due", () => {
		const queue = new MailboxQueue(":memory:");
		try {
			enqueueLead(queue, "q1");
			queue.acquireOrRenewOwner({
				ownerEpoch: "epoch-1",
				now: NOW,
				leaseTtlMs: 10_000,
			});
			queue.claimLeadBatch({
				toAgent: "lead-a",
				msgClass: "model",
				ownerEpoch: "epoch-1",
				batchId: "batch-1",
				now: NOW,
				claimTtlMs: 30_000,
			});
			queue.recordLeadDeliveryFailure({
				batchId: "batch-1",
				ownerEpoch: "epoch-1",
				now: "2026-08-05T12:00:01.000Z",
				nextRetryAt: "2026-08-05T12:05:00.000Z",
				error: "transport down",
				maxAttempts: 5,
			});
			expect(queue.getById("q1")).toMatchObject({
				state: "LEASED",
				batch_id: "batch-1",
				claimed_by: null,
				retry_count: 1,
			});
			expect(
				queue.claimLeadBatch({
					toAgent: "lead-a",
					msgClass: "model",
					ownerEpoch: "epoch-1",
					batchId: "ignored-for-reclaim",
					now: "2026-08-05T12:04:59.000Z",
					claimTtlMs: 30_000,
				}),
			).toEqual([]);
			queue.acquireOrRenewOwner({
				ownerEpoch: "epoch-1",
				now: "2026-08-05T12:05:00.000Z",
				leaseTtlMs: 10_000,
			});
			expect(
				queue.claimLeadBatch({
					toAgent: "lead-a",
					msgClass: "model",
					ownerEpoch: "epoch-1",
					batchId: "ignored-for-reclaim",
					now: "2026-08-05T12:05:00.000Z",
					claimTtlMs: 30_000,
				}),
			).toHaveLength(1);
		} finally {
			queue.close();
		}
	});

	it("records a caller-selected DEAD reason without making it quarantine-recoverable", () => {
		const queue = new MailboxQueue(":memory:");
		try {
			queue.enqueue({
				id: "unavailable-1",
				fromAgent: "runner-a",
				toAgent: "lead-a",
				recipientKind: "lead",
				type: "regular",
				content: "unavailable-1",
				createdAt: NOW,
				senderRef: SENDER_REF,
			});
			queue.acquireOrRenewOwner({
				ownerEpoch: "epoch-1",
				now: NOW,
				leaseTtlMs: 10_000,
			});
			queue.claimLeadBatch({
				toAgent: "lead-a",
				msgClass: "model",
				ownerEpoch: "epoch-1",
				batchId: "batch-unavailable",
				now: NOW,
				claimTtlMs: 30_000,
			});

			expect(
				queue.recordLeadDeliveryFailure({
					batchId: "batch-unavailable",
					ownerEpoch: "epoch-1",
					now: "2026-08-05T12:00:01.000Z",
					nextRetryAt: "2026-08-05T12:00:05.000Z",
					error: "socket unavailable",
					maxAttempts: 1,
					deadReason: "transport_unavailable_exhausted",
				}),
			).toBe(1);
			expect(queue.getById("unavailable-1")).toMatchObject({
				state: "DEAD",
				retry_count: 1,
				next_retry_at: null,
				batch_id: null,
				dead_reason: "transport_unavailable_exhausted",
			});
			expect(QUARANTINE_DEAD_REASONS).not.toContain(
				"transport_unavailable_exhausted",
			);
			expect(
				queue.listUncoveredLeadDeadLetters({
					sinceCursor: [],
					limit: 10,
					maxRowsPerRecipient: 10,
					maxSummaryBytes: 4_096,
					resolveOwningLead: () => undefined,
				}),
			).toEqual([
				expect.objectContaining({
					sourceKind: "lead_unacked",
					recipient: "lead-a",
					deadCount: 1,
				}),
			]);
			expect(
				queue.archiveDueFamilies({
					now: "2026-08-08T12:00:01.000Z",
				}),
			).toMatchObject({ archivedFamilies: 1, archivedMessages: 1 });
			expect(
				queue.listUncoveredLeadDeadLetters({
					sinceCursor: [],
					limit: 10,
					maxRowsPerRecipient: 10,
					maxSummaryBytes: 4_096,
					resolveOwningLead: () => undefined,
				}),
			).toEqual([]);
		} finally {
			queue.close();
		}
	});

	it("keeps the existing Lead DEAD reason when no override is supplied", () => {
		const queue = new MailboxQueue(":memory:");
		try {
			enqueueLead(queue, "ordinary-1");
			queue.acquireOrRenewOwner({
				ownerEpoch: "epoch-1",
				now: NOW,
				leaseTtlMs: 10_000,
			});
			queue.claimLeadBatch({
				toAgent: "lead-a",
				msgClass: "model",
				ownerEpoch: "epoch-1",
				batchId: "batch-ordinary",
				now: NOW,
				claimTtlMs: 30_000,
			});
			queue.recordLeadDeliveryFailure({
				batchId: "batch-ordinary",
				ownerEpoch: "epoch-1",
				now: "2026-08-05T12:00:01.000Z",
				nextRetryAt: "2026-08-05T12:00:05.000Z",
				error: "permanent rejection",
				maxAttempts: 1,
			});
			expect(queue.getById("ordinary-1")?.dead_reason).toBe(
				"delivery_attempts_exhausted",
			);
		} finally {
			queue.close();
		}
	});

	it("preserves frozen membership when a member becomes terminal", () => {
		const queue = new MailboxQueue(":memory:");
		try {
			enqueueLead(queue, "q1");
			enqueueLead(queue, "q2");
			queue.acquireOrRenewOwner({
				ownerEpoch: "epoch-1",
				now: NOW,
				leaseTtlMs: 10_000,
			});
			queue.claimLeadBatch({
				toAgent: "lead-a",
				msgClass: "model",
				ownerEpoch: "epoch-1",
				batchId: "batch-1",
				now: NOW,
				claimTtlMs: 30_000,
			});
			queue.recordLeadDeliveryFailure({
				batchId: "batch-1",
				ownerEpoch: "epoch-1",
				now: "2026-08-05T12:00:01.000Z",
				nextRetryAt: "2026-08-05T12:05:00.000Z",
				error: "transport down",
				maxAttempts: 5,
			});
			expect(queue.ack("q1", "2026-08-05T12:03:00.000Z")).toBe(true);
			queue.acquireOrRenewOwner({
				ownerEpoch: "epoch-1",
				now: "2026-08-05T12:05:00.000Z",
				leaseTtlMs: 10_000,
			});
			const reclaimed = queue.claimLeadBatch({
				toAgent: "lead-a",
				msgClass: "model",
				ownerEpoch: "epoch-1",
				batchId: "ignored-for-reclaim",
				now: "2026-08-05T12:05:00.000Z",
				claimTtlMs: 30_000,
			});
			expect(reclaimed.map((row) => row.id)).toEqual(["q1", "q2"]);
			expect(
				queue.ackBatch({
					batchId: "batch-1",
					ownerEpoch: "epoch-1",
					memberIds: reclaimed.map((row) => row.delivery_id),
					now: "2026-08-05T12:05:01.000Z",
				}),
			).toBe(true);
			expect(queue.getById("q2")?.state).toBe("ACKED");
		} finally {
			queue.close();
		}
	});

	it("archives a whole resolved RPC family only after the retention window", () => {
		const queue = new MailboxQueue(":memory:");
		try {
			enqueueLead(queue, "question-1");
			queue.enqueue({
				id: "response-1",
				fromAgent: "lead-a",
				toAgent: "runner-a",
				recipientKind: "runner",
				type: "response",
				content: "answer",
				refId: "question-1",
				createdAt: NOW,
				senderRef: SENDER_REF,
			});
			queue.ack("question-1", "2026-08-05T12:00:00.000Z");
			queue.ack("response-1", "2026-08-05T13:00:00.000Z");

			expect(
				queue.archiveDueFamilies({
					now: "2026-08-08T12:59:59.000Z",
				}),
			).toMatchObject({ archivedFamilies: 0, archivedMessages: 0 });
			expect(queue.getById("question-1")).toBeDefined();
			expect(
				queue.archiveDueFamilies({
					now: "2026-08-08T13:00:00.000Z",
				}),
			).toMatchObject({ archivedFamilies: 1, archivedMessages: 2 });
			expect(queue.getById("question-1")).toBeUndefined();
			expect(queue.getById("response-1")).toBeUndefined();
		} finally {
			queue.close();
		}
	});

	it("indexes every archived RPC member by its root question id", () => {
		const db = new Database(":memory:");
		db.exec(MAILBOX_SCHEMA);
		const queue = new MailboxQueue(db);
		try {
			enqueueLead(queue, "question-indexed");
			queue.enqueue({
				id: "response-indexed",
				fromAgent: "lead-a",
				toAgent: "runner-a",
				recipientKind: "runner",
				type: "response",
				content: "answer",
				refId: "question-indexed",
				createdAt: NOW,
				senderRef: SENDER_REF,
			});
			queue.ack("question-indexed", "2026-08-05T12:00:00.000Z");
			queue.ack("response-indexed", "2026-08-05T13:00:00.000Z");

			expect(
				queue.archiveFamily({
					id: "question-indexed",
					now: "2026-08-08T13:00:00.000Z",
				}),
			).toBe("archived");
			expect(
				db
					.prepare(
						"SELECT message_id, subject_id FROM mailbox_log WHERE event = 'archived' ORDER BY message_id",
					)
					.all(),
			).toEqual([
				{ message_id: "question-indexed", subject_id: "question-indexed" },
				{ message_id: "response-indexed", subject_id: "question-indexed" },
			]);
		} finally {
			queue.close();
			db.close();
		}
	});

	it("never archives an unanswered non-terminal question", () => {
		const queue = new MailboxQueue(":memory:");
		try {
			enqueueLead(queue, "question-1");
			queue.ack("question-1", "2026-08-01T00:00:00.000Z");
			expect(
				queue.archiveDueFamilies({ now: "2026-08-05T00:00:00.000Z" }),
			).toMatchObject({ archivedFamilies: 0 });
			expect(queue.getById("question-1")).toBeDefined();
		} finally {
			queue.close();
		}
	});

	it("advances the production five-family batch past not-due families", () => {
		const queue = new MailboxQueue(":memory:");
		try {
			for (let index = 0; index < 40; index += 1) {
				const id = `pinned-question-${String(index).padStart(2, "0")}`;
				enqueueLead(queue, id);
				queue.ack(
					id,
					new Date(
						Date.parse("2026-08-01T00:00:00.000Z") + index,
					).toISOString(),
				);
			}
			queue.enqueue({
				id: "archivable-behind-pinned-window",
				fromAgent: "lead-a",
				toAgent: "runner-a",
				recipientKind: "runner",
				type: "instruction",
				content: "must not remain hidden",
				createdAt: NOW,
				senderRef: SENDER_REF,
			});
			queue.ack("archivable-behind-pinned-window", "2026-08-01T00:00:01.000Z");

			let archivedFamilies = 0;
			for (let pass = 0; pass < 10 && archivedFamilies === 0; pass += 1) {
				archivedFamilies += queue.archiveDueFamilies({
					now: "2026-08-05T00:00:00.000Z",
					maxFamilies: 5,
				}).archivedFamilies;
			}
			expect(archivedFamilies).toBe(1);
			expect(queue.getById("archivable-behind-pinned-window")).toBeUndefined();
		} finally {
			queue.close();
		}
	});

	it("archives content-ref bytes before the GC outbox deletes the file", () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1572-archive-"));
		const dbPath = join(dir, "comm.db");
		const db = new Database(dbPath);
		db.exec(MAILBOX_SCHEMA);
		const queue = new MailboxQueue(db);
		try {
			const refPath = writeContentRef(dbPath, "instruction-1", "full body");
			queue.enqueue({
				id: "instruction-1",
				fromAgent: "lead-a",
				toAgent: "runner-a",
				recipientKind: "runner",
				type: "instruction",
				content: "[content_ref]",
				contentRef: refPath,
				createdAt: NOW,
				senderRef: SENDER_REF,
			});
			queue.ack("instruction-1", "2026-08-01T00:00:00.000Z");
			expect(
				queue.archiveDueFamilies({ now: "2026-08-05T00:00:00.000Z" }),
			).toMatchObject({ archivedFamilies: 1, archivedMessages: 1 });
			expect(existsSync(refPath)).toBe(true);
			const archived = db
				.prepare("SELECT row_json FROM mailbox_log WHERE event_id = ?")
				.get("archived:instruction-1") as { row_json: string };
			expect(JSON.parse(archived.row_json).content_ref_archive).toMatchObject({
				path: refPath,
				bytes: 9,
				content_base64: Buffer.from("full body").toString("base64"),
			});
			let contentRefReads = 0;
			expect(
				queue.drainContentRefGc({
					now: "2026-08-05T00:00:01.000Z",
					readFile: (path) => {
						contentRefReads += 1;
						expect(db.inTransaction).toBe(false);
						return readFileSync(path);
					},
				}),
			).toEqual({
				done: 1,
				pending: 0,
			});
			expect(contentRefReads).toBe(1);
			expect(existsSync(refPath)).toBe(false);
			expect(readFileSync(dbPath).length).toBeGreaterThan(0);
		} finally {
			queue.close();
			db.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("skips oversized families until the explicit maintenance path raises the cap", () => {
		const queue = new MailboxQueue(":memory:");
		try {
			queue.enqueue({
				id: "large",
				fromAgent: "lead-a",
				toAgent: "runner-a",
				recipientKind: "runner",
				type: "instruction",
				content: "x".repeat(2_100_000),
				createdAt: NOW,
				senderRef: SENDER_REF,
			});
			queue.ack("large", "2026-08-01T00:00:00.000Z");
			expect(
				queue.archiveDueFamilies({ now: "2026-08-05T00:00:00.000Z" }),
			).toMatchObject({ archivedFamilies: 0, skippedOversized: 1 });
			expect(
				queue.archiveFamily({
					id: "large",
					now: "2026-08-05T00:00:00.000Z",
					retentionMs: 72 * 60 * 60_000,
					maxFamilyBytes: Number.POSITIVE_INFINITY,
				}),
			).toBe("archived");
		} finally {
			queue.close();
		}
	});

	it("archives ten near-cap families in a bounded explicit batch", () => {
		const queue = new MailboxQueue(":memory:");
		try {
			for (let index = 0; index < 10; index += 1) {
				const id = `near-cap-${index}`;
				queue.enqueue({
					id,
					fromAgent: "lead-a",
					toAgent: "runner-a",
					recipientKind: "runner",
					type: "instruction",
					content: "x".repeat(1_800_000),
					createdAt: NOW,
					senderRef: SENDER_REF,
				});
				queue.ack(id, "2026-08-01T00:00:00.000Z");
			}

			const result = queue.archiveDueFamilies({
				now: "2026-08-05T00:00:00.000Z",
				maxFamilies: 10,
			});
			expect(result).toMatchObject({
				archivedFamilies: 10,
				archivedMessages: 10,
			});
		} finally {
			queue.close();
		}
	}, 20_000);

	it("keeps the row live when its content-ref cannot be captured", () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1572-missing-ref-"));
		const dbPath = join(dir, "comm.db");
		const queue = new MailboxQueue(dbPath);
		try {
			queue.enqueue({
				id: "missing-ref",
				fromAgent: "lead-a",
				toAgent: "runner-a",
				recipientKind: "runner",
				type: "instruction",
				content: "[content_ref]",
				contentRef: join(dir, "refs", "missing-ref.txt"),
				createdAt: NOW,
				senderRef: SENDER_REF,
			});
			queue.ack("missing-ref", "2026-08-01T00:00:00.000Z");
			expect(
				queue.archiveDueFamilies({ now: "2026-08-05T00:00:00.000Z" }),
			).toMatchObject({
				archivedFamilies: 0,
				skippedInvalidContentRef: 1,
			});
			expect(queue.getById("missing-ref")).toBeDefined();
		} finally {
			queue.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("retries GC failures and waits until shared live references are archived", () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1572-gc-retry-"));
		const dbPath = join(dir, "comm.db");
		const queue = new MailboxQueue(dbPath);
		try {
			const refPath = writeContentRef(dbPath, "shared", "shared body");
			for (const id of ["first", "second"]) {
				queue.enqueue({
					id,
					fromAgent: "lead-a",
					toAgent: "runner-a",
					recipientKind: "runner",
					type: "instruction",
					content: "[content_ref]",
					contentRef: refPath,
					createdAt: NOW,
					senderRef: SENDER_REF,
				});
			}
			queue.ack("first", "2026-08-01T00:00:00.000Z");
			expect(
				queue.archiveFamily({ id: "first", now: "2026-08-05T00:00:00.000Z" }),
			).toBe("archived");
			expect(
				queue.drainContentRefGc({ now: "2026-08-05T00:00:01.000Z" }),
			).toEqual({
				done: 0,
				pending: 1,
			});
			expect(existsSync(refPath)).toBe(true);

			queue.ack("second", "2026-08-01T00:00:00.000Z");
			expect(
				queue.archiveFamily({ id: "second", now: "2026-08-05T00:00:02.000Z" }),
			).toBe("archived");
			expect(
				queue.drainContentRefGc({
					now: "2026-08-05T00:00:02.000Z",
					removeFile: () => {
						throw new Error("permission denied");
					},
				}),
			).toEqual({ done: 0, pending: 2 });
			expect(
				queue.drainContentRefGc({ now: "2026-08-05T00:00:03.000Z" }),
			).toEqual({
				done: 1,
				pending: 0,
			});
			expect(existsSync(refPath)).toBe(false);
			expect(
				queue.drainContentRefGc({ now: "2026-08-05T00:00:04.000Z" }),
			).toEqual({
				done: 1,
				pending: 0,
			});
		} finally {
			queue.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("bounds automatic open-time maintenance to ten families", () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1572-open-sweep-"));
		const dbPath = join(dir, "comm.db");
		new CommDB(dbPath).close();
		const queue = new MailboxQueue(dbPath);
		try {
			for (let index = 0; index < 12; index++) {
				const id = `old-${index}`;
				queue.enqueue({
					id,
					fromAgent: "lead-a",
					toAgent: "runner-a",
					recipientKind: "runner",
					type: "instruction",
					content: id,
					createdAt: "2026-07-01T00:00:00.000Z",
					senderRef: SENDER_REF,
				});
				queue.ack(id, "2026-07-01T00:01:00.000Z");
			}
		} finally {
			queue.close();
		}
		const opened = new CommDB(dbPath);
		try {
			const raw = new Database(dbPath, { readonly: true });
			try {
				expect(
					(
						raw.prepare("SELECT COUNT(*) AS count FROM mailbox").get() as {
							count: number;
						}
					).count,
				).toBe(2);
			} finally {
				raw.close();
			}
		} finally {
			opened.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
