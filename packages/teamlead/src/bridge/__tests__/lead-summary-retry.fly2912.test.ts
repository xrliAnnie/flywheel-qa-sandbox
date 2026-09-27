import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { encodeSenderRef } from "flywheel-comm/sender-ref";
import { afterEach, expect, it, vi } from "vitest";
import { LeadJournal } from "../../lead-backends/codex/LeadJournal.js";
import { SqliteJournalStore } from "../../lead-backends/codex/SqliteJournalStore.js";
import { buildLeadAuditSummaryOffer } from "../lead-audit-summary.js";
import {
	ClaudeLeadDeliveryAdapter,
	type LeadDeliveryAdapter,
	type LeadDeliveryBatch,
} from "../lead-delivery-adapter.js";
import { LeadInboxLoop } from "../lead-inbox-loop.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
	for (const close of cleanup.splice(0).reverse()) close();
});

const cases = (["claude", "codex"] as const).flatMap((backend) =>
	[false, true].flatMap((discord) =>
		(
			[
				"OFF-to-ON",
				"ON-to-OFF",
				"upgrade retry",
				"upgrade crash",
				"unsupported downgrade",
			] as const
		).map((scenario) => ({ backend, discord, scenario })),
	),
);

it.each(cases)(
	"checks $backend retry compatibility on $scenario (Discord=$discord)",
	async ({ backend, discord, scenario }) => {
		const root = mkdtempSync(join(tmpdir(), "fly2912-summary-retry-"));
		cleanup.push(() => rmSync(root, { recursive: true, force: true }));
		const queue = new MailboxQueue(join(root, "comm.db"));
		cleanup.push(() => queue.close());
		const journalStore = new SqliteJournalStore(join(root, "journal.db"));
		cleanup.push(() => journalStore.close());
		const journal = new LeadJournal({ store: journalStore });
		const transport: LeadDeliveryAdapter =
			backend === "claude"
				? new ClaudeLeadDeliveryAdapter({
						inboxPath: join(root, "inbox.json"),
						sidecarPath: join(root, "inbox.sidecar.jsonl"),
					})
				: {
						async deliverBatch(batch) {
							const memberIds = batch.members.map(
								({ deliveryId }) => deliveryId,
							);
							const result = journal.acceptBatch({
								batchId: batch.batchId,
								memberIds,
								payload: batch.modelPayload,
								replyChannelId: batch.replyChannelId,
								replyRoute: batch.replyRoute,
							});
							return {
								batchId: batch.batchId,
								memberIds,
								status: result.status,
							};
						},
					};
		let nowMs = Date.parse("2099-07-19T12:00:00.000Z");
		let enabled = scenario !== "OFF-to-ON";
		let installed = !scenario.startsWith("upgrade");
		const snapshot = {
			generation: "generation-a",
			startSeq: 0,
			startEventId: null,
			recovered: false,
			fromSeq: 0,
			throughSeq: 3,
			anchorEventId: "event-3",
			total: 3,
			counts: { stage_changed: 3 },
			representatives: [],
		};
		const store = {
			getFlagValueRow: () => ({ hasOverride: true, raw: enabled ? "1" : "0" }),
			getNotificationAuditGeneration: vi.fn(() => snapshot),
			readLeadAuditSummary: vi.fn(() => snapshot),
		};
		const scope = () => ({
			projectName: "p",
			leadId: "lead-a",
			ownerEpoch: "owner-a",
			now: new Date(nowMs).toISOString(),
		});
		let sequence = 0;
		const batches: LeadDeliveryBatch[] = [];
		const statuses: string[] = [];
		const loop = () =>
			new LeadInboxLoop({
				queue,
				leadId: "lead-a",
				ownerEpoch: "owner-a",
				hasLiveSession: () => false,
				handleProtocol: async () => ({ disposition: "done" }),
				now: () => new Date(nowMs),
				batchIdFactory: () => `batch-${++sequence}`,
				retryBackoffBaseMs: 5_000,
				retryBackoffCapMs: 5_000,
				prepareAuditSummary: (input) =>
					installed
						? buildLeadAuditSummaryOffer({ ...scope(), ...input, queue, store })
						: undefined,
				adapter: {
					async deliverBatch(batch) {
						batches.push(structuredClone(batch));
						const receipt = await transport.deliverBatch(batch);
						statuses.push(receipt.status);
						if (batches.length === 1) throw new Error("accepted, receipt lost");
						return receipt;
					},
				},
			});
		const enqueue = (id: string) =>
			queue.enqueue({
				id,
				fromAgent: discord ? "founder" : "runner",
				toAgent: "lead-a",
				recipientKind: "lead",
				type: discord ? "discord_chat" : "regular",
				senderRef: encodeSenderRef(),
				content: discord
					? `[discord-chat-receipt v1] ${JSON.stringify({
							v: 1,
							receiptId: "chat:lead-a:423456789012345678",
							leadId: "lead-a",
							chatId: "123456789012345678",
							originChannelId: "123456789012345678",
							messageId: "423456789012345678",
							authorId: "223456789012345678",
							authorName: "Annie",
							ts: scope().now,
							priority: 1,
							msgKind: "guild",
							attachments: [],
							text: id,
							replyChannelId: "323456789012345678",
						})}`
					: id,
				deliveryContent: id,
			});
		enqueue("real-task");
		if (scenario === "upgrade crash") {
			// Model a process death after durable transport acceptance and before
			// queue failure accounting. The retry counter stays zero.
			vi.spyOn(queue, "recordLeadDeliveryFailure").mockImplementationOnce(
				() => {
					throw new Error("crash before failure accounting");
				},
			);
		}
		expect((await loop().tick()).ok).toBe(false);
		expect(statuses).toEqual(["accepted_new"]);
		expect(queue.getById("real-task")?.retry_count).toBe(
			scenario === "upgrade crash" ? 0 : 1,
		);
		installed = scenario !== "unsupported downgrade";
		enabled = scenario !== "ON-to-OFF";
		nowMs += 5_000;
		expect((await loop().tick()).ok).toBe(true);
		if (scenario === "unsupported downgrade") {
			// Diagnostic, not a supported-delivery assertion: omit the hook as a
			// pre-summary binary would. Actual transport dedupe rejects the changed
			// payload; the unchanged legacy conflict branch dead-letters the task.
			expect(statuses).toEqual(["accepted_new", "membership_conflict"]);
			expect(queue.getById("real-task")).toMatchObject({
				state: "DEAD",
				dead_reason: discord
					? "discord_undeliverable:membership_conflict:batch-1"
					: "membership_conflict:batch-1",
				delivery_content: "real-task",
				notified_at: null,
			});
			expect(batches[0]?.modelPayload).toContain("只读账目概览");
			expect(batches[1]?.modelPayload).not.toContain("只读账目概览");
			if (backend === "codex")
				expect(journalStore.listUnfinished()).toHaveLength(1);
			else
				expect(
					JSON.parse(readFileSync(join(root, "inbox.json"), "utf8")),
				).toHaveLength(1);
			return;
		}
		expect(queue.getById("real-task")).toMatchObject({
			state: "LEASED",
			dead_reason: null,
			last_error: null,
		});
		expect(queue.getById("real-task")?.notified_at).not.toBeNull();
		expect(statuses).toEqual([
			"accepted_new",
			"accepted_duplicate_same_membership",
		]);
		expect(batches[1]).toEqual(batches[0]);
		const offer = queue.getLeadAuditSummaryOffer({
			...scope(),
			transportBatchId: "batch-1#r0",
		});
		if (scenario === "ON-to-OFF") {
			expect(offer?.content).toContain("只读账目概览");
			expect(offer?.acceptedAt).not.toBeNull();
		} else {
			expect(offer?.content).toBe("");
			expect(store.readLeadAuditSummary).not.toHaveBeenCalled();
			expect(queue.ack("real-task", scope().now)).toBe(true);
			enqueue("next-task");
			expect((await loop().tick()).ok).toBe(true);
			expect(batches[2]?.modelPayload).toContain("只读账目概览");
			expect(statuses[2]).toBe("accepted_new");
		}
	},
);
