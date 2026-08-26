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
 *     the Lead alert producers) AND a restart-safe reconcile pass (`reconcile`, run from the
 *     GatePoller lead-reconcile rider) post "recovered" + archive the thread.
 *
 * Tickets enter as NEW. The Hub never automatically @mentions the founder or
 * writes ESCALATED; only an explicit cap-owner handoff may carry a mention.
 *
 * Degradation (Codex R1 MEDIUM-5): a `queued` (Discord transient failure) or a
 * `duplicate` with no active thread degrades to ROOT-ONLY — no thread/ack/bot.
 */

import {
	type AlertEventType,
	type AlertPayload,
	type AlertResult,
	isInformationalKind,
} from "../LeadAlertNotifier.js";
import type { AlertThreadRow, StateStore } from "../StateStore.js";
import type { AutoRepairBot } from "./AutoRepairBot.js";
import { markAutomatedDiscordText } from "./automated-message.js";
import {
	formatAccountCapOwnerAssignment,
	resolveAccountCapOwnerId,
} from "./infra-notify.js";
import { classifyLeadAlertPane } from "./pane-blocked-classifier.js";
import { fingerprintOutput } from "./pane-fingerprint.js";
import { resolveAutoArchiveMinutes } from "./roundtable/channel-archive-default.js";
import {
	decideTicketEscalation,
	policyForKind,
	type TicketEscalationPolicy,
} from "./ticket-escalation.js";

const DISCORD_API = "https://discord.com/api/v10";

/** A bot whose token can't post here (no channel perms) → try the next bot. */
function isPermFallthrough(status: number): boolean {
	return status === 401 || status === 403 || status === 404;
}

function assertNever(value: never): never {
	throw new Error(`unhandled repair outcome: ${String(value)}`);
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
		async createThreadFromMessage(channelId, messageId, name, archiveMinutes) {
			const tokens = getTokens();
			for (const token of tokens) {
				try {
					const res = await fetchFn(
						`${DISCORD_API}/channels/${channelId}/messages/${messageId}/threads`,
						{
							method: "POST",
							headers: authHeaders(token),
							body: JSON.stringify({
								name,
								auto_archive_duration: archiveMinutes ?? 1440,
							}),
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
			// explicit owner handoffs opt in to one REAL @-ping via `mentionUserId`.
			const allowed_mentions = opts?.mentionUserId
				? { users: [opts.mentionUserId] }
				: { parse: [] as string[] };
			for (const token of tokens) {
				const res = await fetchFn(
					`${DISCORD_API}/channels/${threadId}/messages`,
					{
						method: "POST",
						headers: authHeaders(token),
						body: JSON.stringify({
							content: markAutomatedDiscordText(content),
							allowed_mentions,
						}),
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
		// FLY-927 (Task 2.3): root-message read + edit for the 🎫 status
		// edit-in-place. Both best-effort (null/false on any failure) — the thread
		// narrative is the truth stream; the root status is a courtesy render.
		async getMessage(channelId, messageId) {
			for (const token of getTokens()) {
				try {
					const res = await fetchFn(
						`${DISCORD_API}/channels/${channelId}/messages/${messageId}`,
						{ headers: authHeaders(token) },
					);
					if (res.ok) {
						const body = (await res.json()) as { content?: string };
						return body.content ?? null;
					}
					if (isPermFallthrough(res.status)) continue;
					return null;
				} catch {
					return null;
				}
			}
			return null;
		},
		async editMessage(channelId, messageId, content) {
			for (const token of getTokens()) {
				try {
					const res = await fetchFn(
						`${DISCORD_API}/channels/${channelId}/messages/${messageId}`,
						{
							method: "PATCH",
							headers: authHeaders(token),
							body: JSON.stringify({
								content: markAutomatedDiscordText(content),
								allowed_mentions: { parse: [] as string[] },
							}),
						},
					);
					if (res.ok) return true;
					if (isPermFallthrough(res.status)) continue;
					return false;
				} catch {
					return false;
				}
			}
			return false;
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
		archiveMinutes?: number,
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
	/**
	 * FLY-927 (Task 2.3): read a message's content / edit it in place — the 🎫
	 * status edit path. OPTIONAL (older DiscordOps impls / test doubles without
	 * them simply skip the root status render; the thread narrative remains the
	 * truth stream).
	 */
	getMessage?(channelId: string, messageId: string): Promise<string | null>;
	editMessage?(
		channelId: string,
		messageId: string,
		content: string,
	): Promise<boolean>;
}

export interface AlertChannelHubDeps {
	store: StateStore;
	notifier: { alert: (p: AlertPayload) => Promise<AlertResult> };
	discord: DiscordOps;
	/** Parent-channel archive default reader. Missing/null/failure preserves 1440. */
	archiveDefaultProvider?: () => Promise<number | null>;
	/** Optional — when absent, no auto-repair runs (FLYWHEEL_AUTO_REPAIR off). */
	autoRepairBot?: AutoRepairBot;
	/**
	 * Reconcile-pass capture of a Lead pane (null = no window / cannot tell).
	 * Required for the restart-safe Lead recovery reconcile.
	 */
	capturePane?: (projectName: string, leadId: string) => Promise<string | null>;
	/**
	 * Reconcile-pass capture of a RUNNER terminal by executionId. Retained for
	 * login-expiry recovery, where a changed terminal fingerprint is an external
	 * fact rather than an inactivity inference.
	 */
	captureRunner?: (
		executionId: string,
		projectName: string,
	) => Promise<string | null>;
	/** Retry policy override (tests); default = per-kind via `policyForKind`. */
	ticketPolicy?: TicketEscalationPolicy;
	/**
	 * FLY-1082: fleet-kind recovery probe for the reconcile pass — the fleet
	 * analog of the retained pane/runner probes. Returns true = the underlying fleet
	 * condition cleared (resolve quietly), false = still broken, null/absent =
	 * cannot tell (leave active; bounded repair reconciliation may still run). Wired in
	 * plugin.ts to the fleet-sensors module.
	 */
	fleetRecovery?: (row: AlertThreadRow) => Promise<boolean | null>;
	now?: () => number;
	logger?: (msg: string) => void;
}

/** FLY-1082: kinds whose reconcile recovery runs through `fleetRecovery`. */
const FLEET_RECOVERY_KINDS: ReadonlySet<AlertEventType> = new Set([
	"swap_pressure_high",
	"tmux_server_lost",
	"tmux_hold",
	"tmux_split_brain",
	"bridge_abnormal_exit",
	"infra_bot_down",
]);

const LEAD_KINDS: ReadonlySet<AlertEventType> = new Set([
	"rate_limit",
	"usage_limit",
	"login_expired",
	"permission_blocked",
	"crash_loop",
]);

/**
 * Quota-monitor tickets are machine-daemon state, not a Lead-pane or fleet
 * sensor condition. They therefore stay open for explicit human disposition;
 * successful/transient/confirmation notices are informational and never enter
 * this lifecycle. Keeping this set explicit prevents a future quota kind from
 * silently inheriting an invalid Lead-pane recovery probe.
 */
export const QUOTA_MONITOR_MANUAL_TICKET_KINDS: ReadonlySet<AlertEventType> =
	new Set([
		"account_identity_mismatch",
		"account_switch_degraded",
		"machine_account_conflict",
		"model_cap_persistent_unknown",
		"model_bench_malformed",
		"quota_choice",
		"quota_no_target",
		"quota_read_blind",
		"account_switch_failed",
		"quota_revive_stuck",
		"quota_monitor_down",
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

	constructor(private readonly deps: AlertChannelHubDeps) {
		this.now = deps.now ?? (() => Date.now());
		this.logger = deps.logger ?? ((m) => console.log(`[AlertChannelHub] ${m}`));
	}

	/** The alert notifier points here in unified+threading mode. */
	async handle(payload: AlertPayload): Promise<AlertResult> {
		const result = await this.deps.notifier.alert(payload);
		if (isInformationalKind(payload.eventType)) return result;
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
		let archiveMinutes = 1440;
		if (this.deps.archiveDefaultProvider) {
			try {
				archiveMinutes =
					resolveAutoArchiveMinutes(
						await this.deps.archiveDefaultProvider(),
						1440,
					) ?? 1440;
			} catch (err) {
				this.logger(
					`archive default lookup failed for ${channelId}; using 1440: ${(err as Error).message}`,
				);
			}
		}
		const threadId = await this.deps.discord.createThreadFromMessage(
			channelId,
			messageId,
			name,
			archiveMinutes,
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
			repairStatus: null,
			// A ticket always enters the channel ledger as NEW. Serialized payload
			// status is intentionally not part of the input contract.
			ticketStatus: payload.ticket ? "NEW" : null,
			ownerRef: payload.ticket?.ownerRef ?? null,
			firstSeenAt: payload.ticket
				? new Date(payload.ticket.firstSeenMs)
						.toISOString()
						.replace("T", " ")
						.slice(0, 19)
				: null,
		});
		// FLY-368 v1.58.0: ack is HONEST per kind (no premature "waiting for human"):
		//  - Cass will try this kind → "正在尝试自动修复…"
		//  - Cass can't (bot present, non-repairable kind) → bare "收到"; a
		//    needs_human result leaves the visible ticket NEW for duty triage.
		//  - auto-repair disabled (no bot) → say so and leave it for duty triage.
		const bot = this.deps.autoRepairBot;
		const ackTail = !bot
			? "自动修复未启用，工单留在频道等值守处理。"
			: bot.canAttempt(payload)
				? "正在尝试自动修复…"
				: "";
		await this.safePostToThread(
			threadId,
			`🔧 Cass 收到（${payload.title}）。${ackTail}`.trimEnd(),
		);

		if (bot) {
			const repair = await bot.attempt(payload, ck);
			switch (repair.outcome) {
				case "attempted": {
					// An account_switch enqueue is the Codex Infra Bot's assignment;
					// mention only that bot. Every other attempted action is mention-free.
					const infraBotId =
						repair.action === "account_switch" ? this.infraBotId() : undefined;
					await this.safePostToThread(
						threadId,
						repair.detail,
						infraBotId ? { mentionUserId: infraBotId } : undefined,
					);
					this.deps.store.setAlertRepairStatus(ck, "attempted");
					if (payload.ticket) {
						this.deps.store.setTicketStatus(ck, "REPAIRING");
						this.deps.store.bumpTicketAttempt(ck);
						await this.updateRootTicketStatus(
							channelId,
							messageId,
							"REPAIRING",
						);
					}
					break;
				}
				case "needs_human": {
					// Account-cap ownership can route to its owner bot. Other rejected
					// repairs stay NEW and silent for the channel duty reader.
					const capOwnerId =
						payload.eventType === "usage_limit" &&
						payload.metadata?.accountLimit?.provider === "claude"
							? resolveAccountCapOwnerId()
							: undefined;
					if (capOwnerId) {
						await this.safePostToThread(
							threadId,
							formatAccountCapOwnerAssignment(capOwnerId, repair.detail),
							{ mentionUserId: capOwnerId },
						);
					}
					break;
				}
				case "no_action":
					await this.safePostToThread(threadId, repair.detail);
					this.deps.store.setAlertRepairStatus(ck, "no_action");
					if (payload.ticket) {
						this.deps.store.setTicketStatus(ck, "MONITORING");
						await this.updateRootTicketStatus(
							channelId,
							messageId,
							"MONITORING",
						);
					}
					break;
				default:
					assertNever(repair.outcome);
			}
		}
	}

	/**
	 * FLY-927 (Task 2.3): re-render the root message's 🎫 status segment in
	 * place. Best-effort at every step — missing ops methods / message gone /
	 * no 🎫 line all degrade silently (the thread narrative is the truth stream).
	 */
	private async updateRootTicketStatus(
		channelId: string,
		messageId: string | null | undefined,
		status: string,
	): Promise<void> {
		const ops = this.deps.discord;
		if (!messageId || !ops.getMessage || !ops.editMessage) return;
		try {
			const content = await ops.getMessage(channelId, messageId);
			if (!content) return;
			const updated = content.replace(/^(🎫 .*· 状态 )\S+$/mu, `$1${status}`);
			if (updated === content) return; // no 🎫 line (legacy root) — skip
			await ops.editMessage(channelId, messageId, updated);
		} catch (err) {
			this.logger(
				`root ticket-status edit failed (${messageId}): ${(err as Error).message}`,
			);
		}
	}

	/**
	 * FLY-871 R2/W6: the Codex Infra Bot's Discord id, used to @-mention it on the
	 * `account_switch` ASSIGNMENT post so the FLY-267 mention-gate wakes it to claim
	 * the pending switch. Resolved at CALL time (env may change); accepts ONLY a
	 * snowflake so a present-but-malformed env degrades to no-mention rather than a
	 * rejected allowed_mentions body. Unset ⇒ undefined = byte-compat.
	 */
	private infraBotId(): string | undefined {
		const id = process.env.FLYWHEEL_INFRA_BOT_USER_ID?.trim();
		return id && /^\d{17,20}$/.test(id) ? id : undefined;
	}

	/**
	 * FLY-927 (Codex R1 HIGH): attach the per-error thread + ticket lifecycle to
	 * an alert the DRAIN loop delivered (a rate-limited / transiently-failed root
	 * that bypassed `handle()`'s live path). Same threading semantics as
	 * `handle()` — a threading failure degrades to root-only, never throws.
	 */
	async attachThreadForDelivered(
		payload: AlertPayload,
		channelId: string,
		messageId: string,
	): Promise<void> {
		const ck = correlationKeyFor(payload);
		try {
			await this.openOrReplaceThread(ck, payload, channelId, messageId);
		} catch (err) {
			this.logger(
				`drained-thread handling failed for ${ck}: ${(err as Error).message}`,
			);
		}
	}

	/** Post "recovered" + archive + mark resolved for an active incident. */
	async resolve(correlationKey: string): Promise<void> {
		const active = this.deps.store.getActiveAlertThread(correlationKey);
		if (!active) return;
		// FLY-927 (Task 2.3): a ticket row flips to RESOLVED without a mention
		// with the root 🎫 line re-rendered; legacy rows (NULL status) untouched.
		if (active.ticket_status) {
			this.deps.store.setTicketStatus(correlationKey, "RESOLVED");
			await this.updateRootTicketStatus(
				active.channel_id,
				active.root_message_id,
				"RESOLVED",
			);
		}
		await this.safePostToThread(active.thread_id, this.formatResolved(active));
		await this.safeArchive(active.thread_id);
		this.deps.store.resolveAlertThread(correlationKey);
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
	 * Restart-safe reconcile (run from the GatePoller lead-reconcile rider). For each
	 * active alert thread, decide whether the underlying condition has cleared and
	 * resolve if so. This — not the in-memory onRecovery hook — is the source of
	 * truth after a Bridge restart (Codex R1 HIGH-1).
	 */
	async reconcile(): Promise<void> {
		const active = this.deps.store.listActiveAlertThreads();
		for (const row of active) {
			try {
				if (
					QUOTA_MONITOR_MANUAL_TICKET_KINDS.has(
						row.event_type as AlertEventType,
					)
				) {
					await this.reconcileTicket(row);
					continue;
				}
				if (row.session_key && row.event_type === "runner_login_expired") {
					// FLY-871 R2/C8: a runner_login_expired resolves by the RUNNER's
					// pane/status (rescue closes the old session, or its fingerprint
					// changes), NOT a Lead pane.
					if (await this.shouldResolveRunner(row.session_key, row)) {
						await this.resolve(row.correlation_key);
						continue;
					}
					await this.reconcileTicket(row);
					continue;
				}
				// FLY-1082: fleet kinds recover through the fleet probe (watermark
				// cleared / tmux server back / boot reconcile done / bot alive).
				if (FLEET_RECOVERY_KINDS.has(row.event_type as AlertEventType)) {
					if (this.deps.fleetRecovery) {
						const recovered = await this.deps.fleetRecovery(row);
						if (recovered === true) {
							await this.resolve(row.correlation_key);
							continue;
						}
					}
					await this.reconcileTicket(row);
					continue;
				}
				if (LEAD_KINDS.has(row.event_type as AlertEventType)) {
					if (this.deps.capturePane) {
						const pane = await this.deps.capturePane(
							row.project_name,
							row.lead_id,
						);
						if (pane != null && this.shouldResolveLead(row.event_type, pane)) {
							await this.resolve(row.correlation_key);
							continue;
						}
					}
				}
				// Still-active ticket rows may run one bounded ARC retry on the same
				// piggybacked tick. They never auto-escalate.
				await this.reconcileTicket(row);
			} catch (err) {
				this.logger(
					`reconcile failed for ${row.correlation_key}: ${(err as Error).message}`,
				);
			}
		}
	}

	/**
	 * Per-row bounded retry pass. Exhausted and timed-out tickets stay visible
	 * in their current state for explicit duty handling.
	 */
	private async reconcileTicket(row: AlertThreadRow): Promise<void> {
		if (!row.ticket_status) return; // legacy row — the state machine never drives it
		const decision = decideTicketEscalation(
			row,
			this.now(),
			// FLY-1082 (Task 2.2): per-kind bounded-retry policy; a test-injected
			// policy still wins.
			this.deps.ticketPolicy ?? policyForKind(row.event_type, process.env),
		);
		if (decision === "none") return;
		if (decision === "retry") {
			const bot = this.deps.autoRepairBot;
			if (!bot) return;
			// Reconstruct the minimal payload the bot's gates need — the structured
			// runnerStuck fingerprint rides the row (episode_signature/session_key).
			const payload: AlertPayload = {
				leadId: row.lead_id,
				projectName: row.project_name,
				eventId: row.event_id,
				eventType: row.event_type as AlertEventType,
				title: "",
				body: "",
				severity: "warning",
				sessionKey: row.session_key ?? undefined,
				...(row.session_key && row.episode_signature
					? {
							metadata: {
								runnerStuck: {
									executionId: row.session_key,
									episodeFingerprint: row.episode_signature,
								},
							},
						}
					: {}),
			};
			const repair = await bot.attempt(payload, row.correlation_key);
			switch (repair.outcome) {
				case "attempted":
					this.deps.store.bumpTicketAttempt(row.correlation_key);
					this.deps.store.setAlertRepairStatus(
						row.correlation_key,
						"attempted",
					);
					await this.safePostToThread(
						row.thread_id,
						`🔁 第 ${row.attempt_count + 1} 次自动修复:${repair.detail}`,
					);
					break;
				case "needs_human":
					this.deps.store.bumpTicketAttempt(row.correlation_key);
					this.deps.store.setAlertRepairStatus(row.correlation_key, "n/a");
					await this.safePostToThread(
						row.thread_id,
						`🔁 自动修复安全闸拒绝:${repair.detail}`,
					);
					break;
				case "no_action":
					await this.safePostToThread(row.thread_id, repair.detail);
					this.deps.store.setAlertRepairStatus(
						row.correlation_key,
						"no_action",
					);
					this.deps.store.setTicketStatus(row.correlation_key, "MONITORING");
					await this.updateRootTicketStatus(
						row.channel_id,
						row.root_message_id,
						"MONITORING",
					);
					break;
				default:
					assertNever(repair.outcome);
			}
			return;
		}
	}

	/**
	 * Runner login-expiry recovery. Resolve when the session closes or its live
	 * terminal fingerprint changes. Missing capture stays fail-closed.
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

	private shouldResolveLead(eventType: string, pane: string): boolean {
		return classifyLeadAlertPane(pane) !== eventType;
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
