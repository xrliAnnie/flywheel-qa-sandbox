import {
	type AlertPayload,
	type AlertResult,
	FLEET_ALERT_PROJECT,
} from "../LeadAlertNotifier.js";
import type { StateStore } from "../StateStore.js";
import type { ObservationStorageState } from "../ship-judgment/observation-cursor.js";

type StorageReader = Pick<
	StateStore,
	"getShipJudgmentObservationStorage" | "getShipJudgmentObservationProgress"
>;
const sessionKey = "bridge-observation-storage";

/** Health reads only the cached startup result and exposes static reason codes. */
export function observationStorageHealth(
	store: StorageReader,
): ObservationStorageState &
	ReturnType<StateStore["getShipJudgmentObservationProgress"]> {
	const progress = store.getShipJudgmentObservationProgress?.() ?? {
		zero_progress_ticks: {
			verdict: 0,
			closeout: 0,
			clarification: 0,
			archive: 0,
		},
		starved: false,
	};
	try {
		const state = store.getShipJudgmentObservationStorage();
		if (state.status === "ready")
			return { status: "ready", reason: null, ...progress };
		if (
			["not_initialized", "schema_drift", "migration_failed"].includes(
				state.reason,
			)
		)
			return { status: "unavailable", reason: state.reason, ...progress };
	} catch {
		/* Missing or failed provider is unavailable, never raw error text. */
	}
	return { status: "unavailable", reason: "not_initialized", ...progress };
}

/** One startup failure identity; retries ride the existing alert-drain timer. */
export class ObservationStorageAlert {
	private flight: Promise<boolean> | null = null;
	private delivered = false;
	private stopped = false;
	private payload: AlertPayload | null = null;
	private episode = 1;
	private failureMode: string | null = null;
	constructor(
		private readonly deps: {
			store: StorageReader & Pick<StateStore, "getAlertDeliveryReceipt">;
			bootId: string;
			alert: (payload: AlertPayload) => Promise<AlertResult>;
		},
	) {}
	tick(): Promise<boolean> {
		if (this.stopped) return Promise.resolve(false);
		if (this.flight) return this.flight;
		const state = observationStorageHealth(this.deps.store);
		if (state.status === "ready" && !state.starved) {
			if (this.payload) {
				this.episode++;
				this.payload = null;
				this.failureMode = null;
				this.delivered = false;
			}
			return Promise.resolve(true);
		}
		const failureMode =
			state.status === "unavailable" ? state.reason : "starved";
		if (this.payload && this.failureMode !== failureMode) {
			// A new failure mode needs a fresh delivery identity: the routed sink
			// deduplicates already delivered events and replaces older episodes.
			this.episode++;
			this.payload = null;
			this.delivered = false;
		}
		this.failureMode = failureMode;
		if (this.delivered) return Promise.resolve(true);
		this.payload ??= {
			projectName: FLEET_ALERT_PROJECT,
			leadId: "bridge",
			eventType: "ship_judgment_observation_unavailable",
			eventId: `${sessionKey}:${this.deps.bootId}:${this.episode}`,
			episodeId: `${sessionKey}:${this.deps.bootId}:${this.episode}`,
			sessionKey,
			severity: "warning",
			title: "Ship-judgment observation unavailable or starved",
			body:
				state.status === "unavailable"
					? `Observation startup status: ${state.reason}. Learning observers are disabled; inspect migration diagnostics before an authorized recovery.`
					: `Consecutive budget-exhausted zero-progress ticks: ${JSON.stringify(state.zero_progress_ticks)}. Inspect host contention; observation budgets remain unchanged.`,
		};
		const payload = this.payload;
		const flight = Promise.resolve()
			.then(async () => {
				const result = await this.deps.alert(payload);
				this.delivered = !!(
					result.sent ||
					result.dmSent ||
					result.queued ||
					result.deadLettered ||
					(result.skipped === "duplicate" &&
						this.deps.store.getAlertDeliveryReceipt(payload.eventId))
				);
				return this.delivered;
			})
			.finally(() => {
				if (this.flight === flight) this.flight = null;
			});
		this.flight = flight;
		return flight;
	}
	recoveryProbe(row: {
		event_id: string;
		session_key: string | null;
	}): boolean | null {
		if (
			row.session_key !== sessionKey ||
			!row.event_id.startsWith(`${sessionKey}:`)
		)
			return null;
		const state = observationStorageHealth(this.deps.store);
		if (state.status === "ready" && !state.starved) return true;
		const prefix = `${sessionKey}:${this.deps.bootId}:`;
		const suffix = row.event_id.slice(prefix.length);
		return (
			row.event_id.startsWith(prefix) &&
			/^[1-9]\d*$/.test(suffix) &&
			Number(suffix) < this.episode
		);
	}
	async stop(): Promise<void> {
		this.stopped = true;
		await this.flight?.catch(() => {});
	}
}
