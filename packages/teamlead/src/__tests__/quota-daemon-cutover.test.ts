import { describe, expect, it } from "vitest";
import { resolveQuotaDaemonBridgeMode } from "../bridge/quota-daemon-cutover.js";

describe("FLY-1256 Bridge quota-daemon cutover", () => {
	it("permanently retires Bridge account-switch faces while preserving runner quota alerts", () => {
		expect(resolveQuotaDaemonBridgeMode()).toEqual({
			cutover: true,
			attachAccountSwitch: false,
			retireAccountSwitchRoute: true,
			quarantinePending: true,
			runRunnerQuotaScan: true,
		});
	});
});
