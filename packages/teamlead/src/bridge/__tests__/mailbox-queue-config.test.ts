import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_MAILBOX_QUEUE_CONFIG,
	resetMailboxQueueConfigWarningsForTests,
	resolveMailboxQueueConfig,
} from "../mailbox-queue-config.js";

describe("FLY-1573 mailbox queue config", () => {
	beforeEach(() => resetMailboxQueueConfigWarningsForTests());

	it("uses the approved defaults and supports call-time flag changes", () => {
		const env: NodeJS.ProcessEnv = {};
		expect(resolveMailboxQueueConfig(env)).toEqual({
			...DEFAULT_MAILBOX_QUEUE_CONFIG,
			enabled: true,
		});

		env.FLYWHEEL_MAILBOX_QUEUE = "0";
		expect(resolveMailboxQueueConfig(env).enabled).toBe(false);
		env.FLYWHEEL_MAILBOX_QUEUE = "1";
		expect(resolveMailboxQueueConfig(env).enabled).toBe(true);
	});

	it.each([
		["FLYWHEEL_MAILBOX_ACK_LEASE_MS", 10_000, 86_400_000, 1_800_000],
		["FLYWHEEL_MAILBOX_BATCH_WINDOW_MS", 0, 3_600_000, 60_000],
		["FLYWHEEL_MAILBOX_BATCH_MAX", 1, 50, 5],
		["FLYWHEEL_MAILBOX_INFLIGHT_BATCHES", 1, 20, 3],
		["FLYWHEEL_MAILBOX_LEASE_RETRY_MAX", 0, 10, 3],
		["FLYWHEEL_MAILBOX_DEADLETTER_WINDOW_MS", 10_000, 86_400_000, 1_800_000],
	])(
		"validates %s inclusively and falls back outside the range",
		(name, min, max, fallback) => {
			const key = name as keyof NodeJS.ProcessEnv;
			const field = {
				FLYWHEEL_MAILBOX_ACK_LEASE_MS: "ackLeaseMs",
				FLYWHEEL_MAILBOX_BATCH_WINDOW_MS: "batchWindowMs",
				FLYWHEEL_MAILBOX_BATCH_MAX: "batchMaxSize",
				FLYWHEEL_MAILBOX_INFLIGHT_BATCHES: "inflightMaxBatches",
				FLYWHEEL_MAILBOX_LEASE_RETRY_MAX: "leaseRetryMax",
				FLYWHEEL_MAILBOX_DEADLETTER_WINDOW_MS: "deadLetterWindowMs",
			}[name] as keyof typeof DEFAULT_MAILBOX_QUEUE_CONFIG;

			expect(resolveMailboxQueueConfig({ [key]: String(min) })[field]).toBe(
				min,
			);
			expect(resolveMailboxQueueConfig({ [key]: String(max) })[field]).toBe(
				max,
			);
			expect(resolveMailboxQueueConfig({ [key]: String(min - 1) })[field]).toBe(
				fallback,
			);
			expect(resolveMailboxQueueConfig({ [key]: String(max + 1) })[field]).toBe(
				fallback,
			);
			expect(resolveMailboxQueueConfig({ [key]: "1.5" })[field]).toBe(fallback);
		},
	);

	it("warns once per invalid knob", () => {
		const warn = vi.fn();
		const env = { FLYWHEEL_MAILBOX_BATCH_MAX: "nope" };
		resolveMailboxQueueConfig(env, warn);
		resolveMailboxQueueConfig(env, warn);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toContain("FLYWHEEL_MAILBOX_BATCH_MAX");
	});
});
