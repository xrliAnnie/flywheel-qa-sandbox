import { randomUUID } from "node:crypto";
import type { RegisteredAgent } from "flywheel-v2-engine";
import {
	type ActionActor,
	FENCE,
	type Kernel,
	listActions,
	recordActionIntent,
	recordActionOutcome,
	recordExternalEffectIntentTx,
} from "flywheel-v2-kernel";
import { actionLogicalKey, digestJson } from "./digests.js";
import { DagContractError } from "./errors.js";
import { appendEvent } from "./events.js";
import {
	allMembersDone,
	auditShipGateTx,
	type IssueReceiptData,
	issueReceipt,
	type ShipGateData,
} from "./gate.js";
import { appendMailboxTx } from "./mailbox-append.js";
import { readCutoverEpoch, readEnvelope, updateEnvelope } from "./meta.js";
import type { DagPorts } from "./types.js";

export interface ExecuteShipInput {
	issueId: string;
	capabilityId: string;
	actor: RegisteredAgent;
}

export type ExecuteShipResult =
	| { status: "succeeded"; actionId: string; mergedSha: string }
	| { status: "failed"; actionId: string; error: string };

function actionActor(actor: RegisteredAgent): ActionActor {
	return actor.kind === "runner"
		? {
				kind: "runner",
				agentId: actor.agentId,
				instanceId: actor.instanceId,
				generation: actor.generation,
				activationId: actor.activationId,
			}
		: {
				kind: "lead",
				agentId: actor.agentId,
				instanceId: actor.instanceId,
				generation: actor.generation,
			};
}

export async function executeShip(
	kernel: Kernel,
	ports: DagPorts,
	input: ExecuteShipInput,
): Promise<ExecuteShipResult> {
	if (!ports.githubObservation || !ports.githubMerge) {
		throw new DagContractError("ship ports are unavailable");
	}
	const snapshot = kernel.read((tx) => {
		const issue = readEnvelope<IssueReceiptData>(
			tx,
			`dag_issue:${input.issueId}`,
		);
		const gate = readEnvelope<ShipGateData>(tx, `ship_gate:${input.issueId}`);
		if (!issue || !gate || !gate.data.target) {
			throw new DagContractError("ship authority is incomplete");
		}
		return { issue, gate, target: gate.data.target };
	});
	const observedHead = await ports.githubObservation.readPrHead({
		repo: snapshot.target.repo,
		pr: snapshot.target.pr,
	});
	const actionId = randomUUID();
	const actor = actionActor(input.actor);
	const intended = kernel.write("v2dag.ship.intent", (tx) => {
		const epoch = readCutoverEpoch(tx);
		const issue = readEnvelope<IssueReceiptData>(
			tx,
			`dag_issue:${input.issueId}`,
			epoch,
		);
		const gate = readEnvelope<ShipGateData>(
			tx,
			`ship_gate:${input.issueId}`,
			epoch,
		);
		if (!issue || !gate || !gate.data.target) {
			throw new DagContractError("ship authority disappeared");
		}
		const target = gate.data.target;
		const span = readEnvelope<{ head: string }>(
			tx,
			`span_tip:${issue.data.ship_worktree_id}`,
			epoch,
		);
		if (
			gate.data.state !== "approved" ||
			gate.data.settled !== null ||
			gate.data.tip !== span?.data.head ||
			gate.data.target.head !== gate.data.tip
		) {
			throw new DagContractError("founder authority is not current");
		}
		if (!allMembersDone(tx, issue.data.task_ids)) {
			throw new DagContractError("DAG is not terminal-successful");
		}
		if (observedHead !== gate.data.tip) {
			throw new DagContractError("world head drifted");
		}
		// FLY-1543 ⑤: actor currency follows the discriminator -- a runner actor
		// is a session (activations row), a lead actor is an agents row.
		const actorCurrent = (() => {
			if (input.actor.kind === "runner") {
				if (!input.actor.agentId.startsWith("v2dag:")) return false;
				const activation = tx.get<{ generation: number }>(
					`SELECT generation FROM activations
					  WHERE session_ref=@sessionRef AND state='active'`,
					{ sessionRef: input.actor.agentId },
				);
				return activation?.generation === input.actor.generation;
			}
			const lead = tx.get<{ kind: string; generation: number }>(
				"SELECT kind,generation FROM agents WHERE agent_id=@agentId",
				{ agentId: input.actor.agentId },
			);
			return (
				lead?.kind === "lead" && lead.generation === input.actor.generation
			);
		})();
		if (
			!actorCurrent ||
			gate.data.actor_agent_id !== input.actor.agentId ||
			gate.data.actor_generation !== input.actor.generation ||
			gate.data.capability_id !== input.capabilityId
		) {
			throw new DagContractError("action actor is not authorized");
		}
		const lineage = gate.data.actor_lineage;
		if (input.actor.kind === "runner") {
			if (!lineage || lineage.activation_id !== input.actor.activationId) {
				throw new DagContractError("runner action lineage is not authorized");
			}
			const activeLineage = tx.get<{
				task_id: string;
				attempt_id: string;
				attempt_generation: number;
			}>(
				`SELECT attempt.task_id,
				        act.attempt_id,
				        act.generation AS attempt_generation
				   FROM activations act
				   JOIN attempts attempt
				     ON attempt.id=act.attempt_id
				    AND attempt.generation=act.generation
				  WHERE act.id=@activationId
				    AND act.state='active'
				    AND attempt.desired_state<>'terminal'`,
				{ activationId: input.actor.activationId },
			);
			if (
				!activeLineage ||
				activeLineage.task_id !== lineage.task_id ||
				activeLineage.attempt_id !== lineage.attempt_id ||
				activeLineage.attempt_generation !== lineage.attempt_generation
			) {
				throw new DagContractError("runner action lineage is stale");
			}
		} else if (lineage !== null) {
			throw new DagContractError("lead action cannot carry runner lineage");
		}
		const logicalEffectId = `github_merge:${gate.data.target.repo}:${gate.data.target.pr}:${gate.data.target.head}`;
		const logicalKey = actionLogicalKey({
			actorAgentId: input.actor.agentId,
			cutoverEpoch: epoch,
			kind: "github_merge",
			logicalEffectId,
			lineage: lineage
				? {
						taskId: lineage.task_id,
						attemptId: lineage.attempt_id,
						attemptGeneration: lineage.attempt_generation,
					}
				: null,
		});
		const subjectDigest = digestJson({
			gate_id: gate.data.gate_id,
			logical_key: logicalKey,
			repo: gate.data.target.repo,
			pr: gate.data.target.pr,
			head: gate.data.target.head,
		});
		const capability = tx.get<{
			issuer: string;
			audience: string;
			subject_digest: string | null;
		}>(
			`SELECT issuer,audience,subject_digest FROM capabilities
			  WHERE id=@capabilityId`,
			{ capabilityId: input.capabilityId },
		);
		if (
			!capability ||
			capability.issuer !== `ship_gate:${gate.data.gate_id}` ||
			capability.audience !== input.actor.agentId ||
			capability.subject_digest !== subjectDigest
		) {
			throw new DagContractError("capability binding is invalid");
		}
		tx.cas(FENCE.capabilityConsume, {
			now: ports.clock.nowIso(),
			capabilityId: input.capabilityId,
			action: "github_merge",
			audience: input.actor.agentId,
			taskId: null,
			attemptGeneration: null,
		});
		const prior = listActions(tx, { logicalKey, limit: 1 })[0];
		if (prior?.state === "succeeded") {
			throw new DagContractError("ship effect is already successful");
		}
		const recorded = recordActionIntent(
			tx,
			{
				id: actionId,
				...(lineage
					? {
							taskId: lineage.task_id,
							attemptId: lineage.attempt_id,
							attemptGeneration: lineage.attempt_generation,
						}
					: {}),
				actor,
				kind: "github_merge",
				payload: {
					repo: gate.data.target.repo,
					pr: gate.data.target.pr,
					head: gate.data.target.head,
					tip: gate.data.tip,
				},
				logicalEffectId,
				invocationUid: input.capabilityId,
				...(prior
					? {
							supersedesActionId: prior.id,
							retryBasis: {
								evidenceRef: `gate:${gate.data.gate_id}:${gate.revision}`,
								reason: "authorized effect recovery",
							},
						}
					: {}),
				cutoverEpoch: epoch,
				createdAt: ports.clock.nowIso(),
			},
			{
				prepare: (writeTx) => {
					recordExternalEffectIntentTx(writeTx, {
						effectKey: `github:${target.repo}:${target.pr}:${input.capabilityId}`,
						family: "github",
						nowIso: ports.clock.nowIso(),
					});
				},
			},
		);
		updateEnvelope(
			tx,
			`ship_gate:${input.issueId}`,
			gate,
			{
				...gate.data,
				retry: {
					...gate.data.retry,
					attempt_count: gate.data.retry.attempt_count + 1,
					next_retry_at: null,
				},
			},
			ports.clock.nowIso(),
		);
		return {
			action: recorded.action,
			target: gate.data.target,
		};
	});
	let merged: { mergedSha: string };
	try {
		merged = await ports.githubMerge.merge(
			intended.target.repo,
			intended.target.pr,
			intended.target.head,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		kernel.write("v2dag.ship.outcome.failure", (tx) => {
			const epoch = readCutoverEpoch(tx);
			recordActionOutcome(tx, {
				id: intended.action.id,
				actor,
				state: "failed",
				result: { error: message },
				completedAt: ports.clock.nowIso(),
			});
			const gate = readEnvelope<ShipGateData>(
				tx,
				`ship_gate:${input.issueId}`,
				epoch,
			);
			if (!gate) throw new DagContractError("ship gate is missing");
			const exhausted =
				gate.data.retry.attempt_count >= gate.data.retry.max_attempts;
			const delay = Math.min(
				gate.data.retry.base_ms *
					2 ** Math.max(0, gate.data.retry.attempt_count - 1),
				gate.data.retry.cap_ms,
			);
			const next = updateEnvelope(
				tx,
				`ship_gate:${input.issueId}`,
				gate,
				{
					...gate.data,
					state: exhausted ? "expired" : gate.data.state,
					retry: {
						...gate.data.retry,
						next_retry_at: exhausted
							? null
							: new Date(ports.clock.nowMs() + delay).toISOString(),
					},
				},
				ports.clock.nowIso(),
			);
			if (exhausted) {
				auditShipGateTx(tx, next.data, next.revision, ports.clock.nowIso());
				appendEvent(tx, {
					eventUid: `ship_retry_exhausted:${intended.action.id}`,
					taskId: next.data.emitter_task_id,
					kind: "ship_retry_exhausted",
					sourceKind: "action",
					sourceId: intended.action.id,
					payload: {
						action_id: intended.action.id,
						gate_id: next.data.gate_id,
						attempt_count: next.data.retry.attempt_count,
					},
					cutoverEpoch: epoch,
					createdAt: ports.clock.nowIso(),
				});
				appendMailboxTx(tx, {
					sourceKind: "ship_retry_exhausted",
					sourceId: intended.action.id,
					toAgent: issueReceipt(tx, input.issueId, epoch).data.notify_agent_id,
					kind: "ship_retry_exhausted",
					payload: {
						action_id: intended.action.id,
						gate_id: next.data.gate_id,
						attempt_count: next.data.retry.attempt_count,
					},
					retentionClass: "business",
					cutoverEpoch: epoch,
					createdAt: ports.clock.nowIso(),
				});
			}
		});
		return { status: "failed", actionId: intended.action.id, error: message };
	}
	ports.faults?.hit("ship_after_merge");
	kernel.write("v2dag.ship.outcome.success", (tx) => {
		const epoch = readCutoverEpoch(tx);
		recordActionOutcome(tx, {
			id: intended.action.id,
			actor,
			state: "succeeded",
			result: { merged_sha: merged.mergedSha },
			completedAt: ports.clock.nowIso(),
		});
		const gate = readEnvelope<ShipGateData>(
			tx,
			`ship_gate:${input.issueId}`,
			epoch,
		);
		if (!gate || gate.data.settled !== null) {
			throw new DagContractError("ship gate cannot settle");
		}
		updateEnvelope(
			tx,
			`ship_gate:${input.issueId}`,
			gate,
			{
				...gate.data,
				settled: {
					action_id: intended.action.id,
					merged_sha: merged.mergedSha,
					at: ports.clock.nowIso(),
				},
			},
			ports.clock.nowIso(),
		);
		appendEvent(tx, {
			eventUid: `ship_completed:${intended.action.id}`,
			taskId: gate.data.emitter_task_id,
			kind: "ship_completed",
			sourceKind: "action",
			sourceId: intended.action.id,
			payload: {
				action_id: intended.action.id,
				merged_sha: merged.mergedSha,
				gate_id: gate.data.gate_id,
			},
			cutoverEpoch: epoch,
			createdAt: ports.clock.nowIso(),
		});
	});
	return {
		status: "succeeded",
		actionId: intended.action.id,
		mergedSha: merged.mergedSha,
	};
}
