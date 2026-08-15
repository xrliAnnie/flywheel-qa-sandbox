import { describe, expect, it } from "vitest";
import { mailboxQueueEnabled } from "../feature-flags/mailbox-queue.js";
import { FEATURE_FLAGS } from "../feature-flags/registry.js";
import { NON_FLAG_ALLOWLIST } from "../feature-flags/truth.js";

describe("FLY-1573 mailbox queue flag", () => {
	it("is default-on and only exact 0 restores the legacy flow", () => {
		expect(mailboxQueueEnabled({})).toBe(true);
		expect(mailboxQueueEnabled({ FLYWHEEL_MAILBOX_QUEUE: "0" })).toBe(false);
		expect(mailboxQueueEnabled({ FLYWHEEL_MAILBOX_QUEUE: "1" })).toBe(true);
		expect(mailboxQueueEnabled({ FLYWHEEL_MAILBOX_QUEUE: "false" })).toBe(true);
	});

	it("is registered as a direct-toggleable default-on kill switch", () => {
		const flag = FEATURE_FLAGS.find((flag) => flag.name === "mailbox_queue");
		expect(flag).toMatchObject({
			category: "kill_switch",
			envVar: "FLYWHEEL_MAILBOX_QUEUE",
			polarity: "default_on",
			default: true,
			toggleable: "direct",
		});
		expect(flag?.readSites).toContainEqual({
			file: "packages/inbox-mcp/src/queue-mode.ts",
			symbol: "resolveLiveMailboxQueueEnabled",
			timing: "dotenv_live",
			pattern: "dynamic",
		});
	});

	it("classifies all seven queue parameters as numeric tuning, not flags", () => {
		for (const name of [
			"FLYWHEEL_MAILBOX_ACK_LEASE_MS",
			"FLYWHEEL_MAILBOX_BATCH_WINDOW_MS",
			"FLYWHEEL_MAILBOX_BATCH_MAX",
			"FLYWHEEL_MAILBOX_INFLIGHT_BATCHES",
			"FLYWHEEL_MAILBOX_LEASE_RETRY_MAX",
			"FLYWHEEL_MAILBOX_DEADLETTER_WINDOW_MS",
			"FLYWHEEL_MAILBOX_UNAVAILABLE_RETRY_MAX",
		]) {
			expect(NON_FLAG_ALLOWLIST[name]).toMatch(/numeric tuning/i);
		}
	});
});
