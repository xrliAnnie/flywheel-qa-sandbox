/**
 * FLY-404 — DiscordTypingNotifier: the concrete `TypingNotifier` that shows the
 * Discord "typing…" indicator while a Codex Lead processes a founder's message
 * (parity with the Claude Lead, whose Discord plugin does this). Wired into the
 * shared `LeadInputRouter`, so it covers BOTH Codex Lead runtimes — the headless
 * app-server (codex-lead-runtime) AND the windowed TUI sidecar (codex-lead-tui-
 * runtime), which both drive Discord I/O through that one router.
 *
 * Why a keepalive loop: Discord's typing indicator (POST /channels/{id}/typing)
 * auto-expires after ~10s, but a model turn can take far longer (the whole reason
 * the founder couldn't tell the Lead was working). So `start` fires immediately
 * AND refreshes every `refreshMs` (~8s) until `stop`/`close`, with two safety
 * brakes: a hard `maxDurationMs` cap (a missed stop can never type forever) and a
 * consecutive-failure circuit breaker (a dead/forbidden channel stops hammering).
 *
 * Storm-immune (FLY-220): the typing endpoint creates NO message, so it can never
 * echo into a Lead's pane or self-amplify — unlike a posted reply.
 *
 * Robustness contract: `start`/`stop`/`close` NEVER throw — a typing failure can
 * never break the reply turn that drives it. Timers + clock + the sender are
 * injected so the loop is unit-tested deterministically with no real network/time.
 */

import { sendTypingToChannel } from "../../bridge/discord-utils.js";
import type { TypingNotifier } from "./LeadInputRouter.js";

type SendFn = (
	channelId: string,
	botToken: string,
) => Promise<{ ok: boolean; error?: string }>;

export interface DiscordTypingNotifierOptions {
	/** The Lead's OWN Discord bot token (same identity as its replies). */
	botToken: string;
	/** The channel a reply posts to when an input carries no explicit channel
	 * (chat/core/mailbox) — `start(undefined)` resolves to this. */
	defaultChannelId: string;
	/** Injected typing poster (defaults to the REST `sendTypingToChannel`). */
	sendImpl?: SendFn;
	/** Keepalive cadence — Discord typing lasts ~10s, so default 8000ms. */
	refreshMs?: number;
	/** Hard safety cap per channel — default 600000ms (10 min). A loop that somehow
	 * outlives its `stop` is force-stopped on the first tick past this. */
	maxDurationMs?: number;
	/** Consecutive send failures before a channel's loop self-stops — default 3. */
	maxConsecutiveFailures?: number;
	logger?: { warn: (m: string, c?: unknown) => void };
	/** Injected timer impls (tests). Default to the globals. */
	scheduler?: {
		setInterval: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
		clearInterval: (h: ReturnType<typeof setInterval>) => void;
	};
	/** Injected monotonic-ish clock (tests). Default `Date.now`. */
	now?: () => number;
}

interface TypingLoop {
	startedAt: number;
	failures: number;
	handle: ReturnType<typeof setInterval>;
}

export class DiscordTypingNotifier implements TypingNotifier {
	private readonly botToken: string;
	private readonly defaultChannelId: string;
	private readonly sendImpl: SendFn;
	private readonly refreshMs: number;
	private readonly maxDurationMs: number;
	private readonly maxFailures: number;
	private readonly logger: { warn: (m: string, c?: unknown) => void };
	private readonly setIntervalImpl: (
		cb: () => void,
		ms: number,
	) => ReturnType<typeof setInterval>;
	private readonly clearIntervalImpl: (
		h: ReturnType<typeof setInterval>,
	) => void;
	private readonly now: () => number;
	/** One keepalive per RESOLVED channel id. The router is serial, so in practice
	 * at most one is ever live — but keying by channel keeps it robust regardless. */
	private readonly loops = new Map<string, TypingLoop>();

	constructor(opts: DiscordTypingNotifierOptions) {
		if (!opts.botToken)
			throw new Error("DiscordTypingNotifier: botToken required");
		if (!opts.defaultChannelId)
			throw new Error("DiscordTypingNotifier: defaultChannelId required");
		this.botToken = opts.botToken;
		this.defaultChannelId = opts.defaultChannelId;
		this.sendImpl =
			opts.sendImpl ??
			((channelId, botToken) => sendTypingToChannel(channelId, botToken));
		this.refreshMs = opts.refreshMs ?? 8000;
		this.maxDurationMs = opts.maxDurationMs ?? 600_000;
		this.maxFailures = opts.maxConsecutiveFailures ?? 3;
		this.logger = opts.logger ?? { warn: () => {} };
		this.setIntervalImpl =
			opts.scheduler?.setInterval ?? ((cb, ms) => setInterval(cb, ms));
		this.clearIntervalImpl =
			opts.scheduler?.clearInterval ?? ((h) => clearInterval(h));
		this.now = opts.now ?? (() => Date.now());
	}

	/** Begin (or keep) showing "typing…" in the resolved channel. Idempotent: a
	 * second start for a channel already typing is a no-op (the live loop carries
	 * it). Never throws. */
	start(channelId?: string): void {
		const ch = channelId || this.defaultChannelId;
		if (!ch || this.loops.has(ch)) return;
		const handle = this.setIntervalImpl(() => this.tick(ch), this.refreshMs);
		// Never hold the process open on the keepalive timer.
		(handle as { unref?: () => void }).unref?.();
		this.loops.set(ch, { startedAt: this.now(), failures: 0, handle });
		// Fire the first typing immediately (don't wait a full refresh interval).
		void this.fire(ch);
	}

	/** Stop showing "typing…" in the resolved channel. Idempotent. Never throws. */
	stop(channelId?: string): void {
		const ch = channelId || this.defaultChannelId;
		const loop = this.loops.get(ch);
		if (!loop) return;
		this.clearIntervalImpl(loop.handle);
		this.loops.delete(ch);
	}

	/** Clear ALL active loops (shutdown / TUI generation rebuild). Never throws. */
	close(): void {
		for (const loop of this.loops.values()) this.clearIntervalImpl(loop.handle);
		this.loops.clear();
	}

	/** Keepalive tick: enforce the duration cap, else refresh typing. */
	private tick(ch: string): void {
		const loop = this.loops.get(ch);
		if (!loop) return;
		if (this.now() - loop.startedAt >= this.maxDurationMs) {
			this.logger.warn("typing keepalive hit max-duration cap — stopping", {
				channelId: ch,
			});
			this.stop(ch);
			return;
		}
		void this.fire(ch);
	}

	/** Send one typing pulse; account success/failure for the circuit breaker.
	 * Swallows everything — a typing failure must never surface to the turn. */
	private async fire(ch: string): Promise<void> {
		let res: { ok: boolean; error?: string };
		try {
			res = await this.sendImpl(ch, this.botToken);
		} catch (err) {
			// sendTypingToChannel never throws, but a custom sendImpl might — treat a
			// thrown rejection as a failed pulse rather than crashing the loop.
			res = { ok: false, error: (err as Error).message };
		}
		const loop = this.loops.get(ch);
		if (!loop) return; // stopped while in-flight
		if (res.ok) {
			loop.failures = 0;
			return;
		}
		loop.failures += 1;
		this.logger.warn("typing pulse failed", {
			channelId: ch,
			error: res.error,
			failures: loop.failures,
		});
		if (loop.failures >= this.maxFailures) {
			this.logger.warn(
				"typing keepalive hit consecutive-failure cap — stopping",
				{ channelId: ch },
			);
			this.stop(ch);
		}
	}
}
