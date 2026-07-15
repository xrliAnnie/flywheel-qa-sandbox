import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../../db.js";
import { ackEvent } from "../ack-event.js";

describe("ackEvent", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1279-ack-event-"));
		dbPath = join(dir, "comm.db");
		new CommDB(dbPath).close();
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("writes a backend-neutral receipt addressed to the Bridge", () => {
		const receiptId = ackEvent({
			dbPath,
			eventSeq: 17,
			ackToken: "stdin-bearer",
			leadId: "lead-1",
		});
		const db = new CommDB(dbPath);
		try {
			expect(db.getPendingAckReceipts()).toMatchObject([
				{
					id: receiptId,
					from_agent: "lead-1",
					content: JSON.stringify({
						event_seq: 17,
						ack_token: "stdin-bearer",
					}),
				},
			]);
		} finally {
			db.close();
		}
	});

	it("rejects empty token input", () => {
		expect(() =>
			ackEvent({ dbPath, eventSeq: 17, ackToken: "", leadId: "lead-1" }),
		).toThrow(/token/i);
	});
});
