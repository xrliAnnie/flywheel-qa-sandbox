import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";
import {
	CHAT_DELIVERY_UNCONFIRMED_REASON,
	MailboxQueue,
} from "../mailbox-queue.js";
import { encodeSenderRef } from "../sender-ref.js";

const NOW = "2099-08-06T00:00:00.000Z";
const LEAD = "external-delivery-lead";
const paths: string[] = [];

afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { force: true });
});

function freshDb(name: string): string {
	const path = `${process.env.TMPDIR ?? "/tmp"}/external-delivery-${name}-${process.pid}-${Math.random().toString(36).slice(2)}.db`;
	paths.push(path, `${path}-wal`, `${path}-shm`);
	new CommDB(path, true).close();
	return path;
}

function enqueueExternal(queue: MailboxQueue, id: string): void {
	queue.enqueue({
		id,
		fromAgent: "founder",
		toAgent: LEAD,
		recipientKind: "lead",
		sourceKind: "discord_chat",
		sourceRef: id,
		type: "external_delivery",
		msgClass: "model",
		priority: 0,
		content: "raw",
		createdAt: NOW,
		carrier: "external",
		senderRef: encodeSenderRef(),
	});
}

function pendingIds(queue: MailboxQueue): string[] {
	return queue
		.listExternalPending({ toAgent: LEAD, idPrefix: "chat:" })
		.map((row) => row.id);
}

describe("external delivery pending truth table", () => {
	it("lists only external rows that have not reached ACKED", () => {
		const queue = new MailboxQueue(freshDb("states"));
		try {
			for (const suffix of ["queued", "delivered", "dead"]) {
				enqueueExternal(queue, `chat:${LEAD}:${suffix}`);
			}
			queue.markExternalDelivered(`chat:${LEAD}:delivered`, NOW);
			queue.markDead(
				`chat:${LEAD}:dead`,
				NOW,
				CHAT_DELIVERY_UNCONFIRMED_REASON,
			);
			expect(pendingIds(queue)).toEqual([
				`chat:${LEAD}:queued`,
				`chat:${LEAD}:dead`,
			]);
		} finally {
			queue.close();
		}
	});

	it("allows callers to exclude both quarantine spellings", () => {
		const queue = new MailboxQueue(freshDb("quarantine"));
		try {
			for (const [suffix, reason] of [
				["current", CHAT_DELIVERY_UNCONFIRMED_REASON],
				["legacy", "delivery_quarantined"],
			] as const) {
				enqueueExternal(queue, `chat:${LEAD}:${suffix}`);
				queue.markDead(`chat:${LEAD}:${suffix}`, NOW, reason);
			}
			expect(pendingIds(queue)).toHaveLength(2);
			expect(
				queue.listExternalPending({
					toAgent: LEAD,
					idPrefix: "chat:",
					excludeQuarantined: true,
				}),
			).toEqual([]);
		} finally {
			queue.close();
		}
	});
});
