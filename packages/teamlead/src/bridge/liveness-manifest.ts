import { lstatSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
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

export type ArtifactFreshnessReceiptState = {
	freshness: "not_started" | "fresh" | "stale" | "invalid";
	run_status: "ok" | "degraded" | "unknown";
	last_run_at: string | null;
};

export const ARTIFACT_FRESHNESS_STALL_MS = 180 * 60_000;
const ARTIFACT_FRESHNESS_RECEIPT_MAX_BYTES = 4096;
const ARTIFACT_FRESHNESS_FUTURE_SKEW_MS = 300_000;
const ARTIFACT_FRESHNESS_COUNT_KEYS = [
	"fresh",
	"stale",
	"missing",
	"undetermined",
	"suspended",
] as const;

const invalidArtifactFreshnessReceipt = (): ArtifactFreshnessReceiptState => ({
	freshness: "invalid",
	run_status: "unknown",
	last_run_at: null,
});

export function readArtifactFreshnessReceipt(
	path: string,
	nowMs: number,
): ArtifactFreshnessReceiptState {
	try {
		const stat = lstatSync(path, { throwIfNoEntry: false });
		if (stat === undefined) {
			return {
				freshness: "not_started",
				run_status: "unknown",
				last_run_at: null,
			};
		}
		if (!stat.isFile() || stat.isSymbolicLink()) {
			return invalidArtifactFreshnessReceipt();
		}
		if (stat.size > ARTIFACT_FRESHNESS_RECEIPT_MAX_BYTES) {
			return invalidArtifactFreshnessReceipt();
		}
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return invalidArtifactFreshnessReceipt();
		}
		const receipt = parsed as Record<string, unknown>;
		if (
			receipt.schema !== 1 ||
			typeof receipt.run_id !== "string" ||
			!/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$/.test(receipt.run_id) ||
			typeof receipt.observed_at !== "string" ||
			!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(
				receipt.observed_at,
			) ||
			typeof receipt.registry_sha256 !== "string" ||
			!/^[0-9a-f]{64}$/.test(receipt.registry_sha256) ||
			!Number.isSafeInteger(receipt.rows) ||
			(receipt.rows as number) < 0 ||
			!Number.isSafeInteger(receipt.unobservable_active) ||
			(receipt.unobservable_active as number) < 0 ||
			(receipt.unobservable_active as number) > (receipt.rows as number) ||
			(receipt.post_status !== "none" &&
				receipt.post_status !== "success" &&
				receipt.post_status !== "failed") ||
			(receipt.run_status !== "ok" && receipt.run_status !== "degraded")
		) {
			return invalidArtifactFreshnessReceipt();
		}
		const observedAtMs = Date.parse(receipt.observed_at);
		if (
			!Number.isFinite(observedAtMs) ||
			`${new Date(observedAtMs).toISOString().slice(0, 19)}Z` !==
				receipt.observed_at ||
			observedAtMs > nowMs + ARTIFACT_FRESHNESS_FUTURE_SKEW_MS
		) {
			return invalidArtifactFreshnessReceipt();
		}
		if (
			!receipt.counts ||
			typeof receipt.counts !== "object" ||
			Array.isArray(receipt.counts)
		) {
			return invalidArtifactFreshnessReceipt();
		}
		const counts = receipt.counts as Record<string, unknown>;
		if (
			Object.keys(counts).length !== ARTIFACT_FRESHNESS_COUNT_KEYS.length ||
			!ARTIFACT_FRESHNESS_COUNT_KEYS.every(
				(key) =>
					Number.isSafeInteger(counts[key]) && (counts[key] as number) >= 0,
			) ||
			ARTIFACT_FRESHNESS_COUNT_KEYS.reduce(
				(total, key) => total + (counts[key] as number),
				0,
			) !== receipt.rows
		) {
			return invalidArtifactFreshnessReceipt();
		}
		const derivedRunStatus =
			(receipt.unobservable_active as number) > 0 ||
			receipt.post_status === "failed"
				? "degraded"
				: "ok";
		if (receipt.run_status !== derivedRunStatus) {
			return invalidArtifactFreshnessReceipt();
		}
		return {
			freshness:
				nowMs - observedAtMs <= ARTIFACT_FRESHNESS_STALL_MS ? "fresh" : "stale",
			run_status: receipt.run_status as "ok" | "degraded",
			last_run_at: receipt.observed_at,
		};
	} catch {
		return invalidArtifactFreshnessReceipt();
	}
}

const DEFAULT_INBOX_LOOP_STALL_MS = 10 * 60_000;

export function inboxLoopStallMs(env: NodeJS.ProcessEnv = process.env): number {
	const minutes = Number(env.FLYWHEEL_INBOX_LOOP_STALL_MIN ?? "10");
	return Number.isFinite(minutes) && minutes > 0
		? minutes * 60_000
		: DEFAULT_INBOX_LOOP_STALL_MS;
}

export type LivenessEnv = Record<string, string | undefined>;

export function artifactFreshnessStateDir(
	env: LivenessEnv = process.env,
): string {
	const root = env.FLYWHEEL_STATE_DIR?.trim() || join(homedir(), ".flywheel");
	return join(root, "state", "artifact-freshness");
}

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
	artifactFreshness?: { receiptPath: string };
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
			...(input.artifactFreshness === undefined
				? {}
				: {
						w4_artifact_freshness: {
							class: "W-4",
							wired: true,
							effective_enabled: true,
							switch: "required/no_switch",
							observation: "receipt_file",
							receipt_path: input.artifactFreshness.receiptPath,
							...readArtifactFreshnessReceipt(
								input.artifactFreshness.receiptPath,
								nowMs,
							),
						},
					}),
		},
	};
}
