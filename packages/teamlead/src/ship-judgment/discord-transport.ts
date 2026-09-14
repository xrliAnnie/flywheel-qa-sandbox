import { markAutomatedDiscordText } from "../bridge/automated-message.js";
import {
	discordId,
	discordMessage,
	readDiscordJson,
} from "./discord-message.js";
import type { SendReceipt } from "./sender.js";

/** Single request only: durable sender owns retries and reservations, and preserves server visibility time. */
export async function writeJudgmentMessage(input: {
	threadId: string;
	cardMessageId: string;
	messageId?: string;
	botUserId: string;
	botToken: string;
	content: string;
	signal: AbortSignal;
	fetchImpl?: typeof fetch;
	now?: () => number;
}): Promise<SendReceipt> {
	const content = markAutomatedDiscordText(input.content);
	if (
		content.length > 2000 ||
		![
			input.threadId,
			input.cardMessageId,
			input.botUserId,
			...(input.messageId ? [input.messageId] : []),
		].every((id) => discordId.safeParse(id).success)
	)
		return { kind: "failed" };
	try {
		input.signal.throwIfAborted();
		const response = await (input.fetchImpl ?? fetch)(
			`https://discord.com/api/v10/channels/${input.threadId}/messages${input.messageId ? `/${input.messageId}` : ""}`,
			{
				method: input.messageId ? "PATCH" : "POST",
				headers: {
					Authorization: `Bot ${input.botToken}`,
					"Content-Type": "application/json",
				},
				signal: input.signal,
				redirect: "error",
				body: JSON.stringify({
					content,
					allowed_mentions: { parse: [] },
					...(!input.messageId
						? {
								message_reference: {
									message_id: input.cardMessageId,
									fail_if_not_exists: true,
								},
							}
						: {}),
				}),
			},
		);
		if (response.status === 429) {
			const payload = (await readDiscordJson(response, input.signal, 4096)) as {
				retry_after?: unknown;
			};
			const seconds =
				typeof payload?.retry_after === "number"
					? payload.retry_after
					: Number(response.headers.get("retry-after"));
			return {
				kind: "failed",
				...(Number.isFinite(seconds) && seconds > 0 && seconds <= 86400
					? { retryAt: (input.now ?? Date.now)() + Math.ceil(seconds * 1000) }
					: {}),
			};
		}
		if (!response.ok) {
			await response.body?.cancel();
			return { kind: response.status >= 500 ? "uncertain" : "failed" };
		}
		const parsed = discordMessage.safeParse(
			await readDiscordJson(response, input.signal, 64 * 1024),
		);
		if (!parsed.success) return { kind: "uncertain" };
		const row = parsed.data;
		if (
			row.channel_id !== input.threadId ||
			row.author.id !== input.botUserId ||
			row.author.bot !== true ||
			row.content !== content ||
			(input.messageId && row.id !== input.messageId)
		)
			return { kind: "uncertain" };
		// A PATCH cannot use the original creation time as its new visibility receipt.
		if (input.messageId && !row.edited_timestamp) return { kind: "uncertain" };
		const visibleAt = new Date(
			row.edited_timestamp ?? row.timestamp,
		).toISOString();
		if (Date.parse(visibleAt) < Date.parse(row.timestamp))
			return { kind: "uncertain" };
		return { kind: "posted", messageId: row.id, visibleAt };
	} catch {
		return { kind: "uncertain" };
	}
}
