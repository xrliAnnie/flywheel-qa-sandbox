import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	FENCE,
	FenceViolation,
	type Kernel,
	type WriteTx,
} from "flywheel-v2-kernel";
import { ENGINE_SQL } from "./sql.js";
import {
	readCutoverEpochTx,
	requireAttemptBindingTx,
	requireCurrentAgentTx,
	settleFailureMailboxTx,
} from "./transitions.js";
import {
	type AttemptHandle,
	type ConversionProposal,
	type Effect,
	type EngineRuntime,
	MAX_EFFECTS_PER_PROPOSAL,
	MAX_FIELD_BYTES,
	MAX_PROPOSAL_TOTAL_BYTES,
	type ProposalAuthorization,
} from "./types.js";

interface PreparedEffect {
	effect: Effect;
	id: string;
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

export function canonicalProposalDigest(proposal: ConversionProposal): string {
	return createHash("sha256")
		.update(
			canonicalJson({
				v: 1,
				attempt_uid: proposal.handle.attemptUid,
				message_uid: proposal.handle.messageUid,
				agent: proposal.handle.agent,
				effects: proposal.effects,
			}),
		)
		.digest("hex");
}

export function proposalSubjectDigest(handle: AttemptHandle): string {
	return createHash("sha256")
		.update(
			canonicalJson({
				v: 1,
				attempt_uid: handle.attemptUid,
				message_uid: handle.messageUid,
				agent_id: handle.agent.agentId,
				instance_id: handle.agent.instanceId,
				generation: handle.agent.generation,
				activation_id:
					handle.agent.kind === "runner" ? handle.agent.activationId : null,
			}),
		)
		.digest("hex");
}

interface DeliveryActionRow {
	id: string;
	state: string;
	actor_kind: string;
	actor_agent_id: string;
	actor_instance_id: string;
	actor_generation: number;
	activation_id: string | null;
	attempt_id: string | null;
}

export function issueProposalCapability(
	kernel: Kernel,
	runtime: EngineRuntime,
	handle: AttemptHandle,
	issuer: string,
): ProposalAuthorization {
	requireField(issuer, "issuer");
	const token = randomBytes(32).toString("base64url");
	const capabilityId = randomUUID();
	const tokenHash = createHash("sha256").update(token).digest("hex");
	kernel.write("consume.issue-proposal-capability", (tx) => {
		requireCurrentAgentTx(tx, handle.agent);
		requireAttemptBindingTx(tx, handle);
		const action = tx.get<DeliveryActionRow>(
			`SELECT id,state,actor_kind,actor_agent_id,actor_instance_id,
			        actor_generation,activation_id,attempt_id
			 FROM actions WHERE id=@issuer`,
			{ issuer },
		);
		const activationId =
			handle.agent.kind === "runner" ? handle.agent.activationId : null;
		if (
			!action ||
			action.state !== "intended" ||
			action.actor_kind !== handle.agent.kind ||
			action.actor_agent_id !== handle.agent.agentId ||
			action.actor_instance_id !== handle.agent.instanceId ||
			action.actor_generation !== handle.agent.generation ||
			action.activation_id !== activationId
		) {
			throw new FenceViolation(
				`delivery action ${issuer} does not authorize ${handle.attemptUid}`,
			);
		}
		tx.run(
			`INSERT INTO capabilities
			 (id,token_hash,issuer,audience,action,attempt_generation,
			  subject_digest,issued_at)
			 VALUES (@id,@tokenHash,@issuer,@audience,'submit_proposal',
			  @attemptGeneration,@subjectDigest,@issuedAt)`,
			{
				id: capabilityId,
				tokenHash,
				issuer,
				audience: handle.agent.agentId,
				attemptGeneration: handle.agent.generation,
				subjectDigest: proposalSubjectDigest(handle),
				issuedAt: runtime.clock.nowIso(),
			},
		);
	});
	return { capabilityId, token };
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function requireField(value: string, name: string): void {
	if (value.length === 0 || byteLength(value) > MAX_FIELD_BYTES) {
		throw new TypeError(
			`${name} must be non-empty and at most ${MAX_FIELD_BYTES} UTF-8 bytes`,
		);
	}
}

function validateProposal(proposal: ConversionProposal): PreparedEffect[] {
	requireField(proposal.handle.attemptUid, "attemptUid");
	requireField(proposal.handle.messageUid, "messageUid");
	if (proposal.effects.length > MAX_EFFECTS_PER_PROPOSAL) {
		throw new TypeError(
			`effects must contain at most ${MAX_EFFECTS_PER_PROPOSAL}`,
		);
	}
	if (byteLength(JSON.stringify(proposal)) > MAX_PROPOSAL_TOTAL_BYTES) {
		throw new TypeError(
			`proposal must be at most ${MAX_PROPOSAL_TOTAL_BYTES} UTF-8 bytes`,
		);
	}
	return proposal.effects.map((effect) => {
		if (effect.kind === "task") {
			requireField(effect.taskKind, "taskKind");
			requireField(effect.projectId, "projectId");
			if (effect.lineageRootTaskId !== undefined) {
				requireField(effect.lineageRootTaskId, "lineageRootTaskId");
			}
			return { effect, id: randomUUID() };
		}
		requireField(effect.eventKind, "eventKind");
		return { effect, id: randomUUID() };
	});
}

function writeEffect(
	tx: WriteTx,
	runtime: EngineRuntime,
	proposal: ConversionProposal,
	prepared: PreparedEffect,
	cutoverEpoch: number,
): void {
	const { effect, id } = prepared;
	const createdAt = runtime.clock.nowIso();
	if (effect.kind === "task") {
		tx.run(ENGINE_SQL.insertTask, {
			id,
			projectId: effect.projectId,
			kind: effect.taskKind,
			state: effect.state,
			payload: effect.payload,
			lineageRootId: effect.lineageRootTaskId ?? id,
			createdAt,
		});
		return;
	}
	tx.run(ENGINE_SQL.insertEvent, {
		eventUid: id,
		taskId: null,
		attemptId: null,
		kind: effect.eventKind,
		sourceKind: "v2-engine",
		sourceId: proposal.handle.attemptUid,
		payload: effect.payload,
		cutoverEpoch,
		createdAt,
	});
}

export function submitProposal(
	kernel: Kernel,
	runtime: EngineRuntime,
	proposal: ConversionProposal,
	authorization?: ProposalAuthorization,
): string {
	const preparedEffects = validateProposal(proposal);
	const proposalDigest = canonicalProposalDigest(proposal);
	kernel.write("consume.settle.success", (tx) => {
		requireCurrentAgentTx(tx, proposal.handle.agent);
		requireAttemptBindingTx(tx, proposal.handle);
		if (authorization) {
			const tokenHash = createHash("sha256")
				.update(authorization.token)
				.digest("hex");
			const capability = tx.get<{
				id: string;
				issuer: string;
				audience: string;
				action: string;
				attempt_generation: number | null;
				subject_digest: string | null;
				consumed_at: string | null;
				revoked_at: string | null;
			}>(
				`SELECT id,issuer,audience,action,attempt_generation,subject_digest,
				        consumed_at,revoked_at
				 FROM capabilities WHERE token_hash=@tokenHash`,
				{ tokenHash },
			);
			if (
				!capability ||
				capability.id !== authorization.capabilityId ||
				capability.issuer.trim().length === 0 ||
				capability.audience !== proposal.handle.agent.agentId ||
				capability.action !== "submit_proposal" ||
				capability.attempt_generation !== proposal.handle.agent.generation ||
				capability.subject_digest !== proposalSubjectDigest(proposal.handle) ||
				capability.consumed_at !== null ||
				capability.revoked_at !== null
			) {
				throw new FenceViolation("proposal capability binding mismatch");
			}
			if (proposal.handle.agent.kind === "runner") {
				const activation = tx.get<{ state: string }>(
					"SELECT state FROM activations WHERE id=@activationId",
					{ activationId: proposal.handle.agent.activationId },
				);
				if (!activation || activation.state !== "active") {
					throw new FenceViolation(
						"proposal capability runner activation is not active",
					);
				}
			}
			tx.cas(FENCE.capabilityConsume, {
				capabilityId: capability.id,
				now: runtime.clock.nowIso(),
				action: "submit_proposal",
				audience: proposal.handle.agent.agentId,
				taskId: null,
				attemptGeneration: proposal.handle.agent.generation,
			});
		}
		const cutoverEpoch = readCutoverEpochTx(tx);
		for (const prepared of preparedEffects) {
			writeEffect(tx, runtime, proposal, prepared, cutoverEpoch);
		}
		tx.run(ENGINE_SQL.insertEvent, {
			eventUid: `mailbox:${proposal.handle.messageUid}:applied:${proposal.handle.attemptUid}`,
			taskId: null,
			attemptId: null,
			kind: "mailbox.applied",
			sourceKind: "v2-engine",
			sourceId: proposal.handle.messageUid,
			payload: JSON.stringify({
				message_uid: proposal.handle.messageUid,
				attempt_uid: proposal.handle.attemptUid,
			}),
			cutoverEpoch,
			createdAt: runtime.clock.nowIso(),
		});
		tx.cas(FENCE.mailboxCasPendingApplied, {
			uid: proposal.handle.messageUid,
			now: runtime.clock.nowIso(),
		});
		tx.cas(FENCE.processingAttemptCasRunningSettled, {
			attemptUid: proposal.handle.attemptUid,
			outcome: "succeeded",
			settledAt: runtime.clock.nowIso(),
			proposalDigest,
		});
	});
	return proposalDigest;
}

export type ProposalReceipt =
	| { status: "running" }
	| { status: "failed"; outcome: "failed" | "crashed" }
	| { status: "succeeded"; proposalDigest: string }
	| {
			status: "conflict";
			proposalDigest: string;
			storedProposalDigest: string;
	  }
	| { status: "missing" };

export function readProposalReceipt(
	kernel: Kernel,
	proposal: ConversionProposal,
): ProposalReceipt {
	const proposalDigest = canonicalProposalDigest(proposal);
	const row = kernel.read((tx) =>
		tx.get<{
			message_uid: string;
			outcome: "running" | "succeeded" | "failed" | "crashed";
			proposal_digest: string | null;
		}>(
			`SELECT message_uid,outcome,proposal_digest
			 FROM processing_attempts WHERE attempt_uid=@attemptUid`,
			{ attemptUid: proposal.handle.attemptUid },
		),
	);
	if (!row || row.message_uid !== proposal.handle.messageUid) {
		return { status: "missing" };
	}
	if (row.outcome === "running") return { status: "running" };
	if (row.outcome !== "succeeded") {
		return { status: "failed", outcome: row.outcome };
	}
	if (row.proposal_digest === proposalDigest) {
		return { status: "succeeded", proposalDigest };
	}
	return {
		status: "conflict",
		proposalDigest,
		storedProposalDigest: row.proposal_digest as string,
	};
}

export function reportConversionFailure(
	kernel: Kernel,
	runtime: EngineRuntime,
	handle: AttemptHandle,
	_error: string,
): void {
	kernel.write("consume.settle.failure", (tx) => {
		requireCurrentAgentTx(tx, handle.agent);
		requireAttemptBindingTx(tx, handle);
		tx.cas(FENCE.processingAttemptCasRunningSettled, {
			attemptUid: handle.attemptUid,
			outcome: "failed",
			settledAt: runtime.clock.nowIso(),
			proposalDigest: null,
		});
		settleFailureMailboxTx(tx, runtime, {
			agentId: handle.agent.agentId,
			messageUid: handle.messageUid,
			attemptUid: handle.attemptUid,
			generation: handle.agent.generation,
		});
	});
}
