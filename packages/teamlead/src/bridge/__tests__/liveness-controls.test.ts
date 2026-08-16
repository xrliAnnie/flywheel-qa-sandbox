import { describe, expect, it } from "vitest";
import { qaStallInboxLoopLead } from "../liveness-manifest.js";

describe("FLY-1393 minimum-set policy", () => {
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
