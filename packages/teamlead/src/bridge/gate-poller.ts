/**
 * FLY-62 / FLY-161: Question Poller — scans CommDB for pending questions
 * and relays them to the appropriate Lead via the configured LeadRuntime.
 *
 * Despite the historical name `GatePoller`, this poller surfaces **both**
 * gate_question (checkpoint != NULL) and runner_question (checkpoint == NULL).
 *
 * Routing rules:
 *  - `gate_question` (FLY-62): requires the source session to be in
 *    {running, awaiting_review, approved_to_ship} AND
 *    `matchesLead(session, lead.agentId, projects)` — i.e. the session's
 *    label-derived Lead must equal the iteration Lead. Preserves pre-FLY-161
 *    behavior where source-session label routing wins.
 *  - `runner_question` (FLY-161): routes purely by `q.to_agent` (the Lead the
 *    Runner explicitly named when running `flywheel-comm ask --lead <id>`).
 *    No active-session check, no lead-scope check — the question survives
 *    Runner completion so Annie can still answer asks from finished sessions.
 *
 * Name not changed (FLY-161 §2.5) to avoid rename diff noise; both event
 * types continue to flow through this poller.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { readContentRef } from "flywheel-comm/utils";
// FLY-927 (Task 3.2): checkpoint-park patrol wake primitive.
import { wakeRunnerMailbox } from "flywheel-comm/wake";
import {
	type FounderMilestoneReportConfig,
	type MilestoneKind,
	phaseMessageTag,
	SUPPORTED_MILESTONE_KINDS_V1,
} from "flywheel-config";
import {
	encodeReactionEmoji,
	type ReactionFetcher,
} from "../lead-backends/codex/gateway/founder-confirmation.js";
import {
	type InboundCursorStore,
	InMemoryInboundCursorStore,
} from "../lead-backends/codex/InboundCursorStore.js";
import {
	type LeadConfig,
	type ProjectEntry,
	resolveLeadForIssue,
} from "../ProjectConfig.js";
import {
	REVIEW_BINDING_UNBOUND,
	type Session,
	type StateStore,
} from "../StateStore.js";
import {
	type DeferredRebindDeps,
	type RebindCommDb,
	runDeferredApprovalRebindPass,
} from "./approval-signal/deferred-approval.js";
import { writeGateMessageBinding } from "./approval-signal/gate-message-binding-store.js";
import { isReviewHeld, reviewHoldReason } from "./auto-qa-held.js";
import { resolveChatThreadId } from "./chat-thread-utils.js";
// FLY-927 (Task 3.3): truthful park wording for the lead-pending nudge.
import { deriveParkTuple, formatParkAlert } from "./checkpoint-park.js";
import { queueCodexCodeReviewInstructionResult } from "./codex-instruction.js";
import { DISCORD_API, postDiscordMessageToChannel } from "./discord-utils.js";
import { drainFounderActionLedger } from "./founder-action-drain.js";
import {
	isDiscordSnowflake,
	parseSqliteUtcMs,
} from "./founder-notify-utils.js";
import {
	emitFounderReplyDeliveryForThread,
	type FounderReplyDeliverDeps,
	type FounderReplyRetryLedger,
	type FounderReplyThreadCtx,
	type PendingQuestionForThread,
} from "./founder-reply-deliverer.js";
import { FounderReplyWatchdog } from "./founder-reply-watchdog.js";
import {
	emitFounderMilestoneNotification,
	emitFounderThreadNotification,
	emitIssueThreadInfraNotification,
} from "./founder-thread-notifier.js";
import type { HookPayload } from "./hook-payload.js";
import {
	computeStuckKey,
	decideLeadNudge,
	leadPendingEscalationEnabled,
	readLeadNudgePolicy,
} from "./lead-pending-escalation.js";
import type { LeadEventEnvelope } from "./lead-runtime.js";
import { matchesLead } from "./lead-scope.js";
import type { MergedGateGuard } from "./merged-gate-guard.js";
import { decideMilestoneReport } from "./milestone-report-policy.js";
import { sendRunnerWake } from "./runner-wake.js";
import type { RuntimeRegistry } from "./runtime-registry.js";
import { defaultGetCommDbPath } from "./session-capture.js";
import {
	DEFAULT_REWAKE_BACKOFF_MS,
	DEFAULT_REWAKE_GRACE_MS,
	type RewakeSessionProbe,
	reconcileStaleApprovedShip,
} from "./stale-approved-ship-reconciler.js";
import type { UnhandledAlertSink } from "./stuck-escalation.js";
import { isTmuxSessionAlive } from "./tmux-lookup.js";
import {
	runZombieGateHygiene,
	type ZombieCommDb,
	zombieGateResolveEnabled,
} from "./zombie-gate-hygiene.js";

/**
 * FLY-208 A2: minimal structural view of the agent-team transport used by the
 * misroute patrol. `ClaudeCodeAdapter` satisfies it; tests can stub it.
 * Production code must reach mailbox files through this interface only (the
 * CI grep gate forbids direct claude path-helper calls outside the transport
 * package).
 */
export interface MisrouteMailboxMessage {
	/** Vendor-stable dedupe id (`${from}:${timestamp}` for claude-code). */
	id: string;
	from: string;
	content: string;
	/** Epoch ms of the original mailbox entry. */
	ts: number;
	read: boolean;
}

export interface MisroutePatrolTransport {
	readUnread(args: {
		leadName: string;
		agentName: string;
	}): Promise<MisrouteMailboxMessage[]>;
	ack(args: {
		leadName: string;
		agentName: string;
		messageIds: string[];
	}): Promise<void>;
}

export interface GatePollerConfig {
	pollIntervalMs: number;
	projects: ProjectEntry[];
	store: StateStore;
	runtimeRegistry: RuntimeRegistry;
	/** FLY-91: Enable per-issue chat thread hints in gate_question payloads. */
	chatThreadsEnabled?: boolean;
	/**
	 * FLY-208 A2: transport for the black-hole inbox patrol. Absent (commdb /
	 * rollback mode, or wiring failure) → patrol is a complete no-op.
	 */
	transport?: MisroutePatrolTransport;
	/**
	 * FLY-208 A2: root dir for backlog JSONL archives
	 * (`<dir>/<leadId>/<aggregateId>.jsonl`). Required for the patrol — the
	 * aggregate path MUST archive before bulk-ack (mailbox read-retention
	 * pruning can delete acked originals). transport set but archiveDir
	 * missing → patrol no-op + one warning.
	 */
	misrouteArchiveDir?: string;
	/** FLY-208 A2: patrol cadence in poll ticks (default 20 ≈ 60s at 3s). */
	patrolEveryNTicks?: number;
	/** FLY-208 A2: unread count above which the aggregate path kicks in (default 10). */
	backlogThreshold?: number;
	/** FLY-307 B: consecutive per-lead poll failures before the circuit opens (default 3). */
	circuitThreshold?: number;
	/** FLY-307 B: poll ticks a lead's circuit stays open before a probe (default 20 ≈ 60s at 3s). */
	circuitCooldownTicks?: number;
	/** FLY-307 A: poll ticks before retrying a failed stale-gate eviction write (default 20). */
	evictionRetryTicks?: number;
	/**
	 * FLY-513: optional global-codex drift probe run on the SAME poll tick (zero
	 * new periodic timer, FLY-169/172 discipline). Invoked OUTSIDE the
	 * per-project/per-lead loops, fully error-isolated; MUST be cheap and MUST
	 * NOT touch StateStore/CommDB (Codex design R2 LOW-2). Detects a global `codex`
	 * that drifted into a Lead CODEX_HOME while the Bridge is running — the churn
	 * window the boot check alone cannot cover. Absent → complete no-op.
	 */
	onHealthTick?: () => void | Promise<void>;
	/** FLY-513: cadence for `onHealthTick` in poll ticks (default 20 ≈ 60s at 3s). */
	healthCheckEveryNTicks?: number;
	/**
	 * FLY-1048 (PR-C): the detection-escalation reconcile sweep — the ~30min
	 * Lead-grace timer that pages the founder (or aggregates a fleet incident).
	 * Piggybacks this same poll tick (zero new periodic timer). Error-isolated +
	 * fire-and-forget. Absent → complete no-op; cadence 0 → disabled.
	 */
	onDetectionReconcileTick?: () => void | Promise<void>;
	/** FLY-1048 (PR-C): cadence in poll ticks (default 20 ≈ 60s at 3s). */
	detectionReconcileEveryNTicks?: number;
	/**
	 * FLY-907 (Step 4.5): the issue-display reconcile sweep, piggybacked on this
	 * same poll tick (zero new periodic timers — FLY-169/172/208 discipline).
	 * Error-isolated + fire-and-forget; MUST be cheap on a no-drift pass (the
	 * refresher's zero-churn writers make it Discord-request-free). Absent →
	 * complete no-op.
	 */
	onDisplayReconcileTick?: () => void | Promise<void>;
	/**
	 * FLY-907: cadence for `onDisplayReconcileTick` in poll ticks (default 60 ≈
	 * 3min at the production 3s interval; plugin reads
	 * FLYWHEEL_ISSUE_DISPLAY_SWEEP_TICKS). 0 → sweep disabled.
	 */
	displayReconcileEveryNTicks?: number;
	/**
	 * FLY-1048 (A6): the cheap gap/state scan, piggybacked on this same tick
	 * (zero new periodic timer — FLY-513 pattern). MUST stay zero-pane /
	 * zero-token (StateStore + readonly CommDB reads only); fully
	 * error-isolated. Absent → complete no-op (byte-compat).
	 */
	onGapScanTick?: () => void | Promise<void>;
	/** FLY-1048 (A6): cadence in poll ticks (default 100 ≈ 5min at 3s; plugin
	 * reads FLYWHEEL_GAP_SCAN_EVERY_N_TICKS). */
	gapScanEveryNTicks?: number;

	// ── FLY-605: bidirectional in-thread founder relay fallback ──
	/** Global Discord bot token fallback (lead.botToken takes precedence). */
	discordBotToken?: string;
	/** Founder Discord user id (DISCORD_OWNER_USER_ID) — @mention + author match. */
	discordOwnerUserId?: string;
	/** Test seam for Discord HTTP (passed to notifier/deliverer). */
	fetchImpl?: typeof fetch;
	/** Part A grace before the in-thread fallback fires (default 10min). */
	founderThreadNotifyGraceMs?: number;
	/** Part A transient-retry TIME budget (default 45min); not a fast tick count. */
	founderThreadRetryBudgetMs?: number;
	/** Part B grace before auto-delivering a founder reply (default 10min). */
	founderReplyDeliverGraceMs?: number;
	/**
	 * FLY-945 Fix A: grace for approve_to_ship gates ONLY (text + ✅-reaction
	 * founder approvals). The 10min FLY-605 grace exists so the Lead can relay
	 * first — but a ship gate's answer is founder-only (the Lead is FORBIDDEN
	 * from relaying it), so the wait is pure dead time. Default 15s. Env
	 * `FLYWHEEL_SHIP_GATE_GRACE_MS` overrides (set 600000 to restore the old
	 * behavior — that IS the kill-switch). Non-ship checkpoints are untouched.
	 */
	shipGateGraceMs?: number;
	/**
	 * FLY-1041 Chunk 6: grace before the approve_to_ship founder CARD is
	 * posted (the deterministic approval carrier — reply-to-card / ✅). The
	 * 10min FLY-605 grace made the card a rarely-seen fallback; for ship gates
	 * the card IS the primary surface, so it fires after ~15s (default). Env
	 * `FLYWHEEL_SHIP_GATE_CARD_GRACE_MS` overrides; `FLYWHEEL_SHIP_GATE_CARD=0`
	 * restores the 10min fallback behavior. Brainstorm is untouched.
	 */
	shipGateCardGraceMs?: number;
	/** Part B slow sub-cadence in poll ticks (default 20 ≈ 60s at 3s). */
	founderReplyDeliverEveryNTicks?: number;
	/** Part B thread-read cursor store (default in-memory). */
	cursorStore?: InboundCursorStore;
	/**
	 * FLY-799: the flag-gated founder ship-approval callback (built in plugin.ts
	 * via makeFounderShipApprovalCallback). Threaded into the founder-reply
	 * deliverer so a founder's identity-verified text approval writes the
	 * approve_to_ship gate response. Absent → deliverer stays WAKE-only.
	 */
	tryFounderShipApproval?: FounderReplyDeliverDeps["tryFounderShipApproval"];

	/**
	 * FLY-1041 Chunk 7: the durable gate-message binding reader (same closure
	 * the ✅-reaction callback uses), threaded into the founder-reply deliverer
	 * for reply-to-card narrowing. Absent → replies are never card-matched.
	 */
	readCurrentBinding?: FounderReplyDeliverDeps["readCurrentBinding"];

	/**
	 * FLY-945 Fix D: the external-merge convergence sweeper closure (built in
	 * plugin.ts via createExternalMergeReconciler). Runs on the patrol cadence;
	 * owns its own kill-switch + per-project gh budget. Absent → no sweep.
	 */
	externalMergeReconcile?: () => Promise<void>;

	/**
	 * FLY-1099 §4.3: the deferred-approval rebind pass wiring (plugin injects
	 * the production post-write hook + canonical founder id resolver — the SAME
	 * ones the live text path uses, so the rebind can never drift into a
	 * different authorization chain). Absent → rebind pass disabled.
	 */
	deferredRebind?: {
		canonicalFounderId(): string | undefined;
		onResponseWritten?: DeferredRebindDeps["onResponseWritten"];
	};
	/** FLY-1238: one shared last-mile guard for all recovery surfaces. */
	mergedGateGuard?: MergedGateGuard;

	/**
	 * FLY-799: the flag-gated founder ✅-reaction ship-approval callback (built in
	 * plugin.ts via makeFounderReactionApprovalCallback). Called per pending
	 * approve_to_ship gate; on a founder ✅ on the bound gate message it writes the
	 * approve_to_ship response. Absent → no reaction pass (text path unchanged).
	 */
	tryFounderReactionApproval?: (args: {
		gate: {
			questionId: string;
			executionId: string;
			checkpoint: string | null;
			createdAtMs: number;
		};
		ctx: { issueId: string; threadId: string; projectName: string };
		db: CommDB;
		reactionFetcherImpl: ReactionFetcher;
	}) => Promise<{ handled: string[]; retrySafe: boolean } | null>;

	// ── FLY-637-ext: lead-pending escalation ──
	/**
	 * Sink for the final "page Annie" fallback when the Lead has ignored a
	 * runner's blocking `question` gate for `pageAnnieRounds` backoff nudges.
	 * Absent → the page step is a no-op (the lead-nudges still fire). The
	 * LeadAlertNotifier satisfies this (FLY-182-hardened: queues on failure,
	 * never throws).
	 */
	leadAlertSink?: UnhandledAlertSink;
	/** FLY-637-ext: prune cadence for lead_pending_escalation in poll ticks (default 20 ≈ 60s). */
	leadPendingPruneEveryNTicks?: number;

	// ── FLY-725: founder milestone report ──
	/**
	 * Per-project founder milestone-report config, loaded from each project's
	 * CANONICAL root (see founder-milestone-config-source.ts). Absent map / entry
	 * / enabled:false → the patrol no-ops for that project (byte-compatible).
	 */
	founderMilestoneReportByProject?: Map<
		string,
		FounderMilestoneReportConfig | undefined
	>;
	/**
	 * Boot timestamp captured BEFORE `app.listen()` — the first-enablement baseline
	 * cutoff (Codex R2 #1). Terminal sessions with `last_activity_at <= cutoff`
	 * (pre-boot history) are marker-seeded (not pinged) on the first patrol; those
	 * arriving after the cutoff still ping. Consumed only during first-enable
	 * seeding; later boots (baseline marker present) ignore it. Absent → Date.now().
	 */
	founderMilestoneBaselineCutoffMs?: number;
	/** FLY-725: patrol cadence in poll ticks (default 20 ≈ 60s at 3s). */
	milestonePatrolEveryNTicks?: number;
	/** FLY-725: lookback window (hours) bounding the terminal-session scan (default 24). */
	founderMilestoneLookbackHours?: number;
	/** FLY-725: grace (ms) since the terminal transition before pinging (default 90s). */
	founderMilestoneGraceMs?: number;
}

/** The black-hole recipient name (stock claude-code lead convention). */
const MISROUTE_AGENT_NAME = "team-lead";
const DEFAULT_PATROL_EVERY_N_TICKS = 20;
const DEFAULT_BACKLOG_THRESHOLD = 10;
// FLY-307 B: per-lead circuit breaker defaults.
const DEFAULT_CIRCUIT_THRESHOLD = 3;
const DEFAULT_CIRCUIT_COOLDOWN_TICKS = 20;
// FLY-307 A: backoff before retrying a failed stale-gate eviction write.
const DEFAULT_EVICTION_RETRY_TICKS = 20;

const MISROUTE_HINT =
	"Reply to the Runner via `flywheel-comm send` (NOT SendMessage). " +
	"The Runner may be on a pre-FLY-208 prompt that doesn't know the report-back protocol.";

function sha16(input: string): string {
	return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/** FLY-725: parse a strictly-positive int env, else fall back. */
function positiveIntEnv(raw: string | undefined, fallback: number): number {
	const n = Number.parseInt(raw ?? "", 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** FLY-725: parse a non-negative int env (0 allowed, e.g. grace=0 = immediate). */
function nonNegativeIntEnv(raw: string | undefined, fallback: number): number {
	const n = Number.parseInt(raw ?? "", 10);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

interface PendingQuestion {
	id: string;
	from_agent: string;
	content: string;
	created_at: string;
	checkpoint: string | null;
	content_type: string;
	content_ref: string | null;
	/** FLY-1041: 'report' = runner status report (`ask --report`). */
	kind?: string | null;
}

/** Codex code R4 HIGH: one latched/immediate founder-reply dead-letter. */
interface FounderReplyDeadLetterArgs {
	ctx: FounderReplyThreadCtx;
	msgId: string;
	executionId: string;
	stage: string;
	reason: string;
	contentExcerpt: string;
	attempts: number;
	nowMs: number;
}

const ACTIVE_SESSION_STATUSES = new Set([
	"running",
	"awaiting_review",
	"approved_to_ship",
]);

/**
 * FLY-1041 Fix A (sweeper judgement, pure). A pending approve_to_ship gate is
 * SUPERSEDED when its session has re-bound to a DIFFERENT question whose row
 * was created STRICTLY later — the founder must only ever see ONE bindable
 * ship gate.
 *
 * ACCEPTED CONSERVATIVE TRADEOFF (Codex R1 #5): this sweeper is a backstop,
 * not a completeness guarantee. Under a same-second re-fire (SQLite
 * `created_at` has 1s resolution) where the main event-route retire ALSO
 * failed, the old gate stays pending until its TTL — safe side: noise over a
 * false kill of the founder's only bindable gate. The main path (event-route)
 * retires by EXACT qid and is unaffected by same-second timing. Do NOT widen
 * the comparison to `>=`.
 */
export function isSupersededShipGate(
	q: { id: string; checkpoint: string | null; created_at: string },
	session: { review_question_id?: string | null },
	boundQuestion: { created_at: string } | undefined,
): boolean {
	if (q.checkpoint !== "approve_to_ship") return false;
	const boundQid = session.review_question_id;
	if (!boundQid || boundQid === REVIEW_BINDING_UNBOUND || boundQid === q.id) {
		return false;
	}
	if (!boundQuestion) return false;
	const boundMs = parseSqliteUtcMs(boundQuestion.created_at);
	const qMs = parseSqliteUtcMs(q.created_at);
	if (boundMs === null || qMs === null) return false;
	return boundMs > qMs;
}

/**
 * Codex code R4 HIGH: founder-reply pass health (pure, testable). Unhealthy
 * when EVERY scanned thread failed (read/process/exception — the broken-
 * StateStore shape fails every scan as process_failed, never read_failed),
 * OR while ANY dead-letter write is still latched (its recovery anchor is
 * in-memory only, so the pass-dead episode must stay alive until it lands).
 */
export function computeFounderPassHealthy(
	scanned: number,
	failedScans: number,
	pendingDeadLetters: number,
): boolean {
	if (pendingDeadLetters > 0) return false;
	return scanned === 0 || failedScans < scanned;
}

export class GatePoller {
	private timerHandle: ReturnType<typeof setInterval> | null = null;
	private polling = false;
	// FLY-1099 §7.2: founder-reply health watchdog + its per-thread routing map
	// (refreshed by every deliver pass; unknown threads fall back to the infra
	// owner route).
	private readonly founderReplyWatchdog: FounderReplyWatchdog;
	private readonly founderThreadRoutes = new Map<
		string,
		{ leadId: string; projectName: string; issueId?: string }
	>();

	constructor(private config: GatePollerConfig) {
		this.founderReplyWatchdog = new FounderReplyWatchdog({
			store: config.store,
			alertSink: config.leadAlertSink,
			resolveThreadRoute: (threadId) => this.founderThreadRoutes.get(threadId),
			infraRoute: () => this.infraAlertRoute(),
		});
	}

	/**
	 * FLY-1099 §7.2: pass-level alert routing — the unified infra alert owner:
	 * the `flywheel` project's first lead when present, else the first
	 * configured (project, lead) pair.
	 */
	private infraAlertRoute():
		| { leadId: string; projectName: string }
		| undefined {
		const projects = this.config.projects;
		const infra =
			projects.find((p) => p.projectName === "flywheel") ??
			projects.find((p) => p.leads.length > 0);
		const lead = infra?.leads[0];
		if (!infra || !lead) return undefined;
		return { leadId: lead.agentId, projectName: infra.projectName };
	}

	start(): void {
		if (this.timerHandle) return;
		// FLY-639: guard the timer callback so an async poll() that somehow rejects
		// can never become an unhandled rejection that exits the Bridge. poll()'s
		// internals are already wrapped (per-lead + founder-reply try/catch), this
		// is belt-and-suspenders for any scaffolding throw above those.
		this.timerHandle = setInterval(() => {
			// FLY-1099 §7.2 (Codex R1 #5): the pass-dead HANG check lives in the
			// interval callback's OUTERMOST layer — a pass hung inside poll()
			// leaves `polling` true forever, so poll() itself would never observe
			// it; this cheap clock check still runs every tick.
			try {
				this.founderReplyWatchdog.checkHang(Date.now());
			} catch {
				/* the watchdog must never break the poll loop */
			}
			void this.poll().catch((err) => {
				console.error(
					"[GatePoller] unexpected poll rejection (contained, Bridge stays up):",
					err instanceof Error ? err.message : String(err),
				);
			});
		}, this.config.pollIntervalMs);
		console.log(
			`[GatePoller] Started (interval: ${this.config.pollIntervalMs}ms)`,
		);
	}

	/**
	 * FLY-639: best-effort StateStore self-heal hook. A poll error may be a sql.js
	 * corruption ("no such table" / "null function …"); ask the store to rebuild
	 * itself from the last persisted image so the next lead/cycle is healthy. The
	 * store's own throttle ensures one corruption episode triggers at most one
	 * rebuild even though several leads in a tick may each land here.
	 */
	private maybeRecoverStore(err: unknown): void {
		if (typeof this.config.store.recoverFromCorruption === "function") {
			this.config.store.recoverFromCorruption(err);
		}
	}

	stop(): void {
		if (this.timerHandle) {
			clearInterval(this.timerHandle);
			this.timerHandle = null;
			console.log("[GatePoller] Stopped");
		}
	}

	private async poll(): Promise<void> {
		if (this.polling) return;
		this.polling = true;
		try {
			// FLY-208 A2: patrol cadence — piggybacks on this existing tick
			// (zero new periodic timers, FLY-169/172 discipline). Misrouted
			// reports are a minutes-scale human-loop event; every Nth tick
			// (default 20 ≈ 60s at the production 3s interval) is plenty.
			this.tickCount++;

			// FLY-513: global-codex drift probe — piggybacks this same tick (zero
			// new periodic timer). Runs OUTSIDE the (project,lead) loops, fully
			// isolated (its own catch), and must not touch StateStore/CommDB. The
			// alert debounce lives in the callback's MetaAlertNotifier, so a
			// stuck-bad state pages at most once per debounce window.
			// Codex code-review R1 LOW: `(tickCount - 1) % n === 0` fires on tick 1
			// then every n — and unlike `tickCount % n === 1` it also works for n=1
			// (every tick), so a clamped/low cadence never silently disables the probe.
			if (
				this.config.onHealthTick &&
				(this.tickCount - 1) % this.healthCheckEveryNTicks() === 0
			) {
				void Promise.resolve()
					.then(() => this.config.onHealthTick?.())
					.catch((err) =>
						console.warn(
							`[GatePoller] FLY-513 codex-health probe error (non-fatal): ${(err as Error).message}`,
						),
					);
			}

			// FLY-1048 (PR-C): detection-escalation reconcile — same piggyback
			// pattern (zero new timer, own catch, never blocks the poll). The
			// grace timer it advances is read from the durable
			// detection_escalations rows, so a missed tick can only delay a page,
			// never restart the clock. Cadence 0 → disabled.
			{
				const detectionCadence = this.detectionReconcileEveryNTicks();
				if (
					this.config.onDetectionReconcileTick &&
					detectionCadence > 0 &&
					(this.tickCount - 1) % detectionCadence === 0
				) {
					void Promise.resolve()
						.then(() => this.config.onDetectionReconcileTick?.())
						.catch((err) =>
							console.warn(
								`[GatePoller] FLY-1048 detection reconcile error (non-fatal): ${(err as Error).message}`,
							),
						);
				}
			}

			// FLY-907: issue-display reconcile sweep — same piggyback pattern as
			// the FLY-513 health probe above (zero new timer, own catch, never
			// blocks the poll). Cadence 0 → disabled.
			{
				const displayCadence = this.displayReconcileEveryNTicks();
				if (
					this.config.onDisplayReconcileTick &&
					displayCadence > 0 &&
					(this.tickCount - 1) % displayCadence === 0
				) {
					void Promise.resolve()
						.then(() => this.config.onDisplayReconcileTick?.())
						.catch((err) =>
							console.warn(
								`[GatePoller] FLY-907 display-reconcile sweep error (non-fatal): ${(err as Error).message}`,
							),
						);
				}
			}

			// FLY-1048 (A6): cheap gap/state scan — same piggyback pattern as the
			// FLY-513 health probe above (zero new timer, own catch, never blocks
			// the poll). Cadence default 100 ticks ≈ 5min at the production 3s
			// interval; `(tickCount - 1) % n === 0` fires on tick 1 and works for
			// n=1 (FLY-513 Codex R1 LOW precedent).
			if (
				this.config.onGapScanTick &&
				(this.tickCount - 1) % this.gapScanEveryNTicks() === 0
			) {
				void Promise.resolve()
					.then(() => this.config.onGapScanTick?.())
					.catch((err) =>
						console.warn(
							`[GatePoller] FLY-1048 gap-scan tick error (non-fatal): ${(err as Error).message}`,
						),
					);
			}

			const patrolDue =
				this.misroutePatrolEnabled() &&
				this.tickCount % this.patrolEveryNTicks() === 1;

			// FLY-637-ext: accumulate the active blocking-question gate ids seen this
			// poll so the lead_pending_escalation table can be pruned of answered/gone
			// questions. `leadPendingPollComplete` goes false if ANY lead's poll was
			// skipped (open circuit) or threw — the prune only runs on a complete
			// picture, so a transiently-unread lead never loses its backoff state.
			const seenLeadPendingQids = new Set<string>();
			let leadPendingPollComplete = true;

			// FLY-161: iterate (project, lead) pairs directly instead of starting
			// from getActiveSessions(). This lets runner_question survive Runner
			// completion — a question whose source session has transitioned to
			// `completed` would have been dropped by the old active-session-first
			// loop. The session is still resolved per-question below for metadata,
			// but presence in the active set is no longer a prerequisite.
			for (const project of this.config.projects) {
				for (const lead of project.leads) {
					const leadKey = `${project.projectName}::${lead.agentId}`;
					// FLY-307 B: while a lead's circuit is open, skip BOTH the
					// question-relay duty AND the misroute patrol for that lead — the
					// patrol also touches sql.js StateStore (deliverMisrouteEvent), so
					// skipping only the relay would not fully isolate a poisoned WASM
					// heap. `tickCount` still advances once per poll (above).
					if (this.circuitEnabled() && this.circuitOpen(leadKey)) {
						leadPendingPollComplete = false; // FLY-637-ext: incomplete view → skip prune
						continue;
					}
					const dbPath = defaultGetCommDbPath(project.projectName);
					let relayFailed = false;
					try {
						const pending = this.getPendingQuestions(
							dbPath,
							lead.agentId,
							() => {
								// FLY-637-ext: genuine comm.db read failure ⇒ incomplete view ⇒ skip prune.
								leadPendingPollComplete = false;
							},
						);
						for (const question of pending) {
							// FLY-307 A: short-circuit stale gates BEFORE the sql.js
							// getSession() touch — that WASM op is the exact churn this
							// fix removes. Only gate_questions (checkpoint != null) are
							// ever evicted; runner_questions fall through untouched.
							if (question.checkpoint != null) {
								if (this.evictedGateIds.has(question.id)) continue;
								const retryAt = this.evictionRetryAt.get(question.id);
								if (retryAt !== undefined) {
									// A prior eviction write failed. Suppress until the retry
									// tick, then retry the cleanup write WITHOUT a getSession()
									// touch (we already know it's a terminal stale gate).
									if (this.tickCount < retryAt) continue;
									this.evictTerminalGateQuestion(question, dbPath);
									continue;
								}
							}
							const session = this.config.store.getSession(question.from_agent);
							if (!session) {
								// Orphan question — from_agent references no known session.
								// Skip rather than throw; Lead can still pick it up manually
								// via `flywheel-comm pending`. (Codex R1 Issue 1.)
								console.warn(
									`[GatePoller] orphan question — no session for from_agent=${question.from_agent} (qid=${question.id}, lead=${lead.agentId})`,
								);
								continue;
							}
							// FLY-1041 Fix A (sweeper): a superseded ship gate is retired +
							// skipped BEFORE any founder surface — runs even for a held
							// session (a zombie gate on a held session must still die).
							if (
								this.maybeSweepSupersededShipGate(question, session, dbPath)
							) {
								continue;
							}
							// FLY-579: QA-held — do NOT surface the parent's approve_to_ship
							// gate to the Lead/founder until QA is green. Skip BOTH the relay
							// and the founder-thread fallback, and do NOT evict (the question
							// must survive so it can be surfaced once QA passes; verify-approval
							// remains bound to it). Same isQaHeld predicate as event-route +
							// HeartbeatService so the three surfaces cannot drift.
							if (
								question.checkpoint === "approve_to_ship" &&
								isReviewHeld(this.config.store, session)
							) {
								continue;
							}
							// FLY-605 Part A (Codex R2 #3): relayToLead and the founder-thread
							// fallback get SEPARATE try/catch so a Lead-runtime throw from the
							// relay never prevents the post-grace fallback for this question.
							try {
								await this.relayToLead(lead, session, question, dbPath);
							} catch (relayErr) {
								relayFailed = true;
								console.warn(
									`[GatePoller] relayToLead threw for ${lead.agentId} (qid=${question.id}):`,
									relayErr instanceof Error
										? relayErr.message
										: String(relayErr),
								);
								// FLY-639 (Codex code R1 HIGH): relayToLead touches StateStore (isLeadEventDelivered / appendLeadEvent / markLeadEventDelivered / recordDeliveryFailure) — self-heal on corruption (relayFailed already set keeps FLY-307 circuit semantics).
								this.maybeRecoverStore(relayErr);
							}
							try {
								await this.maybeEmitFounderThreadFallback(
									lead,
									session,
									question,
									dbPath,
								);
							} catch (fbErr) {
								console.warn(
									`[GatePoller] founder-thread fallback error for ${lead.agentId} (qid=${question.id}):`,
									fbErr instanceof Error ? fbErr.message : String(fbErr),
								);
								// FLY-639 (Codex code R1 HIGH): maybeEmitFounderThreadFallback touches StateStore (getEventsByExecution / getChatThreadByIssue / emitFounderThreadNotification) — self-heal on corruption.
								this.maybeRecoverStore(fbErr);
							}
							// FLY-637-ext: the lead-pending nudge — sibling of the founder
							// fallback. A BLOCKING `question` gate the Lead hasn't answered →
							// exponential-backoff nudge → page Annie. Count the question as
							// seen (for the prune) BEFORE the call so a throw can't drop it.
							if (question.checkpoint === "question") {
								seenLeadPendingQids.add(question.id);
								try {
									await this.maybeEmitLeadPendingNudge(lead, session, question);
								} catch (lpErr) {
									console.warn(
										`[GatePoller] lead-pending nudge error for ${lead.agentId} (qid=${question.id}):`,
										lpErr instanceof Error ? lpErr.message : String(lpErr),
									);
									this.maybeRecoverStore(lpErr);
								}
							}
							// FLY-927 (Task 3.2, Watchdog v2): the checkpoint-park 1h patrol —
							// third sibling, own try/catch, kill-switch default OFF.
							try {
								await this.maybeEmitCheckpointParkAlert(
									lead,
									session,
									question,
									dbPath,
								);
							} catch (cpErr) {
								console.warn(
									`[GatePoller] checkpoint-park patrol error for ${lead.agentId} (qid=${question.id}):`,
									cpErr instanceof Error ? cpErr.message : String(cpErr),
								);
								this.maybeRecoverStore(cpErr);
							}
						}
						// FLY-307 B: a clean pass closes the circuit; a relay throw counts as
						// a failure (preserves the pre-FLY-605 break-on-throw circuit semantics
						// while letting the founder-thread fallback still run — Codex R2 #3).
						if (this.circuitEnabled()) {
							if (relayFailed) this.recordCircuitFailure(leadKey);
							else this.recordCircuitSuccess(leadKey);
						}
					} catch (err) {
						relayFailed = true;
						leadPendingPollComplete = false; // FLY-637-ext: incomplete view → skip prune
						console.warn(
							`[GatePoller] Error polling ${lead.agentId}:`,
							err instanceof Error ? err.message : String(err),
						);
						// FLY-307 B: count the failed poll even if earlier questions in
						// this iteration were delivered (no reset-on-partial-delivery).
						if (this.circuitEnabled()) this.recordCircuitFailure(leadKey);
						// FLY-639: a sql.js corruption thrown by getSession/getPendingQuestions
						// here is contained by this catch (no Bridge crash). Attempt a
						// best-effort StateStore self-heal so the next lead/cycle is healthy.
						// Complementary to the FLY-307 circuit: circuit isolates the poisoned
						// path, recover repairs the underlying store.
						this.maybeRecoverStore(err);
					}

					// FLY-208 A2: black-hole inbox patrol — fully isolated from
					// the question-relay main duty (own try/catch; any error is
					// a warn + skip, never a poll abort). FLY-307 B: a relay failure
					// (which may have just opened the circuit) skips the patrol for
					// this lead too — the patrol also touches sql.js StateStore, so
					// running it after the failure would not isolate a poisoned heap.
					if (patrolDue && !relayFailed) {
						try {
							await this.misroutePatrol(project, lead);
						} catch (err) {
							console.warn(
								`[GatePoller] misroute patrol error for ${lead.agentId}:`,
								err instanceof Error ? err.message : String(err),
							);
							// FLY-639 (Codex code R1 HIGH): misroutePatrol → deliverMisrouteEvent touches StateStore (isLeadEventDelivered / appendLeadEvent / markLeadEventDelivered / recordDeliveryFailure) — self-heal on corruption.
							this.maybeRecoverStore(err);
						}
					}
				}

				// FLY-725: founder milestone-report patrol — per-project (NOT
				// per-lead), cadence-gated, fully isolated (own catch → warn + skip,
				// never a poll abort). Zero new timer (piggybacks this tick). Pushes
				// one @founder ping to the issue thread when a Runner reached a
				// terminal milestone the founder was never told about.
				if (
					this.founderMilestoneNotifyEnabled() &&
					this.tickCount % this.milestonePatrolEveryNTicks() === 1
				) {
					try {
						await this.maybeEmitMilestoneReports(project);
					} catch (err) {
						console.warn(
							`[GatePoller] milestone patrol error for ${project.projectName}:`,
							err instanceof Error ? err.message : String(err),
						);
						// FLY-639: touches StateStore (getRecentTerminalSessionsForNotify /
						// getEventsByExecution / getChatThreadByIssue / insertEvent).
						this.maybeRecoverStore(err);
					}
				}
			}

			// FLY-637-ext: prune lead_pending_escalation of answered/gone question
			// gates on a slow sub-cadence — ONLY when the active-set view is complete
			// (no open circuit / failed poll this tick), so a transiently-unread lead
			// never loses its backoff state. Empty seen-set ⇒ clear all.
			if (
				leadPendingEscalationEnabled() &&
				leadPendingPollComplete &&
				this.tickCount % this.leadPendingPruneEveryNTicks() === 1
			) {
				try {
					this.config.store.pruneLeadPendingEscalationNotIn([
						...seenLeadPendingQids,
					]);
				} catch (err) {
					console.warn(
						"[GatePoller] lead-pending prune error:",
						err instanceof Error ? err.message : String(err),
					);
					this.maybeRecoverStore(err);
				}
			}

			// FLY-605 Part B: founder-reply inbound auto-delivery on a slow
			// sub-cadence (~60s). Piggybacks this tick (zero new timer); fully
			// isolated — its errors never abort the poll loop.
			if (
				this.founderReplyDeliverEnabled() &&
				this.tickCount % this.founderReplyDeliverEveryNTicks() === 1
			) {
				try {
					const healthy = await this.founderReplyDeliverPass();
					// FLY-1099 §7.2: pass health — an all-read-failed pass is NOT a
					// success (Discord ingest is effectively down for every thread).
					if (healthy) this.founderReplyWatchdog.notePassSuccess(Date.now());
					else this.founderReplyWatchdog.notePassFailure(Date.now());
				} catch (err) {
					this.founderReplyWatchdog.notePassFailure(Date.now());
					console.warn(
						"[GatePoller] founder-reply deliver pass error:",
						err instanceof Error ? err.message : String(err),
					);
					// FLY-639: this pass also touches StateStore (getSession /
					// getChatThreadByIssue / appendLeadEvent) — self-heal on corruption.
					this.maybeRecoverStore(err);
				}
			}

			// FLY-1099 §4.3: deferred-approval rebind pass — same sub-cadence,
			// only meaningful while ingest is on (a deferral is captured by the
			// deliver pass; TTL still converges via this pass's own kill-switch
			// checks inside runDeferredApprovalRebindPass).
			if (
				this.config.deferredRebind &&
				this.founderReplyDeliverEnabled() &&
				this.tickCount % this.founderReplyDeliverEveryNTicks() === 1
			) {
				try {
					await this.deferredRebindPass();
				} catch (err) {
					console.warn(
						"[GatePoller] deferred-approval rebind pass error:",
						err instanceof Error ? err.message : String(err),
					);
					this.maybeRecoverStore(err);
				}
			}

			// FLY-1099 §3.3 + §8: founder action-ledger drain — DELIBERATELY
			// outside the FLYWHEEL_FOUNDER_REPLY_DELIVER ingest switch: intents
			// already committed (held notices / nudges / feedback wakes / MUST-
			// DELIVER alerts) still converge when ops turn ingest off.
			if (this.tickCount % this.founderReplyDeliverEveryNTicks() === 1) {
				try {
					await this.founderActionDrainPass();
				} catch (err) {
					console.warn(
						"[GatePoller] founder action-ledger drain error:",
						err instanceof Error ? err.message : String(err),
					);
					this.maybeRecoverStore(err);
				}
				// FLY-1099 §7.2: watchdog detector tick (pin / unreachable / pass-dead
				// latch maintenance) — durable-table driven, cheap.
				try {
					await this.founderReplyWatchdog.tick(Date.now());
				} catch (err) {
					console.warn(
						"[GatePoller] founder-reply watchdog tick error:",
						err instanceof Error ? err.message : String(err),
					);
					this.maybeRecoverStore(err);
				}
			}

			// FLY-1099 §5: zombie gate hygiene on the patrol cadence — Z1 retires
			// gates whose runner is irreversibly gone (three-phase, guarded); Z2
			// (live session, missing CommDB row) feeds the unreachable detector.
			if (this.tickCount % this.patrolEveryNTicks() === 1) {
				try {
					await this.zombieGateHygienePass();
				} catch (err) {
					console.warn(
						"[GatePoller] zombie gate hygiene error:",
						err instanceof Error ? err.message : String(err),
					);
					this.maybeRecoverStore(err);
				}
			}
			// FLY-799: founder ✅-reaction ship approval on the same sub-cadence
			// (piggyback; zero new timer). Only runs when the reaction callback is
			// wired; fully isolated so its errors never abort the poll loop.
			if (
				this.config.tryFounderReactionApproval &&
				this.founderReplyDeliverEnabled() &&
				this.tickCount % this.founderReplyDeliverEveryNTicks() === 1
			) {
				try {
					await this.founderReactionApprovalPass();
				} catch (err) {
					console.warn(
						"[GatePoller] founder-reaction approval pass error:",
						err instanceof Error ? err.message : String(err),
					);
					this.maybeRecoverStore(err);
				}
			}

			// FLY-799 Part B: re-wake sessions stranded in approved_to_ship (a
			// missed self-ship wake). Default-ON kill-switch; same sub-cadence.
			if (
				this.staleShipRewakeEnabled() &&
				this.tickCount % this.founderReplyDeliverEveryNTicks() === 1
			) {
				try {
					await this.staleApprovedShipReconcilePass();
				} catch (err) {
					console.warn(
						"[GatePoller] stale approved_to_ship reconcile error:",
						err instanceof Error ? err.message : String(err),
					);
					this.maybeRecoverStore(err);
				}
			}

			// FLY-945 Fix D: external-merge convergence sweeper on the patrol
			// cadence (zero new timer). The closure (built in plugin.ts) owns its
			// own kill-switch (FLYWHEEL_EXTERNAL_MERGE_RECONCILE=0) and gh budget;
			// fully isolated — its errors never abort the poll loop.
			if (
				this.config.externalMergeReconcile &&
				this.tickCount % this.patrolEveryNTicks() === 1
			) {
				try {
					await this.config.externalMergeReconcile();
				} catch (err) {
					console.warn(
						"[GatePoller] external-merge reconcile error:",
						err instanceof Error ? err.message : String(err),
					);
					this.maybeRecoverStore(err);
				}
			}
		} finally {
			this.polling = false;
		}
	}

	// ── FLY-208 A2: black-hole inbox patrol ─────────────────────────────────

	private tickCount = 0;
	private warnedMissingArchiveDir = false;

	// FLY-307 A: stale gate_question eviction bookkeeping (process-local).
	// `evictedGateIds` = cleanup write succeeded → skip permanently and silently.
	// `evictionRetryAt` = cleanup write failed → suppress getSession()/warnings
	// until tickCount reaches the stored tick, then retry the write.
	private readonly evictedGateIds = new Set<string>();
	private readonly evictionRetryAt = new Map<string, number>();

	// FLY-307 B: per-lead circuit breaker keyed `projectName::agentId`.
	private readonly circuitFailures = new Map<string, number>();
	private readonly circuitCooldownUntil = new Map<string, number>();

	private patrolEveryNTicks(): number {
		return this.config.patrolEveryNTicks ?? DEFAULT_PATROL_EVERY_N_TICKS;
	}

	// FLY-513: cadence for the optional global-codex drift probe (default 20 ≈ 60s).
	private healthCheckEveryNTicks(): number {
		return this.config.healthCheckEveryNTicks ?? DEFAULT_PATROL_EVERY_N_TICKS;
	}

	/** FLY-1048 (PR-C): detection-escalation reconcile cadence (default 20 ≈ 60s). */
	private detectionReconcileEveryNTicks(): number {
		return (
			this.config.detectionReconcileEveryNTicks ?? DEFAULT_PATROL_EVERY_N_TICKS
		);
	}

	/** FLY-907: display-reconcile sweep cadence (default 60 ≈ 3min at 3s). */
	private displayReconcileEveryNTicks(): number {
		return this.config.displayReconcileEveryNTicks ?? 60;
	}

	/** FLY-1048 (A6): gap-scan cadence (default 100 ≈ 5min at 3s). */
	private gapScanEveryNTicks(): number {
		return this.config.gapScanEveryNTicks ?? 100;
	}

	private backlogThreshold(): number {
		return this.config.backlogThreshold ?? DEFAULT_BACKLOG_THRESHOLD;
	}

	// ── FLY-307 A: stale gate eviction ──────────────────────────────────────

	private evictionRetryTicks(): number {
		return this.config.evictionRetryTicks ?? DEFAULT_EVICTION_RETRY_TICKS;
	}

	/**
	 * Expire a gate_question whose source session is terminal so
	 * `getPendingQuestions` (filter `expires_at > now`) stops returning it —
	 * the same primitive `gate.ts` uses for timeout cleanup (`resolveGate(qid, 0)`).
	 *
	 * Defense in depth (Codex R1 #6): refuses any `runner_question`
	 * (checkpoint == null) as its first line — `resolveGate()` itself updates any
	 * `type='question'` row by id with no checkpoint guard, and FLY-161 requires
	 * runner_questions to survive session completion. Best-effort: a failed write
	 * is recorded in `evictionRetryAt` for a low-cadence retry rather than a write
	 * storm or a permanent in-memory ignore.
	 */
	private evictTerminalGateQuestion(
		question: PendingQuestion,
		dbPath: string,
	): void {
		if (question.checkpoint == null) return; // FLY-161 boundary
		if (this.evictedGateIds.has(question.id)) return;
		try {
			const db = new CommDB(dbPath);
			try {
				db.resolveGate(question.id, 0); // 0h TTL = expire NOW
			} finally {
				db.close();
			}
			this.evictedGateIds.add(question.id);
			this.evictionRetryAt.delete(question.id);
			console.warn(
				`[GatePoller] evicting stale gate_question qid=${question.id}: source session terminal`,
			);
		} catch (err) {
			this.evictionRetryAt.set(
				question.id,
				this.tickCount + this.evictionRetryTicks(),
			);
			console.warn(
				`[GatePoller] stale gate_question qid=${question.id} eviction write failed (retry in ${this.evictionRetryTicks()} ticks):`,
				err instanceof Error ? err.message : String(err),
			);
		}
	}

	// ── FLY-307 B: per-lead circuit breaker ─────────────────────────────────

	/** ON by default; `FLYWHEEL_GATEPOLLER_CIRCUIT=0` is the explicit bypass. */
	private circuitEnabled(): boolean {
		return process.env.FLYWHEEL_GATEPOLLER_CIRCUIT !== "0";
	}

	private circuitThreshold(): number {
		return this.config.circuitThreshold ?? DEFAULT_CIRCUIT_THRESHOLD;
	}

	private circuitCooldownTicks(): number {
		return this.config.circuitCooldownTicks ?? DEFAULT_CIRCUIT_COOLDOWN_TICKS;
	}

	private circuitOpen(leadKey: string): boolean {
		const until = this.circuitCooldownUntil.get(leadKey);
		return until !== undefined && this.tickCount < until;
	}

	private recordCircuitSuccess(leadKey: string): void {
		this.circuitFailures.delete(leadKey);
		this.circuitCooldownUntil.delete(leadKey);
	}

	private recordCircuitFailure(leadKey: string): void {
		const n = (this.circuitFailures.get(leadKey) ?? 0) + 1;
		this.circuitFailures.set(leadKey, n);
		if (n >= this.circuitThreshold()) {
			this.circuitCooldownUntil.set(
				leadKey,
				this.tickCount + this.circuitCooldownTicks(),
			);
			console.warn(
				`[GatePoller] circuit OPEN for ${leadKey} after ${n} consecutive poll failures; cooling down ${this.circuitCooldownTicks()} ticks`,
			);
		}
	}

	/**
	 * Patrol is ON by default when a transport is wired; `=0` is the explicit
	 * bypass (FLY-193 default-ON precedent). Env read per-poll so tests and
	 * live ops can flip it without a restart.
	 */
	private misroutePatrolEnabled(): boolean {
		if (!this.config.transport) return false;
		if (process.env.FLYWHEEL_MISROUTE_PATROL === "0") return false;
		if (!this.config.misrouteArchiveDir) {
			if (!this.warnedMissingArchiveDir) {
				this.warnedMissingArchiveDir = true;
				console.warn(
					"[GatePoller] misroute patrol disabled: transport wired but misrouteArchiveDir missing (archive-before-ack is mandatory)",
				);
			}
			return false;
		}
		return true;
	}

	/**
	 * Scan `teams/<leadId>/inboxes/team-lead.json` for unread entries — every
	 * one of them is a misrouted message (the recipient "team-lead" does not
	 * exist in Flywheel's lead-named teams; stock SendMessage auto-created the
	 * file and reported success to the sender).
	 *
	 * Semantics (Codex R1 #1/#2/#6):
	 *  - delivery dedupe (isLeadEventDelivered) is DECOUPLED from ack retry: an
	 *    already-delivered event skips re-delivery but its message id still
	 *    joins ackCandidates — otherwise an ack failure would strand the entry
	 *    unread forever behind the dedupe early-return.
	 *  - backlog (> threshold): archive the FULL batch as JSONL BEFORE ack
	 *    (mailbox read-retention pruning may delete acked originals), then one
	 *    aggregate advisory. Aggregate eventId is content-addressed from the
	 *    sorted message dedupe ids — stable across restarts and ack retries;
	 *    the archive filename reuses it so a retry overwrites idempotently.
	 *  - ack only after the advisory was delivered (now or previously);
	 *    delivery failure → recordDeliveryFailure, no ack, retried next patrol.
	 */
	private async misroutePatrol(
		project: ProjectEntry,
		lead: LeadConfig,
	): Promise<void> {
		const transport = this.config.transport;
		const archiveRoot = this.config.misrouteArchiveDir;
		if (!transport || !archiveRoot) return;
		// A lead actually NAMED "team-lead" would make this file its real
		// inbox, not a black hole.
		if (lead.agentId === MISROUTE_AGENT_NAME) return;

		const unread = (
			await transport.readUnread({
				leadName: lead.agentId,
				agentName: MISROUTE_AGENT_NAME,
			})
		).filter((m) => !m.read);
		if (unread.length === 0) return;

		const runtime = this.config.runtimeRegistry.getForLead(lead.agentId);
		const ackCandidates: string[] = [];

		if (unread.length > this.backlogThreshold()) {
			// Aggregate path.
			const sortedIds = unread.map((m) => m.id).sort();
			const aggId = `misroute_agg_${sha16(`${lead.agentId}|${sortedIds.join("|")}`)}`;

			// Archive BEFORE any ack — deterministic filename (= aggId) so an
			// ack-retry pass overwrites instead of duplicating.
			const leadDir = join(archiveRoot, lead.agentId);
			mkdirSync(leadDir, { recursive: true });
			const archivePath = join(leadDir, `${aggId}.jsonl`);
			writeFileSync(
				archivePath,
				`${unread.map((m) => JSON.stringify(m)).join("\n")}\n`,
			);

			const tsRange = unread.map((m) => m.ts).sort((a, b) => a - b);
			const senders = [...new Set(unread.map((m) => m.from))].sort();
			const payload: HookPayload = {
				event_type: "runner_misrouted_report",
				execution_id: "misroute-backlog",
				issue_id: "unknown",
				project_name: project.projectName,
				status: "misrouted_backlog",
				summary:
					`${unread.length} misrouted runner report(s) from [${senders.join(", ")}] ` +
					`between ${new Date(tsRange[0] ?? 0).toISOString()} and ${new Date(tsRange[tsRange.length - 1] ?? 0).toISOString()} — archived, not replayed.`,
				misroute_count: unread.length,
				misroute_archive_path: archivePath,
				misroute_hint: MISROUTE_HINT,
			};
			const delivered = await this.deliverMisrouteEvent(
				lead,
				aggId,
				payload,
				runtime,
			);
			if (delivered) ackCandidates.push(...unread.map((m) => m.id));
		} else {
			// Per-message path.
			for (const m of unread) {
				const eventId = `misroute_${sha16(`${m.id}:${lead.agentId}`)}`;
				const payload: HookPayload = {
					event_type: "runner_misrouted_report",
					execution_id: m.from,
					issue_id: "unknown",
					project_name: project.projectName,
					status: "misrouted_report",
					from_agent: m.from,
					misroute_from: m.from,
					misrouted_at: new Date(m.ts).toISOString(),
					summary: m.content.slice(0, 2000),
					misroute_hint: MISROUTE_HINT,
				};
				const delivered = await this.deliverMisrouteEvent(
					lead,
					eventId,
					payload,
					runtime,
				);
				if (delivered) ackCandidates.push(m.id);
			}
		}

		if (ackCandidates.length > 0) {
			try {
				await transport.ack({
					leadName: lead.agentId,
					agentName: MISROUTE_AGENT_NAME,
					messageIds: ackCandidates,
				});
			} catch (err) {
				// Retried next patrol: the events are already delivered, so the
				// dedupe skips re-delivery but the ids re-enter ackCandidates
				// (delivered-event-still-acks rule above).
				console.warn(
					`[GatePoller] misroute ack failed for ${lead.agentId} (will retry next patrol):`,
					err instanceof Error ? err.message : String(err),
				);
			}
		}
	}

	/**
	 * Deliver one misroute advisory with the relayToLead persistence pattern.
	 * Returns true when the Lead has the event (delivered now OR on a previous
	 * patrol) — the caller acks on either (ack-retry decoupled from delivery
	 * dedupe).
	 */
	private async deliverMisrouteEvent(
		lead: LeadConfig,
		eventId: string,
		payload: HookPayload,
		runtime: ReturnType<RuntimeRegistry["getForLead"]>,
	): Promise<boolean> {
		if (this.config.store.isLeadEventDelivered(lead.agentId, eventId)) {
			return true; // previously delivered — still an ack candidate
		}
		const seq = this.config.store.appendLeadEvent(
			lead.agentId,
			eventId,
			payload.event_type,
			JSON.stringify(payload),
			payload.execution_id,
		);
		if (!runtime) return false;
		const envelope: LeadEventEnvelope = {
			seq,
			event: payload,
			sessionKey: payload.execution_id,
			leadId: lead.agentId,
			timestamp: new Date().toISOString(),
		};
		const result = await runtime.deliver(envelope);
		if (result.delivered) {
			this.config.store.markLeadEventDelivered(seq);
			return true;
		}
		this.config.store.recordDeliveryFailure(
			seq,
			result.error ?? "deliver returned false",
		);
		return false;
	}

	private getPendingQuestions(
		dbPath: string,
		leadId: string,
		onReadFailure?: () => void,
	): PendingQuestion[] {
		let db: CommDB;
		try {
			db = CommDB.openReadonly(dbPath);
		} catch {
			// FLY-637-ext (Codex code R1 #3): distinguish "no comm.db yet" (benign —
			// the project simply has no questions) from a genuine open failure on an
			// EXISTING file (transient lock / corruption). The latter must NOT look
			// like "no active questions" to the lead-pending prune, or it could delete
			// live backoff rows — signal it so the poll skips the prune this tick.
			// Relay behavior is unchanged (still returns [] = skip this lead's relay).
			if (existsSync(dbPath)) onReadFailure?.();
			return [];
		}
		try {
			// FLY-161: return ALL pending questions for this lead — both
			// checkpoint != null (gate_question) and checkpoint == null
			// (runner_question). Branching happens in relayToLead.
			return db.getPendingQuestions(leadId) as PendingQuestion[];
		} finally {
			db.close();
		}
	}

	private async relayToLead(
		lead: LeadConfig,
		session: Session,
		question: PendingQuestion,
		dbPath: string,
	): Promise<void> {
		const isGate = question.checkpoint != null;

		if (isGate) {
			// FLY-62 + FLY-161 R2/R3: preserve pre-FLY-161 gate_question gating.
			// (a) Active-session check: a stale gate from a completed Runner must
			//     not re-notify the Lead. Source: pre-FLY-161 behavior implicit in
			//     the old "start from getActiveSessions()" loop.
			// (b) Lead-scope check: the source session's label-derived Lead must
			//     equal the iteration Lead. Stops a checkpoint with
			//     `to_agent=product-lead` but source session labelled `ops` from
			//     reaching product-lead. Preserves the label-routing precedence
			//     that the brainstorm session decided to keep for gate.
			if (!ACTIVE_SESSION_STATUSES.has(session.status)) {
				// FLY-307 A: a gate from a terminal session can never be answered
				// (the Runner is gone, and the active-session check already withholds
				// delivery), so it would otherwise be re-polled every tick until its
				// 48h TTL. Evict it from CommDB instead of log-skipping forever.
				this.evictTerminalGateQuestion(question, dbPath);
				return;
			}
			let scoped: boolean;
			try {
				scoped = matchesLead(session, lead.agentId, this.config.projects);
			} catch (err) {
				console.warn(
					`[GatePoller] skipping gate_question qid=${question.id}: lead-scope verify error for session ${session.execution_id}: ${(err as Error).message}`,
				);
				return;
			}
			if (!scoped) {
				console.warn(
					`[GatePoller] skipping gate_question qid=${question.id}: source session ${session.execution_id} resolves to a different Lead (current iteration: ${lead.agentId})`,
				);
				return;
			}
		}

		const eventId = isGate ? `gate_${question.id}` : `runner_q_${question.id}`;
		const eventType = isGate ? "gate_question" : "runner_question";

		// Check if already delivered
		if (this.config.store.isLeadEventDelivered(lead.agentId, eventId)) return;

		// Resolve content_ref if needed
		let fullContent = question.content;
		if (question.content_type === "ref" && question.content_ref) {
			fullContent = readContentRef(question.content_ref) ?? question.content;
		}

		const payload: HookPayload = {
			event_type: eventType,
			execution_id: session.execution_id,
			issue_id: session.issue_id,
			issue_identifier: session.issue_identifier,
			project_name: session.project_name,
			status: isGate ? "gate_pending" : "runner_question",
			summary: fullContent,
			question_id: question.id,
			from_agent: question.from_agent,
			comm_db_path: dbPath,
			session_role: session.session_role ?? "main",
		};
		if (isGate) {
			payload.checkpoint = question.checkpoint ?? undefined;
		}

		// FLY-91 + FLY-161: Fill chat_thread_id for Lead thread routing.
		// Both branches use `lead.chatChannel` here — for gate_question the
		// matchesLead check above guarantees source session label resolution
		// equals this iteration Lead, so label-derived chat-thread and
		// target-Lead chat-thread are equivalent. For runner_question we route
		// strictly by `to_agent` (= this iteration Lead), so the target Lead's
		// chatChannel is the correct source.
		if (this.config.chatThreadsEnabled) {
			payload.chat_thread_id = resolveChatThreadId(
				this.config.store,
				session.issue_id,
				lead.chatChannel,
			);
		}

		const seq = this.config.store.appendLeadEvent(
			lead.agentId,
			eventId,
			eventType,
			JSON.stringify(payload),
			session.execution_id,
		);

		// Deliver to Lead via the runtime (CommDB instruction or mailbox).
		const runtime = this.config.runtimeRegistry.getForLead(lead.agentId);
		if (runtime) {
			const envelope: LeadEventEnvelope = {
				seq,
				event: payload,
				sessionKey: session.execution_id,
				leadId: lead.agentId,
				timestamp: new Date().toISOString(),
			};

			const result = await runtime.deliver(envelope);

			if (result.delivered) {
				this.config.store.markLeadEventDelivered(seq);
			} else {
				this.config.store.recordDeliveryFailure(
					seq,
					result.error ?? "deliver returned false",
				);
			}
		}

		// FLY-47/FLY-77: Chat relay removed. Lead receives the event via the
		// configured LeadRuntime (CommDB instruction or mailbox) and relays to
		// Annie in chatChannel using its own Discord identity.
	}

	// ── FLY-605 Part A: in-thread founder fallback (outbound runner→founder) ──

	/**
	 * qid → terminal (posted / permanent / skipped / retry-budget-exhausted):
	 * never notify again this process. Durable cross-restart dedup is the
	 * `founder-thread-notify-<qid>` session_events marker.
	 */
	/**
	 * FLY-605 (Codex code-review #3): in-process processed-through cursor used
	 * for Part B when no file-backed cursor is wired (e.g. commdb/rollback path).
	 * Without it, every sub-cadence would re-scan from the oldest pending question.
	 */
	private readonly defaultReplyCursor = new InMemoryInboundCursorStore();
	private readonly founderNotifyDone = new Set<string>();
	/** qid → transient-failure retry state (TIME budget, not a fast tick count). */
	private readonly founderNotifyRetry = new Map<
		string,
		{ firstFailedAtMs: number; nextAttemptAtMs: number; attempts: number }
	>();
	/**
	 * FLY-799: qid → next allowed reaction-check time. A ✅ needs a Discord
	 * reactions GET per pending ship gate; throttle so we do not hammer the API
	 * every poll tick (ship gates are few + short-lived, so a coarse interval is
	 * plenty). Cleared implicitly as the gate leaves awaiting_review.
	 */
	private readonly founderReactionNextCheck = new Map<string, number>();
	/** FLY-799 Part B: execId → next allowed stale-ship re-wake time. */
	private readonly staleShipRewakeBackoff = new Map<string, number>();
	/** FLY-799 Part B: execIds already dead-alerted (one alert per stranded ship). */
	private readonly staleShipDeadAlerted = new Set<string>();

	// ── FLY-637-ext: lead-pending escalation (sibling of the founder fallback) ──

	private leadPendingPruneEveryNTicks(): number {
		const v = this.config.leadPendingPruneEveryNTicks;
		return v !== undefined && Number.isFinite(v) && v > 0 ? v : 20;
	}

	/**
	 * FLY-637-ext: a runner blocked on a BLOCKING `question` gate the owning Lead
	 * has not answered → exponential-backoff nudge the Lead → after the configured
	 * rounds page Annie ONCE. Only `cp === "question"` reaches here (the caller
	 * gates non-blocking asks + founder-facing checkpoints out). Mirrors the FLY-605
	 * founder fallback: same liveness/scope gate, per-question durable state.
	 *
	 * Persistence ordering (Codex design R1 #5): emit the user-visible event FIRST,
	 * commit the backoff/page row only AFTER it is accepted — so a crash between
	 * the two re-nudges (safe) rather than silently dropping a nudge.
	 */
	private async maybeEmitLeadPendingNudge(
		lead: LeadConfig,
		session: Session,
		question: PendingQuestion,
	): Promise<void> {
		if (!leadPendingEscalationEnabled()) return;
		if (question.checkpoint !== "question") return; // blocking lead-facing only
		if (!ACTIVE_SESSION_STATUSES.has(session.status)) return;
		try {
			if (!matchesLead(session, lead.agentId, this.config.projects)) return;
		} catch {
			return;
		}

		const createdMs = parseSqliteUtcMs(question.created_at);
		if (createdMs === null) return;
		const now = Date.now();
		const stuckKey = computeStuckKey(
			question.id,
			session.session_stage ?? null,
		);
		const prev = this.config.store.getLeadPendingEscalation(
			session.execution_id,
			question.id,
		);
		const action = decideLeadNudge(
			prev,
			stuckKey,
			createdMs,
			now,
			readLeadNudgePolicy(),
		);

		if (action.kind === "wait") return;

		if (action.kind === "reset") {
			// stuck_key changed (external progress) → persist a fresh grace-delayed
			// row so the next nudge waits a full fresh grace (Codex code R1 #2).
			this.config.store.upsertLeadPendingEscalation(
				session.execution_id,
				question.id,
				action.nextRow,
			);
			return;
		}

		if (action.kind === "nudge") {
			const persisted = await this.emitLeadPendingNudge(
				lead,
				session,
				question,
				action.nudgeCount,
				now,
				createdMs,
			);
			if (persisted) {
				this.config.store.upsertLeadPendingEscalation(
					session.execution_id,
					question.id,
					action.nextRow,
				);
			}
			return;
		}

		// page_annie (final fallback). ALWAYS advance the backoff row (so a failed
		// page is re-attempted on a paced cadence, not every tick), but only set
		// paged_annie when the alert was genuinely accepted — otherwise `>=` in the
		// policy retries the page next eligible tick (Codex code R1 #1).
		const accepted = await this.emitLeadPendingUnhandledAlert(
			lead,
			session,
			question,
			action.nextRow.nudge_count,
		);
		this.config.store.upsertLeadPendingEscalation(
			session.execution_id,
			question.id,
			{ ...action.nextRow, paged_annie: accepted },
		);
	}

	/**
	 * Emit the `runner_lead_pending_escalation` nudge to the owning Lead (guardrail
	 * event → reliably retried). Returns true once the event row is persisted to
	 * lead_events (the caller then commits the backoff row). Per-nudge eventId so
	 * each reminder is a distinct, idempotent event.
	 */
	private async emitLeadPendingNudge(
		lead: LeadConfig,
		session: Session,
		question: PendingQuestion,
		nudgeCount: number,
		now: number,
		createdMs: number,
	): Promise<boolean> {
		const eventId = `lead_pending_${question.id}_${nudgeCount}`;
		if (this.config.store.isLeadEventDelivered(lead.agentId, eventId))
			return true;
		const issue = session.issue_identifier ?? session.issue_id;
		const ageMin = Math.round((now - createdMs) / 60_000);
		// FLY-927 (Task 3.3, FLY-912 wording collapse): the nudge leads with the
		// TRUTHFUL park line (authoritative session_stage, ball with the LEAD, the
		// gate's real age) instead of hand-built prose; underivable → an explicit
		// stage未上报 prefix, never a guessed stage name.
		const parkTuple = deriveParkTuple({
			session,
			pendingGates: [{ checkpoint: "question", createdAtMs: createdMs }],
			autoQaActive: false,
			notifiedEvidence: false,
			ownerLeadId: lead.agentId,
			nowMs: now,
		});
		const truthfulLine = parkTuple
			? formatParkAlert(parkTuple, now)
			: `[stage未上报] Runner ${issue} is blocked at a question gate`;
		const payload: HookPayload = {
			event_type: "runner_lead_pending_escalation",
			execution_id: session.execution_id,
			issue_id: session.issue_id,
			issue_identifier: session.issue_identifier,
			project_name: session.project_name,
			status: session.status,
			summary:
				`${truthfulLine} — waiting for YOU to answer, ${ageMin} min, no progress (reminder #${nudgeCount}). ` +
				"Answer it via flywheel-comm respond so the runner can continue.",
			question_id: question.id,
			session_role: session.session_role ?? "main",
		};
		if (this.config.chatThreadsEnabled) {
			payload.chat_thread_id = resolveChatThreadId(
				this.config.store,
				session.issue_id,
				lead.chatChannel,
			);
		}
		const seq = this.config.store.appendLeadEvent(
			lead.agentId,
			eventId,
			"runner_lead_pending_escalation",
			JSON.stringify(payload),
			session.execution_id,
		);
		const runtime = this.config.runtimeRegistry.getForLead(lead.agentId);
		if (runtime) {
			const result = await runtime.deliver({
				seq,
				event: payload,
				sessionKey: session.execution_id,
				leadId: lead.agentId,
				timestamp: new Date().toISOString(),
			});
			if (result.delivered) this.config.store.markLeadEventDelivered(seq);
			else
				this.config.store.recordDeliveryFailure(
					seq,
					result.error ?? "deliver returned false",
				);
		}
		// Persisted to lead_events — the guardrail retry owns redelivery.
		return true;
	}

	/**
	 * Final fallback: page Annie ONCE that the Lead has ignored a runner's blocking
	 * question. DISTINCT alert kind (`runner_lead_pending_unhandled`) with NO
	 * runnerStuck metadata, so the AutoRepairBot never sends the runner a `continue`
	 * (Codex design R1 #3 — the runner is fine, the Lead is unresponsive).
	 *
	 * Returns true ONLY when THIS attempt genuinely sent / queued / DM'd the alert
	 * (Codex code R1 #1 + R2 #1): fail-closed for a missing sink, a skip
	 * (unknown-lead/no-channel/no-token — incl. the late-bound page-Annie holder
	 * before plugin.ts populates it), or a dead-letter — so the caller does NOT mark
	 * `paged_annie` and the `>=` policy re-attempts the page on the next eligible tick.
	 *
	 * `duplicate` is deliberately NOT accepted: `LeadAlertNotifier` writes its dedup
	 * claim BEFORE resolving the channel/token, so a first attempt that then fails
	 * (no-channel / dead-letter) would make a retry with a STABLE eventId report
	 * `duplicate` and falsely look delivered (R2 #1). We instead make the eventId
	 * per-attempt (`…:<nudgeCount>`, which increments every retry), so each retry is
	 * a genuine fresh send and a stale claim can never masquerade as a real page.
	 */
	private async emitLeadPendingUnhandledAlert(
		lead: LeadConfig,
		session: Session,
		question: PendingQuestion,
		nudgeCount: number,
	): Promise<boolean> {
		const sink = this.config.leadAlertSink;
		if (!sink) return false; // not wired → fail-closed, retry next eligible tick
		const issue = session.issue_identifier ?? session.issue_id;
		const result = await sink.alert({
			leadId: lead.agentId,
			projectName: session.project_name,
			eventId: `runner-lead-pending-unhandled:${session.execution_id}:${question.id}:${nudgeCount}`,
			eventType: "runner_lead_pending_unhandled",
			title: `Runner waiting — Lead unresponsive: ${issue}`,
			body:
				`Runner ${issue} (execution ${session.execution_id}) has been blocked waiting on ${lead.agentId} to answer its question, ` +
				`and the Lead has not responded after several reminders. Poke the Lead — the runner itself is fine.`,
			severity: "warning",
			sessionKey: session.execution_id,
		});
		// Only a genuine send/queue/DM on THIS attempt counts as "Annie has it".
		return (
			result.sent === true || result.queued === true || result.dmSent === true
		);
	}

	// ── FLY-927 (Task 3.2, Watchdog v2): checkpoint-park 1h patrol ────────────
	// FLY-912: a session parked at a founder checkpoint for hours with NO
	// delivery evidence means the founder was never told. First response goes to
	// the OWNER (runner mailbox wake + Lead event — the self-heal path: the
	// runner re-verifies/retries its founder notification); only a SECOND full
	// window without evidence pages the founder in the issue's own thread with
	// the truthful park template. Kill-switch FLYWHEEL_CHECKPOINT_WATCHDOG
	// unset ⇒ the whole patrol is off (byte-compat). Piggybacks this poll tick —
	// no new timer (FLY-169).

	private checkpointWatchdogEnabled(): boolean {
		return process.env.FLYWHEEL_CHECKPOINT_WATCHDOG === "1";
	}

	/** FLYWHEEL_CHECKPOINT_STUCK_MS — default 1h (FLY-912: 3h was too slow). */
	private checkpointStuckMs(): number {
		const n = Number(process.env.FLYWHEEL_CHECKPOINT_STUCK_MS);
		return Number.isFinite(n) && n > 0 ? n : 3_600_000;
	}

	private async maybeEmitCheckpointParkAlert(
		lead: LeadConfig,
		session: Session,
		question: PendingQuestion,
		dbPath: string,
	): Promise<void> {
		if (!this.checkpointWatchdogEnabled()) return;
		const cp = question.checkpoint;
		if (cp !== "brainstorm" && cp !== "approve_to_ship") return; // founder parks (v1)
		if (!ACTIVE_SESSION_STATUSES.has(session.status)) return;
		try {
			if (!matchesLead(session, lead.agentId, this.config.projects)) return;
		} catch {
			return;
		}
		const createdMs = parseSqliteUtcMs(question.created_at);
		if (createdMs === null) return;
		const now = Date.now();
		const windowMs = this.checkpointStuckMs();
		if (now - createdMs < windowMs) return;

		const events = this.config.store.getEventsByExecution(session.execution_id);
		// Evidence = a SUCCESSFUL founder-facing delivery audit for THIS gate
		// (the FLY-605 fallback's `founder_thread_notified`). Evidence present ⇒
		// the founder already knows — waiting on her is not "stuck", stay silent.
		const notifiedEvidence = events.some(
			(e) =>
				e.event_type === "founder_thread_notified" &&
				(e.payload as { questionId?: string } | undefined)?.questionId ===
					question.id,
		);
		const tuple = deriveParkTuple({
			session,
			pendingGates: [{ checkpoint: cp, createdAtMs: createdMs }],
			autoQaActive: false,
			notifiedEvidence,
			ownerLeadId: lead.agentId,
			nowMs: now,
		});
		if (!tuple || tuple.party !== "founder" || tuple.notifiedEvidence) return;
		const line = formatParkAlert(tuple, now);

		// ── FIRST window: wake the OWNER (durable marker = once per gate) ──
		const nudgeMarker = `checkpoint-park-nudged-${question.id}`;
		const nudgeRow = events.find((e) => e.event_id === nudgeMarker);
		if (!nudgeRow) {
			const ownerAsk =
				`${line}。第一响给你(owner):校验这个 founder 通知是否真的送达` +
				"(publish-report / gate 通知),失败就重试并上报;修不掉才升级 founder。";
			// Runner mailbox wake — the FLY-912 self-heal (best-effort).
			try {
				const db = new CommDB(dbPath);
				await wakeRunnerMailbox({
					db,
					execId: session.execution_id,
					fromAgent: "bridge",
					content: ownerAsk,
					metadata: {
						kind: "checkpoint_park_nudge",
						questionId: question.id,
					},
				});
			} catch (err) {
				console.warn(
					`[GatePoller] checkpoint-park runner wake failed (${session.execution_id}): ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
			// Lead gets the SAME line via the guardrail lead_events lane.
			try {
				const seq = this.config.store.appendLeadEvent(
					lead.agentId,
					`checkpoint-park-lead-${question.id}`,
					"checkpoint_park_nudge",
					JSON.stringify({
						event_type: "checkpoint_park_nudge",
						execution_id: session.execution_id,
						issue_id: session.issue_id,
						issue_identifier: session.issue_identifier,
						project_name: session.project_name,
						status: session.status,
						summary: ownerAsk,
						question_id: question.id,
						session_role: session.session_role ?? "main",
					}),
					session.execution_id,
				);
				const runtime = this.config.runtimeRegistry.getForLead(lead.agentId);
				if (runtime) {
					const result = await runtime.deliver({
						seq,
						event: {
							event_type: "checkpoint_park_nudge",
							execution_id: session.execution_id,
							issue_id: session.issue_id,
							project_name: session.project_name,
							status: session.status,
							summary: ownerAsk,
						} as HookPayload,
						sessionKey: session.execution_id,
						leadId: lead.agentId,
						timestamp: new Date().toISOString(),
					});
					if (result.delivered) this.config.store.markLeadEventDelivered(seq);
					else
						this.config.store.recordDeliveryFailure(
							seq,
							result.error ?? "deliver returned false",
						);
				}
			} catch (err) {
				console.warn(
					`[GatePoller] checkpoint-park lead nudge failed (${lead.agentId}): ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
			// Durable marker (restart-safe once-per-gate) — carries the nudge time
			// the second-window check reads.
			this.config.store.insertEvent({
				event_id: nudgeMarker,
				execution_id: session.execution_id,
				issue_id: session.issue_id,
				project_name: session.project_name,
				event_type: "checkpoint_park_nudged",
				source: "bridge.gate-poller",
				payload: { questionId: question.id, nudgedAtMs: now, line },
			});
			return;
		}

		// ── SECOND window past the nudge, still no evidence → founder page ──
		const pageMarker = `checkpoint-park-paged-${question.id}`;
		if (events.some((e) => e.event_id === pageMarker)) return;
		const nudgedAtMs =
			(nudgeRow.payload as { nudgedAtMs?: number } | undefined)?.nudgedAtMs ??
			createdMs;
		if (now - nudgedAtMs < windowMs) return;

		const thread = this.config.store.getChatThreadByIssue(
			session.issue_id,
			lead.chatChannel,
		);
		const result = await emitIssueThreadInfraNotification(
			{
				executionId: session.execution_id,
				issueId: session.issue_id,
				issueIdentifier: session.issue_identifier,
				projectName: session.project_name,
				kind: "checkpoint_park",
				content: `🕰️ ${line}\n(owner 第一响已发、一窗内仍无送达证据 → 升级给你。)`,
				mentionUserId: this.config.discordOwnerUserId,
				thread,
				botToken: lead.botToken ?? this.config.discordBotToken,
				// NEVER silent: undeliverable pages ride the existing undelivered
				// escalation (deterministic eventId → claims-deduped across retries).
				onUndeliverable: (reason) =>
					this.escalateFounderThreadUndelivered(
						lead,
						session,
						question,
						`checkpoint-park page undeliverable: ${reason}`,
					),
			},
			{ store: this.config.store, fetchImpl: this.config.fetchImpl },
		);
		// Terminal outcomes write the once-marker; a no_chat_thread skip stays
		// unmarked so the page retries when the thread appears (escalation above
		// already told the Lead lane, deduped).
		if (
			result.kind === "posted" ||
			result.kind === "permanent_failed" ||
			result.kind === "transient_failed"
		) {
			this.config.store.insertEvent({
				event_id: pageMarker,
				execution_id: session.execution_id,
				issue_id: session.issue_id,
				project_name: session.project_name,
				event_type: "checkpoint_park_paged",
				source: "bridge.gate-poller",
				payload: { questionId: question.id, outcome: result.kind, line },
			});
		}
	}

	/** FLY-1041: default-ON kill-switch shared with the event-route retire path. */
	private shipGateRetireEnabled(): boolean {
		return process.env.FLYWHEEL_SHIP_GATE_RETIRE !== "0";
	}

	/**
	 * FLY-1041 Fix A (sweeper): converge a superseded approve_to_ship gate the
	 * event-route retire missed (crash between rebind and retire, manual gate).
	 * Returns true when this gate is superseded → the relay loop `continue`s
	 * (no relay, no founder card) this tick; the retire write is best-effort
	 * (a failure re-tries next tick — the gate stays suppressed either way).
	 * Zero new timer: inlined in the existing relay loop.
	 */
	private maybeSweepSupersededShipGate(
		question: PendingQuestion,
		session: Session,
		dbPath: string,
	): boolean {
		if (!this.shipGateRetireEnabled()) return false;
		if (question.checkpoint !== "approve_to_ship") return false;
		const boundQid = session.review_question_id;
		if (
			!boundQid ||
			boundQid === REVIEW_BINDING_UNBOUND ||
			boundQid === question.id
		) {
			return false;
		}
		let boundQuestion: { created_at: string } | undefined;
		try {
			const rdb = CommDB.openReadonly(dbPath);
			try {
				boundQuestion = rdb.getMessageById(boundQid);
			} finally {
				rdb.close();
			}
		} catch {
			return false; // comm.db unreadable → judge nothing this tick
		}
		if (!isSupersededShipGate(question, session, boundQuestion)) return false;

		try {
			const wdb = new CommDB(dbPath, false);
			let retired = false;
			try {
				retired = wdb.retireShipGate(question.id);
			} finally {
				wdb.close();
			}
			if (retired) {
				// Same event-id prefix as the event-route path → insertEvent's
				// UNIQUE constraint dedupes naturally across both writers.
				this.config.store.insertEvent({
					event_id: `ship-gate-superseded-${question.id}`,
					execution_id: session.execution_id,
					issue_id: session.issue_id,
					project_name: session.project_name,
					event_type: "ship_gate_superseded",
					source: "bridge.gate-poller",
					payload: {
						supersededQid: question.id,
						newQid: boundQid,
						by: "gate-poller-sweeper",
					},
				});
			}
		} catch (err) {
			console.warn(
				`[GatePoller] FLY-1041 sweeper retire failed for ${question.id}: ` +
					`${err instanceof Error ? err.message : String(err)} — retried next tick`,
			);
		}
		return true;
	}

	private founderThreadNotifyEnabled(): boolean {
		return process.env.FLYWHEEL_FOUNDER_THREAD_NOTIFY !== "0";
	}

	private founderThreadGraceMs(): number {
		return this.config.founderThreadNotifyGraceMs ?? 10 * 60_000;
	}

	/** FLY-1041 Chunk 6: default-ON kill-switch for the fast ship card. */
	private shipGateCardEnabled(): boolean {
		return process.env.FLYWHEEL_SHIP_GATE_CARD !== "0";
	}

	/** FLY-1041 Chunk 6: ship-card grace (env > config > 15s default). */
	private shipGateCardGraceMs(): number {
		const env = Number.parseInt(
			process.env.FLYWHEEL_SHIP_GATE_CARD_GRACE_MS ?? "",
			10,
		);
		if (Number.isFinite(env) && env >= 0) return env;
		return this.config.shipGateCardGraceMs ?? 15_000;
	}

	private founderThreadRetryBudgetMs(): number {
		return this.config.founderThreadRetryBudgetMs ?? 45 * 60_000;
	}

	private writeFounderThreadMarker(
		question: PendingQuestion,
		session: Session,
		reason: string,
	): void {
		this.config.store.insertEvent({
			event_id: `founder-thread-notify-${question.id}`,
			execution_id: session.execution_id,
			issue_id: session.issue_id,
			project_name: session.project_name,
			event_type: "founder_thread_notify_done",
			severity: reason === "transient_budget_exhausted" ? "warning" : "info",
			source: "bridge.gate-poller",
			payload: { questionId: question.id, reason },
		});
		this.founderNotifyDone.add(question.id);
		this.founderNotifyRetry.delete(question.id);
	}

	private async maybeEmitFounderThreadFallback(
		lead: LeadConfig,
		session: Session,
		question: PendingQuestion,
		_dbPath: string,
	): Promise<void> {
		if (!this.founderThreadNotifyEnabled()) return;
		if (!this.config.chatThreadsEnabled) return;
		const cp = question.checkpoint;
		if (cp !== "brainstorm" && cp !== "approve_to_ship") return; // v1 scope

		// Same liveness + scope gate as the gate-question relay path.
		if (!ACTIVE_SESSION_STATUSES.has(session.status)) return;
		try {
			if (!matchesLead(session, lead.agentId, this.config.projects)) return;
		} catch {
			return;
		}

		// Grace: the gate must have sat unanswered ≥ grace (= "the Lead dropped it").
		// FLY-1041 Chunk 6: approve_to_ship gets the SHORT ship-card grace — the
		// card is the founder's deterministic approval carrier (reply-to-card /
		// ✅), not a fallback; brainstorm keeps the 10min FLY-605 grace. Hold
		// semantics are untouched: the relay loop's isReviewHeld skip runs before
		// this method, so a held gate never reaches here — the card lands on the
		// first tick after the hold clears.
		const createdMs = parseSqliteUtcMs(question.created_at);
		if (createdMs === null) return;
		const now = Date.now();
		const graceMs =
			cp === "approve_to_ship" && this.shipGateCardEnabled()
				? this.shipGateCardGraceMs()
				: this.founderThreadGraceMs();
		if (now - createdMs < graceMs) return;

		// Dedup: terminal in-process, or a durable marker survived a restart.
		if (this.founderNotifyDone.has(question.id)) return;
		const marker = `founder-thread-notify-${question.id}`;
		if (
			this.config.store
				.getEventsByExecution(session.execution_id)
				.some((e) => e.event_id === marker)
		) {
			this.founderNotifyDone.add(question.id);
			return;
		}

		// Transient backoff: respect the per-qid nextAttemptAt window.
		const retry = this.founderNotifyRetry.get(question.id);
		if (retry && now < retry.nextAttemptAtMs) return;

		// FLY-892 (converge): one issue = one thread — the founder notification goes
		// to the single `(issue, channel)` thread the phase session shares.
		const thread = this.config.store.getChatThreadByIssue(
			session.issue_id,
			lead.chatChannel,
		);
		const botToken = lead.botToken ?? this.config.discordBotToken;
		const ownerUserId = this.config.discordOwnerUserId;

		let summary = question.content;
		if (question.content_type === "ref" && question.content_ref) {
			summary = readContentRef(question.content_ref) ?? question.content;
		}

		// FLY-1238: the ship card is a recovery/reapproval side effect. Re-check
		// GitHub immediately before POST; every non-continue verdict stays silent
		// and deliberately writes no permanent founderNotifyDone marker.
		if (cp === "approve_to_ship" && this.config.mergedGateGuard) {
			const project = this.config.projects.find(
				(candidate) => candidate.projectName === session.project_name,
			);
			const guarded = await this.config.mergedGateGuard({
				executionId: session.execution_id,
				issueId: session.issue_id,
				questionId: question.id,
				projectName: session.project_name,
				projectRoot: project?.projectRoot,
				prNumber: session.pr_number ?? undefined,
				source: "gate_card",
			});
			if (guarded.kind !== "continue") return;
		}

		const result = await emitFounderThreadNotification(
			{
				questionId: question.id,
				checkpoint: cp,
				executionId: session.execution_id,
				issueId: session.issue_id,
				issueIdentifier: session.issue_identifier,
				projectName: session.project_name,
				summary,
				ageMinutes: Math.round((now - createdMs) / 60_000),
				thread,
				botToken,
				ownerUserId,
				// FLY-892 (Step 3): tag which phase session is asking, in the single
				// converged issue thread; "" for a main session (byte-compat).
				phasePrefix: phaseMessageTag(
					session.chat_thread_role,
					session.runner_model,
				),
			},
			{ store: this.config.store, fetchImpl: this.config.fetchImpl },
		);

		// FLY-725 (Annie 2026-07-01): `skipped:no_chat_thread` is TRANSIENT — the
		// issue thread may be created shortly after the gate opens, so retry it
		// within the budget instead of writing a terminal marker that permanently
		// silences the ship-ready ping (the exact "hours of silence" symptom).
		const isTransient =
			result.kind === "transient_failed" ||
			(result.kind === "skipped" && result.skipReason === "no_chat_thread");
		if (isTransient) {
			// TIME budget (Codex R1 #4): keep retrying until the budget elapses or
			// the gate is answered (drops out of pending). Honor Retry-After.
			const prev = retry ?? {
				firstFailedAtMs: now,
				nextAttemptAtMs: now,
				attempts: 0,
			};
			const attempts = prev.attempts + 1;
			if (now - prev.firstFailedAtMs >= this.founderThreadRetryBudgetMs()) {
				// Budget elapsed and the founder was still never pinged → escalate on
				// the alert channel before giving up (never silent).
				await this.escalateFounderThreadUndelivered(
					lead,
					session,
					question,
					"transient_budget_exhausted",
				);
				this.writeFounderThreadMarker(
					question,
					session,
					"transient_budget_exhausted",
				);
				return;
			}
			const backoff = Math.min(
				result.retryAfterMs ?? 30_000 * 2 ** (attempts - 1),
				5 * 60_000,
			);
			this.founderNotifyRetry.set(question.id, {
				firstFailedAtMs: prev.firstFailedAtMs,
				nextAttemptAtMs: now + backoff,
				attempts,
			});
			return;
		}

		// posted → success. permanent_failed / config-skip (no_bot_token / no_owner /
		// bad_owner_id) → the founder ping gave up → escalate on the alert channel so
		// the founder is never silently left in the dark (Annie 2026-07-01), then mark
		// terminal so it does not spin on an unfixable config error.
		if (result.kind !== "posted") {
			await this.escalateFounderThreadUndelivered(
				lead,
				session,
				question,
				result.kind === "skipped"
					? (result.skipReason ?? "skipped")
					: result.kind,
			);
		}

		// FLY-799 A-0b: on a posted approve_to_ship ping, durably bind
		// (questionId, prHeadSha) → the Discord gate message id so the reaction
		// path knows which message to watch for the founder's ✅. Write-once
		// (immutable — a duplicate ping cannot overwrite it). Only for the CURRENT
		// review question of an awaiting_review session with a known pr_head — the
		// exact-one key `selectCurrentBinding` fail-closes on. Best-effort; a write
		// failure must never block the notify marker below.
		if (
			cp === "approve_to_ship" &&
			result.kind === "posted" &&
			result.gateMessageId &&
			thread &&
			session.pr_head_sha &&
			session.status === "awaiting_review" &&
			session.review_question_id === question.id
		) {
			try {
				writeGateMessageBinding(
					this.config.store,
					{
						questionId: question.id,
						executionId: session.execution_id,
						issueId: session.issue_id,
						prHeadSha: session.pr_head_sha,
						threadId: thread.thread_id,
						gateMessageId: result.gateMessageId,
						checkpoint: cp,
						postedAt: new Date(now).toISOString(),
					},
					session.project_name,
				);
			} catch (err) {
				console.warn(
					`[gate-poller] FLY-799 gate-message binding write failed for ${question.id} (non-fatal): ${(err as Error).message}`,
				);
			}
		}

		this.writeFounderThreadMarker(question, session, result.kind);
	}

	/**
	 * FLY-725 (Annie 2026-07-01: "never silently drop"): when the FLY-605 outbound
	 * founder-thread ping for a gate (brainstorm / approve_to_ship ⇒ ship-ready)
	 * could NOT be delivered — a config skip (no bot token / owner / bad owner) or
	 * the transient retry budget elapsed — surface it on the FLY-368 alert channel
	 * so the founder is not left in hours of silence. Reuses the already-wired
	 * `leadAlertSink`; `founder_milestone_undelivered` event type (title
	 * distinguishes gate vs milestone). One alert per undelivered ping — the
	 * terminal marker written alongside stops re-processing.
	 */
	private async escalateFounderThreadUndelivered(
		lead: LeadConfig,
		session: Session,
		question: PendingQuestion,
		reason: string,
	): Promise<void> {
		const sink = this.config.leadAlertSink;
		if (!sink) return;
		const issue = session.issue_identifier ?? session.issue_id;
		const cp = question.checkpoint ?? "gate";
		try {
			await sink.alert({
				leadId: lead.agentId,
				projectName: session.project_name,
				eventId: `founder-thread-undelivered:${session.execution_id}:${question.id}`,
				eventType: "founder_milestone_undelivered",
				title: `Founder ping undelivered — ${issue} (${cp})`,
				body:
					`Bridge could not deliver the ${cp} @founder ping for ${issue} ` +
					`(execution ${session.execution_id}) to its thread — reason: ${reason}. ` +
					"The founder was NOT pinged; check the issue thread / bot token / owner config.",
				severity: "warning",
				sessionKey: session.execution_id,
			});
		} catch (err) {
			console.warn(
				`[GatePoller] founder-thread undelivered-escalation failed for ${issue}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	// ── FLY-725: founder milestone-report patrol (Bridge-primary @founder push) ──

	/** In-process dedup key = `${execution_id}:${status}` (durable marker mirrors it). */
	private readonly milestoneNotifyDone = new Set<string>();
	private readonly milestoneNotifyRetry = new Map<
		string,
		{ firstFailedAtMs: number; nextAttemptAtMs: number; attempts: number }
	>();
	/** Per-process cache: projects whose first-enable baseline was already seeded. */
	private readonly milestoneBaselineSeeded = new Set<string>();

	private founderMilestoneNotifyEnabled(): boolean {
		return process.env.FLYWHEEL_FOUNDER_MILESTONE_NOTIFY !== "0";
	}

	// FLY-725 tuning: config override → env knob → default. The env reads make the
	// cadence / lookback / grace ops-tunable without a config edit (Codex code R1).
	private milestonePatrolEveryNTicks(): number {
		return (
			this.config.milestonePatrolEveryNTicks ??
			positiveIntEnv(
				process.env.FLYWHEEL_FOUNDER_MILESTONE_PATROL_TICKS,
				DEFAULT_PATROL_EVERY_N_TICKS,
			)
		);
	}

	private founderMilestoneLookbackHours(): number {
		return (
			this.config.founderMilestoneLookbackHours ??
			positiveIntEnv(process.env.FLYWHEEL_FOUNDER_MILESTONE_LOOKBACK_HOURS, 24)
		);
	}

	private founderMilestoneGraceMs(): number {
		return (
			this.config.founderMilestoneGraceMs ??
			nonNegativeIntEnv(process.env.FLYWHEEL_FOUNDER_MILESTONE_GRACE_MS, 90_000)
		);
	}

	/**
	 * FLY-725 v1 (B) zero-signal terminal status → milestone kind. `completed` is
	 * NOT mapped — routine completions go to the FLY-727 digest, and ship-ready is
	 * covered by the FLY-605 approve gate ping; only failed/blocked are pushed here.
	 */
	private statusToMilestone(status: string): MilestoneKind | null {
		if (status === "failed") return "failed";
		if (status === "blocked") return "blocked";
		return null;
	}

	/**
	 * FLY-725 ground-truth guard (Annie 2026-07-01): only ping when the session
	 * carries REAL evidence, so a bare/erroneous FSM flip cannot produce a false
	 * @founder ping. failed → needs a real `last_error`; blocked → needs a real
	 * blocked route or an error reason. Until the FSM edge-case bugs FLY-232
	 * (awaiting_review→blocked silent-reject) and FLY-172 (restart mislabels failed)
	 * are fixed (fast-follow), this keeps the ping trustworthy rather than noise.
	 */
	private hasMilestoneGroundTruth(
		session: Session,
		milestone: MilestoneKind,
	): boolean {
		// failed → a real error is the canonical failure signal (a restart-mislabel,
		// FLY-172, carries none → skipped).
		if (milestone === "failed") return !!session.last_error?.trim();
		// blocked → the reason lives in last_error / summary / decision_reasoning
		// (`complete --route blocked --summary "…"`; Codex code R1). Require a REAL
		// reason so every blocked ping carries one — a bare status flip with no
		// route+reason (FLY-232 silent-reject) is skipped, not falsely pinged.
		if (milestone === "blocked")
			return !!(
				session.last_error?.trim() ||
				session.summary?.trim() ||
				session.decision_reasoning?.trim()
			);
		return false;
	}

	private milestoneMarkerId(executionId: string, status: string): string {
		return `founder-milestone-notify-${executionId}-${status}`;
	}

	/** Terminal per-(session, status) marker: posted / permanent / budget-exhausted / baseline. */
	private writeMilestoneMarker(
		session: Session,
		milestone: MilestoneKind,
		reason: string,
	): void {
		const key = `${session.execution_id}:${session.status}`;
		this.config.store.insertEvent({
			event_id: this.milestoneMarkerId(session.execution_id, session.status),
			execution_id: session.execution_id,
			issue_id: session.issue_id,
			project_name: session.project_name,
			event_type: "founder_milestone_notify_done",
			severity: reason === "transient_budget_exhausted" ? "warning" : "info",
			source: "bridge.gate-poller",
			payload: { milestone, reason },
		});
		this.milestoneNotifyDone.add(key);
		this.milestoneNotifyRetry.delete(key);
	}

	private hasMilestoneMarker(executionId: string, status: string): boolean {
		const marker = this.milestoneMarkerId(executionId, status);
		return this.config.store
			.getEventsByExecution(executionId)
			.some((e) => e.event_id === marker);
	}

	/**
	 * Per-project milestone patrol. Pushes ONE @founder-pinged report to the issue
	 * thread for each Runner that reached a terminal milestone (completed/failed/
	 * blocked) the founder wasn't told about. Reuses emitFounderMilestoneNotification
	 * (retry budget) + durable event markers (restart-safe dedup). The first patrol
	 * after this project first enables the feature marker-seeds pre-cutoff history
	 * (no post) then falls through so cutoff-after sessions still ping this pass.
	 */
	private async maybeEmitMilestoneReports(
		project: ProjectEntry,
	): Promise<void> {
		if (!this.config.chatThreadsEnabled) return;
		const cfg = this.config.founderMilestoneReportByProject?.get(
			project.projectName,
		);
		if (!cfg?.enabled) return;
		const milestones =
			cfg.milestones && cfg.milestones.length > 0
				? cfg.milestones
				: [...SUPPORTED_MILESTONE_KINDS_V1];

		const sessions = this.config.store.getRecentTerminalSessionsForNotify(
			project.projectName,
			this.founderMilestoneLookbackHours(),
		);

		// ── First-enable baseline seed (Codex R1 #1 + R2 #1): mark pre-cutoff
		// history as already-notified WITHOUT posting; cutoff-after sessions are
		// NOT seeded so they still ping (this same pass — no early return, R3). ──
		const baselineExecId = `milestone-baseline-${project.projectName}`;
		const baselineMarker = `founder-milestone-baseline-${project.projectName}`;
		const baselineDone =
			this.milestoneBaselineSeeded.has(project.projectName) ||
			this.config.store
				.getEventsByExecution(baselineExecId)
				.some((e) => e.event_id === baselineMarker);
		if (!baselineDone) {
			const cutoff = this.config.founderMilestoneBaselineCutoffMs ?? Date.now();
			for (const s of sessions) {
				const ms = parseSqliteUtcMs(s.last_activity_at ?? null);
				const milestone = this.statusToMilestone(s.status);
				if (milestone && ms !== null && ms <= cutoff) {
					this.writeMilestoneMarker(s, milestone, "baseline_preexisting");
				}
			}
			this.config.store.insertEvent({
				event_id: baselineMarker,
				execution_id: baselineExecId,
				issue_id: "milestone-baseline",
				project_name: project.projectName,
				event_type: "founder_milestone_baseline_seeded",
				source: "bridge.gate-poller",
				payload: { cutoffMs: cutoff },
			});
			this.milestoneBaselineSeeded.add(project.projectName);
		}

		const now = Date.now();
		for (const s of sessions) {
			const milestone = this.statusToMilestone(s.status);
			if (!milestone) continue;
			const dedupKey = `${s.execution_id}:${s.status}`;
			if (this.milestoneNotifyDone.has(dedupKey)) continue;
			if (this.hasMilestoneMarker(s.execution_id, s.status)) {
				this.milestoneNotifyDone.add(dedupKey);
				continue;
			}

			// Locate the owning Lead WITHIN this project (Codex R1 #2: matchesLead is
			// the label/lead guard, NOT the project boundary — the SQL already scoped
			// project_name).
			const lead = project.leads.find((l) => {
				try {
					return matchesLead(s, l.agentId, this.config.projects);
				} catch {
					return false;
				}
			});
			if (!lead) continue;

			const decision = decideMilestoneReport(
				{
					status: s.status,
					session_role: s.session_role,
					lastActivityMs: parseSqliteUtcMs(s.last_activity_at ?? null),
				},
				milestones,
				false,
				now,
				this.founderMilestoneGraceMs(),
			);
			if (decision.kind !== "notify") continue;

			// FLY-725 ground-truth guard: skip (no marker) a bare/erroneous FSM flip
			// with no real evidence — if evidence lands later it can still ping; if it
			// never does, it ages out of the lookback window. Keeps the ping accurate
			// while FLY-232 / FLY-172 (FSM edge-case bugs) are fixed as fast-follow.
			if (!this.hasMilestoneGroundTruth(s, decision.milestone)) continue;

			const retry = this.milestoneNotifyRetry.get(dedupKey);
			if (retry && now < retry.nextAttemptAtMs) continue;

			// FLY-892 (converge): milestone ping goes to the single issue thread.
			const thread = this.config.store.getChatThreadByIssue(
				s.issue_id,
				lead.chatChannel,
			);
			const result = await emitFounderMilestoneNotification(
				{
					executionId: s.execution_id,
					issueId: s.issue_id,
					issueIdentifier: s.issue_identifier,
					issueTitle: s.issue_title,
					projectName: s.project_name,
					milestone: decision.milestone,
					route: s.decision_route,
					prNumber: s.pr_number,
					summary: s.summary,
					lastError: s.last_error,
					decisionReasoning: s.decision_reasoning,
					thread,
					botToken: lead.botToken ?? this.config.discordBotToken,
					ownerUserId: this.config.discordOwnerUserId,
					// FLY-892 (Step 3): tag which phase reached the milestone; "" for main.
					phasePrefix: phaseMessageTag(s.chat_thread_role, s.runner_model),
				},
				{ store: this.config.store, fetchImpl: this.config.fetchImpl },
			);

			if (result.kind === "transient_failed") {
				// Same TIME-budget retry structure as the FLY-605 fallback.
				const prev = retry ?? {
					firstFailedAtMs: now,
					nextAttemptAtMs: now,
					attempts: 0,
				};
				const attempts = prev.attempts + 1;
				if (now - prev.firstFailedAtMs >= this.founderThreadRetryBudgetMs()) {
					// Never silently drop (Annie 2026-07-01): the founder was not pinged
					// after the whole retry budget → surface it on the alert channel.
					await this.escalateMilestoneUndelivered(
						lead,
						s,
						decision.milestone,
						"transient_budget_exhausted",
					);
					this.writeMilestoneMarker(
						s,
						decision.milestone,
						"transient_budget_exhausted",
					);
					continue;
				}
				const backoff = Math.min(
					result.retryAfterMs ?? 30_000 * 2 ** (attempts - 1),
					5 * 60_000,
				);
				this.milestoneNotifyRetry.set(dedupKey, {
					firstFailedAtMs: prev.firstFailedAtMs,
					nextAttemptAtMs: now + backoff,
					attempts,
				});
				continue;
			}

			// posted → success. permanent_failed / skipped → the thread delivery gave
			// up (4xx / missing thread|token|owner), so surface it on the alert channel
			// before marking terminal — a failed/blocked ping is never silently dropped.
			if (result.kind !== "posted") {
				await this.escalateMilestoneUndelivered(
					lead,
					s,
					decision.milestone,
					result.kind,
				);
			}
			this.writeMilestoneMarker(s, decision.milestone, result.kind);
		}
	}

	/**
	 * FLY-725 (Annie 2026-07-01: "never silently drop"): when the thread ping for a
	 * failed/blocked milestone could NOT be delivered (permanent 4xx, missing
	 * thread/token/owner, or the transient retry budget elapsed), surface it on the
	 * FLY-368 unified alert channel so the founder is not left in the dark. Fires
	 * once per undelivered milestone — the terminal marker written alongside stops
	 * re-processing, and the eventId is deterministic for the alert sink's dedup.
	 */
	private async escalateMilestoneUndelivered(
		lead: LeadConfig,
		session: Session,
		milestone: MilestoneKind,
		reason: string,
	): Promise<void> {
		const sink = this.config.leadAlertSink;
		if (!sink) return;
		const issue = session.issue_identifier ?? session.issue_id;
		try {
			await sink.alert({
				leadId: lead.agentId,
				projectName: session.project_name,
				eventId: `founder-milestone-undelivered:${session.execution_id}:${session.status}`,
				eventType: "founder_milestone_undelivered",
				title: `Milestone ping undelivered — ${issue} (${milestone})`,
				body:
					`Bridge could not push the ${milestone} @founder report for ${issue} ` +
					`(execution ${session.execution_id}) to its thread — reason: ${reason}. ` +
					"The founder was NOT pinged; check the issue thread / bot token / owner config.",
				severity: "warning",
				sessionKey: session.execution_id,
			});
		} catch (err) {
			console.warn(
				`[GatePoller] milestone undelivered-escalation failed for ${issue}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	// ── FLY-605 Part B: founder-reply inbound delivery (founder→runner) ──

	private founderReplyDeliverEnabled(): boolean {
		return process.env.FLYWHEEL_FOUNDER_REPLY_DELIVER !== "0";
	}

	private founderReplyDeliverGraceMs(): number {
		return this.config.founderReplyDeliverGraceMs ?? 10 * 60_000;
	}

	/** FLY-945 Fix A: ship-gate grace (env > config > 15s default). */
	private shipGateGraceMs(): number {
		const env = Number.parseInt(
			process.env.FLYWHEEL_SHIP_GATE_GRACE_MS ?? "",
			10,
		);
		if (Number.isFinite(env) && env >= 0) return env;
		return this.config.shipGateGraceMs ?? 15_000;
	}

	/** FLY-945 Fix A: per-checkpoint founder-message grace. */
	private checkpointGraceMsFor(checkpoint: string | null): number {
		return checkpoint === "approve_to_ship"
			? this.shipGateGraceMs()
			: this.founderReplyDeliverGraceMs();
	}

	private founderReplyDeliverEveryNTicks(): number {
		return (
			this.config.founderReplyDeliverEveryNTicks ?? DEFAULT_PATROL_EVERY_N_TICKS
		);
	}

	/**
	 * Per (project, lead): take the past-grace pending questions, group them by
	 * issue thread, and let `emitFounderReplyDeliveryForThread` read each thread
	 * once and auto-deliver / WAKE / hand off as appropriate.
	 *
	 * FLY-1099 §7.2: returns pass HEALTH — false when every scanned thread
	 * failed its Discord read (ingest effectively down), so the watchdog's
	 * pass-dead clock is not fed by hollow "successes".
	 */
	private async founderReplyDeliverPass(): Promise<boolean> {
		if (!this.config.chatThreadsEnabled) return true;
		const ownerUserId = this.config.discordOwnerUserId;
		if (!isDiscordSnowflake(ownerUserId)) return true;
		const graceMs = this.founderReplyDeliverGraceMs();
		const now = Date.now();
		let scanned = 0;
		let failedScans = 0;
		// Codex code R4 HIGH: re-drive any dead-letters whose StateStore write
		// failed on a prior pass BEFORE scanning (the store may have self-healed).
		this.retryPendingDeadLetters();

		for (const project of this.config.projects) {
			for (const lead of project.leads) {
				const botToken = lead.botToken ?? this.config.discordBotToken;
				if (!botToken) continue;
				const dbPath = defaultGetCommDbPath(project.projectName);

				let pending: PendingQuestion[];
				try {
					const db = CommDB.openReadonly(dbPath);
					try {
						pending = db.getPendingQuestions(lead.agentId) as PendingQuestion[];
					} finally {
						db.close();
					}
				} catch {
					continue; // CommDB not present yet
				}

				// Group pending questions by issue thread. FLY-945 Fix A: the old
				// per-question "past 10min grace" pre-filter is REPLACED — every
				// pending question joins its thread group (each carrying its own
				// per-checkpoint grace), and a thread is scanned as soon as ANY of
				// its questions has passed its own threshold. The deliverer matches
				// founder messages against the FULL set (so a reply to a young
				// question is never classified irrelevant and lost), while maturity
				// only decides "process now vs pin the cursor and wait".
				const byThread = new Map<
					string,
					{ ctx: FounderReplyThreadCtx; questions: PendingQuestionForThread[] }
				>();
				for (const q of pending) {
					// FLY-1041 Chunk 9 (Fix D): a runner's `ask --report` status report
					// is NEVER a founder-reply binding candidate — it neither absorbs
					// a founder "ship" nor inflates the ambiguity denominator. This is
					// the ONLY place reports are special-cased: relayToLead, the
					// pending CLI, and liveness all keep treating them as questions.
					if (q.kind === "report") continue;
					const createdMs = parseSqliteUtcMs(q.created_at);
					if (createdMs === null) continue;
					const session = this.config.store.getSession(q.from_agent);
					if (!session) continue;
					// FLY-892 (converge): group founder replies by the single issue
					// thread the from_agent session shares.
					const thread = this.config.store.getChatThreadByIssue(
						session.issue_id,
						lead.chatChannel,
					);
					if (!thread?.thread_id) continue;
					let group = byThread.get(thread.thread_id);
					if (!group) {
						group = {
							ctx: {
								issueId: session.issue_id,
								projectName: project.projectName,
								threadId: thread.thread_id,
								botToken,
								ownerUserId: ownerUserId as string,
								graceMs,
								commDbPath: dbPath,
								leadId: lead.agentId,
							},
							questions: [],
						};
						byThread.set(thread.thread_id, group);
						// FLY-1099 §7.2: refresh the watchdog's per-thread alert route.
						this.founderThreadRoutes.set(thread.thread_id, {
							leadId: lead.agentId,
							projectName: project.projectName,
							issueId: session.issue_identifier ?? session.issue_id,
						});
					}
					group.questions.push({
						questionId: q.id,
						checkpoint: q.checkpoint,
						executionId: q.from_agent,
						createdAtMs: createdMs,
						checkpointGraceMs: this.checkpointGraceMsFor(q.checkpoint),
					});
				}

				const deliverAmbiguousToLead = this.makeAmbiguousHandoff(
					lead,
					project.projectName,
				);
				for (const { ctx, questions } of byThread.values()) {
					// Scan only threads where at least one question passed its own
					// scan threshold (all-young thread → byte-compatible no-scan).
					if (
						!questions.some(
							(q) => now - q.createdAtMs >= (q.checkpointGraceMs ?? graceMs),
						)
					) {
						continue;
					}
					try {
						scanned++;
						const outcome = await emitFounderReplyDeliveryForThread(
							ctx,
							questions,
							{
								store: this.config.store,
								fetchImpl: this.config.fetchImpl,
								cursorStore: this.config.cursorStore ?? this.defaultReplyCursor,
								deliverAmbiguousToLead,
								// FLY-799: founder text approval → gate write (flag-gated; absent → WAKE-only).
								tryFounderShipApproval: this.config.tryFounderShipApproval,
								// FLY-1041 Chunk 7: reply-to-card binding reader.
								readCurrentBinding: this.config.readCurrentBinding,
								// FLY-1099 §7.1: bounded retry + dead-letter.
								retryLedger: this.founderReplyRetryLedger(),
							},
						);
						// Codex code R4 HIGH: process failures count against pass health
						// too — a fully broken StateStore fails every scan as
						// process_failed/exception (never read_failed), and that shape
						// must reach the pass-dead detector.
						if (
							outcome.result === "read_failed" ||
							outcome.result === "process_failed"
						) {
							failedScans++;
						}
					} catch (err) {
						failedScans++;
						console.warn(
							`[GatePoller] founder-reply deliver error (thread=${ctx.threadId}):`,
							err instanceof Error ? err.message : String(err),
						);
						// FLY-639 (Codex code R1 HIGH): per-thread founder-reply delivery touches StateStore (isLeadEventDelivered / appendLeadEvent / markLeadEventDelivered / flush / recordDeliveryFailure) — self-heal on corruption.
						this.maybeRecoverStore(err);
					}
				}
			}
		}
		return computeFounderPassHealthy(
			scanned,
			failedScans,
			this.pendingDeadLetters.size,
		);
	}

	// ── FLY-1099: founder-reply reliability wiring ──────────────────────────

	/** §7.1: FLYWHEEL_FOUNDER_REPLY_RETRY_MAX (default 10). */
	private founderReplyRetryMax(): number {
		return positiveIntEnv(process.env.FLYWHEEL_FOUNDER_REPLY_RETRY_MAX, 10);
	}

	/** §7.1: FLYWHEEL_FOUNDER_REPLY_DEADLETTER_AGE_MS (default 30min). */
	private founderReplyDeadletterAgeMs(): number {
		return positiveIntEnv(
			process.env.FLYWHEEL_FOUNDER_REPLY_DEADLETTER_AGE_MS,
			30 * 60_000,
		);
	}

	/** Parse a session's issue_labels JSON (defensive — never throws). */
	private static parseSessionLabels(raw: string | undefined): string[] {
		if (!raw) return [];
		try {
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed)
				? parsed.filter((x): x is string => typeof x === "string")
				: [];
		} catch {
			return [];
		}
	}

	/**
	 * §7.2: per-session alert routing — the session's label-resolved lead;
	 * infra owner fallback when unresolvable.
	 */
	private resolveAlertRoute(
		projectName: string,
		executionId: string,
	): { leadId: string } | undefined {
		try {
			const session = this.config.store.getSession(executionId);
			const { lead } = resolveLeadForIssue(
				this.config.projects,
				projectName,
				GatePoller.parseSessionLabels(session?.issue_labels),
			);
			return { leadId: lead.agentId };
		} catch {
			const infra = this.infraAlertRoute();
			return infra ? { leadId: infra.leadId } : undefined;
		}
	}

	/** Bot token for a session's thread (lead token → global fallback). */
	private resolveBotTokenFor(
		projectName: string,
		executionId: string,
	): string | undefined {
		try {
			const session = this.config.store.getSession(executionId);
			const { lead } = resolveLeadForIssue(
				this.config.projects,
				projectName,
				GatePoller.parseSessionLabels(session?.issue_labels),
			);
			return lead.botToken ?? this.config.discordBotToken;
		} catch {
			return this.config.discordBotToken;
		}
	}

	private retryLedgerImpl?: FounderReplyRetryLedger;

	/**
	 * Codex code R4 HIGH: the in-memory pending-dead-letter latch — the ONLY
	 * recovery anchor for a message whose response is durable but whose
	 * dead-letter WRITE failed (fully broken StateStore: no retry row, no gate
	 * rematch, nothing durable to scan). Entries are re-driven at the start of
	 * every deliver pass (the FLY-639 self-heal may have repaired the store),
	 * and a NON-EMPTY latch keeps the pass marked UNHEALTHY so the pass-dead
	 * watchdog escalates instead of notePassSuccess silencing the episode.
	 * Honest floor: a Bridge crash drops the latch — with storage fully broken
	 * nothing durable was recordable anywhere; the sustained pass-dead alert
	 * is the human hand-off.
	 */
	private readonly pendingDeadLetters = new Map<
		string,
		FounderReplyDeadLetterArgs
	>();

	/** Re-drive latched dead-letters (the store may have self-healed). */
	private retryPendingDeadLetters(): void {
		if (this.pendingDeadLetters.size === 0) return;
		for (const [key, entry] of this.pendingDeadLetters) {
			try {
				if (
					this.executeFounderReplyDeadLetter({ ...entry, nowMs: Date.now() })
				) {
					this.pendingDeadLetters.delete(key);
					continue;
				}
				// Codex code R5 HIGH: mark returns false ONLY when the row is
				// already dead-lettered (the missing-row case now creates + marks in
				// one transaction) — another path disposed it; the latch is done.
				if (
					this.config.store.getFounderReplyRetry(
						entry.ctx.threadId,
						entry.msgId,
					)?.dead_lettered_at
				) {
					this.pendingDeadLetters.delete(key);
				}
			} catch {
				// still broken — keep the latch (pass stays unhealthy)
			}
		}
	}

	/** The atomic dead-letter transaction (row mark + audit + alert intent). */
	private executeFounderReplyDeadLetter(
		args: FounderReplyDeadLetterArgs,
	): boolean {
		const store = this.config.store;
		const route = this.resolveAlertRoute(
			args.ctx.projectName,
			args.executionId,
		);
		return store.markFounderReplyDeadLettered({
			threadId: args.ctx.threadId,
			msgId: args.msgId,
			nowMs: args.nowMs,
			audit: {
				event_id: `founder-reply-dead-letter-${args.ctx.threadId}-${args.msgId}`,
				execution_id: args.executionId,
				issue_id: args.ctx.issueId,
				project_name: args.ctx.projectName,
				event_type: "founder_reply_dead_letter",
				source: "bridge.gate-poller",
				payload: {
					threadId: args.ctx.threadId,
					msgId: args.msgId,
					stage: args.stage,
					reason: args.reason,
					attempts: args.attempts,
					excerpt: args.contentExcerpt,
				},
			},
			alertIntent: {
				actionKey: `emit-alert-founder-reply-dl-${args.ctx.threadId}-${args.msgId}`,
				kind: "emit_alert",
				executionId: args.executionId,
				issueId: args.ctx.issueId,
				projectName: args.ctx.projectName,
				threadId: args.ctx.threadId,
				payload: {
					alert: {
						leadId: route?.leadId ?? "",
						projectName: args.ctx.projectName,
						// §7.2: durable episode salt = dead_lettered_ms (this nowMs).
						eventId: `founder-reply-dl-${args.msgId}-${args.nowMs}`,
						eventType: "founder_reply_dead_letter",
						title: `Founder reply DEAD-LETTERED — ${args.ctx.issueId}`,
						body:
							`Founder message ${args.msgId} in thread ${args.ctx.threadId}(《${args.contentExcerpt}》)was dead-lettered ` +
							`after ${args.attempts} attempts (last stage ${args.stage}: ${args.reason}). ` +
							"It will NOT be auto-processed — a human must act on it.",
						severity: "warning",
					},
				},
			},
		});
	}

	/**
	 * §7.1: the bounded-retry / dead-letter policy the deliverer drives.
	 * Dead-letter (attempts OR age threshold) is ONE StateStore transaction:
	 * retry-row mark + audit event + must-deliver emit_alert intent — the
	 * message is then DISPOSED (never silently lost: the durable trail exists
	 * before the cursor may pass it).
	 */
	private founderReplyRetryLedger(): FounderReplyRetryLedger {
		if (this.retryLedgerImpl) return this.retryLedgerImpl;
		const store = this.config.store;
		/** Shared atomic dead-letter transaction — see executeFounderReplyDeadLetter. */
		const deadLetter = (args: FounderReplyDeadLetterArgs): boolean =>
			this.executeFounderReplyDeadLetter(args);
		this.retryLedgerImpl = {
			recordFailure: ({
				ctx,
				msgId,
				executionId,
				stage,
				reason,
				contentExcerpt,
			}) => {
				const nowMs = Date.now();
				const row = store.recordFounderReplyFailure({
					threadId: ctx.threadId,
					msgId,
					stage,
					error: reason,
					nowMs,
				});
				if (
					row.attempts < this.founderReplyRetryMax() &&
					nowMs - row.first_seen_ms < this.founderReplyDeadletterAgeMs()
				) {
					return { deadLettered: false };
				}
				return {
					deadLettered: deadLetter({
						ctx,
						msgId,
						executionId,
						stage,
						reason,
						contentExcerpt,
						attempts: row.attempts,
						nowMs,
					}),
				};
			},
			// Codex code R3 HIGH: no bounded lap — an answered gate can never
			// re-match, so the terminal must land NOW (or the cursor pins and the
			// watchdog is the last resort).
			deadLetterNow: ({
				ctx,
				msgId,
				executionId,
				stage,
				reason,
				contentExcerpt,
			}) => {
				const nowMs = Date.now();
				let attempts = 1;
				try {
					attempts = store.recordFounderReplyFailure({
						threadId: ctx.threadId,
						msgId,
						stage,
						error: reason,
						nowMs,
					}).attempts;
				} catch {
					/* the row is bookkeeping; the DL transaction below is the terminal */
				}
				const dlArgs = {
					ctx,
					msgId,
					executionId,
					stage,
					reason,
					contentExcerpt,
					attempts,
					nowMs,
				};
				try {
					const deadLettered = deadLetter(dlArgs);
					if (deadLettered) return { deadLettered: true };
					// mark returned false: already dead-lettered → disposed; else the
					// row could not be written → LATCH (R4 HIGH recovery anchor).
					if (
						store.getFounderReplyRetry(ctx.threadId, msgId)?.dead_lettered_at
					) {
						return { deadLettered: true };
					}
					this.pendingDeadLetters.set(`${ctx.threadId}:${msgId}`, dlArgs);
					return { deadLettered: false };
				} catch {
					this.pendingDeadLetters.set(`${ctx.threadId}:${msgId}`, dlArgs);
					return { deadLettered: false };
				}
			},
			isDeadLettered: (threadId, msgId) =>
				!!store.getFounderReplyRetry(threadId, msgId)?.dead_lettered_at,
			clear: (threadId, msgId) => store.clearFounderReplyRetry(threadId, msgId),
			clearUpTo: (threadId, msgIdInclusive) => {
				store.clearFounderReplyRetriesUpTo(threadId, msgIdInclusive);
			},
		};
		return this.retryLedgerImpl;
	}

	/** §4.3: the deferred-approval rebind pass (same authorization chain). */
	private async deferredRebindPass(): Promise<void> {
		const rebind = this.config.deferredRebind;
		if (!rebind) return;
		await runDeferredApprovalRebindPass({
			store: this.config.store,
			canonicalFounderId: rebind.canonicalFounderId,
			holdReasonFor: (execId) =>
				reviewHoldReason(
					this.config.store,
					this.config.store.getSession(execId),
				),
			openCommDb: (projectName) => {
				try {
					return new CommDB(
						defaultGetCommDbPath(projectName),
						false,
					) as unknown as RebindCommDb;
				} catch {
					return null;
				}
			},
			onResponseWritten: rebind.onResponseWritten,
			resolveBotToken: (row) =>
				this.resolveBotTokenFor(row.project_name, row.execution_id),
			fetchImpl: this.config.fetchImpl,
			mergedGateGuard: this.config.mergedGateGuard,
			resolveProjectRoot: (projectName) =>
				this.config.projects.find((p) => p.projectName === projectName)
					?.projectRoot,
		});
	}

	/** §3.3: drain the founder action ledger (notices / nudges / wakes / alerts). */
	private async founderActionDrainPass(): Promise<void> {
		await drainFounderActionLedger({
			store: this.config.store,
			mergedGateGuard: this.config.mergedGateGuard,
			resolveProjectRoot: (projectName) =>
				this.config.projects.find((p) => p.projectName === projectName)
					?.projectRoot,
			postNotice: async ({ threadId, text, projectName, executionId }) => {
				const token = this.resolveBotTokenFor(projectName, executionId);
				if (!token) return { ok: false, error: "no_bot_token" };
				const res = await postDiscordMessageToChannel(
					threadId,
					text,
					token,
					{ origin: "automation" },
					this.config.fetchImpl ?? fetch,
				);
				return res.ok ? { ok: true } : { ok: false, error: res.error };
			},
			queueCodexInstruction: ({ projectName, executionId, instructionId }) =>
				queueCodexCodeReviewInstructionResult(projectName, executionId, {
					instructionId,
				}),
			wake: async ({ projectName, executionId, content, metadata }) => {
				let db: CommDB;
				try {
					db = new CommDB(defaultGetCommDbPath(projectName), false);
				} catch (err) {
					return { ok: false, error: (err as Error).message };
				}
				try {
					const res = await wakeRunnerMailbox({
						db,
						execId: executionId,
						fromAgent: "founder-bridge-auto",
						content,
						metadata,
					});
					return res.ok
						? { ok: true }
						: {
								ok: false,
								error: res.error ?? res.skippedReason ?? "wake failed",
							};
				} finally {
					db.close();
				}
			},
			alertSink: this.config.leadAlertSink,
			resolveAlertRoute: (projectName, executionId) =>
				this.resolveAlertRoute(projectName, executionId),
		});
	}

	/** §5: zombie gate hygiene (Z1 guarded retire + Z2 unreachable detection). */
	private async zombieGateHygienePass(): Promise<void> {
		const watchdogOn = process.env.FLYWHEEL_FOUNDER_REPLY_WATCHDOG !== "0";
		if (!zombieGateResolveEnabled() && !watchdogOn) return;
		this.founderReplyWatchdog.beginUnreachableSweep();
		for (const project of this.config.projects) {
			for (const lead of project.leads) {
				let db: CommDB;
				try {
					db = new CommDB(defaultGetCommDbPath(project.projectName), false);
				} catch {
					continue; // CommDB not present yet
				}
				try {
					// FLY-307 A contract (Case 8c): questions already tracked by the
					// stale-gate eviction bookkeeping are being handled by that path —
					// the zombie pass must NOT re-touch them (each getSession() on a
					// known-stale gate is exactly the sql.js churn FLY-307 removed).
					const pending = (
						db.getPendingQuestions(lead.agentId) as PendingQuestion[]
					).filter(
						(q) =>
							q.checkpoint != null &&
							!this.evictedGateIds.has(q.id) &&
							!this.evictionRetryAt.has(q.id),
					);
					// Codex code R8 MED-1: run the hygiene pass even with ZERO
					// candidates — its tail reconciles dangling zombie intents
					// (intent-without-outcome after a crash), which must converge even
					// when every pending gate is eviction-tracked. Reconcile reads only
					// CommDB rows + StateStore events, never getSession, so this does
					// not reintroduce the Case 8c churn.
					await runZombieGateHygiene({
						store: this.config.store,
						projectName: project.projectName,
						pendingGateQuestions: pending.map((q) => ({
							id: q.id,
							from_agent: q.from_agent,
							checkpoint: q.checkpoint,
						})),
						db: db as unknown as ZombieCommDb,
						noteUnreachableRunner: watchdogOn
							? (a) => this.founderReplyWatchdog.noteUnreachableRunner(a)
							: undefined,
					});
				} catch (err) {
					console.warn(
						`[GatePoller] zombie hygiene error (${project.projectName}/${lead.agentId}):`,
						err instanceof Error ? err.message : String(err),
					);
					this.maybeRecoverStore(err);
				} finally {
					db.close();
				}
			}
		}
		this.founderReplyWatchdog.endUnreachableSweep();
	}

	/** FLY-799: minimum spacing between reaction-checks for one ship gate. */
	private founderReactionCheckIntervalMs(): number {
		return 15_000;
	}

	/**
	 * FLY-799: per-pending-ship-gate founder ✅-reaction approval. For each
	 * past-grace `approve_to_ship` gate, build a per-lead Discord reactions
	 * fetcher (bot token) and call the flag-gated reaction callback; on a founder
	 * ✅ on the durably-bound gate message it writes `{approved:true}` (attributed
	 * to the founder) + flips + wakes. Self-limiting (the flip drops the gate out
	 * of awaiting_review) + throttled per-qid so we do not hammer the reactions
	 * API. Fully isolated: a per-gate error is logged and never aborts the pass.
	 */
	private async founderReactionApprovalPass(): Promise<void> {
		const tryReaction = this.config.tryFounderReactionApproval;
		if (!tryReaction) return;
		if (!this.config.chatThreadsEnabled) return;
		const ownerUserId = this.config.discordOwnerUserId;
		if (!isDiscordSnowflake(ownerUserId)) return;
		// FLY-945 Fix A (Codex R1 #6): all gates here are approve_to_ship — use
		// the ship-gate grace, not the 10min founder-reply grace, or a founder ✅
		// still waits out the full 10min end-to-end (the 15s reaction-check
		// interval below is only a per-question re-check throttle).
		const graceMs = this.shipGateGraceMs();
		const now = Date.now();
		const fetchImpl = this.config.fetchImpl ?? fetch;

		for (const project of this.config.projects) {
			for (const lead of project.leads) {
				const botToken = lead.botToken ?? this.config.discordBotToken;
				if (!botToken) continue;
				const dbPath = defaultGetCommDbPath(project.projectName);

				// Collect pending approve_to_ship questions for this lead (read-only).
				let shipGates: PendingQuestion[];
				try {
					const rdb = CommDB.openReadonly(dbPath);
					try {
						shipGates = (
							rdb.getPendingQuestions(lead.agentId) as PendingQuestion[]
						).filter((q) => q.checkpoint === "approve_to_ship");
					} finally {
						rdb.close();
					}
				} catch {
					continue; // CommDB not present yet
				}
				if (shipGates.length === 0) continue;

				// Per-lead Discord reactions fetcher (paginating GET; the shared
				// checkReactionConfirmation is fail-closed on any non-200/429/malformed).
				const reactionFetcherImpl: ReactionFetcher = async ({
					channelId,
					messageId,
					emoji,
					after,
				}) => {
					const afterQs = after ? `&after=${encodeURIComponent(after)}` : "";
					const res = await fetchImpl(
						`${DISCORD_API}/channels/${channelId}/messages/${messageId}/reactions/${encodeReactionEmoji(emoji)}?limit=100${afterQs}`,
						{ headers: { Authorization: `Bot ${botToken}` } },
					);
					return {
						status: res.status,
						body: res.ok ? await res.json() : undefined,
					};
				};

				// One writable CommDB per lead for any gate response write.
				let db: CommDB;
				try {
					db = new CommDB(dbPath, false);
				} catch {
					continue;
				}
				try {
					for (const q of shipGates) {
						const createdMs = parseSqliteUtcMs(q.created_at);
						if (createdMs === null || now - createdMs < graceMs) continue;
						// Throttle: at most one reactions GET per qid per interval.
						const nextAt = this.founderReactionNextCheck.get(q.id) ?? 0;
						if (now < nextAt) continue;
						this.founderReactionNextCheck.set(
							q.id,
							now + this.founderReactionCheckIntervalMs(),
						);

						const session = this.config.store.getSession(q.from_agent);
						if (!session) continue;
						const thread = this.config.store.getChatThreadByIssue(
							session.issue_id,
							lead.chatChannel,
						);
						if (!thread?.thread_id) continue;

						try {
							await tryReaction({
								gate: {
									questionId: q.id,
									executionId: q.from_agent,
									checkpoint: q.checkpoint,
									createdAtMs: createdMs,
								},
								ctx: {
									issueId: session.issue_id,
									threadId: thread.thread_id,
									projectName: project.projectName,
								},
								db,
								reactionFetcherImpl,
							});
						} catch (err) {
							console.warn(
								`[GatePoller] founder-reaction approval error (qid=${q.id}):`,
								err instanceof Error ? err.message : String(err),
							);
							this.maybeRecoverStore(err);
						}
					}
				} finally {
					db.close();
				}
			}
		}
	}

	/** FLY-799 Part B: default-ON re-wake reconciler kill-switch (`=0` disables). */
	private staleShipRewakeEnabled(): boolean {
		return process.env.FLYWHEEL_STALE_SHIP_REWAKE !== "0";
	}

	/**
	 * FLY-799 Part B: re-wake sessions stranded in approved_to_ship. A LIVE runner
	 * gets the approval wake re-sent (idempotent; verify-approval still gates the
	 * actual ship); a DEAD one is alerted once (durable event + warn) and deferred
	 * to FLY-795. Re-wake-only — never self-ships, never reads 795's progress.md.
	 */
	private async staleApprovedShipReconcilePass(): Promise<void> {
		const sessions = this.config.store
			.getActiveSessions()
			.filter((s) => s.status === "approved_to_ship");
		if (sessions.length === 0) return;

		await reconcileStaleApprovedShip({
			sessions: sessions as RewakeSessionProbe[],
			nowMs: Date.now(),
			graceMs: DEFAULT_REWAKE_GRACE_MS,
			backoffMs: DEFAULT_REWAKE_BACKOFF_MS,
			backoff: this.staleShipRewakeBackoff,
			deadAlerted: this.staleShipDeadAlerted,
			isAlive: async (s) => {
				if (!s.tmux_session) return true; // can't probe → treat as live (re-wake harmless)
				try {
					return await isTmuxSessionAlive(s.tmux_session);
				} catch {
					return true;
				}
			},
			reWake: async (s) => {
				const dbPath = defaultGetCommDbPath(s.project_name);
				let db: CommDB;
				try {
					db = new CommDB(dbPath, false);
				} catch {
					return;
				}
				try {
					await sendRunnerWake(
						this.config.store,
						db,
						s.execution_id,
						{ issue_id: s.issue_id, project_name: s.project_name },
						"approval_wake",
						{ questionId: s.review_question_id },
					);
				} finally {
					db.close();
				}
			},
			alertDead: async (s) => {
				console.warn(
					`[GatePoller] FLY-799: approved_to_ship runner ${s.execution_id} (issue ${s.issue_id}) appears DEAD while stranded post-approval — founder approved but the runner cannot self-ship. Deferring to FLY-795 (durable resume).`,
				);
				try {
					this.config.store.insertEvent({
						event_id: `stale-approved-ship-dead-${s.execution_id}`,
						execution_id: s.execution_id,
						issue_id: s.issue_id,
						project_name: s.project_name,
						event_type: "stale_approved_ship_dead",
						source: "bridge.fly799-stale-ship-reconciler",
						payload: {
							reviewQuestionId: s.review_question_id ?? null,
							prHeadSha: s.pr_head_sha ?? null,
							at: new Date().toISOString(),
						},
					});
				} catch {
					// durable dead-alert event is best-effort
				}
			},
		});
	}

	/**
	 * Durable ambiguous-message handoff to the Lead via the SAME LeadRuntime path
	 * GatePoller uses for gate questions (Codex R3 #2). Returns true only when the
	 * event is durably accepted + delivered; on failure the deliverer stops the
	 * cursor before that message so the manual-relay handoff is never lost.
	 */
	private makeAmbiguousHandoff(
		lead: LeadConfig,
		projectName: string,
	): (eventId: string, payload: Record<string, unknown>) => Promise<boolean> {
		return async (eventId, payload) => {
			if (this.config.store.isLeadEventDelivered(lead.agentId, eventId)) {
				// FLY-605 (Codex code-review R2 #1): a prior pass may have set the
				// in-memory delivered mark and then had flush() throw (the deliverer
				// caught the thread error and did NOT advance the cursor that pass).
				// Re-flush here so the "already delivered in memory" short-circuit can
				// never let the cursor advance past a marker that never reached disk.
				// A flush() failure propagates → emitFounderReplyDeliveryForThread
				// throws → the per-thread catch leaves the cursor un-advanced → retry.
				this.config.store.flush();
				return true;
			}
			const issueId = String(payload.issueId ?? "");
			const answer = String(payload.answer ?? "");
			const hookPayload: HookPayload = {
				event_type: "founder_reply_ambiguous",
				execution_id: "",
				issue_id: issueId,
				project_name: projectName,
				status: "founder_reply_ambiguous",
				summary:
					"🧵 Annie 在该 issue thread 回复了，但有多个 open question、Bridge 无法确定她答的是哪个 —— " +
					`请人工 relay 给对应 runner。回复内容：${answer}`,
				chat_thread_id: String(payload.threadId ?? ""),
			};
			const seq = this.config.store.appendLeadEvent(
				lead.agentId,
				eventId,
				"founder_reply_ambiguous",
				JSON.stringify(hookPayload),
				issueId,
			);
			const runtime = this.config.runtimeRegistry.getForLead(lead.agentId);
			if (!runtime) return false;
			const result = await runtime.deliver({
				seq,
				event: hookPayload,
				sessionKey: issueId,
				leadId: lead.agentId,
				timestamp: new Date().toISOString(),
			});
			if (result.delivered) {
				this.config.store.markLeadEventDelivered(seq);
				// FLY-605 (Codex code-review #2): force the lead_events append +
				// delivered mark to disk BEFORE we return true — the deliverer
				// advances (and immediately persists) the thread cursor on success,
				// and appendLeadEvent/markLeadEventDelivered do NOT auto-save. Without
				// this flush a crash after the cursor write could drop the manual-relay
				// handoff while the cursor permanently skips the founder message.
				this.config.store.flush();
				return true;
			}
			this.config.store.recordDeliveryFailure(
				seq,
				result.error ?? "deliver returned false",
			);
			return false;
		};
	}
}
