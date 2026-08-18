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
import { classifyLandRetryReason } from "./land-retry-policy.js";
import { computeAuthoritativeShipDecision } from "./merge-ship-gate.js";

const execFileAsync = promisify(execFile);

export interface LandPrState {
	state: "OPEN" | "MERGED" | "CLOSED";
	headSha: string;
	mergeSha?: string;
}

export type LandWorkflowState =
	| { state: "pending"; runId?: string; runUrl?: string }
	| { state: "failed"; runId?: string; runUrl?: string; reason: string }
	| { state: "succeeded"; runId?: string; runUrl?: string };

export interface LandMergeDriver {
	inspectPr(input: {
		projectName: string;
		prNumber: number;
	}): Promise<LandPrState>;
	triggerCool(input: {
		projectName: string;
		prNumber: number;
		operationId: string;
		headSha: string;
	}): Promise<{ commentId: string; commentUrl?: string }>;
	inspectTriggeredWorkflow(input: {
		projectName: string;
		prNumber: number;
		triggerCommentId: string;
		headSha: string;
	}): Promise<LandWorkflowState>;
}

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
	const prBinding = store.getCurrentWorkflowNodePrBindingForHead(
		operation.run_id,
		holder.head_sha,
	);
	if (!prBinding || prBinding.pr_number !== operation.pr_number) {
		return { ok: false, reason: "approved_pr_mismatch" };
	}
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

		let pr = await deps.mergeDriver.inspectPr({
			projectName: operation.project_name,
			prNumber: operation.pr_number,
		});
		if (pr.headSha.toLowerCase() !== operation.approved_head) {
			return release(deps, operation, claim, "held", "pr_head_mismatch", now);
		}
		if (pr.state === "CLOSED") {
			return release(deps, operation, claim, "held", "pr_closed_unmerged", now);
		}

		if (pr.state !== "MERGED") {
			const triggerReceipt = coolTriggerReceipt(deps.store, operation);
			let trigger = triggerReceipt.receipt;
			if (!trigger) {
				const rejected = await rejectUnauthorizedLandEffect(
					deps,
					operation,
					claim,
					now,
				);
				if (rejected) return rejected;
				const posted = await deps.mergeDriver.triggerCool({
					projectName: operation.project_name,
					prNumber: operation.pr_number,
					operationId,
					headSha: operation.approved_head,
				});
				const rejectedAfterTrigger = await rejectUnauthorizedLandEffect(
					deps,
					operation,
					claim,
					now,
				);
				if (rejectedAfterTrigger) return rejectedAfterTrigger;
				trigger = posted;
				recordStep(deps, operation, claim, triggerReceipt.step, posted, now);
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
			const workflow = await deps.mergeDriver.inspectTriggeredWorkflow({
				projectName: operation.project_name,
				prNumber: operation.pr_number,
				triggerCommentId,
				headSha: operation.approved_head,
			});
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
				pr = await deps.mergeDriver.inspectPr({
					projectName: operation.project_name,
					prNumber: operation.pr_number,
				});
				if (
					pr.state !== "MERGED" ||
					pr.headSha.toLowerCase() !== operation.approved_head
				) {
					await announce(deps, operation, claim, "merge_failed", workflow, now);
					const reason = `ship_workflow_failed:${workflow.reason}`;
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
				pr = await deps.mergeDriver.inspectPr({
					projectName: operation.project_name,
					prNumber: operation.pr_number,
				});
			}
			if (pr.headSha.toLowerCase() !== operation.approved_head) {
				return release(deps, operation, claim, "held", "pr_head_mismatch", now);
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
				"state,headRefOid,mergeCommit",
			],
			{ cwd: this.root(input.projectName) },
		);
		const parsed = parseJson<{
			state: LandPrState["state"];
			headRefOid: string;
			mergeCommit?: { oid?: string } | null;
		}>(result.stdout, "land_pr_view");
		return {
			state: parsed.state,
			headSha: parsed.headRefOid.toLowerCase(),
			...(parsed.mergeCommit?.oid
				? { mergeSha: parsed.mergeCommit.oid.toLowerCase() }
				: {}),
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
		if (status === "failure" || status === "cancelled") {
			const failedStep = /failed_step=([^\s>]+)/.exec(body)?.[1];
			return {
				state: "failed",
				...(runId ? { runId } : {}),
				...(runUrl ? { runUrl } : {}),
				reason: failedStep ?? status,
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
