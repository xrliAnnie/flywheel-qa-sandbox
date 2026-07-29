import { type Kernel, recordExternalEffectIntentTx } from "flywheel-v2-kernel";
import type { SchedulerConfig } from "./config.js";
import { validateSchedulerConfig } from "./config.js";
import { mapLeadLaunchdTarget } from "./launchd-target.js";
import {
	type MemorySample,
	type MemoryThresholds,
	MemoryWatermark,
} from "./memory-watermark.js";
import { RestartCapacity } from "./restart-capacity.js";
import {
	claimHeartbeatRepair,
	finishHeartbeatRepair,
	finishSchedulerRun,
	listStaleLeadCandidates,
	readHeartbeatProgress,
	startSchedulerRun,
} from "./scheduler-store.js";

export interface SchedulerClock {
	nowMs(): number;
	nowIso(): string;
	sleep(ms: number): Promise<void>;
}

export interface SchedulerMemoryPort {
	thresholds: MemoryThresholds;
	sample(): Promise<MemorySample | null>;
}

export interface LaunchdPort {
	kickstart(jobLabel: string): Promise<void>;
}

export type RestartGateState =
	| "active"
	| "resumed"
	| "held_alert_pending"
	| "held_alert_attempted";

export interface RestartGateStatus {
	state: RestartGateState;
	ledgerSeq: number;
}

export interface RestartGateRecordResult extends RestartGateStatus {
	recorded: boolean;
}

export interface RestartGatePort {
	status(childKey: string): Promise<RestartGateStatus>;
	recordFailure(
		childKey: string,
		expectedSeq: number,
	): Promise<RestartGateRecordResult>;
}

export interface SchedulerOnceInput {
	kernel: Kernel;
	runId: string;
	backend: string;
	host: string;
	projectName: string;
	uid: number;
	config: SchedulerConfig;
	clock: SchedulerClock;
	memory: SchedulerMemoryPort;
	launchd: LaunchdPort;
	restartGate: RestartGatePort;
}

export interface SchedulerOnceResult {
	status: "succeeded" | "partial" | "failed" | "timed_out" | "lease_busy";
	candidates: number;
	restarted: number;
	held: number;
	failed: number;
	memoryLimited: number;
}

class SchedulerDeadlineError extends Error {}

function held(state: RestartGateState): boolean {
	return state === "held_alert_pending" || state === "held_alert_attempted";
}

function isoAt(ms: number): string {
	return new Date(ms).toISOString();
}

function boundedBackoffMs(
	failureCount: number,
	config: SchedulerConfig,
): number {
	const multiplier = 2 ** Math.min(failureCount, 20);
	return Math.min(config.retryCapMs, config.retryBaseMs * multiplier);
}

function assertBeforeDeadline(clock: SchedulerClock, deadlineMs: number): void {
	if (clock.nowMs() >= deadlineMs) {
		throw new SchedulerDeadlineError("scheduler-once hard deadline reached");
	}
}

async function confirmProgress(
	input: SchedulerOnceInput,
	claim: { agentId: string; generation: number; lastPollAt: string },
	hardDeadlineMs: number,
): Promise<boolean> {
	const confirmDeadline = Math.min(
		input.clock.nowMs() + input.config.heartbeatConfirmMs,
		hardDeadlineMs,
	);
	for (;;) {
		const progress = readHeartbeatProgress(input.kernel, claim.agentId);
		if (
			progress &&
			(progress.generation > claim.generation ||
				(progress.generation === claim.generation &&
					progress.lastPollAt !== null &&
					Date.parse(progress.lastPollAt) > Date.parse(claim.lastPollAt)))
		) {
			return true;
		}
		const remaining = confirmDeadline - input.clock.nowMs();
		if (remaining <= 0) return false;
		await input.clock.sleep(Math.min(input.config.confirmPollMs, remaining));
	}
}

type RepairCandidate = ReturnType<typeof listStaleLeadCandidates>[number];
type RepairResult = "succeeded" | "failed" | "held";

async function repairCandidate(
	input: SchedulerOnceInput,
	config: SchedulerConfig,
	candidate: RepairCandidate,
	startedAtMs: number,
	hardDeadlineMs: number,
): Promise<RepairResult> {
	assertBeforeDeadline(input.clock, hardDeadlineMs);
	let target: ReturnType<typeof mapLeadLaunchdTarget>;
	try {
		target = mapLeadLaunchdTarget({
			agentId: candidate.agentId,
			kind: "lead",
			projectName: input.projectName,
			uid: input.uid,
		});
	} catch {
		return "failed";
	}

	const nowMs = input.clock.nowMs();
	const claim = claimHeartbeatRepair(input.kernel, {
		runId: input.runId,
		agentId: candidate.agentId,
		generation: candidate.generation,
		observedLastPollAt: candidate.lastPollAt,
		staleBeforeIso: isoAt(startedAtMs - config.heartbeatStaleMs),
		nowIso: input.clock.nowIso(),
		leaseExpiresAt: isoAt(nowMs + config.repairLeaseMs),
	});
	if (!claim) return "failed";

	let repairResult: RepairResult = "failed";
	try {
		const before = await input.restartGate.status(target.childKey);
		if (held(before.state)) {
			await input.restartGate.recordFailure(target.childKey, before.ledgerSeq);
			repairResult = "held";
		} else {
			let kickstartFailed = false;
			try {
				input.kernel.write("scheduler.kickstart-intent", (tx) => {
					recordExternalEffectIntentTx(tx, {
						effectKey: `scheduler:${input.runId}:${claim.agentId}:${claim.generation}`,
						family: "scheduler",
						nowIso: input.clock.nowIso(),
					});
				});
				await input.launchd.kickstart(target.jobLabel);
			} catch {
				kickstartFailed = true;
			}
			const confirmed =
				!kickstartFailed &&
				(await confirmProgress(input, claim, hardDeadlineMs));
			if (confirmed) {
				repairResult = "succeeded";
			} else {
				const accounted = await input.restartGate.recordFailure(
					target.childKey,
					before.ledgerSeq,
				);
				repairResult = held(accounted.state) ? "held" : "failed";
			}
		}
	} catch {
		repairResult = "failed";
	}

	const finishedAtMs = input.clock.nowMs();
	finishHeartbeatRepair(input.kernel, {
		runId: input.runId,
		agentId: claim.agentId,
		generation: claim.generation,
		result: repairResult,
		nowIso: input.clock.nowIso(),
		nextAttemptAt:
			repairResult === "succeeded"
				? null
				: isoAt(finishedAtMs + boundedBackoffMs(claim.failureCount, config)),
	});
	return repairResult;
}

function summaryResult(result: SchedulerOnceResult): "succeeded" | "partial" {
	return result.held > 0 ||
		result.failed > 0 ||
		result.memoryLimited > 0 ||
		result.restarted < result.candidates
		? "partial"
		: "succeeded";
}

export async function runSchedulerOnce(
	input: SchedulerOnceInput,
): Promise<SchedulerOnceResult> {
	const config = validateSchedulerConfig(input.config);
	const startedAtMs = input.clock.nowMs();
	const hardDeadlineMs = startedAtMs + config.hardTimeoutMs;
	const acquired = startSchedulerRun(input.kernel, {
		runId: input.runId,
		backend: input.backend,
		host: input.host,
		nowIso: input.clock.nowIso(),
		leaseExpiresAt: isoAt(startedAtMs + config.repairLeaseMs),
	});
	if (!acquired) {
		return {
			status: "lease_busy",
			candidates: 0,
			restarted: 0,
			held: 0,
			failed: 0,
			memoryLimited: 0,
		};
	}

	const result: SchedulerOnceResult = {
		status: "succeeded",
		candidates: 0,
		restarted: 0,
		held: 0,
		failed: 0,
		memoryLimited: 0,
	};
	try {
		const candidates = listStaleLeadCandidates(input.kernel, {
			staleBeforeIso: isoAt(startedAtMs - config.heartbeatStaleMs),
			limit: config.candidateLimit,
		});
		result.candidates = candidates.length;
		const watermark = new MemoryWatermark(input.memory.thresholds);
		const capacity = new RestartCapacity({
			maxCapacity: config.restartConcurrencyMax,
			decreaseWindowMs: config.pressureDecreaseWindowMs,
			healthyIncreaseWindowMs: config.healthyIncreaseWindowMs,
		});
		if (candidates.length > 0) {
			watermark.observe(await input.memory.sample());
			await input.clock.sleep(config.memorySampleIntervalMs);
		}

		const queue = [...candidates];
		while (queue.length > 0) {
			const batch: Array<Promise<RepairResult>> = [];
			while (queue.length > 0 && batch.length < capacity.current) {
				assertBeforeDeadline(input.clock, hardDeadlineMs);
				const candidate = queue.shift();
				if (!candidate) break;
				const observation = watermark.observe(await input.memory.sample());
				if (observation.health !== "healthy") {
					capacity.observePressure(input.clock.nowMs());
					// Preserve the candidate's exact identity at the queue head. If
					// another admitted repair is still able to make progress, finish
					// that wave and retry this candidate first. With no admitted work,
					// the global memory signal limits every remaining candidate, so
					// end this short-lived batch and let the next level-triggered tick
					// reconstruct them from durable state.
					queue.unshift(candidate);
					if (batch.length === 0) {
						result.memoryLimited += queue.length;
						queue.length = 0;
					}
					break;
				}
				capacity.observeHealthy(input.clock.nowMs(), true);
				batch.push(
					repairCandidate(
						input,
						config,
						candidate,
						startedAtMs,
						hardDeadlineMs,
					),
				);
			}
			if (batch.length === 0) break;
			const settledRepairs = await Promise.allSettled(batch);
			const unexpectedFailure = settledRepairs.find(
				(repair): repair is PromiseRejectedResult =>
					repair.status === "rejected",
			);
			if (unexpectedFailure) throw unexpectedFailure.reason;
			for (const repair of settledRepairs) {
				if (repair.status !== "fulfilled") continue;
				const repairResult = repair.value;
				if (repairResult === "succeeded") result.restarted++;
				else if (repairResult === "held") result.held++;
				else result.failed++;
			}
		}

		result.status = summaryResult(result);
		finishSchedulerRun(input.kernel, {
			runId: input.runId,
			result: result.status,
			detail: JSON.stringify(result),
			nowIso: input.clock.nowIso(),
		});
		return result;
	} catch (error) {
		result.status =
			error instanceof SchedulerDeadlineError ? "timed_out" : "failed";
		finishSchedulerRun(input.kernel, {
			runId: input.runId,
			result: result.status,
			detail: error instanceof Error ? error.message : String(error),
			nowIso: input.clock.nowIso(),
		});
		return result;
	}
}
