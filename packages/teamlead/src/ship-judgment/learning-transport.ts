import { z } from "zod";
import { discordId, readDiscordJson } from "./discord-message.js";
import { writeJudgmentMessage } from "./discord-transport.js";
import type { SendReceipt } from "./sender.js";
export type LearningSendReceipt =
	| SendReceipt
	| { kind: "unavailable"; code: string };
/** Read the thread immediately before sending; never issue an unarchive or channel mutation. */
export async function writeLearningMessage(input: {
	threadId: string;
	guildId: string;
	replyTo: string;
	botUserId: string;
	botToken: string;
	content: string;
	signal: AbortSignal;
	fetchImpl?: typeof fetch;
	now?: () => number;
	canPost?: () => boolean;
}): Promise<LearningSendReceipt> {
	if (
		![input.threadId, input.guildId, input.replyTo, input.botUserId].every(
			(value) => discordId.safeParse(value).success,
		)
	)
		return { kind: "failed" };
	const fetchImpl = input.fetchImpl ?? fetch;
	try {
		input.signal.throwIfAborted();
		const response = await fetchImpl(
			`https://discord.com/api/v10/channels/${input.threadId}`,
			{
				headers: { Authorization: `Bot ${input.botToken}` },
				signal: input.signal,
				redirect: "error",
			},
		);
		if (response.status === 403 || response.status === 404) {
			await response.body?.cancel();
			return {
				kind: "unavailable",
				code: response.status === 403 ? "discord_forbidden" : "thread_missing",
			};
		}
		if (response.status === 429) {
			const body = (await readDiscordJson(response, input.signal, 4096)) as {
				retry_after?: unknown;
			};
			const seconds = Number(
				body?.retry_after ?? response.headers.get("retry-after"),
			);
			return {
				kind: "failed",
				...(Number.isFinite(seconds) && seconds > 0 && seconds <= 86400
					? { retryAt: (input.now ?? Date.now)() + Math.ceil(seconds * 1000) }
					: {}),
			};
		}
		if (!response.ok) {
			await response.body?.cancel();
			return { kind: "failed" };
		}
		const parsed = z
			.object({
				id: discordId,
				guild_id: discordId,
				type: z.union([z.literal(10), z.literal(11), z.literal(12)]),
				thread_metadata: z.object({
					archived: z.boolean(),
					locked: z.boolean().optional(),
				}),
			})
			.safeParse(await readDiscordJson(response, input.signal, 65536));
		if (
			!parsed.success ||
			parsed.data.id !== input.threadId ||
			parsed.data.guild_id !== input.guildId
		)
			return { kind: "unavailable", code: "thread_identity_invalid" };
		if (parsed.data.thread_metadata.archived)
			return { kind: "unavailable", code: "thread_archived" };
		if (parsed.data.thread_metadata.locked)
			return { kind: "unavailable", code: "thread_locked" };
	} catch {
		return { kind: "failed" };
	}
	let unavailable: string | undefined;
	if (input.signal.aborted || input.canPost?.() === false)
		return { kind: "failed" };
	const result = await writeJudgmentMessage({
		...input,
		cardMessageId: input.replyTo,
		fetchImpl: async (url, init) => {
			const response = await fetchImpl(url, init);
			if (response.status === 403 || response.status === 404)
				unavailable =
					response.status === 403 ? "discord_forbidden" : "thread_missing";
			return response;
		},
	});
	return unavailable ? { kind: "unavailable", code: unavailable } : result;
}
