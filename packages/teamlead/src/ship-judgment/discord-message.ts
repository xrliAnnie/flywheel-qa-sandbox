import { z } from "zod";
export const discordId = z.string().regex(/^[0-9]{17,20}$/);
export const discordMessage = z.object({
	id: discordId,
	channel_id: discordId,
	author: z.object({ id: discordId, bot: z.boolean().optional() }),
	content: z.string().max(4000),
	timestamp: z.string().datetime({ offset: true }),
	edited_timestamp: z.string().datetime({ offset: true }).nullable().optional(),
});
export async function readDiscordJson(
	response: Response,
	signal: AbortSignal,
	limit: number,
): Promise<unknown> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("discord_body_missing");
	const parts: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			signal.throwIfAborted();
			const part = await reader.read();
			if (part.done) break;
			size += part.value.byteLength;
			if (size > limit) throw new Error("discord_body_budget");
			parts.push(part.value);
		}
	} finally {
		await reader.cancel();
		reader.releaseLock();
	}
	return JSON.parse(Buffer.concat(parts).toString("utf8"));
}
