/**
 * FLY-869 B — the Bridge-side seam onto the shared `evaluateShipEligibility`
 * predicate. Every completion / finalization surface (DirectEventSink +
 * event-route session_completed + event-route W2 + complete-marker-reconciler)
 * computes the ship decision through THIS helper BEFORE any status mutation
 * (design R2 HIGH-1 — `verifyApproval` requires the row still be
 * `approved_to_ship`, and the sinks write `completed` first, so the decision
 * MUST be taken pre-transition and threaded into finalization).
 *
 * A merged landing WITHOUT ship eligibility is parked with a durable, head-bound
 * `merge_block` marker (决定③ — NO auto-revert). `isMergeBlocked` is the single
 * suppressor the founder / QA / finalization surfaces consume so a parked session
 * cannot leak into review, QA, W2 finalization, or Done (design R2 HIGH-4).
 */

import {
	evaluateShipEligibility,
	type ShipEligibilityArgs,
	type ShipEligibilityDecision,
} from "flywheel-comm/ship-eligibility";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { Session, StateStore } from "../StateStore.js";
import { parseWorkflowRunSnapshot } from "../workflow-run-snapshot.js";
import { commDbPathForProject } from "./commdb-path.js";
import { evaluateWorkflowFounderReviewPrecondition } from "./founder-review-authority.js";
import { resolveWorkflowHeadAuthority } from "./head-authority.js";
import { makeLinearDoneFinalizer } from "./linear-issue-finalizer.js";
import {
	type MaterializedHeadAuthority,
	unavailableMaterializedHeadAuthority,
} from "./materialized-head-authority.js";
import { runPostShipFinalization } from "./post-ship-finalization.js";
import { type BridgeConfig, sqliteDatetime } from "./types.js";
import type { WorktreeCleanupFn } from "./worktree-cleanup.js";

/**
 * Post-merge recovery has stronger landing evidence than the open-PR CI probe:
 * GitHub already accepted the exact head and reports the PR as MERGED. Re-running
 * the open-PR probe here is both redundant and incorrect because GitHub reports
 * mergeStateStatus=UNKNOWN after merge and the runner worktree may be gone.
 */
export const mergedPrCiProbe: NonNullable<
	ShipEligibilityArgs["ciProbe"]
> = () => ({
	green: true,
	reason: "ci_green",
	mergeStateStatus: "MERGED",
	checks: [],
});

/**
 * Compute the ship decision for a (session, prHead) BEFORE mutating status.
 *
 * Passes the BRIDGE process env (like the existing codex-gate sink checks, e.g.
 * isReviewHeld). This is BOTH production-correct AND testable, and does NOT
 * contradict design R2 HIGH-2: HIGH-2 forbids the *runner CLI* (whose inherited
 * env is a stale spawn-time snapshot) from passing env, so verify-approval must
 * read the authoritative `~/.flywheel/.env`. The BRIDGE process env is current;
 * and because the merge gate resolver only honors `argsEnv` when the KEY IS PRESENT,
 * a normal production Bridge (kill-switch keys absent) still falls through to the
 * live `~/.flywheel/.env` read — so an operator re-arm is honored — while a test
 * that sets `process.env.FLYWHEEL_MERGE_APPROVAL_GATE` can bypass merge approval.
 */
export function computeShipDecision(
	store: Partial<Pick<StateStore, "getDbPath">>,
	session: Pick<Session, "execution_id" | "project_name">,
	prHead: string,
	env: NodeJS.ProcessEnv = process.env,
	ciProbe?: ShipEligibilityArgs["ciProbe"],
): ShipEligibilityDecision {
	return evaluateShipEligibility({
		execId: session.execution_id,
		prHead,
		// Defensive: a session without a project_name cannot resolve a CommDB path;
		// pass empty → verifyApproval's CommDB read fail-closes when the gate is ON,
		// and it is skipped entirely when the merge kill-switch is OFF.
		commDbPath: session.project_name
			? commDbPathForProject(session.project_name)
			: "",
		// Defensive: a store double without getDbPath → let evaluateShipEligibility
		// resolve the default StateStore path (only read when the gate is ON).
		stateDbPath:
			typeof store.getDbPath === "function" ? store.getDbPath() : undefined,
		env,
		ciProbe,
	});
}

export interface AuthoritativeShipDecision extends ShipEligibilityDecision {
	authoritativeHead: string;
	workflowClaimsOk?: boolean;
	workflowClaimsReason?: string;
}

type EngineShipContext = {
	runId: string;
	projectName: string;
	snapshot: ReturnType<typeof parseWorkflowRunSnapshot>;
};

function outputBackedReviewNodeId(
	snapshot: ReturnType<typeof parseWorkflowRunSnapshot>,
): string | undefined {
	const candidates = snapshot.resolved.nodes.filter((node) => {
		if (node.type !== "review") return false;
		const producerIds = snapshot.manifest.edges
			.filter((edge) => edge.to === node.id && edge.condition === "node_done")
			.map((edge) => edge.from);
		const outputProducers = snapshot.resolved.nodes.filter(
			(candidate) =>
				producerIds.includes(candidate.id) &&
				candidate.capabilities.produces_output,
		);
		return outputProducers.length === 1;
	});
	if (candidates.length > 1) {
		throw new Error("materialized_review_node_ambiguous");
	}
	return candidates[0]?.id;
}

function engineShipContext(
	store: StateStore,
	executionId: string,
):
	| { engineOwned: false }
	| ({ engineOwned: true } & EngineShipContext)
	| {
			engineOwned: true;
			reason: string;
	  } {
	// Several legacy finalization tests (and third-party embedders) intentionally
	// provide a narrow StateStore-shaped double. Missing engine capabilities mean
	// the caller predates engine ownership, not that an engine run is malformed.
	const capabilities = store as Partial<
		Pick<
			StateStore,
			| "getWorkflowExecutionBinding"
			| "listWorkflowActivationsForActor"
			| "getWorkflowRun"
		>
	>;
	if (
		(typeof capabilities.listWorkflowActivationsForActor !== "function" &&
			typeof capabilities.getWorkflowExecutionBinding !== "function") ||
		typeof capabilities.getWorkflowRun !== "function"
	) {
		return { engineOwned: false };
	}
	const binding = capabilities.listWorkflowActivationsForActor
		? capabilities.listWorkflowActivationsForActor(executionId)[0]
		: capabilities.getWorkflowExecutionBinding?.(executionId);
	if (!binding) return { engineOwned: false };
	const run = capabilities.getWorkflowRun(binding.run_id);
	if (run?.engine_owned !== 1) return { engineOwned: false };
	if (!run.snapshot)
		return { engineOwned: true, reason: "snapshot_unavailable" };
	try {
		return {
			engineOwned: true,
			runId: run.run_id,
			projectName: run.project_name,
			snapshot: parseWorkflowRunSnapshot(run.snapshot),
		};
	} catch {
		return { engineOwned: true, reason: "snapshot_invalid" };
	}
}

function evaluateEngineShipClaims(
	store: StateStore,
	context: EngineShipContext,
	authoritativeHead: string,
	now = new Date().toISOString(),
): { eligible: true } | { eligible: false; reason: string } {
	const resolved = store.resolveEngineWorkflowShipClaims({
		runId: context.runId,
		subjectDigest: authoritativeHead,
		now,
	});
	return resolved.valid
		? { eligible: true }
		: { eligible: false, reason: resolved.reason };
}

export type EngineWorkflowShipPrecondition =
	| { engineOwned: false; eligible: true; authoritativeHead: string }
	| {
			engineOwned: true;
			eligible: boolean;
			authoritativeHead: string;
			reason?: string;
	  };

/**
 * Status-independent engine terminal precondition. Completed-row recovery
 * uses this instead of the legacy approval verifier, whose status contract
 * intentionally rejects rows that are already completed.
 */
export async function computeEngineWorkflowShipPrecondition(
	store: StateStore,
	executionId: string,
	observedAuthorityHead: string,
	materializedHeadAuthority: MaterializedHeadAuthority = unavailableMaterializedHeadAuthority,
): Promise<EngineWorkflowShipPrecondition> {
	const context = engineShipContext(store, executionId);
	const observed = observedAuthorityHead.trim().toLowerCase();
	if (!context.engineOwned) {
		return { engineOwned: false, eligible: true, authoritativeHead: observed };
	}
	if ("reason" in context) {
		return {
			engineOwned: true,
			eligible: false,
			authoritativeHead: "",
			reason: context.reason,
		};
	}
	let authoritativeHead = "";
	try {
		const reviewNodeId = outputBackedReviewNodeId(context.snapshot);
		if (reviewNodeId) {
			authoritativeHead = (
				await materializedHeadAuthority.resolve(context.runId, reviewNodeId)
			).head
				.trim()
				.toLowerCase();
		} else {
			authoritativeHead = (
				await resolveWorkflowHeadAuthority(store, executionId)
			).prHeadSha;
		}
	} catch (error) {
		return {
			engineOwned: true,
			eligible: false,
			authoritativeHead: "",
			reason:
				error instanceof Error ? error.message : "head_authority_unavailable",
		};
	}
	if (observed && observed !== authoritativeHead) {
		return {
			engineOwned: true,
			eligible: false,
			authoritativeHead,
			reason: "head_authority_mismatch",
		};
	}
	if (!/^[0-9a-f]{40}$/.test(authoritativeHead)) {
		return {
			engineOwned: true,
			eligible: false,
			authoritativeHead,
			reason: "head_authority_invalid",
		};
	}
	const founderReview = await evaluateWorkflowFounderReviewPrecondition({
		store,
		runId: context.runId,
		projectName: context.projectName,
		snapshot: context.snapshot,
		head: authoritativeHead,
	});
	if (!founderReview.eligible) {
		return {
			engineOwned: true,
			eligible: false,
			authoritativeHead,
			reason: founderReview.reason,
		};
	}
	const result = evaluateEngineShipClaims(store, context, authoritativeHead);
	return result.eligible
		? { engineOwned: true, eligible: true, authoritativeHead }
		: {
				engineOwned: true,
				eligible: false,
				authoritativeHead,
				reason: result.reason,
			};
}

/**
 * The production ship seam. The session/evidence head is comparison-only; git
 * HEAD in the persisted worktree is authoritative for every finalization path.
 */
export async function computeAuthoritativeShipDecision(
	store: StateStore,
	session: Pick<Session, "execution_id" | "project_name">,
	observedHead: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
	materializedHeadAuthority: MaterializedHeadAuthority = unavailableMaterializedHeadAuthority,
	ciProbe?: ShipEligibilityArgs["ciProbe"],
): Promise<AuthoritativeShipDecision> {
	const engine = engineShipContext(store, session.execution_id);
	const typedEngine =
		engine.engineOwned && !("reason" in engine) ? engine : undefined;
	if (engine.engineOwned && "reason" in engine) {
		return {
			eligible: false,
			mergeApprovalOk: false,
			qaOk: false,
			mergeReason: `workflow_ship_claims_${engine.reason}`,
			qaReason: "head_authority_unavailable_failclosed",
			authoritativeHead: "",
			workflowClaimsOk: false,
			workflowClaimsReason: engine.reason,
		};
	}
	let authoritativeHead = "";
	try {
		const reviewNodeId = typedEngine
			? outputBackedReviewNodeId(typedEngine.snapshot)
			: undefined;
		authoritativeHead = reviewNodeId
			? (
					await materializedHeadAuthority.resolve(
						typedEngine!.runId,
						reviewNodeId,
					)
				).head
					.trim()
					.toLowerCase()
			: (await resolveWorkflowHeadAuthority(store, session.execution_id))
					.prHeadSha;
	} catch {
		return {
			eligible: false,
			mergeApprovalOk: false,
			qaOk: false,
			mergeReason: "head_authority_unavailable",
			qaReason: "head_authority_unavailable_failclosed",
			authoritativeHead,
		};
	}
	const compared = observedHead?.trim().toLowerCase();
	if (compared && compared !== authoritativeHead) {
		return {
			eligible: false,
			mergeApprovalOk: false,
			qaOk: false,
			mergeReason: "head_authority_mismatch",
			qaReason: "head_authority_mismatch_failclosed",
			authoritativeHead,
		};
	}
	if (typedEngine) {
		const founderReview = await evaluateWorkflowFounderReviewPrecondition({
			store,
			runId: typedEngine.runId,
			projectName: typedEngine.projectName,
			snapshot: typedEngine.snapshot,
			head: authoritativeHead,
			processEnv: env,
		});
		if (!founderReview.eligible) {
			return {
				eligible: false,
				mergeApprovalOk: false,
				qaOk: false,
				mergeReason: founderReview.reason,
				qaReason: "qa_claim_gate_unenrolled_failclosed",
				authoritativeHead,
				workflowClaimsOk: false,
				workflowClaimsReason: founderReview.reason,
			};
		}
	}
	const base = computeShipDecision(
		store,
		session,
		authoritativeHead,
		env,
		ciProbe,
	);
	if (typedEngine) {
		const workflow = evaluateEngineShipClaims(
			store,
			typedEngine,
			authoritativeHead,
		);
		if (!workflow.eligible) {
			return {
				...base,
				eligible: false,
				mergeReason: `workflow_ship_claims:${workflow.reason}`,
				authoritativeHead,
				workflowClaimsOk: false,
				workflowClaimsReason: workflow.reason,
			};
		}
		return {
			...base,
			authoritativeHead,
			workflowClaimsOk: true,
		};
	}
	return { ...base, authoritativeHead };
}

/**
 * The single merge_block suppressor. A parked (merged-but-unapproved) session
 * carries a durable `merge_block_reason` — every founder / QA / finalization
 * surface must treat it as "not eligible to surface / QA / finalize" until a
 * same-head approval recovery clears it.
 */
export function isMergeBlocked(
	session: Pick<Session, "merge_block_reason"> | undefined,
): boolean {
	return !!session?.merge_block_reason;
}

/**
 * Park a merged-but-unapproved session with the durable, head-bound marker.
 * Returns TRUE only for the first claim of THIS head (StateStore.setMergeBlock is
 * the once-per-head claim), so the caller fires the `merge_without_approval`
 * alert exactly once (design R1 MED-4). Idempotent across restarts / replays.
 */
export function parkMergeBlock(
	store: Pick<StateStore, "setMergeBlock">,
	session: Pick<Session, "execution_id">,
	prHead: string,
	decision: ShipEligibilityDecision,
): boolean {
	return store.setMergeBlock({
		executionId: session.execution_id,
		reason: `merge_without_approval:${decision.mergeReason}/${decision.qaReason}`,
		head: prHead,
	});
}

/**
 * FLY-869 B-3 recovery (design R2 HIGH-5): when a founder approval lands for a
 * parked (merge_block) session whose marker head matches the current PR head, clear
 * the marker so the session is no longer held from founder surfaces (isReviewHeld) and
 * can complete normally. Called AFTER the approved_to_ship FSM flip in BOTH approval
 * surfaces (actions.approveExecution + founder-consent gate-response hook). A head
 * mismatch (marker bound to a stale head) is left intact — only THIS head's block is
 * cleared by THIS head's approval. Returns true when a marker was cleared.
 *
 * NOTE: the recovered session is now `approved_to_ship` with a merged landing; driving
 * it the rest of the way to `completed` + Linear-Done reuses the existing post-ship
 * finalization machinery (the completion surfaces are now ship-eligible for this head).
 */
export function clearMergeBlockOnApproval(
	store: Pick<StateStore, "getSession" | "clearMergeBlock">,
	execId: string,
): boolean {
	const s = store.getSession(execId);
	if (!s?.merge_block_reason) return false;
	const head = s.pr_head_sha?.trim().toLowerCase();
	const markerHead = s.merge_block_head?.trim().toLowerCase();
	if (head && markerHead && head === markerHead) {
		store.clearMergeBlock(execId);
		return true;
	}
	return false;
}

/**
 * FLY-869 B-3 recovery + completion (Codex R1 #1, R2 #2): a same-head founder approval on a
 * parked merged-but-unapproved session must drive it the rest of the way to `completed` +
 * Linear-Done — the original `session_completed` event was consumed by the park, so NO later
 * event does it and the row would strand at `approved_to_ship` (the exact FLY-120 stranding
 * this issue must not create).
 *
 * CRITICAL (Codex R2 #2): eligibility is checked BEFORE the marker is cleared. The durable
 * `merge_block` marker is the ONLY suppressor holding a self-merged session; clearing it while
 * a ship gate (QA / Codex) is still unmet would drop the hold and let the session fall into
 * ordinary stale-approved re-wake. So: verify head-bound `computeShipDecision` eligibility with
 * the marker STILL PRESENT; only when fully eligible do we clear + complete + finalize —
 * otherwise the marker is left intact and the session stays explicitly held (决定③: a human
 * resolves the remaining gate). This function is the SINGLE recovery entry the approval
 * surfaces call (replacing a bare `clearMergeBlockOnApproval`).
 *
 * Returns true only when the recovered merge was driven to completed. Best-effort finalization
 * (never throws into the approval handler — the durable status write already happened).
 */
export async function finalizeRecoveredMerge(
	store: StateStore,
	config: BridgeConfig,
	projects: ProjectEntry[],
	execId: string,
	removeCleanWorktree?: WorktreeCleanupFn,
	env: NodeJS.ProcessEnv = process.env,
	/**
	 * FLY-907 (Step 4.1c): the unified issue-display refresh (awaited variant),
	 * threaded into runPostShipFinalization so a recovered-merge finalization
	 * also drives the three display faces to their terminal state (this is the
	 * FOURTH completion write path — it bypasses both the applyTransition hook
	 * and the DirectEventSink hook via its direct `upsertSession`).
	 */
	refreshIssueDisplay?: (issueId: string) => Promise<void>,
	/**
	 * FLY-907 Codex R1 MED-2: a recovered merge on a shared-workflow issue must
	 * also close the still-alive parked design/implement phases + drop the TURN
	 * row (exactly like the live completion sinks) — and only THEN run the
	 * terminal display refresh. Built by the callers via
	 * makeFinalizeWorkflowPhaseRoles (they hold transitionOpts; this module does
	 * not). Absent → no phase finalization (byte-compat with pre-FLY-907).
	 */
	finalizeWorkflowPhaseRoles?: (
		issueId: string,
		projectName: string,
	) => Promise<void>,
	materializedHeadAuthority: MaterializedHeadAuthority = unavailableMaterializedHeadAuthority,
	ciProbe?: ShipEligibilityArgs["ciProbe"],
): Promise<boolean> {
	const s = store.getSession(execId);
	// Only a still-parked row (marker present) whose founder approval just landed.
	if (!s?.merge_block_reason) return false;
	const head = s.pr_head_sha?.trim();
	const markerHead = s.merge_block_head?.trim();
	if (!markerHead) {
		return false;
	}
	// Eligibility BEFORE clearing (Codex R2 #2): an unmet QA / Codex gate → NOT eligible → leave
	// the marker in place (still held). verifyApproval also requires status approved_to_ship, so
	// a not-yet-approved row is naturally ineligible here.
	const decision = await computeAuthoritativeShipDecision(
		store,
		s,
		head,
		env,
		materializedHeadAuthority,
		ciProbe ?? mergedPrCiProbe,
	);
	// Head-bound: only THIS authoritative head recovers THIS marker. A stale
	// cached/session head or stale marker remains parked.
	if (
		!decision.authoritativeHead ||
		markerHead.toLowerCase() !== decision.authoritativeHead
	) {
		return false;
	}
	if (!decision.eligible) return false;

	// Eligible → clear the durable marker (same head-matched clear), write `completed`, then
	// finalize (mirrors the live sink order: status set, then runPostShipFinalization).
	clearMergeBlockOnApproval(store, execId);
	store.upsertSession({
		execution_id: execId,
		issue_id: s.issue_id,
		issue_identifier: s.issue_identifier,
		issue_title: s.issue_title,
		project_name: s.project_name,
		status: "completed",
		last_activity_at: sqliteDatetime(),
	});
	try {
		await runPostShipFinalization(
			{
				executionId: execId,
				runId: store.getWorkflowRunIdForExecution(execId),
				...(s.pr_number && s.pr_head_sha
					? {
							mergedPr: {
								prNumber: s.pr_number,
								headSha: s.pr_head_sha,
							},
						}
					: {}),
				issueId: s.issue_id,
				issueIdentifier: s.issue_identifier,
				projectName: s.project_name,
				sessionStatus: "completed",
				discordOwnerUserId: config.chatThreadsEnabled
					? config.discordOwnerUserId
					: undefined,
				fallbackBotToken: config.discordBotToken,
			},
			{
				store,
				projects,
				removeCleanWorktree,
				markIssueDone: makeLinearDoneFinalizer(config),
				// FLY-907 Codex R1 MED-2: close parked phases + drop TURN before the
				// terminal display refresh (runPostShipFinalization orders them).
				finalizeWorkflowPhaseRoles,
				refreshIssueDisplay,
			},
		);
	} catch (err) {
		console.error(
			`[merge-ship-gate] FLY-869 B-3 finalizeRecoveredMerge finalization failed for ${execId}: ${
				(err as Error).message
			}`,
		);
	}
	return true;
}
