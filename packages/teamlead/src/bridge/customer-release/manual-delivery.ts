import { isDeepStrictEqual } from "node:util";
import type { ReleaseInteractionTarget } from "./actions.js";
import { releaseCard, releaseMessageDigest } from "./cards.js";
import type { ReleaseDiscordClient } from "./discord.js";
import type { ManualReleaseDelivery } from "./manual.js";
import type { CustomerReleaseStore } from "./store.js";

/** Original manual card only; a fresh independent probe populates the
 * synchronous Gateway go cache. No delivery probe can accept go itself. */
export class ManualReleaseCardDelivery {
	private last: number | null = null;
	constructor(
		private readonly options: {
			store: CustomerReleaseStore;
			target: () => ReleaseInteractionTarget;
			timezone: () => string;
			now: () => number;
			cache: Map<string, ManualReleaseDelivery>;
			transport: Pick<
				ReleaseDiscordClient,
				"send" | "findMessage" | "verifyMessage"
			>;
		},
	) {}
	async tick(signal?: AbortSignal): Promise<void> {
		const now = this.options.now();
		if (this.last !== null && now >= this.last && now - this.last < 15000)
			return;
		this.last = now;
		this.options.cache.clear();
		const requests = this.options.store.manual.waitingCards(now);
		for (const request of requests) {
			const { card, binding } = request;
			try {
				const target = { ...this.options.target() };
				const ensure = () => {
					signal?.throwIfAborted();
					const current = this.options.store.manual.get(card.requestId);
					if (
						!current ||
						current.status !== "waiting" ||
						!isDeepStrictEqual(current, request) ||
						!isDeepStrictEqual(target, this.options.target()) ||
						target.epoch !== card.activationEpoch ||
						target.founderId !== card.founderId ||
						target.applicationId !== card.applicationId ||
						target.channelId !== card.channelId ||
						target.botUserId !== card.botUserId ||
						this.options.now() >= card.expiresAt ||
						this.options.store.get(request.cycleId)?.state !== "cancelled"
					)
						throw new Error("manual card authority changed");
				};
				ensure();
				const rendered = releaseCard({
					kind: "go",
					nonce: card.requestId,
					epoch: card.activationEpoch,
					timezone: this.options.timezone(),
					betaVersion: binding.betaVersion,
					releaseVersion: binding.releaseVersion,
					sourceCommit: binding.sourceCommit,
					payloadSha256: binding.releasePayloadSha256,
					deadlineAt: card.expiresAt,
				});
				if (releaseMessageDigest(rendered) !== card.messageDigest)
					throw new Error("manual card changed");
				let messageId: string | null = null;
				if (
					this.options.store.manual.startDelivery(
						card.requestId,
						this.options.now(),
					)
				) {
					try {
						messageId = await this.options.transport.send(
							rendered,
							card.requestId,
							signal,
						);
					} catch {
						/* Recover the same durable send intent. */
					}
				}
				ensure();
				const intent = this.options.store.manual.deliveryIntent(
					card.requestId,
				)!;
				messageId ??=
					intent.messageId ??
					(await this.options.transport.findMessage(
						card.requestId,
						intent.at,
						signal,
					));
				ensure();
				if (!messageId) continue;
				const proof = await this.options.transport.verifyMessage(
					messageId,
					card.messageDigest,
					signal,
				);
				ensure();
				const at = this.options.now();
				if (
					proof.messageId !== messageId ||
					!proof.accessVerified ||
					!proof.gatewayHealthy ||
					!Number.isSafeInteger(proof.verifiedAt) ||
					proof.verifiedAt > at ||
					at - proof.verifiedAt > 30000 ||
					(
						[
							"messageDigest",
							"channelId",
							"applicationId",
							"botUserId",
							"founderId",
						] as const
					).some((key) => proof[key] !== card[key])
				)
					continue;
				this.options.store.manual.recordDeliveredMessage(
					card.requestId,
					messageId,
					at,
				);
				this.options.cache.set(card.requestId, proof);
			} catch {
				this.options.cache.delete(card.requestId);
			}
		}
	}
}
