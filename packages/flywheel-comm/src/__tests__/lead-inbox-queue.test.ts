import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";
import {
	LeadInboxQueue,
	receiptPriorityWindowsMs,
} from "../lead-inbox-queue.js";

describe("FLY-1373 lead inbox queue", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1373-inbox-"));
		dbPath = join(dir, "comm.db");
		new CommDB(dbPath).close();
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("uses the four category-agnostic priority windows", () => {
		expect(
			receiptPriorityWindowsMs({
				FLYWHEEL_RECEIPT_WINDOW_P0_MIN: "1",
				FLYWHEEL_RECEIPT_WINDOW_P1_MIN: "2",
				FLYWHEEL_RECEIPT_WINDOW_P2_MIN: "3",
				FLYWHEEL_RECEIPT_WINDOW_P3_MIN: "4",
			}),
		).toEqual([60_000, 120_000, 180_000, 240_000]);
	});

	it("creates the durable queue, owner lease, and per-Lead heartbeat schema", () => {
		const raw = new Database(dbPath, { readonly: true });
		try {
			const tables = (
				raw
					.prepare(
						"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
					)
					.all() as Array<{ name: string }>
			).map(({ name }) => name);
			expect(tables).toEqual(
				expect.arrayContaining(["lead_inbox", "loop_owner", "loop_heartbeat"]),
			);
		} finally {
			raw.close();
		}
	});

	it("enqueues idempotently and preserves namespaced ids for two Leads", () => {
		const queue = new LeadInboxQueue(dbPath);
		try {
			const first = queue.enqueue({
				id: "lead_event:lead-a:shared-event",
				toLead: "lead-a",
				source: "bridge_event",
				type: "session_completed",
				msgClass: "model",
				priority: 2,
				content: "done A",
			});
			const duplicate = queue.enqueue({
				id: "lead_event:lead-a:shared-event",
				toLead: "lead-a",
				source: "bridge_event",
				type: "session_completed",
				msgClass: "model",
				priority: 2,
				content: "done A",
			});
			const otherLead = queue.enqueue({
				id: "lead_event:lead-b:shared-event",
				toLead: "lead-b",
				source: "bridge_event",
				type: "session_completed",
				msgClass: "model",
				priority: 2,
				content: "done B",
			});

			expect(duplicate.seq).toBe(first.seq);
			expect(otherLead.seq).not.toBe(first.seq);
			expect(queue.countPending()).toBe(2);
		} finally {
			queue.close();
		}
	});

	it("keeps external receipt rows out of every inbox queue surface", () => {
		const queue = new LeadInboxQueue(dbPath);
		try {
			queue.acquireOrRenewOwner({
				ownerEpoch: "epoch-a",
				now: "2026-07-21T12:00:00.000Z",
				leaseTtlMs: 10_000,
			});
			const external = queue.enqueue({
				id: "xdept:lead-a:discord-1",
				toLead: "lead-a",
				source: "discord",
				type: "cross_department_message",
				msgClass: "model",
				priority: 1,
				content: "hello from another department",
				carrier: "external",
			});

			expect(external.carrier).toBe("external");
			expect(external.consumed_at).toBeNull();
			expect(queue.countPending()).toBe(0);
			expect(
				queue.claimPending({
					toLead: "lead-a",
					ownerEpoch: "epoch-a",
					now: "2026-07-21T12:00:01.000Z",
					claimTtlMs: 5_000,
				}),
			).toEqual([]);
			expect(
				queue.claimProtocol({
					toLead: "lead-a",
					ownerEpoch: "epoch-a",
					now: "2026-07-21T12:00:01.000Z",
					claimTtlMs: 5_000,
				}),
			).toBeUndefined();
			expect(
				queue.claimModelBatch({
					toLead: "lead-a",
					ownerEpoch: "epoch-a",
					batchId: "batch-external",
					now: "2026-07-21T12:00:01.000Z",
					claimTtlMs: 5_000,
				}),
			).toEqual([]);
		} finally {
			queue.close();
		}
	});

	it("finishes an accepted external delivery without exposing it to the inbox carrier", () => {
		const queue = new LeadInboxQueue(dbPath);
		try {
			queue.enqueue({
				id: "xdept:lead-a:discord-accepted",
				toLead: "lead-a",
				source: "discord",
				type: "cross_department_message",
				msgClass: "model",
				priority: 1,
				content: "accepted",
				carrier: "external",
			});

			expect(
				queue.markExternalDelivered("xdept:lead-a:discord-accepted", {
					now: "2026-07-21T12:00:00.000Z",
					receiptWindowsMs: [1_800_000, 1_800_000, 14_400_000, 86_400_000],
				}),
			).toBe(true);
			expect(queue.getById("xdept:lead-a:discord-accepted")).toMatchObject({
				carrier: "external",
				delivered_at: "2026-07-21T12:00:00.000Z",
				consumed_at: "2026-07-21T12:00:00.000Z",
				disposition: "external_delivered",
				next_unprocessed_at: "2026-07-21T12:30:00.000Z",
			});
			expect(queue.countPending()).toBe(0);
		} finally {
			queue.close();
		}
	});

	it("replays external completion idempotently even when the retry timestamp changes", () => {
		const queue = new LeadInboxQueue(dbPath);
		try {
			queue.enqueue({
				id: "xdept:lead-a:discord-replay",
				toLead: "lead-a",
				source: "discord",
				type: "external_delivery",
				msgClass: "model",
				priority: 1,
				content: "replay",
				carrier: "external",
			});
			const windows = [1_800_000, 1_800_000, 14_400_000, 86_400_000] as const;
			expect(
				queue.markExternalDelivered("xdept:lead-a:discord-replay", {
					now: "2026-07-21T12:00:00.000Z",
					receiptWindowsMs: windows,
				}),
			).toBe(true);
			expect(
				queue.markExternalDelivered("xdept:lead-a:discord-replay", {
					now: "2026-07-21T12:05:00.000Z",
					receiptWindowsMs: windows,
				}),
			).toBe(true);
			expect(queue.getById("xdept:lead-a:discord-replay")?.delivered_at).toBe(
				"2026-07-21T12:00:00.000Z",
			);
		} finally {
			queue.close();
		}
	});

	it("reconciles external pending rows as aborted or quarantined without chasing them", () => {
		const queue = new LeadInboxQueue(dbPath);
		try {
			for (const id of ["xdept:lead-a:absent", "xdept:lead-a:unknown"]) {
				queue.enqueue({
					id,
					toLead: "lead-a",
					source: "discord",
					type: "external_delivery",
					msgClass: "model",
					priority: 1,
					content: id,
					carrier: "external",
					createdAt: "2026-07-21T11:00:00.000Z",
				});
			}
			expect(
				queue.listExternalDeliveryPending({
					before: "2026-07-21T12:00:00.000Z",
				}),
			).toHaveLength(2);
			expect(
				queue.markExternalAborted("xdept:lead-a:absent", {
					now: "2026-07-21T12:00:00.000Z",
					reason: "journal_absent_after_watermark",
				}),
			).toBe(true);
			expect(
				queue.quarantineExternalDelivery("xdept:lead-a:unknown", {
					now: "2026-07-21T12:00:00.000Z",
					reason: "journal_unavailable",
				}),
			).toBe(true);
			expect(queue.getById("xdept:lead-a:absent")).toMatchObject({
				disposition: "delivery_aborted",
				delivered_at: null,
				disposed_at: "2026-07-21T12:00:00.000Z",
			});
			expect(queue.getById("xdept:lead-a:unknown")).toMatchObject({
				delivered_at: null,
			});
			expect(
				queue.getReceiptAlertOutbox(
					"external_saga_unknown:xdept:lead-a:unknown",
				),
			).toMatchObject({ kind: "external_saga_unknown" });
			expect(queue.countPending()).toBe(0);
		} finally {
			queue.close();
		}
	});

	it("filters external pending rows by Lead, lane, terminal state, age, quarantine, and cursor in SQL", () => {
		const queue = new LeadInboxQueue(dbPath);
		try {
			const enqueue = (
				id: string,
				toLead = "lead-a",
				createdAt = "2026-07-21T10:00:00.000Z",
			) =>
				queue.enqueue({
					id,
					toLead,
					source: "discord_chat",
					type: "external_delivery",
					msgClass: "model",
					priority: 1,
					content: id,
					carrier: "external",
					createdAt,
				});
			const first = enqueue("chat:lead-a:1001");
			enqueue("xdept:lead-a:1002");
			enqueue("chat:lead-b:1003", "lead-b");
			enqueue("chat:lead-a:1004", "lead-a", "2026-07-21T13:00:00.000Z");
			enqueue("chat:lead-a:1005");
			enqueue("chat:lead-a:1006");
			queue.markProcessed("chat:lead-a:1005", {
				now: "2026-07-21T10:05:00.000Z",
				evidence: {
					v: 1,
					kind: "discord_explicit_reply",
					ref: "reply-1005",
					actor: "lead-a",
					actor_kind: "lead",
					fence: { chatReplyTo: "1005" },
				},
			});
			queue.quarantineExternalDelivery("chat:lead-a:1006", {
				now: "2026-07-21T11:00:00.000Z",
				reason: "chat_delivery_unconfirmed",
			});

			expect(
				queue
					.listExternalPendingForLane({
						toLead: "lead-a",
						idPrefix: "chat:lead-a:",
						createdBefore: "2026-07-21T12:00:00.000Z",
						excludeQuarantined: true,
						cursorSeq: 0,
						limit: 20,
					})
					.map((row) => row.id),
			).toEqual(["chat:lead-a:1001"]);
			expect(
				queue
					.listExternalPendingForLane({
						toLead: "lead-a",
						idPrefix: "chat:lead-a:",
						cursorSeq: first.seq,
						limit: 20,
					})
					.map((row) => row.id),
			).toEqual(["chat:lead-a:1004", "chat:lead-a:1006"]);
		} finally {
			queue.close();
		}
	});

	it("claims by priority then FIFO and only the owning epoch can consume", () => {
		const queue = new LeadInboxQueue(dbPath);
		try {
			expect(
				queue.acquireOrRenewOwner({
					ownerEpoch: "epoch-a",
					now: "2026-07-19T12:00:00.000Z",
					leaseTtlMs: 5_000,
				}),
			).toBe(true);
			for (const [id, priority] of [
				["telemetry-1", 3],
				["founder-1", 0],
				["question-1", 1],
				["question-2", 1],
				["report-1", 2],
			] as const) {
				queue.enqueue({
					id,
					toLead: "lead-a",
					source: "test",
					type: "regular",
					msgClass: "model",
					priority,
					content: id,
				});
			}

			const rows = queue.claimPending({
				toLead: "lead-a",
				ownerEpoch: "epoch-a",
				now: "2026-07-19T12:00:00.000Z",
				claimTtlMs: 5_000,
			});
			expect(rows.map(({ id }) => id)).toEqual([
				"founder-1",
				"question-1",
				"question-2",
				"report-1",
				"telemetry-1",
			]);
			expect(
				queue.markConsumed(["founder-1"], {
					ownerEpoch: "wrong-epoch",
					disposition: "delivered",
					now: "2026-07-19T12:00:01.000Z",
				}),
			).toBe(0);
			expect(
				queue.markConsumed(["founder-1"], {
					ownerEpoch: "epoch-a",
					disposition: "delivered",
					now: "2026-07-19T12:00:01.000Z",
				}),
			).toBe(1);
			expect(queue.countPending("lead-a")).toBe(4);
		} finally {
			queue.close();
		}
	});

	it("fences a stale owner after lease takeover", () => {
		const first = new LeadInboxQueue(dbPath);
		const second = new LeadInboxQueue(dbPath);
		try {
			expect(
				first.acquireOrRenewOwner({
					ownerEpoch: "epoch-a",
					now: "2026-07-19T12:00:00.000Z",
					leaseTtlMs: 1_000,
				}),
			).toBe(true);
			expect(
				second.acquireOrRenewOwner({
					ownerEpoch: "epoch-b",
					now: "2026-07-19T12:00:00.500Z",
					leaseTtlMs: 1_000,
				}),
			).toBe(false);
			expect(
				second.acquireOrRenewOwner({
					ownerEpoch: "epoch-b",
					now: "2026-07-19T12:00:01.001Z",
					leaseTtlMs: 2_000,
				}),
			).toBe(true);
			expect(first.isCurrentOwner("epoch-a", "2026-07-19T12:00:01.001Z")).toBe(
				false,
			);
			expect(second.isCurrentOwner("epoch-b", "2026-07-19T12:00:01.001Z")).toBe(
				true,
			);
		} finally {
			first.close();
			second.close();
		}
	});

	it("freezes a model batch so arrivals during delivery wait for the next batch", () => {
		const queue = new LeadInboxQueue(dbPath);
		try {
			queue.acquireOrRenewOwner({
				ownerEpoch: "epoch-a",
				now: "2026-07-19T12:00:00.000Z",
				leaseTtlMs: 10_000,
			});
			for (const id of ["A", "B"]) {
				queue.enqueue({
					id,
					toLead: "lead-a",
					source: "test",
					type: "regular",
					msgClass: "model",
					priority: 1,
					content: id,
				});
			}
			const first = queue.claimModelBatch({
				toLead: "lead-a",
				ownerEpoch: "epoch-a",
				batchId: "batch-ab",
				now: "2026-07-19T12:00:01.000Z",
				claimTtlMs: 2_000,
			});
			expect(first.map(({ id }) => id)).toEqual(["A", "B"]);
			queue.enqueue({
				id: "C",
				toLead: "lead-a",
				source: "test",
				type: "regular",
				msgClass: "model",
				priority: 0,
				content: "C",
			});
			queue.recordFailure(["A", "B"], {
				ownerEpoch: "epoch-a",
				error: "receipt lost",
				now: "2026-07-19T12:00:01.500Z",
			});
			const retry = queue.claimModelBatch({
				toLead: "lead-a",
				ownerEpoch: "epoch-a",
				batchId: "ignored-new-id",
				now: "2026-07-19T12:00:01.600Z",
				claimTtlMs: 2_000,
			});
			expect(retry.map(({ id }) => id)).toEqual(["A", "B"]);
			expect(new Set(retry.map(({ batch_id }) => batch_id))).toEqual(
				new Set(["batch-ab"]),
			);
			expect(
				queue.markConsumed(["A", "B"], {
					ownerEpoch: "epoch-a",
					disposition: "delivered",
					now: "2026-07-19T12:00:02.000Z",
				}),
			).toBe(2);
			const next = queue.claimModelBatch({
				toLead: "lead-a",
				ownerEpoch: "epoch-a",
				batchId: "batch-c",
				now: "2026-07-19T12:00:02.100Z",
				claimTtlMs: 2_000,
			});
			expect(next.map(({ id }) => id)).toEqual(["C"]);
		} finally {
			queue.close();
		}
	});

	it("records per-Lead started/success heartbeat independently", () => {
		const queue = new LeadInboxQueue(dbPath);
		try {
			queue.recordTickStarted("lead-a", "2026-07-19T12:00:00.000Z");
			queue.recordTickStarted("lead-b", "2026-07-19T12:00:01.000Z");
			queue.recordTickSuccess("lead-a", "2026-07-19T12:00:02.000Z");
			expect(queue.getHeartbeat("lead-a")).toMatchObject({
				last_started_at: "2026-07-19T12:00:00.000Z",
				last_success_at: "2026-07-19T12:00:02.000Z",
			});
			expect(queue.getHeartbeat("lead-b")).toMatchObject({
				last_started_at: "2026-07-19T12:00:01.000Z",
				last_success_at: null,
			});
		} finally {
			queue.close();
		}
	});

	it("stores a strict UTC deadline on both source messages and queue rows", () => {
		const deadline = "2026-07-20T08:30:00.000Z";
		const comm = new CommDB(dbPath);
		const questionId = comm.insertQuestion("runner", "lead-a", "urgent", {
			deadlineAt: deadline,
		});
		expect(comm.getMessageById(questionId)?.deadline_at).toBe(deadline);
		expect(() =>
			comm.insertQuestion("runner", "lead-a", "bad", {
				deadlineAt: "2026-07-20 08:30:00",
			}),
		).toThrow(/UTC ISO/i);
		comm.close();

		const queue = new LeadInboxQueue(dbPath);
		try {
			const row = queue.enqueue({
				id: `question:lead-a:${questionId}`,
				toLead: "lead-a",
				source: "cli_question",
				type: "runner_question",
				msgClass: "model",
				priority: 1,
				content: "urgent",
				refMessageId: questionId,
				deadlineAt: deadline,
			});
			expect(row.deadline_at).toBe(deadline);
		} finally {
			queue.close();
		}
	});
});
