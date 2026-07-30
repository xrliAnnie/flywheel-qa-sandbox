import type { RegisteredAgent } from "flywheel-v2-engine";
import type { Kernel, ReadTx, WriteTx } from "flywheel-v2-kernel";
import { terminalizeAttemptTx } from "./attempt-terminal.js";
import { parseTaskPayload, type TaskPayload } from "./contract.js";
import type { CanonicalValue } from "./digests.js";
import { digestJson } from "./digests.js";
import { DagContractError } from "./errors.js";
import { appendEvent, readReceipt } from "./events.js";
import type { ReviewFamilies } from "./families.js";
import {
	auditShipGateTx,
	type IssueReceiptData,
	maybeRefreshShipGateTx,
	type ShipGateData,
} from "./gate.js";
import { appendMailboxTx } from "./mailbox-append.js";
import { readManifest } from "./manifest.js";
import {
	type Envelope,
	readCutoverEpoch,
	readEnvelope,
	updateEnvelope,
} from "./meta.js";
import type {
	CompletionObservation,
	DagPorts,
	ManifestEntry,
} from "./types.js";

interface TaskRow {
	project_id: string;
	external_issue_id: string;
	state: string;
	payload: string;
}

interface WorktreeData {
	worktree_path: string;
}

interface SpanData {
	head: string;
	updated_by_attempt: string | null;
}

interface WriterData {
	chain_head: string;
	open_attempt: null | {
		attempt_id: string;
		generation: number;
		family: string;
		start_head: string;
	};
	span_author_set: string[];
	pending_gap: null | { from: string; to: string };
}

interface ClaimData {
	state: "pending" | "claimed" | "launched" | "tombstoned";
	owner_token: string | null;
	lease_until: string | null;
	launch_receipt: unknown;
}

export interface NodeCompletionRequest {
	taskId: string;
	attemptId: string;
	activationId: string;
	agent: RegisteredAgent;
	completionUid: string;
}

export interface NodeCompletionResult {
	status: "completed" | "contract_pending" | "replayed";
	taskId: string;
	head: string;
	gateId: string | null;
}

function readTask(tx: ReadTx, taskId: string): TaskRow {
	const task = tx.get<TaskRow>(
		`SELECT project_id,external_issue_id,state,payload
		   FROM tasks WHERE id=@taskId`,
		{ taskId },
	);
	if (!task) throw new DagContractError(`task ${taskId} is missing`);
	return task;
}

function issueReceipt(tx: ReadTx, issueId: string): IssueReceiptData {
	const receipt = readEnvelope<IssueReceiptData>(tx, `dag_issue:${issueId}`);
	if (!receipt)
		throw new DagContractError("task has no DAG membership receipt");
	return receipt.data;
}

function emptyObservation(head: string): CompletionObservation {
	const manifest: ManifestEntry[] = [];
	const manifestDigest = digestJson(manifest as unknown as CanonicalValue);
	return {
		base: head,
		head,
		manifest,
		manifestDigest,
		reviewSubjectDigest: digestJson({
			head,
			manifest_digest: manifestDigest,
			author_families: [],
		}),
		authorFamilies: [],
		writerRevision: null,
	};
}

export async function observeNodeCompletion(
	kernel: Kernel,
	ports: DagPorts,
	taskId: string,
): Promise<CompletionObservation> {
	const snapshot = kernel.read((tx) => {
		const task = readTask(tx, taskId);
		const payload = parseTaskPayload(JSON.parse(task.payload));
		const issue = issueReceipt(tx, task.external_issue_id);
		if (!payload.writes_repo || payload.worktree_id === null) {
			const shipSpan = readEnvelope<SpanData>(
				tx,
				`span_tip:${issue.ship_worktree_id}`,
			);
			if (!shipSpan) throw new DagContractError("ship span is missing");
			return { kind: "nonwriter" as const, head: shipSpan.data.head };
		}
		const worktree = readEnvelope<WorktreeData>(
			tx,
			`canonical_worktree:${payload.worktree_id}`,
		);
		const span = readEnvelope<SpanData>(tx, `span_tip:${payload.worktree_id}`);
		const writer = readEnvelope<WriterData>(
			tx,
			`writer_chain:${payload.worktree_id}`,
		);
		if (!worktree || !span || !writer || !writer.data.open_attempt) {
			throw new DagContractError("writer state is incomplete");
		}
		return { kind: "writer" as const, worktree, span, writer };
	});
	if (snapshot.kind === "nonwriter") {
		return emptyObservation(snapshot.head);
	}
	const head = await ports.git.readHead(snapshot.worktree.data.worktree_path);
	const manifest = await readManifest(
		ports.git,
		snapshot.worktree.data.worktree_path,
		snapshot.span.data.head,
		head,
	);
	const authorFamilies = [
		...new Set([
			...snapshot.writer.data.span_author_set,
			...(head === snapshot.writer.data.open_attempt?.start_head
				? []
				: [snapshot.writer.data.open_attempt?.family as string]),
		]),
	].sort();
	return {
		base: snapshot.span.data.head,
		head,
		manifest: manifest.entries,
		manifestDigest: manifest.digest,
		reviewSubjectDigest: digestJson({
			head,
			manifest_digest: manifest.digest,
			author_families: authorFamilies,
		}),
		authorFamilies,
		writerRevision: snapshot.writer.revision,
	};
}

interface EvidenceRecord {
	ref: string;
	payload: Record<string, CanonicalValue>;
}

interface ContractEvaluation {
	evidenceRefs: string[];
	satisfiedItems: CanonicalValue[];
}

function allEvidence(tx: ReadTx, kind: string): EvidenceRecord[] {
	return tx
		.all<{ event_uid: string; payload: string | null }>(
			"SELECT event_uid,payload FROM events WHERE kind=@kind ORDER BY seq",
			{ kind },
		)
		.map((row) => ({
			ref: row.event_uid,
			payload: JSON.parse(row.payload ?? "{}") as Record<
				string,
				CanonicalValue
			>,
		}));
}

function reviewFamilies(
	tx: ReadTx,
	projectId: string,
): Record<string, { reviewer_agent_id: string }> {
	return (
		readEnvelope<ReviewFamilies>(tx, `review_families:${projectId}`)?.data
			.families ?? {}
	);
}

function hasApproval(
	tx: ReadTx,
	input: {
		kind: string;
		projectId: string;
		subject: string;
		eligibleFamilies: Set<string>;
		excludedReviewerAgentId: string;
	},
): EvidenceRecord | null {
	return (
		allEvidence(tx, "evidence.review_approval").find(
			({ payload }) =>
				payload.project_id === input.projectId &&
				payload.review === input.kind &&
				payload.subject_digest === input.subject &&
				typeof payload.reviewer_family === "string" &&
				input.eligibleFamilies.has(payload.reviewer_family) &&
				payload.reviewer_agent !== input.excludedReviewerAgentId,
		) ?? null
	);
}

function requireContract(
	tx: ReadTx,
	input: {
		taskId: string;
		task: TaskRow;
		payload: TaskPayload;
		attemptId: string;
		observation: CompletionObservation;
	},
):
	| { status: "review_family_exhausted" }
	| { status: "satisfied"; evaluation: ContractEvaluation } {
	const families = reviewFamilies(tx, input.task.project_id);
	const eligibleFamilies = new Set(
		Object.keys(families).filter(
			(family) => !input.observation.authorFamilies.includes(family),
		),
	);
	const productOutput = input.observation.manifest.some(
		(entry) => entry.classification === "product",
	);
	const declaredReview = input.payload.contract.some(
		(item) => item.kind === "review_approval",
	);
	if (
		(productOutput || declaredReview) &&
		!Object.hasOwn(families, input.payload.executor.family)
	) {
		throw new DagContractError(
			`executor family ${input.payload.executor.family} is not authoritative`,
		);
	}
	if ((productOutput || declaredReview) && eligibleFamilies.size === 0) {
		return { status: "review_family_exhausted" };
	}
	const evidenceRefs = new Set<string>();
	const satisfiedItems: CanonicalValue[] = [];
	if (productOutput) {
		const approval = hasApproval(tx, {
			kind: "code",
			projectId: input.task.project_id,
			subject: input.observation.reviewSubjectDigest,
			eligibleFamilies,
			excludedReviewerAgentId: input.payload.executor.logicalAgentId,
		});
		if (!approval) {
			throw new DagContractError("contract lacks cross-family approval");
		}
		evidenceRefs.add(approval.ref);
		satisfiedItems.push({ kind: "derived_review_approval", review: "code" });
	}
	for (const item of input.payload.contract) {
		if (item.kind === "verdict") {
			const found = allEvidence(tx, "evidence.verdict").find(
				({ payload }) =>
					payload.task_id === input.taskId &&
					payload.attempt_id === input.attemptId &&
					payload.head === input.observation.head &&
					payload.verdict === "pass",
			);
			if (!found) throw new DagContractError("contract lacks passing verdict");
			evidenceRefs.add(found.ref);
			satisfiedItems.push({ kind: "verdict" });
		} else if (item.kind === "review_approval") {
			const approval = hasApproval(tx, {
				kind: item.review,
				projectId: input.task.project_id,
				subject: input.observation.reviewSubjectDigest,
				eligibleFamilies,
				excludedReviewerAgentId: input.payload.executor.logicalAgentId,
			});
			if (!approval) {
				throw new DagContractError("contract lacks declared approval");
			}
			evidenceRefs.add(approval.ref);
			satisfiedItems.push(item as CanonicalValue);
		} else {
			const matches = allEvidence(tx, "evidence.artifact").filter(
				({ payload }) =>
					payload.attempt_id === input.attemptId &&
					payload.path === item.path &&
					(item.digest === undefined || payload.digest === item.digest),
			);
			if (
				matches.length === 0 ||
				(item.cardinality === "one" && matches.length !== 1)
			) {
				throw new DagContractError("contract lacks artifact evidence");
			}
			for (const match of matches) evidenceRefs.add(match.ref);
			satisfiedItems.push(item as CanonicalValue);
		}
	}
	return {
		status: "satisfied",
		evaluation: {
			evidenceRefs: [...evidenceRefs].sort(),
			satisfiedItems,
		},
	};
}

function completionRequestValue(
	request: NodeCompletionRequest,
): CanonicalValue {
	return {
		task_id: request.taskId,
		attempt_id: request.attemptId,
		activation_id: request.activationId,
		agent: request.agent as unknown as CanonicalValue,
		completion_uid: request.completionUid,
	};
}

/**
 * FLY-1543 ⑤ operator-contract change (stated in the PR): the completion
 * producer identity is the sessionRef quad -- agentId = instanceId =
 * activations.session_ref, generation = the attempt generation, activationId =
 * the active activation. Role names are no longer accepted.
 */
function validateBinding(
	tx: WriteTx,
	request: NodeCompletionRequest,
): {
	task: TaskRow;
	payload: TaskPayload;
	sessionRef: string;
	attemptGeneration: number;
} {
	if (request.agent.kind !== "runner") {
		throw new DagContractError("completion agent must be a runner");
	}
	const row = tx.get<{
		task_id: string;
		attempt_generation: number;
		attempt_state: string;
		activation_generation: number;
		activation_state: string;
		session_ref: string;
	}>(
		`SELECT a.task_id,a.generation AS attempt_generation,
		        a.desired_state AS attempt_state,
		        act.generation AS activation_generation,
		        act.state AS activation_state,act.session_ref
		   FROM attempts a JOIN activations act ON act.attempt_id=a.id
		  WHERE a.id=@attemptId AND act.id=@activationId`,
		{
			attemptId: request.attemptId,
			activationId: request.activationId,
		},
	);
	if (
		!row ||
		row.task_id !== request.taskId ||
		row.attempt_state === "terminal" ||
		row.activation_state !== "active" ||
		row.attempt_generation !== row.activation_generation ||
		request.agent.activationId !== request.activationId ||
		request.agent.instanceId !== row.session_ref ||
		request.agent.agentId !== row.session_ref ||
		request.agent.generation !== row.attempt_generation
	) {
		throw new DagContractError("completion identity binding is stale");
	}
	const task = readTask(tx, request.taskId);
	if (task.state !== "running")
		throw new DagContractError("task is not running");
	const issue = issueReceipt(tx, task.external_issue_id);
	if (!issue.task_ids.includes(request.taskId)) {
		throw new DagContractError("task is outside the admitted DAG");
	}
	return {
		task,
		payload: parseTaskPayload(JSON.parse(task.payload)),
		sessionRef: row.session_ref,
		attemptGeneration: row.attempt_generation,
	};
}

function auditSpanAnchorDivergence(
	kernel: Kernel,
	ports: DagPorts,
	request: NodeCompletionRequest,
): void {
	kernel.write("v2dag.node.span-diverged", (tx) => {
		const epoch = readCutoverEpoch(tx);
		const task = readTask(tx, request.taskId);
		const issue = issueReceipt(tx, task.external_issue_id);
		const now = ports.clock.nowIso();
		const eventUid = `span_anchor_diverged:${request.attemptId}:${request.completionUid}`;
		const payload = {
			task_id: request.taskId,
			attempt_id: request.attemptId,
			completion_uid: request.completionUid,
		};
		if (
			!tx.get("SELECT 1 FROM events WHERE event_uid=@eventUid", { eventUid })
		) {
			appendEvent(tx, {
				eventUid,
				taskId: request.taskId,
				attemptId: request.attemptId,
				kind: "span_anchor_diverged",
				sourceKind: "completion",
				sourceId: request.completionUid,
				payload,
				cutoverEpoch: epoch,
				createdAt: now,
			});
		}
		appendMailboxTx(tx, {
			sourceKind: "span_anchor_diverged",
			sourceId: eventUid,
			toAgent: issue.notify_agent_id,
			kind: "span_anchor_diverged",
			payload,
			retentionClass: "business",
			cutoverEpoch: epoch,
			createdAt: now,
		});
		const gateKey = `ship_gate:${task.external_issue_id}`;
		const gate = readEnvelope<ShipGateData>(tx, gateKey, epoch);
		if (gate && gate.data.settled === null && gate.data.state !== "expired") {
			if (gate.data.capability_id) {
				tx.run(
					`UPDATE capabilities SET revoked_at=@now
					  WHERE id=@capabilityId AND consumed_at IS NULL AND revoked_at IS NULL`,
					{ now, capabilityId: gate.data.capability_id },
				);
			}
			const next = updateEnvelope(
				tx,
				gateKey,
				gate,
				{
					...gate.data,
					state: "expired",
					capability_id: null,
					retry: { ...gate.data.retry, next_retry_at: null },
				},
				now,
			);
			auditShipGateTx(tx, next.data, next.revision, now);
		}
	});
}

export async function submitNodeCompletion(
	kernel: Kernel,
	ports: DagPorts,
	request: NodeCompletionRequest,
): Promise<NodeCompletionResult> {
	const requestValue = completionRequestValue(request);
	const requestDigest = digestJson(requestValue);
	const receiptUid = `node_completed:${request.completionUid}`;
	const replay = kernel.read((tx) =>
		readReceipt<NodeCompletionResult>(tx, receiptUid, requestDigest),
	);
	if (replay) return { ...replay, status: "replayed" };
	let observation: CompletionObservation;
	try {
		observation = await observeNodeCompletion(kernel, ports, request.taskId);
	} catch (error) {
		if (
			error instanceof DagContractError &&
			error.message === "span anchor diverged"
		) {
			auditSpanAnchorDivergence(kernel, ports, request);
		}
		throw error;
	}
	const sessionRef = kernel.read((tx) => {
		const row = tx.get<{ session_ref: string }>(
			"SELECT session_ref FROM activations WHERE id=@activationId",
			{ activationId: request.activationId },
		);
		if (!row) throw new DagContractError("activation is missing");
		return row.session_ref;
	});
	return await ports.locks.withSessionLock(sessionRef, async () =>
		kernel.write("v2dag.node.complete", (tx) => {
			const raced = readReceipt<NodeCompletionResult>(
				tx,
				receiptUid,
				requestDigest,
			);
			if (raced) return { ...raced, status: "replayed" };
			const bound = validateBinding(tx, request);
			const epoch = readCutoverEpoch(tx);
			let writer: Envelope<WriterData> | null = null;
			if (bound.payload.writes_repo && bound.payload.worktree_id) {
				const span = readEnvelope<SpanData>(
					tx,
					`span_tip:${bound.payload.worktree_id}`,
					epoch,
				);
				writer = readEnvelope<WriterData>(
					tx,
					`writer_chain:${bound.payload.worktree_id}`,
					epoch,
				);
				if (
					!span ||
					!writer ||
					span.data.head !== observation.base ||
					writer.revision !== observation.writerRevision ||
					writer.data.open_attempt?.attempt_id !== request.attemptId ||
					writer.data.open_attempt.generation !== bound.attemptGeneration
				) {
					throw new DagContractError("writer observation is stale");
				}
			} else {
				const issue = issueReceipt(tx, bound.task.external_issue_id);
				const shipSpan = readEnvelope<SpanData>(
					tx,
					`span_tip:${issue.ship_worktree_id}`,
					epoch,
				);
				if (!shipSpan || shipSpan.data.head !== observation.head) {
					throw new DagContractError("non-writer observation is stale");
				}
			}
			const contract = requireContract(tx, {
				taskId: request.taskId,
				task: bound.task,
				payload: bound.payload,
				attemptId: request.attemptId,
				observation,
			});
			if (contract.status === "review_family_exhausted") {
				const eventUid = `${contract.status}:${request.completionUid}`;
				if (
					!tx.get("SELECT 1 FROM events WHERE event_uid=@eventUid", {
						eventUid,
					})
				) {
					appendEvent(tx, {
						eventUid,
						taskId: request.taskId,
						attemptId: request.attemptId,
						kind: contract.status,
						sourceKind: "completion",
						sourceId: request.completionUid,
						payload: {
							task_id: request.taskId,
							attempt_id: request.attemptId,
							subject_digest: observation.reviewSubjectDigest,
						},
						cutoverEpoch: epoch,
						createdAt: ports.clock.nowIso(),
					});
				}
				appendMailboxTx(tx, {
					sourceKind: contract.status,
					sourceId: eventUid,
					toAgent: issueReceipt(tx, bound.task.external_issue_id)
						.notify_agent_id,
					kind: contract.status,
					payload: {
						task_id: request.taskId,
						attempt_id: request.attemptId,
						subject_digest: observation.reviewSubjectDigest,
					},
					retentionClass: "business",
					cutoverEpoch: epoch,
					createdAt: ports.clock.nowIso(),
				});
				return {
					status: "contract_pending",
					taskId: request.taskId,
					head: observation.head,
					gateId: null,
				};
			}
			const claimKey = `launch_claim:${bound.sessionRef}`;
			const claim = readEnvelope<ClaimData>(tx, claimKey, epoch);
			if (!claim || claim.data.state === "tombstoned") {
				throw new DagContractError("launch claim is stale");
			}
			if (bound.payload.writes_repo && bound.payload.worktree_id && writer) {
				const span = readEnvelope<SpanData>(
					tx,
					`span_tip:${bound.payload.worktree_id}`,
					epoch,
				);
				if (!span) throw new DagContractError("span is missing");
				updateEnvelope(
					tx,
					`span_tip:${bound.payload.worktree_id}`,
					span,
					{
						head: observation.head,
						updated_by_attempt: request.attemptId,
					},
					ports.clock.nowIso(),
				);
				updateEnvelope(
					tx,
					`writer_chain:${bound.payload.worktree_id}`,
					writer,
					{
						...writer.data,
						chain_head: observation.head,
						open_attempt: null,
						span_author_set: [],
					},
					ports.clock.nowIso(),
				);
			}
			terminalizeAttemptTx(tx, {
				attemptId: request.attemptId,
				reason: "completed",
				cutoverEpoch: epoch,
				nowIso: ports.clock.nowIso(),
			});
			tx.cas(
				`UPDATE tasks SET state='done',state_version=state_version+1,
				 terminal_at=@now WHERE id=@taskId AND state='running'`,
				{ taskId: request.taskId, now: ports.clock.nowIso() },
			);
			const gate = maybeRefreshShipGateTx(tx, {
				issueId: bound.task.external_issue_id,
				emitterTaskId: request.taskId,
				emitterAgentId: request.agent.agentId,
				now: ports.clock.nowIso(),
			});
			const result: NodeCompletionResult = {
				status: "completed",
				taskId: request.taskId,
				head: observation.head,
				gateId: gate?.data.gate_id ?? null,
			};
			appendEvent(tx, {
				eventUid: receiptUid,
				taskId: request.taskId,
				attemptId: request.attemptId,
				kind: "node_completed",
				sourceKind: "completion",
				sourceId: request.completionUid,
				payload: {
					request_digest: requestDigest,
					result: result as unknown as CanonicalValue,
					manifest_digest: observation.manifestDigest,
					satisfied_items: contract.evaluation.satisfiedItems,
					evidence_refs: contract.evaluation.evidenceRefs,
				},
				cutoverEpoch: epoch,
				createdAt: ports.clock.nowIso(),
			});
			return result;
		}),
	);
}
