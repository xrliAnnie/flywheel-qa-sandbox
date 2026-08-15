import type { LandOperationRow, StateStore } from "../StateStore.js";
import { normalizeLandLinearDoneReason } from "./land-retry-policy.js";
import {
	type LinearDoneFinalizer,
	raceMarkIssueDoneWithAbort,
} from "./linear-issue-finalizer.js";

type DeferredLinearDoneStore = Pick<
	StateStore,
	| "listDeferredLandLinearDone"
	| "getLandOperation"
	| "settleDeferredLandLinearDone"
	| "deferLandLinearDoneRetry"
>;

export interface DeferredLinearDoneSweepReport {
	inspected: number;
	settled: number;
}

/** Stable for one operation/Lead/day so alert replay cannot UID-conflict. */
export function buildAgedDeferredLinearDoneAlert(input: {
	operation: LandOperationRow;
	leadId: string;
	leadResolution: "resolved" | "fallback";
	dayBucket: string;
}): {
	escalationUid: string;
	title: string;
	body: string;
	workflowMetadata: {
		nodeId: "land";
		executionId: string;
		disposition: "linear_done_deferred";
		operationId: string;
		reason: "linear_done_deferred_stale";
		deferredAt?: string;
		leadResolution: "resolved" | "fallback";
	};
} {
	const { operation } = input;
	return {
		escalationUid: `linear_done_deferred_stale:${operation.operation_id}:${input.leadId}:${input.leadResolution}:${input.dayBucket}`,
		title: `Linear Done still deferred for ${operation.issue_id}`,
		body: `Local land cleanup completed, but Linear Done remains deferred since ${operation.linear_done_deferred_at ?? "an unknown time"}. The bounded slow sweep will continue retrying.`,
		workflowMetadata: {
			nodeId: "land",
			executionId: operation.operation_id,
			disposition: "linear_done_deferred",
			operationId: operation.operation_id,
			reason: "linear_done_deferred_stale",
			leadResolution: input.leadResolution,
			...(operation.linear_done_deferred_at
				? { deferredAt: operation.linear_done_deferred_at }
				: {}),
		},
	};
}

function authorityRefusesLinearWrite(reason: string): boolean {
	return (
		reason === "founder_parked" ||
		reason === "canceled_observation" ||
		reason === "canceled_fresh_linear"
	);
}

const LINEAR_DONE_RETRY_DELAYS_MS = [
	15 * 60_000,
	30 * 60_000,
	60 * 60_000,
	2 * 60 * 60_000,
	4 * 60 * 60_000,
	8 * 60 * 60_000,
	24 * 60 * 60_000,
] as const;

function nextLinearDoneAttemptAt(
	operation: LandOperationRow,
	now: Date,
): string {
	const retryCount = Math.max(0, operation.linear_done_retry_count ?? 0);
	const delay =
		LINEAR_DONE_RETRY_DELAYS_MS[
			Math.min(retryCount, LINEAR_DONE_RETRY_DELAYS_MS.length - 1)
		] ?? LINEAR_DONE_RETRY_DELAYS_MS.at(-1)!;
	return new Date(now.getTime() + delay).toISOString();
}

/**
 * Retry the external Linear projection independently from already-completed
 * local cleanup. Each exact operation is rechecked and settled under the same
 * canonical issue mutex used by the land DAG.
 */
export async function sweepDeferredLandLinearDone(input: {
	store: DeferredLinearDoneStore;
	preArbitrate: (
		issueId: string,
		projectName: string,
		alreadyLocked?: boolean,
	) => Promise<
		| { ok: true; degraded?: "linear_unreachable" }
		| { ok: false; reason: string; retryable?: boolean }
	>;
	withIssueMutex: <T>(issueId: string, fn: () => Promise<T>) => Promise<T>;
	markIssueDone?: LinearDoneFinalizer;
	now?: Date;
	onAgedDeferred?: (
		operation: LandOperationRow,
		detail: { ageHours: number; dayBucket: string; reason: string },
	) => void | Promise<void>;
	log?: (message: string) => void;
}): Promise<DeferredLinearDoneSweepReport> {
	const now = input.now ?? new Date();
	const nowIso = now.toISOString();
	const candidates = input.store.listDeferredLandLinearDone(nowIso, 10);
	let settled = 0;
	const logFailure = (operationId: string, error: unknown) => {
		(input.log ?? console.warn)(
			`[land] deferred Linear Done candidate ${operationId} failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	};

	for (const candidate of candidates) {
		try {
			await input.withIssueMutex(candidate.issue_id, async () => {
				const operation = input.store.getLandOperation(candidate.operation_id);
				if (
					!operation ||
					operation.state !== "completed" ||
					operation.linear_done_disposition !== "deferred"
				) {
					return;
				}
				const baselineRetryCount = Math.max(
					0,
					operation.linear_done_retry_count ?? 0,
				);
				let lastReason = normalizeLandLinearDoneReason(
					operation.linear_done_last_reason,
				);
				let fallbackReason: string | undefined;
				const deferRetry = (reason: unknown) => {
					const normalized = normalizeLandLinearDoneReason(reason);
					lastReason = normalized;
					try {
						const deferred = input.store.deferLandLinearDoneRetry({
							operationId: operation.operation_id,
							reason: normalized,
							now: nowIso,
							nextAttemptAt: nextLinearDoneAttemptAt(operation, now),
							expectedRetryCount: baselineRetryCount,
						});
						if (deferred.ok) return true;
						fallbackReason = normalizeLandLinearDoneReason(
							`linear_done_retry_failed:${deferred.reason}`,
						);
					} catch (error) {
						fallbackReason = normalizeLandLinearDoneReason(
							`linear_done_retry_failed:${error instanceof Error ? error.message : String(error)}`,
						);
					}
					return false;
				};
				const settle = (
					disposition: "done" | "canceled_refused",
					reason: unknown,
				) => {
					const normalized = normalizeLandLinearDoneReason(reason);
					lastReason = normalized;
					try {
						const result = input.store.settleDeferredLandLinearDone({
							operationId: operation.operation_id,
							disposition,
							reason: normalized,
							now: nowIso,
						});
						if (result.ok) {
							settled += 1;
							return true;
						}
						fallbackReason = normalizeLandLinearDoneReason(
							`linear_done_settlement_failed:${result.reason}`,
						);
					} catch (error) {
						fallbackReason = normalizeLandLinearDoneReason(
							`linear_done_settlement_failed:${error instanceof Error ? error.message : String(error)}`,
						);
					}
					return false;
				};

				let arbitration:
					| { ok: true; degraded?: "linear_unreachable" }
					| { ok: false; reason: string; retryable?: boolean };
				try {
					arbitration = await input.preArbitrate(
						operation.issue_id,
						operation.project_name,
						true,
					);
				} catch (error) {
					arbitration = {
						ok: false,
						reason: `arbitration_failed:${error instanceof Error ? error.message : String(error)}`,
						retryable: true,
					};
				}
				if (!arbitration.ok) {
					if (authorityRefusesLinearWrite(arbitration.reason)) {
						settle("canceled_refused", arbitration.reason);
					} else {
						deferRetry(arbitration.reason);
					}
				} else if (!input.markIssueDone) {
					settle("canceled_refused", "linear_finalizer_unavailable");
				} else {
					const result = await raceMarkIssueDoneWithAbort(
						input.markIssueDone,
						operation.issue_id,
						undefined,
					);
					const reason =
						result.reason ?? (result.done ? "done" : "linear_done_failed");
					const disposition = result.done
						? "done"
						: result.reason === "issue_canceled_never_overwritten"
							? "canceled_refused"
							: undefined;
					if (disposition) {
						settle(disposition, reason);
					} else {
						deferRetry(reason);
					}
				}

				if (fallbackReason) {
					try {
						const current = input.store.getLandOperation(
							operation.operation_id,
						);
						if (
							current?.state === "completed" &&
							current.linear_done_disposition === "deferred" &&
							Math.max(0, current.linear_done_retry_count ?? 0) ===
								baselineRetryCount
						) {
							const fallback = input.store.deferLandLinearDoneRetry({
								operationId: operation.operation_id,
								reason: fallbackReason,
								now: nowIso,
								nextAttemptAt: nextLinearDoneAttemptAt(current, now),
								expectedRetryCount: baselineRetryCount,
							});
							if (!fallback.ok)
								logFailure(operation.operation_id, fallback.reason);
						}
					} catch (error) {
						logFailure(operation.operation_id, error);
					}
					lastReason = fallbackReason;
				}

				try {
					const current = input.store.getLandOperation(operation.operation_id);
					if (
						current?.state === "completed" &&
						current.linear_done_disposition === "deferred"
					) {
						const deferredAt = Date.parse(
							current.linear_done_deferred_at ?? "",
						);
						const ageHours = Number.isFinite(deferredAt)
							? Math.max(
									0,
									Math.floor((now.getTime() - deferredAt) / 3_600_000),
								)
							: 0;
						if (ageHours >= 24 && input.onAgedDeferred) {
							await input.onAgedDeferred(current, {
								ageHours,
								dayBucket: nowIso.slice(0, 10),
								reason: lastReason,
							});
						}
					}
				} catch (error) {
					logFailure(operation.operation_id, error);
				}
			});
		} catch (error) {
			logFailure(candidate.operation_id, error);
		}
	}

	return { inspected: candidates.length, settled };
}
