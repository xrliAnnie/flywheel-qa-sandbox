import { describe, expect, it, vi } from "vitest";
import {
	LeadInputRouter,
	type OutboundSender,
	type TurnExecutor,
} from "../LeadInputRouter.js";
import { InMemoryJournalStore, LeadJournal } from "../LeadJournal.js";

const silent = { warn: vi.fn(), error: vi.fn() };

/** Fake executor: deterministic turnIds + resolvable completions. */
class FakeExecutor implements TurnExecutor {
	startCalls: Array<{ input: string; clientUserMessageId: string }> = [];
	private turnSeq = 0;
	completions = new Map<string, { output: string }>();
	failStartFor?: string; // throw on startTurn when input matches
	failAwaitFor?: string; // throw on awaitCompletion for turnId
	reconcileResult: {
		exists: boolean;
		completed: boolean;
		turnId?: string;
		output?: string;
	} = { exists: false, completed: false };

	async startTurn(args: {
		threadId: string;
		input: string;
		clientUserMessageId: string;
	}): Promise<string> {
		this.startCalls.push({
			input: args.input,
			clientUserMessageId: args.clientUserMessageId,
		});
		if (this.failStartFor === args.input) throw new Error("startTurn boom");
		const turnId = `turn-${++this.turnSeq}`;
		this.completions.set(turnId, { output: `reply:${args.input}` });
		return turnId;
	}
	async awaitCompletion(turnId: string): Promise<{ output: string }> {
		if (this.failAwaitFor === turnId) throw new Error("awaitCompletion boom");
		return this.completions.get(turnId) ?? { output: "" };
	}
	async reconcile(): Promise<{
		exists: boolean;
		completed: boolean;
		turnId?: string;
		output?: string;
	}> {
		return this.reconcileResult;
	}
}

class FakeSender implements OutboundSender {
	enqueued: Array<{
		text: string;
		idempotencyKey: string;
		channelId?: string;
	}> = [];
	delivered: string[] = [];
	private seq = 0;
	async enqueue(args: {
		leadId: string;
		text: string;
		idempotencyKey: string;
		channelId?: string;
	}): Promise<string> {
		this.enqueued.push({
			text: args.text,
			idempotencyKey: args.idempotencyKey,
			channelId: args.channelId,
		});
		return `ob-${++this.seq}`;
	}
	async deliver(outboxId: string): Promise<void> {
		this.delivered.push(outboxId);
	}
}

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
	let corr = 0;
	const router = new LeadInputRouter({
		leadId: "lead-x",
		threadId: "th-1",
		journal,
		executor,
		sender,
		correlationFactory: () => `corr-${++corr}`,
		logger: silent,
	});
	return { store, journal, executor, sender, router };
}

describe("LeadInputRouter — happy path", () => {
	it("processes an accepted input through to completed (turn + delivery)", async () => {
		const { router, executor, sender, store } = make();
		const { accepted, entryId } = router.submit({
			idempotencyKey: "k1",
			source: "discord",
			payload: "hello",
		});
		expect(accepted).toBe(true);
		await router.whenIdle();
		expect(executor.startCalls).toHaveLength(1);
		expect(executor.startCalls[0].clientUserMessageId).toBe("corr-1");
		expect(sender.enqueued[0].text).toBe("reply:hello");
		expect(sender.delivered).toHaveLength(1);
		expect(store.getById(entryId)?.state).toBe("completed");
	});

	it("dedupes a duplicate idempotencyKey (not reprocessed)", async () => {
		const { router, executor } = make();
		router.submit({ idempotencyKey: "k", source: "discord", payload: "a" });
		const dup = router.submit({
			idempotencyKey: "k",
			source: "discord",
			payload: "a",
		});
		expect(dup.accepted).toBe(false);
		await router.whenIdle();
		expect(executor.startCalls).toHaveLength(1);
	});

	it("processes serially — second turn starts only after the first completes", async () => {
		const { router, executor } = make();
		// Make awaitCompletion of turn-1 block until we release it.
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const realAwait = executor.awaitCompletion.bind(executor);
		executor.awaitCompletion = async (turnId: string) => {
			if (turnId === "turn-1") await gate;
			return realAwait(turnId);
		};
		router.submit({
			idempotencyKey: "k1",
			source: "discord",
			payload: "first",
		});
		router.submit({
			idempotencyKey: "k2",
			source: "discord",
			payload: "second",
		});
		// Let the loop start turn-1 and block.
		await Promise.resolve();
		await Promise.resolve();
		expect(executor.startCalls.map((c) => c.input)).toEqual(["first"]);
		release();
		await router.whenIdle();
		expect(executor.startCalls.map((c) => c.input)).toEqual([
			"first",
			"second",
		]);
	});

	it("the next turn waits for the FULL lifecycle (blocked sender.deliver holds it)", async () => {
		// CR MED-3: prove serialization spans delivery, not just model completion.
		const { router, executor, sender } = make();
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const realDeliver = sender.deliver.bind(sender);
		let firstDeliverSeen = false;
		sender.deliver = async (outboxId: string) => {
			if (!firstDeliverSeen) {
				firstDeliverSeen = true;
				await gate; // hold the first delivery
			}
			return realDeliver(outboxId);
		};
		router.submit({
			idempotencyKey: "k1",
			source: "discord",
			payload: "first",
		});
		router.submit({
			idempotencyKey: "k2",
			source: "discord",
			payload: "second",
		});
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		// First turn ran + is stuck in delivery; second has NOT started yet.
		expect(executor.startCalls.map((c) => c.input)).toEqual(["first"]);
		release();
		await router.whenIdle();
		expect(executor.startCalls.map((c) => c.input)).toEqual([
			"first",
			"second",
		]);
	});
});

describe("LeadInputRouter — failures never auto-retry", () => {
	it("startTurn failure → entry ambiguous, no delivery", async () => {
		const { router, executor, sender, store } = make();
		executor.failStartFor = "bad";
		const { entryId } = router.submit({
			idempotencyKey: "k",
			source: "discord",
			payload: "bad",
		});
		await router.whenIdle();
		expect(store.getById(entryId)?.state).toBe("ambiguous");
		expect(sender.delivered).toHaveLength(0);
	});

	it("awaitCompletion failure → ambiguous (model may have run; no re-run)", async () => {
		const { router, executor, store } = make();
		executor.failAwaitFor = "turn-1";
		const { entryId } = router.submit({
			idempotencyKey: "k",
			source: "discord",
			payload: "x",
		});
		await router.whenIdle();
		expect(store.getById(entryId)?.state).toBe("ambiguous");
	});
});

describe("LeadInputRouter — recovery", () => {
	it("redispatches an 'accepted' unfinished entry", async () => {
		const { router, journal, executor, store } = make();
		const { entry } = journal.accept({
			idempotencyKey: "k",
			source: "discord",
			payload: "p",
		});
		await router.recover();
		await router.whenIdle();
		expect(executor.startCalls).toHaveLength(1);
		expect(store.getById(entry.id)?.state).toBe("completed");
	});

	it("reconcile: a completed turn re-sends output only (no model re-run)", async () => {
		const { router, journal, executor, sender, store } = make();
		const { entry } = journal.accept({
			idempotencyKey: "k",
			source: "discord",
			payload: "p",
		});
		journal.toDispatching(entry.id, "corr-old"); // crashed mid-dispatch
		executor.reconcileResult = {
			exists: true,
			completed: true,
			turnId: "real-turn-77",
			output: "recovered-out",
		};
		await router.recover();
		await router.whenIdle();
		expect(executor.startCalls).toHaveLength(0); // NEVER re-ran the model
		expect(sender.enqueued[0]?.text).toBe("recovered-out");
		expect(store.getById(entry.id)?.state).toBe("completed");
		// CR MED-2: the REAL turn id was recorded, not a "recovered" placeholder.
		expect(store.getById(entry.id)?.turnId).toBe("real-turn-77");
	});

	it("reconcile: completed turn WITHOUT a real turnId → ambiguous", async () => {
		const { router, journal, store } = make();
		const { entry } = journal.accept({
			idempotencyKey: "k",
			source: "discord",
			payload: "p",
		});
		journal.toDispatching(entry.id, "corr");
		(router as unknown as { executor: FakeExecutor }).executor.reconcileResult =
			{
				exists: true,
				completed: true,
				output: "x",
			}; // no turnId
		await router.recover();
		await router.whenIdle();
		expect(store.getById(entry.id)?.state).toBe("ambiguous");
	});

	it("reconcile: turn exists but NOT completed → ambiguous (no replay)", async () => {
		const { router, journal, executor, store } = make();
		const { entry } = journal.accept({
			idempotencyKey: "k",
			source: "discord",
			payload: "p",
		});
		journal.toDispatching(entry.id, "corr");
		journal.toDispatched(entry.id, "t-real");
		executor.reconcileResult = {
			exists: true,
			completed: false,
			turnId: "t-real",
		};
		await router.recover();
		await router.whenIdle();
		expect(executor.startCalls).toHaveLength(0);
		expect(store.getById(entry.id)?.state).toBe("ambiguous");
	});

	it("resend_output for a model_completed entry re-enqueues from persisted output (no re-run)", async () => {
		// CR HIGH-1: crash between model_completed and outbox enqueue. The output
		// is persisted in the journal → recovery re-enqueues + delivers, no model re-run.
		const { router, journal, executor, sender, store } = make();
		const { entry } = journal.accept({
			idempotencyKey: "k",
			source: "discord",
			payload: "p",
		});
		journal.toDispatching(entry.id, "c");
		journal.toDispatched(entry.id, "t");
		journal.toModelCompleted(entry.id, "persisted-reply"); // no outboxId yet
		await router.recover();
		await router.whenIdle();
		expect(executor.startCalls).toHaveLength(0);
		expect(sender.enqueued[0]?.text).toBe("persisted-reply");
		expect(sender.delivered).toHaveLength(1);
		expect(store.getById(entry.id)?.state).toBe("completed");
	});

	it("reconcile: no provable turn → ambiguous (no replay)", async () => {
		const { router, journal, executor, store } = make();
		const { entry } = journal.accept({
			idempotencyKey: "k",
			source: "discord",
			payload: "p",
		});
		journal.toDispatching(entry.id, "corr-old");
		executor.reconcileResult = { exists: false, completed: false };
		await router.recover();
		await router.whenIdle();
		expect(executor.startCalls).toHaveLength(0);
		expect(store.getById(entry.id)?.state).toBe("ambiguous");
	});

	it("resend_output: redelivers by outboxId without re-running", async () => {
		const { router, journal, sender, executor, store } = make();
		const { entry } = journal.accept({
			idempotencyKey: "k",
			source: "discord",
			payload: "p",
		});
		journal.toDispatching(entry.id, "c");
		journal.toDispatched(entry.id, "t");
		journal.toModelCompleted(entry.id);
		journal.toOutputPending(entry.id, "ob-existing");
		await router.recover();
		await router.whenIdle();
		expect(executor.startCalls).toHaveLength(0);
		expect(sender.delivered).toEqual(["ob-existing"]);
		expect(store.getById(entry.id)?.state).toBe("completed");
	});
});

describe("LeadInputRouter — reply channel routing (FLY-267 回)", () => {
	it("threads replyChannelId from the input to sender.enqueue (else undefined)", async () => {
		const { router, sender } = make();
		router.submit({
			idempotencyKey: "kr",
			source: "discord",
			payload: "hi",
			replyChannelId: "round-1",
		});
		router.submit({ idempotencyKey: "kn", source: "discord", payload: "hi" });
		await router.whenIdle();
		expect(sender.enqueued[0]?.channelId).toBe("round-1");
		expect(sender.enqueued[1]?.channelId).toBeUndefined(); // chat → sender default
	});

	it("recovery (model_completed) re-enqueues to the persisted reply channel", async () => {
		// A crash after model_completed but before enqueue: the route must survive in
		// the journal so the recovered resend targets the source channel, not chat.
		const { router, journal, sender } = make();
		const { entry } = journal.accept({
			idempotencyKey: "k",
			source: "discord",
			payload: "p",
			replyChannelId: "round-1",
		});
		journal.toDispatching(entry.id, "c");
		journal.toDispatched(entry.id, "t");
		journal.toModelCompleted(entry.id, "persisted-reply");
		await router.recover();
		await router.whenIdle();
		expect(sender.enqueued[0]?.text).toBe("persisted-reply");
		expect(sender.enqueued[0]?.channelId).toBe("round-1");
	});

	it("output_pending recovery with a stateless (direct-mode) sender → ambiguous, never a wrong-channel send (finding-4 boundary)", async () => {
		// DirectDiscordOutboundSender's outbox is in-memory: after a restart the
		// outboxId is gone, so deliver() throws and the router conservatively marks
		// the entry ambiguous. This is a PRE-EXISTING limitation affecting ALL direct
		// replies (chat included) — FLY-267 does not regress it, and crucially it
		// never mis-routes (it just doesn't resend). Verified so the boundary is auditable.
		const store = new InMemoryJournalStore();
		let c = 0;
		const journal = new LeadJournal({
			store,
			idFactory: () => `e-${++c}`,
			now: () => ++c,
		});
		const statelessSender: OutboundSender = {
			enqueue: async () => "ob-x",
			deliver: async (id) => {
				throw new Error(`no outbox ${id}`); // lost after restart
			},
		};
		const router = new LeadInputRouter({
			leadId: "l",
			threadId: "t",
			journal,
			executor: new FakeExecutor(),
			sender: statelessSender,
			correlationFactory: () => `corr-${++c}`,
			logger: silent,
		});
		const { entry } = journal.accept({
			idempotencyKey: "k",
			source: "discord",
			payload: "p",
			replyChannelId: "round-1",
		});
		journal.toDispatching(entry.id, "c1");
		journal.toDispatched(entry.id, "t1");
		journal.toModelCompleted(entry.id, "out");
		journal.toOutputPending(entry.id, "ob-stale");
		await router.recover();
		await router.whenIdle();
		expect(store.getById(entry.id)?.state).toBe("ambiguous");
	});
});

describe("LeadInputRouter — typing indicator (FLY-404)", () => {
	/** A recorder for the TypingNotifier interface + a shared event log so tests
	 * can assert ORDERING (start before the turn, stop after delivery). */
	function makeWithTyping() {
		const store = new InMemoryJournalStore();
		let c = 0;
		const journal = new LeadJournal({
			store,
			idFactory: () => `e-${++c}`,
			now: () => ++c,
		});
		const executor = new FakeExecutor();
		const sender = new FakeSender();
		const events: string[] = [];
		const startCalls: Array<string | undefined> = [];
		const stopCalls: Array<string | undefined> = [];
		const typing = {
			start: (ch?: string) => {
				startCalls.push(ch);
				events.push(`start:${ch ?? "default"}`);
			},
			stop: (ch?: string) => {
				stopCalls.push(ch);
				events.push(`stop:${ch ?? "default"}`);
			},
			close: () => events.push("close"),
		};
		// Wrap the executor + sender so the event log captures relative ordering.
		const realStart = executor.startTurn.bind(executor);
		executor.startTurn = async (a) => {
			events.push("startTurn");
			return realStart(a);
		};
		const realDeliver = sender.deliver.bind(sender);
		sender.deliver = async (id: string) => {
			events.push("deliver");
			return realDeliver(id);
		};
		let corr = 0;
		const router = new LeadInputRouter({
			leadId: "lead-x",
			threadId: "th-1",
			journal,
			executor,
			sender,
			typing,
			correlationFactory: () => `corr-${++corr}`,
			logger: silent,
		});
		return {
			store,
			journal,
			executor,
			sender,
			router,
			typing,
			events,
			startCalls,
			stopCalls,
		};
	}

	it("starts typing BEFORE the turn and stops it AFTER delivery (default chat channel)", async () => {
		const { router, events, startCalls, stopCalls } = makeWithTyping();
		router.submit({ idempotencyKey: "k1", source: "discord", payload: "hi" });
		await router.whenIdle();
		expect(events).toEqual([
			"start:default",
			"startTurn",
			"deliver",
			"stop:default",
		]);
		// A chat message carries no replyChannelId → notifier resolves its default.
		expect(startCalls).toEqual([undefined]);
		expect(stopCalls).toEqual([undefined]);
	});

	it("routes typing to the cross-dept source channel (replyChannelId)", async () => {
		const { router, startCalls, stopCalls } = makeWithTyping();
		router.submit({
			idempotencyKey: "kr",
			source: "discord",
			payload: "hi",
			replyChannelId: "round-1",
		});
		await router.whenIdle();
		expect(startCalls).toEqual(["round-1"]);
		expect(stopCalls).toEqual(["round-1"]);
	});

	it("ALWAYS stops typing even when the turn fails (no leaked indicator)", async () => {
		const { router, executor, store, startCalls, stopCalls } = makeWithTyping();
		executor.failStartFor = "boom";
		const { entryId } = router.submit({
			idempotencyKey: "k",
			source: "discord",
			payload: "boom",
		});
		await router.whenIdle();
		expect(store.getById(entryId)?.state).toBe("ambiguous");
		// start was called, and the finally guaranteed a matching stop.
		expect(startCalls).toEqual([undefined]);
		expect(stopCalls).toEqual([undefined]);
	});

	it("typing stays paired across serial turns (start/stop per entry)", async () => {
		const { router, startCalls, stopCalls } = makeWithTyping();
		router.submit({ idempotencyKey: "k1", source: "discord", payload: "a" });
		router.submit({ idempotencyKey: "k2", source: "discord", payload: "b" });
		await router.whenIdle();
		expect(startCalls).toHaveLength(2);
		expect(stopCalls).toHaveLength(2);
	});

	it("byte-compat: a router WITHOUT a typing notifier processes normally", async () => {
		// `make()` (no typing) must still complete — the optional dependency is a no-op.
		const { router, sender, store } = make();
		const { entryId } = router.submit({
			idempotencyKey: "k",
			source: "discord",
			payload: "hi",
		});
		await router.whenIdle();
		expect(sender.delivered).toHaveLength(1);
		expect(store.getById(entryId)?.state).toBe("completed");
	});
});
