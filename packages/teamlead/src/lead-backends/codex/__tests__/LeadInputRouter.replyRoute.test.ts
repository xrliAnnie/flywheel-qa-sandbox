import { describe, expect, it, vi } from "vitest";
import {
	LeadInputRouter,
	type OutboundSender,
	type TurnExecutor,
} from "../LeadInputRouter.js";
import { InMemoryJournalStore, LeadJournal } from "../LeadJournal.js";
import type { RoundtableReplyRoute } from "../roundtable-reply-route.js";

const silent = { warn: vi.fn(), error: vi.fn() };

const ROUTE: RoundtableReplyRoute = {
	kind: "roundtable_thread_from_message",
	parentChannelId: "roundtable",
	sourceMessageId: "42",
	threadId: "42",
};

class FakeExecutor implements TurnExecutor {
	async startTurn(args: { input: string }): Promise<string> {
		return `turn-${args.input}`;
	}
	async awaitCompletion(): Promise<{ output: string }> {
		return { output: "the reply" };
	}
	async reconcile(): Promise<{ exists: boolean; completed: boolean }> {
		return { exists: false, completed: false };
	}
}

/** Build a router whose ensure + sender both append to a shared `order` array so
 * tests can assert the ensure-before-deliver ordering. */
function makeRouter(opts: { ensure?: boolean } = {}) {
	const store = new InMemoryJournalStore();
	let c = 0;
	const journal = new LeadJournal({
		store,
		idFactory: () => `e-${++c}`,
		now: () => ++c,
	});
	const order: string[] = [];
	const ensure = vi.fn(async (r: RoundtableReplyRoute) => {
		order.push(`ensure:${r.threadId}`);
	});
	const sender: OutboundSender = {
		async enqueue(args) {
			order.push(`enqueue:${args.channelId ?? "default"}`);
			return "ob-1";
		},
		async deliver(outboxId) {
			order.push(`deliver:${outboxId}`);
		},
	};
	const router = new LeadInputRouter({
		leadId: "lead-x",
		threadId: "th-1",
		journal,
		executor: new FakeExecutor(),
		sender,
		correlationFactory: () => "corr-1",
		logger: silent,
		...(opts.ensure ? { ensureReplyRoute: ensure } : {}),
	});
	return { router, journal, store, ensure, order };
}

describe("LeadInputRouter — reply-in-thread ensure (FLY-314 Phase 2)", () => {
	it("calls ensureReplyRoute BEFORE enqueue/deliver on the normal path", async () => {
		const { router, ensure, order } = makeRouter({ ensure: true });
		router.submit({
			idempotencyKey: "42",
			source: "discord",
			payload: "hi",
			replyChannelId: "42",
			replyRoute: ROUTE,
		});
		await router.whenIdle();
		expect(ensure).toHaveBeenCalledWith(ROUTE);
		expect(order).toEqual(["ensure:42", "enqueue:42", "deliver:ob-1"]);
	});

	it("does NOT ensure when there is no replyRoute (byte-compat)", async () => {
		const { router, ensure } = makeRouter({ ensure: true });
		router.submit({ idempotencyKey: "k", source: "discord", payload: "hi" });
		await router.whenIdle();
		expect(ensure).not.toHaveBeenCalled();
	});

	it("output_pending recovery ensures then delivers the SAME outbox — no re-enqueue (Codex R3#1)", async () => {
		const { router, journal, store, ensure, order } = makeRouter({
			ensure: true,
		});
		// Seed a journal entry stuck at output_pending (crashed after enqueue, before
		// delivery) carrying the durable replyRoute + outboxId.
		const { entry } = journal.accept({
			idempotencyKey: "42",
			source: "discord",
			payload: "hi",
			replyChannelId: "42",
			replyRoute: ROUTE,
		});
		journal.toDispatching(entry.id, "corr-1");
		journal.toDispatched(entry.id, "turn-1");
		journal.toModelCompleted(entry.id, "the reply");
		journal.toOutputPending(entry.id, "ob-seed");

		await router.recover();

		expect(ensure).toHaveBeenCalledWith(ROUTE);
		// delivered the SEEDED outbox; NEVER re-enqueued (preserves direct-mode boundary)
		expect(order).toEqual(["ensure:42", "deliver:ob-seed"]);
		expect(store.getById(entry.id)?.state).toBe("completed");
	});
});
