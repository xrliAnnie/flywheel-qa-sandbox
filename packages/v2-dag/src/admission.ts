import type { Kernel } from "flywheel-v2-kernel";
import { taskPayloadFromDescriptor, taskPayloadJson } from "./contract.js";
import type { CanonicalValue } from "./digests.js";
import { canonicalJson, digestJson, sha256 } from "./digests.js";
import { DagConflictError, DagContractError } from "./errors.js";
import { appendEvent, readReceipt, receiptPayload } from "./events.js";
import type { ReviewFamilies } from "./families.js";
import {
	insertEnvelope,
	makeEnvelope,
	readCutoverEpoch,
	readEnvelope,
} from "./meta.js";
import { appendLifecycleTx } from "./outbox.js";
import type { AdmissionResult, DagPorts, IssueDagDescriptor } from "./types.js";

const MAX_TASKS = 500;

function requiredText(value: string, label: string): void {
	if (value.trim().length === 0)
		throw new DagContractError(`${label} is empty`);
}

function validateGraph(descriptor: IssueDagDescriptor): void {
	for (const [label, value] of [
		["admissionUid", descriptor.admissionUid],
		["projectId", descriptor.projectId],
		["issueId", descriptor.issueId],
		["notifyAgentId", descriptor.notifyAgentId],
		["shipWorktreeId", descriptor.shipWorktreeId],
	] as const) {
		requiredText(value, label);
	}
	if (descriptor.tasks.length === 0 || descriptor.tasks.length > MAX_TASKS) {
		throw new DagContractError(`task count must be between 1 and ${MAX_TASKS}`);
	}
	const localIds = new Set<string>();
	for (const task of descriptor.tasks) {
		requiredText(task.localId, "task.localId");
		requiredText(task.kindLabel, "task.kindLabel");
		if (localIds.has(task.localId)) {
			throw new DagContractError(`duplicate task ${task.localId}`);
		}
		localIds.add(task.localId);
		taskPayloadFromDescriptor(task);
	}
	const worktreeIds = new Set(
		descriptor.worktrees.map((item) => item.worktreeId),
	);
	for (const worktree of descriptor.worktrees) {
		for (const [label, value] of [
			["worktreeId", worktree.worktreeId],
			["repoIdentity", worktree.repoIdentity],
			["worktreePath", worktree.worktreePath],
			["branchRef", worktree.branchRef],
			["mergeTargetRef", worktree.mergeTargetRef],
		] as const) {
			requiredText(value, label);
		}
	}
	if (
		worktreeIds.size !== descriptor.worktrees.length ||
		!worktreeIds.has(descriptor.shipWorktreeId)
	) {
		throw new DagContractError("worktree identities are invalid");
	}
	for (const task of descriptor.tasks) {
		if (task.worktreeId !== null && !worktreeIds.has(task.worktreeId)) {
			throw new DagContractError(`unknown worktree ${task.worktreeId}`);
		}
	}
	const incoming = new Map<string, number>([...localIds].map((id) => [id, 0]));
	const outgoing = new Map<string, string[]>(
		[...localIds].map((id) => [id, []]),
	);
	const edges = new Set<string>();
	for (const [from, to] of descriptor.edges) {
		if (!localIds.has(from) || !localIds.has(to) || from === to) {
			throw new DagContractError("edge endpoint is invalid");
		}
		const key = `${from}\0${to}`;
		if (edges.has(key)) throw new DagContractError("duplicate edge");
		edges.add(key);
		incoming.set(to, (incoming.get(to) ?? 0) + 1);
		outgoing.get(from)?.push(to);
	}
	const queue = [...incoming]
		.filter(([, count]) => count === 0)
		.map(([id]) => id)
		.sort();
	let visited = 0;
	while (queue.length > 0) {
		const current = queue.shift();
		if (current === undefined) break;
		visited += 1;
		for (const next of outgoing.get(current) ?? []) {
			const count = (incoming.get(next) ?? 0) - 1;
			incoming.set(next, count);
			if (count === 0) queue.push(next);
		}
		queue.sort();
	}
	if (visited !== descriptor.tasks.length) {
		throw new DagContractError("task graph contains a cycle");
	}
}

function descriptorRequest(descriptor: IssueDagDescriptor): CanonicalValue {
	return descriptor as unknown as CanonicalValue;
}

export async function admitIssueDag(
	kernel: Kernel,
	ports: DagPorts,
	descriptor: IssueDagDescriptor,
): Promise<AdmissionResult> {
	validateGraph(descriptor);
	const request = descriptorRequest(descriptor);
	const requestDigest = digestJson(request);
	const receiptUid = `admission:${descriptor.admissionUid}`;
	const replay = kernel.read((tx) =>
		readReceipt<AdmissionResult>(tx, receiptUid, requestDigest),
	);
	if (replay) return { ...replay, status: "replayed" };

	const observations = await Promise.all(
		descriptor.worktrees.map(async (worktree) => {
			const [head, anchor] = await Promise.all([
				ports.git.readHead(worktree.worktreePath),
				ports.git.mergeBase(worktree.worktreePath, worktree.mergeTargetRef),
			]);
			return { worktree, head, anchor };
		}),
	);
	const taskIds = Object.fromEntries(
		descriptor.tasks.map((task) => [
			task.localId,
			`task:${sha256(`${descriptor.admissionUid}:${task.localId}`)}`,
		]),
	);
	const result: AdmissionResult = {
		status: "admitted",
		issueId: descriptor.issueId,
		taskIds,
	};

	return kernel.write("v2dag.admit", (tx) => {
		const raced = readReceipt<AdmissionResult>(tx, receiptUid, requestDigest);
		if (raced) return { ...raced, status: "replayed" };
		const epoch = readCutoverEpoch(tx);
		const now = ports.clock.nowIso();
		// FLY-1543 ⑤: the notify recipient must be a LEAD row. Runner rows are
		// offline tombstones after the cutover; mail addressed to one would be a
		// permanent dead letter, and the mailbox recipient trigger would refuse it
		// later with a less useful error.
		const notify = tx.get<{ agent_id: string; kind: string }>(
			"SELECT agent_id,kind FROM agents WHERE agent_id=@agentId",
			{ agentId: descriptor.notifyAgentId },
		);
		if (!notify || notify.kind !== "lead") {
			throw new DagContractError("notify agent is unknown");
		}
		const familyAuthority = readEnvelope<ReviewFamilies>(
			tx,
			`review_families:${descriptor.projectId}`,
			epoch,
		);
		if (familyAuthority) {
			for (const task of descriptor.tasks) {
				if (
					!Object.hasOwn(familyAuthority.data.families, task.executor.family)
				) {
					throw new DagContractError(
						`executor family ${task.executor.family} is not authoritative`,
					);
				}
			}
		}
		// FLY-1544 ①: no executor ledger validation here. The instruction book
		// hangs off the node kind (tasks.kind -> .flywheel/agents/nodes/); a
		// missing node instruction file fails closed at dispatch, inside
		// resolveRoleInstruction.
		if (readEnvelope(tx, `dag_issue:${descriptor.issueId}`, epoch)) {
			throw new DagConflictError(
				`issue ${descriptor.issueId} is already admitted`,
			);
		}
		// FLY-1543 ⑥: a worktree whose head is ahead of its merge-base anchor
		// carries unauthenticated commits. Admitting it used to bury a
		// pending_gap in the writer chain plus an event nobody consumed, and the
		// worktree's writes_repo tasks were then silently never dispatched.
		// Refuse the whole admission instead: the transaction aborts with ZERO
		// writes, the operator sees the exact worktree and heads, fixes the tree
		// (merge the commits or use a clean worktree) and re-admits.
		for (const observation of observations) {
			if (observation.head !== observation.anchor) {
				throw new DagContractError(
					`worktree ${observation.worktree.worktreeId} has unauthenticated commits: ` +
						`head ${observation.head} is ahead of anchor ${observation.anchor} ` +
						`(issue ${descriptor.issueId})`,
				);
			}
		}
		for (const observation of observations) {
			const { worktree, anchor } = observation;
			insertEnvelope(
				tx,
				`canonical_worktree:${worktree.worktreeId}`,
				makeEnvelope(epoch, {
					repo_identity: worktree.repoIdentity,
					worktree_path: worktree.worktreePath,
					branch_ref: worktree.branchRef,
					merge_target_ref: worktree.mergeTargetRef,
					initial_anchor: anchor,
				}),
				now,
			);
			insertEnvelope(
				tx,
				`span_tip:${worktree.worktreeId}`,
				makeEnvelope(epoch, {
					head: anchor,
					updated_by_attempt: null,
				}),
				now,
			);
			insertEnvelope(
				tx,
				`writer_chain:${worktree.worktreeId}`,
				makeEnvelope(epoch, {
					chain_head: anchor,
					open_attempt: null,
					span_author_set: [],
					// Admission refuses a dirty worktree above, so the seed is
					// constant null; dispatch keeps its pending_gap guard as a ledger
					// invariant.
					pending_gap: null,
				}),
				now,
			);
		}
		for (const task of descriptor.tasks) {
			const id = taskIds[task.localId];
			if (id === undefined)
				throw new DagContractError("task mapping is missing");
			const payload = taskPayloadFromDescriptor(task);
			tx.run(
				`INSERT INTO tasks
				 (id,project_id,external_issue_id,kind,state,payload,lineage_root_id,created_at)
				 VALUES(@id,@projectId,@issueId,@kind,'ready',@payload,@id,@now)`,
				{
					id,
					projectId: descriptor.projectId,
					issueId: descriptor.issueId,
					kind: task.kindLabel,
					payload: canonicalJson(taskPayloadJson(payload)),
					now,
				},
			);
		}
		for (const [from, to] of descriptor.edges) {
			tx.run(
				`INSERT INTO task_dependencies
				 (task_id,blocked_by_task_id,condition,created_at)
				 VALUES(@taskId,@blockedBy,NULL,@now)`,
				{
					taskId: taskIds[to],
					blockedBy: taskIds[from],
					now,
				},
			);
		}
		insertEnvelope(
			tx,
			`dag_issue:${descriptor.issueId}`,
			makeEnvelope(epoch, {
				admission_uid: descriptor.admissionUid,
				notify_agent_id: descriptor.notifyAgentId,
				ship_worktree_id: descriptor.shipWorktreeId,
				task_ids: descriptor.tasks.map(
					(task) => taskIds[task.localId] as string,
				),
				worktree_ids: descriptor.worktrees.map((item) => item.worktreeId),
			}),
			now,
		);
		appendEvent(tx, {
			eventUid: receiptUid,
			kind: "dag_admitted",
			sourceKind: "admission",
			sourceId: descriptor.admissionUid,
			payload: receiptPayload(request, result as unknown as CanonicalValue),
			cutoverEpoch: epoch,
			createdAt: now,
		});
		// FLY-1544 ③: issue intake opens the `[FLY-XXXX]` Discord thread.
		appendLifecycleTx(tx, {
			sourceKind: "dag_issue_opened",
			sourceId: descriptor.admissionUid,
			kind: "issue_opened",
			issueId: descriptor.issueId,
			payload: {
				project_id: descriptor.projectId,
				task_kinds: descriptor.tasks.map((task) => task.kindLabel),
			},
			cutoverEpoch: epoch,
			createdAt: now,
		});
		return result;
	});
}
