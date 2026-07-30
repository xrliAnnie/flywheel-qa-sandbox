import type { Kernel, ReadTx } from "flywheel-v2-kernel";
import { terminalizeAttemptTx } from "./attempt-terminal.js";
import { parseTaskPayload, type TaskPayload } from "./contract.js";
import type { CanonicalValue } from "./digests.js";
import { digestJson } from "./digests.js";
import { dispatchOnce } from "./dispatch.js";
import { DagConflictError, DagContractError } from "./errors.js";
import { appendEvent, readReceipt, receiptPayload } from "./events.js";
import type { IssueReceiptData, ShipGateData } from "./gate.js";
import { readCutoverEpoch, readEnvelope, updateEnvelope } from "./meta.js";
import type { DagPorts, SpawnRequest } from "./types.js";

export type ReworkResult =
	| {
			status: "reworked";
			taskId: string;
			dispatch: SpawnRequest | null;
	  }
	| { status: "awaiting_quiescence"; taskId: string; dispatch: null };

interface ActiveSuite {
	taskId: string;
	attemptId: string;
	attemptGeneration: number;
	activationId: string;
	sessionRef: string;
	payload: TaskPayload;
	claimRevision: number;
}

interface WriterPacket {
	worktreeId: string;
	head: string;
	writerRevision: number;
}

interface ClaimData {
	state: "pending" | "claimed" | "launched" | "tombstoned";
	owner_token: string | null;
	lease_until: string | null;
	launch_receipt: unknown;
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

function affectedTaskIds(kernel: Kernel, taskId: string): string[] {
	return kernel.read((tx) =>
		tx
			.all<{ id: string }>(
				`WITH RECURSIVE affected(id) AS (
				   SELECT @taskId
				   UNION
				   SELECT d.task_id FROM task_dependencies d
				   JOIN affected a ON d.blocked_by_task_id=a.id
				 )
				 SELECT id FROM affected ORDER BY id`,
				{ taskId },
			)
			.map((row) => row.id),
	);
}

function activeSuitesTx(tx: ReadTx, taskIds: string[]): ActiveSuite[] {
	if (taskIds.length === 0) return [];
	const epoch = readCutoverEpoch(tx);
	return taskIds.flatMap((taskId) => {
		const row = tx.get<{
			attempt_id: string;
			attempt_generation: number;
			activation_id: string;
			session_ref: string;
			payload: string;
		}>(
			`SELECT a.id AS attempt_id,a.generation AS attempt_generation,
				        act.id AS activation_id,act.session_ref,t.payload
				   FROM attempts a
				   JOIN activations act ON act.attempt_id=a.id AND act.state='active'
				   JOIN tasks t ON t.id=a.task_id
				  WHERE a.task_id=@taskId AND a.desired_state<>'terminal'`,
			{ taskId },
		);
		if (!row) return [];
		const claim = readEnvelope<ClaimData>(
			tx,
			`launch_claim:${row.session_ref}`,
			epoch,
		);
		if (!claim || claim.data.state === "tombstoned") {
			throw new DagContractError("active suite has no live launch claim");
		}
		return [
			{
				taskId,
				attemptId: row.attempt_id,
				attemptGeneration: row.attempt_generation,
				activationId: row.activation_id,
				sessionRef: row.session_ref,
				payload: parseTaskPayload(JSON.parse(row.payload)),
				claimRevision: claim.revision,
			},
		];
	});
}

function activeSuites(kernel: Kernel, taskIds: string[]): ActiveSuite[] {
	return kernel.read((tx) => activeSuitesTx(tx, taskIds));
}

function sameSuites(left: ActiveSuite[], right: ActiveSuite[]): boolean {
	return (
		left.length === right.length &&
		left.every(
			(item, index) =>
				item.attemptId === right[index]?.attemptId &&
				item.activationId === right[index]?.activationId &&
				item.sessionRef === right[index]?.sessionRef &&
				item.claimRevision === right[index]?.claimRevision,
		)
	);
}

async function withSessionLocks<T>(
	ports: DagPorts,
	sessionRefs: string[],
	fn: () => Promise<T>,
	index = 0,
): Promise<T> {
	const sessionRef = sessionRefs[index];
	if (sessionRef === undefined) return await fn();
	return await ports.locks.withSessionLock(sessionRef, async () =>
		withSessionLocks(ports, sessionRefs, fn, index + 1),
	);
}

async function writerPackets(
	kernel: Kernel,
	ports: DagPorts,
	suites: ActiveSuite[],
): Promise<WriterPacket[]> {
	const snapshots = kernel.read((tx) => {
		const epoch = readCutoverEpoch(tx);
		return suites.flatMap((suite) => {
			if (!suite.payload.writes_repo || !suite.payload.worktree_id) return [];
			const worktree = readEnvelope<{ worktree_path: string }>(
				tx,
				`canonical_worktree:${suite.payload.worktree_id}`,
				epoch,
			);
			const writer = readEnvelope<WriterData>(
				tx,
				`writer_chain:${suite.payload.worktree_id}`,
				epoch,
			);
			if (
				!worktree ||
				!writer ||
				writer.data.open_attempt?.attempt_id !== suite.attemptId ||
				writer.data.open_attempt.generation !== suite.attemptGeneration
			) {
				throw new DagContractError("active writer suite is stale");
			}
			return [
				{
					worktreeId: suite.payload.worktree_id,
					worktreePath: worktree.data.worktree_path,
					writerRevision: writer.revision,
					startHead: writer.data.open_attempt.start_head,
				},
			];
		});
	});
	return await Promise.all(
		snapshots.map(async (snapshot) => {
			const head = await ports.git.readHead(snapshot.worktreePath);
			if (
				!(await ports.git.isAncestor(
					snapshot.worktreePath,
					snapshot.startHead,
					head,
				))
			) {
				throw new DagContractError("active writer head diverged");
			}
			return {
				worktreeId: snapshot.worktreeId,
				head,
				writerRevision: snapshot.writerRevision,
			};
		}),
	);
}

export async function reworkTask(
	kernel: Kernel,
	ports: DagPorts,
	input: { issueId: string; taskId: string; reworkUid: string },
): Promise<ReworkResult> {
	const request = {
		issue_id: input.issueId,
		task_id: input.taskId,
		rework_uid: input.reworkUid,
	} satisfies CanonicalValue;
	const requestDigest = digestJson(request);
	const receiptUid = `task_reworked:${input.reworkUid}`;
	const replay = kernel.read((tx) =>
		readReceipt<{ status: "reworked"; taskId: string }>(
			tx,
			receiptUid,
			requestDigest,
		),
	);
	if (!replay) {
		const affected = affectedTaskIds(kernel, input.taskId);
		const suites = activeSuites(kernel, affected);
		for (const suite of suites) {
			await ports.runnerControl.requestStop(suite.sessionRef);
		}
		const sessionRefs = suites.map((suite) => suite.sessionRef).sort();
		const settled = await withSessionLocks(ports, sessionRefs, async () => {
			const lockedSuites = activeSuites(kernel, affected);
			if (!sameSuites(suites, lockedSuites)) return "retry" as const;
			for (const suite of lockedSuites) {
				const probe = await ports.process.probe(suite.sessionRef);
				if (probe.state !== "absent") return "awaiting" as const;
			}
			const packets = await writerPackets(kernel, ports, lockedSuites);
			kernel.write("v2dag.task.rework", (tx) => {
				const raced = readReceipt<{ status: "reworked"; taskId: string }>(
					tx,
					receiptUid,
					requestDigest,
				);
				if (raced) return;
				const epoch = readCutoverEpoch(tx);
				const issue = readEnvelope<IssueReceiptData>(
					tx,
					`dag_issue:${input.issueId}`,
					epoch,
				);
				if (!issue || !issue.data.task_ids.includes(input.taskId)) {
					throw new DagContractError("rework task is outside the admitted DAG");
				}
				const incomingOpen = tx.get<{ count: number }>(
					`SELECT count(*) AS count
				   FROM task_dependencies d
				   JOIN tasks upstream ON upstream.id=d.blocked_by_task_id
				  WHERE d.task_id=@taskId AND upstream.state<>'done'`,
					{ taskId: input.taskId },
				)?.count;
				if ((incomingOpen ?? 0) !== 0) {
					throw new DagContractError("rework task prerequisites are not done");
				}
				const currentSuites = activeSuitesTx(tx, affected);
				if (!sameSuites(lockedSuites, currentSuites)) {
					throw new DagContractError("rework active suite changed");
				}
				for (const suite of lockedSuites) {
					const claimKey = `launch_claim:${suite.sessionRef}`;
					const claim = readEnvelope<ClaimData>(tx, claimKey, epoch);
					if (
						!claim ||
						claim.revision !== suite.claimRevision ||
						claim.data.state === "tombstoned"
					) {
						throw new DagContractError("rework launch claim changed");
					}
					if (suite.payload.writes_repo && suite.payload.worktree_id) {
						const packet = packets.find(
							(item) => item.worktreeId === suite.payload.worktree_id,
						);
						const writerKey = `writer_chain:${suite.payload.worktree_id}`;
						const writer = readEnvelope<WriterData>(tx, writerKey, epoch);
						const span = readEnvelope<{
							head: string;
							updated_by_attempt: string | null;
						}>(tx, `span_tip:${suite.payload.worktree_id}`, epoch);
						if (
							!packet ||
							!writer ||
							!span ||
							writer.revision !== packet.writerRevision ||
							writer.data.open_attempt?.attempt_id !== suite.attemptId
						) {
							throw new DagContractError("rework writer packet changed");
						}
						updateEnvelope(
							tx,
							writerKey,
							writer,
							{
								...writer.data,
								chain_head: packet.head,
								open_attempt: null,
								span_author_set: [
									...new Set([
										...writer.data.span_author_set,
										...(packet.head === writer.data.open_attempt.start_head
											? []
											: [writer.data.open_attempt.family]),
									]),
								].sort(),
							},
							ports.clock.nowIso(),
						);
					}
					terminalizeAttemptTx(tx, {
						attemptId: suite.attemptId,
						reason: "superseded",
						cutoverEpoch: epoch,
						nowIso: ports.clock.nowIso(),
					});
				}
				for (const id of affected) {
					tx.run(
						`UPDATE tasks SET state='ready',state_version=state_version+1,
					 terminal_at=NULL WHERE id=@id AND state IN ('done','running')`,
						{ id },
					);
				}
				const gateKey = `ship_gate:${input.issueId}`;
				const gate = readEnvelope<ShipGateData>(tx, gateKey, epoch);
				if (gate?.data.settled) {
					throw new DagConflictError("settled ship authority cannot rework");
				}
				if (gate?.data.target) {
					const inFlight = tx.get<{ count: number }>(
						`SELECT count(*) AS count FROM actions
							  WHERE kind='github_merge'
							    AND json_extract(payload,'$.repo')=@repo
							    AND json_extract(payload,'$.pr')=@pr
							    AND json_extract(payload,'$.head')=@head
							    AND state='intended'`,
						{
							repo: gate.data.target.repo,
							pr: gate.data.target.pr,
							head: gate.data.target.head,
						},
					)?.count;
					if ((inFlight ?? 0) !== 0) {
						throw new DagConflictError("ship effect is in flight");
					}
				}
				if (
					gate &&
					gate.data.settled === null &&
					gate.data.state !== "expired"
				) {
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
					updateEnvelope(
						tx,
						gateKey,
						gate,
						{
							...gate.data,
							state: "expired",
							capability_id: null,
							retry: { ...gate.data.retry, next_retry_at: null },
						},
						ports.clock.nowIso(),
					);
				}
				const result = { status: "reworked" as const, taskId: input.taskId };
				appendEvent(tx, {
					eventUid: receiptUid,
					taskId: input.taskId,
					kind: "task_reworked",
					sourceKind: "rework",
					sourceId: input.reworkUid,
					payload: receiptPayload(request, result as unknown as CanonicalValue),
					cutoverEpoch: epoch,
					createdAt: ports.clock.nowIso(),
				});
			});
			return "settled" as const;
		});
		if (settled === "retry") {
			return await reworkTask(kernel, ports, input);
		}
		if (settled === "awaiting") {
			return {
				status: "awaiting_quiescence",
				taskId: input.taskId,
				dispatch: null,
			};
		}
	}
	const dispatched = await dispatchOnce(kernel, ports);
	return {
		status: "reworked",
		taskId: input.taskId,
		dispatch:
			dispatched.dispatched.find((item) => item.taskId === input.taskId) ??
			null,
	};
}
