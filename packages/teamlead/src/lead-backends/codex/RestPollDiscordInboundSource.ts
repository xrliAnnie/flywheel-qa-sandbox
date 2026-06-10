/**
 * FLY-224 Phase 7 — RestPollDiscordInboundSource: a real `DiscordInboundSource`
 * (the inbound half of the Codex Lead's own Discord connection, plan §6.7a).
 *
 * The monorepo has NO discord.js — the Bridge talks raw Discord REST. So instead
 * of a gateway websocket we POLL each watched channel with
 * `GET /channels/{id}/messages?after=<lastSeenId>` on an interval, map each new
 * message to a `DiscordInboundMessage`, and hand it to the gateway (which applies
 * echo-immunity + filters). This keeps the bring-up dependency-free and reuses the
 * existing Bot-token REST pattern; the `DiscordInboundSource` interface hides the
 * mechanism, so a gateway-websocket source can replace it later with no caller
 * change.
 *
 * On `start` it BASELINES each channel to the latest message id so it never
 * replays history. Polling advances `lastSeenId` strictly, so a message is
 * delivered at most once by this source (and the journal dedups on msg id anyway).
 * `fetch` + the timer are injected → unit-tested without a real network.
 */

import type {
	DiscordInboundMessage,
	DiscordInboundSource,
} from "./CodexDiscordGateway.js";
import type { InboundCursorStore } from "./InboundCursorStore.js";

const DISCORD_API = "https://discord.com/api/v10";

interface RawDiscordMessage {
	id: string;
	channel_id?: string;
	content?: string;
	author?: { id?: string; bot?: boolean };
}

export interface RestPollSourceOptions {
	botToken: string;
	channelIds: string[];
	pollIntervalMs?: number;
	/** messages/channel per poll (Discord max 100). */
	limit?: number;
	fetchImpl?: typeof fetch;
	/** Injectable scheduler (tests). Returns a cancel handle. */
	setTimer?: (fn: () => void, ms: number) => { cancel: () => void };
	logger?: { warn: (m: string, c?: unknown) => void };
	/** Durable per-channel cursor (FLY-224 review HIGH-4). When provided, a RESTART
	 * RESUMES from the persisted last-seen id (so downtime messages aren't dropped);
	 * only the FIRST run (no saved cursor) baselines to latest. Omitted → legacy
	 * baseline-to-latest-every-start behavior (byte-compat). */
	cursorStore?: InboundCursorStore;
}

export class RestPollDiscordInboundSource implements DiscordInboundSource {
	private readonly botToken: string;
	private readonly channelIds: string[];
	private readonly pollIntervalMs: number;
	private readonly limit: number;
	private readonly fetchImpl: typeof fetch;
	private readonly setTimer: (
		fn: () => void,
		ms: number,
	) => { cancel: () => void };
	private readonly logger: { warn: (m: string, c?: unknown) => void };
	private readonly cursorStore?: InboundCursorStore;

	private handler?: (msg: DiscordInboundMessage) => boolean;
	private readonly lastSeen = new Map<string, string>();
	private timer: { cancel: () => void } | null = null;
	private running = false;

	constructor(opts: RestPollSourceOptions) {
		if (!opts.botToken)
			throw new Error("RestPollDiscordInboundSource: botToken required");
		this.botToken = opts.botToken;
		this.channelIds = [...opts.channelIds];
		this.pollIntervalMs = opts.pollIntervalMs ?? 3000;
		this.limit = Math.min(opts.limit ?? 50, 100);
		this.fetchImpl = opts.fetchImpl ?? fetch;
		this.setTimer =
			opts.setTimer ??
			((fn, ms) => {
				const h = setTimeout(fn, ms);
				return { cancel: () => clearTimeout(h) };
			});
		this.logger = opts.logger ?? { warn: () => {} };
		this.cursorStore = opts.cursorStore;
	}

	onMessage(handler: (msg: DiscordInboundMessage) => boolean): void {
		this.handler = handler;
	}

	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;
		let resumedAny = false;
		for (const channelId of this.channelIds) {
			// RESUME (FLY-224 review HIGH-4): a persisted cursor means a restart — keep
			// it so the next poll fetches `after=<cursor>` and replays the downtime gap.
			const resumed = this.cursorStore?.load(channelId);
			if (resumed) {
				this.lastSeen.set(channelId, resumed);
				resumedAny = true;
				continue;
			}
			// FIRST run (no cursor): baseline to the latest message so history isn't
			// replayed, and persist it so the NEXT start resumes instead of re-baselining.
			try {
				const latest = await this.fetchMessages(channelId, undefined);
				const newest = latest[0]; // Discord returns newest-first
				if (newest) {
					this.lastSeen.set(channelId, newest.id);
					try {
						this.cursorStore?.save(channelId, newest.id);
					} catch (err) {
						this.logger.warn("baseline cursor persist failed", {
							channelId,
							err: (err as Error).message,
						});
					}
				}
			} catch (err) {
				this.logger.warn("baseline poll failed", {
					channelId,
					err: (err as Error).message,
				});
			}
		}
		// DRAIN the downtime backlog NOW (HIGH-4): instead of trickling one page per
		// poll interval, walk forward until caught up so a >limit gap is fully
		// recovered at startup. Bounded so a perpetually-active channel can't wedge boot.
		if (resumedAny) {
			let safety = 1000;
			while ((await this.pollOnce()) > 0 && --safety > 0) {
				// keep draining
			}
		}
		this.scheduleNext();
	}

	async stop(): Promise<void> {
		this.running = false;
		this.timer?.cancel();
		this.timer = null;
	}

	/**
	 * One poll cycle across all channels (exposed for tests). Returns the number of
	 * messages delivered this cycle — `start()` loops on this to DRAIN a downtime
	 * backlog promptly (Discord's `after` paginates FORWARD: each page is the oldest
	 * `limit` messages newer than the cursor, so advancing to a page's newest id and
	 * polling again walks forward through an arbitrarily large gap with no loss).
	 */
	async pollOnce(): Promise<number> {
		let delivered = 0;
		for (const channelId of this.channelIds) {
			let messages: RawDiscordMessage[];
			try {
				messages = await this.fetchMessages(
					channelId,
					this.lastSeen.get(channelId),
				);
			} catch (err) {
				this.logger.warn("poll failed", {
					channelId,
					err: (err as Error).message,
				});
				continue;
			}
			if (messages.length === 0) continue;
			// Discord returns newest-first; deliver oldest-first. Advance the cursor
			// ONLY through messages the handler DURABLY accepted (HIGH-4 at-least-once):
			// stop at the first message whose durable-accept failed so it (and every
			// message after it) is re-fetched next poll instead of being skipped.
			const ordered = [...messages].reverse();
			let lastDurable: string | undefined;
			for (const m of ordered) {
				if (!this.deliver(m)) break; // durable-accept failed → don't advance past it
				delivered += 1;
				if (m.id) lastDurable = m.id;
			}
			if (lastDurable) {
				this.lastSeen.set(channelId, lastDurable);
				// Persist AFTER durable accept so a crash re-delivers (the journal dedups
				// on msg id) rather than skipping. A persist failure must NOT crash the
				// poll: the in-memory cursor still advances; a restart resumes from the
				// older persisted cursor → re-delivers → journal dedups (at-least-once).
				try {
					this.cursorStore?.save(channelId, lastDurable);
				} catch (err) {
					this.logger.warn("cursor persist failed (at-least-once preserved)", {
						channelId,
						err: (err as Error).message,
					});
				}
			}
		}
		return delivered;
	}

	private scheduleNext(): void {
		if (!this.running) return;
		this.timer = this.setTimer(() => {
			void this.pollOnce().finally(() => this.scheduleNext());
		}, this.pollIntervalMs);
	}

	/** Map + hand a raw message to the handler. Returns whether it is SAFE TO ADVANCE
	 * the cursor past it (the handler's durable-accept signal; HIGH-4). No handler or
	 * no id → nothing to durably accept → safe to advance (defensive). A handler that
	 * throws unexpectedly is treated as a transient failure (retry, don't advance). */
	private deliver(m: RawDiscordMessage): boolean {
		if (!this.handler || !m.id) return true;
		try {
			return this.handler({
				id: m.id,
				channelId: m.channel_id ?? "",
				authorId: m.author?.id ?? "",
				authorBot: m.author?.bot === true,
				content: m.content ?? "",
			});
		} catch (err) {
			this.logger.warn("inbound handler threw (will retry)", {
				id: m.id,
				err: (err as Error).message,
			});
			return false;
		}
	}

	private async fetchMessages(
		channelId: string,
		afterId: string | undefined,
	): Promise<RawDiscordMessage[]> {
		const params = new URLSearchParams({ limit: String(this.limit) });
		if (afterId) params.set("after", afterId);
		const url = `${DISCORD_API}/channels/${channelId}/messages?${params.toString()}`;
		const res = await this.fetchImpl(url, {
			headers: { Authorization: `Bot ${this.botToken}` },
		});
		if (!res.ok) {
			throw new Error(`Discord GET messages ${res.status}`);
		}
		const body = (await res.json()) as unknown;
		return Array.isArray(body) ? (body as RawDiscordMessage[]) : [];
	}
}
