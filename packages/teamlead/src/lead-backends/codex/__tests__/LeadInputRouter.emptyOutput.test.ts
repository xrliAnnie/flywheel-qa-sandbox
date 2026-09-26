import { renderDiscordChatContent } from "flywheel-comm/discord-chat-ingest";
import { describe, expect, it, vi } from "vitest";
import { formatMailboxBatchHeader } from "../../../bridge/mailbox-batch-header.js";
import {
	LeadInputRouter,
	type OutboundSender,
	type TurnExecutor,
} from "../LeadInputRouter.js";
import {
	InMemoryJournalStore,
	type JournalEntry,
	LeadJournal,
} from "../LeadJournal.js";

/** FLY-2862: a Codex turn that ends with no text must never reach Discord. */

class FakeExecutor implements TurnExecutor {
	output = "";
	reconcileResult: {
		exists: boolean;
		completed: boolean;
		turnId?: string;
		output?: string;
	} = { exists: false, completed: false };
	async startTurn(): Promise<string> {
		return "turn-1";
	}
	async awaitCompletion(): Promise<{ output: string }> {
		return { output: this.output };
	}
	async reconcile() {
		return this.reconcileResult;
	}
}

class FakeSender implements OutboundSender {
	enqueued: Array<{ text: string; channelId?: string }> = [];
	delivered: string[] = [];
	async enqueue(args: { text: string; channelId?: string }): Promise<string> {
		this.enqueued.push({ text: args.text, channelId: args.channelId });
		return `ob-${this.enqueued.length}`;
	}
	async deliver(outboxId: string): Promise<void> {
		this.delivered.push(outboxId);
	}
}

const VOICE_THREAD = "1549900000000000001";

function voicePayload(): string {
	const body = renderDiscordChatContent({
		v: 1,
		deliveryId: "chat:lead-x:1549900000000000002",
		leadId: "lead-x",
		chatId: VOICE_THREAD,
		originChannelId: VOICE_THREAD,
		messageId: "1549900000000000002",
		authorId: "1485896147951419434",
		authorName: "founder",
		ts: "2026-09-24T21:48:00.000Z",
		priority: 1,
		msgKind: "guild",
		attachments: [],
		text: "我要测什么",
		origin: "voice",
		voiceSessionId: "7f1dc054-c257-4ca0-ab97-13beab6ca640",
		replyChannelId: VOICE_THREAD,
	});
	return `${formatMailboxBatchHeader({ batchId: "mailbox-batch:v", count: 1, fromAgent: "founder" })}\n\n${body}`;
}

const TICK = `${formatMailboxBatchHeader({ batchId: "mailbox-batch:t", count: 1, fromAgent: "bridge" })}\n\n[patrol_tick]`;

function make() {
	const store = new InMemoryJournalStore();
	let c = 0;
	const journal = new LeadJournal({
		store,
		idFactory: () => `e-${++c}`,
		now: () => ++c,
	});
	const executor = new FakeExecutor();
	const sender = new FakeSender();
	const completed: JournalEntry[] = [];
	const failed: Array<{ entry: JournalEntry; reason: string }> = [];
	const logger = { warn: vi.fn(), error: vi.fn() };
	const router = new LeadInputRouter({
		leadId: "lead-x",
		threadId: "th-1",
		journal,
		executor,
		sender,
		logger,
		onEntryCompleted: (entry) => completed.push(entry),
		onReplyFailed: (entry, reason) => failed.push({ entry, reason }),
	});
	return {
		store,
		journal,
		executor,
		sender,
		router,
		completed,
		failed,
		logger,
	};
}

describe("LeadInputRouter — empty final answer (FLY-2862)", () => {
	it("an inbound that owes nothing closes silent_no_reply without any send", async () => {
		const { router, sender, store, completed, failed } = make();
		const { entryId } = router.submitBatch({
			batchId: "b-tick",
			memberIds: ["d-1"],
			payload: TICK,
		});
		await router.whenIdle();
		expect(sender.enqueued).toEqual([]);
		expect(store.getById(entryId)).toMatchObject({
			state: "completed",
			reason: "silent_no_reply",
			output: "",
		});
		expect(completed.map((entry) => entry.id)).toEqual([entryId]);
		expect(failed).toEqual([]);
	});

	it("a voice turn with an empty answer is a diagnosable failure, never a Discord post", async () => {
		const { router, sender, store, completed, failed } = make();
		const { entryId } = router.submitBatch({
			batchId: "b-voice",
			memberIds: ["d-2"],
			payload: voicePayload(),
			replyChannelId: VOICE_THREAD,
		});
		await router.whenIdle();
		expect(sender.enqueued).toEqual([]);
		expect(store.getById(entryId)).toMatchObject({
			state: "dead_letter",
			reason: "empty_final_answer",
		});
		expect(completed).toEqual([]);
		expect(failed).toHaveLength(1);
		expect(failed[0]).toMatchObject({
			reason: "empty_final_answer",
			entry: { id: entryId, replyChannelId: VOICE_THREAD },
		});
	});

	it("whitespace-only output counts as empty", async () => {
		const { router, sender, executor, store } = make();
		executor.output = " \n\t ";
		const { entryId } = router.submitBatch({
			batchId: "b-ws",
			memberIds: ["d-3"],
			payload: voicePayload(),
		});
		await router.whenIdle();
		expect(sender.enqueued).toEqual([]);
		expect(store.getById(entryId)?.state).toBe("dead_letter");
	});

	it("a non-empty answer is still delivered and completed", async () => {
		const { router, sender, executor, store, failed } = make();
		executor.output = "我在，你说。";
		const { entryId } = router.submitBatch({
			batchId: "b-ok",
			memberIds: ["d-4"],
			payload: voicePayload(),
			replyChannelId: VOICE_THREAD,
		});
		await router.whenIdle();
		expect(sender.enqueued).toEqual([
			{ text: "我在，你说。", channelId: VOICE_THREAD },
		]);
		expect(store.getById(entryId)?.state).toBe("completed");
		expect(store.getById(entryId)?.reason).toBeUndefined();
		expect(failed).toEqual([]);
	});

	it("a throwing failure hook cannot turn the closed entry ambiguous", async () => {
		const store = new InMemoryJournalStore();
		const journal = new LeadJournal({ store });
		const sender = new FakeSender();
		const logger = { warn: vi.fn(), error: vi.fn() };
		const router = new LeadInputRouter({
			leadId: "lead-x",
			threadId: "th-1",
			journal,
			executor: new FakeExecutor(),
			sender,
			logger,
			onReplyFailed: () => {
				throw new Error("hook boom");
			},
		});
		const { entryId } = router.submitBatch({
			batchId: "b-hook",
			memberIds: ["d-5"],
			payload: voicePayload(),
		});
		await router.whenIdle();
		expect(store.getById(entryId)?.state).toBe("dead_letter");
		expect(logger.error).toHaveBeenCalledWith(
			"reply-failed hook failed",
			expect.objectContaining({ id: entryId }),
		);
	});

	it("recovery never resends a persisted empty answer", async () => {
		const { journal, router, sender, store, failed } = make();
		const { entry } = journal.acceptBatch({
			batchId: "b-rec",
			memberIds: ["d-6"],
			payload: voicePayload(),
		});
		journal.toDispatching(entry.id, "corr-1");
		journal.toDispatched(entry.id, "turn-9");
		journal.toModelCompleted(entry.id, "");
		await router.recover();
		await router.whenIdle();
		expect(sender.enqueued).toEqual([]);
		expect(store.getById(entry.id)?.state).toBe("dead_letter");
		expect(failed).toHaveLength(1);
	});

	it("reconcile of a completed empty turn closes without a send", async () => {
		const { journal, router, sender, executor, store } = make();
		const { entry } = journal.acceptBatch({
			batchId: "b-recon",
			memberIds: ["d-7"],
			payload: TICK,
		});
		journal.toDispatching(entry.id, "corr-2");
		executor.reconcileResult = {
			exists: true,
			completed: true,
			turnId: "turn-7",
			output: "",
		};
		await router.recover();
		await router.whenIdle();
		expect(sender.enqueued).toEqual([]);
		expect(store.getById(entry.id)).toMatchObject({
			state: "completed",
			reason: "silent_no_reply",
		});
	});
});
