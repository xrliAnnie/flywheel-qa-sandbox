import { z } from "zod";
import { canonical, parseStrictJson } from "./canonical.js";

export const WRITE_OPERATIONS = [
	"xiaohongshu.publish_content",
	"xiaohongshu.publish_with_video",
	"xiaohongshu.post_comment_to_feed",
	"xiaohongshu.reply_comment_in_feed",
	"xiaohongshu.like_feed",
	"xiaohongshu.favorite_feed",
] as const;
export type XhsWriteOperation = (typeof WRITE_OPERATIONS)[number];
const id = z.string().min(1).max(256);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const artifactSchema = z
	.object({
		artifactId: id,
		sha256: hash,
		sizeBytes: integer.min(1).max(10 * 1024 * 1024),
		mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "video/mp4"]),
	})
	.strict();
export type FrozenArtifact = z.infer<typeof artifactSchema>;

const inputSchema = z
	.object({
		schemaVersion: z.literal(1),
		purpose: z.literal("xiaohongshu_founder_write"),
		proposalId: z.string().uuid(),
		requesterUid: integer,
		authorityPolicyVersion: integer.min(1),
		projectId: id,
		leadId: id,
		operationId: z.enum(WRITE_OPERATIONS),
		account: z
			.object({
				providerInstanceId: id,
				accountUserId: id,
				accountEpoch: integer.min(1),
				providerGeneration: id,
			})
			.strict(),
		target: z
			.object({ feedId: id, commentId: id.nullable(), userId: id.nullable() })
			.strict()
			.nullable(),
		payload: z
			.object({
				title: z.string().max(40).nullable().default(null),
				content: z.string().min(1).max(16000).nullable().default(null),
				tags: z.array(z.string().min(1).max(256)).max(100).default([]),
				visibility: z
					.enum(["公开可见", "仅自己可见", "仅互关好友可见"])
					.nullable()
					.default(null),
				isOriginal: z.boolean().nullable().default(null),
				scheduleAt: z.string().max(64).nullable().default(null),
				unlike: z.boolean().nullable().default(null),
				unfavorite: z.boolean().nullable().default(null),
				products: z.array(z.string()).max(100).optional(),
			})
			.strict(),
		media: z.array(artifactSchema).max(18),
		upstream: z
			.object({
				binarySha256: hash,
				toolSchemaDigest: hash,
				guardProtocol: z.literal(1),
			})
			.strict(),
	})
	.strict();

export type FrozenWrite = Omit<z.infer<typeof inputSchema>, "payload"> & {
	payload: Omit<z.infer<typeof inputSchema>["payload"], "products">;
};
export const xhsDraftPayloadSchema = inputSchema.shape.payload.omit({
	products: true,
});

function deny(code = "invalid_write_input"): never {
	throw new Error(code);
}

function scheduleUtc(input: string): string {
	const match =
		/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(
			input,
		);
	if (!match) deny("schedule_invalid");
	const day = Date.parse(`${match[1]}T00:00:00Z`);
	if (
		!Number.isFinite(day) ||
		new Date(day).toISOString().slice(0, 10) !== match[1] ||
		Number(match[2]) > 23 ||
		Number(match[3]) > 59 ||
		Number(match[4]) > 59
	)
		deny("schedule_invalid");
	const timestamp = Date.parse(input);
	if (!Number.isFinite(timestamp)) deny("schedule_invalid");
	return new Date(timestamp).toISOString();
}

/** Also called just before the provider lease commits, using provider time. */
export function validateSchedule(write: FrozenWrite, now: number): void {
	if (!Number.isSafeInteger(now) || now < 0) deny("schedule_invalid");
	if (write.payload.scheduleAt === null) return;
	const time = Date.parse(scheduleUtc(write.payload.scheduleAt));
	if (time < now + 3600000 || time > now + 14 * 86400000)
		deny("schedule_invalid");
}

/** Authority-derived identity/media enter here, never model-provided account proofs. */
export function freezeWrite(input: unknown, now: number): FrozenWrite {
	const value = typeof input === "string" ? parseStrictJson(input) : input;
	canonical(value);
	const parsed = inputSchema.safeParse(value);
	if (!parsed.success) deny();
	const { products, ...payload } = parsed.data.payload;
	if (products?.length) deny("dynamic_target_unbound");
	const result: FrozenWrite = { ...parsed.data, payload };
	const operation = result.operationId;
	const publish =
		operation === "xiaohongshu.publish_content" ||
		operation === "xiaohongshu.publish_with_video";
	const comment =
		operation === "xiaohongshu.post_comment_to_feed" ||
		operation === "xiaohongshu.reply_comment_in_feed";
	if (publish) {
		if (
			result.target !== null ||
			payload.title === null ||
			payload.content === null ||
			result.media.length === 0
		)
			deny();
		let titleUnits = 0;
		for (let i = 0; i < payload.title.length; i++)
			titleUnits += payload.title.charCodeAt(i) > 127 ? 2 : 1;
		if (Math.ceil(titleUnits / 2) > 20) deny();
		const video = operation === "xiaohongshu.publish_with_video";
		if (
			video
				? result.media.length !== 1 || result.media[0]?.mimeType !== "video/mp4"
				: result.media.some((media) => media.mimeType === "video/mp4")
		)
			deny();
		payload.visibility ??= "公开可见";
		payload.isOriginal ??= false;
		if (payload.unlike !== null || payload.unfavorite !== null) deny();
		if (payload.scheduleAt !== null)
			payload.scheduleAt = scheduleUtc(payload.scheduleAt);
	} else {
		if (result.target === null) deny("target_unbound");
		if (operation === "xiaohongshu.reply_comment_in_feed") {
			if (result.target.commentId === null) deny("target_unbound");
		} else if (
			result.target.commentId !== null ||
			result.target.userId !== null
		)
			deny("target_unbound");
		if (
			result.media.length ||
			payload.title !== null ||
			payload.tags.length ||
			payload.visibility !== null ||
			payload.isOriginal !== null ||
			payload.scheduleAt !== null ||
			products !== undefined
		)
			deny();
		if (comment ? payload.content === null : payload.content !== null) deny();
		if (operation === "xiaohongshu.like_feed") payload.unlike ??= false;
		else if (payload.unlike !== null) deny();
		if (operation === "xiaohongshu.favorite_feed") payload.unfavorite ??= false;
		else if (payload.unfavorite !== null) deny();
	}
	validateSchedule(result, now);
	return result;
}
