import { describe, expect, it } from "vitest";
import { legacyDeliveryWatchdogsEnabled } from "../legacy-delivery-watchdog-policy.js";

describe("legacy delivery watchdog reverse flag", () => {
	it("is policy-hard-off through the shared retired-lane policy", () => {
		expect(legacyDeliveryWatchdogsEnabled({})).toBe(false);
		expect(legacyDeliveryWatchdogsEnabled({ UNRELATED: "1" })).toBe(false);
	});
});
