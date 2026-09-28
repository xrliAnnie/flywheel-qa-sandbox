/** FLY-1373 backend-specific durable batch handoff. */

import {
	MailboxBatchConflictError,
	type MailboxBatchMember,
	writeMailboxBatch,
} from "flywheel-agent-team-transport";
import {
	type CodexLeadInboxCapabilities,
	CodexLeadInboxRejectedError,
	LEAD_INTERRUPT_STEER_FEATURE,
	probeCodexLeadInboxCapabilities,
	resolveCodexLeadInboxSocketPath,
	submitCodexLeadInboxBatch,
	submitCodexLeadInterrupt,
} from "../lead-backends/codex/CodexLeadInboxSocket.js";
import type { BatchAcceptStatus } from "../lead-backends/codex/LeadJournal.js";

export interface LeadDeliveryBatchMember {
	deliveryId: string;
	content: string;
	priority: number;
	seq: number;
}

export interface LeadDeliveryBatch {
	batchId: string;
	leadId: string;
	ownerEpoch: string;
	kind?: "discord_chat" | "model";
	members: readonly LeadDeliveryBatchMember[];
	/** Codex consumes one packaged turn; Claude writes members atomically and
	 * its stock poller packages the unread snapshot into one turn. */
	modelPayload: string;
	replyChannelId?: string;
	replyRoute?: import("../lead-backends/codex/roundtable-reply-route.js").RoundtableReplyRoute;
}

export class LeadDeliveryUnavailableError extends Error {
	constructor(
		readonly scope: "lead" | "discord",
		message: string,
	) {
		super(message);
		this.name = "LeadDeliveryUnavailableError";
	}
}

export interface DurableAcceptReceipt {
	batchId: string;
	memberIds: string[];
	status: BatchAcceptStatus;
}

/** FLY-2883: how a controlled-interrupt letter reached a Codex Lead. */
export type CodexInterruptResult =
	| {
			outcome: "steered" | "queued_turn";
			receipt: DurableAcceptReceipt;
	  }
	| {
			outcome: "mailbox_only";
			reason: "steer_unsupported";
			receipt: DurableAcceptReceipt;
	  }
	| { outcome: "steer_failed"; detail: string };

export interface LeadDeliveryAdapter {
	deliverBatch(batch: LeadDeliveryBatch): Promise<DurableAcceptReceipt>;
	/** FLY-2883: Codex only — steer one interrupt letter into the current turn. */
	deliverInterrupt?(batch: LeadDeliveryBatch): Promise<CodexInterruptResult>;
}

export class ClaudeLeadDeliveryAdapter implements LeadDeliveryAdapter {
	constructor(
		private readonly opts: {
			inboxPath: string;
			sidecarPath: string;
			from?: string;
		},
	) {}

	async deliverBatch(batch: LeadDeliveryBatch): Promise<DurableAcceptReceipt> {
		const members: MailboxBatchMember[] = batch.members.map((member) => ({
			flywheelId: member.deliveryId,
			payload: {
				from: this.opts.from ?? "bridge",
				to: batch.leadId,
				content: member.content,
			},
		}));
		try {
			return await writeMailboxBatch({
				inboxPath: this.opts.inboxPath,
				sidecarPath: this.opts.sidecarPath,
				batchId: batch.batchId,
				members,
			});
		} catch (error) {
			if (!(error instanceof MailboxBatchConflictError)) throw error;
			return {
				batchId: batch.batchId,
				memberIds: members.map(({ flywheelId }) => flywheelId),
				status: "membership_conflict",
			};
		}
	}
}

export class CodexLeadDeliveryAdapter implements LeadDeliveryAdapter {
	private readonly socketPath: string;

	constructor(
		private readonly opts: {
			stateDir: string;
			leadId: string;
			authSecret: string;
			timeoutMs?: number;
		},
	) {
		this.socketPath = resolveCodexLeadInboxSocketPath(opts.stateDir);
	}

	async deliverBatch(batch: LeadDeliveryBatch): Promise<DurableAcceptReceipt> {
		return this.submitOrdinary(batch, await this.probe(batch));
	}

	/**
	 * FLY-2883: steer an interrupt letter into the Lead's current turn when the
	 * sidecar advertises the capability; otherwise deliver it as ordinary input.
	 * A failed steer is returned (never retried as ordinary input here).
	 */
	async deliverInterrupt(
		batch: LeadDeliveryBatch,
	): Promise<CodexInterruptResult> {
		const capabilities = await this.probe(batch);
		const memberIds = batch.members.map(({ deliveryId }) => deliveryId);
		if (!capabilities?.features.includes(LEAD_INTERRUPT_STEER_FEATURE)) {
			return {
				outcome: "mailbox_only",
				reason: "steer_unsupported",
				receipt: await this.submitOrdinary(batch, capabilities),
			};
		}
		let result: Awaited<ReturnType<typeof submitCodexLeadInterrupt>>;
		try {
			result = await submitCodexLeadInterrupt({
				socketPath: this.socketPath,
				leadId: batch.leadId,
				ownerEpoch: batch.ownerEpoch,
				authSecret: this.opts.authSecret,
				batch: {
					batchId: batch.batchId,
					memberIds,
					payload: batch.modelPayload,
				},
				...(this.opts.timeoutMs ? { timeoutMs: this.opts.timeoutMs } : {}),
			});
		} catch (error) {
			if (error instanceof CodexLeadInboxRejectedError) throw error;
			throw new LeadDeliveryUnavailableError(
				"lead",
				`Codex Lead interrupt submit failed: ${(error as Error).message}`,
			);
		}
		if (result.outcome === "steer_failed") return result;
		return {
			outcome: result.outcome,
			receipt: { batchId: batch.batchId, memberIds, status: "accepted_new" },
		};
	}

	/** Capabilities, or undefined for a v1 server that predates the probe. */
	private async probe(
		batch: LeadDeliveryBatch,
	): Promise<CodexLeadInboxCapabilities | undefined> {
		if (batch.leadId !== this.opts.leadId) {
			throw new Error(
				`CodexLeadDeliveryAdapter lead mismatch: ${batch.leadId} != ${this.opts.leadId}`,
			);
		}
		try {
			return await probeCodexLeadInboxCapabilities({
				socketPath: this.socketPath,
				leadId: batch.leadId,
				authSecret: this.opts.authSecret,
				...(this.opts.timeoutMs ? { timeoutMs: this.opts.timeoutMs } : {}),
			});
		} catch (error) {
			// A v1 server rejects the additive capabilities method. Connection-level
			// failures are Lead-wide and must not exhaust queued model rows.
			if (
				!(
					error instanceof CodexLeadInboxRejectedError &&
					error.reason === "malformed submitBatch request"
				)
			) {
				if (error instanceof CodexLeadInboxRejectedError) throw error;
				throw new LeadDeliveryUnavailableError(
					"lead",
					`Codex Lead inbox capability probe failed: ${(error as Error).message}`,
				);
			}
			return undefined;
		}
	}

	private async submitOrdinary(
		batch: LeadDeliveryBatch,
		capabilities: CodexLeadInboxCapabilities | undefined,
	): Promise<DurableAcceptReceipt> {
		const protocolVersion: 1 | 2 = capabilities?.features.includes(
			"discord_route_v2",
		)
			? 2
			: 1;
		if (batch.kind === "discord_chat" && protocolVersion === 1) {
			throw new LeadDeliveryUnavailableError(
				"discord",
				"route_protocol_unavailable",
			);
		}
		let result: Awaited<ReturnType<typeof submitCodexLeadInboxBatch>>;
		try {
			result = await submitCodexLeadInboxBatch({
				socketPath: this.socketPath,
				leadId: batch.leadId,
				ownerEpoch: batch.ownerEpoch,
				authSecret: this.opts.authSecret,
				protocolVersion,
				batch: {
					batchId: batch.batchId,
					memberIds: batch.members.map(({ deliveryId }) => deliveryId),
					payload: batch.modelPayload,
					...(protocolVersion === 2 && batch.replyChannelId
						? { replyChannelId: batch.replyChannelId }
						: {}),
					...(protocolVersion === 2 && batch.replyRoute
						? { replyRoute: batch.replyRoute }
						: {}),
				},
				...(this.opts.timeoutMs ? { timeoutMs: this.opts.timeoutMs } : {}),
			});
		} catch (error) {
			if (error instanceof CodexLeadInboxRejectedError) throw error;
			throw new LeadDeliveryUnavailableError(
				"lead",
				`Codex Lead inbox submit failed: ${(error as Error).message}`,
			);
		}
		return {
			batchId: batch.batchId,
			memberIds: batch.members.map(({ deliveryId }) => deliveryId),
			status: result.status,
		};
	}
}
