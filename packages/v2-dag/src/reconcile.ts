import {
	type ActionSnapshot,
	type Kernel,
	listActions,
	type ReadTx,
	recordActionOutcome,
	type WriteTx,
} from "flywheel-v2-kernel";
import { actionLogicalKey } from "./digests.js";
import { DagContractError } from "./errors.js";
import { appendEvent } from "./events.js";
import {
	allMembersDone,
	auditShipGateTx,
	issueReceipt,
	mintCapability,
	type ShipGateData,
	usableActor,
} from "./gate.js";
import { appendMailboxTx } from "./mailbox-append.js";
import {
	type Envelope,
	readCutoverEpoch,
	readEnvelope,
	updateEnvelope,
} from "./meta.js";
import { appendLifecycleTx } from "./outbox.js";
import type { DagPorts } from "./types.js";

export interface ReconcileResult {
	examined: number;
	settled: number;
	failed: number;
	uncertain: number;
	rearmed: number;
	authorityRecovered: number;
}

function expireRetryGateTx(
	tx: WriteTx,
	ports: DagPorts,
	input: {
		issueId: string;
		gate: Envelope<ShipGateData>;
		actionId: string;
		cutoverEpoch: number;
	},
): Envelope<ShipGateData> {
	const now = ports.clock.nowIso();
	const next = updateEnvelope(
		tx,
		`ship_gate:${input.issueId}`,
		input.gate,
		{
			...input.gate.data,
			state: "expired",
			retry: { ...input.gate.data.retry, next_retry_at: null },
		},
		now,
	);
	auditShipGateTx(tx, next.data, next.revision, now);
	const payload = {
		action_id: input.actionId,
		gate_id: next.data.gate_id,
		attempt_count: next.data.retry.attempt_count,
	};
	appendEvent(tx, {
		eventUid: `ship_retry_exhausted:${input.actionId}`,
		taskId: next.data.emitter_task_id,
		kind: "ship_retry_exhausted",
		sourceKind: "reconciler",
		sourceId: input.actionId,
		payload,
		cutoverEpoch: input.cutoverEpoch,
		createdAt: now,
	});
	appendMailboxTx(tx, {
		sourceKind: "ship_retry_exhausted",
		sourceId: input.actionId,
		toAgent: issueReceipt(tx, input.issueId, input.cutoverEpoch).data
			.notify_agent_id,
		kind: "ship_retry_exhausted",
		payload,
		retentionClass: "business",
		cutoverEpoch: input.cutoverEpoch,
		createdAt: now,
	});
	return next;
}

function gateForAction(
	tx: ReadTx,
	action: ActionSnapshot,
): { issueId: string; gate: Envelope<ShipGateData> } | null {
	const payload = action.payload as {
		repo?: string;
		pr?: number;
		head?: string;
	};
	const rows = tx.all<{ key: string }>(
		"SELECT key FROM meta WHERE key LIKE 'ship_gate:%' ORDER BY key",
	);
	for (const row of rows) {
		const gate = readEnvelope<ShipGateData>(tx, row.key);
		if (
			gate?.data.target &&
			gate.data.target.repo === payload.repo &&
			gate.data.target.pr === payload.pr &&
			gate.data.target.head === payload.head &&
			gate.data.actor_agent_id === action.actor.agentId
		) {
			return { issueId: row.key.slice("ship_gate:".length), gate };
		}
	}
	return null;
}

export async function reconcileShipActions(
	kernel: Kernel,
	ports: DagPorts,
): Promise<ReconcileResult> {
	if (!ports.githubObservation) {
		throw new DagContractError("observation port is unavailable");
	}
	const intended = kernel.read((tx) =>
		listActions(tx, { state: "intended", limit: 100 }).filter(
			(action) => action.kind === "github_merge",
		),
	);
	const result: ReconcileResult = {
		examined: intended.length,
		settled: 0,
		failed: 0,
		uncertain: 0,
		rearmed: 0,
		authorityRecovered: 0,
	};
	for (const action of intended) {
		const payload = action.payload as {
			repo: string;
			pr: number;
			head: string;
		};
		const observed = await ports.githubObservation.readMergeState({
			repo: payload.repo,
			pr: payload.pr,
			head: payload.head,
		});
		if (observed.state === "unknown" || observed.state === "open") {
			result.uncertain += 1;
			continue;
		}
		kernel.write("v2dag.ship.reconcile", (tx) => {
			const epoch = readCutoverEpoch(tx);
			const match = gateForAction(tx, action);
			if (!match?.gate || match.gate.data.settled !== null) return;
			// FLY-1543 ⑤: actor currency by discriminator. A runner actor is only
			// current while its session's activation is active; a pre-cutover
			// role-name runner actor is never current (its outcome is recorded as
			// unsettleable, exactly like a superseded generation).
			const actorCurrent = (() => {
				if (action.actor.kind === "runner") {
					if (!action.actor.agentId.startsWith("v2dag:")) return false;
					const activation = tx.get<{ generation: number }>(
						`SELECT generation FROM activations
						  WHERE session_ref=@sessionRef AND state='active'`,
						{ sessionRef: action.actor.agentId },
					);
					return activation?.generation === action.actor.generation;
				}
				const lead = tx.get<{ kind: string; generation: number }>(
					"SELECT kind,generation FROM agents WHERE agent_id=@agentId",
					{ agentId: action.actor.agentId },
				);
				return (
					lead?.kind === "lead" && lead.generation === action.actor.generation
				);
			})();
			if (observed.state === "merged") {
				if (actorCurrent) {
					recordActionOutcome(tx, {
						id: action.id,
						actor: action.actor,
						state: "succeeded",
						result: {
							merged_sha: observed.head,
							reconciled: true,
						},
						completedAt: ports.clock.nowIso(),
					});
				} else {
					appendEvent(tx, {
						eventUid: `action_unsettleable_generation:${action.id}`,
						taskId: match.gate.data.emitter_task_id,
						kind: "action_unsettleable_generation",
						sourceKind: "reconciler",
						sourceId: action.id,
						payload: {
							action_id: action.id,
							world_state: "merged",
							merged_sha: observed.head,
						},
						cutoverEpoch: epoch,
						createdAt: ports.clock.nowIso(),
					});
				}
				updateEnvelope(
					tx,
					`ship_gate:${match.issueId}`,
					match.gate,
					{
						...match.gate.data,
						settled: {
							action_id: actorCurrent ? action.id : null,
							merged_sha: observed.head,
							at: ports.clock.nowIso(),
						},
					},
					ports.clock.nowIso(),
				);
				appendEvent(tx, {
					eventUid: `ship_completed:${action.id}`,
					taskId: match.gate.data.emitter_task_id,
					kind: "ship_completed",
					sourceKind: "reconciler",
					sourceId: action.id,
					payload: {
						action_id: action.id,
						merged_sha: observed.head,
						gate_id: match.gate.data.gate_id,
					},
					cutoverEpoch: epoch,
					createdAt: ports.clock.nowIso(),
				});
				// FLY-1544 ③: same gate-keyed outbox row as the direct ship path, so
				// whichever settle path runs first wins and the other dedups.
				appendLifecycleTx(tx, {
					sourceKind: "dag_issue_merged",
					sourceId: match.gate.data.gate_id,
					kind: "issue_merged",
					issueId: match.issueId,
					payload: { merged_sha: observed.head },
					cutoverEpoch: epoch,
					createdAt: ports.clock.nowIso(),
				});
				result.settled += 1;
				return;
			}
			if (actorCurrent) {
				recordActionOutcome(tx, {
					id: action.id,
					actor: action.actor,
					state: "failed",
					result: {
						evidence_ref: observed.evidenceRef,
						reconciled: true,
					},
					completedAt: ports.clock.nowIso(),
				});
			} else {
				appendEvent(tx, {
					eventUid: `action_unsettleable_generation:${action.id}`,
					taskId: match.gate.data.emitter_task_id,
					kind: "action_unsettleable_generation",
					sourceKind: "reconciler",
					sourceId: action.id,
					payload: {
						action_id: action.id,
						world_state: "rejected",
						evidence_ref: observed.evidenceRef,
					},
					cutoverEpoch: epoch,
					createdAt: ports.clock.nowIso(),
				});
			}
			if (
				match.gate.data.retry.attempt_count >=
				match.gate.data.retry.max_attempts
			) {
				expireRetryGateTx(tx, ports, {
					issueId: match.issueId,
					gate: match.gate,
					actionId: action.id,
					cutoverEpoch: epoch,
				});
			} else {
				const delay = Math.min(
					match.gate.data.retry.base_ms *
						2 ** Math.max(0, match.gate.data.retry.attempt_count - 1),
					match.gate.data.retry.cap_ms,
				);
				updateEnvelope(
					tx,
					`ship_gate:${match.issueId}`,
					match.gate,
					{
						...match.gate.data,
						retry: {
							...match.gate.data.retry,
							next_retry_at: new Date(
								ports.clock.nowMs() + delay,
							).toISOString(),
						},
					},
					ports.clock.nowIso(),
				);
			}
			result.failed += 1;
		});
	}
	const due = kernel.read((tx) =>
		tx
			.all<{ key: string }>(
				"SELECT key FROM meta WHERE key LIKE 'ship_gate:%' ORDER BY key",
			)
			.filter((row) => {
				const gate = readEnvelope<ShipGateData>(tx, row.key);
				return (
					gate?.data.state === "approved" &&
					gate.data.settled === null &&
					gate.data.retry.next_retry_at !== null &&
					Date.parse(gate.data.retry.next_retry_at) <= ports.clock.nowMs()
				);
			}),
	);
	for (const row of due) {
		const rearmed = kernel.write("v2dag.ship.retry-rearm", (tx) => {
			const epoch = readCutoverEpoch(tx);
			const gate = readEnvelope<ShipGateData>(tx, row.key, epoch);
			if (
				!gate ||
				gate.data.state !== "approved" ||
				gate.data.settled !== null ||
				gate.data.retry.next_retry_at === null ||
				Date.parse(gate.data.retry.next_retry_at) > ports.clock.nowMs()
			) {
				return false;
			}
			if (gate.data.retry.attempt_count >= gate.data.retry.max_attempts) {
				const issueId = row.key.slice("ship_gate:".length);
				expireRetryGateTx(tx, ports, {
					issueId,
					gate,
					actionId: `${gate.data.gate_id}:${gate.revision}`,
					cutoverEpoch: epoch,
				});
				return false;
			}
			const issueId = row.key.slice("ship_gate:".length);
			const issue = issueReceipt(tx, issueId, epoch);
			const span = readEnvelope<{ head: string }>(
				tx,
				`span_tip:${issue.data.ship_worktree_id}`,
				epoch,
			);
			if (
				!gate.data.target ||
				!allMembersDone(tx, issue.data.task_ids) ||
				span?.data.head !== gate.data.tip ||
				gate.data.target.head !== gate.data.tip
			) {
				expireRetryGateTx(tx, ports, {
					issueId,
					gate,
					actionId: `${gate.data.gate_id}:${gate.revision}`,
					cutoverEpoch: epoch,
				});
				return false;
			}
			const actorId = gate.data.actor_agent_id;
			const actor = actorId ? usableActor(tx, actorId) : null;
			if (!actor) return false;
			const logicalKey = actionLogicalKey({
				actorAgentId: actor.agent_id,
				cutoverEpoch: epoch,
				kind: "github_merge",
				logicalEffectId: `github_merge:${gate.data.target.repo}:${gate.data.target.pr}:${gate.data.target.head}`,
				lineage: gate.data.actor_lineage
					? {
							taskId: gate.data.actor_lineage.task_id,
							attemptId: gate.data.actor_lineage.attempt_id,
							attemptGeneration: gate.data.actor_lineage.attempt_generation,
						}
					: null,
			});
			const tail = listActions(tx, {
				logicalKey,
				limit: 1,
			})[0];
			const definitiveStaleRejection =
				tail?.state === "intended" &&
				tx.get(
					`SELECT 1 FROM events
					  WHERE kind='action_unsettleable_generation'
					    AND json_extract(payload,'$.action_id')=@actionId
					    AND json_extract(payload,'$.world_state')='rejected'
					  LIMIT 1`,
					{ actionId: tail.id },
				) !== undefined;
			if (!tail || (tail.state !== "failed" && !definitiveStaleRejection)) {
				return false;
			}
			if (gate.data.capability_id) {
				tx.run(
					`UPDATE capabilities SET revoked_at=@now
					  WHERE id=@capabilityId AND consumed_at IS NULL AND revoked_at IS NULL`,
					{
						capabilityId: gate.data.capability_id,
						now: ports.clock.nowIso(),
					},
				);
			}
			const nextData: ShipGateData = {
				...gate.data,
				actor_agent_id: actor.agent_id,
				actor_generation: actor.generation,
				actor_lineage: actor.lineage,
				retry: { ...gate.data.retry, next_retry_at: null },
			};
			nextData.capability_id = mintCapability(tx, {
				gate: nextData,
				actorId: actor.agent_id,
				cutoverEpoch: epoch,
				now: ports.clock.nowIso(),
			});
			const next = updateEnvelope(
				tx,
				row.key,
				gate,
				nextData,
				ports.clock.nowIso(),
			);
			appendMailboxTx(tx, {
				sourceKind: "ship_retry",
				sourceId: `${nextData.gate_id}:${next.revision}`,
				toAgent: actor.agent_id,
				kind: "ship_authorized",
				payload: {
					capability_id: nextData.capability_id,
					gate_id: nextData.gate_id,
					repo: nextData.target?.repo as string,
					pr: nextData.target?.pr as number,
					head: nextData.target?.head as string,
					tip: nextData.tip,
				},
				retentionClass: "business",
				cutoverEpoch: epoch,
				createdAt: ports.clock.nowIso(),
			});
			appendEvent(tx, {
				eventUid: `ship_retry_rearmed:${nextData.gate_id}:${next.revision}`,
				taskId: nextData.emitter_task_id,
				kind: "ship_retry_rearmed",
				sourceKind: "reconciler",
				sourceId: tail.id,
				payload: {
					action_id: tail.id,
					capability_id: nextData.capability_id,
				},
				cutoverEpoch: epoch,
				createdAt: ports.clock.nowIso(),
			});
			return true;
		});
		if (rearmed) result.rearmed += 1;
	}
	const staleAuthorities = kernel.read((tx) =>
		tx
			.all<{ key: string }>(
				"SELECT key FROM meta WHERE key LIKE 'ship_gate:%' ORDER BY key",
			)
			.filter((row) => {
				const gate = readEnvelope<ShipGateData>(tx, row.key);
				if (
					gate?.data.state !== "approved" ||
					gate.data.settled !== null ||
					!gate.data.target ||
					!gate.data.actor_agent_id ||
					gate.data.actor_generation === null ||
					!gate.data.capability_id
				) {
					return false;
				}
				const actor = usableActor(tx, gate.data.actor_agent_id);
				return actor !== null && actor.generation > gate.data.actor_generation;
			}),
	);
	for (const row of staleAuthorities) {
		const recovered = kernel.write(
			"v2dag.ship.same-actor-authority-recovery",
			(tx) => {
				const epoch = readCutoverEpoch(tx);
				const gate = readEnvelope<ShipGateData>(tx, row.key, epoch);
				if (
					!gate ||
					gate.data.state !== "approved" ||
					gate.data.settled !== null ||
					!gate.data.target ||
					!gate.data.actor_agent_id ||
					gate.data.actor_generation === null ||
					!gate.data.capability_id
				) {
					return false;
				}
				const target = gate.data.target;
				const actor = usableActor(tx, gate.data.actor_agent_id);
				if (!actor || actor.generation <= gate.data.actor_generation) {
					return false;
				}
				const oldCapability = tx.get<{
					consumed_at: string | null;
					revoked_at: string | null;
				}>(
					"SELECT consumed_at,revoked_at FROM capabilities WHERE id=@capabilityId",
					{ capabilityId: gate.data.capability_id },
				);
				if (
					!oldCapability ||
					oldCapability.consumed_at !== null ||
					oldCapability.revoked_at !== null
				) {
					return false;
				}
				const issueId = row.key.slice("ship_gate:".length);
				const issue = issueReceipt(tx, issueId, epoch);
				const span = readEnvelope<{ head: string }>(
					tx,
					`span_tip:${issue.data.ship_worktree_id}`,
					epoch,
				);
				if (
					!allMembersDone(tx, issue.data.task_ids) ||
					span?.data.head !== gate.data.tip ||
					target.head !== gate.data.tip
				) {
					return false;
				}
				const actions = tx.get<{ count: number }>(
					`SELECT count(*) AS count FROM actions
					  WHERE kind='github_merge'
					    AND json_extract(payload,'$.repo')=@repo
					    AND json_extract(payload,'$.pr')=@pr
					    AND json_extract(payload,'$.head')=@head`,
					{
						repo: target.repo,
						pr: target.pr,
						head: target.head,
					},
				)?.count;
				if ((actions ?? 0) !== 0) return false;
				tx.run(
					"UPDATE capabilities SET revoked_at=@now WHERE id=@capabilityId AND consumed_at IS NULL AND revoked_at IS NULL",
					{
						now: ports.clock.nowIso(),
						capabilityId: gate.data.capability_id,
					},
				);
				const nextData: ShipGateData = {
					...gate.data,
					actor_generation: actor.generation,
					actor_lineage: actor.lineage,
				};
				nextData.capability_id = mintCapability(tx, {
					gate: nextData,
					actorId: actor.agent_id,
					cutoverEpoch: epoch,
					now: ports.clock.nowIso(),
				});
				const next = updateEnvelope(
					tx,
					row.key,
					gate,
					nextData,
					ports.clock.nowIso(),
				);
				appendMailboxTx(tx, {
					sourceKind: "ship_actor_recovery",
					sourceId: `${nextData.gate_id}:${next.revision}`,
					toAgent: actor.agent_id,
					kind: "ship_authorized",
					payload: {
						capability_id: nextData.capability_id,
						gate_id: nextData.gate_id,
						repo: target.repo,
						pr: target.pr,
						head: target.head,
						tip: nextData.tip,
					},
					retentionClass: "business",
					cutoverEpoch: epoch,
					createdAt: ports.clock.nowIso(),
				});
				appendEvent(tx, {
					eventUid: `ship_actor_authority_recovered:${nextData.gate_id}:${next.revision}`,
					taskId: nextData.emitter_task_id,
					kind: "ship_actor_authority_recovered",
					sourceKind: "reconciler",
					sourceId: actor.agent_id,
					payload: {
						actor_generation: actor.generation,
						capability_id: nextData.capability_id,
					},
					cutoverEpoch: epoch,
					createdAt: ports.clock.nowIso(),
				});
				return true;
			},
		);
		if (recovered) result.authorityRecovered += 1;
	}
	return result;
}
