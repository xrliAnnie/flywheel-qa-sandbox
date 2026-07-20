import { describe, expect, it } from "vitest";
import { legacyDeliveryWatchdogsEnabled } from "../legacy-delivery-watchdog-policy.js";

describe("legacy delivery watchdog reverse flag", () => {
	it("is disabled by default and only re-enabled by the exact value 1", () => {
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
		).toBe(true);
	});
});
