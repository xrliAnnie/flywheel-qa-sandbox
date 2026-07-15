/**
 * Shared Discord utilities used by standup-service and FLY-162 reply-by-issue.
 */

import {
	type DiscordMessageOrigin,
	markAutomatedDiscordText,
} from "./automated-message.js";

export const DISCORD_API = "https://discord.com/api/v10";
export const MAX_DISCORD_MESSAGE_LENGTH = 1900; // Discord limit is 2000, leave margin

/**
 * Split a message into chunks that fit within Discord's message length limit.
 * Splits at newline boundaries when possible.
 *
 * NOTE: Trims leading whitespace from each subsequent chunk (see `trimStart`
 * below). FLY-162 callers that build `remainingText` should compare against
 * helper output, not byte-identical to the original input.
 */
export function splitDiscordMessage(content: string): string[] {
	if (content.length <= MAX_DISCORD_MESSAGE_LENGTH) return [content];
	const chunks: string[] = [];
	let remaining = content;
	while (remaining.length > 0) {
		if (remaining.length <= MAX_DISCORD_MESSAGE_LENGTH) {
			chunks.push(remaining);
			break;
		}
		// Split at last newline within limit
		const cutoff = remaining.lastIndexOf("\n", MAX_DISCORD_MESSAGE_LENGTH);
		const splitAt = cutoff > 0 ? cutoff : MAX_DISCORD_MESSAGE_LENGTH;
		chunks.push(remaining.slice(0, splitAt));
		remaining = remaining.slice(splitAt).trimStart();
	}
	return chunks;
}

// ──────────────────────────────────────────────────────────────────────
// FLY-162 P2: postDiscordMessageToChannel — split + sequential POST
// helper, fail-fast on first chunk failure, returns enough metadata for
// the caller (`/api/chat-threads/send` route) to surface a recovery
// envelope. Every POST sets `allowed_mentions: { parse: [] }` so a Lead
// text containing `@everyone`/`@here`/role mentions cannot trigger a
// real ping (plan §4.1 + AC4 + Codex Round 2 issue #7).
// ──────────────────────────────────────────────────────────────────────

/** Successful end-to-end post. */
export interface PostDiscordOk {
	ok: true;
	messageIds: string[];
}

/**
 * Partial / total failure envelope. The caller wraps this into the HTTP
 * 502 response body for `/api/chat-threads/send`:
 *   { error, threadId, messageIds, chunksSent, chunksTotal,
 *     failedChunkIndex, remainingText }
 * The Lead resends `remainingText` directly as the `text` field on the
 * next `send` call — NOT the original whole text (plan §Q6.1 + AC4 +
 * Codex Round 3 issue #3).
 */
export interface PostDiscordPartial {
	ok: false;
	error: string;
	messageIds: string[];
	chunksSent: number;
	chunksTotal: number;
	failedChunkIndex: number;
	remainingText: string;
}

export type PostDiscordResult = PostDiscordOk | PostDiscordPartial;

export interface PostDiscordOptions {
	/** Semantic author of the text; the bot token is only a transport identity. */
	origin: DiscordMessageOrigin;
	/** Discord `message_reference.message_id` — attached only to the FIRST chunk. */
	replyTo?: string;
}

/** Build the unsent-suffix recovery text from the chunk list. */
function buildRemainingText(chunks: string[], failedIndex: number): string {
	return chunks.slice(failedIndex).join("\n");
}

/**
 * Post `text` to a Discord channel/thread as a bot. Splits long text via
 * `splitDiscordMessage`, posts each chunk sequentially, fails fast on
 * the first non-OK response. Returns enough metadata for the route
 * layer to assemble both success and partial-failure responses.
 *
 * `fetchImpl` is injectable so unit tests can mock without touching the
 * network; defaults to the global `fetch`.
 */
export async function postDiscordMessageToChannel(
	threadId: string,
	text: string,
	botToken: string,
	options: PostDiscordOptions,
	fetchImpl: typeof fetch = fetch,
): Promise<PostDiscordResult> {
	const chunks = splitDiscordMessage(text).map((chunk) =>
		options.origin === "automation" ? markAutomatedDiscordText(chunk) : chunk,
	);
	const url = `${DISCORD_API}/channels/${threadId}/messages`;
	const messageIds: string[] = [];

	for (let i = 0; i < chunks.length; i++) {
		const body: Record<string, unknown> = {
			content: chunks[i],
			// FLY-162 Codex R2 #7: never let user-supplied text trigger pings
			allowed_mentions: { parse: [] },
		};
		// Discord `message_reference` only valid on first chunk
		if (i === 0 && options.replyTo) {
			body.message_reference = { message_id: options.replyTo };
		}

		let res: Response;
		try {
			res = await fetchImpl(url, {
				method: "POST",
				headers: {
					Authorization: `Bot ${botToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				ok: false,
				error: `Discord POST failed: ${msg}`,
				messageIds,
				chunksSent: messageIds.length,
				chunksTotal: chunks.length,
				failedChunkIndex: i,
				remainingText: buildRemainingText(chunks, i),
			};
		}

		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			return {
				ok: false,
				error: `Discord ${res.status}: ${detail.slice(0, 200)}`,
				messageIds,
				chunksSent: messageIds.length,
				chunksTotal: chunks.length,
				failedChunkIndex: i,
				remainingText: buildRemainingText(chunks, i),
			};
		}

		let data: { id?: string };
		try {
			data = (await res.json()) as { id?: string };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				ok: false,
				error: `Discord response not JSON: ${msg}`,
				messageIds,
				chunksSent: messageIds.length,
				chunksTotal: chunks.length,
				failedChunkIndex: i,
				remainingText: buildRemainingText(chunks, i),
			};
		}

		if (!data.id) {
			return {
				ok: false,
				error: "Discord response missing message id",
				messageIds,
				chunksSent: messageIds.length,
				chunksTotal: chunks.length,
				failedChunkIndex: i,
				remainingText: buildRemainingText(chunks, i),
			};
		}

		messageIds.push(data.id);
	}

	return { ok: true, messageIds };
}

export type EditDiscordResult =
	| { ok: true }
	| { ok: false; status?: number; error: string };

/**
 * FLY-887 (founder-visibility status line): edit an existing Discord message
 * in place (`PATCH /channels/{id}/messages/{id}`). Single-chunk only — callers
 * with a short, bounded status line don't need `splitDiscordMessage`. Returns
 * `status: 404` distinctly (never throws) so a caller can tell "message was
 * deleted, repost fresh" apart from a transient failure worth leaving alone.
 */
export async function editDiscordMessageInChannel(
	threadId: string,
	messageId: string,
	text: string,
	botToken: string,
	options: Pick<PostDiscordOptions, "origin">,
	fetchImpl: typeof fetch = fetch,
): Promise<EditDiscordResult> {
	const content =
		options.origin === "automation" ? markAutomatedDiscordText(text) : text;
	let res: Response;
	try {
		res = await fetchImpl(
			`${DISCORD_API}/channels/${threadId}/messages/${messageId}`,
			{
				method: "PATCH",
				headers: {
					Authorization: `Bot ${botToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					content,
					allowed_mentions: { parse: [] },
				}),
			},
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `Discord PATCH failed: ${msg}` };
	}
	if (res.ok) return { ok: true };
	const detail = await res.text().catch(() => "");
	return {
		ok: false,
		status: res.status,
		error: `Discord ${res.status}: ${detail.slice(0, 200)}`,
	};
}

/**
 * FLY-907 (Lead directive 17ab4f53 — converge status into the pinned block):
 * delete a message the system previously scattered into a thread (the legacy
 * standalone phase-status line). A 404 counts as ok — the message is already
 * gone, which is the desired end state. Never throws.
 */
export async function deleteDiscordMessageInChannel(
	threadId: string,
	messageId: string,
	botToken: string,
	fetchImpl: typeof fetch = fetch,
): Promise<EditDiscordResult> {
	let res: Response;
	try {
		res = await fetchImpl(
			`${DISCORD_API}/channels/${threadId}/messages/${messageId}`,
			{
				method: "DELETE",
				headers: { Authorization: `Bot ${botToken}` },
			},
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `Discord DELETE failed: ${msg}` };
	}
	if (res.ok || res.status === 404) return { ok: true };
	const detail = await res.text().catch(() => "");
	return {
		ok: false,
		status: res.status,
		error: `Discord ${res.status}: ${detail.slice(0, 200)}`,
	};
}

// ──────────────────────────────────────────────────────────────────────
// FLY-404: sendTypingToChannel — trigger the Discord "typing…" indicator.
// ──────────────────────────────────────────────────────────────────────

/**
 * Trigger the Discord "typing…" indicator in a channel/thread as a bot
 * (`POST /channels/{id}/typing` → 204 No Content). The indicator auto-expires
 * after ~10 seconds, so a caller that wants sustained typing must re-call on an
 * interval (see `DiscordTypingNotifier`).
 *
 * This is intentionally a BODY-LESS POST: the typing endpoint creates NO message,
 * so it can never echo into a Lead's pane / trigger the FLY-220 self-amplifying
 * storm class of bug (typing is inherently storm-immune).
 *
 * NEVER throws — returns `{ ok: false, error }` on any failure (HTTP non-2xx or a
 * network error) so a typing failure can never break the reply turn that drives it.
 * `fetchImpl` is injectable for unit tests; defaults to the global `fetch`.
 */
export async function sendTypingToChannel(
	channelId: string,
	botToken: string,
	fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; error?: string }> {
	const url = `${DISCORD_API}/channels/${channelId}/typing`;
	try {
		const res = await fetchImpl(url, {
			method: "POST",
			headers: { Authorization: `Bot ${botToken}` },
		});
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			return {
				ok: false,
				error: `Discord ${res.status}: ${detail.slice(0, 200)}`,
			};
		}
		return { ok: true };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `Discord typing POST failed: ${msg}` };
	}
}
