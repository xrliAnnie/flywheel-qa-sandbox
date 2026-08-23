import { homedir, tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import type { MailboxQueue } from "flywheel-comm/mailbox-queue";

export interface InboxLoopHealthTarget {
	projectName: string;
	leadId: string;
	queue: MailboxQueue;
}

export interface LivenessProbeForensics {
	lookup_error: number;
	probe_throw: number;
	probe_unclear: number;
	pending_sentinel: number;
	last_at: string | null;
}

const DEFAULT_INBOX_LOOP_STALL_MS = 10 * 60_000;

export function inboxLoopStallMs(env: NodeJS.ProcessEnv = process.env): number {
	const minutes = Number(env.FLYWHEEL_INBOX_LOOP_STALL_MIN ?? "10");
	return Number.isFinite(minutes) && minutes > 0
		? minutes * 60_000
		: DEFAULT_INBOX_LOOP_STALL_MS;
}

export type LivenessEnv = Record<string, string | undefined>;

/**
 * The W-2 hang seam is destructive, so a target Lead alone is insufficient.
 * It is armed only when CommDB is redirected inside the process temp root.
 */
export function qaStallInboxLoopLead(
	env: LivenessEnv = process.env,
	tempRoot = tmpdir(),
	protectedFlywheelRoot = resolve(homedir(), ".flywheel"),
): string | undefined {
	const leadId = env.FLYWHEEL_QA_STALL_INBOX_LOOP_LEAD?.trim();
	// Match commDbRootDir() precedence exactly: a production COMM_ROOT must not
	// be masked by setting a harmless-looking temp COMM_DIR beside it.
	const commRoot =
		env.FLYWHEEL_COMM_ROOT?.trim() || env.FLYWHEEL_COMM_DIR?.trim();
	if (!leadId || !commRoot) return undefined;
	const root = resolve(tempRoot);
	const candidate = resolve(commRoot);
	const protectedRoot = resolve(protectedFlywheelRoot);
	if (
		candidate === protectedRoot ||
		candidate.startsWith(`${protectedRoot}${sep}`)
	) {
		return undefined;
	}
	if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
		return undefined;
	}
	return leadId;
}

export type LivenessFreshness = "not_started" | "fresh" | "stale" | "in_flight";

export interface LivenessTrackerSnapshot {
	wired: boolean;
	effective_enabled: boolean;
	last_check_started_at: string | null;
	last_check_completed_at: string | null;
	in_flight_age_ms: number | null;
	freshness: LivenessFreshness;
}

export class LivenessCheckTracker {
	private lastStartedAtMs: number | undefined;
	private lastCompletedAtMs: number | undefined;
	private nextGeneration = 0;
	private activePasses = new Map<number, number>();

	constructor(
		private readonly opts: { cadenceMs: number; now?: () => number },
	) {}

	started(): number {
		const generation = ++this.nextGeneration;
		this.lastStartedAtMs = (this.opts.now ?? Date.now)();
		this.activePasses.set(generation, this.lastStartedAtMs);
		return generation;
	}

	completed(generation: number): void {
		if (!this.activePasses.delete(generation)) return;
		this.lastCompletedAtMs = (this.opts.now ?? Date.now)();
	}

	snapshot(input: {
		wired: boolean;
		effectiveEnabled: boolean;
	}): LivenessTrackerSnapshot {
		const nowMs = (this.opts.now ?? Date.now)();
		const oldestActiveAtMs = Math.min(...this.activePasses.values());
		const inFlight = this.activePasses.size > 0;
		let freshness: LivenessFreshness = "not_started";
		if (inFlight) freshness = "in_flight";
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
			in_flight_age_ms: inFlight ? Math.max(0, nowMs - oldestActiveAtMs) : null,
			freshness,
		};
	}
}

export function buildLivenessManifest(input: {
	nowMs?: number;
	bridgeStartedAtMs: number;
	wiring: {
		liveness: boolean;
		externalDrift: boolean;
	};
	trackers: {
		liveness: LivenessCheckTracker;
	};
	deliveryLoopWired: boolean;
	loopStallMs: number;
	loopTargets: readonly InboxLoopHealthTarget[];
	probeForensics?: LivenessProbeForensics;
}) {
	const nowMs = input.nowMs ?? Date.now();
	const tracked = (
		tracker: LivenessCheckTracker,
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
		schema_version: 2 as const,
		generated_at: new Date(nowMs).toISOString(),
		bridge_started_at: new Date(input.bridgeStartedAtMs).toISOString(),
		...(input.probeForensics === undefined
			? {}
			: { probe_forensics: { ...input.probeForensics } }),
		components: {
			w1_process_liveness: tracked(
				input.trackers.liveness,
				input.wiring.liveness,
				true,
				{ class: "W-1", switch: "required" },
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
		},
	};
}
