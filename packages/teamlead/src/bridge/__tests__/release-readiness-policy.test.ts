import { describe, expect, it } from "vitest";
import { readReadinessPolicy } from "../release-readiness/policy.js";

describe("release readiness policy", () => {
	it("accepts finite positive overrides and records invalid values that default", () => {
		const policy = readReadinessPolicy({
			FLYWHEEL_READINESS_SOAK_HOURS: "1.5",
			FLYWHEEL_READINESS_HEARTBEAT_FRESH_MIN: "2",
			FLYWHEEL_READINESS_GAP_TOLERANCE_MIN: "0",
			FLYWHEEL_READINESS_BACKLOG_AGE_MAX_S: "0",
			FLYWHEEL_READINESS_SEVERE_HOLD: "Infinity",
			FLYWHEEL_READINESS_WARNING_HOLD: "1.2",
			FLYWHEEL_READINESS_BUG_HOLD: "0",
			FLYWHEEL_READINESS_PROJECTS: " flywheel, machine,flywheel ",
			FLYWHEEL_READINESS_IGNORE_KINDS: "deploy_failed, deploy_degraded",
			FLYWHEEL_BUG_LABEL: " Defect ",
		});
		expect(policy).toMatchObject({
			soakHours: 1.5,
			heartbeatFreshMin: 2,
			gapToleranceMin: 0,
			backlogAgeMaxS: 0,
			severeHold: 1,
			warningHold: 5,
			bugHold: 1,
			projects: ["flywheel", "machine"],
			ignoreKinds: ["deploy_failed", "deploy_degraded"],
			bugLabel: "Defect",
			policyDefaulted: [
				"FLYWHEEL_READINESS_SEVERE_HOLD",
				"FLYWHEEL_READINESS_WARNING_HOLD",
				"FLYWHEEL_READINESS_BUG_HOLD",
			],
		});
	});

	it.each(["", " ", "NaN", "-1", "0x10", "1e3"])(
		"rejects malformed numeric override %j",
		(value) => {
			expect(
				readReadinessPolicy({ FLYWHEEL_READINESS_SOAK_HOURS: value }),
			).toMatchObject({
				soakHours: 12,
				policyDefaulted: ["FLYWHEEL_READINESS_SOAK_HOURS"],
			});
		},
	);

	it("cannot silently disable all project coverage with an empty list", () => {
		expect(
			readReadinessPolicy({
				FLYWHEEL_READINESS_PROJECTS: " , ",
				FLYWHEEL_BUG_LABEL: " ",
			}),
		).toMatchObject({
			projects: ["flywheel", "machine"],
			bugLabel: "Bug",
			policyDefaulted: ["FLYWHEEL_READINESS_PROJECTS", "FLYWHEEL_BUG_LABEL"],
		});
	});
	it("records the approved defaults when no overrides exist", () => {
		expect(readReadinessPolicy({})).toEqual({
			soakHours: 12,
			heartbeatFreshMin: 10,
			gapToleranceMin: 30,
			backlogAgeMaxS: 600,
			severeHold: 1,
			warningHold: 5,
			bugHold: 1,
			projects: ["flywheel", "machine"],
			ignoreKinds: [],
			founderChannelConfigured: false,
			bugLabel: "Bug",
			policyDefaulted: [],
		});
	});
});
