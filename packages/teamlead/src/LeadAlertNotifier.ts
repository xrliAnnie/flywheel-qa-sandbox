/**
 * FLY-83: Bridge-side alert emitter for Lead lifecycle incidents.
 *
 * Two invariants:
 * - Cross-process atomic claim (Fix 2): we run the SAME
 *   `BEGIN IMMEDIATE + INSERT OR IGNORE + SELECT changes()` transaction
 *   that `scripts/lead-alert.sh` runs against `~/.flywheel/alerts/claims.db`.
 *   First writer wins, regardless of which path (Bridge or shell) fired
 *   first. The earlier `claimsReader` Set is kept as a fast-path skip
 *   (avoids building a payload when shell has already posted), but the
 *   load-bearing dedup is the atomic claimer, not the reader.
 *   Same-process dedup: StateStore.tryClaimLeadEvent against lead_events.
 * - Never throw from alert(): Discord is unreliable; failures get queued to
 *   $HOME/.flywheel/alert-queue/ for a later drainQueue() pass.
 *
 * Not responsible for deciding *when* to alert — LeadWatchdog drives that.
 */

import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	buildRepairChain,
	buildSendChain,
	resolveFirstAvailableBotToken,
} from "./bridge/alert-bot-chain.js";
import type { MetaAlertReason } from "./MetaAlertNotifier.js";
import type { LeadConfig, ProjectEntry } from "./ProjectConfig.js";
import type { StateStore } from "./StateStore.js";

/**
 * FLY-182 Track B: minimal sink so LeadAlertNotifier can fire a Discord-
 * independent meta-alert when its own delivery path fails (config gap,
 * permanent failure, drain stuck). Satisfied by `MetaAlertNotifier`.
 */
export interface MetaAlertSink {
	notify(input: {
		reason: MetaAlertReason;
		title: string;
		body: string;
	}): Promise<unknown>;
}

/**
 * FLY-927: the SINGLE source of truth for the alert-kind face. `AlertEventType`
 * is derived from this array, and the LeadWatchdog echo-immunity regex
 * (`ALERT_ECHO_START`) derives its kind alternation from it too — so a new kind
 * can never silently miss echo stripping (the FLY-220 storm family).
 */
export const ALERT_EVENT_TYPES = [
	"rate_limit",
	"usage_limit",
	"login_expired",
	"permission_blocked",
	"crash_loop",
	"pane_hash_stuck",
	// FLY-195 (plan §3.6 Q7): a stuck-runner episode the owning Lead did not
	// dispose of within the grace window — Bridge pages Annie directly.
	// eventId format (FLY-253: escalatedAt = generation salt so a post-re-arm
	// / post-TTL second fallback is not swallowed by the persistent dedup):
	// `runner-stuck-unhandled:${execution_id}:${fingerprint}:${escalatedAt}`.
	"runner_stuck_unhandled",
	// FLY-579: the auto-QA pipeline could not proceed (spawn failed, QA ended
	// without a verdict, or a fail-closed pr_head_sha). A Lead-only alert — the
	// founder is intentionally never surfaced for a non-green QA. NOT a
	// founder-facing notification (those go to the issue thread).
	"auto_qa_stuck",
	// FLY-827: a session reached awaiting_review but Codex code review is NOT
	// APPROVED for the current PR head → the hard gate blocked auto-QA + merge and
	// held the founder. A Lead-only alert (founder never surfaced pre-Codex).
	// eventId `codex-gate:${execution_id}:${sha}` (no timestamp → fires ONCE per head).
	"codex_gate_blocked",
	// FLY-793: a three-stage pipeline phase handoff (Design→Implement→QA) could
	// not proceed — head-SHA capture failed, the previous phase runner would not
	// close, or the next phase dispatch threw. Fail-closed: the next phase is NOT
	// started and this Lead-only alert fires so a completed phase is never
	// silently stranded. Not a founder-facing notification.
	"three_stage_stuck",
	// FLY-637-ext: the owning Lead did not answer a runner's BLOCKING question
	// gate after the configured number of backoff nudges → page Annie ONCE
	// (final fallback). DISTINCT from runner_stuck_unhandled: the runner is fine,
	// the Lead is unresponsive — so this is deliberately NOT in
	// AUTO_ATTEMPT_EVENT_TYPES and carries no runnerStuck metadata, so the
	// AutoRepairBot never sends the runner a `continue` nudge (Codex design R1 #3).
	"runner_lead_pending_unhandled",
	// FLY-725 (Annie 2026-07-01: "never silently drop"): the Bridge could not
	// deliver a failed/blocked milestone @founder ping to its issue thread
	// (permanent 4xx / missing thread|token|owner / transient retry budget
	// elapsed). Surfaced so the founder is not left in the dark. Not a runner-
	// stuck event — the runner is fine; the notification channel failed.
	"founder_milestone_undelivered",
	// FLY-871 R2/C8: a runner sitting at a login prompt (auth/session expired) —
	// DISTINCT from the lead `login_expired` so AlertChannelHub.reconcile resolves
	// it by the RUNNER pane, and the R3 rescue keys on this event's still-pending row.
	"runner_login_expired",
	// FLY-871 §12 W2: a windowed (cmux TUI) Codex Lead's founder-facing pane could
	// not be (re)created after K consecutive liveness checks — "silent no-pane". NOT
	// emitted by the TS LeadWatchdog / notifier: it is fired ONLY by the runtime's
	// guard via scripts/lead-alert.sh (Discord-independent). Present in the union so
	// the shared kind face (lead-alert.sh allowlist ↔ TS) has no drift.
	"tui_window_lost",
	// FLY-913: the flywheel-restart-guard PreToolUse hook's mandatory bypass
	// alert — fired ONLY via scripts/lead-alert.sh --strict-delivery (Discord-
	// independent path; the hook fail-closes unless the strict result is
	// sent/queued_transient). NOT emitted by the TS LeadWatchdog / notifier;
	// present in the union so a queued bypass alert drains with a known
	// eventType and the shared kind face (lead-alert.sh ↔ TS) has no drift.
	"restart_guard_bypass",
	// FLY-939 (G-D): the Bridge booted on a STALE checkout — its running HEAD is
	// strictly behind origin/main, so merged work is NOT live (the FLY-887
	// silent-non-deploy incident shape). A Lead-only alert; the durable
	// `bridge_boot_stale_checkout` StateStore event + the boot console.warn are the
	// primary signals. Fired from TS (boot-sha-check via the notifier), never shell.
	"bridge_boot_stale_checkout",
	// FLY-927 (D4): the Bridge launchd wrapper's fail-loud path (port stuck /
	// preflight failure while the Bridge is DOWN) — fired ONLY via
	// scripts/lead-alert.sh from flywheel-bridge-wrapper.sh `bp_fail_loud`
	// (Discord-independent; direct-curl core-channel kept as fallback). Present in
	// the union so a queued wrapper alert drains with a known eventType and the
	// shared kind face (lead-alert.sh allowlist ↔ TS) has no drift.
	"bridge_wrapper_fail",
	// FLY-927 W-B: a RUNNER that is genuinely STALLED after a 529/overloaded
	// throttle — pane stagnant + throttle residue + NO live retry activity. A
	// subtype of runner_stuck_unhandled (same runnerStuck metadata contract) so
	// the AutoRepairBot can attempt the audited continue-nudge; a HEALTHY 529
	// (still retrying) never emits this (FLY-218 suppression stays).
	"runner_throttle_stalled",
] as const;

export type AlertEventType = (typeof ALERT_EVENT_TYPES)[number];

export type AlertSeverity = "info" | "warning" | "severe";

/**
 * FLY-368: optional structured metadata carried alongside an alert. NOT rendered
 * into the Discord message (`formatContent` ignores it — byte-compat text), it is
 * consumed by the AutoRepairBot for safe, gated recovery. `runnerStuck` lets the
 * bot reuse the runner recovery-nudge gates without parsing safety-critical data
 * out of the eventId string (Codex design R1 HIGH-2).
 */
export interface AlertMetadata {
	runnerStuck?: {
		executionId: string;
		episodeFingerprint: string;
		escalatedAt?: number;
	};
	/**
	 * FLY-696: a real quota cap (5h / weekly), NOT a transient 529. Produced at
	 * detection (LeadWatchdog / RunnerQuotaDetector) after parsing the CLI usage
	 * gauge. `provider` drives server-side cross-provider gating on the dedicated
	 * account-switch route; `observedAccount`/`observedGeneration` are the CAS
	 * snapshot so a duplicate trigger from another Lead cannot double-switch.
	 * Absent when the gauge was ambiguous (→ the alert stays needs_human).
	 */
	accountLimit?: {
		provider: "claude" | "codex";
		scope: "5h" | "weekly" | "both";
		/** ISO reset instant of the hit window (weekly dominates when "both"). */
		resetAt: string;
		observedAccount: string;
		observedGeneration: number;
	};
	/**
	 * FLY-696 M3: auth/login expiry — DELIBERATELY distinct from `accountLimit`.
	 * Auth expiry is only fixed by re-login (never by waiting for a quota reset),
	 * so it carries its own metadata and evidence source. `observedGeneration`
	 * guards against marking the wrong pool profile after a switch already changed
	 * the active account.
	 */
	authLimit?: {
		provider: "claude" | "codex";
		observedAccount: string;
		observedGeneration: number;
		/** What surfaced the expiry (e.g. "lead-pane:login_expired"). */
		evidence: string;
		/**
		 * FLY-871 R2/C8: the runner's execution id when this is a
		 * `runner_login_expired` — the R3 rescue path validates + targets this
		 * exact session. Absent for a lead-pane auth alert.
		 */
		executionId?: string;
	};
}

export interface AlertPayload {
	leadId: string;
	projectName: string;
	eventId: string;
	eventType: AlertEventType;
	title: string;
	body: string;
	severity: AlertSeverity;
	sessionKey?: string;
	/** FLY-368: optional structured metadata (ignored by Discord rendering). */
	metadata?: AlertMetadata;
}

export interface AlertResult {
	sent?: boolean;
	skipped?: "duplicate" | "no-channel" | "no-token" | "unknown-lead";
	queued?: boolean;
	dmSent?: boolean;
	/** FLY-182: payload routed to dead-letter (permanent failure, no retry). */
	deadLettered?: boolean;
	/**
	 * FLY-368: on a successful unified-channel POST, the channel + posted message
	 * id so AlertChannelHub can open a thread off the root message. ONLY attached
	 * on the unified+threading path (Codex R1 LOW-10: the legacy result stays
	 * exactly `{ sent: true }`). Never carries a token.
	 */
	channelId?: string;
	messageId?: string;
}

/**
 * FLY-368 (rework): fleet-wide unified alert routing. When set, ALL Lead +
 * Q7-runner alerts route to one channel. The root alert is posted via the STUCK
 * agent's OWN bot (correct attribution — the Bridge holds the token, so it works
 * even if that agent is dead) with a fallback chain: own bot → repair bot (Cass)
 * → alphabetical fleet (see `bridge/alert-bot-chain.ts`). `repairBotTokenEnv` is
 * the env-var NAME of the repair/fallback bot (default `CASS_BOT_TOKEN`).
 */
export interface UnifiedAlertConfig {
	channelId: string;
	repairBotTokenEnv: string;
}

export type FetchLike = typeof globalThis.fetch;
export type ClaimsReader = () => Promise<Set<string>>;

/**
 * Atomic claim against the shared `claims.db`.
 *  - `true`  → this caller inserted the row (we won the race; proceed).
 *  - `false` → row already existed (another Bridge or the shell path
 *    already claimed; skip Discord POST).
 *  - `null`  → claim infrastructure failed (sqlite missing, DB locked
 *    past timeout, etc.). Caller should fall through to "best-effort
 *    POST anyway" — duplicate alerts are recoverable; silent failures
 *    are not.
 */
export type ClaimsClaimer = (
	eventId: string,
	leadId: string,
	kind: AlertEventType,
) => Promise<boolean | null>;

export interface LeadAlertNotifierConfig {
	store: StateStore;
	projects: ProjectEntry[];
	fetchFn?: FetchLike;
	queueDir?: string;
	claimsReader?: ClaimsReader;
	claimsClaimer?: ClaimsClaimer;
	logger?: (msg: string) => void;
	/** FLY-182: Discord-independent meta-alert sink (best-effort). */
	metaAlert?: MetaAlertSink;
	/** FLY-182: dead-letter dir (default ~/.flywheel/alert-deadletter). */
	deadLetterDir?: string;
	/** FLY-182: max queue files before oldest are dead-lettered (default 500). */
	queueMax?: number;
	/** FLY-182: max queue-file age before dead-lettered (default 3 days). */
	queueMaxAgeMs?: number;
	/** FLY-368: when set, ALL alerts route to one unified channel. */
	unifiedAlert?: UnifiedAlertConfig;
}

/** Queue reasons that are PERMANENT — config doesn't change at runtime, so
 * retrying is pointless. These are dead-lettered on drain regardless of
 * whether today's config could now resolve a channel (Codex design R1#3 —
 * prevents the legacy `no-channel` backlog from flooding core on config flip). */
const PERMANENT_QUEUE_REASONS = new Set([
	"no-channel",
	"no-token",
	"unknown-lead",
]);

const DEFAULT_QUEUE_MAX = 500;
const DEFAULT_QUEUE_MAX_AGE_MS = 259_200_000; // 3 days

const DISCORD_API = "https://discord.com/api/v10";

/** Result of a Discord POST attempt. `transient` failures are retryable.
 * FLY-368: `messageId` is the posted message id (parsed from the Discord JSON
 * response) on the unified path, so AlertChannelHub can open a thread off it. */
type PostOutcome =
	| { ok: true; messageId?: string }
	| { ok: false; status?: number; transient: boolean };

/** 5xx and 429 are transient (retry); other 4xx are permanent (dead-letter). */
function isTransientStatus(status: number): boolean {
	return status >= 500 || status === 429;
}

/**
 * FLY-368 rework (Codex code R1 MEDIUM): a permanent status that means "THIS bot
 * can't post here" (auth/perms/not-a-member) → try the next bot in the send
 * chain. Any other permanent 4xx (400/405/413/...) is a malformed request that
 * fails identically for every bot → stop and dead-letter, don't burn the fleet.
 * `undefined` (network error with no status) is NOT a fall-through (it's
 * transient and handled before this is consulted).
 */
function isSendChainFallthrough(status: number | undefined): boolean {
	return status === 401 || status === 403 || status === 404;
}

export class LeadAlertNotifier {
	private store: StateStore;
	private projects: ProjectEntry[];
	private fetchFn: FetchLike;
	private queueDir: string;
	private claimsReader?: ClaimsReader;
	private claimsClaimer?: ClaimsClaimer;
	private logger: (msg: string) => void;
	private metaAlert?: MetaAlertSink;
	private deadLetterDir: string;
	private queueMax: number;
	private queueMaxAgeMs: number;
	private unifiedAlert?: UnifiedAlertConfig;

	constructor(config: LeadAlertNotifierConfig) {
		this.store = config.store;
		this.projects = config.projects;
		this.fetchFn = config.fetchFn ?? (globalThis.fetch as FetchLike);
		this.queueDir =
			config.queueDir ?? join(homedir(), ".flywheel", "alert-queue");
		this.claimsReader = config.claimsReader;
		this.claimsClaimer = config.claimsClaimer;
		this.logger =
			config.logger ??
			((msg) => {
				console.log(`[LeadAlertNotifier] ${msg}`);
			});
		this.metaAlert = config.metaAlert;
		this.deadLetterDir =
			config.deadLetterDir ?? join(homedir(), ".flywheel", "alert-deadletter");
		this.queueMax = config.queueMax ?? DEFAULT_QUEUE_MAX;
		this.queueMaxAgeMs = config.queueMaxAgeMs ?? DEFAULT_QUEUE_MAX_AGE_MS;
		this.unifiedAlert = config.unifiedAlert;
		mkdirSync(this.queueDir, { recursive: true });
	}

	/** Fire a meta-alert (Discord-independent), best-effort — never throws. */
	private async fireMetaAlert(
		reason: MetaAlertReason,
		title: string,
		body: string,
	): Promise<void> {
		if (!this.metaAlert) return;
		try {
			await this.metaAlert.notify({ reason, title, body });
		} catch (err) {
			this.logger(`meta-alert notify failed: ${(err as Error).message}`);
		}
	}

	/**
	 * Route a payload to the dead-letter dir (PERMANENT failure — never retried,
	 * kept for audit) and fire a meta-alert so the silent failure surfaces.
	 */
	private async deadLetter(
		payload: AlertPayload,
		reason: string,
	): Promise<void> {
		try {
			mkdirSync(this.deadLetterDir, { recursive: true });
			const stamp = new Date().toISOString().replace(/[:.]/g, "-");
			const file = `${stamp}-${payload.leadId}-${payload.eventType}.json`;
			writeFileSync(
				join(this.deadLetterDir, file),
				JSON.stringify(
					{ ...payload, deadLetteredAt: new Date().toISOString(), reason },
					null,
					2,
				),
				"utf-8",
			);
		} catch (err) {
			this.logger(`dead-letter write failed: ${(err as Error).message}`);
		}
		await this.fireMetaAlert(
			"alert_dead_lettered",
			"LeadAlert dropped (dead-letter)",
			`A Lead alert could not be delivered and was dead-lettered (reason=${reason}, lead=${payload.leadId}, type=${payload.eventType}). The Discord alert path may be misconfigured or down.`,
		);
	}

	async alert(payload: AlertPayload): Promise<AlertResult> {
		const resolved = this.resolveLead(payload.leadId, payload.projectName);
		if (!resolved) {
			this.logger(
				`unknown lead: project=${payload.projectName} leadId=${payload.leadId}`,
			);
			// Permanent routing failure (Codex CR R1) — dead-letter for audit
			// (deadLetter() also fires the Discord-independent meta-alert) so the
			// dropped payload is recorded, not just announced.
			await this.deadLetter(payload, "unknown-lead");
			return { skipped: "unknown-lead", deadLettered: true };
		}
		const { lead, project } = resolved;

		// Step 1: shell-side fast-path read. Avoids building a payload when
		// shell has already posted an alert for this eventId. Not the
		// load-bearing dedup — that's Step 2.
		if (this.claimsReader) {
			try {
				const claimed = await this.claimsReader();
				if (claimed.has(payload.eventId)) {
					return { skipped: "duplicate" };
				}
			} catch (err) {
				this.logger(
					`claimsReader failed (treating as not claimed): ${(err as Error).message}`,
				);
			}
		}

		// Step 2 (Fix 2): atomic cross-process claim. INSERT OR IGNORE inside
		// BEGIN IMMEDIATE against the SAME claims.db file that lead-alert.sh
		// writes. Whoever writes the row first wins; everyone else gets
		// `false` and skips. On infrastructure failure (`null`) we proceed
		// to the Bridge-only dedup so a partial outage doesn't silence
		// alerts entirely.
		if (this.claimsClaimer) {
			try {
				const won = await this.claimsClaimer(
					payload.eventId,
					payload.leadId,
					payload.eventType,
				);
				if (won === false) {
					return { skipped: "duplicate" };
				}
				// won === true  → proceed; we own the alert.
				// won === null  → claim infra broken; fall through to Bridge-side dedup.
			} catch (err) {
				this.logger(
					`claimsClaimer threw (falling back to Bridge dedup): ${(err as Error).message}`,
				);
			}
		}

		// Step 3: Bridge-only dedup via lead_events UNIQUE. Catches duplicate
		// in-process Watchdog re-fires plus same-Bridge-process retries that
		// might bypass the cross-process claim (e.g., when claimsClaimer
		// returned null).
		const firstClaim = this.store.tryClaimLeadEvent(
			payload.leadId,
			payload.eventId,
			payload.eventType,
			JSON.stringify(payload),
			payload.sessionKey,
		);
		if (!firstClaim) {
			return { skipped: "duplicate" };
		}

		// Step 4: Resolve channel (PERMANENT failure → dead-letter; config doesn't
		// change at runtime). FLY-182: do NOT blind-retry no-channel.
		const channel = this.resolveChannel(lead, project);
		if (!channel) {
			await this.deadLetter(payload, "no-channel");
			return { skipped: "no-channel", deadLettered: true };
		}

		// Step 5: Fire the Discord POST.
		// FLY-368 rework: in unified mode the root alert is posted via the
		// owner-attributed send chain (stuck agent's own bot → Cass → alphabetical
		// fleet, try-in-order, fall through 401/403/404). In legacy (per-lead) mode
		// the single-token path is unchanged (byte-compat).
		let messageId: string | undefined;
		let usedToken: string | null = null;
		if (this.unifiedAlert) {
			const sent = await this.postAlertWithSendChain(payload, channel);
			if (!sent.ok) {
				if (sent.transient) {
					this.enqueue(payload, `discord-${sent.status ?? "net"}`);
					return { queued: true };
				}
				await this.deadLetter(payload, `discord-${sent.status ?? "4xx"}`);
				return { deadLettered: true };
			}
			messageId = sent.messageId;
			usedToken = sent.usedToken ?? null;
		} else {
			const token = this.resolveToken(lead);
			if (!token) {
				await this.deadLetter(payload, "no-token");
				return { skipped: "no-token", deadLettered: true };
			}
			const outcome = await this.postMessage(channel, token, payload);
			if (!outcome.ok) {
				if (outcome.transient) {
					this.enqueue(payload, `discord-${outcome.status ?? "net"}`);
					return { queued: true };
				}
				await this.deadLetter(payload, `discord-${outcome.status ?? "4xx"}`);
				return { deadLettered: true };
			}
			messageId = outcome.messageId;
			usedToken = token;
		}

		// Step 6: Severe follow-up DM (best-effort). FLY-368 (Codex R1 LOW-3): use
		// the WINNING root token so the DM comes from the same bot that visibly
		// posted the root — not an independent re-resolve.
		let dmSent = false;
		if (payload.severity === "severe" && lead.alertDmUserId && usedToken) {
			dmSent = await this.sendDm(lead.alertDmUserId, usedToken, payload);
		}

		// FLY-368: on the unified path, surface channel + posted message id so the
		// Hub can open a per-error thread. ONLY in unified mode (Codex R1 LOW-10:
		// the legacy result object stays exactly `{ sent: true }`).
		const base: AlertResult = dmSent
			? { sent: true, dmSent: true }
			: { sent: true };
		if (this.unifiedAlert) {
			base.channelId = channel;
			if (messageId) base.messageId = messageId;
		}
		return base;
	}

	/**
	 * FLY-368 rework: post the root alert via the owner-attributed send chain
	 * (own bot → Cass → alphabetical fleet). Shared by `alert()` and
	 * `drainQueue()` so the retry path uses the SAME logic (Codex R1 MEDIUM-2).
	 *  - first 2xx wins (returns messageId + the winning token);
	 *  - permanent rejection (401/403/404) on a candidate → try the next;
	 *  - transient (429/5xx/network) → STOP, report transient (don't burn the
	 *    chain on a blip; caller queues / leaves the queue file);
	 *  - all candidates permanently fail / none resolve → ok:false, transient:false.
	 * Tokens are resolved from env at call time (never persisted).
	 */
	private async postAlertWithSendChain(
		payload: AlertPayload,
		channel: string,
	): Promise<{
		ok: boolean;
		messageId?: string;
		usedTokenEnv?: string;
		usedToken?: string;
		transient?: boolean;
		status?: number;
	}> {
		const repairEnv = this.unifiedAlert?.repairBotTokenEnv ?? "";
		const chain = buildSendChain(this.projects, payload.leadId, repairEnv);
		let lastStatus: number | undefined;
		for (const tokenEnv of chain) {
			const token = process.env[tokenEnv];
			if (!token) continue;
			const outcome = await this.postMessage(channel, token, payload);
			if (outcome.ok) {
				return {
					ok: true,
					messageId: outcome.messageId,
					usedTokenEnv: tokenEnv,
					usedToken: token,
				};
			}
			if (outcome.transient) {
				// Transient on this candidate → stop; the alert is retryable as a whole.
				return { ok: false, transient: true, status: outcome.status };
			}
			// Permanent. ONLY 401/403/404 (this bot lacks channel perms) falls through
			// to the next candidate (Codex code R1 MEDIUM). Any other permanent status
			// (400/405/413/... — a malformed request that will fail identically for
			// EVERY bot) stops immediately and dead-letters; trying the rest of the
			// fleet would be pointless and noisy.
			if (!isSendChainFallthrough(outcome.status)) {
				return { ok: false, transient: false, status: outcome.status };
			}
			lastStatus = outcome.status;
		}
		return { ok: false, transient: false, status: lastStatus };
	}

	/**
	 * Drain the retry queue. Oldest first. Successes are unlinked; TRANSIENT
	 * failures stay for the next pass; everything else (permanent reason,
	 * malformed, unknown lead, unresolved channel/token, permanent 4xx, aged
	 * out, over cap) is moved to the dead-letter dir so the queue can never
	 * grow without bound or spin forever at sent=0 (FLY-182).
	 *
	 * Does NOT fire meta-alerts per file (would be 1667× on a backlog drain);
	 * returns `deadLettered` so the caller (Bridge drain loop) can fire ONE
	 * debounced meta-alert when dead-lettering occurs.
	 */
	async drainQueue(): Promise<{
		sent: number;
		remaining: number;
		deadLettered: number;
	}> {
		let entries = readdirSync(this.queueDir)
			.filter((f) => f.endsWith(".json"))
			.sort(); // names start with an ISO-ish stamp → lexical ≈ chronological
		let sent = 0;
		let deadLettered = 0;

		// Cap: dead-letter the oldest beyond queueMax before doing any work.
		if (entries.length > this.queueMax) {
			const overflow = entries.slice(0, entries.length - this.queueMax);
			for (const file of overflow) {
				this.moveQueueFileToDeadLetter(file, "queue-cap");
				deadLettered++;
			}
			entries = entries.slice(entries.length - this.queueMax);
		}

		for (const file of entries) {
			const path = join(this.queueDir, file);
			let parsed: AlertPayload & { queueReason?: string; queuedAt?: string };
			try {
				parsed = JSON.parse(readFileSync(path, "utf-8"));
			} catch (err) {
				// Malformed → dead-letter (never skip forever — Codex CR R2#2).
				this.logger(`malformed queue entry ${file}: ${(err as Error).message}`);
				this.moveQueueFileToDeadLetter(file, "malformed");
				deadLettered++;
				continue;
			}

			// Aging.
			if (this.queueFileAgeMs(parsed.queuedAt, path) > this.queueMaxAgeMs) {
				this.moveQueueFileToDeadLetter(file, "aged-out");
				deadLettered++;
				continue;
			}

			// Recorded permanent reason → dead-letter REGARDLESS of whether
			// today's config can resolve a channel (Codex design R1#3: stops the
			// legacy no-channel backlog flooding core after fallbackToCore flip).
			if (
				parsed.queueReason &&
				PERMANENT_QUEUE_REASONS.has(parsed.queueReason)
			) {
				this.moveQueueFileToDeadLetter(file, `permanent-${parsed.queueReason}`);
				deadLettered++;
				continue;
			}

			const resolved = this.resolveLead(parsed.leadId, parsed.projectName);
			if (!resolved) {
				this.moveQueueFileToDeadLetter(file, "unknown-lead");
				deadLettered++;
				continue;
			}
			const { lead, project } = resolved;
			const channel = this.resolveChannel(lead, project);
			if (!channel) {
				// Config problem — permanent. Dead-letter, don't spin.
				this.moveQueueFileToDeadLetter(file, "no-channel");
				deadLettered++;
				continue;
			}

			// FLY-368 rework (Codex R1 MEDIUM-2): drain retries use the SAME
			// owner-attributed send chain as the first send in unified mode, so a
			// queued alert is never re-sent via stale single-token logic. Chain is
			// recomputed here (env/config may have changed); tokens are not stored.
			if (this.unifiedAlert) {
				const sentResult = await this.postAlertWithSendChain(parsed, channel);
				if (sentResult.ok) {
					unlinkSync(path);
					sent++;
				} else if (!sentResult.transient) {
					// Every candidate permanently failed → dead-letter.
					this.moveQueueFileToDeadLetter(
						file,
						`discord-${sentResult.status ?? "4xx"}`,
					);
					deadLettered++;
				}
				// transient → leave for the next pass.
				continue;
			}

			const token = this.resolveToken(lead);
			if (!token) {
				this.moveQueueFileToDeadLetter(file, "no-token");
				deadLettered++;
				continue;
			}
			const outcome = await this.postMessage(channel, token, parsed);
			if (outcome.ok) {
				unlinkSync(path);
				sent++;
			} else if (!outcome.transient) {
				// Permanent 4xx → dead-letter (retry pointless).
				this.moveQueueFileToDeadLetter(
					file,
					`discord-${outcome.status ?? "4xx"}`,
				);
				deadLettered++;
			}
			// transient → leave for the next pass.
		}

		const remaining = readdirSync(this.queueDir).filter((f) =>
			f.endsWith(".json"),
		).length;
		return { sent, remaining, deadLettered };
	}

	/** Move a queue file into the dead-letter dir (no retry, kept for audit). */
	private moveQueueFileToDeadLetter(file: string, reason: string): void {
		const src = join(this.queueDir, file);
		try {
			mkdirSync(this.deadLetterDir, { recursive: true });
			renameSync(src, join(this.deadLetterDir, `${reason}-${file}`));
		} catch (err) {
			this.logger(
				`dead-letter move failed for ${file} (${reason}): ${(err as Error).message}`,
			);
			// Best-effort: remove so a permanently-broken file can't loop forever.
			try {
				unlinkSync(src);
			} catch {
				/* already gone */
			}
		}
	}

	/** Age of a queue file in ms — from `queuedAt` if present, else file mtime. */
	private queueFileAgeMs(queuedAt: string | undefined, path: string): number {
		const now = Date.now();
		if (queuedAt) {
			const t = Date.parse(queuedAt);
			if (!Number.isNaN(t)) return now - t;
		}
		try {
			return now - statSync(path).mtimeMs;
		} catch {
			return 0;
		}
	}

	private resolveLead(
		leadId: string,
		projectName: string,
	): { lead: LeadConfig; project: ProjectEntry } | null {
		const project = this.projects.find((p) => p.projectName === projectName);
		if (!project) return null;
		const lead = project.leads.find((l) => l.agentId === leadId);
		if (!lead) return null;
		return { lead, project };
	}

	private resolveChannel(
		lead: LeadConfig,
		project: ProjectEntry,
	): string | null {
		// FLY-368: unified channel wins over per-lead routing when configured —
		// this is what funnels every Lead/Q7-runner alert into one place.
		if (this.unifiedAlert?.channelId) return this.unifiedAlert.channelId;
		if (lead.alertChannel) return lead.alertChannel;
		if (lead.alertFallbackToCore && project.generalChannel) {
			return project.generalChannel;
		}
		return null;
	}

	/**
	 * Legacy (non-unified) per-lead token resolution — unchanged byte-compat.
	 * The unified path no longer uses this; it resolves per-alert via the
	 * owner-attributed send chain (`postAlertWithSendChain`).
	 */
	private resolveToken(lead: LeadConfig): string | null {
		const envName = lead.alertBotTokenEnv ?? lead.botTokenEnv;
		if (envName) {
			const fromEnv = process.env[envName];
			if (fromEnv) return fromEnv;
		}
		return lead.botToken ?? null;
	}

	private async postMessage(
		channelId: string,
		token: string,
		payload: AlertPayload,
	): Promise<PostOutcome> {
		const url = `${DISCORD_API}/channels/${channelId}/messages`;
		try {
			const res = await this.fetchFn(url, {
				method: "POST",
				headers: {
					Authorization: `Bot ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					content: formatContent(payload),
					// FLY-368 (Codex code R1 MEDIUM-3): suppress all mentions on the
					// unified-channel root alert so an issue id / title / body can never
					// @everyone/@here/@role-ping the channel. Gated on unified mode so the
					// legacy per-lead POST body stays byte-identical.
					...(this.unifiedAlert
						? { allowed_mentions: { parse: [] as string[] } }
						: {}),
				}),
			});
			if (!res.ok) {
				const text = await safeText(res);
				this.logger(
					`Discord POST ${res.status} ${res.statusText} for ${payload.leadId}/${payload.eventType}: ${text}`,
				);
				return {
					ok: false,
					status: res.status,
					transient: isTransientStatus(res.status),
				};
			}
			// FLY-368: parse the posted message id ONLY in unified mode (so the
			// legacy path is byte-identical and never depends on response parsing).
			if (this.unifiedAlert) {
				try {
					const body =
						(await (
							res.json as undefined | (() => Promise<{ id?: string }>)
						)?.()) ?? {};
					return { ok: true, messageId: body.id };
				} catch {
					return { ok: true };
				}
			}
			return { ok: true };
		} catch (err) {
			// Network/transport error — transient, retry via queue.
			this.logger(
				`Discord POST threw for ${payload.leadId}/${payload.eventType}: ${(err as Error).message}`,
			);
			return { ok: false, transient: true };
		}
	}

	private async sendDm(
		userId: string,
		token: string,
		payload: AlertPayload,
	): Promise<boolean> {
		const createUrl = `${DISCORD_API}/users/@me/channels`;
		try {
			const res = await this.fetchFn(createUrl, {
				method: "POST",
				headers: {
					Authorization: `Bot ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ recipient_id: userId }),
			});
			if (!res.ok) {
				this.logger(
					`DM channel create ${res.status} for user ${userId}: ${await safeText(res)}`,
				);
				return false;
			}
			const body =
				(await (
					res.json as undefined | (() => Promise<{ id?: string }>)
				)?.()) ?? {};
			const dmChannelId = body.id;
			if (!dmChannelId) return false;
			return (await this.postMessage(dmChannelId, token, payload)).ok;
		} catch (err) {
			this.logger(`DM fan-out failed: ${(err as Error).message}`);
			return false;
		}
	}

	private enqueue(payload: AlertPayload, reason: string): void {
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const file = `${stamp}-${payload.leadId}-${payload.eventType}.json`;
		const path = join(this.queueDir, file);
		const record = {
			...payload,
			queuedAt: new Date().toISOString(),
			queueReason: reason,
		};
		writeFileSync(path, JSON.stringify(record, null, 2), "utf-8");
	}
}

/** A Lead whose alert path can never deliver with the current config. */
export interface UnreachableAlertLead {
	projectName: string;
	leadId: string;
	reason: string;
}

/**
 * FLY-182 (§4.1): find Leads whose alert channel/token cannot resolve from
 * config — the silent gap that broke alerting for 25 days. Called at Bridge
 * startup so a misconfigured alert path is surfaced LOUDLY instead of failing
 * silently. Token check is config-shape only (a configured env var may still
 * be empty at runtime; that surfaces as a permanent no-token dead-letter).
 */
export function findUnreachableAlertLeads(
	projects: ProjectEntry[],
	unified?: { channelId?: string; repairBotTokenEnv?: string },
): UnreachableAlertLead[] {
	const out: UnreachableAlertLead[] = [];
	// FLY-368 rework: in unified mode every alert resolves a token via the
	// fleet-wide send chain (own → repair/Cass → alphabetical). A lead is
	// therefore unreachable ONLY if the ENTIRE fleet has no resolvable bot token
	// — a single fleet-wide failure, not per-lead noise. (The per-thread
	// repair-bot fail-loud lives in plugin.ts.)
	if (unified?.channelId) {
		const repairEnv = unified.repairBotTokenEnv ?? "";
		const anyBot = resolveFirstAvailableBotToken(
			buildRepairChain(projects, repairEnv),
		);
		if (!anyBot) {
			out.push({
				projectName: "*",
				leadId: "*",
				reason:
					"unified alert channel set but NO fleet bot token resolves (repair chain Cass→alpha empty) — alerts cannot be sent",
			});
		}
		return out;
	}
	// Legacy (non-unified) per-lead channel+token validation — unchanged.
	for (const project of projects) {
		for (const lead of project.leads) {
			const hasChannel =
				!!lead.alertChannel ||
				(!!lead.alertFallbackToCore && !!project.generalChannel);
			if (!hasChannel) {
				out.push({
					projectName: project.projectName,
					leadId: lead.agentId,
					reason:
						"no alertChannel and no alertFallbackToCore+generalChannel — alerts cannot resolve a channel",
				});
				continue;
			}
			// Codex CR R1: check the token actually RESOLVES at runtime, not just
			// that an env-var NAME is configured — a misspelled/unset env var would
			// otherwise pass startup and only surface as a dead-letter on the first
			// real alert.
			const tokenEnvName = lead.alertBotTokenEnv ?? lead.botTokenEnv;
			const tokenResolves =
				(!!tokenEnvName && !!process.env[tokenEnvName]) || !!lead.botToken;
			if (!tokenResolves) {
				out.push({
					projectName: project.projectName,
					leadId: lead.agentId,
					reason: tokenEnvName
						? `alert token env "${tokenEnvName}" is not set / empty (and no inline botToken)`
						: "no alertBotTokenEnv / botTokenEnv / botToken configured",
				});
			}
		}
	}
	return out;
}

function formatContent(payload: AlertPayload): string {
	const sev =
		payload.severity === "severe"
			? "🚨"
			: payload.severity === "warning"
				? "⚠️"
				: "ℹ️";
	return `${sev} **${payload.title}** (${payload.leadId} / ${payload.eventType})\n${payload.body}`;
}

async function safeText(
	res: Response | { text?: () => Promise<string> },
): Promise<string> {
	try {
		return typeof res.text === "function" ? await res.text() : "";
	} catch {
		return "";
	}
}
