import type { StateStore } from "./StateStore.js";
import type { TemplateNotifier } from "./TemplateNotifier.js";

/**
 * Periodic checker for stuck sessions (running but no activity for N minutes).
 * Sends one notification per execution, deduped in-memory.
 */
export class StuckWatcher {
	private timer: NodeJS.Timeout | null = null;
	private notifiedExecutions = new Set<string>();

	constructor(
		private store: StateStore,
		private notifier: TemplateNotifier,
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
