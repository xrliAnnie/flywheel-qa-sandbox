import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { encodeSenderRef } from "flywheel-comm/sender-ref";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_MAILBOX_QUEUE_CONFIG,
	resetMailboxQueueConfigWarningsForTests,
	resolveMailboxQueueConfig,
} from "../mailbox-queue-config.js";

describe("FLY-1573 mailbox queue config", () => {
	beforeEach(() => resetMailboxQueueConfigWarningsForTests());

	it("always uses the queue path even when the retired flag is zero", () => {
		const legacyKey = ["FLYWHEEL", "MAILBOX", "QUEUE"].join("_");
		const config = resolveMailboxQueueConfig({ [legacyKey]: "0" });

		expect(config).toEqual(DEFAULT_MAILBOX_QUEUE_CONFIG);
		expect(config).not.toHaveProperty("enabled");
	});

	it("packs at most 10 messages from the head's 30-second coalescing window", () => {
		const queue = new MailboxQueue(":memory:");
		const config = resolveMailboxQueueConfig({});
		const ownerEpoch = "owner-1751";
		const t0 = Date.parse("2026-08-14T12:00:00.000Z");
		const at = (seconds: number) =>
			new Date(t0 + seconds * 1_000).toISOString();
		const enqueue = (id: string, seconds: number) =>
			queue.enqueue({
				id,
				fromAgent: "founder",
				toAgent: "lead-a",
				recipientKind: "lead",
				type: "discord_chat",
				content: id,
				createdAt: at(seconds),
				senderRef: encodeSenderRef(),
			});
		const claim = (batchId: string, now: string) =>
			queue.claimLeadBatchQueue({
				toAgent: "lead-a",
				msgClass: "model",
				ownerEpoch,
				batchId,
				now,
				transportClaimTtlMs: config.ackLeaseMs,
				batchWindowMs: config.batchWindowMs,
				batchMaxSize: config.batchMaxSize,
				inflightMaxBatches: config.inflightMaxBatches,
			});

		try {
			queue.acquireOrRenewOwner({
				ownerEpoch,
				now: at(0),
				leaseTtlMs: 3_600_000,
			});
			for (let index = 0; index < 12; index += 1) {
				enqueue(`capacity-${index}`, index);
			}
			expect(claim("capacity-batch", at(12))).toHaveLength(10);
			expect(queue.getById("capacity-10")?.state).toBe("QUEUED");

			queue.recordLeadBatchDelivered({
				batchId: "capacity-batch",
				ownerEpoch,
				now: at(12),
				ackLeaseTtlMs: config.ackLeaseMs,
			});
			queue.ackBatchByRecipient({
				batchId: "capacity-batch",
				fromAgent: "lead-a",
				now: at(13),
			});

			enqueue("window-head", 100);
			enqueue("window-outside", 131);
			expect(claim("window-batch-1", at(131)).map(({ id }) => id)).toEqual([
				"capacity-10",
				"capacity-11",
			]);
			queue.recordLeadBatchDelivered({
				batchId: "window-batch-1",
				ownerEpoch,
				now: at(131),
				ackLeaseTtlMs: config.ackLeaseMs,
			});
			queue.ackBatchByRecipient({
				batchId: "window-batch-1",
				fromAgent: "lead-a",
				now: at(132),
			});

			expect(claim("window-batch-2", at(132)).map(({ id }) => id)).toEqual([
				"window-head",
			]);
			queue.recordLeadBatchDelivered({
				batchId: "window-batch-2",
				ownerEpoch,
				now: at(132),
				ackLeaseTtlMs: config.ackLeaseMs,
			});
			queue.ackBatchByRecipient({
				batchId: "window-batch-2",
				fromAgent: "lead-a",
				now: at(133),
			});
			expect(claim("window-batch-3", at(133)).map(({ id }) => id)).toEqual([
				"window-outside",
			]);
		} finally {
			queue.close();
		}
	});

	it.each([
		["FLYWHEEL_MAILBOX_ACK_LEASE_MS", 10_000, 86_400_000, 1_800_000],
		["FLYWHEEL_MAILBOX_BATCH_WINDOW_MS", 0, 3_600_000, 30_000],
		["FLYWHEEL_MAILBOX_BATCH_MAX", 1, 50, 10],
		["FLYWHEEL_MAILBOX_INFLIGHT_BATCHES", 1, 20, 3],
		["FLYWHEEL_MAILBOX_LEASE_RETRY_MAX", 0, 10, 3],
		["FLYWHEEL_MAILBOX_DEADLETTER_WINDOW_MS", 10_000, 86_400_000, 1_800_000],
		["FLYWHEEL_MAILBOX_UNAVAILABLE_RETRY_MAX", 1, 100_000, 55],
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
				FLYWHEEL_MAILBOX_UNAVAILABLE_RETRY_MAX: "unavailableRetryMax",
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
