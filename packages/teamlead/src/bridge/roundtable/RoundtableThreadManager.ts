/**
 * FLY-314 — RoundtableThreadManager: the Bridge-side central listener that
 * auto-creates a Discord thread when a "topic" enters #leads-roundtable.
 *
 * Phase 1 ONLY: open the thread + seed it + pull configured leads in as members.
 * Reply-in-thread routing (each lead replying inside the thread) is Phase 2.
 *
 * DESIGN (Codex design review R1/R2):
 *  - A DEDICATED poller, NOT `RestPollDiscordInboundSource` — that source's
 *    `onMessage` is a SYNCHRONOUS `(msg) => boolean` whose return immediately drives
 *    cursor advancement. Topic-thread creation is async (Discord POST + DB write),
 *    so this manager owns its own loop and advances the cursor ONLY after the
 *    awaited create/store completes. Zero blast radius on the Mufasa production
 *    inbound path. The durable cursor (`FileInboundCursorStore`) is reused.
 *  - Crash-recovery invariant: Discord "start thread from message" creates a thread
 *    whose id EQUALS the source message id, and a message can have only one thread.
 *    So a create-succeeded-but-store-lost crash is recoverable: on the duplicate
 *    error we confirm the thread (GET /channels/{msgId}) and persist the mapping —
 *    never a second create.
 *  - Failure classification: transient (429/5xx/network/timeout) HOLDS the cursor
 *    (retry next poll, at-least-once); deleted message (404) no-ops; permanent auth
 *    (401/403) is logged loudly then advances (never wedge the whole channel).
 *  - Topic threads live in their OWN table (`roundtable_topic_threads`), isolated
 *    from issue-bound `chat_threads` semantics (reverse lookup + reply-guard).
 */

import type { InboundCursorStore } from "../../lead-backends/codex/InboundCursorStore.js";
import type { StateStore } from "../../StateStore.js";
import { markAutomatedDiscordText } from "../automated-message.js";
import { addThreadMember } from "../chat-thread-utils.js";
import {
	deriveRoundtableThreadName,
	isTopicNoise,
	ROUNDTABLE_PLACEHOLDER_NAME,
	ROUNDTABLE_TOPIC_AUTO_ARCHIVE_MINUTES,
} from "./roundtable-text.js";
import type { RoundtableMessage } from "./topic-trigger.js";

const DISCORD_API = "https://discord.com/api/v10";
const CREATE_TIMEOUT_MS = 5_000;
/** Discord error code: "A thread has already been created for this message". */
const THREAD_ALREADY_EXISTS_CODE = 160004;
/** Discord thread channel types (10 announcement, 11 public, 12 private). */
const THREAD_TYPES = new Set([10, 11, 12]);
/** Cap on an honored 429 Retry-After so a hostile/huge value can't wedge the poll. */
const MAX_RETRY_AFTER_MS = 60_000;
// FLY-576: ROUNDTABLE_PLACEHOLDER_NAME (the generic name the Belle plugin hard-codes
// when it wins the create race) is now imported from ./roundtable-text.js so the
// poller, the Codex-lead path, and the plugin all share ONE canonical value + naming
// (FLY-314 fix §6 risk 3). It doubles as (a) the fallback when a topic message has no
// usable text and (b) the marker the recovery path looks for before renaming.

/** Discord sends Retry-After in (possibly fractional) seconds → ms. */
function parseRetryAfterMs(
	header: string | null | undefined,
): number | undefined {
	if (!header) return undefined;
	const secs = Number(header);
	if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
	return undefined;
}

interface RawDiscordMessage {
	id: string;
	channel_id?: string;
	content?: string;
	author?: { id?: string; bot?: boolean };
	mentions?: Array<{ id?: string }>;
	mention_everyone?: boolean;
	/** FLY-314 fix: set on a Discord REPLY → the message this one replies to. */
	message_reference?: { message_id?: string };
}

type Timer = { cancel: () => void };

export interface RoundtableThreadManagerOptions {
	store: StateStore;
	channelId: string;
	botToken: string;
	botUserId: string;
	/** Topic predicate (from buildTopicTrigger). */
	trigger: (msg: RoundtableMessage) => boolean;
	/** Discord user ids pulled into each new topic thread as members. */
	memberUserIds: string[];
	/**
	 * FLY-576: the founder's Discord id — ALWAYS pulled into each topic thread as a
	 * member (so the thread appears in the founder's sidebar + surfaces follow-up
	 * messages), exactly like issue threads' ownerUserId. Undefined → degrade to
	 * configured members + mentions only (byte-compat, no throw).
	 */
	founderUserId?: string;
	/** Recorded on the row for audit (which trigger opened it). */
	triggerMode: string;
	/**
	 * FLY-314: when true, the poller bot's OWN top-level messages are ALSO threaded
	 * (echo immunity relaxed). Needed when the poller bot is itself a topic-poster
	 * (e.g. the CoS broadcasting in #leads-roundtable) and Annie wants those
	 * broadcasts threaded too. Safe: the manager never posts top-level in the parent
	 * channel — seeds go into child threads which are never polled, so there is no
	 * self-threading loop. Default false (echo immunity ON).
	 */
	threadOwnBotMessages?: boolean;
	cursorStore: InboundCursorStore;
	fetchImpl?: typeof fetch;
	pollIntervalMs?: number;
	limit?: number;
	setTimer?: (fn: () => void, ms: number) => Timer;
	logger?: {
		warn: (m: string, c?: unknown) => void;
		log?: (m: string) => void;
	};
}

/** Internal create outcome (drives advance + side effects). */
type CreateResult =
	| { kind: "created"; threadId: string }
	| { kind: "exists" } // message already has a thread (recovery path)
	| { kind: "deleted" } // 404 — message gone
	| { kind: "auth" } // 401/403 — permanent, loud
	| { kind: "client_error"; status: number } // other 4xx — permanent
	| { kind: "transient" }; // 429/5xx/network/timeout — hold cursor, retry

export class RoundtableThreadManager {
	private readonly store: StateStore;
	private readonly channelId: string;
	private readonly botToken: string;
	private readonly botUserId: string;
	private readonly trigger: (msg: RoundtableMessage) => boolean;
	private readonly memberUserIds: string[];
	private readonly founderUserId: string | undefined;
	private readonly triggerMode: string;
	private readonly threadOwnBotMessages: boolean;
	private readonly cursorStore: InboundCursorStore;
	private readonly fetchImpl: typeof fetch;
	private readonly pollIntervalMs: number;
	private readonly limit: number;
	private readonly setTimer: (fn: () => void, ms: number) => Timer;
	private readonly logger: {
		warn: (m: string, c?: unknown) => void;
		log?: (m: string) => void;
	};

	private lastSeen: string | undefined;
	private ready = false;
	private running = false;
	private timer: Timer | null = null;
	/** The in-flight poll cycle (so stop() can drain it before returning). */
	private activePoll: Promise<unknown> | null = null;
	/** One-shot override for the NEXT scheduled delay (honored 429 Retry-After). */
	private pendingDelayMs: number | undefined;

	constructor(opts: RoundtableThreadManagerOptions) {
		if (!opts.botToken)
			throw new Error("RoundtableThreadManager: botToken required");
		if (!opts.channelId)
			throw new Error("RoundtableThreadManager: channelId required");
		this.store = opts.store;
		this.channelId = opts.channelId;
		this.botToken = opts.botToken;
		this.botUserId = opts.botUserId;
		this.trigger = opts.trigger;
		this.memberUserIds = [...opts.memberUserIds];
		this.founderUserId = opts.founderUserId;
		this.triggerMode = opts.triggerMode;
		this.threadOwnBotMessages = opts.threadOwnBotMessages ?? false;
		this.cursorStore = opts.cursorStore;
		this.fetchImpl = opts.fetchImpl ?? fetch;
		this.pollIntervalMs = opts.pollIntervalMs ?? 3000;
		this.limit = Math.min(opts.limit ?? 50, 100);
		this.setTimer =
			opts.setTimer ??
			((fn, ms) => {
				const h = setTimeout(fn, ms);
				h.unref?.();
				return { cancel: () => clearTimeout(h) };
			});
		this.logger = opts.logger ?? { warn: () => {} };
	}

	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;
		// RESUME from a persisted cursor (don't re-baseline → no downtime-gap loss);
		// FIRST run baselines to latest (don't replay history).
		const resumed = this.cursorStore.load(this.channelId);
		if (resumed) {
			this.lastSeen = resumed;
			this.ready = true;
		} else {
			await this.baseline();
		}
		this.scheduleNext();
	}

	async stop(): Promise<void> {
		this.running = false;
		this.timer?.cancel();
		this.timer = null;
		// Drain the in-flight poll so shutdown never races a Discord create/store
		// into a closing StateStore (Codex code review #1). Never throws.
		if (this.activePoll) {
			try {
				await this.activePoll;
			} catch {
				// already logged inside the scheduled wrapper
			}
		}
	}

	/** Baseline the channel to its latest message id WITHOUT delivering history.
	 * On failure the channel stays UNREADY so pollOnce retries the baseline rather
	 * than ever fetching without an `after` cursor (which would replay history). */
	private async baseline(): Promise<boolean> {
		try {
			const latest = await this.fetchMessages(undefined);
			const newest = latest[0]; // Discord returns newest-first
			if (newest?.id) {
				this.lastSeen = newest.id;
				this.saveCursor(newest.id);
			}
			this.ready = true;
			return true;
		} catch (err) {
			this.logger.warn("[RoundtableThreadManager] baseline failed", {
				err: (err as Error).message,
			});
			return false;
		}
	}

	private scheduleNext(): void {
		if (!this.running) return;
		// Honor a one-shot 429 Retry-After (capped); never poll faster than the base
		// interval (Codex code review #2). The override is consumed once.
		const delay = Math.max(this.pollIntervalMs, this.pendingDelayMs ?? 0);
		this.pendingDelayMs = undefined;
		this.timer = this.setTimer(() => {
			// Track the active poll so stop() can drain it; catch so a thrown poll
			// can never become an unhandled rejection (Codex code review #1, #3).
			this.activePoll = this.pollOnce()
				.catch((err) => {
					this.logger.warn("[RoundtableThreadManager] poll cycle error", {
						err: (err as Error).message,
					});
					return 0;
				})
				.finally(() => {
					this.activePoll = null;
					this.scheduleNext();
				});
		}, delay);
	}

	/** Persist the cursor, keeping the in-memory advance on a write failure (warn,
	 * don't throw — matches the repo's RestPoll at-least-once pattern; Codex #3). */
	private saveCursor(messageId: string): void {
		try {
			this.cursorStore.save(this.channelId, messageId);
		} catch (err) {
			this.logger.warn(
				"[RoundtableThreadManager] cursor persist failed (in-memory advance kept)",
				{ err: (err as Error).message },
			);
		}
	}

	/**
	 * One poll cycle. Returns the number of messages processed-and-advanced. The
	 * cursor advances ONLY through messages whose async handling completed AND was
	 * "advanceable"; a transient failure STOPS at that message so it (and all after
	 * it) are re-fetched next poll (at-least-once).
	 */
	async pollOnce(): Promise<number> {
		if (!this.ready) {
			await this.baseline();
			return 0;
		}
		let messages: RawDiscordMessage[];
		try {
			messages = await this.fetchMessages(this.lastSeen);
		} catch (err) {
			this.logger.warn("[RoundtableThreadManager] poll failed", {
				err: (err as Error).message,
			});
			return 0;
		}
		if (messages.length === 0) return 0;
		// Discord returns newest-first; process oldest-first.
		const ordered = [...messages].reverse();
		let advanced = 0;
		for (const raw of ordered) {
			const msg = this.mapMessage(raw);
			if (!msg.id) continue;
			let advance: boolean;
			try {
				advance = await this.processMessage(msg);
			} catch (err) {
				// Unexpected throw → treat as transient (retry, don't advance).
				this.logger.warn("[RoundtableThreadManager] process threw (retry)", {
					id: msg.id,
					err: (err as Error).message,
				});
				advance = false;
			}
			if (!advance) break; // hold cursor at this message; retry next poll
			this.lastSeen = msg.id;
			this.saveCursor(msg.id);
			advanced += 1;
		}
		return advanced;
	}

	/**
	 * Decide whether to advance the cursor past `msg`, opening a thread as a side
	 * effect when the trigger fires. Returns true to advance (handled / no-op /
	 * permanent), false to HOLD (transient — retry next poll).
	 */
	async processMessage(msg: RoundtableMessage): Promise<boolean> {
		// 1. Echo immunity — skip the poller's own bot messages, UNLESS
		// threadOwnBotMessages is set (then the bot's own top-level posts, e.g. a
		// CoS broadcast, are threaded too). No loop: seeds live in child threads
		// that the parent-only poll never sees.
		if (!this.threadOwnBotMessages && msg.authorId === this.botUserId)
			return true;
		// 2. FLY-314 fix — mode-independent pre-gates (BEFORE the trigger). Both are
		// "handled / no-op" (return true → cursor advances), never a transient hold.
		//   2a. follow-up gate: a Discord reply is a continuation, NOT a fresh topic —
		//       never open a second thread for it (the discussion stays in the original
		//       thread via reply-in-thread). This is the core "follow-up over-spawn" fix
		//       and holds regardless of the trigger mode.
		if (msg.referencedMessageId) return true;
		//   2b. noise gate: pure-emoji / one-word acks are not topics worth a thread.
		if (isTopicNoise(msg.content)) return true;
		// 3. Trigger — `disabled` mode makes this always false (canary / byte-compat).
		if (!this.trigger(msg)) return true;
		// 3. Dedup — already opened a thread for this message.
		if (this.store.getRoundtableTopicThread(this.channelId, msg.id))
			return true;

		// 4. Create the thread from the topic message (threadId === msg.id).
		const result = await this.createThreadFromMessage(msg);
		switch (result.kind) {
			case "created":
				// Host bot won the create — the name is already descriptive AND
				// createThreadFromMessage already set the 1h archive, so pass both as the
				// current values (no PATCH needed). commitThread returns false on a
				// transient decorate failure to hold the cursor.
				return await this.commitThread(msg, result.threadId, {
					seed: true,
					currentName: this.threadName(msg.content),
					currentArchiveMinutes: ROUNDTABLE_TOPIC_AUTO_ARCHIVE_MINUTES,
				});
			case "exists": {
				// Recovery: someone (usually the Belle plugin's real-time gateway) created
				// the thread first — confirm via GET (no second create), then decorate +
				// rename. A transient confirm failure HOLDS the cursor so the next poll
				// retries (otherwise a single 429/5xx would skip repair permanently).
				const conf = await this.confirmThreadExists(msg.id);
				if (conf.kind === "transient") return false; // hold — retry next poll
				if (conf.kind === "absent") {
					this.logger.warn(
						`[RoundtableThreadManager] create said thread exists for ${msg.id} but GET did not confirm — skipping`,
					);
					return true;
				}
				return await this.commitThread(msg, msg.id, {
					seed: false,
					currentName: conf.name,
					currentArchiveMinutes: conf.autoArchiveMinutes,
				});
			}
			case "deleted":
				return true; // message gone — nothing to thread
			case "auth":
				// Permanent (bad token / missing perms). LOUD log, advance (do NOT
				// wedge the channel). Not routed through store.insertEvent — that
				// schema is session-bound (Codex R2#1).
				this.logger.warn(
					`[RoundtableThreadManager] auth error creating thread for ${msg.id} (401/403) — check the roundtable bot token / CREATE_PUBLIC_THREADS permission`,
				);
				return true;
			case "client_error":
				this.logger.warn(
					`[RoundtableThreadManager] non-retryable Discord error ${result.status} creating thread for ${msg.id} — skipping`,
				);
				return true;
			default:
				// transient — hold the cursor, retry next poll.
				return false;
		}
	}

	/**
	 * FLY-576: decorate the topic thread, THEN persist the mapping (the commit point).
	 *
	 * Order matters for crash/transient safety:
	 *  1. Add the founder + configured members + @-mentioned leads. Each add is
	 *     awaited + classified — a transient failure returns false to HOLD the cursor
	 *     (the next poll re-runs; PUT thread-member is idempotent). A permanent
	 *     failure (bad token / no perms / gone) is warned and skipped (never wedge).
	 *  2. Converge thread metadata in ONE PATCH — rename a placeholder-named thread
	 *     (the plugin hard-codes the placeholder) to a descriptive name AND, for a
	 *     thread the plugin created with Discord's default 3-day archive, set the 1h
	 *     archive (FLY-802). Only the fields that actually changed are sent; same
	 *     hold-on-transient policy.
	 *  3. Persist the row LAST. A crash before here re-runs idempotently via the
	 *     160004 recovery path; a crash after here but before the cursor saves dedups
	 *     out safely (the row now means the critical repair already completed). This
	 *     is why dedup is only an optimization, not the safety property.
	 *  4. Seed message is best-effort AFTER the commit (its failure never re-opens
	 *     the strand risk).
	 *
	 * Returns true to advance the cursor, false to hold (transient — retry next poll).
	 */
	private async commitThread(
		msg: RoundtableMessage,
		threadId: string,
		opts: {
			seed: boolean;
			currentName?: string;
			/** The thread's current auto_archive_duration (minutes). Undefined when
			 * unreadable → treated as needing convergence (FLY-802). */
			currentArchiveMinutes?: number;
		},
	): Promise<boolean> {
		// FLY-576 (Annie's T2 model + founder): the founder is ALWAYS a member; union
		// with any configured base members and the leads the author @-mentioned. Skip
		// the poller's own bot id and any undefined (e.g. founder unset).
		const members = [
			...new Set([this.founderUserId, ...this.memberUserIds, ...msg.mentions]),
		].filter((id): id is string => Boolean(id) && id !== this.botUserId);
		for (const userId of members) {
			const outcome = await addThreadMember(threadId, userId, this.botToken, {
				fetchImpl: this.fetchImpl,
				timeoutMs: CREATE_TIMEOUT_MS,
			});
			if (outcome === "transient") return false; // hold — retry (PUT idempotent)
			// "permanent" already warned inside addThreadMember — proceed (no wedge).
		}

		// FLY-576 + FLY-802: converge the thread's metadata in ONE PATCH, sending only
		// the fields that actually need changing.
		//  - name: only when the creator left the generic placeholder (the plugin's
		//    real-time gateway hard-codes it); a thread the host bot created already
		//    reads descriptive → skipped.
		//  - auto_archive_duration: FLY-802 — the plugin's real-time gateway can win the
		//    create race and open the thread with Discord's DEFAULT 3-day archive, so
		//    the poller must converge it to 1h (else it never collapses out of the
		//    sidebar — the whole point of the issue). A thread the host bot created
		//    already carries 60 (currentArchiveMinutes === 60) → skipped, so there is no
		//    redundant Discord write on the create path.
		const patch: { name?: string; auto_archive_duration?: number } = {};
		const desired = this.threadName(msg.content);
		if (
			opts.currentName === ROUNDTABLE_PLACEHOLDER_NAME &&
			desired !== opts.currentName
		) {
			patch.name = desired;
		}
		if (opts.currentArchiveMinutes !== ROUNDTABLE_TOPIC_AUTO_ARCHIVE_MINUTES) {
			patch.auto_archive_duration = ROUNDTABLE_TOPIC_AUTO_ARCHIVE_MINUTES;
		}
		if (patch.name !== undefined || patch.auto_archive_duration !== undefined) {
			const outcome = await this.patchThread(threadId, patch);
			if (outcome === "transient") return false; // hold — converge on the next poll
			// "permanent" (e.g. no MANAGE_THREADS) already warned — membership stands.
		}

		// Commit point — persist only after the critical repair has converged.
		this.store.upsertRoundtableTopicThread({
			threadId,
			channelId: this.channelId,
			sourceMessageId: msg.id,
			authorId: msg.authorId,
			triggerMode: this.triggerMode,
		});

		if (opts.seed) void this.seedThread(threadId); // best-effort, after commit
		return true;
	}

	/** Best-effort seed message so the thread shows a starting line. Never throws,
	 * never holds the cursor (it runs AFTER the commit point). */
	private async seedThread(threadId: string): Promise<void> {
		try {
			await this.fetchImpl(`${DISCORD_API}/channels/${threadId}/messages`, {
				method: "POST",
				headers: {
					Authorization: `Bot ${this.botToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					content: markAutomatedDiscordText(
						"🧵 Topic — relevant leads, please discuss in this thread.",
					),
					allowed_mentions: { parse: [] },
				}),
			});
		} catch (err) {
			this.logger.warn("[RoundtableThreadManager] seed message failed", {
				threadId,
				err: (err as Error).message,
			});
		}
	}

	/** PATCH /channels/{threadId} with the given thread-metadata fields (name and/or
	 * auto_archive_duration). Classified like the member add: transient
	 * (429/5xx/network/timeout) → caller holds the cursor; permanent (401/403/404,
	 * e.g. the bot lacks MANAGE_THREADS) → warn + proceed (membership still converges). */
	private async patchThread(
		threadId: string,
		fields: { name?: string; auto_archive_duration?: number },
	): Promise<"patched" | "transient" | "permanent"> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), CREATE_TIMEOUT_MS);
		try {
			const res = await this.fetchImpl(`${DISCORD_API}/channels/${threadId}`, {
				method: "PATCH",
				headers: {
					Authorization: `Bot ${this.botToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(fields),
				signal: controller.signal,
			});
			if (res.ok) return "patched";
			this.logger.warn(
				`[RoundtableThreadManager] patch thread ${threadId} failed: HTTP ${res.status} (name/archive stays as-is)`,
			);
			if (res.status === 408 || res.status === 429 || res.status >= 500)
				return "transient";
			return "permanent";
		} catch (err) {
			this.logger.warn("[RoundtableThreadManager] patch thread error", {
				threadId,
				err: (err as Error).message,
			});
			return "transient";
		} finally {
			clearTimeout(timer);
		}
	}

	/** POST /channels/{channelId}/messages/{messageId}/threads. */
	private async createThreadFromMessage(
		msg: RoundtableMessage,
	): Promise<CreateResult> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), CREATE_TIMEOUT_MS);
		try {
			const res = await this.fetchImpl(
				`${DISCORD_API}/channels/${this.channelId}/messages/${msg.id}/threads`,
				{
					method: "POST",
					headers: {
						Authorization: `Bot ${this.botToken}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						name: this.threadName(msg.content),
						// FLY-802: 1h auto-archive so finished topics collapse out of the sidebar.
						auto_archive_duration: ROUNDTABLE_TOPIC_AUTO_ARCHIVE_MINUTES,
					}),
					signal: controller.signal,
				},
			);
			if (res.ok) {
				const data = (await res.json().catch(() => ({}))) as { id?: string };
				// Invariant: thread id == source message id. Fall back to msg.id if the
				// body is unparseable.
				return { kind: "created", threadId: data.id ?? msg.id };
			}
			if (res.status === 404) return { kind: "deleted" };
			if (res.status === 401 || res.status === 403) return { kind: "auth" };
			if (res.status === 429) {
				// Honor Retry-After (capped) → delay the NEXT poll instead of hammering
				// every base interval (Codex code review #2). Holds the cursor.
				const retryAfterMs = parseRetryAfterMs(
					res.headers?.get?.("retry-after"),
				);
				if (retryAfterMs !== undefined) {
					this.pendingDelayMs = Math.max(
						this.pendingDelayMs ?? 0,
						Math.min(retryAfterMs, MAX_RETRY_AFTER_MS),
					);
				}
				return { kind: "transient" };
			}
			if (res.status >= 500) return { kind: "transient" };
			if (res.status === 400) {
				const body = (await res.json().catch(() => ({}))) as { code?: number };
				if (body.code === THREAD_ALREADY_EXISTS_CODE) return { kind: "exists" };
				return { kind: "client_error", status: 400 };
			}
			return { kind: "client_error", status: res.status };
		} catch {
			// Network error / abort/timeout — transient.
			return { kind: "transient" };
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * GET /channels/{messageId} — confirm a thread owned by the roundtable channel
	 * exists (recovery anchor: threadId === messageId) AND read its current name +
	 * archive duration (so the caller can rename a placeholder and converge a
	 * plugin-created thread's stale 3-day archive to 1h — FLY-802).
	 *
	 * FLY-576: classified, not boolean. A transient failure (429/5xx/network/timeout)
	 * must NOT be collapsed to "not confirmed" — that would advance the cursor and
	 * skip the founder/member/rename repair forever. The caller holds the cursor on
	 * "transient" and retries next poll.
	 *  - "confirmed": is a thread under this channel; carries `name` +
	 *    `autoArchiveMinutes` if readable.
	 *  - "absent": 200-but-not-a-matching-thread, 404, or a non-retryable 4xx — there
	 *    is nothing to repair / retrying won't help.
	 *  - "transient": retry next poll.
	 */
	private async confirmThreadExists(
		messageId: string,
	): Promise<
		| { kind: "confirmed"; name?: string; autoArchiveMinutes?: number }
		| { kind: "absent" }
		| { kind: "transient" }
	> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), CREATE_TIMEOUT_MS);
		try {
			const res = await this.fetchImpl(`${DISCORD_API}/channels/${messageId}`, {
				headers: { Authorization: `Bot ${this.botToken}` },
				signal: controller.signal,
			});
			if (res.ok) {
				const data = (await res.json().catch(() => ({}))) as {
					type?: number;
					parent_id?: string;
					name?: unknown;
					thread_metadata?: { auto_archive_duration?: unknown };
				};
				const isThread =
					typeof data.type === "number" &&
					THREAD_TYPES.has(data.type) &&
					data.parent_id === this.channelId;
				if (!isThread) return { kind: "absent" };
				// FLY-802: also read the thread's current archive duration so commitThread
				// can converge a plugin-created thread (Discord's default 3-day) to 1h
				// without a redundant PATCH when it is already correct.
				const rawArchive = data.thread_metadata?.auto_archive_duration;
				return {
					kind: "confirmed",
					name: typeof data.name === "string" ? data.name : undefined,
					autoArchiveMinutes:
						typeof rawArchive === "number" ? rawArchive : undefined,
				};
			}
			// 408 / 429 / 5xx → retry; everything else (404 gone, 401/403) → nothing to do.
			if (res.status === 408 || res.status === 429 || res.status >= 500)
				return { kind: "transient" };
			return { kind: "absent" };
		} catch {
			return { kind: "transient" }; // network / abort / timeout → retry
		} finally {
			clearTimeout(timer);
		}
	}

	private async fetchMessages(
		afterId: string | undefined,
	): Promise<RawDiscordMessage[]> {
		const params = new URLSearchParams({ limit: String(this.limit) });
		if (afterId) params.set("after", afterId);
		const res = await this.fetchImpl(
			`${DISCORD_API}/channels/${this.channelId}/messages?${params.toString()}`,
			{ headers: { Authorization: `Bot ${this.botToken}` } },
		);
		if (!res.ok) throw new Error(`Discord GET messages ${res.status}`);
		const body = (await res.json()) as unknown;
		return Array.isArray(body) ? (body as RawDiscordMessage[]) : [];
	}

	private mapMessage(m: RawDiscordMessage): RoundtableMessage {
		return {
			id: m.id,
			channelId: m.channel_id ?? this.channelId,
			authorId: m.author?.id ?? "",
			authorBot: m.author?.bot === true,
			content: m.content ?? "",
			mentions: (m.mentions ?? [])
				.map((u) => u.id)
				.filter((id): id is string => Boolean(id)),
			mentionEveryone: m.mention_everyone === true,
			referencedMessageId: m.message_reference?.message_id,
		};
	}

	/**
	 * FLY-576: a descriptive thread name from the topic content. Strips Discord
	 * markup (user/role/channel mentions, custom emoji) so the name reads as the
	 * topic, not raw `<@id>` noise. Falls back to the placeholder when the message
	 * has no usable text (e.g. mentions-only).
	 */
	private threadName(content: string): string {
		return deriveRoundtableThreadName(content);
	}
}
