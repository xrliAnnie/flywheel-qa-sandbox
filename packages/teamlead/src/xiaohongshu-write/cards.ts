import { canonical, contentDigest } from "./canonical.js";
import { freezeWrite } from "./contracts.js";
import { buildPreview, type ReviewFile, reviewFile } from "./preview.js";
import type { XhsWriteStore } from "./store.js";
export type ReviewMessage = {
	id: string;
	authorId: string;
	channelId: string;
	content: string;
	attachments: Array<{ id: string; name: string; size: number }>;
};
export interface ReviewTransport {
	// Implementation must send allowed_mentions: {parse: []}, with no model-controlled destination.
	send(
		content: string,
		files: ReviewFile[],
		allowedMentions: { parse: never[] },
	): Promise<string>;
	fetch(messageId: string): Promise<ReviewMessage>;
	readAttachment(attachmentId: string): Promise<Buffer>;
	remove(messageId: string): Promise<void>;
}
type Input = {
	frozen: ReturnType<typeof freezeWrite>;
	challenge: string;
	expiresAt: number;
	now: number;
	attachmentLimit: number;
	botId: string;
	channelId: string;
	guildId: string;
	media: Buffer[];
};
export type ReviewManifest = {
	schemaVersion: 1;
	proposalId: string;
	contentDigest: string;
	messages: Array<{
		id: string;
		content: string;
		attachments: Array<{
			id: string;
			name: string;
			size: number;
			sha256: string;
		}>;
	}>;
};
export async function deliverReview(
	input: Input,
	transport: ReviewTransport,
	store: Pick<XhsWriteStore, "delivered">,
) {
	input = {
		...input,
		frozen: freezeWrite(input.frozen, input.now),
		media: input.media.map((bytes) => Buffer.from(bytes)),
	};
	const preview = buildPreview(input.frozen, input.challenge, input.expiresAt);
	if (input.media.length !== input.frozen.media.length)
		throw Error("artifact_unverified");
	const files = [...preview.files];
	for (const [index, bytes] of input.media.entries()) {
		const expected = input.frozen.media[index]!;
		const extension = {
			"image/png": "png",
			"image/jpeg": "jpg",
			"image/webp": "webp",
			"video/mp4": "mp4",
		}[expected.mimeType];
		const file = reviewFile(`media-${index + 1}.${extension}`, bytes);
		if (file.sha256 !== expected.sha256 || bytes.length !== expected.sizeBytes)
			throw Error("artifact_unverified");
		files.push(file);
	}
	const limit = Math.min(10 * 1024 * 1024, input.attachmentLimit);
	if (
		!Number.isSafeInteger(limit) ||
		limit <= 0 ||
		files.some((file) => file.bytes.length > limit)
	)
		throw Error("preview_media_too_large");
	if (
		files.reduce((total, file) => total + file.bytes.length, 0) >
		180 * 1024 * 1024
	)
		throw Error("preview_media_too_large");
	const groups: ReviewFile[][] = [];
	let group: ReviewFile[] = [];
	let size = 0;
	for (const file of files) {
		if (group.length === 10 || size + file.bytes.length > 20 * 1024 * 1024) {
			groups.push(group);
			group = [];
			size = 0;
		}
		group.push(file);
		size += file.bytes.length;
	}
	if (group.length) groups.push(group);
	const sent: string[] = [];
	const manifest: ReviewManifest = {
		schemaVersion: 1,
		proposalId: input.frozen.proposalId,
		contentDigest: preview.contentDigest,
		messages: [],
	};
	try {
		for (const [index, batch] of groups.entries()) {
			const content = `小红书审核材料 ${input.frozen.proposalId}，第 ${index + 1}/${groups.length} 批。完整交付后另发可回复审核卡。`;
			const id = await transport.send(content, batch, { parse: [] });
			sent.push(id);
			const message = await transport.fetch(id);
			if (
				message.id !== id ||
				message.authorId !== input.botId ||
				message.channelId !== input.channelId ||
				message.content !== content ||
				message.attachments.length !== batch.length
			)
				throw Error();
			const attachments: ReviewManifest["messages"][number]["attachments"] = [];
			for (const [position, expected] of batch.entries()) {
				const actual = message.attachments[position];
				if (
					!actual ||
					actual.name !== expected.name ||
					actual.size !== expected.bytes.length
				)
					throw Error();
				const bytes = await transport.readAttachment(actual.id);
				if (!bytes.equals(expected.bytes)) throw Error();
				attachments.push({ ...actual, sha256: expected.sha256 });
			}
			manifest.messages.push({ id, content, attachments });
		}
		const manifestDigest = contentDigest(manifest);
		const links = manifest.messages
			.map(
				(message) =>
					`https://discord.com/channels/${input.guildId}/${input.channelId}/${message.id}`,
			)
			.join("\n");
		const content = `${preview.content}\n完整材料：\n${links}\n交付指纹：${manifestDigest}`;
		if (content.length > 2000) throw Error();
		const cardId = await transport.send(content, [], { parse: [] });
		sent.push(cardId);
		const card = await transport.fetch(cardId);
		if (
			card.id !== cardId ||
			card.authorId !== input.botId ||
			card.channelId !== input.channelId ||
			card.content !== content ||
			card.attachments.length !== 0
		)
			throw Error();
		store.delivered(
			input.frozen.proposalId,
			{
				expectedContentDigest: preview.contentDigest,
				previewDigest: manifestDigest,
				cardId,
				challenge: input.challenge,
				guildId: input.guildId,
				channelId: input.channelId,
				manifestJson: canonical({ manifest, cardContent: content }),
			},
			input.now,
		);
		return { cardId, manifest, manifestDigest };
	} catch {
		// Cleanup only these draft messages; failed cleanup does not enable approval.
		await Promise.allSettled(sent.map((id) => transport.remove(id)));
		throw Error("preview_delivery_failed");
	}
}
