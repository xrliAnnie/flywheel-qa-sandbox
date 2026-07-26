import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { CommDB } from "flywheel-comm/db";
import type {
	DetectionEscalationRow,
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
	commDbPaths: () => string[];
	secretProvider: DeliverySecretProvider;
	now?: () => number;
	ackTimeoutMs?: number;
	leaseMs?: number;
	maxRedeliver?: number;
	maxTransportFailures?: number;
	lateAckWindowMs?: number;
	onDeadLetter?: (row: LeadEventRow) => Promise<boolean>;
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
	private readonly maxRedeliver: number;
	private readonly maxTransportFailures: number;
	private readonly lateAckWindowMs: number;
	private reconciling = false;
	private readonly enabled: boolean;

	constructor(private readonly options: LeadEventDeliveryCoordinatorOptions) {
		this.enabled = options.enabled ?? deliveryAckEnabled();
		this.now = options.now ?? Date.now;
		this.ackTimeoutMs = positiveInt(options.ackTimeoutMs, 5 * 60_000);
		this.leaseMs = positiveInt(options.leaseMs, this.ackTimeoutMs * 2);
		this.maxRedeliver = positiveInt(options.maxRedeliver, 5);
		this.maxTransportFailures = positiveInt(options.maxTransportFailures, 5);
		this.lateAckWindowMs = positiveInt(
			options.lateAckWindowMs,
			24 * 60 * 60_000,
		);
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

	async reconcile(): Promise<void> {
		if (!this.enabled || this.reconciling) return;
		this.reconciling = true;
		try {
			this.consumeAckReceipts();
			for (const row of this.options.store.listLateAckLeadEvents(
				this.nowIso(),
			)) {
				this.autoAckFromMachineEvidence(row);
			}
			this.disposeExpiredIngressRows();
			for (const row of this.options.store.listOpenAckLeadEvents()) {
				if (this.autoAckFromMachineEvidence(row)) continue;
				if (row.dead_letter_pending_at) {
					await this.pageDeadLetter(row);
					continue;
				}
				const attempts = this.options.store.listLeadEventDeliveryAttempts(
					row.seq,
				);
				const transportFailures = attempts.filter(
					(attempt) =>
						attempt.retired_at === null && attempt.outcome === "failed",
				).length;
				if (transportFailures >= this.maxTransportFailures) {
					await this.deadLetter(row);
					continue;
				}
				if (row.pending_delivery_reason) {
					await this.deliverAttempt(row, row.pending_delivery_reason);
					await this.deadLetterIfTransportExhausted(row.seq);
					continue;
				}

				if (!row.delivered_at) {
					await this.deliverAttempt(row, "initial");
					await this.deadLetterIfTransportExhausted(row.seq);
					continue;
				}
				if (!row.ack_deadline_at || row.ack_deadline_at > this.nowIso()) {
					continue;
				}
				const pushedAckReminders = attempts.filter(
					(attempt) =>
						attempt.retired_at === null &&
						attempt.reason === "ack_timeout" &&
						attempt.outcome === "pushed",
				).length;
				if (pushedAckReminders >= this.maxRedeliver) {
					await this.deadLetter(row);
					continue;
				}
				await this.deliverAttempt(row, "ack_timeout");
				await this.deadLetterIfTransportExhausted(row.seq);
			}
		} finally {
			this.reconciling = false;
		}
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

	private consumeAckReceipts(): void {
		const secret = this.activeSecret();
		for (const dbPath of new Set(this.options.commDbPaths())) {
			let db: CommDB | null = null;
			try {
				db = new CommDB(dbPath, false);
				for (const receipt of db.getPendingAckReceipts()) {
					try {
						const payload = JSON.parse(receipt.content) as {
							event_seq?: unknown;
							ack_token?: unknown;
						};
						if (
							typeof payload.event_seq !== "number" ||
							typeof payload.ack_token !== "string"
						) {
							continue;
						}
						const row = this.options.store.getLeadEventBySeq(payload.event_seq);
						if (!row?.ack_owner_lead_id || row.acked_at) continue;
						const expected = deriveLeadEventAckToken(secret, {
							eventSeq: row.seq,
							ackOwnerLeadId: row.ack_owner_lead_id,
							ownerEpoch: row.ack_owner_epoch ?? 0,
						});
						if (tokenMatches(payload.ack_token, expected)) {
							this.options.store.markLeadEventAcked(row.seq, this.nowIso());
						}
					} finally {
						db.markAckReceiptConsumed(receipt.id);
					}
				}
			} catch (error) {
				console.warn(
					`[lead-event-delivery] ACK receipt scan failed for ${dbPath}: ${error instanceof Error ? error.message : String(error)}`,
				);
			} finally {
				db?.close();
			}
		}
	}

	private disposeExpiredIngressRows(): void {
		for (const row of this.options.store.listExpiredAckIngressRows(
			this.nowIso(),
		)) {
			try {
				const route = row.routing_snapshot
					? (JSON.parse(row.routing_snapshot) as {
							commDbPath?: string;
							questionId?: string;
						})
					: {};
				if (route.commDbPath && route.questionId) {
					const db = new CommDB(route.commDbPath, false);
					try {
						db.markQuestionTerminalDisposed(route.questionId);
					} finally {
						db.close();
					}
				}
				this.options.store.markLeadEventIngressDisposed(row.seq, this.nowIso());
			} catch (error) {
				console.warn(
					`[lead-event-delivery] terminal ingress disposal failed for event #${row.seq}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	private autoAckFromMachineEvidence(row: LeadEventRow): boolean {
		if (!row.routing_snapshot) {
			return false;
		}
		try {
			const route = JSON.parse(row.routing_snapshot) as {
				commDbPath?: string;
				questionId?: string;
			};
			if (!route.questionId) return false;
			if (row.ack_policy === "founder_surface_confirmed") {
				if (!row.session_key) return false;
				const confirmed = this.options.store
					.getEventsByExecution(row.session_key)
					.some(
						(event) =>
							event.event_id === `founder-thread-notify-${route.questionId}` &&
							(event.payload as { reason?: string } | undefined)?.reason ===
								"posted",
					);
				return (
					confirmed &&
					this.options.store.markLeadEventAcked(row.seq, this.nowIso())
				);
			}
			if (row.ack_policy !== "question_response" || !route.commDbPath) {
				return false;
			}
			const db = new CommDB(route.commDbPath, false);
			try {
				if (!db.getResponse(route.questionId)) return false;
				return this.options.store.markLeadEventAcked(row.seq, this.nowIso());
			} finally {
				db.close();
			}
		} catch {
			return false;
		}
	}

	private async deadLetterIfTransportExhausted(seq: number): Promise<void> {
		const attempts = this.options.store.listLeadEventDeliveryAttempts(seq);
		if (
			attempts.filter(
				(attempt) =>
					attempt.retired_at === null && attempt.outcome === "failed",
			).length >= this.maxTransportFailures
		) {
			const row = this.options.store.getLeadEventBySeq(seq);
			if (row) await this.deadLetter(row);
		}
	}

	private async deadLetter(row: LeadEventRow): Promise<void> {
		const nowIso = this.nowIso();
		this.options.store.markLeadEventDeadLetterPending(row.seq, nowIso);
		await this.pageDeadLetter(
			this.options.store.getLeadEventBySeq(row.seq) ?? row,
		);
	}

	private async pageDeadLetter(row: LeadEventRow): Promise<void> {
		if (!this.options.onDeadLetter) return;
		const claimToken = randomUUID();
		const nowIso = this.nowIso();
		if (
			!this.options.store.claimLeadEventDeadLetterPage({
				seq: row.seq,
				claimToken,
				nowIso,
				leaseExpiresIso: new Date(this.now() + this.leaseMs).toISOString(),
			})
		) {
			return;
		}
		if (!(await this.options.onDeadLetter(row))) return;
		this.options.store.markLeadEventDeadLetterConfirmed({
			seq: row.seq,
			claimToken,
			nowIso: this.nowIso(),
			ackTokenValidUntilIso: new Date(
				this.now() + this.lateAckWindowMs,
			).toISOString(),
		});
	}
}

export interface LeadEventDeadLetterHandlerOptions {
	pageFounder: (row: DetectionEscalationRow) => Promise<boolean>;
	mirror?: (row: LeadEventRow) => Promise<void>;
	now?: () => number;
}

/**
 * Route a delivery dead letter through the canonical issue-thread founder
 * pager. Park notices retain their semantic episode tuple, so D1 and D2 share
 * the same founder-page ledger key and converge on one confirmed occurrence.
 * A general-channel mirror is best effort and never counts as confirmation.
 */
export function createLeadEventDeadLetterHandler(
	options: LeadEventDeadLetterHandlerOptions,
): (row: LeadEventRow) => Promise<boolean> {
	return async (row) => {
		let payload: Record<string, unknown> = {};
		try {
			payload = JSON.parse(row.payload) as Record<string, unknown>;
		} catch {
			// The immutable journal metadata below still yields a stable fallback.
		}
		const targetKey = String(
			payload.detection_target_key ??
				payload.execution_id ??
				row.session_key ??
				`lead-event:${row.seq}`,
		);
		const kind = String(
			payload.escalation_kind ?? `delivery:dead_letter:${row.event_type}`,
		);
		const fingerprint = String(
			payload.episode_fingerprint ?? payload.question_id ?? row.event_id,
		);
		const nowMs = options.now?.() ?? Date.now();
		const posted = await options.pageFounder({
			target_key: targetKey,
			kind,
			episode_fingerprint: fingerprint,
			issue_id: typeof payload.issue_id === "string" ? payload.issue_id : null,
			owner_lead_id: row.ack_owner_lead_id ?? row.lead_id,
			first_detected_at_ms: nowMs,
			lead_notified_at_ms: nowMs,
			lead_ack_at_ms: null,
			founder_paged_at_ms: null,
			clearing_since_ms: null,
			status: "LEAD_NOTIFIED",
			attempts: 0,
			resolved_via: null,
			source_receipt_id: null,
			source_execution_id: null,
			source_question_id: null,
		});
		if (!posted) return false;
		try {
			await options.mirror?.(row);
		} catch {
			// Founder issue-thread confirmation owns the state transition; a mirror
			// failure must not make the already-posted page repeat forever.
		}
		return true;
	};
}
