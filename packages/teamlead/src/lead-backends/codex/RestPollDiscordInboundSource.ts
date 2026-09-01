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
import type { ResidentCodexLeadPollFailureClass } from "./resident-codex-lead-lifecycle.js";

const DISCORD_API = "https://discord.com/api/v10";

interface RawDiscordMessage {
	id: string;
	channel_id?: string;
	content?: string;
	/** Discord ISO timestamp for the message send instant. */
	timestamp?: string;
	author?: { id?: string; bot?: boolean };
	/** FLY-267: Discord populates `mentions` with the @-mentioned user objects. */
	mentions?: Array<{ id?: string }>;
	/** FLY-314 fix: set on a Discord REPLY → the message this one replies to. */
	message_reference?: { message_id?: string };
	/** FLY-898: Discord includes the FULL referenced message object on a reply (by
	 * default). Its author id lets the gate recognize a reply to THIS bot's own
	 * message as an explicit address (reply-to-self). Absent when the referenced
	 * message was deleted / not fetched → reply-to-self simply won't trigger. */
	referenced_message?: { author?: { id?: string } };
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
	/** Optional business-liveness observer. Its failures are telemetry failures and
	 * must never change Discord delivery/cursor behavior. */
	lifecycle?: RestPollLifecycleObserver;
}

export interface RestPollLifecycleObserver {
	pollAttempt(channelId: string): void;
	pollResult(
		result:
			| { ok: true; channelId: string }
			| {
					ok: false;
					channelId: string;
					failureClass: ResidentCodexLeadPollFailureClass;
					status?: number;
			  },
	): void;
	messageConsumed(input: {
		channelId: string;
		messageId: string;
		cursorPersisted: boolean;
	}): void;
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
	private readonly lifecycle?: RestPollLifecycleObserver;

	private handler?: (msg: DiscordInboundMessage) => boolean;
	private readonly lastSeen = new Map<string, string>();
	/** FLY-267: channels that are resumed-from-cursor OR have completed ONE
	 * successful baseline. A channel NOT in `ready` must never be polled without an
	 * `after` cursor in the DELIVERY path — that replays history (e.g. a newly-added
	 * cross-dept channel whose first baseline fetch failed at startup would otherwise
	 * deliver up to `limit` stale messages, re-triggering old @mentions). pollOnce
	 * baselines an unready channel (no delivery) and retries until one succeeds. */
	private readonly ready = new Set<string>();
	/** FLY-314 Phase 2: runtime-subscribed roundtable topic thread channels. Kept
	 * SEPARATE from the static base `channelIds` so base fetch order is byte-identical
	 * when empty (the production Mufasa path when reply-in-thread is off). */
	private readonly dynamicChannels = new Set<string>();
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
		this.lifecycle = opts.lifecycle;
	}

	onMessage(handler: (msg: DiscordInboundMessage) => boolean): void {
		this.handler = handler;
	}

	async assertAuthenticatedBotUser(expectedBotUserId: string): Promise<void> {
		if (!expectedBotUserId) {
			throw new Error(
				"[identity_expected_bot_id_missing] expected Discord bot user id is required",
			);
		}
		const response = await this.fetchImpl(`${DISCORD_API}/users/@me`, {
			headers: { Authorization: `Bot ${this.botToken}` },
		});
		if (!response.ok) {
			throw new Error(
				`[identity_bot_login_failed] Discord /users/@me returned ${response.status}`,
			);
		}
		const authenticated = (await response.json()) as { id?: unknown };
		const actualBotUserId =
			typeof authenticated.id === "string" ? authenticated.id : "";
		if (actualBotUserId !== expectedBotUserId) {
			throw new Error(
				`[identity_bot_login_mismatch] expected ${expectedBotUserId}, authenticated ${actualBotUserId || "<missing>"}`,
			);
		}
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
				this.ready.add(channelId); // resumed = ready (will poll with `after`)
				resumedAny = true;
				continue;
			}
			// FIRST run (no cursor): baseline to the latest message so history isn't
			// replayed, and persist it so the NEXT start resumes instead of re-baselining.
			// A baseline FAILURE leaves the channel UNREADY (FLY-267) — pollOnce retries
			// the baseline (no delivery) so a transient failure can't replay history.
			await this.baselineChannel(channelId);
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
	 * FLY-267: baseline a channel to its latest message WITHOUT delivering history,
	 * then mark it `ready`. On a fetch failure the channel stays UNREADY (no `ready`
	 * entry, no `lastSeen`) so pollOnce retries the baseline next cycle instead of
	 * ever polling it without an `after` cursor (which would replay history). Returns
	 * whether the baseline succeeded. Never throws.
	 */
	private async baselineChannel(channelId: string): Promise<boolean> {
		try {
			const latest = await this.observedFetchMessages(channelId, undefined);
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
			// Mark ready even for an empty channel (no `newest`): it has been observed,
			// so the next poll's no-`after` fetch only sees genuinely NEW messages.
			this.ready.add(channelId);
			return true;
		} catch (err) {
			this.logger.warn("baseline poll failed", {
				channelId,
				err: (err as Error).message,
			});
			return false;
		}
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
		for (const channelId of this.allChannels()) {
			delivered += await this.pollChannelOnce(channelId);
		}
		return delivered;
	}

	/** Base channels (static) ∪ dynamic thread channels. Returns the base array
	 * REFERENCE when no dynamic channel is subscribed, so fetch order is byte-identical
	 * to the pre-Phase-2 production path (Codex review R2#4). */
	private allChannels(): string[] {
		return this.dynamicChannels.size === 0
			? this.channelIds
			: [...this.channelIds, ...this.dynamicChannels];
	}

	/**
	 * FLY-314 Phase 2: dynamically subscribe to a topic thread channel. CURSOR-AWARE
	 * (Codex review R1#4): resume from a saved cursor and drain the gap; only baseline
	 * to latest when there is NO cursor (so a restart / cap-eviction re-add never drops
	 * messages newer than the saved cursor). Idempotent; a base or already-subscribed
	 * id is a no-op.
	 */
	async addChannel(channelId: string): Promise<void> {
		if (
			!channelId ||
			this.channelIds.includes(channelId) ||
			this.dynamicChannels.has(channelId)
		) {
			return;
		}
		this.dynamicChannels.add(channelId);
		const resumed = this.cursorStore?.load(channelId);
		if (resumed) {
			this.lastSeen.set(channelId, resumed);
			this.ready.add(channelId);
			await this.drainChannel(channelId);
		} else {
			await this.baselineChannel(channelId);
		}
	}

	/**
	 * FLY-314 Phase 2: stop polling a dynamic channel. KEEPS its cursor/lastSeen so a
	 * re-add RESUMES (Codex review R1#10: cap eviction drops the active polling slot,
	 * it does NOT delete durable interest). A base channel is never removable.
	 */
	removeChannel(channelId: string): void {
		this.dynamicChannels.delete(channelId);
	}

	isSubscribed(channelId: string): boolean {
		return this.dynamicChannels.has(channelId);
	}

	get dynamicChannelCount(): number {
		return this.dynamicChannels.size;
	}

	/** Drain ONE dynamic channel forward from its cursor (bounded), without touching
	 * the base-channel poll order. Used by `addChannel` on resume. */
	private async drainChannel(channelId: string): Promise<void> {
		let safety = 1000;
		while ((await this.pollChannelOnce(channelId)) > 0 && --safety > 0) {
			// keep draining this channel's downtime gap
		}
	}

	/** Poll a single channel once; returns the number of messages delivered. */
	private async pollChannelOnce(channelId: string): Promise<number> {
		let delivered = 0;
		{
			// FLY-267 baseline gate: a channel that has NOT yet baselined (e.g. its
			// startup baseline fetch failed) must be baselined here — NOT polled in
			// the delivery path, which (with no `after`) would replay history. Baseline
			// delivers nothing; once it succeeds the channel becomes `ready` and the
			// NEXT poll fetches with `after`.
			if (!this.ready.has(channelId)) {
				await this.baselineChannel(channelId);
				return delivered;
			}
			let messages: RawDiscordMessage[];
			try {
				messages = await this.observedFetchMessages(
					channelId,
					this.lastSeen.get(channelId),
				);
			} catch (err) {
				this.logger.warn("poll failed", {
					channelId,
					err: (err as Error).message,
				});
				return delivered;
			}
			if (messages.length === 0) return delivered;
			// Discord returns newest-first; deliver oldest-first. Advance the cursor
			// ONLY through messages the handler DURABLY accepted (HIGH-4 at-least-once):
			// stop at the first message whose durable-accept failed so it (and every
			// message after it) is re-fetched next poll instead of being skipped.
			const ordered = [...messages].reverse();
			let lastDurable: string | undefined;
			const consumedMessageIds: string[] = [];
			for (const m of ordered) {
				if (!this.deliver(m)) break; // durable-accept failed → don't advance past it
				delivered += 1;
				if (m.id) {
					lastDurable = m.id;
					consumedMessageIds.push(m.id);
				}
			}
			if (lastDurable) {
				this.lastSeen.set(channelId, lastDurable);
				// Persist AFTER durable accept so a crash re-delivers (the journal dedups
				// on msg id) rather than skipping. A persist failure must NOT crash the
				// poll: the in-memory cursor still advances; a restart resumes from the
				// older persisted cursor → re-delivers → journal dedups (at-least-once).
				let cursorPersisted = false;
				try {
					if (this.cursorStore) {
						this.cursorStore.save(channelId, lastDurable);
						cursorPersisted = true;
					}
				} catch (err) {
					this.logger.warn("cursor persist failed (at-least-once preserved)", {
						channelId,
						err: (err as Error).message,
					});
				}
				for (const messageId of consumedMessageIds) {
					this.observe(() =>
						this.lifecycle?.messageConsumed({
							channelId,
							messageId,
							cursorPersisted,
						}),
					);
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
			const parsedTimestamp = m.timestamp
				? Date.parse(m.timestamp)
				: Number.NaN;
			return this.handler({
				id: m.id,
				channelId: m.channel_id ?? "",
				authorId: m.author?.id ?? "",
				authorBot: m.author?.bot === true,
				content: m.content ?? "",
				...(Number.isFinite(parsedTimestamp)
					? { timestampMs: parsedTimestamp }
					: {}),
				// FLY-267: explicit @-mention ids (for shared-channel mention-gating).
				mentions: (m.mentions ?? [])
					.map((u) => u.id)
					.filter((id): id is string => Boolean(id)),
				// FLY-314 fix: reply target → follow-up routing (into referenced thread).
				referencedMessageId: m.message_reference?.message_id,
				// FLY-898: author of the replied-to message → reply-to-self address signal.
				referencedAuthorId: m.referenced_message?.author?.id,
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
			throw new DiscordPollHttpError(res.status);
		}
		const body = (await res.json()) as unknown;
		return Array.isArray(body) ? (body as RawDiscordMessage[]) : [];
	}

	private async observedFetchMessages(
		channelId: string,
		afterId: string | undefined,
	): Promise<RawDiscordMessage[]> {
		this.observe(() => this.lifecycle?.pollAttempt(channelId));
		try {
			const messages = await this.fetchMessages(channelId, afterId);
			this.observe(() => this.lifecycle?.pollResult({ ok: true, channelId }));
			return messages;
		} catch (error) {
			const classified = classifyPollFailure(error);
			this.observe(() =>
				this.lifecycle?.pollResult({
					ok: false,
					channelId,
					failureClass: classified.failureClass,
					...(classified.status !== undefined
						? { status: classified.status }
						: {}),
				}),
			);
			throw error;
		}
	}

	private observe(fn: () => void): void {
		try {
			fn();
		} catch (error) {
			this.logger.warn("Raya lifecycle observer failed (poll continues)", {
				err: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

class DiscordPollHttpError extends Error {
	constructor(readonly status: number) {
		super(`Discord GET messages ${status}`);
		this.name = "DiscordPollHttpError";
	}
}

function classifyPollFailure(error: unknown): {
	failureClass: ResidentCodexLeadPollFailureClass;
	status?: number;
} {
	if (error instanceof DiscordPollHttpError) {
		const failureClass: ResidentCodexLeadPollFailureClass =
			error.status === 401 || error.status === 403
				? "auth"
				: error.status === 429
					? "rate_limit"
					: error.status >= 500
						? "server"
						: "unknown";
		return { failureClass, status: error.status };
	}
	if (
		error instanceof TypeError ||
		(error instanceof Error && error.name === "AbortError")
	) {
		return { failureClass: "network" };
	}
	return { failureClass: "unknown" };
}
