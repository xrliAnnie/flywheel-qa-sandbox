import {
	type ApplyTransitionOpts,
	applyTransition,
} from "./applyTransition.js";
import type { EventFilter } from "./bridge/EventFilter.js";
import {
	buildSessionKey,
	type HookPayload,
} from "./bridge/hook-payload.js";
import type { LeadEventEnvelope } from "./bridge/lead-runtime.js";
import type { RuntimeRegistry } from "./bridge/runtime-registry.js";
import { type ProjectEntry, resolveLeadForIssue } from "./ProjectConfig.js";
import type { Session, StateStore } from "./StateStore.js";

export interface HeartbeatNotifier {
	onSessionStuck(session: Session, minutesSinceActivity: number): Promise<void>;
	onSessionOrphaned(
		session: Session,
		minutesSinceHeartbeat: number,
	): Promise<void>;
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

	constructor(
		private store: StateStore,
		private notifier: HeartbeatNotifier,
		private thresholdMinutes: number,
		private intervalMs: number,
		private orphanThresholdMinutes: number,
		private transitionOpts?: ApplyTransitionOpts,
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
		await this.checkStuck();
		await this.reapOrphans();
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
 * GEO-195: Registry-based heartbeat notifier — delivers via RuntimeRegistry.
 * Must throw on failure so HeartbeatService skips dedup and retries next cycle.
 */
export class RegistryHeartbeatNotifier implements HeartbeatNotifier {
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

	private async deliverHook(
		session: Session,
		hookPayload: HookPayload,
	): Promise<void> {
		let agentId: string;
		let forumChannel: string;
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

		// EventFilter: classify and potentially skip (GEO-187)
		if (this.eventFilter) {
			const filterResult = this.eventFilter.classify(
				hookPayload.event_type,
				hookPayload,
			);
			if (filterResult.action !== "notify_agent") {
				return;
			}
			hookPayload.filter_priority = filterResult.priority;
			hookPayload.notification_context = filterResult.reason;
		}

		const sessionKey = buildSessionKey(session);
		const envelope: LeadEventEnvelope = {
			seq: 0,
			event: hookPayload,
			sessionKey,
			leadId: agentId,
			timestamp: new Date().toISOString(),
		};
		// Must throw on failure so HeartbeatService skips dedup and retries next cycle.
		await runtime.deliver(envelope);
	}
}
