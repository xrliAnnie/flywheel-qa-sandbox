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
import { CommDB } from "flywheel-comm/db";
import { parseFounderReviewQuestionContent } from "flywheel-comm/founder-review";
import { readContentRef } from "flywheel-comm/utils";
// FLY-927: gate patrol wake primitive.
import { wakeRunnerMailbox } from "flywheel-comm/wake";
import { phaseMessageTag } from "flywheel-config";
import type { AlertPayload, AlertResult } from "../LeadAlertNotifier.js";
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
import { nodeRequiresFounderReview } from "../workflow-run-snapshot.js";
import {
	type DeferredRebindDeps,
	type RebindCommDb,
	runDeferredApprovalRebindPass,
} from "./approval-signal/deferred-approval.js";
import { writeGateMessageBinding } from "./approval-signal/gate-message-binding-store.js";
import { resolveChatThreadId } from "./chat-thread-utils.js";
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
import { FounderReplyUnreachableReconcile } from "./founder-reply-unreachable.js";
import { founderReviewCheckpointEnabled } from "./founder-review-authority.js";
import { tryFounderReviewReactionResponse } from "./founder-review-response.js";
import { emitFounderThreadNotification } from "./founder-thread-notifier.js";
import type { HookPayload } from "./hook-payload.js";
import type { LeadEventEnvelope } from "./lead-runtime.js";
import { matchesLead } from "./lead-scope.js";
import type { MergedGateGuard } from "./merged-gate-guard.js";
import {
	isAutoMigratableClaudeTmux,
	parsePaneLossGenerationParams,
} from "./pane-loss-reconcile.js";
import { isReviewGateCheckpoint } from "./review-gate-checkpoints.js";
import { type ReviewHoldReason, reviewHoldReason } from "./review-hold.js";
import { sendRunnerWake } from "./runner-wake.js";
import {
	dispatchLeadEventCompat as dispatchLeadEvent,
	type RuntimeRegistry,
} from "./runtime-registry.js";
import { defaultGetCommDbPath } from "./session-capture.js";
import {
	classifyStaleShipRunnerLiveness,
	DEFAULT_REWAKE_BACKOFF_MS,
	DEFAULT_REWAKE_GRACE_MS,
	deadAlertAccepted,
	type RewakeSessionProbe,
	reconcileStaleApprovedShip,
	shipAttemptFailedSuppressedHead,
} from "./stale-approved-ship-reconciler.js";
import {
	discoverTmuxTargetByExecutionId,
	lookupTmuxTarget,
	probeRunnerProcessLiveness,
	probeTmuxServerStartTime,
} from "./tmux-lookup.js";
import {
	runZombieGateHygiene,
	type ZombieCommDb,
} from "./zombie-gate-hygiene.js";

export interface GatePollerConfig {
	/** FLY-1995: wall-clock correlation only; never treated as CPU attribution. */
	recordSpan?: (name: string, startMs: number, endMs: number) => void;
	pollIntervalMs: number;
	projects: ProjectEntry[];
	store: StateStore;
	runtimeRegistry: RuntimeRegistry;
	/** FLY-1251: async producer for the exact-head ship-diff hold snapshot. */
	ensureShipRelevantDiff?: (session: Session) => Promise<void> | void;
	/** FLY-91: Enable per-issue chat thread hints in gate_question payloads. */
	chatThreadsEnabled?: boolean;
	/** FLY-208 A2: patrol cadence in poll ticks (default 20 ≈ 60s at 3s). */
	patrolEveryNTicks?: number;
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
	/** FLY-1687: pure alarm producer on the existing 60s rider cadence. */
	onLeadPatrolTick?: () => void | Promise<void>;
	/** FLY-1944: cmux watcher liveness/recovery rider on the same 60s cadence. */
	onCmuxWatcherPatrolTick?: () => void | Promise<void>;
	/** FLY-513: cadence for `onHealthTick` in poll ticks (default 20 ≈ 60s at 3s). */
	healthCheckEveryNTicks?: number;
	/**
	 * FLY-1314: issue-scoped gate supersede patrol. It shares the existing
	 * GatePoller timer and runs every tick so a newly-opened replacement gate
	 * cannot leave a long founder-reply ambiguity window. The callback owns its
	 * own bounded mutation budget; failures are fully contained here.
	 */
	onIssueGateSupersedeTick?: () => void | Promise<void>;
	/**
	 * FLY-1375: converge engine-owned approval holders into CommDB + Discord.
	 * Runs every poll tick on the existing timer; the callback owns single-flight.
	 */
	onWorkflowGateMaterializeTick?: () => void | Promise<void>;
	/** FLY-1375: resume durable engine and runless land operations. */
	onLandOperationTick?: () => void | Promise<void>;
	/**
	 * FLY-1282 Part D: the disposition-receipt delivery pass — its OWN stage,
	 * fixed cadence 20 ticks (≈60s at 3s); the pass has
	 * its own in-process single-flight. Absent → complete no-op.
	 */
	onDispositionReceiptTick?: () => void | Promise<void>;
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
	 * from relaying it), so the wait is pure dead time. Default 15s.
	 * Non-ship checkpoints are untouched.
	 */
	shipGateGraceMs?: number;
	/**
	 * FLY-1041 Chunk 6: grace before the approve_to_ship founder CARD is
	 * posted (the deterministic approval carrier — reply-to-card / ✅). The
	 * 10min FLY-605 grace made the card a rarely-seen fallback; for ship gates
	 * the card IS the primary surface, so it fires after ~15s (default).
	 * Brainstorm is untouched.
	 */
	shipGateCardGraceMs?: number;
	/** Part B slow sub-cadence in poll ticks (default 20 ≈ 60s at 3s). */
	founderReplyDeliverEveryNTicks?: number;
	/** FLY-2008: rotating budget for pure ingress-scan threads (question lane excluded). */
	founderReplyScanBudget?: number;
	/** FLY-1448: durable decision convergence on this existing cadence. */
	onFounderDecisionConvergenceTick?: () => void | Promise<void>;
	/** Part B thread-read cursor store (default in-memory). */
	cursorStore?: InboundCursorStore;
	/**
	 * FLY-1448: the founder ship-approval callback built by plugin.ts. The
	 * deliverer invokes it only after founder identity and gate targeting have
	 * been verified. Absent preserves the legacy Lead-handoff behavior.
	 */
	tryFounderShipApproval?: FounderReplyDeliverDeps["tryFounderShipApproval"];
	/**
	 * FLY-1448: durable ship-card binding reader used for exact reply-to-card
	 * targeting when more than one ship gate is pending in the issue thread.
	 */
	readCurrentBinding?: FounderReplyDeliverDeps["readCurrentBinding"];
	/** Retained convergence riders; piggyback this poller's timer. */
	onReconcilePatrolTick?: () => void | Promise<void>;
	/** Reconcile patrol cadence (default 20, about 60s in production). */
	reconcilePatrolEveryNTicks?: number;
	/** Retained Lead/fleet reconciliation riders on the existing poll timer. */
	onLeadReconcileTick?: () => void | Promise<void>;
	/** Lead reconcile cadence (default 200, about 10min in production). */
	leadReconcileEveryNTicks?: number;
	/**
	 * FLY-1560: both riders below are assembled far AFTER `start()` in the Bridge
	 * composition root, so on a slow boot the first 3s tick can land while the
	 * pass holder is still null. The cadence anchor would otherwise be burned by
	 * that unarmed tick — pushing the boot pass out by a full cadence (~10min for
	 * lead reconcile) while looking like it ran. When supplied and false, the tick
	 * is skipped WITHOUT anchoring; the anchor is set by the first tick that
	 * actually runs. Omitted ⇒ anchored on tick 1, byte-compatible with before.
	 */
	onLeadReconcileReady?: () => boolean;
	/** Runner quota/auth scan on the existing poll timer. */
	onRunnerQuotaScanTick?: () => void | Promise<void>;
	/** Runner scan cadence (default 20, about 1min in production). */
	runnerQuotaScanEveryNTicks?: number;
	/** See `onLeadReconcileReady` — same late-arming contract. */
	onRunnerQuotaScanReady?: () => boolean;
	/** FLY-1781: weekly flag scan rider on the existing GatePoller timer. */
	onFlagScanTick?: () => void | Promise<void>;
	/** Cadence in poll ticks (default 200, about 10min in production). */
	flagScanEveryNTicks?: number;
	/** Late-arm guard: an unready boot tick must not burn the cadence anchor. */
	onFlagScanReady?: () => boolean;

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
		gateAuthorityView?: DeferredRebindDeps["gateAuthorityView"];
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

	// Shared alert sink for retained GatePoller convergence failures.
	/**
	 * The LeadAlertNotifier queues transient failures and never throws.
	 */
	leadAlertSink?: { alert(payload: AlertPayload): Promise<AlertResult> };
}

const DEFAULT_PATROL_EVERY_N_TICKS = 20;
export const DEFAULT_LEAD_RECONCILE_EVERY_N_TICKS = 200;
export const DEFAULT_RUNNER_QUOTA_SCAN_EVERY_N_TICKS = 20;
export const FOUNDER_REPLY_SCAN_BUDGET_PER_PASS = 25;
// FLY-307 B: per-lead circuit breaker defaults.
const DEFAULT_CIRCUIT_THRESHOLD = 3;
const DEFAULT_CIRCUIT_COOLDOWN_TICKS = 20;
const FOUNDER_REPLY_RETRY_MAX = 10;
// FLY-307 A: backoff before retrying a failed stale-gate eviction write.
const DEFAULT_EVICTION_RETRY_TICKS = 20;
const yieldToEventLoop = (): Promise<void> =>
	new Promise((resolve) => setImmediate(resolve));
const compareThreadIds = (left: string, right: string): number =>
	left < right ? -1 : left > right ? 1 : 0;

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
 * FLY-1257 defect ④ path-2: the review gates (`review_design` / `review_code`,
 * the FLY-1224 non-claude-author lane). These are the ONE gate family the
 * authoring runner never answers — `request-review` BINDS them and the reviewer
 * answers them, so the FLY-307 A eviction premise ("the Runner is gone, so this
 * gate can never be answered") is false for them. Evicting one expired it
 * (`resolveGate(qid, 0)`) before `request-review` could bind it, so a
 * blocked/completed session could never re-request review: checkGate saw
 * answered/expired → fail-close forever, and the row was then purged by TTL.
 * Sibling in intent to the FLY-579 approve_to_ship QA-held carve-out.
 *
 * The set + predicate live in `./review-gate-checkpoints.js` (single source of
 * truth — the zombie-gate-hygiene Z1 sweep consults the same one; a drifting
 * copy is the defect ④ bug). Imported above; re-exported here so the previously
 * public `isReviewGateCheckpoint` API is preserved.
 */
export { isReviewGateCheckpoint };

/**
 * FLY-1041 Fix A (sweeper judgement, pure). A pending approve_to_ship gate is
 * SUPERSEDED when its session has re-bound to a DIFFERENT question whose row
 * was created STRICTLY later — the founder must only ever see ONE bindable
 * ship gate.
 *
 * ACCEPTED CONSERVATIVE TRADEOFF (Codex R1 #5): this sweeper is a backstop,
 * not a completeness guarantee. Under an equal-timestamp re-fire where the
 * main event-route retire ALSO
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

export class GatePoller {
	private timerHandle: ReturnType<typeof setInterval> | null = null;
	private polling = false;
	private reconcilePatrolPass: Promise<void> | null = null;
	private leadReconcilePass: Promise<void> | null = null;
	private runnerQuotaScanPass: Promise<void> | null = null;
	private flagScanPass: Promise<void> | null = null;
	// FLY-1560: cadence anchors for the two late-armed riders. `null` means the
	// rider has never run, so the next ready tick anchors it (see the
	// `onLeadReconcileReady` contract in GatePollerConfig).
	private leadReconcileAnchorTick: number | null = null;
	private runnerQuotaScanAnchorTick: number | null = null;
	private flagScanAnchorTick: number | null = null;
	// FLY-1099 §7.2: retained unreachable-runner consistency reconcile.
	private readonly founderReplyUnreachable: FounderReplyUnreachableReconcile;

	constructor(private config: GatePollerConfig) {
		this.founderReplyUnreachable = new FounderReplyUnreachableReconcile({
			alertSink: config.leadAlertSink,
			infraRoute: () => this.infraAlertRoute(),
		});
	}

	/**
	 * FLY-1251 R2: a code-bearing or unclassifiable PR stays founder-hidden.
	 * The caller has already refreshed the server-owned classifier; emit a
	 * Lead-only deterministic alert. LeadAlertNotifier's durable claim makes the
	 * stable event id the once-per-(execution, head, reason) marker across restarts.
	 */
	private async handleHeldReviewGate(
		lead: LeadConfig,
		session: Session,
		reason: ReviewHoldReason,
	): Promise<void> {
		if (reason !== "qa_evidence_missing" && reason !== "qa_evidence_unknown") {
			return;
		}
		const head = session.pr_head_sha?.toLowerCase() ?? "unknown";
		const issue = session.issue_identifier ?? session.issue_id;
		const work: Promise<unknown>[] = [];
		if (this.config.leadAlertSink) {
			work.push(
				this.config.leadAlertSink.alert({
					leadId: lead.agentId,
					projectName: session.project_name,
					eventId: `ship-readiness-hold:${session.execution_id}:${head}:${reason}`,
					eventType: "auto_qa_stuck",
					title: `Ship readiness held — ${issue}`,
					body:
						`Founder approval remains hidden for ${issue} because ${reason}. ` +
						"Bridge will retry the server-owned PR classification. If the evidence remains missing, cancel the held run and redispatch it through the DAG QA pipeline.",
					severity: "warning",
					sessionKey: session.execution_id,
				}),
			);
		}
		const results = await Promise.allSettled(work);
		for (const result of results) {
			if (result.status === "rejected") {
				console.warn(
					`[GatePoller] ship-readiness hold handling failed for ${session.execution_id}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
				);
			}
		}
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
		const spanStart = Date.now();
		try {
			// FLY-208 A2: patrol cadence — piggybacks on this existing tick
			// (zero new periodic timers, FLY-169/172 discipline). Misrouted
			// reports are a minutes-scale human-loop event; every Nth tick
			// (default 20 ≈ 60s at the production 3s interval) is plenty.
			this.tickCount++;

			if (
				this.config.onReconcilePatrolTick &&
				(this.tickCount - 1) % this.reconcilePatrolEveryNTicks() === 0
			) {
				void this.runReconcilePatrolPass().catch((err) =>
					console.warn(
						`[GatePoller] reconcile patrol error (non-fatal): ${(err as Error).message}`,
					),
				);
			}

			if (
				this.config.onLeadReconcileTick &&
				this.riderDueThisTick(
					this.leadReconcileAnchorTick,
					this.leadReconcileEveryNTicks(),
					this.config.onLeadReconcileReady,
					(anchor) => {
						this.leadReconcileAnchorTick = anchor;
					},
				)
			) {
				void this.runLeadReconcilePass().catch((err) =>
					console.warn(
						`[GatePoller] lead reconcile error (non-fatal): ${(err as Error).message}`,
					),
				);
			}

			if (
				this.config.onRunnerQuotaScanTick &&
				this.riderDueThisTick(
					this.runnerQuotaScanAnchorTick,
					this.runnerQuotaScanEveryNTicks(),
					this.config.onRunnerQuotaScanReady,
					(anchor) => {
						this.runnerQuotaScanAnchorTick = anchor;
					},
				)
			) {
				void this.runRunnerQuotaScanPass().catch((err) =>
					console.warn(
						`[GatePoller] runner quota scan error (non-fatal): ${(err as Error).message}`,
					),
				);
			}

			if (
				this.config.onFlagScanTick &&
				this.riderDueThisTick(
					this.flagScanAnchorTick,
					this.flagScanEveryNTicks(),
					this.config.onFlagScanReady,
					(anchor) => {
						this.flagScanAnchorTick = anchor;
					},
				)
			) {
				void this.runFlagScanPass().catch((err) =>
					console.warn(
						`[GatePoller] flag retirement scan error (non-fatal): ${(err as Error).message}`,
					),
				);
			}

			// FLY-1314: gate hygiene is a same-tick invariant repair, not a new
			// background timer. Keep it outside the project/lead loops and isolate it
			// exactly like the other patrol callbacks.
			if (this.config.onIssueGateSupersedeTick) {
				void Promise.resolve()
					.then(() =>
						this.withSpan("gate-poller.issue-gate-supersede", () =>
							this.config.onIssueGateSupersedeTick?.(),
						),
					)
					.catch((err) =>
						console.warn(
							`[GatePoller] FLY-1314 issue-gate supersede error (non-fatal): ${(err as Error).message}`,
						),
					);
			}

			if (this.config.onWorkflowGateMaterializeTick) {
				void Promise.resolve()
					.then(() =>
						this.withSpan("gate-poller.workflow-gate-materialize", () =>
							this.config.onWorkflowGateMaterializeTick?.(),
						),
					)
					.catch((err) =>
						console.warn(
							`[GatePoller] FLY-1375 workflow-gate materialization error (non-fatal): ${(err as Error).message}`,
						),
					);
			}

			if (this.config.onLandOperationTick) {
				void Promise.resolve()
					.then(() =>
						this.withSpan("gate-poller.land-operation", () =>
							this.config.onLandOperationTick?.(),
						),
					)
					.catch((err) =>
						console.warn(
							`[GatePoller] FLY-1375 land-operation sweep error (non-fatal): ${(err as Error).message}`,
						),
					);
			}

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
					.then(() =>
						this.withSpan("gate-poller.health", () =>
							this.config.onHealthTick?.(),
						),
					)
					.catch((err) =>
						console.warn(
							`[GatePoller] FLY-513 codex-health probe error (non-fatal): ${(err as Error).message}`,
						),
					);
			}

			if (
				this.config.onLeadPatrolTick &&
				(this.tickCount - 1) % DEFAULT_PATROL_EVERY_N_TICKS === 0
			) {
				void Promise.resolve()
					.then(() =>
						this.withSpan("gate-poller.lead-patrol", () =>
							this.config.onLeadPatrolTick?.(),
						),
					)
					.catch((err) =>
						console.warn(
							`[GatePoller] lead patrol tick error (non-fatal): ${(err as Error).message}`,
						),
					);
			}

			if (
				this.config.onCmuxWatcherPatrolTick &&
				(this.tickCount - 1) % DEFAULT_PATROL_EVERY_N_TICKS === 0
			) {
				void Promise.resolve()
					.then(() =>
						this.withSpan("gate-poller.cmux-watcher-patrol", () =>
							this.config.onCmuxWatcherPatrolTick?.(),
						),
					)
					.catch((err) =>
						console.warn(
							`[GatePoller] cmux watcher patrol error (non-fatal): ${(err as Error).message}`,
						),
					);
			}

			// FLY-1282 Part D: disposition-receipt delivery — independent stage
			// (see config docs: NOT under the detection cadence). Same piggyback
			// posture: zero new timer, own catch, never blocks the poll.
			if (
				this.config.onDispositionReceiptTick &&
				(this.tickCount - 1) % 20 === 0
			) {
				void Promise.resolve()
					.then(() =>
						this.withSpan("gate-poller.disposition-receipt", () =>
							this.config.onDispositionReceiptTick?.(),
						),
					)
					.catch((err) =>
						console.warn(
							`[GatePoller] FLY-1282 disposition receipt error (non-fatal): ${(err as Error).message}`,
						),
					);
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
						.then(() =>
							this.withSpan("gate-poller.display-reconcile", () =>
								this.config.onDisplayReconcileTick?.(),
							),
						)
						.catch((err) =>
							console.warn(
								`[GatePoller] FLY-907 display-reconcile sweep error (non-fatal): ${(err as Error).message}`,
							),
						);
				}
			}

			// FLY-161: iterate (project, lead) pairs directly instead of starting
			// from getActiveSessions(). This lets runner_question survive Runner
			// completion — a question whose source session has transitioned to
			// `completed` would have been dropped by the old active-session-first
			// loop. The session is still resolved per-question below for metadata,
			// but presence in the active set is no longer a prerequisite.
			for (const project of this.config.projects) {
				const projectDbPath = defaultGetCommDbPath(project.projectName);
				if (!this.ensureCommDbMigrated(projectDbPath, project)) {
					continue;
				}
				for (const lead of project.leads) {
					const leadKey = `${project.projectName}::${lead.agentId}`;
					// FLY-307 B: while a lead's circuit is open, skip question relay for
					// that lead. `tickCount` still advances once per poll (above).
					if (this.circuitOpen(leadKey)) {
						await yieldToEventLoop();
						continue;
					}
					const dbPath = projectDbPath;
					let relayFailed = false;
					try {
						const pending = this.getPendingQuestions(dbPath, lead.agentId);
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
							const orphan = this.orphanQuestions.get(question.id);
							if (
								question.checkpoint == null &&
								orphan &&
								(this.tickCount - orphan.firstSeenTick) % 20 !== 0
							) {
								continue;
							}
							const session = this.config.store.getSession(question.from_agent);
							if (!session) {
								// Orphan question — from_agent references no known session.
								// Skip rather than throw; Lead can still pick it up manually
								// via `flywheel-comm pending`. (Codex R1 Issue 1.)
								if (!orphan) {
									this.rememberOrphanQuestion(question.id);
									console.warn(
										`[GatePoller] orphan question — no session for from_agent=${question.from_agent} (qid=${question.id}, lead=${lead.agentId})`,
									);
								} else {
									this.orphanQuestions.delete(question.id);
									this.orphanQuestions.set(question.id, orphan);
								}
								continue;
							}
							this.orphanQuestions.delete(question.id);
							const gateOwnership =
								typeof this.config.store.workflowGatePresentationDisposition ===
								"function"
									? this.config.store.workflowGatePresentationDisposition({
											executionId: question.from_agent,
											checkpoint: question.checkpoint,
											questionId: question.id,
										})
									: { allow: true as const, reason: "legacy" as const };
							if (!gateOwnership.allow) {
								console.warn(
									`[GatePoller] suppressed non-authoritative workflow ship gate ${question.id}: ${gateOwnership.reason}`,
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
							if (question.checkpoint === "approve_to_ship") {
								try {
									await this.config.ensureShipRelevantDiff?.(session);
								} catch (err) {
									console.warn(
										`[GatePoller] ship-diff refresh failed for ${session.execution_id}: ${err instanceof Error ? err.message : String(err)}`,
									);
								}
								const holdReason = reviewHoldReason(this.config.store, session);
								if (holdReason !== null) {
									await this.handleHeldReviewGate(lead, session, holdReason);
									continue;
								}
							}
							// FLY-605 Part A (Codex R2 #3): relayToLead and the founder-thread
							// fallback get SEPARATE try/catch so a Lead-runtime throw from the
							// relay never prevents the post-grace fallback for this question.
							try {
								// FLY-1373: the 1s LeadInboxLoop owns admission + delivery. This
								// legacy direct relay remains only as a test/rollback fallback when
								// no loop was registered; production nudge returns true and never
								// touches runtime.deliver here.
								if (
									!this.config.runtimeRegistry.nudgeLeadInbox(
										lead.agentId,
										project.projectName,
									)
								) {
									await this.withSpan("gate-poller.question-relay", () =>
										this.relayToLead(lead, session, question, dbPath),
									);
								}
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
						}
						// FLY-307 B: a clean pass closes the circuit; a relay throw counts as
						// a failure (preserves the pre-FLY-605 break-on-throw circuit semantics
						// while letting the founder-thread fallback still run — Codex R2 #3).
						if (relayFailed) this.recordCircuitFailure(leadKey);
						else this.recordCircuitSuccess(leadKey);
					} catch (err) {
						relayFailed = true;
						console.warn(
							`[GatePoller] Error polling ${lead.agentId}:`,
							err instanceof Error ? err.message : String(err),
						);
						// FLY-307 B: count the failed poll even if earlier questions in
						// this iteration were delivered (no reset-on-partial-delivery).
						this.recordCircuitFailure(leadKey);
						// FLY-639: a sql.js corruption thrown by getSession/getPendingQuestions
						// here is contained by this catch (no Bridge crash). Attempt a
						// best-effort StateStore self-heal so the next lead/cycle is healthy.
						// Complementary to the FLY-307 circuit: circuit isolates the poisoned
						// path, recover repairs the underlying store.
						this.maybeRecoverStore(err);
					}
					await yieldToEventLoop();
				}
			}

			// FLY-605 Part B: founder-reply inbound auto-delivery on a slow
			// sub-cadence (~60s). Piggybacks this tick (zero new timer); fully
			// isolated — its errors never abort the poll loop.
			if (this.tickCount % this.founderReplyDeliverEveryNTicks() === 1) {
				try {
					await this.withSpan("gate-poller.founder-reply-deliver", () =>
						this.founderReplyDeliverPass(),
					);
				} catch (err) {
					console.warn(
						"[GatePoller] founder-reply deliver pass error:",
						err instanceof Error ? err.message : String(err),
					);
					// FLY-639: this pass also touches StateStore (getSession /
					// getChatThreadByIssue / appendLeadEvent) — self-heal on corruption.
					this.maybeRecoverStore(err);
				}
				await yieldToEventLoop();
			}

			// FLY-1099 §4.3: deferred-approval rebind pass — same sub-cadence,
			// only meaningful while ingest is on (a deferral is captured by the
			// deliver pass; TTL still converges via this pass's own kill-switch
			// checks inside runDeferredApprovalRebindPass).
			if (
				this.config.deferredRebind &&
				this.tickCount % this.founderReplyDeliverEveryNTicks() === 1
			) {
				try {
					await this.withSpan("gate-poller.deferred-rebind", () =>
						this.deferredRebindPass(),
					);
				} catch (err) {
					console.warn(
						"[GatePoller] deferred-approval rebind pass error:",
						err instanceof Error ? err.message : String(err),
					);
					this.maybeRecoverStore(err);
				}
				await yieldToEventLoop();
			}

			// FLY-1099 §3.3 + §8: founder action-ledger drain. Already-committed
			// held notices / nudges / feedback wakes / MUST-DELIVER alerts converge
			// independently from founder-reply ingestion.
			if (this.tickCount % this.founderReplyDeliverEveryNTicks() === 1) {
				try {
					await this.withSpan("gate-poller.founder-action-drain", () =>
						this.founderActionDrainPass(),
					);
				} catch (err) {
					console.warn(
						"[GatePoller] founder action-ledger drain error:",
						err instanceof Error ? err.message : String(err),
					);
					this.maybeRecoverStore(err);
				}
				await yieldToEventLoop();
				try {
					await this.withSpan("gate-poller.founder-decision-convergence", () =>
						this.config.onFounderDecisionConvergenceTick?.(),
					);
				} catch (err) {
					console.warn(
						"[GatePoller] founder-decision convergence pass error:",
						err instanceof Error ? err.message : String(err),
					);
					this.maybeRecoverStore(err);
				}
				await yieldToEventLoop();
				// FLY-1099 §7.2: retained unreachable-runner detector tick.
				try {
					await this.withSpan("gate-poller.founder-reply-unreachable", () =>
						this.founderReplyUnreachable.tick(),
					);
				} catch (err) {
					console.warn(
						"[GatePoller] founder-reply reconcile tick error:",
						err instanceof Error ? err.message : String(err),
					);
					this.maybeRecoverStore(err);
				}
				await yieldToEventLoop();
			}

			// FLY-1099 §5: zombie gate hygiene on the patrol cadence — Z1 retires
			// gates whose runner is irreversibly gone (three-phase, guarded); Z2
			// (live session, missing CommDB row) feeds the unreachable detector.
			if (this.tickCount % this.patrolEveryNTicks() === 1) {
				try {
					await this.withSpan("gate-poller.zombie-hygiene", () =>
						this.zombieGateHygienePass(),
					);
				} catch (err) {
					console.warn(
						"[GatePoller] zombie gate hygiene error:",
						err instanceof Error ? err.message : String(err),
					);
					this.maybeRecoverStore(err);
				}
				await yieldToEventLoop();
			}
			// FLY-799: founder ✅-reaction ship approval on the same sub-cadence
			// (piggyback; zero new timer). Only runs when the reaction callback is
			// wired; fully isolated so its errors never abort the poll loop.
			if (
				this.config.tryFounderReactionApproval &&
				this.tickCount % this.founderReplyDeliverEveryNTicks() === 1
			) {
				try {
					await this.withSpan("gate-poller.founder-reaction-approval", () =>
						this.founderReactionApprovalPass(),
					);
				} catch (err) {
					console.warn(
						"[GatePoller] founder-reaction approval pass error:",
						err instanceof Error ? err.message : String(err),
					);
					this.maybeRecoverStore(err);
				}
				await yieldToEventLoop();
			}

			// FLY-799 Part B: re-wake sessions stranded in approved_to_ship (a
			// missed self-ship wake). Default-ON kill-switch; same sub-cadence.
			if (this.tickCount % this.founderReplyDeliverEveryNTicks() === 1) {
				try {
					await this.withSpan("gate-poller.stale-approved-ship", () =>
						this.staleApprovedShipReconcilePass(),
					);
				} catch (err) {
					console.warn(
						"[GatePoller] stale approved_to_ship reconcile error:",
						err instanceof Error ? err.message : String(err),
					);
					this.maybeRecoverStore(err);
				}
				await yieldToEventLoop();
			}

			// FLY-945 Fix D: external-merge convergence sweeper on the patrol
			// cadence (zero new timer). The closure (built in plugin.ts) owns its
			// gh budget; its errors never abort the poll loop.
			if (
				this.config.externalMergeReconcile &&
				this.tickCount % this.patrolEveryNTicks() === 1
			) {
				try {
					await this.withSpan("gate-poller.external-merge-reconcile", () =>
						this.config.externalMergeReconcile?.(),
					);
				} catch (err) {
					console.warn(
						"[GatePoller] external-merge reconcile error:",
						err instanceof Error ? err.message : String(err),
					);
					this.maybeRecoverStore(err);
				}
				await yieldToEventLoop();
			}
		} finally {
			this.polling = false;
			try {
				this.config.recordSpan?.("gate-poller.tick", spanStart, Date.now());
			} catch {
				// Diagnostics must never disable the poller it observes.
			}
		}
	}

	private tickCount = 0;

	// FLY-307 A: stale gate_question eviction bookkeeping (process-local).
	// `evictedGateIds` = cleanup write succeeded → skip permanently and silently.
	// `evictionRetryAt` = cleanup write failed → suppress getSession()/warnings
	// until tickCount reaches the stored tick, then retry the write.
	private readonly evictedGateIds = new Set<string>();
	private readonly evictionRetryAt = new Map<string, number>();
	private readonly migratedCommDbPaths = new Set<string>();
	private readonly commDbMigrationRetryAt = new Map<string, number>();
	private readonly commDbMigrationAlerted = new Set<string>();
	private readonly orphanQuestions = new Map<
		string,
		{ firstSeenTick: number }
	>();

	// FLY-307 B: per-lead circuit breaker keyed `projectName::agentId`.
	private readonly circuitFailures = new Map<string, number>();
	private readonly circuitCooldownUntil = new Map<string, number>();

	private rememberOrphanQuestion(questionId: string): void {
		if (this.orphanQuestions.size >= 500) {
			const oldest = this.orphanQuestions.keys().next().value;
			if (oldest) this.orphanQuestions.delete(oldest);
		}
		this.orphanQuestions.set(questionId, { firstSeenTick: this.tickCount });
	}

	private async withSpan<T>(
		name: string,
		run: () => T | Promise<T>,
	): Promise<T> {
		const startedAt = Date.now();
		try {
			return await run();
		} finally {
			try {
				this.config.recordSpan?.(name, startedAt, Date.now());
			} catch {
				// Diagnostics must never alter rider control flow.
			}
		}
	}

	private patrolEveryNTicks(): number {
		return this.config.patrolEveryNTicks ?? DEFAULT_PATROL_EVERY_N_TICKS;
	}

	// FLY-513: cadence for the optional global-codex drift probe (default 20 ≈ 60s).
	private healthCheckEveryNTicks(): number {
		return this.config.healthCheckEveryNTicks ?? DEFAULT_PATROL_EVERY_N_TICKS;
	}

	private reconcilePatrolEveryNTicks(): number {
		return Math.max(
			1,
			this.config.reconcilePatrolEveryNTicks ?? DEFAULT_PATROL_EVERY_N_TICKS,
		);
	}

	private runReconcilePatrolPass(): Promise<void> {
		if (this.reconcilePatrolPass) return this.reconcilePatrolPass;
		const pass = Promise.resolve()
			.then(() =>
				this.withSpan("gate-poller.reconcile-patrol", () =>
					this.config.onReconcilePatrolTick?.(),
				),
			)
			.then(() => undefined);
		const guarded = pass.finally(() => {
			if (this.reconcilePatrolPass === guarded) {
				this.reconcilePatrolPass = null;
			}
		});
		this.reconcilePatrolPass = guarded;
		return guarded;
	}

	/**
	 * FLY-1560: is a late-armed rider due on this tick? An unarmed tick is skipped
	 * without anchoring, so the boot pass runs on the first tick where the holder
	 * exists rather than being deferred a whole cadence. With no readiness probe
	 * the anchor lands on tick 1, which reproduces the previous
	 * `(tickCount - 1) % N === 0` schedule exactly.
	 */
	private riderDueThisTick(
		anchor: number | null,
		everyNTicks: number,
		ready: (() => boolean) | undefined,
		setAnchor: (tick: number) => void,
	): boolean {
		if (ready && !ready()) return false;
		if (anchor === null) {
			setAnchor(this.tickCount);
			return true;
		}
		return (this.tickCount - anchor) % everyNTicks === 0;
	}

	private leadReconcileEveryNTicks(): number {
		return Math.max(
			1,
			this.config.leadReconcileEveryNTicks ??
				DEFAULT_LEAD_RECONCILE_EVERY_N_TICKS,
		);
	}

	private runLeadReconcilePass(): Promise<void> {
		if (this.leadReconcilePass) return this.leadReconcilePass;
		const pass = Promise.resolve()
			.then(() =>
				this.withSpan("gate-poller.lead-reconcile", () =>
					this.config.onLeadReconcileTick?.(),
				),
			)
			.then(() => undefined);
		const guarded = pass.finally(() => {
			if (this.leadReconcilePass === guarded) {
				this.leadReconcilePass = null;
			}
		});
		this.leadReconcilePass = guarded;
		return guarded;
	}

	private runnerQuotaScanEveryNTicks(): number {
		return Math.max(
			1,
			this.config.runnerQuotaScanEveryNTicks ??
				DEFAULT_RUNNER_QUOTA_SCAN_EVERY_N_TICKS,
		);
	}

	private runRunnerQuotaScanPass(): Promise<void> {
		if (this.runnerQuotaScanPass) return this.runnerQuotaScanPass;
		const pass = Promise.resolve()
			.then(() =>
				this.withSpan("gate-poller.runner-quota-scan", () =>
					this.config.onRunnerQuotaScanTick?.(),
				),
			)
			.then(() => undefined);
		const guarded = pass.finally(() => {
			if (this.runnerQuotaScanPass === guarded) {
				this.runnerQuotaScanPass = null;
			}
		});
		this.runnerQuotaScanPass = guarded;
		return guarded;
	}

	private flagScanEveryNTicks(): number {
		return Math.max(1, this.config.flagScanEveryNTicks ?? 200);
	}

	private runFlagScanPass(): Promise<void> {
		if (this.flagScanPass) return this.flagScanPass;
		const pass = Promise.resolve()
			.then(() =>
				this.withSpan("gate-poller.flag-scan", () =>
					this.config.onFlagScanTick?.(),
				),
			)
			.then(() => undefined);
		const guarded = pass.finally(() => {
			if (this.flagScanPass === guarded) this.flagScanPass = null;
		});
		this.flagScanPass = guarded;
		return guarded;
	}

	/** FLY-907: display-reconcile sweep cadence (default 60 ≈ 3min at 3s). */
	private displayReconcileEveryNTicks(): number {
		return this.config.displayReconcileEveryNTicks ?? 60;
	}

	private ensureCommDbMigrated(dbPath: string, project: ProjectEntry): boolean {
		if (this.migratedCommDbPaths.has(dbPath)) return true;
		const retryAt = this.commDbMigrationRetryAt.get(dbPath);
		if (retryAt !== undefined && this.tickCount < retryAt) return false;
		try {
			const db = new CommDB(dbPath);
			db.close();
			this.migratedCommDbPaths.add(dbPath);
			this.commDbMigrationRetryAt.delete(dbPath);
			this.commDbMigrationAlerted.delete(dbPath);
			return true;
		} catch (error) {
			this.commDbMigrationRetryAt.set(
				dbPath,
				this.tickCount + DEFAULT_PATROL_EVERY_N_TICKS,
			);
			console.warn(
				`[GatePoller] CommDB migration failed; project relay paused for ${dbPath}: ${error instanceof Error ? error.message : String(error)}`,
			);
			if (!this.commDbMigrationAlerted.has(dbPath)) {
				this.commDbMigrationAlerted.add(dbPath);
				void this.alertCommDbMigrationFailure(project, dbPath, error).catch(
					(alertError) => {
						this.commDbMigrationAlerted.delete(dbPath);
						console.warn(
							`[GatePoller] CommDB migration Lead alert failed for ${dbPath}: ${alertError instanceof Error ? alertError.message : String(alertError)}`,
						);
					},
				);
			}
			return false;
		}
	}

	private async alertCommDbMigrationFailure(
		project: ProjectEntry,
		dbPath: string,
		error: unknown,
	): Promise<void> {
		const sink = this.config.leadAlertSink;
		const route = project.leads[0]
			? { leadId: project.leads[0].agentId, projectName: project.projectName }
			: this.infraAlertRoute();
		if (!sink || !route) {
			this.commDbMigrationAlerted.delete(dbPath);
			return;
		}
		const pathHash = createHash("sha256")
			.update(dbPath)
			.digest("hex")
			.slice(0, 12);
		const result = await sink.alert({
			leadId: route.leadId,
			projectName: route.projectName,
			eventId: `commdb-migration-failed:${project.projectName}:${pathHash}`,
			eventType: "crash_loop",
			title: `CommDB relay paused — ${project.projectName}`,
			body:
				`Bridge could not migrate/open ${dbPath}; all gate and question relay for ` +
				`${project.projectName} is paused until recovery. Error: ${error instanceof Error ? error.message : String(error)}`,
			severity: "warning",
		});
		if (
			!result.sent &&
			!result.queued &&
			!result.dmSent &&
			result.skipped !== "duplicate"
		) {
			this.commDbMigrationAlerted.delete(dbPath);
		}
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
		// FLY-1257 path-2 (defense in depth): the invariant lives at the single
		// mutation chokepoint, so neither caller — the relay path nor the
		// eviction-retry short-circuit above — can expire a review gate.
		if (isReviewGateCheckpoint(question.checkpoint)) return;
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

	private getPendingQuestions(
		dbPath: string,
		leadId: string,
	): PendingQuestion[] {
		let db: CommDB;
		try {
			db = CommDB.openReadonly(dbPath);
		} catch {
			// Missing or unreadable CommDB means there is nothing safe to relay this tick.
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
				// FLY-1257 path-2: a review gate outlives its author by design — the
				// review coordinator binds it and the reviewer answers it, so the
				// FLY-307 A premise below does not hold. Withhold delivery (as ever
				// for a terminal session) but leave the gate bindable; the schema's
				// own `expires_at` default (+72h, flywheel-comm db.ts) still bounds it.
				if (isReviewGateCheckpoint(question.checkpoint)) return;
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
			question_kind: question.kind ?? undefined,
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
		const commDb = new CommDB(dbPath, false);
		try {
			if (!commDb.markQuestionProtected(question.id, String(seq))) {
				console.warn(
					`[GatePoller] question ${question.id} could not bind to lead event seq ${seq}; relay continues without protection`,
				);
			}
		} finally {
			commDb.close();
		}

		// Deliver to Lead via the runtime (CommDB instruction or mailbox).
		const runtime = this.config.runtimeRegistry.getForLead(lead.agentId);
		if (runtime) {
			const envelope: LeadEventEnvelope = {
				eventId,
				seq,
				event: payload,
				sessionKey: session.execution_id,
				leadId: lead.agentId,
				timestamp: new Date().toISOString(),
			};

			const result = await dispatchLeadEvent(
				this.config.runtimeRegistry,
				runtime,
				envelope,
			);

			if (result.delivered) {
				this.config.store.markLeadEventDelivered(seq);
			} else if (result.queued) {
				// Durable inbox loop owns the delivery receipt.
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
	private founderReplyScanCursor: string | null = null;
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
				retired = wdb.retireShipGate(question.id, {
					supersededBy: boundQid,
				});
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

	private founderThreadGraceMs(): number {
		return this.config.founderThreadNotifyGraceMs ?? 10 * 60_000;
	}

	/** FLY-2101: founder fixed ship-card grace at 15s; config remains a test seam. */
	private shipGateCardGraceMs(): number {
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
		if (!this.config.chatThreadsEnabled) return;
		const cp = question.checkpoint;
		if (
			cp !== "brainstorm" &&
			cp !== "approve_to_ship" &&
			cp !== "founder_review"
		)
			return;
		const gateOwnership =
			typeof this.config.store.workflowGatePresentationDisposition ===
			"function"
				? this.config.store.workflowGatePresentationDisposition({
						executionId: question.from_agent,
						checkpoint: cp,
						questionId: question.id,
					})
				: { allow: true as const };
		if (!gateOwnership.allow) {
			return;
		}
		// FLY-1832: an engine workflow holder owns approve_to_ship presentation.
		// `holder_authoritative` means the materializer is responsible for the one
		// durable card; it is not permission for this legacy fallback to post a
		// second, phase-prefixed copy. Holder-less legacy gates still use this path.
		if (
			cp === "approve_to_ship" &&
			"reason" in gateOwnership &&
			gateOwnership.reason === "holder_authoritative"
		) {
			return;
		}

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
			cp === "founder_review" || cp === "approve_to_ship"
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

		// FLY-1758: this card is review authority, not a best-effort ping. The
		// payload must belong to the exact sealed capable run. An existing binding
		// means a prior tick crashed after the POST; converge the marker without
		// creating a second authority card.
		const founderReviewContent =
			cp === "founder_review"
				? parseFounderReviewQuestionContent(summary)
				: undefined;
		if (cp === "founder_review") {
			const project = this.config.projects.find(
				(candidate) => candidate.projectName === session.project_name,
			);
			if (!project?.projectRoot) return;
			try {
				if (!(await founderReviewCheckpointEnabled(project.projectRoot)))
					return;
			} catch (error) {
				console.warn(
					`[gate-poller] founder_review config unavailable for ${session.project_name}: ${error instanceof Error ? error.message : String(error)}`,
				);
				return;
			}
			const context = this.config.store.getGeneralizedWorkflowNodeForExecution(
				session.execution_id,
			);
			if (
				!founderReviewContent ||
				!context ||
				founderReviewContent.runId !== context.run.run_id ||
				!nodeRequiresFounderReview(context.snapshot, context.node.id)
			) {
				return;
			}
			const existing = this.config.store.getFounderReviewCardBindingByQuestion(
				question.id,
			);
			if (existing) {
				if (
					existing.run_id === founderReviewContent.runId &&
					existing.artifact_digest === founderReviewContent.artifactDigest
				) {
					this.writeFounderThreadMarker(question, session, "binding_recovered");
				}
				return;
			}
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
					session.design_backend,
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

		// A 2xx without a Discord message id is not a delivered founder-review
		// round. Bind the exact card before writing the durable notify marker; any
		// failure stays retryable and therefore cannot authorize a later response.
		if (cp === "founder_review" && result.kind === "posted") {
			if (!result.gateMessageId || !founderReviewContent) {
				this.founderNotifyRetry.set(question.id, {
					firstFailedAtMs: retry?.firstFailedAtMs ?? now,
					nextAttemptAtMs: now + 30_000,
					attempts: (retry?.attempts ?? 0) + 1,
				});
				return;
			}
			try {
				const binding = this.config.store.bindFounderReviewCard({
					questionId: question.id,
					messageId: result.gateMessageId,
					runId: founderReviewContent.runId,
					artifactDigest: founderReviewContent.artifactDigest,
					createdAt: new Date(now).toISOString(),
				});
				if (binding.status === "conflict") return;
			} catch (error) {
				console.warn(
					`[gate-poller] founder-review card binding failed for ${question.id}: ${error instanceof Error ? error.message : String(error)}`,
				);
				return;
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
	 * `leadAlertSink`; `founder_gate_delivery_failed` event type. One alert per
	 * undelivered ping — the
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
				eventType: "founder_gate_delivery_failed",
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

	// ── Founder-reply inbound delivery (FLY-1392: founder→Lead) ──

	private founderReplyDeliverGraceMs(): number {
		return this.config.founderReplyDeliverGraceMs ?? 10 * 60_000;
	}

	/** FLY-2101: founder fixed ship-gate grace at 15s; config remains a test seam. */
	private shipGateGraceMs(): number {
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

	private founderReplyScanBudget(): number {
		const configured = this.config.founderReplyScanBudget;
		return Number.isSafeInteger(configured) && (configured as number) >= 0
			? (configured as number)
			: FOUNDER_REPLY_SCAN_BUDGET_PER_PASS;
	}

	/**
	 * Per (project, lead): take the past-grace pending questions, group them by
	 * issue thread, and let `emitFounderReplyDeliveryForThread` read each thread
	 * once. FLY-1392's path is always a raw Lead handoff; the kill switch pauses
	 * chasing only.
	 *
	 */
	private async founderReplyDeliverPass(): Promise<void> {
		if (!this.config.chatThreadsEnabled) return;
		const ownerUserId = this.config.discordOwnerUserId;
		if (!isDiscordSnowflake(ownerUserId)) return;
		const graceMs = this.founderReplyDeliverGraceMs();
		// Codex code R4 HIGH: re-drive any dead-letters whose StateStore write
		// failed on a prior pass BEFORE scanning (the store may have self-healed).
		this.retryPendingDeadLetters();

		const sessions = this.config.store.listNonTerminalSessions();
		const resources = new Map<
			string,
			{ readonlyDb: CommDB; writerDb: CommDB }
		>();
		const tasks: Array<{
			ctx: FounderReplyThreadCtx;
			questions: PendingQuestionForThread[];
			writerDb: CommDB;
			deliverAmbiguousToLead: NonNullable<
				FounderReplyDeliverDeps["deliverAmbiguousToLead"]
			>;
		}> = [];
		try {
			for (const project of this.config.projects) {
				const dbPath = defaultGetCommDbPath(project.projectName);
				let readonlyDb: CommDB;
				let writerDb: CommDB;
				try {
					readonlyDb = CommDB.openReadonly(dbPath);
					try {
						writerDb = new CommDB(dbPath, false);
					} catch {
						readonlyDb.close();
						continue;
					}
				} catch {
					continue; // CommDB not present yet
				}
				resources.set(project.projectName, { readonlyDb, writerDb });

				for (const lead of project.leads) {
					const botToken = lead.botToken ?? this.config.discordBotToken;
					if (!botToken) {
						await yieldToEventLoop();
						continue;
					}

					let pending: PendingQuestion[];
					try {
						pending = readonlyDb.getPendingQuestions(
							lead.agentId,
						) as PendingQuestion[];
					} catch {
						await yieldToEventLoop();
						continue; // CommDB not present yet
					}

					// Build every live issue thread first, then attach pending questions as
					// Lead context. Question age never gates founder ingress in v2.
					const byThread = new Map<
						string,
						{
							ctx: FounderReplyThreadCtx;
							questions: PendingQuestionForThread[];
						}
					>();
					for (const session of sessions) {
						if (session.project_name !== project.projectName) continue;
						try {
							if (!matchesLead(session, lead.agentId, this.config.projects))
								continue;
						} catch {
							continue;
						}
						const thread = this.config.store.getChatThreadByIssue(
							session.issue_id,
							lead.chatChannel,
						);
						if (!thread?.thread_id || byThread.has(thread.thread_id)) continue;
						byThread.set(thread.thread_id, {
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
						});
					}
					for (const q of pending) {
						// FLY-1041 Chunk 9 (Fix D): a runner's `ask --report` status report
						// is NEVER a founder-reply binding candidate — it neither absorbs
						// a founder "ship" nor inflates the ambiguity denominator. This is
						// the ONLY place reports are special-cased: relayToLead, the
						// pending CLI, and liveness all keep treating them as questions.
						if (q.kind === "report") continue;
						// FLY-1314: cross-family design/code review gates are reviewer
						// transport, never founder-answerable. Leaving them in this set
						// makes a one-letter founder reply ambiguous with the actual ship
						// gate. This exclusion deliberately does not alter relay/pending/
						// liveness semantics for review gates.
						if (isReviewGateCheckpoint(q.checkpoint)) {
							continue;
						}
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
						tasks.push({
							ctx,
							questions,
							writerDb,
							deliverAmbiguousToLead,
						});
					}
					await yieldToEventLoop();
				}
			}

			tasks.sort((left, right) =>
				compareThreadIds(left.ctx.threadId, right.ctx.threadId),
			);
			const questioned = tasks.filter((task) => task.questions.length > 0);
			const scan = tasks.filter((task) => task.questions.length === 0);
			const scanBudget = Math.min(this.founderReplyScanBudget(), scan.length);
			const firstAfterCursor =
				this.founderReplyScanCursor === null
					? 0
					: scan.findIndex(
							(task) =>
								compareThreadIds(
									task.ctx.threadId,
									this.founderReplyScanCursor!,
								) > 0,
						);
			const start = firstAfterCursor < 0 ? 0 : firstAfterCursor;
			const selectedScan = Array.from(
				{ length: scanBudget },
				(_, index) => scan[(start + index) % scan.length]!,
			);

			for (const task of [
				...questioned.map((value) => ({ value, advancesScanCursor: false })),
				...selectedScan.map((value) => ({ value, advancesScanCursor: true })),
			]) {
				const { ctx, questions, writerDb, deliverAmbiguousToLead } = task.value;
				try {
					await emitFounderReplyDeliveryForThread(ctx, questions, {
						store: this.config.store,
						fetchImpl: this.config.fetchImpl,
						cursorStore: this.config.cursorStore ?? this.defaultReplyCursor,
						commDbLeaseFactory: () => ({ db: writerDb, release: () => {} }),
						deliverAmbiguousToLead,
						tryFounderShipApproval: this.config.tryFounderShipApproval,
						readCurrentBinding: this.config.readCurrentBinding,
						ensureDecisionConvergence: (input) => {
							this.config.store.ensureFounderDecisionConvergence(input);
						},
						classifyDecisionConvergence: (input) => {
							this.config.store.classifyFounderDecisionConvergence(input);
						},
						retryLedger: this.founderReplyRetryLedger(),
					});
				} catch (err) {
					console.warn(
						`[GatePoller] founder-reply deliver error (thread=${ctx.threadId}):`,
						err instanceof Error ? err.message : String(err),
					);
					this.maybeRecoverStore(err);
				} finally {
					if (task.advancesScanCursor) {
						this.founderReplyScanCursor = ctx.threadId;
					}
					await yieldToEventLoop();
				}
			}
		} finally {
			for (const { readonlyDb, writerDb } of resources.values()) {
				try {
					writerDb.close();
				} catch (err) {
					console.warn("[GatePoller] founder-reply writer close failed:", err);
				}
				try {
					readonlyDb.close();
				} catch (err) {
					console.warn(
						"[GatePoller] founder-reply readonly close failed:",
						err,
					);
				}
			}
		}
	}

	// ── FLY-1099: founder-reply reliability wiring ──────────────────────────

	/** FLY-2101: founder fixed the former runtime flag at 30 minutes. */
	private founderReplyDeadletterAgeMs(): number {
		return 30 * 60_000;
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
	 * and a NON-EMPTY latch keeps the pass marked UNHEALTHY.
	 * Honest floor: a Bridge crash drops the latch when storage is fully broken
	 * and nothing durable could be recorded anywhere.
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
					row.attempts < FOUNDER_REPLY_RETRY_MAX &&
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
			// reconcile is the last resort).
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
			gateAuthorityView: rebind.gateAuthorityView,
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
		this.founderReplyUnreachable.beginUnreachableSweep();
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
					// FLY-1328: checkpoint-less asks are now candidates too (the ask
					// branch dispatches internally), so the checkpoint filter is gone.
					// The eviction exclusions are gate-only bookkeeping, so they still
					// only exclude gates — an ask never enters that path.
					const pending = (
						db.getPendingQuestions(lead.agentId) as PendingQuestion[]
					).filter(
						(q) =>
							q.checkpoint == null ||
							(!this.evictedGateIds.has(q.id) &&
								!this.evictionRetryAt.has(q.id)),
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
						leadId: lead.agentId,
						pendingGateQuestions: pending.map((q) => ({
							id: q.id,
							from_agent: q.from_agent,
							checkpoint: q.checkpoint,
							created_at: q.created_at,
							kind: q.kind,
						})),
						db: db as unknown as ZombieCommDb,
						env: process.env,
						resolveDeadGates: false,
						noteUnreachableRunner: (a) =>
							this.founderReplyUnreachable.noteUnreachableRunner(a),
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
		this.founderReplyUnreachable.endUnreachableSweep();
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

				// Collect founder-authority gates for this lead (read-only).
				let reactionGates: PendingQuestion[];
				try {
					const rdb = CommDB.openReadonly(dbPath);
					try {
						reactionGates = (
							rdb.getPendingQuestions(lead.agentId) as PendingQuestion[]
						).filter(
							(q) =>
								q.checkpoint === "approve_to_ship" ||
								q.checkpoint === "founder_review",
						);
					} finally {
						rdb.close();
					}
				} catch {
					continue; // CommDB not present yet
				}
				if (reactionGates.length === 0) continue;

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
					for (const q of reactionGates) {
						const createdMs = parseSqliteUtcMs(q.created_at);
						const checkpointGraceMs =
							q.checkpoint === "founder_review"
								? this.shipGateCardGraceMs()
								: graceMs;
						if (createdMs === null || now - createdMs < checkpointGraceMs)
							continue;
						// Throttle: at most one reactions GET per qid per interval.
						const nextAt = this.founderReactionNextCheck.get(q.id) ?? 0;
						if (now < nextAt) continue;
						this.founderReactionNextCheck.set(
							q.id,
							now + this.founderReactionCheckIntervalMs(),
						);

						const session = this.config.store.getSession(q.from_agent);
						if (!session) continue;
						const gateOwnership =
							typeof this.config.store.workflowGatePresentationDisposition ===
							"function"
								? this.config.store.workflowGatePresentationDisposition({
										executionId: q.from_agent,
										checkpoint: q.checkpoint,
										questionId: q.id,
									})
								: { allow: true as const };
						if (!gateOwnership.allow) {
							continue;
						}
						const thread = this.config.store.getChatThreadByIssue(
							session.issue_id,
							lead.chatChannel,
						);
						if (!thread?.thread_id) continue;

						try {
							if (q.checkpoint === "founder_review") {
								await tryFounderReviewReactionResponse({
									store: this.config.store,
									db,
									questionId: q.id,
									executionId: q.from_agent,
									threadId: thread.thread_id,
									founderId: ownerUserId,
									reactionFetcher: reactionFetcherImpl,
								});
							} else if (tryReaction) {
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
							}
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

	/**
	 * FLY-799 Part B: re-wake sessions stranded in approved_to_ship. A LIVE runner
	 * gets the approval wake re-sent (idempotent; verify-approval still gates the
	 * actual ship); a DEAD one is alerted once (durable event + warn) and deferred
	 * to FLY-795. Re-wake-only — never self-ships, never reads 795's progress.md.
	 */
	private async staleApprovedShipReconcilePass(): Promise<void> {
		const sessions = this.config.store
			.getActiveSessions()
			.filter((s) => s.status === "approved_to_ship")
			.map((s) => ({
				...s,
				shipAttemptFailedHead: shipAttemptFailedSuppressedHead(
					s.session_params,
					s.review_question_id,
				),
			}));
		if (sessions.length === 0) return;

		await reconcileStaleApprovedShip({
			sessions: sessions as RewakeSessionProbe[],
			nowMs: Date.now(),
			graceMs: DEFAULT_REWAKE_GRACE_MS,
			backoffMs: DEFAULT_REWAKE_BACKOFF_MS,
			backoff: this.staleShipRewakeBackoff,
			deadAlerted: this.staleShipDeadAlerted,
			probe: async (s) => {
				if (!isAutoMigratableClaudeTmux(s.adapter_type)) {
					return "indeterminate";
				}
				const target = lookupTmuxTarget(s.execution_id, s.project_name);
				if (target.kind === "error") return "indeterminate";
				if (target.kind === "found") {
					const verdict = await probeRunnerProcessLiveness(
						target.target.tmuxWindow,
					);
					const classified = classifyStaleShipRunnerLiveness(verdict);
					if (classified !== "indeterminate") return classified;
					if (verdict === "indeterminate") return "indeterminate";
				}
				const discovery = await discoverTmuxTargetByExecutionId(s.execution_id);
				if (discovery.kind === "found") {
					const verdict = await probeRunnerProcessLiveness(
						discovery.tmuxWindow,
					);
					const classified = classifyStaleShipRunnerLiveness(verdict);
					if (classified !== "indeterminate") return classified;
					if (verdict === "indeterminate") return "indeterminate";
				} else if (discovery.kind !== "missing") {
					return "indeterminate";
				}
				const generation = parsePaneLossGenerationParams(s.session_params);
				if (!generation) return "indeterminate";
				const current = await probeTmuxServerStartTime(generation.socket_path);
				return current.kind === "found" &&
					current.startTime !== generation.server_start_time
					? "dead"
					: "indeterminate";
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
						{
							issue_id: s.issue_id,
							project_name: s.project_name,
							review_question_id: s.review_question_id,
						},
						"approval_wake",
						{ questionId: s.review_question_id },
					);
				} finally {
					db.close();
				}
			},
			alertDead: async (s) => {
				const current = this.config.store.getSession(s.execution_id);
				if (
					current?.status !== "approved_to_ship" ||
					current.review_question_id !== s.review_question_id ||
					current.pr_head_sha !== s.pr_head_sha
				) {
					return false;
				}
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
					// The external alert remains retryable if the audit store is unavailable.
				}
				const resolved = this.resolveAlertRoute(s.project_name, s.execution_id);
				const route = resolved
					? { leadId: resolved.leadId, projectName: s.project_name }
					: this.infraAlertRoute();
				if (!route || !this.config.leadAlertSink) return false;
				const result = await this.config.leadAlertSink.alert({
					leadId: route.leadId,
					projectName: route.projectName,
					eventId: `stale-approved-ship-dead:${s.execution_id}`,
					eventType: "stale_approved_ship_dead",
					title: `Approved ship runner dead — ${s.issue_id}`,
					body:
						`Execution ${s.execution_id} was stranded in approved_to_ship and its exact tmux target is proven dead. ` +
						"The reconcile did not self-ship; use the durable recovery path.",
					severity: "severe",
					sessionKey: s.execution_id,
				});
				return deadAlertAccepted(result);
			},
			diagnose: (s, reason) => {
				console.warn(
					`[GatePoller] FLY-1393 W-1 indeterminate for ${s.execution_id}: ${reason}; harmless re-wake only, no death alert`,
				);
			},
		});
	}

	/**
	 * Durable founder-message handoff audit. The deliverer has already inserted
	 * the canonical founder row into comm.db; this method must never dispatch a
	 * second lead_event row. It persists the audit mirror and rings the queue
	 * doorbell only.
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
				this.config.runtimeRegistry.nudgeLeadInbox?.(lead.agentId, projectName);
				return true;
			}
			const issueId = String(payload.issueId ?? "");
			const answer = String(payload.answer ?? "");
			const msgId = String(payload.msgId ?? "");
			const commDbPath = String(payload.commDbPath ?? "");
			const sourceThread = String(payload.threadId ?? "").trim();
			if (!sourceThread) {
				throw new Error("founder_reply_source_thread_missing");
			}
			const hookPayload: HookPayload = {
				event_type: "founder_reply",
				execution_id: "",
				issue_id: issueId,
				project_name: projectName,
				status: "founder_reply",
				summary: answer,
				chat_thread_id: sourceThread,
				founder_message_id: msgId,
				comm_db_path: commDbPath,
				action:
					`Handle this founder message as Lead. If it answers a Runner question, route it with ` +
					`flywheel-comm respond <qid> "<founder-answer>" --lead ${lead.agentId} ` +
					`--db ${commDbPath} --source-thread ${sourceThread} ` +
					`--bridge-url "$BRIDGE_URL". If no Runner action is needed, close the ` +
					`corresponding FLY-1575 task as no_action with a reason.`,
			};
			const seq = this.config.store.appendLeadEvent(
				lead.agentId,
				eventId,
				"founder_reply",
				JSON.stringify(hookPayload),
				issueId,
			);
			this.config.store.markLeadEventDelivered(seq);
			// The StateStore event is audit-only. Marking it delivered prevents the
			// legacy reconciler from materializing a sibling lead_event:* queue row.
			this.config.store.flush();
			this.config.runtimeRegistry.nudgeLeadInbox?.(lead.agentId, projectName);
			return true;
		};
	}
}
