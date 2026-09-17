import { z } from "zod";

export const privateReadOperation = z.enum([
	"list_feeds",
	"search_feeds",
	"get_feed_detail",
	"user_profile",
	"list_collections",
	"get_collection_content",
	"list_saved_content",
]);
export const publicListOperation = privateReadOperation.exclude([
	"get_feed_detail",
	"user_profile",
]);
export type PublicListOperation = z.infer<typeof publicListOperation>;
export type PrivateReadOperation = z.infer<typeof privateReadOperation>;
const id = z
	.string()
	.min(1)
	.max(256)
	.regex(/^[^?#/\\]+$/)
	.refine((value) =>
		[...value].every((character) => character.charCodeAt(0) >= 32),
	);
const token = z
	.string()
	.min(8)
	.max(4096)
	.refine(
		(value) => Buffer.byteLength(value) <= 4096 && !/[\0\r\n]/.test(value),
	);
const limit = z.number().int().min(1).max(200).default(20);
const filters = z
	.object({
		sort_by: z
			.enum(["", "综合", "最新", "最多点赞", "最多评论", "最多收藏"])
			.default(""),
		note_type: z.enum(["", "不限", "视频", "图文"]).default(""),
		publish_time: z
			.enum(["", "不限", "一天内", "一周内", "半年内"])
			.default(""),
		search_scope: z
			.enum(["", "不限", "已看过", "未看过", "已关注"])
			.default(""),
		location: z.enum(["", "不限", "同城", "附近"]).default(""),
	})
	.strict()
	.default({
		sort_by: "",
		note_type: "",
		publish_time: "",
		search_scope: "",
		location: "",
	});
/** Private wire only: raw tokens are supplied by the authority's observed
 * resource map, never by a model-facing tool. Matches Go expanded input fields. */
export const privateReadInputs = {
	list_feeds: z.object({}).strict(),
	search_feeds: z
		.object({
			keyword: z
				.string()
				.max(16000)
				.refine((value) => value.trim().length > 0),
			filters,
			limit,
		})
		.strict(),
	get_feed_detail: z
		.object({
			feed_id: id,
			xsec_token: token,
			load_all_comments: z.boolean().default(false),
			limit,
			click_more_replies: z.boolean().default(false),
			reply_limit: z.number().int().min(1).max(200).default(10),
			scroll_speed: z.enum(["slow", "normal", "fast"]).default("normal"),
		})
		.strict(),
	user_profile: z.object({ user_id: id, xsec_token: token }).strict(),
	list_collections: z
		.object({ limit: z.number().int().min(1).max(500).default(20) })
		.strict(),
	get_collection_content: z.object({ collection_id: id, limit }).strict(),
	list_saved_content: z.object({ limit }).strict(),
};
const record = z.record(z.string(), z.unknown());
const rows = z.array(record).max(1000).nullable();
const count = z.number().int().min(0).max(1000);
const feeds = z
	.object({ feeds: rows, count })
	.strict()
	.refine((value) => value.count === (value.feeds?.length ?? 0));
export const privateReadData = {
	list_feeds: feeds,
	search_feeds: feeds,
	get_feed_detail: z
		.object({
			feed_id: id,
			data: z.object({ note: record, comments: record }).strict(),
		})
		.strict(),
	user_profile: z
		.object({ userBasicInfo: record, interactions: rows, feeds: rows })
		.strict(),
	list_collections: z.array(record).max(500),
	get_collection_content: z
		.object({ notes: rows, count, total: z.number().int().nonnegative() })
		.strict()
		.refine((value) => value.count === (value.notes?.length ?? 0)),
	list_saved_content: feeds,
};

export const publicDetailInput = privateReadInputs.get_feed_detail
	.omit({ xsec_token: true })
	.extend({ resourceHandle: z.string().uuid() })
	.strict();

export const publicReadOperation = z.enum([
	...publicListOperation.options,
	"get_feed_detail",
]);
export type PublicReadOperation = z.infer<typeof publicReadOperation>;
export const publicReadInputs = {
	list_feeds: privateReadInputs.list_feeds,
	search_feeds: privateReadInputs.search_feeds,
	list_saved_content: privateReadInputs.list_saved_content,
	list_collections: privateReadInputs.list_collections,
	get_collection_content: privateReadInputs.get_collection_content,
	get_feed_detail: publicDetailInput,
};
