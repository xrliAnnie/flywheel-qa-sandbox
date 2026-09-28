import type { BodyObservation } from "flywheel-claude-runner";

/** Bridge-internal authority; never deserialize this input from a Runner request. */
export interface BodyDeathCommitInput {
	observation: BodyObservation;
	expectedCommIdentityRevision: string;
	observedTurnEpoch: number | null;
	/** Synchronous final read of the managed switch and reowner/OS identity fences. */
	isCurrent(observation: BodyObservation): boolean;
	markerDir?: string;
	nowMs: number;
}
export interface BodyDeathObligation {
	version: 1;
	obligationId: string;
	observation: BodyObservation;
	runId: string | null;
	nodeId: string | null;
	attempt: number | null;
	expectedCommIdentityRevision: string;
	observedTurnEpoch: number | null;
	terminalStatus: string;
	terminalLifecycleId: string | null;
	completionEventId: string | null;
	disposition:
		| "failed"
		| "terminal_preserved"
		| "completion_preserved"
		| "standby";
	committedAt: string;
}
export type BodyDeathCommitResult =
	| { ok: true; obligation: BodyDeathObligation; idempotentReplay: boolean }
	| { ok: false; reason: string };

import type {
	BodyDeathProjectionProof,
	BodyDeathProjectionResult,
	CommDB,
} from "flywheel-comm/db";
import { canonicalSubmissionDigest } from "flywheel-config";
import type { StateStore } from "../StateStore.js";
import type { createExecutionBodyObserver } from "./execution-body-liveness.js";

export interface ExecutionBodyConvergenceDeps {
	store: StateStore;
	comm: CommDB;
	observer: ReturnType<typeof createExecutionBodyObserver>;
	completionBlocksDeath(executionId: string): Promise<boolean>;
	markerDir?: string;
	now(): number;
}
export type ExecutionBodyConvergenceResult =
	| { kind: "deferred"; reason: string }
	| {
			kind: "committed";
			obligation: BodyDeathObligation;
			projection: ReturnType<typeof projectCommittedExecutionBodyDeath>;
	  };

/** Temporary lease contention is scheduling, not a semantic death refusal.
 * Each attempt reacquires/revalidates independently; no lease is held while waiting. */
export async function retryExecutionBodyConvergence(
	attempt: () => Promise<ExecutionBodyConvergenceResult>,
	wait: (ms: number) => Promise<void> = (ms) =>
		new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<ExecutionBodyConvergenceResult> {
	const delays = [25, 75];
	for (let index = 0; ; index++) {
		const result = await attempt();
		const delay = delays[index];
		if (
			result.kind !== "deferred" ||
			result.reason !== "lease_held" ||
			delay === undefined
		)
			return result;
		await wait(delay);
	}
}

function projectionProof(
	store: StateStore,
	duty: BodyDeathObligation,
): BodyDeathProjectionProof | undefined {
	const { observation } = duty;
	const activationId = observation.identity.activationId;
	const run = duty.runId ? store.getWorkflowRun(duty.runId) : undefined;
	const session = store.getSession(observation.identity.executionId);
	const workflowScope = Boolean(
		activationId && run && duty.nodeId && duty.attempt,
	);
	const legacyScope =
		activationId === null &&
		duty.runId === null &&
		duty.nodeId === null &&
		duty.attempt === null;
	if (
		(!workflowScope && !legacyScope) ||
		!session ||
		!session.issue_id ||
		!duty.terminalLifecycleId
	)
		return undefined;
	let status: BodyDeathProjectionProof["terminalStatus"];
	switch (duty.terminalStatus) {
		case "failed":
		case "blocked":
		case "completed":
			status = duty.terminalStatus;
			break;
		// CommDB has no cancellation enum; preserve the source reason in the receipt.
		case "terminated":
		case "rejected":
		case "deferred":
		case "shelved":
			status = "completed";
			break;
		default:
			return undefined;
	}
	return {
		version: 1,
		obligationId: duty.obligationId,
		executionId: observation.identity.executionId,
		activationId,
		generation: observation.identity.generation,
		ownerToken: observation.ownerToken,
		spawnEpoch: observation.spawnEpoch,
		bindingDigest: observation.bindingDigest,
		lifecycleRevision: observation.identity.lifecycleRevision,
		runId: duty.runId,
		nodeId: duty.nodeId,
		attempt: duty.attempt,
		projectName: run?.project_name ?? session.project_name,
		issueId: run?.issue_id ?? session.issue_id,
		evidenceId: canonicalSubmissionDigest(observation),
		expectedIdentityRevision: duty.expectedCommIdentityRevision,
		observedTurnEpoch: duty.observedTurnEpoch,
		observedAt: observation.observedAt,
		expiresAt: observation.expiresAt,
		committedAt: duty.committedAt,
		terminalLifecycleId: duty.terminalLifecycleId,
		terminalStatus: status,
		terminalReason: `${duty.terminalStatus}:${observation.reason}`,
	};
}

/** Replay a committed StateStore duty, without resampling or manufacturing a new
 * land reservation. The short lease covers only synchronous cross-store effects. */
export function projectCommittedExecutionBodyDeath(input: {
	store: StateStore;
	comm: CommDB;
	obligationId: string;
	nowMs: number;
}): BodyDeathProjectionResult | { projected: false; reason: string } {
	const { store, comm } = input;
	const duty = store.getExecutionBodyDeathObligation(input.obligationId);
	if (!duty)
		return { projected: false, reason: "body_death_obligation_missing" };
	const proof = projectionProof(store, duty);
	if (!proof)
		return { projected: false, reason: "body_death_obligation_invalid" };
	const session = store.getSession(proof.executionId);
	if (!session) return { projected: false, reason: "session_missing" };
	const revision = session.lifecycle_revision ?? 0;
	const claim = store.claimExecutionMutationLease(proof.executionId, revision, {
		holder: `body-death-projection:${proof.obligationId}`,
		nowMs: input.nowMs,
		ttlMs: 60000,
	});
	if (!claim.ok) return { projected: false, reason: claim.reason };
	// A throw deliberately keeps the lease until TTL: CommDB may have committed.
	const projected = comm.projectProvenBodyDeath(proof, {
		nowMs: input.nowMs,
		verifyCommitted: (candidate) => {
			const current = store.getExecutionBodyDeathObligation(input.obligationId);
			const verified = current ? projectionProof(store, current) : undefined;
			const owner = store.executionProcessOwners.get(proof.executionId);
			const currentSession = store.getSession(proof.executionId);
			const activationCurrent = proof.activationId
				? store.resolveExecutionBodyActivation(proof.executionId)
						?.activation_id === proof.activationId
				: owner?.activation_id === null &&
					store.resolveExecutionBodyActivation(proof.executionId) ===
						undefined &&
					store.getWorkflowActor(proof.executionId) === undefined;
			return Boolean(
				verified &&
					canonicalSubmissionDigest(verified) ===
						canonicalSubmissionDigest(candidate) &&
					currentSession &&
					currentSession.status === duty.terminalStatus &&
					currentSession.terminal_lifecycle_id === duty.terminalLifecycleId &&
					owner &&
					owner.generation === proof.generation &&
					activationCurrent &&
					owner.owner_token === proof.ownerToken &&
					owner.spawn_epoch === proof.spawnEpoch &&
					owner.binding_digest === proof.bindingDigest &&
					owner.close_requested === 1 &&
					owner.spawn_inflight === 0 &&
					owner.restart_in_progress === 0 &&
					owner.owner_drained_receipt &&
					(store.getWorkflowExecutionProcessBody(proof.executionId)
						?.generation ?? 1) === proof.generation,
			);
		},
	});
	if (
		projected.projected &&
		!store.markExecutionBodyDeathProjected(
			duty,
			new Date(input.nowMs).toISOString(),
		)
	)
		throw new Error("body_death_projection_ack_refused");
	const committed = store.commitExecutionMutationLease(
		proof.executionId,
		claim.claimToken,
		revision,
		input.nowMs,
	);
	if (!committed.ok)
		throw new Error(`body_death_projection_lease:${committed.reason}`);
	return projected;
}

/** On-demand common path. Neither the OS await nor marker reconciliation owns a
 * mutation lease; both ledgers are rechecked immediately before the death CAS. */
export async function convergeExecutionBody(
	deps: ExecutionBodyConvergenceDeps,
	executionId: string,
): Promise<ExecutionBodyConvergenceResult> {
	const initial = deps.comm.getSessionCloseoutIdentity(executionId);
	const initialActivation =
		deps.store.resolveExecutionBodyActivation(executionId);
	const initialRun = initialActivation
		? deps.store.getWorkflowRun(initialActivation.run_id)
		: undefined;
	const initialSession = deps.store.getSession(executionId);
	if (!initialSession || (initialActivation && !initialRun))
		return { kind: "deferred", reason: "body_activation_missing" };
	const initialIssueId = initialRun?.issue_id ?? initialSession.issue_id;
	const initialTurn = deps.comm.getTurn(initialIssueId);
	const observation = await deps.observer.observe(executionId);
	if (!observation || observation.verdict !== "dead")
		return {
			kind: "deferred",
			reason: `body_${observation?.verdict ?? "unknown"}`,
		};
	try {
		if (await deps.completionBlocksDeath(executionId))
			return { kind: "deferred", reason: "completion_marker_pending" };
	} catch {
		return { kind: "deferred", reason: "completion_marker_pending" };
	}
	if (
		deps.comm.getSessionCloseoutIdentity(executionId).revision !==
		initial.revision
	)
		return { kind: "deferred", reason: "comm_identity_changed" };
	const activation = observation.identity.activationId
		? deps.store.getWorkflowActivation(observation.identity.activationId)
		: undefined;
	const run = activation
		? deps.store.getWorkflowRun(activation.run_id)
		: undefined;
	const workflowChanged = initialActivation
		? !run ||
			run.run_id !== initialRun?.run_id ||
			activation?.activation_id !== initialActivation.activation_id
		: observation.identity.activationId !== null ||
			activation !== undefined ||
			deps.store.resolveExecutionBodyActivation(executionId) !== undefined ||
			deps.store.executionProcessOwners.get(executionId)?.activation_id !==
				null ||
			deps.store.getWorkflowActor(executionId) !== undefined;
	if (workflowChanged)
		return { kind: "deferred", reason: "body_activation_changed" };
	const issueId = run?.issue_id ?? deps.store.getSession(executionId)?.issue_id;
	if (!issueId || issueId !== initialIssueId)
		return { kind: "deferred", reason: "body_activation_changed" };
	const turn = deps.comm.getTurn(issueId);
	if (
		turn?.holder_exec_id !== initialTurn?.holder_exec_id ||
		turn?.epoch !== initialTurn?.epoch
	)
		return { kind: "deferred", reason: "turn_changed" };
	const committed = deps.store.convergeProvenDeadExecution({
		observation,
		expectedCommIdentityRevision: initial.revision,
		observedTurnEpoch: turn?.holder_exec_id === executionId ? turn.epoch : null,
		isCurrent: deps.observer.isCurrent,
		markerDir: deps.markerDir,
		nowMs: deps.now(),
	});
	if (!committed.ok) return { kind: "deferred", reason: committed.reason };
	return {
		kind: "committed",
		obligation: committed.obligation,
		projection: projectCommittedExecutionBodyDeath({
			store: deps.store,
			comm: deps.comm,
			obligationId: committed.obligation.obligationId,
			nowMs: deps.now(),
		}),
	};
}
