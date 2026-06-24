/**
 * FLY-91: ChatThreadCreator — Bridge creates per-issue chat threads in chatChannel.
 * Uses validateThreadExists for 404 detection, AbortController for 5s fail-open
 * timeout on Discord API.
 */

import type { StateStore } from "../StateStore.js";
import {
	addThreadMember,
	removeUserFromChatThread,
} from "./chat-thread-utils.js";
import { validateThreadExists } from "./thread-validator.js";

const DISCORD_API = "https://discord.com/api/v10";
const CREATE_TIMEOUT_MS = 5_000;
const DISCORD_THREAD_NAME_MAX = 100;
const LINEAR_IDENTIFIER_RE = /^[A-Z][A-Z0-9]*-\d+$/;

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

function effectiveIssueKey(
	ctx: Pick<ChatThreadContext, "issueId" | "issueIdentifier">,
): string | undefined {
	return (
		ctx.issueIdentifier ??
		(LINEAR_IDENTIFIER_RE.test(ctx.issueId) ? ctx.issueId : undefined)
	);
}

function buildIssueThreadName(
	ctx: Pick<ChatThreadContext, "issueId" | "issueIdentifier" | "issueTitle">,
): string {
	const issueKey = effectiveIssueKey(ctx);
	if (issueKey) return `[${issueKey}] ${ctx.issueTitle ?? ctx.issueId}`;
	return ctx.issueTitle ?? ctx.issueId;
}

function truncateDiscordThreadName(name: string): string {
	return name.slice(0, DISCORD_THREAD_NAME_MAX);
}

function isPlaceholderThreadName(
	currentName: string | undefined,
	ctx: Pick<ChatThreadContext, "issueId" | "issueIdentifier">,
): boolean {
	if (!currentName) return false;
	const issueKey = effectiveIssueKey(ctx);
	if (!issueKey) return false;
	const placeholders = new Set([issueKey]);
	placeholders.add(`[${issueKey}]`);
	placeholders.add(`[${issueKey}] ${issueKey}`);
	placeholders.add(`[${issueKey}] ${ctx.issueId}`);
	return placeholders.has(currentName);
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
				await this.maybeBackfillThreadName(ctx, existing.thread_id);
				// FLY-91: Even when reusing existing thread, post a notification
				// in the main channel so Annie sees the issue is active.
				await this.postChannelNotification(ctx, existing.thread_id);
				// FLY-91: Re-add owner as thread member (idempotent) — ensures
				// sidebar visibility even if they previously left/were removed.
				if (ctx.ownerUserId) {
					await addThreadMember(
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
		const threadName = truncateDiscordThreadName(buildIssueThreadName(ctx));

		const issueKey = effectiveIssueKey(ctx);
		const messageContent = issueKey
			? `🧵 **${issueKey}** — ${ctx.issueTitle ?? "Runner session"}`
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
					// FLY-162 Codex R3 #2: never let issue title / generated
					// notification text trigger @everyone/@here/role pings.
					body: JSON.stringify({
						content: messageContent,
						allowed_mentions: { parse: [] },
					}),
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
						name: threadName,
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
				await addThreadMember(data.id, ctx.ownerUserId, ctx.botToken);
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

	async backfillThreadName(
		ctx: ChatThreadContext,
		threadId: string,
	): Promise<void> {
		await this.maybeBackfillThreadName(ctx, threadId);
	}

	private async maybeBackfillThreadName(
		ctx: ChatThreadContext,
		threadId: string,
	): Promise<void> {
		if (!ctx.issueTitle) return;
		if (!effectiveIssueKey(ctx)) return;
		const desiredName = truncateDiscordThreadName(buildIssueThreadName(ctx));
		if (!desiredName || desiredName === ctx.issueId) return;

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), CREATE_TIMEOUT_MS);

		try {
			const getRes = await fetch(`${DISCORD_API}/channels/${threadId}`, {
				method: "GET",
				headers: { Authorization: `Bot ${ctx.botToken}` },
				signal: controller.signal,
			});
			if (!getRes.ok) {
				const body = await getRes.text().catch(() => "");
				console.warn(
					`[ChatThreadCreator] thread name backfill GET failed: ${getRes.status} ${body.slice(0, 200)}`,
				);
				return;
			}

			const data = (await getRes.json().catch(() => ({}))) as {
				name?: unknown;
			};
			const currentName =
				typeof data.name === "string" ? data.name.trim() : undefined;
			if (!isPlaceholderThreadName(currentName, ctx)) return;
			if (currentName === desiredName) return;

			const patchRes = await fetch(`${DISCORD_API}/channels/${threadId}`, {
				method: "PATCH",
				headers: {
					Authorization: `Bot ${ctx.botToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ name: desiredName }),
				signal: controller.signal,
			});
			if (!patchRes.ok) {
				const body = await patchRes.text().catch(() => "");
				console.warn(
					`[ChatThreadCreator] thread name backfill PATCH failed: ${patchRes.status} ${body.slice(0, 200)}`,
				);
			}
		} catch (err) {
			const msg = (err as Error).message;
			if ((err as Error).name === "AbortError") {
				console.warn(
					`[ChatThreadCreator] thread name backfill timed out after ${CREATE_TIMEOUT_MS}ms`,
				);
			} else {
				console.warn(`[ChatThreadCreator] thread name backfill error:`, msg);
			}
		} finally {
			clearTimeout(timeout);
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
					// FLY-162 Codex R3 #2: notification text is generated, but
					// belt-and-suspenders — block any future label-injection
					// path from triggering @everyone/@here/role pings.
					body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
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
