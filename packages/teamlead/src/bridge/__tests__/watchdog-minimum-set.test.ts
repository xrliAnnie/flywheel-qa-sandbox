import { describe, expect, it } from "vitest";
import {
	qaStallInboxLoopLead,
	watchdogBlockedEnabled,
	watchdogLivenessEnabled,
} from "../watchdog-minimum-set.js";

describe("FLY-1393 minimum-set policy", () => {
	it("kept watchdog lanes are independent default-on kill switches", () => {
		expect(watchdogLivenessEnabled({})).toBe(true);
		expect(watchdogBlockedEnabled({})).toBe(true);

		expect(watchdogLivenessEnabled({ FLYWHEEL_WATCHDOG_LIVENESS: "0" })).toBe(
			false,
		);
		expect(watchdogBlockedEnabled({ FLYWHEEL_WATCHDOG_BLOCKED: "0" })).toBe(
			false,
		);
	});

	it("enables the destructive inbox-loop stall seam only under an isolated comm root", () => {
		const target = "flywheel-eng-lead";
		expect(
			qaStallInboxLoopLead(
				{ FLYWHEEL_QA_STALL_INBOX_LOOP_LEAD: target },
				"/private/tmp",
			),
		).toBeUndefined();
		expect(
			qaStallInboxLoopLead(
				{
					FLYWHEEL_QA_STALL_INBOX_LOOP_LEAD: target,
					FLYWHEEL_COMM_DIR: "/Users/me/.flywheel/qa/comm",
				},
				"/Users/me/.flywheel/qa",
				"/Users/me/.flywheel",
			),
		).toBeUndefined();
		expect(
			qaStallInboxLoopLead(
				{
					FLYWHEEL_QA_STALL_INBOX_LOOP_LEAD: target,
					FLYWHEEL_COMM_DIR: "/Users/me/.flywheel/comm",
				},
				"/private/tmp",
			),
		).toBeUndefined();
		expect(
			qaStallInboxLoopLead(
				{
					FLYWHEEL_QA_STALL_INBOX_LOOP_LEAD: target,
					FLYWHEEL_COMM_ROOT: "/Users/me/.flywheel/comm",
					FLYWHEEL_COMM_DIR: "/private/tmp/fly1393-qa/comm",
				},
				"/private/tmp",
			),
		).toBeUndefined();
		expect(
			qaStallInboxLoopLead(
				{
					FLYWHEEL_QA_STALL_INBOX_LOOP_LEAD: target,
					FLYWHEEL_COMM_DIR: "/private/tmp/fly1393-qa/comm",
				},
				"/private/tmp",
			),
		).toBe(target);
	});
});
