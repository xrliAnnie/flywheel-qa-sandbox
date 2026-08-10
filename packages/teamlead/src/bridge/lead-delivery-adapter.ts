/** FLY-1373 backend-specific durable batch handoff. */

import {
	MailboxBatchConflictError,
	type MailboxBatchMember,
	writeMailboxBatch,
} from "flywheel-agent-team-transport";
import {
	probeCodexLeadInboxCapabilities,
	resolveCodexLeadInboxSocketPath,
	submitCodexLeadInboxBatch,
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

export interface LeadDeliveryAdapter {
	deliverBatch(batch: LeadDeliveryBatch): Promise<DurableAcceptReceipt>;
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
		if (batch.leadId !== this.opts.leadId) {
			throw new Error(
				`CodexLeadDeliveryAdapter lead mismatch: ${batch.leadId} != ${this.opts.leadId}`,
			);
		}
		let protocolVersion: 1 | 2 = 1;
		try {
			const capabilities = await probeCodexLeadInboxCapabilities({
				socketPath: this.socketPath,
				leadId: batch.leadId,
				authSecret: this.opts.authSecret,
				...(this.opts.timeoutMs ? { timeoutMs: this.opts.timeoutMs } : {}),
			});
			if (capabilities.features.includes("discord_route_v2"))
				protocolVersion = 2;
		} catch (error) {
			// A v1 server rejects the additive capabilities method. Connection-level
			// failures are Lead-wide and must not exhaust queued model rows.
			if (!(error as Error).message.includes("malformed submitBatch request")) {
				throw new LeadDeliveryUnavailableError(
					"lead",
					`Codex Lead inbox capability probe failed: ${(error as Error).message}`,
				);
			}
		}
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
