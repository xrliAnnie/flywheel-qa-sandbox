import { randomUUID } from "node:crypto";
import {
	type ApplyTransitionOpts,
	applyTransition,
} from "./applyTransition.js";
import { resolveChatThreadId } from "./bridge/chat-thread-utils.js";
import {
	applyQuarantineFallback,
	type MarkerReconcilerDeps,
	tryReconcileComplete,
} from "./bridge/complete-marker-reconciler.js";
import type { EventFilter } from "./bridge/EventFilter.js";
import { buildSessionKey, type HookPayload } from "./bridge/hook-payload.js";
import {
	GUARDRAIL_EVENT_TYPES,
	type LeadEventEnvelope,
	RETRYABLE_LEAD_EVENT_TYPES,
} from "./bridge/lead-runtime.js";
import type { RuntimeRegistry } from "./bridge/runtime-registry.js";
import {
	getTmuxTargetFromCommDb,
	isTmuxWindowAlive,
} from "./bridge/tmux-lookup.js";
import type { ProjectEntry } from "./ProjectConfig.js";
import type { Session, StateStore } from "./StateStore.js";

export interface HeartbeatNotifier {
	onSessionStuck(session: Session, minutesSinceActivity: number): Promise<void>;
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
	 */
	onSessionMonitoringLost(
		session: Session,
		minutesSinceHeartbeat: number,
	): Promise<void>;
}

/**
 * FLY-523: notify the founder DIRECTLY (her alert channel / DM) when a run is
 * founder-gate-pending — implemented + code-review-passed and sitting in
 * `awaiting_review` waiting for her to approve the ship. This is the mechanism
 * that replaces "the Lead has to remember to relay" (the FLY-163 gap that left
 * finished work silently waiting). The production implementation
 * (`FounderGatePendingNotifier`) routes via `LeadAlertNotifier`, so delivery
 * reliability + dedup (claims.db + lead_events + queue/dead-letter) are reused;
 * dedup is keyed on the per-review-window `awaiting_review_entered_at`, so a
 * re-review naturally re-notifies. When no notifier is wired the check is a
 * no-op (byte-compat / opt-out via `FLYWHEEL_FOUNDER_GATE_NOTIFY=0`).
 */
export interface FounderGateNotifier {
	notifyGatePending(session: Session): Promise<void>;
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
export class HeartbeatService {
	private timer: NodeJS.Timeout | null = null;
	private notifiedStuck = new Set<string>();
	private notifiedOrphans = new Set<string>();
	private notifiedStale = new Set<string>();
	private lastStaleCheckAt = 0;
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
	 * FLY-523: optional founder-gate-pending notifier. Injected post-construction
	 * (the LeadAlertNotifier it wraps is built after HeartbeatService in plugin.ts)
	 * via `setFounderGateNotifier`. Absent → `checkFounderGatePending` is a no-op.
	 */
	private founderGateNotifier?: FounderGateNotifier;

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
	) {}

	/**
	 * FLY-523: wire the founder-gate-pending notifier. Safe to call after
	 * `start()` — the periodic `checkFounderGatePending` no-ops until it is set.
	 */
	setFounderGateNotifier(notifier: FounderGateNotifier): void {
		this.founderGateNotifier = notifier;
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
		await this.checkStuck();
		await this.reapOrphans();
		await this.checkStaleCompleted();
		await this.checkAwaitingReviewTimeout();
		await this.checkFounderGatePending();
	}

	/**
	 * FLY-523: founder-gate-pending auto-notify. Every cycle, find runs sitting in
	 * `awaiting_review` (founder-gate-pending: implemented + code-review-passed,
	 * waiting for the founder to approve the ship) and proactively notify the
	 * founder via the injected notifier — so finished work never sits silently
	 * waiting on the Lead to remember to relay it (FLY-163 gap). Reuses the
	 * existing heartbeat timer (no new periodic load — FLY-169/172 norm).
	 *
	 * Dedup + delivery reliability live in the notifier (LeadAlertNotifier:
	 * claims.db + lead_events + queue/dead-letter), keyed on the per-window
	 * `awaiting_review_entered_at`, so it fires once per review window and a
	 * re-review re-notifies. Absent a notifier (opt-out / legacy / tests) this is
	 * a no-op — and we don't even consult the store, so there is zero added cost.
	 */
	async checkFounderGatePending(): Promise<void> {
		if (!this.founderGateNotifier) return;
		const pending = this.store.getAwaitingReviewSessions();
		for (const session of pending) {
			try {
				await this.founderGateNotifier.notifyGatePending(session);
			} catch (err) {
				console.error(
					`[HeartbeatService] founder-gate notify failed for ${session.execution_id}: ${(err as Error).message}`,
				);
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
	 * FLY-172: For running sessions whose heartbeat has gone stale (≥ stuck
	 * threshold — i.e. the Bridge stopped receiving heartbeats, the fingerprint
	 * of monitoring loss after a restart): try the completion marker FIRST (a
	 * valid terminal marker wins over tmux liveness — a finished `needs_review`
	 * Runner can keep its tmux window open), and only if there is no usable
	 * marker, probe tmux. tmux alive → one-time advisory, never force-fail.
	 * tmux dead → leave it for `reapOrphans` to force-fail at the orphan
	 * threshold. Owns `notifiedMonitorLost` and `markerRetryPending`.
	 */
	async reconcileMonitorLoss(): Promise<void> {
		this.markerRetryPending.clear();
		if (!this.monitorReconcile) return; // not wired (e.g. unit tests) → no-op

		// Candidate set: running + heartbeat stale ≥ stuck threshold.
		const candidates = this.store.getOrphanSessions(this.thresholdMinutes);
		const candidateIds = new Set(candidates.map((s) => s.execution_id));
		// Prune monitor-lost advisory dedup for sessions no longer candidates
		// (e.g. they completed and left `running`).
		for (const id of this.notifiedMonitorLost) {
			if (!candidateIds.has(id)) this.notifiedMonitorLost.delete(id);
		}

		const deps: MarkerReconcilerDeps = {
			store: this.store,
			bridgeBaseUrl: this.monitorReconcile.bridgeBaseUrl,
			ingestToken: this.monitorReconcile.ingestToken,
			fetchFn: this.monitorReconcile.fetchFn,
			markerDir: this.monitorReconcile.markerDir,
			quarantineDir: this.monitorReconcile.quarantineDir,
		};

		for (const session of candidates) {
			const execId = session.execution_id;

			// 1) Marker-first. A valid terminal marker proves the Runner finished.
			const outcome = await tryReconcileComplete(execId, deps);
			if (
				outcome.kind === "reconciled" ||
				outcome.kind === "duplicate_terminal"
			) {
				// Session is now at its true terminal status. No longer monitor-lost.
				this.notifiedMonitorLost.delete(execId);
				continue;
			}
			if (outcome.kind === "transient_failed") {
				// Keep marker; block reapOrphans from force-failing this cycle.
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
					// CODEX R1 HIGH FIX: marker was moved to quarantine, so reapOrphans
					// can no longer see it. The Runner is STILL alive — if we don't
					// protect it here, reapOrphans would force-fail a live Runner once
					// past the orphan threshold (re-triggering GEO-374). Treat it as
					// monitoring-lost: one-time advisory + add to the skip set.
					await this.emitMonitorLostOnce(session);
				} else {
					// tmux dead → applyQuarantineFallback already forced a terminal
					// status; drop any prior monitor-lost dedup.
					this.notifiedMonitorLost.delete(execId);
				}
				continue;
			}

			// 2) No marker (absent) → probe tmux.
			const alive = await this.isSessionTmuxAlive(session);
			if (alive) {
				// Runner still working, Bridge blind. One-time advisory; do NOT
				// force-fail and do NOT refresh heartbeat_at (keeps the session
				// orphan-eligible so the very next cycle re-verifies liveness).
				await this.emitMonitorLostOnce(session);
			} else {
				// tmux gone, no marker → genuine orphan; let reapOrphans force-fail
				// it at the orphan threshold. Drop any prior monitor-lost dedup.
				this.notifiedMonitorLost.delete(execId);
			}
		}
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

	/** FLY-172: resolve + probe tmux for a session. Single owner of liveness. */
	private async isSessionTmuxAlive(session: Session): Promise<boolean> {
		if (!session.project_name) return false;
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

	private async checkStuck(): Promise<void> {
		const stuck = this.store.getStuckSessions(this.thresholdMinutes);

		// Prune notified set: remove entries for sessions no longer stuck
		const stuckIds = new Set(stuck.map((s) => s.execution_id));
		for (const id of this.notifiedStuck) {
			if (!stuckIds.has(id)) this.notifiedStuck.delete(id);
		}

		for (const session of stuck) {
			// FLY-172: a monitoring-lost (alive-but-detached) Runner looks "stuck"
			// (last_activity stale) only because the Bridge lost its reporting
			// channel — suppress the false session_stuck. The reconcile pass that
			// just ran owns this set and removes dead sessions, so this never
			// over-suppresses a Runner that later died.
			if (this.notifiedMonitorLost.has(session.execution_id)) continue;
			if (this.notifiedStuck.has(session.execution_id)) continue;

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
				await this.notifier.onSessionStuck(session, minutesSince);
				this.notifiedStuck.add(session.execution_id);
			} catch {
				// Notification failed — don't dedup so it's retried next cycle
			}
		}
	}

	/** GEO-270: Check for completed/failed/blocked sessions with tmux still alive. */
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

		for (const session of stale) {
			if (this.notifiedStale.has(session.execution_id)) continue;
			if (!session.project_name) continue;

			try {
				const target = getTmuxTargetFromCommDb(
					session.execution_id,
					session.project_name,
				);
				if (!target) continue;

				const alive = await isTmuxWindowAlive(target.tmuxWindow);
				if (!alive) continue;

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

	/** Reap orphan sessions: heartbeat has gone stale beyond orphanThresholdMinutes. */
	async reapOrphans(): Promise<void> {
		const orphans = this.store.getOrphanSessions(this.orphanThresholdMinutes);

		// Prune notified set: remove entries for sessions no longer orphaned
		const orphanIds = new Set(orphans.map((s) => s.execution_id));
		for (const id of this.notifiedOrphans) {
			if (!orphanIds.has(id)) this.notifiedOrphans.delete(id);
		}

		for (const session of orphans) {
			// FLY-172: skip sessions the reconcile pass classified this cycle as
			// alive-but-detached (monitor-lost) or as having a marker pending
			// retry. reapOrphans does NOT probe tmux itself — the reconcile pass
			// is the single owner of liveness (Codex guidance #1). When neither
			// set contains the session, it is a genuine orphan (tmux gone / no
			// usable marker) and the existing force-fail behavior applies.
			if (this.notifiedMonitorLost.has(session.execution_id)) continue;
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
	) {}

	async onSessionStuck(session: Session, minutes: number): Promise<void> {
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
		await this.deliverHook(session, hookPayload);
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
	): Promise<void> {
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
			return;
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
	}
}
