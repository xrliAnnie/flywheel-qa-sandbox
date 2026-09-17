import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { afterEach, expect, it } from "vitest";
import {
	enqueueXhsNotification,
	XhsNotificationPoller,
} from "../xhs-notification-poller.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const close of cleanup.splice(0).reverse()) close();
});
function setup() {
	const dir = mkdtempSync("/tmp/xhs-mailbox-");
	const path = join(dir, "comm.db");
	let queue = new MailboxQueue(path);
	cleanup.push(() => {
		queue.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const scope = { projectId: "project-a", leadId: "lead-a" };
	const receiptId = randomUUID();
	const notice = {
		eventId: `xhs-approved:${receiptId}`,
		eventKind: "approved",
		receiptId,
		proposalId: randomUUID(),
		contentDigest: "a".repeat(64),
		expiry: Date.now() + 60000,
	};
	return {
		scope,
		notice,
		get queue() {
			return queue;
		},
		reopen() {
			queue.close();
			queue = new MailboxQueue(path);
		},
	};
}
it("queues before ACK and reuses one durable letter after an ACK loss and Bridge restart", async () => {
	const s = setup();
	let ackFails = true,
		acked = false,
		deliveryId = "";
	const client = {
		async call(action: string) {
			if (action === "notifications")
				return { events: acked ? [] : [s.notice] };
			expect(s.queue.getById(deliveryId)?.to_agent).toBe(s.scope.leadId);
			if (ackFails) throw Error("lost ACK");
			acked = true;
			return { acknowledged: true };
		},
	};
	const poller = () =>
		new XhsNotificationPoller({
			scope: s.scope,
			client,
			enqueue: (scope, notice) => {
				const result = enqueueXhsNotification(s.queue, scope, notice);
				deliveryId = result.deliveryId;
				return result;
			},
		});
	await poller().poll();
	const before = s.queue.getById(deliveryId)!;
	expect(before.msg_class).toBe("model");
	expect(before.content).toContain("不是写许可");
	expect(acked).toBe(false);
	s.reopen();
	ackFails = false;
	await poller().poll();
	expect(acked).toBe(true);
	expect(s.queue.getById(deliveryId)?.seq).toBe(before.seq);
	expect(s.queue.getById(deliveryId)?.content).toBe(before.content);
});
it("never ACKs on queue failure, cancellation or malformed authority output", async () => {
	const s = setup();
	let acks = 0,
		enqueues = 0;
	let events: unknown[] = [s.notice];
	const controller = new AbortController();
	const poller = new XhsNotificationPoller({
		scope: s.scope,
		client: {
			async call(action) {
				if (action === "notifications") return { events };
				acks++;
				return { acknowledged: true };
			},
		},
		enqueue: () => {
			enqueues++;
			throw Error("disk unavailable");
		},
	});
	await poller.poll();
	expect(enqueues).toBe(1);
	expect(acks).toBe(0);
	events = [{ ...s.notice, xsec_token: "private" }];
	await poller.poll();
	expect(enqueues).toBe(1);
	expect(acks).toBe(0);
	controller.abort();
	await poller.poll(controller.signal);
	expect(enqueues).toBe(1);
	expect(acks).toBe(0);
});
it("isolates identities across scopes and rejects changed content for an existing event", () => {
	const s = setup();
	const a = enqueueXhsNotification(s.queue, s.scope, s.notice);
	const b = enqueueXhsNotification(
		s.queue,
		{ ...s.scope, leadId: "lead-b" },
		s.notice,
	);
	expect(a.deliveryId).not.toBe(b.deliveryId);
	expect(() =>
		enqueueXhsNotification(s.queue, s.scope, {
			...s.notice,
			contentDigest: "b".repeat(64),
		}),
	).toThrow();
	expect(s.queue.getById(a.deliveryId)?.content).toContain(
		s.notice.contentDigest,
	);
});

it("coalesces overlapping polls and drops a response after cancellation", async () => {
	const s = setup();
	let resolve!: (value: unknown) => void;
	let reads = 0,
		enqueues = 0;
	const response = new Promise<unknown>((done) => {
		resolve = done;
	});
	const controller = new AbortController();
	const poller = new XhsNotificationPoller({
		scope: s.scope,
		client: {
			async call(action) {
				expect(action).toBe("notifications");
				reads++;
				return response;
			},
		},
		enqueue: () => {
			enqueues++;
			return { queued: true, deliveryId: "unexpected" };
		},
	});
	const first = poller.poll(controller.signal);
	await poller.poll();
	expect(reads).toBe(1);
	controller.abort();
	resolve({ events: [s.notice] });
	await first;
	expect(enqueues).toBe(0);
});
