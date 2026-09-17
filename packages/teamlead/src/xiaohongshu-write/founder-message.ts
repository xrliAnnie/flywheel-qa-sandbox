import { randomInt } from "node:crypto";
import { z } from "zod";
import { contentDigest } from "./canonical.js";

const snowflake = z.string().regex(/^[1-9][0-9]{16,19}$/);
const rawMessage = z.object({
	id: snowflake,
	channel_id: snowflake,
	guild_id: snowflake.optional(),
	author: z.object({ id: snowflake, bot: z.boolean().optional() }),
	webhook_id: z.never().optional(),
	type: z.literal(19),
	message_reference: z.object({
		type: z.literal(0).optional(),
		message_id: snowflake,
		channel_id: snowflake,
		guild_id: snowflake.optional(),
	}),
	message_snapshots: z.array(z.unknown()).max(0).optional(),
	timestamp: z.string().datetime({ offset: true }),
	edited_timestamp: z.null(),
	content: z.string().max(4000),
});
export type FounderMessageContext = {
	founderId: string;
	canonicalFounderId: string;
	founderConfigVersion: number;
	guildId: string;
	channelId: string;
	trustedChannelGuildId: string;
	cardId: string;
	challenge: string;
	cardCreatedAt: number;
	preparedAt: number;
	proposalExpiresAt: number;
	observedAt: number;
};
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function createChallenge(): string {
	return Array.from(
		{ length: 8 },
		() => alphabet[randomInt(alphabet.length)],
	).join("");
}
export function normalizeFounderCommand(content: string): string {
	return content
		.normalize("NFKC")
		.trim()
		.replace(/[.!。！]$/, "");
}
/** A routing exclusion only: matching text never grants XHS approval. */
export function isXhsProtocolReply(content: string): boolean {
	const command = normalizeFounderCommand(content);
	return ["批准小红书", "撤回小红书", "拒绝小红书"].some((prefix) =>
		command.startsWith(prefix),
	);
}
/** Pure policy check; caller must refetch message/card using the authority's own bot. */
export function verifyFounderMessage(
	raw: unknown,
	context: FounderMessageContext,
) {
	for (const id of [
		context.founderId,
		context.canonicalFounderId,
		context.guildId,
		context.channelId,
		context.trustedChannelGuildId,
		context.cardId,
	]) {
		if (!snowflake.safeParse(id).success) throw Error("founder_policy_invalid");
	}
	if (
		context.founderId !== context.canonicalFounderId ||
		context.trustedChannelGuildId !== context.guildId ||
		!Number.isSafeInteger(context.founderConfigVersion) ||
		context.founderConfigVersion < 1 ||
		!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(context.challenge)
	)
		throw Error("founder_policy_invalid");
	for (const time of [
		context.cardCreatedAt,
		context.preparedAt,
		context.proposalExpiresAt,
		context.observedAt,
	])
		if (!Number.isSafeInteger(time) || time < 0)
			throw Error("founder_policy_invalid");
	if (
		context.proposalExpiresAt <= context.preparedAt ||
		context.proposalExpiresAt > context.preparedAt + 86400_000
	)
		throw Error("founder_policy_invalid");
	const parsed = rawMessage.safeParse(raw);
	if (!parsed.success) throw Error("founder_message_invalid");
	const message = parsed.data;
	const reference = message.message_reference;
	if (
		message.author.bot ||
		message.author.id !== context.founderId ||
		message.channel_id !== context.channelId ||
		(message.guild_id !== undefined && message.guild_id !== context.guildId) ||
		reference.message_id !== context.cardId ||
		reference.channel_id !== context.channelId ||
		(reference.guild_id !== undefined && reference.guild_id !== context.guildId)
	)
		throw Error("founder_message_invalid");
	const createdAt = Date.parse(message.timestamp);
	const idTime = Number(BigInt(message.id) >> 22n) + 1420070400000;
	if (
		!Number.isSafeInteger(createdAt) ||
		createdAt !== idTime ||
		createdAt < Math.max(context.preparedAt, context.cardCreatedAt) ||
		createdAt > context.observedAt + 30000
	)
		throw Error("founder_message_invalid");
	if (!message.content.trim()) throw Error("founder_content_unavailable");
	const command = normalizeFounderCommand(message.content);
	const kinds = {
		批准小红书: "approved",
		拒绝小红书: "rejected",
		撤回小红书: "revoked",
	} as const;
	const entry = Object.entries(kinds).find(
		([prefix]) => command === `${prefix} ${context.challenge}`,
	);
	if (!entry) throw Error("founder_command_mismatch");
	const expiresAt = Math.min(
		context.proposalExpiresAt,
		createdAt + 15 * 60_000,
	);
	if (context.observedAt >= expiresAt) throw Error("founder_receipt_expired");
	return {
		kind: entry[1],
		messageId: message.id,
		founderId: message.author.id,
		founderConfigVersion: context.founderConfigVersion,
		guildId: context.guildId,
		channelId: message.channel_id,
		cardId: reference.message_id,
		messageCreatedAt: createdAt,
		observedAt: context.observedAt,
		expiresAt,
		messageDigest: contentDigest({
			messageId: message.id,
			authorId: message.author.id,
			guildId: context.guildId,
			channelId: message.channel_id,
			cardId: reference.message_id,
			type: message.type,
			editedAt: null,
			content: message.content,
			createdAt,
		}),
	};
}
