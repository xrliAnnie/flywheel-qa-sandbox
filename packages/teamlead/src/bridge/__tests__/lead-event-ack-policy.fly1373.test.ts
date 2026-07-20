import { describe, expect, it } from "vitest";
import {
	ackPolicyForLeadEvent,
	deliveryAckEnabled,
	legacyLeadWatchdogEnabled,
} from "../lead-event-ack-policy.js";

describe("FLY-1373 legacy delivery watchdog reverse flag", () => {
	it("is disabled by default and requires an explicit legacy=1 opt-in", () => {
		expect(legacyLeadWatchdogEnabled({})).toBe(false);
		expect(deliveryAckEnabled({ FLYWHEEL_DELIVERY_ACK: "1" })).toBe(false);
		expect(
			deliveryAckEnabled({
				FLYWHEEL_LEGACY_DELIVERY_WATCHDOGS: "1",
				FLYWHEEL_DELIVERY_ACK: "1",
			}),
		).toBe(true);
		expect(
			deliveryAckEnabled({
				FLYWHEEL_LEGACY_DELIVERY_WATCHDOGS: "1",
				FLYWHEEL_DELIVERY_ACK: "0",
			}),
		).toBe(false);
	});

	it("does not mint ACK requirements for new events when the legacy scanner is re-enabled", () => {
		expect(
			ackPolicyForLeadEvent(
				"gate_question",
				{
					event_type: "gate_question",
					checkpoint: "approve_to_ship",
				},
				{
					FLYWHEEL_LEGACY_DELIVERY_WATCHDOGS: "1",
					FLYWHEEL_DELIVERY_ACK: "1",
				},
			),
		).toBeNull();
	});
});
