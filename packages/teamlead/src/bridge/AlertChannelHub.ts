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
	leadPaneHasErrorSignature,
	leadPaneLiveHash,
} from "../LeadWatchdog.js";
import type { AlertThreadRow, StateStore } from "../StateStore.js";
import { type AutoRepairBot, HUMAN_ONLY_REASON } from "./AutoRepairBot.js";
import { markAutomatedDiscordText } from "./automated-message.js";
import {
	formatAccountCapOwnerAssignment,
	resolveAccountCapOwnerId,
} from "./infra-notify.js";
import {
	escalatesAtEnqueue,
	FLEET_ESCALATION_COPY,
	KIND_CONTRACTS,
} from "./kind-contract.js";
import { fingerprintOutput } from "./stuck-candidate.js";
import {
	decideTicketEscalation,
	policyForKind,
	type TicketEscalationPolicy,
	ticketOwnerConfigured,
} from "./ticket-escalation.js";
import { ownerRegistryFromEnv } from "./ticket-owner-map.js";

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
	/**
	 * FLY-927 (Task 2.4): T2 escalation delivery for an ISSUE-BOUND ticket —
	 * the founder page lands in the issue's own [FLY-XX] thread (FLY-818 reuse +
	 * founder_page_ledger dedup live in the plugin wiring). Returns true when
	 * the page actually posted. Absent / false ⇒ the Hub falls back to the
	 * needs_human @founder line in the alert thread.
	 */
	escalateToIssueThread?: (row: AlertThreadRow) => Promise<boolean>;
	/** T2 policy override (tests); default = per-kind via `policyForKind`. */
	ticketPolicy?: TicketEscalationPolicy;
	/**
	 * FLY-1082: fleet-kind recovery probe for the reconcile pass — the fleet
	 * analog of capturePane/captureRunner. Returns true = the underlying fleet
	 * condition cleared (resolve quietly), false = still broken, null/absent =
	 * cannot tell (leave active; the T2 decision still runs). Wired in
	 * plugin.ts to the fleet-sensors module.
	 */
	fleetRecovery?: (row: AlertThreadRow) => Promise<boolean | null>;
	/**
	 * FLY-1082 (Task 3.2): fired after a ticket lands ESCALATED via the T2
	 * path — the repeated-escalation runbook-gap counter hangs here. Best-
	 * effort (failures logged, never block the escalation).
	 */
	onTicketEscalated?: (row: AlertThreadRow) => Promise<void>;
	now?: () => number;
	logger?: (msg: string) => void;
}

/** FLY-1082: kinds whose reconcile recovery runs through `fleetRecovery`. */
const FLEET_RECOVERY_KINDS: ReadonlySet<AlertEventType> = new Set([
	"swap_pressure_high",
	"tmux_server_lost",
	"bridge_abnormal_exit",
	"infra_bot_down",
]);

const LEAD_KINDS: ReadonlySet<AlertEventType> = new Set([
	"rate_limit",
	"usage_limit",
	"login_expired",
	"permission_blocked",
	"crash_loop",
	"pane_hash_stuck",
	// FLY-1048 (A4): pane-driven like the rest — reconcile resolves it when
	// the error signature leaves the live region (see shouldResolveLead).
	"pane_error_stalled",
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
			// FLY-927 (Task 2.3): ticket lifecycle seed from the enriched payload
			// (absent = legacy row, NULL status — the state machine never drives it).
			ticketStatus: payload.ticket?.status ?? null,
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
		//  - Cass can't (bot present, non-repairable kind) → bare "收到"; the
		//    needs_human result line right below carries the real @Annie ping.
		//  - auto-repair disabled (no bot) → say so + that it needs Annie.
		const bot = this.deps.autoRepairBot;
		const ackTail = !bot
			? "自动修复未启用，需要 Annie。"
			: bot.canAttempt(payload)
				? "正在尝试自动修复…"
				: "";
		await this.safePostToThread(
			threadId,
			`🔧 Cass 收到（${payload.title}）。${ackTail}`.trimEnd(),
		);

		// FLY-1082 (Task 1.5): (b)-type kinds (kind-contract none_escalate)
		// NEVER enter the ARC loop — the founder-facing line is the BY-DESIGN
		// copy, not a "repair failed" framing. Generalizes the legacy
		// runner_lead_pending_unhandled special case (its bot-present line stays
		// byte-identical: same 🙋 framing, same HUMAN_ONLY_REASON string).
		// Codex R1 HIGH-4: deliberately OUTSIDE the auto-repair gate — a
		// by-design escalation (founder line + ESCALATED status + runbook-gap
		// count) must fire even with FLYWHEEL_AUTO_REPAIR off; the contract, not
		// the bot, owns this path.
		if (escalatesAtEnqueue(payload.eventType)) {
			await this.postByDesignEscalation(payload, threadId);
			if (bot) this.deps.store.setAlertRepairStatus(ck, "needs_human");
			if (payload.ticket) {
				this.deps.store.setTicketStatus(ck, "ESCALATED");
				await this.updateRootTicketStatus(channelId, messageId, "ESCALATED");
				// FLY-1082 (Task 3.2): a by-design escalation counts toward the
				// runbook-gap window too (repeated zombie backlogs = FLY-1066 is
				// overdue — exactly what the auto-filed issue should say).
				const row = this.deps.store.getActiveAlertThread(ck);
				if (row) {
					try {
						await this.deps.onTicketEscalated?.(row);
					} catch (err) {
						this.logger(
							`onTicketEscalated hook failed for ${ck}: ${(err as Error).message}`,
						);
					}
				}
			}
			return;
		}

		if (bot) {
			const repair = await bot.attempt(payload, ck);
			if (repair.outcome === "needs_human") {
				// FLY-929 A5: a CLAUDE account-cap needs_human (usage_limit with
				// claude accountLimit metadata — the not-attemptable pool/bin shape)
				// is ASSIGNED to the owner bot instead of immediately paging the
				// founder, but ONLY when self-heal + P-identity + the infra bot id
				// are all present (`resolveAccountCapOwnerId`). The bot's playbook
				// (FLY-871: retries exhausted → @Annie and stop) carries the final
				// founder escalation until the FLY-927 ticket state machine lands.
				// Any env missing / any other needs_human kind → the founder
				// escalation below, byte-for-byte.
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
				} else {
					// Cass genuinely can't fix this → the ONE place we REALLY @Annie.
					// FLY-1082 (Task 3.1, Codex R4 MED): fleet kinds render the
					// four-element template with the bot's specific reason as the
					// "为什么失败" element; legacy kinds keep the line byte-for-byte.
					const fid = this.founderId();
					const mention = fid ? `<@${fid}>` : "Annie";
					const line =
						this.fleetEscalationLine(
							payload.eventType,
							mention,
							repair.detail,
						) ?? `🙋 ${mention} 这个 Cass 修不了，需要你：${repair.detail}`;
					await this.safePostToThread(
						threadId,
						line,
						fid ? { mentionUserId: fid } : undefined,
					);
				}
			} else {
				// "attempted": a safe action was sent — posted verbatim. FLY-871 R2/W6:
				// an `account_switch` enqueue IS the Codex Infra Bot's ASSIGNMENT —
				// @-mention the bot so the FLY-267 mention-gate wakes it to claim the
				// pending switch (default `parse:[]` would suppress it). Env unset ⇒ no
				// mention = byte-compat (the account-switch watchdog deadline still fires
				// the switch even if the bot is never woken).
				const infraBotId =
					repair.action === "account_switch" ? this.infraBotId() : undefined;
				await this.safePostToThread(
					threadId,
					repair.detail,
					infraBotId ? { mentionUserId: infraBotId } : undefined,
				);
			}
			// "attempted" (a safe action was sent, recovery not yet confirmed) vs
			// "needs_human". The thread flips to resolved (✅ 已恢复) only when the
			// reconcile/onRecovery path confirms recovery — never on send alone.
			this.deps.store.setAlertRepairStatus(
				ck,
				repair.outcome === "attempted" ? "attempted" : "needs_human",
			);
			// FLY-927 (Task 2.3): ticket lifecycle — Cass's immediate ARC counts an
			// attempt toward the T2 budget; needs_human is a direct escalation. The
			// root 🎫 line is re-rendered in place (best-effort).
			if (payload.ticket) {
				if (repair.outcome === "attempted") {
					this.deps.store.setTicketStatus(ck, "REPAIRING");
					this.deps.store.bumpTicketAttempt(ck);
					await this.updateRootTicketStatus(channelId, messageId, "REPAIRING");
				} else {
					this.deps.store.setTicketStatus(ck, "ESCALATED");
					await this.updateRootTicketStatus(channelId, messageId, "ESCALATED");
					// FLY-1082 (Task 3.2, Codex R3 MED): a needs_human escalation IS
					// an ESCALATED landing — it must feed the runbook-gap window like
					// the T2 and by-design paths (repeated "can't auto-fix" is
					// exactly the signal the auto-filed eng issue exists for).
					const row = this.deps.store.getActiveAlertThread(ck);
					if (row) {
						try {
							await this.deps.onTicketEscalated?.(row);
						} catch (err) {
							this.logger(
								`onTicketEscalated hook failed for ${ck}: ${(err as Error).message}`,
							);
						}
					}
				}
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
	 * FLY-1082 (Task 3.1): the four-element founder escalation for a FLEET
	 * kind — kind 人话 label · ARC 试了什么 · 为什么失败 · 你只需拍的一个决定
	 * (plan contract: the failure reason slots in as-is; the Hub assembles the
	 * rest). Returns null for non-fleet kinds (their legacy copy is kept
	 * byte-for-byte by the callers).
	 */
	private fleetEscalationLine(
		kind: AlertEventType,
		mention: string,
		failureReason: string,
	): string | null {
		const fleet = FLEET_ESCALATION_COPY[kind];
		if (!fleet) return null;
		return `🙋 ${mention} 修不掉 — ${fleet.label}。\n· ARC 试了：${
			KIND_CONTRACTS[kind]?.remediationRef ?? "（无自动修复）"
		}\n· 为什么失败：${failureReason}\n· 你只需拍一个决定：${fleet.decision}`;
	}

	/**
	 * FLY-1082 (Task 1.5): the by-design escalation line for a (b)-type kind
	 * (kind-contract none_escalate). The copy states the ARC posture honestly —
	 * "设计上不自动修" — never the generic "试修失败" framing. Legacy
	 * runner_lead_pending_unhandled keeps its exact pre-FLY-1082 line: same 🙋
	 * framing + the SAME HUMAN_ONLY_REASON string (sourced, not duplicated).
	 */
	private async postByDesignEscalation(
		payload: AlertPayload,
		threadId: string,
	): Promise<void> {
		const fid = this.founderId();
		const mention = fid ? `<@${fid}>` : "Annie";
		const line =
			payload.eventType === "zombie_session_backlog"
				? `🙋 ${mention} 跨 Lead 僵尸 session 积压 — 设计上不自动收割（收割机制落地 = ${
						KIND_CONTRACTS.zombie_session_backlog.remediationRef
					}），样本清单见根消息。需要你拍一个决定：是否人工清理。`
				: `🙋 ${mention} 这个 Cass 修不了，需要你：${
						HUMAN_ONLY_REASON[payload.eventType] ??
						"设计上不做自动修复（by design）— 需要人看。"
					}`;
		await this.safePostToThread(
			threadId,
			line,
			fid ? { mentionUserId: fid } : undefined,
		);
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
		// FLY-927 (Task 2.3): a ticket row flips to RESOLVED (quiet — never @Annie)
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
				if (
					row.session_key &&
					(row.event_type === "runner_stuck_unhandled" ||
						row.event_type === "runner_throttle_stalled" ||
						row.event_type === "runner_login_expired")
				) {
					// FLY-871 R2/C8: a runner_login_expired resolves by the RUNNER's
					// pane/status (rescue closes the old session, or its fingerprint
					// changes), NOT a Lead pane — same path as runner_stuck_unhandled.
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
						if (
							pane != null &&
							(await this.shouldResolveLead(
								row.correlation_key,
								row.event_type,
								pane,
							))
						) {
							await this.resolve(row.correlation_key);
							continue;
						}
					}
				}
				// FLY-927 (Task 2.4): still-active ticket rows run the T2 decision on
				// the SAME piggybacked tick (recovery was checked above — a recovered
				// ticket resolved quietly and never reaches here). Legacy rows (NULL
				// ticket_status) are a no-op inside.
				await this.reconcileTicket(row);
			} catch (err) {
				this.logger(
					`reconcile failed for ${row.correlation_key}: ${(err as Error).message}`,
				);
			}
		}
	}

	/**
	 * FLY-927 (Task 2.4): the per-row T2 pass — retry (second ARC attempt, all
	 * safety gates intact) or escalate ("couldn't fix": 2 attempts / 5 min, or
	 * unclaimed > 5 min with a configured owner).
	 */
	private async reconcileTicket(row: AlertThreadRow): Promise<void> {
		if (!row.ticket_status) return; // legacy row — the state machine never drives it
		const decision = decideTicketEscalation(
			row,
			this.now(),
			ticketOwnerConfigured(row.owner_ref, ownerRegistryFromEnv(process.env)),
			// FLY-1082 (Task 2.2): per-kind policy — legacy kinds resolve to the
			// locked T2 defaults byte-for-byte; a test-injected policy still wins.
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
			this.deps.store.bumpTicketAttempt(row.correlation_key);
			const repair = await bot.attempt(payload, row.correlation_key);
			await this.safePostToThread(
				row.thread_id,
				repair.outcome === "attempted"
					? `🔁 第 ${row.attempt_count + 1} 次自动修复:${repair.detail}`
					: `🔁 第 ${row.attempt_count + 1} 次尝试被安全闸拒绝:${repair.detail}`,
			);
			return;
		}
		await this.escalateTicket(row);
	}

	/**
	 * T2 escalation: issue-bound tickets page the founder in the issue's OWN
	 * thread (FLY-818 reuse + ledger dedup, via the injected wiring); unbound
	 * tickets keep the existing needs_human @founder line in the alert thread.
	 * Either way the ticket lands ESCALATED (terminal for the state machine —
	 * the reconcile recovery pass can still resolve the row later).
	 */
	private async escalateTicket(row: AlertThreadRow): Promise<void> {
		let pagedInIssueThread = false;
		if (row.session_key && this.deps.escalateToIssueThread) {
			try {
				pagedInIssueThread = await this.deps.escalateToIssueThread(row);
			} catch (err) {
				this.logger(
					`issue-thread escalation failed for ${row.correlation_key}: ${(err as Error).message}`,
				);
			}
		}
		if (pagedInIssueThread) {
			await this.safePostToThread(
				row.thread_id,
				"⛔ 修不掉(T2)— 已升级 founder(落在该 issue 的 thread)。",
			);
		} else {
			const fid = this.founderId();
			const mention = fid ? `<@${fid}>` : "Annie";
			// FLY-1082 (Task 3.1): fleet kinds render the FOUR-ELEMENT template
			// (kind · ARC 试了什么 · 为什么失败 · 你只需拍的一个决定); legacy kinds
			// keep the pre-FLY-1082 line byte-for-byte (no copy regression).
			const line =
				this.fleetEscalationLine(
					row.event_type as AlertEventType,
					mention,
					row.attempt_count >= 2
						? `重试预算用尽仍未恢复（尝试 ${row.attempt_count} 次）`
						: "超时窗内没有恢复信号",
				) ??
				`🙋 ${mention} 修不掉(T2:重试 ${row.attempt_count} 次 / 超时)— 需要你处理。`;
			await this.safePostToThread(
				row.thread_id,
				line,
				fid ? { mentionUserId: fid } : undefined,
			);
		}
		this.deps.store.setTicketStatus(row.correlation_key, "ESCALATED");
		await this.updateRootTicketStatus(
			row.channel_id,
			row.root_message_id,
			"ESCALATED",
		);
		// FLY-1082 (Task 3.2): repeated escalations of one kind = a runbook gap —
		// the hook (wired in plugin.ts) counts the 7-day window and auto-files
		// the eng issue. Best-effort: never blocks the escalation itself.
		try {
			await this.deps.onTicketEscalated?.(row);
		} catch (err) {
			this.logger(
				`onTicketEscalated hook failed for ${row.correlation_key}: ${(err as Error).message}`,
			);
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
		// FLY-1048 (A4): pane_error_stalled — classify() never returns this kind,
		// so the blocked-kind rule below would resolve it instantly. Recovered
		// iff the error signature left the live region (fail-toward-active while
		// the error is still visible).
		if (eventType === "pane_error_stalled") {
			return !leadPaneHasErrorSignature(pane);
		}
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
