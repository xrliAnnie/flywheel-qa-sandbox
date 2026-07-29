import { randomUUID } from "node:crypto";
import type { RegisteredAgent } from "flywheel-v2-engine";
import { FENCE, type Kernel } from "flywheel-v2-kernel";
import type { CanonicalValue } from "./digests.js";
import { digestJson, sha256 } from "./digests.js";
import { DagConflictError, DagContractError } from "./errors.js";
import { appendEvent, readReceipt, receiptPayload } from "./events.js";
import { appendMailboxTx } from "./mailbox-append.js";
import { readCutoverEpoch, readEnvelope, updateEnvelope } from "./meta.js";
import type { DagPorts } from "./types.js";

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

interface SpanData {
	head: string;
	updated_by_attempt: string | null;
}

interface GapBinding {
	worktree_id: string;
	from_head: string;
	to_head: string;
	attribution_family: string;
	reason: string;
}

interface LostOpenBinding extends GapBinding {
	attempt_id: string;
	writer_revision: number;
	start_head: string;
	resolution_head: string;
}

interface WriterGapCapabilityInput {
	mode?: "adopt_writer_gap";
	authorizationUid: string;
	worktreeId: string;
	fromHead: string;
	toHead: string;
	attributionFamily: string;
	reason: string;
	actor: RegisteredAgent;
}

interface LostOpenCapabilityInput {
	mode: "lost_open_attempt";
	authorizationUid: string;
	worktreeId: string;
	attemptId: string;
	writerRevision: number;
	startHead: string;
	resolutionHead: string;
	attributionFamily: string;
	reason: "worktree_and_ref_unrecoverable";
	actor: RegisteredAgent;
}

interface WriterGapAdoptionInput {
	mode?: "adopt_writer_gap";
	worktreeId: string;
	fromHead: string;
	toHead: string;
	attributionFamily: string;
	reason: string;
	capabilityId: string;
	adoptionUid: string;
	actor: RegisteredAgent;
}

interface LostOpenAdoptionInput {
	mode: "lost_open_attempt";
	worktreeId: string;
	attemptId: string;
	writerRevision: number;
	startHead: string;
	resolutionHead: string;
	attributionFamily: string;
	reason: "worktree_and_ref_unrecoverable";
	capabilityId: string;
	adoptionUid: string;
	actor: RegisteredAgent;
}

function requireLead(
	kernel: Kernel,
	actor: RegisteredAgent,
): { agentId: string; generation: number } {
	if (actor.kind !== "lead") {
		throw new DagContractError("writer adoption requires supervised authority");
	}
	const current = kernel.read((tx) =>
		tx.get<{ kind: string; generation: number }>(
			"SELECT kind,generation FROM agents WHERE agent_id=@agentId",
			{ agentId: actor.agentId },
		),
	);
	if (
		!current ||
		current.kind !== "lead" ||
		current.generation !== actor.generation
	) {
		throw new DagContractError("writer adoption authority is stale");
	}
	return { agentId: actor.agentId, generation: actor.generation };
}

function gapBinding(input: {
	worktreeId: string;
	fromHead: string;
	toHead: string;
	attributionFamily: string;
	reason: string;
}): GapBinding {
	for (const [name, value] of [
		["worktreeId", input.worktreeId],
		["fromHead", input.fromHead],
		["toHead", input.toHead],
		["attributionFamily", input.attributionFamily],
		["reason", input.reason],
	] as const) {
		if (value.trim().length === 0) {
			throw new DagContractError(`${name} is empty`);
		}
	}
	return {
		worktree_id: input.worktreeId,
		from_head: input.fromHead,
		to_head: input.toHead,
		attribution_family: input.attributionFamily,
		reason: input.reason,
	};
}

function lostOpenBinding(input: {
	worktreeId: string;
	attemptId: string;
	writerRevision: number;
	startHead: string;
	resolutionHead: string;
	attributionFamily: string;
	reason: string;
}): LostOpenBinding {
	if (!Number.isSafeInteger(input.writerRevision) || input.writerRevision < 1) {
		throw new DagContractError("writerRevision is invalid");
	}
	if (input.reason !== "worktree_and_ref_unrecoverable") {
		throw new DagContractError("lost-open reason is invalid");
	}
	const base = gapBinding({
		worktreeId: input.worktreeId,
		fromHead: input.startHead,
		toHead: input.resolutionHead,
		attributionFamily: input.attributionFamily,
		reason: input.reason,
	});
	if (input.attemptId.trim().length === 0) {
		throw new DagContractError("attemptId is empty");
	}
	return {
		...base,
		attempt_id: input.attemptId,
		writer_revision: input.writerRevision,
		start_head: input.startHead,
		resolution_head: input.resolutionHead,
	};
}

function mintLostOpenCapability(
	kernel: Kernel,
	ports: DagPorts,
	input: LostOpenCapabilityInput,
): { capabilityId: string } {
	const actor = requireLead(kernel, input.actor);
	const binding = lostOpenBinding(input);
	const request: CanonicalValue = {
		authorization_uid: input.authorizationUid,
		action: "lost_open_attempt",
		binding: binding as unknown as CanonicalValue,
		actor: {
			agent_id: actor.agentId,
			generation: actor.generation,
		},
	};
	const requestDigest = digestJson(request);
	const eventUid = `writer_adoption_minted:${input.authorizationUid}`;
	return kernel.write("v2dag.writer-gap.authorize-lost-open", (tx) => {
		const replay = readReceipt<{ capabilityId: string }>(
			tx,
			eventUid,
			requestDigest,
		);
		if (replay) return replay;
		const epoch = readCutoverEpoch(tx);
		const writer = readEnvelope<WriterData>(
			tx,
			`writer_chain:${binding.worktree_id}`,
			epoch,
		);
		const span = readEnvelope<SpanData>(
			tx,
			`span_tip:${binding.worktree_id}`,
			epoch,
		);
		if (
			!writer ||
			!span ||
			writer.revision !== binding.writer_revision ||
			writer.data.chain_head !== binding.start_head ||
			writer.data.open_attempt?.attempt_id !== binding.attempt_id ||
			writer.data.open_attempt.start_head !== binding.start_head ||
			writer.data.open_attempt.family !== binding.attribution_family ||
			span.data.head !== binding.resolution_head
		) {
			throw new DagContractError("lost-open authority does not match");
		}
		const capabilityId = randomUUID();
		const subjectDigest = digestJson(binding as unknown as CanonicalValue);
		tx.run(
			`INSERT INTO capabilities
			 (id,token_hash,issuer,audience,action,task_id,attempt_generation,
			  subject_digest,issued_at)
			 VALUES(@id,@tokenHash,@issuer,@audience,'lost_open_attempt',NULL,NULL,
			        @subjectDigest,@issuedAt)`,
			{
				id: capabilityId,
				tokenHash: sha256(`v2dag:${capabilityId}:${subjectDigest}`),
				issuer: `lost_open_attempt:${binding.worktree_id}:${binding.attempt_id}`,
				audience: actor.agentId,
				subjectDigest,
				issuedAt: ports.clock.nowIso(),
			},
		);
		const result = { capabilityId };
		appendEvent(tx, {
			eventUid,
			kind: "writer_adoption_minted",
			sourceKind: "lost_open_authority",
			sourceId: input.authorizationUid,
			payload: receiptPayload(request, result),
			cutoverEpoch: epoch,
			createdAt: ports.clock.nowIso(),
		});
		return result;
	});
}

export function mintWriterAdoptionCapability(
	kernel: Kernel,
	ports: DagPorts,
	input: WriterGapCapabilityInput | LostOpenCapabilityInput,
): { capabilityId: string } {
	if (input.mode === "lost_open_attempt") {
		return mintLostOpenCapability(kernel, ports, input);
	}
	const actor = requireLead(kernel, input.actor);
	const binding = gapBinding(input);
	const request: CanonicalValue = {
		authorization_uid: input.authorizationUid,
		binding: binding as unknown as CanonicalValue,
		actor: {
			agent_id: actor.agentId,
			generation: actor.generation,
		},
	};
	const requestDigest = digestJson(request);
	const eventUid = `writer_adoption_minted:${input.authorizationUid}`;
	return kernel.write("v2dag.writer-gap.authorize", (tx) => {
		const replay = readReceipt<{ capabilityId: string }>(
			tx,
			eventUid,
			requestDigest,
		);
		if (replay) return replay;
		const epoch = readCutoverEpoch(tx);
		const writer = readEnvelope<WriterData>(
			tx,
			`writer_chain:${binding.worktree_id}`,
			epoch,
		);
		if (
			!writer ||
			writer.data.pending_gap?.from !== binding.from_head ||
			writer.data.pending_gap.to !== binding.to_head
		) {
			throw new DagContractError("writer gap authority does not match");
		}
		const capabilityId = randomUUID();
		const subjectDigest = digestJson(binding as unknown as CanonicalValue);
		tx.run(
			`INSERT INTO capabilities
			 (id,token_hash,issuer,audience,action,task_id,attempt_generation,
			  subject_digest,issued_at)
			 VALUES(@id,@tokenHash,@issuer,@audience,'adopt_writer_gap',NULL,NULL,
			        @subjectDigest,@issuedAt)`,
			{
				id: capabilityId,
				tokenHash: sha256(`v2dag:${capabilityId}:${subjectDigest}`),
				issuer: `writer_gap:${binding.worktree_id}:${binding.from_head}:${binding.to_head}`,
				audience: actor.agentId,
				subjectDigest,
				issuedAt: ports.clock.nowIso(),
			},
		);
		const result = { capabilityId };
		appendEvent(tx, {
			eventUid,
			kind: "writer_adoption_minted",
			sourceKind: "writer_gap_authority",
			sourceId: input.authorizationUid,
			payload: receiptPayload(request, result),
			cutoverEpoch: epoch,
			createdAt: ports.clock.nowIso(),
		});
		return result;
	});
}

async function adoptLostOpenAttempt(
	kernel: Kernel,
	ports: DagPorts,
	input: LostOpenAdoptionInput,
): Promise<{
	status: "adopted" | "replayed";
	worktreeId: string;
}> {
	const actor = requireLead(kernel, input.actor);
	const binding = lostOpenBinding(input);
	const request: CanonicalValue = {
		adoption_uid: input.adoptionUid,
		capability_id: input.capabilityId,
		action: "lost_open_attempt",
		binding: binding as unknown as CanonicalValue,
		actor: {
			agent_id: actor.agentId,
			generation: actor.generation,
		},
	};
	const requestDigest = digestJson(request);
	const eventUid = `lost_writer_span_adopted:${input.adoptionUid}`;
	const replay = kernel.read((tx) =>
		readReceipt<{ status: "adopted"; worktreeId: string }>(
			tx,
			eventUid,
			requestDigest,
		),
	);
	if (replay) return { ...replay, status: "replayed" };

	const packet = kernel.read((tx) => {
		const worktree = readEnvelope<{
			worktree_path: string;
			repo_identity: string;
			branch_ref: string;
		}>(tx, `canonical_worktree:${binding.worktree_id}`);
		const execution = tx.get<{
			task_id: string;
			issue_id: string;
			task_state: string;
			attempt_state: string;
			activation_id: string;
			session_ref: string;
			agent_id: string;
		}>(
			`SELECT t.id AS task_id,t.external_issue_id AS issue_id,
			        t.state AS task_state,a.desired_state AS attempt_state,
			        act.id AS activation_id,act.session_ref,
			        json_extract(t.payload,'$.executor.logicalAgentId') AS agent_id
			   FROM attempts a
			   JOIN tasks t ON t.id=a.task_id
			   JOIN activations act ON act.attempt_id=a.id AND act.state='active'
			  WHERE a.id=@attemptId`,
			{ attemptId: binding.attempt_id },
		);
		const claim = execution
			? readEnvelope<{ state: string }>(
					tx,
					`launch_claim:${execution.session_ref}`,
				)
			: null;
		return worktree && execution && claim
			? {
					worktree: worktree.data,
					execution,
					claimRevision: claim.revision,
				}
			: null;
	});
	if (
		!packet ||
		packet.execution.task_state !== "running" ||
		!["dispatched", "started"].includes(packet.execution.attempt_state)
	) {
		throw new DagContractError("lost-open attempt is not active");
	}

	return await ports.locks.withSessionLock(
		packet.execution.session_ref,
		async () => {
			const fresh = await ports.process.probe(packet.execution.session_ref);
			if (fresh.state !== "absent") {
				throw new DagContractError("lost-open process is still present");
			}
			if (
				await ports.worktreeRef.worktreePresent(packet.worktree.worktree_path)
			) {
				throw new DagContractError("lost-open worktree is still present");
			}
			const branchHead = await ports.worktreeRef.readExactRef(
				packet.worktree.repo_identity,
				packet.worktree.branch_ref,
			);
			if (branchHead !== null) {
				throw new DagContractError("lost-open branch ref is still present");
			}
			const reachableResolution = await ports.worktreeRef.readExactRef(
				packet.worktree.repo_identity,
				binding.resolution_head,
			);
			if (reachableResolution !== binding.resolution_head) {
				throw new DagContractError("lost-open resolution head is unreachable");
			}

			return kernel.write("v2dag.writer-gap.adopt-lost-open", (tx) => {
				const raced = readReceipt<{
					status: "adopted";
					worktreeId: string;
				}>(tx, eventUid, requestDigest);
				if (raced) return { ...raced, status: "replayed" as const };
				const epoch = readCutoverEpoch(tx);
				const execution = tx.get<{
					task_id: string;
					issue_id: string;
					task_state: string;
					attempt_state: string;
					activation_id: string;
					session_ref: string;
					agent_id: string;
				}>(
					`SELECT t.id AS task_id,t.external_issue_id AS issue_id,
					        t.state AS task_state,a.desired_state AS attempt_state,
					        act.id AS activation_id,act.session_ref,
					        json_extract(t.payload,'$.executor.logicalAgentId') AS agent_id
					   FROM attempts a
					   JOIN tasks t ON t.id=a.task_id
					   JOIN activations act
					     ON act.attempt_id=a.id AND act.state='active'
					  WHERE a.id=@attemptId`,
					{ attemptId: binding.attempt_id },
				);
				const writerKey = `writer_chain:${binding.worktree_id}`;
				const writer = readEnvelope<WriterData>(tx, writerKey, epoch);
				const span = readEnvelope<SpanData>(
					tx,
					`span_tip:${binding.worktree_id}`,
					epoch,
				);
				if (
					!execution ||
					execution.task_state !== "running" ||
					!["dispatched", "started"].includes(execution.attempt_state) ||
					execution.session_ref !== packet.execution.session_ref ||
					!writer ||
					!span ||
					writer.revision !== binding.writer_revision ||
					writer.data.chain_head !== binding.start_head ||
					writer.data.open_attempt?.attempt_id !== binding.attempt_id ||
					writer.data.open_attempt.start_head !== binding.start_head ||
					writer.data.open_attempt.family !== binding.attribution_family ||
					span.data.head !== binding.resolution_head
				) {
					throw new DagConflictError("lost-open state changed");
				}
				const claimKey = `launch_claim:${execution.session_ref}`;
				const claim = readEnvelope<{
					state: string;
					owner_token: string | null;
					lease_until: string | null;
					launch_receipt: unknown;
				}>(tx, claimKey, epoch);
				if (
					!claim ||
					claim.revision !== packet.claimRevision ||
					claim.data.state !== "launched"
				) {
					throw new DagConflictError("lost-open launch claim changed");
				}
				const agentBindingKey = `agent_binding:${execution.agent_id}`;
				const agentBinding = readEnvelope<{
					state: "active" | "clear";
					activation_id: string | null;
					attempt_id: string | null;
					session_ref_current: string | null;
					session_ref_last: string | null;
					host_epoch: string | null;
				}>(tx, agentBindingKey, epoch);
				if (
					!agentBinding ||
					agentBinding.data.state !== "active" ||
					agentBinding.data.activation_id !== execution.activation_id ||
					agentBinding.data.attempt_id !== binding.attempt_id ||
					agentBinding.data.session_ref_current !== execution.session_ref
				) {
					throw new DagConflictError("lost-open agent binding changed");
				}
				const subjectDigest = digestJson(binding as unknown as CanonicalValue);
				const capability = tx.get<{
					issuer: string;
					audience: string;
					action: string;
					subject_digest: string | null;
				}>(
					`SELECT issuer,audience,action,subject_digest
					   FROM capabilities WHERE id=@capabilityId`,
					{ capabilityId: input.capabilityId },
				);
				if (
					!capability ||
					capability.issuer !==
						`lost_open_attempt:${binding.worktree_id}:${binding.attempt_id}` ||
					capability.audience !== actor.agentId ||
					capability.action !== "lost_open_attempt" ||
					capability.subject_digest !== subjectDigest
				) {
					throw new DagContractError("lost-open capability is invalid");
				}

				tx.cas(FENCE.capabilityConsume, {
					now: ports.clock.nowIso(),
					capabilityId: input.capabilityId,
					action: "lost_open_attempt",
					audience: actor.agentId,
					taskId: null,
					attemptGeneration: null,
				});
				updateEnvelope(
					tx,
					claimKey,
					claim,
					{ ...claim.data, state: "tombstoned" },
					ports.clock.nowIso(),
				);
				tx.cas(FENCE.activationCasActiveTerminal, {
					activationId: execution.activation_id,
				});
				tx.cas(FENCE.attemptCasActiveTerminal, {
					attemptId: binding.attempt_id,
					reason: "failed",
					terminalAt: ports.clock.nowIso(),
				});
				tx.cas(
					`UPDATE tasks SET state='ready',state_version=state_version+1,
					 terminal_at=NULL WHERE id=@taskId AND state='running'`,
					{ taskId: execution.task_id },
				);
				updateEnvelope(
					tx,
					agentBindingKey,
					agentBinding,
					{
						state: "clear",
						activation_id: null,
						attempt_id: null,
						session_ref_current: null,
						session_ref_last: execution.session_ref,
						host_epoch: null,
					},
					ports.clock.nowIso(),
				);
				updateEnvelope(
					tx,
					writerKey,
					writer,
					{
						...writer.data,
						chain_head: binding.resolution_head,
						open_attempt: null,
						span_author_set: [
							...new Set([
								...writer.data.span_author_set,
								binding.attribution_family,
							]),
						].sort(),
					},
					ports.clock.nowIso(),
				);
				const issue = readEnvelope<{ notify_agent_id: string }>(
					tx,
					`dag_issue:${execution.issue_id}`,
					epoch,
				);
				if (!issue) throw new DagContractError("lost-open issue is missing");
				const result = {
					status: "adopted" as const,
					worktreeId: binding.worktree_id,
				};
				appendEvent(tx, {
					eventUid,
					taskId: execution.task_id,
					attemptId: binding.attempt_id,
					kind: "lost_writer_span_adopted",
					sourceKind: "writer_gap",
					sourceId: input.adoptionUid,
					payload: receiptPayload(request, result),
					cutoverEpoch: epoch,
					createdAt: ports.clock.nowIso(),
				});
				appendMailboxTx(tx, {
					sourceKind: "lost_writer_span_adopted",
					sourceId: input.adoptionUid,
					toAgent: issue.data.notify_agent_id,
					kind: "lost_writer_span_adopted",
					payload: {
						attempt_id: binding.attempt_id,
						worktree_id: binding.worktree_id,
						resolution_head: binding.resolution_head,
					},
					retentionClass: "business",
					cutoverEpoch: epoch,
					createdAt: ports.clock.nowIso(),
				});
				return result;
			});
		},
	);
}

export async function adoptWriterGap(
	kernel: Kernel,
	ports: DagPorts,
	input: WriterGapAdoptionInput | LostOpenAdoptionInput,
): Promise<{
	status: "adopted" | "replayed";
	worktreeId: string;
}> {
	if (input.mode === "lost_open_attempt") {
		return await adoptLostOpenAttempt(kernel, ports, input);
	}
	const actor = requireLead(kernel, input.actor);
	const binding = gapBinding(input);
	const request: CanonicalValue = {
		adoption_uid: input.adoptionUid,
		capability_id: input.capabilityId,
		binding: binding as unknown as CanonicalValue,
		actor: {
			agent_id: actor.agentId,
			generation: actor.generation,
		},
	};
	const requestDigest = digestJson(request);
	const eventUid = `writer_gap_adopted:${input.adoptionUid}`;
	const replay = kernel.read((tx) =>
		readReceipt<{ status: "adopted"; worktreeId: string }>(
			tx,
			eventUid,
			requestDigest,
		),
	);
	if (replay) return { ...replay, status: "replayed" };
	const worktree = kernel.read((tx) =>
		readEnvelope<{ worktree_path: string }>(
			tx,
			`canonical_worktree:${input.worktreeId}`,
		),
	);
	if (!worktree) throw new DagContractError("canonical worktree is missing");
	const observed = await ports.git.readHead(worktree.data.worktree_path);
	if (
		observed !== input.toHead ||
		!(await ports.git.isAncestor(
			worktree.data.worktree_path,
			input.fromHead,
			input.toHead,
		))
	) {
		throw new DagContractError("writer gap world observation changed");
	}
	return kernel.write("v2dag.writer-gap.adopt", (tx) => {
		const raced = readReceipt<{ status: "adopted"; worktreeId: string }>(
			tx,
			eventUid,
			requestDigest,
		);
		if (raced) return { ...raced, status: "replayed" as const };
		const epoch = readCutoverEpoch(tx);
		const writerKey = `writer_chain:${binding.worktree_id}`;
		const writer = readEnvelope<WriterData>(tx, writerKey, epoch);
		const spanKey = `span_tip:${binding.worktree_id}`;
		const span = readEnvelope<SpanData>(tx, spanKey, epoch);
		if (
			!writer ||
			!span ||
			writer.data.open_attempt !== null ||
			writer.data.pending_gap?.from !== binding.from_head ||
			writer.data.pending_gap.to !== binding.to_head ||
			writer.data.chain_head !== binding.from_head ||
			span.data.head !== binding.from_head
		) {
			throw new DagConflictError("writer gap changed");
		}
		const subjectDigest = digestJson(binding as unknown as CanonicalValue);
		const capability = tx.get<{
			issuer: string;
			audience: string;
			action: string;
			subject_digest: string | null;
		}>(
			`SELECT issuer,audience,action,subject_digest
			   FROM capabilities WHERE id=@capabilityId`,
			{ capabilityId: input.capabilityId },
		);
		if (
			!capability ||
			capability.issuer !==
				`writer_gap:${binding.worktree_id}:${binding.from_head}:${binding.to_head}` ||
			capability.audience !== actor.agentId ||
			capability.action !== "adopt_writer_gap" ||
			capability.subject_digest !== subjectDigest
		) {
			throw new DagContractError("writer adoption capability is invalid");
		}
		tx.cas(FENCE.capabilityConsume, {
			now: ports.clock.nowIso(),
			capabilityId: input.capabilityId,
			action: "adopt_writer_gap",
			audience: actor.agentId,
			taskId: null,
			attemptGeneration: null,
		});
		updateEnvelope(
			tx,
			writerKey,
			writer,
			{
				...writer.data,
				chain_head: binding.to_head,
				pending_gap: null,
				span_author_set: [
					...new Set([
						...writer.data.span_author_set,
						binding.attribution_family,
					]),
				].sort(),
			},
			ports.clock.nowIso(),
		);
		const result = {
			status: "adopted" as const,
			worktreeId: binding.worktree_id,
		};
		appendEvent(tx, {
			eventUid,
			kind: "writer_gap_adopted",
			sourceKind: "writer_gap",
			sourceId: input.adoptionUid,
			payload: receiptPayload(request, result),
			cutoverEpoch: epoch,
			createdAt: ports.clock.nowIso(),
		});
		return result;
	});
}
