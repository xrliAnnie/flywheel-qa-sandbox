import { describe, expect, it } from "vitest";
import { mapLeadLaunchdTarget } from "../launchd-target.js";

describe("launchd Lead target mapping", () => {
	it("derives the exact job label and restart child key", () => {
		expect(
			mapLeadLaunchdTarget({
				agentId: "eng",
				kind: "lead",
				projectName: "flywheel",
				uid: 501,
			}),
		).toEqual({
			agentId: "eng",
			jobLabel: "gui/501/com.flywheel.lead.flywheel-eng",
			childKey: "lead.flywheel-eng",
		});
	});

	it.each([
		{
			agentId: "r1",
			kind: "runner" as const,
			projectName: "flywheel",
			uid: 501,
		},
		{
			agentId: "../eng",
			kind: "lead" as const,
			projectName: "flywheel",
			uid: 501,
		},
		{
			agentId: "eng",
			kind: "lead" as const,
			projectName: "bad/name",
			uid: 501,
		},
		{ agentId: "eng", kind: "lead" as const, projectName: "flywheel", uid: -1 },
	])("fails closed for an unmappable identity %#", (input) => {
		expect(() => mapLeadLaunchdTarget(input)).toThrow();
	});
});
