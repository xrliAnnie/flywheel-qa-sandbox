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
import { markAutomatedDiscordText } from "./automated-message.js";

const DISCORD_API = "https://discord.com/api/v10";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 5_000;
/** Cap on an honored Retry-After so a hostile/huge value can't hang teardown. */
const MAX_RETRY_AFTER_MS = 10_000;
const DISCORD_EPOCH_MS = 1_420_070_400_000;

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
	/** A human reopened the thread; automation deliberately leaves it open. */
	| "founder_reopened"
	/** The thread has not yet satisfied the caller's quiet window. */
	| "deferred_quiet_window"
	/** Reopen authorship or the compensation end state could not be verified. */
	| "reopen_check_failed"
	/** A current runner owns the reopened thread. */
	| "in_active_use"
	/**
	 * Discord metadata verified that the thread is still archived, so no PATCH
	 * was needed. This is an idempotent, truthful success.
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
	/** Execution that caused an `in_active_use` veto. */
	activeExecutionId?: string;
}

export interface UnarchiveChatThreadResult {
	unarchived: boolean;
	attempts: number;
	status?: number;
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

/**
 * FLY-1709: best-effort inverse of archiveChatThread for compensating a
 * re-archive whose quiet-window verification failed. It gets one retry and
 * never throws. Callers still verify the final channel metadata themselves.
 */
export async function unarchiveChatThread(
	threadId: string,
	botToken: string,
	deps: ArchiveChatThreadDeps = {},
): Promise<UnarchiveChatThreadResult> {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const sleep = deps.sleepImpl ?? defaultSleep;
	const maxAttempts = 2;
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
				body: JSON.stringify({ archived: false }),
				signal: controller.signal,
			});
			lastStatus = res.status;
			if (res.ok) {
				const flag = await readArchivedFlag(res);
				if (flag !== true) {
					return { unarchived: true, attempts: attempt, status: res.status };
				}
			}
			if (
				attempt < maxAttempts &&
				(res.ok || res.status === 429 || res.status >= 500)
			) {
				const retryAfter =
					res.status === 429
						? parseRetryAfterMs(res.headers.get("retry-after"))
						: undefined;
				await sleep(
					Math.min(retryAfter ?? backoffMs(attempt), MAX_RETRY_AFTER_MS),
				);
				continue;
			}
			return { unarchived: false, attempts: attempt, status: res.status };
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
			if (attempt < maxAttempts) {
				await sleep(backoffMs(attempt));
				continue;
			}
			return {
				unarchived: false,
				attempts: attempt,
				status: lastStatus,
				error: lastError,
			};
		} finally {
			clearTimeout(timer);
		}
	}

	return {
		unarchived: false,
		attempts: maxAttempts,
		status: lastStatus,
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

/**
 * FLY-1544 ③: the pure two-step Discord thread-create flow, extracted from
 * ChatThreadCreator so the v2 Discord messenger can import ONE implementation
 * instead of copy-pasting the REST calls. Step 1 posts a root message to the
 * channel (visible in the main channel — FLY-91 UX), step 2 creates the thread
 * FROM that message. No StateStore, no dedup, no title coalescing — those stay
 * in ChatThreadCreator; this is only the REST mechanics.
 */
export interface CreateChatThreadDeps {
	/** Test seam for Discord HTTP. */
	fetchImpl?: typeof fetch;
	/** Abort timeout for EACH Discord request. Default 5000ms. */
	timeoutMs?: number;
}

export type CreateChatThreadResult =
	| { created: true; threadId: string; rootMessageId: string }
	| { created: false; error: string; rootMessageId?: string; status?: number };

export type PostThreadRootMessageResult =
	| { posted: true; rootMessageId: string }
	| { posted: false; error: string; status?: number };

/**
 * FLY-1927: step 1 of issue-thread creation. Its response is the durable
 * identity of the future thread, so callers must receive it before attempting
 * start-from-message. This request owns its timeout; step 2 gets a fresh one.
 */
export async function postThreadRootMessage(
	input: {
		channelId: string;
		messageContent: string;
		botToken: string;
	},
	deps: CreateChatThreadDeps = {},
): Promise<PostThreadRootMessageResult> {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(),
		deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	);
	try {
		const res = await fetchImpl(
			`${DISCORD_API}/channels/${input.channelId}/messages`,
			{
				method: "POST",
				headers: {
					Authorization: `Bot ${input.botToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					content: markAutomatedDiscordText(input.messageContent),
					allowed_mentions: { parse: [] },
				}),
				signal: controller.signal,
			},
		);
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			return {
				posted: false,
				status: res.status,
				error: `Discord ${res.status}: ${body.slice(0, 200)}`,
			};
		}
		const data = (await res.json()) as { id?: string };
		if (!data.id) return { posted: false, error: "no message ID in response" };
		return { posted: true, rootMessageId: data.id };
	} catch (err) {
		if ((err as Error).name === "AbortError") {
			return { posted: false, error: "timeout" };
		}
		return { posted: false, error: (err as Error).message };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * FLY-1927: step 2 always targets a caller-supplied, already-known root. Discord
 * guarantees the created thread id equals that root message id. Failures retain
 * the root id so the owner can probe/replay this exact operation.
 */
export async function startThreadFromMessage(
	input: {
		channelId: string;
		rootMessageId: string;
		threadName: string;
		botToken: string;
		autoArchiveMinutes?: number;
	},
	deps: CreateChatThreadDeps = {},
): Promise<CreateChatThreadResult> {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(),
		deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	);
	try {
		const res = await fetchImpl(
			`${DISCORD_API}/channels/${input.channelId}/messages/${input.rootMessageId}/threads`,
			{
				method: "POST",
				headers: {
					Authorization: `Bot ${input.botToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					name: input.threadName,
					auto_archive_duration: input.autoArchiveMinutes ?? 4320,
				}),
				signal: controller.signal,
			},
		);
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			return {
				created: false,
				status: res.status,
				rootMessageId: input.rootMessageId,
				error: `Discord ${res.status}: ${body.slice(0, 200)}`,
			};
		}
		const data = (await res.json()) as { id?: string };
		if (!data.id) {
			return {
				created: false,
				rootMessageId: input.rootMessageId,
				error: "no thread ID in response",
			};
		}
		if (data.id !== input.rootMessageId) {
			return {
				created: false,
				rootMessageId: input.rootMessageId,
				error: `Discord thread ID ${data.id} did not match root message ID ${input.rootMessageId}`,
			};
		}
		return {
			created: true,
			threadId: input.rootMessageId,
			rootMessageId: input.rootMessageId,
		};
	} catch (err) {
		return {
			created: false,
			rootMessageId: input.rootMessageId,
			error:
				(err as Error).name === "AbortError"
					? "timeout"
					: (err as Error).message,
		};
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Compatibility/test helper. Production creation uses the two primitives
 * directly so it can claim the root between them. `timeoutMs` is a per-step
 * budget (root POST, then start-from-message), not one shared total deadline.
 */
export async function createChatThread(
	input: {
		channelId: string;
		threadName: string;
		messageContent: string;
		botToken: string;
		/** Discord auto_archive_duration in minutes. Default 4320 (3 days). */
		autoArchiveMinutes?: number;
	},
	deps: CreateChatThreadDeps = {},
): Promise<CreateChatThreadResult> {
	const root = await postThreadRootMessage(input, deps);
	if (!root.posted) {
		return {
			created: false,
			error: root.error,
			...(root.status === undefined ? {} : { status: root.status }),
		};
	}
	return startThreadFromMessage(
		{ ...input, rootMessageId: root.rootMessageId },
		deps,
	);
}

/**
 * FLY-1544 ③④: post one message into a channel/thread (a Discord thread IS a
 * channel, so `channelId` may be a thread id). Pure REST, ping-safe, bounded.
 */
export interface PostChatMessageDeps {
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

export type PostChatMessageResult =
	| { posted: true; messageId: string }
	| { posted: false; status?: number; error: string };

export async function postChatMessage(
	input: { channelId: string; content: string; botToken: string },
	deps: PostChatMessageDeps = {},
): Promise<PostChatMessageResult> {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(),
		deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	);
	try {
		const res = await fetchImpl(
			`${DISCORD_API}/channels/${input.channelId}/messages`,
			{
				method: "POST",
				headers: {
					Authorization: `Bot ${input.botToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					content: markAutomatedDiscordText(input.content),
					allowed_mentions: { parse: [] },
				}),
				signal: controller.signal,
			},
		);
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			return {
				posted: false,
				status: res.status,
				error: `Discord ${res.status}: ${body.slice(0, 200)}`,
			};
		}
		const data = (await res.json()) as { id?: string };
		if (!data.id) return { posted: false, error: "no message ID in response" };
		return { posted: true, messageId: data.id };
	} catch (err) {
		if ((err as Error).name === "AbortError") {
			return { posted: false, error: "timeout" };
		}
		return { posted: false, error: (err as Error).message };
	} finally {
		clearTimeout(timer);
	}
}

/* ------------------------------------------------------------------------- *
 * FLY-1549: minimal REST additions for the v2 display surfaces (title badge
 * PATCH + pinned-header edit). Single-attempt, structured results; the retry
 * policy (429 backoff / defer-to-sweep) lives in the v2 display refresher.
 * ------------------------------------------------------------------------- */

async function readRetryAfterMs(res: Response): Promise<number | undefined> {
	const header = parseRetryAfterMs(res.headers.get("retry-after"));
	if (header !== undefined) return header;
	try {
		const data = (await res.clone().json()) as { retry_after?: unknown };
		if (typeof data.retry_after === "number" && data.retry_after >= 0) {
			return Math.round(data.retry_after * 1000);
		}
	} catch {
		// no parseable body
	}
	return undefined;
}

export interface DisplayRestDeps {
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

/** Convert a millisecond timestamp to the lower-bound Discord snowflake. */
export function snowflakeFromMs(ms: number): string {
	const normalized = Number.isFinite(ms) ? Math.floor(ms) : DISCORD_EPOCH_MS;
	const sinceEpoch = Math.max(0, normalized - DISCORD_EPOCH_MS);
	return (BigInt(sinceEpoch) << 22n).toString();
}

export type ReopenerClass =
	| { kind: "bot_only"; frontierMessageId: string }
	| { kind: "human" }
	| { kind: "unknown"; detail: string };

type DiscordThreadMessage = {
	id?: unknown;
	author?: { bot?: unknown };
};

async function getThreadMessages(
	url: string,
	botToken: string,
	deps: DisplayRestDeps,
): Promise<
	| { ok: true; messages: DiscordThreadMessage[] }
	| { ok: false; status?: number; retryAfterMs?: number; error: string }
> {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(),
		deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	);
	try {
		const res = await fetchImpl(url, {
			headers: { Authorization: `Bot ${botToken}` },
			signal: controller.signal,
		});
		if (!res.ok) {
			const retryAfterMs =
				res.status === 429 ? await readRetryAfterMs(res) : undefined;
			const body = await res.text().catch(() => "");
			return {
				ok: false,
				status: res.status,
				...(retryAfterMs === undefined ? {} : { retryAfterMs }),
				error: `Discord ${res.status}: ${body.slice(0, 200)}`,
			};
		}
		const data = (await res.json()) as unknown;
		if (!Array.isArray(data)) {
			return { ok: false, error: "Discord messages response is not an array" };
		}
		return { ok: true, messages: data as DiscordThreadMessage[] };
	} catch (err) {
		return {
			ok: false,
			error:
				err instanceof Error && err.name === "AbortError"
					? "timeout"
					: err instanceof Error
						? err.message
						: String(err),
		};
	} finally {
		clearTimeout(timer);
	}
}

/**
 * FLY-1709: classify every visible post-archive message. Any human wins;
 * incomplete or malformed evidence stays unknown so automation never fights
 * a founder reopen. Discord does not expose the actor for a bare UI unarchive:
 * if a founder opens the thread without posting and a bot later posts first,
 * that indistinguishable sequence is classified bot-only. Human-message
 * evidence remains fail-closed and always wins.
 */
export async function classifyThreadReopener(
	threadId: string,
	botToken: string,
	afterMs: number,
	deps: DisplayRestDeps = {},
): Promise<ReopenerClass> {
	const anchor = snowflakeFromMs(afterMs);
	const result = await getThreadMessages(
		`${DISCORD_API}/channels/${threadId}/messages?after=${anchor}&limit=100`,
		botToken,
		deps,
	);
	if (!result.ok) return { kind: "unknown", detail: result.error };
	if (result.messages.length === 0) {
		return { kind: "unknown", detail: "no post-archive messages" };
	}
	if (result.messages.length >= 100) {
		return { kind: "unknown", detail: "post-archive message window is full" };
	}
	if (
		result.messages.some(
			(message) => typeof message.id !== "string" || !/^\d+$/.test(message.id),
		)
	) {
		return { kind: "unknown", detail: "message id is malformed" };
	}

	const filtered = result.messages.filter(
		(message): message is DiscordThreadMessage & { id: string } =>
			typeof message.id === "string" && BigInt(message.id) > BigInt(anchor),
	);
	if (filtered.length === 0) {
		return { kind: "unknown", detail: "no messages beyond the local anchor" };
	}
	if (filtered.some((message) => !message.author)) {
		return { kind: "unknown", detail: "message author is missing" };
	}
	if (filtered.some((message) => message.author?.bot !== true)) {
		return { kind: "human" };
	}
	const frontierMessageId = filtered
		.map((message) => message.id)
		.reduce((max, id) => (BigInt(id) > BigInt(max) ? id : max), "0");
	return { kind: "bot_only", frontierMessageId };
}

export type LatestThreadMessageResult =
	| { ok: true; messageId: string | null }
	| { ok: false; status?: number; retryAfterMs?: number; error: string };

/** Fetch the current message frontier for the quiet-window fence. */
export async function getLatestThreadMessageId(
	threadId: string,
	botToken: string,
	deps: DisplayRestDeps = {},
): Promise<LatestThreadMessageResult> {
	const result = await getThreadMessages(
		`${DISCORD_API}/channels/${threadId}/messages?limit=1`,
		botToken,
		deps,
	);
	if (!result.ok) return result;
	if (result.messages.length === 0) return { ok: true, messageId: null };
	const id = result.messages[0]?.id;
	if (typeof id !== "string") {
		return { ok: false, error: "latest message id is missing" };
	}
	return { ok: true, messageId: id };
}

export type GetChannelNameResult =
	| {
			ok: true;
			name: string;
			archived?: boolean;
			archiveTimestamp?: string;
	  }
	| { ok: false; status?: number; retryAfterMs?: number; error: string };

/** GET the channel object and return its current name (+ archived flag). */
export async function getChannelName(
	channelId: string,
	botToken: string,
	deps: DisplayRestDeps = {},
): Promise<GetChannelNameResult> {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(),
		deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	);
	try {
		const res = await fetchImpl(`${DISCORD_API}/channels/${channelId}`, {
			headers: { Authorization: `Bot ${botToken}` },
			signal: controller.signal,
		});
		if (res.status === 429) {
			return {
				ok: false,
				status: 429,
				retryAfterMs: await readRetryAfterMs(res),
				error: "rate limited",
			};
		}
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			return {
				ok: false,
				status: res.status,
				error: `Discord ${res.status}: ${body.slice(0, 200)}`,
			};
		}
		const data = (await res.json()) as {
			name?: unknown;
			thread_metadata?: {
				archived?: unknown;
				archive_timestamp?: unknown;
			};
		};
		if (typeof data.name !== "string") {
			return { ok: false, error: "no channel name in response" };
		}
		const archived = data.thread_metadata?.archived;
		const archiveTimestamp = data.thread_metadata?.archive_timestamp;
		return {
			ok: true,
			name: data.name,
			...(typeof archived === "boolean" ? { archived } : {}),
			...(typeof archiveTimestamp === "string" ? { archiveTimestamp } : {}),
		};
	} catch (err) {
		if ((err as Error).name === "AbortError") {
			return { ok: false, error: "timeout" };
		}
		return { ok: false, error: (err as Error).message };
	} finally {
		clearTimeout(timer);
	}
}

export type RenameChannelResult =
	| { ok: true }
	| {
			ok: false;
			status?: number;
			retryAfterMs?: number;
			archived?: boolean;
			error: string;
	  };

/** PATCH the channel/thread name. Thread renames are heavily rate limited
 * (~2 per 10 min) — callers must be zero-churn and treat 429 as deferrable. */
export async function renameChannel(
	channelId: string,
	name: string,
	botToken: string,
	deps: DisplayRestDeps = {},
): Promise<RenameChannelResult> {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(),
		deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	);
	try {
		const res = await fetchImpl(`${DISCORD_API}/channels/${channelId}`, {
			method: "PATCH",
			headers: {
				Authorization: `Bot ${botToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ name }),
			signal: controller.signal,
		});
		if (res.ok) return { ok: true };
		if (res.status === 429) {
			return {
				ok: false,
				status: 429,
				retryAfterMs: await readRetryAfterMs(res),
				error: "rate limited",
			};
		}
		const body = await res.text().catch(() => "");
		// 400 code 50083 = thread archived — renames need an unarchive first.
		const archived = res.status === 400 && body.includes("50083");
		return {
			ok: false,
			status: res.status,
			...(archived ? { archived: true } : {}),
			error: `Discord ${res.status}: ${body.slice(0, 200)}`,
		};
	} catch (err) {
		if ((err as Error).name === "AbortError") {
			return { ok: false, error: "timeout" };
		}
		return { ok: false, error: (err as Error).message };
	} finally {
		clearTimeout(timer);
	}
}

export type EditChatMessageResult =
	| { edited: true }
	| { edited: false; status?: number; retryAfterMs?: number; error: string };

/** PATCH an existing message's content (the pinned-header in-place refresh). */
export async function editChatMessage(
	input: {
		channelId: string;
		messageId: string;
		content: string;
		botToken: string;
	},
	deps: DisplayRestDeps = {},
): Promise<EditChatMessageResult> {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(),
		deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	);
	try {
		const res = await fetchImpl(
			`${DISCORD_API}/channels/${input.channelId}/messages/${input.messageId}`,
			{
				method: "PATCH",
				headers: {
					Authorization: `Bot ${input.botToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					content: markAutomatedDiscordText(input.content),
					allowed_mentions: { parse: [] },
				}),
				signal: controller.signal,
			},
		);
		if (res.ok) return { edited: true };
		if (res.status === 429) {
			return {
				edited: false,
				status: 429,
				retryAfterMs: await readRetryAfterMs(res),
				error: "rate limited",
			};
		}
		const body = await res.text().catch(() => "");
		return {
			edited: false,
			status: res.status,
			error: `Discord ${res.status}: ${body.slice(0, 200)}`,
		};
	} catch (err) {
		if ((err as Error).name === "AbortError") {
			return { edited: false, error: "timeout" };
		}
		return { edited: false, error: (err as Error).message };
	} finally {
		clearTimeout(timer);
	}
}

export type GetChannelMessageResult =
	| { ok: true; pinned: boolean }
	| { ok: false; status?: number; error: string };

/** GET one message — the FLY-1549 sweep's remote verification that a
 * converged pinned header still exists and is still pinned. */
export async function getChannelMessage(
	channelId: string,
	messageId: string,
	botToken: string,
	deps: DisplayRestDeps = {},
): Promise<GetChannelMessageResult> {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(),
		deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	);
	try {
		const res = await fetchImpl(
			`${DISCORD_API}/channels/${channelId}/messages/${messageId}`,
			{
				headers: { Authorization: `Bot ${botToken}` },
				signal: controller.signal,
			},
		);
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			return {
				ok: false,
				status: res.status,
				error: `Discord ${res.status}: ${body.slice(0, 200)}`,
			};
		}
		const data = (await res.json()) as { pinned?: unknown };
		return { ok: true, pinned: data.pinned === true };
	} catch (err) {
		if ((err as Error).name === "AbortError") {
			return { ok: false, error: "timeout" };
		}
		return { ok: false, error: (err as Error).message };
	} finally {
		clearTimeout(timer);
	}
}
