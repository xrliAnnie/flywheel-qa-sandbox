/**
 * FLY-314 Phase 2 — buildReplyInThreadWiring: assembles the reply-in-thread parts
 * (registry + route resolver + ensure hook + active-thread discovery) into ONE object
 * that BOTH the headless and TUI Codex Lead runtimes wire identically (Codex design
 * review R1#5/#6 — the same wiring lives in two runtimes; a shared builder keeps them
 * in lockstep). Returns `undefined` when the feature is off → byte-compat.
 */

import { makeChannelArchiveDefaultProvider } from "../../bridge/roundtable/channel-archive-default.js";
import { ensureThreadFromMessage } from "../../bridge/roundtable/ensure-thread-from-message.js";
import type { DiscordInboundMessage } from "./CodexDiscordGateway.js";
import type { JournalEntry } from "./LeadJournal.js";
import {
	type ChannelSubscriber,
	RoundtableThreadDiscovery,
} from "./RoundtableThreadDiscovery.js";
import type {
	RegistrySnapshot,
	SubscriptionEntry,
} from "./RoundtableThreadRegistry.js";
import { RoundtableThreadRegistry } from "./RoundtableThreadRegistry.js";
import {
	type ReplyRouteResult,
	type RoundtableReplyRoute,
	resolveRoundtableReplyRoute,
} from "./roundtable-reply-route.js";
import {
	appendAudit,
	auditPath,
	ledgerPath,
	parseLedgerFile,
	persistSnapshot,
	quarantineCorrupt,
} from "./roundtable-subscription-ledger.js";
import {
	createThreadBudgetStore,
	DEFAULT_ROUNDTABLE_THREAD_BUDGET,
	seedThreadBudget,
	type ThreadBudgetStore,
} from "./roundtable-thread-budget.js";

export interface ReplyInThreadConfig {
	enabled: boolean;
	/** The roundtable parent channel id (where top-level topics are posted). */
	parentChannelId: string;
	/** Enables Discord reconciliation of existing durable subscriptions.
	 * Ledger restart recovery works with or without a guild id. */
	guildId?: string;
	cap?: number;
	subscriptionTtlMs?: number;
	reconcileIntervalMs?: number;
	/** FLY-314 Part(b): no-@ in-thread continuation inside topic threads, bounded by the
	 * anti-loop budget. Default false → topic threads stay mention-required (byte-compat,
	 * FLY-220). */
	autoContinue?: boolean;
	/** Per-thread bot-only continuation budget (conservative default 2). */
	budgetN?: number;
}

export interface ReplyInThreadWiring {
	registry: RoundtableThreadRegistry;
	/** Structured route for the gateway (supersedes resolveReplyChannelId). */
	resolveReplyRoute: (msg: DiscordInboundMessage) => ReplyRouteResult;
	/** Ensure hook for the LeadInputRouter (creates the topic thread before delivery). */
	ensureReplyRoute: (route: RoundtableReplyRoute) => Promise<void>;
	/** Seed the anti-loop budget for a newly-engaged top-level topic. LeadInputRouter
	 * MUST call this ONLY when journal.accept() returns accepted (Codex code review R2 —
	 * a budget reset must require a durably-accepted new topic, not an at-least-once
	 * re-delivery of an old one). No-op when autoContinue is off. */
	seedBudgetForRoute: (route: RoundtableReplyRoute) => void;
	/** FLY-314 Part(b): no-@ in-thread continuation enabled (kill-switch). */
	autoContinue: boolean;
	/** Per-thread bot-only anti-loop budget store (membership implicit = registry). */
	budgetStore: ThreadBudgetStore;
	/** Per-thread bot-only continuation budget. */
	budgetN: number;
	onTopicEngaged(route: RoundtableReplyRoute): Promise<void>;
	onInputAccepted(
		entry: Pick<JournalEntry, "replyChannelId" | "replyRoute">,
	): void;
	listSubscriptions(): SubscriptionEntry[];
	unsubscribeThread(
		threadId: string,
		reason: string,
		actor: string,
	): Promise<boolean>;
	restoreState(): Promise<void>;
	activateSource(): Promise<void>;
	start(): Promise<void>;
	stop(): Promise<void>;
}

export function buildReplyInThreadWiring(opts: {
	cfg: ReplyInThreadConfig;
	stateDir: string;
	now?: () => number;
	persistSnapshot?: typeof persistSnapshot;
	botToken: string;
	botUserId: string;
	crossDeptChannelIds: string[];
	source: ChannelSubscriber;
	fetchImpl?: typeof fetch;
	setTimer?: (fn: () => void, ms: number) => { cancel: () => void };
	logger?: { warn: (m: string, c?: unknown) => void };
}): ReplyInThreadWiring | undefined {
	if (!opts.cfg.enabled) return undefined;

	const now = opts.now ?? Date.now;
	const registry = new RoundtableThreadRegistry({
		ttlMs: opts.cfg.subscriptionTtlMs ?? 86_400_000,
		cap: opts.cfg.cap ?? 50,
		now,
	});
	const ledger = ledgerPath(opts.stateDir);
	const audit = (op: string, fields: Record<string, unknown> = {}) =>
		appendAudit(auditPath(opts.stateDir), {
			ts: new Date(now()).toISOString(),
			op,
			parentChannelId: opts.cfg.parentChannelId,
			...fields,
		});
	const persist = opts.persistSnapshot ?? persistSnapshot;
	let restored = false;
	let active = false;
	let sweepTimer: { cancel(): void } | undefined;
	const setTimer =
		opts.setTimer ??
		((fn: () => void, ms: number) => {
			const timer = setTimeout(fn, ms);
			timer.unref?.();
			return { cancel: () => clearTimeout(timer) };
		});
	async function applyPlan(
		plan: { next: RegistrySnapshot },
		op: string,
		reason = op,
		actor = "runtime",
	): Promise<boolean> {
		const before = registry.entries();
		try {
			persist(ledger, plan.next);
		} catch (error) {
			audit("persist_failed", { reason, actor, error: String(error) });
			return false;
		}
		registry.commit(plan.next);
		const nextIds = new Set(plan.next.entries.map((e) => e.threadId));
		const beforeIds = new Set(before.map((e) => e.threadId));
		for (const entry of before)
			if (!nextIds.has(entry.threadId)) {
				try {
					opts.source.removeChannel(entry.threadId);
				} catch (error) {
					audit("source_failed", {
						threadId: entry.threadId,
						reason,
						actor,
						error: String(error),
					});
				}
				audit(op === "add" ? "evict" : op, {
					threadId: entry.threadId,
					reason,
					actor,
				});
			}
		for (const entry of plan.next.entries)
			if (
				!beforeIds.has(entry.threadId) ||
				(op === "add" &&
					!before.some(
						(e) =>
							e.threadId === entry.threadId && Date.parse(e.expiresAt) > now(),
					))
			) {
				try {
					await opts.source.addChannel(entry.threadId);
				} catch (error) {
					audit("source_failed", {
						threadId: entry.threadId,
						reason,
						actor,
						error: String(error),
					});
				}
				audit(op, { threadId: entry.threadId, reason, actor });
			}
		return true;
	}
	const budgetStore = createThreadBudgetStore();
	const budgetN =
		opts.cfg.budgetN && opts.cfg.budgetN > 0
			? opts.cfg.budgetN
			: DEFAULT_ROUNDTABLE_THREAD_BUDGET;
	const autoContinue = opts.cfg.autoContinue === true;
	const parentChannelId = opts.cfg.parentChannelId;
	const archiveDefaultProvider = makeChannelArchiveDefaultProvider({
		channelId: parentChannelId,
		botToken: opts.botToken,
		...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
		...(opts.logger
			? { logger: { warn: (message: string) => opts.logger?.warn(message) } }
			: {}),
	});
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
				removeThread: (id, reason) =>
					applyPlan(registry.planRemove(id), "remove", reason),
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
		return r;
	};

	const ensureReplyRoute = async (
		route: RoundtableReplyRoute,
	): Promise<void> => {
		const res = await ensureThreadFromMessage(
			route.parentChannelId,
			route.sourceMessageId,
			opts.botToken,
			{
				...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
				archiveDefaultProvider,
				// FLY-314 fix: correct-from-start name so a Codex-created topic thread is
				// never left as the generic "Roundtable topic" placeholder.
				...(route.threadName ? { threadName: route.threadName } : {}),
			},
		);
		if (!res.ok) {
			opts.logger?.warn(
				`[reply-in-thread] ensureThreadFromMessage failed for ${route.threadId}: ${res.reason}`,
			);
		}
	};

	const seedBudgetForRoute = (route: RoundtableReplyRoute): void => {
		if (autoContinue) seedThreadBudget(budgetStore, route.threadId, budgetN);
	};

	const onTopicEngaged = async (route: RoundtableReplyRoute): Promise<void> => {
		if (route.parentChannelId !== parentChannelId) {
			audit("reject", {
				threadId: route.threadId,
				parentChannelId: route.parentChannelId,
				reason: "wrong_parent",
			});
			return;
		}
		const plan = registry.planAdd({
			threadId: route.threadId,
			parentChannelId,
			source: "mention",
		});
		if (plan.added && !(await applyPlan(plan, "add"))) return;
		seedBudgetForRoute(route);
	};
	const onInputAccepted = (
		entry: Pick<JournalEntry, "replyChannelId" | "replyRoute">,
	): void => {
		if (entry.replyChannelId && registry.has(entry.replyChannelId))
			void applyPlan(registry.planTouch(entry.replyChannelId), "touch");
	};
	const restoreState = async (): Promise<void> => {
		if (restored) return;
		const parsed = parseLedgerFile(ledger);
		if (!parsed.ok && parsed.reason === "corrupt") {
			quarantineCorrupt(ledger);
			audit("restore_failed", { reason: "corrupt" });
		}
		if (parsed.ok)
			for (const drop of parsed.dropped)
				audit("restore_failed", { reason: drop.why });
		const plan = registry.planRestore(
			parsed.ok ? parsed.snapshot : { version: 1, entries: [] },
			parentChannelId,
		);
		try {
			persist(ledger, plan.next);
		} catch (error) {
			audit("persist_failed", { reason: "restore", error: String(error) });
			if (parsed.ok || parsed.reason !== "missing") throw error;
			restored = true;
			return;
		}
		registry.commit(plan.next);
		for (const drop of plan.dropped)
			audit(drop.why === "expired" ? "expire" : "restore_failed", {
				threadId: drop.entry.threadId,
				reason: drop.why,
			});
		restored = true;
	};
	const scheduleSweep = (): void => {
		if (!active) return;
		sweepTimer = setTimer(() => {
			const plan = registry.planSweep();
			void (
				plan.expired.length ? applyPlan(plan, "expire") : Promise.resolve()
			).finally(scheduleSweep);
		}, 60_000);
	};
	const activateSource = async (): Promise<void> => {
		if (!restored)
			throw new Error(
				"reply-in-thread restoreState must precede source activation",
			);
		if (active) return;
		active = true;
		for (const entry of registry.entries()) {
			// Earlier dynamic drains may accept an unsubscribe or expiry while awaited.
			if (!registry.has(entry.threadId)) continue;
			try {
				await opts.source.addChannel(entry.threadId);
			} catch (error) {
				audit("source_failed", {
					threadId: entry.threadId,
					reason: "restore",
					error: String(error),
				});
			}
			audit("restore", { threadId: entry.threadId });
		}
		scheduleSweep();
		await discovery?.start();
	};
	return {
		registry,
		resolveReplyRoute,
		ensureReplyRoute,
		seedBudgetForRoute,
		onTopicEngaged,
		onInputAccepted,
		autoContinue,
		budgetStore,
		budgetN,
		listSubscriptions: () => registry.entries(),
		unsubscribeThread: async (id, reason, actor) => {
			const plan = registry.planRemove(id);
			return plan.removed ? applyPlan(plan, "remove", reason, actor) : false;
		},
		restoreState,
		activateSource,
		start: async () => {
			await restoreState();
			await activateSource();
		},
		stop: async () => {
			active = false;
			sweepTimer?.cancel();
			await discovery?.stop();
		},
	};
}
