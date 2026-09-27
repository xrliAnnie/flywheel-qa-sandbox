import { randomUUID } from "node:crypto";
import { buildReworkWakeId, type CommDB } from "flywheel-comm/db";
import type {
	GeneralizedWorkflowAdmissionResult,
	WorkflowEngineAlertIdentity,
	WorkflowReworkDeathProof,
	WorkflowReworkDeliveryClaimResult,
	WorkflowReworkDeliveryRow,
	WorkflowReworkFailureSettlement,
	WorkflowReworkRequestRow,
	WorkflowReworkRouteRevisionRow,
	WorkflowRunNodeRow,
	WorkflowRunRow,
	WorkflowSideEffectState,
} from "../StateStore.js";
import {
	isStateStoreIrreversibleTerminalForZombie,
	workflowDeliveryReceiptNextRetryAt,
} from "../StateStore.js";
import {
	parseWorkflowRunSnapshot,
	resolveWorkflowDecisionContract,
} from "../workflow-run-snapshot.js";
import { credentialWindowForNode } from "../workflow-submission-expiry.js";
import {
	classifyPhaseActorReentry,
	type PhaseLiveness,
} from "./phase-actor-reentry.js";
import type { WorkflowActorSession } from "./workflow-actor-session.js";
import { buildWorkflowReworkContext } from "./workflow-rework-context.js";

/** FLY-2808: what a failed standby resume expected and how long it ran. */
export interface WorkflowResumeFailureEvidence {
	expectedSessionId?: string;
	expectedModel?: string;
	expectedCwd?: string;
	queueMs?: number;
	startupMs?: number;
	totalMs?: number;
}

export interface WorkflowReworkTurnInput {
	issueId: string;
	projectName: string;
	executionId: string;
	nodeId: string;
	runId: string;
	attempt: number;
	activationId: string;
	sourceEventId: string;
	outputCredential?: string;
	submissionCredential?: string;
	context: unknown;
}

/**
 * Grant a workflow TURN and return the durable grant identity. Source replay is
 * intentionally resolved from CommDB after `grantTurn`: the caller's wall clock
 * is not authoritative once the source event already exists.
 */
export function grantWorkflowReworkTurn(
	db: Pick<CommDB, "getTurn" | "grantTurn">,
	input: WorkflowReworkTurnInput,
	grantedAtMs: number,
): { epoch: number; grantedAt: string } {
	const epoch = db.grantTurn(
		input.issueId,
		input.executionId,
		input.nodeId,
		grantedAtMs,
		{
			project: input.projectName,
			sourceEventId: input.sourceEventId,
			targetRunId: input.runId,
			activation: {
				activationId: input.activationId,
				runId: input.runId,
				nodeId: input.nodeId,
				attempt: input.attempt,
				...(input.outputCredential
					? { outputCredential: input.outputCredential }
					: {}),
				...(input.submissionCredential
					? { submissionCredential: input.submissionCredential }
					: {}),
				context: input.context,
			},
		},
	);
	const persisted = db.getTurn(input.issueId);
	if (
		!persisted ||
		persisted.epoch !== epoch ||
		persisted.holder_exec_id !== input.executionId ||
		persisted.phase !== input.nodeId ||
		persisted.target_run_id !== input.runId ||
		persisted.target_node_id !== input.nodeId ||
		persisted.target_attempt !== input.attempt ||
		persisted.activation_id !== input.activationId ||
		!Number.isSafeInteger(persisted.granted_at)
	) {
		throw new Error(`workflow TURN replay mismatch: ${input.sourceEventId}`);
	}
	return {
		epoch,
		grantedAt: new Date(persisted.granted_at).toISOString(),
	};
}

export interface WorkflowReworkCoordinatorStore {
	/** FLY-2900: parked in Codex quota standby — wait, never replace. */
	isCodexQuotaStandby?(executionId: string): boolean;
	getWorkflowExecutionProcessBody?(executionId: string):
		| {
				generation: number;
				state:
					| "active"
					| "retiring"
					| "standby"
					| "resuming"
					| "resume_failed"
					| "closed";
				current_demand_id: string | null;
				owner_claim_id: string | null;
		  }
		| undefined;
	cancelWorkflowExecutionRetirementForRework?(input: {
		executionId: string;
		demandId: string;
		now: string;
	}):
		| { ok: true; generation: number; idempotentReplay: boolean }
		| { ok: false; reason: string };
	beginWorkflowExecutionResume?(input: {
		executionId: string;
		demandId: string;
		ownerClaimId: string;
		now: string;
	}):
		| {
				ok: true;
				generation: number;
				attempt: number;
				idempotentReplay: boolean;
		  }
		| { ok: false; reason: string };
	finishWorkflowExecutionResume?(input: {
		executionId: string;
		generation: number;
		demandId: string;
		ownerClaimId: string;
		expectedSessionId: string;
		observedSessionId: string;
		expectedModel: string;
		observedModel: string;
		expectedCwd: string;
		observedCwd: string;
		queueMs: number;
		startupMs: number;
		totalMs: number;
		now: string;
	}): { ok: true; idempotentReplay: boolean } | { ok: false; reason: string };
	failWorkflowExecutionResume?(input: {
		executionId: string;
		generation: number;
		demandId: string;
		ownerClaimId: string;
		reasonCode: string;
		attemptReasonCode?: string;
		evidence?: WorkflowResumeFailureEvidence;
		now: string;
	}): { ok: true; idempotentReplay: boolean } | { ok: false; reason: string };
	allocateWorkflowResumeFallback?(input: {
		executionId: string;
		demandId: string;
		newExecutionId: string;
		now: string;
		ownerId?: string;
		generation?: number;
	}):
		| {
				ok: true;
				executionId: string;
				launchOrdinal: number;
				idempotentReplay: boolean;
		  }
		| { ok: false; reason: string };
	getWorkflowReworkRequest(
		requestId: string,
	): WorkflowReworkRequestRow | undefined;
	getLatestWorkflowReworkRoute(
		requestId: string,
	): WorkflowReworkRouteRevisionRow | undefined;
	getWorkflowReworkDelivery(
		requestId: string,
	): WorkflowReworkDeliveryRow | undefined;
	getWorkflowRun(runId: string): WorkflowRunRow | undefined;
	getWorkflowRunNode(
		runId: string,
		nodeId: string,
		attempt: number,
	): WorkflowRunNodeRow | undefined;
	convergeWorkflowReworkWriterReplacement(input: {
		requestId: string;
		ownerId: string;
		generation: number;
		now: string;
	}):
		| { ok: true; executionId: string; launchOrdinal: number }
		| { ok: false; reason: string };
	claimWorkflowReworkDelivery(input: {
		requestId: string;
		ownerId: string;
		now: string;
		leaseExpiresAt: string;
	}): WorkflowReworkDeliveryClaimResult;
	releaseWorkflowReworkDelivery(input: {
		requestId: string;
		ownerId: string;
		generation: number;
		error: string;
		now: string;
	}): { ok: true } | { ok: false; reason: string };
	settleWorkflowReworkFailure(input: {
		requestId: string;
		ownerId: string;
		generation: number;
		reason: string;
		alertIdentity: WorkflowEngineAlertIdentity;
		now: string;
		forceReturn?: boolean;
	}): WorkflowReworkFailureSettlement;
	replaceWorkflowReworkActor(input: {
		requestId: string;
		ownerId: string;
		generation: number;
		deadExecutionId: string;
		newExecutionId: string;
		proof: { kind: WorkflowReworkDeathProof };
		reason: string;
		observedAt: string;
		expectedSessionLifecycleRevision?: number | null;
	}):
		| {
				ok: true;
				executionId: string;
				launchOrdinal: number;
				routeRevision: number;
				idempotentReplay: boolean;
		  }
		| { ok: false; reason: string };
	workflowReworkDeathProof(
		requestId: string,
	): WorkflowReworkDeathProof | undefined;
	getWorkflowReworkReplacementLaunch(requestId: string):
		| {
				executionId: string;
				launchOrdinal: number;
				ledgerState: WorkflowSideEffectState;
				createdAt: string;
				bindingMode: string | null;
				launchOwnerPresent: boolean;
		  }
		| undefined;
	abandonUnadmittedReworkReplacementLaunch(input: {
		requestId: string;
		ownerId: string;
		generation: number;
		reason: string;
		now: string;
	}): { ok: true } | { ok: false; reason: string };
	hasReworkReplacementContentMissingFact(input: {
		runId: string;
		requestId: string;
		routeRevision: number;
	}): boolean;
	deferWorkflowReworkDelivery(input: {
		requestId: string;
		ownerId: string;
		generation: number;
		nextRetryAt: string;
		reason: string;
	}): { ok: true } | { ok: false; reason: string };
	noteWorkflowReworkLiveness(input: {
		requestId: string;
		ownerId: string;
		generation: number;
		known: boolean;
		reason: string;
		now: string;
		alertIdentity?: WorkflowEngineAlertIdentity;
	}):
		| {
				ok: true;
				unknownSince: string | null;
				alerted: "warn" | "severe" | null;
		  }
		| { ok: false; reason: string };
	markWorkflowReworkWakeSent(input: {
		requestId: string;
		ownerId: string;
		generation: number;
		now: string;
	}): { ok: true } | { ok: false; reason: string };
	markWorkflowReworkGrantStarted(input: {
		requestId: string;
		ownerId: string;
		generation: number;
		now: string;
	}): { ok: true } | { ok: false; reason: string };
	advanceWorkflowReworkDelivery(input: {
		requestId: string;
		ownerId: string;
		generation: number;
		from: WorkflowReworkDeliveryRow["state"];
		to: WorkflowReworkDeliveryRow["state"];
		now: string;
		error?: string;
		releaseOwner?: boolean;
	}): { ok: true } | { ok: false; reason: string };
	scheduleWorkflowReworkReceiptProbe(input: {
		requestId: string;
		ownerId: string;
		generation: number;
		nextRetryAt: string;
		reason: string;
	}): { ok: true } | { ok: false; reason: string };
	admitGeneralizedWorkflowExecution(input: {
		runId: string;
		nodeId: string;
		executionId: string;
		attempt: number;
		activationId?: string;
		activationMode?: "spawn" | "wake" | "replacement";
		reworkRequestId?: string;
		expiresAt: string;
		absoluteDeadlineAt: string;
		now?: string;
		env?: Record<string, string | undefined>;
		standbyResumeEnabled?: boolean;
	}): GeneralizedWorkflowAdmissionResult;
	rotateGeneralizedWorkflowOutputCredential(input: {
		executionId: string;
		activationId?: string;
		ownerId: string;
		generation: number;
		now: string;
		expiresAt: string;
		absoluteDeadlineAt: string;
	}): { ok: true; outputCredential: string } | { ok: false; reason: string };
	rotateGeneralizedWorkflowSubmissionCredential(input: {
		executionId: string;
		activationId?: string;
		ownerId: string;
		generation: number;
		now: string;
		expiresAt: string;
		absoluteDeadlineAt: string;
	}):
		| { ok: true; submissionCredential: string }
		| { ok: false; reason: string };
	recordWorkflowActivationTurn(input: {
		activationId: string;
		issueId: string;
		executionId: string;
		epoch: number;
		sourceEventId: string;
		grantedAt: string;
	}): { ok: true; idempotentReplay: boolean } | { ok: false; reason: string };
}

export interface WorkflowReworkCoordinatorEffects {
	getActorSession(executionId: string): WorkflowActorSession | undefined;
	probeRegistered(session: WorkflowActorSession): Promise<PhaseLiveness>;
	probePersisted(session: WorkflowActorSession): Promise<PhaseLiveness>;
	hasHostProcess?(executionId: string): Promise<boolean>;
	assertWorktreeReady(
		session: WorkflowActorSession,
		expectedHeadSha: string,
		options?: { allowDirty?: boolean },
	): Promise<{ ok: boolean; reason?: string }>;
	activateActorForWake?(
		session: WorkflowActorSession,
	): Promise<{ ok: boolean; error?: string }>;
	resumeStandbyActor?(input: {
		session: WorkflowActorSession;
		demandId: string;
		ownerId: string;
		ownerGeneration: number;
		processGeneration: number;
		expectedHeadSha: string;
	}): Promise<
		| {
				ok: true;
				expectedSessionId: string;
				observedSessionId: string;
				expectedModel: string;
				observedModel: string;
				expectedCwd: string;
				observedCwd: string;
				queueMs: number;
				startupMs: number;
				totalMs: number;
		  }
		| {
				ok: false;
				error: string;
				cleanupRequired: boolean;
				evidence?: WorkflowResumeFailureEvidence;
		  }
	>;
	cleanupFailedStandbyResume(input: {
		session: WorkflowActorSession;
		requestId: string;
		ownerId: string;
		generation: number;
		routeRevision: number;
		executionId: string;
		processGeneration: number;
		demandId: string;
		ownerClaimId: string;
	}): Promise<{ ok: boolean; error?: string }>;
	closeActorForReworkSupersession(input: {
		session: WorkflowActorSession;
		requestId: string;
		ownerId: string;
		generation: number;
		routeRevision: number;
		executionId: string;
	}): Promise<{ ok: boolean; error?: string }>;
	hasTurnSource(
		input: Pick<
			WorkflowReworkTurnInput,
			"issueId" | "projectName" | "sourceEventId"
		>,
	): Promise<boolean>;
	grantTurn(
		input: WorkflowReworkTurnInput,
	): Promise<{ epoch: number; grantedAt: string }>;
	wakeActor(input: {
		session: WorkflowActorSession;
		wakeId: string;
		activationId: string;
		epoch: number;
		context: unknown;
	}): Promise<{ ok: boolean; error?: string }>;
	/**
	 * FLY-2921: after a Lead resume, reset the SAME durable wake (its push
	 * budget is spent) exactly once per resume receipt. `busy` means a push
	 * claim is live: nothing was executed, retry later.
	 */
	rearmReworkWake?(input: {
		projectName: string;
		wakeId: string;
		receiptId: string;
	}): Promise<
		{ kind: "reset" | "idempotent_replay" | "noop" } | { kind: "busy" }
	>;
}

export type WorkflowReworkCoordinatorOutcome =
	| {
			kind: "wake_sent";
			executionId: string;
			activationId: string;
			epoch: number;
	  }
	| {
			kind: "receipt_pending";
			state: "turn_granted" | "wake_delivered";
			executionId: string;
	  }
	| { kind: "replacement_minted"; executionId: string; reason: string }
	| { kind: "replacement_launching"; executionId: string; reason: string }
	| { kind: "disabled"; reason: "rework_reentry_disabled" }
	| { kind: "retryable"; reason: string }
	| { kind: "busy" }
	| {
			kind: "settled";
			state: "wake_delivered" | "completed" | "returned_to_lead";
	  }
	| { kind: "invalid"; reason: string };

/** FLY-2921: a launching replacement is looked at again after this long. */
const REPLACEMENT_LAUNCH_DEFER_MS = 30_000;
/** Matches the dispatcher's unlaunched-rollback threshold default. */
const DEFAULT_REPLACEMENT_LAUNCH_STALL_MS = 10 * 60_000;
/**
 * FLY-2921 (FLY-2919 not merged): a delivered-but-unacknowledged wake whose
 * actor has been unobservable this long is returned to the Lead instead of
 * waiting forever, because liveness-based replacement is closed until
 * FLY-2919's process evidence is available.
 */
const SENT_LIVENESS_UNKNOWN_RETURN_MS = 2 * 60 * 60_000;

export class WorkflowReworkCoordinator {
	private readonly leaseMs: number;

	constructor(
		private readonly deps: {
			store: WorkflowReworkCoordinatorStore;
			ownerId: string;
			now?: () => Date;
			leaseMs?: number;
			effects: WorkflowReworkCoordinatorEffects;
			resolveAlertIdentity: (
				run: WorkflowRunRow,
			) => WorkflowEngineAlertIdentity;
			resolveCredentialWindow?: (
				run: WorkflowRunRow,
				nodeId: string,
				now: Date,
			) => { expiresAt: string; absoluteDeadlineAt: string };
			nodeStandbyResumeEnabled?: () => boolean;
			reentryEnabled?: () => boolean;
			replacementLaunchStallMs?: () => number;
		},
	) {
		this.leaseMs = deps.leaseMs ?? 30_000;
	}

	private now(): Date {
		return this.deps.now?.() ?? new Date();
	}

	/**
	 * Count one retryable failure (1/2/4/8 minute backoff; the fifth — or
	 * `forceReturn` — returns the rework to the Lead). A run that is no
	 * longer active is only released: its rows belong to that run's owner.
	 */
	private releaseRetryable(input: {
		requestId: string;
		generation: number;
		reason: string;
		forceReturn?: boolean;
	}): WorkflowReworkCoordinatorOutcome {
		const request = this.deps.store.getWorkflowReworkRequest(input.requestId);
		const run = request
			? this.deps.store.getWorkflowRun(request.run_id)
			: undefined;
		if (run?.status === "active") {
			const settled = this.deps.store.settleWorkflowReworkFailure({
				requestId: input.requestId,
				ownerId: this.deps.ownerId,
				generation: input.generation,
				reason: input.reason,
				alertIdentity: this.deps.resolveAlertIdentity(run),
				now: this.now().toISOString(),
				...(input.forceReturn ? { forceReturn: true } : {}),
			});
			if (settled.ok) {
				return settled.state === "returned_to_lead"
					? { kind: "settled", state: "returned_to_lead" }
					: { kind: "retryable", reason: input.reason };
			}
		}
		this.releaseOnly({
			requestId: input.requestId,
			generation: input.generation,
			reason: input.reason,
		});
		return { kind: "retryable", reason: input.reason };
	}

	/** Give the claim back without counting a failure. */
	private releaseOnly(input: {
		requestId: string;
		generation: number;
		reason: string;
	}): void {
		const delivery = this.deps.store.getWorkflowReworkDelivery(input.requestId);
		const sent =
			delivery?.state === "wake_delivered" ||
			(delivery?.state === "turn_granted" && delivery.wake_sent_at !== null);
		if (sent) {
			this.deps.store.scheduleWorkflowReworkReceiptProbe({
				requestId: input.requestId,
				ownerId: this.deps.ownerId,
				generation: input.generation,
				nextRetryAt: workflowDeliveryReceiptNextRetryAt(
					this.now().toISOString(),
				),
				reason: input.reason,
			});
			return;
		}
		this.deps.store.releaseWorkflowReworkDelivery({
			requestId: input.requestId,
			ownerId: this.deps.ownerId,
			generation: input.generation,
			error: input.reason,
			now: this.now().toISOString(),
		});
	}

	private deferReceiptProbe(input: {
		requestId: string;
		generation: number;
		state: "turn_granted" | "wake_delivered";
		executionId: string;
		reason: string;
	}): WorkflowReworkCoordinatorOutcome {
		const scheduled = this.deps.store.scheduleWorkflowReworkReceiptProbe({
			requestId: input.requestId,
			ownerId: this.deps.ownerId,
			generation: input.generation,
			nextRetryAt: workflowDeliveryReceiptNextRetryAt(this.now().toISOString()),
			reason: input.reason,
		});
		return scheduled.ok
			? {
					kind: "receipt_pending",
					state: input.state,
					executionId: input.executionId,
				}
			: { kind: "retryable", reason: scheduled.reason };
	}

	/** Look again later without counting and without an event. */
	private defer(input: {
		requestId: string;
		generation: number;
		executionId: string;
		reason: string;
		delayMs: number;
	}): WorkflowReworkCoordinatorOutcome {
		const deferred = this.deps.store.deferWorkflowReworkDelivery({
			requestId: input.requestId,
			ownerId: this.deps.ownerId,
			generation: input.generation,
			nextRetryAt: new Date(this.now().getTime() + input.delayMs).toISOString(),
			reason: input.reason,
		});
		return deferred.ok
			? {
					kind: "replacement_launching",
					executionId: input.executionId,
					reason: input.reason,
				}
			: { kind: "retryable", reason: deferred.reason };
	}

	/**
	 * C2 step 5: liveness that cannot be decided. It starts (or continues) the
	 * per-revision unknown clock, which raises the 30-minute and 2-hour
	 * alerts. A wake already sent only waits (FLY-2919 absent: a sent
	 * `turn_granted` is returned to the Lead after two unknown hours); an
	 * unsent delivery counts one failure.
	 */
	private livenessUnknown(input: {
		requestId: string;
		generation: number;
		run: WorkflowRunRow;
		delivery: WorkflowReworkDeliveryRow;
		executionId: string;
		reason: string;
		treatAsSent?: boolean;
	}): WorkflowReworkCoordinatorOutcome {
		const now = this.now();
		const noted = this.deps.store.noteWorkflowReworkLiveness({
			requestId: input.requestId,
			ownerId: this.deps.ownerId,
			generation: input.generation,
			known: false,
			reason: input.reason,
			now: now.toISOString(),
			alertIdentity: this.deps.resolveAlertIdentity(input.run),
		});
		const sent =
			input.delivery.state === "wake_delivered" ||
			(input.delivery.state === "turn_granted" &&
				input.delivery.wake_sent_at !== null);
		if (input.treatAsSent) {
			return this.defer({
				requestId: input.requestId,
				generation: input.generation,
				executionId: input.executionId,
				reason: input.reason,
				delayMs: 3 * 60_000,
			});
		}
		if (!sent) {
			return this.releaseRetryable({
				requestId: input.requestId,
				generation: input.generation,
				reason: input.reason,
			});
		}
		if (
			input.delivery.state === "turn_granted" &&
			noted.ok &&
			noted.unknownSince !== null &&
			now.getTime() - Date.parse(noted.unknownSince) >=
				SENT_LIVENESS_UNKNOWN_RETURN_MS
		) {
			return this.releaseRetryable({
				requestId: input.requestId,
				generation: input.generation,
				reason: `liveness_unknown_timeout:${input.reason}`,
				forceReturn: true,
			});
		}
		return this.deferReceiptProbe({
			requestId: input.requestId,
			generation: input.generation,
			state: input.delivery.state as "turn_granted" | "wake_delivered",
			executionId: input.executionId,
			reason: input.reason,
		});
	}

	/**
	 * C2 step 4, without a trusted death proof: a terminal label, a missing
	 * session/pane, an expired resident hold, or missing replacement content
	 * is only a reason to verify. Ask the actor to exit where the existing
	 * supersession authority allows (never widened here), then treat its
	 * liveness as unknown; replacement waits for proof.
	 */
	private async unverifiedDeath(input: {
		requestId: string;
		generation: number;
		run: WorkflowRunRow;
		delivery: WorkflowReworkDeliveryRow;
		route: WorkflowReworkRouteRevisionRow;
		actor: WorkflowActorSession | undefined;
		reason: string;
		treatAsSent?: boolean;
	}): Promise<WorkflowReworkCoordinatorOutcome> {
		let reason = input.reason;
		if (
			input.actor &&
			(input.delivery.state === "pending" ||
				(input.delivery.state === "turn_granted" &&
					input.delivery.wake_sent_at === null))
		) {
			try {
				const close = await this.deps.effects.closeActorForReworkSupersession({
					session: input.actor,
					requestId: input.requestId,
					ownerId: this.deps.ownerId,
					generation: input.generation,
					routeRevision: input.route.revision,
					executionId: input.actor.execution_id,
				});
				if (!close.ok) {
					reason += `:supersession_close_failed:${close.error ?? "unknown"}`;
				}
			} catch (error) {
				reason += `:supersession_close_failed:${
					error instanceof Error ? error.message : String(error)
				}`;
			}
		}
		return this.livenessUnknown({
			requestId: input.requestId,
			generation: input.generation,
			run: input.run,
			delivery: input.delivery,
			executionId: input.route.preferred_actor_execution_id,
			reason,
			...(input.treatAsSent ? { treatAsSent: true } : {}),
		});
	}

	/** C2 step 4 with a trusted proof: replace in place, inside this claim. */
	private replaceActor(input: {
		requestId: string;
		generation: number;
		route: WorkflowReworkRouteRevisionRow;
		proof: WorkflowReworkDeathProof;
		reason: string;
	}): WorkflowReworkCoordinatorOutcome {
		const replaced = this.deps.store.replaceWorkflowReworkActor({
			requestId: input.requestId,
			ownerId: this.deps.ownerId,
			generation: input.generation,
			deadExecutionId: input.route.preferred_actor_execution_id,
			newExecutionId: randomUUID(),
			proof: { kind: input.proof },
			reason: input.reason,
			observedAt: this.now().toISOString(),
		});
		if (replaced.ok) {
			return {
				kind: "replacement_minted",
				executionId: replaced.executionId,
				reason: input.reason,
			};
		}
		if (replaced.reason === "replacement_budget_exhausted") {
			return this.releaseRetryable({
				requestId: input.requestId,
				generation: input.generation,
				reason: "replacement_budget_exhausted",
				forceReturn: true,
			});
		}
		// The observation went stale between classification and commit: give
		// the claim back and look again, without counting.
		this.releaseOnly({
			requestId: input.requestId,
			generation: input.generation,
			reason: `replacement_not_committed:${replaced.reason}`,
		});
		return {
			kind: "retryable",
			reason: `replacement_not_committed:${replaced.reason}`,
		};
	}

	/**
	 * C2 step 3: a `pending` delivery that waits on a replacement launch
	 * (exact dispatch intent `rework_replacement:<req>` for the preferred
	 * actor). The rows are mutually exclusive, first match wins.
	 */
	private async reconcileLaunchingReplacement(input: {
		requestId: string;
		generation: number;
		run: WorkflowRunRow;
		delivery: WorkflowReworkDeliveryRow;
		route: WorkflowReworkRouteRevisionRow;
		launch: NonNullable<
			ReturnType<
				WorkflowReworkCoordinatorStore["getWorkflowReworkReplacementLaunch"]
			>
		>;
	}): Promise<WorkflowReworkCoordinatorOutcome> {
		const { requestId, generation, run, delivery, route, launch } = input;
		const actor = this.deps.effects.getActorSession(launch.executionId);
		// (a) content missing: the replacement is unusable.
		if (
			this.deps.store.hasReworkReplacementContentMissingFact({
				runId: run.run_id,
				requestId,
				routeRevision: route.revision,
			})
		) {
			return this.unverifiedDeath({
				requestId,
				generation,
				run,
				delivery,
				route,
				actor,
				reason: "replacement_content_missing",
			});
		}
		// (b) a Lead resume re-versioned the route: an unstarted replacement's
		// launch envelope is bound to the old revision and can never prove
		// the content.
		if (
			route.interpreted_by === "engine:hold_resume" &&
			launch.ledgerState !== "started"
		) {
			if (launch.ledgerState === "intent_recorded") {
				if (launch.bindingMode === null && !launch.launchOwnerPresent) {
					const abandoned =
						this.deps.store.abandonUnadmittedReworkReplacementLaunch({
							requestId,
							ownerId: this.deps.ownerId,
							generation,
							reason: "rework_replacement_superseded_by_lead_resume",
							now: this.now().toISOString(),
						});
					if (abandoned.ok) {
						return this.replaceActor({
							requestId,
							generation,
							route,
							proof: "launch_abandoned",
							reason: "replacement_superseded_by_lead_resume",
						});
					}
				}
				// Admitted: the dispatcher's unlaunched fence rolls it back; the
				// rollback fact then proves it unlaunched (row c). The wait is
				// bounded from this resume: if the fence cannot complete (e.g. a
				// leftover marker or unknown external evidence), the stall is
				// counted against the budget and the rework returns to the Lead.
				const waitingSinceMs = Date.parse(route.created_at);
				const stallMs =
					this.deps.replacementLaunchStallMs?.() ??
					DEFAULT_REPLACEMENT_LAUNCH_STALL_MS;
				if (
					Number.isFinite(waitingSinceMs) &&
					this.now().getTime() - waitingSinceMs >= stallMs
				) {
					return this.releaseRetryable({
						requestId,
						generation,
						reason: "replacement_launch_stalled:awaiting_cancellation",
					});
				}
				return this.defer({
					requestId,
					generation,
					executionId: launch.executionId,
					reason: "replacement_awaiting_launch_cancellation",
					delayMs: REPLACEMENT_LAUNCH_DEFER_MS,
				});
			}
			if (launch.ledgerState === "launch_committed") {
				return this.unverifiedDeath({
					requestId,
					generation,
					run,
					delivery,
					route,
					actor,
					reason: "replacement_envelope_superseded_by_lead_resume",
				});
			}
		}
		// (c) the launch is proven not to have happened.
		const proof = this.deps.store.workflowReworkDeathProof(requestId);
		if (proof) {
			return this.replaceActor({
				requestId,
				generation,
				route,
				proof,
				reason: `replacement_${proof}`,
			});
		}
		// (d)/(e) not launched yet: wait, then count a stall.
		if (launch.ledgerState === "intent_recorded") {
			const stallMs =
				this.deps.replacementLaunchStallMs?.() ??
				DEFAULT_REPLACEMENT_LAUNCH_STALL_MS;
			const createdMs = Date.parse(launch.createdAt);
			if (
				!Number.isFinite(createdMs) ||
				this.now().getTime() - createdMs < stallMs
			) {
				return this.defer({
					requestId,
					generation,
					executionId: launch.executionId,
					reason: "replacement_launching",
					delayMs: REPLACEMENT_LAUNCH_DEFER_MS,
				});
			}
			return this.releaseRetryable({
				requestId,
				generation,
				reason: "replacement_launch_stalled:intent_recorded",
			});
		}
		// (f) committed (or started) without the content receipt yet: treat it
		// as sent — alive waits; unobservable waits with alerts; only a proof
		// replaces it.
		if (!actor) {
			return this.livenessUnknown({
				requestId,
				generation,
				run,
				delivery,
				executionId: launch.executionId,
				reason: `replacement_${launch.ledgerState}:actor_session_missing`,
				treatAsSent: true,
			});
		}
		const reentry = await classifyPhaseActorReentry({
			session: actor,
			probeRegistered: this.deps.effects.probeRegistered,
			probePersisted: this.deps.effects.probePersisted,
			hasHostProcess: this.deps.effects.hasHostProcess,
		});
		if (reentry.kind === "hold") {
			return this.livenessUnknown({
				requestId,
				generation,
				run,
				delivery,
				executionId: launch.executionId,
				reason: `replacement_${launch.ledgerState}:${reentry.reason}`,
				treatAsSent: true,
			});
		}
		if (reentry.kind === "replace") {
			return this.unverifiedDeath({
				requestId,
				generation,
				run,
				delivery,
				route,
				actor,
				reason: `replacement_${launch.ledgerState}:${reentry.reason}`,
				treatAsSent: true,
			});
		}
		this.noteKnownLiveness(requestId, generation, delivery);
		return this.defer({
			requestId,
			generation,
			executionId: launch.executionId,
			reason: `replacement_${launch.ledgerState}:alive`,
			delayMs: 3 * 60_000,
		});
	}

	private noteKnownLiveness(
		requestId: string,
		generation: number,
		delivery: WorkflowReworkDeliveryRow,
	): void {
		if (delivery.liveness_unknown_since === null) return;
		this.deps.store.noteWorkflowReworkLiveness({
			requestId,
			ownerId: this.deps.ownerId,
			generation,
			known: true,
			reason: "liveness_known",
			now: this.now().toISOString(),
		});
	}

	async reconcile(
		requestId: string,
	): Promise<WorkflowReworkCoordinatorOutcome> {
		if (this.deps.reentryEnabled?.() === false) {
			return { kind: "disabled", reason: "rework_reentry_disabled" };
		}
		const now = this.now();
		const claim = this.deps.store.claimWorkflowReworkDelivery({
			requestId,
			ownerId: this.deps.ownerId,
			now: now.toISOString(),
			leaseExpiresAt: new Date(now.getTime() + this.leaseMs).toISOString(),
		});
		if (!claim.ok) {
			if (claim.reason === "delivery_busy") return { kind: "busy" };
			if (
				claim.reason === "delivery_settled" &&
				(claim.state === "completed" || claim.state === "returned_to_lead")
			) {
				return { kind: "settled", state: claim.state };
			}
			return { kind: "invalid", reason: claim.reason };
		}

		const request = this.deps.store.getWorkflowReworkRequest(requestId);
		const route = this.deps.store.getLatestWorkflowReworkRoute(requestId);
		const delivery = this.deps.store.getWorkflowReworkDelivery(requestId);
		const run = request
			? this.deps.store.getWorkflowRun(request.run_id)
			: undefined;
		// Step 1: incomplete context. A row on a run that is no longer active
		// is a leftover for that run's owner: release it, never count it.
		if (run && delivery && run.status !== "active") {
			this.releaseOnly({
				requestId,
				generation: claim.generation,
				reason: "rework_run_not_active",
			});
			return { kind: "retryable", reason: "rework_run_not_active" };
		}
		if (
			!request ||
			!route ||
			!delivery ||
			!run ||
			delivery.route_revision !== route.revision
		) {
			return this.releaseRetryable({
				requestId,
				generation: claim.generation,
				reason: "rework_context_unavailable",
			});
		}
		const sent =
			delivery.state === "wake_delivered" ||
			(delivery.state === "turn_granted" && delivery.wake_sent_at !== null);
		const target = this.deps.store.getWorkflowRunNode(
			request.run_id,
			route.target_node_id,
			route.target_attempt,
		);
		// Step 2: converge a writer replacement minted by the legacy lane.
		if (
			target?.state === "pending" &&
			target.execution_id &&
			target.execution_id !== route.preferred_actor_execution_id
		) {
			const converged = this.deps.store.convergeWorkflowReworkWriterReplacement(
				{
					requestId,
					ownerId: this.deps.ownerId,
					generation: claim.generation,
					now: this.now().toISOString(),
				},
			);
			if (converged.ok) {
				return {
					kind: "replacement_minted",
					executionId: converged.executionId,
					reason: "writer_replacement_converged",
				};
			}
		}
		// Step 3: the delivery waits on a replacement launch.
		if (delivery.state === "pending") {
			const launch =
				this.deps.store.getWorkflowReworkReplacementLaunch(requestId);
			if (
				launch &&
				(launch.bindingMode === null || launch.bindingMode === "replacement")
			) {
				return this.reconcileLaunchingReplacement({
					requestId,
					generation: claim.generation,
					run,
					delivery,
					route,
					launch,
				});
			}
		}
		// Step 4: a trusted death proof replaces the actor in place.
		const proof = this.deps.store.workflowReworkDeathProof(requestId);
		if (proof) {
			return this.replaceActor({
				requestId,
				generation: claim.generation,
				route,
				proof,
				reason: proof,
			});
		}
		if (
			!target ||
			target.execution_id !== route.preferred_actor_execution_id ||
			!(
				(delivery.state === "wake_delivered" && target.state === "running") ||
				(delivery.state !== "wake_delivered" &&
					(target.state === "pending" || target.state === "admitted"))
			)
		) {
			return this.releaseRetryable({
				requestId,
				generation: claim.generation,
				reason: "rework_target_not_reserved",
			});
		}
		const actor = this.deps.effects.getActorSession(
			route.preferred_actor_execution_id,
		);
		if (!actor) {
			return this.unverifiedDeath({
				requestId,
				generation: claim.generation,
				run,
				delivery,
				route,
				actor,
				reason: "actor_session_missing",
			});
		}
		if (isStateStoreIrreversibleTerminalForZombie(actor.status)) {
			return this.unverifiedDeath({
				requestId,
				generation: claim.generation,
				run,
				delivery,
				route,
				actor,
				reason: `actor_session_terminal:${actor.status}`,
			});
		}
		let worktreeReady = false;
		let standbyResume:
			| { ownerClaimId: string; processGeneration: number }
			| undefined;
		let processBody = this.deps.store.getWorkflowExecutionProcessBody?.(
			actor.execution_id,
		);
		if (!sent && processBody?.state === "retiring") {
			if (!this.deps.store.cancelWorkflowExecutionRetirementForRework) {
				return this.releaseRetryable({
					requestId,
					generation: claim.generation,
					reason: "retirement_cancel_not_wired",
				});
			}
			const cancelled =
				this.deps.store.cancelWorkflowExecutionRetirementForRework({
					executionId: actor.execution_id,
					demandId: requestId,
					now: this.now().toISOString(),
				});
			if (!cancelled.ok) {
				const racedBody = this.deps.store.getWorkflowExecutionProcessBody?.(
					actor.execution_id,
				);
				if (
					racedBody &&
					(cancelled.reason === `process_body_${racedBody.state}` ||
						cancelled.reason === "retirement_cancellation_cas_failed") &&
					(racedBody.state === "standby" ||
						racedBody.state === "resuming" ||
						racedBody.state === "resume_failed")
				) {
					processBody = racedBody;
				} else {
					return this.releaseRetryable({
						requestId,
						generation: claim.generation,
						reason: `retirement_cancel_failed:${cancelled.reason}`,
					});
				}
			}
		}
		if (
			!sent &&
			(processBody?.state === "standby" ||
				processBody?.state === "resuming" ||
				processBody?.state === "resume_failed")
		) {
			const ready = await this.deps.effects.assertWorktreeReady(
				actor,
				request.base_revision,
				{ allowDirty: true },
			);
			if (!ready.ok) {
				return this.releaseRetryable({
					requestId,
					generation: claim.generation,
					reason: `worktree_not_ready:${ready.reason ?? "unknown"}`,
				});
			}
			worktreeReady = true;
			if (
				!this.deps.effects.resumeStandbyActor ||
				!this.deps.effects.cleanupFailedStandbyResume ||
				!this.deps.store.beginWorkflowExecutionResume ||
				!this.deps.store.finishWorkflowExecutionResume ||
				!this.deps.store.failWorkflowExecutionResume
			) {
				return this.releaseRetryable({
					requestId,
					generation: claim.generation,
					reason: "standby_resume_not_wired",
				});
			}
			const ownerClaimId = `${this.deps.ownerId}:${claim.generation}`;
			const begun = this.deps.store.beginWorkflowExecutionResume({
				executionId: actor.execution_id,
				demandId: requestId,
				ownerClaimId,
				now: this.now().toISOString(),
			});
			if (!begun.ok) {
				if (
					begun.reason === "resume_attempt_limit" &&
					this.deps.store.allocateWorkflowResumeFallback
				) {
					const fallbackExecutionId = randomUUID();
					// FLY-2921 C6.3: the fallback shares the replacement core and
					// runs inside this claim; it counts against the same budget.
					const fallback = this.deps.store.allocateWorkflowResumeFallback({
						executionId: actor.execution_id,
						demandId: requestId,
						newExecutionId: fallbackExecutionId,
						now: this.now().toISOString(),
						ownerId: this.deps.ownerId,
						generation: claim.generation,
					});
					if (fallback.ok) {
						return {
							kind: "replacement_minted",
							executionId: fallback.executionId,
							reason: "resume_fallback",
						};
					}
					return this.releaseRetryable({
						requestId,
						generation: claim.generation,
						reason:
							fallback.reason === "replacement_budget_exhausted"
								? "replacement_budget_exhausted"
								: `standby_fallback_failed:${fallback.reason}`,
						...(fallback.reason === "replacement_budget_exhausted"
							? { forceReturn: true }
							: {}),
					});
				}
				return this.releaseRetryable({
					requestId,
					generation: claim.generation,
					reason: `standby_resume_begin_failed:${begun.reason}`,
				});
			}
			standbyResume = {
				ownerClaimId,
				processGeneration: begun.generation,
			};
		}
		if (
			!standbyResume &&
			this.deps.store.isCodexQuotaStandby?.(actor.execution_id) === true
		) {
			// FLY-2900 §4.2: the actor is parked on a Codex usage-limit wall; the
			// quota resume loop relaunches it. Retry later instead of replacing.
			return this.releaseRetryable({
				requestId,
				generation: claim.generation,
				reason: "codex_quota_standby",
			});
		}
		if (!standbyResume) {
			const reentry = await classifyPhaseActorReentry({
				session: actor,
				probeRegistered: this.deps.effects.probeRegistered,
				probePersisted: this.deps.effects.probePersisted,
				hasHostProcess: this.deps.effects.hasHostProcess,
			});
			if (reentry.kind === "hold") {
				return this.livenessUnknown({
					requestId,
					generation: claim.generation,
					run,
					delivery,
					executionId: actor.execution_id,
					reason: reentry.reason,
				});
			}
			if (reentry.kind === "replace") {
				// A dead pane/pin is not a death proof (FLY-2919 owns that).
				return this.unverifiedDeath({
					requestId,
					generation: claim.generation,
					run,
					delivery,
					route,
					actor,
					reason: reentry.reason,
				});
			}
			this.noteKnownLiveness(requestId, claim.generation, delivery);
		}
		if (sent) {
			return this.deferReceiptProbe({
				requestId,
				generation: claim.generation,
				state: delivery.state as "turn_granted" | "wake_delivered",
				executionId: actor.execution_id,
				reason:
					delivery.state === "turn_granted"
						? "receipt_not_observed"
						: "actor_alive_after_receipt",
			});
		}

		if (!worktreeReady) {
			const ready = await this.deps.effects.assertWorktreeReady(
				actor,
				request.base_revision,
			);
			if (!ready.ok) {
				return this.releaseRetryable({
					requestId,
					generation: claim.generation,
					reason: `worktree_not_ready:${ready.reason ?? "unknown"}`,
				});
			}
		}
		const activateHolder = async (): Promise<
			WorkflowReworkCoordinatorOutcome | undefined
		> => {
			const holderActivation =
				await this.deps.effects.activateActorForWake?.(actor);
			if (holderActivation && !holderActivation.ok) {
				const activationError = holderActivation.error ?? "unknown";
				const statusPrefix = "state_not_revivable:";
				const terminalStatus = activationError.startsWith(statusPrefix)
					? activationError.slice(statusPrefix.length).trim()
					: undefined;
				let reason = `holder_activation_failed:${activationError}`;
				if (isStateStoreIrreversibleTerminalForZombie(terminalStatus)) {
					try {
						const close =
							await this.deps.effects.closeActorForReworkSupersession({
								session: actor,
								requestId,
								ownerId: this.deps.ownerId,
								generation: claim.generation,
								routeRevision: route.revision,
								executionId: actor.execution_id,
							});
						if (!close.ok) {
							reason += `:supersession_close_failed:${close.error ?? "unknown"}`;
						}
					} catch (error) {
						reason += `:supersession_close_failed:${
							error instanceof Error ? error.message : String(error)
						}`;
					}
				}
				return this.releaseRetryable({
					requestId,
					generation: claim.generation,
					reason,
				});
			}
			return undefined;
		};
		if (!standbyResume) {
			const activationFailure = await activateHolder();
			if (activationFailure) return activationFailure;
		}

		const activationId = `activation:${requestId}`;
		const sourceEventId = `rework-turn:${requestId}:${activationId}`;
		let snapshot: ReturnType<typeof parseWorkflowRunSnapshot>;
		let targetNode: ReturnType<
			typeof parseWorkflowRunSnapshot
		>["resolved"]["nodes"][number];
		let decisionContract: ReturnType<typeof resolveWorkflowDecisionContract>;
		let credentialWindow: {
			expiresAt: string;
			absoluteDeadlineAt: string;
		};
		try {
			snapshot = parseWorkflowRunSnapshot(run.snapshot!);
			const resolvedTarget = snapshot.resolved.nodes.find(
				(candidate) => candidate.id === route.target_node_id,
			);
			if (!resolvedTarget) {
				throw new Error(`workflow node ${route.target_node_id} is missing`);
			}
			targetNode = resolvedTarget;
			decisionContract = resolveWorkflowDecisionContract(
				snapshot,
				route.target_node_id,
			);
			credentialWindow = this.deps.resolveCredentialWindow
				? this.deps.resolveCredentialWindow(run, route.target_node_id, now)
				: credentialWindowForNode(snapshot, route.target_node_id, now);
		} catch (error) {
			return this.releaseRetryable({
				requestId,
				generation: claim.generation,
				reason: `credential_window_unavailable:${(error as Error).message}`,
			});
		}
		const admission = this.deps.store.admitGeneralizedWorkflowExecution({
			runId: request.run_id,
			nodeId: route.target_node_id,
			executionId: route.preferred_actor_execution_id,
			attempt: route.target_attempt,
			activationId,
			activationMode: "wake",
			reworkRequestId: requestId,
			expiresAt: credentialWindow.expiresAt,
			absoluteDeadlineAt: credentialWindow.absoluteDeadlineAt,
			now: now.toISOString(),
			standbyResumeEnabled: this.deps.nodeStandbyResumeEnabled?.() ?? false,
		});
		if (!admission.ok) {
			return this.releaseRetryable({
				requestId,
				generation: claim.generation,
				reason: `activation_admission_failed:${admission.reason}`,
			});
		}
		let turnSourceFrozen = false;
		if (admission.idempotentReplay) {
			try {
				turnSourceFrozen = await this.deps.effects.hasTurnSource({
					issueId: run.issue_id,
					projectName: run.project_name,
					sourceEventId,
				});
			} catch (error) {
				return this.releaseRetryable({
					requestId,
					generation: claim.generation,
					reason: `turn_source_probe_failed:${(error as Error).message}`,
				});
			}
		}
		let outputCredential = admission.outputCredential;
		if (
			admission.idempotentReplay &&
			!turnSourceFrozen &&
			targetNode.capabilities.produces_output &&
			!outputCredential
		) {
			const rotated = this.deps.store.rotateGeneralizedWorkflowOutputCredential(
				{
					executionId: actor.execution_id,
					activationId,
					ownerId: this.deps.ownerId,
					generation: claim.generation,
					now: now.toISOString(),
					expiresAt: credentialWindow.expiresAt,
					absoluteDeadlineAt: credentialWindow.absoluteDeadlineAt,
				},
			);
			if (!rotated.ok) {
				return this.releaseRetryable({
					requestId,
					generation: claim.generation,
					reason: `engine_output_rotation_${rotated.reason}`,
				});
			}
			outputCredential = rotated.outputCredential;
		}
		let submissionCredential = admission.submissionCredential;
		if (
			admission.idempotentReplay &&
			!turnSourceFrozen &&
			decisionContract &&
			!submissionCredential
		) {
			const rotated =
				this.deps.store.rotateGeneralizedWorkflowSubmissionCredential({
					executionId: actor.execution_id,
					activationId,
					ownerId: this.deps.ownerId,
					generation: claim.generation,
					now: now.toISOString(),
					expiresAt: credentialWindow.expiresAt,
					absoluteDeadlineAt: credentialWindow.absoluteDeadlineAt,
				});
			if (!rotated.ok) {
				return this.releaseRetryable({
					requestId,
					generation: claim.generation,
					reason: `engine_submission_rotation_${rotated.reason}`,
				});
			}
			submissionCredential = rotated.submissionCredential;
		}
		const builtContext = buildWorkflowReworkContext({ request, route });
		if (!builtContext.ok) {
			return this.releaseRetryable({
				requestId,
				generation: claim.generation,
				reason: builtContext.reason,
			});
		}
		const context = builtContext.context;
		const grantStarted = this.deps.store.markWorkflowReworkGrantStarted({
			requestId,
			ownerId: this.deps.ownerId,
			generation: claim.generation,
			now: this.now().toISOString(),
		});
		if (!grantStarted.ok) {
			return this.releaseRetryable({
				requestId,
				generation: claim.generation,
				reason: `grant_intent_failed:${grantStarted.reason}`,
			});
		}
		let turn: { epoch: number; grantedAt: string };
		try {
			turn = await this.deps.effects.grantTurn({
				issueId: run.issue_id,
				projectName: run.project_name,
				executionId: actor.execution_id,
				nodeId: route.target_node_id,
				runId: request.run_id,
				attempt: route.target_attempt,
				activationId,
				sourceEventId,
				...(outputCredential ? { outputCredential } : {}),
				...(submissionCredential ? { submissionCredential } : {}),
				context,
			});
		} catch (error) {
			return this.releaseRetryable({
				requestId,
				generation: claim.generation,
				reason: `turn_grant_failed:${(error as Error).message}`,
			});
		}
		const projected = this.deps.store.recordWorkflowActivationTurn({
			activationId,
			issueId: run.issue_id,
			executionId: actor.execution_id,
			epoch: turn.epoch,
			sourceEventId,
			grantedAt: turn.grantedAt,
		});
		if (!projected.ok) {
			return this.releaseRetryable({
				requestId,
				generation: claim.generation,
				reason: `turn_projection_failed:${projected.reason}`,
			});
		}
		if (standbyResume) {
			const resumed = await this.deps.effects.resumeStandbyActor!({
				session: actor,
				demandId: requestId,
				ownerId: this.deps.ownerId,
				ownerGeneration: claim.generation,
				processGeneration: standbyResume.processGeneration,
				expectedHeadSha: request.base_revision,
			});
			const failAfterCleanup = async (
				reasonCode: string,
				releaseReason: string,
				cleanupRequired: boolean,
				evidence?: WorkflowResumeFailureEvidence,
			): Promise<WorkflowReworkCoordinatorOutcome> => {
				let cleanupError: string | undefined;
				if (cleanupRequired) {
					try {
						const cleanup = await this.deps.effects.cleanupFailedStandbyResume!(
							{
								session: actor,
								requestId,
								ownerId: this.deps.ownerId,
								generation: claim.generation,
								routeRevision: route.revision,
								executionId: actor.execution_id,
								processGeneration: standbyResume.processGeneration,
								demandId: requestId,
								ownerClaimId: standbyResume.ownerClaimId,
							},
						);
						if (!cleanup.ok) cleanupError = cleanup.error ?? "unknown";
					} catch (error) {
						cleanupError =
							error instanceof Error ? error.message : String(error);
					}
				}
				const failed = this.deps.store.failWorkflowExecutionResume!({
					executionId: actor.execution_id,
					generation: standbyResume.processGeneration,
					demandId: requestId,
					ownerClaimId: standbyResume.ownerClaimId,
					reasonCode: cleanupError ? "cleanup_unconfirmed" : reasonCode,
					// FLY-2808: the cleanup latch keeps the body held, but the attempt
					// keeps the real cause and what it expected.
					attemptReasonCode: reasonCode,
					...(evidence ? { evidence } : {}),
					now: this.now().toISOString(),
				});
				if (!failed.ok) {
					return this.releaseRetryable({
						requestId,
						generation: claim.generation,
						reason: `standby_resume_failure_record_failed:${failed.reason}`,
					});
				}
				return this.releaseRetryable({
					requestId,
					generation: claim.generation,
					reason: cleanupError
						? `standby_resume_cleanup_unconfirmed:${cleanupError}:${reasonCode}`
						: releaseReason,
				});
			};
			if (!resumed.ok) {
				return failAfterCleanup(
					resumed.error,
					`standby_resume_failed:${resumed.error}`,
					resumed.cleanupRequired,
					resumed.evidence,
				);
			}
			const verified = this.deps.store.finishWorkflowExecutionResume!({
				executionId: actor.execution_id,
				generation: standbyResume.processGeneration,
				demandId: requestId,
				ownerClaimId: standbyResume.ownerClaimId,
				...resumed,
				now: this.now().toISOString(),
			});
			if (!verified.ok) {
				return failAfterCleanup(
					`verification_${verified.reason}`,
					`standby_resume_verification_failed:${verified.reason}`,
					true,
					{
						expectedSessionId: resumed.expectedSessionId,
						expectedModel: resumed.expectedModel,
						expectedCwd: resumed.expectedCwd,
						queueMs: resumed.queueMs,
						startupMs: resumed.startupMs,
						totalMs: resumed.totalMs,
					},
				);
			}
			const activationFailure = await activateHolder();
			if (activationFailure) return activationFailure;
		}
		const wakeId = buildReworkWakeId({
			requestId,
			activationId,
			epoch: turn.epoch,
		});
		// FLY-2921: a Lead resume keeps the same wake identity (same request,
		// activation, epoch), so the durable wake's spent push budget is reset
		// once per resume receipt before this revision's first push.
		if (
			route.interpreted_by === "engine:hold_resume" &&
			delivery.wake_sent_at === null &&
			this.deps.effects.rearmReworkWake
		) {
			let rearmed: Awaited<
				ReturnType<
					NonNullable<WorkflowReworkCoordinatorEffects["rearmReworkWake"]>
				>
			>;
			try {
				rearmed = await this.deps.effects.rearmReworkWake({
					projectName: run.project_name,
					wakeId,
					receiptId: `rework-rearm:${requestId}:${route.revision}`,
				});
			} catch (error) {
				return this.releaseRetryable({
					requestId,
					generation: claim.generation,
					reason: `wake_rearm_failed:${(error as Error).message}`,
				});
			}
			if (rearmed.kind === "busy") {
				// Not executed: a push claim is live. Look again shortly; this
				// is neither a failure nor a re-arm.
				const deferred = this.defer({
					requestId,
					generation: claim.generation,
					executionId: actor.execution_id,
					reason: "wake_rearm_busy",
					delayMs: REPLACEMENT_LAUNCH_DEFER_MS,
				});
				return deferred.kind === "replacement_launching"
					? { kind: "retryable", reason: "wake_rearm_busy" }
					: deferred;
			}
		}
		if (delivery.state === "pending") {
			const advanced = this.deps.store.advanceWorkflowReworkDelivery({
				requestId,
				ownerId: this.deps.ownerId,
				generation: claim.generation,
				from: "pending",
				to: "turn_granted",
				now: this.now().toISOString(),
			});
			if (!advanced.ok) {
				return { kind: "retryable", reason: advanced.reason };
			}
		}
		const woke = await this.deps.effects.wakeActor({
			session: actor,
			wakeId,
			activationId,
			epoch: turn.epoch,
			context,
		});
		if (!woke.ok) {
			if (woke.error === "resident_hold_expired") {
				// A retired resident body is a reason to verify, not a proof.
				const current =
					this.deps.store.getWorkflowReworkDelivery(requestId) ?? delivery;
				return this.unverifiedDeath({
					requestId,
					generation: claim.generation,
					run,
					delivery: current,
					route,
					actor,
					reason: "resident_hold_expired",
				});
			}
			return this.releaseRetryable({
				requestId,
				generation: claim.generation,
				reason: `wake_failed:${woke.error ?? "unknown"}`,
			});
		}
		const wakeSent = this.deps.store.markWorkflowReworkWakeSent({
			requestId,
			ownerId: this.deps.ownerId,
			generation: claim.generation,
			now: this.now().toISOString(),
		});
		if (!wakeSent.ok) {
			return { kind: "retryable", reason: wakeSent.reason };
		}
		return {
			kind: "wake_sent",
			executionId: actor.execution_id,
			activationId,
			epoch: turn.epoch,
		};
	}
}
