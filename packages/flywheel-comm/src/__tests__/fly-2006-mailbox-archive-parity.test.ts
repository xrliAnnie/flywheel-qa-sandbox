import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { archiveMailboxFamily } from "../../../../scripts/lib/fly-2006-mailbox-archive.mjs";
import { MailboxQueue } from "../mailbox-queue.js";
import { MAILBOX_SCHEMA } from "../mailbox-schema.js";
import { encodeSenderRef } from "../sender-ref.js";

const CREATED_AT = "2026-08-22T00:00:00.000Z";
const ACKED_AT = "2026-08-23T07:03:57.749Z";
const NOW = "2026-08-23T14:40:00.000Z";

function prepare(db: Database.Database, contentRef: string) {
	db.exec(MAILBOX_SCHEMA);
	const queue = new MailboxQueue(db);
	queue.enqueue({
		id: "hl-orphan",
		fromAgent: "voice-honeylemon-fly1911",
		toAgent: "flywheel-product-lead",
		recipientKind: "lead",
		type: "question",
		kind: "report",
		content: "payload",
		contentRef,
		contentType: "text/plain",
		createdAt: CREATED_AT,
		relayState: "terminal_disposed",
		senderRef: encodeSenderRef(),
	});
	queue.ack("hl-orphan", ACKED_AT);
	return queue;
}

function archiveState(db: Database.Database) {
	return {
		mailbox: db.prepare("SELECT * FROM mailbox ORDER BY seq").all(),
		log: db
			.prepare(
				"SELECT event_id,message_id,subject_id,event,at,row_json FROM mailbox_log ORDER BY log_seq",
			)
			.all(),
		identity: db
			.prepare(
				"SELECT id,delivery_id,insert_projection_hash,archived_at FROM mailbox_identity ORDER BY id",
			)
			.all(),
		gc: db
			.prepare(
				"SELECT intent_id,message_id,path,content_hash,state,attempts,next_retry_at,last_error,created_at,finished_at FROM content_ref_gc_outbox ORDER BY intent_id",
			)
			.all(),
	};
}

describe("FLY-2006 mailbox archive replica", () => {
	it("matches MailboxQueue.archiveFamily for every durable archive projection", () => {
		const root = mkdtempSync(join(tmpdir(), "fly2006-archive-parity-"));
		const refs = join(root, "refs");
		mkdirSync(refs);
		const contentRef = join(refs, "hl-orphan.txt");
		writeFileSync(contentRef, "external payload");
		const runtimeDb = new Database(":memory:");
		const replicaDb = new Database(":memory:");
		const runtime = prepare(runtimeDb, contentRef);
		const replica = prepare(replicaDb, contentRef);
		try {
			expect(
				runtime.archiveFamily({ id: "hl-orphan", now: NOW, retentionMs: 0 }),
			).toBe("archived");
			expect(
				archiveMailboxFamily({
					db: replicaDb,
					id: "hl-orphan",
					now: NOW,
					retentionMs: 0,
				}),
			).toBe("archived");
			expect(archiveState(replicaDb)).toEqual(archiveState(runtimeDb));
			expect(
				archiveMailboxFamily({
					db: replicaDb,
					id: "hl-orphan",
					now: NOW,
					retentionMs: 0,
				}),
			).toBe("idempotent");
		} finally {
			runtime.close();
			replica.close();
			runtimeDb.close();
			replicaDb.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("needs the explicit zero retention override for the recent HL family", () => {
		const runtimeDb = new Database(":memory:");
		const replicaDb = new Database(":memory:");
		const runtime = prepare(runtimeDb, "");
		const replica = prepare(replicaDb, "");
		try {
			expect(
				runtime.archiveFamily({
					id: "hl-orphan",
					now: NOW,
					retentionMs: 72 * 60 * 60_000,
				}),
			).toBe("not_due");
			expect(
				archiveMailboxFamily({
					db: replicaDb,
					id: "hl-orphan",
					now: NOW,
					retentionMs: 72 * 60 * 60_000,
				}),
			).toBe("not_due");
		} finally {
			runtime.close();
			replica.close();
			runtimeDb.close();
			replicaDb.close();
		}
	});
});
