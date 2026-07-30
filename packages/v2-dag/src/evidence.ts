import {
	isSessionRecipient,
	type RegisteredAgent,
	requireCurrentRunnerTx,
} from "flywheel-v2-engine";
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
			reviewer: RegisteredAgent | { agentId: string; generation: number };
	  };

/**
 * FLY-1543 ⑤ operator-contract change (stated in the PR): the evidence
 * producer identity is the sessionRef quad -- agentId = instanceId =
 * activations.session_ref, generation = the attempt generation. There is no
 * agents-table lookup and no logicalAgentId comparison any more.
 */
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
		generation: number;
	}>(
		`SELECT a.task_id,act.id AS activation_id,act.session_ref,
		        act.generation
		   FROM attempts a
		   JOIN activations act ON act.attempt_id=a.id
		   JOIN tasks t ON t.id=a.task_id
		  WHERE a.id=@attemptId AND act.id=@activationId AND act.state='active'`,
		{
			attemptId: input.attemptId,
			activationId: input.producer.activationId,
		},
	);
	if (
		!bound ||
		bound.task_id !== input.taskId ||
		bound.session_ref !== input.producer.instanceId ||
		bound.session_ref !== input.producer.agentId ||
		bound.generation !== input.producer.generation
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

/**
 * FLY-1544 ①: with the role layer deleted, a reviewer's family is anchored
 * directly. A runner reviewer carries its own executor family (from its task
 * payload); a lead reviewer is matched against the review-families config by
 * agent id. Either way the resolved family must be exactly one configured
 * family, or the approval is refused.
 */
function reviewerFamilyTx(
	tx: WriteTx,
	reviewer: Extract<EvidenceInput, { kind: "review_approval" }>["reviewer"],
	families: ReviewFamilies["families"],
): string {
	if (!isSessionRecipient(reviewer.agentId)) {
		const current = tx.get<{ generation: number; kind: string }>(
			"SELECT generation,kind FROM agents WHERE agent_id=@agentId",
			{ agentId: reviewer.agentId },
		);
		if (
			!current ||
			current.kind !== "lead" ||
			current.generation !== reviewer.generation
		) {
			throw new DagContractError("reviewer generation is stale");
		}
		const matched = Object.entries(families)
			.filter(([, value]) => value.reviewer_agent_id === reviewer.agentId)
			.map(([family]) => family);
		if (matched.length !== 1) {
			throw new DagContractError("reviewer family is ambiguous");
		}
		return matched[0] as string;
	}
	if (!("kind" in reviewer) || reviewer.kind !== "runner") {
		throw new DagContractError(
			"runner reviewer requires the sessionRef identity quad",
		);
	}
	requireCurrentRunnerTx(tx, reviewer);
	const row = tx.get<{ payload: string }>(
		`SELECT t.payload
		   FROM activations act
		   JOIN attempts a ON a.id=act.attempt_id
		   JOIN tasks t ON t.id=a.task_id
		  WHERE act.id=@activationId AND act.session_ref=@sessionRef
		    AND act.state='active'`,
		{
			activationId: reviewer.activationId,
			sessionRef: reviewer.agentId,
		},
	);
	if (!row) {
		throw new DagContractError("reviewer activation is stale");
	}
	const family = parseTaskPayload(JSON.parse(row.payload)).executor.family;
	if (!Object.hasOwn(families, family)) {
		throw new DagContractError("reviewer family is ambiguous");
	}
	return family;
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
			const config = readEnvelope<ReviewFamilies>(
				tx,
				`review_families:${input.projectId}`,
				epoch,
			);
			const family = reviewerFamilyTx(
				tx,
				input.reviewer,
				config?.data.families ?? {},
			);
			insertIdempotent(tx, {
				eventUid: input.eventUid,
				kind: "evidence.review_approval",
				payload: {
					project_id: input.projectId,
					review: input.review,
					subject_digest: input.subjectDigest,
					reviewer_agent: input.reviewer.agentId,
					reviewer_session: input.reviewer.agentId,
					reviewer_family: family,
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
