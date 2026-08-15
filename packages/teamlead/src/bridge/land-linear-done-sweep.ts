import type { LandOperationRow, StateStore } from "../StateStore.js";
import {
	type LinearDoneFinalizer,
	raceMarkIssueDoneWithAbort,
} from "./linear-issue-finalizer.js";

type DeferredLinearDoneStore = Pick<
	StateStore,
	| "listDeferredLandLinearDone"
	| "getLandOperation"
	| "settleDeferredLandLinearDone"
>;

export interface DeferredLinearDoneSweepReport {
	inspected: number;
	settled: number;
}

function authorityRefusesLinearWrite(reason: string): boolean {
	return (
		reason === "founder_parked" ||
		reason === "canceled_observation" ||
		reason === "canceled_fresh_linear"
	);
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
	const candidates = input.store.listDeferredLandLinearDone(10);
	let settled = 0;

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
						const result = input.store.settleDeferredLandLinearDone({
							operationId: operation.operation_id,
							disposition: "canceled_refused",
							reason: arbitration.reason,
							now: nowIso,
						});
						if (result.ok) settled += 1;
					}
					return;
				}

				let reason = "linear_finalizer_unavailable";
				if (input.markIssueDone) {
					const result = await raceMarkIssueDoneWithAbort(
						input.markIssueDone,
						operation.issue_id,
						undefined,
					);
					reason =
						result.reason ?? (result.done ? "done" : "linear_done_failed");
					const disposition = result.done
						? "done"
						: result.reason === "issue_canceled_never_overwritten"
							? "canceled_refused"
							: undefined;
					if (disposition) {
						const settlement = input.store.settleDeferredLandLinearDone({
							operationId: operation.operation_id,
							disposition,
							reason,
							now: nowIso,
						});
						if (settlement.ok) settled += 1;
						return;
					}
				}

				const deferredAt = Date.parse(operation.linear_done_deferred_at ?? "");
				const ageHours = Number.isFinite(deferredAt)
					? Math.max(0, Math.floor((now.getTime() - deferredAt) / 3_600_000))
					: 0;
				if (ageHours >= 24 && input.onAgedDeferred) {
					await input.onAgedDeferred(operation, {
						ageHours,
						dayBucket: nowIso.slice(0, 10),
						reason,
					});
				}
			});
		} catch (error) {
			(input.log ?? console.warn)(
				`[land] deferred Linear Done candidate ${candidate.operation_id} failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	return { inspected: candidates.length, settled };
}
