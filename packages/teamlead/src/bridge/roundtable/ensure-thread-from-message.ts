/**
 * FLY-314 — shared `ensureThreadFromMessage`: idempotently make sure the topic
 * thread for a roundtable message exists, returning the thread id.
 *
 * The Discord invariant (a thread started from a message has `thread.id ===
 * messageId`) makes this convergent: the Bridge poller (Phase 1) and any Lead
 * (Phase 2, before it replies into the thread) can both call this; concurrent
 * creates resolve to one thread (one wins, the rest get "already exists" / 160004).
 *
 * Extracted from RoundtableThreadManager's create+confirm logic so Phase 1 (Bridge)
 * and Phase 2 (Codex lead reply-in-thread) share ONE implementation (Codex design
 * review R1#5). Never throws.
 */

import {
	deriveRoundtableThreadName,
	ROUNDTABLE_TOPIC_AUTO_ARCHIVE_MINUTES,
} from "./roundtable-text.js";

const DISCORD_API = "https://discord.com/api/v10";
const ENSURE_TIMEOUT_MS = 5_000;
/** Discord error code: "A thread has already been created for this message". */
const THREAD_ALREADY_EXISTS_CODE = 160004;
/** Discord thread channel types (10 announcement, 11 public, 12 private). */
const THREAD_TYPES = new Set([10, 11, 12]);

export interface EnsureThreadDeps {
	fetchImpl?: typeof fetch;
	/** Override the created thread name. Default derives from `name` arg / fallback. */
	threadName?: string;
	logger?: { warn: (m: string, c?: unknown) => void };
}

export type EnsureThreadResult =
	| { ok: true; threadId: string }
	/** Source message was deleted (404) — no thread possible. */
	| { ok: false; reason: "deleted" }
	/** Bad token / missing CREATE_PUBLIC_THREADS / MANAGE_THREADS (401/403). */
	| { ok: false; reason: "auth" }
	/** Other non-retryable 4xx. */
	| { ok: false; reason: "client_error"; status: number }
	/** 429 / 5xx / network / timeout — caller may retry or fall back. */
	| { ok: false; reason: "transient" };

/** FLY-314 fix (Codex code review R1 LOW): use the SHARED name helper so a
 * Codex-created topic thread is byte-for-byte aligned with the Bridge poller +
 * plugin (90/100-char behavior), not the older local 80-char cleanup. Idempotent on
 * an already-derived `deps.threadName`. */
function deriveName(raw: string | undefined): string {
	return deriveRoundtableThreadName(raw ?? "");
}

/**
 * Ensure the topic thread for `sourceMessageId` (child of `parentChannelId`)
 * exists. Returns its id (== sourceMessageId) on success.
 */
export async function ensureThreadFromMessage(
	parentChannelId: string,
	sourceMessageId: string,
	botToken: string,
	deps: EnsureThreadDeps = {},
): Promise<EnsureThreadResult> {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ENSURE_TIMEOUT_MS);
	try {
		const res = await fetchImpl(
			`${DISCORD_API}/channels/${parentChannelId}/messages/${sourceMessageId}/threads`,
			{
				method: "POST",
				headers: {
					Authorization: `Bot ${botToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					name: deriveName(deps.threadName),
					// FLY-802: 1h auto-archive so finished topics collapse out of the sidebar.
					auto_archive_duration: ROUNDTABLE_TOPIC_AUTO_ARCHIVE_MINUTES,
				}),
				signal: controller.signal,
			},
		);
		if (res.ok) {
			const data = (await res.json().catch(() => ({}))) as { id?: string };
			// Invariant: thread id == source message id.
			return { ok: true, threadId: data.id ?? sourceMessageId };
		}
		if (res.status === 404) return { ok: false, reason: "deleted" };
		if (res.status === 401 || res.status === 403)
			return { ok: false, reason: "auth" };
		if (res.status === 429 || res.status >= 500)
			return { ok: false, reason: "transient" };
		if (res.status === 400) {
			const body = (await res.json().catch(() => ({}))) as { code?: number };
			if (body.code === THREAD_ALREADY_EXISTS_CODE) {
				// Already a thread for this message — confirm it and return its id (== msgId).
				const confirmed = await confirmThreadExists(
					parentChannelId,
					sourceMessageId,
					botToken,
					fetchImpl,
				);
				return confirmed
					? { ok: true, threadId: sourceMessageId }
					: { ok: false, reason: "client_error", status: 400 };
			}
			return { ok: false, reason: "client_error", status: 400 };
		}
		return { ok: false, reason: "client_error", status: res.status };
	} catch {
		return { ok: false, reason: "transient" };
	} finally {
		clearTimeout(timer);
	}
}

/** GET /channels/{messageId} → confirm a thread owned by `parentChannelId` exists
 * (recovery anchor: threadId === messageId). Returns false on any error. */
export async function confirmThreadExists(
	parentChannelId: string,
	sourceMessageId: string,
	botToken: string,
	fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ENSURE_TIMEOUT_MS);
	try {
		const res = await fetchImpl(`${DISCORD_API}/channels/${sourceMessageId}`, {
			headers: { Authorization: `Bot ${botToken}` },
			signal: controller.signal,
		});
		if (!res.ok) return false;
		const data = (await res.json().catch(() => ({}))) as {
			type?: number;
			parent_id?: string;
		};
		return (
			typeof data.type === "number" &&
			THREAD_TYPES.has(data.type) &&
			data.parent_id === parentChannelId
		);
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}
