import { z } from "zod";
// Explicit inputs from the captured 2026-09-14 schemas; no live-schema auto-admission.
export const UPSTREAM_TOOL_ROWS = [
	{
		serverId: "xiaohongshu-mcp",
		toolName: "check_login_status",
		operationId: "xiaohongshu.check_login_status",
		classification: "read",
		writeDenial: null,
		input: z.object({}).strict(),
	},
	{
		serverId: "xiaohongshu-mcp",
		toolName: "delete_cookies",
		operationId: "xiaohongshu.delete_cookies",
		classification: "write",
		writeDenial: "unclassified_write",
		input: z.object({}).strict(),
	},
	{
		serverId: "xiaohongshu-mcp",
		toolName: "favorite_feed",
		operationId: "xiaohongshu.favorite_feed",
		classification: "write",
		writeDenial: "founder_write_gate_absent",
		input: z
			.object({
				feed_id: z.string().max(16000),
				unfavorite: z.boolean().optional(),
				resourceHandle: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
			})
			.strict(),
	},
	{
		serverId: "xiaohongshu-mcp",
		toolName: "get_collection_content",
		operationId: "xiaohongshu.get_collection_content",
		classification: "read",
		writeDenial: null,
		input: z
			.object({
				collection_id: z.string().max(16000),
				limit: z.number().int().min(1).max(200).optional(),
			})
			.strict(),
	},
	{
		serverId: "xiaohongshu-mcp",
		toolName: "get_feed_detail",
		operationId: "xiaohongshu.get_feed_detail",
		classification: "read",
		writeDenial: null,
		input: z
			.object({
				click_more_replies: z.boolean().optional(),
				feed_id: z.string().max(16000),
				limit: z.number().int().min(1).max(200).optional(),
				load_all_comments: z.boolean().optional(),
				reply_limit: z.number().int().min(1).max(200).optional(),
				scroll_speed: z.string().max(16000).optional(),
				resourceHandle: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
			})
			.strict(),
	},
	{
		serverId: "xiaohongshu-mcp",
		toolName: "get_login_qrcode",
		operationId: "xiaohongshu.get_login_qrcode",
		classification: "read",
		writeDenial: null,
		input: z.object({}).strict(),
	},
	{
		serverId: "xiaohongshu-mcp",
		toolName: "like_feed",
		operationId: "xiaohongshu.like_feed",
		classification: "write",
		writeDenial: "founder_write_gate_absent",
		input: z
			.object({
				feed_id: z.string().max(16000),
				unlike: z.boolean().optional(),
				resourceHandle: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
			})
			.strict(),
	},
	{
		serverId: "xiaohongshu-mcp",
		toolName: "list_collections",
		operationId: "xiaohongshu.list_collections",
		classification: "read",
		writeDenial: null,
		input: z
			.object({ limit: z.number().int().min(1).max(500).optional() })
			.strict(),
	},
	{
		serverId: "xiaohongshu-mcp",
		toolName: "list_feeds",
		operationId: "xiaohongshu.list_feeds",
		classification: "read",
		writeDenial: null,
		input: z.object({}).strict(),
	},
	{
		serverId: "xiaohongshu-mcp",
		toolName: "list_saved_content",
		operationId: "xiaohongshu.list_saved_content",
		classification: "read",
		writeDenial: null,
		input: z
			.object({ limit: z.number().int().min(1).max(200).optional() })
			.strict(),
	},
	{
		serverId: "xiaohongshu-mcp",
		toolName: "post_comment_to_feed",
		operationId: "xiaohongshu.post_comment_to_feed",
		classification: "write",
		writeDenial: "founder_write_gate_absent",
		input: z
			.object({
				content: z.string().max(16000),
				feed_id: z.string().max(16000),
				resourceHandle: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
			})
			.strict(),
	},
	{
		serverId: "xiaohongshu-mcp",
		toolName: "publish_content",
		operationId: "xiaohongshu.publish_content",
		classification: "write",
		writeDenial: "founder_write_gate_absent",
		input: z
			.object({
				content: z.string().max(16000),
				artifactHandles: z
					.array(z.string().regex(/^[A-Za-z0-9_-]{1,256}$/))
					.min(1)
					.max(18),
				is_original: z.boolean().optional(),
				products: z.array(z.string().max(16000)).max(100).optional(),
				schedule_at: z.string().max(16000).optional(),
				tags: z.array(z.string().max(16000)).max(100).optional(),
				title: z.string().max(16000),
				visibility: z.string().max(16000).optional(),
			})
			.strict(),
	},
	{
		serverId: "xiaohongshu-mcp",
		toolName: "publish_with_video",
		operationId: "xiaohongshu.publish_with_video",
		classification: "write",
		writeDenial: "founder_write_gate_absent",
		input: z
			.object({
				content: z.string().max(16000),
				products: z.array(z.string().max(16000)).max(100).optional(),
				schedule_at: z.string().max(16000).optional(),
				tags: z.array(z.string().max(16000)).max(100).optional(),
				title: z.string().max(16000),
				artifactHandle: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
				visibility: z.string().max(16000).optional(),
			})
			.strict(),
	},
	{
		serverId: "xiaohongshu-mcp",
		toolName: "reply_comment_in_feed",
		operationId: "xiaohongshu.reply_comment_in_feed",
		classification: "write",
		writeDenial: "founder_write_gate_absent",
		input: z
			.object({
				comment_id: z.string().max(16000).optional(),
				content: z.string().max(16000),
				feed_id: z.string().max(16000),
				user_id: z.string().max(16000).optional(),
				resourceHandle: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
			})
			.strict(),
	},
	{
		serverId: "xiaohongshu-mcp",
		toolName: "search_feeds",
		operationId: "xiaohongshu.search_feeds",
		classification: "read",
		writeDenial: null,
		input: z
			.object({
				filters: z
					.object({
						location: z.string().max(16000).optional(),
						note_type: z.string().max(16000).optional(),
						publish_time: z.string().max(16000).optional(),
						search_scope: z.string().max(16000).optional(),
						sort_by: z.string().max(16000).optional(),
					})
					.strict()
					.optional(),
				keyword: z.string().max(16000),
				limit: z.number().int().min(1).max(200).optional(),
			})
			.strict(),
	},
	{
		serverId: "xiaohongshu-mcp",
		toolName: "user_profile",
		operationId: "xiaohongshu.user_profile",
		classification: "read",
		writeDenial: null,
		input: z
			.object({
				user_id: z.string().max(16000),
				resourceHandle: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
			})
			.strict(),
	},
] as const;
