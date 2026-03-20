export interface TagUpdateContext {
	threadId?: string;
	status: string;
	eventType: string;
	action?: string;
	discordBotToken?: string;
}

export type TagUpdateResult =
	| "skipped"
	| "attempted"
	| "succeeded"
	| "failed"
	| "no_thread";

/** Actions that should NOT trigger a Forum tag update. */
const SKIP_ACTIONS = new Set(["retry", "reject", "defer", "shelve"]);

export class ForumTagUpdater {
	constructor(private readonly statusTagMap: Record<string, string[]>) {}

	async updateTag(ctx: TagUpdateContext): Promise<TagUpdateResult> {
		if (!ctx.threadId) return "no_thread";
		if (!ctx.discordBotToken) return "skipped";
		if (ctx.action && SKIP_ACTIONS.has(ctx.action)) return "skipped";

		const tagIds = this.statusTagMap[ctx.status];
		if (!tagIds) return "skipped";

		try {
			const res = await fetch(
				`https://discord.com/api/v10/channels/${ctx.threadId}`,
				{
					method: "PATCH",
					headers: {
						Authorization: `Bot ${ctx.discordBotToken}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ applied_tags: tagIds }),
				},
			);
			if (!res.ok) {
				const body = await res.text();
				console.warn(
					`[ForumTagUpdater] Discord returned ${res.status}: ${body}`,
				);
				return "failed";
			}
			return "succeeded";
		} catch (err) {
			console.warn(
				"[ForumTagUpdater] Discord API call failed:",
				(err as Error).message,
			);
			return "failed";
		}
	}
}
