import { createHmac, timingSafeEqual } from "node:crypto";
import type {
	LeadEventDeliveryReason,
	LeadEventRow,
	StateStore,
} from "../StateStore.js";
import { deliveryAckEnabled } from "./lead-event-ack-policy.js";
import type {
	DeliveryResult,
	LeadEventEnvelope,
	LeadRuntime,
} from "./lead-runtime.js";

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

export function deriveLeadEventAckToken(
	secret: DeliverySecret,
	input: { eventSeq: number; ackOwnerLeadId: string; ownerEpoch: number },
): string {
	const canonical = JSON.stringify({
		purpose: "lead-event-ack",
		eventSeq: input.eventSeq,
		ackOwnerLeadId: input.ackOwnerLeadId,
		ownerEpoch: input.ownerEpoch,
	});
	return createHmac("sha256", secret.key).update(canonical).digest("base64url");
}

export function tokenMatches(actual: string, expected: string): boolean {
	const a = Buffer.from(actual);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

export class LeadEventDeliveryCoordinator {
	private readonly now: () => number;
	private readonly ackTimeoutMs: number;
	private readonly leaseMs: number;
	private readonly enabled: boolean;

	constructor(private readonly options: LeadEventDeliveryCoordinatorOptions) {
		this.enabled = options.enabled ?? deliveryAckEnabled();
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
