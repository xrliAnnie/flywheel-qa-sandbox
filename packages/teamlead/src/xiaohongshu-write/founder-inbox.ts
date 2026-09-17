import { z } from "zod";
import { canonical } from "./canonical.js";
import {
	type FounderSource,
	type ObserverPolicy,
	XhsFounderObserver,
} from "./observer.js";
import type { XhsWriteStore } from "./store.js";

const snowflake = z.string().regex(/^[1-9][0-9]{16,19}$/);
const envelope = z.object({
	id: snowflake,
	channel_id: snowflake,
	author: z.object({ id: snowflake, bot: z.boolean().optional() }),
	type: z.number().int(),
});
const reply = envelope.extend({
	type: z.literal(19),
	webhook_id: z.never().optional(),
	edited_timestamp: z.null(),
	message_snapshots: z.array(z.unknown()).max(0).optional(),
	message_reference: z.object({
		type: z.literal(0).optional(),
		message_id: snowflake,
		channel_id: snowflake,
		guild_id: snowflake.optional(),
	}),
});
/** Discovers known cards using the authority's own source; Bridge hints are unnecessary. */
export class XhsFounderInbox {
	private readonly observer: XhsFounderObserver;
	constructor(
		private readonly store: XhsWriteStore,
		private readonly source: FounderSource,
		private readonly policy: () => ObserverPolicy,
		clock: () => number = Date.now,
	) {
		this.observer = new XhsFounderObserver(store, source, policy, clock);
	}
	async process(messageId: string): Promise<"handled" | "ignored"> {
		const initial = structuredClone(this.policy());
		if (initial.founderId !== initial.canonicalFounderId)
			throw Error("founder_policy_changed");
		let raw: unknown;
		try {
			snowflake.parse(messageId);
			raw = await this.source.fetchMessage(initial.channelId, messageId);
			const message = envelope.parse(raw);
			if (message.id !== messageId || message.channel_id !== initial.channelId)
				throw Error();
		} catch {
			throw Error("founder_source_unavailable");
		}
		if (canonical(this.policy()) !== canonical(initial))
			throw Error("founder_policy_changed");
		const candidate = reply.safeParse(raw);
		if (!candidate.success) return "ignored";
		const message = candidate.data;
		if (
			message.author.bot ||
			message.author.id !== initial.founderId ||
			message.message_reference.channel_id !== initial.channelId ||
			(message.message_reference.guild_id !== undefined &&
				message.message_reference.guild_id !== initial.guildId)
		)
			return "ignored";
		const proposalId = this.store.proposalForCard(
			initial.channelId,
			message.message_reference.message_id,
			initial,
		);
		if (!proposalId) return "ignored";
		const status = this.store.status(proposalId, initial);
		if (
			!status ||
			!["awaiting_approval", "approved", "consumed"].includes(status.state)
		)
			return "ignored";
		try {
			await this.observer.observe(proposalId, messageId);
			return "handled";
		} catch (error) {
			if (
				error instanceof Error &&
				[
					"founder_message_invalid",
					"founder_command_mismatch",
					"founder_receipt_expired",
				].includes(error.message)
			)
				return "ignored";
			throw error;
		}
	}
}
