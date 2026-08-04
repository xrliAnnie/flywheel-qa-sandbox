/**
 * FLY-92: Runner Idle Watchdog — system-level idle detection.
 *
 * Periodically polls active "running" sessions via createStatusQuery(),
 * detects when a Runner process has exited to an idle shell, and emits
 * runner_idle_detected Lead events via the existing guardrail pipeline.
 *
 * Design: external observation via tmux capture-pane, NOT prompt patches.
 * Reference: Claude Code Agent Team idle detection (inProcessRunner.ts, teammateInit.ts).
 */

import { resolveChatThreadId } from "./bridge/chat-thread-utils.js";
import type { HookPayload } from "./bridge/hook-payload.js";
import type { LeadEventEnvelope } from "./bridge/lead-runtime.js";
import { parseSessionLabels } from "./bridge/lead-scope.js";
import {
	classifyQuiet,
	type QuietSignals,
	quietFingerprint,
} from "./bridge/quiet-classifier.js";
import { createStatusQuery } from "./bridge/runner-status.js";
import {
	dispatchLeadEventCompat,
	type RuntimeRegistry,
} from "./bridge/runtime-registry.js";
import type { CaptureSessionFn } from "./bridge/tools.js";
import type { LeadConfig, ProjectEntry } from "./ProjectConfig.js";
import { resolveLeadForIssue } from "./ProjectConfig.js";
import type { Session, StateStore } from "./StateStore.js";

/** Preserve the pre-FLY-1393 expensive runner quota/auth scan cadence. */
export const DEFAULT_RUNNER_QUOTA_SCAN_INTERVAL_MS = 60 * 60_000;

export interface IdleWatchdogConfig {
	pollIntervalMs: number;
	projects: ProjectEntry[];
	store: StateStore;
	runtimeRegistry: RuntimeRegistry;
	captureSessionFn: CaptureSessionFn;
	/** FLY-91: Enable per-issue chat thread hints in idle event payloads. */
	chatThreadsEnabled?: boolean;
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
	/**
	 * FLY-696 M1/③: optional runner-side quota scan, driven from THIS poll's
	 * capture (FLY-169: no new timer). Given a valid runner pane it applies the
	 * §3.3 transient 529 short-circuit + the Claude usage-gauge parser; a real
	 * 5h/weekly cap emits a usage_limit alert (with accountLimit metadata + runner
	 * identity) through the shared alert sink → AutoRepairBot enqueue → account
	 * switch. Wired in plugin.ts only when FLYWHEEL_ACCOUNT_SELF_HEAL=1; absent ⇒
	 * no scan (byte-compat). Best-effort — a throwing scan never wedges the poll.
	 * (Edge case per plan §11: under the shared single account the LeadWatchdog
	 * already covers the core cap; this catches a runner capping while every Lead
	 * pane is idle.)
	 */
	runnerQuotaScan?: (session: Session, pane: string) => void | Promise<void>;
	/** Independent cadence for the expensive quota/auth callback. */
	runnerQuotaScanIntervalMs?: number;
	/** Deterministic clock for cadence tests. */
	now?: () => number;
	/** FLY-1393: independent W-1 process-liveness lane (idle only). */
	watchdogLivenessEnabled?: boolean;
	watchdogTracker?: { started(): void; completed(): void };
}

type IdleStatus = "idle";

interface SessionIdleState {
	notifiedForStatus: IdleStatus | null;
	transitionCounter: number;
}

export class RunnerIdleWatchdog {
	private stateMap = new Map<string, SessionIdleState>();
	private timerHandle: ReturnType<typeof setInterval> | null = null;
	private polling = false;
	private statusQuery: ReturnType<typeof createStatusQuery>;
	private lastRunnerQuotaScanAtMs = new Map<string, number>();

	constructor(private config: IdleWatchdogConfig) {
		this.statusQuery = createStatusQuery(config.captureSessionFn);
	}

	start(): void {
		if (this.timerHandle) return;
		// FLY-639: `poll()` already contains its own try/catch, but guard the timer
		// callback too — an async poll() that somehow rejects must NEVER become an
		// unhandled rejection (Node's default would exit the whole Bridge; the
		// production crash-loop). Belt-and-suspenders on top of poll()'s catch.
		this.timerHandle = setInterval(() => {
			void this.poll().catch((err) => {
				console.error(
					"[IdleWatchdog] unexpected poll rejection (contained, Bridge stays up):",
					err instanceof Error ? err.message : String(err),
				);
			});
		}, this.config.pollIntervalMs);
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
		this.config.watchdogTracker?.started();
		try {
			const sessions = this.config.store
				.getActiveSessions()
				.filter((s) => s.status === "running");

			// Evict stale entries for sessions no longer active
			const activeIds = new Set(sessions.map((s) => s.execution_id));
			for (const key of this.stateMap.keys()) {
				if (!activeIds.has(key)) this.stateMap.delete(key);
			}
			for (const key of this.lastRunnerQuotaScanAtMs.keys()) {
				if (!activeIds.has(key)) this.lastRunnerQuotaScanAtMs.delete(key);
			}
			// FLY-637 #4: prune persistent quiet-wake dedup rows for sessions no
			// longer in THIS watchdog's running surface (idle source). Empty set ⇒
			// all idle rows cleared (no `IN ()`); the store handles the guard.
			if (this.quietPersistEnabled()) {
				this.config.store.pruneQuietWakeNotifiedNotIn("idle", [...activeIds]);
			}

			for (const session of sessions) {
				await this.checkSession(session);
			}
		} catch (err) {
			// FLY-639: the proven Bridge crash path. `getActiveSessions()` is the one
			// StateStore touch above the per-session try/catch; a sql.js corruption
			// ("no such table: sessions" / "null function or function signature
			// mismatch") thrown here used to reject this un-awaited poll() →
			// unhandled rejection → Bridge exit 1. Contain it: log, attempt a
			// best-effort StateStore self-heal, and skip this cycle.
			console.warn(
				"[IdleWatchdog] poll error (skipping cycle, Bridge stays up):",
				err instanceof Error ? err.message : String(err),
			);
			// Byte-compat: old mock stores (tests) may lack the method.
			if (typeof this.config.store.recoverFromCorruption === "function") {
				this.config.store.recoverFromCorruption(err);
			}
		} finally {
			this.config.watchdogTracker?.completed();
			this.polling = false;
		}
	}

	private async checkSession(session: Session): Promise<void> {
		// FLY-623: a Runner re-adopted after a Bridge restart is alive-but-detached;
		// its idle signal is an artifact of monitoring loss, not a real process exit.
		if (this.config.isReconnecting?.(session.execution_id)) {
			return;
		}
		try {
			const { result, captureErrorStatus, output } =
				await this.statusQuery.query(
					session.execution_id,
					session.project_name,
				);

			// FLY-696 M1/③: reuse a valid capture for runner-side quota detection,
			// but claim the classifier's independent cadence before invoking it. The
			// 3-second W-1 probe must not multiply token-expensive auth/classifier work.
			// Best-effort — a throwing scan must never break the idle poll.
			if (
				this.config.runnerQuotaScan &&
				captureErrorStatus === undefined &&
				output !== undefined &&
				this.claimRunnerQuotaScan(session.execution_id)
			) {
				try {
					await this.config.runnerQuotaScan(session, output);
				} catch (err) {
					console.warn(
						`[IdleWatchdog] runner quota scan error for ${session.execution_id}:`,
						err instanceof Error ? err.message : String(err),
					);
				}
			}

			// Skip idle notification for infra errors (400/404/CommDB 502).
			// Only tmux-unreachable (no captureErrorStatus) is a valid idle signal.
			if (captureErrorStatus) {
				// Clear the in-memory fallback dedup so an idle shell observed after
				// infrastructure recovery can trigger a fresh liveness event.
				const infraState = this.stateMap.get(session.execution_id);
				if (infraState) {
					infraState.notifiedForStatus = null;
				}
				console.warn(
					`[IdleWatchdog] Infra error for ${session.execution_id} (HTTP ${captureErrorStatus}): ${result.reason} — skipping`,
				);
				return;
			}

			const state = this.stateMap.get(session.execution_id) ?? {
				notifiedForStatus: null,
				transitionCounter: 0,
			};

			if (result.status === "executing") {
				// Active — reset the IN-MEMORY dedup state only. The persistent
				// quiet_wake_notified rows are keyed by the frozen-frame fingerprint
				// and must NOT be cleared here (FLY-637 R1 #1: a raw spinner / ctx%
				// tick reads as `executing`; clearing the row would let the very same
				// frozen frame re-wake the Lead — defeating the fingerprint dedup).
				// transitionCounter uses Date.now() on next idle.
				state.notifiedForStatus = null;
				this.stateMap.set(session.execution_id, state);
				return;
			}
			if (
				this.config.watchdogLivenessEnabled === false ||
				result.status !== "idle"
			)
				return;

			// FLY-626: before any (token-expensive) Lead wake, consult the cheap
			// quiet classifier. A legitimately quiet runner is suppressed; only
			// `quiet_unexplained` (or no probe) may wake.
			if (
				!this.alreadyNotifiedIdle(session, state, output) &&
				!this.isWakeSuppressed(session)
			) {
				state.transitionCounter = Date.now();
				const persisted = await this.emitIdleEvent(
					session,
					"idle",
					result.reason,
					state.transitionCounter,
				);
				if (persisted) this.markNotifiedIdle(session, state, output);
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
	 * FLY-637 #3/#4: persistent quiet-wake dedup is on by default;
	 * `FLYWHEEL_QUIET_PERSIST_DEDUP=0` reverts to the MVP in-memory
	 * (`notifiedForStatus`) dedup — byte-compat. Read per-call so a flip needs
	 * no restart.
	 */
	private quietPersistEnabled(): boolean {
		return process.env.FLYWHEEL_QUIET_PERSIST_DEDUP !== "0";
	}

	/**
	 * FLY-637 #2/#3: has the Lead already been woken about THIS idle episode?
	 * Pane-backed idle statuses dedup on the persistent normalized fingerprint —
	 * so cosmetic jitter and Bridge restarts don't re-wake. The kill-switch falls
	 * back to the in-memory status dedup.
	 */
	private alreadyNotifiedIdle(
		session: Session,
		state: SessionIdleState,
		output: string | undefined,
	): boolean {
		if (this.quietPersistEnabled() && output !== undefined) {
			return this.config.store.hasQuietWakeNotified(
				session.execution_id,
				"idle",
				quietFingerprint(output),
			);
		}
		return state.notifiedForStatus === "idle";
	}

	/** FLY-637: record the dedup after a PERSISTED emit (mirrors {@link alreadyNotifiedIdle}). */
	private markNotifiedIdle(
		session: Session,
		state: SessionIdleState,
		output: string | undefined,
	): void {
		if (this.quietPersistEnabled() && output !== undefined) {
			this.config.store.recordQuietWakeNotified(
				session.execution_id,
				"idle",
				quietFingerprint(output),
			);
		} else {
			state.notifiedForStatus = "idle";
		}
	}

	private claimRunnerQuotaScan(executionId: string): boolean {
		const nowMs = (this.config.now ?? Date.now)();
		const lastAtMs = this.lastRunnerQuotaScanAtMs.get(executionId);
		const intervalMs =
			this.config.runnerQuotaScanIntervalMs ?? this.config.pollIntervalMs;
		if (lastAtMs !== undefined && nowMs - lastAtMs < intervalMs) return false;
		// Claim before invoking the callback so a throwing classifier cannot turn the
		// 3-second W-1 loop into a retry storm.
		this.lastRunnerQuotaScanAtMs.set(executionId, nowMs);
		return true;
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
		// The durable failure remains available for operator inspection.
		const runtime = this.config.runtimeRegistry.getForLead(lead.agentId);
		if (runtime) {
			const envelope: LeadEventEnvelope = {
				seq,
				eventId,
				event: payload,
				sessionKey: session.execution_id,
				leadId: lead.agentId,
				timestamp: new Date().toISOString(),
			};
			const result = await dispatchLeadEventCompat(
				this.config.runtimeRegistry,
				runtime,
				envelope,
			);
			if (result.delivered) {
				this.config.store.markLeadEventDelivered(seq);
			} else if (!(result as { queued?: boolean }).queued) {
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
