import type { InboxLoopHealthTarget } from "./inbox-loop-health-checker.js";

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

export const RETIRING_WATCHDOGS = [
	"legacy_delivery_watchdogs",
	"misroute_patrol",
	"founder_reply_watchdog",
	"lead_pending_escalation",
	"park_watch",
	"stuck_detect",
	"stuck_founder_page_killswitch",
	"zombie_gate_resolve",
	"checkpoint_watchdog",
] as const;

export type RetiringWatchdogName = (typeof RETIRING_WATCHDOGS)[number];

export function buildRetiringWatchdogRows(
	effective: Record<RetiringWatchdogName, boolean>,
): Array<{ name: RetiringWatchdogName; effective_enabled: boolean }> {
	return RETIRING_WATCHDOGS.map((name) => ({
		name,
		effective_enabled: effective[name] === true,
	}));
}

export function buildWatchdogManifest(input: {
	nowMs?: number;
	bridgeStartedAtMs: number;
	flags: { liveness: boolean; loopHeartbeat: boolean; blocked: boolean };
	wiring: {
		liveness: boolean;
		loopHeartbeat: boolean;
		externalDrift: boolean;
		blockedLead: boolean;
		blockedRunner: boolean;
	};
	trackers: {
		liveness: WatchdogCheckTracker;
		loopHeartbeat: WatchdogCheckTracker;
		blockedLead: WatchdogCheckTracker;
		blockedRunner: WatchdogCheckTracker;
	};
	loopStallMs: number;
	loopTargets: readonly InboxLoopHealthTarget[];
	retiringEnabled: Record<RetiringWatchdogName, boolean>;
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
				...tracked(
					input.trackers.loopHeartbeat,
					input.wiring.loopHeartbeat,
					input.flags.loopHeartbeat,
					{
						class: "W-2",
						switch: "FLYWHEEL_WATCHDOG_LOOP_HEARTBEAT",
					},
				),
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
			w4_runner_blocked: tracked(
				input.trackers.blockedRunner,
				input.wiring.blockedRunner,
				input.flags.blocked,
				{ class: "W-4", switch: "FLYWHEEL_WATCHDOG_BLOCKED" },
			),
		},
		retiring: buildRetiringWatchdogRows(input.retiringEnabled),
	};
}
