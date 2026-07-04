/**
 * FLY-368: the unified-alert product layer that sits on top of LeadAlertNotifier.
 *
 * Responsibilities (all best-effort over Discord — the root alert via the
 * notifier is the reliability anchor and is NEVER blocked by a threading failure):
 *  1. Per-error threading — on a successful unified-channel root post, open a
 *     Discord thread, post an "ack", and (if auto-repair is on) run the
 *     conservative bot and post its result.
 *  2. Active-mapping persistence (`alert_threads`) keyed by a coarse
 *     correlation key, so the thread can be RESOLVED later and so a Bridge
 *     restart can reconcile (the durable row outlives the in-memory state).
 *  3. Recovery → resolve: a real-time hook (`onLeadRecovery`, fed by the
 *     LeadWatchdog) AND a restart-safe reconcile pass (`reconcile`, run from the
 *     watchdog's onPollComplete) post "recovered" + archive the thread.
 *
 * Degradation (Codex R1 MEDIUM-5): a `queued` (Discord transient failure) or a
 * `duplicate` with no active thread degrades to ROOT-ONLY — no thread/ack/bot.
 */

import type {
	AlertEventType,
	AlertPayload,
	AlertResult,
} from "../LeadAlertNotifier.js";
import {
	classifyLeadAlertPane,
	isIdleHealthyPane,
	leadPaneLiveHash,
} from "../LeadWatchdog.js";
import type { AlertThreadRow, StateStore } from "../StateStore.js";
import type { AutoRepairBot } from "./AutoRepairBot.js";
import { fingerprintOutput } from "./stuck-candidate.js";

const DISCORD_API = "https://discord.com/api/v10";

/** A bot whose token can't post here (no channel perms) → try the next bot. */
function isPermFallthrough(status: number): boolean {
	return status === 401 || status === 403 || status === 404;
}

/**
 * FLY-368 rework: production DiscordOps over the Discord REST API using the
 * REPAIR chain (Cass → alphabetical fleet). `getTokens()` returns the ordered,
 * resolved bot tokens at CALL time (env may change; tokens never cached). Each
 * operation tries candidates in order: 2xx wins; 401/403/404 (that bot lacks
 * channel perms) → next candidate; any other non-2xx → throw (the Hub's safe
 * wrapper logs). Every message sends `allowed_mentions: { parse: [] }` so an
 * issue id / title / body can never ping the channel (Codex R1 LOW-11).
 */
export function createDiscordOps(
	getTokens: () => string[],
	fetchFn: typeof globalThis.fetch = globalThis.fetch,
): DiscordOps {
	const authHeaders = (token: string) => ({
		Authorization: `Bot ${token}`,
		"Content-Type": "application/json",
	});
	return {
		async createThreadFromMessage(channelId, messageId, name) {
			const tokens = getTokens();
			for (const token of tokens) {
				try {
					const res = await fetchFn(
						`${DISCORD_API}/channels/${channelId}/messages/${messageId}/threads`,
						{
							method: "POST",
							headers: authHeaders(token),
							body: JSON.stringify({ name, auto_archive_duration: 1440 }),
						},
					);
					if (res.ok) {
						const body = (await res.json()) as { id?: string };
						return body.id ?? null;
					}
					if (isPermFallthrough(res.status)) continue; // this bot can't post → next
					return null; // other failure → best-effort degrade to root-only
				} catch {
					return null;
				}
			}
			return null; // no candidate could create the thread
		},
		async postToThread(threadId, content, opts) {
			const tokens = getTokens();
			let lastStatus: number | undefined;
			// FLY-368 v1.58.0: by default suppress ALL mentions (parse:[]); only a
			// needs_human escalation opts in to a single REAL founder @-ping via
			// `mentionUserId` (the id is runtime-validated as a snowflake by the Hub).
			const allowed_mentions = opts?.mentionUserId
				? { users: [opts.mentionUserId] }
				: { parse: [] as string[] };
			for (const token of tokens) {
				const res = await fetchFn(
					`${DISCORD_API}/channels/${threadId}/messages`,
					{
						method: "POST",
						headers: authHeaders(token),
						body: JSON.stringify({ content, allowed_mentions }),
					},
				);
				if (res.ok) return;
				lastStatus = res.status;
				if (isPermFallthrough(res.status)) continue;
				// Non-perm failure → throw so the Hub's safe wrapper logs it.
				throw new Error(`Discord postToThread ${res.status} for ${threadId}`);
			}
			throw new Error(
				`Discord postToThread exhausted repair chain (last=${lastStatus ?? "no-token"}) for ${threadId}`,
			);
		},
		async archiveThread(threadId) {
			const tokens = getTokens();
			let lastStatus: number | undefined;
			for (const token of tokens) {
				const res = await fetchFn(`${DISCORD_API}/channels/${threadId}`, {
					method: "PATCH",
					headers: authHeaders(token),
					body: JSON.stringify({ archived: true }),
				});
				if (res.ok) return;
				lastStatus = res.status;
				if (isPermFallthrough(res.status)) continue;
				throw new Error(`Discord archiveThread ${res.status} for ${threadId}`);
			}
			throw new Error(
				`Discord archiveThread exhausted repair chain (last=${lastStatus ?? "no-token"}) for ${threadId}`,
			);
		},
	};
}

/** Discord operations the Hub needs — injected for testability. */
export interface DiscordOps {
	/** Create a thread off a posted message; returns the thread id or null on failure. */
	createThreadFromMessage(
		channelId: string,
		messageId: string,
		name: string,
	): Promise<string | null>;
	/**
	 * Post a message into a thread (best-effort). FLY-368 v1.58.0: `opts.mentionUserId`
	 * opts that one post into a single REAL user @-ping (allowed_mentions.users);
	 * omitted → all mentions suppressed (parse:[]), the default for ack/attempted/resolve.
	 */
	postToThread(
		threadId: string,
		content: string,
		opts?: { mentionUserId?: string },
	): Promise<void>;
	/** Archive a thread (best-effort). */
	archiveThread(threadId: string): Promise<void>;
}

export interface AlertChannelHubDeps {
	store: StateStore;
	notifier: { alert: (p: AlertPayload) => Promise<AlertResult> };
	discord: DiscordOps;
	/** Optional — when absent, no auto-repair runs (FLYWHEEL_AUTO_REPAIR off). */
	autoRepairBot?: AutoRepairBot;
	/**
	 * Reconcile-pass capture of a Lead pane (null = no window / cannot tell).
	 * Required for the restart-safe Lead recovery reconcile.
	 */
	capturePane?: (projectName: string, leadId: string) => Promise<string | null>;
	/**
	 * Reconcile-pass capture of a RUNNER terminal by executionId (null = cannot
	 * capture → leave active, fail-closed). Lets a runner alert thread resolve when
	 * the runner unsticks while its session is STILL running (Codex code R1 HIGH-1
	 * — the common successful-nudge case).
	 */
	captureRunner?: (
		executionId: string,
		projectName: string,
	) => Promise<string | null>;
	now?: () => number;
	logger?: (msg: string) => void;
}

const LEAD_KINDS: ReadonlySet<AlertEventType> = new Set([
	"rate_limit",
	"usage_limit",
	"login_expired",
	"permission_blocked",
	"crash_loop",
	"pane_hash_stuck",
]);

export function correlationKeyFor(p: {
	projectName: string;
	leadId: string;
	eventType: string;
	sessionKey?: string | null;
}): string {
	return `${p.projectName}|${p.leadId}|${p.eventType}|${p.sessionKey ?? ""}`;
}

export class AlertChannelHub {
	private readonly now: () => number;
	private readonly logger: (msg: string) => void;
	/** In-memory last-seen live hash per correlation key for the two-capture rule. */
	private readonly reconcileHashes = new Map<string, string>();

	constructor(private readonly deps: AlertChannelHubDeps) {
		this.now = deps.now ?? (() => Date.now());
		this.logger = deps.logger ?? ((m) => console.log(`[AlertChannelHub] ${m}`));
	}

	/** The watchdog notifier points here in unified+threading mode. */
	async handle(payload: AlertPayload): Promise<AlertResult> {
		const result = await this.deps.notifier.alert(payload);
		// Degrade to root-only on duplicate/queued (Codex R1 MEDIUM-5).
		if (result.skipped === "duplicate" || result.queued) return result;
		if (!result.sent || !result.channelId || !result.messageId) return result;

		const ck = correlationKeyFor(payload);
		try {
			await this.openOrReplaceThread(
				ck,
				payload,
				result.channelId,
				result.messageId,
			);
		} catch (err) {
			// Threading is an enhancement — never let it break the alert path.
			this.logger(
				`thread handling failed for ${ck}: ${(err as Error).message}`,
			);
		}
		// FLY-818 M3 note: the genuinely-stuck-runner founder page is NOT here —
		// it posts an @founder message into the STUCK RUNNER'S OWN [FLY-XX] issue
		// thread from `createStuckUnhandledAlerter` (stuck-escalation.ts), which has
		// the owning Lead (bot token + chat channel). This Hub only owns the alert
		// thread + auto-repair (Annie's design; the alert-channel page was the
		// rejected FLY-523 path).
		return result;
	}

	private async openOrReplaceThread(
		ck: string,
		payload: AlertPayload,
		channelId: string,
		messageId: string,
	): Promise<void> {
		const active = this.deps.store.getActiveAlertThread(ck);
		if (active) {
			if (active.event_id === payload.eventId) {
				// Same episode already has a thread + ack — nothing to do. (The M3
				// founder-page lives in the stuck alerter — an issue-thread post — not
				// the Hub, so the caller no longer needs this thread id.)
				return;
			}
			// Stale row (a distinct, later episode never got resolved): resolve the
			// old thread first, then open the new one (active-mapping replace).
			await this.safePostToThread(
				active.thread_id,
				"↪️ 取代为新 incident（同类新发生）。",
			);
			await this.safeArchive(active.thread_id);
			this.deps.store.resolveAlertThread(ck);
		}

		const name = this.threadName(payload);
		const threadId = await this.deps.discord.createThreadFromMessage(
			channelId,
			messageId,
			name,
		);
		if (!threadId) {
			this.logger(`thread create failed for ${ck} — root-only`);
			return;
		}
		this.deps.store.openAlertThread({
			correlationKey: ck,
			eventId: payload.eventId,
			episodeSignature:
				payload.metadata?.runnerStuck?.episodeFingerprint ?? null,
			threadId,
			rootMessageId: messageId,
			channelId,
			leadId: payload.leadId,
			projectName: payload.projectName,
			eventType: payload.eventType,
			sessionKey: payload.sessionKey ?? null,
			repairStatus: this.deps.autoRepairBot ? "pending" : null,
		});
		// FLY-368 v1.58.0: ack is HONEST per kind (no premature "waiting for human"):
		//  - Cass will try this kind → "正在尝试自动修复…"
		//  - Cass can't (bot present, non-repairable kind) → bare "收到"; the
		//    needs_human result line right below carries the real @Annie ping.
		//  - auto-repair disabled (no bot) → say so + that it needs Annie.
		const bot = this.deps.autoRepairBot;
		const ackTail = !bot
			? "自动修复未启用，需要 Annie。"
			: bot.canAttempt(payload.eventType)
				? "正在尝试自动修复…"
				: "";
		await this.safePostToThread(
			threadId,
			`🔧 Cass 收到（${payload.title}）。${ackTail}`.trimEnd(),
		);

		if (bot) {
			const repair = await bot.attempt(payload, ck);
			if (repair.outcome === "needs_human") {
				// Cass genuinely can't fix this → the ONE place we REALLY @Annie.
				const fid = this.founderId();
				const mention = fid ? `<@${fid}>` : "Annie";
				await this.safePostToThread(
					threadId,
					`🙋 ${mention} 这个 Cass 修不了，需要你：${repair.detail}`,
					fid ? { mentionUserId: fid } : undefined,
				);
			} else {
				// "attempted": a safe action was sent — posted verbatim, NEVER pings.
				await this.safePostToThread(threadId, repair.detail);
			}
			// "attempted" (a safe action was sent, recovery not yet confirmed) vs
			// "needs_human". The thread flips to resolved (✅ 已恢复) only when the
			// reconcile/onRecovery path confirms recovery — never on send alone.
			this.deps.store.setAlertRepairStatus(
				ck,
				repair.outcome === "attempted" ? "attempted" : "needs_human",
			);
		}
	}

	/**
	 * FLY-368 v1.58.0: the founder Discord id used for the needs_human @-ping,
	 * resolved at CALL time (env may change). Accepts ONLY a Discord snowflake;
	 * a present-but-malformed env returns undefined so the Hub degrades to plain
	 * text rather than letting Discord reject the whole allowed_mentions body and
	 * drop the escalation line (Codex design LOW-2).
	 */
	private founderId(): string | undefined {
		const id = process.env.FLYWHEEL_FOUNDER_DISCORD_USER_ID?.trim();
		return id && /^\d{17,20}$/.test(id) ? id : undefined;
	}

	/** Real-time recovery hook fed by LeadWatchdog.onRecovery (an optimization). */
	async onLeadRecovery(
		projectName: string,
		leadId: string,
		recoveredKind: AlertEventType,
	): Promise<void> {
		await this.resolve(
			correlationKeyFor({ projectName, leadId, eventType: recoveredKind }),
		);
	}

	/** Post "recovered" + archive + mark resolved for an active incident. */
	async resolve(correlationKey: string): Promise<void> {
		const active = this.deps.store.getActiveAlertThread(correlationKey);
		if (!active) return;
		await this.safePostToThread(active.thread_id, this.formatResolved(active));
		await this.safeArchive(active.thread_id);
		this.deps.store.resolveAlertThread(correlationKey);
		this.reconcileHashes.delete(correlationKey);
	}

	/**
	 * FLY-368 v1.58.0: the recovery line Annie asked for — "X 几点报警 → 几点修好".
	 * `opened_at` (the alert/detection time) is the "broke" anchor; now is "fixed".
	 * Cass is credited ONLY when she actually acted (repair_status === "attempted");
	 * a self-heal / no-bot / needs_human recovery says "自行恢复" (no false credit).
	 */
	private formatResolved(row: AlertThreadRow): string {
		const what = `${row.lead_id} ${row.event_type}`;
		const broke = this.localHHMM(row.opened_at);
		const fixed = this.hhmm();
		return row.repair_status === "attempted"
			? `✅ ${what} 已恢复 — ${broke} 报警 → ${fixed} 修好（Cass 自动修复）。`
			: `✅ ${what} 已恢复 — ${broke} 报警 → ${fixed} 自行恢复。`;
	}

	/**
	 * Format a SQLite `datetime('now')` value (UTC, no zone suffix) as local HH:MM.
	 * Reuses the repo's established UTC-parse pattern (HeartbeatService etc.).
	 */
	private localHHMM(sqliteUtc: string): string {
		const d = new Date(`${sqliteUtc.replace(" ", "T")}Z`);
		if (Number.isNaN(d.getTime())) return "??:??";
		return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	}

	/**
	 * Restart-safe reconcile (run from LeadWatchdog.onPollComplete). For each
	 * active alert thread, decide whether the underlying condition has cleared and
	 * resolve if so. This — not the in-memory onRecovery hook — is the source of
	 * truth after a Bridge restart (Codex R1 HIGH-1).
	 */
	async reconcile(): Promise<void> {
		const active = this.deps.store.listActiveAlertThreads();
		for (const row of active) {
			try {
				if (row.session_key && row.event_type === "runner_stuck_unhandled") {
					if (await this.shouldResolveRunner(row.session_key, row)) {
						await this.resolve(row.correlation_key);
					}
					continue;
				}
				if (!LEAD_KINDS.has(row.event_type as AlertEventType)) continue;
				if (!this.deps.capturePane) continue;
				const pane = await this.deps.capturePane(row.project_name, row.lead_id);
				if (pane == null) continue; // no window / cannot tell → leave active
				if (
					await this.shouldResolveLead(
						row.correlation_key,
						row.event_type,
						pane,
					)
				) {
					await this.resolve(row.correlation_key);
				}
			} catch (err) {
				this.logger(
					`reconcile failed for ${row.correlation_key}: ${(err as Error).message}`,
				);
			}
		}
	}

	/**
	 * Runner alert recovery (Codex code R1 HIGH-1). Resolve when:
	 *  - the session is no longer running (completed/failed/...), OR
	 *  - the session is STILL running but the live terminal fingerprint has
	 *    changed from the stuck episode signature (the common successful-nudge
	 *    case where the runner moved on while status stays "running").
	 * Fail-closed: an unknown session, missing capture, or a capture error leaves
	 * the thread active (never resolve on uncertainty).
	 */
	private async shouldResolveRunner(
		executionId: string,
		row: { project_name: string; episode_signature: string | null },
	): Promise<boolean> {
		const session = this.deps.store.getSession(executionId);
		if (session && session.status !== "running") return true;
		// Still running (or unknown session): use the fingerprint probe.
		if (!this.deps.captureRunner || !row.episode_signature) return false;
		const out = await this.deps.captureRunner(executionId, row.project_name);
		if (out == null) return false; // cannot tell → leave active
		return fingerprintOutput(out) !== row.episode_signature;
	}

	private async shouldResolveLead(
		correlationKey: string,
		eventType: string,
		pane: string,
	): Promise<boolean> {
		if (eventType !== "pane_hash_stuck") {
			// A blocked kind (rate/usage/login/permission): recovered iff the kind
			// is no longer present in the live pane.
			return classifyLeadAlertPane(pane) !== eventType;
		}
		// pane_hash_stuck: conservative. Resolve when the pane looks idle-healthy,
		// OR when the live hash has CHANGED across two reconcile passes (a still-
		// identical frozen pane is still frozen).
		if (isIdleHealthyPane(pane)) return true;
		const hash = leadPaneLiveHash(pane);
		const prev = this.reconcileHashes.get(correlationKey);
		if (prev !== undefined && prev !== hash) return true;
		this.reconcileHashes.set(correlationKey, hash);
		return false;
	}

	private threadName(payload: AlertPayload): string {
		return `[${payload.eventType}] ${payload.leadId} ${this.hhmm()}`.slice(
			0,
			100,
		);
	}

	private hhmm(): string {
		const d = new Date(this.now());
		const hh = String(d.getHours()).padStart(2, "0");
		const mm = String(d.getMinutes()).padStart(2, "0");
		return `${hh}:${mm}`;
	}

	private async safePostToThread(
		threadId: string,
		content: string,
		opts?: { mentionUserId?: string },
	): Promise<void> {
		try {
			await this.deps.discord.postToThread(threadId, content, opts);
		} catch (err) {
			this.logger(
				`postToThread failed (${threadId}): ${(err as Error).message}`,
			);
		}
	}

	private async safeArchive(threadId: string): Promise<void> {
		try {
			await this.deps.discord.archiveThread(threadId);
		} catch (err) {
			this.logger(
				`archiveThread failed (${threadId}): ${(err as Error).message}`,
			);
		}
	}
}
