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
import type { StateStore } from "../StateStore.js";
import { parseRetryAfterMs } from "./chat-thread-utils.js";
import { isDiscordSnowflake, truncate } from "./founder-notify-utils.js";

const DISCORD_API = "https://discord.com/api/v10";
const POST_TIMEOUT_MS = 5_000;
const SUMMARY_MAX = 1_500;

/** `getChatThreadByIssue` returns `{ thread_id, channel_id, ... } | undefined`. */
export type ChatThreadRef = NonNullable<
	ReturnType<StateStore["getChatThreadByIssue"]>
>;

export type FounderGateCheckpoint = "brainstorm" | "approve_to_ship";

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
}

export interface FounderThreadNotifyDeps {
	store: StateStore;
	/** Test seam for Discord HTTP. */
	fetchImpl?: typeof fetch;
}

export type FounderThreadNotifyKind =
	| "posted"
	| "skipped"
	| "permanent_failed"
	| "transient_failed";

export interface FounderThreadNotifyResult {
	kind: FounderThreadNotifyKind;
	/** Only on a 429 transient_failed — Discord's honored Retry-After in ms. */
	retryAfterMs?: number;
}

function buildBody(opts: FounderThreadNotifyOpts): string {
	const identifier = opts.issueIdentifier ?? opts.issueId;
	const owner = `<@${opts.ownerUserId}>`;
	const summary = truncate(opts.summary, SUMMARY_MAX);
	if (opts.checkpoint === "approve_to_ship") {
		return [
			`🚀 **Ship gate 等你批准** — ${identifier}`,
			owner,
			"",
			summary,
			"",
			`…实现 + code-review 完成、等你 ship。已等 ${opts.ageMinutes} 分钟（Lead 可能漏转）。`,
		].join("\n");
	}
	return [
		`🧠 **Brainstorm gate 等你确认** — ${identifier}`,
		owner,
		"",
		summary,
		"",
		`已等 ${opts.ageMinutes} 分钟没人答（Lead 可能漏转）。在本 thread 回复确认/纠正。`,
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
		return { kind: "skipped" };
	}
	if (!opts.botToken) {
		audit(store, opts, "founder_thread_notify_skipped", {
			reason: "no_bot_token",
		});
		return { kind: "skipped" };
	}
	if (!opts.ownerUserId) {
		audit(store, opts, "founder_thread_notify_skipped", { reason: "no_owner" });
		return { kind: "skipped" };
	}
	if (!isDiscordSnowflake(opts.ownerUserId)) {
		// Codex R2 #4: a malformed owner id would make Discord reject the POST
		// with 400; refuse to send rather than spin on a config error.
		audit(store, opts, "founder_thread_notify_skipped", {
			reason: "bad_owner_id",
		});
		return { kind: "skipped" };
	}

	// ── (B) COMPOSE + POST ──
	const body = buildBody(opts);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
	try {
		const res = await fetchImpl(
			`${DISCORD_API}/channels/${opts.thread.thread_id}/messages`,
			{
				method: "POST",
				headers: {
					Authorization: `Bot ${opts.botToken}`,
					"Content-Type": "application/json",
				},
				// FLY-162: explicitly allow ONLY the founder user mention; block
				// @everyone/@here/role (ChatThreadCreator default blocks all mentions).
				body: JSON.stringify({
					content: body,
					allowed_mentions: { users: [opts.ownerUserId] },
				}),
				signal: controller.signal,
			},
		);

		// ── (C) CLASSIFY (mirrors chat-thread-utils.ts::archiveChatThread) ──
		if (res.ok) {
			audit(store, opts, "founder_thread_notified", {
				threadId: opts.thread.thread_id,
				status: res.status,
			});
			return { kind: "posted" };
		}
		if (res.status === 429) {
			const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
			audit(store, opts, "founder_thread_notify_failed", {
				severity: "transient",
				status: 429,
				retryAfterMs,
			});
			return { kind: "transient_failed", retryAfterMs };
		}
		if (res.status >= 500) {
			audit(store, opts, "founder_thread_notify_failed", {
				severity: "transient",
				status: res.status,
			});
			return { kind: "transient_failed" };
		}
		// Any other 4xx (incl. 400 malformed mention / 401/403/404) — client
		// error, retrying won't help (Codex R2 #4).
		const text = await res.text().catch(() => "");
		audit(store, opts, "founder_thread_notify_failed", {
			severity: "permanent",
			status: res.status,
			body: text.slice(0, 300),
		});
		return { kind: "permanent_failed" };
	} catch (err) {
		// Network error / abort / timeout — transient.
		audit(store, opts, "founder_thread_notify_failed", {
			severity: "transient",
			error: (err as Error).message,
		});
		return { kind: "transient_failed" };
	} finally {
		clearTimeout(timer);
	}
}
