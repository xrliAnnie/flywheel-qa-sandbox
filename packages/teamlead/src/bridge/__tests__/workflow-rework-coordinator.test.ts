import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CommDB } from "flywheel-comm/db";
import { describe, expect, it, vi } from "vitest";
import {
	legacyEngineeringSeed,
	pinLegacyWorkflowSeedAgents,
} from "../../__tests__/fixtures/legacy-workflow-manifests.js";
import {
	installSelfHostedWorkflowAgentProject,
	installWorkflowDomainAgentFixture,
} from "../../__tests__/fixtures/workflow-agent-project.js";
import type {
	WorkflowReworkDeliveryRow,
	WorkflowReworkRequestRow,
	WorkflowReworkRouteRevisionRow,
	WorkflowSideEffectState,
} from "../../StateStore.js";
import { buildWorkflowRunSnapshotV2 } from "../../workflow-run-snapshot.js";
import {
	classifyPhaseActorReentry,
	type PhaseActorReentryDecision,
} from "../phase-actor-reentry.js";
import {
	grantWorkflowReworkTurn,
	WorkflowReworkCoordinator,
	type WorkflowReworkCoordinatorEffects,
	type WorkflowReworkCoordinatorStore,
} from "../workflow-rework-coordinator.js";

const NOW = "2026-07-23T00:00:00.000Z";
const HEAD = "a".repeat(40);
const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const WAKE_ID = "rework-wake:rework-1:activation:rework-1:epoch:4";

function minutesBefore(minutes: number): string {
	return new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
}

function minutesAfter(minutes: number): string {
	return new Date(Date.parse(NOW) + minutes * 60_000).toISOString();
}

function buildSnapshot(implementProducesOutput = false) {
	const seed = pinLegacyWorkflowSeedAgents(legacyEngineeringSeed());
	if (implementProducesOutput) {
		const implementNode = seed.manifest.nodes.find(
			(node) => node.id === "implement",
		);
		if (!implementNode)
			throw new Error("implement node missing from test seed");
		Object.assign(implementNode, {
			type: "generic",
			produces_output: true,
			output: { schema: "json_v1", max_bytes: 262_144 },
		});
		const implementEdge = seed.manifest.edges.find(
			(edge) => edge.from === "implement",
		);
		if (!implementEdge)
			throw new Error("implement edge missing from test seed");
		implementEdge.condition = "node_done";
	}
	// This output-capability fixture deliberately retains the implement role while
	// using generic type. Install its protocol-free domain manual only in TEMP.
	const temporaryRoot = implementProducesOutput
		? mkdtempSync(join(tmpdir(), "fly1423-output-agent-"))
		: undefined;
	try {
		if (temporaryRoot) {
			installSelfHostedWorkflowAgentProject(temporaryRoot);
			installWorkflowDomainAgentFixture(temporaryRoot, "implement");
		}
		return buildWorkflowRunSnapshotV2({
			template: { id: "tpl-rework-coordinator-unit", revision: 1 },
			canonicalRoot: temporaryRoot ?? REPO_ROOT,
			manifest: seed.manifest,
		});
	} finally {
		if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
	}
}

const SNAPSHOT = buildSnapshot();
const OUTPUT_SNAPSHOT = buildSnapshot(true);

const session = {
	execution_id: "implement-exec",
	issue_id: "FLY-1423",
	project_name: "flywheel",
	status: "running",
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

type HarnessInput = {
	registered?: "alive" | "dead_pin" | "absent" | "indeterminate";
	persisted?: "alive" | "dead_pin" | "absent" | "indeterminate";
	ready?: { ok: boolean; reason?: string };
	wakeResults?: Array<{ ok: boolean; error?: string }>;
	failTurnProjectionOnce?: boolean;
	reentryEnabled?: boolean;
	initialState?: WorkflowReworkDeliveryRow["state"];
	/** FLY-2921: `turn_granted` with a pushed wake (fact column, not a state). */
	wakeSentAt?: string;
	/** FLY-2921: pre-existing unknown-liveness clock on the delivery row. */
	livenessUnknownSince?: string;
	targetNode?: "implement" | "qa";
	implementProducesOutput?: boolean;
	turnSourceProbeError?: string;
	processBodyState?: "retiring" | "standby" | "resuming" | "resume_failed";
	retirementCancelRacesToStandby?: boolean;
	cleanupResult?: { ok: boolean; error?: string };
	resumeResult?:
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
		| { ok: false; error: string; cleanupRequired: boolean };
	runStatus?: string;
	routeInterpretedBy?: string;
	routeRevision?: number;
	/** FLY-2921 C2 step 4: the only trusted death proofs while FLY-2919 is absent. */
	deathProof?: "unlaunched_rollback" | "launch_abandoned";
	replacementBudgetExhausted?: boolean;
	/** FLY-2921 C2 step 3: a replacement launch for the preferred actor. */
	replacementLaunch?: {
		ledgerState: WorkflowSideEffectState;
		createdAt?: string;
		bindingMode?: string | null;
		launchOwnerPresent?: boolean;
	};
	contentMissing?: boolean;
	replacementLaunchStallMs?: number;
	rearmResult?:
		| { kind: "reset" | "idempotent_replay" | "noop" }
		| { kind: "busy" };
};

function makeHarness(input: HarnessInput) {
	const targetNode = input.targetNode ?? "implement";
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
	let route: WorkflowReworkRouteRevisionRow = {
		request_id: request.request_id,
		revision: input.routeRevision ?? 1,
		target_node_id: targetNode,
		target_attempt: 2,
		preferred_actor_execution_id: session.execution_id,
		invalidation_scope: ["implement", "qa"],
		verification_policy: ["code_review", "qa_retest"],
		interpreted_by: input.routeInterpretedBy ?? "engine:qa_verdict",
		interpretation_reason: "qa fail",
		created_at: NOW,
	};
	let delivery: WorkflowReworkDeliveryRow = {
		request_id: request.request_id,
		owner_id: null,
		generation: 0,
		lease_expires_at: null,
		route_revision: route.revision,
		state: input.initialState ?? "pending",
		hold_count: 0,
		next_retry_at: null,
		grant_started_at: null,
		last_error: null,
		updated_at: NOW,
		wake_sent_at: input.wakeSentAt ?? null,
		liveness_unknown_since: input.livenessUnknownSince ?? null,
	};
	let activationAdmitted = delivery.state !== "pending";
	let projected = false;
	let turnSourceFrozen = false;
	let failProjection = input.failTurnProjectionOnce ?? false;
	let processBodyState = input.processBodyState;
	let processGeneration = 1;

	const claimed = (owner: { ownerId: string; generation: number }) =>
		delivery.owner_id === owner.ownerId &&
		delivery.generation === owner.generation;
	const sent = () =>
		delivery.state === "wake_delivered" ||
		(delivery.state === "turn_granted" && delivery.wake_sent_at !== null);

	const store: WorkflowReworkCoordinatorStore = {
		getWorkflowExecutionProcessBody: vi.fn(() =>
			processBodyState
				? {
						execution_id: session.execution_id,
						generation: processGeneration,
						state: processBodyState,
						current_demand_id: null,
						owner_claim_id: null,
					}
				: undefined,
		),
		cancelWorkflowExecutionRetirementForRework: vi.fn(() => {
			if (processBodyState !== "retiring") {
				return {
					ok: false as const,
					reason: `process_body_${processBodyState}`,
				};
			}
			if (input.retirementCancelRacesToStandby) {
				processBodyState = "standby";
				return {
					ok: false as const,
					reason: "process_body_standby",
				};
			}
			processBodyState = undefined;
			return {
				ok: true as const,
				generation: processGeneration,
				idempotentReplay: false,
			};
		}),
		beginWorkflowExecutionResume: vi.fn(() => {
			processGeneration += 1;
			processBodyState = "resume_failed";
			return {
				ok: true as const,
				generation: processGeneration,
				attempt: 1,
				idempotentReplay: false,
			};
		}),
		finishWorkflowExecutionResume: vi.fn(() => {
			processBodyState = undefined;
			return { ok: true as const, idempotentReplay: false };
		}),
		failWorkflowExecutionResume: vi.fn(() => {
			processBodyState = "resume_failed";
			return { ok: true as const, idempotentReplay: false };
		}),
		allocateWorkflowResumeFallback: vi.fn((fallback) => {
			if (input.replacementBudgetExhausted) {
				return { ok: false as const, reason: "replacement_budget_exhausted" };
			}
			return {
				ok: true as const,
				executionId: fallback.newExecutionId,
				launchOrdinal: 2,
				idempotentReplay: false,
			};
		}),
		getWorkflowReworkRequest: vi.fn(() => request),
		getLatestWorkflowReworkRoute: vi.fn(() => ({ ...route })),
		getWorkflowReworkDelivery: vi.fn(() => ({ ...delivery })),
		getWorkflowRun: vi.fn(() => ({
			run_id: "run-1",
			issue_id: "FLY-1423",
			project_name: "flywheel",
			status: input.runStatus ?? "active",
			engine_owned: 1,
			snapshot: JSON.stringify(
				input.implementProducesOutput ? OUTPUT_SNAPSHOT : SNAPSHOT,
			),
		})),
		getWorkflowRunNode: vi.fn(() => ({
			run_id: "run-1",
			node_id: targetNode,
			attempt: 2,
			state:
				delivery.state === "wake_delivered"
					? "running"
					: activationAdmitted
						? "admitted"
						: "pending",
			execution_id: route.preferred_actor_execution_id,
		})),
		convergeWorkflowReworkWriterReplacement: vi.fn(() => ({
			ok: false as const,
			reason: "writer_replacement_target_unavailable",
		})),
		claimWorkflowReworkDelivery: vi.fn((claim) => {
			if (
				delivery.state === "completed" ||
				delivery.state === "returned_to_lead"
			) {
				return {
					ok: false as const,
					reason: "delivery_settled" as const,
					state: delivery.state,
				};
			}
			if (delivery.owner_id && delivery.owner_id !== claim.ownerId) {
				return { ok: false as const, reason: "delivery_busy" as const };
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
			if (!claimed(release)) {
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
			if (!claimed(failure)) {
				return { ok: false as const, reason: "stale_delivery_owner" };
			}
			const holdCount = delivery.hold_count + 1;
			// FLY-2921 C3: 1/2/4/8 minute backoff; the fifth strike (or a forced
			// return) hands the rework to the Lead. The run is never frozen.
			const exhausted = failure.forceReturn === true || holdCount >= 5;
			const state = exhausted ? "returned_to_lead" : delivery.state;
			const nextRetryAt = exhausted
				? null
				: new Date(
						Date.parse(failure.now) + [1, 2, 4, 8][holdCount - 1]! * 60_000,
					).toISOString();
			delivery = {
				...delivery,
				owner_id: null,
				lease_expires_at: null,
				hold_count: holdCount,
				next_retry_at: nextRetryAt,
				state,
				last_error: failure.reason,
			};
			return {
				ok: true as const,
				holdCount,
				state: state as "pending" | "turn_granted" | "returned_to_lead",
				nextRetryAt,
			};
		}),
		replaceWorkflowReworkActor: vi.fn((replace) => {
			if (!claimed(replace)) {
				return { ok: false as const, reason: "stale_delivery_owner" };
			}
			if (
				delivery.state !== "pending" &&
				delivery.state !== "turn_granted" &&
				delivery.state !== "wake_delivered"
			) {
				return { ok: false as const, reason: "rework_delivery_state_changed" };
			}
			if (replace.deadExecutionId !== route.preferred_actor_execution_id) {
				return {
					ok: false as const,
					reason: "rework_replacement_actor_changed",
				};
			}
			if (input.replacementBudgetExhausted) {
				return { ok: false as const, reason: "replacement_budget_exhausted" };
			}
			route = {
				...route,
				revision: route.revision + 1,
				preferred_actor_execution_id: replace.newExecutionId,
				interpreted_by: "engine:proven_dead_replacement",
				interpretation_reason: replace.reason,
				created_at: replace.observedAt,
			};
			delivery = {
				...delivery,
				route_revision: route.revision,
				state: "pending",
				owner_id: null,
				lease_expires_at: null,
				hold_count: 0,
				next_retry_at: null,
				grant_started_at: null,
				wake_sent_at: null,
				liveness_unknown_since: null,
				last_error: replace.reason,
				updated_at: replace.observedAt,
			};
			activationAdmitted = false;
			return {
				ok: true as const,
				executionId: replace.newExecutionId,
				launchOrdinal: 2,
				routeRevision: route.revision,
				idempotentReplay: false,
			};
		}),
		workflowReworkDeathProof: vi.fn(() => input.deathProof),
		getWorkflowReworkReplacementLaunch: vi.fn(() =>
			input.replacementLaunch
				? {
						executionId: route.preferred_actor_execution_id,
						launchOrdinal: 2,
						ledgerState: input.replacementLaunch.ledgerState,
						createdAt: input.replacementLaunch.createdAt ?? NOW,
						bindingMode: input.replacementLaunch.bindingMode ?? null,
						launchOwnerPresent:
							input.replacementLaunch.launchOwnerPresent ?? false,
					}
				: undefined,
		),
		abandonUnadmittedReworkReplacementLaunch: vi.fn((abandon) =>
			claimed(abandon)
				? { ok: true as const }
				: { ok: false as const, reason: "stale_delivery_owner" },
		),
		hasReworkReplacementContentMissingFact: vi.fn(
			() => input.contentMissing ?? false,
		),
		deferWorkflowReworkDelivery: vi.fn((defer) => {
			if (
				!claimed(defer) ||
				!(
					delivery.state === "pending" ||
					(delivery.state === "turn_granted" && delivery.wake_sent_at === null)
				)
			) {
				return { ok: false as const, reason: "stale_delivery_owner" };
			}
			delivery = {
				...delivery,
				owner_id: null,
				lease_expires_at: null,
				next_retry_at: defer.nextRetryAt,
			};
			return { ok: true as const };
		}),
		noteWorkflowReworkLiveness: vi.fn((note) => {
			if (!claimed(note)) {
				return { ok: false as const, reason: "stale_delivery_owner" };
			}
			if (note.known) {
				delivery = { ...delivery, liveness_unknown_since: null };
				return { ok: true as const, unknownSince: null, alerted: null };
			}
			const unknownSince = delivery.liveness_unknown_since ?? note.now;
			delivery = { ...delivery, liveness_unknown_since: unknownSince };
			const ageMs = Date.parse(note.now) - Date.parse(unknownSince);
			return {
				ok: true as const,
				unknownSince,
				alerted:
					ageMs >= 2 * 60 * 60_000
						? ("severe" as const)
						: ageMs >= 30 * 60_000
							? ("warn" as const)
							: null,
			};
		}),
		markWorkflowReworkWakeSent: vi.fn((mark) => {
			if (!claimed(mark) || delivery.state !== "turn_granted") {
				return { ok: false as const, reason: "stale_delivery_owner" };
			}
			delivery = {
				...delivery,
				wake_sent_at: delivery.wake_sent_at ?? mark.now,
				next_retry_at: new Date(
					Date.parse(mark.now) + 3 * 60_000,
				).toISOString(),
				owner_id: null,
				lease_expires_at: null,
				last_error: null,
			};
			return { ok: true as const };
		}),
		markWorkflowReworkGrantStarted: vi.fn((grant) => {
			if (!claimed(grant)) {
				return { ok: false as const, reason: "stale_delivery_owner" };
			}
			delivery = { ...delivery, grant_started_at: grant.now };
			return { ok: true as const };
		}),
		scheduleWorkflowReworkReceiptProbe: vi.fn((probe) => {
			if (!claimed(probe) || !sent()) {
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
			const allowed =
				(advance.from === "pending" && advance.to === "turn_granted") ||
				(advance.from === "wake_delivered" && advance.to === "completed");
			if (!allowed) {
				return {
					ok: false as const,
					reason: "invalid_rework_delivery_transition",
				};
			}
			if (!claimed(advance) || delivery.state !== advance.from) {
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
				...(replay
					? {}
					: targetNode === "qa"
						? { submissionCredential: "submission-ticket" }
						: { outputCredential: "output-ticket" }),
			};
		}),
		rotateGeneralizedWorkflowOutputCredential: vi.fn(() => ({
			ok: true as const,
			outputCredential: "rotated-output-ticket",
		})),
		rotateGeneralizedWorkflowSubmissionCredential: vi.fn(() => ({
			ok: true as const,
			submissionCredential: "rotated-submission-ticket",
		})),
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
	let resumed = false;
	const effects = {
		getActorSession: vi.fn(() => session),
		probeRegistered: vi.fn(async () =>
			resumed ? "alive" : (input.registered ?? "alive"),
		),
		probePersisted: vi.fn(async () => input.persisted ?? "absent"),
		assertWorktreeReady: vi.fn(async () => input.ready ?? { ok: true }),
		activateActorForWake: vi.fn(async () => ({ ok: true })),
		resumeStandbyActor: vi.fn(async () => {
			const result = input.resumeResult ?? {
				ok: true as const,
				expectedSessionId: "session-1",
				observedSessionId: "session-1",
				expectedModel: "sonnet",
				observedModel: "sonnet",
				expectedCwd: "/tmp/worktree",
				observedCwd: "/tmp/worktree",
				queueMs: 1,
				startupMs: 2,
				totalMs: 3,
			};
			if (result.ok) resumed = true;
			return result;
		}),
		closeActorForReworkSupersession: vi.fn(
			async () => input.cleanupResult ?? { ok: true },
		),
		cleanupFailedStandbyResume: vi.fn(
			async () => input.cleanupResult ?? { ok: true },
		),
		hasTurnSource: vi.fn(async () => {
			if (input.turnSourceProbeError) {
				throw new Error(input.turnSourceProbeError);
			}
			return turnSourceFrozen;
		}),
		grantTurn: vi.fn(async () => {
			turnSourceFrozen = true;
			return { epoch: 4, grantedAt: NOW };
		}),
		wakeActor: vi.fn(async () => wakeResults.shift() ?? { ok: true }),
		rearmReworkWake: vi.fn(async () => input.rearmResult ?? { kind: "reset" }),
	} satisfies WorkflowReworkCoordinatorEffects;
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
		reentryEnabled: () => env.FLYWHEEL_WORKFLOW_REWORK_REENTRY !== "0",
		...(input.replacementLaunchStallMs !== undefined
			? { replacementLaunchStallMs: () => input.replacementLaunchStallMs! }
			: {}),
	});
	return {
		coordinator,
		store,
		effects,
		env,
		initialRouteRevision: input.routeRevision ?? 1,
		getDelivery: () => delivery,
		getRoute: () => route,
		/** Simulate a concurrent writer (e.g. a completion landing inside the wake). */
		mutateDelivery: (patch: Partial<WorkflowReworkDeliveryRow>) => {
			delivery = { ...delivery, ...patch };
		},
	};
}

/** FLY-2921: the assertions every "no death proof" path must satisfy. */
function expectNoSuccessor(h: ReturnType<typeof makeHarness>) {
	expect(h.store.replaceWorkflowReworkActor).not.toHaveBeenCalled();
	expect(
		h.store.convergeWorkflowReworkWriterReplacement,
	).not.toHaveBeenCalled();
	expect(h.store.allocateWorkflowResumeFallback).not.toHaveBeenCalled();
	expect(h.getRoute().preferred_actor_execution_id).toBe(session.execution_id);
	expect(h.getRoute().revision).toBe(h.initialRouteRevision);
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
			kind: "wake_sent",
		});
		expect(h.store.claimWorkflowReworkDelivery).toHaveBeenCalledOnce();
	});

	it("admits a same-exec activation, grants a new epoch, and wakes the original actor", async () => {
		const h = makeHarness({
			registered: "alive",
			implementProducesOutput: true,
		});
		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "wake_sent",
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
			expect.objectContaining({ wakeId: WAKE_ID }),
		);
		// FLY-2921 C1.6: the push is a fact on the `turn_granted` row, not a state.
		expect(h.getDelivery()).toMatchObject({
			state: "turn_granted",
			wake_sent_at: NOW,
			next_retry_at: "2026-07-23T00:03:00.000Z",
			owner_id: null,
		});
	});

	it("cancels in-grace retirement before waking the still-live original actor", async () => {
		const h = makeHarness({
			processBodyState: "retiring",
			registered: "alive",
			implementProducesOutput: true,
		});

		await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
			kind: "wake_sent",
			executionId: "implement-exec",
		});
		expect(
			h.store.cancelWorkflowExecutionRetirementForRework,
		).toHaveBeenCalledWith({
			executionId: "implement-exec",
			demandId: "rework-1",
			now: NOW,
		});
		expect(h.effects.resumeStandbyActor).not.toHaveBeenCalled();
		expect(h.effects.activateActorForWake).toHaveBeenCalledWith(session);
		expect(h.effects.wakeActor).toHaveBeenCalledOnce();
		expect(
			vi.mocked(h.store.cancelWorkflowExecutionRetirementForRework!).mock
				.invocationCallOrder[0],
		).toBeLessThan(h.effects.grantTurn.mock.invocationCallOrder[0]!);
	});

	it("resumes standby when retirement cancellation loses the confirmation race", async () => {
		const h = makeHarness({
			processBodyState: "retiring",
			retirementCancelRacesToStandby: true,
			registered: "absent",
			persisted: "absent",
			implementProducesOutput: true,
		});

		await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
			kind: "wake_sent",
			executionId: "implement-exec",
		});
		expect(
			h.store.cancelWorkflowExecutionRetirementForRework,
		).toHaveBeenCalledOnce();
		expect(h.effects.resumeStandbyActor).toHaveBeenCalledWith(
			expect.objectContaining({
				session,
				demandId: "rework-1",
				processGeneration: 2,
			}),
		);
		expect(
			h.effects.resumeStandbyActor.mock.invocationCallOrder[0],
		).toBeLessThan(h.effects.wakeActor.mock.invocationCallOrder[0]!);
	});

	it("admits and grants TURN before resuming a confirmed standby process body", async () => {
		const h = makeHarness({
			processBodyState: "standby",
			registered: "absent",
			persisted: "absent",
			implementProducesOutput: true,
		});
		await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
			kind: "wake_sent",
			executionId: "implement-exec",
		});
		expect(h.effects.resumeStandbyActor).toHaveBeenCalledWith({
			session,
			demandId: "rework-1",
			ownerId: "coordinator-a",
			ownerGeneration: 1,
			processGeneration: 2,
			expectedHeadSha: HEAD,
		});
		expect(
			vi.mocked(h.store.beginWorkflowExecutionResume!).mock
				.invocationCallOrder[0],
		).toBeLessThan(h.effects.resumeStandbyActor.mock.invocationCallOrder[0]!);
		expect(
			vi.mocked(h.store.admitGeneralizedWorkflowExecution).mock
				.invocationCallOrder[0],
		).toBeLessThan(h.effects.resumeStandbyActor.mock.invocationCallOrder[0]!);
		expect(h.effects.grantTurn.mock.invocationCallOrder[0]).toBeLessThan(
			h.effects.resumeStandbyActor.mock.invocationCallOrder[0]!,
		);
		expect(
			vi.mocked(h.store.recordWorkflowActivationTurn).mock
				.invocationCallOrder[0],
		).toBeLessThan(h.effects.resumeStandbyActor.mock.invocationCallOrder[0]!);
		expect(
			h.effects.resumeStandbyActor.mock.invocationCallOrder[0],
		).toBeLessThan(
			vi.mocked(h.store.finishWorkflowExecutionResume!).mock
				.invocationCallOrder[0]!,
		);
		expect(
			vi.mocked(h.store.finishWorkflowExecutionResume!).mock
				.invocationCallOrder[0],
		).toBeLessThan(h.effects.activateActorForWake.mock.invocationCallOrder[0]!);
		expect(
			h.effects.activateActorForWake.mock.invocationCallOrder[0],
		).toBeLessThan(h.effects.wakeActor.mock.invocationCallOrder[0]!);
	});

	it("records a failed standby resume after granting TURN and never wakes", async () => {
		const h = makeHarness({
			processBodyState: "standby",
			registered: "absent",
			persisted: "absent",
			resumeResult: {
				ok: false,
				error: "session_identity_mismatch",
				cleanupRequired: true,
			},
		});

		await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
			kind: "retryable",
			reason: "standby_resume_failed:session_identity_mismatch",
		});
		expect(h.store.failWorkflowExecutionResume).toHaveBeenCalledWith(
			expect.objectContaining({
				executionId: "implement-exec",
				demandId: "rework-1",
				reasonCode: "session_identity_mismatch",
			}),
		);
		expect(h.store.finishWorkflowExecutionResume).not.toHaveBeenCalled();
		expect(h.effects.cleanupFailedStandbyResume).toHaveBeenCalledWith({
			session,
			requestId: "rework-1",
			ownerId: "coordinator-a",
			generation: 1,
			routeRevision: 1,
			executionId: "implement-exec",
			processGeneration: 2,
			demandId: "rework-1",
			ownerClaimId: "coordinator-a:1",
		});
		expect(
			h.effects.cleanupFailedStandbyResume.mock.invocationCallOrder[0],
		).toBeLessThan(
			vi.mocked(h.store.failWorkflowExecutionResume!).mock
				.invocationCallOrder[0]!,
		);
		expect(h.effects.activateActorForWake).not.toHaveBeenCalled();
		expect(h.effects.grantTurn).toHaveBeenCalledOnce();
		expect(h.effects.grantTurn.mock.invocationCallOrder[0]).toBeLessThan(
			h.effects.resumeStandbyActor.mock.invocationCallOrder[0]!,
		);
		expect(h.effects.wakeActor).not.toHaveBeenCalled();
	});

	it("records a pre-launch resume failure without tearing down the parked body", async () => {
		const h = makeHarness({
			processBodyState: "standby",
			registered: "absent",
			persisted: "absent",
			resumeResult: {
				ok: false,
				error: "resume_git_identity_unavailable",
				cleanupRequired: false,
			},
		});

		await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
			kind: "retryable",
			reason: "standby_resume_failed:resume_git_identity_unavailable",
		});
		expect(h.effects.cleanupFailedStandbyResume).not.toHaveBeenCalled();
		expect(h.effects.closeActorForReworkSupersession).not.toHaveBeenCalled();
		expect(h.store.failWorkflowExecutionResume).toHaveBeenCalledWith(
			expect.objectContaining({
				reasonCode: "resume_git_identity_unavailable",
			}),
		);
	});

	it("fails closed without another launch when failed-resume cleanup is unconfirmed", async () => {
		const h = makeHarness({
			processBodyState: "standby",
			registered: "absent",
			persisted: "absent",
			resumeResult: {
				ok: false,
				error: "resume_identity_timeout",
				cleanupRequired: true,
				evidence: {
					expectedSessionId: "session-original",
					expectedModel: "claude-opus-5-5",
					expectedCwd: "/tmp/worktree",
					totalMs: 180_000,
				},
			},
			cleanupResult: { ok: false, error: "process_still_alive" },
		});

		await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
			kind: "retryable",
			reason:
				"standby_resume_cleanup_unconfirmed:process_still_alive:resume_identity_timeout",
		});
		// FLY-2808 QA: the latch must not erase why the resume failed.
		expect(h.store.failWorkflowExecutionResume).toHaveBeenCalledWith(
			expect.objectContaining({
				reasonCode: "cleanup_unconfirmed",
				attemptReasonCode: "resume_identity_timeout",
				evidence: {
					expectedSessionId: "session-original",
					expectedModel: "claude-opus-5-5",
					expectedCwd: "/tmp/worktree",
					totalMs: 180_000,
				},
			}),
		);
		expect(h.effects.grantTurn).toHaveBeenCalledOnce();
		expect(h.effects.wakeActor).not.toHaveBeenCalled();
	});

	it("routes a resuming process body back through durable lease recovery", async () => {
		const h = makeHarness({
			processBodyState: "resuming",
			registered: "absent",
			persisted: "absent",
			implementProducesOutput: true,
		});

		await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
			kind: "wake_sent",
			executionId: "implement-exec",
		});
		expect(h.store.beginWorkflowExecutionResume).toHaveBeenCalled();
	});

	it("allocates a separate fallback dispatch inside the claim after the resume budget is exhausted", async () => {
		const h = makeHarness({
			processBodyState: "resume_failed",
			registered: "absent",
			persisted: "absent",
		});
		vi.mocked(h.store.beginWorkflowExecutionResume!).mockReturnValue({
			ok: false,
			reason: "resume_attempt_limit",
		});

		await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
			kind: "replacement_minted",
			executionId: expect.any(String),
			reason: "resume_fallback",
		});
		// FLY-2921 C6.3: the fallback shares the replacement core and runs under
		// the coordinator's claim, so it carries owner + generation.
		expect(h.store.allocateWorkflowResumeFallback).toHaveBeenCalledWith({
			executionId: "implement-exec",
			demandId: "rework-1",
			newExecutionId: expect.any(String),
			now: NOW,
			ownerId: "coordinator-a",
			generation: 1,
		});
		expect(h.effects.resumeStandbyActor).not.toHaveBeenCalled();
		expect(h.effects.grantTurn).not.toHaveBeenCalled();
		expect(h.effects.wakeActor).not.toHaveBeenCalled();
	});

	it("returns the rework to the Lead when the resume fallback exhausts the replacement budget", async () => {
		const h = makeHarness({
			processBodyState: "resume_failed",
			registered: "absent",
			persisted: "absent",
			replacementBudgetExhausted: true,
		});
		vi.mocked(h.store.beginWorkflowExecutionResume!).mockReturnValue({
			ok: false,
			reason: "resume_attempt_limit",
		});

		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "settled",
			state: "returned_to_lead",
		});
		expect(h.store.settleWorkflowReworkFailure).toHaveBeenCalledWith(
			expect.objectContaining({
				reason: "replacement_budget_exhausted",
				forceReturn: true,
			}),
		);
		expect(h.getDelivery()).toMatchObject({ state: "returned_to_lead" });
		expect(h.effects.wakeActor).not.toHaveBeenCalled();
	});

	it("reprobes an unacked actor on the durable cadence without granting or waking again", async () => {
		const h = makeHarness({
			registered: "alive",
			initialState: "turn_granted",
			wakeSentAt: minutesBefore(3),
		});
		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "receipt_pending",
			state: "turn_granted",
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
		expect(h.store.settleWorkflowReworkFailure).not.toHaveBeenCalled();
	});

	it("keeps an unacked delivery waiting when its pane dies without a death proof", async () => {
		// FLY-2921 C2 step 4: a dead pin is a reason to verify, not a proof;
		// liveness-based replacement is closed until FLY-2919 lands.
		const h = makeHarness({
			registered: "dead_pin",
			initialState: "turn_granted",
			wakeSentAt: minutesBefore(3),
		});
		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "receipt_pending",
			state: "turn_granted",
			executionId: "implement-exec",
		});
		expectNoSuccessor(h);
		expect(h.store.noteWorkflowReworkLiveness).toHaveBeenCalledWith(
			expect.objectContaining({ known: false, reason: "registered_dead_pin" }),
		);
		// A wake already pushed: the actor is not asked to close (authority
		// rules out `wake_delivered`/sent rows) and no failure is counted.
		expect(h.effects.closeActorForReworkSupersession).not.toHaveBeenCalled();
		expect(h.store.settleWorkflowReworkFailure).not.toHaveBeenCalled();
		expect(h.getDelivery()).toMatchObject({
			state: "turn_granted",
			liveness_unknown_since: NOW,
			hold_count: 0,
		});
		expect(h.effects.grantTurn).not.toHaveBeenCalled();
		expect(h.effects.wakeActor).not.toHaveBeenCalled();
	});

	it("treats a terminal session as unverified and replaces only on rollback evidence", async () => {
		const terminal = makeHarness({ registered: "alive" });
		terminal.effects.getActorSession.mockReturnValue({
			...session,
			status: "completed",
		});
		await expect(
			terminal.coordinator.reconcile("rework-1"),
		).resolves.toMatchObject({
			kind: "retryable",
			reason: "actor_session_terminal:completed",
		});
		expect(terminal.effects.probeRegistered).not.toHaveBeenCalled();
		expect(
			terminal.effects.closeActorForReworkSupersession,
		).toHaveBeenCalledOnce();
		expect(terminal.store.settleWorkflowReworkFailure).toHaveBeenCalledWith(
			expect.objectContaining({ reason: "actor_session_terminal:completed" }),
		);
		expectNoSuccessor(terminal);

		const rolledBack = makeHarness({
			registered: "alive",
			deathProof: "unlaunched_rollback",
		});
		rolledBack.effects.getActorSession.mockReturnValue(undefined);
		await expect(
			rolledBack.coordinator.reconcile("rework-1"),
		).resolves.toMatchObject({
			kind: "replacement_minted",
			executionId: expect.any(String),
			reason: "unlaunched_rollback",
		});
		expect(rolledBack.effects.probeRegistered).not.toHaveBeenCalled();
		expect(rolledBack.store.replaceWorkflowReworkActor).toHaveBeenCalledOnce();
		expect(rolledBack.store.settleWorkflowReworkFailure).not.toHaveBeenCalled();
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

	it("keeps a post-ACK actor whose pane died as unknown liveness, not as dead", async () => {
		const h = makeHarness({
			registered: "dead_pin",
			initialState: "wake_delivered",
		});
		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "receipt_pending",
			state: "wake_delivered",
			executionId: "implement-exec",
		});
		expectNoSuccessor(h);
		expect(h.effects.closeActorForReworkSupersession).not.toHaveBeenCalled();
		expect(h.store.settleWorkflowReworkFailure).not.toHaveBeenCalled();
		expect(h.getDelivery()).toMatchObject({
			state: "wake_delivered",
			liveness_unknown_since: NOW,
		});
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
		// FLY-2921 C2 step 5: the unknown clock starts on the first hold.
		expect(uncertain.getDelivery().liveness_unknown_since).toBe(NOW);

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
		expect(
			h.store.settleWorkflowReworkFailure.mock.calls[0]?.[0],
		).not.toHaveProperty("forceReturn");
		expect(h.store.admitGeneralizedWorkflowExecution).not.toHaveBeenCalled();
		expect(h.getDelivery()).toMatchObject({
			state: "pending",
			hold_count: 1,
			owner_id: null,
		});
	});

	it("returns the rework to the Lead only after five failed controlled closes", async () => {
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
					? { kind: "settled", state: "returned_to_lead" }
					: {
							kind: "retryable",
							reason:
								"holder_activation_failed:state_not_revivable:completed:supersession_close_failed:phase shutdown timed out",
						},
			);
		}
		expect(h.effects.closeActorForReworkSupersession).toHaveBeenCalledTimes(5);
		expect(h.getDelivery()).toMatchObject({
			state: "returned_to_lead",
			hold_count: 5,
		});
		for (const [failure] of h.store.settleWorkflowReworkFailure.mock.calls) {
			expect(failure).not.toHaveProperty("terminal");
			expect(failure).not.toHaveProperty("forceReturn");
			expect(failure).toMatchObject({
				reason:
					"holder_activation_failed:state_not_revivable:completed:supersession_close_failed:phase shutdown timed out",
			});
		}
		// FLY-2921 C3: the returned row is settled for the engine; only a Lead
		// resume (new route revision) reopens it.
		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "settled",
			state: "returned_to_lead",
		});
		expect(h.effects.closeActorForReworkSupersession).toHaveBeenCalledTimes(5);
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

	it("asks a terminal actor with a missing persisted target to close and counts, never replaces", async () => {
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
			reason: "actor_session_terminal:terminated",
		});
		expectNoSuccessor(h);
		expect(h.effects.closeActorForReworkSupersession).toHaveBeenCalledOnce();
		expect(h.effects.probeRegistered).not.toHaveBeenCalled();
		expect(h.store.settleWorkflowReworkFailure).toHaveBeenCalledWith(
			expect.objectContaining({ reason: "actor_session_terminal:terminated" }),
		);
		expect(h.getDelivery()).toMatchObject({
			state: "pending",
			hold_count: 1,
			liveness_unknown_since: NOW,
		});
	});

	it("backs off when the actor session row is entirely missing", async () => {
		const h = makeHarness({ registered: "absent" });
		h.effects.getActorSession.mockReturnValue(undefined);

		await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
			kind: "retryable",
			reason: "actor_session_missing",
		});
		expect(h.store.settleWorkflowReworkFailure).toHaveBeenCalledWith(
			expect.objectContaining({ reason: "actor_session_missing" }),
		);
		// No session to ask: nothing to close, and still no successor.
		expect(h.effects.closeActorForReworkSupersession).not.toHaveBeenCalled();
		expectNoSuccessor(h);
	});

	it("does not replace a dead-probed actor without a death proof", async () => {
		const dead = makeHarness({ registered: "absent", persisted: "absent" });
		await expect(dead.coordinator.reconcile("rework-1")).resolves.toMatchObject(
			{
				kind: "retryable",
				reason: "persisted_target_dead",
			},
		);
		expect(dead.effects.grantTurn).not.toHaveBeenCalled();
		expectNoSuccessor(dead);
		expect(dead.effects.closeActorForReworkSupersession).toHaveBeenCalledOnce();
		expect(dead.getDelivery()).toMatchObject({
			state: "pending",
			hold_count: 1,
			liveness_unknown_since: NOW,
		});
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
			kind: "wake_sent",
			activationId: "activation:rework-1",
			epoch: 4,
		});
		expect(h.effects.grantTurn).toHaveBeenCalledTimes(2);
		expect(h.effects.grantTurn.mock.calls[0]?.[0].sourceEventId).toBe(
			h.effects.grantTurn.mock.calls[1]?.[0].sourceEventId,
		);
	});

	it("fails closed before TURN when replay output rotation loses its claim", async () => {
		const h = makeHarness({
			registered: "alive",
			implementProducesOutput: true,
		});
		h.effects.grantTurn.mockRejectedValueOnce(new Error("lease_held"));

		await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
			kind: "retryable",
			reason: "turn_grant_failed:lease_held",
		});
		vi.mocked(
			h.store.rotateGeneralizedWorkflowOutputCredential,
		).mockReturnValue({ ok: false, reason: "stale_rework_owner" });

		await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
			kind: "retryable",
			reason: "engine_output_rotation_stale_rework_owner",
		});
		expect(h.effects.grantTurn).toHaveBeenCalledOnce();
	});

	it("fails closed before TURN when replay submission rotation loses its claim", async () => {
		const h = makeHarness({ registered: "alive", targetNode: "qa" });
		h.effects.grantTurn.mockRejectedValueOnce(new Error("lease_held"));

		await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
			kind: "retryable",
			reason: "turn_grant_failed:lease_held",
		});
		vi.mocked(
			h.store.rotateGeneralizedWorkflowSubmissionCredential,
		).mockReturnValue({ ok: false, reason: "stale_rework_owner" });

		await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
			kind: "retryable",
			reason: "engine_submission_rotation_stale_rework_owner",
		});
		expect(h.effects.grantTurn).toHaveBeenCalledOnce();
	});

	it("preserves the credential when TURN froze but its StateStore projection failed", async () => {
		const h = makeHarness({
			registered: "alive",
			targetNode: "qa",
			failTurnProjectionOnce: true,
		});

		await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
			kind: "retryable",
			reason: "turn_projection_failed:projection_crash",
		});
		await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
			kind: "wake_sent",
		});

		expect(h.effects.hasTurnSource).toHaveBeenCalledOnce();
		expect(
			h.store.rotateGeneralizedWorkflowSubmissionCredential,
		).not.toHaveBeenCalled();
	});

	it("fails closed when the frozen TURN source cannot be checked before rotation", async () => {
		const h = makeHarness({
			registered: "alive",
			targetNode: "qa",
			turnSourceProbeError: "comm unavailable",
		});
		h.effects.grantTurn.mockRejectedValueOnce(new Error("lease_held"));

		await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
			kind: "retryable",
			reason: "turn_grant_failed:lease_held",
		});
		await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
			kind: "retryable",
			reason: "turn_source_probe_failed:comm unavailable",
		});

		expect(
			h.store.rotateGeneralizedWorkflowSubmissionCredential,
		).not.toHaveBeenCalled();
		expect(h.effects.grantTurn).toHaveBeenCalledOnce();
	});

	it.each(["pending", "turn_granted"] as const)(
		"treats an expired resident hold from %s as unverified death: asks to close, counts once, mints nothing",
		async (initialState) => {
			// FLY-2921 C2 step 7: `resident_hold_expired` is a reason to verify,
			// not a death proof. The push never happened, so this counts.
			const h = makeHarness({
				initialState,
				wakeResults: [{ ok: false, error: "resident_hold_expired" }],
			});

			await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
				kind: "retryable",
				reason: "resident_hold_expired",
			});
			expectNoSuccessor(h);
			expect(h.effects.closeActorForReworkSupersession).toHaveBeenCalledWith(
				expect.objectContaining({
					session,
					requestId: "rework-1",
					ownerId: "coordinator-a",
					generation: 1,
					routeRevision: 1,
				}),
			);
			expect(h.store.settleWorkflowReworkFailure).toHaveBeenCalledWith(
				expect.objectContaining({ reason: "resident_hold_expired" }),
			);
			expect(h.getDelivery()).toMatchObject({
				state: "turn_granted",
				wake_sent_at: null,
				hold_count: 1,
				owner_id: null,
			});
			expect(h.store.markWorkflowReworkWakeSent).not.toHaveBeenCalled();
		},
	);

	it("asks a released completed actor to close without attempting wake, and never replaces it", async () => {
		const h = makeHarness({ registered: "absent" });
		h.effects.getActorSession.mockReturnValue({
			...session,
			status: "completed",
			tmux_session: undefined,
		});

		await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
			kind: "retryable",
			reason: "actor_session_terminal:completed",
		});
		expectNoSuccessor(h);
		expect(h.effects.closeActorForReworkSupersession).toHaveBeenCalledOnce();
		expect(h.getDelivery()).toMatchObject({
			state: "pending",
			hold_count: 1,
		});
		expect(h.effects.wakeActor).not.toHaveBeenCalled();
		expect(h.effects.probeRegistered).not.toHaveBeenCalled();
	});

	// FLY-2921 C5: the fence no longer emits resident_hold_already_woken; a
	// woken hold is delivered to directly. Only the CAS conflict remains.
	it.each(["resident_hold_wake_conflict"])(
		"retries %s without replacing the actor",
		async (error) => {
			const h = makeHarness({ wakeResults: [{ ok: false, error }] });
			await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
				kind: "retryable",
				reason: `wake_failed:${error}`,
			});
			expectNoSuccessor(h);
			expect(h.effects.closeActorForReworkSupersession).not.toHaveBeenCalled();
			expect(h.store.settleWorkflowReworkFailure).toHaveBeenCalled();
		},
	);

	it("retries a failed mailbox on the same actor and with the same wake identity", async () => {
		const h = makeHarness({
			registered: "alive",
			wakeResults: [{ ok: false, error: "mailbox unavailable" }, { ok: true }],
		});
		await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
			kind: "retryable",
			reason: "wake_failed:mailbox unavailable",
		});
		expect(h.getDelivery()).toMatchObject({
			state: "turn_granted",
			wake_sent_at: null,
		});
		await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
			kind: "wake_sent",
		});
		expect(h.effects.wakeActor).toHaveBeenCalledTimes(2);
		expect(h.effects.wakeActor.mock.calls[0]?.[0]).toEqual(
			h.effects.wakeActor.mock.calls[1]?.[0],
		);
		expect(h.store.admitGeneralizedWorkflowExecution).toHaveBeenCalledTimes(2);
		expect(h.getDelivery()).toMatchObject({
			state: "turn_granted",
			wake_sent_at: NOW,
		});
	});

	it("keeps a granted-but-unpushed activation on its actor when only the pane dies", async () => {
		const h = makeHarness({
			registered: "alive",
			wakeResults: [{ ok: false, error: "lost process" }],
		});
		await h.coordinator.reconcile("rework-1");
		h.effects.probeRegistered.mockResolvedValue("dead_pin");
		await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
			kind: "retryable",
			reason: "registered_dead_pin",
		});
		expectNoSuccessor(h);
		// Granted but never pushed: the actor is asked to close and the
		// unknown liveness counts against the transport budget.
		expect(h.effects.closeActorForReworkSupersession).toHaveBeenCalledOnce();
		expect(h.getDelivery()).toMatchObject({
			state: "turn_granted",
			wake_sent_at: null,
			hold_count: 2,
		});
	});
});

describe("FLY-2921 C2 step 4: a trusted death proof replaces the actor in place", () => {
	it.each(["unlaunched_rollback", "launch_abandoned"] as const)(
		"mints the successor inside the claim on a %s proof",
		async (deathProof) => {
			const h = makeHarness({ deathProof });

			await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
				kind: "replacement_minted",
				executionId: expect.any(String),
				reason: deathProof,
			});
			expect(h.store.replaceWorkflowReworkActor).toHaveBeenCalledOnce();
			// The fake transaction CAS-checks owner + generation, so a successful
			// mint proves the replacement ran under this reconcile's claim.
			expect(h.store.replaceWorkflowReworkActor).toHaveBeenCalledWith({
				requestId: "rework-1",
				ownerId: "coordinator-a",
				generation: 1,
				deadExecutionId: "implement-exec",
				newExecutionId: expect.any(String),
				proof: { kind: deathProof },
				reason: deathProof,
				observedAt: NOW,
			});
			expect(
				vi.mocked(h.store.claimWorkflowReworkDelivery).mock
					.invocationCallOrder[0],
			).toBeLessThan(
				vi.mocked(h.store.replaceWorkflowReworkActor).mock
					.invocationCallOrder[0]!,
			);
			// Landed on `pending` at revision + 1 with every per-revision clock
			// cleared (C2: each new route revision resets the unknown timer).
			expect(h.getDelivery()).toMatchObject({
				state: "pending",
				route_revision: 2,
				hold_count: 0,
				owner_id: null,
				lease_expires_at: null,
				grant_started_at: null,
				wake_sent_at: null,
				liveness_unknown_since: null,
			});
			expect(h.getRoute()).toMatchObject({
				revision: 2,
				interpreted_by: "engine:proven_dead_replacement",
			});
			expect(h.getRoute().preferred_actor_execution_id).not.toBe(
				"implement-exec",
			);
			// No probe, no TURN, no wake, no failure accounting for the dead body.
			expect(h.effects.probeRegistered).not.toHaveBeenCalled();
			expect(h.effects.closeActorForReworkSupersession).not.toHaveBeenCalled();
			expect(h.effects.grantTurn).not.toHaveBeenCalled();
			expect(h.effects.wakeActor).not.toHaveBeenCalled();
			expect(h.store.settleWorkflowReworkFailure).not.toHaveBeenCalled();
		},
	);

	it("replaces a granted-but-unpushed and a delivered actor alike once a proof exists", async () => {
		for (const initialState of ["turn_granted", "wake_delivered"] as const) {
			const h = makeHarness({ deathProof: "launch_abandoned", initialState });
			await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
				kind: "replacement_minted",
				reason: "launch_abandoned",
			});
			expect(h.getDelivery()).toMatchObject({
				state: "pending",
				route_revision: 2,
			});
		}
	});

	it("returns the rework to the Lead when the replacement budget is exhausted", async () => {
		const h = makeHarness({
			deathProof: "unlaunched_rollback",
			replacementBudgetExhausted: true,
		});

		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "settled",
			state: "returned_to_lead",
		});
		expect(h.store.replaceWorkflowReworkActor).toHaveBeenCalledOnce();
		expect(h.store.settleWorkflowReworkFailure).toHaveBeenCalledOnce();
		expect(h.store.settleWorkflowReworkFailure).toHaveBeenCalledWith(
			expect.objectContaining({
				requestId: "rework-1",
				ownerId: "coordinator-a",
				generation: 1,
				reason: "replacement_budget_exhausted",
				forceReturn: true,
			}),
		);
		expect(h.getDelivery()).toMatchObject({
			state: "returned_to_lead",
			route_revision: 1,
			owner_id: null,
		});
		expect(h.getRoute().revision).toBe(1);
		// C3: settled for the engine; no further supersession or wake attempts.
		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "settled",
			state: "returned_to_lead",
		});
		expect(h.effects.wakeActor).not.toHaveBeenCalled();
	});

	it("gives the claim back without counting when the replacement commit goes stale", async () => {
		const h = makeHarness({ deathProof: "launch_abandoned" });
		vi.mocked(h.store.replaceWorkflowReworkActor).mockReturnValue({
			ok: false,
			reason: "rework_replacement_node_changed",
		});

		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "retryable",
			reason: "replacement_not_committed:rework_replacement_node_changed",
		});
		expect(h.store.settleWorkflowReworkFailure).not.toHaveBeenCalled();
		expect(h.store.releaseWorkflowReworkDelivery).toHaveBeenCalledWith(
			expect.objectContaining({
				error: "replacement_not_committed:rework_replacement_node_changed",
			}),
		);
		expect(h.getDelivery()).toMatchObject({ hold_count: 0, owner_id: null });
	});
});

describe("FLY-2921 C2 step 4 negative control: no proof, no successor", () => {
	type NoProofCase = {
		name: string;
		harness: HarnessInput;
		setup?: (h: ReturnType<typeof makeHarness>) => void;
		reason: string;
		/** Whether the harness session row exists (a missing row cannot be asked to close). */
		hasActor: boolean;
	};
	const cases: NoProofCase[] = [
		{
			name: "irreversible terminal session label",
			harness: { registered: "alive" },
			setup: (h) =>
				h.effects.getActorSession.mockReturnValue({
					...session,
					status: "completed",
				}),
			reason: "actor_session_terminal:completed",
			hasActor: true,
		},
		{
			name: "missing session row",
			harness: { registered: "alive" },
			setup: (h) => h.effects.getActorSession.mockReturnValue(undefined),
			reason: "actor_session_missing",
			hasActor: false,
		},
		{
			name: "re-entry classifier says replace (dead pin)",
			harness: { registered: "dead_pin" },
			reason: "registered_dead_pin",
			hasActor: true,
		},
		{
			name: "re-entry classifier says replace (target absent)",
			harness: { registered: "absent", persisted: "absent" },
			reason: "persisted_target_dead",
			hasActor: true,
		},
	];
	const states: Array<{
		label: string;
		initialState: WorkflowReworkDeliveryRow["state"];
		wakeSentAt?: string;
		sent: boolean;
	}> = [
		{ label: "pending", initialState: "pending", sent: false },
		{
			label: "turn_granted (not pushed)",
			initialState: "turn_granted",
			sent: false,
		},
		{
			label: "turn_granted (pushed)",
			initialState: "turn_granted",
			wakeSentAt: minutesBefore(3),
			sent: true,
		},
		{ label: "wake_delivered", initialState: "wake_delivered", sent: true },
	];

	for (const testCase of cases) {
		for (const state of states) {
			it(`${testCase.name} on ${state.label}: zero successors, close only when unsent, count only when unsent`, async () => {
				const h = makeHarness({
					...testCase.harness,
					initialState: state.initialState,
					...(state.wakeSentAt ? { wakeSentAt: state.wakeSentAt } : {}),
				});
				testCase.setup?.(h);

				const outcome = await h.coordinator.reconcile("rework-1");

				expectNoSuccessor(h);
				expect(h.effects.grantTurn).not.toHaveBeenCalled();
				expect(h.effects.wakeActor).not.toHaveBeenCalled();
				expect(h.store.noteWorkflowReworkLiveness).toHaveBeenCalledWith(
					expect.objectContaining({ known: false, reason: testCase.reason }),
				);
				expect(h.getDelivery().liveness_unknown_since).toBe(NOW);
				if (state.sent) {
					// A pushed wake only waits on its receipt: no close request
					// (authority excludes sent rows), no failure, 3-minute reprobe.
					expect(outcome).toEqual({
						kind: "receipt_pending",
						state: state.initialState,
						executionId: "implement-exec",
					});
					expect(
						h.effects.closeActorForReworkSupersession,
					).not.toHaveBeenCalled();
					expect(h.store.settleWorkflowReworkFailure).not.toHaveBeenCalled();
					expect(
						h.store.scheduleWorkflowReworkReceiptProbe,
					).toHaveBeenCalledWith(
						expect.objectContaining({
							nextRetryAt: "2026-07-23T00:03:00.000Z",
							reason: testCase.reason,
						}),
					);
					expect(h.getDelivery()).toMatchObject({
						state: state.initialState,
						hold_count: 0,
						owner_id: null,
					});
				} else {
					expect(outcome).toEqual({
						kind: "retryable",
						reason: testCase.reason,
					});
					if (testCase.hasActor) {
						expect(
							h.effects.closeActorForReworkSupersession,
						).toHaveBeenCalledWith(
							expect.objectContaining({
								requestId: "rework-1",
								ownerId: "coordinator-a",
								generation: 1,
								routeRevision: 1,
								executionId: "implement-exec",
							}),
						);
					} else {
						expect(
							h.effects.closeActorForReworkSupersession,
						).not.toHaveBeenCalled();
					}
					expect(h.store.settleWorkflowReworkFailure).toHaveBeenCalledWith(
						expect.objectContaining({ reason: testCase.reason }),
					);
					expect(
						h.store.settleWorkflowReworkFailure.mock.calls[0]?.[0],
					).not.toHaveProperty("forceReturn");
					expect(h.getDelivery()).toMatchObject({
						state: state.initialState,
						hold_count: 1,
						owner_id: null,
					});
				}
			});
		}
	}

	it("reports a failed close request in the counted reason and still mints nothing", async () => {
		const h = makeHarness({
			registered: "dead_pin",
			cleanupResult: { ok: false, error: "phase shutdown timed out" },
		});
		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "retryable",
			reason:
				"registered_dead_pin:supersession_close_failed:phase shutdown timed out",
		});
		expectNoSuccessor(h);
		expect(h.getDelivery()).toMatchObject({ hold_count: 1 });
	});
});

describe("FLY-2921 C2 step 5: unknown liveness on a pushed wake", () => {
	it("reprobes a pushed turn_granted wake, notes the unknown clock, and counts nothing", async () => {
		const h = makeHarness({
			registered: "indeterminate",
			initialState: "turn_granted",
			wakeSentAt: minutesBefore(3),
		});

		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "receipt_pending",
			state: "turn_granted",
			executionId: "implement-exec",
		});
		expect(h.store.noteWorkflowReworkLiveness).toHaveBeenCalledOnce();
		expect(h.store.noteWorkflowReworkLiveness).toHaveBeenCalledWith({
			requestId: "rework-1",
			ownerId: "coordinator-a",
			generation: 1,
			known: false,
			reason: "registered_liveness_indeterminate",
			now: NOW,
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			},
		});
		expect(h.store.settleWorkflowReworkFailure).not.toHaveBeenCalled();
		expect(h.store.scheduleWorkflowReworkReceiptProbe).toHaveBeenCalledWith(
			expect.objectContaining({
				nextRetryAt: "2026-07-23T00:03:00.000Z",
				reason: "registered_liveness_indeterminate",
			}),
		);
		expect(h.getDelivery()).toMatchObject({
			state: "turn_granted",
			wake_sent_at: minutesBefore(3),
			liveness_unknown_since: NOW,
			hold_count: 0,
		});
		expectNoSuccessor(h);
	});

	it("keeps the first unknown timestamp across reprobes and clears it once the actor is seen alive", async () => {
		const h = makeHarness({
			registered: "indeterminate",
			initialState: "turn_granted",
			wakeSentAt: minutesBefore(3),
			livenessUnknownSince: minutesBefore(10),
		});
		await h.coordinator.reconcile("rework-1");
		expect(h.getDelivery().liveness_unknown_since).toBe(minutesBefore(10));

		h.effects.probeRegistered.mockResolvedValue("alive");
		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "receipt_pending",
			state: "turn_granted",
			executionId: "implement-exec",
		});
		expect(h.store.noteWorkflowReworkLiveness).toHaveBeenLastCalledWith(
			expect.objectContaining({ known: true, reason: "liveness_known" }),
		);
		expect(h.getDelivery().liveness_unknown_since).toBeNull();
		expect(h.store.settleWorkflowReworkFailure).not.toHaveBeenCalled();
	});

	it("returns a pushed turn_granted wake to the Lead after two unknown hours (FLY-2919 absent)", async () => {
		const h = makeHarness({
			registered: "indeterminate",
			initialState: "turn_granted",
			wakeSentAt: minutesBefore(125),
			livenessUnknownSince: minutesBefore(120),
		});

		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "settled",
			state: "returned_to_lead",
		});
		expect(h.store.noteWorkflowReworkLiveness).toHaveBeenCalledWith(
			expect.objectContaining({ known: false }),
		);
		expect(h.store.settleWorkflowReworkFailure).toHaveBeenCalledOnce();
		expect(h.store.settleWorkflowReworkFailure).toHaveBeenCalledWith(
			expect.objectContaining({
				reason: "liveness_unknown_timeout:registered_liveness_indeterminate",
				forceReturn: true,
			}),
		);
		expect(h.store.scheduleWorkflowReworkReceiptProbe).not.toHaveBeenCalled();
		expect(h.getDelivery()).toMatchObject({ state: "returned_to_lead" });
		expectNoSuccessor(h);
	});

	it("does not return a pushed wake under the two-hour line", async () => {
		const h = makeHarness({
			registered: "indeterminate",
			initialState: "turn_granted",
			wakeSentAt: minutesBefore(125),
			livenessUnknownSince: minutesBefore(119),
		});
		await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
			kind: "receipt_pending",
		});
		expect(h.store.settleWorkflowReworkFailure).not.toHaveBeenCalled();
	});

	it("keeps a wake_delivered actor with unknown liveness on the receipt probe even after two hours", async () => {
		const h = makeHarness({
			registered: "indeterminate",
			initialState: "wake_delivered",
			livenessUnknownSince: minutesBefore(180),
		});
		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "receipt_pending",
			state: "wake_delivered",
			executionId: "implement-exec",
		});
		expect(h.store.settleWorkflowReworkFailure).not.toHaveBeenCalled();
		expectNoSuccessor(h);
	});
});

describe("FLY-2921 C2 step 3: a pending delivery waiting on a replacement launch", () => {
	const launchingBaseline = (h: ReturnType<typeof makeHarness>) => {
		expect(h.effects.grantTurn).not.toHaveBeenCalled();
		expect(h.effects.wakeActor).not.toHaveBeenCalled();
		expect(h.store.admitGeneralizedWorkflowExecution).not.toHaveBeenCalled();
	};

	it("row d: an intent blocked before admission under the stall threshold is deferred without a failure", async () => {
		const h = makeHarness({
			replacementLaunch: {
				ledgerState: "intent_recorded",
				createdAt: minutesBefore(1),
				bindingMode: null,
			},
		});

		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "replacement_launching",
			executionId: "implement-exec",
			reason: "replacement_launching",
		});
		expect(h.store.deferWorkflowReworkDelivery).toHaveBeenCalledWith({
			requestId: "rework-1",
			ownerId: "coordinator-a",
			generation: 1,
			nextRetryAt: "2026-07-23T00:00:30.000Z",
			reason: "replacement_launching",
		});
		expect(h.store.settleWorkflowReworkFailure).not.toHaveBeenCalled();
		expect(h.store.releaseWorkflowReworkDelivery).not.toHaveBeenCalled();
		expect(h.getDelivery()).toMatchObject({
			state: "pending",
			hold_count: 0,
			owner_id: null,
			next_retry_at: "2026-07-23T00:00:30.000Z",
		});
		launchingBaseline(h);
		expectNoSuccessor(h);
	});

	it("row d: an admitted intent (binding mode replacement) is likewise deferred", async () => {
		const h = makeHarness({
			replacementLaunch: {
				ledgerState: "intent_recorded",
				createdAt: minutesBefore(5),
				bindingMode: "replacement",
				launchOwnerPresent: true,
			},
		});
		await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
			kind: "replacement_launching",
			reason: "replacement_launching",
		});
		expect(h.store.settleWorkflowReworkFailure).not.toHaveBeenCalled();
		launchingBaseline(h);
	});

	it("row e: an intent older than the stall threshold counts a replacement_launch_stalled failure", async () => {
		const h = makeHarness({
			replacementLaunch: {
				ledgerState: "intent_recorded",
				createdAt: minutesBefore(11),
				bindingMode: null,
			},
		});

		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "retryable",
			reason: "replacement_launch_stalled:intent_recorded",
		});
		expect(h.store.settleWorkflowReworkFailure).toHaveBeenCalledWith(
			expect.objectContaining({
				reason: "replacement_launch_stalled:intent_recorded",
			}),
		);
		expect(h.store.deferWorkflowReworkDelivery).not.toHaveBeenCalled();
		expect(h.getDelivery()).toMatchObject({ state: "pending", hold_count: 1 });
		launchingBaseline(h);
		expectNoSuccessor(h);
	});

	it("row e: the stall threshold is configurable per deployment", async () => {
		const h = makeHarness({
			replacementLaunch: {
				ledgerState: "intent_recorded",
				createdAt: minutesBefore(2),
			},
			replacementLaunchStallMs: 60_000,
		});
		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "retryable",
			reason: "replacement_launch_stalled:intent_recorded",
		});
	});

	it("row e: five stalled strikes return the rework to the Lead", async () => {
		const h = makeHarness({
			replacementLaunch: {
				ledgerState: "intent_recorded",
				createdAt: minutesBefore(11),
			},
		});
		for (let strike = 1; strike <= 5; strike += 1) {
			await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject(
				strike === 5
					? { kind: "settled", state: "returned_to_lead" }
					: {
							kind: "retryable",
							reason: "replacement_launch_stalled:intent_recorded",
						},
			);
		}
		expect(h.getDelivery()).toMatchObject({
			state: "returned_to_lead",
			hold_count: 5,
		});
	});

	it("row c: a death proof on the launching replacement replaces it again", async () => {
		const h = makeHarness({
			replacementLaunch: { ledgerState: "intent_recorded" },
			deathProof: "launch_abandoned",
		});

		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "replacement_minted",
			executionId: expect.any(String),
			reason: "replacement_launch_abandoned",
		});
		expect(h.store.replaceWorkflowReworkActor).toHaveBeenCalledWith(
			expect.objectContaining({
				proof: { kind: "launch_abandoned" },
				deadExecutionId: "implement-exec",
			}),
		);
		expect(h.store.settleWorkflowReworkFailure).not.toHaveBeenCalled();
		expect(h.store.deferWorkflowReworkDelivery).not.toHaveBeenCalled();
		launchingBaseline(h);
	});

	it("row b: a Lead-resumed revision abandons an unadmitted intent, then replaces with fresh content", async () => {
		const h = makeHarness({
			routeInterpretedBy: "engine:hold_resume",
			routeRevision: 2,
			replacementLaunch: {
				ledgerState: "intent_recorded",
				bindingMode: null,
				launchOwnerPresent: false,
			},
		});

		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "replacement_minted",
			executionId: expect.any(String),
			reason: "replacement_superseded_by_lead_resume",
		});
		expect(
			h.store.abandonUnadmittedReworkReplacementLaunch,
		).toHaveBeenCalledWith({
			requestId: "rework-1",
			ownerId: "coordinator-a",
			generation: 1,
			reason: "rework_replacement_superseded_by_lead_resume",
			now: NOW,
		});
		expect(
			vi.mocked(h.store.abandonUnadmittedReworkReplacementLaunch).mock
				.invocationCallOrder[0],
		).toBeLessThan(
			vi.mocked(h.store.replaceWorkflowReworkActor).mock
				.invocationCallOrder[0]!,
		);
		expect(h.store.replaceWorkflowReworkActor).toHaveBeenCalledWith(
			expect.objectContaining({
				proof: { kind: "launch_abandoned" },
				reason: "replacement_superseded_by_lead_resume",
			}),
		);
		expect(h.getRoute()).toMatchObject({
			revision: 3,
			interpreted_by: "engine:proven_dead_replacement",
		});
		expect(h.getDelivery()).toMatchObject({
			state: "pending",
			route_revision: 3,
		});
		expect(h.store.settleWorkflowReworkFailure).not.toHaveBeenCalled();
		expect(h.effects.rearmReworkWake).not.toHaveBeenCalled();
		launchingBaseline(h);
	});

	it("row b: a Lead-resumed revision with an admitted intent waits for the launch fence to cancel it", async () => {
		const h = makeHarness({
			routeInterpretedBy: "engine:hold_resume",
			routeRevision: 2,
			replacementLaunch: {
				ledgerState: "intent_recorded",
				bindingMode: "replacement",
				launchOwnerPresent: true,
			},
		});
		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "replacement_launching",
			executionId: "implement-exec",
			reason: "replacement_awaiting_launch_cancellation",
		});
		expect(
			h.store.abandonUnadmittedReworkReplacementLaunch,
		).not.toHaveBeenCalled();
		expect(h.store.deferWorkflowReworkDelivery).toHaveBeenCalledWith(
			expect.objectContaining({
				nextRetryAt: "2026-07-23T00:00:30.000Z",
				reason: "replacement_awaiting_launch_cancellation",
			}),
		);
		expect(h.store.settleWorkflowReworkFailure).not.toHaveBeenCalled();
		expectNoSuccessor(h);
	});

	it("row b: a Lead-resumed revision with a committed launch asks the replacement to close and counts", async () => {
		const h = makeHarness({
			routeInterpretedBy: "engine:hold_resume",
			routeRevision: 2,
			registered: "alive",
			replacementLaunch: {
				ledgerState: "launch_committed",
				bindingMode: "replacement",
				launchOwnerPresent: true,
			},
		});
		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "retryable",
			reason: "replacement_envelope_superseded_by_lead_resume",
		});
		expect(h.effects.closeActorForReworkSupersession).toHaveBeenCalledOnce();
		expect(h.store.settleWorkflowReworkFailure).toHaveBeenCalledWith(
			expect.objectContaining({
				reason: "replacement_envelope_superseded_by_lead_resume",
			}),
		);
		expectNoSuccessor(h);
		launchingBaseline(h);
	});

	it("row a: a content-missing fact outranks waiting: close is requested and the failure counts", async () => {
		const h = makeHarness({
			registered: "alive",
			contentMissing: true,
			replacementLaunch: {
				ledgerState: "launch_committed",
				bindingMode: "replacement",
			},
		});
		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "retryable",
			reason: "replacement_content_missing",
		});
		expect(h.effects.closeActorForReworkSupersession).toHaveBeenCalledOnce();
		expect(h.store.noteWorkflowReworkLiveness).toHaveBeenCalledWith(
			expect.objectContaining({
				known: false,
				reason: "replacement_content_missing",
			}),
		);
		expect(h.store.settleWorkflowReworkFailure).toHaveBeenCalledWith(
			expect.objectContaining({ reason: "replacement_content_missing" }),
		);
		expect(h.store.deferWorkflowReworkDelivery).not.toHaveBeenCalled();
		expectNoSuccessor(h);
		launchingBaseline(h);
	});

	it("row f: a committed launch with a live replacement is deferred three minutes with no wake", async () => {
		const h = makeHarness({
			registered: "alive",
			replacementLaunch: {
				ledgerState: "launch_committed",
				bindingMode: "replacement",
				launchOwnerPresent: true,
			},
		});
		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "replacement_launching",
			executionId: "implement-exec",
			reason: "replacement_launch_committed:alive",
		});
		expect(h.effects.probeRegistered).toHaveBeenCalledOnce();
		expect(h.store.deferWorkflowReworkDelivery).toHaveBeenCalledWith(
			expect.objectContaining({
				nextRetryAt: "2026-07-23T00:03:00.000Z",
				reason: "replacement_launch_committed:alive",
			}),
		);
		expect(h.store.settleWorkflowReworkFailure).not.toHaveBeenCalled();
		expect(h.effects.closeActorForReworkSupersession).not.toHaveBeenCalled();
		expect(h.getDelivery()).toMatchObject({ state: "pending", hold_count: 0 });
		launchingBaseline(h);
		expectNoSuccessor(h);
	});

	it("row f: a committed launch whose liveness is unknown starts the unknown clock and waits", async () => {
		const h = makeHarness({
			registered: "indeterminate",
			replacementLaunch: {
				ledgerState: "launch_committed",
				bindingMode: "replacement",
			},
		});
		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "replacement_launching",
			executionId: "implement-exec",
			reason: "replacement_launch_committed:registered_liveness_indeterminate",
		});
		expect(h.store.noteWorkflowReworkLiveness).toHaveBeenCalledWith(
			expect.objectContaining({ known: false }),
		);
		expect(h.getDelivery().liveness_unknown_since).toBe(NOW);
		expect(h.store.settleWorkflowReworkFailure).not.toHaveBeenCalled();
		expectNoSuccessor(h);
	});

	it("row f: a committed launch with a dead pane is asked to close and waits for a proof", async () => {
		const h = makeHarness({
			registered: "dead_pin",
			replacementLaunch: {
				ledgerState: "launch_committed",
				bindingMode: "replacement",
			},
		});
		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "replacement_launching",
			executionId: "implement-exec",
			reason: "replacement_launch_committed:registered_dead_pin",
		});
		expect(h.effects.closeActorForReworkSupersession).toHaveBeenCalledOnce();
		expect(h.store.settleWorkflowReworkFailure).not.toHaveBeenCalled();
		expectNoSuccessor(h);
	});

	it("row f: a committed launch with no session row is treated as sent and waits", async () => {
		const h = makeHarness({
			replacementLaunch: {
				ledgerState: "launch_committed",
				bindingMode: "replacement",
			},
		});
		h.effects.getActorSession.mockReturnValue(undefined);
		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "replacement_launching",
			executionId: "implement-exec",
			reason: "replacement_launch_committed:actor_session_missing",
		});
		expect(h.store.settleWorkflowReworkFailure).not.toHaveBeenCalled();
		expectNoSuccessor(h);
	});

	it("ignores a dispatch intent whose binding is not a replacement", async () => {
		const h = makeHarness({
			registered: "alive",
			replacementLaunch: {
				ledgerState: "intent_recorded",
				bindingMode: "spawn",
			},
		});
		await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
			kind: "wake_sent",
		});
		expect(h.store.deferWorkflowReworkDelivery).not.toHaveBeenCalled();
	});
});

describe("FLY-2921 C2: Lead resume re-arms the same wake once", () => {
	it("re-arms with the resume receipt before pushing on a hold_resume revision", async () => {
		const h = makeHarness({
			registered: "alive",
			routeInterpretedBy: "engine:hold_resume",
			routeRevision: 2,
			rearmResult: { kind: "reset" },
		});

		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "wake_sent",
			executionId: "implement-exec",
			activationId: "activation:rework-1",
			epoch: 4,
		});
		expect(h.effects.rearmReworkWake).toHaveBeenCalledOnce();
		expect(h.effects.rearmReworkWake).toHaveBeenCalledWith({
			projectName: "flywheel",
			wakeId: WAKE_ID,
			receiptId: "rework-rearm:rework-1:2",
		});
		expect(h.effects.rearmReworkWake.mock.invocationCallOrder[0]).toBeLessThan(
			h.effects.wakeActor.mock.invocationCallOrder[0]!,
		);
		// Same wake identity on both sides: nothing new is minted.
		expect(h.effects.wakeActor).toHaveBeenCalledWith(
			expect.objectContaining({ wakeId: WAKE_ID }),
		);
		expect(h.getDelivery()).toMatchObject({
			state: "turn_granted",
			wake_sent_at: NOW,
		});
	});

	it("does not re-arm on an engine-authored revision or once the wake is already pushed", async () => {
		const engine = makeHarness({
			registered: "alive",
			rearmResult: { kind: "reset" },
		});
		await expect(
			engine.coordinator.reconcile("rework-1"),
		).resolves.toMatchObject({
			kind: "wake_sent",
		});
		expect(engine.effects.rearmReworkWake).not.toHaveBeenCalled();

		const pushed = makeHarness({
			registered: "alive",
			routeInterpretedBy: "engine:hold_resume",
			routeRevision: 2,
			initialState: "turn_granted",
			wakeSentAt: minutesBefore(1),
			rearmResult: { kind: "reset" },
		});
		await expect(
			pushed.coordinator.reconcile("rework-1"),
		).resolves.toMatchObject({
			kind: "receipt_pending",
		});
		expect(pushed.effects.rearmReworkWake).not.toHaveBeenCalled();
	});

	it.each(["idempotent_replay", "noop"] as const)(
		"continues to the push when the re-arm reports %s",
		async (kind) => {
			const h = makeHarness({
				registered: "alive",
				routeInterpretedBy: "engine:hold_resume",
				routeRevision: 2,
				rearmResult: { kind },
			});
			await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
				kind: "wake_sent",
			});
			expect(h.effects.wakeActor).toHaveBeenCalledOnce();
		},
	);

	it("defers without a wake, a failure, or a re-arm when a push claim is live (busy)", async () => {
		const h = makeHarness({
			registered: "alive",
			routeInterpretedBy: "engine:hold_resume",
			routeRevision: 2,
			rearmResult: { kind: "busy" },
		});

		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "retryable",
			reason: "wake_rearm_busy",
		});
		expect(h.store.deferWorkflowReworkDelivery).toHaveBeenCalledWith({
			requestId: "rework-1",
			ownerId: "coordinator-a",
			generation: 1,
			nextRetryAt: "2026-07-23T00:00:30.000Z",
			reason: "wake_rearm_busy",
		});
		expect(h.effects.wakeActor).not.toHaveBeenCalled();
		expect(h.store.settleWorkflowReworkFailure).not.toHaveBeenCalled();
		expect(h.store.markWorkflowReworkWakeSent).not.toHaveBeenCalled();
		expect(h.store.advanceWorkflowReworkDelivery).not.toHaveBeenCalled();
		expect(h.getDelivery()).toMatchObject({
			state: "pending",
			hold_count: 0,
			owner_id: null,
			wake_sent_at: null,
			next_retry_at: "2026-07-23T00:00:30.000Z",
		});

		// The next pass re-arms (the claim has cleared) and pushes once.
		h.effects.rearmReworkWake.mockResolvedValue({ kind: "reset" });
		await expect(h.coordinator.reconcile("rework-1")).resolves.toMatchObject({
			kind: "wake_sent",
		});
		expect(h.effects.rearmReworkWake).toHaveBeenCalledTimes(2);
		expect(h.effects.wakeActor).toHaveBeenCalledOnce();
	});

	it("counts a thrown re-arm as a delivery failure", async () => {
		const h = makeHarness({
			registered: "alive",
			routeInterpretedBy: "engine:hold_resume",
			routeRevision: 2,
		});
		h.effects.rearmReworkWake.mockRejectedValue(new Error("comm unavailable"));
		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "retryable",
			reason: "wake_rearm_failed:comm unavailable",
		});
		expect(h.effects.wakeActor).not.toHaveBeenCalled();
		expect(h.store.settleWorkflowReworkFailure).toHaveBeenCalledWith(
			expect.objectContaining({ reason: "wake_rearm_failed:comm unavailable" }),
		);
	});
});

describe("FLY-2921 C1.6: a successful push is a fact on turn_granted", () => {
	it("advances pending→turn_granted before the push and marks wake_sent_at after it", async () => {
		const h = makeHarness({ registered: "alive" });

		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "wake_sent",
			executionId: "implement-exec",
			activationId: "activation:rework-1",
			epoch: 4,
		});
		expect(h.store.advanceWorkflowReworkDelivery).toHaveBeenCalledOnce();
		expect(h.store.advanceWorkflowReworkDelivery).toHaveBeenCalledWith({
			requestId: "rework-1",
			ownerId: "coordinator-a",
			generation: 1,
			from: "pending",
			to: "turn_granted",
			now: NOW,
		});
		expect(h.store.markWorkflowReworkWakeSent).toHaveBeenCalledOnce();
		expect(h.store.markWorkflowReworkWakeSent).toHaveBeenCalledWith({
			requestId: "rework-1",
			ownerId: "coordinator-a",
			generation: 1,
			now: NOW,
		});
		const advanceOrder = vi.mocked(h.store.advanceWorkflowReworkDelivery).mock
			.invocationCallOrder[0]!;
		const wakeOrder = h.effects.wakeActor.mock.invocationCallOrder[0]!;
		const markOrder = vi.mocked(h.store.markWorkflowReworkWakeSent).mock
			.invocationCallOrder[0]!;
		expect(advanceOrder).toBeLessThan(wakeOrder);
		expect(wakeOrder).toBeLessThan(markOrder);
		expect(h.getDelivery()).toMatchObject({
			state: "turn_granted",
			wake_sent_at: NOW,
			next_retry_at: minutesAfter(3),
			owner_id: null,
			lease_expires_at: null,
			hold_count: 0,
		});
		expect(h.store.settleWorkflowReworkFailure).not.toHaveBeenCalled();
	});

	it("does not resend a pushed wake on the next pass", async () => {
		const h = makeHarness({ registered: "alive" });
		await h.coordinator.reconcile("rework-1");
		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "receipt_pending",
			state: "turn_granted",
			executionId: "implement-exec",
		});
		expect(h.effects.wakeActor).toHaveBeenCalledOnce();
		expect(h.store.markWorkflowReworkWakeSent).toHaveBeenCalledOnce();
	});

	it("reports the CAS reason when the row moved on during the push (completion inside the wake)", async () => {
		const h = makeHarness({ registered: "alive" });
		h.effects.wakeActor.mockImplementation(async () => {
			// The actor completed inside the wake: the completion-implied receipt
			// settled the row before the coordinator could mark the push.
			h.mutateDelivery({ state: "completed", owner_id: null });
			return { ok: true };
		});

		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "retryable",
			reason: "stale_delivery_owner",
		});
		expect(h.store.settleWorkflowReworkFailure).not.toHaveBeenCalled();
		expect(h.getDelivery()).toMatchObject({ state: "completed" });
		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "settled",
			state: "completed",
		});
	});
});

describe("FLY-2921 C2 step 1: a row on a run that is no longer active", () => {
	it.each(["held", "terminated", "completed"])(
		"is released without a failure count when the run is %s",
		async (runStatus) => {
			const h = makeHarness({ registered: "alive", runStatus });

			await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
				kind: "retryable",
				reason: "rework_run_not_active",
			});
			expect(h.store.releaseWorkflowReworkDelivery).toHaveBeenCalledWith({
				requestId: "rework-1",
				ownerId: "coordinator-a",
				generation: 1,
				error: "rework_run_not_active",
				now: NOW,
			});
			expect(h.store.settleWorkflowReworkFailure).not.toHaveBeenCalled();
			expect(h.effects.probeRegistered).not.toHaveBeenCalled();
			expect(h.effects.grantTurn).not.toHaveBeenCalled();
			expect(h.effects.wakeActor).not.toHaveBeenCalled();
			expect(h.getDelivery()).toMatchObject({
				state: "pending",
				hold_count: 0,
				owner_id: null,
			});
			expectNoSuccessor(h);
		},
	);

	it("schedules the receipt probe instead of releasing when the wake was already pushed", async () => {
		const h = makeHarness({
			runStatus: "held",
			initialState: "turn_granted",
			wakeSentAt: minutesBefore(1),
		});
		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "retryable",
			reason: "rework_run_not_active",
		});
		expect(h.store.scheduleWorkflowReworkReceiptProbe).toHaveBeenCalledWith(
			expect.objectContaining({ reason: "rework_run_not_active" }),
		);
		expect(h.store.releaseWorkflowReworkDelivery).not.toHaveBeenCalled();
		expect(h.store.settleWorkflowReworkFailure).not.toHaveBeenCalled();
	});

	it("still counts a failure when the context itself is missing on an active run", async () => {
		const h = makeHarness({ registered: "alive" });
		vi.mocked(h.store.getLatestWorkflowReworkRoute).mockReturnValue(undefined);
		await expect(h.coordinator.reconcile("rework-1")).resolves.toEqual({
			kind: "retryable",
			reason: "rework_context_unavailable",
		});
		expect(h.store.settleWorkflowReworkFailure).toHaveBeenCalledWith(
			expect.objectContaining({ reason: "rework_context_unavailable" }),
		);
	});
});
