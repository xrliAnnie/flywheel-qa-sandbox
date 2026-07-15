/**
 * FLY-350 (R1-4 / R3 shared core) — the ONE proactive Discord-send path shared by
 * BOTH the full-access lead-actions MCP (`lead-actions-main.ts`) and the
 * write-capable gateway (`gateway/gateway-main.ts`). Extracting it keeps a single
 * audited, alias-gated, loop-safe implementation (codex R1-4: don't reinvent the
 * send in the gateway; reuse `resolveChannelAlias` + `postDiscordMessageToChannel`).
 *
 * Security shape (unchanged from the reviewed lead-actions path):
 *  - `target` is an ALIAS only ("chat"/"roundtable"); the channel id is resolved
 *    SERVER-SIDE (`resolveChannelAlias`, fail-closed) — the model never passes a raw id.
 *  - per-channel rate limit + deterministic in-process idempotency (FLY-220 loop-safety;
 *    cross-restart exactly-once is intentionally out of scope — same trade-off as
 *    direct reactive outbound).
 *  - metadata-only audit (NEVER the message text; codex R2-6).
 *  - `allowed_mentions:{parse:[]}` + chunking live in `postDiscordMessageToChannel`
 *    (no `@everyone`/role pings).
 *
 * Pure-ish: all effects (clock, the Discord POST, the audit sink) are injected so
 * the core is unit-testable without a live Discord or wall clock.
 */

import { appendFileSync } from "node:fs";
import { postDiscordMessageToChannel } from "../../bridge/discord-utils.js";
import {
	AliasResolutionError,
	type ChannelAliasConfig,
	resolveChannelAlias,
} from "./lead-actions/alias-allowlist.js";
import {
	deriveSendIdempotencyKey,
	type SendIdempotencyCache,
	type SlidingWindowRateLimiter,
	shouldRefuseProactiveRoundtable,
} from "./lead-actions/send-guard.js";

/** The result of a `runDiscordSend` call — the caller wraps `text` into its own
 * MCP tool-result envelope (`asText`). `isError` mirrors the MCP error flag. */
export interface DiscordSendResult {
	ok: boolean;
	text: string;
	isError?: boolean;
	/** The resolved channel id (present once the alias resolved). */
	channelId?: string;
	/** The Discord message id (present only on a successful send). */
	messageId?: string;
}

/** Injected effects + scoped config for one proactive send. The caller owns the
 * rate-limiter / idempotency-cache instances (one per live process). */
export interface DiscordSendDeps extends ChannelAliasConfig {
	/** Bot token fetched from the parent broker (NEVER from the model env). */
	botToken: string;
	rateLimiter: SlidingWindowRateLimiter;
	idempotency: SendIdempotencyCache;
	/** Absolute path to the metadata-only audit jsonl. */
	auditPath: string;
	leadId: string;
	projectName: string;
	/** FLY-676 — the EFFECTIVE roundtable autoContinue flag (replyInThread enabled &&
	 * THREAD_AUTOCONTINUE !== "0"), computed by the runtime and forwarded as a non-secret
	 * coordinate (NOT a raw env read in the child). When true, a proactive
	 * `target="roundtable"` send is fail-soft refused (FLY-680 owns the proper engage hook).
	 * Absent/false → no refusal (kill-switch / byte-compat with pre-FLY-676). */
	roundtableAutoContinue?: boolean;
	/** Injectable clock (default `Date.now`) for deterministic tests. */
	now?: () => number;
	/** Injectable Discord POST (default the real `postDiscordMessageToChannel`). */
	post?: typeof postDiscordMessageToChannel;
	/** Injectable audit sink (default appends one jsonl line; best-effort). */
	appendAudit?: (row: Record<string, unknown>) => void;
}

/** Append one durable audit row (metadata only — never the message text). The
 * default is best-effort: a failed audit append must never fail a send. */
function defaultAppendAudit(
	auditPath: string,
	row: Record<string, unknown>,
): void {
	try {
		appendFileSync(auditPath, `${JSON.stringify(row)}\n`);
	} catch {
		// best-effort — never fail a send because the audit append failed.
	}
}

/**
 * Run one proactive Discord send for an aliased target. Resolves the alias
 * server-side, enforces idempotency + rate limit, posts, records, audits.
 * Returns a structured result (the caller renders the MCP envelope). Never
 * throws for an operational failure — every path returns a `DiscordSendResult`.
 */
export async function runDiscordSend(
	target: string,
	text: string,
	deps: DiscordSendDeps,
): Promise<DiscordSendResult> {
	const now = (deps.now ?? Date.now)();
	const post = deps.post ?? postDiscordMessageToChannel;
	const audit =
		deps.appendAudit ?? ((row) => defaultAppendAudit(deps.auditPath, row));

	// Authority DERIVED server-side: alias → channel id, fail-closed.
	let channelId: string;
	try {
		channelId = resolveChannelAlias(target, {
			chatChannelId: deps.chatChannelId,
			crossDeptChannelIds: deps.crossDeptChannelIds,
			explicitAliases: deps.explicitAliases,
		});
	} catch (e) {
		const msg =
			e instanceof AliasResolutionError || e instanceof Error
				? e.message
				: String(e);
		return { ok: false, isError: true, text: `REFUSED: ${msg}` };
	}

	// FLY-676 guard (Codex R4#2): after the alias classifies as "roundtable" but BEFORE any
	// side effect (idempotency record / rate-limit consume / Discord post / non-defer audit),
	// fail-soft refuse a PROACTIVE roundtable send while reply-in-thread autoContinue is on.
	// A proactive roundtable post bypasses LeadInputRouter → no subscribe + no budget seed →
	// the initiator would miss the first reply back (FLY-680 owns the proper engage hook).
	if (
		shouldRefuseProactiveRoundtable({
			target,
			autoContinue: deps.roundtableAutoContinue === true,
		})
	) {
		audit({
			ts: now,
			leadId: deps.leadId,
			project: deps.projectName,
			target,
			channelId,
			outcome: "roundtable_proactive_deferred",
		});
		return {
			ok: false,
			isError: true,
			channelId,
			text:
				"REFUSED: proactive roundtable posts are deferred while in-thread auto-continue is on " +
				"(FLY-680 — cross-process subscribe+seed not yet wired). Reactive replies are unaffected.",
		};
	}

	const key = deriveSendIdempotencyKey(channelId, text);
	const prior = deps.idempotency.get(key, now);
	if (prior) {
		return {
			ok: true,
			channelId,
			messageId: prior,
			text: `Already sent (idempotent) to ${target} → message ${prior}`,
		};
	}

	if (!deps.rateLimiter.tryAcquire(channelId, now)) {
		audit({
			ts: now,
			leadId: deps.leadId,
			project: deps.projectName,
			target,
			channelId,
			outcome: "rate_limited",
		});
		return {
			ok: false,
			isError: true,
			channelId,
			text: `REFUSED: per-channel rate limit reached for ${target} (loop-safety) — try again shortly`,
		};
	}

	let res: Awaited<ReturnType<typeof postDiscordMessageToChannel>>;
	try {
		res = await post(channelId, text, deps.botToken, {
			origin: "lead_authored",
		});
	} catch (e) {
		return {
			ok: false,
			isError: true,
			channelId,
			text: `REFUSED: discord send threw: ${e instanceof Error ? e.message : String(e)}`,
		};
	}
	if (!res.ok) {
		return {
			ok: false,
			isError: true,
			channelId,
			text: `REFUSED: discord send failed: ${res.error}`,
		};
	}

	const messageId = res.messageIds[0] ?? "";
	deps.idempotency.record(key, messageId, now);
	audit({
		ts: now,
		leadId: deps.leadId,
		project: deps.projectName,
		target,
		channelId,
		messageId,
		textLen: text.length,
		outcome: "sent",
	});
	return {
		ok: true,
		channelId,
		messageId,
		text: `Sent to ${target} (${channelId}) → message ${messageId}`,
	};
}
