/**
 * FLY-102 Round 3: Shared post-approve-ship orchestrator.
 *
 * Replaces the two divergent post-merge cleanup paths that existed before
 * (DirectEventSink emitCompleted + event-route.ts postApproveShip branch)
 * with a single serialized flow:
 *
 *   1. postMergeTmuxCleanup   — close Runner tmux + audit
 *   2. emitRunnerReadyToCloseNotification — post "🏁 Runner 完工可关闭"
 *      into the per-issue chat thread (atomic dedupe via UNIQUE event_id)
 *   3. removeUserFromChatThread + archiveChatThread — clear Annie's sidebar
 *
 * Ordering is strict: archive MUST NOT run before the notifier, otherwise
 * the "🏁 可关闭" message would land in an archived thread that Discord
 * pushes below Annie's sidebar fold.
 *
 * Fire-and-forget at call sites. Every stage swallows & audits its own
 * errors — the orchestrator itself never throws.
 */

import { CommDB } from "flywheel-comm/db";
import { phaseMessageTag } from "flywheel-config";
import type { ApplyTransitionOpts } from "../applyTransition.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { resolveLeadForIssue } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import type {
	ArchiveChatThreadResult,
	archiveChatThread,
	removeUserFromChatThread,
} from "./chat-thread-utils.js";
import { closeRunner, FINALIZE_DONE_SOURCE_STATES } from "./close-runner.js";
import { commDbPathForProject } from "./commdb-path.js";
import { archiveThreadAndRecord } from "./done-thread-archiver.js";
import { emitIssueThreadInfraNotification } from "./founder-thread-notifier.js";
import {
	inferLandCloseoutCause,
	type LandCloseoutCause,
	landCloseoutReason,
} from "./land-closeout-cause.js";
import { normalizeLandLinearDoneReason } from "./land-retry-policy.js";
import {
	type LinearDoneFinalizer,
	raceMarkIssueDoneWithAbort,
} from "./linear-issue-finalizer.js";
import { postMergeTmuxCleanup } from "./post-merge.js";
import { patchSessionParams } from "./proofshot-session.js";
import { emitRunnerReadyToCloseNotification } from "./runner-ready-to-close-notifier.js";
import {
	type ForceShippedHusksResult,
	forceShippedHusks,
} from "./shipped-husk-escalation.js";
import type { WorktreeCleanupFn } from "./worktree-cleanup.js";

/** No-op policy outcomes that deliberately discharge finalization's archive duty. */
export function isArchiveObligationSettled(
	result: ArchiveChatThreadResult,
): boolean {
	return (
		result.archived ||
		result.reason === "already_archived" ||
		result.reason === "founder_reopened" ||
		result.reason === "in_active_use"
	);
}

/**
 * Shared predicate — aligns with event-route.ts + DirectEventSink
 * postApproveShip semantics.
 *
 * Must return true BEFORE DES or event-route schedules `runPostShipFinalization`.
 * Note: `status === "completed"` alone is NOT sufficient — a Runner that
 * self-completes without actually shipping (e.g. `route=needs_review` and
 * the PR is still open) should not trigger post-ship cleanup.
 *
 * The three "yes" cases the orchestrator must accept:
 *   1. session was already in `approved_to_ship` (Annie / a Lead pressed
 *      `:cool:` first; Bridge's approveExecution flipped status; Runner
 *      then fired session_completed) — the canonical FLY-58 path.
 *   2. `route === "auto_approve"` with `landingStatus.status === "merged"`
 *      — auto-approve workflows where the PR self-merged via deploy
 *      action without an explicit Bridge approve.
 *   3. `route === "needs_review"` with `landingStatus.status === "merged"`
 *      — FLY-115 v1.24.5 (FLY-120). The Lead unblocked the
 *      `approve_to_ship` gate via `flywheel-comm respond` (production
 *      path; v1.24.4 test framework also uses this). Bridge's
 *      `approveExecution` was never called so `existingStatus` stayed at
 *      `running`; the Runner resumed, merged the PR, rewrote
 *      `land-status.json` to `status:"merged"`, and finally exited.
 *      Without this case `runPostShipFinalization` is skipped, the
 *      Runner tmux + chat thread are never torn down, and the Lead
 *      keeps pestering Annie about a PR already on main. Symmetric with
 *      the matching `status` mapping in `DirectEventSink.emitCompleted`
 *      / `event-route.ts:event_type=session_completed`.
 */
export function isPostApproveShipComplete(args: {
	/** session.status BEFORE this event applied (from getSession before upsertSession). */
	existingStatus: string | undefined;
	route: string | undefined;
	landingStatus: { status?: string } | undefined;
	/**
	 * FLY-869 B (design R2 HIGH-1 / MED-1): the PRE-computed ship-eligibility
	 * decision (approval + Codex + QA), taken BEFORE the status mutation. This is
	 * the SINGLE finalization chokepoint — a merged landing that is NOT ship-eligible
	 * was parked with a merge_block marker and MUST NOT finalize (mark Done / tear
	 * down). `false` → refuse finalization. `undefined` (non-merged paths, or a
	 * caller that legitimately did not evaluate) → the merged guard below already
	 * fails for non-merged, so it does not weaken any existing path.
	 */
	shipEligible?: boolean;
}): boolean {
	// FLY-208 5a (Codex design R2 #1): merge evidence is REQUIRED in every
	// branch. Previously `existingStatus === "approved_to_ship"` returned true
	// with landingStatus undefined or "ready_to_merge" — which would run tmux
	// teardown / ready-to-close notification / thread archive for the new
	// evidence-gap completion path (approved_to_ship session whose Runner
	// never rewrote the landing signal) even though nothing proves the PR
	// merged. Finalization for evidence-gap completions is deferred to
	// FLY-210 (PR-state freshness) or a manual close.
	if (args.landingStatus?.status !== "merged") return false;
	// FLY-869 B: never finalize a merged-but-unapproved (parked) session.
	if (args.shipEligible === false) return false;
	if (args.existingStatus === "approved_to_ship") return true;
	if (args.route === "auto_approve") return true;
	if (args.route === "needs_review") return true; // FLY-120
	return false;
}

/**
 * FLY-208 5a: persist the evidence-gap marker on a session completed WITHOUT
 * merge evidence (approved_to_ship + auto_approve/needs_review + landing not
 * "merged"). Stored inside the existing `session_params` JSON column —
 * `patchSessionMetadata` is a column whitelist, so an ad-hoc field would
 * silently no-op (Codex design R3 guardrail #1). Read-modify-write merge
 * preserves whatever else lives in session_params (e.g. proofshot runs).
 *
 * FLY-210 consumes this marker: when later merge proof arrives (PR-head
 * watcher / live PR query), it runs idempotent finalization WITHOUT a status
 * transition (completed is terminal).
 */
export function markEvidenceGapCompletion(
	store: StateStore,
	executionId: string,
	info: { route: string | undefined; landingStatus: string | undefined },
): void {
	patchSessionParams(store, executionId, (cur) => ({
		...cur,
		fly208_evidence_gap: {
			at: new Date().toISOString(),
			route: info.route ?? null,
			landing_status: info.landingStatus ?? null,
		},
	}));
}

export type ShipAttemptSettle =
	| {
			outcome: "marked";
			firstAttemptForHead: boolean;
			attemptCount: number;
	  }
	| { outcome: "stale_attempt" }
	| {
			outcome: "unknown_head_marked";
			firstAttemptForHead: boolean;
			attemptCount: number;
	  }
	| { outcome: "unknown_head_skipped" };

const REAL_GIT_HEAD = /^[0-9a-f]{40}$/;
const UNKNOWN_SHIP_ATTEMPT_HEAD = "(unknown)";

function normalizedGitHead(
	value: string | null | undefined,
): string | undefined {
	const normalized = value?.trim().toLowerCase();
	return normalized && REAL_GIT_HEAD.test(normalized) ? normalized : undefined;
}

/**
 * FLY-1505: settle a failed/stalled ship ATTEMPT without changing the session
 * status. The completion event's head is authoritative for the attempt; the
 * session row's head is only the comparison target for the currently-live
 * approval.
 *
 * A delayed attempt for an older real head is consumed without writing. An
 * event with no usable head records an explicit fail-open sentinel, but that
 * sentinel never overwrites a real-head marker.
 */
export function settleShipAttemptFailed(
	store: StateStore,
	executionId: string,
	info: {
		attemptHeadSha?: string | null;
		currentHeadSha?: string | null;
		prNumber?: number;
		/** Approval binding carried by the attempt event itself. */
		reviewQuestionId?: string | null;
		/** Approval binding on the currently-live session row. */
		currentReviewQuestionId?: string | null;
		summary?: string;
	},
): ShipAttemptSettle {
	const attemptHead = normalizedGitHead(info.attemptHeadSha);
	const currentHead = normalizedGitHead(info.currentHeadSha);
	if (attemptHead && currentHead && attemptHead !== currentHead) {
		return { outcome: "stale_attempt" };
	}
	const reviewQuestionId = info.reviewQuestionId?.trim() || null;
	const currentReviewQuestionId = info.currentReviewQuestionId?.trim() || null;
	if (
		reviewQuestionId &&
		currentReviewQuestionId &&
		reviewQuestionId !== currentReviewQuestionId
	) {
		return { outcome: "stale_attempt" };
	}

	let result: ShipAttemptSettle | undefined;
	patchSessionParams(store, executionId, (cur) => {
		const priorRaw = cur.fly1505_ship_attempt_failed;
		const prior =
			priorRaw && typeof priorRaw === "object" && !Array.isArray(priorRaw)
				? (priorRaw as Record<string, unknown>)
				: undefined;
		const priorHead =
			typeof prior?.head_sha === "string" ? prior.head_sha.toLowerCase() : "";
		const priorReviewQuestionId =
			typeof prior?.review_question_id === "string"
				? prior.review_question_id
				: null;

		if (!attemptHead && REAL_GIT_HEAD.test(priorHead)) {
			result = { outcome: "unknown_head_skipped" };
			return cur;
		}

		const markerHead = attemptHead ?? UNKNOWN_SHIP_ATTEMPT_HEAD;
		const sameApproval = priorReviewQuestionId === reviewQuestionId;
		const sameSeries =
			sameApproval &&
			(priorHead === markerHead ||
				(priorHead === UNKNOWN_SHIP_ATTEMPT_HEAD && Boolean(attemptHead)));
		const priorCount =
			sameSeries &&
			typeof prior?.attempt_count === "number" &&
			Number.isInteger(prior.attempt_count) &&
			prior.attempt_count > 0
				? prior.attempt_count
				: 0;
		const attemptCount = priorCount + 1;
		const firstAttemptForHead = !sameSeries;
		result = attemptHead
			? { outcome: "marked", firstAttemptForHead, attemptCount }
			: {
					outcome: "unknown_head_marked",
					firstAttemptForHead,
					attemptCount,
				};

		return {
			...cur,
			fly1505_ship_attempt_failed: {
				at: new Date().toISOString(),
				pr_number: info.prNumber ?? null,
				head_sha: markerHead,
				review_question_id: reviewQuestionId,
				summary: info.summary ?? null,
				attempt_count: attemptCount,
			},
		};
	});

	// patchSessionParams invokes the callback synchronously.
	return result ?? { outcome: "unknown_head_skipped" };
}

export interface PostShipOpts {
	executionId: string;
	/** Workflow authority when the session belongs to an engine-owned run. */
	runId?: string;
	/** Exact merge receipt attributed to this finalization trigger. */
	mergedPr?: {
		prNumber: number;
		headSha: string;
		repoIdentity?: string;
	};
	issueId: string;
	issueIdentifier?: string;
	projectName: string;
	/** Final status written by DES / event-route (for notifier display). */
	sessionStatus: string;
	/** Discord user ID to remove from chat thread (optional). */
	discordOwnerUserId?: string;
	/** Fallback if lead has no per-lead bot token. */
	fallbackBotToken?: string;
	/** Generation-fenced owner of terminal notification + archive receipts. */
	landOperation?: {
		operationId: string;
		ownerId: string;
		generation: number;
	};
}

/**
 * FLY-1185: the ship-entry lifecycle bundle built ONCE at the Bridge
 * composition root and threaded to all three finalization call sites
 * (event-route ×2 + DirectEventSink) — remote branch CAS, issue-level
 * closeout (entry A) and the fire-and-forget trailing sweep.
 */
export type LifecycleShipInfra = Pick<
	PostShipDeps,
	| "remoteBranchCleanup"
	| "issueCloseout"
	| "postShipSweep"
	| "preArbitrate"
	| "withIssueLifecycleMutex"
	| "forceShippedHusks"
>;

export interface PostShipDeps {
	store: StateStore;
	projects: ProjectEntry[];
	/**
	 * FLY-603 Layer A: optional worktree-cleanup closure, built at the Bridge
	 * composition root and threaded into all three finalization call sites so
	 * the HTTP /events router (which has no WorktreeManager) can clean too.
	 * Absent → no worktree cleanup (byte-compat for callers that don't wire it).
	 */
	removeCleanWorktree?: WorktreeCleanupFn;
	/**
	 * FLY-799: optional auto-Linear-Done closure. Because this whole orchestrator
	 * runs ONLY on confirmed merge evidence (isPostApproveShipComplete), calling
	 * it here is the structural ship-success gate — a shipped issue flips to Done.
	 * Best-effort (never throws). Absent → no Linear transition (byte-compat).
	 */
	markIssueDone?: LinearDoneFinalizer;
	/**
	 * FLY-1770: the resumable land path must durably classify the Linear Done
	 * outcome before it can record local finalization completion. A deferred
	 * SaaS write is settled by the independent slow sweep.
	 */
	recordLinearDoneDisposition?: (input: {
		disposition: "done" | "canceled_refused" | "deferred";
		reason: string;
	}) =>
		| { ok: true; idempotentReplay: boolean }
		| { ok: false; reason: string }
		| Promise<
				{ ok: true; idempotentReplay: boolean } | { ok: false; reason: string }
		  >;
	/**
	 * FLY-1185 §2.4: ship-time immediate remote-branch delete — consumes the
	 * Layer A pre-delete attestation returned by `removeCleanWorktree` (never
	 * re-reads the destroyed admin marker). Best-effort; absent → no remote
	 * delete (the sweep owns the remainder; byte-compat).
	 */
	remoteBranchCleanup?: (input: {
		executionId: string;
		issueId: string;
		projectName: string;
		attestation: import("./worktree-cleanup.js").WorktreeCleanupAttestation;
	}) => Promise<void>;
	/**
	 * FLY-1185 §2.6: fire-and-forget project sweep after a ship — the moment
	 * of highest fresh-garbage probability. Never awaited, never throws into
	 * the orchestrator. Absent → no trailing sweep (byte-compat).
	 */
	postShipSweep?: (projectName: string) => void;
	/**
	 * FLY-1185 §2.12 (A entry): issue-level closeout — collect ALL related
	 * nodes (phases + auto-QA children) under the `shipped` disposition and
	 * drive the full checklist. Runs AFTER the classic per-session steps.
	 * Best-effort; absent → classic behavior only (byte-compat).
	 */
	issueCloseout?: (input: {
		executionId: string;
		issueId: string;
		issueIdentifier?: string;
		projectName: string;
		/** R4#3: the post-ship DAG already holds the canonical issue mutex. */
		alreadyLocked?: boolean;
	}) => Promise<
		| {
				outcome:
					| "complete"
					| "completed"
					| "partial"
					| "needs_operator"
					| "blocked"
					| "conflict";
				cause?: LandCloseoutCause;
		  }
		| undefined
	>;
	/**
	 * Codex R2#8: disposition PRE-arbitration — runs BEFORE the first
	 * destructive step (tmux close). An active founder-park tombstone or a
	 * canceled Linear disposition (fresh lookup when available, persisted
	 * observation as the durable floor) refuses the ENTIRE ship DAG with zero
	 * mutation. The closeout's own in-mutex arbitration (step 1.7) remains
	 * the second line for authority changes landing mid-DAG. Absent →
	 * byte-compat (arbitration only inside the closeout).
	 */
	preArbitrate?: (
		issueId: string,
		projectName: string,
		/** R4#3: the caller already holds the canonical issue mutex. */
		alreadyLocked?: boolean,
	) => Promise<
		| { ok: true; degraded?: "linear_unreachable" }
		| { ok: false; reason: string; retryable?: boolean }
	>;
	/**
	 * FLY-1185 (Codex R4#3): canonical issue mutex for the ENTIRE ship DAG —
	 * arbitration, dedupe claim, tmux/worktree/branch teardown, closeout,
	 * archive and Linear Done all run inside ONE hold, so a founder park can
	 * never interleave between the arbitration check and a later mutation
	 * (plan.md:145 zero-cross-mutation). When set, `preArbitrate` and
	 * `issueCloseout` receive `alreadyLocked` (the keyed lock is not
	 * re-entrant). Absent → legacy check-then-act (byte-compat).
	 */
	withIssueLifecycleMutex?: <T>(
		issueId: string,
		fn: () => Promise<T>,
	) => Promise<T>;
	/**
	 * FLY-887: close the issue's still-alive parked design + implement phase
	 * sessions (DAG workflow keep-alive) BEFORE the shared worktree is removed — the
	 * parked phases' cwd is inside it, so they must be torn down first. No-op for a
	 * single-session issue and for keep-alive OFF (both leave no parked phases).
	 * Never throws. Absent → no phase finalization (byte-compat).
	 */
	finalizeWorkflowPhaseRoles?: (
		issueId: string,
		projectName: string,
		/** R5#3: the post-ship DAG already holds the canonical issue mutex — the
		 * finalizer's inner closeRunner must skip the (non-re-entrant) lifecycle
		 * close guard or it self-deadlocks against the outer hold. */
		alreadyLocked?: boolean,
		/** FLY-2027: exact land-run authority for workflow-bound main actors. */
		runId?: string,
	) => Promise<void>;
	/**
	 * FLY-907 (Step 4.1c / plan §2.5 form (a)): the unified issue-display
	 * refresh (AWAITED variant). Called AFTER `finalizeWorkflowPhaseRoles` (so it
	 * reads the phases already at their terminal `completed` status) and BEFORE
	 * the notifier/archive steps (a rename/edit must land while the thread is
	 * still un-archived) — the ship-terminal contract: title ✅完成, header all
	 * ✅, status line done/done/done, never a leftover 「进行中」. Best-effort;
	 * absent → no refresh (byte-compat).
	 */
	refreshIssueDisplay?: (issueId: string) => Promise<void>;
	/**
	 * FLY-1165 test seams for the thread-teardown stage (threaded into the
	 * shared archive sink + the ready-to-close notifier). Absent → real
	 * implementations (byte-compat).
	 */
	archiveFn?: typeof archiveChatThread;
	removeUserFn?: typeof removeUserFromChatThread;
	fetchImpl?: typeof fetch;
	/** FLY-1992: evidence-gated cleanup for shipped workflow-node husks. */
	forceShippedHusks?: typeof forceShippedHusks;
}

/**
 * FLY-887: build the ship-time finalizer for a DAG workflow issue's still-alive
 * parked phases. Closes the parked design + implement sessions DIRECTLY via
 * `closeRunner({ finalizeDone })` (NOT `closePhaseRunner`, which owns the
 * handoff-era worktree removal — the shared worktree is removed once by
 * `removeCleanWorktree` AFTER this runs) and drops the issue's TURN row. Their
 * FINALIZE_DONE source statuses (design_done / awaiting_review) transition to
 * completed → the FLY-369 archive cascade then fires once all runners are closed.
 * No-op for a single-session issue (no phase sessions) and for keep-alive OFF
 * (no parked phases). Never throws.
 *
 * `refreshPhaseStatusLine` (optional — a founder-visibility real-machine QA
 * finding): called AFTER the phases above are closed, so the status line's
 * final refresh reads all three phases already at their terminal `completed`
 * status and renders the documented done/done/done state, instead of going
 * stale at whatever it last showed pre-merge. Best-effort — swallowed on error,
 * absent → no refresh (byte-compat for callers that don't wire it).
 */
/**
 * FLY-1204: the phase statuses ship-finalization reclaims. The FINALIZE_DONE
 * source states (running/awaiting_review/approved_to_ship/design_done) transition
 * to `completed` via the FSM; `completed` is added because a shipped QA phase-session
 * lands there and would otherwise leak alive (the primary FLY-1204 defect) — a
 * `completed` session is already terminal, so `closeRunner` skips the FSM step and
 * just tears down its tmux (idempotent when already gone).
 */
const RECLAIMABLE_PHASE_STATUSES = new Set<string>([
	...FINALIZE_DONE_SOURCE_STATES,
	"completed",
]);

export function makeFinalizeWorkflowPhaseRoles(
	store: StateStore,
	transitionOpts: ApplyTransitionOpts,
	refreshPhaseStatusLine?: (issueId: string) => Promise<void>,
): (
	issueId: string,
	projectName: string,
	alreadyLocked?: boolean,
	runId?: string,
) => Promise<void> {
	return async (issueId, projectName, alreadyLocked, runId) => {
		const phases = store.getPhaseSessionsForIssue(issueId).filter(
			(s) =>
				(s.chat_thread_role === "design" ||
					s.chat_thread_role === "implement" ||
					// FLY-1204: reclaim the QA phase too — the fragile
					// postMergeTmuxCleanup trigger chain often leaves it leaked alive.
					s.chat_thread_role === "qa") &&
				RECLAIMABLE_PHASE_STATUSES.has(s.status),
		);
		const workflowManagedMain = runId
			? store
					.getWorkflowManagedSessionsForIssue(issueId)
					.filter(
						(session) =>
							session.chat_thread_role === "main" &&
							Boolean(session.workflow_node_id) &&
							RECLAIMABLE_PHASE_STATUSES.has(session.status) &&
							store
								.listWorkflowActivationsForActor(session.execution_id)
								.some(
									(activation) =>
										activation.run_id === runId &&
										activation.node_id === session.workflow_node_id,
								),
					)
			: [];
		for (const p of [...phases, ...workflowManagedMain]) {
			try {
				const res = await closeRunner(
					{
						executionId: p.execution_id,
						issueId: p.issue_id,
						projectName: p.project_name ?? projectName,
						reason: "DAG workflow ship finalization",
						executorType: p.chat_thread_role === "main" ? "workflow" : "phase",
						finalizeDone: true,
						transitionOpts,
						// R5#3: when the post-ship DAG already holds the issue mutex,
						// skip the non-re-entrant lifecycle close guard (else the
						// inner closeRunner re-acquires the SAME lock → deadlock).
						...(alreadyLocked && { skipLifecycleGuard: true }),
					},
					store,
				);
				if (!res.closed || !res.commDbFinalized) {
					console.warn(
						`[post-ship] finalize phase ${p.execution_id} incomplete: ${res.error ?? "?"}`,
					);
				}
			} catch (err) {
				console.warn(
					`[post-ship] finalize phase ${p.execution_id} threw: ${(err as Error).message}`,
				);
			}
		}
		if (refreshPhaseStatusLine) {
			try {
				await refreshPhaseStatusLine(issueId);
			} catch (err) {
				console.warn(
					`[post-ship] final phase-status-line refresh failed for ${issueId}: ${(err as Error).message}`,
				);
			}
		}
		// The single-writer lease is done — drop the TURN row.
		try {
			const db = new CommDB(commDbPathForProject(projectName));
			try {
				db.deleteTurn(issueId);
			} finally {
				db.close();
			}
		} catch (err) {
			console.warn(
				`[post-ship] deleteTurn(${issueId}) failed: ${(err as Error).message}`,
			);
		}
	};
}

/**
 * Serialized post-ship orchestrator. Never throws.
 *
 * Codex Round 1 (post-Round 4 cycle): Atomic orchestrator-level claim.
 * Without a claim at this level, DES + event-route dual paths can both pass
 * the predicate and each call `runPostShipFinalization`. The notifier's own
 * UNIQUE claim makes the loser RETURN EARLY, but the loser's caller still
 * falls through to `removeUserFromChatThread` + `archiveChatThread` — racing
 * the winner's still-in-flight Discord POST. Result: thread archived before
 * the "🏁 可关闭" message lands, and teardown runs twice.
 *
 * Claim at this level ensures only one call performs tmux cleanup + notifier
 * + thread teardown as a single serialized pipeline.
 */
export async function runPostShipFinalization(
	opts: PostShipOpts,
	deps: PostShipDeps,
): Promise<void> {
	// R4#3 (plan.md:145): when the canonical issue mutex is wired, the ENTIRE
	// ship DAG — arbitration, dedupe claim, every teardown mutation, closeout,
	// archive, Linear Done — runs inside ONE hold. A founder park serializes
	// strictly before or after the whole DAG, never between its steps.
	if (deps.withIssueLifecycleMutex) {
		await deps.withIssueLifecycleMutex(opts.issueId, () =>
			runPostShipFinalizationInner(opts, deps, true, false),
		);
		return;
	}
	await runPostShipFinalizationInner(opts, deps, false, false);
}

export interface ResumablePostShipFinalizationReport {
	complete: boolean;
	outcome: "completed" | "partial" | "held";
	reason?: string;
	cause?: { token: LandCloseoutCause; executionIds?: string[] };
	details: {
		tmuxClosed?: boolean;
		commDbFinalized?: boolean;
		closeoutBlocked?: boolean;
		worktreeRemoved?: boolean;
		threadArchived?: boolean;
		issueDone?: boolean;
		linearDoneDisposition?: "done" | "canceled_refused" | "deferred";
	};
}

type ResumableLinearDoneReport = {
	issueDone: boolean;
	disposition: "done" | "canceled_refused" | "deferred";
	reason: string;
	recorded: boolean;
};

async function reconcileResumableLinearDone(
	opts: PostShipOpts,
	deps: PostShipDeps,
): Promise<ResumableLinearDoneReport> {
	let issueDone = false;
	let disposition: ResumableLinearDoneReport["disposition"] =
		"canceled_refused";
	let reason = "linear_finalizer_unavailable";
	if (deps.markIssueDone) {
		const result = (await raceMarkIssueDoneWithAbort(
			deps.markIssueDone,
			opts.issueId,
			opts.issueIdentifier,
			15_000,
			{ timeoutReason: "mark_issue_done_timeout" },
		)) ?? { done: false, reason: "linear_done_result_missing" };
		issueDone = result.done === true;
		reason = result.reason ?? (result.done ? "done" : "linear_done_failed");
		disposition = result.done
			? "done"
			: result.reason === "issue_canceled_never_overwritten"
				? "canceled_refused"
				: "deferred";
	}
	reason = normalizeLandLinearDoneReason(reason);

	const recorded = deps.recordLinearDoneDisposition
		? await Promise.resolve(
				deps.recordLinearDoneDisposition({ disposition, reason }),
			).catch((err) => ({
				ok: false as const,
				reason: (err as Error).message,
			}))
		: {
				ok: false as const,
				reason: "linear_done_disposition_recorder_missing",
			};
	if (!recorded.ok) {
		console.error(
			`[post-ship] Linear Done disposition was not recorded for ${opts.issueIdentifier ?? opts.issueId}: ${recorded.reason}`,
		);
	}
	return { issueDone, disposition, reason, recorded: recorded.ok };
}

/** Land replay treats the old once-claim as started evidence, not completion. */
export async function runResumablePostShipFinalization(
	opts: PostShipOpts,
	deps: PostShipDeps,
): Promise<ResumablePostShipFinalizationReport> {
	if (deps.withIssueLifecycleMutex) {
		return deps.withIssueLifecycleMutex(opts.issueId, () =>
			runPostShipFinalizationInner(opts, deps, true, true),
		);
	}
	return runPostShipFinalizationInner(opts, deps, false, true);
}

async function runPostShipFinalizationInner(
	opts: PostShipOpts,
	deps: PostShipDeps,
	dagLocked: boolean,
	resumable: boolean,
): Promise<ResumablePostShipFinalizationReport> {
	const { store, projects } = deps;
	const landManaged = resumable && !!opts.landOperation;
	const replayCompletedFinalization =
		async (): Promise<ResumablePostShipFinalizationReport> => {
			if (!resumable) {
				return { complete: true, outcome: "completed", details: {} };
			}
			const linear = await reconcileResumableLinearDone(opts, deps);
			if (!linear.recorded) {
				return {
					complete: false,
					outcome: "partial",
					reason: "land_linear_done_disposition_incomplete",
					details: {
						issueDone: linear.issueDone,
						linearDoneDisposition: linear.disposition,
					},
				};
			}
			return {
				complete: true,
				outcome: "completed",
				details: {
					issueDone: linear.issueDone,
					linearDoneDisposition: linear.disposition,
				},
			};
		};

	// ── (0.9) Codex R2#8 + R3#9: disposition pre-arbitration — BEFORE any
	// mutation AND before the dedupe claim, so a refusal never consumes the
	// once-only finalization claim (a later legitimate retry still runs).
	// A founder-parked or canceled issue refuses the whole ship DAG here (the
	// tmux close / worktree delete / branch delete below never run). ──
	if (deps.preArbitrate) {
		const arb = await deps
			.preArbitrate(opts.issueId, opts.projectName, dagLocked)
			.catch(
				(
					err,
				): {
					ok: false;
					reason: string;
					retryable: true;
				} => ({
					ok: false,
					reason: `arbitration_failed:${(err as Error).message}`,
					retryable: true,
				}),
			);
		if (!arb.ok) {
			console.warn(
				`[post-ship] disposition pre-arbitration refused ship finalization for ${opts.issueIdentifier ?? opts.issueId}: ${arb.reason ?? "conflict"} — ZERO mutation`,
			);
			store.insertEvent({
				event_id: `post-ship-arbitration-refused-${opts.executionId}`,
				execution_id: opts.executionId,
				issue_id: opts.issueId,
				project_name: opts.projectName,
				event_type: "post_ship_arbitration_refused",
				source: "bridge.post-ship-finalization",
				payload: { reason: arb.reason ?? "conflict" },
			});
			return {
				complete: false,
				outcome: resumable && arb.retryable ? "partial" : "held",
				reason: arb.reason ?? "disposition_conflict",
				details: {},
			};
		}
		if (arb.degraded) {
			if (!resumable) {
				store.insertEvent({
					event_id: `post-ship-arbitration-refused-${opts.executionId}`,
					execution_id: opts.executionId,
					issue_id: opts.issueId,
					project_name: opts.projectName,
					event_type: "post_ship_arbitration_refused",
					source: "bridge.post-ship-finalization",
					payload: { reason: "linear_lookup_failed_retryable" },
				});
				return {
					complete: false,
					outcome: "held",
					reason: "linear_lookup_failed_retryable",
					details: {},
				};
			}
			store.insertEvent({
				event_id: `post-ship-arbitration-degraded-${opts.executionId}`,
				execution_id: opts.executionId,
				issue_id: opts.issueId,
				project_name: opts.projectName,
				event_type: "post_ship_arbitration_degraded",
				source: "bridge.post-ship-finalization",
				payload: { reason: arb.degraded },
			});
		}
	}

	// FLY-1434: a workflow run may declare an exact multi-PR delivery set.
	// Claiming that run/revision is the durable closeout authority; no teardown,
	// archive, or Linear Done happens while any declared PR is still open.
	let declaredFinalization = false;
	if (opts.runId) {
		if (opts.mergedPr && store.getWorkflowPrManifest(opts.runId)) {
			const attributed = store.markWorkflowDeclaredPrMerged({
				runId: opts.runId,
				...opts.mergedPr,
			});
			if (!attributed.ok) {
				return {
					complete: false,
					outcome: "held",
					reason: `workflow_pr_manifest_merge_receipt_refused:${attributed.reason}`,
					details: {},
				};
			}
		}
		const manifestClaim = store.claimWorkflowPrFinalization({
			runId: opts.runId,
			sourceExecutionId: opts.executionId,
		});
		if (!manifestClaim.ok) {
			const held = manifestClaim.reason === "run_not_active";
			const reason =
				manifestClaim.reason === "manifest_incomplete"
					? `workflow_pr_manifest_partial:${manifestClaim.pendingCount ?? 0}; partial delivery must stay flag-off until all declared PRs merge`
					: manifestClaim.reason;
			return {
				complete: false,
				outcome: held ? "held" : "partial",
				reason,
				details: {},
			};
		}
		declaredFinalization = manifestClaim.mode === "declared";
		if (manifestClaim.mode === "declared" && manifestClaim.completed) {
			return replayCompletedFinalization();
		}
	}

	// ── (0) ATOMIC ORCHESTRATOR CLAIM ──
	// Stable event_id → UNIQUE constraint collapses concurrent callers
	// (DES + event-route dual paths) to one winner for the full pipeline.
	const claimed = store.insertEvent({
		event_id: `post-ship-finalization-${opts.executionId}`,
		execution_id: opts.executionId,
		issue_id: opts.issueId,
		project_name: opts.projectName,
		event_type: "post_ship_finalization_claim",
		source: "bridge.post-ship-finalization",
		payload: { claimedAt: new Date().toISOString() },
	});
	if (!claimed) {
		const alreadyCompleted = store
			.getEventsByExecution(opts.executionId)
			.some(
				(event) =>
					event.event_id ===
					`post-ship-finalization-completed-${opts.executionId}`,
			);
		if (alreadyCompleted) {
			return replayCompletedFinalization();
		}
		// A production caller holding the canonical issue mutex, or an explicit
		// land replay, may repair a crash after the old once-claim. Unlocked legacy
		// callers retain the original duplicate-suppression behavior.
		if (!resumable && !dagLocked) {
			return {
				complete: false,
				outcome: "partial",
				reason: "finalization_claimed_without_completion",
				details: {},
			};
		}
	}

	// (FLY-1185 Codex R1#7: the FLY-799 auto-Linear-Done step used to run HERE,
	// FIRST — before any teardown. It now runs LAST (step 3.5 below), after the
	// closeout confirmed every node gone, matching the plan's "Linear item runs
	// last" DAG edge, and it is skipped entirely when the closeout is blocked.)
	let huskForce: ForceShippedHusksResult | undefined;
	if (landManaged) {
		const context = opts.landOperation!;
		huskForce = await (deps.forceShippedHusks ?? forceShippedHusks)(
			{
				issueId: opts.issueId,
				projectName: opts.projectName,
				operationId: context.operationId,
				claim: {
					operationId: context.operationId,
					ownerId: context.ownerId,
					generation: context.generation,
				},
			},
			store,
		).catch((error) => {
			console.error(
				"[post-ship] shipped husk escalation failed:",
				(error as Error).message,
			);
			return { cleared: [] };
		});
	}

	// ── (1) tmux cleanup — idempotent; preserved contract { tmuxClosed, errors } ──
	const cleanup = await postMergeTmuxCleanup(
		{
			executionId: opts.executionId,
			issueId: opts.issueId,
			projectName: opts.projectName,
		},
		store,
	).catch((err) => {
		console.error(
			`[post-ship] postMergeTmuxCleanup failed:`,
			(err as Error).message,
		);
		return {
			tmuxClosed: false,
			commDbFinalized: false,
			retiredGateCount: 0,
			errors: [(err as Error).message],
		};
	});

	// ── (1.25) FLY-887 DAG workflow keep-alive: close the still-alive parked
	// design + implement phases for this issue BEFORE the shared worktree is
	// removed below (their cwd is inside it). No-op for single-session / keep-alive
	// OFF (no parked phases exist). Never throws. ──
	if (deps.finalizeWorkflowPhaseRoles) {
		// R6#7: only pass the 3rd (alreadyLocked) arg when the DAG actually holds
		// the mutex — non-locked callers keep the original 2-arg call (byte-compat
		// with the existing fly887 test seam contract).
		const finalizeCall = dagLocked
			? deps.finalizeWorkflowPhaseRoles(
					opts.issueId,
					opts.projectName,
					true,
					opts.runId,
				)
			: opts.runId
				? deps.finalizeWorkflowPhaseRoles(
						opts.issueId,
						opts.projectName,
						undefined,
						opts.runId,
					)
				: deps.finalizeWorkflowPhaseRoles(opts.issueId, opts.projectName);
		await finalizeCall.catch((err) => {
			console.error(
				`[post-ship] finalizeWorkflowPhaseRoles failed:`,
				(err as Error).message,
			);
		});
	}

	// ── (1.3) FLY-907 final terminal-state display refresh — AFTER phase
	// finalization (reads phases already `completed`), BEFORE the notifier +
	// archive below (a title rename / pin edit must land while the thread is
	// still un-archived). Best-effort; never blocks teardown. ──
	if (deps.refreshIssueDisplay) {
		await deps.refreshIssueDisplay(opts.issueId).catch((err) => {
			console.error(
				`[post-ship] final issue-display refresh failed:`,
				(err as Error).message,
			);
		});
	}

	// FLY-1375: land replay calls this only after issue-level closeout confirms
	// every related session is gone. Legacy callers retain their prior order.
	const cleanWorktree = async (closeoutConfirmed = false) => {
		if (!deps.removeCleanWorktree) return undefined;
		const attestation = await deps
			.removeCleanWorktree({
				executionId: opts.executionId,
				issueId: opts.issueId,
				issueIdentifier: opts.issueIdentifier,
				projectName: opts.projectName,
				tmuxClosed:
					cleanup.tmuxClosed ||
					(resumable && closeoutConfirmed && cleanup.commDbFinalized),
				tmuxErrors: cleanup.errors,
			})
			.catch((err) => {
				console.error(
					`[post-ship] worktree cleanup failed:`,
					(err as Error).message,
				);
				return undefined;
			});

		// ── (1.6) FLY-1185 §2.4: ship-time remote-branch delete, driven ONLY by
		// the pre-delete attestation (bindingVerified + actualBranch + headSha
		// captured BEFORE the removal destroyed the admin marker). Ineligible
		// attestations audit `remote_delete_skipped` inside the closure and the
		// sweep owns the remainder. ──
		if (attestation && deps.remoteBranchCleanup) {
			await deps
				.remoteBranchCleanup({
					executionId: opts.executionId,
					issueId: opts.issueId,
					projectName: opts.projectName,
					attestation,
				})
				.catch((err) => {
					console.error(
						`[post-ship] remote branch cleanup failed:`,
						(err as Error).message,
					);
				});
		}
		return attestation;
	};
	if (!resumable) await cleanWorktree();

	// ── (1.7) FLY-1185 §2.12 entry A: issue-level lifecycle closeout —
	// collect ALL related nodes (parked phases already finalized above,
	// auto-QA children, launch claims) under the `shipped` disposition and
	// drive the remaining checklist items. Best-effort. ──
	// Codex R1#3: CONSUME the closure report — a blocked/conflict closeout
	// (some node not confirmed gone, or a canceled-vs-shipped conflict) must
	// NOT be followed by thread archive or the Linear Done write. The sweep /
	// next finalization pass is the eventual repair.
	let closeoutCause: LandCloseoutCause | undefined = huskForce?.cause
		? huskForce.cause === "authority_lost"
			? "lifecycle_conflict"
			: huskForce.cause
		: undefined;
	let closeoutBlocked = Boolean(huskForce?.cause) || !cleanup.commDbFinalized;
	if (closeoutBlocked) {
		closeoutCause ??= inferLandCloseoutCause(cleanup.errors);
		console.warn(
			`[post-ship] CommDB finalization incomplete for ${opts.executionId} — thread archive + Linear Done deferred`,
		);
	}
	if (deps.issueCloseout) {
		const closeoutRes = await deps
			.issueCloseout({
				executionId: opts.executionId,
				issueId: opts.issueId,
				issueIdentifier: opts.issueIdentifier,
				projectName: opts.projectName,
				// R4#3: the whole DAG already holds the canonical issue mutex.
				alreadyLocked: dagLocked,
			})
			.catch((err) => {
				console.error(
					`[post-ship] issue closeout failed:`,
					(err as Error).message,
				);
				return { outcome: "blocked" as const, cause: undefined };
			});
		if (
			closeoutRes?.outcome !== "complete" &&
			closeoutRes?.outcome !== "completed"
		) {
			closeoutCause ??= closeoutRes?.cause;
		}
		if (
			closeoutRes &&
			(closeoutRes.outcome === "blocked" || closeoutRes.outcome === "conflict")
		) {
			closeoutBlocked = true;
			closeoutCause ??= "lifecycle_conflict";
			console.warn(
				`[post-ship] issue closeout ${closeoutRes.outcome} for ${opts.issueIdentifier ?? opts.issueId} — thread archive + Linear Done deferred to the next pass`,
			);
		} else if (
			closeoutRes &&
			(closeoutRes.outcome === "partial" ||
				closeoutRes.outcome === "needs_operator")
		) {
			console.warn(
				`[post-ship] issue closeout ${closeoutRes.outcome} for ${opts.issueIdentifier ?? opts.issueId}${closeoutRes.cause ? ` (${closeoutRes.cause})` : ""} — diagnostic retained; terminal closeout remains eligible`,
			);
		}
	}
	let worktreeRemoved = !resumable;
	if (resumable && !closeoutBlocked) {
		const attestation = await cleanWorktree(true);
		worktreeRemoved =
			attestation?.removed === true ||
			attestation?.skippedReason === "not_registered";
	}

	// ── Resolve lead + thread ONCE, reused by notifier AND archiver ──
	let chatChannel: string | undefined;
	let botToken: string | undefined;
	try {
		const labels = store.getSessionLabels(opts.executionId);
		const { lead } = resolveLeadForIssue(projects, opts.projectName, labels);
		chatChannel = lead.chatChannel;
		botToken = lead.botToken ?? opts.fallbackBotToken;
	} catch (err) {
		console.warn(
			`[post-ship] resolveLeadForIssue failed:`,
			(err as Error).message,
		);
		botToken = opts.fallbackBotToken;
	}
	const thread = chatChannel
		? store.getChatThreadByIssue(opts.issueId, chatChannel)
		: undefined;

	// ── (2) notifier — atomic dedupe; MUST run BEFORE archive ──
	// FLY-892 (Step 3): tag which phase's runner finished; "" for main (byte-compat).
	const finalizedSession = store.getSession(opts.executionId);
	await emitRunnerReadyToCloseNotification(
		{
			executionId: opts.executionId,
			issueId: opts.issueId,
			issueIdentifier: opts.issueIdentifier,
			projectName: opts.projectName,
			sessionStatus: opts.sessionStatus,
			tmuxClosed: cleanup.tmuxClosed,
			errors: cleanup.errors?.length ? cleanup.errors : undefined,
			thread,
			botToken,
			phasePrefix: phaseMessageTag(
				finalizedSession?.chat_thread_role,
				finalizedSession?.runner_model,
				finalizedSession?.design_backend,
			),
		},
		{ store, fetchImpl: deps.fetchImpl },
	);

	// FLY-1832: the resumable land operation owns one terminal founder message.
	// It is generation-fenced and must settle only after closeout + worktree
	// cleanup; archive is the final Discord mutation after this receipt.
	const landReady = !closeoutBlocked && worktreeRemoved;
	let terminalNotified = !landManaged || !thread;
	if (landManaged && thread && landReady) {
		const context = opts.landOperation!;
		const operation = store.getLandOperation(context.operationId);
		const prNumber = opts.mergedPr?.prNumber ?? operation?.pr_number;
		const terminalReceipt = {
			threadId: thread.thread_id,
			prNumber: prNumber ?? null,
		};
		const prior = store
			.listLandOperationSteps(context.operationId)
			.find((step) => step.step === "terminal_notified");
		if (prior) {
			terminalNotified = store.recordLandOperationStep({
				operationId: context.operationId,
				ownerId: context.ownerId,
				generation: context.generation,
				step: "terminal_notified",
				receipt: terminalReceipt,
				now: new Date().toISOString(),
			}).ok;
		} else if (botToken) {
			const terminal = await emitIssueThreadInfraNotification(
				{
					executionId: opts.executionId,
					issueId: opts.issueId,
					issueIdentifier: opts.issueIdentifier,
					projectName: opts.projectName,
					kind: "land_terminal",
					content: [
						`✅ **已合入 PR #${prNumber ?? "?"} — ${opts.issueIdentifier ?? opts.issueId}**`,
						"清理完成(worktree / runner 已收),本 thread 将自动归档;Linear 状态随后落 Done。",
					].join("\n"),
					thread,
					botToken,
					onUndeliverable: (reason) =>
						console.warn(
							`[post-ship] terminal founder notification undeliverable for ${opts.issueId}: ${reason}`,
						),
				},
				{ store, fetchImpl: deps.fetchImpl },
			);
			if (terminal.kind === "posted") {
				const recorded = store.recordLandOperationStep({
					operationId: context.operationId,
					ownerId: context.ownerId,
					generation: context.generation,
					step: "terminal_notified",
					receipt: terminalReceipt,
					now: new Date().toISOString(),
				});
				terminalNotified = recorded.ok;
			}
		}
		if (!terminalNotified) {
			return {
				complete: false,
				outcome: "partial",
				reason: "land_terminal_notification_incomplete",
				details: {
					tmuxClosed: cleanup.tmuxClosed,
					commDbFinalized: cleanup.commDbFinalized,
					closeoutBlocked: false,
					worktreeRemoved,
					threadArchived: false,
				},
			};
		}
	}

	// ── (3) thread teardown — only after notifier has landed AND the issue
	// closeout confirmed every related node gone (Codex R1#3: an archive over
	// a blocked closeout would hide a still-live runner). ──
	let threadArchived = !resumable || !thread;
	if (
		thread &&
		botToken &&
		!closeoutBlocked &&
		(!landManaged || (landReady && terminalNotified))
	) {
		// FLY-1165: route through the shared archive sink — per-thread
		// serialization + the sink-level archive-once guard (a founder re-open
		// is never fought; matches the cascade + endpoint paths). The owner
		// removal is folded into the sink (no double removal), the audit event
		// keeps this path's source, and `reason: "already_archived"` is an
		// idempotent no-op success — NEVER a chat_thread_archive_failed.
		const archive = await archiveThreadAndRecord(
			store,
			{
				threadId: thread.thread_id,
				issueId: opts.issueId,
				projectName: opts.projectName,
				executionId: opts.executionId,
			},
			botToken,
			{
				discordOwnerUserId: opts.discordOwnerUserId,
				auditSource: "bridge.post-ship-finalization",
				archiveFn: deps.archiveFn,
				removeUserFn: deps.removeUserFn,
				fetchImpl: deps.fetchImpl,
			},
		);
		threadArchived = isArchiveObligationSettled(archive);
		if (
			archive.reason === "founder_reopened" ||
			archive.reason === "in_active_use"
		) {
			console.log(
				`[post-ship] thread archive waived for ${opts.issueId}: ${archive.reason}`,
			);
			if (landManaged) {
				const context = opts.landOperation!;
				const waiverReceipt = {
					reason: archive.reason,
					archiveEpoch: thread.archived_at ?? "open",
				};
				const prior = store
					.listLandOperationSteps(context.operationId)
					.find((step) => step.step === "archive_waiver_notified");
				if (!prior) {
					const explained = await emitIssueThreadInfraNotification(
						{
							executionId: opts.executionId,
							issueId: opts.issueId,
							issueIdentifier: opts.issueIdentifier,
							projectName: opts.projectName,
							kind: "land_archive_waiver",
							content:
								archive.reason === "founder_reopened"
									? "ℹ️ 本 thread 未自动归档:founder 已重新打开；系统会保持 thread 开放且不会自动重试归档，请 Lead 确认后手动归档。"
									: "ℹ️ 本 thread 未自动归档:仍有活跃使用者；原因解除后会由清理流程重试。",
							thread,
							botToken,
							onUndeliverable: (reason) =>
								console.warn(
									`[post-ship] archive waiver explanation undeliverable for ${opts.issueId}: ${reason}`,
								),
						},
						{ store, fetchImpl: deps.fetchImpl },
					);
					if (explained.kind !== "posted") {
						return {
							complete: false,
							outcome: "partial",
							reason: "land_archive_waiver_notification_incomplete",
							details: {
								tmuxClosed: cleanup.tmuxClosed,
								commDbFinalized: cleanup.commDbFinalized,
								closeoutBlocked: false,
								worktreeRemoved,
								threadArchived: false,
							},
						};
					}
				}
				const recorded = store.recordLandOperationStep({
					operationId: context.operationId,
					ownerId: context.ownerId,
					generation: context.generation,
					step: "archive_waiver_notified",
					receipt: waiverReceipt,
					now: new Date().toISOString(),
				});
				if (!recorded.ok) {
					return {
						complete: false,
						outcome: "partial",
						reason: `land_archive_waiver_receipt_incomplete:${recorded.reason}`,
						details: {
							tmuxClosed: cleanup.tmuxClosed,
							commDbFinalized: cleanup.commDbFinalized,
							closeoutBlocked: false,
							worktreeRemoved,
							threadArchived: false,
						},
					};
				}
			}
		}
	}

	// ── (3.5) FLY-799 auto-Linear-Done — moved LAST (Codex R1#7): the Linear
	// write is the closeout DAG's final item, so it runs only after the
	// closeout confirmed all nodes gone (never over a blocked closeout, and
	// the finalizer itself re-reads fresh Linear state so a founder-canceled
	// issue is never overwritten to Done). Best-effort AND time-bounded. ──
	let issueDone = !resumable;
	let linearDoneDisposition:
		| "done"
		| "canceled_refused"
		| "deferred"
		| undefined;
	let linearDispositionRecorded = !resumable;
	if (
		!closeoutBlocked &&
		resumable &&
		(!landManaged || (landReady && terminalNotified && threadArchived))
	) {
		const linear = await reconcileResumableLinearDone(opts, deps);
		issueDone = linear.issueDone;
		linearDoneDisposition = linear.disposition;
		linearDispositionRecorded = linear.recorded;
	} else if (!closeoutBlocked && !resumable && deps.markIssueDone) {
		await raceMarkIssueDoneWithAbort(
			deps.markIssueDone,
			opts.issueId,
			opts.issueIdentifier,
			15_000,
			{
				timeoutReason: "mark_issue_done_timeout",
				onTimeout: (timeoutMs) =>
					console.warn(
						`[post-ship] markIssueDone timed out after ${timeoutMs}ms for ${opts.issueIdentifier ?? opts.issueId} — issue left not-Done (Done-sweep / manual close can resolve)`,
					),
				onRejected: (error) =>
					console.error(`[post-ship] markIssueDone failed:`, error.message),
			},
		);
	}

	// ── (4) FLY-1185 §2.6: fire-and-forget trailing project sweep — the
	// moment right after a merge has the highest fresh-garbage probability.
	// Never awaited; a failure to START never affects the finalization. ──
	if (deps.postShipSweep) {
		try {
			deps.postShipSweep(opts.projectName);
		} catch (err) {
			console.warn(
				`[post-ship] trailing sweep failed to start:`,
				(err as Error).message,
			);
		}
	}
	if (closeoutBlocked) {
		const cause = closeoutCause ?? "unknown";
		const reason = landCloseoutReason(cause);
		if (declaredFinalization && opts.runId) {
			store.setWorkflowPrFinalizationOutcome({
				runId: opts.runId,
				completed: false,
				error: reason,
			});
		}
		return {
			complete: false,
			outcome: "partial",
			reason,
			cause: {
				token: cause,
				...(huskForce?.affectedExecutionIds?.length
					? { executionIds: huskForce.affectedExecutionIds }
					: {}),
			},
			details: {
				tmuxClosed: cleanup.tmuxClosed,
				commDbFinalized: cleanup.commDbFinalized,
				closeoutBlocked: true,
			},
		};
	}
	if (
		resumable &&
		!linearDispositionRecorded &&
		(!landManaged || (landReady && terminalNotified && threadArchived))
	) {
		return {
			complete: false,
			outcome: "partial",
			reason: "land_linear_done_disposition_incomplete",
			details: {
				tmuxClosed: cleanup.tmuxClosed,
				commDbFinalized: cleanup.commDbFinalized,
				closeoutBlocked: false,
				worktreeRemoved,
				threadArchived,
				issueDone,
				...(linearDoneDisposition ? { linearDoneDisposition } : {}),
			},
		};
	}
	if (resumable && (!worktreeRemoved || !threadArchived)) {
		const postconditionCause: LandCloseoutCause = !worktreeRemoved
			? "worktree_branch_mismatch"
			: "archive_failed";
		const reason = landCloseoutReason(postconditionCause);
		if (declaredFinalization && opts.runId) {
			store.setWorkflowPrFinalizationOutcome({
				runId: opts.runId,
				completed: false,
				error: reason,
			});
		}
		return {
			complete: false,
			outcome: "partial",
			reason,
			cause: { token: postconditionCause },
			details: {
				tmuxClosed: cleanup.tmuxClosed,
				commDbFinalized: cleanup.commDbFinalized,
				closeoutBlocked: false,
				worktreeRemoved,
				threadArchived,
				issueDone,
				...(linearDoneDisposition ? { linearDoneDisposition } : {}),
			},
		};
	}

	store.insertEvent({
		event_id: `post-ship-finalization-completed-${opts.executionId}`,
		execution_id: opts.executionId,
		issue_id: opts.issueId,
		project_name: opts.projectName,
		event_type: "post_ship_finalization_completed",
		source: "bridge.post-ship-finalization",
		payload: { completedAt: new Date().toISOString() },
	});
	if (declaredFinalization && opts.runId) {
		store.setWorkflowPrFinalizationOutcome({
			runId: opts.runId,
			completed: true,
		});
	}
	return {
		complete: true,
		outcome: "completed",
		details: {
			tmuxClosed: cleanup.tmuxClosed,
			commDbFinalized: cleanup.commDbFinalized,
			closeoutBlocked: false,
			...(resumable
				? {
						worktreeRemoved,
						threadArchived,
						issueDone,
						...(linearDoneDisposition ? { linearDoneDisposition } : {}),
					}
				: {}),
		},
	};
}
