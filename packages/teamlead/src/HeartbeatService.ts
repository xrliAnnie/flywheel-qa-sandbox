import {
	type ApplyTransitionOpts,
	applyTransition,
} from "./applyTransition.js";
import type { EventFilter } from "./bridge/EventFilter.js";
import { buildSessionKey, type HookPayload } from "./bridge/hook-payload.js";
import {
	GUARDRAIL_EVENT_TYPES,
	type LeadEventEnvelope,
} from "./bridge/lead-runtime.js";
import type { RuntimeRegistry } from "./bridge/runtime-registry.js";
import {
	getTmuxTargetFromCommDb,
	isTmuxSessionAlive,
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

	constructor(
		private store: StateStore,
		private notifier: HeartbeatNotifier,
		private thresholdMinutes: number,
		private intervalMs: number,
		private orphanThresholdMinutes: number,
		private transitionOpts?: ApplyTransitionOpts,
		private staleThresholdHours: number = 24,
		private staleCheckIntervalMs: number = 6 * 3_600_000,
	) {}

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
		await this.checkStuck();
		await this.reapOrphans();
		await this.checkStaleCompleted();
	}

	private async checkStuck(): Promise<void> {
		const stuck = this.store.getStuckSessions(this.thresholdMinutes);

		// Prune notified set: remove entries for sessions no longer stuck
		const stuckIds = new Set(stuck.map((s) => s.execution_id));
		for (const id of this.notifiedStuck) {
			if (!stuckIds.has(id)) this.notifiedStuck.delete(id);
		}

		for (const session of stuck) {
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

				const alive = await isTmuxSessionAlive(target.sessionName);
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
			thread_id: session.thread_id,
			minutes_since_activity: minutes,
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
			thread_id: session.thread_id,
			minutes_since_activity: minutes,
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
			thread_id: session.thread_id,
			notification_context: `Session ${session.status} ${hours}h ago but tmux still alive. Please check if it can be closed.`,
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

		const eventTypes = [...GUARDRAIL_EVENT_TYPES];
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
		let forumChannel: string | undefined;
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
			const existingThread = this.store.getThreadByIssue(session.issue_id);
			forumChannel = existingThread?.channel ?? resolved.lead.forumChannel;
			chatChannel = resolved.lead.chatChannel;
		} catch {
			console.warn(
				`[heartbeat-notify] Cannot resolve runtime for "${session.project_name}" — skipping notification`,
			);
			return;
		}

		hookPayload.forum_channel = forumChannel;
		hookPayload.chat_channel = chatChannel;

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
