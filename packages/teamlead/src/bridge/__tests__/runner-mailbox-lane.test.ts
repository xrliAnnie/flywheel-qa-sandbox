import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { encodeSenderRef } from "flywheel-comm/sender-ref";
import { wakeRunnerMailbox } from "flywheel-comm/wake";
import { describe, expect, it, vi } from "vitest";
import {
	ProductionRunnerMailboxDeliveryAdapter,
	RunnerMailboxLane,
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
			vi.mocked(wakeRunnerMailbox).mockResolvedValue({ ok: true });
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
			});
			expect(wakeRunnerMailbox).toHaveBeenCalledWith(
				expect.objectContaining({ execId: "exec-1", backend: "codex" }),
			);
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
			const deliver = vi.fn(async () => ({ status: "delivered" as const }));
			const lane = new RunnerMailboxLane({
				queue: q,
				ownerEpoch: "owner-1",
				deliver,
				now: () => new Date(NOW),
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
			});
			expect(await lane.tick()).toMatchObject({ delivered: 0, failed: 1 });
			expect(q.getById("instruction-1")?.state).toBe("QUEUED");
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
});
