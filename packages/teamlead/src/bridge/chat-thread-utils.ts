/**
 * FLY-91: Shared helpers for chat thread operations.
 * Used by DirectEventSink, HeartbeatService, actions.ts, gate-poller.ts.
 */

import type { StateStore } from "../StateStore.js";

const DISCORD_API = "https://discord.com/api/v10";

export function resolveChatThreadId(
	store: StateStore,
	issueId: string,
	chatChannelId: string | undefined,
): string | undefined {
	if (!chatChannelId) return undefined;
	const chatThread = store.getChatThreadByIssue(issueId, chatChannelId);
	return chatThread?.thread_id;
}

/**
 * FLY-91: Archive a chat thread so it disappears from the sidebar.
 * Called when a session reaches completed/merged.
 * If a user later sends a message in the archived thread, Discord
 * will auto-unarchive it.
 * Fire-and-forget — failures are logged but never thrown.
 */
export async function archiveChatThread(
	threadId: string,
	botToken: string,
): Promise<void> {
	try {
		const res = await fetch(`${DISCORD_API}/channels/${threadId}`, {
			method: "PATCH",
			headers: {
				Authorization: `Bot ${botToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ archived: true }),
		});
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			console.warn(
				`[chat-thread-utils] archiveChatThread failed: ${res.status} ${body.slice(0, 200)}`,
			);
		}
	} catch (err) {
		console.warn(
			`[chat-thread-utils] archiveChatThread error:`,
			(err as Error).message,
		);
	}
}

/**
 * FLY-91: Remove a user from a chat thread's membership.
 * Used when a session reaches a terminal state so the thread
 * disappears from the user's Discord sidebar.
 * Fire-and-forget — failures are logged but never thrown.
 */
export async function removeUserFromChatThread(
	threadId: string,
	userId: string,
	botToken: string,
): Promise<void> {
	try {
		const res = await fetch(
			`${DISCORD_API}/channels/${threadId}/thread-members/${userId}`,
			{
				method: "DELETE",
				headers: { Authorization: `Bot ${botToken}` },
			},
		);
		if (!res.ok && res.status !== 404) {
			const body = await res.text().catch(() => "");
			console.warn(
				`[chat-thread-utils] removeUserFromChatThread failed: ${res.status} ${body.slice(0, 200)}`,
			);
		}
	} catch (err) {
		console.warn(
			`[chat-thread-utils] removeUserFromChatThread error:`,
			(err as Error).message,
		);
	}
}
