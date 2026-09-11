import { describe, expect, it } from "vitest";
import {
	isMailboxTerminalStatus,
	OUTCOME_STATUSES,
	TERMINAL_STATUSES,
} from "../session-terminal.js";

describe("shared StateStore mailbox terminal policy", () => {
	it.each([
		"completed",
		"approved",
		"blocked",
		"failed",
		"rejected",
		"deferred",
		"shelved",
		"terminated",
	])("rejects irreversible StateStore outcome %s", (status) => {
		expect(isMailboxTerminalStatus(status)).toBe(true);
		expect(TERMINAL_STATUSES.has(status)).toBe(true);
	});

	it.each([
		"running",
		"pending",
		"awaiting_review",
		"approved_to_ship",
		"timeout",
		"",
	])(
		"keeps mailbox-live or non-StateStore outcome %s deliverable",
		(status) => {
			expect(isMailboxTerminalStatus(status)).toBe(false);
		},
	);

	it("preserves the distinct outcome and transition policies", () => {
		expect(OUTCOME_STATUSES).toEqual([
			"completed",
			"approved",
			"approved_to_ship",
			"blocked",
			"failed",
			"rejected",
			"deferred",
			"shelved",
			"terminated",
		]);
		expect(TERMINAL_STATUSES.has("awaiting_review")).toBe(true);
		expect(TERMINAL_STATUSES.has("approved_to_ship")).toBe(false);
	});
});
