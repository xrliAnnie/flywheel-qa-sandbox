import {
	type AlertPayload,
	type AlertResult,
	FLEET_ALERT_PROJECT,
} from "../LeadAlertNotifier.js";
import type { StateStore } from "../StateStore.js";
import { correlationKeyFor } from "./AlertChannelHub.js";
import type { FdHealth } from "./process-resource-monitor.js";

/** Stable identity within a process episode; an attempt-only duplicate is not a receipt. */
export class FdPressureAlert {
	private episode = 1;
	private recoveredThrough = 0;
	private active: AlertPayload | null = null;
	private readonly sessionKey: string;
	constructor(
		private readonly deps: {
			bootId: string;
			store: Pick<StateStore, "getAlertDeliveryReceipt">;
			alert: (payload: AlertPayload) => Promise<AlertResult>;
			resolve: (correlationKey: string, eventId: string) => Promise<void>;
		},
	) {
		this.sessionKey = `bridge-fd:${deps.bootId}`;
	}
	async alert(sample: FdHealth): Promise<boolean> {
		this.active ??= {
			projectName: FLEET_ALERT_PROJECT,
			leadId: "bridge",
			eventId: `${this.sessionKey}:${this.episode}`,
			episodeId: `${this.sessionKey}:${this.episode}`,
			sessionKey: this.sessionKey,
			eventType: "bridge_fd_pressure",
			severity: "warning",
			title: "Bridge file descriptor pressure exceeds 80%",
			body: `Bridge fd usage ${sample.used}/${sample.limit}; inspect connection ownership and process/kernel limits.`,
		};
		const result = await this.deps.alert(this.active);
		return !!(
			result.sent ||
			result.dmSent ||
			result.queued ||
			result.deadLettered ||
			(result.skipped === "duplicate" &&
				this.deps.store.getAlertDeliveryReceipt(this.active.eventId))
		);
	}
	async resolve(): Promise<boolean> {
		if (!this.active) return true;
		await this.deps.resolve(
			correlationKeyFor(this.active),
			this.active.eventId,
		);
		this.recoveredThrough = this.episode;
		this.episode++;
		this.active = null;
		return true;
	}
	recoveryProbe(row: {
		event_id: string;
		session_key: string | null;
	}): boolean | null {
		if (row.session_key !== this.sessionKey) return null;
		const prefix = `${this.sessionKey}:`;
		if (!row.event_id.startsWith(prefix)) return null;
		const suffix = row.event_id.slice(prefix.length);
		if (!/^[1-9]\d*$/.test(suffix)) return null;
		const episode = Number(suffix);
		return Number.isSafeInteger(episode)
			? episode <= this.recoveredThrough
			: null;
	}
}
