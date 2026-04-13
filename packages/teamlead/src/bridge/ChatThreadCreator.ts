/**
 * FLY-91: ChatThreadCreator — Bridge creates per-issue chat threads in chatChannel.
 * Modeled after ForumPostCreator. Uses validateThreadExists for 404 detection,
 * AbortController for 5s fail-open timeout on Discord API.
 */

import type { StateStore } from "../StateStore.js";
import { removeUserFromChatThread } from "./chat-thread-utils.js";
import { validateThreadExists } from "./thread-validator.js";

const DISCORD_API = "https://discord.com/api/v10";
const CREATE_TIMEOUT_MS = 5_000;

export interface ChatThreadContext {
	chatChannelId: string;
	issueId: string;
	issueIdentifier?: string;
	issueTitle?: string;
	botToken: string;
	leadId?: string;
	/** Discord user ID to auto-add as thread member (for sidebar visibility). */
	ownerUserId?: string;
}

export interface ChatThreadResult {
	created: boolean;
	threadId?: string;
	error?: string;
}

export class ChatThreadCreator {
	/** Inflight dedup: concurrent calls for the same (issueId, channelId) share one promise. */
	private inflight = new Map<string, Promise<ChatThreadResult>>();

	constructor(private store: StateStore) {}

	async ensureChatThread(ctx: ChatThreadContext): Promise<ChatThreadResult> {
		const key = `${ctx.issueId}:${ctx.chatChannelId}`;
		const pending = this.inflight.get(key);
		if (pending) return pending;

		const promise = this._doEnsure(ctx);
		this.inflight.set(key, promise);
		try {
			return await promise;
		} finally {
			this.inflight.delete(key);
		}
	}

	private async _doEnsure(ctx: ChatThreadContext): Promise<ChatThreadResult> {
		// 1. Check existing mapping
		const existing = this.store.getChatThreadByIssue(
			ctx.issueId,
			ctx.chatChannelId,
		);
		if (existing) {
			const valid = await validateThreadExists(
				existing.thread_id,
				ctx.botToken,
				{
					markDiscordMissing: (id) => this.store.markChatThreadMissing(id),
				},
			);
			if (valid) {
				// FLY-91: Even when reusing existing thread, post a notification
				// in the main channel so Annie sees the issue is active.
				await this.postChannelNotification(ctx, existing.thread_id);
				// FLY-91: Re-add owner as thread member (idempotent) — ensures
				// sidebar visibility even if they previously left/were removed.
				if (ctx.ownerUserId) {
					await this.addThreadMember(
						existing.thread_id,
						ctx.ownerUserId,
						ctx.botToken,
					);
				}
				return { created: false, threadId: existing.thread_id };
			}
			// Thread gone in Discord — fall through to create new
		}

		// 2. Compose thread name + initial message visible in main channel.
		// FLY-91 UX fix: "Start Thread from Message" makes the root message
		// appear in the channel, so users can see the thread was created.
		const threadName = ctx.issueIdentifier
			? `[${ctx.issueIdentifier}] ${ctx.issueTitle ?? ctx.issueId}`
			: (ctx.issueTitle ?? ctx.issueId);

		const messageContent = ctx.issueIdentifier
			? `🧵 **${ctx.issueIdentifier}** — ${ctx.issueTitle ?? "Runner session"}`
			: `🧵 ${ctx.issueTitle ?? ctx.issueId}`;

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), CREATE_TIMEOUT_MS);

		try {
			// Step 1: Post initial message to channel (visible in main channel)
			console.log(
				`[ChatThreadCreator] Step 1: POST message to channel=${ctx.chatChannelId} content="${messageContent.slice(0, 80)}"`,
			);
			const msgRes = await fetch(
				`${DISCORD_API}/channels/${ctx.chatChannelId}/messages`,
				{
					method: "POST",
					headers: {
						Authorization: `Bot ${ctx.botToken}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ content: messageContent }),
					signal: controller.signal,
				},
			);

			if (!msgRes.ok) {
				const body = await msgRes.text().catch(() => "");
				console.warn(
					`[ChatThreadCreator] Step 1 FAILED: ${msgRes.status} ${body.slice(0, 200)}`,
				);
				return {
					created: false,
					error: `Discord ${msgRes.status}: ${body.slice(0, 200)}`,
				};
			}

			const msgData = (await msgRes.json()) as { id?: string };
			if (!msgData.id) {
				return { created: false, error: "no message ID in response" };
			}

			// Step 2: Create thread FROM that message (thread attaches to the message)
			console.log(
				`[ChatThreadCreator] Step 2: POST thread from message=${msgData.id} name="${threadName.slice(0, 60)}"`,
			);
			const res = await fetch(
				`${DISCORD_API}/channels/${ctx.chatChannelId}/messages/${msgData.id}/threads`,
				{
					method: "POST",
					headers: {
						Authorization: `Bot ${ctx.botToken}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						name: threadName.slice(0, 100),
						auto_archive_duration: 4320, // 3 days
					}),
					signal: controller.signal,
				},
			);

			if (!res.ok) {
				const body = await res.text().catch(() => "");
				return {
					created: false,
					error: `Discord ${res.status}: ${body.slice(0, 200)}`,
				};
			}

			const data = (await res.json()) as { id?: string };
			if (!data.id)
				return { created: false, error: "no thread ID in response" };

			// 3. Store mapping
			this.store.upsertChatThread(
				data.id,
				ctx.chatChannelId,
				ctx.issueId,
				ctx.leadId,
			);

			// 4. Auto-add owner as thread member (sidebar visibility + notifications)
			if (ctx.ownerUserId) {
				await this.addThreadMember(data.id, ctx.ownerUserId, ctx.botToken);
			}

			return { created: true, threadId: data.id };
		} catch (err) {
			if ((err as Error).name === "AbortError") {
				return { created: false, error: "timeout" };
			}
			throw err;
		} finally {
			clearTimeout(timeout);
		}
	}

	/**
	 * FLY-91: Remove a user from thread membership so it disappears from
	 * their sidebar. Called when a session reaches a terminal state.
	 */
	async removeThreadMember(
		threadId: string,
		userId: string,
		botToken: string,
	): Promise<void> {
		return removeUserFromChatThread(threadId, userId, botToken);
	}

	/**
	 * FLY-91: Add a user as a thread member so the thread appears in their
	 * sidebar and notifications are enabled. Fire-and-forget.
	 */
	private async addThreadMember(
		threadId: string,
		userId: string,
		botToken: string,
	): Promise<void> {
		try {
			const res = await fetch(
				`${DISCORD_API}/channels/${threadId}/thread-members/${userId}`,
				{
					method: "PUT",
					headers: { Authorization: `Bot ${botToken}` },
				},
			);
			if (!res.ok) {
				const body = await res.text().catch(() => "");
				console.warn(
					`[ChatThreadCreator] addThreadMember failed: ${res.status} ${body.slice(0, 200)}`,
				);
			}
		} catch (err) {
			console.warn(
				`[ChatThreadCreator] addThreadMember error:`,
				(err as Error).message,
			);
		}
	}

	/**
	 * FLY-91: Post a brief notification in the main channel when reusing
	 * an existing thread. Fire-and-forget — failures are logged but don't
	 * block the caller. Uses AbortController timeout to prevent hanging
	 * the session_started pipeline.
	 */
	private async postChannelNotification(
		ctx: ChatThreadContext,
		threadId: string,
	): Promise<void> {
		const label = ctx.issueIdentifier
			? `**${ctx.issueIdentifier}** — ${ctx.issueTitle ?? "Runner session"}`
			: (ctx.issueTitle ?? ctx.issueId);
		const content = `🧵 ${label} — <#${threadId}>`;

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), CREATE_TIMEOUT_MS);

		try {
			const res = await fetch(
				`${DISCORD_API}/channels/${ctx.chatChannelId}/messages`,
				{
					method: "POST",
					headers: {
						Authorization: `Bot ${ctx.botToken}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ content }),
					signal: controller.signal,
				},
			);
			if (!res.ok) {
				const body = await res.text().catch(() => "");
				console.warn(
					`[ChatThreadCreator] channel notification failed: ${res.status} ${body.slice(0, 200)}`,
				);
			}
		} catch (err) {
			const msg = (err as Error).message;
			if ((err as Error).name === "AbortError") {
				console.warn(
					`[ChatThreadCreator] channel notification timed out after ${CREATE_TIMEOUT_MS}ms`,
				);
			} else {
				console.warn(`[ChatThreadCreator] channel notification error:`, msg);
			}
		} finally {
			clearTimeout(timeout);
		}
	}
}
