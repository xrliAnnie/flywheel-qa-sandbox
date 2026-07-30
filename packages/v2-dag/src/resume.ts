import { randomUUID } from "node:crypto";
import { FENCE, type Kernel } from "flywheel-v2-kernel";
import { parseTaskPayload } from "./contract.js";
import { appendTaskAssignmentTx, claimLaunch, launchOnce } from "./dispatch.js";
import { DagConflictError, DagContractError } from "./errors.js";
import { appendEvent } from "./events.js";
import {
	insertEnvelope,
	makeEnvelope,
	readCutoverEpoch,
	readEnvelope,
	updateEnvelope,
} from "./meta.js";
import { terminalizeSessionMailboxTx } from "./terminal-mail.js";
import type { DagPorts, SpawnRequest } from "./types.js";

interface ClaimData {
	state: "pending" | "claimed" | "launched" | "tombstoned";
	owner_token: string | null;
	lease_until: string | null;
	launch_receipt: unknown;
}

/**
 * FLY-1543 ①⑤: resume takes no death evidence. The liveness check below (the
 * session process must be POSITIVELY absent -- a present or unprobeable session
 * refuses the resume) is kept: it probes the old session directly, which is a
 * forward-looking safety check, not an evidence ceremony. The superseded
 * activation's pending mail is dead-lettered and a fresh assignment is written
 * to the NEW session, so the replacement runner starts from a clean, complete
 * envelope.
 */
export async function resumeActivation(
	kernel: Kernel,
	ports: DagPorts,
	input: { attemptId: string },
): Promise<SpawnRequest> {
	const current = kernel.read((tx) => {
		const row = tx.get<{
			task_id: string;
			generation: number;
			desired_state: string;
			activation_id: string;
			session_ref: string;
			payload: string;
		}>(
			`SELECT a.task_id,a.generation,a.desired_state,
			        act.id AS activation_id,act.session_ref,t.payload
			   FROM attempts a
			   JOIN activations act ON act.attempt_id=a.id AND act.state='active'
			   JOIN tasks t ON t.id=a.task_id
			  WHERE a.id=@attemptId`,
			{ attemptId: input.attemptId },
		);
		if (!row || row.desired_state === "terminal") {
			throw new DagContractError("attempt cannot resume");
		}
		return row;
	});
	const prepared = await ports.locks.withSessionLock(
		current.session_ref,
		async () => {
			const fresh = await ports.process.probe(current.session_ref);
			if (fresh.state !== "absent") {
				throw new DagContractError("resume requires an absent session process");
			}
			return kernel.write("v2dag.activation.resume", (tx) => {
				const epoch = readCutoverEpoch(tx);
				const row = tx.get<{
					task_id: string;
					generation: number;
					desired_state: string;
					activation_id: string;
					session_ref: string;
					kind: string;
					payload: string;
				}>(
					`SELECT a.task_id,a.generation,a.desired_state,
				        act.id AS activation_id,act.session_ref,t.kind,t.payload
				   FROM attempts a
				   JOIN activations act ON act.attempt_id=a.id AND act.state='active'
				   JOIN tasks t ON t.id=a.task_id
				  WHERE a.id=@attemptId`,
					{ attemptId: input.attemptId },
				);
				if (
					!row ||
					row.desired_state === "terminal" ||
					row.activation_id !== current.activation_id ||
					row.session_ref !== current.session_ref
				) {
					throw new DagContractError("active activation changed");
				}
				const payload = parseTaskPayload(JSON.parse(row.payload));
				const oldClaim = readEnvelope<ClaimData>(
					tx,
					`launch_claim:${row.session_ref}`,
					epoch,
				);
				if (!oldClaim || oldClaim.data.state === "tombstoned") {
					throw new DagContractError("resume claim is stale");
				}
				updateEnvelope(
					tx,
					`launch_claim:${row.session_ref}`,
					oldClaim,
					{ ...oldClaim.data, state: "tombstoned" },
					ports.clock.nowIso(),
				);
				tx.cas(FENCE.activationCasActiveTerminal, {
					activationId: row.activation_id,
				});
				terminalizeSessionMailboxTx(tx, {
					sessionRef: row.session_ref,
					cutoverEpoch: epoch,
					nowIso: ports.clock.nowIso(),
				});
				const activationId = randomUUID();
				const sessionRef = `v2dag:${input.attemptId}:${row.generation}:${activationId}`;
				tx.run(
					`INSERT INTO activations(id,attempt_id,session_ref,generation,state)
				 VALUES(@activationId,@attemptId,@sessionRef,@generation,'active')`,
					{
						activationId,
						attemptId: input.attemptId,
						sessionRef,
						generation: row.generation,
					},
				);
				const agent = {
					kind: "runner" as const,
					agentId: sessionRef,
					instanceId: sessionRef,
					generation: row.generation,
					activationId,
				};
				insertEnvelope(
					tx,
					`launch_claim:${sessionRef}`,
					makeEnvelope<ClaimData>(epoch, {
						state: "pending",
						owner_token: null,
						lease_until: null,
						launch_receipt: null,
					}),
					ports.clock.nowIso(),
				);
				const request: SpawnRequest = {
					taskId: row.task_id,
					attemptId: input.attemptId,
					attemptGeneration: row.generation,
					activationId,
					sessionRef,
					ownerToken: "",
					agent,
					taskKind: row.kind,
					executor: payload.executor,
				};
				// The replacement session gets its own assignment envelope, keyed on
				// the NEW activation id -- the dead session's row was just settled.
				appendTaskAssignmentTx(tx, ports, request);
				appendEvent(tx, {
					eventUid: `activation_resumed:${activationId}`,
					taskId: row.task_id,
					attemptId: input.attemptId,
					kind: "activation_resumed",
					sourceKind: "resume",
					sourceId: activationId,
					payload: {
						activation_id: activationId,
						session_ref: sessionRef,
						agent_generation: agent.generation,
					},
					cutoverEpoch: epoch,
					createdAt: ports.clock.nowIso(),
				});
				return request;
			});
		},
	);
	const claimed = await claimLaunch(kernel, ports, prepared);
	const launched = await launchOnce(kernel, ports, claimed);
	if (!launched) {
		throw new DagConflictError("resume launch claim changed before spawn");
	}
	if (launched.kind !== "runner") {
		throw new DagConflictError("resume registered a non-runner agent");
	}
	return { ...claimed, agent: launched };
}
