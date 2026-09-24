import { describe, expect, it } from "vitest";
import { classifyTurnWakeReceiptProjection } from "../turn-wake-receipt-classifier.js";

/**
 * FLY-2828 §3.3: the receipt handler's disposition table as a pure function.
 * `not_applicable` is reserved for facts that can never become valid again
 * (stale epoch / route revision / actor, or a delivery parked behind a Lead
 * decision). Everything else retries into the bounded quarantine lane so the
 * StateStore obligation stays visible to a Lead.
 */
describe("classifyTurnWakeReceiptProjection", () => {
	it("closes legacy, unacked, and foreign-purpose receipts as not_applicable", () => {
		expect(
			classifyTurnWakeReceiptProjection({
				purpose: "workflow_rework",
				activationId: null,
				ackedAt: 1,
			}),
		).toEqual({ kind: "not_applicable", reason: "legacy_or_unacked" });
		expect(
			classifyTurnWakeReceiptProjection({
				purpose: "workflow_rework",
				activationId: "activation-1",
				ackedAt: null,
			}),
		).toEqual({ kind: "not_applicable", reason: "legacy_or_unacked" });
		expect(
			classifyTurnWakeReceiptProjection({
				purpose: "legacy_recovery",
				activationId: "activation-1",
				ackedAt: 1,
			}),
		).toEqual({ kind: "not_applicable", reason: "purpose:legacy_recovery" });
	});

	it("retries when the activation or run cannot be resolved", () => {
		expect(
			classifyTurnWakeReceiptProjection({
				purpose: "workflow_rework",
				activationResolved: false,
			}),
		).toEqual({ kind: "retry", reason: "activation_or_run_unresolved" });
	});

	it("projects on success", () => {
		expect(
			classifyTurnWakeReceiptProjection({
				purpose: "workflow_rework",
				activationResolved: true,
				projected: { ok: true, idempotentReplay: true },
			}),
		).toEqual({ kind: "projected" });
		expect(
			classifyTurnWakeReceiptProjection({
				purpose: "workflow_ship_carrier",
				activationResolved: true,
				projected: { ok: true, idempotentReplay: false },
			}),
		).toEqual({ kind: "projected" });
	});

	it("treats only stale immutable identity as terminal", () => {
		expect(
			classifyTurnWakeReceiptProjection({
				purpose: "workflow_rework",
				activationResolved: true,
				projected: {
					ok: false,
					reason: "rework_wake_receipt_identity_conflict",
				},
				deliveryState: "awaiting_receipt",
			}),
		).toEqual({
			kind: "not_applicable",
			reason: "rework_wake_receipt_identity_conflict",
		});
		expect(
			classifyTurnWakeReceiptProjection({
				purpose: "workflow_ship_carrier",
				activationResolved: true,
				projected: {
					ok: false,
					reason: "carrier_wake_receipt_identity_conflict",
				},
			}),
		).toEqual({
			kind: "not_applicable",
			reason: "carrier_wake_receipt_identity_conflict",
		});
	});

	it("retries structural corruption and unsettled StateStore obligations", () => {
		for (const reason of [
			"rework_wake_receipt_context_corrupt",
			"rework_wake_receipt_path_conflict",
			"rework_wake_receipt_path_missing",
			"rework_wake_receipt_node_not_reserved:done",
			"rework_wake_receipt_node_not_reserved:failed",
			"rework_wake_receipt_race",
			"rework_wake_receipt_not_found",
			"something_new",
		]) {
			expect(
				classifyTurnWakeReceiptProjection({
					purpose: "workflow_rework",
					activationResolved: true,
					projected: { ok: false, reason },
					deliveryState: "awaiting_receipt",
				}),
			).toEqual({ kind: "retry", reason });
		}
	});

	it("splits not_ready by delivery state", () => {
		for (const deliveryState of [
			"held",
			"needs_lead",
			"replacement_pending",
		] as const) {
			expect(
				classifyTurnWakeReceiptProjection({
					purpose: "workflow_rework",
					activationResolved: true,
					projected: { ok: false, reason: "rework_wake_receipt_not_ready" },
					deliveryState,
				}),
			).toEqual({
				kind: "not_applicable",
				reason: `rework_wake_receipt_not_ready:${deliveryState}`,
			});
		}
		for (const deliveryState of [
			"pending",
			"turn_granted",
			undefined,
		] as const) {
			expect(
				classifyTurnWakeReceiptProjection({
					purpose: "workflow_rework",
					activationResolved: true,
					projected: { ok: false, reason: "rework_wake_receipt_not_ready" },
					deliveryState,
				}),
			).toEqual({ kind: "retry", reason: "rework_wake_receipt_not_ready" });
		}
		expect(
			classifyTurnWakeReceiptProjection({
				purpose: "workflow_ship_carrier",
				activationResolved: true,
				projected: { ok: false, reason: "carrier_wake_receipt_not_ready" },
			}),
		).toEqual({ kind: "retry", reason: "carrier_wake_receipt_not_ready" });
	});
});
