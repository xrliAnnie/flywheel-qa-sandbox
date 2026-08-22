import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { describe, expect, it, vi } from "vitest";
import type {
	WorkflowReworkDeliveryRow,
	WorkflowReworkRequestRow,
	WorkflowReworkRouteRevisionRow,
} from "../../StateStore.js";
import {
	classifyPhaseActorReentry,
	type PhaseActorReentryDecision,
} from "../phase-actor-reentry.js";
import {
	grantWorkflowReworkTurn,
	WorkflowReworkCoordinator,
	type WorkflowReworkCoordinatorStore,
} from "../workflow-rework-coordinator.js";

const NOW = "2026-07-23T00:00:00.000Z";
const HEAD = "a".repeat(40);

const session = {
	execution_id: "implement-exec",
	issue_id: "FLY-1423",
	project_name: "flywheel",
	status: "completed",
	chat_thread_role: "implement",
	tmux_session: "flywheel:implement-exec",
	worktree_path: "/tmp/flywheel-FLY-1423",
};

describe("classifyPhaseActorReentry", () => {
	it.each<{
		registered: "alive" | "dead_pin" | "absent" | "indeterminate";
		persisted?: "alive" | "dead_pin" | "absent" | "indeterminate";
		hasTarget?: boolean;
		expected: PhaseActorReentryDecision["kind"];
	}>([
		{ registered: "alive", expected: "wake" },
		{ registered: "indeterminate", expected: "hold" },
		{ registered: "dead_pin", expected: "replace" },
		{ registered: "absent", hasTarget: false, expected: "hold" },
		{ registered: "absent", persisted: "absent", expected: "replace" },
		{ registered: "absent", persisted: "dead_pin", expected: "replace" },
		{ registered: "absent", persisted: "alive", expected: "wake" },
		{ registered: "absent", persisted: "indeterminate", expected: "hold" },
	])(
		"classifies registered=$registered persisted=$persisted target=$hasTarget as $expected",
		async ({ registered, persisted, hasTarget = true, expected }) => {
			const probePersisted = vi.fn(async () => persisted ?? "absent");
			const result = await classifyPhaseActorReentry({
				session: {
					...session,
					tmux_session: hasTarget ? session.tmux_session : undefined,
				},
				probeRegistered: vi.fn(async () => registered),
				probePersisted,
			});
			expect(result.kind).toBe(expected);
			expect(probePersisted).toHaveBeenCalledTimes(
				registered === "absent" && hasTarget ? 1 : 0,
			);
		},
	);

	it("replaces a targetless terminal actor only after host-process absence", async () => {
		await expect(
			classifyPhaseActorReentry({
				session: { ...session, status: "terminated", tmux_session: undefined },
				probeRegistered: async () => "absent",
				probePersisted: async () => "absent",
				hasHostProcess: async () => false,
			}),
		).resolves.toEqual({
			kind: "replace",
			reason: "terminal_actor_target_and_host_absent",
		});
	});

	it("holds a targetless terminal actor while a host process still exists", async () => {
		await expect(
			classifyPhaseActorReentry({
				session: { ...session, status: "terminated", tmux_session: undefined },
				probeRegistered: async () => "absent",
				probePersisted: async () => "absent",
				hasHostProcess: async () => true,
			}),
		).resolves.toEqual({ kind: "hold", reason: "persisted_target_missing" });
	});
});

function makeHarness(input: {
	registered?: "alive" | "dead_pin" | "absent" | "indeterminate";
	persisted?: "alive" | "dead_pin" | "absent" | "indeterminate";
	ready?: { ok: boolean; reason?: string };
	wakeResults?: Array<{ ok: boolean; error?: string }>;
	failTurnProjectionOnce?: boolean;
	reentryEnabled?: boolean;
	initialState?: WorkflowReworkDeliveryRow["state"];
}) {
	const request: WorkflowReworkRequestRow = {
		request_id: "rework-1",
		run_id: "run-1",
		source_event_id: "qa-fail-1",
		authority: "qa",
		source_node_id: "qa",
		source_attempt: 1,
		base_revision: HEAD,
		authority_context_json: JSON.stringify({
			authority: "qa",
			summary: "fix the regression",
		}),
		authority_context_digest: "digest-1",
		founder_feedback_verbatim: null,
		requested_at: NOW,
	};
	const route: WorkflowReworkRouteRevisionRow = {
		request_id: request.request_id,
		revision: 1,
		target_node_id: "implement",
		target_attempt: 2,
		preferred_actor_execution_id: session.execution_id,
		invalidation_scope: ["implement", "qa"],
		verification_policy: ["code_review", "qa_retest"],
		interpreted_by: "engine:qa_verdict",
		interpretation_reason: "qa fail",
		created_at: NOW,
	};
	let delivery: WorkflowReworkDeliveryRow = {
		request_id: request.request_id,
		owner_id: null,
		generation: 0,
		lease_expires_at: null,
		route_revision: 1,
		state: input.initialState ?? "pending",
		hold_count: 0,
		next_retry_at: null,
		grant_started_at: null,
		last_error: null,
		updated_at: NOW,
	};
	let activationAdmitted = delivery.state !== "pending";
	let projected = false;
	let failProjection = input.failTurnProjectionOnce ?? false;

	const store: WorkflowReworkCoordinatorStore = {
		getWorkflowReworkRequest: vi.fn(() => request),
		getLatestWorkflowReworkRoute: vi.fn(() => route),
		getWorkflowReworkDelivery: vi.fn(() => ({ ...delivery })),
		getWorkflowRun: vi.fn(() => ({
			run_id: "run-1",
			issue_id: "FLY-1423",
			project_name: "flywheel",
			status: "active",
		})),
		getWorkflowRunNode: vi.fn(() => ({
			run_id: "run-1",
			node_id: "implement",
			attempt: 2,
			state:
				delivery.state === "wake_delivered"
					? "running"
					: activationAdmitted
						? "admitted"
						: "pending",
			execution_id: "implement-exec",
		})),
		claimWorkflowReworkDelivery: vi.fn((claim) => {
			if (delivery.owner_id && delivery.owner_id !== claim.ownerId) {
				return { ok: false as const, reason: "delivery_busy" };
			}
			if (!delivery.owner_id) delivery.generation += 1;
			delivery = {
				...delivery,
				owner_id: claim.ownerId,
				lease_expires_at: claim.leaseExpiresAt,
			};
			return {
				ok: true as const,
				generation: delivery.generation,
				idempotentReplay: false,
			};
		}),
		releaseWorkflowReworkDelivery: vi.fn((release) => {
			if (
				delivery.owner_id !== release.ownerId ||
				delivery.generation !== release.generation
			) {
				return { ok: false as const, reason: "stale_delivery_owner" };
			}
			delivery = {
				...delivery,
				owner_id: null,
				lease_expires_at: null,
				last_error: release.error,
			};
			return { ok: true as const };
		}),
		settleWorkflowReworkFailure: vi.fn((failure) => {
			if (
				delivery.owner_id !== failure.ownerId ||
				delivery.generation !== failure.generation
			) {
				return { ok: false as const, reason: "stale_delivery_owner" };
			}
			const holdCount = delivery.hold_count + 1;
			const state =
				failure.terminal || holdCount >= 5 ? "needs_lead" : delivery.state;
			delivery = {
				...delivery,
				owner_id: null,
				lease_expires_at: null,
				hold_count: holdCount,
				state,
				last_error: failure.reason,
			};
			return {
				ok: true as const,
				holdCount,
				state,
				nextRetryAt: null,
			};
		}),
		markWorkflowReworkGrantStarted: vi.fn((grant) => {
			if (
				delivery.owner_id !== grant.ownerId ||
				delivery.generation !== grant.generation
			) {
				return { ok: false as const, reason: "stale_delivery_owner" };
			}
			delivery = { ...delivery, grant_started_at: grant.now };
			return { ok: true as const };
		}),
		scheduleWorkflowReworkReceiptProbe: vi.fn((probe) => {
			if (
				delivery.owner_id !== probe.ownerId ||
				delivery.generation !== probe.generation ||
				!(
					delivery.state === "awaiting_receipt" ||
					delivery.state === "wake_delivered"
				)
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
		advanceWorkflowReworkDelivery: vi.fn((advance) => {
			if (
				delivery.owner_id !== advance.ownerId ||
				delivery.generation !== advance.generation ||
				delivery.state !== advance.from
			) {
				return { ok: false as const, reason: "stale_delivery_owner" };
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
			return { ok: true as const };
		}),
		admitGeneralizedWorkflowExecution: vi.fn(() => {
			const replay = activationAdmitted;
			activationAdmitted = true;
			return {
				ok: true as const,
				idempotentReplay: replay,
				activationId: "activation:rework-1",
				snapshotDigest: "snapshot-1",
				...(replay ? {} : { outputCredential: "output-ticket" }),
			};
		}),
		recordWorkflowActivationTurn: vi.fn(() => {
			if (failProjection) {
				failProjection = false;
				return { ok: false as const, reason: "projection_crash" };
			}
			const replay = projected;
			projected = true;
			return { ok: true as const, idempotentReplay: replay };
		}),
	};

	const wakeResults = [...(input.wakeResults ?? [{ ok: true }])];
	const effects = {
		getActorSession: vi.fn(() => session),
		probeRegistered: vi.fn(async () => input.registered ?? "alive"),
		probePersisted: vi.fn(async () => input.persisted ?? "absent"),
		assertWorktreeReady: vi.fn(async () => input.ready ?? { ok: true }),
		activateActorForWake: vi.fn(async () => ({ ok: true })),
		closeActorForReworkSupersession: vi.fn(async () => ({ ok: true })),
		grantTurn: vi.fn(async () => ({ epoch: 4, grantedAt: NOW })),
		wakeActor: vi.fn(async () => wakeResults.shift() ?? { ok: true }),
	};
	const env = {
		FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
		FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
		FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
		FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
		FLYWHEEL_WORKFLOW_REWORK_REENTRY:
			input.reentryEnabled === false ? "0" : "1",
	};
	const coordinator = new WorkflowReworkCoordinator({
		store,
		ownerId: "coordinator-a",
		now: () => new Date(NOW),
		effects,
		resolveAlertIdentity: () => ({
			leadId: "flywheel-eng-lead",
			projectName: "flywheel",
			leadResolution: "resolved",
		}),
		resolveCredentialWindow: (_run, _nodeId, now) => ({
			expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
			absoluteDeadlineAt: new Date(
				now.getTime() + 24 * 60 * 60_000,
			).toISOString(),
		}),
		env,
		reentryEnabled: () => env.FLYWHEEL_WORKFLOW_REWORK_REENTRY !== "0",
	});
	return { coordinator, store, effects, env, getDelivery: () => delivery };
}

describe("WorkflowReworkCoordinator", () => {
	it("reuses the persisted TURN timestamp when a source grant is replayed", () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1423-rework-turn-"));
		const db = new CommDB(join(dir, "comm.db"));
		const input = {
			issueId: "FLY-1423",
			projectName: "flywheel",
			executionId: "implement-exec",
			nodeId: "implement",
			runId: "run-1",
			attempt: 2,
			activationId: "activation:rework-1",
			sourceEventId: "rework-turn:rework-1:activation:rework-1",
			outputCredential: "output-ticket",
			context: { requestId: "rework-1" },
		};
		try {
			const first = grantWorkflowReworkTurn(db, input, Date.parse(NOW));
			const replay = grantWorkflowReworkTurn(
				db,
				input,
				Date.parse(NOW) + 60_000,
			);

			expect(replay).toEqual(first);
			expect(replay).toEqual({ epoch: 1, grantedAt: NOW });
		} finally {
			db.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("pauses without claiming or mutating and resumes when re-entry is re-enabled", async () => {
		const h = makeHarness({ reentryEnabled: false });
		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "disabled",
			reason: "rework_reentry_disabled",
		});
		expect(h.store.claimWorkflowReworkDelivery).not.toHaveBeenCalled();
		expect(h.effects.probeRegistered).not.toHaveBeenCalled();
		expect(h.effects.grantTurn).not.toHaveBeenCalled();
		expect(h.effects.wakeActor).not.toHaveBeenCalled();
		expect(h.store.settleWorkflowReworkFailure).not.toHaveBeenCalled();
		expect(h.getDelivery()).toMatchObject({
			state: "pending",
			generation: 0,
			hold_count: 0,
		});

		h.env.FLYWHEEL_WORKFLOW_REWORK_REENTRY = "1";
		await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
			kind: "awaiting_receipt",
		});
		expect(h.store.claimWorkflowReworkDelivery).toHaveBeenCalledOnce();
	});

	it("admits a same-exec activation, grants a new epoch, and wakes the original actor", async () => {
		const h = makeHarness({ registered: "alive" });
		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "awaiting_receipt",
			executionId: "implement-exec",
			activationId: "activation:rework-1",
			epoch: 4,
		});
		expect(h.effects.assertWorktreeReady).toHaveBeenCalledWith(session, HEAD);
		expect(h.store.admitGeneralizedWorkflowExecution).toHaveBeenCalledWith(
			expect.objectContaining({
				expiresAt: "2026-07-23T01:00:00.000Z",
				absoluteDeadlineAt: "2026-07-24T00:00:00.000Z",
			}),
		);
		expect(h.effects.activateActorForWake).toHaveBeenCalledWith(session);
		expect(
			h.effects.activateActorForWake.mock.invocationCallOrder[0],
		).toBeLessThan(h.effects.grantTurn.mock.invocationCallOrder[0]!);
		expect(h.effects.grantTurn).toHaveBeenCalledWith(
			expect.objectContaining({
				executionId: "implement-exec",
				activationId: "activation:rework-1",
				outputCredential: "output-ticket",
			}),
		);
		expect(h.effects.wakeActor).toHaveBeenCalledWith(
			expect.objectContaining({
				wakeId: "rework-wake:rework-1:activation:rework-1:epoch:4",
			}),
		);
		expect(h.getDelivery().state).toBe("awaiting_receipt");
		expect(h.getDelivery().next_retry_at).toBe("2026-07-23T00:03:00.000Z");
	});

	it("reprobes an unacked actor on the durable cadence without granting or waking again", async () => {
		const h = makeHarness({
			registered: "alive",
			initialState: "awaiting_receipt",
		});
		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "receipt_pending",
			state: "awaiting_receipt",
			executionId: "implement-exec",
		});
		expect(h.effects.probeRegistered).toHaveBeenCalledOnce();
		expect(h.store.scheduleWorkflowReworkReceiptProbe).toHaveBeenCalledWith({
			requestId: "rework-1",
			ownerId: "coordinator-a",
			generation: 1,
			nextRetryAt: "2026-07-23T00:03:00.000Z",
			reason: "receipt_not_observed",
		});
		expect(h.effects.grantTurn).not.toHaveBeenCalled();
		expect(h.effects.wakeActor).not.toHaveBeenCalled();
	});

	it("moves an unacked delivery to replacement when its actor proves dead", async () => {
		const h = makeHarness({
			registered: "dead_pin",
			initialState: "awaiting_receipt",
		});
		await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
			kind: "replacement_pending",
			executionId: "implement-exec",
		});
		expect(h.getDelivery().state).toBe("replacement_pending");
		expect(h.effects.grantTurn).not.toHaveBeenCalled();
		expect(h.effects.wakeActor).not.toHaveBeenCalled();
	});

	it("owns post-ACK liveness without replaying TURN or wake", async () => {
		const h = makeHarness({
			registered: "alive",
			initialState: "wake_delivered",
		});
		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "receipt_pending",
			state: "wake_delivered",
			executionId: "implement-exec",
		});
		expect(h.store.scheduleWorkflowReworkReceiptProbe).toHaveBeenCalledWith(
			expect.objectContaining({
				nextRetryAt: "2026-07-23T00:03:00.000Z",
				reason: "actor_alive_after_receipt",
			}),
		);
		expect(h.effects.grantTurn).not.toHaveBeenCalled();
		expect(h.effects.wakeActor).not.toHaveBeenCalled();
	});

	it("replaces a post-ACK actor that subsequently proves dead", async () => {
		const h = makeHarness({
			registered: "dead_pin",
			initialState: "wake_delivered",
		});
		await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
			kind: "replacement_pending",
			executionId: "implement-exec",
		});
		expect(h.getDelivery().state).toBe("replacement_pending");
	});

	it("backs off uncertain or dirty actors without granting TURN", async () => {
		const uncertain = makeHarness({ registered: "indeterminate" });
		await expect(
			uncertain.coordinator.reconcile("rework-1"),
		).resolves.toMatchObject({
			kind: "retryable",
			reason: "registered_liveness_indeterminate",
		});
		expect(uncertain.effects.grantTurn).not.toHaveBeenCalled();
		expect(uncertain.store.settleWorkflowReworkFailure).toHaveBeenCalledWith(
			expect.objectContaining({
				reason: "registered_liveness_indeterminate",
			}),
		);

		const dirty = makeHarness({
			registered: "alive",
			ready: { ok: false, reason: "dirty worktree" },
		});
		await expect(
			dirty.coordinator.reconcile("rework-1"),
		).resolves.toMatchObject({
			kind: "retryable",
			reason: "worktree_not_ready:dirty worktree",
		});
		expect(dirty.effects.grantTurn).not.toHaveBeenCalled();
		expect(dirty.getDelivery().state).toBe("pending");
		expect(dirty.store.settleWorkflowReworkFailure).toHaveBeenCalledWith(
			expect.objectContaining({
				reason: "worktree_not_ready:dirty worktree",
			}),
		);
	});

	it("backs off a revivable holder activation failure before admission, TURN, or wake", async () => {
		const h = makeHarness({ registered: "alive" });
		h.effects.activateActorForWake.mockResolvedValue({
			ok: false,
			error: "state_not_revivable:approved_to_ship",
		});

		await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
			kind: "retryable",
			reason: "holder_activation_failed:state_not_revivable:approved_to_ship",
		});
		expect(h.store.admitGeneralizedWorkflowExecution).not.toHaveBeenCalled();
		expect(h.effects.grantTurn).not.toHaveBeenCalled();
		expect(h.effects.wakeActor).not.toHaveBeenCalled();
	});

	it("closes an irreversible holder under the claimed delivery fence, then retries without terminalizing", async () => {
		const h = makeHarness({ registered: "alive" });
		h.effects.activateActorForWake.mockResolvedValue({
			ok: false,
			error: "state_not_revivable:completed",
		});

		await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
			kind: "retryable",
			reason: "holder_activation_failed:state_not_revivable:completed",
		});
		expect(h.effects.closeActorForReworkSupersession).toHaveBeenCalledWith({
			session,
			requestId: "rework-1",
			ownerId: "coordinator-a",
			generation: 1,
			routeRevision: 1,
			executionId: "implement-exec",
		});
		expect(h.store.settleWorkflowReworkFailure).toHaveBeenCalledWith(
			expect.objectContaining({
				reason: "holder_activation_failed:state_not_revivable:completed",
			}),
		);
		expect(
			h.store.settleWorkflowReworkFailure.mock.calls[0]?.[0],
		).not.toHaveProperty("terminal");
		expect(h.store.admitGeneralizedWorkflowExecution).not.toHaveBeenCalled();
		expect(h.getDelivery()).toMatchObject({
			state: "pending",
			hold_count: 1,
			owner_id: null,
		});
	});

	it("escalates only after five failed controlled closes", async () => {
		const h = makeHarness({ registered: "alive" });
		h.effects.activateActorForWake.mockResolvedValue({
			ok: false,
			error: "state_not_revivable:completed",
		});
		h.effects.closeActorForReworkSupersession.mockResolvedValue({
			ok: false,
			error: "phase shutdown timed out",
		});

		for (let strike = 1; strike <= 5; strike += 1) {
			await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject(
				strike === 5
					? { kind: "settled", state: "needs_lead" }
					: {
							kind: "retryable",
							reason:
								"holder_activation_failed:state_not_revivable:completed:supersession_close_failed:phase shutdown timed out",
						},
			);
		}
		expect(h.effects.closeActorForReworkSupersession).toHaveBeenCalledTimes(5);
		expect(h.getDelivery()).toMatchObject({
			state: "needs_lead",
			hold_count: 5,
		});
		for (const [failure] of h.store.settleWorkflowReworkFailure.mock.calls) {
			expect(failure).not.toHaveProperty("terminal");
			expect(failure).toMatchObject({
				reason:
					"holder_activation_failed:state_not_revivable:completed:supersession_close_failed:phase shutdown timed out",
			});
		}
	});

	it("records a thrown controlled-close failure in durable retry accounting", async () => {
		const h = makeHarness({ registered: "alive" });
		h.effects.activateActorForWake.mockResolvedValue({
			ok: false,
			error: "state_not_revivable:completed",
		});
		h.effects.closeActorForReworkSupersession.mockRejectedValue(
			new Error("close transport lost"),
		);

		await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
			kind: "retryable",
			reason:
				"holder_activation_failed:state_not_revivable:completed:supersession_close_failed:close transport lost",
		});
		expect(h.store.settleWorkflowReworkFailure).toHaveBeenCalledWith(
			expect.objectContaining({
				reason:
					"holder_activation_failed:state_not_revivable:completed:supersession_close_failed:close transport lost",
			}),
		);
	});

	it("leaves retry accounting to a new owner after supersession loses its fence", async () => {
		const h = makeHarness({ registered: "alive" });
		h.effects.activateActorForWake.mockResolvedValue({
			ok: false,
			error: "state_not_revivable:completed",
		});
		h.effects.closeActorForReworkSupersession.mockImplementation(
			async ({ requestId, ownerId, generation }) => {
				expect(
					h.store.releaseWorkflowReworkDelivery({
						requestId,
						ownerId,
						generation,
						error: "test takeover",
						now: NOW,
					}),
				).toEqual({ ok: true });
				expect(
					h.store.claimWorkflowReworkDelivery({
						requestId,
						ownerId: "coordinator-b",
						now: NOW,
						leaseExpiresAt: "2026-07-23T00:01:00.000Z",
					}),
				).toMatchObject({ ok: true, generation: 2 });
				return { ok: false, error: "authority_lost" };
			},
		);

		await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
			kind: "retryable",
			reason:
				"holder_activation_failed:state_not_revivable:completed:supersession_close_failed:authority_lost",
		});
		expect(h.getDelivery()).toMatchObject({
			owner_id: "coordinator-b",
			generation: 2,
			hold_count: 0,
			state: "pending",
		});
	});

	it("backs off a missing persisted target before handing it to pane-loss recovery", async () => {
		const h = makeHarness({ registered: "absent" });
		h.effects.getActorSession.mockReturnValue({
			...session,
			status: "terminated",
			tmux_session: undefined,
		});
		Object.assign(h.effects, {
			hasHostProcess: vi.fn(async () => true),
		});

		await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
			kind: "retryable",
			reason: "persisted_target_missing",
		});
		expect(h.store.settleWorkflowReworkFailure).toHaveBeenCalledWith(
			expect.objectContaining({
				reason: "persisted_target_missing",
				onExhausted: "handoff_held_pane_loss",
			}),
		);
	});

	it("marks only proven-dead actors for replacement", async () => {
		const dead = makeHarness({ registered: "absent", persisted: "absent" });
		await expect(dead.coordinator.reconcile("rework-1")).resolves.toMatchObject(
			{
				kind: "replacement_pending",
				executionId: "implement-exec",
			},
		);
		expect(dead.effects.grantTurn).not.toHaveBeenCalled();
		expect(dead.getDelivery().state).toBe("replacement_pending");
	});

	it("replays the same activation and source grant after a projection crash", async () => {
		const h = makeHarness({
			registered: "alive",
			failTurnProjectionOnce: true,
		});
		await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
			kind: "retryable",
			reason: "turn_projection_failed:projection_crash",
		});
		await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
			kind: "awaiting_receipt",
			activationId: "activation:rework-1",
			epoch: 4,
		});
		expect(h.effects.grantTurn).toHaveBeenCalledTimes(2);
		expect(h.effects.grantTurn.mock.calls[0]?.[0].sourceEventId).toBe(
			h.effects.grantTurn.mock.calls[1]?.[0].sourceEventId,
		);
	});

	it("retries a failed mailbox on the same actor and with the same wake identity", async () => {
		const h = makeHarness({
			registered: "alive",
			wakeResults: [{ ok: false, error: "mailbox unavailable" }, { ok: true }],
		});
		await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
			kind: "retryable",
			reason: "wake_failed:mailbox unavailable",
		});
		await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
			kind: "awaiting_receipt",
		});
		expect(h.effects.wakeActor).toHaveBeenCalledTimes(2);
		expect(h.effects.wakeActor.mock.calls[0]?.[0]).toEqual(
			h.effects.wakeActor.mock.calls[1]?.[0],
		);
		expect(h.store.admitGeneralizedWorkflowExecution).toHaveBeenCalledTimes(2);
	});

	it("moves a granted activation to replacement only if the actor later proves dead", async () => {
		const h = makeHarness({
			registered: "alive",
			wakeResults: [{ ok: false, error: "lost process" }],
		});
		await h.coordinator.reconcile("rework-1");
		h.effects.probeRegistered.mockResolvedValue("dead_pin");
		await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
			kind: "replacement_pending",
		});
		expect(h.getDelivery().state).toBe("replacement_pending");
	});
});
