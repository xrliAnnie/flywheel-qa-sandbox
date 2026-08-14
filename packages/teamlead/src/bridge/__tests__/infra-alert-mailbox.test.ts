import { describe, expect, it } from "vitest";
import {
	INFRA_ALERT_LAST_MILE_ROUTE,
	shouldCopyInfraAlertToChannel,
} from "../infra-alert-mailbox.js";

describe("FLY-1764 infra alert last-mile route", () => {
	it("targets claw and keeps the Discord copy switch default-off", () => {
		expect(INFRA_ALERT_LAST_MILE_ROUTE).toEqual({
			ownerLeadId: "claude-infra-bot-lead",
			copyToChannelEnv: "FLYWHEEL_ALERT_COPY_TO_CHANNEL",
			copyToChannelDefault: false,
		});
		expect(shouldCopyInfraAlertToChannel({})).toBe(false);
		expect(
			shouldCopyInfraAlertToChannel({ FLYWHEEL_ALERT_COPY_TO_CHANNEL: "0" }),
		).toBe(false);
		expect(
			shouldCopyInfraAlertToChannel({ FLYWHEEL_ALERT_COPY_TO_CHANNEL: "1" }),
		).toBe(true);
	});
});
