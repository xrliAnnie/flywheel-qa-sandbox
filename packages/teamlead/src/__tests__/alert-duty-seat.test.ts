import { describe, expect, it } from "vitest";
import {
	ALERT_DUTY_SEAT,
	resolveAlertDutyLeadId,
	resolveAlertDutySeat,
} from "../alert-duty-seat.js";

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

describe("isolated alert duty Lead", () => {
	it("ignores production overrides and honors only an isolated override", () => {
		expect(
			resolveAlertDutyLeadId({
				FLYWHEEL_ALERT_DUTY_LEAD_ID: "flywheel-test-1",
			}),
		).toBe(ALERT_DUTY_SEAT.leadId);
		expect(
			resolveAlertDutyLeadId({
				FLYWHEEL_ISOLATION_ROOT: "/tmp/room",
				FLYWHEEL_ALERT_DUTY_LEAD_ID: "flywheel-test-1",
			}),
		).toBe("flywheel-test-1");
		expect(
			resolveAlertDutyLeadId({ FLYWHEEL_ISOLATION_ROOT: "/tmp/room" }),
		).toBe(ALERT_DUTY_SEAT.leadId);
	});
	it("resolves the isolated roster seat and leaves other Leads without duty", () => {
		const env = {
			FLYWHEEL_ISOLATION_ROOT: "/tmp/room",
			FLYWHEEL_ALERT_DUTY_LEAD_ID: "flywheel-test-1",
		};
		const projects = [
			{
				projectName: "room",
				leads: [{ agentId: "flywheel-test-1", alertChannel: "room-alerts" }],
			},
		];
		expect(
			resolveAlertDutySeat({
				leadId: "flywheel-test-1",
				projectName: "room",
				projects,
				env,
			}),
		).toEqual({ isDutySeat: true, alertChannelId: "room-alerts" });
		expect(
			resolveAlertDutySeat({
				leadId: ALERT_DUTY_SEAT.leadId,
				projectName: "room",
				projects,
				env,
			}).isDutySeat,
		).toBe(false);
	});
});
