/**
 * FLY-91: ChatThreadCreator — Bridge creates per-issue chat threads in chatChannel.
 * Uses validateThreadExists for 404 detection, AbortController for 5s fail-open
 * timeout on Discord API.
 */

import type { StateStore } from "../StateStore.js";
import {
	addThreadMember,
	parseRetryAfterMs,
	pinThreadMessage,
	removeUserFromChatThread,
} from "./chat-thread-utils.js";
import {
	modelSuffixCode,
	splitStatusEmoji,
	stageBadge,
	stripModelSuffix,
} from "./stage-utils.js";
import { validateThreadExists } from "./thread-validator.js";

const DISCORD_API = "https://discord.com/api/v10";
const CREATE_TIMEOUT_MS = 5_000;
const DISCORD_THREAD_NAME_MAX = 100;
const LINEAR_IDENTIFIER_RE = /^[A-Z][A-Z0-9]*-\d+$/;

/**
 * FLY-630 ①: how many times the coalescing title writer re-attempts a single
 * thread after a Discord 429 (rename rate limit) before giving up for this
 * episode. Each retry honors the server's Retry-After and re-reads the LATEST
 * desired badge, so the final stage always lands within the rate-limit window
 * instead of being silently dropped. A small cap is enough — Discord's rename
 * budget reopens in ≤10 min and the next `stage_changed` re-stamps anyway.
 */
const MAX_RATE_LIMIT_RETRIES = 5;
/**
 * FLY-630 ①: cap an honored Retry-After. Discord's thread-rename limit is
 * ~2/10-min, so a real Retry-After can be up to ~10 min — honor it (the pending
 * drain is just an in-memory promise, it blocks nothing), but cap so a hostile /
 * absurd value can't hold the per-thread writer forever.
 */
const MAX_RETRY_AFTER_MS = 600_000;
/** FLY-630 ①: fallback wait when a 429 carries no parseable Retry-After. */
const DEFAULT_RETRY_AFTER_MS = 10_000;

function defaultTitleWriteSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * FLY-630 ①: extract the honored backoff from a Discord 429. Prefers the
 * `Retry-After` header (seconds, possibly fractional); falls back to the JSON
 * body's `retry_after` (Discord sends both); else a modest default. Never
 * throws — a malformed/absent value degrades to the default.
 */
async function retryAfterMsFrom(res: Response): Promise<number> {
	const header =
		typeof res.headers?.get === "function"
			? res.headers.get("retry-after")
			: null;
	const fromHeader = parseRetryAfterMs(header);
	if (fromHeader != null) return fromHeader;
	if (typeof res.json === "function") {
		const body = (await res.json().catch(() => null)) as {
			retry_after?: unknown;
		} | null;
		const secs = Number(body?.retry_after);
		if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
	}
	return DEFAULT_RETRY_AFTER_MS;
}

/**
 * FLY-630 ①: outcome of one GET+PATCH title write. `rate_limited` carries the
 * honored Retry-After so the coalescing drain can wait then retry the latest
 * target; `noop` means the desired title was already present (idempotent skip).
 */
type TitleWriteResult =
	| { status: "ok" }
	| { status: "noop" }
	| { status: "error" }
	| { status: "rate_limited"; retryAfterMs: number };

/**
 * FLY-630 ①: per-thread coalescing state for the title writer. `target` always
 * holds the LATEST requested badge (string badge, or null to strip the prefix);
 * `dirty` means an unwritten target is pending; `done` is the shared drain
 * promise every concurrent request awaits.
 */
interface TitleWriteState {
	ctx: ChatThreadContext;
	target: string | null;
	dirty: boolean;
	done: Promise<void>;
}

export interface ChatThreadContext {
	chatChannelId: string;
	issueId: string;
	issueIdentifier?: string;
	issueTitle?: string;
	botToken: string;
	leadId?: string;
	/** Discord user ID to auto-add as thread member (for sidebar visibility). */
	ownerUserId?: string;
	/**
	 * FLY-728 Part D: the resolved model's F/O/S/H short code, stamped as a title
	 * SUFFIX (` ·F`) that rides the same rename as the stage-emoji prefix.
	 * Tri-state (Codex code R1 MEDIUM — an authoritative stamp must be able to
	 * CLEAR a stale suffix when a reused thread's run has no model):
	 *   - a code ("F"…) → SET the suffix to it
	 *   - `null`        → CLEAR it (the caller KNOWS this run is account-default)
	 *   - absent        → PRESERVE the existing suffix (caller has no model context)
	 * Every stamp caller that has the session passes `modelShortCode(runner_model)
	 * ?? null` so account-default clears rather than preserving a prior model.
	 */
	modelCode?: "F" | "O" | "S" | "H" | null;
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

/**
 * FLY-728: compose the final ≤100-char thread title, RESERVING room for the
 * leading status `prefix` (e.g. "🔨实现中 ") and the trailing model-code suffix
 * (` ·F`) so a long issue title truncates in the MIDDLE and never drops the
 * F/O/S/H code off the end (Codex design R1 MEDIUM). `base` must be suffix-free.
 */
function composeThreadTitle(
	prefix: string,
	base: string,
	modelCode: "F" | "O" | "S" | "H" | null | undefined,
): string {
	const suffix = modelCode ? ` ·${modelCode}` : "";
	const budget = DISCORD_THREAD_NAME_MAX - prefix.length - suffix.length;
	const cutBase = base.slice(0, Math.max(0, budget));
	return `${prefix}${cutBase}${suffix}`;
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

	/**
	 * FLY-560 Codex R1 HIGH / FLY-630 ①: per-thread COALESCING title writer.
	 *
	 * Stamps are fire-and-forget on each `stage_changed`. The original design
	 * chained every stamp (FIFO) so two adjacent stamps couldn't read-then-write
	 * race. FLY-630 replaces the FIFO chain with coalesce-to-latest: each request
	 * records only the LATEST desired badge for the thread; if a writer is already
	 * draining that thread, the request just updates the target and rides the same
	 * drain. Two problems this fixes:
	 *   (1) Discord caps thread renames at ~2/10-min. A rapid burst
	 *       (implement→pr_created→code_review) used to spend a PATCH on every
	 *       intermediate stage and 429 on the latest, which was then dropped → the
	 *       title stuck on an old stage. Coalescing collapses intermediates; the
	 *       latest is what gets written.
	 *   (2) A 429 used to be swallowed (fire-and-forget). The drain now honors
	 *       Retry-After and retries the LATEST target, so the final stage always
	 *       lands within the rate-limit window.
	 * Single-writer-per-thread still serializes (no read-then-write race), and the
	 * idempotent no-op skip + base-title preservation are unchanged.
	 */
	private titleWriters = new Map<string, TitleWriteState>();

	/**
	 * @param store StateStore for chat-thread mappings.
	 * @param titleWriteSleep test seam for the 429 Retry-After backoff sleep
	 *   (default real `setTimeout`); injected as an immediate resolve in tests so
	 *   the retry path runs without real waits.
	 */
	constructor(
		private store: StateStore,
		private readonly titleWriteSleep: (
			ms: number,
		) => Promise<void> = defaultTitleWriteSleep,
	) {}

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
		// FLY-728 Part D (Codex R1 MEDIUM): stamp the model code at thread creation
		// so a new [FLY-XX] thread shows F/O/S/H immediately, not only after the
		// first stage_changed.
		const threadName = composeThreadTitle(
			"",
			buildIssueThreadName(ctx),
			ctx.modelCode,
		);

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

	/**
	 * FLY-560 Feature A: stamp the current pipeline stage's status badge onto the
	 * front of the issue thread title so Annie reads the status at a glance —
	 * e.g. `🔨 [FLY-560] Title` (emoji-only) or `🔨实现中 [FLY-560] Title`
	 * (emoji+word). Driven automatically from the `stage_changed` event; the Lead
	 * never touches it.
	 *
	 * `withWord` (FLY-560 UX iteration): when true the badge carries a short word
	 * after the emoji (Annie's feedback — emoji alone is hard to memorise). The
	 * production wiring reads it from `FLYWHEEL_ISSUE_STATUS_WORD` (default ON);
	 * it defaults to false here so an omitted arg keeps the emoji-only behaviour.
	 *
	 * Idempotent + churn-safe: reads the current name, swaps only the leading
	 * status badge (the title text is preserved, or rebuilt from `ctx` when the
	 * issue title is known), and skips the PATCH when the desired name already
	 * matches. Unknown stages no-op. Fire-and-forget: every failure path (GET
	 * 404, PATCH 429 rate-limit, timeout) is swallowed so the caller's stage
	 * transition is never blocked or broken — the next stage_changed reconciles.
	 */
	async stampStageEmoji(
		ctx: ChatThreadContext,
		threadId: string,
		stage: string,
		withWord = false,
	): Promise<void> {
		const badge = stageBadge(stage, withWord);
		if (!badge) return; // unknown stage → no-op (no fetch, no writer)
		return this.enqueueTitleWrite(threadId, ctx, badge);
	}

	/**
	 * FLY-623 Display-A: stamp the cross-cutting "⚠️重连中" reconnecting marker
	 * (`badge` non-null) or clear it back to the real/terminal badge (`badge` is the
	 * stage badge, or null to strip the prefix entirely). Routed through the SAME
	 * per-thread coalescing writer as stage stamps so a reconnecting stamp and a
	 * stage_changed stamp never race; idempotent (a no-op PATCH is skipped).
	 */
	async stampStatusBadge(
		ctx: ChatThreadContext,
		threadId: string,
		badge: string | null,
	): Promise<void> {
		return this.enqueueTitleWrite(threadId, ctx, badge);
	}

	/**
	 * FLY-630 ①: coalesce a title-write request into the per-thread writer. Records
	 * the LATEST desired badge; if a writer is already draining this thread, it
	 * just updates the target (intermediate stages collapse) and rides the same
	 * drain promise. Otherwise it starts a fresh drain. Returns the shared drain
	 * promise so callers (and tests) can await settle, but it is fire-and-forget at
	 * the production call sites.
	 */
	private enqueueTitleWrite(
		threadId: string,
		ctx: ChatThreadContext,
		target: string | null,
	): Promise<void> {
		const existing = this.titleWriters.get(threadId);
		if (existing) {
			// A writer is mid-drain — point it at the latest target. It re-reads
			// `target` at the top of its next loop iteration, so the intermediate is
			// coalesced away and only the latest badge is written.
			existing.ctx = ctx;
			existing.target = target;
			existing.dirty = true;
			return existing.done;
		}
		const state: TitleWriteState = {
			ctx,
			target,
			dirty: true,
			done: Promise.resolve(),
		};
		state.done = this.drainTitleWrites(threadId, state);
		this.titleWriters.set(threadId, state);
		return state.done;
	}

	/**
	 * FLY-630 ①: single per-thread drain loop. Writes the latest target; on a 429
	 * waits the honored Retry-After then retries the (possibly-advanced) latest
	 * target so the final stage always lands. Exits only when no newer target is
	 * pending; deletes the writer entry so a later stamp starts a fresh drain.
	 */
	private async drainTitleWrites(
		threadId: string,
		state: TitleWriteState,
	): Promise<void> {
		try {
			let rateLimitRetries = 0;
			while (state.dirty) {
				state.dirty = false;
				const ctx = state.ctx;
				const target = state.target;
				const result = await this.writeTitleOnce(ctx, threadId, target);
				if (
					result.status === "rate_limited" &&
					rateLimitRetries < MAX_RATE_LIMIT_RETRIES
				) {
					rateLimitRetries += 1;
					// Retry the LATEST target (it may have advanced while we waited).
					state.dirty = true;
					await this.titleWriteSleep(
						Math.min(result.retryAfterMs, MAX_RETRY_AFTER_MS),
					);
				} else if (result.status === "ok" || result.status === "noop") {
					// A successful write resets the retry budget for the next target.
					// If a newer target arrived during the write, `state.dirty` is set
					// and the loop writes it next; otherwise the loop exits.
					rateLimitRetries = 0;
				}
				// `error` / retries-exhausted: do NOT spin — loop only if a newer
				// target was queued during the write (state.dirty set by enqueue).
				// The next stage_changed reconciles a dropped write.
			}
		} finally {
			this.titleWriters.delete(threadId);
		}
	}

	/**
	 * FLY-630 ①: perform ONE GET+PATCH title write. Stamps `badge` onto the leading
	 * status position (or STRIPS the status prefix when `badge` is null), preserving
	 * the rest of the title (incl. manual curation) and skipping the no-op PATCH.
	 * Returns a structured result so the drain can honor a 429 Retry-After. Never
	 * throws — every failure path is logged and mapped to a result.
	 */
	private async writeTitleOnce(
		ctx: ChatThreadContext,
		threadId: string,
		badge: string | null,
	): Promise<TitleWriteResult> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), CREATE_TIMEOUT_MS);

		try {
			const getRes = await fetch(`${DISCORD_API}/channels/${threadId}`, {
				method: "GET",
				headers: { Authorization: `Bot ${ctx.botToken}` },
				signal: controller.signal,
			});
			if (!getRes.ok) {
				if (getRes.status === 429) {
					return {
						status: "rate_limited",
						retryAfterMs: await retryAfterMsFrom(getRes),
					};
				}
				const body = await getRes.text().catch(() => "");
				console.warn(
					`[ChatThreadCreator] stage-emoji GET failed: ${getRes.status} ${body.slice(0, 200)}`,
				);
				return { status: "error" };
			}

			const data = (await getRes.json().catch(() => ({}))) as {
				name?: unknown;
			};
			const currentName =
				typeof data.name === "string" ? data.name.trim() : undefined;

			// Base title (without status emoji). FLY-560 Codex R1 MEDIUM: Feature A
			// manages ONLY the leading emoji — preserve the existing title text
			// (including any manual curation), swapping just the emoji. Rebuild the
			// canonical `[FLY-XX] Title` from ctx only when the current title is a
			// placeholder (or empty) and the real title is known.
			// FLY-560 strips the leading stage emoji; FLY-728 works on a SUFFIX-FREE
			// base and re-appends the model code via composeThreadTitle (so it rides
			// the same rename as the stage badge, and long titles reserve room for
			// it). The placeholder check uses the bare base.
			const rawBase = splitStatusEmoji(currentName ?? "").base;
			const bareBase = stripModelSuffix(rawBase);
			// FLY-728 Part D (tri-state, Codex code R1 MEDIUM): an explicit code SETS
			// it, `null` CLEARS it (authoritative caller knows this run is account-
			// default — so a stale ·F from a prior run on a REUSED thread is removed),
			// and ABSENT preserves whatever is there (a caller with no model context).
			const effectiveCode =
				ctx.modelCode === undefined
					? modelSuffixCode(rawBase) // preserve
					: (ctx.modelCode ?? undefined); // set (code) or clear (null → undefined)
			let base: string | undefined;
			if (bareBase && !isPlaceholderThreadName(bareBase, ctx)) {
				base = bareBase;
			} else if (ctx.issueTitle && effectiveIssueKey(ctx)) {
				base = buildIssueThreadName(ctx);
			} else if (bareBase) {
				base = bareBase;
			}
			if (!base) return { status: "noop" };

			const desired = composeThreadTitle(
				badge ? `${badge} ` : "",
				base,
				effectiveCode,
			);
			if (currentName === desired) return { status: "noop" }; // already stamped

			const patchRes = await fetch(`${DISCORD_API}/channels/${threadId}`, {
				method: "PATCH",
				headers: {
					Authorization: `Bot ${ctx.botToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ name: desired }),
				signal: controller.signal,
			});
			if (!patchRes.ok) {
				if (patchRes.status === 429) {
					// FLY-630 ①: do NOT swallow the rate limit — surface it so the drain
					// retries the latest target after Discord's Retry-After.
					return {
						status: "rate_limited",
						retryAfterMs: await retryAfterMsFrom(patchRes),
					};
				}
				const body = await patchRes.text().catch(() => "");
				console.warn(
					`[ChatThreadCreator] stage-emoji PATCH failed: ${patchRes.status} ${body.slice(0, 200)}`,
				);
				return { status: "error" };
			}
			return { status: "ok" };
		} catch (err) {
			if ((err as Error).name === "AbortError") {
				console.warn(
					`[ChatThreadCreator] stage-emoji stamp timed out after ${CREATE_TIMEOUT_MS}ms`,
				);
			} else {
				console.warn(
					`[ChatThreadCreator] stage-emoji stamp error:`,
					(err as Error).message,
				);
			}
			return { status: "error" };
		} finally {
			clearTimeout(timeout);
		}
	}

	/**
	 * FLY-560 Feature C: per-thread serialization chain for the runner-attach pin
	 * (same rationale as `stampChains`): concurrent fire-and-forget calls for the
	 * same thread must run in submission order so two adjacent calls can't both
	 * read "no message yet" and double-POST the pin.
	 */
	private attachChains = new Map<string, Promise<void>>();

	/**
	 * FLY-560 Feature C: ensure the issue thread has a pinned, copy-pasteable
	 * `tmux attach` rescue command (`command`), kept current via the pin state
	 * machine below. Fire-and-forget; serialized per thread; never throws.
	 *
	 * `deps` injects the pin call + clock for tests.
	 */
	async ensureRunnerAttachPin(
		ctx: ChatThreadContext,
		threadId: string,
		command: string,
		deps: {
			pinImpl?: typeof pinThreadMessage;
			now?: () => string;
		} = {},
	): Promise<void> {
		const resolved = {
			pinImpl: deps.pinImpl ?? pinThreadMessage,
			now: deps.now ?? (() => new Date().toISOString()),
		};
		const prev = this.attachChains.get(threadId) ?? Promise.resolve();
		const next = prev
			.catch(() => undefined)
			.then(() =>
				this.ensureRunnerAttachPinNow(ctx, threadId, command, resolved),
			);
		this.attachChains.set(threadId, next);
		void next.finally(() => {
			if (this.attachChains.get(threadId) === next) {
				this.attachChains.delete(threadId);
			}
		});
		return next;
	}

	/** Render the pinned attach message (Annie-approved demo format). */
	private buildAttachMessageContent(
		ctx: ChatThreadContext,
		command: string,
	): string {
		const key = effectiveIssueKey(ctx);
		const label = key ? `[${key}]` : (ctx.issueTitle ?? ctx.issueId);
		return (
			`📌 **${label} Runner terminal** — copy & run to attach to this issue's runner:\n` +
			"```\n" +
			`${command}\n` +
			"```\n" +
			"_自动更新：runner 重起/换人时命令跟着变；runner 结束后命令失效（那时也不用 attach）。_"
		);
	}

	private async postAttachMessage(
		threadId: string,
		content: string,
		botToken: string,
		signal: AbortSignal,
	): Promise<string | undefined> {
		const res = await fetch(`${DISCORD_API}/channels/${threadId}/messages`, {
			method: "POST",
			headers: {
				Authorization: `Bot ${botToken}`,
				"Content-Type": "application/json",
			},
			// allowed_mentions parse:[] — the command/title text must never trigger
			// @everyone/@here/role pings (mirrors ensureChatThread).
			body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
			signal,
		});
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			console.warn(
				`[ChatThreadCreator] attach-pin POST failed: ${res.status} ${body.slice(0, 200)}`,
			);
			return undefined;
		}
		const data = (await res.json().catch(() => ({}))) as { id?: unknown };
		return typeof data.id === "string" ? data.id : undefined;
	}

	private async editAttachMessage(
		threadId: string,
		messageId: string,
		content: string,
		botToken: string,
		signal: AbortSignal,
	): Promise<"ok" | "missing" | "error"> {
		const res = await fetch(
			`${DISCORD_API}/channels/${threadId}/messages/${messageId}`,
			{
				method: "PATCH",
				headers: {
					Authorization: `Bot ${botToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
				signal,
			},
		);
		if (res.ok) return "ok";
		if (res.status === 404) return "missing";
		const body = await res.text().catch(() => "");
		console.warn(
			`[ChatThreadCreator] attach-pin PATCH failed: ${res.status} ${body.slice(0, 200)}`,
		);
		return "error";
	}

	/** POST a fresh attach message, record it, and pin it. */
	private async postAndPinAttach(
		ctx: ChatThreadContext,
		threadId: string,
		command: string,
		content: string,
		signal: AbortSignal,
		deps: { pinImpl: typeof pinThreadMessage; now: () => string },
	): Promise<void> {
		const messageId = await this.postAttachMessage(
			threadId,
			content,
			ctx.botToken,
			signal,
		);
		if (!messageId) return; // POST failed — next stage retries
		this.store.setChatThreadAttachPin(ctx.issueId, ctx.chatChannelId, {
			messageId,
			command,
			pinnedAt: null,
		});
		const pin = await deps.pinImpl(threadId, messageId, ctx.botToken);
		if (pin.outcome === "pinned") {
			this.store.setChatThreadAttachPin(ctx.issueId, ctx.chatChannelId, {
				messageId,
				command,
				pinnedAt: deps.now(),
			});
		} else if (pin.outcome === "missing") {
			// Codex code R1 MED-2: the just-posted message is already gone (404).
			// Don't retain a known-missing record — clear it so the next stage
			// reposts fresh (bounded: no same-call repost loop on a flapping 404).
			this.store.clearChatThreadAttachPin(ctx.issueId, ctx.chatChannelId);
		}
		// forbidden/error: leave pinnedAt null → next stage retries the pin.
	}

	/**
	 * FLY-560 Feature C pin state machine. See plan §组件 3:
	 *  - no record → POST + pin.
	 *  - command changed → EDIT in place (+ pin if not yet pinned). 404 → repost.
	 *  - command same + pinned → skip (zero churn).
	 *  - command same + NOT pinned → retry pin (self-heal after perms fixed).
	 *  - any pin/edit 404 → clear + repost in this same serialized call.
	 */
	private async ensureRunnerAttachPinNow(
		ctx: ChatThreadContext,
		threadId: string,
		command: string,
		deps: { pinImpl: typeof pinThreadMessage; now: () => string },
	): Promise<void> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), CREATE_TIMEOUT_MS);
		try {
			const content = this.buildAttachMessageContent(ctx, command);
			const pinState = this.store.getChatThreadAttachPin(
				ctx.issueId,
				ctx.chatChannelId,
			);

			if (!pinState) {
				await this.postAndPinAttach(
					ctx,
					threadId,
					command,
					content,
					controller.signal,
					deps,
				);
				return;
			}

			if (pinState.command !== command) {
				const edit = await this.editAttachMessage(
					threadId,
					pinState.messageId,
					content,
					ctx.botToken,
					controller.signal,
				);
				if (edit === "missing") {
					this.store.clearChatThreadAttachPin(ctx.issueId, ctx.chatChannelId);
					await this.postAndPinAttach(
						ctx,
						threadId,
						command,
						content,
						controller.signal,
						deps,
					);
					return;
				}
				if (edit === "error") return; // next stage retries
				// edit ok: command updated; an edit never unpins, so keep pinnedAt —
				// but if it was never pinned, ensure it is now.
				let pinnedAt = pinState.pinnedAt;
				if (!pinnedAt) {
					const pin = await deps.pinImpl(
						threadId,
						pinState.messageId,
						ctx.botToken,
					);
					if (pin.outcome === "pinned") pinnedAt = deps.now();
					else if (pin.outcome === "missing") {
						this.store.clearChatThreadAttachPin(ctx.issueId, ctx.chatChannelId);
						await this.postAndPinAttach(
							ctx,
							threadId,
							command,
							content,
							controller.signal,
							deps,
						);
						return;
					}
				}
				this.store.setChatThreadAttachPin(ctx.issueId, ctx.chatChannelId, {
					messageId: pinState.messageId,
					command,
					pinnedAt,
				});
				return;
			}

			// command unchanged
			if (pinState.pinnedAt) return; // already pinned — zero churn

			// posted but not yet pinned (e.g. earlier pin 403) → retry the pin.
			const pin = await deps.pinImpl(
				threadId,
				pinState.messageId,
				ctx.botToken,
			);
			if (pin.outcome === "pinned") {
				this.store.setChatThreadAttachPin(ctx.issueId, ctx.chatChannelId, {
					messageId: pinState.messageId,
					command,
					pinnedAt: deps.now(),
				});
			} else if (pin.outcome === "missing") {
				this.store.clearChatThreadAttachPin(ctx.issueId, ctx.chatChannelId);
				await this.postAndPinAttach(
					ctx,
					threadId,
					command,
					content,
					controller.signal,
					deps,
				);
			}
			// forbidden/error: leave pinnedAt null → next stage retries.
		} catch (err) {
			if ((err as Error).name === "AbortError") {
				console.warn(
					`[ChatThreadCreator] attach-pin timed out after ${CREATE_TIMEOUT_MS}ms`,
				);
			} else {
				console.warn(
					`[ChatThreadCreator] attach-pin error:`,
					(err as Error).message,
				);
			}
		} finally {
			clearTimeout(timeout);
		}
	}

	private async maybeBackfillThreadName(
		ctx: ChatThreadContext,
		threadId: string,
	): Promise<void> {
		if (!ctx.issueTitle) return;
		if (!effectiveIssueKey(ctx)) return;
		// FLY-728: carry the model code (backfill fills a placeholder → no suffix yet).
		const desiredName = composeThreadTitle(
			"",
			buildIssueThreadName(ctx),
			ctx.modelCode,
		);
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
