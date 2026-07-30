import { createHash, randomUUID } from "node:crypto";
import { FenceViolation, type Kernel } from "flywheel-v2-kernel";
import { readEngineConfigTx } from "./config.js";
import { ENGINE_SQL } from "./sql.js";
import { readCutoverEpochTx } from "./transitions.js";
import { type EngineRuntime, isSessionRecipient } from "./types.js";

export class CanonicalConflict extends Error {
	constructor(sourceKind: string, sourceId: string) {
		super(`canonical mailbox source conflicts: ${sourceKind}/${sourceId}`);
		this.name = "CanonicalConflict";
	}
}

export interface MailboxEnvelope {
	sourceKind: string;
	sourceId: string;
	payload: string;
	toAgent: string;
	kind: string;
	retentionClass: "notice" | "business" | "dlq";
	expectedCutoverEpoch: number;
}

export type EnqueueResult =
	| { status: "enqueued"; messageUid: string }
	| { status: "duplicate"; messageUid: string }
	| {
			status: "rejected";
			reason: "epoch_mismatch" | "unknown_recipient" | "overload";
	  };

export interface ProvisionedRecipient {
	agentId: string;
	kind: "lead" | "runner";
	generation: number;
	lastPollAt: string | null;
	state: "online" | "offline";
}

interface AgentRow {
	agent_id: string;
	kind: string;
	generation: number;
	last_poll_at: string | null;
	state: string;
}

function requireNonEmpty(value: string, name: string): void {
	if (value.trim().length === 0) {
		throw new TypeError(`${name} must not be empty`);
	}
}

function toProvisioned(row: AgentRow): ProvisionedRecipient {
	if (
		(row.kind !== "lead" && row.kind !== "runner") ||
		(row.state !== "online" && row.state !== "offline")
	) {
		throw new FenceViolation(`agent row ${row.agent_id} is malformed`);
	}
	return {
		agentId: row.agent_id,
		kind: row.kind,
		generation: row.generation,
		lastPollAt: row.last_poll_at,
		state: row.state,
	};
}

export function provisionAgentRecipient(
	kernel: Kernel,
	agentId: string,
	kind: "lead" | "runner",
): ProvisionedRecipient {
	requireNonEmpty(agentId, "agentId");
	// FLY-1543 ⑤: only leads live in the agents table. A runner recipient is an
	// active activations row and is never provisioned here.
	if (kind !== "lead") {
		throw new FenceViolation(
			"provisionAgentRecipient accepts lead recipients only",
		);
	}
	if (isSessionRecipient(agentId)) {
		throw new FenceViolation(
			"lead recipient must not use the v2dag: session namespace",
		);
	}
	return kernel.write("mailbox.provision-recipient", (tx) => {
		tx.run(ENGINE_SQL.insertProvisionedAgent, { agentId, kind });
		const row = tx.get<AgentRow>(ENGINE_SQL.readAgent, { agentId });
		if (!row || row.kind !== kind) {
			throw new FenceViolation(`agent kind collision for ${agentId}`);
		}
		return toProvisioned(row);
	});
}

export function enqueue(
	kernel: Kernel,
	runtime: EngineRuntime,
	envelope: MailboxEnvelope,
): EnqueueResult {
	for (const [name, value] of [
		["sourceKind", envelope.sourceKind],
		["sourceId", envelope.sourceId],
		["toAgent", envelope.toAgent],
		["kind", envelope.kind],
	] as const) {
		requireNonEmpty(value, name);
	}
	if (
		!Number.isSafeInteger(envelope.expectedCutoverEpoch) ||
		envelope.expectedCutoverEpoch <= 0
	) {
		throw new TypeError(
			"expectedCutoverEpoch is required and must be positive",
		);
	}
	const payloadDigest = createHash("sha256")
		.update(envelope.payload)
		.digest("hex");
	const messageUid = randomUUID();

	return kernel.write("mailbox.enqueue", (tx) => {
		const cutoverEpoch = readCutoverEpochTx(tx);
		if (cutoverEpoch !== envelope.expectedCutoverEpoch) {
			return { status: "rejected", reason: "epoch_mismatch" };
		}
		// FLY-1543 ⑤: recipient namespaces. `v2dag:` names an active session
		// (activations row); anything else must be a lead. A tombstoned runner
		// role name is deliberately NOT a recipient any more -- mail addressed to
		// it would be a permanent dead letter.
		if (isSessionRecipient(envelope.toAgent)) {
			const activation = tx.get<{ state: string }>(
				ENGINE_SQL.readActiveActivationBySessionRef,
				{ sessionRef: envelope.toAgent },
			);
			if (!activation) {
				return { status: "rejected", reason: "unknown_recipient" };
			}
		} else {
			const agent = tx.get<AgentRow>(ENGINE_SQL.readAgent, {
				agentId: envelope.toAgent,
			});
			if (!agent || agent.kind !== "lead") {
				return { status: "rejected", reason: "unknown_recipient" };
			}
		}
		if (envelope.retentionClass === "notice") {
			const config = readEngineConfigTx(tx);
			const count =
				tx.get<{ count: number }>(ENGINE_SQL.countPendingForRecipient, {
					agent: envelope.toAgent,
					probeLimit: config.noticePendingLimit + 1,
				})?.count ?? 0;
			if (count > config.noticePendingLimit) {
				return { status: "rejected", reason: "overload" };
			}
		}

		try {
			tx.run(ENGINE_SQL.insertMailbox, {
				messageUid,
				sourceKind: envelope.sourceKind,
				sourceId: envelope.sourceId,
				payload: envelope.payload,
				payloadDigest,
				toAgent: envelope.toAgent,
				kind: envelope.kind,
				retentionClass: envelope.retentionClass,
				cutoverEpoch,
				createdAt: runtime.clock.nowIso(),
			});
			return { status: "enqueued", messageUid };
		} catch (error) {
			const existing = tx.get<{
				message_uid: string;
				payload_digest: string;
				to_agent: string;
				kind: string;
				retention_class: string;
			}>(ENGINE_SQL.readMailboxByCanonicalSource, {
				sourceKind: envelope.sourceKind,
				sourceId: envelope.sourceId,
			});
			if (!existing) {
				throw error;
			}
			if (
				existing.payload_digest !== payloadDigest ||
				existing.to_agent !== envelope.toAgent ||
				existing.kind !== envelope.kind ||
				existing.retention_class !== envelope.retentionClass
			) {
				throw new CanonicalConflict(envelope.sourceKind, envelope.sourceId);
			}
			return { status: "duplicate", messageUid: existing.message_uid };
		}
	});
}
