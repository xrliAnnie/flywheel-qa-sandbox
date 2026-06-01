/**
 * FLY-182 (Codex R1#10): FLYWHEEL_MAILBOX_WRITE_TIMEOUT_MS must be wired in the
 * factory. This validates the parse helper used by createLeadRuntime().
 */

import { afterEach, describe, expect, it } from "vitest";
import { resolveMailboxWriteTimeoutMs } from "../bridge/plugin.js";

describe("resolveMailboxWriteTimeoutMs", () => {
	const saved = process.env.FLYWHEEL_MAILBOX_WRITE_TIMEOUT_MS;
	afterEach(() => {
		if (saved === undefined)
			delete process.env.FLYWHEEL_MAILBOX_WRITE_TIMEOUT_MS;
		else process.env.FLYWHEEL_MAILBOX_WRITE_TIMEOUT_MS = saved;
	});

	it("returns undefined when unset (→ MailboxLeadRuntime default 3000)", () => {
		delete process.env.FLYWHEEL_MAILBOX_WRITE_TIMEOUT_MS;
		expect(resolveMailboxWriteTimeoutMs()).toBeUndefined();
	});

	it("returns a valid positive integer override", () => {
		process.env.FLYWHEEL_MAILBOX_WRITE_TIMEOUT_MS = "8000";
		expect(resolveMailboxWriteTimeoutMs()).toBe(8000);
	});

	it("returns undefined for invalid / non-positive values", () => {
		for (const bad of ["0", "-1", "abc", "3.5", "", "  "]) {
			process.env.FLYWHEEL_MAILBOX_WRITE_TIMEOUT_MS = bad;
			expect(resolveMailboxWriteTimeoutMs()).toBeUndefined();
		}
	});
});
