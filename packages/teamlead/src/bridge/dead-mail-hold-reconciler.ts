import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { CommDB } from "flywheel-comm/db";
import { StateStore, type WorkflowEngineAlertIdentity } from "../StateStore.js";
import { DELIVERY_MAINTENANCE_PAGE_SIZE } from "./delivery-contract/policy.js";

const LEGACY_DEAD_MAIL_RECONCILE_BUDGET_MS = 50;

export interface LegacyDeadMailboxHoldReconcileCursor {
	runId: string;
	eventSeq: number;
}

export interface LegacyDeadMailboxHoldReconcileResult {
	examined: number;
	staged: number;
	skipped: number;
	failed: number;
	nextCursor?: LegacyDeadMailboxHoldReconcileCursor;
}

export interface LegacyDeadMailboxHoldReconcileInput {
	store: StateStore;
	commDb: CommDB;
	projectName: string;
	now: string;
	cursor?: LegacyDeadMailboxHoldReconcileCursor;
	monotonicNow?: () => number;
	emitEvent?: (event: {
		event: "legacy_dead_mail_reconcile_pass";
		payload: Record<string, unknown>;
	}) => void;
	resolveAlertIdentity?: (input: {
		projectName: string;
		issueId: string;
		runId: string;
	}) => WorkflowEngineAlertIdentity;
}

export class LegacyDeadMailboxHoldReconcileScheduler {
	private readonly cursors = new Map<
		string,
		LegacyDeadMailboxHoldReconcileCursor
	>();

	runPass(
		input: Omit<LegacyDeadMailboxHoldReconcileInput, "cursor">,
	): LegacyDeadMailboxHoldReconcileResult {
		const result = reconcileLegacyDeadMailboxHolds({
			...input,
			cursor: this.cursors.get(input.projectName),
		});
		if (result.nextCursor) {
			this.cursors.set(input.projectName, result.nextCursor);
		} else {
			this.cursors.delete(input.projectName);
		}
		return result;
	}
}

export function reconcileLegacyDeadMailboxHolds(
	input: LegacyDeadMailboxHoldReconcileInput,
): LegacyDeadMailboxHoldReconcileResult {
	if (!input.projectName.trim() || !Number.isFinite(Date.parse(input.now))) {
		throw new Error("invalid_legacy_dead_mail_hold_reconcile_input");
	}
	const monotonicNow = input.monotonicNow ?? (() => performance.now());
	const startedAt = monotonicNow();
	const candidates = input.store.listLegacyDeadMailboxHoldReconcileCandidates(
		input.projectName,
		{
			cursor: input.cursor,
			deferEvaluation: true,
			limit: DELIVERY_MAINTENANCE_PAGE_SIZE,
		},
	);
	const result = {
		examined: 0,
		staged: 0,
		skipped: 0,
		failed: 0,
	};
	let budgetExhausted = false;
	let lastProcessed: { runId: string; eventSeq: number } | undefined;
	for (const evidence of candidates) {
		const elapsedMs = Math.max(0, monotonicNow() - startedAt);
		if (
			result.examined > 0 &&
			elapsedMs >= LEGACY_DEAD_MAIL_RECONCILE_BUDGET_MS
		) {
			budgetExhausted = true;
			break;
		}
		result.examined++;
		lastProcessed = {
			runId: evidence.runId,
			eventSeq: evidence.eventSeq,
		};
		const candidate =
			input.store.resolveLegacyDeadMailboxHoldReconcileCandidate(
				input.projectName,
				evidence,
			);
		if (!candidate.eligible) {
			if (
				candidate.reason === "reconcile_retry_exhausted" &&
				input.resolveAlertIdentity
			) {
				const run = input.store.getWorkflowRun(candidate.runId);
				if (run) {
					input.store.recordLegacyDeadMailboxHoldReconcileExhausted({
						runId: candidate.runId,
						holdEventUid: candidate.holdEventUid,
						attempts: candidate.resumeGeneration,
						now: input.now,
						alertIdentity: input.resolveAlertIdentity({
							projectName: run.project_name,
							issueId: run.issue_id,
							runId: candidate.runId,
						}),
					});
				}
			}
			result.skipped++;
			continue;
		}
		const sourceResolution = candidate.sourceResolution;
		if (sourceResolution === "live_attempt") {
			const physicalSource = input.commDb.getRunnerDeliveryProjectionRow(
				candidate.physicalId,
			);
			if (!physicalSource) {
				console.warn(
					`[delivery-contract] legacy dead-mail hold ${candidate.holdEventUid} has a live attempt but no runner mailbox projection`,
				);
				result.skipped++;
				continue;
			}
		}
		const clientRequestId = `fly2337:legacy:${createHash("sha256")
			.update(
				`${candidate.runId}\0${candidate.holdEventUid}\0${candidate.resumeGeneration}`,
			)
			.digest("hex")}`;
		const normalized = StateStore.canonicalizeHoldResume({
			runId: candidate.runId,
			shape: "delivery_undeliverable_no_recipient",
			holdEventUid: candidate.holdEventUid,
			decision: "cancel",
			reason: "fly2337_legacy_reconcile",
			principal: "master",
			clientRequestId,
		});
		if (!normalized) {
			console.warn(
				`[delivery-contract] legacy dead-mail hold ${candidate.holdEventUid} produced invalid canonical resume input`,
			);
			result.skipped++;
			continue;
		}
		const resumed = input.store.resumeWorkflowHold({
			canonical: normalized.canonical,
			digest: normalized.digest,
			now: input.now,
			sourceResolution,
			legacyReconcileProjectName: input.projectName,
		});
		if (!resumed.ok) {
			console.warn(
				`[delivery-contract] legacy dead-mail hold ${candidate.holdEventUid} resume refused: ${resumed.reason}`,
			);
			result.skipped++;
			continue;
		}
		if (resumed.state === "failed") {
			console.warn(
				`[delivery-contract] legacy dead-mail hold ${candidate.holdEventUid} replayed a failed resume operation`,
			);
			result.failed++;
			continue;
		}
		result.staged++;
	}
	const durationMs = Math.max(0, monotonicNow() - startedAt);
	const nextCursor =
		lastProcessed &&
		(budgetExhausted || candidates.length === DELIVERY_MAINTENANCE_PAGE_SIZE)
			? lastProcessed
			: undefined;
	const output: LegacyDeadMailboxHoldReconcileResult = {
		...result,
		...(nextCursor ? { nextCursor } : {}),
	};
	if (candidates.length > 0 || input.cursor) {
		input.emitEvent?.({
			event: "legacy_dead_mail_reconcile_pass",
			payload: {
				projectName: input.projectName,
				page: {
					limit: DELIVERY_MAINTENANCE_PAGE_SIZE,
					candidates: candidates.length,
				},
				call: {
					...result,
					durationMs,
					budgetMs: LEGACY_DEAD_MAIL_RECONCILE_BUDGET_MS,
					budgetExhausted,
				},
				cursor: input.cursor,
				nextCursor,
			},
		});
	}
	return output;
}
