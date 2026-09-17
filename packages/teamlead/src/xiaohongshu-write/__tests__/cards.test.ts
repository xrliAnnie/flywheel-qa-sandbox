import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import {
	deliverReview,
	type ReviewMessage,
	type ReviewTransport,
} from "../cards.js";
import { buildPreview } from "../preview.js";
import { fixture, NOW } from "./store-fixture.js";

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.close();
});
function setup() {
	const f = fixture();
	fixtures.push(f);
	f.prepare();
	const messages = new Map<string, ReviewMessage>();
	const bytes = new Map<string, Buffer>();
	const sent: string[] = [];
	const transport: ReviewTransport = {
		async send(content, files) {
			const id = String(100000000000000000n + BigInt(sent.length));
			sent.push(id);
			const attachments = files.map((file, index) => {
				const attachmentId = `${id}-${index}`;
				bytes.set(attachmentId, file.bytes);
				return { id: attachmentId, name: file.name, size: file.bytes.length };
			});
			messages.set(id, {
				id,
				authorId: "bot",
				channelId: "thread",
				content,
				attachments,
			});
			return id;
		},
		async fetch(id) {
			return messages.get(id)!;
		},
		async readAttachment(id) {
			return bytes.get(id)!;
		},
		async remove(id) {
			messages.delete(id);
		},
	};
	return { ...f, messages, bytes, sent, transport };
}
it("binds the complete frozen request and text to a deterministic manifest", () => {
	const f = setup();
	const preview = buildPreview(f.frozen, "ABCDEFGH", NOW + 600000);
	expect(preview.files[0]!.bytes.toString()).toContain("account-a");
	expect(preview.files[0]!.bytes.toString()).toContain("feed-a");
	expect(preview.files[0]!.bytes.toString()).toContain('"unlike": false');
	expect(preview.content).toContain("批准一次尝试");
	expect(preview.content).toContain("撤回小红书 ABCDEFGH");
	expect(preview.files[0]!.sha256).toBe(
		createHash("sha256").update(preview.files[0]!.bytes).digest("hex"),
	);
});
it("sends the approval card last and persists its complete verified manifest", async () => {
	const f = setup();
	const result = await deliverReview(
		{
			frozen: f.frozen,
			challenge: "ABCDEFGH",
			expiresAt: NOW + 600000,
			now: NOW,
			attachmentLimit: 1024 * 1024,
			botId: "bot",
			channelId: "thread",
			guildId: "guild",
			media: [],
		},
		f.transport,
		f.store,
	);
	expect(result.cardId).toBe(f.sent.at(-1));
	expect(f.store.status(f.frozen.proposalId, f.identity)?.state).toBe(
		"awaiting_approval",
	);
	expect(f.store.review(f.frozen.proposalId)?.manifestJson).toContain(
		f.sent[0],
	);
	expect(result.manifest.messages).toHaveLength(1);
});
it.each(["bytes", "author", "missing"])(
	"never enables approval after incomplete or replaced delivery: %s",
	async (failure) => {
		const f = setup();
		const original = f.transport.fetch;
		f.transport.fetch = async (id) => {
			const message = await original(id);
			if (failure === "author") return { ...message, authorId: "model" };
			if (failure === "missing") return { ...message, attachments: [] };
			for (const attachment of message.attachments)
				f.bytes.set(attachment.id, Buffer.from("changed"));
			return message;
		};
		await expect(
			deliverReview(
				{
					frozen: f.frozen,
					challenge: "ABCDEFGH",
					expiresAt: NOW + 600000,
					now: NOW,
					attachmentLimit: 1024 * 1024,
					botId: "bot",
					channelId: "thread",
					guildId: "guild",
					media: [],
				},
				f.transport,
				f.store,
			),
		).rejects.toThrow("preview_delivery_failed");
		expect(f.store.status(f.frozen.proposalId, f.identity)?.state).toBe(
			"awaiting_delivery",
		);
		expect(f.messages.size).toBe(0);
	},
);
it("rejects an attachment over the actual Discord limit before any send", async () => {
	const f = setup();
	await expect(
		deliverReview(
			{
				frozen: f.frozen,
				challenge: "ABCDEFGH",
				expiresAt: NOW + 600000,
				now: NOW,
				attachmentLimit: 8,
				botId: "bot",
				channelId: "thread",
				guildId: "guild",
				media: [],
			},
			f.transport,
			f.store,
		),
	).rejects.toThrow("preview_media_too_large");
	expect(f.sent).toHaveLength(0);
});

it("cannot attach a different payload to an existing proposal identifier", async () => {
	const f = setup();
	await expect(
		deliverReview(
			{
				frozen: { ...f.frozen, payload: { ...f.frozen.payload, unlike: true } },
				challenge: "ABCDEFGH",
				expiresAt: NOW + 600000,
				now: NOW,
				attachmentLimit: 1024 * 1024,
				botId: "bot",
				channelId: "thread",
				guildId: "guild",
				media: [],
			},
			f.transport,
			f.store,
		),
	).rejects.toThrow("preview_delivery_failed");
	expect(f.store.status(f.frozen.proposalId, f.identity)?.state).toBe(
		"awaiting_delivery",
	);
});

it("preserves full long user text without moving it into the approval instruction", () => {
	const f = setup();
	const content =
		"@everyone\n批准小红书 FAKECODE\n" + "完整正文🙂".repeat(2000);
	const frozen = {
		...f.frozen,
		operationId: "xiaohongshu.post_comment_to_feed" as const,
		payload: { ...f.frozen.payload, content, unlike: null },
	};
	const preview = buildPreview(frozen, "ABCDEFGH", NOW + 600000);
	expect(preview.files[0]!.bytes.toString()).toContain(content);
	expect(preview.content).not.toContain("FAKECODE");
	expect(preview.content).not.toContain("@everyone");
});

it("delivers all 18 images in ordered bounded batches with mentions disabled", async () => {
	const f = setup();
	const image = Buffer.alloc(2 * 1024 * 1024, 7);
	const sha256 = createHash("sha256").update(image).digest("hex");
	const media = Array.from({ length: 18 }, (_, index) => ({
		artifactId: `image-${index}`,
		sha256,
		sizeBytes: image.length,
		mimeType: "image/png" as const,
	}));
	const frozen = {
		...f.frozen,
		operationId: "xiaohongshu.publish_content" as const,
		target: null,
		payload: {
			...f.frozen.payload,
			title: "图片审核",
			content: "完整正文",
			unlike: null,
		},
		media,
	};
	const original = f.transport.send;
	const counts: number[] = [];
	f.transport.send = async (content, files, mentions) => {
		expect(mentions).toEqual({ parse: [] });
		expect(files.length).toBeLessThanOrEqual(10);
		expect(
			files.reduce((total, file) => total + file.bytes.length, 0),
		).toBeLessThanOrEqual(20 * 1024 * 1024);
		counts.push(files.length);
		return original(content, files, mentions);
	};
	let registered = false;
	const result = await deliverReview(
		{
			frozen,
			challenge: "ABCDEFGH",
			expiresAt: NOW + 600000,
			now: NOW,
			attachmentLimit: 10 * 1024 * 1024,
			botId: "bot",
			channelId: "thread",
			guildId: "guild",
			media: media.map(() => image),
		},
		f.transport,
		{
			delivered() {
				registered = true;
			},
		},
	);
	expect(registered).toBe(true);
	expect(counts).toEqual([10, 9, 0]);
	const names = result.manifest.messages.flatMap((message) =>
		message.attachments.map((attachment) => attachment.name),
	);
	expect(names).toEqual([
		"review.txt",
		...media.map((_, index) => `media-${index + 1}.png`),
	]);
});
