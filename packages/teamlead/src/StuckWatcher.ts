import type { StateStore, Session } from "./StateStore.js";

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

			await this.notifier.onSessionStuck(session, minutesSince);
			this.notifiedExecutions.add(session.execution_id);
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
		const id = session.issue_identifier ?? session.issue_id;
		const message = `[Stuck] ${id}: No activity for ${minutes} minutes. Started at ${session.started_at ?? "unknown"}.`;
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 3000);
		try {
			await fetch(`${this.gatewayUrl}/hooks/agent`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.hooksToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ agentId: "product-lead", message }),
				signal: controller.signal,
			});
		} catch (err) {
			console.warn("[stuck-notify] Failed:", (err as Error).message);
		} finally {
			clearTimeout(timeout);
		}
	}
}
