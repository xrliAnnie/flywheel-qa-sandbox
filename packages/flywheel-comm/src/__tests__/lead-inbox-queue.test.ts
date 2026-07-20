import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";
import { LeadInboxQueue } from "../lead-inbox-queue.js";

describe("FLY-1373 lead inbox queue", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1373-inbox-"));
		dbPath = join(dir, "comm.db");
		new CommDB(dbPath).close();
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

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
