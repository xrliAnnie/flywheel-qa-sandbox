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
import { createStatusQuery } from "./bridge/runner-status.js";
import type { RuntimeRegistry } from "./bridge/runtime-registry.js";
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

			for (const session of sessions) {
				await this.checkSession(session);
			}
		} finally {
			this.polling = false;
		}
	}

	private async checkSession(session: Session): Promise<void> {
		try {
			const { result, captureErrorStatus } = await this.statusQuery.query(
				session.execution_id,
				session.project_name,
			);

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

			if (result.status === "executing") {
				// Active — clear dedup state; transitionCounter uses Date.now() on next idle
				state.waitingCycleCount = 0;
				state.notifiedForStatus = null;
			} else if (result.status === "waiting") {
				state.waitingCycleCount++;
				if (
					state.waitingCycleCount >= this.config.waitingThresholdCycles &&
					state.notifiedForStatus !== "waiting"
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
				if (state.notifiedForStatus !== idleStatus) {
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
