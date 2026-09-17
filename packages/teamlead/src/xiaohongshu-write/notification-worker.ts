import type { WriteNotification, XhsWriteStore } from "./store.js";

export interface FounderNotificationTransport {
	notify(eventId: string, content: string): Promise<void>;
}
function notificationText(notice: WriteNotification): string {
	const expiry = new Date(notice.expiry).toISOString();
	const messages: Record<string, string> = {
		approved: `已批准，截止 ${expiry}。本回执仅允许一次尝试。`,
		rejected: "已拒绝，未发送。",
		revoked: "已撤回，未发送。",
		expired: "已过期，未发送，需要新卡。",
		delivery_delayed: "检查时组长尚未接到，尚未发送；批准截止时间不变。",
	};
	const message = messages[notice.eventKind];
	if (!message) throw Error("notification_invalid");
	return `[XHS] ${message}\nProposal: ${notice.proposalId}\nDigest: ${notice.contentDigest}\nEvent: ${notice.eventId}`;
}
/** Notification retries have no provider or execution capability. Lifecycle calls poll every 5s. */
export class XhsNotificationWorker {
	private busy = false;
	constructor(
		private readonly store: XhsWriteStore,
		private readonly transport: FounderNotificationTransport,
		private readonly clock: () => number = Date.now,
	) {}
	async poll(signal?: AbortSignal): Promise<void> {
		if (this.busy || signal?.aborted) return;
		this.busy = true;
		try {
			this.store.expireProposals(this.clock());
			this.store.flagDelayedNotifications(this.clock());
			const batch = this.store.pendingFounderNotifications();
			for (const notice of batch) {
				if (signal?.aborted) break;
				// Earlier asynchronous sends may have crossed expiry or a cancellation.
				this.store.expireProposals(this.clock());
				if (
					!this.store
						.pendingFounderNotifications()
						.some((current) => current.eventId === notice.eventId)
				)
					continue;
				let delivered = false;
				try {
					await this.transport.notify(notice.eventId, notificationText(notice));
					delivered = true;
				} catch {
					/* A later poll retries this notice only. */
				}
				this.store.recordFounderNotificationAttempt(notice.eventId, delivered);
			}
		} finally {
			this.busy = false;
		}
	}
}
