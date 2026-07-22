import { describe, expect, it } from "vitest";
import { isNoOutEdgeTerminalStatus as packageRootHelper } from "../index.js";
import {
	isNoOutEdgeTerminalStatus,
	WORKFLOW_TRANSITIONS,
} from "../workflow-fsm.js";

describe("FLY-1427 no-out-edge terminal status helper", () => {
	it.each(["approved", "completed", "shelved", "terminated"])(
		"treats %s as overwrite-immune",
		(status) => {
			expect(WORKFLOW_TRANSITIONS[status]).toEqual([]);
			expect(isNoOutEdgeTerminalStatus(status)).toBe(true);
			expect(packageRootHelper(status)).toBe(true);
		},
	);

	it.each(["pending", "running", "blocked", "failed", "rejected"])(
		"does not immunize out-edged status %s",
		(status) => {
			expect(isNoOutEdgeTerminalStatus(status)).toBe(false);
			expect(packageRootHelper(status)).toBe(false);
		},
	);

	it("fails open for unknown and absent statuses", () => {
		expect(isNoOutEdgeTerminalStatus("unknown")).toBe(false);
		expect(isNoOutEdgeTerminalStatus(undefined)).toBe(false);
		expect(packageRootHelper("unknown")).toBe(false);
		expect(packageRootHelper(undefined)).toBe(false);
	});
});
