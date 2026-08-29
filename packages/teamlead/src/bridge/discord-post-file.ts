/**
 * FLY-203: postDiscordMessageWithFile — post ONE Discord message with a file
 * attachment via multipart/form-data.
 *
 * The existing Bridge Discord senders (discord-utils.ts and friends) are
 * JSON/text-only. The remote report pipeline needs "screenshot attachment +
 * link" in a single message, posted by the Bridge itself (the GEO-151
 * artifact_delivery chain requires a Runner session, which report producers
 * like team-lead/Simba don't have).
 *
 * Takes the file CONTENT as a Buffer, not a path (code review R1#2): the
 * route layer reads + validates the file through a single pinned fd
 * (reports-route.ts readPreviewFile), so a caller racing a file swap after
 * validation cannot change what gets posted.
 *
 * Discipline carried over from discord-utils.ts:
 *   - `allowed_mentions: { parse: [] }` — user-influenced content can never
 *     trigger a real ping.
 *   - error envelope instead of throws, so callers map to HTTP 502 verbatim.
 */

import { markAutomatedDiscordText } from "./automated-message.js";
import { DISCORD_API } from "./discord-utils.js";

export interface DiscordFileAttachment {
	data: Buffer;
	filename: string;
}

export type PostFileResult =
	| { ok: true; messageId: string }
	| { ok: false; error: string };

/**
 * Post `content` + the attachment to a Discord channel as a bot.
 */
export async function postDiscordMessageWithFile(
	channelId: string,
	content: string,
	file: DiscordFileAttachment,
	botToken: string,
	fetchImpl: typeof fetch = fetch,
): Promise<PostFileResult> {
	const form = new FormData();
	form.append(
		"payload_json",
		JSON.stringify({
			content: markAutomatedDiscordText(content),
			allowed_mentions: { parse: [] },
			attachments: [{ id: 0, filename: file.filename }],
		}),
	);
	form.append(
		"files[0]",
		new Blob([new Uint8Array(file.data)], { type: "image/png" }),
		file.filename,
	);

	let res: Response;
	try {
		res = await fetchImpl(`${DISCORD_API}/channels/${channelId}/messages`, {
			method: "POST",
			headers: {
				Authorization: `Bot ${botToken}`,
				// NOTE: no Content-Type header — fetch sets the multipart
				// boundary itself when the body is FormData.
			},
			body: form,
		});
	} catch (err) {
		return {
			ok: false,
			error: `Discord POST failed: ${(err as Error).message}`,
		};
	}

	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		return {
			ok: false,
			error: `Discord ${res.status}: ${detail.slice(0, 200)}`,
		};
	}

	let data: { id?: string };
	try {
		data = (await res.json()) as { id?: string };
	} catch (err) {
		return {
			ok: false,
			error: `Discord response not JSON: ${(err as Error).message}`,
		};
	}

	if (!data.id) {
		return { ok: false, error: "Discord response missing message id" };
	}

	return { ok: true, messageId: data.id };
}
