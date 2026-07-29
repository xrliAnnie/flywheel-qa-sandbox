import { randomUUID } from "node:crypto";
import type { Kernel, ReadTx, WriteTx } from "flywheel-v2-kernel";
import type { CanonicalValue } from "./digests.js";
import { actionLogicalKey, digestJson, sha256 } from "./digests.js";
import { DagConflictError, DagContractError } from "./errors.js";
import { appendEvent, readReceipt, receiptPayload } from "./events.js";
import { appendMailboxTx } from "./mailbox-append.js";
import {
	type Envelope,
	insertEnvelope,
	makeEnvelope,
	readCutoverEpoch,
	readEnvelope,
	updateEnvelope,
} from "./meta.js";
import type { DagPorts } from "./types.js";

export interface IssueReceiptData {
	admission_uid: string;
	notify_agent_id: string;
	ship_worktree_id: string;
	task_ids: string[];
	worktree_ids: string[];
}

export interface ShipGateData {
	gate_id: string;
	state: "open" | "approved" | "rejected" | "expired";
	tip: string;
	dag_digest: string;
	contract_digest: string;
	emitter_task_id: string;
	emitter_agent_id: string;
	target: null | { repo: string; pr: number; head: string };
	actor_agent_id: string | null;
	actor_generation: number | null;
	actor_lineage: ShipActionLineage | null;
	config_digest: string | null;
	capability_id: string | null;
	approval_ref: string | null;
	settled: null | { action_id: string | null; merged_sha: string; at: string };
	retry: {
		reconcile_after_ms: number;
		max_attempts: number;
		base_ms: number;
		cap_ms: number;
		attempt_count: number;
		next_retry_at: string | null;
	};
}

export interface ShipActionLineage {
	task_id: string;
	attempt_id: string;
	attempt_generation: number;
	activation_id: string;
}

export interface UsableShipActor {
	agent_id: string;
	generation: number;
	lineage: ShipActionLineage | null;
}

function issueReceipt(
	tx: ReadTx,
	issueId: string,
	epoch?: number,
): Envelope<IssueReceiptData> {
	const receipt = readEnvelope<IssueReceiptData>(
		tx,
		`dag_issue:${issueId}`,
		epoch,
	);
	if (!receipt) throw new DagContractError(`issue ${issueId} is not admitted`);
	return receipt;
}

export function allMembersDone(tx: ReadTx, taskIds: string[]): boolean {
	if (taskIds.length === 0) return false;
	for (const taskId of taskIds) {
		if (
			tx.get<{ state: string }>("SELECT state FROM tasks WHERE id=@taskId", {
				taskId,
			})?.state !== "done"
		) {
			return false;
		}
	}
	return true;
}

function gateDigests(
	tx: ReadTx,
	taskIds: string[],
): { dagDigest: string; contractDigest: string } {
	const tasks = taskIds
		.map((taskId) => {
			const row = tx.get<{ state: string; payload: string }>(
				"SELECT state,payload FROM tasks WHERE id=@taskId",
				{ taskId },
			);
			if (!row) throw new DagContractError(`task ${taskId} is missing`);
			const incoming = tx
				.all<{ blocked_by_task_id: string }>(
					"SELECT blocked_by_task_id FROM task_dependencies WHERE task_id=@taskId ORDER BY blocked_by_task_id",
					{ taskId },
				)
				.map((item) => item.blocked_by_task_id);
			return {
				task_id: taskId,
				state: row.state,
				incoming,
				payload: row.payload,
			};
		})
		.sort((left, right) => left.task_id.localeCompare(right.task_id));
	return {
		dagDigest: digestJson(
			tasks.map(({ task_id, state, incoming }) => ({
				task_id,
				state,
				incoming,
			})) as unknown as CanonicalValue,
		),
		contractDigest: digestJson(
			tasks.map(({ task_id, payload }) => ({
				task_id,
				payload: JSON.parse(payload) as CanonicalValue,
			})) as unknown as CanonicalValue,
		),
	};
}

function auditGate(
	tx: WriteTx,
	data: ShipGateData,
	revision: number,
	now: string,
): void {
	tx.run(
		`INSERT INTO gates
		 (id,task_id,attempt_generation,kind,subject_digest,state,opened_at,resolved_at)
		 VALUES(@id,@taskId,NULL,'founder_ship_approval',@subjectDigest,@state,
		        @openedAt,@resolvedAt)`,
		{
			id: `${data.gate_id}:${revision}`,
			taskId: data.emitter_task_id,
			subjectDigest: sha256(
				`${data.tip}:${data.dag_digest}:${data.contract_digest}`,
			),
			state: data.state,
			openedAt: now,
			resolvedAt: data.state === "open" ? null : now,
		},
	);
}

export function maybeRefreshShipGateTx(
	tx: WriteTx,
	input: {
		issueId: string;
		emitterTaskId: string;
		emitterAgentId: string;
		now: string;
	},
): Envelope<ShipGateData> | null {
	const epoch = readCutoverEpoch(tx);
	const issue = issueReceipt(tx, input.issueId, epoch);
	if (!allMembersDone(tx, issue.data.task_ids)) return null;
	const span = readEnvelope<{ head: string }>(
		tx,
		`span_tip:${issue.data.ship_worktree_id}`,
		epoch,
	);
	if (!span) throw new DagContractError("ship worktree span is missing");
	const { dagDigest, contractDigest } = gateDigests(tx, issue.data.task_ids);
	const key = `ship_gate:${input.issueId}`;
	const current = readEnvelope<ShipGateData>(tx, key, epoch);
	if (
		current &&
		current.data.state === "open" &&
		current.data.tip === span.data.head &&
		current.data.dag_digest === dagDigest &&
		current.data.contract_digest === contractDigest
	) {
		return current;
	}
	if (current?.data.settled) return current;
	const data: ShipGateData = {
		gate_id: randomUUID(),
		state: "open",
		tip: span.data.head,
		dag_digest: dagDigest,
		contract_digest: contractDigest,
		emitter_task_id: input.emitterTaskId,
		emitter_agent_id: input.emitterAgentId,
		target: null,
		actor_agent_id: null,
		actor_generation: null,
		actor_lineage: null,
		config_digest: null,
		capability_id: null,
		approval_ref: null,
		settled: null,
		retry: {
			reconcile_after_ms: 300_000,
			max_attempts: 6,
			base_ms: 120_000,
			cap_ms: 900_000,
			attempt_count: 0,
			next_retry_at: null,
		},
	};
	const next = current
		? updateEnvelope(tx, key, current, data, input.now)
		: makeEnvelope(epoch, data);
	if (!current) insertEnvelope(tx, key, next, input.now);
	auditGate(tx, data, next.revision, input.now);
	appendEvent(tx, {
		eventUid: `gate_opened:${data.gate_id}`,
		taskId: input.emitterTaskId,
		kind: "gate_opened",
		sourceKind: "ship_gate",
		sourceId: data.gate_id,
		payload: {
			issue_id: input.issueId,
			gate_id: data.gate_id,
			tip: data.tip,
		},
		cutoverEpoch: epoch,
		createdAt: input.now,
	});
	return next;
}

export function usableActor(
	tx: ReadTx,
	agentId: string,
): UsableShipActor | null {
	const agent = tx.get<{
		agent_id: string;
		kind: string;
		generation: number;
	}>("SELECT agent_id,kind,generation FROM agents WHERE agent_id=@agentId", {
		agentId,
	});
	if (!agent) return null;
	if (agent.kind === "runner") {
		const active = tx.get<{
			activation_id: string;
			attempt_id: string;
			attempt_generation: number;
			task_id: string;
		}>(
			`SELECT act.id AS activation_id,
			        act.attempt_id,
			        act.generation AS attempt_generation,
			        attempt.task_id
			   FROM activations act
			   JOIN attempts attempt
			     ON attempt.id=act.attempt_id
			    AND attempt.generation=act.generation
			  JOIN meta binding ON binding.key=@bindingKey
			 WHERE act.id=json_extract(binding.value,'$.data.activation_id')
			   AND act.state='active'
			   AND attempt.desired_state<>'terminal'`,
			{ bindingKey: `agent_binding:${agentId}` },
		);
		if (!active) return null;
		return {
			agent_id: agent.agent_id,
			generation: agent.generation,
			lineage: {
				task_id: active.task_id,
				attempt_id: active.attempt_id,
				attempt_generation: active.attempt_generation,
				activation_id: active.activation_id,
			},
		};
	}
	return {
		agent_id: agent.agent_id,
		generation: agent.generation,
		lineage: null,
	};
}

export function mintCapability(
	tx: WriteTx,
	input: {
		gate: ShipGateData;
		actorId: string;
		cutoverEpoch: number;
		now: string;
	},
): string {
	if (!input.gate.target) throw new DagContractError("ship target is missing");
	const id = randomUUID();
	const logicalEffectId = `github_merge:${input.gate.target.repo}:${input.gate.target.pr}:${input.gate.target.head}`;
	const logicalKey = actionLogicalKey({
		actorAgentId: input.actorId,
		cutoverEpoch: input.cutoverEpoch,
		kind: "github_merge",
		logicalEffectId,
		lineage: input.gate.actor_lineage
			? {
					taskId: input.gate.actor_lineage.task_id,
					attemptId: input.gate.actor_lineage.attempt_id,
					attemptGeneration: input.gate.actor_lineage.attempt_generation,
				}
			: null,
	});
	const subjectDigest = digestJson({
		gate_id: input.gate.gate_id,
		logical_key: logicalKey,
		repo: input.gate.target.repo,
		pr: input.gate.target.pr,
		head: input.gate.target.head,
	});
	tx.run(
		`INSERT INTO capabilities
		 (id,token_hash,issuer,audience,action,task_id,attempt_generation,
		  subject_digest,issued_at)
		 VALUES(@id,@tokenHash,@issuer,@audience,'github_merge',NULL,NULL,
		        @subjectDigest,@issuedAt)`,
		{
			id,
			tokenHash: sha256(`v2dag:${id}:${subjectDigest}`),
			issuer: `ship_gate:${input.gate.gate_id}`,
			audience: input.actorId,
			subjectDigest,
			issuedAt: input.now,
		},
	);
	return id;
}

export interface ShipApprovalResult {
	gateId: string;
	capabilityId: string | null;
}

export function approveShipGate(
	kernel: Kernel,
	ports: DagPorts,
	input: {
		issueId: string;
		approvalRef: string;
		observedTip: string;
		shipTarget: { repo: string; pr: number };
		actorConfig: { defaultActionAgentId: string; configDigest: string };
	},
): ShipApprovalResult {
	return kernel.write("v2dag.gate.approve", (tx) => {
		const epoch = readCutoverEpoch(tx);
		const issue = issueReceipt(tx, input.issueId, epoch);
		const key = `ship_gate:${input.issueId}`;
		const current = readEnvelope<ShipGateData>(tx, key, epoch);
		if (!current) throw new DagContractError("ship gate is missing");
		if (
			current.data.state === "approved" &&
			current.data.approval_ref === input.approvalRef
		) {
			if (
				current.data.target?.repo !== input.shipTarget.repo ||
				current.data.target.pr !== input.shipTarget.pr ||
				current.data.target.head !== input.observedTip ||
				current.data.config_digest !== input.actorConfig.configDigest
			) {
				throw new DagConflictError("ship approval replay conflicts");
			}
			return {
				gateId: current.data.gate_id,
				capabilityId: current.data.capability_id,
			};
		}
		const reopening = current.data.state === "expired";
		if ((current.data.state !== "open" && !reopening) || current.data.settled) {
			throw new DagConflictError("ship gate is not open");
		}
		if (reopening && current.data.approval_ref === input.approvalRef) {
			throw new DagConflictError("ship gate reopen needs fresh authority");
		}
		if (
			!allMembersDone(tx, issue.data.task_ids) ||
			current.data.tip !== input.observedTip
		) {
			throw new DagContractError("ship gate prerequisites changed");
		}
		const worktree = readEnvelope<{ repo_identity: string }>(
			tx,
			`canonical_worktree:${issue.data.ship_worktree_id}`,
			epoch,
		);
		if (worktree?.data.repo_identity !== input.shipTarget.repo) {
			throw new DagContractError("ship target repository is not canonical");
		}
		if (reopening && current.data.target) {
			const unresolved = tx.get<{ count: number }>(
				`SELECT count(*) AS count FROM actions
				  WHERE kind='github_merge'
				    AND json_extract(payload,'$.repo')=@repo
				    AND json_extract(payload,'$.pr')=@pr
				    AND json_extract(payload,'$.head')=@head
				    AND state IN ('intended','succeeded')`,
				{
					repo: current.data.target.repo,
					pr: current.data.target.pr,
					head: current.data.target.head,
				},
			)?.count;
			if ((unresolved ?? 0) !== 0) {
				throw new DagConflictError("ship effect cannot be reopened");
			}
		}
		const emitter = usableActor(tx, current.data.emitter_agent_id);
		const fallback = usableActor(tx, input.actorConfig.defaultActionAgentId);
		const actor = emitter ?? fallback;
		const approved: ShipGateData = {
			...current.data,
			state: "approved",
			target: {
				repo: input.shipTarget.repo,
				pr: input.shipTarget.pr,
				head: current.data.tip,
			},
			actor_agent_id: actor?.agent_id ?? null,
			actor_generation: actor?.generation ?? null,
			actor_lineage: actor?.lineage ?? null,
			config_digest: input.actorConfig.configDigest,
			approval_ref: input.approvalRef,
			retry: reopening
				? {
						...current.data.retry,
						attempt_count: 0,
						next_retry_at: null,
					}
				: current.data.retry,
		};
		if (current.data.capability_id) {
			tx.run(
				`UPDATE capabilities SET revoked_at=@now
				  WHERE id=@capabilityId AND consumed_at IS NULL AND revoked_at IS NULL`,
				{
					capabilityId: current.data.capability_id,
					now: ports.clock.nowIso(),
				},
			);
		}
		if (actor) {
			approved.capability_id = mintCapability(tx, {
				gate: approved,
				actorId: actor.agent_id,
				cutoverEpoch: epoch,
				now: ports.clock.nowIso(),
			});
		}
		const next = updateEnvelope(
			tx,
			key,
			current,
			approved,
			ports.clock.nowIso(),
		);
		auditGate(tx, approved, next.revision, ports.clock.nowIso());
		appendEvent(tx, {
			eventUid: `gate_approved:${input.approvalRef}`,
			taskId: approved.emitter_task_id,
			kind: reopening ? "gate_reopened" : "gate_approved",
			sourceKind: "founder_approval",
			sourceId: input.approvalRef,
			payload: {
				gate_id: approved.gate_id,
				tip: approved.tip,
				capability_id: approved.capability_id,
			},
			cutoverEpoch: epoch,
			createdAt: ports.clock.nowIso(),
		});
		if (actor && approved.target && approved.capability_id) {
			appendMailboxTx(tx, {
				sourceKind: "ship_gate",
				sourceId: `${approved.gate_id}:${next.revision}`,
				toAgent: actor.agent_id,
				kind: "ship_authorized",
				payload: {
					capability_id: approved.capability_id,
					gate_id: approved.gate_id,
					repo: approved.target.repo,
					pr: approved.target.pr,
					head: approved.target.head,
					tip: approved.tip,
				},
				retentionClass: "business",
				cutoverEpoch: epoch,
				createdAt: ports.clock.nowIso(),
			});
		} else {
			const payload = {
				gate_id: approved.gate_id,
				tip: approved.tip,
				config_digest: approved.config_digest,
			};
			appendEvent(tx, {
				eventUid: `ship_action_blocked:${input.approvalRef}`,
				taskId: approved.emitter_task_id,
				kind: "ship_action_blocked",
				sourceKind: "founder_approval",
				sourceId: input.approvalRef,
				payload,
				cutoverEpoch: epoch,
				createdAt: ports.clock.nowIso(),
			});
			appendMailboxTx(tx, {
				sourceKind: "ship_action_blocked",
				sourceId: input.approvalRef,
				toAgent: issue.data.notify_agent_id,
				kind: "ship_action_blocked",
				payload,
				retentionClass: "business",
				cutoverEpoch: epoch,
				createdAt: ports.clock.nowIso(),
			});
		}
		return {
			gateId: approved.gate_id,
			capabilityId: approved.capability_id,
		};
	});
}

export function recoverShipAuthority(
	kernel: Kernel,
	ports: DagPorts,
	input: {
		issueId: string;
		recoveryRef: string;
		actorConfig: { defaultActionAgentId: string; configDigest: string };
	},
): { capabilityId: string; gateId: string } {
	const request: CanonicalValue = {
		issue_id: input.issueId,
		recovery_ref: input.recoveryRef,
		actor_config: {
			default_action_agent_id: input.actorConfig.defaultActionAgentId,
			config_digest: input.actorConfig.configDigest,
		},
	};
	const requestDigest = digestJson(request);
	const eventUid = `ship_authority_recovered:${input.recoveryRef}`;
	return kernel.write("v2dag.gate.recover-authority", (tx) => {
		const replay = readReceipt<{ capabilityId: string; gateId: string }>(
			tx,
			eventUid,
			requestDigest,
		);
		if (replay) return replay;
		const epoch = readCutoverEpoch(tx);
		const issue = issueReceipt(tx, input.issueId, epoch);
		const key = `ship_gate:${input.issueId}`;
		const gate = readEnvelope<ShipGateData>(tx, key, epoch);
		const span = readEnvelope<{ head: string }>(
			tx,
			`span_tip:${issue.data.ship_worktree_id}`,
			epoch,
		);
		if (
			!gate ||
			gate.data.state !== "approved" ||
			gate.data.settled !== null ||
			!gate.data.target ||
			!allMembersDone(tx, issue.data.task_ids) ||
			span?.data.head !== gate.data.tip ||
			gate.data.target.head !== gate.data.tip
		) {
			throw new DagContractError("ship authority cannot be recovered");
		}
		const priorEffect = tx.get<{ count: number }>(
			`SELECT count(*) AS count FROM actions
			  WHERE kind='github_merge'
			    AND json_extract(payload,'$.repo')=@repo
			    AND json_extract(payload,'$.pr')=@pr
			    AND json_extract(payload,'$.head')=@head
			    AND state IN ('intended','succeeded')`,
			{
				repo: gate.data.target.repo,
				pr: gate.data.target.pr,
				head: gate.data.target.head,
			},
		)?.count;
		if ((priorEffect ?? 0) !== 0) {
			throw new DagConflictError("ship effect is already in flight");
		}
		const emitter = usableActor(tx, gate.data.emitter_agent_id);
		const fallback = usableActor(tx, input.actorConfig.defaultActionAgentId);
		const actor = emitter ?? fallback;
		if (!actor) throw new DagContractError("no action actor is available");
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
			config_digest: input.actorConfig.configDigest,
		};
		nextData.capability_id = mintCapability(tx, {
			gate: nextData,
			actorId: actor.agent_id,
			cutoverEpoch: epoch,
			now: ports.clock.nowIso(),
		});
		const next = updateEnvelope(tx, key, gate, nextData, ports.clock.nowIso());
		appendMailboxTx(tx, {
			sourceKind: "ship_authority_recovery",
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
		const result = {
			capabilityId: nextData.capability_id,
			gateId: nextData.gate_id,
		};
		appendEvent(tx, {
			eventUid,
			taskId: nextData.emitter_task_id,
			kind: "ship_authority_recovered",
			sourceKind: "founder_authority",
			sourceId: input.recoveryRef,
			payload: receiptPayload(request, result),
			cutoverEpoch: epoch,
			createdAt: ports.clock.nowIso(),
		});
		return result;
	});
}

export { auditGate as auditShipGateTx, gateDigests, issueReceipt };
