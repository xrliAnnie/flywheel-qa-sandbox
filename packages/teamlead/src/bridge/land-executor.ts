import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
	LandOperationClaim,
	LandOperationRow,
	StateStore,
} from "../StateStore.js";
import { parseWorkflowRunSnapshot } from "../workflow-run-snapshot.js";
import {
	isWorkflowManifestLand,
	workflowApprovalGate,
	workflowTerminalNode,
} from "../workflow-template.js";
import { evaluateWorkflowFounderReviewPrecondition } from "./founder-review-authority.js";
import {
	classifyLandFailure,
	extractBoundedFailedStepLog,
} from "./land-failure-classifier.js";
import type { CleanBaseMergeProof } from "./land-head-refresh-proof.js";
import { classifyLandRetryReason } from "./land-retry-policy.js";
import { computeAuthoritativeShipDecision } from "./merge-ship-gate.js";

const execFileAsync = promisify(execFile);
const COOL_COMMENT_CLOCK_SKEW_MS = 5_000;
const AMBIGUOUS_COOL_FENCE_HORIZON_MS = 15 * 60_000;
// The ship job itself may run for 30 minutes. A second approved PR waiting on a
// healthy sent attempt is ordinary queueing, so leave propagation headroom
// before escalating a genuinely stuck repo-wide fence.
const LAND_QUEUE_FENCE_HORIZON_MS = 45 * 60_000;

export interface LandPrState {
	state: "OPEN" | "MERGED" | "CLOSED";
	headSha: string;
	baseSha?: string;
	mergeSha?: string;
	mergeable?: string | null;
	mergeStateStatus?: string | null;
	isDraft?: boolean;
	reviewDecision?: string | null;
	checks?: Array<{ status?: string | null; conclusion?: string | null }>;
}

export type LandWorkflowState =
	| { state: "pending"; runId?: string; runUrl?: string }
	| {
			state: "failed";
			runId?: string;
			runUrl?: string;
			reason: string;
			conclusion?: string;
			structuredReason?: string;
			failedStep?: { number: number; name: string };
			failedStepLog?: string;
	  }
	| { state: "succeeded"; runId?: string; runUrl?: string };

export type LandPreparedCoolAttemptInspection =
	| { status: "found"; commentId: string }
	| { status: "absent"; observedAt: string }
	| { status: "pending" };

export interface LandMergeDriver {
	inspectPr(input: {
		projectName: string;
		prNumber: number;
	}): Promise<LandPrState>;
	requestBaseRefresh?(input: {
		projectName: string;
		prNumber: number;
		expectedHeadSha: string;
	}): Promise<LandBaseRefreshResult>;
	triggerCool(input: {
		projectName: string;
		prNumber: number;
		operationId: string;
		headSha: string;
	}): Promise<{ commentId: string; commentUrl?: string }>;
	inspectPreparedCoolAttempt?(input: {
		projectName: string;
		prNumber: number;
		headSha: string;
		preparedAt: string;
		now: string;
	}): Promise<LandPreparedCoolAttemptInspection>;
	inspectTriggeredWorkflow(input: {
		projectName: string;
		prNumber: number;
		triggerCommentId: string;
		headSha: string;
	}): Promise<LandWorkflowState>;
}

export type LandBaseRefreshResult =
	| { status: "accepted" }
	| { status: "head_moved"; observedHeadSha: string }
	| { status: "conflict" }
	| { status: "policy_blocked" }
	| { status: "external_outage" }
	| { status: "unknown"; detail: string };

export interface LandClosureReport {
	complete: boolean;
	outcome: "completed" | "partial" | "held";
	reason?: string;
	details?: Record<string, unknown>;
}

export type LandThreadNotificationDisposition =
	| "posted"
	| "suppressed_archived"
	| "covered_by_terminal_notification";

export interface LandThreadNotificationResult {
	disposition: LandThreadNotificationDisposition;
}

/** No land narrative may write after archive; completed is owned by finalization. */
export function landThreadNotificationPreflight(
	stage: string,
	archivedAt: string | null | undefined,
): Exclude<LandThreadNotificationDisposition, "posted"> | undefined {
	if (stage === "completed") return "covered_by_terminal_notification";
	if (archivedAt) return "suppressed_archived";
	return undefined;
}

export interface LandExecutorDeps {
	store: StateStore;
	mergeDriver: LandMergeDriver;
	headRefreshProver?: {
		prove(input: {
			projectName: string;
			prNumber: number;
			approvedHead: string;
			baseOid: string;
			candidateHead: string;
		}): Promise<CleanBaseMergeProof>;
	};
	carryEquivalentHead?: (input: {
		operation: LandOperationRow;
		claim: LandOperationClaim;
		proof: Extract<CleanBaseMergeProof, { ok: true }>;
		now: string;
	}) =>
		| {
				ok: true;
				operation: LandOperationRow;
				receiptId?: string;
				ordinal?: number;
		  }
		| { ok: false; reason: string }
		| Promise<
				| {
						ok: true;
						operation: LandOperationRow;
						receiptId?: string;
						ordinal?: number;
				  }
				| { ok: false; reason: string }
		  >;
	recordCarryoverDepartureCutoff?: (input: {
		operation: LandOperationRow;
		receiptId: string;
		ordinal: number;
		at: string;
	}) => Promise<void> | void;
	openConflictRework?: (input: {
		operation: LandOperationRow;
		claim: LandOperationClaim;
		proofStep: string;
		reason: "merge_conflict_requires_rework";
		now: string;
	}) =>
		| { ok: true; requestId: string }
		| { ok: false; reason: string }
		| Promise<{ ok: true; requestId: string } | { ok: false; reason: string }>;
	finalize(operation: LandOperationRow): Promise<LandClosureReport>;
	requestCleanup?: (operation: LandOperationRow) => Promise<{
		requested: number;
		acked: number;
		timedOut: number;
	}>;
	notify?: (
		operation: LandOperationRow,
		stage: string,
		detail: Record<string, unknown>,
	) =>
		| Promise<LandThreadNotificationResult | undefined>
		| LandThreadNotificationResult
		| undefined;
	authorize?: (
		operation: LandOperationRow,
	) =>
		| { ok: true }
		| { ok: false; reason: string; retryable?: boolean }
		| Promise<
				{ ok: true } | { ok: false; reason: string; retryable?: boolean }
		  >;
	now?: () => Date;
	ownerId?: string;
	leaseMs?: number;
}

export type LandExecutionResult =
	| { status: "completed"; operationId: string }
	| { status: "busy"; operationId: string }
	| { status: "superseded"; operationId: string; nextOperationId: string }
	| { status: "rework"; operationId: string; requestId: string }
	| { status: "partial"; operationId: string; reason: string }
	| { status: "held"; operationId: string; reason: string };

export async function resumeHeldLandOperation(
	input: { operationId: string; actor: string; reason: string },
	deps: Pick<LandExecutorDeps, "store" | "mergeDriver"> & { now?: () => Date },
): Promise<
	{ ok: true; operation: LandOperationRow } | { ok: false; reason: string }
> {
	const operation = deps.store.getLandOperation(input.operationId);
	if (!operation) return { ok: false, reason: "resume_refused:not_found" };
	if (operation.state !== "held") {
		return { ok: false, reason: "resume_refused:not_held" };
	}
	let pr: LandPrState;
	try {
		pr = await deps.mergeDriver.inspectPr({
			projectName: operation.project_name,
			prNumber: operation.pr_number,
		});
	} catch (error) {
		return {
			ok: false,
			reason:
				`resume_refused:pr_inspection_failed:${error instanceof Error ? error.message : String(error)}`.slice(
					0,
					500,
				),
		};
	}
	if (pr.headSha.toLowerCase() !== operation.approved_head.toLowerCase()) {
		return { ok: false, reason: "resume_refused:pr_head_mismatch" };
	}
	if (pr.state === "CLOSED") {
		return { ok: false, reason: "resume_refused:pr_closed_unmerged" };
	}
	return deps.store.resumeHeldLandOperation({
		operationId: input.operationId,
		actor: input.actor,
		reason: input.reason,
		now: (deps.now ?? (() => new Date()))().toISOString(),
		expectedPrDisposition: pr.state === "MERGED" ? "merged" : "open",
		expectedHeadSha: pr.headSha,
	});
}

function stepReceipt(
	store: StateStore,
	operationId: string,
	step: string,
): Record<string, unknown> | undefined {
	return store
		.listLandOperationSteps(operationId)
		.find((candidate) => candidate.step === step)?.receipt;
}

function coolTriggerReceipt(
	store: StateStore,
	operation: LandOperationRow,
): { step: string; receipt?: Record<string, unknown> } {
	const step = `cool_triggered:attempt=${operation.ship_attempt}`;
	const receipt = stepReceipt(store, operation.operation_id, step);
	if (receipt || operation.ship_attempt !== 0) return { step, receipt };
	return {
		step,
		receipt: stepReceipt(store, operation.operation_id, "cool_triggered"),
	};
}

async function authorizeLandOperation(
	store: StateStore,
	operation: LandOperationRow,
): Promise<{ ok: true } | { ok: false; reason: string; retryable?: boolean }> {
	if (!operation.run_id) {
		const candidates = store
			.getSessionsByIssue(operation.issue_id)
			.filter(
				(session) =>
					session.project_name === operation.project_name &&
					session.pr_number === operation.pr_number &&
					session.pr_head_sha?.toLowerCase() === operation.approved_head,
			)
			.sort((left, right) =>
				left.status === "approved_to_ship"
					? -1
					: right.status === "approved_to_ship"
						? 1
						: String(right.last_activity_at ?? "").localeCompare(
								String(left.last_activity_at ?? ""),
							),
			);
		const source = candidates[0];
		if (!source) return { ok: false, reason: "legacy_authority_unavailable" };
		const decision = await computeAuthoritativeShipDecision(
			store,
			source,
			operation.approved_head,
		);
		return decision.eligible
			? { ok: true }
			: {
					ok: false,
					reason: `legacy_ship_authority:${decision.mergeReason}/${decision.qaReason}`,
				};
	}
	const run = store.getWorkflowRun(operation.run_id);
	if (!run?.snapshot || run.engine_owned !== 1) {
		return { ok: false, reason: "engine_run_unavailable" };
	}
	let snapshot: ReturnType<typeof parseWorkflowRunSnapshot>;
	try {
		snapshot = parseWorkflowRunSnapshot(run.snapshot);
	} catch {
		return { ok: false, reason: "snapshot_invalid" };
	}
	if (!isWorkflowManifestLand(snapshot.manifest)) {
		return { ok: false, reason: "land_manifest_required" };
	}
	if (
		run.status !== "active" ||
		run.current_node_id !== workflowTerminalNode(snapshot.manifest)
	) {
		return { ok: false, reason: "land_target_not_current" };
	}
	const holder = store.getCurrentWorkflowGateHolder(
		operation.run_id,
		workflowApprovalGate(snapshot.manifest).node,
	);
	if (!holder || holder.state !== "approved") {
		return {
			ok: false,
			reason: "founder_projection_pending",
			retryable: true,
		};
	}
	if (holder.head_sha !== operation.approved_head) {
		return { ok: false, reason: "approved_head_mismatch" };
	}
	if (
		store.hasWorkflowResumeRedispatchAfter(operation.run_id, holder.created_at)
	) {
		return { ok: false, reason: "resume_admission_changed" };
	}
	const exactHeadAuthority = store.resolveWorkflowExactHeadAuthority({
		runId: operation.run_id,
		headSha: holder.head_sha,
	});
	if (
		!exactHeadAuthority.valid ||
		exactHeadAuthority.binding.pr_number !== operation.pr_number
	) {
		return { ok: false, reason: "approved_pr_mismatch" };
	}
	const prBinding = exactHeadAuthority.binding;
	if (prBinding.target_repo_identity !== "__main__") {
		return { ok: false, reason: "nested_land_unsupported" };
	}
	const founderReview = await evaluateWorkflowFounderReviewPrecondition({
		store,
		runId: operation.run_id,
		projectName: operation.project_name,
		snapshot,
		head: operation.approved_head,
	});
	if (!founderReview.eligible) {
		return {
			ok: false,
			reason: founderReview.reason,
			retryable: true,
		};
	}
	const claims = store.resolveEngineWorkflowShipClaims({
		runId: operation.run_id,
		subjectDigest: operation.approved_head,
	});
	return claims.valid
		? { ok: true }
		: { ok: false, reason: `workflow_ship_claims:${claims.reason}` };
}

async function authorizeLandEffect(
	deps: LandExecutorDeps,
	operation: LandOperationRow,
	claim: LandOperationClaim,
): Promise<{ ok: true } | { ok: false; reason: string; retryable?: boolean }> {
	const authorization = await (
		deps.authorize ?? ((op) => authorizeLandOperation(deps.store, op))
	)(operation);
	if (!authorization.ok) return authorization;
	return deps.store.isCurrentLandOperationClaim({
		operation,
		claim,
		now: (deps.now?.() ?? new Date()).toISOString(),
	})
		? { ok: true }
		: { ok: false, reason: "stale_land_generation" };
}

function recordStep(
	deps: LandExecutorDeps,
	operation: LandOperationRow,
	claim: LandOperationClaim,
	step: string,
	receipt: Record<string, unknown>,
	now: string,
): void {
	const recorded = deps.store.recordLandOperationStep({
		operationId: operation.operation_id,
		ownerId: claim.ownerId,
		generation: claim.generation,
		step,
		receipt,
		now,
	});
	if (!recorded.ok) throw new Error(recorded.reason);
}

async function announce(
	deps: LandExecutorDeps,
	operation: LandOperationRow,
	claim: LandOperationClaim,
	stage: string,
	detail: Record<string, unknown>,
	now: string,
): Promise<void> {
	if (!deps.notify) return;
	const receiptStep = `notification:${stage}`;
	if (stepReceipt(deps.store, operation.operation_id, receiptStep)) return;
	const notified = await deps.notify(operation, stage, detail);
	const disposition = notified?.disposition ?? "posted";
	recordStep(
		deps,
		operation,
		claim,
		receiptStep,
		{ delivered: disposition === "posted", disposition, stage },
		now,
	);
}

function release(
	deps: LandExecutorDeps,
	operation: LandOperationRow,
	claim: LandOperationClaim,
	state: "partial" | "held",
	reason: string,
	now: string,
): LandExecutionResult {
	const released = deps.store.releaseLandOperationWithRetryAccounting({
		operationId: operation.operation_id,
		ownerId: claim.ownerId,
		generation: claim.generation,
		class: state === "held" ? "terminal" : classifyLandRetryReason(reason),
		reason,
		now,
	});
	if (!released) {
		const current = deps.store.getLandOperation(operation.operation_id);
		if (current?.superseded_at && current.superseded_by_operation_id) {
			return {
				status: "superseded",
				operationId: operation.operation_id,
				nextOperationId: current.superseded_by_operation_id,
			};
		}
		if (current?.state === "completed") {
			return { status: "completed", operationId: operation.operation_id };
		}
		if (current?.state === "held") {
			return {
				status: "held",
				operationId: operation.operation_id,
				reason: current.last_error ?? reason,
			};
		}
		return { status: "busy", operationId: operation.operation_id };
	}
	return {
		status: released.state,
		operationId: operation.operation_id,
		reason: released.lastError,
	};
}

async function carryEquivalentLandHead(
	deps: LandExecutorDeps,
	operation: LandOperationRow,
	claim: LandOperationClaim,
	proof: Extract<CleanBaseMergeProof, { ok: true }>,
	now: string,
): Promise<
	{ ok: true; operation: LandOperationRow } | { ok: false; reason: string }
> {
	let carried:
		| {
				ok: true;
				operation: LandOperationRow;
				receiptId?: string;
				ordinal?: number;
		  }
		| { ok: false; reason: string };
	if (deps.carryEquivalentHead) {
		carried = await deps.carryEquivalentHead({ operation, claim, proof, now });
	} else {
		if (!operation.run_id) {
			return { ok: false, reason: "carryover_engine_run_required" };
		}
		const run = deps.store.getWorkflowRun(operation.run_id);
		if (!run?.snapshot)
			return { ok: false, reason: "carryover_run_unavailable" };
		let snapshot: ReturnType<typeof parseWorkflowRunSnapshot>;
		try {
			snapshot = parseWorkflowRunSnapshot(run.snapshot);
		} catch {
			return { ok: false, reason: "carryover_snapshot_invalid" };
		}
		const gateNodeId = workflowApprovalGate(snapshot.manifest).node;
		const holder = deps.store.getCurrentWorkflowGateHolder(
			operation.run_id,
			gateNodeId,
		);
		if (!holder || holder.state !== "approved") {
			return { ok: false, reason: "carryover_holder_unavailable" };
		}
		const { ok: _proofOk, ...verifiedProof } = proof;
		const committed = deps.store.commitEquivalentHeadCarryover({
			runId: operation.run_id,
			gateNodeId,
			fromQuestionId: holder.question_id,
			operationId: operation.operation_id,
			ownerId: claim.ownerId,
			generation: claim.generation,
			proof: verifiedProof,
			now,
		});
		carried = committed.ok
			? {
					ok: true,
					operation: committed.operation,
					receiptId: committed.receiptId,
					ordinal: committed.ordinal,
				}
			: { ok: false, reason: committed.reason };
	}
	if (!carried.ok) return carried;
	if (
		deps.recordCarryoverDepartureCutoff &&
		carried.receiptId &&
		carried.ordinal !== undefined
	) {
		await deps.recordCarryoverDepartureCutoff({
			operation: carried.operation,
			receiptId: carried.receiptId,
			ordinal: carried.ordinal,
			at: now,
		});
	}
	return { ok: true, operation: carried.operation };
}

async function openConflictRework(
	deps: LandExecutorDeps,
	operation: LandOperationRow,
	claim: LandOperationClaim,
	proofStep: string,
	now: string,
): Promise<LandExecutionResult> {
	const opened = deps.openConflictRework
		? await deps.openConflictRework({
				operation,
				claim,
				proofStep,
				reason: "merge_conflict_requires_rework",
				now,
			})
		: operation.run_id
			? deps.store.openEngineLandConflictRework({
					runId: operation.run_id,
					operationId: operation.operation_id,
					ownerId: claim.ownerId,
					generation: claim.generation,
					proofStep,
					reason: "merge_conflict_requires_rework",
					now,
				})
			: { ok: false as const, reason: "engine_land_rework_run_required" };
	if (opened.ok) {
		try {
			await deps.notify?.(operation, "conflict_rework_started", {
				requestId: opened.requestId,
				approvedHead: operation.approved_head,
				requiresQaRetest: true,
				requiresFreshApproval: true,
			});
		} catch {
			// The rework transaction has already revoked the old approval and moved
			// the run back to implement. Visibility failure must not resurrect or
			// strand that obsolete land generation; the Lead alert outbox is written
			// before the best-effort issue-thread delivery by the production notifier.
		}
		return {
			status: "rework",
			operationId: operation.operation_id,
			requestId: opened.requestId,
		};
	}
	if (opened.reason === "engine_land_rework_cycle_limit") {
		return release(deps, operation, claim, "held", opened.reason, now);
	}
	return release(
		deps,
		operation,
		claim,
		"partial",
		`merge_conflict_rework_pending:${opened.reason}`,
		now,
	);
}

function landRecoveryRootApprovalRef(
	store: StateStore,
	operation: LandOperationRow,
): string {
	if (!operation.run_id) return operation.approved_head;
	const authority = store.resolveWorkflowExactHeadAuthority({
		runId: operation.run_id,
		headSha: operation.approved_head,
	});
	return authority.valid ? authority.rootHead : operation.approved_head;
}

function touchAlignmentEpisode(
	store: StateStore,
	operation: LandOperationRow,
	now: string,
): { horizonExceeded: boolean } {
	if (!operation.run_id) return { horizonExceeded: false };
	const rootApprovalRef = landRecoveryRootApprovalRef(store, operation);
	const existing = store.getOpenLandRecoveryEpisode({
		runId: operation.run_id,
		rootApprovalRef,
		kind: "alignment",
	});
	const episode = store.openLandRecoveryEpisode({
		runId: operation.run_id,
		rootApprovalRef,
		kind: "alignment",
		currentOperationId: operation.operation_id,
		firstObservedAt: existing?.first_observed_at ?? now,
		lastProbeAt: now,
	});
	return {
		horizonExceeded:
			Date.parse(now) - Date.parse(episode.first_observed_at) >=
			24 * 60 * 60_000,
	};
}

function closeAlignmentEpisode(
	store: StateStore,
	operation: LandOperationRow,
	now: string,
): void {
	if (!operation.run_id) return;
	const episode = store.getOpenLandRecoveryEpisode({
		runId: operation.run_id,
		rootApprovalRef: landRecoveryRootApprovalRef(store, operation),
		kind: "alignment",
	});
	if (episode) {
		store.closeLandRecoveryEpisode({
			episodeId: episode.episode_id,
			closedReason: "head_aligned",
			now,
		});
	}
}

function touchPolicyEpisode(
	store: StateStore,
	operation: LandOperationRow,
	reason: string,
	now: string,
): { firstObservedAt: string; horizonExceeded: boolean } {
	if (!operation.run_id) {
		return { firstObservedAt: now, horizonExceeded: false };
	}
	const rootApprovalRef = landRecoveryRootApprovalRef(store, operation);
	const existing = store.getOpenLandRecoveryEpisode({
		runId: operation.run_id,
		rootApprovalRef,
		kind: "policy",
		scopeKey: reason,
	});
	const episode = store.openLandRecoveryEpisode({
		runId: operation.run_id,
		rootApprovalRef,
		kind: "policy",
		scopeKey: reason,
		currentOperationId: operation.operation_id,
		firstObservedAt: existing?.first_observed_at ?? now,
		lastProbeAt: now,
	});
	return {
		firstObservedAt: episode.first_observed_at,
		horizonExceeded:
			Date.parse(now) - Date.parse(episode.first_observed_at) >=
			24 * 60 * 60_000,
	};
}

function closePolicyEpisodes(
	store: StateStore,
	operation: LandOperationRow,
	now: string,
): void {
	if (!operation.run_id) return;
	const rootApprovalRef = landRecoveryRootApprovalRef(store, operation);
	for (const scopeKey of ["mergeability_pending", "policy_alignment_pending"]) {
		const episode = store.getOpenLandRecoveryEpisode({
			runId: operation.run_id,
			rootApprovalRef,
			kind: "policy",
			scopeKey,
		});
		if (episode) {
			store.closeLandRecoveryEpisode({
				episodeId: episode.episode_id,
				closedReason: "policy_aligned",
				now,
			});
		}
	}
}

class ExternalLandProbeFailure extends Error {
	constructor(
		readonly scope: string,
		detail: string,
	) {
		super(detail);
		this.name = "ExternalLandProbeFailure";
	}
}

function closeScopedRecoveryEpisode(
	store: StateStore,
	operation: LandOperationRow,
	kind: "outage" | "refire",
	scopeKey: string,
	closedReason: string,
	now: string,
): void {
	if (!operation.run_id) return;
	const episode = store.getOpenLandRecoveryEpisode({
		runId: operation.run_id,
		rootApprovalRef: landRecoveryRootApprovalRef(store, operation),
		kind,
		scopeKey,
	});
	if (episode) {
		store.closeLandRecoveryEpisode({
			episodeId: episode.episode_id,
			closedReason,
			now,
		});
	}
}

async function runExternalLandProbe<T>(
	deps: LandExecutorDeps,
	operation: LandOperationRow,
	scope: string,
	now: string,
	probe: () => Promise<T>,
): Promise<T> {
	try {
		const result = await probe();
		closeScopedRecoveryEpisode(
			deps.store,
			operation,
			"outage",
			scope,
			"probe_recovered",
			now,
		);
		return result;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		if (isExternalLandProbeError(detail)) {
			throw new ExternalLandProbeFailure(scope, detail);
		}
		throw error;
	}
}

async function releaseExternalOutage(
	deps: LandExecutorDeps,
	operation: LandOperationRow,
	claim: LandOperationClaim,
	scope: string,
	detail: string,
	now: string,
): Promise<LandExecutionResult> {
	if (!operation.run_id) {
		return release(
			deps,
			operation,
			claim,
			"partial",
			`external_probe_failed:${scope}:${detail}`,
			now,
		);
	}
	const rootApprovalRef = landRecoveryRootApprovalRef(deps.store, operation);
	const existing = deps.store.getOpenLandRecoveryEpisode({
		runId: operation.run_id,
		rootApprovalRef,
		kind: "outage",
		scopeKey: scope,
	});
	const alertUid = `land-outage:${operation.operation_id}:${scope}`;
	const episode = deps.store.openLandRecoveryEpisode({
		runId: operation.run_id,
		rootApprovalRef,
		kind: "outage",
		scopeKey: scope,
		currentOperationId: operation.operation_id,
		firstObservedAt: existing?.first_observed_at ?? now,
		lastProbeAt: now,
		nextProbeAt: new Date(Date.parse(now) + 5 * 60_000).toISOString(),
		alertUid,
	});
	const ageMs = Date.parse(now) - Date.parse(episode.first_observed_at);
	const notificationDetail = {
		scope,
		firstObservedAt: episode.first_observed_at,
		lastError: detail,
		escalationUid: alertUid,
	};
	if (ageMs >= 2 * 60 * 60_000) {
		await announce(
			deps,
			operation,
			claim,
			"external_outage_fyi",
			notificationDetail,
			now,
		);
	}
	if (ageMs >= 24 * 60 * 60_000) {
		await announce(
			deps,
			operation,
			claim,
			"external_outage_horizon_exceeded",
			notificationDetail,
			now,
		);
		return release(
			deps,
			operation,
			claim,
			"held",
			"external_outage_horizon_exceeded",
			now,
		);
	}
	return release(deps, operation, claim, "partial", "external_outage", now);
}

async function releaseCoolFenceWait(
	deps: LandExecutorDeps,
	operation: LandOperationRow,
	claim: LandOperationClaim,
	scope: string,
	reason: "ambiguous_cool_reconcile_pending" | "land_queue_busy",
	now: string,
): Promise<LandExecutionResult> {
	if (!operation.run_id) {
		return release(deps, operation, claim, "partial", reason, now);
	}
	const rootApprovalRef = landRecoveryRootApprovalRef(deps.store, operation);
	const existing = deps.store.getOpenLandRecoveryEpisode({
		runId: operation.run_id,
		rootApprovalRef,
		kind: "refire",
		scopeKey: scope,
	});
	const episode = deps.store.openLandRecoveryEpisode({
		runId: operation.run_id,
		rootApprovalRef,
		kind: "refire",
		scopeKey: scope,
		currentOperationId: operation.operation_id,
		firstObservedAt: existing?.first_observed_at ?? now,
		lastProbeAt: now,
		nextProbeAt: new Date(Date.parse(now) + 60_000).toISOString(),
		alertUid: `land-cool-fence:${operation.operation_id}:${scope}`,
	});
	const horizonMs =
		reason === "land_queue_busy"
			? LAND_QUEUE_FENCE_HORIZON_MS
			: AMBIGUOUS_COOL_FENCE_HORIZON_MS;
	if (Date.parse(now) - Date.parse(episode.first_observed_at) < horizonMs) {
		return release(deps, operation, claim, "partial", reason, now);
	}
	await announce(
		deps,
		operation,
		claim,
		"cool_fence_horizon_exceeded",
		{
			scope,
			reason,
			firstObservedAt: episode.first_observed_at,
			escalationUid: episode.alert_uid,
		},
		now,
	);
	return release(
		deps,
		operation,
		claim,
		"held",
		"cool_fence_horizon_exceeded",
		now,
	);
}

async function rejectUnauthorizedLandEffect(
	deps: LandExecutorDeps,
	operation: LandOperationRow,
	claim: LandOperationClaim,
	now: string,
): Promise<LandExecutionResult | undefined> {
	const authorization = await authorizeLandEffect(deps, operation, claim);
	return authorization.ok
		? undefined
		: release(
				deps,
				operation,
				claim,
				authorization.retryable ? "partial" : "held",
				authorization.reason,
				now,
			);
}

/**
 * Advance one engine-owned land operation by durable receipts. A pending
 * sanctioned workflow intentionally yields `partial` and releases the lease;
 * the dispatcher retries it on its next reconciliation tick.
 */
export async function executeLandOperation(
	operationId: string,
	deps: LandExecutorDeps,
): Promise<LandExecutionResult> {
	let operation = deps.store.getLandOperation(operationId);
	if (!operation) throw new Error("land_operation_not_found");
	if (operation.superseded_at && operation.superseded_by_operation_id) {
		return {
			status: "superseded",
			operationId,
			nextOperationId: operation.superseded_by_operation_id,
		};
	}
	if (operation.state === "completed") {
		return { status: "completed", operationId };
	}
	if (operation.state === "held") {
		return {
			status: "held",
			operationId,
			reason: operation.last_error ?? "land_operation_held",
		};
	}
	const nowDate = deps.now?.() ?? new Date();
	const now = nowDate.toISOString();
	const claim = deps.store.claimLandOperation({
		operationId,
		ownerId: deps.ownerId ?? `land-engine:${process.pid}`,
		now,
		leaseExpiresAt: new Date(
			nowDate.getTime() + (deps.leaseMs ?? 60 * 60_000),
		).toISOString(),
	});
	if (!claim) return { status: "busy", operationId };
	operation = deps.store.getLandOperation(operationId)!;
	try {
		const authorization = await authorizeLandEffect(deps, operation, claim);
		if (!authorization.ok) {
			return release(
				deps,
				operation,
				claim,
				authorization.retryable ? "partial" : "held",
				authorization.reason,
				now,
			);
		}
		if (!stepReceipt(deps.store, operationId, "authority_verified")) {
			recordStep(
				deps,
				operation,
				claim,
				"authority_verified",
				{
					approvedHead: operation.approved_head,
					prNumber: operation.pr_number,
				},
				now,
			);
		}
		await announce(
			deps,
			operation,
			claim,
			"activated",
			{
				approvedHead: operation.approved_head,
				prNumber: operation.pr_number,
			},
			now,
		);
		if (operation.carryover_receipt_id) {
			const authority = operation.run_id
				? deps.store.resolveWorkflowExactHeadAuthority({
						runId: operation.run_id,
						headSha: operation.approved_head,
					})
				: undefined;
			await announce(
				deps,
				operation,
				claim,
				"head_refresh_equivalent",
				{
					approvedHead:
						authority?.valid === true
							? authority.rootHead
							: operation.approved_head,
					refreshedHead: operation.approved_head,
					approvalContinues: true,
				},
				now,
			);
		}

		let pr = await runExternalLandProbe(
			deps,
			operation,
			"inspect_pr",
			now,
			() =>
				deps.mergeDriver.inspectPr({
					projectName: operation.project_name,
					prNumber: operation.pr_number,
				}),
		);
		if (pr.headSha.toLowerCase() !== operation.approved_head) {
			const alignment = touchAlignmentEpisode(deps.store, operation, now);
			const candidateHead = pr.headSha.toLowerCase();
			const requestedRefreshReceipt = stepReceipt(
				deps.store,
				operationId,
				"base_refresh_requested",
			);
			const preparedRefreshReceipt = stepReceipt(
				deps.store,
				operationId,
				"base_refresh_prepared",
			);
			const alignmentProofStep = `alignment_observed:${candidateHead}`;
			const alignmentReceipt = stepReceipt(
				deps.store,
				operationId,
				alignmentProofStep,
			);
			const refreshReceipt =
				requestedRefreshReceipt ?? preparedRefreshReceipt ?? alignmentReceipt;
			const effectiveProofStep = requestedRefreshReceipt
				? "base_refresh_requested"
				: preparedRefreshReceipt
					? "base_refresh_prepared"
					: alignmentProofStep;
			const refreshBase = String(
				refreshReceipt?.baseOid ?? pr.baseSha ?? "",
			).toLowerCase();
			if (
				!refreshReceipt &&
				/^[0-9a-f]{40}$/.test(refreshBase) &&
				/^[0-9a-f]{40}$/.test(candidateHead)
			) {
				recordStep(
					deps,
					operation,
					claim,
					alignmentProofStep,
					{
						approvedHead: operation.approved_head,
						candidateHead,
						baseOid: refreshBase,
					},
					now,
				);
				if (alignment.horizonExceeded) {
					return release(
						deps,
						operation,
						claim,
						"held",
						"head_alignment_horizon_exceeded",
						now,
					);
				}
				return release(
					deps,
					operation,
					claim,
					"partial",
					"head_alignment_pending",
					now,
				);
			}
			if (
				deps.headRefreshProver &&
				refreshReceipt?.approvedHead === operation.approved_head &&
				/^[0-9a-f]{40}$/.test(refreshBase)
			) {
				const proof = await runExternalLandProbe(
					deps,
					operation,
					"head_refresh_proof",
					now,
					() =>
						deps.headRefreshProver!.prove({
							projectName: operation.project_name,
							prNumber: operation.pr_number,
							approvedHead: operation.approved_head,
							baseOid: refreshBase,
							candidateHead,
						}),
				);
				if (proof.ok) {
					const carried = await carryEquivalentLandHead(
						deps,
						operation,
						claim,
						proof,
						now,
					);
					if (carried.ok) {
						return {
							status: "superseded",
							operationId,
							nextOperationId: carried.operation.operation_id,
						};
					}
					if (
						carried.reason === "carryover_lineage_limit" ||
						carried.reason.startsWith("carryover_")
					) {
						return openConflictRework(
							deps,
							operation,
							claim,
							effectiveProofStep,
							now,
						);
					}
					return release(
						deps,
						operation,
						claim,
						"partial",
						carried.reason === "carryover_lineage_limit"
							? "merge_conflict_requires_rework"
							: "head_alignment_pending",
						now,
					);
				}
				if (
					proof.reason === "parent_identity_mismatch" ||
					proof.reason === "tree_identity_mismatch"
				) {
					return openConflictRework(
						deps,
						operation,
						claim,
						effectiveProofStep,
						now,
					);
				}
				if (
					proof.reason === "invalid_proof_input" ||
					proof.reason === "uncontrolled_merge_config"
				) {
					return release(
						deps,
						operation,
						claim,
						"held",
						"head_equivalence_proof_untrusted",
						now,
					);
				}
				if (!alignment.horizonExceeded) {
					return releaseExternalOutage(
						deps,
						operation,
						claim,
						"head_refresh_proof",
						proof.reason,
						now,
					);
				}
			}
			if (alignment.horizonExceeded) {
				return release(
					deps,
					operation,
					claim,
					"held",
					"head_alignment_horizon_exceeded",
					now,
				);
			}
			return release(
				deps,
				operation,
				claim,
				"partial",
				"pr_head_mismatch",
				now,
			);
		}
		const adjudicated = deps.store.adjudicateRemoteInvalidatedLandCoolAttempts({
			confirmingOperationId: operation.operation_id,
			ownerId: claim.ownerId,
			generation: claim.generation,
			repoIdentity: "__main__",
			observedPrNumber: operation.pr_number,
			observedHeadSha: pr.headSha,
			observedPrState: pr.state,
			now,
		});
		if (!adjudicated.ok) {
			return release(
				deps,
				operation,
				claim,
				"held",
				`cool_adjudication_failed:${adjudicated.reason}`,
				now,
			);
		}
		closeAlignmentEpisode(deps.store, operation, now);
		if (pr.state === "CLOSED") {
			return release(deps, operation, claim, "held", "pr_closed_unmerged", now);
		}
		if (
			pr.state === "OPEN" &&
			(pr.mergeStateStatus !== undefined || pr.isDraft === true)
		) {
			const preflight = classifyLandFailure({
				approvedHead: operation.approved_head,
				pr,
			});
			if (preflight.kind === "merge_conflict") {
				if (
					deps.mergeDriver.requestBaseRefresh &&
					pr.baseSha &&
					/^[0-9a-f]{40}$/.test(pr.baseSha)
				) {
					const rejected = await rejectUnauthorizedLandEffect(
						deps,
						operation,
						claim,
						now,
					);
					if (rejected) return rejected;
					if (!stepReceipt(deps.store, operationId, "base_refresh_prepared")) {
						recordStep(
							deps,
							operation,
							claim,
							"base_refresh_prepared",
							{
								approvedHead: operation.approved_head,
								baseOid: pr.baseSha,
							},
							now,
						);
					}
					const refresh = await runExternalLandProbe(
						deps,
						operation,
						"base_refresh",
						now,
						() =>
							deps.mergeDriver.requestBaseRefresh!({
								projectName: operation.project_name,
								prNumber: operation.pr_number,
								expectedHeadSha: operation.approved_head,
							}),
					);
					if (refresh.status === "accepted") {
						if (
							!stepReceipt(deps.store, operationId, "base_refresh_requested")
						) {
							recordStep(
								deps,
								operation,
								claim,
								"base_refresh_requested",
								{
									approvedHead: operation.approved_head,
									baseOid: pr.baseSha,
									status: refresh.status,
								},
								now,
							);
						}
						return release(
							deps,
							operation,
							claim,
							"partial",
							"base_refresh_pending",
							now,
						);
					}
					if (refresh.status === "head_moved") {
						return release(
							deps,
							operation,
							claim,
							"partial",
							"pr_head_mismatch",
							now,
						);
					}
					if (refresh.status === "conflict") {
						return openConflictRework(
							deps,
							operation,
							claim,
							"base_refresh_prepared",
							now,
						);
					}
					if (refresh.status === "policy_blocked") {
						return release(
							deps,
							operation,
							claim,
							"held",
							"policy_blocked",
							now,
						);
					}
					if (refresh.status === "external_outage") {
						return releaseExternalOutage(
							deps,
							operation,
							claim,
							"base_refresh",
							"driver_reported_external_outage",
							now,
						);
					}
				}
				return release(
					deps,
					operation,
					claim,
					"partial",
					preflight.reason,
					now,
				);
			}
			if (preflight.kind === "policy_blocked") {
				return release(deps, operation, claim, "held", preflight.reason, now);
			}
			if (
				preflight.reason === "mergeability_pending" ||
				preflight.reason === "policy_alignment_pending"
			) {
				const policy = touchPolicyEpisode(
					deps.store,
					operation,
					preflight.reason,
					now,
				);
				if (policy.horizonExceeded) {
					await announce(
						deps,
						operation,
						claim,
						"policy_alignment_horizon_exceeded",
						{
							firstObservedAt: policy.firstObservedAt,
							lastReason: preflight.reason,
						},
						now,
					);
					return release(
						deps,
						operation,
						claim,
						"held",
						"policy_alignment_horizon_exceeded",
						now,
					);
				}
				return release(
					deps,
					operation,
					claim,
					"partial",
					preflight.reason,
					now,
				);
			}
			closePolicyEpisodes(deps.store, operation, now);
		}

		if (pr.state !== "MERGED") {
			const triggerReceipt = coolTriggerReceipt(deps.store, operation);
			let trigger = triggerReceipt.receipt;
			if (!trigger) {
				let attempt = deps.store.getOpenLandCoolAttempt(operationId);
				if (attempt?.state === "prepared") {
					const ambiguousScope = `ambiguous_cool:${operationId}:${attempt.ordinal}`;
					if (!deps.mergeDriver.inspectPreparedCoolAttempt) {
						return releaseCoolFenceWait(
							deps,
							operation,
							claim,
							ambiguousScope,
							"ambiguous_cool_reconcile_pending",
							now,
						);
					}
					const inspection = await runExternalLandProbe(
						deps,
						operation,
						"prepared_cool_inspection",
						now,
						() =>
							deps.mergeDriver.inspectPreparedCoolAttempt!({
								projectName: operation.project_name,
								prNumber: operation.pr_number,
								headSha: operation.approved_head,
								preparedAt: attempt!.prepared_at,
								now,
							}),
					);
					if (inspection.status === "pending") {
						return releaseCoolFenceWait(
							deps,
							operation,
							claim,
							ambiguousScope,
							"ambiguous_cool_reconcile_pending",
							now,
						);
					}
					closeScopedRecoveryEpisode(
						deps.store,
						operation,
						"refire",
						ambiguousScope,
						"prepared_effect_reconciled",
						now,
					);
					if (inspection.status === "found") {
						const sent = deps.store.markLandCoolAttemptSent({
							operationId,
							ordinal: attempt.ordinal,
							ownerId: claim.ownerId,
							generation: claim.generation,
							attemptGeneration: attempt.generation,
							commentId: inspection.commentId,
							now,
						});
						if (!sent.ok) throw new Error(sent.reason);
						attempt = sent.attempt;
					} else {
						const adjudicated = deps.store.adjudicateAbsentLandCoolAttempt({
							operationId,
							ordinal: attempt.ordinal,
							ownerId: claim.ownerId,
							generation: claim.generation,
							attemptGeneration: attempt.generation,
							observedAt: inspection.observedAt,
							now,
						});
						if (!adjudicated.ok) throw new Error(adjudicated.reason);
						attempt = undefined;
					}
				}
				if (!attempt) {
					const prepared = deps.store.prepareLandCoolAttempt({
						operationId,
						ownerId: claim.ownerId,
						generation: claim.generation,
						repoIdentity: "__main__",
						now,
					});
					if (!prepared.ok) {
						if (prepared.reason === "land_external_effect_inflight") {
							return releaseCoolFenceWait(
								deps,
								operation,
								claim,
								"land_queue_busy",
								"land_queue_busy",
								now,
							);
						}
						return release(
							deps,
							operation,
							claim,
							prepared.reason === "land_cool_refire_limit" ? "held" : "partial",
							prepared.reason,
							now,
						);
					}
					closeScopedRecoveryEpisode(
						deps.store,
						operation,
						"refire",
						"land_queue_busy",
						"queue_acquired",
						now,
					);
					attempt = prepared.attempt;
				}
				const rejected = await rejectUnauthorizedLandEffect(
					deps,
					operation,
					claim,
					now,
				);
				if (rejected) return rejected;
				if (attempt.state === "sent") {
					trigger = { commentId: attempt.comment_id };
					recordStep(deps, operation, claim, triggerReceipt.step, trigger, now);
				} else {
					let posted: { commentId: string; commentUrl?: string };
					try {
						posted = await deps.mergeDriver.triggerCool({
							projectName: operation.project_name,
							prNumber: operation.pr_number,
							operationId,
							headSha: operation.approved_head,
						});
					} catch {
						return releaseCoolFenceWait(
							deps,
							operation,
							claim,
							`ambiguous_cool:${operationId}:${attempt.ordinal}`,
							"ambiguous_cool_reconcile_pending",
							now,
						);
					}
					const rejectedAfterTrigger = await rejectUnauthorizedLandEffect(
						deps,
						operation,
						claim,
						now,
					);
					if (rejectedAfterTrigger) return rejectedAfterTrigger;
					const commentId = String(posted.commentId ?? "");
					if (!commentId) {
						return release(
							deps,
							operation,
							claim,
							"held",
							"cool_trigger_receipt_corrupt",
							now,
						);
					}
					const sent = deps.store.markLandCoolAttemptSent({
						operationId,
						ordinal: attempt.ordinal,
						ownerId: claim.ownerId,
						generation: claim.generation,
						commentId,
						now,
					});
					if (!sent.ok) throw new Error(sent.reason);
					attempt = sent.attempt;
					trigger = posted;
					recordStep(deps, operation, claim, triggerReceipt.step, posted, now);
				}
			}
			await announce(deps, operation, claim, "cool_triggered", trigger, now);
			const triggerCommentId = String(trigger.commentId ?? "");
			if (!triggerCommentId) {
				return release(
					deps,
					operation,
					claim,
					"held",
					"cool_trigger_receipt_corrupt",
					now,
				);
			}
			const workflow = await runExternalLandProbe(
				deps,
				operation,
				"ship_workflow",
				now,
				() =>
					deps.mergeDriver.inspectTriggeredWorkflow({
						projectName: operation.project_name,
						prNumber: operation.pr_number,
						triggerCommentId,
						headSha: operation.approved_head,
					}),
			);
			const rejectedAfterWorkflow = await rejectUnauthorizedLandEffect(
				deps,
				operation,
				claim,
				now,
			);
			if (rejectedAfterWorkflow) return rejectedAfterWorkflow;
			if (workflow.state === "failed") {
				// Duplicate sanctioned triggers can race: one run may merge while a
				// later run fails because the PR is already gone. Exact-head PR state
				// wins over the losing run's failure receipt.
				pr = await runExternalLandProbe(
					deps,
					operation,
					"inspect_pr",
					now,
					() =>
						deps.mergeDriver.inspectPr({
							projectName: operation.project_name,
							prNumber: operation.pr_number,
						}),
				);
				if (
					pr.state !== "MERGED" ||
					pr.headSha.toLowerCase() !== operation.approved_head
				) {
					const failure = classifyLandFailure({
						approvedHead: operation.approved_head,
						pr,
						workflow: {
							conclusion: workflow.conclusion ?? workflow.reason,
							failedStep: workflow.failedStep,
							structuredReason: workflow.structuredReason,
							failedStepLog: workflow.failedStepLog,
						},
					});
					const attempt = deps.store.getOpenLandCoolAttempt(operationId);
					if (attempt?.state === "sent") {
						const terminal = deps.store.markLandCoolAttemptTerminal({
							operationId,
							ordinal: attempt.ordinal,
							ownerId: claim.ownerId,
							generation: claim.generation,
							attemptGeneration: attempt.generation,
							classification: failure.kind,
							...(workflow.runId ? { shipRunId: workflow.runId } : {}),
							now,
						});
						if (!terminal.ok) throw new Error(terminal.reason);
					}
					await announce(
						deps,
						operation,
						claim,
						"merge_failed",
						{ ...workflow, classification: failure.kind },
						now,
					);
					if (failure.kind === "external_outage") {
						return releaseExternalOutage(
							deps,
							operation,
							claim,
							"ship_workflow",
							failure.reason,
							now,
						);
					}
					const reason =
						workflow.reason !== "failure" && workflow.reason !== "cancelled"
							? `ship_workflow_failed:${workflow.reason}`
							: failure.reason;
					return release(
						deps,
						operation,
						claim,
						classifyLandRetryReason(reason) === "terminal" ? "held" : "partial",
						reason,
						now,
					);
				}
			}
			if (pr.state !== "MERGED") {
				pr = await runExternalLandProbe(
					deps,
					operation,
					"inspect_pr",
					now,
					() =>
						deps.mergeDriver.inspectPr({
							projectName: operation.project_name,
							prNumber: operation.pr_number,
						}),
				);
			}
			if (pr.headSha.toLowerCase() !== operation.approved_head) {
				return release(
					deps,
					operation,
					claim,
					"partial",
					"pr_head_mismatch",
					now,
				);
			}
			if (pr.state !== "MERGED") {
				return release(
					deps,
					operation,
					claim,
					"partial",
					"ship_workflow_pending",
					now,
				);
			}
		}

		if (pr.state === "MERGED") {
			const attempt = deps.store.getOpenLandCoolAttempt(operationId);
			if (attempt?.state === "sent") {
				const terminal = deps.store.markLandCoolAttemptTerminal({
					operationId,
					ordinal: attempt.ordinal,
					ownerId: claim.ownerId,
					generation: claim.generation,
					attemptGeneration: attempt.generation,
					classification: "merged",
					now,
				});
				if (!terminal.ok) throw new Error(terminal.reason);
			}
		}

		if (!stepReceipt(deps.store, operationId, "merge_confirmed")) {
			recordStep(
				deps,
				operation,
				claim,
				"merge_confirmed",
				{ mergeSha: pr.mergeSha ?? null, headSha: pr.headSha },
				now,
			);
		}
		await announce(
			deps,
			operation,
			claim,
			"merge_confirmed",
			{
				mergeSha: pr.mergeSha ?? null,
			},
			now,
		);

		let cleanup = stepReceipt(deps.store, operationId, "cleanup_requested");
		if (!cleanup) {
			const rejected = await rejectUnauthorizedLandEffect(
				deps,
				operation,
				claim,
				now,
			);
			if (rejected) return rejected;
			cleanup = (await deps.requestCleanup?.(operation)) ?? {
				requested: 0,
				acked: 0,
				timedOut: 0,
			};
			const rejectedAfterCleanup = await rejectUnauthorizedLandEffect(
				deps,
				operation,
				claim,
				now,
			);
			if (rejectedAfterCleanup) return rejectedAfterCleanup;
			recordStep(deps, operation, claim, "cleanup_requested", cleanup, now);
		}
		await announce(deps, operation, claim, "cleanup_requested", cleanup, now);

		const rejected = await rejectUnauthorizedLandEffect(
			deps,
			operation,
			claim,
			now,
		);
		if (rejected) return rejected;
		const closure = await deps.finalize(operation);
		const rejectedAfterFinalize = await rejectUnauthorizedLandEffect(
			deps,
			operation,
			claim,
			now,
		);
		if (rejectedAfterFinalize) return rejectedAfterFinalize;
		if (!closure.complete) {
			await announce(
				deps,
				operation,
				claim,
				"finalization_partial",
				{
					reason: closure.reason ?? closure.outcome,
					...(closure.details ?? {}),
				},
				now,
			);
			return release(
				deps,
				operation,
				claim,
				closure.outcome === "held" ? "held" : "partial",
				closure.reason ?? `finalization_${closure.outcome}`,
				now,
			);
		}
		await announce(deps, operation, claim, "completed", {}, now);
		if (!stepReceipt(deps.store, operationId, "finalization_completed")) {
			recordStep(
				deps,
				operation,
				claim,
				"finalization_completed",
				{ outcome: closure.outcome, ...(closure.details ?? {}) },
				now,
			);
		}
		return { status: "completed", operationId };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		if (error instanceof ExternalLandProbeFailure) {
			try {
				return await releaseExternalOutage(
					deps,
					operation,
					claim,
					error.scope,
					detail,
					now,
				);
			} catch {
				// The operation may be superseded while the external probe is in
				// flight. Outage episode accounting must never strand the operation
				// lease or the project-wide repo admission behind that race.
				return release(
					deps,
					operation,
					claim,
					"partial",
					"external_outage",
					now,
				);
			}
		}
		const reason = `land_execution_error:${detail}`;
		try {
			await announce(
				deps,
				operation,
				claim,
				"execution_retry",
				{ reason },
				now,
			);
		} catch {
			// The original failure remains the retry reason; a second visibility
			// failure must not mask it or leave the lease held.
		}
		return release(
			deps,
			operation,
			claim,
			detail === "land_step_receipt_conflict" ? "held" : "partial",
			reason,
			now,
		);
	}
}

type GhExec = (
	file: string,
	args: string[],
	opts: { cwd: string },
) => Promise<{ stdout: string; stderr: string }>;

function parseJson<T>(raw: string, context: string): T {
	try {
		return JSON.parse(raw) as T;
	} catch {
		throw new Error(`${context}_invalid_json`);
	}
}

function normalizedWorkflowValue(value: string | null | undefined): string {
	return value?.trim().toLowerCase() ?? "";
}

function isExternalLandProbeError(detail: string): boolean {
	return /(?:temporarily unavailable|timed?\s*out|rate[ -]?limit|http\s+(?:429|5\d\d)|\b(?:econnreset|econnrefused|enotfound|eai_again)\b|network error)/i.test(
		detail,
	);
}

export class GhCliLandMergeDriver implements LandMergeDriver {
	constructor(
		private readonly projectRootFor: (
			projectName: string,
		) => string | undefined,
		private readonly exec: GhExec = (file, args, opts) =>
			execFileAsync(file, args, opts) as Promise<{
				stdout: string;
				stderr: string;
			}>,
		private readonly now: () => Date = () => new Date(),
	) {}

	private root(projectName: string): string {
		const root = this.projectRootFor(projectName);
		if (!root) throw new Error("land_project_root_missing");
		return root;
	}

	private async inspectWorkflowFailureEvidence(input: {
		cwd: string;
		nameWithOwner: string;
		runId: string;
		headSha: string;
		structuredReason?: string;
	}): Promise<{
		conclusion?: string;
		failedStep?: { number: number; name: string };
		failedStepLog?: string;
	}> {
		const runResult = await this.exec(
			"gh",
			["api", `repos/${input.nameWithOwner}/actions/runs/${input.runId}`],
			{ cwd: input.cwd },
		);
		const run = parseJson<{
			status?: string | null;
			conclusion?: string | null;
			head_sha?: string | null;
		}>(runResult.stdout, "land_actions_run");
		if (run.head_sha?.toLowerCase() !== input.headSha.toLowerCase()) return {};

		const jobsResult = await this.exec(
			"gh",
			[
				"api",
				`repos/${input.nameWithOwner}/actions/runs/${input.runId}/jobs`,
				"--paginate",
				"--slurp",
			],
			{ cwd: input.cwd },
		);
		type JobStep = {
			number: number;
			name: string;
			conclusion?: string | null;
			started_at?: string | null;
			completed_at?: string | null;
		};
		type Job = {
			id: number;
			conclusion?: string | null;
			steps?: JobStep[] | null;
		};
		const pages = parseJson<Array<Job[] | { jobs?: Job[] }>>(
			jobsResult.stdout,
			"land_actions_jobs",
		);
		const jobs = pages.flatMap((page) =>
			Array.isArray(page) ? page : (page.jobs ?? []),
		);
		const failedSteps = jobs.flatMap((job) =>
			(job.steps ?? [])
				.filter((step) =>
					["failure", "cancelled", "timed_out"].includes(
						normalizedWorkflowValue(step.conclusion),
					),
				)
				.map((step) => ({ job, step })),
		);
		const unique = failedSteps.length === 1 ? failedSteps[0] : undefined;
		if (!unique) {
			return run.conclusion ? { conclusion: run.conclusion } : {};
		}
		const failedStep = {
			number: unique.step.number,
			name: unique.step.name,
		};
		if (failedStep.name !== "✅ Merge PR" || input.structuredReason) {
			return {
				...(run.conclusion ? { conclusion: run.conclusion } : {}),
				failedStep,
			};
		}
		const logResult = await this.exec(
			"gh",
			[
				"api",
				`repos/${input.nameWithOwner}/actions/jobs/${unique.job.id}/logs`,
			],
			{ cwd: input.cwd },
		);
		const failedStepLog = extractBoundedFailedStepLog({
			log: logResult.stdout,
			failedStep,
			steps: (unique.job.steps ?? []).map((step) => ({
				number: step.number,
				name: step.name,
				startedAt: step.started_at,
				completedAt: step.completed_at,
			})),
		});
		return {
			...(run.conclusion ? { conclusion: run.conclusion } : {}),
			failedStep,
			...(failedStepLog ? { failedStepLog } : {}),
		};
	}

	async requestBaseRefresh(input: {
		projectName: string;
		prNumber: number;
		expectedHeadSha: string;
	}): Promise<LandBaseRefreshResult> {
		const expectedHeadSha = input.expectedHeadSha.trim().toLowerCase();
		if (!/^[0-9a-f]{40}$/.test(expectedHeadSha)) {
			return { status: "unknown", detail: "invalid_expected_head" };
		}
		const cwd = this.root(input.projectName);
		const repo = await this.exec(
			"gh",
			["repo", "view", "--json", "nameWithOwner"],
			{ cwd },
		);
		const nameWithOwner = parseJson<{ nameWithOwner: string }>(
			repo.stdout,
			"land_repo_view",
		).nameWithOwner;
		try {
			await this.exec(
				"gh",
				[
					"api",
					"-X",
					"PUT",
					`repos/${nameWithOwner}/pulls/${input.prNumber}/update-branch`,
					"-f",
					`expected_head_sha=${expectedHeadSha}`,
				],
				{ cwd },
			);
			return { status: "accepted" };
		} catch (error) {
			const failure = error as {
				message?: string;
				stderr?: string;
				stdout?: string;
			};
			const detail = [failure.message, failure.stderr, failure.stdout]
				.filter(Boolean)
				.join("\n")
				.slice(0, 2_000);
			if (/\b422\b/.test(detail)) {
				try {
					const observed = await this.inspectPr({
						projectName: input.projectName,
						prNumber: input.prNumber,
					});
					if (observed.headSha !== expectedHeadSha) {
						return {
							status: "head_moved",
							observedHeadSha: observed.headSha,
						};
					}
					if (
						observed.mergeable?.toUpperCase() === "CONFLICTING" ||
						observed.mergeStateStatus?.toUpperCase() === "DIRTY" ||
						/merge conflicts?|not mergeable/i.test(detail)
					) {
						return { status: "conflict" };
					}
				} catch {
					// Without the exact-head re-probe, 422 is ambiguous by contract.
				}
				return { status: "unknown", detail: "update_branch_422_unresolved" };
			}
			if (/\b403\b/.test(detail)) return { status: "policy_blocked" };
			if (/\b(?:429|5\d\d)\b/.test(detail)) {
				return { status: "external_outage" };
			}
			return {
				status: "unknown",
				detail: detail || "update_branch_unknown",
			};
		}
	}

	async inspectPr(input: {
		projectName: string;
		prNumber: number;
	}): Promise<LandPrState> {
		const result = await this.exec(
			"gh",
			[
				"pr",
				"view",
				String(input.prNumber),
				"--json",
				"state,headRefOid,baseRefOid,mergeCommit,mergeable,mergeStateStatus,isDraft,reviewDecision,statusCheckRollup",
			],
			{ cwd: this.root(input.projectName) },
		);
		const parsed = parseJson<{
			state: LandPrState["state"];
			headRefOid: string;
			baseRefOid?: string | null;
			mergeCommit?: { oid?: string } | null;
			mergeable?: string | null;
			mergeStateStatus?: string | null;
			isDraft?: boolean;
			reviewDecision?: string | null;
			statusCheckRollup?: Array<{
				status?: string | null;
				conclusion?: string | null;
			}> | null;
		}>(result.stdout, "land_pr_view");
		return {
			state: parsed.state,
			headSha: parsed.headRefOid.toLowerCase(),
			...(parsed.baseRefOid
				? { baseSha: parsed.baseRefOid.toLowerCase() }
				: {}),
			...(parsed.mergeCommit?.oid
				? { mergeSha: parsed.mergeCommit.oid.toLowerCase() }
				: {}),
			mergeable: parsed.mergeable ?? null,
			mergeStateStatus: parsed.mergeStateStatus ?? null,
			isDraft: parsed.isDraft ?? false,
			reviewDecision: parsed.reviewDecision ?? null,
			checks: (parsed.statusCheckRollup ?? []).map((check) => ({
				status: check.status ?? null,
				conclusion: check.conclusion ?? null,
			})),
		};
	}

	async triggerCool(input: {
		projectName: string;
		prNumber: number;
		operationId: string;
		headSha: string;
	}): Promise<{ commentId: string; commentUrl?: string }> {
		// The sanctioned workflow deliberately requires an exact `:cool:` body.
		// The durable operation already carries idempotency; adding metadata here
		// would make GitHub skip the workflow entirely.
		const body = ":cool:";
		const result = await this.exec(
			"gh",
			["pr", "comment", String(input.prNumber), "--body", body],
			{ cwd: this.root(input.projectName) },
		);
		const url = result.stdout.trim().split(/\s+/).at(-1) ?? "";
		const commentId = /issuecomment-(\d+)/.exec(url)?.[1];
		if (!commentId) throw new Error("cool_trigger_comment_id_missing");
		return { commentId, commentUrl: url };
	}

	async inspectPreparedCoolAttempt(input: {
		projectName: string;
		prNumber: number;
		headSha: string;
		preparedAt: string;
		now: string;
	}): Promise<LandPreparedCoolAttemptInspection> {
		const cwd = this.root(input.projectName);
		const repo = await this.exec(
			"gh",
			["repo", "view", "--json", "nameWithOwner"],
			{ cwd },
		);
		const nameWithOwner = parseJson<{ nameWithOwner: string }>(
			repo.stdout,
			"land_repo_view",
		).nameWithOwner;
		const response = await this.exec(
			"gh",
			[
				"api",
				`repos/${nameWithOwner}/issues/${input.prNumber}/comments`,
				"--paginate",
				"--slurp",
			],
			{ cwd },
		);
		const pages = parseJson<
			Array<Array<{ id?: number; body?: string; created_at?: string }>>
		>(response.stdout, "land_comments");
		const preparedMs = Date.parse(input.preparedAt);
		// GitHub issue-comment timestamps are second-precision while the durable
		// prepare receipt carries milliseconds. Floor the local boundary and allow
		// a small server-clock skew so a comment accepted in the prepare second can
		// never be mis-adjudicated as absent.
		const earliestCandidateMs =
			Math.floor(preparedMs / 1_000) * 1_000 - COOL_COMMENT_CLOCK_SKEW_MS;
		const rows = pages.flat();
		const candidates = rows
			.filter((row) => row.body?.trim() === ":cool:")
			.filter((row) => Date.parse(row.created_at ?? "") >= earliestCandidateMs)
			.filter((row) => Number.isInteger(row.id));
		const receiptedCommentIds = new Set(
			rows.flatMap((row) => {
				const body = row.body ?? "";
				if (!body.includes("flywheel-ship-receipt")) return [];
				const triggerCommentId = /trigger_comment_id=([^\s>]+)/.exec(body)?.[1];
				const head = /head=([^\s>]+)/.exec(body)?.[1]?.toLowerCase();
				return triggerCommentId && head === input.headSha.toLowerCase()
					? [triggerCommentId]
					: [];
			}),
		);
		const receiptedCandidates = candidates.filter((row) =>
			receiptedCommentIds.has(String(row.id)),
		);
		if (receiptedCandidates.length === 1) {
			return {
				status: "found",
				commentId: String(receiptedCandidates[0]?.id),
			};
		}
		const observationMs = Date.parse(input.now);
		if (
			candidates.length === 0 &&
			Number.isFinite(preparedMs) &&
			Number.isFinite(observationMs) &&
			observationMs - preparedMs >= 2 * 60_000
		) {
			return { status: "absent", observedAt: input.now };
		}
		return { status: "pending" };
	}

	async inspectTriggeredWorkflow(input: {
		projectName: string;
		prNumber: number;
		triggerCommentId: string;
		headSha: string;
	}): Promise<LandWorkflowState> {
		const cwd = this.root(input.projectName);
		const repo = (
			await this.exec("gh", ["repo", "view", "--json", "nameWithOwner"], {
				cwd,
			})
		).stdout;
		const nameWithOwner = parseJson<{ nameWithOwner: string }>(
			repo,
			"land_repo_view",
		).nameWithOwner;
		const comments = await this.exec(
			"gh",
			[
				"api",
				`repos/${nameWithOwner}/issues/${input.prNumber}/comments`,
				"--paginate",
				"--slurp",
			],
			{ cwd },
		);
		const pages = parseJson<
			Array<Array<{ body?: string; created_at?: string }>>
		>(comments.stdout, "land_comments");
		const rows = pages.flat();
		const marker = `trigger_comment_id=${input.triggerCommentId}`;
		const head = `head=${input.headSha}`;
		const latest = rows
			.filter((row) => (row.body ?? "").includes("flywheel-ship-receipt"))
			.filter(
				(row) =>
					(row.body ?? "").includes(marker) && (row.body ?? "").includes(head),
			)
			.at(-1);
		if (!latest) return { state: "pending" };
		const body = latest.body ?? "";
		const runId = /run_id=([^\s>]+)/.exec(body)?.[1];
		const runUrl = /run_url=([^\s>]+)/.exec(body)?.[1];
		const status = /status=([^\s>]+)/.exec(body)?.[1];
		const legacyReason = /reason=([^\s>]+)/.exec(body)?.[1];
		const failedStepReason = /failed_step=([^\s>]+)/.exec(body)?.[1];
		const structuredReason = legacyReason ?? failedStepReason;
		if (status === "failure" || status === "cancelled") {
			let actionsEvidence: Awaited<
				ReturnType<GhCliLandMergeDriver["inspectWorkflowFailureEvidence"]>
			> = {};
			if (runId) {
				try {
					actionsEvidence = await this.inspectWorkflowFailureEvidence({
						cwd,
						nameWithOwner,
						runId,
						headSha: input.headSha,
						...(structuredReason ? { structuredReason } : {}),
					});
				} catch {
					// The durable receipt still proves terminal state. Missing detail is
					// classified as bounded unknown by the executor, never guessed.
				}
			}
			return {
				state: "failed",
				...(runId ? { runId } : {}),
				...(runUrl ? { runUrl } : {}),
				reason: failedStepReason ?? status,
				conclusion: actionsEvidence.conclusion ?? status,
				...(structuredReason ? { structuredReason } : {}),
				...(actionsEvidence.failedStep
					? { failedStep: actionsEvidence.failedStep }
					: {}),
				...(actionsEvidence.failedStepLog
					? { failedStepLog: actionsEvidence.failedStepLog }
					: {}),
			};
		}
		if (status === "success") {
			return {
				state: "succeeded",
				...(runId ? { runId } : {}),
				...(runUrl ? { runUrl } : {}),
			};
		}
		if (
			status === "started" &&
			runId &&
			latest.created_at &&
			this.now().getTime() - Date.parse(latest.created_at) >= 45 * 60_000
		) {
			try {
				const run = await this.exec(
					"gh",
					["run", "view", runId, "--json", "status,conclusion"],
					{ cwd },
				);
				const observed = parseJson<{
					status: string;
					conclusion: string | null;
				}>(run.stdout, "land_run_view");
				if (observed.status !== "completed") {
					return {
						state: "pending",
						runId,
						...(runUrl ? { runUrl } : {}),
					};
				}
				if (observed.conclusion === "success") {
					return {
						state: "succeeded",
						runId,
						...(runUrl ? { runUrl } : {}),
					};
				}
				return {
					state: "failed",
					runId,
					...(runUrl ? { runUrl } : {}),
					reason: `run_${observed.conclusion ?? "unknown"}`,
				};
			} catch {
				// A transient receiver lookup cannot safely turn an incomplete receipt
				// into failure. The durable operation will poll again.
			}
		}
		return {
			state: "pending",
			...(runId ? { runId } : {}),
			...(runUrl ? { runUrl } : {}),
		};
	}
}
