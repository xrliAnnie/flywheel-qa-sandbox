import type { MailboxQueue } from "flywheel-comm/mailbox-queue";

export interface InboxLoopHealthTarget {
	projectName: string;
	leadId: string;
	queue: MailboxQueue;
}

const DEFAULT_INBOX_LOOP_STALL_MS = 10 * 60_000;

export function inboxLoopStallMs(env: NodeJS.ProcessEnv = process.env): number {
	const minutes = Number(env.FLYWHEEL_INBOX_LOOP_STALL_MIN ?? "10");
	return Number.isFinite(minutes) && minutes > 0
		? minutes * 60_000
		: DEFAULT_INBOX_LOOP_STALL_MS;
}

export type WatchdogFreshness = "not_started" | "fresh" | "stale" | "in_flight";

export interface WatchdogTrackerSnapshot {
	wired: boolean;
	effective_enabled: boolean;
	last_check_started_at: string | null;
	last_check_completed_at: string | null;
	in_flight_age_ms: number | null;
	freshness: WatchdogFreshness;
}

export class WatchdogCheckTracker {
	private lastStartedAtMs: number | undefined;
	private lastCompletedAtMs: number | undefined;
	private inFlight = false;

	constructor(
		private readonly opts: { cadenceMs: number; now?: () => number },
	) {}

	started(): void {
		this.lastStartedAtMs = (this.opts.now ?? Date.now)();
		this.inFlight = true;
	}

	completed(): void {
		this.lastCompletedAtMs = (this.opts.now ?? Date.now)();
		this.inFlight = false;
	}

	snapshot(input: {
		wired: boolean;
		effectiveEnabled: boolean;
	}): WatchdogTrackerSnapshot {
		const nowMs = (this.opts.now ?? Date.now)();
		let freshness: WatchdogFreshness = "not_started";
		if (this.inFlight) freshness = "in_flight";
		else if (this.lastCompletedAtMs !== undefined) {
			freshness =
				nowMs - this.lastCompletedAtMs <= this.opts.cadenceMs * 2
					? "fresh"
					: "stale";
		}
		return {
			wired: input.wired,
			effective_enabled: input.effectiveEnabled,
			last_check_started_at:
				this.lastStartedAtMs === undefined
					? null
					: new Date(this.lastStartedAtMs).toISOString(),
			last_check_completed_at:
				this.lastCompletedAtMs === undefined
					? null
					: new Date(this.lastCompletedAtMs).toISOString(),
			in_flight_age_ms:
				this.inFlight && this.lastStartedAtMs !== undefined
					? Math.max(0, nowMs - this.lastStartedAtMs)
					: null,
			freshness,
		};
	}
}

export function buildWatchdogManifest(input: {
	nowMs?: number;
	bridgeStartedAtMs: number;
	flags: { liveness: boolean; blocked: boolean };
	wiring: {
		liveness: boolean;
		externalDrift: boolean;
		blockedLead: boolean;
	};
	trackers: {
		liveness: WatchdogCheckTracker;
		blockedLead: WatchdogCheckTracker;
	};
	deliveryLoopWired: boolean;
	loopStallMs: number;
	loopTargets: readonly InboxLoopHealthTarget[];
}) {
	const nowMs = input.nowMs ?? Date.now();
	const tracked = (
		tracker: WatchdogCheckTracker,
		wired: boolean,
		enabled: boolean,
		extra: Record<string, unknown>,
	) => ({
		...extra,
		...tracker.snapshot({ wired, effectiveEnabled: enabled }),
	});
	const leads = input.loopTargets.map((target) => {
		const heartbeat = target.queue.getHeartbeat(target.leadId);
		const lastSuccessMs = heartbeat?.last_success_at
			? Date.parse(heartbeat.last_success_at)
			: Number.NaN;
		return {
			project_name: target.projectName,
			lead_id: target.leadId,
			last_started_at: heartbeat?.last_started_at ?? null,
			last_success_at: heartbeat?.last_success_at ?? null,
			freshness:
				Number.isFinite(lastSuccessMs) &&
				nowMs - lastSuccessMs <= input.loopStallMs
					? "fresh"
					: "stale",
		};
	});
	return {
		schema_version: 1 as const,
		generated_at: new Date(nowMs).toISOString(),
		bridge_started_at: new Date(input.bridgeStartedAtMs).toISOString(),
		components: {
			w1_process_liveness: tracked(
				input.trackers.liveness,
				input.wiring.liveness,
				input.flags.liveness,
				{ class: "W-1", switch: "FLYWHEEL_WATCHDOG_LIVENESS" },
			),
			w2_delivery_loop: {
				class: "W-2",
				wired: input.deliveryLoopWired,
				effective_enabled: true,
				switch: "required",
				leads,
			},
			w3_external_drift: {
				class: "W-3",
				wired: input.wiring.externalDrift,
				effective_enabled: true,
				observation: "static_contract",
				switch: "required/no_switch",
			},
			w4_lead_blocked: tracked(
				input.trackers.blockedLead,
				input.wiring.blockedLead,
				input.flags.blocked,
				{ class: "W-4", switch: "FLYWHEEL_WATCHDOG_BLOCKED" },
			),
		},
	};
}
