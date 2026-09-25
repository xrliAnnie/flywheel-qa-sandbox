import { afterEach, describe, expect, it, vi } from "vitest";
import type { LatestTurn } from "../codex-lead-thread-rotation.js";
import {
	LeadTurnStateTracker,
	seedTurnStateWithRetry,
	type TurnBindingSource,
} from "../LeadTurnStateTracker.js";

const THREAD = "019eaf5d-a5b7-7a72-b73f-cd1063892aa1";
const NOW = Date.parse("2026-09-25T20:00:00.000Z");
const SEC = Math.floor(NOW / 1000);

function binding(
	entries: Record<string, string[]> = {},
	members: Record<string, string[]> = {},
): TurnBindingSource {
	return {
		findEntryIdsByTurnId: (turnId) => entries[turnId] ?? [],
		listMemberIds: (entryId) => members[entryId] ?? [],
	};
}

function started(
	turnId: string,
	startedAt: unknown = SEC - 30,
	threadId = THREAD,
) {
	return {
		threadId,
		turn: { id: turnId, status: "inProgress", startedAt, items: [] },
	};
}
function completed(turnId: string, threadId = THREAD) {
	return { threadId, turn: { id: turnId, status: "completed" } };
}

function tracker(source: TurnBindingSource = binding()) {
	const t = new LeadTurnStateTracker({
		binding: source,
		now: () => NOW,
		generation: "gen-1",
	});
	t.bindThread(THREAD);
	return t;
}

const inProgress = (id = "seed-turn", startedAt = SEC - 90): LatestTurn => ({
	id,
	status: "inProgress",
	startedAt,
});

afterEach(() => vi.useRealTimers());

describe("LeadTurnStateTracker — seeding", () => {
	it("is unseeded and unconnected before the thread is bound", () => {
		const t = new LeadTurnStateTracker({ binding: binding(), now: () => NOW });
		expect(t.snapshot()).toMatchObject({
			schema: "turn-state.v1",
			connected: false,
			seeded: false,
			activeTurns: [],
		});
		expect(t.snapshot().generation).toMatch(/\S/);
	});

	it.each([
		["an empty thread (null)", null, []],
		[
			"a terminal latest turn",
			{ id: "old", status: "completed", startedAt: SEC - 500 } as LatestTurn,
			[],
		],
		[
			"an in-progress latest turn",
			inProgress(),
			[
				{
					origin: "unknown",
					turnId: "seed-turn",
					startedAtMs: (SEC - 90) * 1000,
				},
			],
		],
	])("seeds from %s", (_label, latest, activeTurns) => {
		const t = tracker();
		const rev0 = t.beginSeed();
		expect(t.applySeed(rev0, latest)).toBe(true);
		expect(t.snapshot()).toMatchObject({
			connected: true,
			seeded: true,
			activeTurns,
		});
	});

	it.each([
		[
			"a start",
			(t: LeadTurnStateTracker) => t.onTurnStarted(started("live"), "message"),
		],
		[
			"a completion",
			(t: LeadTurnStateTracker) => t.onTurnCompleted(completed("seed-turn")),
		],
	])("discards a seed reply that raced with %s", (_label, event) => {
		const t = tracker();
		const rev0 = t.beginSeed();
		event(t);
		expect(t.applySeed(rev0, inProgress())).toBe(false);
		const turns = t.snapshot().activeTurns.map((turn) => turn.turnId);
		expect(turns).not.toContain("seed-turn");
		expect(t.snapshot().seeded).toBe(true);
	});

	it("never lets a late in-progress seed resurrect a completed turn (idle wins)", () => {
		const t = tracker();
		const rev0 = t.beginSeed();
		t.onTurnCompleted(completed("seed-turn"));
		expect(t.applySeed(rev0, inProgress("seed-turn"))).toBe(false);
		expect(t.snapshot()).toMatchObject({ seeded: true, activeTurns: [] });
	});

	it("rejects an in-progress seed with an invalid or future start (stays unseeded)", () => {
		const t = tracker();
		expect(t.applySeed(t.beginSeed(), inProgress("x", SEC + 60))).toBe(false);
		expect(
			t.applySeed(t.beginSeed(), {
				id: "x",
				status: "inProgress",
				startedAt: null,
			}),
		).toBe(false);
		expect(t.snapshot()).toMatchObject({ seeded: false, activeTurns: [] });
	});

	it("ignores a seed after it is already seeded, and before the thread is bound", () => {
		const t = tracker();
		t.onTurnStarted(started("live"), "message");
		expect(t.applySeed(t.beginSeed(), null)).toBe(false);
		expect(t.snapshot().activeTurns).toHaveLength(1);
		const unbound = new LeadTurnStateTracker({
			binding: binding(),
			now: () => NOW,
		});
		expect(unbound.applySeed(unbound.beginSeed(), null)).toBe(false);
		expect(unbound.snapshot().seeded).toBe(false);
	});
});

describe("LeadTurnStateTracker — live events", () => {
	it("tracks message and founder turns from start to completion", () => {
		const t = tracker(
			binding({ "m-turn": ["entry-1"] }, { "entry-1": ["d-1#r0", "d-2#r3"] }),
		);
		t.onTurnStarted(started("m-turn", SEC - 40), "message");
		t.onTurnStarted(started("f-turn", SEC - 10), "founder_terminal");
		expect(t.snapshot()).toMatchObject({
			connected: true,
			seeded: true,
			activeTurns: [
				{
					origin: "message",
					turnId: "m-turn",
					startedAtMs: (SEC - 40) * 1000,
					binding: { status: "bound", deliveryIds: ["d-1", "d-2"] },
				},
				{
					origin: "founder_terminal",
					turnId: "f-turn",
					startedAtMs: (SEC - 10) * 1000,
				},
			],
		});
		expect("binding" in t.snapshot().activeTurns[1]!).toBe(false);
		t.onTurnCompleted(completed("m-turn"));
		t.onTurnCompleted(completed("f-turn"));
		t.onTurnCompleted(completed("f-turn"));
		expect(t.snapshot()).toMatchObject({ seeded: true, activeTurns: [] });
	});

	it.each([
		["null", null],
		["non-numeric", "soon"],
		["zero", 0],
		["in the future", SEC + 60],
	])(
		"falls back to the local clock when startedAt is %s",
		(_label, startedAt) => {
			const t = tracker();
			t.onTurnStarted(started("t", startedAt), "message");
			expect(t.snapshot().activeTurns[0]?.startedAtMs).toBe(NOW);
		},
	);

	it("falls back to the local clock when the turn carries no startedAt field", () => {
		const t = tracker();
		t.onTurnStarted({ threadId: THREAD, turn: { id: "bare" } }, "message");
		expect(t.snapshot().activeTurns[0]?.startedAtMs).toBe(NOW);
	});

	it("ignores a replayed start for a turn whose completion was already seen", () => {
		const t = tracker();
		t.onTurnCompleted(completed("fast"));
		t.onTurnStarted(started("fast"), "message");
		expect(t.snapshot().activeTurns).toEqual([]);
	});

	it("ignores events for another thread and events without a turn id", () => {
		const t = tracker();
		t.onTurnStarted(
			started("other", SEC, "019eaf5d-a5b7-7a72-b73f-cd1063892aff"),
			"message",
		);
		t.onTurnStarted({ threadId: THREAD }, "message");
		expect(t.snapshot()).toMatchObject({ seeded: false, activeTurns: [] });
	});

	it("ignores events before the thread is bound", () => {
		const t = new LeadTurnStateTracker({ binding: binding(), now: () => NOW });
		t.onTurnStarted(started("early"), "message");
		t.bindThread(THREAD);
		expect(t.snapshot()).toMatchObject({ seeded: false, activeTurns: [] });
	});

	it("reports every binding state for message turns", () => {
		const members = Array.from({ length: 65 }, (_, i) => `d-${i}#r0`);
		const t = tracker(
			binding(
				{
					ambiguous: ["e1", "e2"],
					bare: ["e3"],
					huge: ["e4"],
					bound: ["e5"],
				},
				{ e3: [], e4: members, e5: members.slice(0, 64) },
			),
		);
		for (const id of ["pending", "ambiguous", "bare", "huge", "bound"])
			t.onTurnStarted(started(id), "message");
		const byId = Object.fromEntries(
			t
				.snapshot()
				.activeTurns.map((turn) => [
					turn.turnId,
					turn.origin === "message" ? turn.binding : undefined,
				]),
		);
		expect(byId).toEqual({
			pending: { status: "pending" },
			ambiguous: { status: "ambiguous" },
			bare: { status: "no_members" },
			huge: { status: "overflow" },
			bound: {
				status: "bound",
				deliveryIds: members.slice(0, 64).map((id) => id.replace("#r0", "")),
			},
		});
	});

	it("reports binding unavailable when the journal read throws", () => {
		const t = tracker({
			findEntryIdsByTurnId: () => {
				throw new Error("SQLITE_BUSY");
			},
			listMemberIds: () => [],
		});
		t.onTurnStarted(started("m"), "message");
		expect(t.snapshot().activeTurns[0]).toMatchObject({
			binding: { status: "unavailable" },
		});
	});
});

describe("LeadTurnStateTracker — disconnect / generations", () => {
	it("goes unconnected + unseeded on disconnect and never revives", () => {
		const t = tracker();
		t.onTurnStarted(started("live"), "message");
		t.markDisconnected();
		expect(t.snapshot()).toMatchObject({
			connected: false,
			seeded: false,
			activeTurns: [],
		});
		t.bindThread(THREAD);
		t.onTurnStarted(started("late"), "message");
		expect(t.applySeed(t.beginSeed(), null)).toBe(false);
		expect(t.snapshot()).toMatchObject({
			connected: false,
			seeded: false,
			activeTurns: [],
		});
	});

	it("keeps generations independent: an old instance's late event cannot touch the new one", () => {
		const old = tracker();
		old.markDisconnected();
		const next = new LeadTurnStateTracker({
			binding: binding(),
			now: () => NOW,
			generation: "gen-2",
		});
		next.bindThread(THREAD);
		expect(next.applySeed(next.beginSeed(), null)).toBe(true);
		old.onTurnStarted(started("stale"), "message");
		expect(next.snapshot()).toMatchObject({
			generation: "gen-2",
			seeded: true,
			activeTurns: [],
		});
	});
});

describe("seedTurnStateWithRetry", () => {
	it("retries after 2s and 10s, then gives up and stays unseeded", async () => {
		vi.useFakeTimers();
		const t = tracker();
		const read = vi.fn(async () => {
			throw new Error("turns_list_invalid");
		});
		seedTurnStateWithRetry({ tracker: t, read });
		await vi.advanceTimersByTimeAsync(0);
		expect(read).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1_999);
		expect(read).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(read).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(read).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(read).toHaveBeenCalledTimes(3);
		expect(t.snapshot().seeded).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
		t.onTurnCompleted(completed("whatever"));
		expect(t.snapshot()).toMatchObject({ seeded: true, activeTurns: [] });
	});

	it("stops retrying once a live event seeded the tracker", async () => {
		vi.useFakeTimers();
		const t = tracker();
		const read = vi.fn(async () => {
			throw new Error("gone");
		});
		seedTurnStateWithRetry({ tracker: t, read });
		await vi.advanceTimersByTimeAsync(0);
		t.onTurnStarted(started("live"), "message");
		await vi.advanceTimersByTimeAsync(20_000);
		expect(read).toHaveBeenCalledTimes(1);
	});

	it("seeds on the first success and cancel() stops pending retries", async () => {
		vi.useFakeTimers();
		const ok = tracker();
		seedTurnStateWithRetry({ tracker: ok, read: async () => inProgress() });
		await vi.advanceTimersByTimeAsync(0);
		expect(ok.snapshot()).toMatchObject({
			seeded: true,
			activeTurns: [{ turnId: "seed-turn" }],
		});

		const t = tracker();
		const read = vi.fn(async () => {
			throw new Error("gone");
		});
		const handle = seedTurnStateWithRetry({ tracker: t, read });
		await vi.advanceTimersByTimeAsync(0);
		handle.cancel();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(read).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});
