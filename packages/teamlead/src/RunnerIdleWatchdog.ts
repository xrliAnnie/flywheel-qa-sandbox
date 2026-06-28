/**
 * FLY-92: Runner Idle Watchdog — system-level idle detection.
 *
 * Periodically polls active "running" sessions via createStatusQuery(),
 * detects when a Runner is stuck (waiting/idle/unknown), and emits
 * runner_idle_detected Lead events via the existing guardrail pipeline.
 *
 * Design: external observation via tmux capture-pane, NOT prompt patches.
 * Reference: Claude Code Agent Team idle detection (inProcessRunner.ts, teammateInit.ts).
 */

import { resolveChatThreadId } from "./bridge/chat-thread-utils.js";
import type { HookPayload } from "./bridge/hook-payload.js";
import type { LeadEventEnvelope } from "./bridge/lead-runtime.js";
import { parseSessionLabels } from "./bridge/lead-scope.js";
import { classifyQuiet, type QuietSignals } from "./bridge/quiet-classifier.js";
import { createStatusQuery } from "./bridge/runner-status.js";
import type { RuntimeRegistry } from "./bridge/runtime-registry.js";
import type {
	CaptureOutcome,
	StuckRunnerDetector,
} from "./bridge/stuck-runner-detector.js";
import type { CaptureSessionFn } from "./bridge/tools.js";
import type { LeadConfig, ProjectEntry } from "./ProjectConfig.js";
import { resolveLeadForIssue } from "./ProjectConfig.js";
import type { Session, StateStore } from "./StateStore.js";

export interface IdleWatchdogConfig {
	pollIntervalMs: number;
	waitingThresholdCycles: number;
	projects: ProjectEntry[];
	store: StateStore;
	runtimeRegistry: RuntimeRegistry;
	captureSessionFn: CaptureSessionFn;
	/** FLY-91: Enable per-issue chat thread hints in idle event payloads. */
	chatThreadsEnabled?: boolean;
	/**
	 * FLY-195: optional stuck-runner detector, driven from THIS poll (FLY-169:
	 * no new periodic timers) and fed this watchdog's own capture (one tmux
	 * capture-pane per session per poll). Independent state from the idle
	 * dedup machinery (Codex R1 LOW-8) — the 90s runner_idle_detected cadence
	 * is unchanged.
	 */
	stuckDetector?: StuckRunnerDetector | null;
	/**
	 * FLY-626: cheap, stateless quiet-signal probe consulted BEFORE a (token-
	 * expensive) Lead wake. When it classifies the session as legitimately quiet
	 * (self_parked / self_long_task / pending_gate / recent_comm / review /
	 * parked_review_status), `runner_idle_detected` is suppressed. Absent ⇒ no
	 * suppression (byte-compat — pre-FLY-626 behavior). Injected for tests.
	 */
	quietSignalsProbe?: (session: Session) => QuietSignals;
	/**
	 * FLY-623: read-only predicate — true while a Runner is RE-ADOPTED after a
	 * Bridge restart (detached but tmux-alive; owned by HeartbeatService). Such a
	 * Runner's idle/stuck signals are an artifact of monitoring loss, not a real
	 * stall (the in-process poll loop died with the previous Bridge), so we skip
	 * both idle notification and stuck-detector episode advancement while true and
	 * resume normal detection once it clears. Wired via the late-bound holder in
	 * plugin.ts; absent (tests/legacy) → no suppression (current behavior).
	 */
	isReconnecting?: (executionId: string) => boolean;
}

type IdleStatus = "waiting" | "idle" | "unknown";

interface SessionIdleState {
	lastStatus: string;
	waitingCycleCount: number;
	notifiedForStatus: IdleStatus | null;
	transitionCounter: number;
}

export class RunnerIdleWatchdog {
	private stateMap = new Map<string, SessionIdleState>();
	private timerHandle: ReturnType<typeof setInterval> | null = null;
	private polling = false;
	private statusQuery: ReturnType<typeof createStatusQuery>;

	constructor(private config: IdleWatchdogConfig) {
		this.statusQuery = createStatusQuery(config.captureSessionFn);
	}

	start(): void {
		if (this.timerHandle) return;
		this.timerHandle = setInterval(
			() => this.poll(),
			this.config.pollIntervalMs,
		);
	}

	stop(): void {
		if (this.timerHandle) {
			clearInterval(this.timerHandle);
			this.timerHandle = null;
		}
		this.statusQuery.stopEviction();
	}

	/** Exposed for testing — runs one poll cycle. */
	async pollOnce(): Promise<void> {
		return this.poll();
	}

	private async poll(): Promise<void> {
		if (this.polling) return;
		this.polling = true;
		try {
			const sessions = this.config.store
				.getActiveSessions()
				.filter((s) => s.status === "running");

			// Evict stale entries for sessions no longer active
			const activeIds = new Set(sessions.map((s) => s.execution_id));
			for (const key of this.stateMap.keys()) {
				if (!activeIds.has(key)) this.stateMap.delete(key);
			}
			// FLY-195: stuck episodes for gone executions are dropped the same way.
			this.config.stuckDetector?.pruneInactive(activeIds);

			for (const session of sessions) {
				await this.checkSession(session);
			}
		} finally {
			this.polling = false;
		}
	}

	private async checkSession(session: Session): Promise<void> {
		// FLY-623: a Runner re-adopted after a Bridge restart is alive-but-detached;
		// its idle/stuck signals are an artifact of monitoring loss, not a real
		// stall. Skip BOTH idle notification and stuck-detector episode advancement
		// while reconnecting (resumes once HeartbeatService clears the state).
		if (this.config.isReconnecting?.(session.execution_id)) {
			return;
		}
		try {
			const { result, captureErrorStatus, output } =
				await this.statusQuery.query(
					session.execution_id,
					session.project_name,
				);

			// FLY-195: drive the stuck detector off this SAME capture. Any capture
			// problem (infra error or tmux-unreachable "unknown") is handed over as
			// { ok: false } so the detector fails closed (skips without touching
			// the episode clock).
			if (this.config.stuckDetector) {
				const outcome: CaptureOutcome =
					captureErrorStatus === undefined && output !== undefined
						? { ok: true, output }
						: { ok: false, error: result.reason };
				try {
					await this.config.stuckDetector.checkSession(session, outcome);
				} catch (err) {
					console.warn(
						`[IdleWatchdog] stuck check error for ${session.execution_id}:`,
						err instanceof Error ? err.message : String(err),
					);
				}
			}

			// Skip idle notification for infra errors (400/404/CommDB 502).
			// Only tmux-unreachable (no captureErrorStatus) is a valid idle signal.
			if (captureErrorStatus) {
				// Reset dedup state so infra errors break the "consecutive waiting" streak.
				// Clear both count and notifiedForStatus so a new waiting episode after
				// infra recovery triggers a fresh alert.
				const infraState = this.stateMap.get(session.execution_id);
				if (infraState) {
					infraState.waitingCycleCount = 0;
					infraState.notifiedForStatus = null;
				}
				console.warn(
					`[IdleWatchdog] Infra error for ${session.execution_id} (HTTP ${captureErrorStatus}): ${result.reason} — skipping`,
				);
				return;
			}

			const state = this.stateMap.get(session.execution_id) ?? {
				lastStatus: "executing",
				waitingCycleCount: 0,
				notifiedForStatus: null,
				transitionCounter: 0,
			};

			state.lastStatus = result.status;

			// FLY-626: before any (token-expensive) Lead wake, consult the cheap
			// quiet classifier. A legitimately-quiet runner (self-declared
			// park/busy, parked at a gate, recently active, gray-zone review) is
			// suppressed; only `quiet_unexplained` (or no probe wired = byte-compat)
			// may wake. Advisory-only path — orphan/force-fail liveness is untouched.
			const quietSuppressed =
				result.status !== "executing" && this.isWakeSuppressed(session);

			if (result.status === "executing") {
				// Active — clear dedup state; transitionCounter uses Date.now() on next idle
				state.waitingCycleCount = 0;
				state.notifiedForStatus = null;
			} else if (result.status === "waiting") {
				state.waitingCycleCount++;
				if (
					state.waitingCycleCount >= this.config.waitingThresholdCycles &&
					state.notifiedForStatus !== "waiting" &&
					!quietSuppressed
				) {
					state.transitionCounter = Date.now();
					const persisted = await this.emitIdleEvent(
						session,
						"waiting",
						result.reason,
						state.transitionCounter,
					);
					if (persisted) state.notifiedForStatus = "waiting";
				}
			} else {
				// "idle" or "unknown" — immediate trigger; break waiting streak
				state.waitingCycleCount = 0;
				const idleStatus = result.status as IdleStatus;
				if (state.notifiedForStatus !== idleStatus && !quietSuppressed) {
					state.transitionCounter = Date.now();
					const persisted = await this.emitIdleEvent(
						session,
						idleStatus,
						result.reason,
						state.transitionCounter,
					);
					if (persisted) state.notifiedForStatus = idleStatus;
				}
			}

			this.stateMap.set(session.execution_id, state);
		} catch (err) {
			console.warn(
				`[IdleWatchdog] Error checking ${session.execution_id}:`,
				err instanceof Error ? err.message : String(err),
			);
		}
	}

	/**
	 * FLY-626: true when a cheap quiet-signal probe classifies the session as
	 * legitimately quiet (not `quiet_unexplained`), so the idle wake must be
	 * suppressed. No probe wired ⇒ false (byte-compat). A probe error fails
	 * OPEN (returns false → the wake still fires) so a transient comm.db read
	 * problem can never silently hide a genuinely stuck runner (FLY-369).
	 */
	private isWakeSuppressed(session: Session): boolean {
		if (!this.config.quietSignalsProbe) return false;
		try {
			const result = classifyQuiet(this.config.quietSignalsProbe(session));
			if (!result.mayWake) {
				console.log(
					`[IdleWatchdog] FLY-626 suppressed idle wake for ${session.execution_id} (${result.verdict})`,
				);
				return true;
			}
			return false;
		} catch (err) {
			console.warn(
				`[IdleWatchdog] FLY-626 quiet probe failed for ${session.execution_id} (fail-open, wake allowed):`,
				err instanceof Error ? err.message : String(err),
			);
			return false;
		}
	}

	/**
	 * Emit a runner_idle_detected Lead event.
	 * Returns true if the event was persisted (delivery will be retried by guardrail if needed).
	 */
	private async emitIdleEvent(
		session: Session,
		detectedStatus: IdleStatus,
		reason: string,
		transitionCounter: number,
	): Promise<boolean> {
		const labels = parseSessionLabels(session);
		let lead: LeadConfig;
		try {
			({ lead } = resolveLeadForIssue(
				this.config.projects,
				session.project_name,
				labels,
			));
		} catch {
			return false;
		}

		// Transition-scoped eventId: transitionCounter uses Date.now() for cross-restart
		// uniqueness — timestamps always move forward, avoiding post-restart collisions.
		const eventId = `idle_${session.execution_id}_${detectedStatus}_${transitionCounter}`;
		if (this.config.store.isLeadEventDelivered(lead.agentId, eventId))
			return true;

		const payload: HookPayload = {
			event_type: "runner_idle_detected",
			execution_id: session.execution_id,
			issue_id: session.issue_id,
			issue_identifier: session.issue_identifier,
			project_name: session.project_name,
			status: detectedStatus,
			summary: reason,
			session_role: session.session_role ?? "main",
		};

		// FLY-91: Fill chat_thread_id for Lead thread routing
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
			"runner_idle_detected",
			JSON.stringify(payload),
			session.execution_id,
		);

		// Event is now persisted — even if delivery fails here,
		// retryUndeliveredGuardrailEvents() will pick it up next heartbeat cycle.
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

		console.log(
			`[IdleWatchdog] Emitted runner_idle_detected for ${session.execution_id} (${detectedStatus}: ${reason})`,
		);
		return true;
	}
}
