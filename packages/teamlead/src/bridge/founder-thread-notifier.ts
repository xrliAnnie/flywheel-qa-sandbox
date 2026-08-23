/**
 * FLY-605 Part A (outbound runner→founder): post a structured "this gate is
 * waiting for you" notification + @founder directly into the per-issue Discord
 * thread (never the FLY-368 alert channel — that was the rejected FLY-523 path).
 *
 * Modeled on `runner-ready-to-close-notifier.ts` (direct POST to the thread +
 * audit events) but DELIBERATELY NOT claim-first: that one writes a dedup claim
 * BEFORE the POST, so a transient Discord failure permanently drops the
 * notification (`runner-ready-to-close-notifier.ts`). The whole point of FLY-605
 * is "the founder always gets it", so dedup + retry are owned by the caller
 * (`GatePoller.maybeEmitFounderThreadFallback`); this notifier just posts once
 * and classifies the outcome.
 */

import { randomUUID } from "node:crypto";
import { parseFounderReviewQuestionContent } from "flywheel-comm/founder-review";
import type { StateStore } from "../StateStore.js";
import { extractGateMessageId } from "./approval-signal/gate-message-binding.js";
import { markAutomatedDiscordText } from "./automated-message.js";
import { parseRetryAfterMs } from "./chat-thread-utils.js";
import { isDiscordSnowflake, truncate } from "./founder-notify-utils.js";

const DISCORD_API = "https://discord.com/api/v10";
const POST_TIMEOUT_MS = 5_000;
const SUMMARY_MAX = 1_500;

/** `getChatThreadByIssue` returns `{ thread_id, channel_id, ... } | undefined`. */
export type ChatThreadRef = NonNullable<
	ReturnType<StateStore["getChatThreadByIssue"]>
>;

export type FounderGateCheckpoint =
	| "brainstorm"
	| "founder_review"
	| "approve_to_ship"
	| "ship_ready";

export interface FounderThreadNotifyOpts {
	questionId: string;
	checkpoint: FounderGateCheckpoint;
	executionId: string;
	issueId: string;
	issueIdentifier?: string;
	projectName: string;
	/** Already-resolved (content_ref dereferenced) question content. */
	summary: string;
	/** Minutes since the gate was raised (display only). */
	ageMinutes: number;
	/** Pre-resolved via getChatThreadByIssue. */
	thread?: ChatThreadRef;
	/** lead.botToken ?? config.discordBotToken. */
	botToken?: string;
	/** config.discordOwnerUserId (for @mention + ping). */
	ownerUserId?: string;
	/**
	 * FLY-892 (Step 3): the message-level phase tag (`[设计·Fable] ` …) prepended to
	 * the header so, in the single converged issue thread, the founder can tell
	 * which of the DAG workflow sessions is speaking. Empty for a main / non-
	 * DAG workflow session → byte-unchanged. Callers pass
	 * `phaseMessageTag(session.chat_thread_role, session.runner_model,
	 * session.design_backend)`.
	 */
	phasePrefix?: string;
	/** Stable footer used to reconcile a successful POST whose response id was lost. */
	correlationMarker?: string;
	/** The workflow materializer owns the one authoritative success audit. */
	deferSuccessAudit?: boolean;
}

export interface FounderThreadNotifyDeps {
	store: StateStore;
	/** Test seam for Discord HTTP. */
	fetchImpl?: typeof fetch;
}

export type FounderThreadNotifyKind =
	| "posted"
	| "posted_ambiguous"
	| "skipped"
	| "permanent_failed"
	| "transient_failed";

/** FLY-725: why a post was skipped, so the caller can retry vs. escalate. */
export type FounderThreadSkipReason =
	| "no_chat_thread"
	| "no_bot_token"
	| "no_owner"
	| "bad_owner_id";

export interface FounderThreadNotifyResult {
	kind: FounderThreadNotifyKind;
	/** Only on a 429 transient_failed — Discord's honored Retry-After in ms. */
	retryAfterMs?: number;
	/** True when Discord definitively rejected the write before creating a message. */
	deliveryRejected?: boolean;
	/**
	 * Only on `skipped`. `no_chat_thread` is TRANSIENT (the thread may be created
	 * later → the caller retries within budget); the others are config errors the
	 * caller should escalate rather than silently drop (Annie 2026-07-01).
	 */
	skipReason?: FounderThreadSkipReason;
	/**
	 * FLY-799 A-0b: only on `posted` — the created Discord message id, so the
	 * ship-gate caller can durably bind `(questionId,prHeadSha)->gateMessageId`
	 * for ReactionSource. Optional/best-effort: undefined if the POST body could
	 * not be parsed (the post still succeeded).
	 */
	gateMessageId?: string;
}

function buildBody(opts: FounderThreadNotifyOpts): string {
	const identifier = opts.issueIdentifier ?? opts.issueId;
	const owner = `<@${opts.ownerUserId}>`;
	const summary = truncate(opts.summary, SUMMARY_MAX);
	const prefix = opts.phasePrefix ?? ""; // FLY-892 Step 3 — "" for main (byte-compat)
	if (opts.checkpoint === "approve_to_ship") {
		return [
			`${prefix}🚀 **Ship gate 等你批准** — ${identifier}`,
			owner,
			"",
			summary,
			"",
			"…实现 + code-review 完成、等你 ship。",
			// FLY-1041 Chunk 6: the card is the deterministic approval carrier —
			// spell out the two binding actions + the ✅ receipt promise so a short
			// reply elsewhere in the thread is never mistaken for the protocol.
			"批准 → 在这张卡点 ✅，或 reply-to 这张卡只回「approve」或「look good to me」。打回 → reply-to 这张卡回复「打回」，或用 design: / implement: / qa: 前缀说明返工对象。提问和讨论 → 直接发在本 thread，由 Lead 接；不会写入 verdict，本轮保持开放。批准绑定后我会在你的消息上点 ✅ 确认。",
			...(opts.correlationMarker ? ["", opts.correlationMarker] : []),
		].join("\n");
	}
	if (opts.checkpoint === "ship_ready") {
		return [
			`${prefix}🚀 **Ship 就绪** — ${identifier}`,
			owner,
			"",
			summary,
			"",
			"Lead 已同步收到。要 ship 请在本 thread 表态，由 Lead 执行合并；此卡为通知，回复/✅ 不会自动记为批准。",
			...(opts.correlationMarker ? ["", opts.correlationMarker] : []),
		].join("\n");
	}
	if (opts.checkpoint === "founder_review") {
		const review = parseFounderReviewQuestionContent(opts.summary);
		const round = review?.round ?? "?";
		const url = review?.hostedUrl ?? "审阅链接无效；请让 Lead 重新送达";
		return [
			`${prefix}📝 **阶段产出 review · 第 ${round} 轮** — ${identifier}`,
			owner,
			"",
			url,
			"",
			"评论 / 提问 → 直接发在本 thread，由 Lead 接。页面里逐处留言后，记得点「一键汇总复制」再贴回来，我才收得到；thread 里的自由发言不会写入 verdict。",
			"批准 → 在这张卡点 ✅，或 reply-to 这张卡只回「approve」或「look good to me」。",
			"打回 → reply-to 这张卡回复「打回」，或用 design: / implement: / qa: 前缀说明返工对象。",
			...(opts.correlationMarker ? ["", opts.correlationMarker] : []),
		].join("\n");
	}
	return [
		`${prefix}🧠 **Brainstorm gate 等你确认** — ${identifier}`,
		owner,
		"",
		summary,
		"",
		`已等 ${opts.ageMinutes} 分钟没人答（Lead 可能漏转）。在本 thread 回复确认/纠正。`,
		...(opts.correlationMarker ? ["", opts.correlationMarker] : []),
	].join("\n");
}

function audit(
	store: StateStore,
	opts: FounderThreadNotifyOpts,
	eventType: string,
	payload: Record<string, unknown>,
): void {
	store.insertEvent({
		event_id: `${eventType}-${randomUUID()}`,
		execution_id: opts.executionId,
		issue_id: opts.issueId,
		project_name: opts.projectName,
		event_type: eventType,
		source: "bridge.founder-thread-notifier",
		payload: {
			questionId: opts.questionId,
			checkpoint: opts.checkpoint,
			...payload,
		},
	});
}

export async function emitFounderThreadNotification(
	opts: FounderThreadNotifyOpts,
	deps: FounderThreadNotifyDeps,
): Promise<FounderThreadNotifyResult> {
	const { store, fetchImpl = fetch } = deps;

	// ── (A) VALIDATE ──
	if (!opts.thread?.thread_id) {
		audit(store, opts, "founder_thread_notify_skipped", {
			reason: "no_chat_thread",
		});
		return { kind: "skipped", skipReason: "no_chat_thread" };
	}
	if (!opts.botToken) {
		audit(store, opts, "founder_thread_notify_skipped", {
			reason: "no_bot_token",
		});
		return { kind: "skipped", skipReason: "no_bot_token" };
	}
	if (!opts.ownerUserId) {
		audit(store, opts, "founder_thread_notify_skipped", { reason: "no_owner" });
		return { kind: "skipped", skipReason: "no_owner" };
	}
	if (!isDiscordSnowflake(opts.ownerUserId)) {
		// Codex R2 #4: a malformed owner id would make Discord reject the POST
		// with 400; refuse to send rather than spin on a config error.
		audit(store, opts, "founder_thread_notify_skipped", {
			reason: "bad_owner_id",
		});
		return { kind: "skipped", skipReason: "bad_owner_id" };
	}

	// ── (B) COMPOSE + POST + (C) CLASSIFY (shared core; FLY-725 extract) ──
	const body = buildBody(opts);
	const outcome = await postFounderThreadCore(
		opts.thread.thread_id,
		body,
		opts.botToken,
		opts.ownerUserId,
		fetchImpl,
	);
	// Audit + return (byte-compatible; FLY-799 adds the optional gateMessageId).
	if (outcome.kind === "posted") {
		if (!opts.deferSuccessAudit) {
			audit(store, opts, "founder_thread_notified", {
				threadId: opts.thread.thread_id,
				status: outcome.status,
				gateMessageId: outcome.messageId,
			});
		}
		return { kind: "posted", gateMessageId: outcome.messageId };
	}
	if (outcome.kind === "posted_ambiguous") {
		// Legacy callers do not require a message id and historically treat a 2xx
		// as delivered. Only a correlation-marked materializer call must reconcile
		// before claiming the authoritative gate card.
		if (!opts.correlationMarker) {
			audit(store, opts, "founder_thread_notified", {
				threadId: opts.thread.thread_id,
				status: outcome.status,
			});
			return { kind: "posted" };
		}
		audit(store, opts, "founder_thread_notify_ambiguous", {
			threadId: opts.thread.thread_id,
			status: outcome.status,
		});
		return { kind: "posted_ambiguous" };
	}
	if (outcome.kind === "transient_failed") {
		if (outcome.status === 429) {
			audit(store, opts, "founder_thread_notify_failed", {
				severity: "transient",
				status: 429,
				retryAfterMs: outcome.retryAfterMs,
			});
			return {
				kind: "transient_failed",
				retryAfterMs: outcome.retryAfterMs,
				deliveryRejected: true,
			};
		}
		if (outcome.status !== undefined) {
			// 5xx
			audit(store, opts, "founder_thread_notify_failed", {
				severity: "transient",
				status: outcome.status,
			});
			return { kind: "transient_failed" };
		}
		// Network error / abort / timeout — transient.
		audit(store, opts, "founder_thread_notify_failed", {
			severity: "transient",
			error: outcome.error,
		});
		return { kind: "transient_failed" };
	}
	// Any other 4xx (incl. 400 malformed mention / 401/403/404) — client
	// error, retrying won't help (Codex R2 #4).
	audit(store, opts, "founder_thread_notify_failed", {
		severity: "permanent",
		status: outcome.status,
		body: outcome.body,
	});
	return { kind: "permanent_failed" };
}

/**
 * FLY-725: shared POST + classify core for founder-thread pushes.
 * Does the Discord POST (with the founder-only mention) and classifies the
 * response into posted / transient / permanent — WITHOUT auditing (each caller
 * owns its own audit event names). Extracted verbatim from the old inline block
 * in `emitFounderThreadNotification` so the gate path behaves identically.
 */
type PostFounderThreadOutcome =
	| { kind: "posted"; status: number; messageId?: string }
	| { kind: "posted_ambiguous"; status: number }
	| {
			kind: "transient_failed";
			/** 429 or 5xx status; undefined for a network error / abort / timeout. */
			status?: number;
			retryAfterMs?: number;
			error?: string;
	  }
	| { kind: "permanent_failed"; status: number; body: string };

async function postFounderThreadCore(
	threadId: string,
	body: string,
	botToken: string,
	// FLY-927: null ⇒ suppress ALL mentions (parse:[]) — the infra-notification
	// leg posts without a ping. The gate/stuck callers always pass the
	// validated founder id, so their POST bodies are unchanged.
	ownerUserId: string | null,
	fetchImpl: typeof fetch,
): Promise<PostFounderThreadOutcome> {
	const controller = new AbortController();
	const headerTimer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
	try {
		const res = await fetchImpl(
			`${DISCORD_API}/channels/${threadId}/messages`,
			{
				method: "POST",
				headers: {
					Authorization: `Bot ${botToken}`,
					"Content-Type": "application/json",
				},
				// FLY-162: explicitly allow ONLY the founder user mention; block
				// @everyone/@here/role (ChatThreadCreator default blocks all mentions).
				// FLY-1189: allowed_mentions is only a FILTER — the ping fires only if
				// the body actually contains <@id>. The detection-escalation leg passes
				// ownerUserId but omits the mention, so the founder never got pinged.
				// Prepend it idempotently; callers already carrying <@id> are unchanged.
				body: JSON.stringify({
					content: markAutomatedDiscordText(
						ownerUserId && !body.includes(`<@${ownerUserId}>`)
							? `<@${ownerUserId}> ${body}`
							: body,
					),
					allowed_mentions: ownerUserId
						? { users: [ownerUserId] }
						: { parse: [] as string[] },
				}),
				signal: controller.signal,
			},
		);
		clearTimeout(headerTimer);
		if (res.ok) {
			// FLY-799 A-0b: capture the created message id so the ship-gate path can
			// durably bind (questionId,prHeadSha)->gateMessageId for ReactionSource.
			// Best-effort: a body-parse failure must NOT change the posted outcome.
			let messageId: string | undefined;
			let bodyTimer: ReturnType<typeof setTimeout> | undefined;
			try {
				const parsed = await Promise.race([
					res.json(),
					new Promise<never>((_, reject) => {
						bodyTimer = setTimeout(() => {
							controller.abort();
							reject(new Error("discord_post_body_timeout"));
						}, POST_TIMEOUT_MS);
					}),
				]);
				messageId = extractGateMessageId(parsed) ?? undefined;
			} catch {
				return { kind: "posted_ambiguous", status: res.status };
			} finally {
				if (bodyTimer) clearTimeout(bodyTimer);
			}
			return messageId
				? { kind: "posted", status: res.status, messageId }
				: { kind: "posted_ambiguous", status: res.status };
		}
		if (res.status === 429) {
			const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
			return { kind: "transient_failed", status: 429, retryAfterMs };
		}
		if (res.status >= 500) {
			return { kind: "transient_failed", status: res.status };
		}
		const text = await res.text().catch(() => "");
		return {
			kind: "permanent_failed",
			status: res.status,
			body: text.slice(0, 300),
		};
	} catch (err) {
		return { kind: "transient_failed", error: (err as Error).message };
	} finally {
		clearTimeout(headerTimer);
	}
}

export type FounderGateCardScanResult =
	| { kind: "found"; messageId: string; frontier: string | null }
	| { kind: "none"; frontier: string | null }
	| { kind: "ambiguous"; frontier: string | null; reason: string };

/**
 * Reconcile an ambiguous Discord POST without guessing. A retry is eligible
 * only after a complete scan proves the correlation marker absent; pagination,
 * timeouts, malformed responses, and multiple matches all stay fail-closed.
 */
export async function scanFounderThreadForGateCard(input: {
	threadId: string;
	botToken: string;
	postedAt: string;
	correlationMarker?: string;
	legacyTerms?: string[];
	pageCap?: number;
	deadlineMs?: number;
	fetchImpl?: typeof fetch;
}): Promise<FounderGateCardScanResult> {
	const fetchImpl = input.fetchImpl ?? fetch;
	const pageCap = Math.max(1, Math.min(20, input.pageCap ?? 4));
	const deadlineMs = Math.max(100, input.deadlineMs ?? 10_000);
	const startedAt = Date.now();
	const postedAtMs = Date.parse(input.postedAt);
	const lowerBound = Number.isFinite(postedAtMs) ? postedAtMs - 30_000 : 0;
	const matches = new Set<string>();
	let before: string | undefined;
	let frontier: string | null = null;

	for (let page = 0; page < pageCap; page += 1) {
		const remaining = deadlineMs - (Date.now() - startedAt);
		if (remaining <= 0) {
			return { kind: "ambiguous", frontier, reason: "scan_deadline" };
		}
		const controller = new AbortController();
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			const query = new URLSearchParams({ limit: "100" });
			if (before) query.set("before", before);
			timeout = setTimeout(() => controller.abort(), remaining);
			const response = await fetchImpl(
				`${DISCORD_API}/channels/${input.threadId}/messages?${query.toString()}`,
				{
					method: "GET",
					headers: { Authorization: `Bot ${input.botToken}` },
					signal: controller.signal,
				},
			);
			if (!response.ok) {
				return {
					kind: "ambiguous",
					frontier,
					reason: `scan_http_${response.status}`,
				};
			}
			const rows = (await response.json()) as Array<{
				id?: string;
				content?: string;
				timestamp?: string;
				author?: { bot?: boolean };
			}>;
			if (!Array.isArray(rows)) {
				return { kind: "ambiguous", frontier, reason: "scan_shape" };
			}
			if (page === 0) frontier = rows[0]?.id ?? null;
			for (const row of rows) {
				if (!row.id || row.author?.bot !== true) continue;
				const timestampMs = Date.parse(row.timestamp ?? "");
				if (Number.isFinite(timestampMs) && timestampMs < lowerBound) continue;
				const content = row.content ?? "";
				const markerMatch =
					!!input.correlationMarker &&
					content.includes(input.correlationMarker);
				const legacyMatch =
					(input.legacyTerms?.length ?? 0) > 0 &&
					input.legacyTerms!.every((term) => content.includes(term));
				if (markerMatch || legacyMatch) matches.add(row.id);
			}
			if (matches.size > 1) {
				return { kind: "ambiguous", frontier, reason: "multiple_matches" };
			}
			const oldest = rows.at(-1);
			const oldestMs = Date.parse(oldest?.timestamp ?? "");
			const complete =
				rows.length < 100 ||
				(Number.isFinite(oldestMs) && oldestMs <= lowerBound);
			if (complete) {
				const messageId = [...matches][0];
				return messageId
					? { kind: "found", messageId, frontier }
					: { kind: "none", frontier };
			}
			before = oldest?.id;
			if (!before) {
				return { kind: "ambiguous", frontier, reason: "scan_cursor_missing" };
			}
		} catch (error) {
			return {
				kind: "ambiguous",
				frontier,
				reason: `scan_error:${error instanceof Error ? error.message : String(error)}`,
			};
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}
	return { kind: "ambiguous", frontier, reason: "scan_page_cap" };
}

// ─────────────────────────────────────────────────────────────────────────
// FLY-818 M3: runner-stuck founder page — a genuinely-stuck runner
// (`runner_stuck_unhandled` = the FLY-195 Q7 fallback past the Lead-first grace,
// which the Lead never disposed) posts an @founder-pinged message into the stuck
// runner's OWN [FLY-XX] issue thread (Annie's design: "哪个 issue 卡住了，就在哪个
// issue thread 里发" — NOT a DM, NOT the FLY-368 alert channel = the rejected
// FLY-523 path). Reuses the shared POST/classify core; distinct audit event names.
// ─────────────────────────────────────────────────────────────────────────

export interface FounderStuckNotifyOpts {
	executionId: string;
	issueId: string;
	issueIdentifier?: string;
	projectName: string;
	/** Owning Lead the Bridge escalated to (display only). */
	leadAgentId: string;
	/** Minutes of unchanged terminal output while status=running (display only). */
	stuckMinutes: number;
	/** Pre-resolved via getChatThreadByIssue(session.issue_id, lead.chatChannel). */
	thread?: ChatThreadRef;
	/** lead.botToken ?? config.discordBotToken. */
	botToken?: string;
	/** config.discordOwnerUserId (for @mention + ping). */
	ownerUserId?: string;
	/** FLY-892 (Step 3): message-level phase tag; "" for main (byte-compat). */
	phasePrefix?: string;
}

function buildStuckBody(opts: FounderStuckNotifyOpts): string {
	const identifier = opts.issueIdentifier ?? opts.issueId;
	const owner = `<@${opts.ownerUserId}>`;
	const prefix = opts.phasePrefix ?? "";
	return [
		`${prefix}🚨 **Runner 卡住没人处理** — ${identifier}`,
		owner,
		"",
		`Runner (execution ${opts.executionId}) 的终端已 ~${opts.stuckMinutes} 分钟没变化、status 还是 running；` +
			`Bridge 升级给 ${opts.leadAgentId} 但 grace 窗内没人处置。先看 Lead、再看 runner 的 tmux。（FLY-195 Q7 fallback）`,
	].join("\n");
}

function auditStuck(
	store: StateStore,
	opts: FounderStuckNotifyOpts,
	eventType: string,
	payload: Record<string, unknown>,
): void {
	store.insertEvent({
		event_id: `${eventType}-${randomUUID()}`,
		execution_id: opts.executionId,
		issue_id: opts.issueId,
		project_name: opts.projectName,
		event_type: eventType,
		source: "bridge.founder-thread-notifier",
		payload: { stuckMinutes: opts.stuckMinutes, ...payload },
	});
}

/**
 * Post the runner-stuck @founder page into the stuck runner's issue thread.
 * Returns `posted` ONLY on a confirmed 2xx (the caller — the stuck alerter — maps
 * that to `founderPaged` and the durable ledger converge). `no_chat_thread` is
 * TRANSIENT (the thread may not exist yet) → the caller returns not-paged so the
 * StuckDetector retries (at-least-once). Mirrors the founder-gate path exactly.
 */
export async function emitFounderStuckNotification(
	opts: FounderStuckNotifyOpts,
	deps: FounderThreadNotifyDeps,
): Promise<FounderThreadNotifyResult> {
	const { store, fetchImpl = fetch } = deps;

	// ── (A) VALIDATE (mirrors the founder-gate path) ──
	if (!opts.thread?.thread_id) {
		auditStuck(store, opts, "founder_stuck_notify_skipped", {
			reason: "no_chat_thread",
		});
		return { kind: "skipped", skipReason: "no_chat_thread" };
	}
	if (!opts.botToken) {
		auditStuck(store, opts, "founder_stuck_notify_skipped", {
			reason: "no_bot_token",
		});
		return { kind: "skipped", skipReason: "no_bot_token" };
	}
	if (!opts.ownerUserId) {
		auditStuck(store, opts, "founder_stuck_notify_skipped", {
			reason: "no_owner",
		});
		return { kind: "skipped", skipReason: "no_owner" };
	}
	if (!isDiscordSnowflake(opts.ownerUserId)) {
		auditStuck(store, opts, "founder_stuck_notify_skipped", {
			reason: "bad_owner_id",
		});
		return { kind: "skipped", skipReason: "bad_owner_id" };
	}

	// ── (B) COMPOSE + POST + (C) CLASSIFY (shared core) ──
	const body = buildStuckBody(opts);
	const outcome = await postFounderThreadCore(
		opts.thread.thread_id,
		body,
		opts.botToken,
		opts.ownerUserId,
		fetchImpl,
	);
	if (outcome.kind === "posted" || outcome.kind === "posted_ambiguous") {
		auditStuck(store, opts, "founder_stuck_notified", {
			threadId: opts.thread.thread_id,
			status: outcome.status,
		});
		return { kind: "posted" };
	}
	if (outcome.kind === "transient_failed") {
		if (outcome.status === 429) {
			auditStuck(store, opts, "founder_stuck_notify_failed", {
				severity: "transient",
				status: 429,
				retryAfterMs: outcome.retryAfterMs,
			});
			return { kind: "transient_failed", retryAfterMs: outcome.retryAfterMs };
		}
		if (outcome.status !== undefined) {
			auditStuck(store, opts, "founder_stuck_notify_failed", {
				severity: "transient",
				status: outcome.status,
			});
			return { kind: "transient_failed" };
		}
		auditStuck(store, opts, "founder_stuck_notify_failed", {
			severity: "transient",
			error: outcome.error,
		});
		return { kind: "transient_failed" };
	}
	auditStuck(store, opts, "founder_stuck_notify_failed", {
		severity: "permanent",
		status: outcome.status,
		body: outcome.body,
	});
	return { kind: "permanent_failed" };
}

// ─────────────────────────────────────────────────────────────────────────
// FLY-927 (Task 1.5): generic issue-thread INFRA notification — the Router's
// "issue_thread" delivery leg. An issue-progress alert (three_stage_stuck /
// founder_gate_delivery_failed / runner_lead_pending_unhandled) lands in the
// issue's OWN [FLY-XX] thread where the responsible party has context, instead
// of the alert channel. Same skeleton as the founder-gate/stuck entries
// (validate → POST via the shared core → classify + audit), plus:
//  - a BOUNDED transient retry budget inside the call (alerts are one-shot —
//    there is no GatePoller retry loop behind this leg), and
//  - a MANDATORY `onUndeliverable` seam: budget burned / permanent failure /
//    defensive-skip all invoke it so the caller can fail-safe the original
//    alert into the ticket queue. NEVER silent, never recursive (the caller
//    wires it to the RAW sink, not back through the Router).
// ─────────────────────────────────────────────────────────────────────────

export interface IssueThreadInfraNotifyOpts {
	executionId: string;
	issueId: string;
	issueIdentifier?: string;
	projectName: string;
	/** Alert kind (audit payload). */
	kind: string;
	/** Fully-formatted message content (the caller owns wording). */
	content: string;
	/** Optional single real @-ping (validated snowflake); absent ⇒ parse:[]. */
	mentionUserId?: string;
	/** Pre-resolved via getChatThreadByIssue. */
	thread?: ChatThreadRef;
	/** lead.botToken ?? config.discordBotToken. */
	botToken?: string;
	/** Fail-safe seam — invoked on ANY non-posted terminal outcome. */
	onUndeliverable: (reason: string) => void | Promise<void>;
}

export interface IssueThreadInfraNotifyDeps extends FounderThreadNotifyDeps {
	/** Transient attempts budget (default 3 total). */
	maxAttempts?: number;
	/** Injected for tests; default = real setTimeout sleep (capped at 5s). */
	sleepFn?: (ms: number) => Promise<void>;
}

const SKIPPED_AUDIT_WINDOW_MS = 10 * 60_000;
const SKIPPED_AUDIT_TTL_MS = 30 * 60_000;
const SKIPPED_AUDIT_MAX_KEYS = 1_000;
// suppressed_count is best-effort: restart or a window with no later emission
// can discard the in-memory tally. It is diagnostic sampling, not an audit sum.
const skippedAuditBuckets = new WeakMap<
	StateStore,
	Map<string, { lastEmitMs: number; lastSeenMs: number; suppressed: number }>
>();

function rateLimitSkippedAudit(
	store: StateStore,
	opts: IssueThreadInfraNotifyOpts,
	payload: Record<string, unknown>,
): Record<string, unknown> | null {
	const now = Date.now();
	let buckets = skippedAuditBuckets.get(store);
	if (!buckets) {
		buckets = new Map();
		skippedAuditBuckets.set(store, buckets);
	}
	for (const [key, bucket] of buckets) {
		if (now - bucket.lastSeenMs > SKIPPED_AUDIT_TTL_MS) buckets.delete(key);
	}
	const key = [
		opts.projectName,
		opts.executionId,
		opts.issueId,
		opts.kind,
		String(payload.reason ?? "unknown"),
	].join("\0");
	const bucket = buckets.get(key);
	if (bucket && now - bucket.lastEmitMs < SKIPPED_AUDIT_WINDOW_MS) {
		bucket.lastSeenMs = now;
		bucket.suppressed += 1;
		buckets.delete(key);
		buckets.set(key, bucket);
		return null;
	}
	const suppressed = bucket?.suppressed ?? 0;
	buckets.delete(key);
	while (buckets.size >= SKIPPED_AUDIT_MAX_KEYS) {
		const oldest = buckets.keys().next().value;
		if (!oldest) break;
		buckets.delete(oldest);
	}
	buckets.set(key, { lastEmitMs: now, lastSeenMs: now, suppressed: 0 });
	return suppressed > 0
		? { ...payload, suppressed_count: suppressed }
		: payload;
}

function auditInfra(
	store: StateStore,
	opts: IssueThreadInfraNotifyOpts,
	eventType: string,
	payload: Record<string, unknown>,
): void {
	const auditedPayload =
		eventType === "issue_thread_infra_notify_skipped"
			? rateLimitSkippedAudit(store, opts, payload)
			: payload;
	if (!auditedPayload) return;
	store.insertEvent({
		event_id: `${eventType}-${randomUUID()}`,
		execution_id: opts.executionId,
		issue_id: opts.issueId,
		project_name: opts.projectName,
		event_type: eventType,
		source: "bridge.founder-thread-notifier",
		payload: { kind: opts.kind, ...auditedPayload },
	});
}

export async function emitIssueThreadInfraNotification(
	opts: IssueThreadInfraNotifyOpts,
	deps: IssueThreadInfraNotifyDeps,
): Promise<FounderThreadNotifyResult> {
	const { store, fetchImpl = fetch } = deps;
	const maxAttempts = deps.maxAttempts ?? 3;
	const sleepFn =
		deps.sleepFn ??
		((ms: number) =>
			new Promise<void>((r) => setTimeout(r, Math.min(ms, 5_000))));

	const undeliverable = async (
		reason: string,
		result: FounderThreadNotifyResult,
	): Promise<FounderThreadNotifyResult> => {
		try {
			await opts.onUndeliverable(reason);
		} catch {
			// The fail-safe seam itself must never throw back into the alert path.
		}
		return result;
	};

	// ── (A) VALIDATE ── (defensive: the Router fail-safes unbound events to the
	// ticket queue before this leg is ever called, but a config gap here must
	// still surface — via the same onUndeliverable seam, never silently.)
	if (!opts.thread?.thread_id) {
		auditInfra(store, opts, "issue_thread_infra_notify_skipped", {
			reason: "no_chat_thread",
		});
		return undeliverable("no_chat_thread", {
			kind: "skipped",
			skipReason: "no_chat_thread",
		});
	}
	if (!opts.botToken) {
		auditInfra(store, opts, "issue_thread_infra_notify_skipped", {
			reason: "no_bot_token",
		});
		return undeliverable("no_bot_token", {
			kind: "skipped",
			skipReason: "no_bot_token",
		});
	}
	const mention =
		opts.mentionUserId && isDiscordSnowflake(opts.mentionUserId)
			? opts.mentionUserId
			: null;

	// ── (B) POST with a bounded transient retry budget ──
	let lastTransient: string | undefined;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const outcome = await postFounderThreadCore(
			opts.thread.thread_id,
			opts.content,
			opts.botToken,
			mention,
			fetchImpl,
		);
		if (outcome.kind === "posted" || outcome.kind === "posted_ambiguous") {
			auditInfra(store, opts, "issue_thread_infra_notified", {
				threadId: opts.thread.thread_id,
				status: outcome.status,
				attempt,
			});
			return { kind: "posted" };
		}
		if (outcome.kind === "permanent_failed") {
			auditInfra(store, opts, "issue_thread_infra_notify_failed", {
				severity: "permanent",
				status: outcome.status,
				body: outcome.body,
				attempt,
			});
			return undeliverable(`permanent-${outcome.status}`, {
				kind: "permanent_failed",
			});
		}
		// transient — sleep (429 honors Retry-After, capped) and retry.
		lastTransient =
			outcome.status !== undefined
				? `transient-${outcome.status}`
				: `transient-${outcome.error ?? "network"}`;
		auditInfra(store, opts, "issue_thread_infra_notify_failed", {
			severity: "transient",
			status: outcome.status,
			error: outcome.error,
			attempt,
		});
		if (attempt < maxAttempts) {
			await sleepFn(outcome.retryAfterMs ?? 1_000);
		}
	}
	return undeliverable(`${lastTransient ?? "transient"}-budget-exhausted`, {
		kind: "transient_failed",
	});
}
