import type { StateStore, Session } from "./StateStore.js";
import { buildSessionKey, buildHookBody, type HookPayload } from "./bridge/hook-payload.js";

export interface HeartbeatNotifier {
	onSessionStuck(session: Session, minutesSinceActivity: number): Promise<void>;
	onSessionOrphaned(session: Session, minutesSinceHeartbeat: number): Promise<void>;
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
				const lastActivity = new Date(session.last_activity_at.replace(" ", "T") + "Z");
				minutesSince = Math.round((Date.now() - lastActivity.getTime()) / 60_000);
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
				const lastHeartbeat = new Date(session.heartbeat_at.replace(" ", "T") + "Z");
				minutesSince = Math.round((Date.now() - lastHeartbeat.getTime()) / 60_000);
			}

			try {
				// Force-fail the orphaned session
				const now = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
				this.store.forceStatus(
					session.execution_id,
					"failed",
					now,
					`Orphaned: no heartbeat for ${minutesSince} minutes`,
				);

				await this.notifier.onSessionOrphaned(session, minutesSince);
				this.notifiedOrphans.add(session.execution_id);
			} catch {
				// Notification failed — don't dedup so it's retried next cycle
			}
		}
	}
}

/**
 * Webhook-based heartbeat notifier — pushes notifications to OpenClaw gateway via HTTP.
 * Handles both stuck and orphaned session events.
 */
export class WebhookHeartbeatNotifier implements HeartbeatNotifier {
	constructor(
		private gatewayUrl: string,
		private hooksToken: string,
	) {}

	async onSessionStuck(session: Session, minutes: number): Promise<void> {
		const sessionKey = buildSessionKey(session);
		const hookPayload: HookPayload = {
			event_type: "session_stuck",
			execution_id: session.execution_id,
			issue_id: session.issue_id,
			issue_identifier: session.issue_identifier,
			issue_title: session.issue_title,
			project_name: session.project_name,
			status: session.status,
			thread_ts: session.slack_thread_ts,
			channel: "CD5QZVAP6",
			minutes_since_activity: minutes,
		};
		await this.sendHook(hookPayload, sessionKey);
	}

	async onSessionOrphaned(session: Session, minutes: number): Promise<void> {
		const sessionKey = buildSessionKey(session);
		const hookPayload: HookPayload = {
			event_type: "session_orphaned",
			execution_id: session.execution_id,
			issue_id: session.issue_id,
			issue_identifier: session.issue_identifier,
			issue_title: session.issue_title,
			project_name: session.project_name,
			status: "failed", // Already force-failed before notification
			thread_ts: session.slack_thread_ts,
			channel: "CD5QZVAP6",
			minutes_since_activity: minutes,
		};
		await this.sendHook(hookPayload, sessionKey);
	}

	private async sendHook(hookPayload: HookPayload, sessionKey: string): Promise<void> {
		const body = buildHookBody("product-lead", hookPayload, sessionKey);

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 3000);
		try {
			const res = await fetch(`${this.gatewayUrl}/hooks/ingest`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.hooksToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			if (!res.ok) {
				throw new Error(`Gateway returned ${res.status}`);
			}
		} catch (err) {
			console.warn(`[heartbeat-notify] Failed:`, (err as Error).message);
			throw err; // Let HeartbeatService skip dedup so notification is retried
		} finally {
			clearTimeout(timeout);
		}
	}
}
