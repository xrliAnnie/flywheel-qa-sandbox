import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	type DeliverySecret,
	deriveLeadEventAckToken,
} from "../lead-event-delivery.js";
import { LegacyAckDrain } from "../legacy-ack-drain.js";

describe("FLY-1373 LegacyAckDrain", () => {
	let dir: string;
	let dbPath: string;
	let store: StateStore;
	const secret: DeliverySecret = {
		secretId: "secret-1",
		key: Buffer.from("01234567890123456789012345678901"),
	};

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "fly1373-ack-drain-"));
		dbPath = join(dir, "comm.db");
		new CommDB(dbPath).close();
		store = await StateStore.create(":memory:");
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function append(id: string): number {
		const seq = store.appendLeadEvent(
			"lead-1",
			id,
			"session_failed",
			JSON.stringify({
				event_type: "session_failed",
				execution_id: `exec-${id}`,
				issue_id: `issue-${id}`,
				project_name: "flywheel",
			}),
		);
		const internal = store as unknown as {
			db: { run(sql: string, params: unknown[]): void };
		};
		internal.db.run(
			`UPDATE lead_events SET ack_required = 1, ack_policy = 'explicit_receipt',
			 ack_protocol_version = 1, ack_owner_lead_id = 'lead-1' WHERE seq = ?`,
			[seq],
		);
		return seq;
	}

	it("applies valid in-flight receipts, then retires only the unresolved cohort", () => {
		const ackedSeq = append("acked");
		const retiredSeq = append("retired");
		const row = store.getLeadEventBySeq(ackedSeq)!;
		const db = new CommDB(dbPath);
		db.insertAckReceipt(
			"lead-1",
			ackedSeq,
			deriveLeadEventAckToken(secret, {
				eventSeq: ackedSeq,
				ackOwnerLeadId: row.ack_owner_lead_id!,
				ownerEpoch: row.ack_owner_epoch!,
			}),
		);
		db.close();

		const result = new LegacyAckDrain({
			store,
			commDbPaths: [dbPath],
			secretProvider: { getActive: () => secret },
			now: () => new Date("2026-07-19T20:00:00.000Z"),
		}).run();

		expect(result).toEqual({ receiptsConsumed: 1, autoAcked: 0, retired: 1 });
		expect(store.getLeadEventBySeq(ackedSeq)?.acked_at).toBeTruthy();
		expect(store.getLeadEventBySeq(ackedSeq)?.ack_retired_at).toBeUndefined();
		expect(store.getLeadEventBySeq(retiredSeq)).toMatchObject({
			ack_retired_reason: "fly1373_cutover",
		});
	});
});
