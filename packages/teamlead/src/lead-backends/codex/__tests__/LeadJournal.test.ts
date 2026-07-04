import { beforeEach, describe, expect, it } from "vitest";
import {
	InMemoryJournalStore,
	type JournalState,
	JournalTransitionError,
	LeadJournal,
} from "../LeadJournal.js";

function makeJournal() {
	let n = 0;
	let clock = 1000;
	const store = new InMemoryJournalStore();
	const journal = new LeadJournal({
		store,
		idFactory: () => `id-${++n}`,
		now: () => ++clock,
	});
	return { journal, store };
}

describe("LeadJournal — idempotent intake", () => {
	it("accepts a new input and reports accepted=true", () => {
		const { journal } = makeJournal();
		const r = journal.accept({
			idempotencyKey: "k1",
			source: "discord",
			payload: "hi",
		});
		expect(r.accepted).toBe(true);
		expect(r.entry.state).toBe("accepted");
		expect(r.entry.idempotencyKey).toBe("k1");
	});

	it("FLY-267: persists replyChannelId when provided (and leaves it undefined otherwise)", () => {
		const { journal } = makeJournal();
		const withRoute = journal.accept({
			idempotencyKey: "kr",
			source: "discord",
			payload: "hi",
			replyChannelId: "round-1",
		});
		expect(withRoute.entry.replyChannelId).toBe("round-1");
		const noRoute = journal.accept({
			idempotencyKey: "kn",
			source: "discord",
			payload: "hi",
		});
		expect(noRoute.entry.replyChannelId).toBeUndefined();
	});

	it("dedupes a duplicate idempotencyKey (accepted=false, same entry)", () => {
		const { journal } = makeJournal();
		const a = journal.accept({
			idempotencyKey: "k1",
			source: "discord",
			payload: "hi",
		});
		const b = journal.accept({
			idempotencyKey: "k1",
			source: "discord",
			payload: "hi-again",
		});
		expect(b.accepted).toBe(false);
		expect(b.entry.id).toBe(a.entry.id);
		expect(b.entry.payload).toBe("hi"); // original preserved
	});

	it("requires an idempotencyKey", () => {
		const { journal } = makeJournal();
		expect(() =>
			journal.accept({ idempotencyKey: "", source: "mailbox", payload: "x" }),
		).toThrow(/idempotencyKey/);
	});
});

describe("LeadJournal — happy-path transitions", () => {
	it("walks accepted → completed carrying correlation/turn/outbox ids", () => {
		const { journal } = makeJournal();
		const { entry } = journal.accept({
			idempotencyKey: "k",
			source: "discord",
			payload: "p",
		});
		expect(journal.toDispatching(entry.id, "corr-1").clientCorrelationId).toBe(
			"corr-1",
		);
		expect(journal.toDispatched(entry.id, "turn-9").turnId).toBe("turn-9");
		expect(journal.toModelCompleted(entry.id).state).toBe("model_completed");
		expect(journal.toOutputPending(entry.id, "ob-3").outboxId).toBe("ob-3");
		expect(journal.toCompleted(entry.id).state).toBe("completed");
	});
});

describe("LeadJournal — transition guards", () => {
	it("rejects skipping a step (accepted → dispatched)", () => {
		const { journal } = makeJournal();
		const { entry } = journal.accept({
			idempotencyKey: "k",
			source: "discord",
			payload: "p",
		});
		expect(() => journal.toDispatched(entry.id, "t")).toThrow(
			JournalTransitionError,
		);
	});

	it("rejects advancing out of a terminal state", () => {
		const { journal } = makeJournal();
		const { entry } = journal.accept({
			idempotencyKey: "k",
			source: "discord",
			payload: "p",
		});
		journal.toDeadLetter(entry.id, "nope");
		expect(() => journal.toDispatching(entry.id, "c")).toThrow(
			JournalTransitionError,
		);
		expect(() => journal.toAmbiguous(entry.id, "x")).toThrow(
			JournalTransitionError,
		);
	});

	it("allows ambiguous/dead_letter from any non-terminal state", () => {
		const { journal } = makeJournal();
		const a = journal.accept({
			idempotencyKey: "k1",
			source: "discord",
			payload: "p",
		});
		journal.toDispatching(a.entry.id, "c");
		expect(journal.toAmbiguous(a.entry.id, "cant prove").state).toBe(
			"ambiguous",
		);

		const b = journal.accept({
			idempotencyKey: "k2",
			source: "discord",
			payload: "p",
		});
		journal.toDispatching(b.entry.id, "c");
		journal.toDispatched(b.entry.id, "t");
		expect(journal.toDeadLetter(b.entry.id, "fatal").state).toBe("dead_letter");
	});
});

describe("LeadJournal — recovery actions (conservative, all 8 states)", () => {
	// Drive an entry to a target state, then assert its recovery action. Covers
	// ALL eight states (Codex Phase-3a LOW-4: don't leave output_pending/escape
	// states unproven).
	function driveTo(target: JournalState) {
		const { journal, store } = makeJournal();
		const id = journal.accept({
			idempotencyKey: "k",
			source: "discord",
			payload: "p",
		}).entry.id;
		if (target === "accepted") return { journal, entry: store.getById(id)! };
		journal.toDispatching(id, "corr");
		if (target === "dispatching") return { journal, entry: store.getById(id)! };
		if (target === "ambiguous") {
			journal.toAmbiguous(id, "r");
			return { journal, entry: store.getById(id)! };
		}
		if (target === "dead_letter") {
			journal.toDeadLetter(id, "r");
			return { journal, entry: store.getById(id)! };
		}
		journal.toDispatched(id, "turn");
		if (target === "dispatched") return { journal, entry: store.getById(id)! };
		journal.toModelCompleted(id);
		if (target === "model_completed")
			return { journal, entry: store.getById(id)! };
		journal.toOutputPending(id, "ob");
		if (target === "output_pending")
			return { journal, entry: store.getById(id)! };
		journal.toCompleted(id);
		return { journal, entry: store.getById(id)! };
	}

	const cases: Array<[JournalState, string]> = [
		["accepted", "redispatch"],
		["dispatching", "reconcile"],
		["dispatched", "reconcile"],
		["model_completed", "resend_output"],
		["output_pending", "resend_output"],
		["completed", "none"],
		["ambiguous", "none"],
		["dead_letter", "none"],
	];

	for (const [state, action] of cases) {
		it(`state '${state}' → recovery '${action}'`, () => {
			const { journal, entry } = driveTo(state);
			expect(entry.state).toBe(state);
			expect(journal.recoveryAction(entry)).toBe(action);
		});
	}

	it("ONLY 'accepted' yields redispatch (no auto re-run elsewhere)", () => {
		for (const [state] of cases) {
			const { journal, entry } = driveTo(state);
			if (state !== "accepted")
				expect(journal.recoveryAction(entry)).not.toBe("redispatch");
		}
	});
});

describe("LeadJournal — atomic guard + isolation (Codex Phase-3a HIGH)", () => {
	it("atomic CAS: a second accepted→dispatching loses (no double dispatch)", () => {
		const { journal } = makeJournal();
		const id = journal.accept({
			idempotencyKey: "k",
			source: "discord",
			payload: "p",
		}).entry.id;
		journal.toDispatching(id, "corr-1");
		// A racing second dispatch must fail — current state is already dispatching.
		expect(() => journal.toDispatching(id, "corr-2")).toThrow(
			JournalTransitionError,
		);
	});

	it("a returned entry is a copy — external mutation can't corrupt the store", () => {
		const { journal, store } = makeJournal();
		const r = journal.accept({
			idempotencyKey: "k",
			source: "discord",
			payload: "p",
		});
		// Try to tamper with the returned object.
		(r.entry as { state: JournalState }).state = "completed";
		(r.entry as { idempotencyKey: string }).idempotencyKey = "hijacked";
		const fresh = store.getById(r.entry.id)!;
		expect(fresh.state).toBe("accepted"); // untouched
		expect(store.getByIdempotencyKey("k")?.id).toBe(r.entry.id); // index intact
		expect(store.getByIdempotencyKey("hijacked")).toBeUndefined();
	});

	it("rejects empty critical identifiers", () => {
		const { journal } = makeJournal();
		const id = journal.accept({
			idempotencyKey: "k",
			source: "discord",
			payload: "p",
		}).entry.id;
		expect(() => journal.toDispatching(id, "")).toThrow(/clientCorrelationId/);
		journal.toDispatching(id, "corr");
		expect(() => journal.toDispatched(id, "")).toThrow(/turnId/);
		journal.toDispatched(id, "t");
		journal.toModelCompleted(id);
		expect(() => journal.toOutputPending(id, "")).toThrow(/outboxId/);
	});
});

describe("LeadJournal — listUnfinished", () => {
	let ctx: ReturnType<typeof makeJournal>;
	beforeEach(() => {
		ctx = makeJournal();
	});

	it("returns non-terminal entries in insertion order, excludes terminal", () => {
		const { journal } = ctx;
		const a = journal.accept({
			idempotencyKey: "a",
			source: "discord",
			payload: "p",
		}).entry.id;
		const b = journal.accept({
			idempotencyKey: "b",
			source: "mailbox",
			payload: "p",
		}).entry.id;
		const c = journal.accept({
			idempotencyKey: "c",
			source: "discord",
			payload: "p",
		}).entry.id;
		// finish b
		journal.toDispatching(b, "c");
		journal.toDispatched(b, "t");
		journal.toModelCompleted(b);
		journal.toOutputPending(b, "ob");
		journal.toCompleted(b);
		const unfinished = journal.listUnfinished().map((e) => e.id);
		expect(unfinished).toEqual([a, c]);
	});
});
