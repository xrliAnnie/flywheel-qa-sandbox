import { describe, expect, it, vi } from "vitest";
import type {
	WorkflowCarrierDeliveryRow,
	WorkflowRunNodeRow,
} from "../../StateStore.js";
import {
	drainWorkflowShipCarrierDeliveries,
	WorkflowShipCarrierDeliveryHandler,
	type WorkflowShipCarrierDeliveryStore,
} from "../workflow-ship-carrier-coordinator.js";

const NOW = "2026-08-11T08:00:00.000Z";
const HEAD = "a".repeat(40);

function harness(input?: {
	projectionFailsOnce?: boolean;
	heldBeforeWake?: boolean;
	terminalBeforeWake?: boolean;
	redriveGeneration?: number;
	initialState?: WorkflowCarrierDeliveryRow["state"];
}) {
	let delivery: WorkflowCarrierDeliveryRow = {
		question_id: "approve-1",
		run_id: "run-1",
		gate_node_id: "founder_gate",
		gate_attempt: 1,
		approved_head: HEAD,
		source_execution_id: "implement-1",
		carrier_activation_id: "carrier:run-1:founder_gate:1:approve-1",
		owner_id: null,
		generation: 0,
		lease_expires_at: null,
		state: input?.initialState ?? "pending",
		hold_count: 0,
		redrive_generation: input?.redriveGeneration ?? 0,
		next_retry_at: null,
		turn_epoch: input?.initialState === "awaiting_receipt" ? 8 : null,
		turn_source_event_id:
			input?.initialState === "awaiting_receipt" ? "ship-turn:approve-1" : null,
		turn_granted_at: input?.initialState === "awaiting_receipt" ? NOW : null,
		last_error: null,
		created_at: NOW,
		updated_at: NOW,
	};
	let runStatus: "active" | "held" = "active";
	let node: WorkflowRunNodeRow = {
		run_id: "run-1",
		node_id: "founder_gate",
		attempt: 1,
		state: "review",
		execution_id: null,
		started_at: NOW,
		ended_at: null,
	};
	let failProjection = input?.projectionFailsOnce ?? false;
	const store: WorkflowShipCarrierDeliveryStore = {
		getWorkflowCarrierDelivery: vi.fn(() => ({ ...delivery })),
		getWorkflowRun: vi.fn(() => ({
			run_id: "run-1",
			issue_id: "FLY-1614",
			project_name: "flywheel",
			status: runStatus,
			current_node_id: "founder_gate",
			engine_owned: 1,
		})),
		getWorkflowRunNode: vi.fn(() => ({ ...node })),
		claimWorkflowCarrierDelivery: vi.fn((claim) => {
			delivery = {
				...delivery,
				owner_id: claim.ownerId,
				generation: delivery.generation + 1,
				lease_expires_at: claim.leaseExpiresAt,
			};
			return {
				ok: true,
				generation: delivery.generation,
				idempotentReplay: false,
			};
		}),
		advanceWorkflowCarrierDelivery: vi.fn((advance) => {
			if (delivery.generation !== advance.generation) {
				return { ok: false, reason: "stale_delivery_owner" };
			}
			delivery = {
				...delivery,
				state: advance.to,
				owner_id: advance.releaseOwner ? null : delivery.owner_id,
				lease_expires_at: advance.releaseOwner
					? null
					: delivery.lease_expires_at,
				last_error: advance.error ?? null,
				next_retry_at: advance.nextRetryAt ?? delivery.next_retry_at,
			};
			return { ok: true };
		}),
		scheduleWorkflowCarrierReceiptProbe: vi.fn((probe) => {
			if (
				delivery.owner_id !== probe.ownerId ||
				delivery.generation !== probe.generation ||
				delivery.state !== "awaiting_receipt"
			) {
				return { ok: false as const, reason: "stale_delivery_owner" };
			}
			delivery = {
				...delivery,
				owner_id: null,
				lease_expires_at: null,
				next_retry_at: probe.nextRetryAt,
			};
			return { ok: true as const };
		}),
		recordWorkflowCarrierActivationTurn: vi.fn((projection) => {
			if (failProjection) {
				failProjection = false;
				return { ok: false, reason: "projection_crash" };
			}
			delivery = {
				...delivery,
				state: "turn_granted",
				turn_epoch: projection.epoch,
				turn_source_event_id: projection.sourceEventId,
				turn_granted_at: projection.grantedAt,
			};
			return { ok: true, idempotentReplay: false };
		}),
		claimWorkflowWakeSend: vi.fn(() => {
			if (input?.heldBeforeWake) {
				runStatus = "held";
				return { ok: false, reason: "target_changed" };
			}
			if (input?.terminalBeforeWake) node = { ...node, state: "done" };
			return node.state === "done"
				? { ok: false, reason: "target_terminal" }
				: { ok: true, generation: 1, idempotentReplay: false };
		}),
		completeWorkflowWakeSend: vi.fn(() => ({ ok: true })),
		settleWorkflowCarrierFailure: vi.fn(() => {
			if (runStatus === "held") {
				delivery = {
					...delivery,
					state: "held",
					owner_id: null,
					lease_expires_at: null,
					last_error: "run_inactive:held",
				};
				return {
					ok: true as const,
					holdCount: delivery.hold_count,
					state: "held" as const,
					nextRetryAt: null,
				};
			}
			return {
				ok: true as const,
				holdCount: 1,
				state: "pending" as const,
				nextRetryAt: null,
			};
		}),
	};
	const effects = {
		getActorSession: vi.fn(() => ({
			execution_id: "implement-1",
			issue_id: "FLY-1614",
			project_name: "flywheel",
			status: "approved_to_ship",
			chat_thread_role: "implement",
			tmux_session: "flywheel:implement-1",
			worktree_path: "/tmp/flywheel-FLY-1614",
		})),
		assertWorktreeReady: vi.fn(async () => ({ ok: true })),
		activateActorForWake: vi.fn(async () => ({ ok: true })),
		grantTurn: vi.fn(async () => ({ epoch: 8, grantedAt: NOW })),
		wakeActor: vi.fn(async () => ({ ok: true })),
	};
	return {
		handler: new WorkflowShipCarrierDeliveryHandler({
			store,
			effects,
			ownerId: "carrier-handler-a",
			now: () => new Date(NOW),
			resolveAlertIdentity: () => ({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			}),
		}),
		store,
		effects,
		getDelivery: () => delivery,
	};
}

describe("WorkflowShipCarrierDeliveryHandler", () => {
	it("drains every due delivery from the engine reconcile tick", async () => {
		const reconcile = vi.fn(async () => ({
			kind: "awaiting_receipt" as const,
		}));
		const store = {
			listWorkflowCarrierDeliveries: vi.fn(() => [
				{ question_id: "approve-1" },
				{ question_id: "approve-2" },
			]),
		};
		await expect(
			drainWorkflowShipCarrierDeliveries({
				store,
				reconcile,
				now: NOW,
			}),
		).resolves.toEqual({ delivered: 2, held: 0 });
		expect(store.listWorkflowCarrierDeliveries).toHaveBeenCalledWith({
			states: ["pending", "grant_started", "turn_granted", "awaiting_receipt"],
			now: NOW,
		});
		expect(reconcile.mock.calls.map(([id]) => id)).toEqual([
			"approve-1",
			"approve-2",
		]);
	});

	it("grants the approved carrier bundle, projects the epoch, and wakes it", async () => {
		const h = harness();
		await expect(h.handler.reconcile("approve-1")).resolves.toEqual({
			kind: "awaiting_receipt",
			executionId: "implement-1",
			activationId: "carrier:run-1:founder_gate:1:approve-1",
			epoch: 8,
		});
		expect(h.effects.assertWorktreeReady).toHaveBeenCalledWith(
			expect.objectContaining({ execution_id: "implement-1" }),
			HEAD,
		);
		expect(h.effects.grantTurn).toHaveBeenCalledWith(
			expect.objectContaining({
				nodeId: "founder_gate",
				attempt: 1,
				activationId: "carrier:run-1:founder_gate:1:approve-1",
				sourceEventId: `ship-turn:approve-1:${HEAD}`,
			}),
		);
		expect(h.store.recordWorkflowCarrierActivationTurn).toHaveBeenCalled();
		expect(h.effects.wakeActor).toHaveBeenCalledOnce();
		expect(h.getDelivery().state).toBe("awaiting_receipt");
		expect(h.getDelivery().next_retry_at).toBe("2026-08-11T08:03:00.000Z");
	});

	it("reprobes an unacked carrier without replaying its TURN or wake", async () => {
		const h = harness({ initialState: "awaiting_receipt" });
		await expect(h.handler.reconcile("approve-1")).resolves.toEqual({
			kind: "awaiting_receipt",
			executionId: "implement-1",
			activationId: "carrier:run-1:founder_gate:1:approve-1",
			epoch: 8,
		});
		expect(h.store.scheduleWorkflowCarrierReceiptProbe).toHaveBeenCalledWith({
			questionId: "approve-1",
			ownerId: "carrier-handler-a",
			generation: 1,
			nextRetryAt: "2026-08-11T08:03:00.000Z",
			reason: "receipt_not_observed",
		});
		expect(h.effects.grantTurn).not.toHaveBeenCalled();
		expect(h.effects.wakeActor).not.toHaveBeenCalled();
	});

	it("replays the immutable source grant after a projection crash", async () => {
		const h = harness({ projectionFailsOnce: true });
		await expect(h.handler.reconcile("approve-1")).resolves.toMatchObject({
			kind: "retryable",
			reason: "turn_projection_failed:projection_crash",
		});
		await expect(h.handler.reconcile("approve-1")).resolves.toMatchObject({
			kind: "awaiting_receipt",
			epoch: 8,
		});
		expect(h.effects.grantTurn).toHaveBeenCalledTimes(2);
		expect(h.effects.grantTurn.mock.calls[0]?.[0]).toEqual(
			h.effects.grantTurn.mock.calls[1]?.[0],
		);
	});

	it("uses a fresh sourced grant identity for an operator redrive", async () => {
		const h = harness({ redriveGeneration: 2 });
		await expect(h.handler.reconcile("approve-1")).resolves.toMatchObject({
			kind: "awaiting_receipt",
		});
		expect(h.effects.grantTurn).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceEventId: `ship-turn:approve-1:${HEAD}:redrive:2`,
				context: expect.objectContaining({ redriveGeneration: 2 }),
			}),
		);
	});

	it("settles through the retry machine when the exact target attempt is done", async () => {
		const h = harness({ terminalBeforeWake: true });
		await expect(h.handler.reconcile("approve-1")).resolves.toEqual({
			kind: "retryable",
			reason: "wake_claim_failed:target_terminal",
		});
		expect(h.effects.wakeActor).not.toHaveBeenCalled();
		expect(h.store.completeWorkflowWakeSend).not.toHaveBeenCalled();
		expect(h.store.settleWorkflowCarrierFailure).toHaveBeenCalledWith(
			expect.objectContaining({
				reason: "wake_claim_failed:target_terminal",
			}),
		);
		expect(h.getDelivery()).not.toMatchObject({
			state: "held",
		});
	});

	it("routes a held run discovered at wake claim through visible settlement", async () => {
		const h = harness({ heldBeforeWake: true });
		await expect(h.handler.reconcile("approve-1")).resolves.toEqual({
			kind: "settled",
			state: "held",
		});
		expect(h.effects.wakeActor).not.toHaveBeenCalled();
		expect(h.store.settleWorkflowCarrierFailure).toHaveBeenCalledWith(
			expect.objectContaining({
				reason: "wake_claim_failed:target_changed",
			}),
		);
		expect(h.store.advanceWorkflowCarrierDelivery).not.toHaveBeenCalledWith(
			expect.objectContaining({ to: "held" }),
		);
		expect(h.getDelivery()).toMatchObject({
			state: "held",
			last_error: "run_inactive:held",
		});
	});

	it("settles instead of retrying when the owning workflow run is terminal", async () => {
		const h = harness();
		vi.mocked(h.store.getWorkflowRun).mockReturnValue({
			run_id: "run-1",
			issue_id: "FLY-1614",
			project_name: "flywheel",
			status: "completed",
			current_node_id: "founder_gate",
			engine_owned: 1,
		});
		vi.mocked(h.store.settleWorkflowCarrierFailure).mockReturnValue({
			ok: true,
			holdCount: 0,
			state: "completed",
			nextRetryAt: null,
		});

		await expect(h.handler.reconcile("approve-1")).resolves.toEqual({
			kind: "settled",
			state: "completed",
		});
		expect(h.effects.getActorSession).not.toHaveBeenCalled();
	});
});
