/**
 * FLY-314 Phase 2 — buildReplyInThreadWiring: assembles the reply-in-thread parts
 * (registry + route resolver + ensure hook + active-thread discovery) into ONE object
 * that BOTH the headless and TUI Codex Lead runtimes wire identically (Codex design
 * review R1#5/#6 — the same wiring lives in two runtimes; a shared builder keeps them
 * in lockstep). Returns `undefined` when the feature is off → byte-compat.
 */

import { ensureThreadFromMessage } from "../../bridge/roundtable/ensure-thread-from-message.js";
import type { DiscordInboundMessage } from "./CodexDiscordGateway.js";
import {
	type ChannelSubscriber,
	RoundtableThreadDiscovery,
} from "./RoundtableThreadDiscovery.js";
import { RoundtableThreadRegistry } from "./RoundtableThreadRegistry.js";
import {
	type ReplyRouteResult,
	type RoundtableReplyRoute,
	resolveRoundtableReplyRoute,
} from "./roundtable-reply-route.js";

export interface ReplyInThreadConfig {
	enabled: boolean;
	/** The roundtable parent channel id (where top-level topics are posted). */
	parentChannelId: string;
	/** Required for active-thread discovery (path ii). Omitted → only the immediate
	 * @-mention path (i) subscribes; reconciliation/restart-recovery is then absent. */
	guildId?: string;
	cap?: number;
	reconcileIntervalMs?: number;
}

export interface ReplyInThreadWiring {
	registry: RoundtableThreadRegistry;
	/** Structured route for the gateway (supersedes resolveReplyChannelId). */
	resolveReplyRoute: (msg: DiscordInboundMessage) => ReplyRouteResult;
	/** Ensure hook for the LeadInputRouter (creates the topic thread before delivery). */
	ensureReplyRoute: (route: RoundtableReplyRoute) => Promise<void>;
	start(): Promise<void>;
	stop(): Promise<void>;
}

export function buildReplyInThreadWiring(opts: {
	cfg: ReplyInThreadConfig;
	botToken: string;
	botUserId: string;
	crossDeptChannelIds: string[];
	source: ChannelSubscriber;
	fetchImpl?: typeof fetch;
	setTimer?: (fn: () => void, ms: number) => { cancel: () => void };
	logger?: { warn: (m: string, c?: unknown) => void };
}): ReplyInThreadWiring | undefined {
	if (!opts.cfg.enabled) return undefined;

	const registry = new RoundtableThreadRegistry();
	const parentChannelId = opts.cfg.parentChannelId;
	// Other cross-dept channels keep their FLY-267 source-channel reply (R2#2).
	const staticCrossDept = new Set(
		opts.crossDeptChannelIds.filter((id) => id !== parentChannelId),
	);

	const discovery = opts.cfg.guildId
		? new RoundtableThreadDiscovery({
				guildId: opts.cfg.guildId,
				roundtableChannelId: parentChannelId,
				botUserId: opts.botUserId,
				botToken: opts.botToken,
				registry,
				source: opts.source,
				...(opts.cfg.cap !== undefined ? { cap: opts.cfg.cap } : {}),
				...(opts.cfg.reconcileIntervalMs !== undefined
					? { reconcileIntervalMs: opts.cfg.reconcileIntervalMs }
					: {}),
				...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
				...(opts.setTimer ? { setTimer: opts.setTimer } : {}),
				...(opts.logger ? { logger: opts.logger } : {}),
			})
		: undefined;

	const resolveReplyRoute = (msg: DiscordInboundMessage): ReplyRouteResult => {
		const r = resolveRoundtableReplyRoute(msg, {
			roundtableParentChannelId: parentChannelId,
			registry,
			staticCrossDept,
		});
		// Immediate subscribe (path i): once we route a reply INTO a topic thread, the
		// Lead must also poll that thread to see other Leads' replies. Fire-and-forget.
		if (r.replyRoute) void subscribeImmediate(r.replyRoute.threadId);
		return r;
	};

	async function subscribeImmediate(threadId: string): Promise<void> {
		if (discovery) {
			await discovery.subscribe(threadId);
			return;
		}
		// No discovery (no guildId): still subscribe so the Lead can read the thread.
		if (!registry.has(threadId)) {
			registry.add(threadId);
			await opts.source.addChannel(threadId);
		}
	}

	const ensureReplyRoute = async (
		route: RoundtableReplyRoute,
	): Promise<void> => {
		const res = await ensureThreadFromMessage(
			route.parentChannelId,
			route.sourceMessageId,
			opts.botToken,
			opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {},
		);
		if (!res.ok) {
			opts.logger?.warn(
				`[reply-in-thread] ensureThreadFromMessage failed for ${route.threadId}: ${res.reason}`,
			);
		}
	};

	return {
		registry,
		resolveReplyRoute,
		ensureReplyRoute,
		start: () => discovery?.start() ?? Promise.resolve(),
		stop: () => discovery?.stop() ?? Promise.resolve(),
	};
}
