import { createHash } from "node:crypto";
import type {
	StateStore,
	WorkflowRunCollectOutcome,
	WorkflowRunCollectReceiptRow,
} from "../StateStore.js";
import type { CloseRunnerResult } from "./close-runner.js";

const COLLECTION_LEASE_MS = 30_000;

export async function reconcileWorkflowRunCollections(input: {
	store: StateStore;
	collect?: (receiptKey: string) => Promise<unknown>;
	log?: (message: string) => void;
}): Promise<void> {
	const log = input.log ?? console.warn;
	if (input.collect) {
		for (const receipt of input.store.listOpenWorkflowRunCollections(2)) {
			try {
				await input.collect(receipt.receipt_key);
			} catch (error) {
				log(
					`[workflow-collection] collect ${receipt.receipt_key} failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}
	for (const residue of input.store.listTerminalWorkflowRunsWithResidue(2)) {
		try {
			const receiptKey = residue.receiptKey ?? null;
			const digest = createHash("sha256")
				.update(JSON.stringify([residue.executionIds, receiptKey]))
				.digest("hex");
			input.store.appendWorkflowRunEventChecked({
				runId: residue.runId,
				eventUid: `residue_sweep_note:${residue.runId}:${digest}`,
				kind: "residue_sweep_note",
				payload: {
					mode: "observe",
					executionIds: residue.executionIds,
					receiptKey,
				},
			});
			log(
				`[workflow-collection] observed terminal residue ${residue.runId}: ${residue.executionIds.join(",")}`,
			);
		} catch (error) {
			log(
				`[workflow-collection] residue ${residue.runId} failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

export async function collectWorkflowRunReceipt(input: {
	store: StateStore;
	receiptKey: string;
	ownerId: string;
	now?: () => Date;
	closeExecution: (
		executionId: string,
		authorityCheck: () => Promise<{ ok: boolean; reason?: string }>,
	) => Promise<CloseRunnerResult>;
}): Promise<WorkflowRunCollectReceiptRow> {
	const now = input.now ?? (() => new Date());
	const initial = input.store.getWorkflowRunCollectReceipt(input.receiptKey);
	if (!initial) throw new Error("workflow_run_collection_missing");
	if (initial.state === "responded") return initial;
	const claimNow = now();
	const claim = input.store.claimWorkflowRunCollection({
		receiptKey: input.receiptKey,
		ownerId: input.ownerId,
		now: claimNow.toISOString(),
		leaseExpiresAt: new Date(
			claimNow.getTime() + COLLECTION_LEASE_MS,
		).toISOString(),
	});
	if (claim.status !== "claimed") return claim.receipt ?? initial;
	const generation = claim.receipt.owner_generation!;
	const authorityCheck = async (): Promise<{
		ok: boolean;
		reason?: string;
	}> => {
		const checkedAt = now();
		const renewed = input.store.renewWorkflowRunCollectionLease({
			receiptKey: input.receiptKey,
			ownerId: input.ownerId,
			generation,
			now: checkedAt.toISOString(),
			leaseExpiresAt: new Date(
				checkedAt.getTime() + COLLECTION_LEASE_MS,
			).toISOString(),
		});
		return renewed.ok ? { ok: true } : { ok: false, reason: renewed.reason };
	};

	let receipt = claim.receipt;
	if (receipt.state === "collecting") {
		for (const executionId of receipt.targetExecutionIds) {
			if (
				receipt.outcomes.some(
					(outcome) =>
						outcome.executionId === executionId &&
						outcome.closed &&
						outcome.commDbFinalized,
				)
			) {
				continue;
			}
			if (!(await authorityCheck()).ok) {
				return input.store.getWorkflowRunCollectReceipt(input.receiptKey)!;
			}
			let close: CloseRunnerResult;
			try {
				close = await input.closeExecution(executionId, authorityCheck);
			} catch (error) {
				close = {
					closed: false,
					commDbFinalized: false,
					retiredGateCount: 0,
					error: error instanceof Error ? error.message : String(error),
				};
			}
			const outcome: WorkflowRunCollectOutcome = {
				executionId,
				closed: close.closed,
				commDbFinalized: close.commDbFinalized,
				retiredGateCount: close.retiredGateCount,
				...(close.alreadyGone ? { alreadyGone: true } : {}),
				...(close.error ? { error: close.error } : {}),
			};
			const recorded = input.store.recordWorkflowRunCollectionOutcome({
				receiptKey: input.receiptKey,
				ownerId: input.ownerId,
				generation,
				outcome,
				now: now().toISOString(),
			});
			if (!recorded.ok) {
				return input.store.getWorkflowRunCollectReceipt(input.receiptKey)!;
			}
			receipt = input.store.getWorkflowRunCollectReceipt(input.receiptKey)!;
		}
		const collected = input.store.markWorkflowRunCollectionCollected({
			receiptKey: input.receiptKey,
			ownerId: input.ownerId,
			generation,
			now: now().toISOString(),
		});
		if (!collected.ok) {
			return input.store.getWorkflowRunCollectReceipt(input.receiptKey)!;
		}
		receipt = input.store.getWorkflowRunCollectReceipt(input.receiptKey)!;
	}

	if (receipt.state === "collected") {
		const run = input.store.getWorkflowRun(receipt.run_id);
		const response = {
			success: true,
			runId: receipt.run_id,
			status: run?.status ?? "terminated",
			receiptKey: receipt.receipt_key,
			inProgress: false,
			snapshot: {
				targetExecutionIds: receipt.targetExecutionIds,
				outcomes: receipt.outcomes,
			},
		};
		input.store.respondWorkflowRunCollection({
			receiptKey: input.receiptKey,
			ownerId: input.ownerId,
			generation,
			response,
			now: now().toISOString(),
		});
	}
	return input.store.getWorkflowRunCollectReceipt(input.receiptKey)!;
}
