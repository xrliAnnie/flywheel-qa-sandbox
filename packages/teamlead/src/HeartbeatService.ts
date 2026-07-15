import { randomUUID } from "node:crypto";
import { CommDB } from "flywheel-comm/db";
import { modelShortCode } from "flywheel-config";
import {
	type ApplyTransitionOpts,
	applyTransition,
} from "./applyTransition.js";
import { isReviewHeld } from "./bridge/auto-qa-held.js";
import type {
	ChatThreadContext,
	ChatThreadCreator,
} from "./bridge/ChatThreadCreator.js";
import { resolveChatThreadId } from "./bridge/chat-thread-utils.js";
import {
	applyQuarantineFallback,
	type MarkerReconcilerDeps,
	tryReconcileComplete,
} from "./bridge/complete-marker-reconciler.js";
import {
	type CrashReaperInjectedDeps,
	reapCrashedRunners,
} from "./bridge/crash-reaper.js";
import { hasPendingCompleteMarker } from "./bridge/done-running-reconciler.js";
import type { EventFilter } from "./bridge/EventFilter.js";
import { buildSessionKey, type HookPayload } from "./bridge/hook-payload.js";
import type { IssueDisplayRefreshHolder } from "./bridge/issue-display-refresher.js";
import {
	GUARDRAIL_EVENT_TYPES,
	type LeadEventEnvelope,
	RETRYABLE_LEAD_EVENT_TYPES,
} from "./bridge/lead-runtime.js";
import {
	GHOST_PROBE_MAX_ROWS,
	TURN_GRANT_GRACE_MS,
} from "./bridge/phase-orchestrator.js";
import { classifyQuiet, type QuietSignals } from "./bridge/quiet-classifier.js";
import type { RuntimeRegistry } from "./bridge/runtime-registry.js";
import { reconnectingBadge, stageBadge } from "./bridge/stage-utils.js";
import {
	CONFIRM_NOTES,
	parseStuckConfirmKnobs,
	type StuckConfirmResult,
} from "./bridge/stuck-pane-confirm.js";
import {
	getTmuxTargetFromCommDb,
	isTmuxWindowAlive,
	lookupTmuxTarget,
	probeRunnerProcessLiveness,
} from "./bridge/tmux-lookup.js";
import type { ProjectEntry } from "./ProjectConfig.js";
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

/**
 * FLY-1204: injected chokepoint for the periodic parked-phase reclaim patrol —
 * the safety net that reclaims three-stage keep-alive phase sessions (design/
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

export interface HeartbeatNotifier {
	/**
	 * Emit the `session_stuck` advisory. Returns true ONLY when the event was
	 * actually persisted (appended to `lead_events`) — FLY-637 R1 #2: the stuck
	 * dedup (both persistent + in-memory) must be gated on this, so a no-lead /
	 * no-runtime no-op (returns false) cannot durably silence a wake that never
	 * reached the guardrail journal. A no-op notifier returns false.
	 */
	onSessionStuck(
		session: Session,
		minutesSinceActivity: number,
		/**
		 * FLY-1234: confirm-layer annotation. ONLY passed when the confirm layer
		 * is engaged (holder injected + kill-switch ON) — the legacy path keeps
		 * the exact two-argument call (INV-5 arity sentinel).
		 */
		details?: { confirmNote?: string },
	): Promise<boolean>;
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
	 * FLY-623: this is the LEGACY (FLYWHEEL_HEARTBEAT_READOPT=0) path's advisory;
	 * the readopt-ON path uses onSessionMonitoringReestablished instead.
	 */
	onSessionMonitoringLost(
		session: Session,
		minutesSinceHeartbeat: number,
	): Promise<void>;
	/**
	 * FLY-623: readopt-ON happy path — the Bridge re-adopted a live detached
	 * Runner after a restart (heartbeat re-established via tmux liveness). A
	 * one-time, low-priority, NON-retryable FYI per reconnecting episode (the
	 * founder-facing signal is the Display-A "⚠️重连中" title, not this). An
	 * implementation that owns a chat thread also stamps the reconnecting title
	 * here.
	 */
	onSessionMonitoringReestablished(
		session: Session,
		minutesSinceHeartbeat: number,
		details?: { stampReconnectTitle?: boolean },
	): Promise<void>;
	/**
	 * FLY-623: re-stamp the real/terminal status badge on a Runner's thread title
	 * once it leaves the reconnecting state (strips the "⚠️重连中" marker). Optional
	 * + best-effort: a notifier without a chat thread (legacy / tests) no-ops.
	 */
	clearReconnectStamp?(session: Session): void;
}

/**
 * FLY-623: the narrow read/clear surface the event path + idle watchdog use on
 * HeartbeatService's reconnecting set, threaded via a late-bound holder (the
 * service is constructed after the router/watchdog are wired). `HeartbeatService`
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
}

/**
 * Periodic checker for stuck sessions (running but no activity for N minutes)
 * and orphan sessions (running but heartbeat has gone stale).
 * Sends one notification per execution per condition, deduped in-memory.
 */
export class HeartbeatService implements ReconnectController {
	private timer: NodeJS.Timeout | null = null;
	private notifiedStuck = new Set<string>();
	private notifiedOrphans = new Set<string>();
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
	 * dead, so `checkStuck()`/`reapOrphans()` resume normal signaling.
	 */
	private notifiedMonitorLost = new Set<string>();
	/**
	 * FLY-172: execIds with a marker whose replay transiently failed THIS cycle —
	 * `reapOrphans()` must skip force-failing them (retry next cycle). Rebuilt
	 * each `reconcileMonitorLoss()` pass so it never goes stale.
	 */
	private markerRetryPending = new Set<string>();
	/**
	 * FLY-623: execIds currently RE-ADOPTED after a Bridge restart (detached but
	 * tmux-alive). The single source of truth for the reconnecting lifecycle:
	 * while a member is here we refresh its heartbeat each cycle (treating
	 * tmux-liveness as the fallback heartbeat source for a Runner whose in-process
	 * poll loop died with the previous Bridge) and suppress stuck/orphan/idle. A
	 * member leaves on a genuine runner event
	 * (clearReconnecting), tmux death, or a terminal marker. Used only on the
	 * readopt-ON path; stays empty when FLYWHEEL_HEARTBEAT_READOPT=0 (exact FLY-172
	 * legacy behavior preserved).
	 */
	private reconnecting = new Set<string>();
	/**
	 * FLY-1264: founder-facing title ownership has a shorter lifetime than the
	 * fallback-monitoring protection above. It starts with a reconnect episode and
	 * is settled as soon as the canonical issue-display refresher is ready.
	 */
	private reconnectTitleActive = new Set<string>();
	private reconnectTitleRefresherReady = false;

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
		/**
		 * FLY-191 Phase 2: review window for awaiting_review sessions, anchored
		 * on the persisted `awaiting_review_entered_at`. On expiry the Bridge
		 * emits `gate_timed_out` via loopback /events (same FLY-159 escalation
		 * the CLI used) — notification ONLY, the idle runner is NOT killed.
		 * Inherits FLY-159's default: 48h.
		 */
		private reviewTimeoutHours: number = 48,
		/**
		 * FLY-626: cheap, stateless quiet-signal probe consulted BEFORE the
		 * (token-expensive) `session_stuck` Lead wake. A legitimately-quiet runner
		 * (self-declared park/busy, parked at a gate, recently active) is
		 * suppressed. Absent ⇒ no suppression (byte-compat). Applies ONLY to the
		 * `session_stuck` advisory — orphan force-fail + monitoring-lost stay
		 * owned by heartbeat + tmux liveness (Codex R1 #4).
		 */
		private quietSignalsProbe?: (session: Session) => QuietSignals,
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
		 * notify+close for leaked terminal-status sessions, behind the
		 * FLYWHEEL_STALE_TERMINAL_CLOSE kill-switch (default ON) and the FLY-752
		 * retest-protection predicate. Absent → pre-FLY-867 notify-only.
		 */
		private staleTerminalClose?: StaleTerminalCloseConfig,
		/**
		 * FLY-1082 (Task 2.3): the tmux server-loss coordinator — a PRE-REAPER
		 * phase (after monitor reconcile, before crash reaper) so a fleet-level
		 * server loss is claimed as ONE grouped episode before the per-runner
		 * orphan machinery buries it silently. Returns the claimed exec ids;
		 * they join the orphan suppression set. Absent → no-op (byte-compat).
		 * Gated on FLYWHEEL_FLEET_SENSOR_TMUX=0 at the wiring layer.
		 */
		private serverLoss?: { check(): Promise<ReadonlySet<string>> },
		/**
		 * FLY-1204: injected parked-phase reclaim chokepoint (see
		 * StaleParkedCloseConfig). Wired (production) → `checkStaleParkedPhases`
		 * reclaims leaked three-stage phase sessions behind the same
		 * FLYWHEEL_STALE_TERMINAL_CLOSE kill-switch (via `staleCloseEnabled`) plus
		 * its own `FLYWHEEL_PARKED_PHASE_STALE_HOURS` threshold. Absent → inert.
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
		 * checkStuck/reapOrphans. Absent → byte-compat no-op.
		 */
		private onMaintenanceTick?: (tick: number) => Promise<void>,
		/**
		 * FLY-1234: late-bound pane/process confirm layer for the `session_stuck`
		 * heartbeat path (liveness probe → two-frame compare → judge). Tri-state
		 * semantics (R2 #6):
		 *   - `undefined`      — constructor never wired it (legacy/tests): the old
		 *                        path runs byte-for-byte, two-arg notifier calls,
		 *                        zero new logs (INV-5);
		 *   - `current: null`  — production wiring fault (holder declared but never
		 *                        bound): fail-open EMIT with a `confirm_unbound`
		 *                        annotation + a warn log — never a silent bypass;
		 *   - `current` bound  — the confirm layer runs (INV-1: it may only
		 *                        suppress on positive health evidence).
		 */
		private stuckConfirmHolder?: {
			current: ((session: Session) => Promise<StuckConfirmResult>) | null;
		},
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

	async check(): Promise<void> {
		// FLY-1185 §2.5: maintenance dispatch OUTSIDE the core try — detached,
		// so neither direction can affect the other (a core-cycle throw doesn't
		// skip maintenance; a maintenance failure never touches the core chain).
		this.dispatchMaintenanceTick();
		// FLY-639: the whole cycle is wrapped so a StateStore sql.js error
		// (getStuckSessions / getOrphanSessions / getActiveSessions / …) can NEVER
		// crash the Bridge via this heartbeat loop. Contract: check() itself never
		// rejects — on any throw it logs, attempts a best-effort StateStore
		// self-heal, and skips the cycle. (start() still wraps check() in a .catch()
		// as belt-and-suspenders.)
		try {
			// FLY-25: Retry undelivered guardrail events from PREVIOUS cycles first,
			// before detection generates new events in this cycle.
			if (this.notifier instanceof RegistryHeartbeatNotifier) {
				await this.notifier.retryUndeliveredGuardrailEvents();
			}
			// FLY-172: reconcile monitoring loss BEFORE stuck/orphan detection so the
			// monitor-lost / marker-retry skip sets are current. This pass is the
			// single owner of tmux probing for running sessions (Codex guidance #1).
			// Only awaited when wired (production) — skipping the await when
			// unconfigured keeps checkStuck's synchronous getStuckSessions call on the
			// same tick (preserves existing fake-timer test timing).
			if (this.monitorReconcile) {
				await this.reconcileMonitorLoss();
			}
			// FLY-720: crash reaper runs BEFORE reapOrphans and claims confirmed
			// dead-pins into deadPinOwned so reapOrphans skips them (never force-fails
			// a crash to `failed`). Best-effort — a reaper failure must not skip the
			// rest of the cycle. Only awaited when the reaper is wired + enabled, so an
			// unconfigured Bridge keeps checkStuck's synchronous getStuckSessions call
			// on the same tick (mirrors the monitorReconcile guard; preserves existing
			// fake-timer test timing).
			// FLY-1082 (Task 2.3): server-loss coordinator — the pre-reaper phase.
			// Runs AFTER reconcileMonitorLoss (liveness sets current) and BEFORE
			// the crash reaper / orphan reaping so a fleet-level tmux server death
			// is claimed as ONE grouped, episode-tagged migration in this same
			// cycle; the claimed ids suppress the per-runner paths below.
			// Best-effort — a coordinator failure must never skip the cycle.
			let serverLossOwned: ReadonlySet<string> = new Set();
			if (this.serverLoss) {
				try {
					serverLossOwned = await this.serverLoss.check();
				} catch (err) {
					console.error(
						`[server-loss] check failed (cycle continues): ${(err as Error).message}`,
					);
				}
			}
			let deadPinOwned: ReadonlySet<string> = new Set();
			if (this.crashReaperConfig?.enabled) {
				deadPinOwned = await this.reapCrashedRunners();
			}
			await this.checkStuck();
			await this.reapOrphans(new Set([...deadPinOwned, ...serverLossOwned]));
			await this.checkStaleCompleted();
			// FLY-1204: reclaim leaked three-stage keep-alive phase sessions
			// (independent throttle; inert unless wired). Its own try/guards keep a
			// failure best-effort — the outer catch is the belt-and-suspenders.
			await this.checkStaleParkedPhases();
			await this.checkAwaitingReviewTimeout();
		} catch (err) {
			console.error(
				"[HeartbeatService] check error (skipping cycle, Bridge stays up):",
				err instanceof Error ? err.message : String(err),
			);
			// Byte-compat: old mock stores (tests) may lack the method.
			if (typeof this.store.recoverFromCorruption === "function") {
				this.store.recoverFromCorruption(err);
			}
		}
	}

	/**
	 * FLY-191 Phase 2: Bridge-side review timeout. With `gate --no-block` the
	 * gate CLI process no longer owns the 48h countdown (it exits immediately),
	 * so the deadline moves here: awaiting_review sessions whose persisted
	 * `awaiting_review_entered_at` is older than `reviewTimeoutHours` get ONE
	 * `gate_timed_out` event via loopback /events (canonical FLY-159 path —
	 * Lead notification + Annie escalation, classify/filter, guardrail retry).
	 *
	 * Deliberately does NOT kill or transition the runner — it is healthy and
	 * idle; the timeout is a human-attention escalation, not a failure
	 * (plan §3.3). Dedup is the persisted `gate_timeout_notified_at` stamp
	 * (cleared on every fresh awaiting_review entry, so a re-review window
	 * gets its own escalation; survives Bridge restarts — in-memory sets
	 * would re-notify after every restart).
	 *
	 * Reuses the existing heartbeat timer (no new periodic load — FLY-169/172
	 * norm) and the FLY-172 loopback wiring; absent that wiring (legacy/test
	 * construction) the pass is a no-op.
	 */
	async checkAwaitingReviewTimeout(): Promise<void> {
		if (!this.monitorReconcile) return;
		const timedOut = this.store.getAwaitingReviewTimedOut(
			this.reviewTimeoutHours,
		);
		if (timedOut.length === 0) return;

		const fetchFn = this.monitorReconcile.fetchFn ?? fetch;
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (this.monitorReconcile.ingestToken) {
			headers.Authorization = `Bearer ${this.monitorReconcile.ingestToken}`;
		}

		for (const session of timedOut) {
			const enteredAt = session.awaiting_review_entered_at;
			if (!enteredAt) continue; // query excludes these; belt-and-braces
			// FLY-579: QA-held — do NOT escalate a founder `gate_timed_out` while
			// independent QA is still running/failed. The founder is intentionally
			// not surfaced until QA is green; a QA stall is a Lead-only pipeline
			// error (owned by AutoQaCoordinator), never a founder review timeout.
			// Same isQaHeld predicate as event-route + GatePoller (no drift).
			if (isReviewHeld(this.store, session)) continue;
			const waitedMs =
				Date.now() - new Date(`${enteredAt.replace(" ", "T")}Z`).getTime();
			const body = {
				event_id: randomUUID(),
				execution_id: session.execution_id,
				issue_id: session.issue_id,
				project_name: session.project_name,
				event_type: "gate_timed_out",
				source: "bridge.heartbeat",
				payload: {
					checkpoint: "approve_to_ship",
					exec_id: session.execution_id,
					waited_ms: waitedMs,
					original_message: `Review window expired: awaiting_review since ${enteredAt} (FLY-191 Bridge-side timeout). Runner is idle and reachable — NOT killed. Approve/reject/feedback to resolve.`,
					timeout_behavior: "fail-close",
					timeout_behavior_source: "bridge",
				},
			};
			try {
				const res = await fetchFn(
					`${this.monitorReconcile.bridgeBaseUrl}/events`,
					{ method: "POST", headers, body: JSON.stringify(body) },
				);
				if (res.ok) {
					// Stamp ONLY on accepted delivery — a Bridge-side 5xx retries
					// next cycle. (Lead-side delivery reliability beyond ingest is
					// owned by the FLY-159 guardrail retry machinery.)
					this.store.markGateTimeoutNotified(session.execution_id);
				} else {
					console.error(
						`[HeartbeatService] gate_timed_out loopback HTTP ${res.status} for ${session.execution_id}; will retry next cycle`,
					);
				}
			} catch (err) {
				console.error(
					`[HeartbeatService] gate_timed_out loopback failed for ${session.execution_id}: ${(err as Error).message}; will retry next cycle`,
				);
			}
		}
	}

	/**
	 * FLY-623: kill-switch — readopt is ON by default (the FLY-172 advisory-only
	 * behavior is the bug: a restart-orphaned but live Runner stays permanently
	 * monitoring-lost). `FLYWHEEL_HEARTBEAT_READOPT=0` reverts to the exact FLY-172
	 * legacy path (no re-adopt, no reconnecting set, no boot-seed, no Display-A).
	 * Read at cycle/boot time so a flip needs no restart and no signature change.
	 */
	private readoptEnabled(): boolean {
		return process.env.FLYWHEEL_HEARTBEAT_READOPT !== "0";
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
		};
	}

	/**
	 * FLY-172 + FLY-623: For running sessions whose heartbeat has gone stale
	 * (≥ stuck threshold — the fingerprint of monitoring loss after a restart):
	 * try the completion marker FIRST (a valid terminal marker wins over tmux
	 * liveness), and only if there is no usable marker, probe tmux.
	 *
	 * - readopt OFF (`FLYWHEEL_HEARTBEAT_READOPT=0`): exact FLY-172 — tmux alive →
	 *   one-time advisory, never force-fail, never refresh heartbeat.
	 * - readopt ON (default, FLY-623): tmux alive → RE-ADOPT (refresh heartbeat so
	 *   the session reads healthy + no false stuck/orphan/idle), once-per-episode
	 *   "re-established" advisory + "⚠️重连中" title. Members of `reconnecting` are
	 *   re-processed through the SAME marker-first order each cycle (so a later
	 *   terminal marker still wins — no stay-loop bypass).
	 *
	 * tmux dead → leave it for `reapOrphans` to force-fail at the orphan threshold.
	 * Owns `notifiedMonitorLost`, `reconnecting`, and `markerRetryPending`.
	 */
	async reconcileMonitorLoss(): Promise<void> {
		this.markerRetryPending.clear();
		const deps = this.buildMarkerDeps();
		if (!deps) return; // not wired (e.g. unit tests) → no-op
		if (this.readoptEnabled()) {
			await this.reconcileMonitorLossReadopt(deps);
		} else {
			await this.reconcileMonitorLossLegacy(deps);
		}
	}

	/** FLY-172 legacy path (readopt OFF): advisory-only, never refresh heartbeat. */
	private async reconcileMonitorLossLegacy(
		deps: MarkerReconcilerDeps,
	): Promise<void> {
		// Candidate set: running + heartbeat stale ≥ stuck threshold.
		const candidates = this.store.getOrphanSessions(this.thresholdMinutes);
		const candidateIds = new Set(candidates.map((s) => s.execution_id));
		// Prune monitor-lost advisory dedup for sessions no longer candidates.
		for (const id of this.notifiedMonitorLost) {
			if (!candidateIds.has(id)) this.notifiedMonitorLost.delete(id);
		}

		for (const session of candidates) {
			const execId = session.execution_id;
			const outcome = await tryReconcileComplete(execId, deps);
			if (
				outcome.kind === "reconciled" ||
				outcome.kind === "duplicate_terminal"
			) {
				this.notifiedMonitorLost.delete(execId);
				continue;
			}
			if (outcome.kind === "transient_failed") {
				this.markerRetryPending.add(execId);
				continue;
			}
			if (outcome.kind === "quarantined") {
				const alive = await this.isSessionTmuxAlive(session);
				applyQuarantineFallback({
					store: this.store,
					transitionOpts: this.transitionOpts,
					executionId: execId,
					issueId: session.issue_id,
					projectName: session.project_name,
					tmuxAlive: alive,
					routeStatus: outcome.routeStatus,
					quarantinePath: outcome.quarantinePath,
				});
				if (alive) {
					// CODEX R1 HIGH FIX (FLY-172): marker moved to quarantine but the
					// Runner is STILL alive — treat as monitoring-lost so reapOrphans
					// skips it (else a live Runner gets force-failed → GEO-374).
					await this.emitMonitorLostOnce(session);
				} else {
					this.notifiedMonitorLost.delete(execId);
				}
				continue;
			}

			const alive = await this.isSessionTmuxAlive(session);
			if (alive) {
				await this.emitMonitorLostOnce(session);
			} else {
				this.notifiedMonitorLost.delete(execId);
			}
		}
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
	): Promise<void> {
		const byId = new Map<string, Session>();
		for (const s of this.store.getOrphanSessions(this.thresholdMinutes)) {
			byId.set(s.execution_id, s);
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

		for (const session of byId.values()) {
			await this.reconcileCandidateReadopt(session, deps);
		}
	}

	/**
	 * FLY-623: marker-first → quarantine → tmux probe → re-adopt for one candidate
	 * on the readopt path. Shared by the per-cycle union pass and `seedReconnecting`.
	 */
	private async reconcileCandidateReadopt(
		session: Session,
		deps: MarkerReconcilerDeps,
	): Promise<void> {
		const execId = session.execution_id;

		// A reconnecting member terminalized by an accepted event (its status is no
		// longer `running`) leaves reconnecting + gets its terminal title re-stamped.
		if (session.status !== "running") {
			this.clearReconnecting(execId);
			return;
		}

		// 1) Marker-first. A valid terminal marker proves the Runner finished.
		const outcome = await tryReconcileComplete(execId, deps);
		if (
			outcome.kind === "reconciled" ||
			outcome.kind === "duplicate_terminal"
		) {
			this.clearReconnecting(execId);
			return;
		}
		if (outcome.kind === "transient_failed") {
			this.markerRetryPending.add(execId);
			return;
		}
		if (outcome.kind === "quarantined") {
			const alive = await this.isSessionTmuxAlive(session);
			applyQuarantineFallback({
				store: this.store,
				transitionOpts: this.transitionOpts,
				executionId: execId,
				issueId: session.issue_id,
				projectName: session.project_name,
				tmuxAlive: alive,
				routeStatus: outcome.routeStatus,
				quarantinePath: outcome.quarantinePath,
			});
			if (alive) await this.enterReconnecting(session);
			else this.clearReconnecting(execId);
			return;
		}

		// 2) No marker (absent) → probe tmux.
		const alive = await this.isSessionTmuxAlive(session);
		if (alive) await this.enterReconnecting(session);
		else this.clearReconnecting(execId);
	}

	/**
	 * FLY-623 boot-seed: at Bridge boot, AFTER the FLY-172 marker drain AND the
	 * FLY-324 done-but-running sweep, and BEFORE `start()` / RunnerIdleWatchdog,
	 * seed reconnecting state for pre-existing `running` sessions (their in-process
	 * poll loop died with the previous Bridge process). This makes the in-memory
	 * set restart-safe (re-seeded every boot → survives repeated restarts) and
	 * closes the on-boot false-alarm window (a parked Runner already has stale
	 * `last_activity_at`, so `checkStuck` could fire before the first reconcile).
	 * No-op when not wired or readopt OFF.
	 */
	async seedReconnecting(): Promise<string[]> {
		const deps = this.buildMarkerDeps();
		if (!deps || !this.readoptEnabled()) return [];
		this.markerRetryPending.clear();
		const seeded: string[] = [];
		const running = this.store
			.getActiveSessions()
			.filter((s) => s.status === "running");
		for (const session of running) {
			const execId = session.execution_id;
			const wasTitleActive = this.reconnectTitleActive.has(execId);
			await this.reconcileCandidateReadopt(session, deps);
			if (!wasTitleActive && this.reconnectTitleActive.has(execId)) {
				seeded.push(execId);
			}
		}
		return seeded;
	}

	/**
	 * FLY-623: re-adopt a detached-but-alive Runner. Refresh its heartbeat every
	 * cycle (tmux-liveness IS the heartbeat now), and ONCE per reconnecting episode
	 * emit the low-priority "re-established" advisory + stamp the "⚠️重连中" title.
	 */
	private async enterReconnecting(session: Session): Promise<void> {
		const execId = session.execution_id;
		// minutesSince from the (pre-refresh) heartbeat — informational only.
		let minutesSince = this.thresholdMinutes;
		if (session.heartbeat_at) {
			minutesSince = Math.round(
				(Date.now() -
					new Date(`${session.heartbeat_at.replace(" ", "T")}Z`).getTime()) /
					60_000,
			);
		}
		// Re-adopt: refresh heartbeat so the session reads healthy (no false
		// stuck/orphan/idle) — every cycle while tmux is alive.
		this.store.updateHeartbeat(execId);
		if (this.reconnecting.has(execId)) return; // stay (already this episode)
		this.reconnecting.add(execId);
		// Only the startup window owns the visible ⚠️ title. Once the canonical
		// refresher is ready, runtime re-entries keep the already-correct phase title
		// and spend zero Discord renames (hard budget: ~2 per 10 minutes/thread).
		const stampReconnectTitle = !this.reconnectTitleRefresherReady;
		if (stampReconnectTitle) this.reconnectTitleActive.add(execId);
		// Once-per-episode FYI + Display-A stamp. Best-effort — a failed FYI must
		// not block re-adopt, and it is NOT retried (non-guardrail event type).
		try {
			await this.notifier.onSessionMonitoringReestablished(
				session,
				minutesSince,
				{ stampReconnectTitle },
			);
		} catch {
			// best-effort advisory
		}
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
	 * FLY-623: read-only predicate for the separate `RunnerIdleWatchdog` /
	 * `StuckRunnerDetector` paths (which independently poll running sessions). They
	 * skip idle notification + stuck-episode advancement while a Runner is
	 * reconnecting, so a restart-orphaned-but-alive Runner doesn't trigger false
	 * idle/stuck alarms.
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
	 * alive-but-detached Runner and add it to `notifiedMonitorLost` so both
	 * `checkStuck()` and `reapOrphans()` skip it. Idempotent per Bridge-process
	 * lifetime; on delivery failure it is NOT deduped (retried next cycle).
	 */
	private async emitMonitorLostOnce(session: Session): Promise<void> {
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
			await this.notifier.onSessionMonitoringLost(session, minutesSince);
			this.notifiedMonitorLost.add(execId);
		} catch {
			// delivery failed — retry advisory next cycle (don't dedup)
		}
	}

	/**
	 * FLY-172 + FLY-720: resolve + probe tmux for a session. Single owner of the
	 * heartbeat-side liveness read.
	 *
	 * FLY-720 root-cause fix: a crashed Runner's cmux `remain-on-exit on` window
	 * PERSISTS with a dead `[exited]` pane, so the old window-existence probe
	 * (`isTmuxWindowAlive`) read the corpse as alive → the readopt loop re-adopted
	 * it forever → it never aged into an orphan → never reaped. This now reads
	 * `#{pane_dead}` (via `probeRunnerProcessLiveness`) so a dead-pin is NOT alive.
	 *
	 * Liveness for the readopt / monitor-loss path (alive = keep monitoring):
	 *   - CommDB `gone` (no target) → false (today's behavior; reapOrphans owns it).
	 *   - CommDB `error` (locked/corrupt/transient) → TRUE, alive-for-suppression
	 *     (GEO-374: a transient read must never look dead → never reaped).
	 *   - pane probe `alive` / `indeterminate` → true (keep monitoring).
	 *   - pane probe `dead_pin` / `absent` → false (ages into orphan → crash reaper
	 *     claims dead_pin; reapOrphans claims absent).
	 *
	 * `FLYWHEEL_LIVENESS_PANE_DEAD=0` reverts to the exact pre-FLY-720
	 * window-existence probe (emergency byte-compat).
	 */
	private async isSessionTmuxAlive(session: Session): Promise<boolean> {
		if (!session.project_name) return false;
		if (process.env.FLYWHEEL_LIVENESS_PANE_DEAD === "0") {
			const target = getTmuxTargetFromCommDb(
				session.execution_id,
				session.project_name,
			);
			if (!target) return false;
			try {
				return await isTmuxWindowAlive(target.tmuxWindow);
			} catch {
				return false;
			}
		}
		const lookup = lookupTmuxTarget(session.execution_id, session.project_name);
		if (lookup.kind === "gone") return false;
		if (lookup.kind === "error") return true; // alive-for-suppression (GEO-374)
		try {
			const liveness = await probeRunnerProcessLiveness(
				lookup.target.tmuxWindow,
			);
			return liveness === "alive" || liveness === "indeterminate";
		} catch {
			return true; // fail-closed to alive-for-suppression
		}
	}

	/**
	 * FLY-626: true when the cheap quiet-signal probe classifies the session as
	 * legitimately quiet, so the `session_stuck` wake must be suppressed. No probe
	 * ⇒ false (byte-compat). Fails OPEN on error (a transient comm.db read problem
	 * never hides a genuinely stuck runner — FLY-369). Scoped to the session_stuck
	 * advisory ONLY; orphan reaping / monitoring-lost are not gated here.
	 */
	private isStuckWakeSuppressed(session: Session): boolean {
		if (!this.quietSignalsProbe) return false;
		try {
			const result = classifyQuiet(this.quietSignalsProbe(session));
			if (!result.mayWake) {
				console.log(
					`[HeartbeatService] FLY-626 suppressed session_stuck for ${session.execution_id} (${result.verdict})`,
				);
				return true;
			}
			return false;
		} catch (err) {
			console.warn(
				`[HeartbeatService] FLY-626 quiet probe failed for ${session.execution_id} (fail-open):`,
				(err as Error).message,
			);
			return false;
		}
	}

	/**
	 * FLY-172 + FLY-623: a session whose stuck/orphan signals must be suppressed
	 * because it is monitoring-lost (legacy advisory) OR re-adopted (readopt). The
	 * reconcile pass owns both sets and removes dead/terminal sessions, so this
	 * never over-suppresses a Runner that later actually died.
	 */
	private isMonitorSuppressed(executionId: string): boolean {
		return (
			this.notifiedMonitorLost.has(executionId) ||
			this.reconnecting.has(executionId)
		);
	}

	/**
	 * FLY-1234 (R1 #2): checkStuck in-flight guard. The confirm layer awaits
	 * real time (frame gap / judge queue) inside the loop — without this a slow
	 * pass would be re-entered by the next tick and amplify (parkedSweepRunning
	 * precedent). `check()`'s await of checkStuck keeps its existing semantics
	 * (later phases run after); this guard only breaks the re-entry chain.
	 *
	 * Codex code R1 #2 (INV-5): the guard exists ONLY while the confirm layer
	 * is engaged — on the kill-switch / holder-undefined rollback paths the
	 * legacy overlap behavior (and its delivery/dedup timing) is preserved
	 * byte-for-byte, with zero new logs.
	 */
	private stuckCheckRunning = false;

	private async checkStuck(): Promise<void> {
		const confirmEngaged =
			this.stuckConfirmHolder !== undefined && this.stuckConfirmEnabled();
		if (!confirmEngaged) {
			await this.checkStuckInner();
			return;
		}
		if (this.stuckCheckRunning) {
			console.log(
				"[HeartbeatService] FLY-1234 checkStuck from a previous tick is still running — skipping this tick",
			);
			return;
		}
		this.stuckCheckRunning = true;
		try {
			await this.checkStuckInner();
		} finally {
			this.stuckCheckRunning = false;
		}
	}

	/** FLY-1234: kill-switch, read per call (`=0` reverts byte-for-byte). */
	private stuckConfirmEnabled(): boolean {
		return process.env.FLYWHEEL_STUCK_PANE_CONFIRM !== "0";
	}

	private async checkStuckInner(): Promise<void> {
		const stuck = this.store.getStuckSessions(this.thresholdMinutes);

		// Prune notified set: remove entries for sessions no longer stuck
		const stuckIds = new Set(stuck.map((s) => s.execution_id));
		for (const id of this.notifiedStuck) {
			if (!stuckIds.has(id)) this.notifiedStuck.delete(id);
		}
		// FLY-637 #4: prune the persistent stuck dedup against the SAME set so a
		// session that recovered (left getStuckSessions) starts clean — if it gets
		// stuck again later it can be re-reported. Empty set ⇒ all stuck rows
		// cleared (the store guards the `IN ()` case).
		if (this.quietPersistEnabled()) {
			this.store.pruneQuietWakeNotifiedNotIn("stuck", [...stuckIds]);
		}

		// FLY-1234 (INV-2): per-tick confirm budget. Beyond-budget candidates take
		// the LEGACY emit (annotated) — never deferral, so a dead_pin queued behind
		// chronically-suppressed candidates can never starve.
		let confirmBudget = parseStuckConfirmKnobs(process.env).perTick;

		for (const session of stuck) {
			// FLY-172 + FLY-623: a monitoring-lost / re-adopted (alive-but-detached)
			// Runner looks "stuck" (last_activity stale) only because the Bridge lost
			// its reporting channel — suppress the false session_stuck. Re-adopt
			// refreshes heartbeat_at but NOT last_activity_at, so without this the
			// re-adopted session would trade a false orphan for a false stuck (plan
			// §3.4 regression guard). The reconcile pass owns both sets.
			if (this.isMonitorSuppressed(session.execution_id)) continue;
			// FLY-637 #3/#4: in-memory OR persistent dedup — already reported this
			// stuck episode (persistent survives a Bridge restart).
			if (this.alreadyNotifiedStuck(session)) continue;
			// FLY-626: a legitimately-quiet runner (self-declared park/busy, parked
			// at a gate, recently active) must not wake the Lead with session_stuck.
			// Advisory-only — reapOrphans force-fail + monitoring-lost are untouched.
			if (this.isStuckWakeSuppressed(session)) continue;

			// FLY-1234: pane/process confirm layer (tri-state — see the holder doc).
			let confirmNote: string | undefined;
			let confirmEngaged = false;
			if (this.stuckConfirmHolder !== undefined && this.stuckConfirmEnabled()) {
				confirmEngaged = true;
				if (this.stuckConfirmHolder.current === null) {
					// Production wiring fault — fail-open emit, loudly (INV-1).
					confirmNote = CONFIRM_NOTES.confirm_unbound;
					console.warn(
						`[HeartbeatService] FLY-1234 confirm holder UNBOUND — fail-open emit for ${session.execution_id}`,
					);
				} else if (confirmBudget <= 0) {
					confirmNote = CONFIRM_NOTES.confirm_budget_exhausted;
					console.log(
						`[HeartbeatService] FLY-1234 confirm budget exhausted — legacy emit for ${session.execution_id}`,
					);
				} else {
					confirmBudget -= 1;
					const activityBefore = session.last_activity_at;
					let result: StuckConfirmResult;
					try {
						result = await this.stuckConfirmHolder.current(session);
					} catch (err) {
						// confirmStuckCandidate never throws by contract —
						// belt-and-suspenders fail-open (INV-1).
						console.warn(
							`[HeartbeatService] FLY-1234 confirm threw for ${session.execution_id} (fail-open emit): ${(err as Error).message}`,
						);
						result = {
							action: "emit",
							reason: "confirm_error",
							confirmNote: CONFIRM_NOTES.confirm_error,
						};
					}
					// INV-3 + R2 #7: the confirm call awaited real time — re-read and
					// replay EVERY cheap gate before emitting. Recovery is judged by
					// snapshot string equality (no JS date parsing). Any change → this
					// tick emits nothing and dedups nothing (re-evaluated next tick).
					const fresh = this.store.getSession(session.execution_id);
					if (
						!fresh ||
						fresh.status !== "running" ||
						fresh.last_activity_at !== activityBefore
					) {
						continue;
					}
					if (this.isMonitorSuppressed(session.execution_id)) continue;
					if (this.alreadyNotifiedStuck(fresh)) continue;
					if (this.isStuckWakeSuppressed(fresh)) continue;
					if (result.action === "suppress") {
						// No dedup on suppress — the episode is re-evaluated next tick
						// (the death probe catches a later real death; the judge
						// cooldown cache bounds the cost).
						console.log(
							`[HeartbeatService] FLY-1234 confirm suppressed session_stuck for ${session.execution_id} (${result.reason})`,
						);
						continue;
					}
					confirmNote = result.confirmNote ?? result.reason;
				}
			}

			let minutesSince = this.thresholdMinutes;
			if (session.last_activity_at) {
				const lastActivity = new Date(
					`${session.last_activity_at.replace(" ", "T")}Z`,
				);
				minutesSince = Math.round(
					(Date.now() - lastActivity.getTime()) / 60_000,
				);
			}

			try {
				// INV-5: the legacy path keeps the exact two-argument call — the
				// three-argument form exists ONLY when the confirm layer is engaged
				// (arity sentinel).
				const persisted = confirmEngaged
					? await this.notifier.onSessionStuck(session, minutesSince, {
							confirmNote,
						})
					: await this.notifier.onSessionStuck(session, minutesSince);
				// FLY-637 R1 #2 / R2 LOW #2: dedup (BOTH persistent + in-memory) ONLY
				// once the wake was actually persisted to lead_events. A no-runtime /
				// no-lead no-op (persisted=false) must NOT durably silence a wake that
				// never reached the guardrail journal — leave it un-deduped to retry.
				if (persisted) this.markStuckNotified(session);
			} catch {
				// Notification threw — don't dedup so it's retried next cycle
			}
		}
	}

	/**
	 * FLY-637 #3/#4: persistent quiet-wake dedup is on by default;
	 * `FLYWHEEL_QUIET_PERSIST_DEDUP=0` reverts to the MVP in-memory
	 * (`notifiedStuck`) dedup only — byte-compat. Read per-call (no restart).
	 */
	private quietPersistEnabled(): boolean {
		return process.env.FLYWHEEL_QUIET_PERSIST_DEDUP !== "0";
	}

	/**
	 * Already reported this stuck episode? In-memory `notifiedStuck` OR (when
	 * persistence is on) the durable `quiet_wake_notified` row. The heartbeat path
	 * has no pane, so the episode fingerprint is the sentinel `'stuck'`.
	 */
	private alreadyNotifiedStuck(session: Session): boolean {
		if (this.notifiedStuck.has(session.execution_id)) return true;
		if (this.quietPersistEnabled()) {
			return this.store.hasQuietWakeNotified(
				session.execution_id,
				"stuck",
				"stuck",
			);
		}
		return false;
	}

	/** FLY-637: record the stuck dedup (in-memory + persistent) after a PERSISTED emit. */
	private markStuckNotified(session: Session): void {
		this.notifiedStuck.add(session.execution_id);
		if (this.quietPersistEnabled()) {
			this.store.recordQuietWakeNotified(
				session.execution_id,
				"stuck",
				"stuck",
			);
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
		// disabled (kill-switch OFF or unwired), the loop must restore the exact
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

				// FLY-867: close the leak through the injected closeRunner
				// chokepoint — BEFORE the notify dedup gate, so a failed close is
				// retried every stale cycle (the dedup only suppresses repeat
				// notifications, never a close retry). Guarded by the FLY-752
				// retest-protection predicate: a parked QA in an active fix-loop
				// must stay alive. Only a CONFIRMED teardown skips the stale
				// notification; a failed/ineligible close falls through to the
				// existing notify path (operator visibility preserved).
				if (closeEnabled && !this.isRetestProtected(session)) {
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
	 * FLY-1204: periodic safety net that reclaims three-stage keep-alive phase
	 * sessions (design/implement/qa) that leaked alive past ship or pipeline
	 * termination — the root of the OOM incident (design_done holders never
	 * closed after handoff; completed QA processes never torn down). Runs behind
	 * the shared FLYWHEEL_STALE_TERMINAL_CLOSE kill-switch, its own independent
	 * throttle, and a global re-entrancy guard. Never throws (best-effort).
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
		// Shared kill-switch with FLY-867 (the env is the switch; the parked patrol
		// has its own wiring check above, so it does NOT also require the terminal
		// close chokepoint to be wired).
		if (process.env.FLYWHEEL_STALE_TERMINAL_CLOSE === "0") return;
		if (this.parkedSweepRunning) return; // a prior long sweep is still running
		const now = Date.now();
		if (now - this.lastParkedCheckAt < this.staleCheckIntervalMs) return;
		this.parkedSweepRunning = true;
		try {
			const candidates = this.store.getParkedPhaseCandidates();
			const total = candidates.length;
			if (total === 0) return;

			// Group by issue — the verdict needs the WHOLE issue group, not just the
			// candidates that fall in this sweep's window.
			const byIssue = new Map<string, Session[]>();
			for (const s of candidates) {
				const g = byIssue.get(s.issue_id);
				if (g) g.push(s);
				else byIssue.set(s.issue_id, [s]);
			}

			// STABLE global order by execution_id (a random UUID — stable across
			// sweeps, independent of the mutable last_activity_at). A single
			// execution_id watermark walks this ordering CAP-at-a-time, restarting at
			// the head after the tail. Because the ordering + identity are stable,
			// EVERY candidate is reached within ⌈total/cap⌉ sweeps regardless of how
			// the candidate set changes between sweeps — there is no per-sweep issue
			// window whose varying length could thrash a modulo cursor and starve a
			// live leak spread across many issues (FLY-1210 root-fix / Codex R4).
			const ordered = [...candidates].sort((a, b) =>
				a.execution_id < b.execution_id
					? -1
					: a.execution_id > b.execution_id
						? 1
						: 0,
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
	 * (1) A `post_ship_finalization_claim` exists → the pipeline is terminated and
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
		const hasClaim =
			this.store.countEventsByIssueAndType(
				issueId,
				"post_ship_finalization_claim",
			) > 0;

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
			this.store.getPhaseSessionsForIssue(issueId),
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
		// Structural subset of ThreeStageTurn (not re-exported from flywheel-comm/db).
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

	/**
	 * FLY-1204: 3-state PROCESS liveness for a phase session — distinct from
	 * `isSessionTmuxAlive` (which folds to a boolean for suppression). Uses the
	 * discriminated `lookupTmuxTarget` (error ≠ gone): CommDB read error → defer;
	 * no target → dead (gone); pane probe alive → alive; dead_pin/absent → dead;
	 * indeterminate / throw → defer (never close on doubt).
	 */
	private async probePhaseLiveness(
		session: Session,
	): Promise<"alive" | "dead" | "defer"> {
		if (!session.project_name) return "dead";
		const lookup = lookupTmuxTarget(session.execution_id, session.project_name);
		if (lookup.kind === "error") return "defer";
		if (lookup.kind === "gone") return "dead";
		try {
			const liveness = await probeRunnerProcessLiveness(
				lookup.target.tmuxWindow,
			);
			if (liveness === "alive") return "alive";
			if (liveness === "indeterminate") return "defer";
			return "dead"; // dead_pin | absent
		} catch {
			return "defer";
		}
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
			const role = r.chat_thread_role ?? "";
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
	 * chokepoint AND the kill-switch is not off. Default ON
	 * (FLYWHEEL_STALE_TERMINAL_CLOSE=0 reverts to pre-FLY-867 notify-only).
	 */
	private staleCloseEnabled(): boolean {
		if (!this.staleTerminalClose) return false;
		return process.env.FLYWHEEL_STALE_TERMINAL_CLOSE !== "0";
	}

	/**
	 * FLY-867 (FLY-752 boundary): NEVER close a QA runner an active fix-loop
	 * still references. Owner-record semantics: the session is protected iff
	 * ANY auto_qa_record has qa_execution_id === session, an active status
	 * (running — an in-flight QA with a terminal CommDB anomaly is spared —
	 * or awaiting_retest — parked for the next head), AND its parent is still
	 * awaiting_review at that record's target head. `qa_execution_id` is not
	 * unique (historical rows), so ALL rows are scanned — any match protects.
	 * Any store read failure → protected (fail-closed: never kill on
	 * uncertainty).
	 */
	private isRetestProtected(session: Session): boolean {
		try {
			const records = this.store.listAutoQaRecordsByQaExec(
				session.execution_id,
			);
			for (const rec of records) {
				if (rec.status !== "running" && rec.status !== "awaiting_retest") {
					continue;
				}
				const parent = this.store.getSession(rec.parent_execution_id);
				if (
					parent &&
					parent.status === "awaiting_review" &&
					(parent.pr_head_sha ?? "").toLowerCase() ===
						rec.target_pr_head_sha.toLowerCase()
				) {
					return true;
				}
			}
			return false;
		} catch (err) {
			console.warn(
				`[HeartbeatService] FLY-867 retest-protection read failed for ${session.execution_id} — treating as protected: ${(err as Error).message}`,
			);
			return true;
		}
	}

	/**
	 * FLY-720: run the liveness-based crash reaper for this cycle and return the
	 * set of confirmed dead-pin execIds so `reapOrphans` skips them. No-op (empty
	 * set) when the reaper is unwired or its kill-switch is OFF. Never throws — a
	 * reaper failure logs and returns an empty set so the rest of the cycle runs.
	 */
	private async reapCrashedRunners(): Promise<ReadonlySet<string>> {
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
					this.isMonitorSuppressed(id) || this.markerRetryPending.has(id),
				hasPendingCompleteMarker: (id) => hasPendingCompleteMarker(id),
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
		deadPinOwned: ReadonlySet<string> = new Set(),
	): Promise<void> {
		const orphans = this.store.getOrphanSessions(this.orphanThresholdMinutes);

		// Prune notified set: remove entries for sessions no longer orphaned
		const orphanIds = new Set(orphans.map((s) => s.execution_id));
		for (const id of this.notifiedOrphans) {
			if (!orphanIds.has(id)) this.notifiedOrphans.delete(id);
		}

		for (const session of orphans) {
			// FLY-720: a confirmed dead-pin the crash reaper owns this cycle is
			// reaped there (→ terminated + teardown + archive); reapOrphans must NOT
			// force-fail it to `failed` (a CRASH_PRESERVE state that never archives).
			if (deadPinOwned.has(session.execution_id)) continue;
			// FLY-172 + FLY-623: skip sessions the reconcile pass classified this
			// cycle as alive-but-detached (monitor-lost / re-adopted) or as having a
			// marker pending retry. reapOrphans does NOT probe tmux itself — the
			// reconcile pass is the single owner of liveness (Codex guidance #1).
			// When none of the sets contains the session, it is a genuine orphan
			// (tmux gone / no usable marker) and the existing force-fail applies.
			if (this.isMonitorSuppressed(session.execution_id)) continue;
			if (this.markerRetryPending.has(session.execution_id)) continue;
			if (this.notifiedOrphans.has(session.execution_id)) continue;

			let minutesSince = this.orphanThresholdMinutes;
			if (session.heartbeat_at) {
				const lastHeartbeat = new Date(
					`${session.heartbeat_at.replace(" ", "T")}Z`,
				);
				minutesSince = Math.round(
					(Date.now() - lastHeartbeat.getTime()) / 60_000,
				);
			}

			try {
				// Force-fail the orphaned session
				const now = new Date()
					.toISOString()
					.replace("T", " ")
					.replace(/\.\d+Z$/, "");
				if (this.transitionOpts) {
					applyTransition(
						this.transitionOpts,
						session.execution_id,
						"failed",
						{
							executionId: session.execution_id,
							issueId: session.issue_id,
							projectName: session.project_name,
							trigger: "orphan_reap",
						},
						{
							last_activity_at: now,
							last_error: `Orphaned: no heartbeat for ${minutesSince} minutes`,
						},
					);
				} else {
					this.store.forceStatus(
						session.execution_id,
						"failed",
						now,
						`Orphaned: no heartbeat for ${minutesSince} minutes`,
					);
				}

				await this.notifier.onSessionOrphaned(session, minutesSince);
				this.notifiedOrphans.add(session.execution_id);
			} catch {
				// Notification failed — don't dedup so it's retried next cycle
			}
		}
	}
}

/**
 * GEO-195 + FLY-25: Registry-based heartbeat notifier — delivers via RuntimeRegistry.
 *
 * FLY-25 upgrade: deliver() returns DeliveryResult instead of fire-and-forget.
 * Guardrail events (stuck/orphan/stale): only mark delivered on success;
 *   failures are recorded and retried next heartbeat cycle (max 3 attempts).
 * Advisory events: best-effort (mark delivered regardless of transport outcome).
 */
export class RegistryHeartbeatNotifier implements HeartbeatNotifier {
	static readonly MAX_DELIVERY_ATTEMPTS = 3;

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

	async onSessionStuck(
		session: Session,
		minutes: number,
		details?: { confirmNote?: string },
	): Promise<boolean> {
		const hookPayload: HookPayload = {
			event_type: "session_stuck",
			execution_id: session.execution_id,
			issue_id: session.issue_id,
			issue_identifier: session.issue_identifier,
			issue_title: session.issue_title,
			project_name: session.project_name,
			status: session.status,
			minutes_since_activity: minutes,
			session_role: session.session_role ?? "main",
		};
		// FLY-1234: confirm-layer annotation — only present when the confirm
		// layer is engaged (legacy two-arg calls leave the payload unchanged).
		if (details?.confirmNote) hookPayload.confirm_note = details.confirmNote;
		// FLY-637 R1 #2: surface whether the event was actually persisted to
		// lead_events so checkStuck only dedups a wake that truly happened.
		return this.deliverHook(session, hookPayload);
	}

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
	): Promise<void> {
		const label = session.issue_identifier ?? session.issue_id;
		const hookPayload: HookPayload = {
			event_type: "session_monitoring_lost",
			execution_id: session.execution_id,
			issue_id: session.issue_id,
			issue_identifier: session.issue_identifier,
			issue_title: session.issue_title,
			project_name: session.project_name,
			status: session.status,
			minutes_since_activity: minutes,
			notification_context: `Runner ${label} lost Bridge monitoring (no heartbeat for ${minutes}m, likely after a Flywheel restart) but its tmux session is still alive and working. Please keep an eye on it and drive it directly via tmux if needed.`,
			session_role: session.session_role ?? "main",
		};
		await this.deliverHook(session, hookPayload);
	}

	/**
	 * FLY-623: readopt-ON happy path. The Bridge re-adopted a live detached Runner
	 * after a restart. Stamp the Display-A "⚠️重连中" title (founder signal) and
	 * deliver a one-time, low-priority, NON-retryable FYI to the Lead. Best-effort:
	 * `session_monitoring_reestablished` is not in GUARDRAIL/RETRYABLE sets, so
	 * deliverHook marks it delivered regardless and it is never re-delivered.
	 */
	async onSessionMonitoringReestablished(
		session: Session,
		minutes: number,
		details?: { stampReconnectTitle?: boolean },
	): Promise<void> {
		const label = session.issue_identifier ?? session.issue_id;
		const hookPayload: HookPayload = {
			event_type: "session_monitoring_reestablished",
			execution_id: session.execution_id,
			issue_id: session.issue_id,
			issue_identifier: session.issue_identifier,
			issue_title: session.issue_title,
			project_name: session.project_name,
			status: session.status,
			minutes_since_activity: minutes,
			notification_context: `Runner ${label} was re-adopted after a Flywheel restart — monitoring re-established via tmux (heartbeat had been stale ${minutes}m). It is alive and being watched again; no action needed.`,
			session_role: session.session_role ?? "main",
		};
		// Display-A: stamp the ⚠️重连中 marker (fire-and-forget, best-effort).
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

		const withWord = process.env.FLYWHEEL_ISSUE_STATUS_WORD !== "0";
		const ctx: ChatThreadContext = {
			chatChannelId: chatChannel,
			issueId: session.issue_id,
			issueIdentifier: session.issue_identifier,
			issueTitle: session.issue_title,
			botToken,
			leadId,
			// FLY-728 Part D: the reconnect stamp has the session — keep the model
			// code authoritative (`?? null` clears on account-default) so a reconnect
			// rename never keeps a stale code (Codex code R1).
			modelCode: modelShortCode(session.runner_model) ?? null,
		};

		let badge: string | null;
		if (mode === "enter") {
			badge = reconnectingBadge(withWord);
		} else if (session.status === "completed") {
			badge = stageBadge("completed", withWord) ?? null;
		} else if (session.status === "running" && session.session_stage) {
			// Cleared while still running (e.g. a stage_changed proved the channel
			// live) → restore the current real stage badge.
			badge = stageBadge(session.session_stage, withWord) ?? null;
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

	/**
	 * FLY-25: Retry undelivered guardrail events from previous cycles.
	 * Called by HeartbeatService.retryUndelivered() each heartbeat cycle.
	 */
	async retryUndeliveredGuardrailEvents(): Promise<void> {
		// Collect unique leadIds from all projects
		const leadIds = new Set<string>();
		for (const project of this.projects) {
			for (const lead of project.leads) {
				leadIds.add(lead.agentId);
			}
		}

		const eventTypes = [...RETRYABLE_LEAD_EVENT_TYPES];
		for (const leadId of leadIds) {
			const undelivered = this.store.getUndeliveredGuardrailEvents(
				leadId,
				eventTypes,
				RegistryHeartbeatNotifier.MAX_DELIVERY_ATTEMPTS,
			);
			for (const row of undelivered) {
				try {
					const runtime = this.registry.getForLead(leadId);
					if (!runtime) continue;
					const envelope: LeadEventEnvelope = {
						seq: row.seq,
						event: JSON.parse(row.payload),
						sessionKey: row.session_key ?? "",
						leadId: row.lead_id,
						timestamp: new Date().toISOString(),
					};
					const result = await runtime.deliver(envelope);
					if (result.delivered) {
						this.store.markLeadEventDelivered(row.seq);
					} else {
						this.store.recordDeliveryFailure(
							row.seq,
							result.error ?? "unknown",
						);
					}
				} catch (err) {
					this.store.recordDeliveryFailure(row.seq, (err as Error).message);
				}
			}
		}
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
			// FLY-637 R1 #2: NOT persisted (no lead_events row appended) → false so
			// checkStuck does not durably dedup a wake that never happened.
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
		const eventId = `heartbeat-${session.execution_id}-${Date.now()}`;
		const seq = this.store.appendLeadEvent(
			agentId,
			eventId,
			hookPayload.event_type,
			JSON.stringify(hookPayload),
			sessionKey,
		);
		const envelope: LeadEventEnvelope = {
			seq,
			event: hookPayload,
			sessionKey,
			leadId: agentId,
			timestamp: new Date().toISOString(),
		};

		const isGuardrail = GUARDRAIL_EVENT_TYPES.has(hookPayload.event_type);
		const result = await runtime.deliver(envelope);

		if (result.delivered) {
			this.store.markLeadEventDelivered(seq);
		} else if (isGuardrail) {
			// Guardrail event failed — record failure for retry next cycle
			this.store.recordDeliveryFailure(seq, result.error ?? "unknown");
		} else {
			// Advisory event — best-effort, mark delivered anyway
			this.store.markLeadEventDelivered(seq);
		}
		// FLY-637 R1 #2: the event row IS in lead_events (guardrail retry owns
		// redelivery), so this counts as persisted regardless of the immediate
		// transport outcome.
		return true;
	}
}
