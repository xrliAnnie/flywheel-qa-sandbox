import type { CommDB } from "flywheel-comm/db";
import type {
	GeneralizedWorkflowAdmissionResult,
	WorkflowReworkDeliveryClaimResult,
	WorkflowReworkDeliveryRow,
	WorkflowReworkRequestRow,
	WorkflowReworkRouteRevisionRow,
	WorkflowRunNodeRow,
	WorkflowRunRow,
} from "../StateStore.js";
import {
	classifyPhaseActorReentry,
	type PhaseLiveness,
} from "./phase-actor-reentry.js";
import type { PhaseSession } from "./phase-orchestrator.js";

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
	getActorSession(executionId: string): PhaseSession | undefined;
	probeRegistered(session: PhaseSession): Promise<PhaseLiveness>;
	probePersisted(session: PhaseSession): Promise<PhaseLiveness>;
	assertWorktreeReady(
		session: PhaseSession,
		expectedHeadSha: string,
	): Promise<{ ok: boolean; reason?: string }>;
	grantTurn(
		input: WorkflowReworkTurnInput,
	): Promise<{ epoch: number; grantedAt: string }>;
	wakeActor(input: {
		session: PhaseSession;
		wakeId: string;
		activationId: string;
		epoch: number;
		context: unknown;
	}): Promise<{ ok: boolean; error?: string }>;
	alertHold(input: {
		session: PhaseSession;
		requestId: string;
		reason: string;
	}): Promise<void>;
}

export type WorkflowReworkCoordinatorOutcome =
	| {
			kind: "wake_delivered";
			executionId: string;
			activationId: string;
			epoch: number;
	  }
	| { kind: "replacement_pending"; executionId: string; reason: string }
	| { kind: "held"; reason: string }
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
			env?: Record<string, string | undefined>;
		},
	) {
		this.leaseMs = deps.leaseMs ?? 30_000;
	}

	private now(): Date {
		return this.deps.now?.() ?? new Date();
	}

	private async releaseAndHold(input: {
		requestId: string;
		generation: number;
		session: PhaseSession;
		reason: string;
	}): Promise<WorkflowReworkCoordinatorOutcome> {
		this.deps.store.releaseWorkflowReworkDelivery({
			requestId: input.requestId,
			ownerId: this.deps.ownerId,
			generation: input.generation,
			error: input.reason,
			now: this.now().toISOString(),
		});
		try {
			await this.deps.effects.alertHold({
				session: input.session,
				requestId: input.requestId,
				reason: input.reason,
			});
		} catch {
			// The durable delivery error is the authority. Alert transport is best-effort.
		}
		return { kind: "held", reason: input.reason };
	}

	private releaseRetryable(input: {
		requestId: string;
		generation: number;
		reason: string;
	}): WorkflowReworkCoordinatorOutcome {
		this.deps.store.releaseWorkflowReworkDelivery({
			requestId: input.requestId,
			ownerId: this.deps.ownerId,
			generation: input.generation,
			error: input.reason,
			now: this.now().toISOString(),
		});
		return { kind: "retryable", reason: input.reason };
	}

	async reconcile(
		requestId: string,
	): Promise<WorkflowReworkCoordinatorOutcome> {
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
		const target = this.deps.store.getWorkflowRunNode(
			request.run_id,
			route.target_node_id,
			route.target_attempt,
		);
		if (
			!target ||
			target.execution_id !== route.preferred_actor_execution_id ||
			!(target.state === "pending" || target.state === "admitted")
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
			return this.releaseRetryable({
				requestId,
				generation: claim.generation,
				reason: "actor_session_missing",
			});
		}
		if (this.deps.env?.FLYWHEEL_WORKFLOW_REWORK_REENTRY === "0") {
			return this.releaseAndHold({
				requestId,
				generation: claim.generation,
				session: actor,
				reason: "rework_reentry_disabled",
			});
		}
		const reentry = await classifyPhaseActorReentry({
			session: actor,
			probeRegistered: this.deps.effects.probeRegistered,
			probePersisted: this.deps.effects.probePersisted,
		});
		if (reentry.kind === "hold") {
			return this.releaseAndHold({
				requestId,
				generation: claim.generation,
				session: actor,
				reason: reentry.reason,
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

		const ready = await this.deps.effects.assertWorktreeReady(
			actor,
			request.base_revision,
		);
		if (!ready.ok) {
			return this.releaseAndHold({
				requestId,
				generation: claim.generation,
				session: actor,
				reason: `worktree_not_ready:${ready.reason ?? "unknown"}`,
			});
		}

		const activationId = `activation:${requestId}`;
		const credentialExpiresAt = new Date(
			now.getTime() + 60 * 60_000,
		).toISOString();
		const absoluteDeadlineAt = new Date(
			now.getTime() + 24 * 60 * 60_000,
		).toISOString();
		const admission = this.deps.store.admitGeneralizedWorkflowExecution({
			runId: request.run_id,
			nodeId: route.target_node_id,
			executionId: route.preferred_actor_execution_id,
			attempt: route.target_attempt,
			activationId,
			activationMode: "wake",
			reworkRequestId: requestId,
			expiresAt: credentialExpiresAt,
			absoluteDeadlineAt,
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
		const delivered = this.deps.store.advanceWorkflowReworkDelivery({
			requestId,
			ownerId: this.deps.ownerId,
			generation: claim.generation,
			from: "turn_granted",
			to: "wake_delivered",
			now: this.now().toISOString(),
			releaseOwner: true,
		});
		if (!delivered.ok) {
			return { kind: "retryable", reason: delivered.reason };
		}
		return {
			kind: "wake_delivered",
			executionId: actor.execution_id,
			activationId,
			epoch: turn.epoch,
		};
	}
}
