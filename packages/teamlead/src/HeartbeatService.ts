import { randomUUID } from "node:crypto";
import { type BodyObservation, withSyncOpMarker } from "flywheel-claude-runner";
import { CommDB } from "flywheel-comm/db";
import { phaseThreadBadge } from "flywheel-config";
import type { ApplyTransitionOpts } from "./applyTransition.js";
import type {
	ChatThreadContext,
	ChatThreadCreator,
} from "./bridge/ChatThreadCreator.js";
import { resolveChatThreadId } from "./bridge/chat-thread-utils.js";
import {
	type CompleteMarkerHeldAlert,
	type MarkerReconcilerDeps,
	type ReconcileOutcome,
	tryReconcileComplete,
} from "./bridge/complete-marker-reconciler.js";
import {
	completionBlocksDeath,
	hasUnresolvedCompleteMarker,
} from "./bridge/completion-before-death.js";
import {
	type CrashReaperInjectedDeps,
	reapCrashedRunners,
} from "./bridge/crash-reaper.js";
import {
	type EventFilter,
	leadEventDeliveryDisposition,
} from "./bridge/EventFilter.js";
import type { ExecutionBodyConvergenceResult } from "./bridge/execution-body-convergence.js";
import { storeLeadTokenSavingsEnabled } from "./bridge/flag-store-runtime.js";
import { buildSessionKey, type HookPayload } from "./bridge/hook-payload.js";
import type { IssueDisplayRefreshHolder } from "./bridge/issue-display-refresher.js";
import {
	GUARDRAIL_EVENT_TYPES,
	type LeadEventEnvelope,
	type LeadRuntime,
} from "./bridge/lead-runtime.js";
import type { MaterializedHeadAuthority } from "./bridge/materialized-head-authority.js";
import type { QuietSignals } from "./bridge/quiet-classifier.js";
import { sessionModelDisplay } from "./bridge/runner-model-display.js";
import {
	dispatchLeadEventCompat,
	type RuntimeRegistry,
} from "./bridge/runtime-registry.js";
import { reconnectingBadge, stageBadge } from "./bridge/stage-utils.js";
import {
	getTmuxTargetFromCommDb,
	isTmuxWindowAlive,
	type RunnerLivenessProbeFailure,
} from "./bridge/tmux-lookup.js";
import {
	GHOST_PROBE_MAX_ROWS,
	TURN_GRANT_GRACE_MS,
} from "./bridge/turn-belt-reconcile.js";
import {
	inspectWorktreeForUnpushedWork,
	type WorktreeInspection,
} from "./bridge/worktree-inspect.js";
import type { ZombieEvidence } from "./bridge/zombie-evidence.js";
import { type ProjectEntry, resolveLeadForIssue } from "./ProjectConfig.js";
import type { Session, StateStore } from "./StateStore.js";

/**
 * FLY-867: injected stale-terminal close chokepoint. Production wires this to
 * `closeRunner({ reason: "fly867_stale_terminal", forcePreserved: true, archive })`
 * so a terminal-status session whose tmux window is still alive past
 * `staleThresholdHours` is torn down through the ONE canonical teardown path
 * (tmux kill + FLY-685 cmux close-request marker + FLY-369 archive + CommDB
 * row deletion). Absent (tests / legacy wiring) → checkStaleCompleted keeps
 * its pre-FLY-867 notify-only behavior byte-for-byte.
 */
export interface StaleTerminalCloseConfig {
	closeStale(
		session: Session,
	): Promise<{ closed: boolean; alreadyGone?: boolean }>;
}

/**
 * FLY-1204: the phase FSM states that are terminal — a session in one of these
 * will never transition back to actively-working, so the reclaim patrol treats
 * it as never-a-working-holder. Mirrors the terminal set the FSM never leaves.
 */
const TERMINAL_PHASE_STATUSES = new Set<string>([
	"completed",
	"failed",
	"terminated",
	"rejected",
	"deferred",
	"shelved",
]);

/**
 * FLY-1204 (plan §C0 probe budget; FLY-1210 root-fix / Codex code-review R4): the
 * max candidates the parked-phase reclaim patrol processes per sweep. It walks the
 * candidates in a STABLE global `execution_id` order behind a single execution_id
 * watermark, so a set larger than the cap drains over ⌈total/cap⌉ sweeps and EVERY
 * candidate is reached — the coverage does not depend on any per-sweep issue window
 * (which would thrash a modulo cursor and could starve a live leak spread across
 * many issues). Each processed candidate costs at most one cleanup probe plus, the
 * first time its issue is seen this sweep, its bounded (≤ GHOST_PROBE_MAX_ROWS/role)
 * verdict — so the total per-sweep work is bounded by the cap. Exported so the
 * safety-boundary test asserts the exact per-sweep cap.
 */
export const PARKED_SWEEP_CANDIDATE_CAP = 200;

/** FLY-1282: shared empty held-set for ticks that skip the liveness chain. */
const EMPTY_SET: ReadonlySet<string> = new Set();

/** FLY-1282: a collected (not yet flushed) re-established notice. */
interface ReestablishedNoticeIntent {
	session: Session;
	minutesSince: number;
	livenessProbe: {
		target?: string;
		probedAt: string;
		method?: "execution_process";
	};
}

/** FLY-1282: pass-local state for one zombie-ON readopt reconcile pass. */
interface ReadoptPassCtx {
	/** dead-verdict execIds not yet (successfully) declared — this pass's
	 * suppression tokens, threaded into reapOrphans (INV-3b). */
	held: Set<string>;
	/** Two-step notice aggregation (R7 #1): flushed after ALL candidates. */
	intents: ReestablishedNoticeIntent[];
}

/**
 * FLY-1204: injected chokepoint for the periodic parked-phase reclaim patrol —
 * the safety net that reclaims DAG workflow keep-alive phase sessions (design/
 * implement/qa) that leaked alive past ship or pipeline termination. Wired in
 * production; absent (tests / not wired) → `checkStaleParkedPhases` is inert
 * (byte-compat). The patrol NEVER kills a healthy parked context-holder — see
 * `computeIssueReclaimVerdict` for the hard "any working phase → keep the whole
 * issue" guard and the TOCTOU-honest auto-kill boundary.
 */
export interface StaleParkedCloseConfig {
	/**
	 * Time safety-net threshold (hours) — only the terminal-guard is the primary
	 * reclaim trigger; time is a pure backstop for the no-ship-claim orphan path.
	 * Env `FLYWHEEL_PARKED_PHASE_STALE_HOURS` (default 24, conservative).
	 */
	parkedStaleHours: number;
	/** Per-project CommDB path resolver (declared-state + TURN reads). */
	commDbPathForProject: (project: string) => string;
	/**
	 * Close a reclaimable parked/terminal phase session through the canonical
	 * closeRunner teardown (finalizeDone, NO thread archive). `noClaim` records
	 * the reason (shipped vs orphan-completed) in the audit.
	 */
	closeParked: (
		session: Session,
		opts: { noClaim: boolean },
	) => Promise<{ closed: boolean; alreadyGone?: boolean }>;
	/**
	 * Alert (issue-level, once) about no-ship-claim orphan parked phases that the
	 * patrol will NOT auto-kill (non-terminal parked — TOCTOU cannot be proven
	 * safe). Operators reclaim these with `close_runner --done`.
	 */
	alertOrphan: (issueId: string, sessions: Session[]) => Promise<void>;
}

/** FLY-2919: process evidence only; unavailable authority stays indeterminate. */
export type SessionLivenessVerdict = "alive" | "dead" | "indeterminate";

export interface SessionLiveness {
	verdict: SessionLivenessVerdict;
	/** tmux window target probed (absent when CommDB had no target). */
	target?: string;
	/** ISO timestamp of this probe. */
	probedAt: string;
}

export type ProbeForensicsSource =
	| "lookup_error"
	| "probe_throw"
	| "probe_unclear"
	| "pending_sentinel";

export interface ProbeForensicsSnapshot {
	lookup_error: number;
	probe_throw: number;
	probe_unclear: number;
	pending_sentinel: number;
	last_at: string | null;
}

/**
 * FLY-1282 (Codex R4 #1 / R5 #1): a fully-prepared zombie alert. Everything
 * needed to append + deliver is resolved BEFORE the FSM transition so the
 * post-transition persist does zero resolve/classify/store reads before the
 * lead_events append (INV-9).
 */
export interface HeartbeatBodyLifecycle {
	observe(executionId: string): Promise<BodyObservation | undefined>;
	converge(executionId: string): Promise<ExecutionBodyConvergenceResult>;
	replayPending?(): Promise<void>;
}

export interface PreparedZombieNotification {
	leadId: string;
	eventId: string;
	eventType: "session_zombie_detected";
	payloadJson: string;
	sessionKey: string;
	/** May be undefined (runtime not registered yet) — persist records an
	 * undelivered row and the existing guardrail retry re-resolves it. */
	runtime: LeadRuntime | undefined;
}

export interface HeartbeatNotifier {
	onSessionOrphaned(
		session: Session,
		minutesSinceHeartbeat: number,
	): Promise<void>;
	/** GEO-270: Stale session patrol — tmux still alive after terminal state. */
	onSessionStale(session: Session, hoursSinceActivity: number): Promise<void>;
	/**
	 * FLY-172: Bridge lost monitoring of a still-running Runner (heartbeat went
	 * stale but tmux is alive — typically after a Flywheel restart). One-time
	 * advisory so the Lead knows to fall back to driving the Runner via tmux.
	 * FLY-623: this advisory remains for indeterminate liveness; positively alive
	 * sessions use onSessionMonitoringReestablished instead.
	 */
	onSessionMonitoringLost(
		session: Session,
		minutesSinceHeartbeat: number,
		/**
		 * FLY-1282 (arity sentinel, FLY-1234 precedent): ONLY passed on the
		 * readopt-ON indeterminate path — liveness could NOT be verified, so the
		 * context must not claim the runner is alive. Legacy callers keep the
		 * exact two-argument call and the current copy byte-for-byte.
		 *
		 * FLY-1329 (A3, Codex R3): `parkedLiveness` carries a PROVABLE-absence
		 * verdict for a parked re-adopt that found the runner gone. The legacy
		 * two-argument copy says "still alive and working" — false for a dead
		 * parked runner — so the death path must describe the verdict honestly
		 * instead. `unverified` and `parkedLiveness` are mutually exclusive.
		 */
		details?: {
			unverified?: boolean;
			parkedLiveness?: "dead" | "dead_pin" | "gone";
		},
	): Promise<void>;
	/**
	 * FLY-623: readopt-ON happy path — the Bridge re-adopted a live detached
	 * Runner after a restart (heartbeat re-established via tmux liveness). A
	 * one-time, low-priority, NON-retryable FYI per reconnecting episode. An
	 * implementation that owns a chat thread also restores the actual phase/status
	 * title here, so a Bridge-restart warning cannot remain stale after re-adopt.
	 */
	onSessionMonitoringReestablished(
		session: Session,
		minutesSinceHeartbeat: number,
		details?: {
			stampReconnectTitle?: boolean;
			/**
			 * FLY-1282 (INV-2): point-in-time pane-probe evidence. Present ONLY on
			 * the zombie-machinery-ON path where re-adoption requires a positive
			 * `alive` verdict; absent → the legacy payload/copy is byte-preserved.
			 */
			livenessProbe?: {
				target?: string;
				probedAt: string;
				method?: "execution_process";
			};
			/**
			 * FLY-1282: same-pass re-adoption cohort size, passed only when >= 3
			 * (monitoring-side-interruption suspicion — observation, not diagnosis).
			 */
			concurrentCount?: number;
		},
	): Promise<void>;
	/**
	 * FLY-1282 (INV-8/INV-9, two-phase contract — Codex R4 #1): synchronous
	 * preparation of a `session_zombie_detected` alert. Performs ALL
	 * store/registry/filter reads and encapsulates the deterministic
	 * `zombie-<execId>` event id; returns null when no Lead is resolvable
	 * (caller writes the deterministic session_events audit AFTER the
	 * transition — prepare itself must never touch the persistent layer).
	 */
	prepareSessionZombieDetected(
		session: Session,
		evidence: ZombieEvidence,
		inspection: WorktreeInspection,
	): PreparedZombieNotification | null;
	/**
	 * FLY-1282 (INV-9): persist + deliver a prepared zombie alert. The FIRST
	 * store mutation is the lead_events append (durable enqueue); transport is
	 * awaited only after, with failures recorded for the existing bounded
	 * guardrail retry. Returns true once the row is durably appended.
	 */
	persistPreparedZombieDetected(
		prepared: PreparedZombieNotification,
	): Promise<boolean>;
	/**
	 * FLY-623: re-stamp the real/terminal status badge on a Runner's thread title
	 * once it leaves the reconnecting state (strips any stale reconnect marker). Optional
	 * + best-effort: a notifier without a chat thread (legacy / tests) no-ops.
	 */
	clearReconnectStamp?(session: Session): void;
}

/**
 * FLY-623: the narrow read/clear surface the event path uses on
 * HeartbeatService's reconnecting set, threaded via a late-bound holder (the
 * service is constructed after the router is wired). `HeartbeatService`
 * implements it.
 */
export interface ReconnectController {
	/** True while a Runner is re-adopted (detached but tmux-alive) after a restart. */
	isReconnecting(executionId: string): boolean;
	/** True only while the founder-facing reconnect title still owns Face A. */
	isReconnectTitleActive(executionId: string): boolean;
	/** Drop a Runner from the reconnecting set on a genuine event / terminal / death. */
	clearReconnecting(executionId: string): void;
	/** End title episodes for selected execs (or every active one); keep monitor protection. */
	settleReconnectTitles(executionIds?: readonly string[]): Session[];
}

/**
 * FLY-172: how HeartbeatService reaches the marker reconciler. The reconciler
 * itself never probes tmux — HeartbeatService owns liveness (Codex guidance #1).
 */
export interface MonitorReconcileConfig {
	bridgeBaseUrl: string;
	ingestToken?: string;
	fetchFn?: typeof fetch;
	markerDir?: string;
	quarantineDir?: string;
	/** FLY-1314: readonly gate-disposition lookup for timeout suppression. */
	commDbPathForProject?: (projectName: string) => string;
	onTerminalStatusPersisted?: (
		executionId: string,
		status: "failed" | "blocked",
		projectName: string,
	) => void;
	alertMergeWithoutApproval?: (session: Session, reason: string) => void;
	alertShipAttemptFailed?: (session: Session, reason: string) => Promise<void>;
	alertCompleteMarkerHeld?: (args: CompleteMarkerHeldAlert) => Promise<void>;
	materializedHeadAuthority?: MaterializedHeadAuthority;
}

/**
 * FLY-1329 (A3): the PARKED statuses boot re-adopt must cover, in addition to
 * `running`. Kept in lock-step with `StateStore.getReadoptCandidateSessions`'s
 * status set (running + these three); the readopt-parked test suite pins the
 * behavioural agreement by re-adopting a candidate at each of these statuses.
 * `running` is handled by the mainline consumer path, so it is deliberately NOT
 * here — this predicate answers "is this a keep-alive parked phase?".
 */
const READOPT_PARKED_STATUSES: ReadonlySet<string> = new Set([
	"ship_parked",
	"awaiting_review",
	"design_done",
	"approved_to_ship",
]);

function isReadoptParkedStatus(status: string): boolean {
	return READOPT_PARKED_STATUSES.has(status);
}

function isSettledMarkerOutcome(outcome: ReconcileOutcome): boolean {
	return (
		outcome.kind === "reconciled" ||
		outcome.kind === "duplicate_terminal" ||
		outcome.kind === "settled_merge_block" ||
		outcome.kind === "settled_ship_attempt_failed"
	);
}

interface LivenessPassTracker {
	started(): number;
	completed(generation: number): void;
}

/**
 * Periodic checker for orphan sessions (running but heartbeat has gone stale)
 * and lifecycle cleanup conditions.
 * Sends one notification per execution per condition, deduped in-memory.
 */
export class HeartbeatService implements ReconnectController {
	private timer: NodeJS.Timeout | null = null;
	private notifiedStale = new Set<string>();
	private lastStaleCheckAt = 0;
	// FLY-1204: parked-phase reclaim patrol state — independent throttle +
	// global re-entrancy guard (a long sweep must not be re-entered by the next
	// tick) + per-issue in-flight set.
	private lastParkedCheckAt = 0;
	private parkedSweepRunning = false;
	// FLY-1204 (FLY-1210 root-fix): a STABLE execution_id watermark. The reclaim
	// patrol walks candidates in stable execution_id order behind this watermark,
	// PARKED_SWEEP_CANDIDATE_CAP at a time, wrapping at the end. Stable identity +
	// stable ordering = every candidate is reached over ⌈total/cap⌉ sweeps, with no
	// per-sweep-window modulo that could starve a live leak. `""` restarts at head.
	private parkedCleanupWatermark = "";
	/**
	 * FLY-172: execIds for which a `session_monitoring_lost` advisory was already
	 * sent this Bridge-process lifetime (one-time advisory). Members are still
	 * alive-but-detached; removed the moment the reconcile pass observes tmux
	 * dead, so `reapOrphans()` resumes normal signaling.
	 */
	private notifiedMonitorLost = new Set<string>();
	/**
	 * FLY-172: execIds with a marker whose replay transiently failed THIS cycle —
	 * `reapOrphans()` must skip force-failing them (retry next cycle). Rebuilt
	 * each `reconcileMonitorLoss()` pass so it never goes stale.
	 */
	private markerRetryPending = new Set<string>();
	/** Re-adopted process-alive executions. This tracks monitoring/title episodes,
	 * not death authority; each pass samples again and markers still win. */
	private reconnecting = new Set<string>();
	/**
	 * FLY-1264: founder-facing title ownership has a shorter lifetime than the
	 * fallback-monitoring protection above. It starts with a reconnect episode and
	 * is settled as soon as the canonical issue-display refresher is ready.
	 */
	private reconnectTitleActive = new Set<string>();
	private reconnectTitleRefresherReady = false;
	/** FLY-1282: per-exec declaration in-flight guard (defense in depth). */
	private zombieDeclaring = new Set<string>();
	/** FLY-1282 (R4 #4): liveness-chain single-flight (zombie-ON only). */
	private livenessChainInFlight = false;
	private livenessPassStartedAt = 0;
	private skippedLivenessTicks = 0;
	/** FLY-1282 (R5 #3): backfill fair-rotation watermark + single-flight. */
	private zombieBackfillWatermark = "";
	private backfillInFlight = false;
	private readonly probeForensicsCounts: Record<ProbeForensicsSource, number> =
		{
			lookup_error: 0,
			probe_throw: 0,
			probe_unclear: 0,
			pending_sentinel: 0,
		};
	private probeForensicsLastAt: string | null = null;

	constructor(
		private store: StateStore,
		private notifier: HeartbeatNotifier,
		private thresholdMinutes: number,
		private intervalMs: number,
		private orphanThresholdMinutes: number,
		private transitionOpts?: ApplyTransitionOpts,
		private staleThresholdHours: number = 24,
		private staleCheckIntervalMs: number = 6 * 3_600_000,
		/** FLY-172: marker reconcile wiring; when absent, monitor-loss reconcile is a no-op. */
		private monitorReconcile?: MonitorReconcileConfig,
		// Retains the historical positional constructor slot for downstream callers.
		_reviewTimeoutHours: number = 48,
		// Historical positional slot retained for downstream constructor callers.
		_legacyQuietSignalsProbe?: (session: Session) => QuietSignals,
		/**
		 * FLY-720: injected crash-reaper deps (tmux/discord/fs sinks + grace +
		 * kill-switch). When wired (production) the crash reaper runs each cycle
		 * BEFORE `reapOrphans`, claiming confirmed dead-pins so `reapOrphans` never
		 * force-fails them to `failed`. Absent (tests / kill-switch OFF) → the crash
		 * reaper is a no-op and behavior is exactly pre-FLY-720.
		 */
		private crashReaperConfig?: CrashReaperInjectedDeps,
		/**
		 * FLY-867: injected stale-terminal close (see StaleTerminalCloseConfig).
		 * Wired (production) → checkStaleCompleted upgrades from notify-only to
		 * notify+close for leaked terminal-status sessions, guarded by the FLY-752
		 * retest-protection predicate. Absent wiring → pre-FLY-867 notify-only.
		 */
		private staleTerminalClose?: StaleTerminalCloseConfig,
		/**
		 * FLY-1082 (Task 2.3): the tmux server-loss coordinator — a PRE-REAPER
		 * phase (after monitor reconcile, before crash reaper) so a fleet-level
		 * server loss is claimed as ONE grouped episode before the per-runner
		 * orphan machinery buries it silently. Returns the claimed exec ids;
		 * they join the orphan suppression set. Absent → no-op (byte-compat).
		 * Wired at the Bridge layer.
		 */
		private serverLoss?: {
			check(): Promise<
				| ReadonlySet<string>
				| {
						claimed: ReadonlySet<string>;
						heldExecutionIds: ReadonlySet<string>;
				  }
			>;
		},
		/**
		 * FLY-1204: injected parked-phase reclaim chokepoint (see
		 * StaleParkedCloseConfig). Wired (production) → `checkStaleParkedPhases`
		 * reclaims leaked DAG workflow sessions behind its own
		 * `FLYWHEEL_PARKED_PHASE_STALE_HOURS` threshold. Absent → inert.
		 */
		private staleParkedClose?: StaleParkedCloseConfig,
		/**
		 * FLY-1185 §2.5 (R3#3): detached maintenance tick — the lifecycle
		 * backstop's scheduler (per-tick MCP orphan reap; every-N-ticks project
		 * sweep — the CALLBACK owns that policy; this service only guarantees
		 * the dispatch contract): NEVER awaited into the core check() chain
		 * (fire-and-forget with its own catch), single-flight (a slow pass
		 * spanning ticks is skipped, never run concurrently), tick 0 fires on
		 * the first cycle (the boot pass). A callback failure can never affect
		 * reapOrphans. Absent → byte-compat no-op.
		 */
		private onMaintenanceTick?: (tick: number) => Promise<void>,
		/** Operational health spans only the liveness owner, never skipped ticks. */
		private livenessPassTracker?: LivenessPassTracker,
		/** FLY-1995: wall-clock correlation only; profiler data owns CPU attribution. */
		private recordSpan?: (name: string, startMs: number, endMs: number) => void,
		/** FLY-2211: best-effort OS snapshot after a Codex zombie becomes durable. */
		private onCodexZombieDeclared?: (session: Session, reason: string) => void,
	) {}

	private maintenanceInFlight = false;
	private maintenanceTickCount = 0;

	/** FLY-1185 §2.5: detached, single-flight maintenance dispatch. */
	private dispatchMaintenanceTick(): void {
		if (!this.onMaintenanceTick) return;
		if (this.maintenanceInFlight) return; // slow pass spans ticks → skip
		this.maintenanceInFlight = true;
		const tick = this.maintenanceTickCount++;
		void this.onMaintenanceTick(tick)
			.catch((err) => {
				console.error(
					`[maintenance-tick] pass ${tick} failed (core heartbeat unaffected): ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			})
			.finally(() => {
				this.maintenanceInFlight = false;
			});
	}

	private executionBodyLifecycle?: HeartbeatBodyLifecycle;

	setExecutionBodyLifecycle(lifecycle: HeartbeatBodyLifecycle): void {
		this.executionBodyLifecycle = lifecycle;
	}

	/** On-demand entry for independently sampled candidates, regardless of age. */
	async reconcileExecutionBody(executionId: string): Promise<boolean> {
		const session = this.store.getSession(executionId);
		return session ? this.declareZombie(session) : false;
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			this.check().catch((err) => {
				console.error("[HeartbeatService] check error:", err);
			});
		}, this.intervalMs);
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	probeForensicsSnapshot(): ProbeForensicsSnapshot {
		return {
			...this.probeForensicsCounts,
			last_at: this.probeForensicsLastAt,
		};
	}

	private recordProbeForensics(
		source: ProbeForensicsSource,
		session: Session,
		input: {
			target?: string;
			pendingTarget?: boolean;
			lookupError?: string;
			failure?: RunnerLivenessProbeFailure;
		} = {},
	): void {
		const at = new Date().toISOString();
		this.probeForensicsCounts[source] += 1;
		this.probeForensicsLastAt = at;
		console.warn(
			`[fly2008-probe] ${JSON.stringify({
				source,
				at,
				execution_id: session.execution_id,
				project_name: session.project_name ?? null,
				target: input.target ?? null,
				pendingTarget: input.pendingTarget === true,
				...(input.lookupError ? { lookup_error: input.lookupError } : {}),
				...(input.failure ? { failure: input.failure } : {}),
			})}`,
		);
	}

	async check(): Promise<void> {
		const spanStart = Date.now();
		// FLY-639: the whole cycle is wrapped so a StateStore sql.js error
		// (getOrphanSessions / getActiveSessions / …) can NEVER
		// crash the Bridge via this heartbeat loop. Contract: check() itself never
		// rejects — on any throw it logs, attempts a best-effort StateStore
		// self-heal, and skips the cycle. (start() still wraps check() in a .catch()
		// as belt-and-suspenders.)
		// FLY-1282 (R4 #4 / R6 #1): the liveness-dependent chain
		// (reconcileMonitorLoss →
		// reapOrphans) is single-flighted as ONE unit — a slow/hung
		// pass makes later ticks skip those checks (observable) while
		// maintenance, retry, server-loss, crash reaper, stale/parked/review
		// stages keep running.
		try {
			try {
				await this.executionBodyLifecycle?.replayPending?.();
			} catch (error) {
				console.warn(
					`[HeartbeatService] body duty replay deferred: ${error instanceof Error ? error.message : String(error)}`,
				);
			}

			// FLY-1282 (R5 #4): recurring zombie-alert backfill — an INDEPENDENT
			// stage outside the liveness guard (a hung liveness pass must not pause
			// alert recovery), with its own single-flight inside.
			// Byte-compat: legacy mock stores may lack the
			// backfill query — skip WITHOUT an await so the pre-existing
			// synchronous path is preserved under fake timers.
			if (typeof this.store.getZombieAlertBacklog === "function") {
				await this.reconcileZombieAlertBacklog();
			}
			// FLY-1282 (code R1 #1): the single-flight guard is acquired HERE — at
			// the entry of the liveness-dependent span — and released in the local
			// finally right after reapOrphans. Retry/backfill above and the
			// stale/parked/review stages below run OUTSIDE the guard: a hang there
			// must never freeze the liveness chain for later ticks (and a hung
			// liveness pass must never freeze them — they run on skipped ticks).
			let livenessOwner = false;
			if (this.livenessChainInFlight) {
				this.skippedLivenessTicks++;
				const inFlightMs = Date.now() - this.livenessPassStartedAt;
				const log = inFlightMs > 10 * 60_000 ? console.warn : console.log;
				log(
					`[HeartbeatService] FLY-1282 liveness chain still in flight (${Math.round(inFlightMs / 1000)}s, ${this.skippedLivenessTicks} tick(s) skipped) — skipping reconcile/orphan this tick`,
				);
			} else {
				this.livenessChainInFlight = true;
				this.livenessPassStartedAt = Date.now();
				this.skippedLivenessTicks = 0;
				livenessOwner = true;
			}
			const runLivenessChain = livenessOwner;
			const livenessGeneration = runLivenessChain
				? this.livenessPassTracker?.started()
				: undefined;
			try {
				// FLY-172: reconcile monitoring loss BEFORE stuck/orphan detection so the
				// marker-retry sets are current. Only independent process evidence
				// can refresh monitoring or authorize the common death transaction.
				// Only awaited when wired (production) — skipping the await when
				// unconfigured keeps the same-tick path synchronous.
				let zombieHeld: ReadonlySet<string> = EMPTY_SET;
				if (runLivenessChain && this.monitorReconcile) {
					zombieHeld = await this.reconcileMonitorLoss();
				}
				// FLY-720: crash reaper runs BEFORE reapOrphans and claims confirmed
				// dead-pins into deadPinOwned so reapOrphans skips them (never force-fails
				// a crash to `failed`). Best-effort — a reaper failure must not skip the
				// rest of the cycle. Only awaited when the reaper is wired + enabled, so an
				// unconfigured Bridge keeps the same-tick path synchronous.
				// FLY-1082 (Task 2.3): server-loss coordinator — the pre-reaper phase.
				// Runs AFTER reconcileMonitorLoss (liveness sets current) and BEFORE
				// the crash reaper / orphan reaping so a fleet-level tmux server death
				// is claimed as ONE grouped, episode-tagged migration in this same
				// cycle; the claimed ids suppress the per-runner paths below.
				// Best-effort — a coordinator failure must never skip the cycle.
				// FLY-1285: check() may return the new {claimed, heldExecutionIds}
				// shape — heldExecutionIds is the unresolved-tmux-socket-evidence
				// hold set that must suppress the crash reaper / stuck advisory /
				// orphan force-fail below.
				let serverLossOwned: ReadonlySet<string> = new Set();
				let tmuxHeld: ReadonlySet<string> = new Set();
				if (this.serverLoss) {
					try {
						const result = await this.serverLoss.check();
						if ("claimed" in result && "heldExecutionIds" in result) {
							serverLossOwned = result.claimed;
							tmuxHeld = result.heldExecutionIds;
						} else {
							// Legacy injected tests/callers returned only the claimed set.
							serverLossOwned = result;
						}
					} catch (err) {
						console.error(
							`[server-loss] check failed (cycle continues): ${(err as Error).message}`,
						);
					}
				}
				let deadPinOwned: ReadonlySet<string> = new Set();
				if (this.crashReaperConfig?.enabled) {
					deadPinOwned = await this.reapCrashedRunners(tmuxHeld);
				}
				if (runLivenessChain) {
					await this.reapOrphans(
						new Set([...deadPinOwned, ...serverLossOwned, ...tmuxHeld]),
						zombieHeld,
					);
				}
			} finally {
				if (livenessGeneration !== undefined) {
					this.livenessPassTracker?.completed(livenessGeneration);
				}
				// FLY-1282 (code R1 #1): release IMMEDIATELY after the liveness span
				// — the stages below must not extend the guard's hold.
				if (livenessOwner) this.livenessChainInFlight = false;
			}
			await this.checkStaleCompleted();
			// FLY-1204: reclaim leaked DAG workflow keep-alive phase sessions
			// (independent throttle; inert unless wired). Its own try/guards keep a
			// failure best-effort — the outer catch is the belt-and-suspenders.
			await this.checkStaleParkedPhases();
		} catch (err) {
			console.error(
				"[HeartbeatService] check error (skipping cycle, Bridge stays up):",
				err instanceof Error ? err.message : String(err),
			);
			// Byte-compat: old mock stores (tests) may lack the method.
			if (typeof this.store.recoverFromCorruption === "function") {
				this.store.recoverFromCorruption(err);
			}
		} finally {
			// FLY-1628: residue maintenance includes pane-loss reconciliation. Run it
			// only after this tick's server-loss coordinator has classified/claimed any
			// fleet-level outage. It remains detached, so neither failure path can
			// affect the other and even a failed core cycle still schedules maintenance.
			this.dispatchMaintenanceTick();
			try {
				this.recordSpan?.("heartbeat.check", spanStart, Date.now());
			} catch {
				// Diagnostics must never alter heartbeat control flow.
			}
		}
	}

	/** FLY-172: marker-reconciler deps, or null when monitor-reconcile isn't wired. */
	private buildMarkerDeps(): MarkerReconcilerDeps | null {
		if (!this.monitorReconcile) return null;
		return {
			store: this.store,
			bridgeBaseUrl: this.monitorReconcile.bridgeBaseUrl,
			ingestToken: this.monitorReconcile.ingestToken,
			fetchFn: this.monitorReconcile.fetchFn,
			markerDir: this.monitorReconcile.markerDir,
			quarantineDir: this.monitorReconcile.quarantineDir,
			materializedHeadAuthority:
				this.monitorReconcile.materializedHeadAuthority,
			onTerminalStatusPersisted:
				this.monitorReconcile.onTerminalStatusPersisted,
			alertMergeWithoutApproval:
				this.monitorReconcile.alertMergeWithoutApproval,
			alertShipAttemptFailed: this.monitorReconcile.alertShipAttemptFailed,
			alertCompleteMarkerHeld: this.monitorReconcile.alertCompleteMarkerHeld,
		};
	}

	/**
	 * FLY-172 + FLY-623: For running sessions whose heartbeat has gone stale
	 * (≥ stuck threshold — the fingerprint of monitoring loss after a restart):
	 * try the completion marker FIRST, then observe the independent process binding.
	 *
	 * The FLY-623 readopt path is the sole behavior: process alive → RE-ADOPT
	 * (refresh heartbeat so
	 *   the session reads healthy + no false stuck/orphan/idle), once-per-episode
	 *   "re-established" advisory + "⚠️重连中" title. Members of `reconnecting` are
	 *   re-processed through the SAME marker-first order each cycle (so a later
	 *   terminal marker still wins — no stay-loop bypass).
	 *
	 * Reliable process death → common exact-owner convergence in this pass.
	 * Owns `notifiedMonitorLost`, `reconnecting`, and `markerRetryPending`.
	 */
	async reconcileMonitorLoss(): Promise<ReadonlySet<string>> {
		this.markerRetryPending.clear();
		const deps = this.buildMarkerDeps();
		if (!deps) return EMPTY_SET; // not wired (e.g. unit tests) → no-op
		return this.reconcileMonitorLossReadopt(deps);
	}

	/**
	 * FLY-623 readopt path (default): re-adopt detached-but-alive Runners. Each
	 * cycle processes the UNION (deduped by execId) of stale-heartbeat candidates
	 * AND current `reconnecting` members (re-fetched — once re-adopted their
	 * heartbeat is fresh so they drop out of `getOrphanSessions`), all through the
	 * same marker-first order. This closes the R1 HIGH-1 stay-loop bypass.
	 */
	private async reconcileMonitorLossReadopt(
		deps: MarkerReconcilerDeps,
	): Promise<ReadonlySet<string>> {
		const byId = new Map<string, Session>();
		for (const s of this.store.getOrphanSessions(this.thresholdMinutes)) {
			byId.set(s.execution_id, s);
		}
		for (const session of this.store.getReadoptCandidateSessions()) {
			if (isReadoptParkedStatus(session.status))
				byId.set(session.execution_id, session);
		}
		// Re-fetch reconnecting members so they keep going through marker-first
		// (R1 HIGH-1) even though their refreshed heartbeat hid them above.
		for (const execId of [...this.reconnecting]) {
			if (byId.has(execId)) continue;
			const s = this.store.getSession(execId);
			if (s) byId.set(execId, s);
			else this.clearReconnecting(execId); // gone entirely
		}
		// Legacy advisory dedup is unused on this path; keep it pruned to candidates.
		for (const id of this.notifiedMonitorLost) {
			if (!byId.has(id)) this.notifiedMonitorLost.delete(id);
		}

		const ctx: ReadoptPassCtx = { held: new Set(), intents: [] };
		for (const session of byId.values()) {
			await this.reconcileCandidateReadoptV2(session, deps, ctx);
		}
		await this.flushReestablishedNotices(ctx);
		return ctx.held;
	}

	/** Process evidence treats running and parked candidates alike; marker reconciliation wins. */
	private async reconcileCandidateReadoptV2(
		session: Session,
		deps: MarkerReconcilerDeps,
		ctx: ReadoptPassCtx,
	): Promise<void> {
		const execId = session.execution_id;

		if (
			session.status !== "running" &&
			!isReadoptParkedStatus(session.status)
		) {
			this.clearReconnecting(execId);
			return;
		}

		// 1) Marker-first. A valid terminal marker proves the Runner finished.
		const outcome = await tryReconcileComplete(execId, deps);
		if (isSettledMarkerOutcome(outcome)) {
			this.clearReconnecting(execId);
			return;
		}
		if (
			outcome.kind === "transient_failed" ||
			outcome.kind === "held_for_lead"
		) {
			this.markerRetryPending.add(execId);
			return;
		}

		const liveness = await this.probeSessionLiveness(session);

		switch (liveness.verdict) {
			case "alive": {
				// A positive probe ends any prior monitor-lost episode (R1 #2).
				this.notifiedMonitorLost.delete(execId);
				const intent = this.bookkeepReconnecting(session, liveness);
				if (intent) ctx.intents.push(intent);
				break;
			}
			case "indeterminate": {
				// Honest degradation (INV-1): suppression via the FLY-172 advisory —
				// no heartbeat refresh, no celebration; reconnecting membership (if
				// any) is left as-is so the union keeps re-probing it.
				await this.emitMonitorLostOnce(session, { unverified: true });
				break;
			}
			case "dead": {
				ctx.held.add(execId);
				if (await this.declareZombie(session)) ctx.held.delete(execId);
				break;
			}
		}
	}

	/** No UI lookup contributes to the physical observation. Missing authority is unknown. */
	private async probeSessionLiveness(
		session: Session,
	): Promise<SessionLiveness> {
		const probedAt = new Date().toISOString();
		try {
			const observation = await this.executionBodyLifecycle?.observe(
				session.execution_id,
			);
			if (
				observation?.identity.executionId === session.execution_id &&
				observation.verdict !== "unknown"
			)
				return {
					verdict: observation.verdict,
					probedAt: observation.observedAt,
				};
		} catch {
			/* Evidence unavailable is never death. */
		}
		this.recordProbeForensics("probe_unclear", session);
		return { verdict: "indeterminate", probedAt };
	}

	/**
	 * FLY-1282 (R7 #1): re-adoption bookkeeping WITHOUT immediate emission —
	 * heartbeat refresh + reconnecting/title membership, returning a notice
	 * intent only for a newly-entered episode. The pass flushes intents after
	 * all candidates so every notice can carry the final same-pass cohort count.
	 */
	private bookkeepReconnecting(
		session: Session,
		liveness: SessionLiveness,
	): ReestablishedNoticeIntent | null {
		const execId = session.execution_id;
		let minutesSince = this.thresholdMinutes;
		if (session.heartbeat_at) {
			minutesSince = Math.round(
				(Date.now() -
					new Date(`${session.heartbeat_at.replace(" ", "T")}Z`).getTime()) /
					60_000,
			);
		}
		this.store.updateHeartbeat(execId);
		if (this.reconnecting.has(execId)) return null; // stay (same episode)
		this.reconnecting.add(execId);
		if (!this.reconnectTitleRefresherReady) {
			this.reconnectTitleActive.add(execId);
		}
		return {
			session,
			minutesSince,
			livenessProbe: {
				probedAt: liveness.probedAt,
				method: "execution_process",
			},
		};
	}

	/**
	 * FLY-1282 (R7 #1 + R8): flush collected re-established notices. Each
	 * notice re-verifies ownership at flush time — an episode a genuine runner
	 * event already ended (clearReconnecting) is skipped ENTIRELY (no event, no
	 * title re-stamp over a recovered title). Per-notice try/catch keeps a
	 * single advisory failure from blocking the rest (best-effort, as before).
	 */
	private async flushReestablishedNotices(ctx: ReadoptPassCtx): Promise<void> {
		const k = ctx.intents.length;
		if (k >= 3) {
			console.warn(
				`[HeartbeatService] FLY-1282 ${k} sessions re-adopted in the same pass — suspect a monitoring-side interruption rather than runner-side`,
			);
		}
		for (const intent of ctx.intents) {
			const execId = intent.session.execution_id;
			if (!this.reconnecting.has(execId)) continue; // episode already over
			const stampNow = this.reconnectTitleActive.has(execId);
			try {
				await this.notifier.onSessionMonitoringReestablished(
					intent.session,
					intent.minutesSince,
					{
						stampReconnectTitle: stampNow,
						livenessProbe: intent.livenessProbe,
						...(k >= 3 ? { concurrentCount: k } : {}),
					},
				);
			} catch {
				// best-effort advisory — never blocks the pass or later notices
			}
		}
	}

	private completionPendingAtMutation(executionId: string): boolean {
		if (
			!hasUnresolvedCompleteMarker(
				executionId,
				this.monitorReconcile?.markerDir,
			)
		)
			return false;
		this.markerRetryPending.add(executionId);
		return true;
	}

	async reconcileCompletionBeforeDeath(executionId: string): Promise<boolean> {
		if (!(await completionBlocksDeath(executionId, this.buildMarkerDeps())))
			return false;
		this.markerRetryPending.add(executionId);
		return true;
	}

	private async declareZombie(session: Session): Promise<boolean> {
		const execId = session.execution_id;
		if (this.zombieDeclaring.has(execId)) return false;
		this.zombieDeclaring.add(execId);
		try {
			if (await this.reconcileCompletionBeforeDeath(execId)) return false;
			if (!this.executionBodyLifecycle) return false;
			// The common path resamples and reconciles completion after awaits,
			// then performs the exact-owner CAS and durable cross-store obligation.
			const result = await this.executionBodyLifecycle.converge(execId);
			if (result.kind !== "committed") return false;
			this.clearReconnecting(execId);
			this.notifiedMonitorLost.delete(execId);
			if (result.obligation.disposition !== "failed") return true;
			const fresh = this.store.getSession(execId);
			if (!fresh) return true;
			const evidence: ZombieEvidence = {
				kind: "process",
				observation: result.obligation.observation,
			};
			// A crash or append failure is covered by the body_death backlog entry
			// and immutable obligation. Never fabricate pane evidence for this path.
			try {
				const inspection = await inspectWorktreeForUnpushedWork(
					fresh.worktree_path,
				);
				const prepared = this.notifier.prepareSessionZombieDetected(
					fresh,
					evidence,
					inspection,
				);
				if (prepared) {
					if (!(await this.notifier.persistPreparedZombieDetected(prepared)))
						console.warn(
							`[HeartbeatService] body death alert ${execId} pending retry`,
						);
				} else this.recordUnroutableZombieAudit(fresh);
			} catch (error) {
				console.warn(
					`[HeartbeatService] committed body death ${execId}; alert retry pending: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			if (fresh.adapter_type === "codex-tmux" && this.onCodexZombieDeclared) {
				try {
					this.onCodexZombieDeclared(fresh, fresh.last_error ?? "body_death");
				} catch (error) {
					console.warn(
						`[HeartbeatService] Codex death snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
			return true;
		} finally {
			this.zombieDeclaring.delete(execId);
		}
	}

	/** FLY-1282 (R5 #1/R6 #2): deterministic, UNIQUE-deduped unroutable audit.
	 * `lastError` overrides the row's own value on the declaration path (code
	 * R1 #7: the pre-transition snapshot's last_error is stale there); the
	 * backfill path omits it — the failed row already carries the zombie
	 * marker. */
	private recordUnroutableZombieAudit(
		session: Session,
		lastError?: string,
	): void {
		console.error(
			`[HeartbeatService] FLY-1282 no Lead resolvable for zombie ${session.execution_id} (${session.issue_identifier ?? session.issue_id}) — recording session_events audit`,
		);
		if (typeof this.store.insertEvent !== "function") return;
		this.store.insertEvent({
			event_id: `zombie-alert-unroutable-${session.execution_id}`,
			execution_id: session.execution_id,
			issue_id: session.issue_id,
			project_name: session.project_name ?? "",
			event_type: "session_zombie_detected",
			severity: "warning",
			payload: {
				unroutable: true,
				last_error: lastError ?? session.last_error,
				worktree_path: session.worktree_path,
			},
			source: "bridge.zombie-reconcile",
		});
	}

	/**
	 * FLY-1282 (R5 #3/#4 + R6 #2): recurring bounded zombie-alert backfill.
	 * Scans failed sessions carrying the zombie marker whose deterministic
	 * lead_events row is missing (SQL anti-join), oldest execution_id first
	 * behind a wrap-around watermark; re-emits AT MOST ONE per pass via the
	 * same prepare/persist pair (never re-transitions). Runs OUTSIDE the
	 * liveness guard with its own single-flight; failures are loud and retried
	 * on later wraps — never silently dropped.
	 */
	private async reconcileZombieAlertBacklog(): Promise<void> {
		if (this.backfillInFlight) return;
		if (typeof this.store.getZombieAlertBacklog !== "function") return;
		this.backfillInFlight = true;
		try {
			let rows = this.store.getZombieAlertBacklog(
				this.zombieBackfillWatermark,
				20,
			);
			if (rows.length === 0 && this.zombieBackfillWatermark !== "") {
				this.zombieBackfillWatermark = ""; // wrap to the head
				rows = this.store.getZombieAlertBacklog("", 20);
			}
			if (rows.length === 0) return;
			const session = rows[0];
			if (!session) return;
			// Advance PAST the attempted row regardless of outcome — fair
			// rotation; a poison row cannot monopolize the per-pass budget.
			this.zombieBackfillWatermark = session.execution_id;
			const { parseZombieLastError } = await import(
				"./bridge/zombie-evidence.js"
			);
			const generation = session.last_error?.startsWith("body_death:")
				? this.store.executionProcessOwners.get(session.execution_id)
						?.generation
				: undefined;
			const obligation =
				generation === undefined
					? undefined
					: this.store.getExecutionBodyDeathObligation(
							`body_death:${session.execution_id}:${generation}`,
						);
			const evidence: ZombieEvidence = obligation
				? { kind: "process", observation: obligation.observation }
				: parseZombieLastError(session.last_error ?? "");
			if (evidence.kind === "unparseable") {
				console.warn(
					`[zombie-backfill] evidence marker unparseable for ${session.execution_id} — emitting degraded alert (no fabricated probe facts)`,
				);
			}
			const inspection = await inspectWorktreeForUnpushedWork(
				session.worktree_path,
			);
			const prepared = this.notifier.prepareSessionZombieDetected(
				session,
				evidence,
				inspection,
			);
			if (!prepared) {
				this.recordUnroutableZombieAudit(session);
				return; // anti-join keeps selecting it; retried on a later wrap
			}
			const persisted =
				await this.notifier.persistPreparedZombieDetected(prepared);
			if (!persisted) {
				console.error(
					`[zombie-backfill] append failed for ${session.execution_id} — will retry on a later wrap`,
				);
			}
		} catch (err) {
			console.error(
				`[zombie-backfill] pass failed (mainline unaffected): ${(err as Error).message}`,
			);
		} finally {
			this.backfillInFlight = false;
		}
	}

	/**
	 * FLY-623 boot-seed: at Bridge boot, AFTER the FLY-324 done-but-running sweep,
	 * before the late-bound FLY-172 alert-aware drain, and BEFORE `start()`,
	 * seed reconnecting state for pre-existing `running` sessions (their in-process
	 * poll loop died with the previous Bridge process). This makes the in-memory
	 * set restart-safe (re-seeded every boot → survives repeated restarts) and
	 * closes the on-boot false-alarm window (a parked Runner already has stale
	 * `last_activity_at`, so stale state could be observed before reconciliation).
	 * No-op when monitor reconciliation is not wired.
	 */
	async seedReconnecting(): Promise<string[]> {
		const deps = this.buildMarkerDeps();
		if (!deps) return [];
		this.markerRetryPending.clear();
		const seeded: string[] = [];
		// FLY-1329 (A3): re-adopt EVERY role's parked status, not just `running`.
		// Under keep-alive each role parks at a different status (HANDOFF_STATUS:
		// design→design_done, implement→awaiting_review), so a `running`-only filter
		// saw exactly the roles that never park. That is why the FLY-1319 restart
		// re-adopted the QA session and left the parked implement unmonitored.
		const candidates = withSyncOpMarker("heartbeat:readopt-candidates", () =>
			this.store.getReadoptCandidateSessions(),
		);
		// FLY-1282 (R3 #1): the public Promise<string[]> contract (FLY-1264 boot
		// title ids) is unchanged. The boot pass uses the same aggregated V2
		// consumption; its held-set is deliberately DISCARDED
		// (the first post-boot check() re-probes and owns suppression).
		const ctx: ReadoptPassCtx = { held: new Set(), intents: [] };
		for (const session of candidates) {
			const execId = session.execution_id;
			const wasTitleActive = this.reconnectTitleActive.has(execId);
			await this.reconcileCandidateReadoptV2(session, deps, ctx);
			if (!wasTitleActive && this.reconnectTitleActive.has(execId)) {
				seeded.push(execId);
			}
		}
		await this.flushReestablishedNotices(ctx);
		return seeded;
	}

	/** Mark the point after which runtime re-entries must preserve the canonical title. */
	markReconnectTitleRefresherReady(): void {
		this.reconnectTitleRefresherReady = true;
	}

	/**
	 * FLY-623: a reconnecting Runner's event channel is proven live again (or it
	 * reached a terminal/dead state). Remove it from the reconnecting set so normal
	 * stuck/orphan/idle monitoring resumes, and re-stamp the real/terminal status
	 * badge (strips "⚠️重连中"). Idempotent + safe when not reconnecting (no-op).
	 * Called from the event path (genuine runner event) and the reconcile cycle
	 * (terminal/dead). Synchronous + fire-and-forget for use from event handlers.
	 */
	clearReconnecting(executionId: string): void {
		const wasReconnecting = this.reconnecting.delete(executionId);
		const wasTitleActive = this.reconnectTitleActive.delete(executionId);
		if (!wasReconnecting && !wasTitleActive) return;
		if (!wasTitleActive) return;
		const session = this.store.getSession(executionId);
		if (session) this.notifier.clearReconnectStamp?.(session);
	}

	/**
	 * FLY-1264: release founder-facing title ownership for the exact boot episode
	 * without weakening internal monitor-loss suppression. Resolve sessions even
	 * when an early accepted event already cleared the title set so an explicit-id
	 * caller can still enqueue a canonical issue refresh for that episode. With no
	 * ids, drain every title episode active when the late refresher binds.
	 */
	settleReconnectTitles(executionIds?: readonly string[]): Session[] {
		const affected: Session[] = [];
		const selected = executionIds ?? [...this.reconnectTitleActive];
		for (const executionId of selected) {
			this.reconnectTitleActive.delete(executionId);
			const session = this.store.getSession(executionId);
			if (session) affected.push(session);
		}
		return affected;
	}

	/**
	 * FLY-623: read-only predicate for idle notification suppression while a
	 * Runner is reconnecting, so a restart-orphaned-but-alive Runner does not
	 * trigger a false idle alert. FLY-1560 removed the in-process runner idle
	 * scan that consumed it; the predicate stays as the reconnecting-set reader.
	 */
	isReconnecting(executionId: string): boolean {
		return this.reconnecting.has(executionId);
	}

	/** FLY-1264: title-only predicate consumed by the canonical display writer. */
	isReconnectTitleActive(executionId: string): boolean {
		return this.reconnectTitleActive.has(executionId);
	}

	/**
	 * FLY-172: send the one-time `session_monitoring_lost` advisory for an
	 * Runner with unavailable process evidence; `notifiedMonitorLost` deduplicates
	 * only the advisory, never authorizes or blocks death. Idempotent per Bridge-process
	 * lifetime; on delivery failure it is NOT deduped (retried next cycle).
	 */
	private async emitMonitorLostOnce(
		session: Session,
		details?: {
			unverified?: boolean;
			parkedLiveness?: "dead" | "dead_pin" | "gone";
		},
	): Promise<void> {
		const execId = session.execution_id;
		if (this.notifiedMonitorLost.has(execId)) return;
		let minutesSince = this.thresholdMinutes;
		if (session.heartbeat_at) {
			minutesSince = Math.round(
				(Date.now() -
					new Date(`${session.heartbeat_at.replace(" ", "T")}Z`).getTime()) /
					60_000,
			);
		}
		try {
			// INV-5 arity sentinel: the legacy path keeps the exact two-argument
			// call; only the zombie-ON indeterminate path passes details.
			if (details) {
				await this.notifier.onSessionMonitoringLost(
					session,
					minutesSince,
					details,
				);
			} else {
				await this.notifier.onSessionMonitoringLost(session, minutesSince);
			}
			this.notifiedMonitorLost.add(execId);
		} catch {
			// delivery failed — retry advisory next cycle (don't dedup)
		}
	}

	/**
	 * GEO-270: Check for completed/failed/blocked sessions with tmux still alive.
	 *
	 * FLY-867: upgraded from notify-only to notify+close. A terminal-status
	 * session whose tmux window is still alive past `staleThresholdHours` is a
	 * LEAK — nothing else closes it: the crash-reaper only takes
	 * `status='running'` (getOrphanSessions), and the auto-QA reconcile's close
	 * predicates treat "CommDB terminal" as "already cleaned up" (production:
	 * 15 leaked QA runners with live claude processes, 2026-07-04). Contract:
	 * this backstop owns exactly the `getStaleCompletedSessions` set
	 * (completed/failed/blocked, ALL session_roles — a main-role leak was
	 * observed too); terminated/rejected/shelved/deferred each have their own
	 * close chains and are NOT scanned here.
	 */
	async checkStaleCompleted(): Promise<void> {
		const now = Date.now();
		if (now - this.lastStaleCheckAt < this.staleCheckIntervalMs) return;

		const stale = this.store.getStaleCompletedSessions(
			this.staleThresholdHours,
		);

		// Prune dedup set
		const staleIds = new Set(stale.map((s) => s.execution_id));
		for (const id of this.notifiedStale) {
			if (!staleIds.has(id)) this.notifiedStale.delete(id);
		}

		// FLY-867: compute the close-enabled gate ONCE per sweep. When close is
		// disabled because the chokepoint is unwired, the loop must restore the exact
		// pre-FLY-867 ordering — dedup short-circuit BEFORE the CommDB/tmux probe
		// — so the OFF/unwired path is byte-compatible (no repeated I/O or logs
		// for already-notified sessions). Codex code review R1 (MEDIUM).
		const closeEnabled = this.staleCloseEnabled();

		for (const session of stale) {
			if (!session.project_name) continue;
			// Notify-only (close disabled) path: skip already-notified sessions
			// before any probe, exactly as GEO-270 did pre-FLY-867.
			if (!closeEnabled && this.notifiedStale.has(session.execution_id)) {
				continue;
			}

			try {
				const target = getTmuxTargetFromCommDb(
					session.execution_id,
					session.project_name,
				);
				if (!target) continue;

				const alive = await isTmuxWindowAlive(target.tmuxWindow);
				if (!alive) continue;

				// Close the leak through the injected closeRunner
				// chokepoint — BEFORE the notify dedup gate, so a failed close is
				// retried every stale cycle (the dedup only suppresses repeat
				// notifications, never a close retry). Only a CONFIRMED teardown
				// skips the stale notification; a failed/ineligible close falls
				// through to the existing notify path.
				if (closeEnabled) {
					const res = await this.staleTerminalClose?.closeStale(session);
					if (res && (res.closed || res.alreadyGone)) {
						this.notifiedStale.delete(session.execution_id);
						continue;
					}
				}

				if (this.notifiedStale.has(session.execution_id)) continue;

				const hoursSince = session.last_activity_at
					? Math.round(
							(Date.now() -
								new Date(
									`${session.last_activity_at.replace(" ", "T")}Z`,
								).getTime()) /
								3_600_000,
						)
					: 0;

				await this.notifier.onSessionStale(session, hoursSince);
				this.notifiedStale.add(session.execution_id);
			} catch (err) {
				console.error(
					`[HeartbeatService] stale check failed for ${session.execution_id}:`,
					(err as Error).message,
				);
			}
		}

		this.lastStaleCheckAt = Date.now();
	}

	/**
	 * FLY-1204: periodic safety net that reclaims DAG workflow keep-alive phase
	 * sessions (design/implement/qa) that leaked alive past ship or pipeline
	 * termination — the root of the OOM incident (design_done holders never
	 * closed after handoff; completed QA processes never torn down). Uses its own
	 * independent throttle and a global re-entrancy guard. Never throws
	 * (best-effort).
	 *
	 * The reclaim is issue-grouped and verdict-driven (`computeIssueReclaimVerdict`)
	 * so it NEVER kills a healthy parked context-holder: any phase still working
	 * keeps the whole issue. Auto-kill is limited to two TOCTOU-safe cases (a
	 * pipeline with a ship-finalization claim = terminated & will not respawn; a
	 * `completed` terminal QA that cannot revert to working). No-ship-claim
	 * non-terminal orphans are only ALERTED for a `close_runner --done`.
	 */
	async checkStaleParkedPhases(): Promise<void> {
		if (!this.staleParkedClose) return; // feature not wired → inert
		if (this.parkedSweepRunning) return; // a prior long sweep is still running
		const now = Date.now();
		if (now - this.lastParkedCheckAt < this.staleCheckIntervalMs) return;
		this.parkedSweepRunning = true;
		try {
			const candidates = withSyncOpMarker("heartbeat:parked-candidates", () => [
				...this.store.getParkedPhaseCandidates(),
				...this.store.getWorkflowManagedParkedCandidates(),
			]);
			const total = candidates.length;
			if (total === 0) return;

			// STABLE global order by execution_id (a random UUID — stable across
			// sweeps, independent of the mutable last_activity_at). A single
			// execution_id watermark walks this ordering CAP-at-a-time, restarting at
			// the head after the tail. Because the ordering + identity are stable,
			// EVERY candidate is reached within ⌈total/cap⌉ sweeps regardless of how
			// the candidate set changes between sweeps — there is no per-sweep issue
			// window whose varying length could thrash a modulo cursor and starve a
			// live leak spread across many issues (FLY-1210 root-fix / Codex R4).
			const { byIssue, ordered } = withSyncOpMarker(
				"heartbeat:parked-materialization",
				() => {
					// Group by issue — the verdict needs the WHOLE issue group, not just
					// the candidates that fall in this sweep's window.
					const grouped = new Map<string, Session[]>();
					for (const session of candidates) {
						const group = grouped.get(session.issue_id);
						if (group) group.push(session);
						else grouped.set(session.issue_id, [session]);
					}
					return {
						byIssue: grouped,
						ordered: [...candidates].sort((a, b) =>
							a.execution_id < b.execution_id
								? -1
								: a.execution_id > b.execution_id
									? 1
									: 0,
						),
					};
				},
			);
			let cstart = 0;
			if (this.parkedCleanupWatermark) {
				const idx = ordered.findIndex(
					(c) => c.execution_id > this.parkedCleanupWatermark,
				);
				cstart = idx >= 0 ? idx : 0; // watermark past the end → restart at head
			}
			const end = Math.min(cstart + PARKED_SWEEP_CANDIDATE_CAP, total);
			if (total > PARKED_SWEEP_CANDIDATE_CAP) {
				console.warn(
					`[HeartbeatService] parked-phase sweep processing candidates [${cstart}, ${end}) of ${total} this pass (cap ${PARKED_SWEEP_CANDIDATE_CAP}); the rest drain on later sweeps (stable-watermark rotation).`,
				);
			}

			// Per-sweep memoized verdict per issue (an issue's verdict is computed at
			// most once, the first time any of its candidates enters this window; its
			// orphan alert fires there too, once).
			const verdictByIssue = new Map<
				string,
				{ autoReclaim: Session[]; alertOnly: Session[]; noClaim: boolean }
			>();
			for (let k = cstart; k < end; k++) {
				const s = ordered[k];
				if (!s) continue;
				try {
					let verdict = verdictByIssue.get(s.issue_id);
					if (!verdict) {
						verdict = await this.computeIssueReclaimVerdict(
							s.issue_id,
							byIssue.get(s.issue_id) ?? [s],
						);
						verdictByIssue.set(s.issue_id, verdict);
						if (verdict.alertOnly.length > 0) {
							await this.alertOrphanParkedOnce(s.issue_id, verdict.alertOnly);
						}
					}
					// Reclaim THIS candidate iff its issue's verdict marks it
					// auto-reclaimable, then re-probe liveness right before the close
					// (dead/defer skip — never close on doubt).
					if (
						verdict.autoReclaim.some((x) => x.execution_id === s.execution_id)
					) {
						const live = await this.probePhaseLiveness(s);
						if (live !== "alive") continue;
						await this.staleParkedClose.closeParked(s, {
							noClaim: verdict.noClaim,
						});
					}
				} catch (err) {
					console.error(
						`[HeartbeatService] parked-phase reclaim failed for ${s.execution_id}:`,
						(err as Error).message,
					);
				}
			}
			// Reached the end → clear the watermark so the next sweep restarts at the
			// head (full coverage); otherwise resume just after the last processed id.
			this.parkedCleanupWatermark =
				end >= total ? "" : (ordered[end - 1]?.execution_id ?? "");
		} catch (err) {
			console.error(
				"[HeartbeatService] parked-phase sweep failed:",
				(err as Error).message,
			);
		} finally {
			this.parkedSweepRunning = false;
			this.lastParkedCheckAt = Date.now();
		}
	}

	/**
	 * FLY-1204: the reclaim verdict for one issue. HARD guard against killing a
	 * healthy parked holder.
	 *
	 * (1) A durable merge-confirmed fact exists → the pipeline is terminated and
	 *     will never spawn a new working phase, so reclaiming its real-parked /
	 *     terminal candidates is TOCTOU-safe. This is the automated main path (the
	 *     shipped design_done + completed-qa zombies).
	 * (2) No claim → first prove the issue has NO working phase and NO in-flight
	 *     spawn (`classifyIssueWorking`); anything but `clean` keeps/defers the
	 *     whole issue. Once clean + past the time backstop: a `completed` terminal
	 *     candidate is auto-reclaimed (cannot revert to working); a non-terminal
	 *     parked candidate (design_done / awaiting_review / …) is only ALERTED —
	 *     the verdict→close window cannot prove TOCTOU-safety, so operators reclaim
	 *     it explicitly with `close_runner --done`.
	 */
	private async computeIssueReclaimVerdict(
		issueId: string,
		group: Session[],
	): Promise<{
		autoReclaim: Session[];
		alertOnly: Session[];
		noClaim: boolean;
	}> {
		const projectName = group.find((s) => s.project_name)?.project_name ?? "";
		const hasClaim = this.store.hasMergeConfirmedForIssue(issueId);

		if (hasClaim) {
			const autoReclaim: Session[] = [];
			for (const s of group) {
				if (this.isReclaimableParkedOrTerminal(s) === "yes")
					autoReclaim.push(s);
			}
			return { autoReclaim, alertOnly: [], noClaim: false };
		}

		const working = await this.classifyIssueWorking(issueId, projectName);
		if (working !== "clean") {
			// has_working (keep the healthy holder) / in_flight (protect the spawn
			// window) / defer (read error → fail-closed) → reclaim nothing this pass.
			return { autoReclaim: [], alertOnly: [], noClaim: true };
		}

		const autoReclaim: Session[] = [];
		const alertOnly: Session[] = [];
		for (const s of group) {
			if (this.isReclaimableParkedOrTerminal(s) !== "yes") continue;
			if (!this.isBeyondParkedStale(s)) continue; // time safety net (backstop)
			if (s.status === "completed") autoReclaim.push(s);
			else alertOnly.push(s);
		}
		return { autoReclaim, alertOnly, noClaim: true };
	}

	/**
	 * FLY-1204: is the issue still working / spawning? Bounded probe: the latest
	 * GHOST_PROBE_MAX_ROWS rows per role (≤9 total) so a "newest terminal + next
	 * alive non-parked" shape is not missed. Any non-terminal, non-parked, alive
	 * phase → `has_working` (keep the whole issue). A fresh in-flight TURN with no
	 * registered holder session → `in_flight` (protect the handoff spawn window).
	 * Any read error / indeterminate probe → `defer` (fail-closed).
	 */
	private async classifyIssueWorking(
		issueId: string,
		projectName: string,
	): Promise<"has_working" | "in_flight" | "defer" | "clean"> {
		const rows = this.pickLatestNPerRole(
			[
				...this.store.getPhaseSessionsForIssue(issueId),
				...this.store
					.getWorkflowManagedSessionsForIssue(issueId)
					.filter((session) => session.chat_thread_role === "main"),
			],
			GHOST_PROBE_MAX_ROWS,
		);
		for (const p of rows) {
			if (TERMINAL_PHASE_STATUSES.has(p.status)) continue;
			const parked = this.declaredStateIsParked(p);
			if (parked === "defer") return "defer";
			if (parked === "yes") continue; // parked → not working
			const live = await this.probePhaseLiveness(p);
			if (live === "alive") return "has_working";
			if (live === "defer") return "defer";
			// dead → not a working holder; keep scanning
		}
		const turn = this.classifyTurn(issueId, projectName);
		if (turn === "defer") return "defer";
		if (turn === "in_flight") return "in_flight";
		return "clean"; // stale / none TURN must NOT permanently block reclaim
	}

	/**
	 * FLY-1204 (Codex R2 BLOCKER-1): the TURN is an untimed overwrite-style
	 * ownership pointer that park does NOT release, so "a TURN exists" ≠ "the
	 * pipeline is live". Only a fresh grant whose holder session row is NOT yet
	 * registered (the pre-launch seam grants before the runner registers) inside
	 * TURN_GRANT_GRACE_MS is an in-flight spawn worth deferring for. Holder row
	 * present, or grace elapsed → `stale` (does NOT block reclaim). Implement
	 * Note 1: for a reclaimed no-claim `completed`-QA orphan the leftover TURN row
	 * is NOT swept by the turn-belt reconciler (which defers to post-ship
	 * finalization — the very thing that never ran for an orphan); it lingers as a
	 * tiny, harmless row (no memory leak, no block; a re-spawn overwrites it via
	 * grantTurn's ON CONFLICT). We deliberately do not add a writable-CommDB
	 * deleteTurn here. CommDB read error → `defer`.
	 */
	private classifyTurn(
		issueId: string,
		projectName: string,
	): "none" | "in_flight" | "stale" | "defer" {
		if (!this.staleParkedClose || !projectName) return "none";
		// Structural subset of WorktreeTurn (not re-exported from flywheel-comm/db).
		let turn: { holder_exec_id: string; granted_at: number } | null;
		try {
			const db = CommDB.openReadonly(
				this.staleParkedClose.commDbPathForProject(projectName),
			);
			try {
				turn = db.getTurn(issueId);
			} finally {
				db.close();
			}
		} catch {
			return "defer";
		}
		if (!turn) return "none";
		const holder = this.store.getSession(turn.holder_exec_id);
		if (!holder && Date.now() - turn.granted_at < TURN_GRANT_GRACE_MS) {
			return "in_flight";
		}
		return "stale";
	}

	/**
	 * FLY-1204: a candidate is reclaimable iff it is a `completed` terminal phase
	 * (TOCTOU-safe) OR a non-terminal phase whose CommDB declared_state is
	 * `parked`. A declared-state read error → `defer` (fail-closed, never a yes).
	 */
	private isReclaimableParkedOrTerminal(
		session: Session,
	): "yes" | "no" | "defer" {
		if (session.status === "completed") return "yes";
		return this.declaredStateIsParked(session);
	}

	/**
	 * FLY-1204: does the session's CommDB declared-state read as `parked` right
	 * now? `yes` / `no` from the effective marker; `defer` on any read error
	 * (fail-closed) or when unwired. Readonly-tolerant per getEffectiveDeclaredState.
	 */
	private declaredStateIsParked(session: Session): "yes" | "no" | "defer" {
		if (!this.staleParkedClose || !session.project_name) return "defer";
		try {
			const db = CommDB.openReadonly(
				this.staleParkedClose.commDbPathForProject(session.project_name),
			);
			try {
				const state = db.getEffectiveDeclaredState(
					session.execution_id,
					Date.now(),
				);
				return state?.kind === "parked" ? "yes" : "no";
			} finally {
				db.close();
			}
		} catch {
			return "defer";
		}
	}

	/** Phase cleanup consumes the same physical truth; a missing UI is not death. */
	private async probePhaseLiveness(
		session: Session,
	): Promise<"alive" | "dead" | "defer"> {
		const observation = await this.probeSessionLiveness(session);
		return observation.verdict === "alive" || observation.verdict === "dead"
			? observation.verdict
			: "defer";
	}

	/**
	 * FLY-1204: pure time backstop (decision ② — the terminal guard is the primary
	 * trigger; time is a conservative safety net). True iff the session's last
	 * activity is older than the configured parked-stale threshold.
	 */
	private isBeyondParkedStale(session: Session): boolean {
		if (!this.staleParkedClose || !session.last_activity_at) return false;
		const activityMs = new Date(
			`${session.last_activity_at.replace(" ", "T")}Z`,
		).getTime();
		if (!Number.isFinite(activityMs)) return false;
		const ageHours = (Date.now() - activityMs) / 3_600_000;
		return ageHours >= this.staleParkedClose.parkedStaleHours;
	}

	/**
	 * FLY-1204: the latest N rows per `chat_thread_role` from a
	 * `last_activity_at DESC, rowid DESC`-ordered list (getPhaseSessionsForIssue
	 * guarantees that order). Caps the working-safety probe at ≤N/role.
	 */
	private pickLatestNPerRole(rows: Session[], n: number): Session[] {
		const perRole = new Map<string, number>();
		const out: Session[] = [];
		for (const r of rows) {
			const role = r.workflow_node_id
				? `workflow:${r.workflow_node_id}`
				: (r.chat_thread_role ?? "");
			const seen = perRole.get(role) ?? 0;
			if (seen >= n) continue;
			perRole.set(role, seen + 1);
			out.push(r);
		}
		return out;
	}

	/**
	 * FLY-1204: alert (once per issue + orphan-set) about no-ship-claim orphan
	 * parked phases the patrol will NOT auto-kill. Durable dedupe via
	 * `quiet_wake_notified` keyed on a SYNTHETIC issue key + a stable source +
	 * the sorted orphan exec-id fingerprint (a NEW orphan → new fingerprint →
	 * re-alert; same set → suppressed across sweeps + Bridge restarts). Records
	 * the dedupe ONLY after the alert is delivered (Implement Note 3 — a failed
	 * alert must not be silenced).
	 */
	private async alertOrphanParkedOnce(
		issueId: string,
		sessions: Session[],
	): Promise<void> {
		if (!this.staleParkedClose) return;
		const source = "fly1204_orphan_parked";
		const fingerprint = sessions
			.map((s) => s.execution_id)
			.sort()
			.join(",");
		if (this.store.hasQuietWakeNotified(issueId, source, fingerprint)) return;
		await this.staleParkedClose.alertOrphan(issueId, sessions);
		this.store.recordQuietWakeNotified(issueId, source, fingerprint);
	}

	/**
	 * FLY-867: stale-terminal close is active iff production wired the close
	 * chokepoint.
	 */
	private staleCloseEnabled(): boolean {
		return this.staleTerminalClose !== undefined;
	}

	/** Suppress reaping while a live detached runner is being re-adopted. */
	private isMonitorSuppressed(executionId: string): boolean {
		return (
			this.notifiedMonitorLost.has(executionId) ||
			this.reconnecting.has(executionId)
		);
	}

	/**
	 * FLY-720: run the liveness-based crash reaper for this cycle and return the
	 * set of confirmed dead-pin execIds so `reapOrphans` skips them. No-op (empty
	 * set) when the reaper is unwired or its kill-switch is OFF. Never throws — a
	 * reaper failure logs and returns an empty set so the rest of the cycle runs.
	 */
	private async reapCrashedRunners(
		tmuxHeld: ReadonlySet<string> = new Set(),
	): Promise<ReadonlySet<string>> {
		if (!this.crashReaperConfig?.enabled || !this.transitionOpts) {
			return new Set();
		}
		try {
			const res = await reapCrashedRunners({
				...this.crashReaperConfig,
				store: this.store,
				transitionOpts: this.transitionOpts,
				orphanThresholdMinutes: this.orphanThresholdMinutes,
				nowMs: Date.now(),
				isSuppressed: (id) =>
					this.isMonitorSuppressed(id) ||
					this.markerRetryPending.has(id) ||
					tmuxHeld.has(id),
				hasPendingCompleteMarker: (id) => this.completionPendingAtMutation(id),
				reconcileCompletionBeforeDeath: (id) =>
					this.reconcileCompletionBeforeDeath(id),
			});
			if (
				res.reaped > 0 ||
				res.confirmedDeadPinOwned > 0 ||
				res.cleanupPending > 0
			) {
				console.log(
					`[crash-reaper] owned=${res.confirmedDeadPinOwned} reaped=${res.reaped} waitingGrace=${res.confirmedDeadButWaitingForGrace} cleanupPending=${res.cleanupPending} absentToOrphan=${res.absentPassedToOrphan} indeterminateSuppressed=${res.indeterminateSuppressed} transitionSkipped=${res.transitionSkipped}`,
				);
			}
			return res.deadPinOwned;
		} catch (err) {
			console.error(
				`[crash-reaper] cycle failed (skipping, Bridge stays up): ${(err as Error).message}`,
			);
			return new Set();
		}
	}

	/** Reap orphan sessions: heartbeat has gone stale beyond orphanThresholdMinutes. */
	async reapOrphans(
		_deadPinOwned: ReadonlySet<string> = new Set(),
		zombieHeld: ReadonlySet<string> = EMPTY_SET,
	): Promise<void> {
		// Age selects candidates only. Historical advisory/monitoring sets do
		// not grant life or death authority; the common process path does.
		for (const session of this.store.getOrphanSessions(
			this.orphanThresholdMinutes,
		)) {
			if (
				session.status !== "running" &&
				!isReadoptParkedStatus(session.status)
			)
				continue;
			if (
				zombieHeld.has(session.execution_id) ||
				this.markerRetryPending.has(session.execution_id)
			)
				continue;
			try {
				await this.declareZombie(session);
			} catch (error) {
				console.warn(
					`[HeartbeatService] body convergence deferred: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}
}

/**
 * GEO-195 + FLY-25: Registry-based heartbeat notifier — delivers via RuntimeRegistry.
 *
 * deliver() returns DeliveryResult instead of fire-and-forget. Guardrail
 * failures remain durable; this notifier does not chase them with redelivery.
 */
export class RegistryHeartbeatNotifier implements HeartbeatNotifier {
	constructor(
		private registry: RuntimeRegistry,
		private projects: ProjectEntry[],
		private store: StateStore,
		private eventFilter?: EventFilter,
		private chatThreadsEnabled?: boolean,
		/**
		 * FLY-623 Display-A: when wired (issue-status-emoji feature ON), stamp /
		 * clear the "⚠️重连中" reconnecting marker on the issue's chat-thread title.
		 * Absent → Display-A no-ops (the re-adopt heartbeat fix still works).
		 */
		private chatThreadCreator?: ChatThreadCreator,
		/** FLY-1225: late-bound issue-level display authority. When available,
		 * reconnect-clear must re-derive from every phase instead of restoring a
		 * completed phase's badge onto the shared issue thread. */
		private issueDisplayRefresh?: IssueDisplayRefreshHolder,
	) {}

	async onSessionOrphaned(session: Session, minutes: number): Promise<void> {
		const hookPayload: HookPayload = {
			event_type: "session_orphaned",
			execution_id: session.execution_id,
			issue_id: session.issue_id,
			issue_identifier: session.issue_identifier,
			issue_title: session.issue_title,
			project_name: session.project_name,
			status: "failed",
			minutes_since_activity: minutes,
			...(session.last_error?.includes("readiness_retry_exhausted")
				? { notification_context: session.last_error }
				: {}),
			session_role: session.session_role ?? "main",
		};
		await this.deliverHook(session, hookPayload);
	}

	async onSessionStale(session: Session, hours: number): Promise<void> {
		const hookPayload: HookPayload = {
			event_type: "session_stale_completed",
			execution_id: session.execution_id,
			issue_id: session.issue_id,
			issue_identifier: session.issue_identifier,
			issue_title: session.issue_title,
			project_name: session.project_name,
			status: session.status,
			notification_context: `Session ${session.status} ${hours}h ago but tmux still alive. Please check if it can be closed.`,
			session_role: session.session_role ?? "main",
		};
		await this.deliverHook(session, hookPayload);
	}

	async onSessionMonitoringLost(
		session: Session,
		minutes: number,
		details?: {
			unverified?: boolean;
			parkedLiveness?: "dead" | "dead_pin" | "gone";
		},
	): Promise<void> {
		const label = session.issue_identifier ?? session.issue_id;
		// FLY-1282 (INV-1): the readopt-ON indeterminate path could NOT verify
		// liveness — its copy must not claim "alive and working". The legacy
		// two-argument call keeps the pre-FLY-1282 copy byte-for-byte.
		// FLY-1329 (A3, Codex R3): a parked re-adopt that found the runner GONE must
		// not reuse the "still alive" copy either — dead_pin is provable death, while
		// dead/gone is a window/mapping miss that cannot confirm alive OR dead.
		let context: string;
		if (details?.parkedLiveness === "dead_pin") {
			context = `Runner ${label} lost Bridge monitoring and its parked tmux window's pane is a dead remain-on-exit corpse — the process is provably gone (heartbeat stale ${minutes}m). No heartbeat was refreshed; the existing reconcile/reaper paths own the cleanup.`;
		} else if (details?.parkedLiveness) {
			context = `Runner ${label} lost Bridge monitoring and no tmux window answered to its name (${details.parkedLiveness}) — it is either gone or its window mapping went stale, so its liveness could NOT be confirmed alive OR dead (heartbeat stale ${minutes}m). No heartbeat was refreshed. Please check it directly via tmux.`;
		} else if (details?.unverified) {
			context = `Runner ${label} lost Bridge monitoring and its liveness could NOT be verified (process evidence unavailable; heartbeat stale ${minutes}m). No heartbeat was refreshed. Please check it directly via tmux.`;
		} else {
			context = `Runner ${label} lost Bridge monitoring (no heartbeat for ${minutes}m, likely after a Flywheel restart) but its tmux session is still alive and working. Please keep an eye on it and drive it directly via tmux if needed.`;
		}
		const hookPayload: HookPayload = {
			event_type: "session_monitoring_lost",
			execution_id: session.execution_id,
			issue_id: session.issue_id,
			issue_identifier: session.issue_identifier,
			issue_title: session.issue_title,
			project_name: session.project_name,
			status: session.status,
			minutes_since_activity: minutes,
			notification_context: context,
			session_role: session.session_role ?? "main",
		};
		await this.deliverHook(session, hookPayload);
	}

	/**
	 * FLY-623: readopt-ON happy path. The Bridge re-adopted a live detached Runner
	 * after a restart. Stamp the Display-A reconnecting title and
	 * deliver a one-time, low-priority, NON-retryable FYI to the Lead. Best-effort:
	 * `session_monitoring_reestablished` is not in GUARDRAIL/RETRYABLE sets, so
	 * deliverHook marks it delivered regardless and it is never re-delivered.
	 */
	async onSessionMonitoringReestablished(
		session: Session,
		minutes: number,
		details?: {
			stampReconnectTitle?: boolean;
			livenessProbe?: {
				target?: string;
				probedAt: string;
				method?: "execution_process";
			};
			concurrentCount?: number;
		},
	): Promise<void> {
		const label = session.issue_identifier ?? session.issue_id;
		// FLY-1282 (INV-2): with probe evidence, state only point-in-time facts —
		// no "restart" narrative (2026-07-15 16:14Z: three of these claimed a
		// restart while the Bridge had 7.9h uptime; the trigger is heartbeat
		// staleness, restart is just one possible cause), no forever promises.
		// "heartbeat age" is honest even for boot-seeded fresh-heartbeat rows.
		let context: string;
		if (details?.livenessProbe) {
			context = `Runner ${label} re-adopted — heartbeat age before re-adoption was ${minutes}m; liveness verified at ${details.livenessProbe.probedAt} via ${details.livenessProbe.method === "execution_process" ? "independent process evidence" : "tmux pane probe (pane_dead=0)"}; monitoring resumed.`;
			if (details.concurrentCount !== undefined) {
				context += ` NOTE: ${details.concurrentCount} sessions re-adopted in the same pass — suspect a monitoring-side interruption rather than runner-side.`;
			}
		} else {
			context = `Runner ${label} was re-adopted after a Flywheel restart — monitoring re-established via tmux (heartbeat had been stale ${minutes}m). It is alive and being watched again; no action needed.`;
		}
		const hookPayload: HookPayload = {
			event_type: "session_monitoring_reestablished",
			execution_id: session.execution_id,
			issue_id: session.issue_id,
			issue_identifier: session.issue_identifier,
			issue_title: session.issue_title,
			project_name: session.project_name,
			status: session.status,
			minutes_since_activity: minutes,
			notification_context: context,
			session_role: session.session_role ?? "main",
		};
		if (
			details?.livenessProbe &&
			details.livenessProbe.method !== "execution_process"
		) {
			hookPayload.liveness_probe = {
				method: "tmux_pane_probe",
				target: details.livenessProbe.target,
				result: "alive",
				probed_at: details.livenessProbe.probedAt,
			};
			if (details.concurrentCount !== undefined) {
				hookPayload.concurrent_reestablished = details.concurrentCount;
			}
		}
		// Display-A: stamp the ⚠️重连中 marker with the resolved model marker
		// (fire-and-forget, best-effort). Runtime re-entry may suppress this write.
		if (details?.stampReconnectTitle !== false) {
			this.stampReconnect(session, "enter");
		}
		await this.deliverHook(session, hookPayload);
	}

	/**
	 * FLY-623: a Runner left the reconnecting state — re-stamp its real/terminal
	 * status badge (strips "⚠️重连中"). Best-effort + synchronous-return so it is
	 * safe to call from a fire-and-forget event handler.
	 */
	clearReconnectStamp(session: Session): void {
		this.stampReconnect(session, "clear");
	}

	/**
	 * FLY-623 Display-A: stamp / clear the reconnecting marker on the issue's chat
	 * thread. Resolves the issue's lead (channel + bot token) + thread, then either
	 * stamps "⚠️重连中" (enter) or restores the real/terminal badge (clear). Silent
	 * no-op on any miss (Display-A disabled, no lead/channel/token, thread not yet
	 * created). Never throws into the caller.
	 */
	private stampReconnect(session: Session, mode: "enter" | "clear"): void {
		if (mode === "clear" && this.issueDisplayRefresh?.current) {
			this.issueDisplayRefresh.current.enqueue(session.issue_id);
			return;
		}
		if (!this.chatThreadCreator) return; // Display-A not wired → no-op
		let chatChannel: string;
		let botToken: string;
		let leadId: string;
		try {
			const labels = this.store.getSessionLabels(session.execution_id);
			const { lead } = this.registry.resolveWithLead(
				this.projects,
				session.project_name,
				labels,
			);
			if (!lead.chatChannel || !lead.botToken) return;
			chatChannel = lead.chatChannel;
			botToken = lead.botToken;
			leadId = lead.agentId;
		} catch {
			return; // lead/project not resolvable → skip
		}
		// FLY-892 (converge): one issue = one thread — every phase session and the
		// Lead resolve the SAME `(issue, channel)` thread.
		const thread = this.store.getChatThreadByIssue(
			session.issue_id,
			chatChannel,
		);
		if (!thread) return; // thread not created yet

		const ctx: ChatThreadContext = {
			chatChannelId: chatChannel,
			issueId: session.issue_id,
			issueIdentifier: session.issue_identifier,
			issueTitle: session.issue_title,
			botToken,
			leadId,
			// FLY-1255: reconnect renames use the same resolved-dispatch model
			// marker as every other managed title writer.
			modelMarker: sessionModelDisplay(session)?.threadMarker ?? null,
		};

		const phaseBadge = phaseThreadBadge(session.chat_thread_role) || undefined;
		let badge: string | null;
		if (mode === "enter") {
			badge = reconnectingBadge(true);
		} else if (session.status === "completed") {
			badge = stageBadge("completed", true) ?? null;
		} else if (session.status === "running" && phaseBadge) {
			badge = phaseBadge;
		} else if (session.status === "running" && session.session_stage) {
			// A non-phase runner restores its current real stage badge.
			badge = stageBadge(session.session_stage, true) ?? null;
		} else {
			// failed / blocked / unknown terminal → strip the prefix to the base title.
			badge = null;
		}

		void this.chatThreadCreator
			.stampStatusBadge(ctx, thread.thread_id, badge)
			.catch((err: unknown) => {
				console.warn(
					`[heartbeat-notify] reconnect ${mode} stamp failed for ${session.execution_id}:`,
					err instanceof Error ? err.message : err,
				);
			});
	}

	private async deliverHook(
		session: Session,
		hookPayload: HookPayload,
	): Promise<boolean> {
		let agentId: string;
		let chatChannel: string;
		let runtime: import("./bridge/lead-runtime.js").LeadRuntime;
		try {
			const labels = this.store.getSessionLabels(session.execution_id);
			const resolved = this.registry.resolveWithLead(
				this.projects,
				session.project_name,
				labels,
			);
			runtime = resolved.runtime;
			agentId = resolved.lead.agentId;
			chatChannel = resolved.lead.chatChannel;
		} catch {
			console.warn(
				`[heartbeat-notify] Cannot resolve runtime for "${session.project_name}" — skipping notification`,
			);
			return false;
		}

		hookPayload.chat_channel = chatChannel;

		// FLY-91: Fill chat_thread_id for Lead thread routing
		if (this.chatThreadsEnabled) {
			hookPayload.chat_thread_id = resolveChatThreadId(
				this.store,
				session.issue_id,
				chatChannel,
			);
		}

		// FLY-47: Annotate priority (EventFilter provides hints for Lead)
		if (this.eventFilter) {
			const filterResult = this.eventFilter.classify(
				hookPayload.event_type,
				hookPayload,
			);
			hookPayload.filter_priority = filterResult.priority;
			// GEO-270: Preserve caller-provided notification_context if present
			if (!hookPayload.notification_context) {
				hookPayload.notification_context = filterResult.reason;
			}
		}

		const sessionKey = buildSessionKey(session);
		const eventId = `heartbeat-${session.execution_id}-${Date.now()}-${randomUUID()}`;
		// FLY-1282 (R2 #3/R3 #5): shared append→deliver lifecycle. The legacy
		// hook keeps "propagate" — a deliver() throw escapes to the caller with
		// the appended row left untouched (attempt=0), exactly as before.
		await this.appendAndDeliverRow({
			leadId: agentId,
			eventId,
			eventType: hookPayload.event_type,
			payloadJson: JSON.stringify(hookPayload),
			sessionKey,
			payloadForEnvelope: hookPayload,
			runtime,
			onDeliverThrow: "propagate",
		});
		// FLY-637 R1 #2: the event row IS in lead_events (guardrail retry owns
		// redelivery), so this counts as persisted regardless of the immediate
		// transport outcome.
		return true;
	}

	/**
	 * FLY-1282 (R2 #3 + R3 #5 + R5 #1): the ONE append→deliver→mark/record
	 * state machine, shared by the legacy deliverHook and the prepared zombie
	 * path. Behavior matrix (M0 goldens freeze the "propagate" side):
	 *   - deliver ok            → markLeadEventDelivered
	 *   - deliver {delivered:false} → guardrail: recordDeliveryFailure;
	 *                                 advisory: mark delivered (best-effort)
	 *   - deliver THROWS        → "propagate": rethrow, row left attempt=0
	 *                             (pre-FLY-1282 semantics, no record/mark);
	 *                             "record": recordDeliveryFailure (retry row)
	 *   - runtime undefined     → recordDeliveryFailure("no runtime registered")
	 *                             (guardrail retry re-resolves getForLead later)
	 * Returns after the row is durably appended — the return value is the seq.
	 */
	private async appendAndDeliverRow(row: {
		leadId: string;
		eventId: string;
		eventType: string;
		payloadJson: string;
		sessionKey: string;
		payloadForEnvelope: HookPayload;
		runtime: LeadRuntime | undefined;
		onDeliverThrow: "propagate" | "record";
	}): Promise<number> {
		const seq = this.store.appendLeadEvent(
			row.leadId,
			row.eventId,
			row.eventType,
			row.payloadJson,
			row.sessionKey,
			storeLeadTokenSavingsEnabled(
				{ store: this.store },
				row.payloadForEnvelope.project_name ?? "",
			)
				? leadEventDeliveryDisposition(
						row.eventType,
						{ ...row.payloadForEnvelope },
						true,
					)
				: "model",
		);
		if (this.store.isLeadEventAuditOnly(seq, row.leadId)) return seq;
		const isGuardrail = GUARDRAIL_EVENT_TYPES.has(row.eventType);
		if (!row.runtime) {
			this.store.recordDeliveryFailure(seq, "no runtime registered");
			return seq;
		}
		const envelope: LeadEventEnvelope = {
			seq,
			eventId: row.eventId,
			event: row.payloadForEnvelope,
			sessionKey: row.sessionKey,
			leadId: row.leadId,
			timestamp: new Date().toISOString(),
		};
		let result: { delivered: boolean; error?: string };
		try {
			result = await dispatchLeadEventCompat(
				this.registry,
				row.runtime,
				envelope,
			);
		} catch (err) {
			if (row.onDeliverThrow === "propagate") throw err;
			this.store.recordDeliveryFailure(seq, (err as Error).message);
			return seq;
		}
		if ((result as { queued?: boolean }).queued) {
			return seq;
		}
		if (result.delivered) {
			this.store.markLeadEventDelivered(seq);
		} else if (isGuardrail) {
			this.store.recordDeliveryFailure(seq, result.error ?? "unknown");
		} else {
			this.store.markLeadEventDelivered(seq);
		}
		return seq;
	}

	/**
	 * FLY-1282 two-phase zombie alert, prepare half (R4 #1 + R5 #2): all
	 * store/registry/filter READS happen here, before the FSM transition. No
	 * persistent writes of any kind. Returns null when no Lead is resolvable.
	 */
	prepareSessionZombieDetected(
		session: Session,
		evidence: ZombieEvidence,
		inspection: WorktreeInspection,
	): PreparedZombieNotification | null {
		let labels: string[] = [];
		try {
			labels = this.store.getSessionLabels(session.execution_id);
		} catch {
			labels = [];
		}
		let lead: { agentId: string; chatChannel: string };
		try {
			({ lead } = resolveLeadForIssue(
				this.projects,
				session.project_name ?? "",
				labels,
			));
		} catch {
			return null; // unroutable — caller records the deterministic audit
		}
		const runtime = this.registry.getForLead(lead.agentId);

		const label = session.issue_identifier ?? session.issue_id;
		const files = [
			...(inspection.untracked ?? []),
			...(inspection.modified ?? []),
		];
		const workSummary = inspection.ok
			? `${inspection.untrackedTotal ?? 0} untracked, ${inspection.modifiedTotal ?? 0} modified, ${
					inspection.unpushedCommits ?? "?"
				} unpushed commit(s) (${inspection.unpushedSemantics ?? "unknown"}) on branch ${
					inspection.branch ?? "?"
				} at ${inspection.worktreePath ?? "?"}.${files.length > 0 ? ` Files: ${files.join(", ")}.` : ""}`
			: `unpushed-work check FAILED (${inspection.error ?? "unknown"}) — please inspect ${session.worktree_path ?? "the worktree"} manually.`;
		const evidenceSummary =
			evidence.kind === "verified"
				? `tmux window ${evidence.liveness.target} PROVEN dead (pane probe absent x${evidence.streak}, server up, verified at ${evidence.liveness.probedAt})`
				: evidence.kind === "process"
					? `execution process generation ${evidence.observation.identity.generation} PROVEN dead (${evidence.observation.reason}, observed at ${evidence.observation.observedAt})`
					: `declared zombie (evidence marker unparseable — see last_error)`;

		const hookPayload: HookPayload = {
			event_type: "session_zombie_detected",
			execution_id: session.execution_id,
			issue_id: session.issue_id,
			issue_identifier: session.issue_identifier,
			issue_title: session.issue_title,
			project_name: session.project_name,
			status: "failed",
			notification_context: `Runner ${label}: ${evidenceSummary}. The session was marked failed after death reconciliation. Worktree check: ${workSummary} Lead decides rescue (commit/push) — NOT auto-committed.${session.last_error?.includes("readiness_retry_exhausted") ? ` Recovery: ${session.last_error}` : ""}`,
			session_role: session.session_role ?? "main",
			unpushed_work: inspection,
		};
		if (evidence.kind === "verified") {
			hookPayload.liveness_probe = {
				method: "tmux_pane_probe",
				target: evidence.liveness.target,
				result: "absent",
				probed_at: evidence.liveness.probedAt,
				consecutive_probes: evidence.streak,
			};
		}
		// Unparseable evidence carries NO liveness_probe at all (code R1 #4): a
		// malformed marker proves only "cannot parse" — never that a pane probe
		// ran, and never its result. The degradation is expressed in the
		// notification_context wording alone.
		hookPayload.chat_channel = lead.chatChannel;
		if (this.chatThreadsEnabled) {
			hookPayload.chat_thread_id = resolveChatThreadId(
				this.store,
				session.issue_id,
				lead.chatChannel,
			);
		}
		if (this.eventFilter) {
			const filterResult = this.eventFilter.classify(
				hookPayload.event_type,
				hookPayload,
			);
			hookPayload.filter_priority = filterResult.priority;
		}
		return {
			leadId: lead.agentId,
			eventId: `zombie-${session.execution_id}`,
			eventType: "session_zombie_detected",
			payloadJson: JSON.stringify(hookPayload),
			sessionKey: buildSessionKey(session),
			runtime,
		};
	}

	/**
	 * FLY-1282 two-phase zombie alert, persist half (INV-9): the FIRST store
	 * mutation is the lead_events append; transport is awaited after, with
	 * throw/false/missing-runtime all recorded for the bounded guardrail retry.
	 */
	async persistPreparedZombieDetected(
		prepared: PreparedZombieNotification,
	): Promise<boolean> {
		try {
			await this.appendAndDeliverRow({
				leadId: prepared.leadId,
				eventId: prepared.eventId,
				eventType: prepared.eventType,
				payloadJson: prepared.payloadJson,
				sessionKey: prepared.sessionKey,
				payloadForEnvelope: JSON.parse(prepared.payloadJson) as HookPayload,
				runtime: prepared.runtime,
				onDeliverThrow: "record",
			});
			return true;
		} catch (err) {
			// append itself failed — the anti-join backfill will retry.
			console.error(
				`[HeartbeatService] FLY-1282 zombie alert append threw: ${(err as Error).message}`,
			);
			return false;
		}
	}
}
