/**
 * GEO-195: ForumPostCreator — Bridge creates Forum Posts directly via Discord API.
 * Previously, OpenClaw Lead handled this via discord:thread-create.
 * Claude Lead can't create threads (Discord MCP plugin limitation),
 * so Bridge does it automatically when session_started has no thread_id.
 */

import type { StateStore } from "../StateStore.js";

const DISCORD_API = "https://discord.com/api/v10";

export interface ForumPostContext {
	forumChannelId: string;
	issueId: string;
	issueIdentifier?: string;
	issueTitle?: string;
	executionId: string;
	status: string;
	discordBotToken?: string;
	/** Initial tag IDs to apply (from statusTagMap). */
	appliedTags?: string[];
}

export interface ForumPostResult {
	created: boolean;
	threadId?: string;
	error?: string;
}

export class ForumPostCreator {
	constructor(
		private store: StateStore,
		private statusTagMap: Record<string, string[]>,
	) {}

	/**
	 * Create a Forum Post for an issue if no thread exists yet.
	 * Idempotent — skips if a thread is already mapped for this issue.
	 */
	async ensureForumPost(ctx: ForumPostContext): Promise<ForumPostResult> {
		// Already has a thread — skip
		const existing = this.store.getThreadByIssue(ctx.issueId);
		if (existing) {
			return { created: false, threadId: existing.thread_id };
		}

		if (!ctx.discordBotToken) {
			return { created: false, error: "no discord bot token" };
		}

		const threadName = ctx.issueIdentifier
			? `[${ctx.issueIdentifier}] ${ctx.issueTitle ?? ""}`
			: ctx.issueTitle ?? ctx.issueId;

		const content = [
			`**Issue**: ${ctx.issueIdentifier ?? ctx.issueId}`,
			ctx.issueTitle ? `**Title**: ${ctx.issueTitle}` : null,
			`**Execution**: \`${ctx.executionId}\``,
			`**Status**: ${ctx.status}`,
		]
			.filter(Boolean)
			.join("\n");

		// Resolve initial tags from statusTagMap
		const appliedTags = ctx.appliedTags ?? this.statusTagMap[ctx.status] ?? [];

		try {
			const res = await fetch(
				`${DISCORD_API}/channels/${ctx.forumChannelId}/threads`,
				{
					method: "POST",
					headers: {
						Authorization: `Bot ${ctx.discordBotToken}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						name: threadName.slice(0, 100), // Discord limit
						message: { content },
						applied_tags: appliedTags,
					}),
				},
			);

			if (!res.ok) {
				const body = await res.text().catch(() => "");
				console.warn(
					`[ForumPostCreator] Discord returned ${res.status}: ${body.slice(0, 200)}`,
				);
				return { created: false, error: `Discord ${res.status}` };
			}

			const data = (await res.json()) as { id?: string };
			const threadId = data.id;
			if (!threadId) {
				return { created: false, error: "no thread ID in response" };
			}

			// Write back to StateStore
			this.store.upsertThread(threadId, ctx.forumChannelId, ctx.issueId);
			this.store.setSessionThreadId(ctx.executionId, threadId);

			console.log(
				`[ForumPostCreator] Created Forum Post for ${ctx.issueIdentifier ?? ctx.issueId}: ${threadId}`,
			);
			return { created: true, threadId };
		} catch (err) {
			console.warn(
				`[ForumPostCreator] Failed for ${ctx.issueIdentifier ?? ctx.issueId}:`,
				(err as Error).message,
			);
			return { created: false, error: (err as Error).message };
		}
	}
}
