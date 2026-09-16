import { type releaseCard, releaseMessageDigest } from "./cards.js";
import type { ReleaseDiscordClient } from "./discord.js";
import { customerNoticeFields } from "./notice.js";
import type { CustomerReleaseStore } from "./store.js";
import type { CustomerDeliveryReceipt, CustomerNoticeIntent } from "./types.js";

interface Options {
	store: CustomerReleaseStore;
	transport: Pick<
		ReleaseDiscordClient,
		"send" | "findMessage" | "verifyMessage"
	>;
	now: () => number;
}
/** One durable intent owns one POST. Restarts/ambiguous responses only scan and
 * verify; no rendering, reporting or probing operation may create another card. */
export class CustomerReleaseNoticeDelivery {
	constructor(private readonly options: Options) {}
	private invalidate(cycleId: string, reason: string) {
		const cycle = this.options.store.get(cycleId);
		if (cycle)
			this.options.store.invalidate(
				cycleId,
				cycle.revision,
				reason,
				this.options.now(),
			);
	}
	async deliver(
		cycleId: string,
		card: ReturnType<typeof releaseCard>,
		signal?: AbortSignal,
	): Promise<CustomerDeliveryReceipt | null> {
		const store = this.options.store,
			cycle = store.get(cycleId),
			notice = store.notice(cycleId);
		if (!cycle || !notice || cycle.state !== "notice_pending") return null;
		if (this.options.now() < notice.noticeAt) return null;
		try {
			if (releaseMessageDigest(card) !== notice.messageDigest)
				throw new Error("frozen card mismatch");
			signal?.throwIfAborted();
			let messageId: string | null = null;
			if (store.startNotice(cycleId, this.options.now())) {
				try {
					messageId = await this.options.transport.send(
						card,
						notice.noticeId,
						signal,
					);
				} catch {
					store.markNoticeUncertain(cycleId);
				}
			}
			const current = store.get(cycleId),
				sending = store.notice(cycleId);
			if (
				!current ||
				current.state !== "notice_pending" ||
				!sending ||
				!["sending", "uncertain"].includes(sending.sendState)
			)
				return null;
			if (!messageId)
				messageId = await this.options.transport.findMessage(
					notice.noticeId,
					notice.noticeAt,
					signal,
				);
			if (!messageId) throw new Error("notice delivery unproven");
			const receipt = await this.readback(cycleId, messageId, signal);
			signal?.throwIfAborted();
			return store.openWindow(cycleId, receipt, this.options.now())
				? receipt
				: null;
		} catch {
			this.invalidate(cycleId, "notice_delivery_unproven");
			return null;
		}
	}
	private async readback(
		cycleId: string,
		messageId: string,
		signal?: AbortSignal,
	): Promise<CustomerDeliveryReceipt> {
		const notice = this.options.store.notice(cycleId);
		if (!notice) throw new Error("notice unavailable");
		const proof = await this.options.transport.verifyMessage(
			messageId,
			notice.messageDigest,
			signal,
		);
		const now = this.options.now();
		if (
			!proof ||
			proof.messageId !== messageId ||
			proof.accessVerified !== true ||
			proof.gatewayHealthy !== true ||
			!Number.isSafeInteger(proof.verifiedAt) ||
			proof.verifiedAt > now ||
			now - proof.verifiedAt > 30000 ||
			(
				[
					"channelId",
					"applicationId",
					"botUserId",
					"founderId",
					"messageDigest",
				] as const
			).some((key) => proof[key] !== notice[key])
		) {
			throw new Error("notice probe evidence invalid");
		}
		// Do not pass the DB's send state or binding fields into the strict receipt contract.
		const intent = Object.fromEntries(
			customerNoticeFields.map((key) => [key, notice[key]]),
		) as unknown as CustomerNoticeIntent;
		return { ...intent, ...proof };
	}
	async probe(
		cycleId: string,
		signal?: AbortSignal,
	): Promise<CustomerDeliveryReceipt | null> {
		const cycle = this.options.store.get(cycleId),
			notice = this.options.store.notice(cycleId);
		if (
			!cycle ||
			!["window_open", "awaiting_attempt"].includes(cycle.state) ||
			!notice ||
			notice.sendState !== "delivered" ||
			!notice.messageId
		)
			return null;
		try {
			const receipt = await this.readback(cycleId, notice.messageId, signal);
			signal?.throwIfAborted();
			const current = this.options.store.get(cycleId);
			if (
				!current ||
				current.revision !== cycle.revision ||
				current.invalidatedEventSeq !== null
			)
				return null;
			return receipt;
		} catch {
			this.invalidate(cycleId, "notice_probe_failed");
			return null;
		}
	}
}
