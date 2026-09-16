import { z } from "zod";
// Explicit inputs from the captured 2026-09-14 schemas; no live-schema auto-admission.
export const UPSTREAM_TOOL_ROWS = [
	{
		serverId: "gbrain",
		toolName: "add_link",
		operationId: "knowledge.add_link",
		classification: "write",
		writeDenial: "unclassified_write",
		input: z
			.object({
				from: z.string().max(16000),
				to: z.string().max(16000),
				link_type: z.string().max(16000).optional(),
				context: z.string().max(16000).optional(),
			})
			.strict(),
	},
	{
		serverId: "gbrain",
		toolName: "add_tag",
		operationId: "knowledge.add_tag",
		classification: "write",
		writeDenial: "unclassified_write",
		input: z
			.object({ slug: z.string().max(16000), tag: z.string().max(16000) })
			.strict(),
	},
	{
		serverId: "gbrain",
		toolName: "add_timeline_entry",
		operationId: "knowledge.add_timeline_entry",
		classification: "write",
		writeDenial: "unclassified_write",
		input: z
			.object({
				slug: z.string().max(16000),
				date: z.string().max(16000),
				summary: z.string().max(16000),
				detail: z.string().max(16000).optional(),
				source: z.string().max(16000).optional(),
			})
			.strict(),
	},
	{
		serverId: "gbrain",
		toolName: "delete_page",
		operationId: "knowledge.delete_page",
		classification: "write",
		writeDenial: "unclassified_write",
		input: z.object({ slug: z.string().max(16000) }).strict(),
	},
	{
		serverId: "gbrain",
		toolName: "file_list",
		operationId: "knowledge.file_list",
		classification: "read",
		writeDenial: null,
		input: z.object({ slug: z.string().max(16000).optional() }).strict(),
	},
	{
		serverId: "gbrain",
		toolName: "file_upload",
		operationId: "knowledge.file_upload",
		classification: "write",
		writeDenial: "unclassified_write",
		input: z
			.object({
				artifactHandle: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
				page_slug: z.string().max(16000).optional(),
			})
			.strict(),
	},
	{
		serverId: "gbrain",
		toolName: "file_url",
		operationId: "knowledge.file_url",
		classification: "read",
		writeDenial: null,
		input: z.object({ storage_path: z.string().max(16000) }).strict(),
	},
	{
		serverId: "gbrain",
		toolName: "get_backlinks",
		operationId: "knowledge.get_backlinks",
		classification: "read",
		writeDenial: null,
		input: z.object({ slug: z.string().max(16000) }).strict(),
	},
	{
		serverId: "gbrain",
		toolName: "get_chunks",
		operationId: "knowledge.get_chunks",
		classification: "read",
		writeDenial: null,
		input: z.object({ slug: z.string().max(16000) }).strict(),
	},
	{
		serverId: "gbrain",
		toolName: "get_health",
		operationId: "knowledge.get_health",
		classification: "read",
		writeDenial: null,
		input: z.object({}).strict(),
	},
	{
		serverId: "gbrain",
		toolName: "get_ingest_log",
		operationId: "knowledge.get_ingest_log",
		classification: "read",
		writeDenial: null,
		input: z
			.object({ limit: z.number().int().min(1).max(1000).optional() })
			.strict(),
	},
	{
		serverId: "gbrain",
		toolName: "get_links",
		operationId: "knowledge.get_links",
		classification: "read",
		writeDenial: null,
		input: z.object({ slug: z.string().max(16000) }).strict(),
	},
	{
		serverId: "gbrain",
		toolName: "get_page",
		operationId: "knowledge.get_page",
		classification: "read",
		writeDenial: null,
		input: z
			.object({ slug: z.string().max(16000), fuzzy: z.boolean().optional() })
			.strict(),
	},
	{
		serverId: "gbrain",
		toolName: "get_raw_data",
		operationId: "knowledge.get_raw_data",
		classification: "read",
		writeDenial: null,
		input: z
			.object({
				slug: z.string().max(16000),
				source: z.string().max(16000).optional(),
			})
			.strict(),
	},
	{
		serverId: "gbrain",
		toolName: "get_stats",
		operationId: "knowledge.get_stats",
		classification: "read",
		writeDenial: null,
		input: z.object({}).strict(),
	},
	{
		serverId: "gbrain",
		toolName: "get_tags",
		operationId: "knowledge.get_tags",
		classification: "read",
		writeDenial: null,
		input: z.object({ slug: z.string().max(16000) }).strict(),
	},
	{
		serverId: "gbrain",
		toolName: "get_timeline",
		operationId: "knowledge.get_timeline",
		classification: "read",
		writeDenial: null,
		input: z.object({ slug: z.string().max(16000) }).strict(),
	},
	{
		serverId: "gbrain",
		toolName: "get_versions",
		operationId: "knowledge.get_versions",
		classification: "read",
		writeDenial: null,
		input: z.object({ slug: z.string().max(16000) }).strict(),
	},
	{
		serverId: "gbrain",
		toolName: "list_pages",
		operationId: "knowledge.list_pages",
		classification: "read",
		writeDenial: null,
		input: z
			.object({
				type: z.string().max(16000).optional(),
				tag: z.string().max(16000).optional(),
				limit: z.number().int().min(1).max(1000).optional(),
			})
			.strict(),
	},
	{
		serverId: "gbrain",
		toolName: "log_ingest",
		operationId: "knowledge.log_ingest",
		classification: "write",
		writeDenial: "unclassified_write",
		input: z
			.object({
				source_type: z.string().max(16000),
				source_ref: z.string().max(16000),
				pages_updated: z.array(z.string().max(16000)).max(100),
				summary: z.string().max(16000),
			})
			.strict(),
	},
	{
		serverId: "gbrain",
		toolName: "put_page",
		operationId: "knowledge.put_page",
		classification: "write",
		writeDenial: "unclassified_write",
		input: z
			.object({ slug: z.string().max(16000), content: z.string().max(16000) })
			.strict(),
	},
	{
		serverId: "gbrain",
		toolName: "put_raw_data",
		operationId: "knowledge.put_raw_data",
		classification: "write",
		writeDenial: "unclassified_write",
		input: z
			.object({
				slug: z.string().max(16000),
				source: z.string().max(16000),
				data: z.record(z.string(), z.unknown()),
			})
			.strict(),
	},
	{
		serverId: "gbrain",
		toolName: "query",
		operationId: "knowledge.query",
		classification: "read",
		writeDenial: null,
		input: z
			.object({
				query: z.string().max(16000),
				limit: z.number().int().min(1).max(1000).optional(),
				expand: z.boolean().optional(),
			})
			.strict(),
	},
	{
		serverId: "gbrain",
		toolName: "remove_link",
		operationId: "knowledge.remove_link",
		classification: "write",
		writeDenial: "unclassified_write",
		input: z
			.object({ from: z.string().max(16000), to: z.string().max(16000) })
			.strict(),
	},
	{
		serverId: "gbrain",
		toolName: "remove_tag",
		operationId: "knowledge.remove_tag",
		classification: "write",
		writeDenial: "unclassified_write",
		input: z
			.object({ slug: z.string().max(16000), tag: z.string().max(16000) })
			.strict(),
	},
	{
		serverId: "gbrain",
		toolName: "resolve_slugs",
		operationId: "knowledge.resolve_slugs",
		classification: "read",
		writeDenial: null,
		input: z.object({ partial: z.string().max(16000) }).strict(),
	},
	{
		serverId: "gbrain",
		toolName: "revert_version",
		operationId: "knowledge.revert_version",
		classification: "write",
		writeDenial: "unclassified_write",
		input: z
			.object({ slug: z.string().max(16000), version_id: z.number().finite() })
			.strict(),
	},
	{
		serverId: "gbrain",
		toolName: "search",
		operationId: "knowledge.search",
		classification: "read",
		writeDenial: null,
		input: z
			.object({
				query: z.string().max(16000),
				limit: z.number().int().min(1).max(1000).optional(),
			})
			.strict(),
	},
	{
		serverId: "gbrain",
		toolName: "sync_brain",
		operationId: "knowledge.sync_brain",
		classification: "write",
		writeDenial: "unclassified_write",
		input: z
			.object({
				repo: z.string().max(16000).optional(),
				dry_run: z.boolean().optional(),
				full: z.boolean().optional(),
				no_pull: z.boolean().optional(),
				no_embed: z.boolean().optional(),
			})
			.strict(),
	},
	{
		serverId: "gbrain",
		toolName: "traverse_graph",
		operationId: "knowledge.traverse_graph",
		classification: "read",
		writeDenial: null,
		input: z
			.object({
				slug: z.string().max(16000),
				depth: z.number().int().min(1).max(1000).optional(),
			})
			.strict(),
	},
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
