import type { CommDB } from "flywheel-comm/db";
import type {
	GeneralizedWorkflowAdmissionResult,
	WorkflowEngineAlertIdentity,
	WorkflowReworkDeliveryClaimResult,
	WorkflowReworkDeliveryRow,
	WorkflowReworkRequestRow,
	WorkflowReworkRouteRevisionRow,
	WorkflowRunNodeRow,
	WorkflowRunRow,
} from "../StateStore.js";
import {
	isStateStoreIrreversibleTerminalForZombie,
	workflowDeliveryReceiptNextRetryAt,
} from "../StateStore.js";
import { parseWorkflowRunSnapshot } from "../workflow-run-snapshot.js";
import { credentialWindowForNode } from "../workflow-submission-expiry.js";
import {
	classifyPhaseActorReentry,
	type PhaseLiveness,
} from "./phase-actor-reentry.js";
import type { WorkflowActorSession } from "./workflow-actor-session.js";

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
		onExhausted?: "needs_lead" | "handoff_held_pane_loss";
		terminal?: { kind: "irreversible_actor"; status: string; cause: string };
	}):
		| {
				ok: true;
				holdCount: number;
				state: "pending" | "turn_granted" | "held" | "needs_lead";
				nextRetryAt: string | null;
		  }
		| { ok: false; reason: string };
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
		nextRetryAt?: string;
		alertIdentity?: WorkflowEngineAlertIdentity;
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
	}): GeneralizedWorkflowAdmissionResult;
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
	): Promise<{ ok: boolean; reason?: string }>;
	activateActorForWake?(
		session: WorkflowActorSession,
	): Promise<{ ok: boolean; error?: string }>;
	closeActorForReworkSupersession(input: {
		session: WorkflowActorSession;
		requestId: string;
		ownerId: string;
		generation: number;
		routeRevision: number;
		executionId: string;
	}): Promise<{ ok: boolean; error?: string }>;
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
}

export type WorkflowReworkCoordinatorOutcome =
	| {
			kind: "awaiting_receipt";
			executionId: string;
			activationId: string;
			epoch: number;
	  }
	| {
			kind: "receipt_pending";
			state: "awaiting_receipt" | "wake_delivered";
			executionId: string;
	  }
	| { kind: "replacement_pending"; executionId: string; reason: string }
	| { kind: "disabled"; reason: "rework_reentry_disabled" }
	| { kind: "retryable"; reason: string }
	| { kind: "busy" }
	| { kind: "settled"; state: WorkflowReworkDeliveryRow["state"] }
	| { kind: "invalid"; reason: string };

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
			env?: Record<string, string | undefined>;
		},
	) {
		this.leaseMs = deps.leaseMs ?? 30_000;
	}

	private now(): Date {
		return this.deps.now?.() ?? new Date();
	}

	private releaseRetryable(input: {
		requestId: string;
		generation: number;
		reason: string;
		onExhausted?: "needs_lead" | "handoff_held_pane_loss";
		terminal?: { kind: "irreversible_actor"; status: string; cause: string };
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
				...(input.onExhausted ? { onExhausted: input.onExhausted } : {}),
				...(input.terminal ? { terminal: input.terminal } : {}),
			});
			if (settled.ok) {
				return settled.state === "needs_lead" || settled.state === "held"
					? { kind: "settled", state: settled.state }
					: { kind: "retryable", reason: input.reason };
			}
		}
		this.deps.store.releaseWorkflowReworkDelivery({
			requestId: input.requestId,
			ownerId: this.deps.ownerId,
			generation: input.generation,
			error: input.reason,
			now: this.now().toISOString(),
		});
		return { kind: "retryable", reason: input.reason };
	}

	private deferReceiptProbe(input: {
		requestId: string;
		generation: number;
		state: "awaiting_receipt" | "wake_delivered";
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

	async reconcile(
		requestId: string,
	): Promise<WorkflowReworkCoordinatorOutcome> {
		if (this.deps.env?.FLYWHEEL_WORKFLOW_REWORK_REENTRY === "0") {
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
			if (claim.reason === "delivery_settled" && claim.state) {
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
		if (
			!request ||
			!route ||
			!delivery ||
			!run ||
			delivery.route_revision !== route.revision ||
			run.status !== "active"
		) {
			return this.releaseRetryable({
				requestId,
				generation: claim.generation,
				reason: "rework_context_unavailable",
			});
		}
		const observingReceipt =
			delivery.state === "awaiting_receipt" ||
			delivery.state === "wake_delivered";
		const target = this.deps.store.getWorkflowRunNode(
			request.run_id,
			route.target_node_id,
			route.target_attempt,
		);
		if (
			!target ||
			target.execution_id !== route.preferred_actor_execution_id ||
			!(
				(observingReceipt &&
					delivery.state === "wake_delivered" &&
					target.state === "running") ||
				(observingReceipt &&
					delivery.state === "awaiting_receipt" &&
					target.state === "admitted") ||
				(!observingReceipt &&
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
			if (observingReceipt) {
				return this.deferReceiptProbe({
					requestId,
					generation: claim.generation,
					state: delivery.state as "awaiting_receipt" | "wake_delivered",
					executionId: route.preferred_actor_execution_id,
					reason: "actor_session_missing",
				});
			}
			return this.releaseRetryable({
				requestId,
				generation: claim.generation,
				reason: "actor_session_missing",
			});
		}
		const reentry = await classifyPhaseActorReentry({
			session: actor,
			probeRegistered: this.deps.effects.probeRegistered,
			probePersisted: this.deps.effects.probePersisted,
			hasHostProcess: this.deps.effects.hasHostProcess,
		});
		if (reentry.kind === "hold") {
			if (observingReceipt) {
				return this.deferReceiptProbe({
					requestId,
					generation: claim.generation,
					state: delivery.state as "awaiting_receipt" | "wake_delivered",
					executionId: actor.execution_id,
					reason: reentry.reason,
				});
			}
			return this.releaseRetryable({
				requestId,
				generation: claim.generation,
				reason: reentry.reason,
				...(reentry.reason === "persisted_target_missing"
					? { onExhausted: "handoff_held_pane_loss" as const }
					: {}),
			});
		}
		if (reentry.kind === "replace") {
			const moved = this.deps.store.advanceWorkflowReworkDelivery({
				requestId,
				ownerId: this.deps.ownerId,
				generation: claim.generation,
				from: delivery.state,
				to: "replacement_pending",
				now: this.now().toISOString(),
				error: reentry.reason,
				releaseOwner: true,
			});
			if (!moved.ok) {
				return { kind: "retryable", reason: moved.reason };
			}
			return {
				kind: "replacement_pending",
				executionId: actor.execution_id,
				reason: reentry.reason,
			};
		}
		if (observingReceipt) {
			return this.deferReceiptProbe({
				requestId,
				generation: claim.generation,
				state: delivery.state as "awaiting_receipt" | "wake_delivered",
				executionId: actor.execution_id,
				reason:
					delivery.state === "awaiting_receipt"
						? "receipt_not_observed"
						: "actor_alive_after_receipt",
			});
		}

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
					const close = await this.deps.effects.closeActorForReworkSupersession(
						{
							session: actor,
							requestId,
							ownerId: this.deps.ownerId,
							generation: claim.generation,
							routeRevision: route.revision,
							executionId: actor.execution_id,
						},
					);
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

		const activationId = `activation:${requestId}`;
		let credentialWindow: {
			expiresAt: string;
			absoluteDeadlineAt: string;
		};
		try {
			credentialWindow = this.deps.resolveCredentialWindow
				? this.deps.resolveCredentialWindow(run, route.target_node_id, now)
				: credentialWindowForNode(
						parseWorkflowRunSnapshot(run.snapshot!),
						route.target_node_id,
						now,
					);
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
			env: this.deps.env,
		});
		if (!admission.ok) {
			return this.releaseRetryable({
				requestId,
				generation: claim.generation,
				reason: `activation_admission_failed:${admission.reason}`,
			});
		}
		let authorityContext: unknown;
		try {
			authorityContext = JSON.parse(request.authority_context_json);
		} catch {
			return this.releaseRetryable({
				requestId,
				generation: claim.generation,
				reason: "authority_context_corrupt",
			});
		}
		const context = {
			requestId,
			authority: request.authority,
			authorityContext,
			target: {
				nodeId: route.target_node_id,
				attempt: route.target_attempt,
				invalidationScope: route.invalidation_scope,
				verificationPolicy: route.verification_policy,
			},
		};
		const sourceEventId = `rework-turn:${requestId}:${activationId}`;
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
				...(admission.outputCredential
					? { outputCredential: admission.outputCredential }
					: {}),
				...(admission.submissionCredential
					? { submissionCredential: admission.submissionCredential }
					: {}),
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

		const wakeId = `rework-wake:${requestId}:${activationId}:epoch:${turn.epoch}`;
		const woke = await this.deps.effects.wakeActor({
			session: actor,
			wakeId,
			activationId,
			epoch: turn.epoch,
			context,
		});
		if (!woke.ok) {
			return this.releaseRetryable({
				requestId,
				generation: claim.generation,
				reason: `wake_failed:${woke.error ?? "unknown"}`,
			});
		}
		const awaitingReceipt = this.deps.store.advanceWorkflowReworkDelivery({
			requestId,
			ownerId: this.deps.ownerId,
			generation: claim.generation,
			from: "turn_granted",
			to: "awaiting_receipt",
			now: this.now().toISOString(),
			nextRetryAt: workflowDeliveryReceiptNextRetryAt(this.now().toISOString()),
			releaseOwner: true,
		});
		if (!awaitingReceipt.ok) {
			return { kind: "retryable", reason: awaitingReceipt.reason };
		}
		return {
			kind: "awaiting_receipt",
			executionId: actor.execution_id,
			activationId,
			epoch: turn.epoch,
		};
	}
}
