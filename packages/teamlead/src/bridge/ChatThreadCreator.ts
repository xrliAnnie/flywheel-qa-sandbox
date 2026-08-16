/**
 * FLY-91: ChatThreadCreator — Bridge creates per-issue chat threads in chatChannel.
 * Uses validateThreadExists for 404 detection, AbortController for 5s fail-open
 * timeout on Discord API.
 */

import type { StateStore } from "../StateStore.js";
import { markAutomatedDiscordText } from "./automated-message.js";
import {
	addThreadMember,
	createChatThread,
	parseRetryAfterMs,
	pinThreadMessage,
	removeUserFromChatThread,
} from "./chat-thread-utils.js";
import {
	type DisplayWriteResult,
	PHASE_DISPLAY_GLYPHS,
	type PhaseDisplayState,
} from "./issue-display.js";
import {
	applyModelMarker,
	modelMarkerLabel,
	splitStatusEmoji,
	stageBadge,
	stripModelMarker,
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

/** Discord rejects renames of archived threads with HTTP 400 / code 50083. */
function isArchivedThreadError(status: number, body: string): boolean {
	if (status !== 400) return false;
	try {
		const parsed = JSON.parse(body) as { code?: unknown };
		return parsed.code === 50083;
	} catch {
		return false;
	}
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
	| { status: "deferred" }
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
	/**
	 * FLY-907 (Step 2, Codex R2 #2): the LAST write outcome of this drain, so
	 * the result-returning stamp variants can report whether the (latest)
	 * target actually reached Discord. Coalesced requesters share the drain and
	 * therefore share this outcome — which is correct: the fingerprint they
	 * gate on is computed from the same latest derived state.
	 */
	lastStatus?: TitleWriteResult["status"];
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
	/** Founder-visible route line; rendered in messages/pins, never the title. */
	routeSummary?: string;
	/**
	 * FLY-755/1255: the resolved model's display marker, stamped as a FRONT
	 * bracket marker (`[F] ` or `[Model GPT-5.6] ` between the stage badge and
	 * issue key) that rides the same rename as the stage-emoji prefix.
	 * Tri-state (Codex code R1 MEDIUM — an authoritative stamp must be able to
	 * CLEAR a stale marker when a reused thread's run has no model):
	 *   - a string       → SET the validated marker to it
	 *   - `null`        → CLEAR it (the caller KNOWS this run is account-default)
	 *   - absent        → PRESERVE the existing marker (caller has no model context)
	 * Every stamp caller that has model context passes the shared display
	 * descriptor's thread marker, or null so account-default clears a stale one.
	 */
	modelMarker?: string | null;
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
	// FLY-892 (converge): the base title is `[FLY-XX] <title>` for every role. The
	// DAG workflow is no longer a separate thread with a base-title badge —
	// the current phase is shown as a STAGE-level title prefix (Step 6, stamped by
	// stampStageEmoji) and as a message tag, not baked into the base title.
	const title = ctx.issueTitle ?? ctx.issueId;
	if (issueKey) return `[${issueKey}] ${title}`;
	return title;
}

/**
 * FLY-755/1255: compose the final ≤100-char thread title. The model marker is a
 * FRONT bracket marker between the status prefix and base, so truncation eats
 * only the base's tail and the model stays visible on mobile. Validation and
 * issue-key anchoring are delegated to stage-utils' paired parser/inserter.
 */
function composeThreadTitle(
	prefix: string,
	base: string,
	modelMarker: string | null | undefined,
): string {
	const markedBase = applyModelMarker(base, modelMarker ?? undefined);
	const budget = DISCORD_THREAD_NAME_MAX - prefix.length;
	return `${prefix}${markedBase.slice(0, Math.max(0, budget))}`;
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

/**
 * FLY-892 (Step 4): one row of the pinned DAG workflow header. The caller
 * (event-route) pre-builds `label` (`[设计·Fable]`) and `plannedModel` so this
 * renderer stays config-free.
 */
export interface PhaseHeaderRow {
	/** `[设计·Fable]` — phase name · that phase's ACTUAL (or planned) model. */
	label: string;
	/**
	 * FLY-907 (Step 1c): the unified PhaseDisplayState vocabulary replaces the
	 * old header-local 3-state ("planned"/"active"/"done") — "pending" is the
	 * former "planned", and "blocked" (kill/terminate) is now representable.
	 */
	status: PhaseDisplayState;
	/** Planned model display name, for the "(计划模型 X)" suffix on a pending row. */
	plannedModel?: string;
	/** Short exec id — present when a session exists for this phase. */
	execId?: string;
	/** tmux/cmux attach command — present when CommDB resolves a live target. */
	attachCommand?: string;
	/** A DONE phase whose session is already gone (pre-FLY-887 keep-alive). */
	sessionEnded?: boolean;
	/**
	 * FLY-907 (Step 3): the CommDB tmux target resolved to a window that does
	 * NOT belong to this issue (identifier-prefix mismatch — FLY-543/923
	 * cross-wire). The attach command is withheld; the row renders a degraded
	 * `_(终端待解析)_` marker instead of a link into another issue's window.
	 */
	attachUnresolved?: boolean;
}

/**
 * FLY-892 (Step 4, founder-approved ①+②): render the single pinned "pipeline
 * header" that lists all three phases — model tag + status (✅/▶/⬜) + exec id +
 * attach command — so the founder reads the whole issue at a glance and can jump
 * to any phase's scrollback. It ABSORBS the FLY-560 "Runner terminal" pin (one
 * pinned message, edited in place, never a second pin). Pre-887, a done phase
 * whose session is gone shows "✅ 完成" with "（session 已结束）"; once FLY-887 keeps
 * phase sessions alive, the same code renders an attach command for all three —
 * usability-driven, this reads CommDB only and never touches 887's lifecycle.
 */
export function buildPipelineHeaderContent(
	ctx: Pick<ChatThreadContext, "issueId" | "issueIdentifier" | "routeSummary">,
	phases: PhaseHeaderRow[],
): string {
	const key = effectiveIssueKey(ctx);
	const label = key ? `[${key}]` : ctx.issueId;
	const lines: string[] = [
		...(ctx.routeSummary ? [ctx.routeSummary] : []),
		`📌 **${label} DAG 工作流**`,
	];
	for (const p of phases) {
		const head = `**${p.label}** ${PHASE_DISPLAY_GLYPHS[p.status]}`;
		if (p.status === "pending") {
			lines.push(
				p.plannedModel ? `${head}（计划模型 ${p.plannedModel}）` : head,
			);
			continue;
		}
		lines.push(p.execId ? `${head} · exec \`${p.execId}\`` : head);
		if (p.attachCommand) lines.push(`\`${p.attachCommand}\``);
		else if (p.attachUnresolved) lines.push("_（终端待解析）_");
		else if (p.sessionEnded) lines.push("_（session 已结束）_");
	}
	lines.push(
		"_自动更新：各节点用什么模型、跑到哪、去哪看终端，一条置顶看全。_",
	);
	return lines.join("\n");
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
		// FLY-892 (converge): one issue = one thread — the inflight-dedup key is
		// `(issue, channel)` so concurrent design + implement ensures for the SAME
		// issue collapse into a single create (never a duplicate thread).
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
		// 1. Check existing mapping (FLY-892: the single (issue, channel) thread).
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
		// FLY-755/1255: stamp the model marker at thread creation
		// so a new thread shows `[F] [FLY-XX] …` immediately, not only after the
		// first stage_changed.
		const threadName = composeThreadTitle(
			"",
			buildIssueThreadName(ctx),
			ctx.modelMarker,
		);

		const issueKey = effectiveIssueKey(ctx);
		const issueMessage = issueKey
			? `🧵 **${issueKey}** — ${ctx.issueTitle ?? "Runner session"}`
			: `🧵 ${ctx.issueTitle ?? ctx.issueId}`;
		const messageContent = ctx.routeSummary
			? `${ctx.routeSummary}\n${issueMessage}`
			: issueMessage;

		// FLY-1544 ③: the two-step REST flow lives in chat-thread-utils
		// (createChatThread) so the v2 Discord messenger shares ONE implementation.
		console.log(
			`[ChatThreadCreator] create thread channel=${ctx.chatChannelId} name="${threadName.slice(0, 60)}" content="${messageContent.slice(0, 80)}"`,
		);
		const created = await createChatThread(
			{
				channelId: ctx.chatChannelId,
				threadName,
				messageContent: markAutomatedDiscordText(messageContent),
				botToken: ctx.botToken,
			},
			{ timeoutMs: CREATE_TIMEOUT_MS },
		);
		if (!created.created) {
			console.warn(`[ChatThreadCreator] create FAILED: ${created.error}`);
			return { created: false, error: created.error };
		}

		// 3. Store mapping (FLY-892: the single (issue, channel) thread).
		this.store.upsertChatThread(
			created.threadId,
			ctx.chatChannelId,
			ctx.issueId,
			ctx.leadId,
		);

		// 4. Auto-add owner as thread member (sidebar visibility + notifications)
		if (ctx.ownerUserId) {
			await addThreadMember(created.threadId, ctx.ownerUserId, ctx.botToken);
		}

		return { created: true, threadId: created.threadId };
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
	 * production wiring passes true; it defaults to false here so an omitted arg
	 * keeps the API's historical emoji-only behaviour.
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
		phaseBadge?: string | null,
	): Promise<void> {
		// FLY-892 (Step 6): on a DAG workflow issue the title carries the STAGE-LEVEL
		// phase badge (🎨设计/🔨实现/🧪QA) — Annie's locked glyphs — INSTEAD of the
		// FLY-560 fine-grained per-stage word, so the whole pipeline renames ~twice.
		// A non-empty `phaseBadge` overrides; else fall back to the FLY-560 stage
		// badge (non-DAG workflow byte-compat). Same coalescing writer either way.
		const badge = phaseBadge ? phaseBadge : stageBadge(stage, withWord);
		if (!badge) return; // unknown stage + no phase badge → no-op (no fetch)
		return this.enqueueTitleWrite(threadId, ctx, badge);
	}

	/**
	 * FLY-907 (Step 2): result-returning variant of `stampStageEmoji` for the
	 * unified issue-display refresher — same coalescing writer, but reports
	 * whether the (latest) badge actually reached Discord so the refresher can
	 * decide whether to persist its reconcile fingerprint. The public void
	 * method above stays byte-compatible for existing callers.
	 */
	async stampStageEmojiResult(
		ctx: ChatThreadContext,
		threadId: string,
		stage: string,
		withWord = false,
		phaseBadge?: string | null,
	): Promise<DisplayWriteResult> {
		const badge = phaseBadge ? phaseBadge : stageBadge(stage, withWord);
		if (!badge) return "noop"; // unknown stage + no phase badge → nothing to write
		return this.enqueueTitleWriteResult(threadId, ctx, badge);
	}

	/**
	 * FLY-907 (Step 2): result-returning variant of `stampStatusBadge` (used for
	 * the cross-cutting 🔴受阻 badge, which is not a pipeline stage).
	 */
	async stampStatusBadgeResult(
		ctx: ChatThreadContext,
		threadId: string,
		badge: string | null,
	): Promise<DisplayWriteResult> {
		return this.enqueueTitleWriteResult(threadId, ctx, badge);
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
	 * FLY-907 (Step 2): enqueue a title write and map the drain's final outcome
	 * onto the DisplayWriteResult contract: ok→changed, noop→noop, a 429 whose
	 * retries were exhausted→deferred (retry via sweep), error→failed.
	 */
	private enqueueTitleWriteResult(
		threadId: string,
		ctx: ChatThreadContext,
		target: string | null,
	): Promise<DisplayWriteResult> {
		this.enqueueTitleWrite(threadId, ctx, target);
		// enqueueTitleWrite either created the state or updated the existing one —
		// read the live entry so we share ITS drain + outcome.
		const state = this.titleWriters.get(threadId);
		if (!state) return Promise.resolve("failed");
		return state.done.then((): DisplayWriteResult => {
			switch (state.lastStatus) {
				case "ok":
					return "changed";
				case "noop":
					return "noop";
				case "rate_limited":
				case "deferred":
					return "deferred";
				default:
					return "failed";
			}
		});
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
				state.lastStatus = result.status;
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
				// `error` / `deferred` / retries-exhausted: do NOT spin — loop only
				// if a newer target was queued during the write (state.dirty set by
				// enqueue). The issue-display sweep owns the later retry.
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
			// FLY-560 strips the leading stage emoji; FLY-755 works on a MARKER-FREE
			// base and re-inserts the model marker via composeThreadTitle (so it rides
			// the same rename as the stage badge). The placeholder check uses the
			// bare base. stripModelMarker also peels a legacy FLY-728 tail (` ·F`),
			// so pre-755 threads migrate to the front marker on this re-stamp.
			const rawBase = splitStatusEmoji(currentName ?? "").base;
			const bareBase = stripModelMarker(rawBase);
			// Tri-state (FLY-728 Codex code R1 MEDIUM): an explicit code SETS it,
			// `null` CLEARS it (authoritative caller knows this run is account-
			// default — so a stale [F] from a prior run on a REUSED thread is
			// removed), and ABSENT preserves whatever is there (a caller with no
			// model context) — front marker first, legacy tail as fallback.
			const effectiveMarker =
				ctx.modelMarker === undefined
					? modelMarkerLabel(rawBase) // preserve
					: (ctx.modelMarker ?? undefined); // set or clear (null → undefined)
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
				effectiveMarker,
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
				if (isArchivedThreadError(patchRes.status, body)) {
					return { status: "deferred" };
				}
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
	private attachChains = new Map<string, Promise<unknown>>();

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
		await this.ensureRunnerAttachPinResult(ctx, threadId, command, deps);
	}

	/**
	 * FLY-907 (Step 2): result-returning variant of `ensureRunnerAttachPin` for
	 * the unified refresher (fingerprint gating). Public void method unchanged.
	 */
	async ensureRunnerAttachPinResult(
		ctx: ChatThreadContext,
		threadId: string,
		command: string,
		deps: {
			pinImpl?: typeof pinThreadMessage;
			now?: () => string;
		} = {},
	): Promise<DisplayWriteResult> {
		// Single-runner (non-DAG workflow) path: fingerprint = the raw command
		// (byte-compat), rendered message = the "📌 Runner terminal" template.
		return this.enqueueAttachPin(
			ctx,
			threadId,
			command,
			this.buildAttachMessageContent(ctx, command),
			deps,
		);
	}

	/**
	 * FLY-907 (Step 3): degrade the single-runner attach pin when the CommDB
	 * tmux target resolved to ANOTHER issue's window (identifier-prefix
	 * mismatch — FLY-543/923 cross-wire). The pin is actively rewritten to a
	 * `_（终端待解析）_` marker so a stale/cross-wired command from a prior exec
	 * is never left visible — the founder must NEVER be handed a wrong link.
	 */
	async ensureRunnerAttachUnresolvedResult(
		ctx: ChatThreadContext,
		threadId: string,
		deps: {
			pinImpl?: typeof pinThreadMessage;
			now?: () => string;
		} = {},
	): Promise<DisplayWriteResult> {
		const key = effectiveIssueKey(ctx);
		const label = key ? `[${key}]` : (ctx.issueTitle ?? ctx.issueId);
		const content =
			`${ctx.routeSummary ? `${ctx.routeSummary}\n` : ""}` +
			`📌 **${label} Runner terminal** — _（终端待解析）_\n` +
			"_当前 tmux 目标与本 issue 不符，已暂不显示 attach 命令；解析恢复后自动更新。_";
		return this.enqueueAttachPin(
			ctx,
			threadId,
			"(attach-unresolved)",
			content,
			deps,
		);
	}

	/**
	 * FLY-892 (Step 4): ensure the issue thread's pinned message is the DAG workflow
	 * PIPELINE HEADER (`content` pre-rendered by `buildPipelineHeaderContent`). Uses
	 * the SAME per-thread serialized pin state-machine as the single-runner attach
	 * pin — it just absorbs the existing "Runner terminal" pin into a richer body.
	 * The idempotency fingerprint IS the rendered content, so an unchanged header
	 * is a zero-PATCH no-op and a phase advance is a single in-place edit.
	 */
	async ensureRunnerPipelineHeaderPin(
		ctx: ChatThreadContext,
		threadId: string,
		content: string,
		deps: {
			pinImpl?: typeof pinThreadMessage;
			now?: () => string;
		} = {},
	): Promise<void> {
		await this.enqueueAttachPin(ctx, threadId, content, content, deps);
	}

	/**
	 * FLY-907 (Step 2): result-returning variant of `ensureRunnerPipelineHeaderPin`
	 * for the unified refresher (fingerprint gating). Public void method unchanged.
	 */
	async ensureRunnerPipelineHeaderPinResult(
		ctx: ChatThreadContext,
		threadId: string,
		content: string,
		deps: {
			pinImpl?: typeof pinThreadMessage;
			now?: () => string;
		} = {},
	): Promise<DisplayWriteResult> {
		return this.enqueueAttachPin(ctx, threadId, content, content, deps);
	}

	/** Per-thread serialized enqueue of a pin write (fingerprint = idempotency key,
	 *  content = the rendered message body). Shared by the single-runner attach pin
	 *  and the FLY-892 pipeline header. */
	private enqueueAttachPin(
		ctx: ChatThreadContext,
		threadId: string,
		fingerprint: string,
		content: string,
		deps: {
			pinImpl?: typeof pinThreadMessage;
			now?: () => string;
		},
	): Promise<DisplayWriteResult> {
		const resolved = {
			pinImpl: deps.pinImpl ?? pinThreadMessage,
			now: deps.now ?? (() => new Date().toISOString()),
		};
		const prev = this.attachChains.get(threadId) ?? Promise.resolve();
		const next = prev
			.catch(() => undefined)
			.then(() =>
				this.ensureRunnerAttachPinNow(
					ctx,
					threadId,
					fingerprint,
					content,
					resolved,
				),
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
			`${ctx.routeSummary ? `${ctx.routeSummary}\n` : ""}` +
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
			body: JSON.stringify({
				content: markAutomatedDiscordText(content),
				allowed_mentions: { parse: [] },
			}),
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
				body: JSON.stringify({
					content: markAutomatedDiscordText(content),
					allowed_mentions: { parse: [] },
				}),
				signal,
			},
		);
		if (res.ok) return "ok";
		// 404 — message gone. 403 (FLY-892 Step 7) — a DIFFERENT bot owns this pin
		// (the announcer took over a pin the Lead bot originally created; Discord
		// only lets the author edit). Both self-heal the same way: clear the stale
		// record + repost under the current (announcer) bot. A genuine perm 403 just
		// re-posts fresh next stage (bounded, no loop) once perms are fixed.
		if (res.status === 404 || res.status === 403) return "missing";
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
	): Promise<DisplayWriteResult> {
		const messageId = await this.postAttachMessage(
			threadId,
			content,
			ctx.botToken,
			signal,
		);
		if (!messageId) return "failed"; // POST failed — next stage retries
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
			return "failed";
		} else {
			// forbidden/error: content posted but NOT pinned — leave pinnedAt null
			// and report DEFERRED (FLY-907 Codex R1 MED-1): the reconcile
			// fingerprint must NOT persist while the pin is outstanding, or a
			// terminal issue's sweep would never retry the pin. Bounded churn: one
			// pin retry per sweep tick until perms are fixed.
			return "deferred";
		}
		return "changed";
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
		// FLY-892 (Step 4): `fingerprint` is the idempotency key stored in the
		// `attach_pin_command` column; `content` is the rendered message body. For
		// the single-runner pin they are (rawCommand, renderedTemplate); for the
		// pipeline header they are (renderedHeader, renderedHeader).
		fingerprint: string,
		content: string,
		deps: { pinImpl: typeof pinThreadMessage; now: () => string },
	): Promise<DisplayWriteResult> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), CREATE_TIMEOUT_MS);
		try {
			const command = fingerprint;
			const pinState = this.store.getChatThreadAttachPin(
				ctx.issueId,
				ctx.chatChannelId,
			);

			if (!pinState) {
				return await this.postAndPinAttach(
					ctx,
					threadId,
					command,
					content,
					controller.signal,
					deps,
				);
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
					return await this.postAndPinAttach(
						ctx,
						threadId,
						command,
						content,
						controller.signal,
						deps,
					);
				}
				if (edit === "error") return "failed"; // next stage retries
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
						return await this.postAndPinAttach(
							ctx,
							threadId,
							command,
							content,
							controller.signal,
							deps,
						);
					}
				}
				this.store.setChatThreadAttachPin(ctx.issueId, ctx.chatChannelId, {
					messageId: pinState.messageId,
					command,
					pinnedAt,
				});
				// FLY-907 Codex R1 MED-1: content updated but still unpinned →
				// DEFERRED, so the fingerprint stays unset and the sweep retries.
				return pinnedAt ? "changed" : "deferred";
			}

			// command unchanged
			if (pinState.pinnedAt) return "noop"; // already pinned — zero churn

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
				return "noop"; // content unchanged; the pin flag self-healed
			}
			if (pin.outcome === "missing") {
				this.store.clearChatThreadAttachPin(ctx.issueId, ctx.chatChannelId);
				return await this.postAndPinAttach(
					ctx,
					threadId,
					command,
					content,
					controller.signal,
					deps,
				);
			}
			// forbidden/error: leave pinnedAt null → next stage retries. FLY-907
			// Codex R1 MED-1: report DEFERRED (not noop) — the fingerprint must not
			// persist while the pin is outstanding, or a terminal issue's sweep
			// would never retry it.
			return "deferred";
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
			return "failed";
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
			// FLY-755 (Codex design R1 #1): the placeholder gate must see THROUGH
			// the model marker (and a legacy ` ·F` tail) — a marker-carrying
			// placeholder (`[F] [FLY-509] FLY-509`) must still backfill once the
			// real title arrives.
			const bareCurrentName = currentName
				? stripModelMarker(currentName)
				: undefined;
			if (!isPlaceholderThreadName(bareCurrentName, ctx)) return;
			// Same tri-state as the stage stamp: absent modelMarker (e.g. the /send
			// route in tools.ts) PRESERVES the marker already on the placeholder —
			// front marker first, legacy tail as fallback (which thereby migrates).
			const effectiveMarker =
				ctx.modelMarker === undefined
					? modelMarkerLabel(currentName ?? "")
					: (ctx.modelMarker ?? undefined);
			const desiredName = composeThreadTitle(
				"",
				buildIssueThreadName(ctx),
				effectiveMarker,
			);
			if (!desiredName || desiredName === ctx.issueId) return;
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
		const threadLink = `🧵 ${label} — <#${threadId}>`;
		const content = ctx.routeSummary
			? `${ctx.routeSummary}\n${threadLink}`
			: threadLink;

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
					body: JSON.stringify({
						content: markAutomatedDiscordText(content),
						allowed_mentions: { parse: [] },
					}),
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
