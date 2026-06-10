/**
 * FLY-224 Phase 4b(3/3) — CodexDiscordGateway: the INBOUND Discord listener for a
 * Codex Lead (plan §6.4/§6.7a). The Codex Lead reads Discord through its OWN
 * gateway (NOT a Discord MCP — see §6.7a: no safe read subset there); each
 * received message is funneled into the LeadInputRouter, which durably accepts it
 * (idempotencyKey = Discord message id → journal dedup) and drives the turn loop.
 *
 * Safety filters (mechanism here; richer policy is injectable):
 *   - ECHO IMMUNITY: messages authored by THIS Lead's own bot are dropped — the
 *     hard lesson from FLY-220 (a Lead reacting to its own posts → self-amplifying
 *     storm). This is non-negotiable and not overridable.
 *   - CHANNEL ALLOWLIST: only the Lead's configured channels (its chat channel +
 *     the project core channel) are handled.
 *   - EMPTY content is skipped (attachment-only / system messages).
 *   - Optional `shouldHandle(msg)` predicate for extra policy (e.g. reply-guard
 *     style discipline), applied AFTER the mandatory filters.
 *
 * Dedup is the journal's job (idempotencyKey = message id), so a Discord
 * gateway RESUME that redelivers a message is harmless — the gateway forwards it,
 * the router/journal drops the duplicate. A handler error never crashes the
 * listener (caught + logged).
 *
 * Per the Phase-4b guardrail this is implemented + UNIT-TESTED ONLY: the Discord
 * connection is an injected `DiscordInboundSource` (tests emit fake messages); it
 * never opens a real gateway. The real source (per-Lead bot token) is wired in the
 * runtime entrypoint (Phase 2b).
 */

import type { LeadInputRouter } from "./LeadInputRouter.js";

export interface DiscordInboundMessage {
	/** Discord message id — the idempotency key for journal dedup. */
	id: string;
	channelId: string;
	authorId: string;
	/** Whether the author is a bot (any bot, incl. this Lead or other Leads). */
	authorBot: boolean;
	content: string;
}

/** The injected Discord connection (real impl wraps discord.js / the adapter).
 * The handler returns whether it is SAFE TO ADVANCE the inbound cursor past this
 * message — `true` when the message was durably accepted/deduped OR intentionally
 * dropped by a filter; `false` ONLY on a transient durable-accept failure (the
 * journal write threw) so the source does NOT advance and re-delivers it (HIGH-4
 * at-least-once: never advance past a message that wasn't durably accepted). */
export interface DiscordInboundSource {
	onMessage(handler: (msg: DiscordInboundMessage) => boolean): void;
	start(): Promise<void>;
	stop(): Promise<void>;
}

export interface CodexDiscordGatewayOptions {
	source: DiscordInboundSource;
	router: Pick<LeadInputRouter, "submit">;
	/** This Lead's own bot user id — its own messages are ALWAYS dropped. */
	botUserId: string;
	/** Channels the Lead listens to (chat + core). */
	channelIds: Iterable<string>;
	/** Optional extra policy, applied after the mandatory filters. */
	shouldHandle?: (msg: DiscordInboundMessage) => boolean;
	logger?: {
		debug?: (m: string, c?: unknown) => void;
		warn: (m: string, c?: unknown) => void;
	};
}

export class CodexDiscordGateway {
	private readonly source: DiscordInboundSource;
	private readonly router: Pick<LeadInputRouter, "submit">;
	private readonly botUserId: string;
	private readonly channelIds: Set<string>;
	private readonly shouldHandle?: (msg: DiscordInboundMessage) => boolean;
	private readonly logger: {
		debug?: (m: string, c?: unknown) => void;
		warn: (m: string, c?: unknown) => void;
	};
	private started = false;

	constructor(opts: CodexDiscordGatewayOptions) {
		if (!opts.botUserId)
			throw new Error(
				"CodexDiscordGateway: botUserId required (echo immunity)",
			);
		this.source = opts.source;
		this.router = opts.router;
		this.botUserId = opts.botUserId;
		this.channelIds = new Set(opts.channelIds);
		this.shouldHandle = opts.shouldHandle;
		this.logger = opts.logger ?? { warn: (m, c) => console.warn(m, c ?? "") };
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		this.source.onMessage((msg) => this.handle(msg));
		await this.source.start();
	}

	async stop(): Promise<void> {
		if (!this.started) return;
		this.started = false;
		await this.source.stop();
	}

	/**
	 * Decide + forward a single inbound message. Returns whether it is SAFE TO ADVANCE
	 * the inbound cursor past this message:
	 *   - filtered out (echo / wrong channel / empty / no-id / shouldHandle) → `true`
	 *     (an intentional drop — re-fetching it would just drop it again).
	 *   - durably accepted (or deduped) by the router/journal → `true`.
	 *   - the durable accept FAILED (journal write threw) → `false`: the source must
	 *     NOT advance, so the message is re-delivered on the next poll / a restart
	 *     (HIGH-4 at-least-once — a swallowed journal failure used to skip it forever).
	 * Never throws — a transient failure is signalled by the `false` return, not an
	 * exception, so the listener keeps running.
	 */
	handle(msg: DiscordInboundMessage): boolean {
		// Filters are pure predicates (no I/O) — an intentional drop is terminal, so
		// it is safe to advance past it.
		if (!this.passesFilters(msg)) return true;
		try {
			this.router.submit({
				idempotencyKey: msg.id,
				source: "discord",
				payload: msg.content,
			});
			return true;
		} catch (err) {
			// DURABLE-ACCEPT FAILURE (e.g. journal DB write threw). Do NOT advance —
			// surface `false` so the source re-delivers (journal dedups on msg id).
			this.logger.warn("inbound durable-accept failed (will retry)", {
				id: msg?.id,
				err: (err as Error).message,
			});
			return false;
		}
	}

	private passesFilters(msg: DiscordInboundMessage): boolean {
		// ECHO IMMUNITY — never react to our own posts (FLY-220). Not overridable.
		if (msg.authorId === this.botUserId) return false;
		// Channel allowlist.
		if (!this.channelIds.has(msg.channelId)) return false;
		// Empty / whitespace-only content (attachment-only, system messages).
		if (!msg.content || msg.content.trim() === "") return false;
		// A message with no id can't be deduped — drop it (defensive).
		if (!msg.id) return false;
		// Optional extra policy.
		if (this.shouldHandle && !this.shouldHandle(msg)) return false;
		return true;
	}
}
