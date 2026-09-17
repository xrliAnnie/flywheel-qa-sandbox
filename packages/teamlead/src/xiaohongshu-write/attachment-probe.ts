import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { ReviewTransport } from "./cards.js";
import { reviewFile } from "./preview.js";
export const ATTACHMENT_HARD_LIMIT = 10 * 1024 * 1024;
const TTL = 86400_000;
const id = z.string().regex(/^[1-9][0-9]{16,19}$/);
const time = z.number().int().nonnegative().safe();
const policySchema = z
	.object({
		guildId: id,
		channelId: id,
		botId: id,
		userChannelIds: z.array(id).max(64),
	})
	.strict()
	.refine((policy) => !policy.userChannelIds.includes(policy.channelId));
export type AttachmentProbePolicy = z.infer<typeof policySchema>;
export const attachmentProbeReceiptSchema = z
	.object({
		schemaVersion: z.literal(1),
		guildId: id,
		channelId: id,
		botId: id,
		messageId: id,
		attachmentId: id,
		sha256: z.string().regex(/^[a-f0-9]{64}$/),
		measuredBytes: z.number().int().positive().max(ATTACHMENT_HARD_LIMIT),
		probedAt: time,
		expiresAt: time,
	})
	.strict();
export type AttachmentProbeReceipt = z.infer<
	typeof attachmentProbeReceiptSchema
>;
export function validAttachmentProbeReceipt(
	raw: unknown,
	policy: AttachmentProbePolicy,
	now: number,
): AttachmentProbeReceipt | null {
	try {
		const expected = policySchema.parse(policy),
			receipt = attachmentProbeReceiptSchema.parse(raw);
		time.parse(now);
		if (
			receipt.guildId !== expected.guildId ||
			receipt.channelId !== expected.channelId ||
			receipt.botId !== expected.botId ||
			receipt.probedAt > now ||
			receipt.expiresAt <= now ||
			receipt.expiresAt <= receipt.probedAt ||
			receipt.expiresAt - receipt.probedAt > TTL
		)
			return null;
		return receipt;
	} catch {
		return null;
	}
}
/** Per Lead ruling: absent/invalid proof uses the independent hard ceiling.
 * A valid receipt can reduce that ceiling, never raise it. */
export function effectiveAttachmentLimit(
	raw: unknown,
	policy: AttachmentProbePolicy,
	now: number,
): number {
	return (
		validAttachmentProbeReceipt(raw, policy, now)?.measuredBytes ??
		ATTACHMENT_HARD_LIMIT
	);
}
/** Source must be constructed for the root-designated dedicated probe channel.
 * Never invoke with a user-facing source or expose this as a model operation. */
export async function measureAttachmentLimit(options: {
	policy: AttachmentProbePolicy;
	source: ReviewTransport & {
		channelGuild(channelId: string): Promise<string>;
	};
	now?: () => number;
	assertCurrent?: () => void;
}): Promise<AttachmentProbeReceipt | null> {
	let messageId: string | undefined;
	try {
		const policy = policySchema.parse(structuredClone(options.policy));
		const current = () => options.assertCurrent?.();
		current();
		if (
			(await options.source.channelGuild(policy.channelId)) !== policy.guildId
		)
			throw Error();
		current();
		const file = reviewFile(
			"xhs-attachment-probe.bin",
			randomBytes(ATTACHMENT_HARD_LIMIT),
		);
		const content =
			"Flywheel attachment limit probe. This message is removed after verification.";
		try {
			messageId = id.parse(
				await options.source.send(content, [file], { parse: [] }),
			);
			current();
			const message = await options.source.fetch(messageId);
			if (
				message.id !== messageId ||
				message.channelId !== policy.channelId ||
				message.authorId !== policy.botId ||
				message.content !== content ||
				message.attachments.length !== 1
			)
				throw Error();
			const attachment = message.attachments[0]!;
			id.parse(attachment.id);
			if (
				attachment.name !== file.name ||
				attachment.size !== ATTACHMENT_HARD_LIMIT
			)
				throw Error();
			const bytes = await options.source.readAttachment(attachment.id);
			if (
				bytes.length !== ATTACHMENT_HARD_LIMIT ||
				createHash("sha256").update(bytes).digest("hex") !== file.sha256
			)
				throw Error();
			current();
			if (
				(await options.source.channelGuild(policy.channelId)) !== policy.guildId
			)
				throw Error();
			const probedAt = time.parse((options.now ?? Date.now)());
			return attachmentProbeReceiptSchema.parse({
				schemaVersion: 1,
				guildId: policy.guildId,
				channelId: policy.channelId,
				botId: policy.botId,
				messageId,
				attachmentId: attachment.id,
				sha256: file.sha256,
				measuredBytes: ATTACHMENT_HARD_LIMIT,
				probedAt,
				expiresAt: probedAt + TTL,
			});
		} finally {
			if (messageId) await options.source.remove(messageId);
			current();
		}
	} catch {
		return null;
	}
}

export type AttachmentLimit =
	| number
	| ((scope: { projectId: string; leadId: string }) => number);
export function resolveAttachmentLimit(
	value: AttachmentLimit,
	scope: { projectId: string; leadId: string },
): number {
	const limit = typeof value === "function" ? value(scope) : value;
	if (!Number.isSafeInteger(limit) || limit <= 0)
		throw Error("preview_media_too_large");
	return Math.min(ATTACHMENT_HARD_LIMIT, limit);
}
