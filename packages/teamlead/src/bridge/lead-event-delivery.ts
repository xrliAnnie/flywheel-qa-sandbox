import { deriveLeadEventAckToken } from "./lead-event-ack-token.js";

export {
	deriveLeadEventAckToken,
	tokenMatches,
} from "./lead-event-ack-token.js";

import type {
	LeadEventDeliveryReason,
	LeadEventRow,
	StateStore,
} from "../StateStore.js";
import type {
	DeliveryResult,
	LeadEventEnvelope,
	LeadRuntime,
} from "./lead-runtime.js";
import { applyLeadEventAckReceipt } from "./protocol-ingress.js";

export interface DeliverySecret {
	secretId: string;
	key: Buffer;
}

export interface DeliverySecretProvider {
	getActive(): DeliverySecret;
}

export interface LeadEventDeliveryCoordinatorOptions {
	store: StateStore;
	runtimeForLead: (leadId: string) => LeadRuntime | undefined;
	secretProvider: DeliverySecretProvider;
	now?: () => number;
	ackTimeoutMs?: number;
	leaseMs?: number;
	/** Boot-captured FLY-1373 reverse flag for the legacy cohort scanner. */
	enabled?: boolean;
}

function positiveInt(value: number | undefined, fallback: number): number {
	return Number.isFinite(value) && (value ?? 0) > 0
		? Math.floor(value as number)
		: fallback;
}

export class LeadEventDeliveryCoordinator {
	private readonly now: () => number;
	private readonly ackTimeoutMs: number;
	private readonly leaseMs: number;
	private readonly enabled: boolean;

	constructor(private readonly options: LeadEventDeliveryCoordinatorOptions) {
		this.enabled = options.enabled ?? false;
		this.now = options.now ?? Date.now;
		this.ackTimeoutMs = positiveInt(options.ackTimeoutMs, 5 * 60_000);
		this.leaseMs = positiveInt(options.leaseMs, this.ackTimeoutMs * 2);
	}

	async deliver(
		envelope: LeadEventEnvelope,
		runtime?: LeadRuntime,
	): Promise<DeliveryResult> {
		const row = this.options.store.getLeadEventBySeq(envelope.seq);
		if (!row?.ack_required || !this.enabled) {
			const target = runtime ?? this.options.runtimeForLead(envelope.leadId);
			return target
				? target.deliver(envelope)
				: { delivered: false, error: "missing lead runtime" };
		}
		return this.deliverAttempt(row, "initial", envelope, runtime);
	}

	readOwnedEvent(input: {
		eventHandle: string;
		projectName: string;
		leadId: string;
	}): LeadEventRow {
		const match = /^event_([1-9][0-9]{0,15})$/.exec(input.eventHandle);
		const seq = match ? Number(match[1]) : NaN;
		const row = Number.isSafeInteger(seq)
			? this.options.store.getLeadEventBySeq(seq)
			: undefined;
		if (!row || (row.ack_owner_lead_id ?? row.lead_id) !== input.leadId)
			throw new Error("inbox_event_scope_denied");
		let project: unknown;
		try {
			project = (JSON.parse(row.payload) as { project_name?: unknown })
				.project_name;
		} catch {
			throw new Error("inbox_event_scope_denied");
		}
		if (project !== input.projectName)
			throw new Error("inbox_event_scope_denied");
		return row;
	}

	/** Typed identifier only, never an authorization token. No legacy enablement or new ingress. */
	acknowledgeOwnedEvent(input: {
		eventHandle: string;
		projectName: string;
		leadId: string;
	}): { status: "disabled" | "acknowledged"; eventId: string } {
		const row = this.readOwnedEvent(input);
		// Retired/exempt cohorts must not be turned into successful ACKs.
		if (!this.enabled || row.ack_retired_at || !row.ack_required)
			return { status: "disabled", eventId: row.event_id };
		const token = deriveLeadEventAckToken(
			this.options.secretProvider.getActive(),
			{
				eventSeq: row.seq,
				ackOwnerLeadId: input.leadId,
				ownerEpoch: row.ack_owner_epoch ?? 0,
			},
		);
		const result = applyLeadEventAckReceipt(
			this.options,
			{ from_agent: input.leadId, to_agent: "bridge" },
			{ event_seq: row.seq, ack_token: token },
		);
		if (
			!["legacy_ack_applied", "legacy_ack_duplicate"].includes(
				result.disposition,
			)
		)
			return { status: "disabled", eventId: row.event_id };
		return { status: "acknowledged", eventId: row.event_id };
	}

	private nowIso(): string {
		return new Date(this.now()).toISOString();
	}

	private activeSecret(): DeliverySecret {
		const secret = this.options.secretProvider.getActive();
		this.options.store.setActiveDeliverySecretId(secret.secretId);
		return secret;
	}

	private async deliverAttempt(
		row: LeadEventRow,
		reason: LeadEventDeliveryReason,
		baseEnvelope?: LeadEventEnvelope,
		runtime?: LeadRuntime,
	): Promise<DeliveryResult> {
		const secret = this.activeSecret();
		const nowIso = this.nowIso();
		const attempt = this.options.store.claimLeadEventDeliveryAttempt({
			eventSeq: row.seq,
			reason,
			secretId: secret.secretId,
			nowIso,
			leaseExpiresIso: new Date(this.now() + this.leaseMs).toISOString(),
		});
		if (!attempt) {
			return { delivered: false, error: "delivery attempt already claimed" };
		}
		const fresh = this.options.store.getLeadEventBySeq(row.seq);
		if (!fresh?.ack_owner_lead_id) {
			return { delivered: false, error: "lead event has no ACK owner" };
		}
		const token = deriveLeadEventAckToken(secret, {
			eventSeq: fresh.seq,
			ackOwnerLeadId: fresh.ack_owner_lead_id,
			ownerEpoch: fresh.ack_owner_epoch ?? 0,
		});
		const envelope: LeadEventEnvelope = {
			...(baseEnvelope ?? {
				seq: fresh.seq,
				event: JSON.parse(fresh.payload),
				sessionKey: fresh.session_key ?? "",
				leadId: fresh.ack_owner_lead_id,
				timestamp: nowIso,
			}),
			leadId: fresh.ack_owner_lead_id,
			timestamp: nowIso,
			deliveryAttemptId: attempt.attempt_id,
			ack: {
				eventSeq: fresh.seq,
				token,
				policy: fresh.ack_policy!,
			},
		};
		const target =
			runtime ?? this.options.runtimeForLead(fresh.ack_owner_lead_id);
		let result: DeliveryResult;
		try {
			result = target
				? await target.deliver(envelope)
				: { delivered: false, error: "missing lead runtime" };
		} catch (error) {
			result = {
				delivered: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
		this.options.store.finalizeLeadEventDeliveryAttempt({
			claimToken: attempt.claim_token,
			outcome: result.delivered ? "pushed" : "failed",
			nowIso: this.nowIso(),
			ackDeadlineIso: new Date(this.now() + this.ackTimeoutMs).toISOString(),
			error: result.delivered ? undefined : result.error,
		});
		return result;
	}
}
