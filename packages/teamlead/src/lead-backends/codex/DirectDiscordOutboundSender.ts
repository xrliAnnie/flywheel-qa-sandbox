/**
 * FLY-224 Phase 7 — DirectDiscordOutboundSender: a low-risk OutboundSender for the
 * FIRST Codex-Lead bring-up that posts replies DIRECTLY to Discord using the Lead's
 * own bot token (via the raw-REST `postDiscordMessageToChannel`), WITHOUT the Bridge
 * `/api/lead-outbound/send` route. This is what lets the first Mufasa-on-Codex test
 * run with NO production Bridge restart (lower risk — the prod Bridge is untouched).
 *
 * Trade-off vs the production CodexOutboundSender (Bridge route): the exactly-once
 * authority there is the Bridge's DURABLE idempotencyKey dedup. Here, dedup is the
 * process-local sent-marker only (no cross-restart durable dedup). A reply is never
 * LOST while the process lives, and `deliver` is locally idempotent; a rare
 * duplicate after a mid-send crash is acceptable for a chat bring-up test. Switch to
 * CodexOutboundSender (FLYWHEEL_CODEX_LEAD_OUTBOUND=bridge) for production exactly-once.
 *
 * `postImpl` (the Discord poster) is injected → unit-tested without a real network.
 */

import { postDiscordMessageToChannel } from "../../bridge/discord-utils.js";
import type { OutboundSender } from "./LeadInputRouter.js";

type PostFn = typeof postDiscordMessageToChannel;

interface OutboxEntry {
	text: string;
	/** FLY-267: channel this reply posts to — the per-message override resolved at
	 * enqueue, else the sender's default chat channel. */
	channelId: string;
	status: "pending" | "sent";
	messageId?: string;
}

export interface DirectDiscordOutboundSenderOptions {
	/** The Lead's OWN Discord bot token (from its env). */
	botToken: string;
	/** The channel the Lead replies in. */
	channelId: string;
	postImpl?: PostFn;
	fetchImpl?: typeof fetch;
	logger?: { warn: (m: string, c?: unknown) => void };
}

export class DirectDiscordOutboundSender implements OutboundSender {
	private readonly botToken: string;
	private readonly channelId: string;
	private readonly postImpl: PostFn;
	private readonly fetchImpl: typeof fetch;
	private readonly logger: { warn: (m: string, c?: unknown) => void };
	private readonly outbox = new Map<string, OutboxEntry>();

	constructor(opts: DirectDiscordOutboundSenderOptions) {
		if (!opts.botToken)
			throw new Error("DirectDiscordOutboundSender: botToken required");
		if (!opts.channelId)
			throw new Error("DirectDiscordOutboundSender: channelId required");
		this.botToken = opts.botToken;
		this.channelId = opts.channelId;
		this.postImpl = opts.postImpl ?? postDiscordMessageToChannel;
		this.fetchImpl = opts.fetchImpl ?? fetch;
		this.logger = opts.logger ?? { warn: () => {} };
	}

	async enqueue(args: {
		leadId: string;
		text: string;
		idempotencyKey: string;
		channelId?: string;
	}): Promise<string> {
		if (!args.idempotencyKey)
			throw new Error(
				"DirectDiscordOutboundSender.enqueue: idempotencyKey required",
			);
		// Idempotent: keep the first text for a given key.
		if (!this.outbox.has(args.idempotencyKey)) {
			this.outbox.set(args.idempotencyKey, {
				text: args.text,
				// FLY-267: per-message override, else the default chat channel (byte-compat).
				channelId: args.channelId ?? this.channelId,
				status: "pending",
			});
		}
		return args.idempotencyKey;
	}

	async deliver(outboxId: string): Promise<void> {
		const entry = this.outbox.get(outboxId);
		if (!entry) {
			throw new Error(
				`DirectDiscordOutboundSender.deliver: no outbox ${outboxId}`,
			);
		}
		if (entry.status === "sent") return; // locally idempotent
		const res = await this.postImpl(
			entry.channelId, // FLY-267: routed channel (default = chat) resolved at enqueue
			entry.text,
			this.botToken,
			{ origin: "lead_authored" },
			this.fetchImpl,
		);
		if (!res.ok) {
			// Leave pending (retryable); surface so the router marks ambiguous.
			this.logger.warn("direct discord post failed", {
				outboxId,
				error: res.error,
			});
			throw new Error(res.error ?? "direct discord post failed");
		}
		entry.status = "sent";
		entry.messageId = res.messageIds[0];
	}
}
