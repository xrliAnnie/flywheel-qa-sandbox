import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MailboxQueue } from "../mailbox-queue.js";
import { encodeSenderRef } from "../sender-ref.js";

function enqueue(queue: MailboxQueue, id: string): void {
	queue.enqueue({
		id,
		deliveryId: `delivery:${id}`,
		fromAgent: "bridge",
		toAgent: "lead-a",
		recipientKind: "lead",
		type: "patrol_tick",
		content: "tick",
		createdAt: "2026-08-01T00:00:00.000Z",
		senderRef: encodeSenderRef(),
	});
}

describe("FLY-1687 MailboxQueue settlement reader", () => {
	it("distinguishes absent identity from every live state", () => {
		const queue = new MailboxQueue(":memory:");
		try {
			expect(queue.inspectDeliveryState("missing")).toEqual({
				kind: "absent_identity",
			});
			enqueue(queue, "tick-1");
			expect(queue.inspectDeliveryState("delivery:tick-1")).toMatchObject({
				kind: "live",
				state: "QUEUED",
				deadReason: null,
				lastError: null,
				createdAt: "2026-08-01T00:00:00.000Z",
				deliveredAt: null,
				notifiedAt: null,
			});
			queue.ack("tick-1", "2026-08-01T01:00:00.000Z");
			expect(queue.inspectDeliveryState("tick-1")).toEqual({
				kind: "live",
				state: "ACKED",
				settledAt: "2026-08-01T01:00:00.000Z",
				deadReason: null,
				lastError: null,
				createdAt: "2026-08-01T00:00:00.000Z",
				deliveredAt: "2026-08-01T01:00:00.000Z",
				notifiedAt: null,
			});
		} finally {
			queue.close();
		}
	});

	it("restores terminal ACKED and DEAD settlement after live-row archival", () => {
		const root = mkdtempSync(join(tmpdir(), "fly1687-settlement-"));
		const dbPath = join(root, "comm.db");
		let queue = new MailboxQueue(dbPath);
		try {
			enqueue(queue, "acked");
			queue.ack("acked", "2026-08-01T00:00:00.000Z");
			enqueue(queue, "dead");
			queue.markDead("dead", "2026-08-01T02:00:00.000Z", "test");
			expect(
				queue.archiveDueFamilies({ now: "2026-08-05T00:00:00.000Z" }),
			).toMatchObject({ archivedMessages: 2 });
			queue.close();
			queue = new MailboxQueue(dbPath);

			expect(queue.inspectDeliveryState("delivery:acked")).toEqual({
				kind: "archived_terminal",
				state: "ACKED",
				settledAt: "2026-08-01T00:00:00.000Z",
				deadReason: null,
				lastError: null,
				createdAt: "2026-08-01T00:00:00.000Z",
				deliveredAt: "2026-08-01T00:00:00.000Z",
				notifiedAt: null,
			});
			expect(queue.inspectDeliveryState("dead")).toEqual({
				kind: "archived_terminal",
				state: "DEAD",
				settledAt: "2026-08-01T02:00:00.000Z",
				deadReason: "test",
				lastError: "test",
				createdAt: "2026-08-01T00:00:00.000Z",
				deliveredAt: null,
				notifiedAt: null,
			});
		} finally {
			queue.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
