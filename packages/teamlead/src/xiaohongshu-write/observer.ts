import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { canonical, contentDigest, parseStrictJson } from "./canonical.js";
import { verifyFounderMessage } from "./founder-message.js";
import type { WriteIdentity, XhsWriteStore } from "./store.js";
export type ObserverPolicy = WriteIdentity & {
	founderId: string;
	canonicalFounderId: string;
	botId: string;
	guildId: string;
	channelId: string;
};
export interface FounderSource {
	fetchMessage(channelId: string, messageId: string): Promise<unknown>;
	channelGuild(channelId: string): Promise<string>;
	readAttachment(attachmentId: string): Promise<Buffer>;
}
const attachment = z
	.object({
		id: z.string().min(1),
		name: z.string().min(1),
		size: z
			.number()
			.int()
			.positive()
			.max(10 * 1024 * 1024),
		sha256: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();
const reviewSchema = z
	.object({
		cardContent: z.string().max(2000),
		manifest: z
			.object({
				schemaVersion: z.literal(1),
				proposalId: z.string(),
				contentDigest: z.string(),
				messages: z
					.array(
						z
							.object({
								id: z.string(),
								content: z.string(),
								attachments: z.array(attachment).max(10),
							})
							.strict(),
					)
					.min(1)
					.max(19),
			})
			.strict(),
	})
	.strict();
const botMessage = z.object({
	id: z.string(),
	channel_id: z.string(),
	guild_id: z.string().optional(),
	author: z.object({ id: z.string(), bot: z.literal(true) }),
	edited_timestamp: z.null(),
	timestamp: z.string().datetime({ offset: true }),
	content: z.string(),
	attachments: z.array(
		z.object({
			id: z.string(),
			filename: z.string(),
			size: z.number().int().nonnegative(),
		}),
	),
});

/** Authority-owned source only. Hints contain IDs; caller-provided message bodies are never accepted. */
export class XhsFounderObserver {
	constructor(
		private readonly store: XhsWriteStore,
		private readonly source: FounderSource,
		private readonly policy: () => ObserverPolicy,
		private readonly clock: () => number = Date.now,
	) {}
	async observe(proposalId: string, messageId: string) {
		try {
			const initialPolicy = structuredClone(this.policy());
			const policyDigest = canonical(initialPolicy);
			const record = this.store.approvalRecord(proposalId);
			if (
				!record ||
				!this.store.status(proposalId, initialPolicy) ||
				record.channelId !== initialPolicy.channelId ||
				record.guildId !== initialPolicy.guildId
			)
				throw Error();
			const stored = reviewSchema.parse(parseStrictJson(record.manifestJson));
			if (
				stored.manifest.proposalId !== proposalId ||
				stored.manifest.contentDigest !== record.contentDigest ||
				contentDigest(stored.manifest) !== record.previewDigest
			)
				throw Error();
			const guild = await this.source.channelGuild(record.channelId);
			if (guild !== record.guildId) throw Error();
			const verifyBot = (input: unknown, id: string, content: string) => {
				const message = botMessage.parse(input);
				if (
					message.id !== id ||
					message.author.id !== initialPolicy.botId ||
					message.channel_id !== record.channelId ||
					(message.guild_id !== undefined &&
						message.guild_id !== record.guildId) ||
					message.content !== content
				)
					throw Error();
				return message;
			};
			const card = verifyBot(
				await this.source.fetchMessage(record.channelId, record.cardId),
				record.cardId,
				stored.cardContent,
			);
			if (card.attachments.length !== 0) throw Error();
			for (const expected of stored.manifest.messages) {
				const material = verifyBot(
					await this.source.fetchMessage(record.channelId, expected.id),
					expected.id,
					expected.content,
				);
				if (material.attachments.length !== expected.attachments.length)
					throw Error();
				for (const [index, file] of expected.attachments.entries()) {
					const actual = material.attachments[index];
					if (
						!actual ||
						actual.id !== file.id ||
						actual.filename !== file.name ||
						actual.size !== file.size
					)
						throw Error();
					const bytes = await this.source.readAttachment(file.id);
					if (
						bytes.length !== file.size ||
						createHash("sha256").update(bytes).digest("hex") !== file.sha256
					)
						throw Error();
				}
			}
			const raw = await this.source.fetchMessage(record.channelId, messageId);
			const assertAuthority = () => {
				if (
					canonical(this.policy()) !== policyDigest ||
					!this.store.status(proposalId, initialPolicy)
				)
					throw Error("founder_policy_changed");
			};
			assertAuthority();
			const verified = verifyFounderMessage(raw, {
				...initialPolicy,
				trustedChannelGuildId: guild,
				cardId: record.cardId,
				challenge: record.challenge,
				cardCreatedAt: Date.parse(card.timestamp),
				preparedAt: record.createdAt,
				proposalExpiresAt: record.expiresAt,
				observedAt: this.clock(),
			});
			if (verified.messageId !== messageId) throw Error();
			if (verified.kind === "revoked") {
				const result = this.store.recordFounderRevocation(
					proposalId,
					verified,
					assertAuthority,
				);
				return { kind: "revoked" as const, ...result };
			}
			const receiptId =
				this.store.receiptForFounderMessage(verified.messageId) ?? randomUUID();
			const result = this.store.recordDecision(
				{
					receiptId,
					proposalId,
					purpose: "xiaohongshu_founder_write",
					decision: verified.kind,
					contentDigest: record.contentDigest,
					founderId: verified.founderId,
					founderConfigVersion: verified.founderConfigVersion,
					founderMessageId: verified.messageId,
					guildId: verified.guildId,
					channelId: verified.channelId,
					cardId: verified.cardId,
					messageDigest: verified.messageDigest,
					messageCreatedAt: verified.messageCreatedAt,
					observedAt: verified.observedAt,
					expiresAt: verified.expiresAt,
				},
				assertAuthority,
			);
			return { kind: verified.kind, ...result };
		} catch (error) {
			if (
				error instanceof Error &&
				[
					"founder_message_invalid",
					"founder_content_unavailable",
					"founder_command_mismatch",
					"founder_receipt_expired",
					"founder_policy_changed",
				].includes(error.message)
			)
				throw error;
			throw Error("founder_source_unavailable");
		}
	}
}
