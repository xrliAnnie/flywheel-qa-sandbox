import type { StateStore, Session } from "./StateStore.js";
import { buildSessionKey, buildHookBody, type HookPayload } from "./bridge/hook-payload.js";

export interface StuckNotifier {
	onSessionStuck(session: Session, minutesSinceActivity: number): Promise<void>;
}

/**
 * Periodic checker for stuck sessions (running but no activity for N minutes).
 * Sends one notification per execution, deduped in-memory.
 */
export class StuckWatcher {
	private timer: NodeJS.Timeout | null = null;
	private notifiedExecutions = new Set<string>();

	constructor(
		private store: StateStore,
		private notifier: StuckNotifier,
		private thresholdMinutes: number,
		private intervalMs: number,
	) {}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			this.check().catch((err) => {
				console.error("[StuckWatcher] check error:", err);
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
		const stuck = this.store.getStuckSessions(this.thresholdMinutes);

		// Prune notified set: remove entries for sessions no longer stuck
		const stuckIds = new Set(stuck.map((s) => s.execution_id));
		for (const id of this.notifiedExecutions) {
			if (!stuckIds.has(id)) this.notifiedExecutions.delete(id);
		}

		for (const session of stuck) {
			if (this.notifiedExecutions.has(session.execution_id)) continue;

			let minutesSince = this.thresholdMinutes;
			if (session.last_activity_at) {
				const lastActivity = new Date(session.last_activity_at.replace(" ", "T") + "Z");
				minutesSince = Math.round((Date.now() - lastActivity.getTime()) / 60_000);
			}

			try {
				await this.notifier.onSessionStuck(session, minutesSince);
				this.notifiedExecutions.add(session.execution_id);
			} catch {
				// Notification failed — don't dedup so it's retried next cycle
			}
		}
	}
}

/**
 * Path B: Webhook-based stuck notifier — pushes notifications to OpenClaw gateway via HTTP.
 */
export class WebhookStuckNotifier implements StuckNotifier {
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
			console.warn("[stuck-notify] Failed:", (err as Error).message);
			throw err; // Let StuckWatcher skip dedup so notification is retried
		} finally {
			clearTimeout(timeout);
		}
	}
}
