import type { CommDB } from "flywheel-comm/db";
import type {
	WorkflowCarrierDeliveryClaimResult,
	WorkflowCarrierDeliveryRow,
	WorkflowEngineAlertIdentity,
	WorkflowRunNodeRow,
	WorkflowRunRow,
	WorkflowWakeSendClaimResult,
} from "../StateStore.js";
import { workflowDeliveryReceiptNextRetryAt } from "../StateStore.js";
import type { WorkflowActorSession } from "./workflow-actor-session.js";

export interface WorkflowShipCarrierTurnInput {
	issueId: string;
	projectName: string;
	executionId: string;
	nodeId: string;
	runId: string;
	attempt: number;
	activationId: string;
	sourceEventId: string;
	context: unknown;
}

/** Write the belt, target binding, and carrier activation in one CommDB tx. */
export function grantWorkflowShipCarrierTurn(
	db: Pick<CommDB, "getTurn" | "grantTurn">,
	input: WorkflowShipCarrierTurnInput,
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
		throw new Error(
			`workflow carrier TURN replay mismatch: ${input.sourceEventId}`,
		);
	}
	return {
		epoch,
		grantedAt: new Date(persisted.granted_at).toISOString(),
	};
}

type CarrierRun = Pick<
	WorkflowRunRow,
	| "run_id"
	| "issue_id"
	| "project_name"
	| "status"
	| "current_node_id"
	| "engine_owned"
>;

export interface WorkflowShipCarrierDeliveryStore {
	getWorkflowCarrierDelivery(
		questionId: string,
	): WorkflowCarrierDeliveryRow | undefined;
	getWorkflowRun(runId: string): CarrierRun | undefined;
	getWorkflowRunNode(
		runId: string,
		nodeId: string,
		attempt: number,
	): WorkflowRunNodeRow | undefined;
	claimWorkflowCarrierDelivery(input: {
		questionId: string;
		ownerId: string;
		now: string;
		leaseExpiresAt: string;
	}): WorkflowCarrierDeliveryClaimResult;
	advanceWorkflowCarrierDelivery(input: {
		questionId: string;
		ownerId: string;
		generation: number;
		from: WorkflowCarrierDeliveryRow["state"];
		to: WorkflowCarrierDeliveryRow["state"];
		now: string;
		error?: string;
		releaseOwner?: boolean;
		nextRetryAt?: string;
	}): { ok: true } | { ok: false; reason: string };
	scheduleWorkflowCarrierReceiptProbe(input: {
		questionId: string;
		ownerId: string;
		generation: number;
		nextRetryAt: string;
		reason: string;
	}): { ok: true } | { ok: false; reason: string };
	recordWorkflowCarrierActivationTurn(input: {
		questionId: string;
		ownerId: string;
		generation: number;
		activationId: string;
		issueId: string;
		executionId: string;
		epoch: number;
		sourceEventId: string;
		grantedAt: string;
	}): { ok: true; idempotentReplay: boolean } | { ok: false; reason: string };
	settleWorkflowCarrierFailure(input: {
		questionId: string;
		ownerId: string;
		generation: number;
		reason: string;
		alertIdentity: WorkflowEngineAlertIdentity;
		now: string;
	}):
		| {
				ok: true;
				holdCount: number;
				state:
					| "pending"
					| "grant_started"
					| "turn_granted"
					| "awaiting_receipt"
					| "completed"
					| "held"
					| "needs_lead";
				nextRetryAt: string | null;
		  }
		| { ok: false; reason: string };
	claimWorkflowWakeSend(input: {
		wakeId: string;
		runId: string;
		nodeId: string;
		attempt: number;
		executionId: string;
		activationId: string;
		epoch: number;
		ownerId: string;
		now: string;
		leaseExpiresAt: string;
	}): WorkflowWakeSendClaimResult;
	completeWorkflowWakeSend(input: {
		wakeId: string;
		ownerId: string;
		generation: number;
		now: string;
		result: "sent" | "cancelled" | "retryable";
		error?: string;
	}): { ok: true } | { ok: false; reason: string };
}

export interface WorkflowShipCarrierDeliveryEffects {
	getActorSession(executionId: string): WorkflowActorSession | undefined;
	assertWorktreeReady(
		session: WorkflowActorSession,
		expectedHeadSha: string,
	): Promise<{ ok: boolean; reason?: string }>;
	activateActorForWake?(
		session: WorkflowActorSession,
	): Promise<{ ok: boolean; error?: string }>;
	grantTurn(
		input: WorkflowShipCarrierTurnInput,
	): Promise<{ epoch: number; grantedAt: string }>;
	wakeActor(input: {
		session: WorkflowActorSession;
		wakeId: string;
		activationId: string;
		epoch: number;
		context: unknown;
	}): Promise<{ ok: boolean; error?: string }>;
}

export type WorkflowShipCarrierDeliveryOutcome =
	| {
			kind: "awaiting_receipt";
			executionId: string;
			activationId: string;
			epoch: number;
	  }
	| { kind: "retryable"; reason: string }
	| { kind: "cancelled"; reason: string }
	| { kind: "busy" }
	| { kind: "settled"; state: WorkflowCarrierDeliveryRow["state"] }
	| { kind: "invalid"; reason: string };

export async function drainWorkflowShipCarrierDeliveries(input: {
	store: {
		listWorkflowCarrierDeliveries(args: {
			states: WorkflowCarrierDeliveryRow["state"][];
			now: string;
		}): Array<Pick<WorkflowCarrierDeliveryRow, "question_id">>;
	};
	reconcile: (
		questionId: string,
	) => Promise<WorkflowShipCarrierDeliveryOutcome>;
	now: string;
}): Promise<{ delivered: number; held: number }> {
	let delivered = 0;
	let held = 0;
	for (const delivery of input.store.listWorkflowCarrierDeliveries({
		states: ["pending", "grant_started", "turn_granted", "awaiting_receipt"],
		now: input.now,
	})) {
		const outcome = await input.reconcile(delivery.question_id);
		if (outcome.kind === "awaiting_receipt") delivered += 1;
		else if (outcome.kind !== "busy" && outcome.kind !== "settled") held += 1;
	}
	return { delivered, held };
}

const TERMINAL_NODE_STATES = new Set([
	"done",
	"failed",
	"superseded",
	"completed",
]);
const CARRIER_SESSION_STATES = new Set([
	"running",
	"ship_parked",
	"awaiting_review",
	"approved_to_ship",
]);

/** Stateless handler owned and scheduled by WorkflowEngineDispatcher. */
export class WorkflowShipCarrierDeliveryHandler {
	private readonly leaseMs: number;
	private readonly wakeLeaseMs: number;

	constructor(
		private readonly deps: {
			store: WorkflowShipCarrierDeliveryStore;
			ownerId: string;
			now?: () => Date;
			leaseMs?: number;
			wakeLeaseMs?: number;
			effects: WorkflowShipCarrierDeliveryEffects;
			resolveAlertIdentity: (run: CarrierRun) => WorkflowEngineAlertIdentity;
		},
	) {
		this.leaseMs = deps.leaseMs ?? 30_000;
		this.wakeLeaseMs = deps.wakeLeaseMs ?? 15_000;
	}

	private now(): Date {
		return this.deps.now?.() ?? new Date();
	}

	private retry(input: {
		questionId: string;
		generation: number;
		run: CarrierRun;
		reason: string;
	}): WorkflowShipCarrierDeliveryOutcome {
		const settled = this.deps.store.settleWorkflowCarrierFailure({
			questionId: input.questionId,
			ownerId: this.deps.ownerId,
			generation: input.generation,
			reason: input.reason,
			alertIdentity: this.deps.resolveAlertIdentity(input.run),
			now: this.now().toISOString(),
		});
		return settled.ok &&
			(settled.state === "needs_lead" ||
				settled.state === "completed" ||
				settled.state === "held")
			? { kind: "settled", state: settled.state }
			: { kind: "retryable", reason: input.reason };
	}

	async reconcile(
		questionId: string,
	): Promise<WorkflowShipCarrierDeliveryOutcome> {
		const now = this.now();
		const claim = this.deps.store.claimWorkflowCarrierDelivery({
			questionId,
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

		const delivery = this.deps.store.getWorkflowCarrierDelivery(questionId);
		const run = delivery
			? this.deps.store.getWorkflowRun(delivery.run_id)
			: undefined;
		const node = delivery
			? this.deps.store.getWorkflowRunNode(
					delivery.run_id,
					delivery.gate_node_id,
					delivery.gate_attempt,
				)
			: undefined;
		if (
			!delivery ||
			!run ||
			!node ||
			run.engine_owned !== 1 ||
			run.status !== "active" ||
			run.current_node_id !== delivery.gate_node_id ||
			TERMINAL_NODE_STATES.has(node.state)
		) {
			return run
				? this.retry({
						questionId,
						generation: claim.generation,
						run,
						reason: "carrier_context_unavailable",
					})
				: { kind: "invalid", reason: "carrier_context_unavailable" };
		}
		const actor = this.deps.effects.getActorSession(
			delivery.source_execution_id,
		);
		if (!actor || !CARRIER_SESSION_STATES.has(actor.status)) {
			return this.retry({
				questionId,
				generation: claim.generation,
				run,
				reason: "carrier_session_unavailable",
			});
		}
		const ready = await this.deps.effects.assertWorktreeReady(
			actor,
			delivery.approved_head,
		);
		if (!ready.ok) {
			return this.retry({
				questionId,
				generation: claim.generation,
				run,
				reason: `worktree_not_ready:${ready.reason ?? "unknown"}`,
			});
		}
		if (delivery.state === "awaiting_receipt") {
			if (!Number.isSafeInteger(delivery.turn_epoch)) {
				return this.retry({
					questionId,
					generation: claim.generation,
					run,
					reason: "carrier_receipt_identity_missing",
				});
			}
			const scheduled = this.deps.store.scheduleWorkflowCarrierReceiptProbe({
				questionId,
				ownerId: this.deps.ownerId,
				generation: claim.generation,
				nextRetryAt: workflowDeliveryReceiptNextRetryAt(
					this.now().toISOString(),
				),
				reason: "receipt_not_observed",
			});
			return scheduled.ok
				? {
						kind: "awaiting_receipt",
						executionId: delivery.source_execution_id,
						activationId: delivery.carrier_activation_id,
						epoch: delivery.turn_epoch!,
					}
				: { kind: "retryable", reason: scheduled.reason };
		}
		const activated = await this.deps.effects.activateActorForWake?.(actor);
		if (activated && !activated.ok) {
			return this.retry({
				questionId,
				generation: claim.generation,
				run,
				reason: `holder_activation_failed:${activated.error ?? "unknown"}`,
			});
		}

		if (delivery.state === "pending") {
			const marked = this.deps.store.advanceWorkflowCarrierDelivery({
				questionId,
				ownerId: this.deps.ownerId,
				generation: claim.generation,
				from: "pending",
				to: "grant_started",
				now: this.now().toISOString(),
			});
			if (!marked.ok) return { kind: "retryable", reason: marked.reason };
		}
		const context = {
			kind: "runner_ship_carrier",
			questionId,
			approvedHead: delivery.approved_head,
			redriveGeneration: delivery.redrive_generation,
		};
		const sourceEventId =
			delivery.redrive_generation > 0
				? `ship-turn:${questionId}:${delivery.approved_head}:redrive:${delivery.redrive_generation}`
				: `ship-turn:${questionId}:${delivery.approved_head}`;
		let turn: { epoch: number; grantedAt: string };
		try {
			turn = await this.deps.effects.grantTurn({
				issueId: run.issue_id,
				projectName: run.project_name,
				executionId: delivery.source_execution_id,
				nodeId: delivery.gate_node_id,
				runId: delivery.run_id,
				attempt: delivery.gate_attempt,
				activationId: delivery.carrier_activation_id,
				sourceEventId,
				context,
			});
		} catch (error) {
			return this.retry({
				questionId,
				generation: claim.generation,
				run,
				reason: `turn_grant_failed:${(error as Error).message}`,
			});
		}
		const projected = this.deps.store.recordWorkflowCarrierActivationTurn({
			questionId,
			ownerId: this.deps.ownerId,
			generation: claim.generation,
			activationId: delivery.carrier_activation_id,
			issueId: run.issue_id,
			executionId: delivery.source_execution_id,
			epoch: turn.epoch,
			sourceEventId,
			grantedAt: turn.grantedAt,
		});
		if (!projected.ok) {
			return this.retry({
				questionId,
				generation: claim.generation,
				run,
				reason: `turn_projection_failed:${projected.reason}`,
			});
		}

		const wakeId = `carrier-wake:${questionId}:${delivery.carrier_activation_id}:epoch:${turn.epoch}`;
		const wakeClaim = this.deps.store.claimWorkflowWakeSend({
			wakeId,
			runId: delivery.run_id,
			nodeId: delivery.gate_node_id,
			attempt: delivery.gate_attempt,
			executionId: delivery.source_execution_id,
			activationId: delivery.carrier_activation_id,
			epoch: turn.epoch,
			ownerId: this.deps.ownerId,
			now: this.now().toISOString(),
			leaseExpiresAt: new Date(
				this.now().getTime() + this.wakeLeaseMs,
			).toISOString(),
		});
		if (!wakeClaim.ok) {
			if (wakeClaim.reason === "wake_already_sent") {
				const awaitingReceipt = this.deps.store.advanceWorkflowCarrierDelivery({
					questionId,
					ownerId: this.deps.ownerId,
					generation: claim.generation,
					from: "turn_granted",
					to: "awaiting_receipt",
					now: this.now().toISOString(),
					nextRetryAt: workflowDeliveryReceiptNextRetryAt(
						this.now().toISOString(),
					),
					releaseOwner: true,
				});
				return awaitingReceipt.ok
					? {
							kind: "awaiting_receipt",
							executionId: delivery.source_execution_id,
							activationId: delivery.carrier_activation_id,
							epoch: turn.epoch,
						}
					: { kind: "retryable", reason: awaitingReceipt.reason };
			}
			return this.retry({
				questionId,
				generation: claim.generation,
				run,
				reason: `wake_claim_failed:${wakeClaim.reason}`,
			});
		}

		const woke = await this.deps.effects.wakeActor({
			session: actor,
			wakeId,
			activationId: delivery.carrier_activation_id,
			epoch: turn.epoch,
			context,
		});
		if (!woke.ok) {
			this.deps.store.completeWorkflowWakeSend({
				wakeId,
				ownerId: this.deps.ownerId,
				generation: wakeClaim.generation,
				now: this.now().toISOString(),
				result: "retryable",
				error: woke.error ?? "unknown",
			});
			return this.retry({
				questionId,
				generation: claim.generation,
				run,
				reason: `wake_failed:${woke.error ?? "unknown"}`,
			});
		}
		const sent = this.deps.store.completeWorkflowWakeSend({
			wakeId,
			ownerId: this.deps.ownerId,
			generation: wakeClaim.generation,
			now: this.now().toISOString(),
			result: "sent",
		});
		if (!sent.ok) return { kind: "retryable", reason: sent.reason };
		const awaitingReceipt = this.deps.store.advanceWorkflowCarrierDelivery({
			questionId,
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
			executionId: delivery.source_execution_id,
			activationId: delivery.carrier_activation_id,
			epoch: turn.epoch,
		};
	}
}
