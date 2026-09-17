import { createHash } from "node:crypto";
import type { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { encodeSenderRef } from "flywheel-comm/sender-ref";
import { z } from "zod";
import { notificationResponses } from "../xiaohongshu-write/notification-contract.js";

const scopeSchema = z
	.object({
		projectId: z.string().min(1).max(256),
		leadId: z.string().min(1).max(256),
	})
	.strict();
type Scope = z.infer<typeof scopeSchema>;
type Notice = z.infer<
	typeof notificationResponses.notifications
>["events"][number];
type QueueReceipt = { queued: true; deliveryId: string };

/** Uses the existing mailbox identity/tombstone machinery; never stores an
 * authorization receipt in Bridge or reads the private authority database. */
export function enqueueXhsNotification(
	queue: Pick<
		MailboxQueue,
		"enqueue" | "getById" | "inspectDeliveryState" | "inspectDeliveryContent"
	>,
	inputScope: Scope,
	inputNotice: unknown,
): QueueReceipt {
	const scope = scopeSchema.parse(inputScope);
	const notice = notificationResponses.notifications.parse({
		events: [inputNotice],
	}).events[0]!;
	const id = `xhs-notice:${createHash("sha256")
		.update(JSON.stringify([scope.projectId, scope.leadId, notice.eventId]))
		.digest("hex")}`;
	const content =
		"[小红书通知] 这是状态通知，不是写许可。请先查询 proposal 的当前状态；只有 authority 仍确认有效批准时，才能请求一次 execute。过期、撤回或结果未知时不得自动重发。\n" +
		JSON.stringify({ projectId: scope.projectId, ...notice });
	const existing = queue.getById(id);
	if (
		!existing &&
		queue.inspectDeliveryState(id).kind === "archived_terminal"
	) {
		const archivedContent = queue.inspectDeliveryContent(id);
		if (archivedContent !== undefined && archivedContent !== content)
			throw Error("notification_identity_conflict");
		return { queued: true, deliveryId: id };
	}
	queue.enqueue({
		id,
		deliveryId: id,
		fromAgent: "bridge",
		toAgent: scope.leadId,
		recipientKind: "lead",
		sourceKind: "xiaohongshu_notification",
		sourceRef: notice.eventId,
		type: "xiaohongshu_notification",
		msgClass: "model",
		priority: 1,
		content,
		createdAt: existing?.created_at,
		senderRef: encodeSenderRef(),
	});
	return { queued: true, deliveryId: id };
}

/** Bridge cadence calls poll every five seconds. A queue failure leaves the
 * authority outbox pending; a lost ACK replays the same durable mailbox ID.
 * This worker has no prepare/execute or provider capability. */
export class XhsNotificationPoller {
	private busy = false;
	private readonly scope: Scope;
	constructor(
		private readonly options: {
			scope: Scope;
			client: {
				call(
					action: "notifications" | "notification_ack",
					input: unknown,
					signal?: AbortSignal,
				): Promise<unknown>;
			};
			enqueue(scope: Scope, notice: Notice): QueueReceipt;
		},
	) {
		this.scope = scopeSchema.parse(options.scope);
	}
	async poll(signal?: AbortSignal): Promise<void> {
		if (this.busy || signal?.aborted) return;
		this.busy = true;
		try {
			const batch = notificationResponses.notifications.parse(
				await this.options.client.call("notifications", {}, signal),
			);
			signal?.throwIfAborted();
			for (const notice of batch.events) {
				signal?.throwIfAborted();
				const receipt = this.options.enqueue(
					{ ...this.scope },
					structuredClone(notice),
				);
				if (receipt.queued !== true || !receipt.deliveryId)
					throw Error("notification_queue_unavailable");
				signal?.throwIfAborted();
				notificationResponses.notification_ack.parse(
					await this.options.client.call(
						"notification_ack",
						{ eventId: notice.eventId },
						signal,
					),
				);
				signal?.throwIfAborted();
			}
		} catch {
			// Only the notification is retried. Private transport failures are not logged.
		} finally {
			this.busy = false;
		}
	}
}
