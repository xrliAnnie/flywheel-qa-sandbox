import { randomUUID } from "node:crypto";
import { type DeathEvidence, registerAgentTx } from "flywheel-v2-engine";
import { FENCE, type Kernel } from "flywheel-v2-kernel";
import { parseTaskPayload } from "./contract.js";
import { claimLaunch, launchOnce } from "./dispatch.js";
import { DagConflictError, DagContractError } from "./errors.js";
import { appendEvent } from "./events.js";
import {
	insertEnvelope,
	makeEnvelope,
	readCutoverEpoch,
	readEnvelope,
	updateEnvelope,
} from "./meta.js";
import type { DagPorts, SpawnRequest } from "./types.js";

interface BindingData {
	state: "active" | "clear";
	activation_id: string | null;
	attempt_id: string | null;
	session_ref_current: string | null;
	session_ref_last: string | null;
	host_epoch: string | null;
}

interface ClaimData {
	state: "pending" | "claimed" | "launched" | "tombstoned";
	owner_token: string | null;
	lease_until: string | null;
	launch_receipt: unknown;
}

export async function resumeActivation(
	kernel: Kernel,
	ports: DagPorts,
	input: { attemptId: string; evidence: DeathEvidence },
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
				throw new DagContractError("resume death evidence is not fresh");
			}
			const freshEvidence: DeathEvidence = {
				...input.evidence,
				confirmedAbsentAt: fresh.confirmedAt,
			};
			return kernel.write("v2dag.activation.resume", (tx) => {
				const epoch = readCutoverEpoch(tx);
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
				if (
					!row ||
					row.desired_state === "terminal" ||
					row.activation_id !== current.activation_id ||
					row.session_ref !== current.session_ref
				) {
					throw new DagContractError("active activation changed");
				}
				const payload = parseTaskPayload(JSON.parse(row.payload));
				const bindingKey = `agent_binding:${payload.executor.logicalAgentId}`;
				const binding = readEnvelope<BindingData>(tx, bindingKey, epoch);
				if (
					!binding ||
					binding.data.state !== "active" ||
					binding.data.attempt_id !== input.attemptId ||
					binding.data.activation_id !== row.activation_id ||
					binding.data.session_ref_current !== row.session_ref
				) {
					throw new DagContractError("resume binding changed");
				}
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
				const agent = registerAgentTx(
					tx,
					{ clock: ports.clock },
					payload.executor.logicalAgentId,
					{
						kind: "runner",
						agentId: payload.executor.logicalAgentId,
						instanceId: sessionRef,
						activationId,
					},
					freshEvidence,
				);
				updateEnvelope(
					tx,
					bindingKey,
					binding,
					{
						state: "active",
						activation_id: activationId,
						attempt_id: input.attemptId,
						session_ref_current: sessionRef,
						session_ref_last: row.session_ref,
						host_epoch: ports.host.hostEpoch(),
					},
					ports.clock.nowIso(),
				);
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
				return {
					taskId: row.task_id,
					attemptId: input.attemptId,
					attemptGeneration: row.generation,
					activationId,
					sessionRef,
					ownerToken: "",
					agent,
					executor: payload.executor,
				} satisfies SpawnRequest;
			});
		},
	);
	const claimed = await claimLaunch(kernel, ports, prepared);
	if (!(await launchOnce(kernel, ports, claimed))) {
		throw new DagConflictError("resume launch claim changed before spawn");
	}
	return claimed;
}
