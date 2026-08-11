import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexDiscordMailboxStrategy } from "../CodexDiscordMailboxStrategy.js";
import { ExternalReceiptSaga } from "../ExternalReceiptSaga.js";
import { InMemoryJournalStore, LeadJournal } from "../LeadJournal.js";

const queues: MailboxQueue[] = [];
afterEach(() => queues.splice(0).forEach((queue) => queue.close()));

function setup() {
	const dbPath = join(
		mkdtempSync(join(tmpdir(), "fly1574-codex-strategy-")),
		"comm.db",
	);
	const queue = new MailboxQueue(dbPath);
	queues.push(queue);
	const journal = new LeadJournal({ store: new InMemoryJournalStore() });
	const submit = vi.fn((input) => journal.accept(input));
	const saga = new ExternalReceiptSaga({ leadId: "lead-a", queue, journal });
	const complete = vi.fn((messageId: string) => saga.complete(messageId));
	const strategy = new CodexDiscordMailboxStrategy({
		leadId: "lead-a",
		dbPath,
		queue,
		journal,
		router: { submit },
		externalReceiptSaga: { complete },
	});
	const input = {
		message: {
			id: "323456789012345678",
			channelId: "123456789012345678",
			authorId: "223456789012345678",
			authorBot: false,
			content: "hello",
		},
		payload: "hello",
		createdAt: "2026-08-10T12:00:00.000Z",
	};
	return { queue, journal, submit, complete, saga, strategy, input };
}

describe("CodexDiscordMailboxStrategy", () => {
	it("always enqueues Discord input through the mailbox", () => {
		const state = setup();
		expect(state.strategy.accept(state.input)).toBe("handled");
		expect(state.submit).not.toHaveBeenCalled();
		expect(state.queue.getById("chat:lead-a:323456789012345678")).toMatchObject(
			{
				type: "discord_chat",
				state: "QUEUED",
			},
		);
	});

	it("skips an existing inbox winner on replay", () => {
		const state = setup();
		expect(state.strategy.accept(state.input)).toBe("handled");
		const replay = new CodexDiscordMailboxStrategy({
			leadId: "lead-a",
			dbPath: join("unused"),
			queue: state.queue,
			journal: state.journal,
			router: { submit: state.submit },
			externalReceiptSaga: { complete: state.complete },
		});
		expect(replay.accept(state.input)).toBe("handled");
		expect(state.submit).not.toHaveBeenCalled();
	});

	it("lets a journal-accepted winner fence a mailbox replay", () => {
		const state = setup();
		state.journal.accept({
			idempotencyKey: state.input.message.id,
			source: "discord",
			payload: state.input.payload,
		});
		const replay = new CodexDiscordMailboxStrategy({
			leadId: "lead-a",
			dbPath: join("unused"),
			queue: state.queue,
			journal: state.journal,
			router: { submit: state.submit },
			externalReceiptSaga: { complete: state.complete },
		});
		expect(replay.accept(state.input)).toBe("handled");
		expect(
			state.queue.getById(`chat:lead-a:${state.input.message.id}`),
		).toBeUndefined();
		expect(state.submit).not.toHaveBeenCalled();
	});

	it("pins the cursor until this runtime owns the ingress lock", () => {
		const state = setup();
		const guarded = new CodexDiscordMailboxStrategy({
			leadId: "lead-a",
			dbPath: join("unused"),
			queue: state.queue,
			journal: state.journal,
			router: { submit: state.submit },
			externalReceiptSaga: { complete: state.complete },
			mailboxReady: () => false,
		});
		expect(guarded.accept(state.input)).toBe("retry");
		expect(
			state.queue.getById("chat:lead-a:323456789012345678"),
		).toBeUndefined();
		expect(state.submit).not.toHaveBeenCalled();
	});

	it("repairs both cross-department crash seams without creating a second turn", () => {
		const afterSubmit = setup();
		afterSubmit.saga.begin({
			messageId: afterSubmit.input.message.id,
			channelId: afterSubmit.input.message.channelId,
			content: afterSubmit.input.payload,
			createdAt: afterSubmit.input.createdAt,
		});
		afterSubmit.journal.accept({
			idempotencyKey: afterSubmit.input.message.id,
			source: "discord",
			payload: afterSubmit.input.payload,
		});
		expect(afterSubmit.strategy.accept(afterSubmit.input)).toBe("handled");
		expect(afterSubmit.submit).not.toHaveBeenCalled();
		expect(
			afterSubmit.queue.getById(`xdept:lead-a:${afterSubmit.input.message.id}`)
				?.state,
		).toBe("ACKED");

		const afterBegin = setup();
		afterBegin.saga.begin({
			messageId: afterBegin.input.message.id,
			channelId: afterBegin.input.message.channelId,
			content: afterBegin.input.payload,
			createdAt: afterBegin.input.createdAt,
		});
		expect(afterBegin.strategy.accept(afterBegin.input)).toBe("handled");
		expect(afterBegin.submit).toHaveBeenCalledOnce();
		expect(
			afterBegin.journal.getByIdempotencyKey(afterBegin.input.message.id),
		).toBeDefined();
		expect(
			afterBegin.queue.getById(`xdept:lead-a:${afterBegin.input.message.id}`)
				?.state,
		).toBe("ACKED");
	});
});
