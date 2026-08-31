import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { encodeSenderRef } from "flywheel-comm/sender-ref";
import { wakeRunnerMailbox } from "flywheel-comm/wake";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MAILBOX_QUEUE_CONFIG } from "../mailbox-queue-config.js";
import {
	ProductionRunnerMailboxDeliveryAdapter,
	RunnerMailboxLane,
	renderRunnerMailboxBatchEnvelope,
	renderRunnerMailboxEnvelope,
} from "../runner-mailbox-lane.js";

vi.mock("flywheel-comm/wake", () => ({ wakeRunnerMailbox: vi.fn() }));

const NOW = "2026-08-05T12:00:00.000Z";

function queue(): MailboxQueue {
	const value = new MailboxQueue(":memory:");
	value.acquireOrRenewOwner({
		ownerEpoch: "owner-1",
		now: NOW,
		leaseTtlMs: 60_000,
	});
	return value;
}

describe("RunnerMailboxLane", () => {
	it("routes production delivery through the target session backend", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1572-runner-lane-"));
		const dbPath = join(dir, "comm.db");
		try {
			const db = new CommDB(dbPath);
			db.registerSession(
				"exec-1",
				"session:window",
				"project-a",
				"FLY-1572",
				"lead-a",
				"codex",
			);
			db.close();
			vi.mocked(wakeRunnerMailbox).mockResolvedValue({
				ok: true,
				backend: "codex",
				settlement: "on_consume",
			});
			const adapter = new ProductionRunnerMailboxDeliveryAdapter(dbPath);
			const envelope = {
				mailboxId: "instruction-1",
				executionId: "exec-1",
				fromAgent: "lead-a",
				type: "instruction",
				kind: "instruction" as const,
				content: "continue",
				metadata: { flywheelId: "instruction-1" },
				intentKey: "instruction:instruction-1",
			};
			await expect(adapter.deliver(envelope)).resolves.toEqual({
				status: "delivered",
				backend: "codex",
				settlement: "on_consume",
			});
			expect(wakeRunnerMailbox).toHaveBeenCalledWith(
				expect.objectContaining({ execId: "exec-1", backend: "codex" }),
			);
			adapter.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("uses the adapter-selected settlement when a legacy session has no vendor", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1795-null-vendor-"));
		const dbPath = join(dir, "comm.db");
		try {
			const db = new CommDB(dbPath);
			db.registerSession(
				"exec-legacy",
				"session:legacy",
				"project-a",
				"FLY-1795",
				"lead-a",
			);
			db.close();
			vi.mocked(wakeRunnerMailbox)
				.mockResolvedValueOnce({
					ok: true,
					backend: "claude-code",
					settlement: "on_delivery",
				})
				.mockResolvedValueOnce({
					ok: true,
					backend: "codex",
					settlement: "on_consume",
				});
			const adapter = new ProductionRunnerMailboxDeliveryAdapter(dbPath);
			const envelope = {
				mailboxId: "instruction-legacy",
				executionId: "exec-legacy",
				fromAgent: "lead-a",
				type: "instruction",
				kind: "instruction" as const,
				content: "continue",
				metadata: { flywheelId: "instruction-legacy" },
				intentKey: "instruction:instruction-legacy",
			};

			await expect(adapter.deliver(envelope)).resolves.toMatchObject({
				backend: "claude-code",
				settlement: "on_delivery",
			});
			await expect(adapter.deliver(envelope)).resolves.toMatchObject({
				backend: "codex",
				settlement: "on_consume",
			});
			for (const [input] of vi.mocked(wakeRunnerMailbox).mock.calls.slice(-2)) {
				expect(input).not.toHaveProperty("backend");
			}
			adapter.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rebuilds byte-compatible instruction and response doorbells", () => {
		const q = queue();
		try {
			const instruction = q.enqueue({
				id: "instruction-1",
				fromAgent: "lead-a",
				toAgent: "12345678-aaaa-bbbb-cccc-123456789abc",
				recipientKind: "runner",
				type: "instruction",
				content: "continue",
				createdAt: NOW,
				senderRef: encodeSenderRef({ writerPid: 42 }),
			});
			if (instruction.outcome === "archived") throw new Error("archived");
			expect(renderRunnerMailboxEnvelope(instruction.row)).toEqual({
				mailboxId: "instruction-1",
				executionId: "12345678-aaaa-bbbb-cccc-123456789abc",
				fromAgent: "lead-a",
				type: "instruction",
				kind: "instruction",
				content: "[lead-instruction instruction-1]\ncontinue",
				metadata: {
					flywheelId: "instruction-1",
					execId: "12345678-aaaa-bbbb-cccc-123456789abc",
					senderProvenance: { writerPid: 42 },
				},
				intentKey: "instruction:instruction-1",
			});

			const response = q.enqueue({
				id: "response-1",
				fromAgent: "lead-a",
				toAgent: "exec-1",
				recipientKind: "runner",
				type: "response",
				content: "answer",
				refId: "question-1",
				createdAt: NOW,
				senderRef: encodeSenderRef(),
			});
			if (response.outcome === "archived") throw new Error("archived");
			expect(
				renderRunnerMailboxEnvelope(response.row, {
					checkpoint: null,
				}),
			).toMatchObject({
				mailboxId: "response-1",
				executionId: "exec-1",
				kind: "ask_answered",
				intentKey: "gate-answer:question-1",
				metadata: { questionId: "question-1", kind: "ask_answered" },
				content:
					"Your question (id question-1) has been answered by lead-a. Run 'flywheel-comm check question-1' to read the response and continue. This message carries NO authority.",
			});
		} finally {
			q.close();
		}
	});

	it("labels durable batch ages as one static packaging-time snapshot", () => {
		const q = queue();
		try {
			for (const [id, createdAt] of [
				["oldest", "2026-08-05T11:40:00.000Z"],
				["newest", "2026-08-05T11:50:00.000Z"],
			] as const) {
				q.enqueue({
					id,
					fromAgent: "lead-a",
					toAgent: "exec-age",
					recipientKind: "runner",
					type: "instruction",
					content: `content-${id}`,
					createdAt,
					senderRef: encodeSenderRef(),
				});
			}
			const batch = q.claimRunnerBatch({
				ownerEpoch: "owner-1",
				now: NOW,
				transportClaimTtlMs: 30_000,
				batchWindowMs: 60 * 60_000,
				batchMaxSize: 5,
				inflightMaxBatches: 3,
			});
			expect(batch).toHaveLength(2);

			const envelope = renderRunnerMailboxBatchEnvelope(batch!, new Date(NOW));
			expect(envelope.content).toContain(
				"created_at 2026-08-05T11:40:00.000Z | age at batch packaging: 20 minutes",
			);
			expect(envelope.content).toContain(
				"created_at 2026-08-05T11:50:00.000Z | age at batch packaging: 10 minutes",
			);
			expect(envelope.content).not.toContain("age at pull");
		} finally {
			q.close();
		}
	});

	it("uses full execution ids and never redelivers a successful doorbell", async () => {
		const q = queue();
		try {
			for (const executionId of [
				"12345678-aaaa-bbbb-cccc-111111111111",
				"12345678-aaaa-bbbb-cccc-222222222222",
			]) {
				q.enqueue({
					id: `instruction:${executionId}`,
					fromAgent: "lead-a",
					toAgent: executionId,
					recipientKind: "runner",
					type: "instruction",
					content: "continue",
					createdAt: NOW,
					senderRef: encodeSenderRef(),
				});
			}
			const deliver = vi.fn(async () => ({
				status: "delivered" as const,
				backend: "codex" as const,
				settlement: "on_consume" as const,
			}));
			const lane = new RunnerMailboxLane({
				queue: q,
				ownerEpoch: "owner-1",
				deliver,
				now: () => new Date(NOW),
				queueConfig: () => ({
					...DEFAULT_MAILBOX_QUEUE_CONFIG,
				}),
			});
			expect(await lane.tick()).toMatchObject({ delivered: 2, failed: 0 });
			expect(
				deliver.mock.calls.map(([envelope]) => envelope.executionId),
			).toEqual([
				"12345678-aaaa-bbbb-cccc-111111111111",
				"12345678-aaaa-bbbb-cccc-222222222222",
			]);
			expect(await lane.tick()).toMatchObject({ delivered: 0, failed: 0 });
			expect(deliver).toHaveBeenCalledTimes(2);
		} finally {
			q.close();
		}
	});

	it("requeues a failed doorbell and accepts no-transport as a terminal push", async () => {
		const q = queue();
		try {
			q.enqueue({
				id: "instruction-1",
				fromAgent: "lead-a",
				toAgent: "exec-1",
				recipientKind: "runner",
				type: "instruction",
				content: "continue",
				createdAt: NOW,
				senderRef: encodeSenderRef(),
			});
			const deliver = vi
				.fn()
				.mockResolvedValueOnce({ status: "failed", error: "offline" })
				.mockResolvedValue({ status: "no_transport" });
			let nowMs = Date.parse(NOW);
			const lane = new RunnerMailboxLane({
				queue: q,
				ownerEpoch: "owner-1",
				deliver,
				now: () => new Date(nowMs),
				retryBackoffBaseMs: 5_000,
				retryBackoffCapMs: 5_000,
				queueConfig: () => ({
					...DEFAULT_MAILBOX_QUEUE_CONFIG,
				}),
			});
			expect(await lane.tick()).toMatchObject({ delivered: 0, failed: 1 });
			expect(q.getById("instruction-1")?.state).toBe("LEASED");
			nowMs += 5_000;
			q.acquireOrRenewOwner({
				ownerEpoch: "owner-1",
				now: new Date(nowMs).toISOString(),
				leaseTtlMs: 60_000,
			});
			expect(await lane.tick()).toMatchObject({ delivered: 1, failed: 0 });
			expect(q.getById("instruction-1")?.state).toBe("LEASED");
		} finally {
			q.close();
		}
	});

	it("ON groups three instructions into one verified attempt-scoped doorbell", async () => {
		const q = queue();
		try {
			for (let index = 0; index < 3; index += 1) {
				q.enqueue({
					id: `instruction-${index}`,
					fromAgent: "lead-a",
					toAgent: "exec-1",
					recipientKind: "runner",
					type: "instruction",
					content: `do-${index}`,
					createdAt: new Date(Date.parse(NOW) + index).toISOString(),
					senderRef: encodeSenderRef(),
				});
			}
			const deliver = vi.fn(async () => ({
				status: "delivered" as const,
				backend: "claude-code" as const,
				settlement: "on_delivery" as const,
			}));
			const lane = new RunnerMailboxLane({
				queue: q,
				ownerEpoch: "owner-1",
				deliver,
				now: () => new Date(NOW),
				queueConfig: () => DEFAULT_MAILBOX_QUEUE_CONFIG,
				recipientState: () => "alive",
			});
			expect(await lane.tick()).toMatchObject({ delivered: 3, failed: 0 });
			expect(deliver).toHaveBeenCalledTimes(1);
			const envelope = deliver.mock.calls[0]?.[0];
			expect(envelope?.metadata.flywheelId).toMatch(/#r0$/);
			expect(envelope?.content).toContain("| 3 messages | from lead-a");
			expect(envelope?.content).not.toContain("You must ack this batch");
			for (let index = 0; index < 3; index += 1) {
				expect(envelope?.content).toContain(
					`[lead-instruction instruction-${index}]`,
				);
				expect(q.getById(`instruction-${index}`)).toMatchObject({
					state: "ACKED",
					acked_at: NOW,
					delivered_at: NOW,
					claimed_by: null,
					claim_expires_at: null,
				});
			}
		} finally {
			q.close();
		}
	});

	it("keeps an on-consume runner batch leased for the existing pull path", async () => {
		const q = queue();
		try {
			q.enqueue({
				id: "codex-on-consume",
				fromAgent: "lead-a",
				toAgent: "exec-codex",
				recipientKind: "runner",
				type: "instruction",
				content: "continue",
				createdAt: NOW,
				senderRef: encodeSenderRef(),
			});
			const lane = new RunnerMailboxLane({
				queue: q,
				ownerEpoch: "owner-1",
				deliver: vi.fn(async () => ({
					status: "delivered" as const,
					backend: "codex" as const,
					settlement: "on_consume" as const,
				})),
				now: () => new Date(NOW),
				queueConfig: () => DEFAULT_MAILBOX_QUEUE_CONFIG,
				recipientState: () => "alive",
			});

			expect(await lane.tick()).toMatchObject({ delivered: 1, failed: 0 });
			expect(q.getById("codex-on-consume")).toMatchObject({
				state: "LEASED",
				delivered_at: NOW,
				acked_at: null,
			});
		} finally {
			q.close();
		}
	});

	it("snapshots queue configuration once per tick", async () => {
		const q = queue();
		try {
			for (let index = 0; index < 3; index += 1) {
				q.enqueue({
					id: `hot-${index}`,
					fromAgent: "lead-a",
					toAgent: "exec-hot",
					recipientKind: "runner",
					type: "instruction",
					content: `hot-${index}`,
					createdAt: new Date(Date.parse(NOW) + index).toISOString(),
					senderRef: encodeSenderRef(),
				});
			}
			const queueConfig = vi.fn(() => ({
				...DEFAULT_MAILBOX_QUEUE_CONFIG,
			}));
			const deliver = vi.fn(async () => ({
				status: "delivered" as const,
				backend: "codex" as const,
				settlement: "on_consume" as const,
			}));
			const lane = new RunnerMailboxLane({
				queue: q,
				ownerEpoch: "owner-1",
				deliver,
				now: () => new Date(NOW),
				queueConfig,
				recipientState: () => "alive",
			});

			expect(await lane.tick()).toMatchObject({ delivered: 3 });
			expect(deliver).toHaveBeenCalledTimes(1);
			expect(queueConfig).toHaveBeenCalledTimes(1);

			for (let index = 3; index < 6; index += 1) {
				q.enqueue({
					id: `hot-${index}`,
					fromAgent: "lead-a",
					toAgent: "exec-hot",
					recipientKind: "runner",
					type: "instruction",
					content: `hot-${index}`,
					createdAt: new Date(Date.parse(NOW) + index).toISOString(),
					senderRef: encodeSenderRef(),
				});
			}
			expect(await lane.tick()).toMatchObject({ delivered: 3 });
			expect(deliver).toHaveBeenCalledTimes(2);
			expect(queueConfig).toHaveBeenCalledTimes(2);
			expect(deliver.mock.calls[1]?.[0].content).toContain("| 3 messages |");
		} finally {
			q.close();
		}
	});

	it("runs 600 empty active ticks with zero outbound messages", async () => {
		const q = queue();
		try {
			const deliver = vi.fn(async () => ({
				status: "delivered" as const,
				backend: "codex" as const,
				settlement: "on_consume" as const,
			}));
			const lane = new RunnerMailboxLane({
				queue: q,
				ownerEpoch: "owner-1",
				deliver,
				now: () => new Date(NOW),
				queueConfig: () => DEFAULT_MAILBOX_QUEUE_CONFIG,
				recipientState: () => "alive",
			});
			for (let tick = 0; tick < 600; tick += 1) {
				expect(await lane.tick()).toMatchObject({ delivered: 0, failed: 0 });
			}
			expect(deliver).not.toHaveBeenCalled();
		} finally {
			q.close();
		}
	});

	it("bounds recipient-state and dead-letter routing lookups to the tick budget", async () => {
		const q = queue();
		try {
			for (let index = 0; index < 20; index += 1) {
				q.enqueue({
					id: `live-${index}`,
					fromAgent: "lead-a",
					toAgent: `exec-live-${index}`,
					recipientKind: "runner",
					type: "instruction",
					content: `live-${index}`,
					createdAt: new Date(Date.parse(NOW) + index).toISOString(),
					senderRef: encodeSenderRef(),
				});
				q.enqueue({
					id: `dead-${index}`,
					fromAgent: "lead-a",
					toAgent: `exec-dead-${index}`,
					recipientKind: "runner",
					type: "instruction",
					content: `dead-${index}`,
					createdAt: new Date(Date.parse(NOW) + 100 + index).toISOString(),
					senderRef: encodeSenderRef(),
				});
				q.markDead(`dead-${index}`, NOW, "recipient_terminal");
			}
			const recipientState = vi.fn(() => "alive" as const);
			const resolveOwningLead = vi.fn(() => "lead-a");
			const lane = new RunnerMailboxLane({
				queue: q,
				ownerEpoch: "owner-1",
				deliver: vi.fn(async () => ({
					status: "delivered" as const,
					backend: "codex" as const,
					settlement: "on_consume" as const,
				})),
				now: () => new Date(NOW),
				maxPerTick: 2,
				queueConfig: () => DEFAULT_MAILBOX_QUEUE_CONFIG,
				recipientState,
				resolveOwningLead,
			});

			await lane.tick();
			expect(recipientState.mock.calls.length).toBeLessThanOrEqual(2);
			expect(resolveOwningLead.mock.calls.length).toBeLessThanOrEqual(2);
		} finally {
			q.close();
		}
	});

	it("throttles dead-letter scans while continuing runner delivery every tick", async () => {
		const q = queue();
		try {
			let nowMs = Date.parse(NOW);
			const deliver = vi.fn(async () => ({
				status: "delivered" as const,
				backend: "claude-code" as const,
				settlement: "on_delivery" as const,
			}));
			const probeFactsByRecipient = vi.fn(() => new Map<string, string>());
			const lane = new RunnerMailboxLane({
				queue: q,
				ownerEpoch: "owner-1",
				deliver,
				now: () => new Date(nowMs),
				queueConfig: () => ({
					...DEFAULT_MAILBOX_QUEUE_CONFIG,
					deadLetterWindowMs: 0,
					deadLetterScanIntervalMs: 30_000,
				}),
				recipientState: () => "alive",
				resolveOwningLead: () => "lead-a",
				probeFactsByRecipient,
			});
			const enqueueRunner = (id: string) =>
				q.enqueue({
					id,
					fromAgent: "lead-a",
					toAgent: "exec-dead",
					recipientKind: "runner",
					type: "instruction",
					content: id,
					createdAt: new Date(nowMs).toISOString(),
					senderRef: encodeSenderRef(),
				});
			const dead1 = enqueueRunner("dead-1");
			if (dead1.outcome === "archived") throw new Error("archived seed");
			q.markDead("dead-1", new Date(nowMs).toISOString(), "test");
			enqueueRunner("live-1");
			expect(await lane.tick()).toMatchObject({ delivered: 1 });
			expect(q.getById(`dead_letter:exec-dead:${dead1.row.seq}`)).toBeTruthy();
			expect(probeFactsByRecipient).toHaveBeenCalledTimes(1);

			nowMs += 1_000;
			const dead2 = enqueueRunner("dead-2");
			if (dead2.outcome === "archived") throw new Error("archived seed");
			q.markDead("dead-2", new Date(nowMs).toISOString(), "test");
			enqueueRunner("live-2");
			expect(await lane.tick()).toMatchObject({ delivered: 1 });
			expect(
				q.getById(`dead_letter:exec-dead:${dead2.row.seq}`),
			).toBeUndefined();
			expect(probeFactsByRecipient).toHaveBeenCalledTimes(1);

			nowMs += 29_000;
			enqueueRunner("live-3");
			expect(await lane.tick()).toMatchObject({ delivered: 1 });
			expect(q.getById(`dead_letter:exec-dead:${dead2.row.seq}`)).toBeTruthy();
			expect(deliver).toHaveBeenCalledTimes(3);
			expect(probeFactsByRecipient).toHaveBeenCalledTimes(2);
		} finally {
			q.close();
		}
	});
});
