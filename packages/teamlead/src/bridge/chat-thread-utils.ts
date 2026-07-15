/**
 * FLY-91: Shared helpers for chat thread operations.
 * Used by DirectEventSink, HeartbeatService, actions.ts, gate-poller.ts.
 *
 * FLY-292: archiveChatThread / removeUserFromChatThread hardened for
 * deterministic auto-archive on issue completion. Both calls now carry a
 * per-attempt AbortController timeout (aligned with thread-validator /
 * ChatThreadCreator) so a slow Discord response can never hang the awaited
 * post-ship finalization chain. archiveChatThread additionally retries
 * transient failures (network/timeout, 429 honoring Retry-After, 5xx), verifies
 * the thread actually reports archived, and marks the thread missing on 404
 * (GEO-200). It is still fire-and-forget at call sites — it never throws — but
 * now returns a structured result so callers can audit the outcome.
 */

import type { StateStore } from "../StateStore.js";

const DISCORD_API = "https://discord.com/api/v10";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 5_000;
/** Cap on an honored Retry-After so a hostile/huge value can't hang teardown. */
const MAX_RETRY_AFTER_MS = 10_000;

export function resolveChatThreadId(
	store: StateStore,
	issueId: string,
	chatChannelId: string | undefined,
): string | undefined {
	if (!chatChannelId) return undefined;
	const chatThread = store.getChatThreadByIssue(issueId, chatChannelId);
	return chatThread?.thread_id;
}

export interface ArchiveChatThreadDeps {
	/** Test seam for Discord HTTP. */
	fetchImpl?: typeof fetch;
	/** GEO-200: invoked with the threadId when Discord returns 404 (gone). */
	markDiscordMissing?: (threadId: string) => void;
	/** Bounded retry budget for transient failures. Default 3. */
	maxAttempts?: number;
	/** Per-attempt abort timeout. Default 5000ms. */
	timeoutMs?: number;
	/** Test seam for backoff/Retry-After sleeps. */
	sleepImpl?: (ms: number) => Promise<void>;
}

export type ArchiveReason =
	| "ok"
	| "missing"
	| "unauthorized"
	| "client_error"
	| "exhausted"
	| "error"
	/**
	 * FLY-1165: sink-level archive-once — the thread's `archived_at` is already
	 * set, so no Discord PATCH was attempted (a founder re-open is never
	 * fought). Callers treat this as an idempotent no-op success.
	 */
	| "already_archived";

export interface ArchiveChatThreadResult {
	/** True only when Discord confirmed the thread is (or stays) archived. */
	archived: boolean;
	/** Number of HTTP attempts actually made. */
	attempts: number;
	/** Last HTTP status seen (absent if every attempt was a network error). */
	status?: number;
	reason: ArchiveReason;
	/** Last error message for the network/timeout path. */
	error?: string;
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Discord sends Retry-After in (possibly fractional) seconds. */
export function parseRetryAfterMs(header: string | null): number | undefined {
	if (!header) return undefined;
	const secs = Number(header);
	if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
	return undefined;
}

/** Exponential backoff: 200ms, 400ms, 800ms, … */
function backoffMs(attempt: number): number {
	return 200 * 2 ** (attempt - 1);
}

/**
 * Read the archived flag from a Discord channel object. Threads nest it under
 * `thread_metadata.archived`; we also accept a top-level `archived` for
 * robustness. Returns the boolean, or undefined when it cannot be determined.
 */
async function readArchivedFlag(res: Response): Promise<boolean | undefined> {
	try {
		const data = (await res.json()) as {
			archived?: unknown;
			thread_metadata?: { archived?: unknown };
		};
		const flag = data?.thread_metadata?.archived ?? data?.archived;
		return typeof flag === "boolean" ? flag : undefined;
	} catch {
		return undefined;
	}
}

/**
 * FLY-91 / FLY-292: Archive a chat thread so it disappears from the sidebar.
 * Called when a session reaches completed/merged (the final teardown step).
 * If a user later sends a message in the archived thread, Discord will
 * auto-unarchive it — by design (Annie is actively using it again).
 *
 * Deterministic: per-attempt 5s timeout + bounded retry on transient failures
 * (network/timeout, 429 honoring Retry-After, 5xx) + post-archive verification.
 * Fire-and-forget — never throws; returns a structured result for auditing.
 */
export async function archiveChatThread(
	threadId: string,
	botToken: string,
	deps: ArchiveChatThreadDeps = {},
): Promise<ArchiveChatThreadResult> {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const sleep = deps.sleepImpl ?? defaultSleep;

	let lastStatus: number | undefined;
	let lastError: string | undefined;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const res = await fetchImpl(`${DISCORD_API}/channels/${threadId}`, {
				method: "PATCH",
				headers: {
					Authorization: `Bot ${botToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ archived: true }),
				signal: controller.signal,
			});
			lastStatus = res.status;

			// 404 — thread gone in Discord (GEO-200). Not retryable; mark missing.
			if (res.status === 404) {
				deps.markDiscordMissing?.(threadId);
				return {
					archived: false,
					attempts: attempt,
					status: 404,
					reason: "missing",
				};
			}

			// 401/403 — bad token / forbidden. Retrying won't help.
			if (res.status === 401 || res.status === 403) {
				const body = await res.text().catch(() => "");
				console.warn(
					`[chat-thread-utils] archiveChatThread unauthorized: ${res.status} ${body.slice(0, 200)}`,
				);
				return {
					archived: false,
					attempts: attempt,
					status: res.status,
					reason: "unauthorized",
				};
			}

			// 429 — rate limited. Honor Retry-After (capped), then retry.
			if (res.status === 429) {
				if (attempt < maxAttempts) {
					const retryAfter =
						parseRetryAfterMs(res.headers.get("retry-after")) ??
						backoffMs(attempt);
					await sleep(Math.min(retryAfter, MAX_RETRY_AFTER_MS));
					continue;
				}
				return {
					archived: false,
					attempts: attempt,
					status: 429,
					reason: "exhausted",
				};
			}

			// 5xx — transient server error. Retry.
			if (res.status >= 500) {
				if (attempt < maxAttempts) {
					await sleep(backoffMs(attempt));
					continue;
				}
				return {
					archived: false,
					attempts: attempt,
					status: res.status,
					reason: "exhausted",
				};
			}

			// Other 4xx — client error, not retryable.
			if (!res.ok) {
				const body = await res.text().catch(() => "");
				console.warn(
					`[chat-thread-utils] archiveChatThread failed: ${res.status} ${body.slice(0, 200)}`,
				);
				return {
					archived: false,
					attempts: attempt,
					status: res.status,
					reason: "client_error",
				};
			}

			// 2xx — verify the thread actually reports archived. Lenient: a
			// missing/unparseable flag is accepted (the PATCH was acknowledged);
			// only an explicit `archived === false` triggers a retry.
			const flag = await readArchivedFlag(res);
			if (flag !== false) {
				return {
					archived: true,
					attempts: attempt,
					status: res.status,
					reason: "ok",
				};
			}
			if (attempt < maxAttempts) {
				await sleep(backoffMs(attempt));
				continue;
			}
			return {
				archived: false,
				attempts: attempt,
				status: res.status,
				reason: "exhausted",
			};
		} catch (err) {
			// Network error or abort/timeout — retryable within budget.
			lastError = (err as Error).message;
			if (attempt < maxAttempts) {
				await sleep(backoffMs(attempt));
				continue;
			}
			console.warn(
				`[chat-thread-utils] archiveChatThread error after ${attempt} attempt(s):`,
				lastError,
			);
			return {
				archived: false,
				attempts: attempt,
				status: lastStatus,
				reason: "error",
				error: lastError,
			};
		} finally {
			clearTimeout(timer);
		}
	}

	// Unreachable (the loop always returns), but keeps TypeScript satisfied.
	return {
		archived: false,
		attempts: maxAttempts,
		status: lastStatus,
		reason: "exhausted",
		error: lastError,
	};
}

export interface AddThreadMemberDeps {
	/** Test seam for Discord HTTP. */
	fetchImpl?: typeof fetch;
	/** FLY-576: per-attempt abort timeout. Default 5000ms (was unbounded before). */
	timeoutMs?: number;
}

/**
 * FLY-576: classified result of an add-thread-member attempt.
 *  - "added": the user is (now) a member.
 *  - "transient": 429 / 5xx / network / timeout — retrying may succeed.
 *  - "permanent": 401/403/404 — retrying won't help (bad token / no perms / gone).
 */
export type AddMemberOutcome = "added" | "transient" | "permanent";

/**
 * FLY-91 / FLY-314: Add a user as a thread member so the thread appears in their
 * Discord sidebar and notifications are enabled. Shared by ChatThreadCreator
 * (per-issue threads) and RoundtableThreadManager (per-topic threads).
 * Never throws.
 *
 * FLY-576: now returns a classified outcome so a caller that gates work on
 * membership (the RoundtableThreadManager cursor) can hold-and-retry on transient
 * failures vs. give up on permanent ones. Existing callers may ignore the return.
 * Also bounded by a per-attempt abort timeout (default 5s) — a hung PUT must never
 * stall a caller that awaits it.
 */
export async function addThreadMember(
	threadId: string,
	userId: string,
	botToken: string,
	deps: AddThreadMemberDeps = {},
): Promise<AddMemberOutcome> {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetchImpl(
			`${DISCORD_API}/channels/${threadId}/thread-members/${userId}`,
			{
				method: "PUT",
				headers: { Authorization: `Bot ${botToken}` },
				signal: controller.signal,
			},
		);
		if (res.ok) return "added";
		const body = await res.text().catch(() => "");
		console.warn(
			`[chat-thread-utils] addThreadMember failed: thread=${threadId} user=${userId} ${res.status} ${body.slice(0, 200)}`,
		);
		// 408 / 429 / 5xx are retryable; other 4xx (401/403/404) are not.
		if (res.status === 408 || res.status === 429 || res.status >= 500)
			return "transient";
		return "permanent";
	} catch (err) {
		console.warn(
			`[chat-thread-utils] addThreadMember error: thread=${threadId} user=${userId}`,
			(err as Error).message,
		);
		return "transient"; // network / abort / timeout → retryable
	} finally {
		clearTimeout(timer);
	}
}

export interface PinThreadMessageDeps {
	/** Test seam for Discord HTTP. */
	fetchImpl?: typeof fetch;
	/** Per-attempt abort timeout. Default 5000ms. */
	timeoutMs?: number;
}

/**
 * FLY-560 Feature C: outcome of a pin attempt, so the caller's pin state
 * machine can decide whether to record success, retry later, or repost.
 *  - "pinned":    the message is (now) pinned.
 *  - "forbidden": 403 — the bot lacks the pin permission (PIN_MESSAGES). The
 *                 message stays posted-but-unpinned; the next stage retries.
 *  - "missing":   404 — the message is gone (deleted); caller should repost.
 *  - "error":     429 / 5xx / network / timeout — transient; retry next stage.
 */
export type PinOutcome = "pinned" | "forbidden" | "missing" | "error";

export interface PinResult {
	outcome: PinOutcome;
	status?: number;
}

/**
 * FLY-560 Feature C: pin a message in a channel/thread via the current Discord
 * Message-resource endpoint `PUT /channels/{channelId}/messages/pins/{messageId}`
 * (requires PIN_MESSAGES; the old Channel-resource `/pins/{id}` route is
 * deprecated). A thread IS a channel, so `channelId` is the thread id. Pinning
 * is idempotent (re-pinning an already-pinned message succeeds), which the
 * self-heal retry relies on. Never throws.
 */
export async function pinThreadMessage(
	threadId: string,
	messageId: string,
	botToken: string,
	deps: PinThreadMessageDeps = {},
): Promise<PinResult> {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetchImpl(
			`${DISCORD_API}/channels/${threadId}/messages/pins/${messageId}`,
			{
				method: "PUT",
				headers: { Authorization: `Bot ${botToken}` },
				signal: controller.signal,
			},
		);
		if (res.ok || res.status === 204)
			return { outcome: "pinned", status: res.status };
		const body = await res.text().catch(() => "");
		if (res.status === 403) {
			console.warn(
				`[chat-thread-utils] pinThreadMessage forbidden (missing PIN_MESSAGES): thread=${threadId} ${res.status} ${body.slice(0, 200)}`,
			);
			return { outcome: "forbidden", status: 403 };
		}
		if (res.status === 404) return { outcome: "missing", status: 404 };
		console.warn(
			`[chat-thread-utils] pinThreadMessage failed: thread=${threadId} ${res.status} ${body.slice(0, 200)}`,
		);
		return { outcome: "error", status: res.status };
	} catch (err) {
		console.warn(
			`[chat-thread-utils] pinThreadMessage error: thread=${threadId}`,
			(err as Error).message,
		);
		return { outcome: "error" };
	} finally {
		clearTimeout(timer);
	}
}

export interface RemoveUserDeps {
	/** Test seam for Discord HTTP. */
	fetchImpl?: typeof fetch;
	/** Abort timeout. Default 5000ms. */
	timeoutMs?: number;
}

/**
 * FLY-91 / FLY-292: Remove a user from a chat thread's membership.
 * Used when a session reaches a terminal state so the thread disappears from
 * the user's Discord sidebar. Runs immediately BEFORE archiveChatThread in the
 * awaited finalization chain, so it now carries an abort timeout — a hung
 * request here must never block the archive.
 * Fire-and-forget — failures are logged but never thrown.
 */
export async function removeUserFromChatThread(
	threadId: string,
	userId: string,
	botToken: string,
	deps: RemoveUserDeps = {},
): Promise<void> {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetchImpl(
			`${DISCORD_API}/channels/${threadId}/thread-members/${userId}`,
			{
				method: "DELETE",
				headers: { Authorization: `Bot ${botToken}` },
				signal: controller.signal,
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
	} finally {
		clearTimeout(timer);
	}
}
