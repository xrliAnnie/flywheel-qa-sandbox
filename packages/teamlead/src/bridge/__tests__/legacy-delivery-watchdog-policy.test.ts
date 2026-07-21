import { describe, expect, it } from "vitest";
import { legacyDeliveryWatchdogsEnabled } from "../legacy-delivery-watchdog-policy.js";

describe("legacy delivery watchdog reverse flag", () => {
	it("is policy-hard-off even when the retired flag is set", () => {
		expect(legacyDeliveryWatchdogsEnabled({})).toBe(false);
		expect(
			legacyDeliveryWatchdogsEnabled({
				FLYWHEEL_LEGACY_DELIVERY_WATCHDOGS: "0",
			}),
		).toBe(false);
		expect(
			legacyDeliveryWatchdogsEnabled({
				FLYWHEEL_LEGACY_DELIVERY_WATCHDOGS: "true",
			}),
		).toBe(false);
		expect(
			legacyDeliveryWatchdogsEnabled({
				FLYWHEEL_LEGACY_DELIVERY_WATCHDOGS: "1",
			}),
		).toBe(false);
	});
});
