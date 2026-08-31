import { describe, expect, it } from "vitest";
import { ALERT_DUTY_SEAT, resolveAlertDutySeat } from "../alert-duty-seat.js";

const projects = [
	{
		projectName: "flywheel",
		leads: [
			{
				agentId: ALERT_DUTY_SEAT.leadId,
				alertChannel: "alerts-123",
			},
			{ agentId: "flywheel-eng-lead", alertChannel: "alerts-123" },
		],
	},
];

describe("resolveAlertDutySeat", () => {
	it("assigns the alerts channel only to the Claw duty seat", () => {
		expect(
			resolveAlertDutySeat({
				leadId: "claude-infra-bot-lead",
				projectName: "flywheel",
				projects,
				env: {},
			}),
		).toEqual({ isDutySeat: true, alertChannelId: "alerts-123" });

		expect(
			resolveAlertDutySeat({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				projects,
				env: {},
			}),
		).toEqual({ isDutySeat: false, alertChannelId: null });
	});

	it("uses the unified alerts channel when the project roster has no channel", () => {
		expect(
			resolveAlertDutySeat({
				leadId: ALERT_DUTY_SEAT.leadId,
				projectName: "missing",
				projects,
				env: { FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID: "alerts-fallback" },
			}),
		).toEqual({ isDutySeat: true, alertChannelId: "alerts-fallback" });
	});
});
