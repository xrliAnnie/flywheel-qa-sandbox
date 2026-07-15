import { describe, expect, it } from "vitest";
import { resolveQuotaDaemonBridgeMode } from "../bridge/quota-daemon-cutover.js";

describe("FLY-1256 Bridge quota-daemon cutover", () => {
	it("legacy mode with a pool preserves all three existing execution faces", () => {
		expect(resolveQuotaDaemonBridgeMode(true, {})).toEqual({
			cutover: false,
			attachAccountSwitch: true,
			runAccountSwitchWatchdog: true,
			retireAccountSwitchRoute: false,
			quarantinePending: false,
			runRunnerQuotaScan: true,
		});
	});

	it("legacy mode without a pool stays byte-compatible and dormant", () => {
		expect(resolveQuotaDaemonBridgeMode(false, {})).toEqual({
			cutover: false,
			attachAccountSwitch: false,
			runAccountSwitchWatchdog: false,
			retireAccountSwitchRoute: false,
			quarantinePending: false,
			runRunnerQuotaScan: false,
		});
	});

	it("cutover retires enqueue/watchdog/route while preserving runner quota alerts", () => {
		expect(
			resolveQuotaDaemonBridgeMode(true, {
				FLYWHEEL_QUOTA_DAEMON_CUTOVER: "1",
			}),
		).toEqual({
			cutover: true,
			attachAccountSwitch: false,
			runAccountSwitchWatchdog: false,
			retireAccountSwitchRoute: true,
			quarantinePending: true,
			runRunnerQuotaScan: true,
		});
	});

	it("only exact value 1 enables cutover", () => {
		expect(
			resolveQuotaDaemonBridgeMode(true, {
				FLYWHEEL_QUOTA_DAEMON_CUTOVER: "true",
			}),
		).toMatchObject({ cutover: false, attachAccountSwitch: true });
	});
});
