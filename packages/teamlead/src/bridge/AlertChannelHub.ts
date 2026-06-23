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
import type { StateStore } from "../StateStore.js";
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
		async postToThread(threadId, content) {
			const tokens = getTokens();
			let lastStatus: number | undefined;
			for (const token of tokens) {
				const res = await fetchFn(
					`${DISCORD_API}/channels/${threadId}/messages`,
					{
						method: "POST",
						headers: authHeaders(token),
						body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
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
	/** Post a message into a thread (best-effort). */
	postToThread(threadId: string, content: string): Promise<void>;
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
				// Same episode already has a thread + ack — nothing to do.
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
		await this.safePostToThread(
			threadId,
			`🔧 收到（${payload.title}）。${this.deps.autoRepairBot ? "正在尝试安全自动修复…" : "等待人工处理。"}`,
		);

		if (this.deps.autoRepairBot) {
			const repair = await this.deps.autoRepairBot.attempt(payload, ck);
			await this.safePostToThread(threadId, repair.detail);
			// "attempted" (a safe action was sent, recovery not yet confirmed) vs
			// "needs_human". The thread flips to resolved (✅ 已恢复) only when the
			// reconcile/onRecovery path confirms recovery — never on send alone.
			this.deps.store.setAlertRepairStatus(
				ck,
				repair.outcome === "attempted" ? "attempted" : "needs_human",
			);
		}
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
		await this.safePostToThread(active.thread_id, `✅ 已恢复 ${this.hhmm()}。`);
		await this.safeArchive(active.thread_id);
		this.deps.store.resolveAlertThread(correlationKey);
		this.reconcileHashes.delete(correlationKey);
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
	): Promise<void> {
		try {
			await this.deps.discord.postToThread(threadId, content);
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
