import { isDeepStrictEqual } from "node:util";
import type { ReleaseInteractionTarget } from "./actions.js";
import type { ReleaseControlNotice } from "./activation-store.js";
import { releaseMessageDigest } from "./cards.js";
import { activationCard } from "./controls.js";
import type { ReleaseDiscordClient } from "./discord.js";
import type { CustomerReleaseStore } from "./store.js";

export class ReleaseControlDelivery {
	constructor(
		private readonly options: {
			store: CustomerReleaseStore;
			target: () => ReleaseInteractionTarget;
			evidenceDigest: () => string | null;
			transport: Pick<
				ReleaseDiscordClient,
				"send" | "findMessage" | "verifyMessage"
			>;
			now: () => number;
		},
	) {}
	async deliver(
		intent: Omit<ReleaseControlNotice, "messageId">,
		signal?: AbortSignal,
	): Promise<ReleaseControlNotice | null> {
		try {
			const target = { ...this.options.target() },
				store = this.options.store;
			const ensure = () => {
				signal?.throwIfAborted();
				const state = store.activation.get();
				if (
					!state ||
					!isDeepStrictEqual(target, this.options.target()) ||
					state.epoch !== target.epoch ||
					state.identity.founderId !== target.founderId ||
					state.identity.identityDigest !== intent.identityDigest ||
					state.identity.policyRevision !== intent.policyRevision ||
					intent.epoch !== target.epoch ||
					intent.applicationId !== target.applicationId ||
					intent.channelId !== target.channelId ||
					intent.botUserId !== target.botUserId ||
					this.options.now() >= intent.expiresAt ||
					(intent.action === "enable" &&
						this.options.evidenceDigest() !== intent.evidenceBundleDigest)
				)
					throw new Error("control authority changed");
			};
			ensure();
			const card = activationCard(intent);
			if (releaseMessageDigest(card) !== intent.messageDigest)
				throw new Error("control card mismatch");
			const first = store.activation.startControlDelivery(
				intent,
				this.options.now(),
			);
			const delivered = store.activation.controlNotice(intent.noticeId);
			if (delivered) return delivered;
			let messageId: string | null = null;
			if (first) {
				try {
					messageId = await this.options.transport.send(
						card,
						intent.noticeId,
						signal,
					);
				} catch {
					/* Durable intent forbids a second POST. */
				}
				ensure();
			}
			// Search from the durable first-send time, including after a restart.
			// The transport rejects incomplete history; absence never permits resend.
			if (!messageId)
				messageId = await this.options.transport.findMessage(
					intent.noticeId,
					store.activation.controlDeliveryAt(intent.noticeId)!,
					signal,
				);
			ensure();
			if (!messageId) return null;
			const proof = await this.options.transport.verifyMessage(
				messageId,
				intent.messageDigest,
				signal,
			);
			ensure();
			const now = this.options.now();
			if (
				proof.messageId !== messageId ||
				proof.messageDigest !== intent.messageDigest ||
				proof.applicationId !== target.applicationId ||
				proof.channelId !== target.channelId ||
				proof.botUserId !== target.botUserId ||
				proof.founderId !== target.founderId ||
				!proof.accessVerified ||
				!proof.gatewayHealthy ||
				!Number.isSafeInteger(proof.verifiedAt) ||
				proof.verifiedAt > now ||
				now - proof.verifiedAt > 30000
			)
				return null;
			const receipt = { ...intent, messageId };
			store.activation.recordDeliveredControl(receipt, now);
			return receipt;
		} catch {
			return null;
		}
	}
}
