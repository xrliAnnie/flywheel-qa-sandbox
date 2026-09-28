/**
 * FLY-2828 §3.3: pure disposition table for a TURN wake receipt projection.
 *
 * The patrol handler resolves the activation, calls the StateStore projector,
 * and hands every fact to this function. Only two kinds of fact are terminal
 * (`not_applicable`): a stale immutable identity (epoch / route revision /
 * actor already superseded, so the old ACK can never become valid) and a
 * delivery parked behind a Lead decision (FLY-2921: `returned_to_lead` only
 * ever leaves via a new route revision). A late ACK from an actor that was
 * replaced is refused before any write by the projector's identity check
 * (preferred actor / binding / TURN execution), not here. Everything
 * else retries into the bounded quarantine lane so an unsettled StateStore
 * obligation ends in a durable Lead question instead of a silent
 * `receipt_projected_at`.
 */

export type TurnWakeReceiptOutcome =
	| { kind: "projected" }
	| { kind: "not_applicable"; reason: string }
	| { kind: "retry"; reason: string };

export type TurnWakeReceiptDeliveryState =
	| "pending"
	| "turn_granted"
	| "wake_delivered"
	| "completed"
	| "returned_to_lead";

const PROJECTABLE_PURPOSES = new Set([
	"workflow_rework",
	"workflow_ship_carrier",
]);
const TERMINAL_IDENTITY_REASONS = new Set([
	"rework_wake_receipt_identity_conflict",
	"carrier_wake_receipt_identity_conflict",
]);
const LEAD_PARKED_DELIVERY_STATES = new Set<TurnWakeReceiptDeliveryState>([
	"returned_to_lead",
]);

export function classifyTurnWakeReceiptProjection(input: {
	purpose: string;
	/** Present when the caller wants the legacy/unacked fence evaluated. */
	activationId?: string | null;
	ackedAt?: number | null;
	/** False when the activation binding or its run cannot be resolved. */
	activationResolved?: boolean;
	projected?:
		| { ok: true; idempotentReplay: boolean }
		| { ok: false; reason: string };
	deliveryState?: TurnWakeReceiptDeliveryState;
}): TurnWakeReceiptOutcome {
	if (
		("activationId" in input && !input.activationId) ||
		("ackedAt" in input && input.ackedAt === null)
	) {
		return { kind: "not_applicable", reason: "legacy_or_unacked" };
	}
	if (!PROJECTABLE_PURPOSES.has(input.purpose)) {
		return { kind: "not_applicable", reason: `purpose:${input.purpose}` };
	}
	if (input.activationResolved === false) {
		return { kind: "retry", reason: "activation_or_run_unresolved" };
	}
	if (!input.projected) {
		return { kind: "retry", reason: "projection_not_attempted" };
	}
	if (input.projected.ok) return { kind: "projected" };
	const reason = input.projected.reason;
	if (TERMINAL_IDENTITY_REASONS.has(reason)) {
		return { kind: "not_applicable", reason };
	}
	if (
		reason === "rework_wake_receipt_not_ready" &&
		input.deliveryState &&
		LEAD_PARKED_DELIVERY_STATES.has(input.deliveryState)
	) {
		return {
			kind: "not_applicable",
			reason: `${reason}:${input.deliveryState}`,
		};
	}
	return { kind: "retry", reason };
}
