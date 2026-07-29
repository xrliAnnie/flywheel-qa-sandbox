import type { RegisteredAgent } from "flywheel-v2-engine";
import type { Kernel, WriteTx } from "flywheel-v2-kernel";
import { parseTaskPayload } from "./contract.js";
import type { CanonicalValue } from "./digests.js";
import { canonicalJson } from "./digests.js";
import { DagConflictError, DagContractError } from "./errors.js";
import { appendEvent } from "./events.js";
import type { ReviewFamilies } from "./families.js";
import { readCutoverEpoch, readEnvelope } from "./meta.js";
import type { DagPorts } from "./types.js";

export type EvidenceInput =
	| {
			eventUid: string;
			kind: "verdict";
			taskId: string;
			attemptId: string;
			head: string;
			verdict: "pass" | "fail";
			producer: RegisteredAgent;
	  }
	| {
			eventUid: string;
			kind: "artifact";
			taskId: string;
			attemptId: string;
			path: string;
			digest: string;
			producer: RegisteredAgent;
	  }
	| {
			eventUid: string;
			kind: "review_approval";
			projectId: string;
			review: string;
			subjectDigest: string;
			reviewer: { agentId: string; generation: number };
	  };

function requireProducer(
	tx: WriteTx,
	input: Extract<EvidenceInput, { kind: "verdict" | "artifact" }>,
): void {
	if (input.producer.kind !== "runner") {
		throw new DagContractError("task evidence producer must be a runner");
	}
	const bound = tx.get<{
		task_id: string;
		activation_id: string;
		session_ref: string;
		task_payload: string;
	}>(
		`SELECT a.task_id,act.id AS activation_id,act.session_ref,
		        t.payload AS task_payload
		   FROM attempts a
		   JOIN activations act ON act.attempt_id=a.id
		   JOIN tasks t ON t.id=a.task_id
		  WHERE a.id=@attemptId AND act.id=@activationId AND act.state='active'`,
		{
			attemptId: input.attemptId,
			activationId: input.producer.activationId,
		},
	);
	const agent = tx.get<{ generation: number; kind: string }>(
		"SELECT generation,kind FROM agents WHERE agent_id=@agentId",
		{ agentId: input.producer.agentId },
	);
	const executor = bound
		? parseTaskPayload(JSON.parse(bound.task_payload)).executor
		: null;
	if (
		!bound ||
		bound.task_id !== input.taskId ||
		bound.session_ref !== input.producer.instanceId ||
		executor?.logicalAgentId !== input.producer.agentId ||
		!agent ||
		agent.kind !== "runner" ||
		agent.generation !== input.producer.generation
	) {
		throw new DagContractError("task evidence producer binding is stale");
	}
}

function insertIdempotent(
	tx: WriteTx,
	input: {
		eventUid: string;
		taskId?: string;
		attemptId?: string;
		kind: string;
		payload: CanonicalValue;
		epoch: number;
		now: string;
	},
): void {
	const existing = tx.get<{ kind: string; payload: string | null }>(
		"SELECT kind,payload FROM events WHERE event_uid=@eventUid",
		{ eventUid: input.eventUid },
	);
	const payload = canonicalJson(input.payload);
	if (existing) {
		if (existing.kind !== input.kind || existing.payload !== payload) {
			throw new DagConflictError(`evidence ${input.eventUid} conflicts`);
		}
		return;
	}
	appendEvent(tx, {
		eventUid: input.eventUid,
		taskId: input.taskId,
		attemptId: input.attemptId,
		kind: input.kind,
		sourceKind: "evidence",
		sourceId: input.eventUid,
		payload: input.payload,
		cutoverEpoch: input.epoch,
		createdAt: input.now,
	});
}

export function recordEvidence(
	kernel: Kernel,
	ports: DagPorts,
	input: EvidenceInput,
): void {
	if (input.eventUid.trim().length === 0)
		throw new TypeError("eventUid is empty");
	kernel.write("v2dag.evidence.record", (tx) => {
		const epoch = readCutoverEpoch(tx);
		if (input.kind === "review_approval") {
			const reviewer = tx.get<{ generation: number }>(
				"SELECT generation FROM agents WHERE agent_id=@agentId",
				{ agentId: input.reviewer.agentId },
			);
			if (!reviewer || reviewer.generation !== input.reviewer.generation) {
				throw new DagContractError("reviewer generation is stale");
			}
			const config = readEnvelope<ReviewFamilies>(
				tx,
				`review_families:${input.projectId}`,
				epoch,
			);
			const families = Object.entries(config?.data.families ?? {})
				.filter(
					([, value]) => value.reviewer_agent_id === input.reviewer.agentId,
				)
				.map(([family]) => family);
			if (families.length !== 1) {
				throw new DagContractError("reviewer family is ambiguous");
			}
			insertIdempotent(tx, {
				eventUid: input.eventUid,
				kind: "evidence.review_approval",
				payload: {
					project_id: input.projectId,
					review: input.review,
					subject_digest: input.subjectDigest,
					reviewer_agent: input.reviewer.agentId,
					reviewer_family: families[0] as string,
					reviewer_generation: input.reviewer.generation,
				},
				epoch,
				now: ports.clock.nowIso(),
			});
			return;
		}
		requireProducer(tx, input);
		if (input.producer.kind !== "runner") {
			throw new DagContractError("task evidence producer must be a runner");
		}
		const common = {
			task_id: input.taskId,
			attempt_id: input.attemptId,
			by_agent: input.producer.agentId,
			by_generation: input.producer.generation,
			by_activation: input.producer.activationId,
		};
		insertIdempotent(tx, {
			eventUid: input.eventUid,
			taskId: input.taskId,
			attemptId: input.attemptId,
			kind: input.kind === "verdict" ? "evidence.verdict" : "evidence.artifact",
			payload:
				input.kind === "verdict"
					? { ...common, head: input.head, verdict: input.verdict }
					: { ...common, path: input.path, digest: input.digest },
			epoch,
			now: ports.clock.nowIso(),
		});
	});
}
