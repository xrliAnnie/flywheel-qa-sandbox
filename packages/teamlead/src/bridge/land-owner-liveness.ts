import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
	getProcessStart,
	processTupleStateWithStart,
} from "flywheel-comm/lead-lease";
import type {
	LandOwnerIdentity,
	LandOwnerLease,
	StateStore,
} from "../StateStore.js";

export const LAND_OWNER_HEARTBEAT_MS = 10_000;
export const LAND_OWNER_DEADLINE_MS = 5 * 60_000;
export const LAND_OWNER_LIVENESS_INTERVAL_MS = 2_000;
const PROCESS_PROBE_TIMEOUT_MS = 2_000;

export type LandOwnerProcessState =
	| "alive"
	| "dead"
	| "identity_mismatch"
	| "unknown";

let cachedDefaultIdentity: LandOwnerIdentity | undefined;

function localHostBootId(): string {
	try {
		return `${hostname()}:${getProcessStart(1)}`;
	} catch {
		// This value stays process-stable. A new Bridge will not use it as
		// positive death evidence; deadline expiry remains the fail-closed fence.
		return `${hostname()}:bridge-boot:${randomUUID()}`;
	}
}

export function defaultLandOwnerIdentity(): LandOwnerIdentity {
	if (!cachedDefaultIdentity) {
		let processStart: string;
		try {
			processStart = getProcessStart(process.pid);
		} catch {
			processStart = `bridge-process-start:${randomUUID()}`;
		}
		cachedDefaultIdentity = {
			ownerId: `land-engine:${process.pid}`,
			ownerInstanceId: randomUUID(),
			ownerPid: process.pid,
			ownerProcessStart: processStart,
			ownerHostBootId: localHostBootId(),
		};
	}
	return cachedDefaultIdentity;
}

function defaultProcessTupleProbe(
	pid: number,
	processStart: string,
): LandOwnerProcessState {
	if (
		pid === process.pid &&
		cachedDefaultIdentity?.ownerPid === pid &&
		cachedDefaultIdentity.ownerProcessStart === processStart
	) {
		return "alive";
	}
	const state = processTupleStateWithStart(pid, processStart);
	return state === "sensor_error" ? "unknown" : state;
}

function defaultLegacyPidProbe(pid: number): LandOwnerProcessState {
	try {
		process.kill(pid, 0);
		return "alive";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH"
			? "dead"
			: "unknown";
	}
}

async function boundedProbe(
	probe: () => LandOwnerProcessState | Promise<LandOwnerProcessState>,
): Promise<LandOwnerProcessState> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			Promise.resolve().then(probe),
			new Promise<LandOwnerProcessState>((resolve) => {
				timer = setTimeout(() => resolve("unknown"), PROCESS_PROBE_TIMEOUT_MS);
				timer.unref?.();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export interface LandOwnerLivenessOptions {
	now?: () => Date;
	hostBootId: string;
	probeProcessTuple?: (
		pid: number,
		processStart: string,
	) => LandOwnerProcessState | Promise<LandOwnerProcessState>;
	probeLegacyPid?: (
		pid: number,
	) => LandOwnerProcessState | Promise<LandOwnerProcessState>;
	onReclaimed?: (input: {
		operationId: string;
		projectName: string;
		reason: string;
	}) => void | Promise<void>;
	onError?: (error: unknown) => void;
}

function legacyOwnerPid(lease: LandOwnerLease): number | undefined {
	const match = /^land-engine:(\d+)$/.exec(lease.ownerId);
	if (!match) return undefined;
	const pid = Number(match[1]);
	return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/** One independent liveness pass; it never treats a probe error as death. */
export async function runLandOwnerLivenessPass(
	store: StateStore,
	options: LandOwnerLivenessOptions,
): Promise<{ reclaimed: string[]; unresolved: string[]; stalled: string[] }> {
	const now = (options.now ?? (() => new Date()))().toISOString();
	const reclaimed: string[] = [];
	const unresolved: string[] = [];
	const stalled: string[] = [];
	for (const lease of store.listActiveLandOwnerLeases()) {
		let reason:
			| "process_absent"
			| "process_identity_mismatch"
			| "legacy_process_absent"
			| "deadline_expired"
			| undefined;
		if (lease.leaseExpiresAt <= now) {
			reason = "deadline_expired";
		} else if (
			lease.ownerInstanceId &&
			lease.ownerPid &&
			lease.ownerProcessStart &&
			lease.ownerHostBootId
		) {
			if (lease.ownerHostBootId !== options.hostBootId) {
				unresolved.push(lease.operationId);
				continue;
			}
			if (lease.ownerProcessStart.startsWith("bridge-process-start:")) {
				unresolved.push(lease.operationId);
				continue;
			}
			const state = await boundedProbe(() =>
				(options.probeProcessTuple ?? defaultProcessTupleProbe)(
					lease.ownerPid!,
					lease.ownerProcessStart!,
				),
			);
			if (state === "dead") reason = "process_absent";
			else if (state === "identity_mismatch") {
				reason = "process_identity_mismatch";
			} else if (state === "unknown") {
				unresolved.push(lease.operationId);
				continue;
			} else {
				if (
					lease.ownerLastProgressAt &&
					Date.parse(now) - Date.parse(lease.ownerLastProgressAt) >=
						LAND_OWNER_DEADLINE_MS &&
					store.recordLandOwnerHealthStall({ observed: lease, now })
				) {
					stalled.push(lease.operationId);
				}
				continue;
			}
		} else {
			const pid = legacyOwnerPid(lease);
			if (!pid) {
				unresolved.push(lease.operationId);
				continue;
			}
			const state = await boundedProbe(() =>
				(options.probeLegacyPid ?? defaultLegacyPidProbe)(pid),
			);
			if (state !== "dead") {
				if (state === "unknown") unresolved.push(lease.operationId);
				continue;
			}
			reason = "legacy_process_absent";
		}
		const result = store.reclaimLandOperationOwner({
			observed: lease,
			reason,
			now,
			nextAttemptAt: now,
		});
		if (!result.ok) continue;
		reclaimed.push(lease.operationId);
		await options.onReclaimed?.({
			operationId: lease.operationId,
			projectName: lease.projectName,
			reason,
		});
	}
	return { reclaimed, unresolved, stalled };
}

/** Independent timer: reclaimed work is kicked without awaiting that work. */
export class LandOwnerLivenessMonitor {
	private timer: ReturnType<typeof setInterval> | undefined;
	private inFlight: Promise<void> | undefined;
	private inFlightToken: object | undefined;

	constructor(
		private readonly store: StateStore,
		private readonly options: LandOwnerLivenessOptions,
	) {}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.tick();
		}, LAND_OWNER_LIVENESS_INTERVAL_MS);
		this.timer.unref?.();
		void this.tick();
	}

	async stop(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		await this.inFlight;
	}

	tick(): Promise<void> {
		if (this.inFlight) return this.inFlight;
		const token = {};
		const pass = (async () => {
			try {
				await runLandOwnerLivenessPass(this.store, this.options);
			} catch (error) {
				this.reportError(error);
			} finally {
				if (this.inFlightToken === token) {
					this.inFlight = undefined;
					this.inFlightToken = undefined;
				}
			}
		})();
		this.inFlightToken = token;
		this.inFlight = pass;
		return pass;
	}

	private reportError(error: unknown): void {
		if (this.options.onError) {
			try {
				this.options.onError(error);
				return;
			} catch (reportError) {
				console.error(
					`[land-owner-liveness] error reporter failed: ${reportError instanceof Error ? reportError.message : String(reportError)}`,
				);
			}
		}
		console.error(
			`[land-owner-liveness] tick failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
