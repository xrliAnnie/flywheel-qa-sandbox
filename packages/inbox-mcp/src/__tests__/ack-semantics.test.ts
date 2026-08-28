import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleBatchAck, handleEventAck } from "../delivery.js";

describe("inbox-mcp durable acknowledgements", () => {
	let testDir: string;
	let db: CommDB;
	const leadId = "test-lead";

	beforeEach(() => {
		testDir = join(tmpdir(), `inbox-mcp-ack-${Date.now()}-${Math.random()}`);
		mkdirSync(testDir, { recursive: true });
		db = new CommDB(join(testDir, "comm.db"));
	});

	afterEach(() => {
		db.close();
		rmSync(testDir, { recursive: true, force: true });
	});

	it("event ack writes a backend-neutral receipt without returning the bearer", () => {
		const result = handleEventAck(db, {
			leadId,
			eventSeq: 42,
			ackToken: "mcp-bearer-secret",
			project: "flywheel",
			expectedProject: "flywheel",
		});

		expect(result).toEqual({ ok: true, eventSeq: 42 });
		expect(JSON.stringify(result)).not.toContain("mcp-bearer-secret");
		expect(db.getPendingAckReceipts()).toMatchObject([
			{
				from_agent: leadId,
				to_agent: "bridge",
				type: "ack_receipt",
				content: JSON.stringify({
					event_seq: 42,
					ack_token: "mcp-bearer-secret",
				}),
			},
		]);
	});

	it("event ack rejects a project mismatch before writing a receipt", () => {
		expect(
			handleEventAck(db, {
				leadId,
				eventSeq: 42,
				ackToken: "wrong-project-bearer",
				project: "another-project",
				expectedProject: "flywheel",
			}),
		).toMatchObject({ ok: false });
		expect(db.getPendingAckReceipts()).toEqual([]);
	});

	it("batch ack writes the backend-neutral protocol row for the calling Lead", () => {
		const result = handleBatchAck(db, {
			leadId,
			batchId: "mailbox-batch:durable-1",
		});

		expect(result).toEqual({ ok: true, batchId: "mailbox-batch:durable-1" });
		const row = (db as any).db
			.prepare("SELECT * FROM mailbox WHERE type = 'ack_batch'")
			.get() as Record<string, unknown>;
		expect(row).toMatchObject({
			from_agent: leadId,
			to_agent: "bridge",
			recipient_kind: "bridge",
			msg_class: "protocol",
			content: JSON.stringify({ batch_id: "mailbox-batch:durable-1" }),
		});
	});

	it("batch ack rejects an empty id without writing", () => {
		expect(handleBatchAck(db, { leadId, batchId: "  " })).toMatchObject({
			ok: false,
		});
		const count = (db as any).db
			.prepare("SELECT COUNT(*) AS count FROM mailbox WHERE type = 'ack_batch'")
			.get() as { count: number };
		expect(count.count).toBe(0);
	});
});
