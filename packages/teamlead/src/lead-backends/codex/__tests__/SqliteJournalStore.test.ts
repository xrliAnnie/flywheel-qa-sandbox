import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	InMemoryJournalStore,
	JournalTransitionError,
	LeadJournal,
} from "../LeadJournal.js";
import { SqliteJournalStore } from "../SqliteJournalStore.js";

function entry(
	over: Partial<Parameters<SqliteJournalStore["insertAccepted"]>[0]> = {},
) {
	return {
		id: "id-1",
		idempotencyKey: "k1",
		source: "discord" as const,
		payload: "p",
		state: "accepted" as const,
		createdAt: 1,
		updatedAt: 1,
		...over,
	};
}

describe("SqliteJournalStore — in-memory", () => {
	let store: SqliteJournalStore;
	beforeEach(() => {
		store = new SqliteJournalStore(":memory:");
	});
	afterEach(() => store.close());

	it("inserts and dedupes by idempotencyKey", () => {
		const a = store.insertAccepted(entry());
		expect(a.inserted).toBe(true);
		const b = store.insertAccepted(entry({ id: "id-2", payload: "other" }));
		expect(b.inserted).toBe(false);
		expect(b.entry.id).toBe("id-1");
		expect(b.entry.payload).toBe("p");
	});

	it("getById / getByIdempotencyKey return copies", () => {
		store.insertAccepted(entry());
		const e = store.getById("id-1")!;
		(e as { state: string }).state = "completed";
		expect(store.getById("id-1")?.state).toBe("accepted");
		expect(store.getByIdempotencyKey("k1")?.id).toBe("id-1");
	});

	it("transition is an atomic CAS — wrong expectedFrom throws", () => {
		store.insertAccepted(entry());
		// legal: accepted → dispatching
		const r = store.transition({
			id: "id-1",
			expectedFrom: ["accepted"],
			to: "dispatching",
			patch: { clientCorrelationId: "c", updatedAt: 2 },
		});
		expect(r.state).toBe("dispatching");
		expect(r.clientCorrelationId).toBe("c");
		// now state is dispatching; an accepted→dispatching CAS must fail
		expect(() =>
			store.transition({
				id: "id-1",
				expectedFrom: ["accepted"],
				to: "dispatching",
				patch: { clientCorrelationId: "c2", updatedAt: 3 },
			}),
		).toThrow(JournalTransitionError);
	});

	it("transition on a missing id throws", () => {
		expect(() =>
			store.transition({
				id: "nope",
				expectedFrom: ["accepted"],
				to: "dispatching",
				patch: {},
			}),
		).toThrow(JournalTransitionError);
	});

	it("never lets a patch corrupt idempotencyKey", () => {
		store.insertAccepted(entry());
		store.transition({
			id: "id-1",
			expectedFrom: ["accepted"],
			to: "dispatching",
			patch: { idempotencyKey: "hijack", updatedAt: 2 } as never,
		});
		expect(store.getByIdempotencyKey("k1")?.id).toBe("id-1");
		expect(store.getByIdempotencyKey("hijack")).toBeUndefined();
	});

	it("listUnfinished excludes terminal, preserves insertion order", () => {
		store.insertAccepted(entry({ id: "a", idempotencyKey: "a" }));
		store.insertAccepted(entry({ id: "b", idempotencyKey: "b" }));
		store.insertAccepted(entry({ id: "c", idempotencyKey: "c" }));
		// terminalize b
		store.transition({
			id: "b",
			expectedFrom: ["accepted"],
			to: "ambiguous",
			patch: { reason: "x", updatedAt: 5 },
		});
		expect(store.listUnfinished().map((e) => e.id)).toEqual(["a", "c"]);
	});

	it("atomically persists journal_member rows and rejects overlapping membership", () => {
		const first = store.insertAcceptedBatch(entry(), ["A", "B"]);
		expect(first.status).toBe("accepted_new");
		expect(store.listMemberIds("id-1")).toEqual(["A", "B"]);
		expect(
			store.insertAcceptedBatch(entry({ id: "id-2" }), ["A", "B"]),
		).toMatchObject({ status: "accepted_duplicate_same_membership" });
		expect(
			store.insertAcceptedBatch(
				entry({ id: "id-payload", payload: "changed" }),
				["A", "B"],
			),
		).toMatchObject({ status: "membership_conflict" });
		expect(
			store.insertAcceptedBatch(
				entry({ id: "id-3", idempotencyKey: "batch-2" }),
				["B", "C"],
			),
		).toMatchObject({ status: "membership_conflict" });
	});
});

describe("SqliteJournalStore — persistence + LeadJournal integration", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly224-sqlite-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("survives close + reopen (durable)", () => {
		const path = join(dir, "journal.db");
		const s1 = new SqliteJournalStore(path);
		s1.insertAccepted(entry());
		s1.transition({
			id: "id-1",
			expectedFrom: ["accepted"],
			to: "dispatching",
			patch: { clientCorrelationId: "c", updatedAt: 2 },
		});
		s1.close();
		const s2 = new SqliteJournalStore(path);
		const e = s2.getById("id-1");
		expect(e?.state).toBe("dispatching");
		expect(e?.clientCorrelationId).toBe("c");
		s2.close();
	});

	it("commit-before-reply retry returns duplicate after reopen; C remains a new batch", () => {
		const path = join(dir, "batch-retry.db");
		const first = new SqliteJournalStore(path);
		expect(first.insertAcceptedBatch(entry(), ["A", "B"]).status).toBe(
			"accepted_new",
		);
		first.close();

		const recovered = new SqliteJournalStore(path);
		expect(
			recovered.insertAcceptedBatch(entry({ id: "lost-reply-retry" }), [
				"A",
				"B",
			]),
		).toMatchObject({ status: "accepted_duplicate_same_membership" });
		expect(
			recovered.insertAcceptedBatch(
				entry({ id: "id-c", idempotencyKey: "batch-c" }),
				["C"],
			),
		).toMatchObject({ status: "accepted_new" });
		expect(recovered.listMemberIds("id-c")).toEqual(["C"]);
		recovered.close();
	});

	it("cross-connection CAS: only one transition wins on the same file", () => {
		const path = join(dir, "journal.db");
		const a = new SqliteJournalStore(path);
		const b = new SqliteJournalStore(path);
		a.insertAccepted(entry());
		// a moves accepted→dispatching; b (separate connection) sees the new state
		// and its accepted→dispatching CAS must fail.
		a.transition({
			id: "id-1",
			expectedFrom: ["accepted"],
			to: "dispatching",
			patch: { clientCorrelationId: "from-a", updatedAt: 2 },
		});
		expect(() =>
			b.transition({
				id: "id-1",
				expectedFrom: ["accepted"],
				to: "dispatching",
				patch: { clientCorrelationId: "from-b", updatedAt: 3 },
			}),
		).toThrow(JournalTransitionError);
		expect(b.getById("id-1")?.clientCorrelationId).toBe("from-a"); // a's write intact
		a.close();
		b.close();
	});

	it("cross-connection dedupe: duplicate-key insert from a 2nd connection loses", () => {
		const path = join(dir, "journal.db");
		const a = new SqliteJournalStore(path);
		const b = new SqliteJournalStore(path);
		expect(a.insertAccepted(entry()).inserted).toBe(true);
		const dup = b.insertAccepted(entry({ id: "id-2", payload: "other" }));
		expect(dup.inserted).toBe(false);
		expect(dup.entry.id).toBe("id-1");
		a.close();
		b.close();
	});

	it("a column-scoped transition does not clobber another column (CR HIGH)", () => {
		const store = new SqliteJournalStore(":memory:");
		store.insertAccepted(entry());
		store.transition({
			id: "id-1",
			expectedFrom: ["accepted"],
			to: "dispatching",
			patch: { clientCorrelationId: "corr", updatedAt: 2 },
		});
		// Advancing to 'dispatched' (sets turn_id) must NOT wipe client_correlation_id.
		store.transition({
			id: "id-1",
			expectedFrom: ["dispatching"],
			to: "dispatched",
			patch: { turnId: "t-1", updatedAt: 3 },
		});
		const e = store.getById("id-1")!;
		expect(e.turnId).toBe("t-1");
		expect(e.clientCorrelationId).toBe("corr"); // preserved
		store.close();
	});

	it("migrates a legacy DB that still has the old `seq NOT NULL` column", async () => {
		// CR Phase-3b R2 HIGH: opening a journal.db created by the earlier schema
		// (with seq) must drop the column so new inserts don't hit a NOT NULL fail.
		const path = join(dir, "legacy.db");
		const Database = (await import("better-sqlite3")).default;
		const raw = new Database(path);
		raw.exec(`
			CREATE TABLE journal (
				id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL,
				source TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL,
				client_correlation_id TEXT, turn_id TEXT, output TEXT, outbox_id TEXT,
				reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
				seq INTEGER NOT NULL
			);`);
		raw.close();
		const store = new SqliteJournalStore(path); // runs migrate()
		// Insert must succeed (no seq NOT NULL failure).
		expect(store.insertAccepted(entry()).inserted).toBe(true);
		expect(store.getById("id-1")?.state).toBe("accepted");
		store.close();
	});

	it("FLY-267: round-trips reply_channel_id; absent route reads back undefined", () => {
		const store = new SqliteJournalStore(":memory:");
		store.insertAccepted(entry({ id: "id-1", replyChannelId: "round-1" }));
		store.insertAccepted(entry({ id: "id-2", idempotencyKey: "k2" })); // no route
		expect(store.getById("id-1")?.replyChannelId).toBe("round-1");
		expect(store.getById("id-2")?.replyChannelId).toBeUndefined();
		store.close();
	});

	it("FLY-267: migrates a pre-267 DB (no reply_channel_id col); reopen is idempotent", async () => {
		const path = join(dir, "pre267.db");
		const Database = (await import("better-sqlite3")).default;
		const raw = new Database(path);
		raw.exec(`
			CREATE TABLE journal (
				id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL,
				source TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL,
				client_correlation_id TEXT, turn_id TEXT, output TEXT, outbox_id TEXT,
				reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
			);`);
		raw
			.prepare(
				`INSERT INTO journal (id, idempotency_key, source, payload, state, created_at, updated_at)
				 VALUES ('old-1','ko','discord','p','accepted',1,1)`,
			)
			.run();
		raw.close();
		const s1 = new SqliteJournalStore(path); // migrate(): ADD COLUMN reply_channel_id
		expect(s1.getById("old-1")?.replyChannelId).toBeUndefined(); // old row → null
		s1.insertAccepted(
			entry({ id: "id-9", idempotencyKey: "k9", replyChannelId: "round-9" }),
		);
		expect(s1.getById("id-9")?.replyChannelId).toBe("round-9");
		s1.close();
		// Reopen MUST be idempotent (no "duplicate column" error on the 2nd migrate).
		const s2 = new SqliteJournalStore(path);
		expect(s2.getById("id-9")?.replyChannelId).toBe("round-9");
		s2.close();
	});

	it("drives a full LeadJournal lifecycle on the sqlite store", () => {
		const store = new SqliteJournalStore(":memory:");
		let n = 0;
		const journal = new LeadJournal({
			store,
			idFactory: () => `e-${++n}`,
			now: () => ++n,
		});
		const { entry: e } = journal.accept({
			idempotencyKey: "k",
			source: "discord",
			payload: "p",
		});
		journal.toDispatching(e.id, "corr");
		journal.toDispatched(e.id, "turn");
		journal.toModelCompleted(e.id, "out");
		journal.toOutputPending(e.id, "ob");
		const done = journal.toCompleted(e.id);
		expect(done.state).toBe("completed");
		expect(done.output).toBe("out");
		expect(store.getById(e.id)?.turnId).toBe("turn");
		expect(journal.listUnfinished()).toHaveLength(0);
		store.close();
	});
});

describe("completed-since rotation eligibility", () => {
	it.each(["memory", "sqlite"])(
		"%s counts only completed entries created strictly after cutoff",
		(backend) => {
			const store =
				backend === "memory"
					? new InMemoryJournalStore()
					: new SqliteJournalStore(":memory:");
			try {
				const journal = new LeadJournal({ store, now: () => 101 });
				for (const [id, state, createdAt] of [
					["before", "completed", 99],
					["equal", "completed", 100],
					["after", "completed", 101],
					["accepted", "accepted", 102],
					["ambiguous", "ambiguous", 102],
				] as const) {
					store.insertAccepted(
						entry({ id, idempotencyKey: id, state, createdAt }),
					);
				}
				journal.recordObservation({
					idempotencyKey: "founder",
					payload: "observed",
				});
				expect(store.countCompletedSince(100)).toBe(2);
				expect(journal.countCompletedSince(100)).toBe(2);
				expect(journal.countCompletedSince(101)).toBe(0);
			} finally {
				if (store instanceof SqliteJournalStore) store.close();
			}
		},
	);
	it("adds the count index idempotently on reopen and preserves existing rows", async () => {
		const { default: Database } = await import("better-sqlite3");
		const dir = mkdtempSync(join(tmpdir(), "fly2550-journal-"));
		const path = join(dir, "journal.sqlite");
		try {
			const store = new SqliteJournalStore(path);
			store.insertAccepted(entry({ state: "completed", createdAt: 101 }));
			store.close();
			const reopened = new SqliteJournalStore(path);
			expect(reopened.countCompletedSince(100)).toBe(1);
			reopened.close();
			const db = new Database(path, { readonly: true });
			try {
				expect(
					db
						.prepare(
							"SELECT name FROM sqlite_master WHERE type='index' AND name='journal_state_created_idx'",
						)
						.get(),
				).toEqual({ name: "journal_state_created_idx" });
				expect(
					db.prepare("PRAGMA index_info(journal_state_created_idx)").all(),
				).toMatchObject([{ name: "state" }, { name: "created_at" }]);
			} finally {
				db.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("findEntryIdsByTurnId (FLY-2882)", () => {
	const stores: Array<
		[string, () => SqliteJournalStore | InMemoryJournalStore]
	> = [
		["sqlite", () => new SqliteJournalStore(":memory:")],
		["in-memory", () => new InMemoryJournalStore()],
	];
	for (const [label, make] of stores) {
		it(`${label}: reports zero, one and two entries bound to a turn`, () => {
			const store = make();
			const dispatch = (id: string, turnId: string) => {
				store.transition({
					id,
					expectedFrom: ["accepted"],
					to: "dispatching",
					patch: { clientCorrelationId: `c-${id}`, updatedAt: 2 },
				});
				store.transition({
					id,
					expectedFrom: ["dispatching"],
					to: "dispatched",
					patch: { turnId, updatedAt: 3 },
				});
			};
			store.insertAcceptedBatch(
				entry({ id: "e1", idempotencyKey: "b1", source: "mailbox" }),
				["d1#r0", "d2#r0"],
			);
			store.insertAccepted(entry({ id: "e2", idempotencyKey: "k2" }));
			store.insertAccepted(entry({ id: "e3", idempotencyKey: "k3" }));
			expect(store.findEntryIdsByTurnId("turn-a")).toEqual([]);
			dispatch("e1", "turn-a");
			expect(store.findEntryIdsByTurnId("turn-a")).toEqual(["e1"]);
			expect(store.listMemberIds("e1")).toEqual(["d1#r0", "d2#r0"]);
			dispatch("e2", "turn-b");
			dispatch("e3", "turn-b");
			expect(store.findEntryIdsByTurnId("turn-b").sort()).toEqual(["e2", "e3"]);
			const journal = new LeadJournal({ store });
			expect(journal.findEntryIdsByTurnId("turn-a")).toEqual(["e1"]);
			expect(journal.listMemberIds("e1")).toEqual(["d1#r0", "d2#r0"]);
			if (store instanceof SqliteJournalStore) store.close();
		});
	}

	it("sqlite: selects only ids (never payload) and is bounded to two rows", () => {
		const store = new SqliteJournalStore(":memory:");
		const db = (store as unknown as { db: { prepare(sql: string): unknown } })
			.db;
		const seen: string[] = [];
		const prepare = db.prepare.bind(db);
		db.prepare = (sql: string) => {
			seen.push(sql);
			return prepare(sql);
		};
		for (const id of ["x1", "x2", "x3"]) {
			store.insertAccepted(
				entry({ id, idempotencyKey: `k-${id}`, payload: "SENTINEL-PAYLOAD" }),
			);
			store.transition({
				id,
				expectedFrom: ["accepted"],
				to: "dispatching",
				patch: { clientCorrelationId: `c-${id}`, updatedAt: 2 },
			});
			store.transition({
				id,
				expectedFrom: ["dispatching"],
				to: "dispatched",
				patch: { turnId: "turn-many", updatedAt: 3 },
			});
		}
		seen.length = 0;
		const ids = store.findEntryIdsByTurnId("turn-many");
		expect(ids).toHaveLength(2);
		expect(JSON.stringify(ids)).not.toContain("SENTINEL");
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatch(
			/SELECT id FROM journal WHERE turn_id = \? LIMIT 2/,
		);
		expect(seen[0]).not.toMatch(/payload|\*/);
		store.close();
	});
});
