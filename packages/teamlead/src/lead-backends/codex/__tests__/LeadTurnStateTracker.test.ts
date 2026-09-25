import { afterEach, describe, expect, it, vi } from "vitest";
import type { LatestTurn } from "../codex-lead-thread-rotation.js";
import {
	LeadTurnStateTracker,
	seedTurnStateWithRetry,
	type TurnBindingSource,
} from "../LeadTurnStateTracker.js";

const THREAD = "019eaf5d-a5b7-7a72-b73f-cd1063892aa1";
const OTHER = "019eaf5d-a5b7-7a72-b73f-cd1063892aff";
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

type Over = Record<string, unknown>;
function started(turnId: string, over: Over = {}, turnOver: Over = {}) {
	return {
		threadId: THREAD,
		...over,
		turn: {
			id: turnId,
			status: "inProgress",
			startedAt: SEC - 30,
			items: [],
			...turnOver,
		},
	};
}
function completed(turnId: string, over: Over = {}, turnOver: Over = {}) {
	return {
		threadId: THREAD,
		...over,
		turn: { id: turnId, status: "completed", ...turnOver },
	};
}

function tracker(source: TurnBindingSource = binding(), onTrustLost = vi.fn()) {
	const t = new LeadTurnStateTracker({
		binding: source,
		now: () => NOW,
		generation: "gen-1",
		onTrustLost,
	});
	t.bindThread(THREAD);
	return t;
}
const start = (t: LeadTurnStateTracker, id: string, turnOver: Over = {}) =>
	t.observeLifecycle("turn/started", started(id, {}, turnOver));
const finish = (t: LeadTurnStateTracker, id: string, turnOver: Over = {}) =>
	t.observeLifecycle("turn/completed", completed(id, {}, turnOver));
const ids = (t: LeadTurnStateTracker) =>
	t.snapshot().activeTurns.map((turn) => [turn.turnId, turn.origin]);

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
		["a start", (t: LeadTurnStateTracker) => start(t, "live")],
		["a completion", (t: LeadTurnStateTracker) => finish(t, "seed-turn")],
	])("discards a seed reply that raced with %s", (_label, event) => {
		const t = tracker();
		const rev0 = t.beginSeed();
		event(t);
		expect(t.applySeed(rev0, inProgress())).toBe(false);
		expect(ids(t).map(([id]) => id)).not.toContain("seed-turn");
		expect(t.snapshot().seeded).toBe(true);
	});

	it("never lets a late in-progress seed resurrect a completed turn (idle wins)", () => {
		const t = tracker();
		const rev0 = t.beginSeed();
		finish(t, "seed-turn");
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
		start(t, "live");
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

describe("LeadTurnStateTracker — raw lifecycle + origin", () => {
	it("records a start as origin unknown until the demux names its owner", () => {
		const t = tracker(
			binding({ "m-turn": ["entry-1"] }, { "entry-1": ["d-1#r0", "d-2#r3"] }),
		);
		start(t, "m-turn", { startedAt: SEC - 40 });
		expect(ids(t)).toEqual([["m-turn", "unknown"]]);
		expect(t.snapshot()).toMatchObject({ seeded: true });
		t.setOrigin("m-turn", "message");
		start(t, "f-turn", { startedAt: SEC - 10 });
		t.setOrigin("f-turn", "founder_terminal");
		expect(t.snapshot().activeTurns).toEqual([
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
		]);
		finish(t, "m-turn");
		finish(t, "f-turn");
		finish(t, "f-turn");
		expect(t.snapshot()).toMatchObject({ seeded: true, activeTurns: [] });
	});

	it("ignores setOrigin for a turn that is not active", () => {
		const t = tracker();
		t.setOrigin("ghost", "message");
		finish(t, "done");
		t.setOrigin("done", "founder_terminal");
		expect(t.snapshot().activeTurns).toEqual([]);
	});

	it("ignores non-lifecycle methods entirely (no body ever enters the tracker)", () => {
		const t = tracker();
		t.observeLifecycle("item/agentMessage/delta", {
			threadId: THREAD,
			turnId: "x",
			delta: "hi",
		});
		t.observeLifecycle("thread/status/changed", {
			threadId: THREAD,
			status: { type: "active" },
		});
		expect(t.snapshot()).toMatchObject({ seeded: false, activeTurns: [] });
	});

	it.each([
		["null", null],
		["missing", undefined],
	])("uses the local clock when startedAt is %s", (_label, startedAt) => {
		const t = tracker();
		start(t, "t", { startedAt });
		expect(t.snapshot().activeTurns[0]?.startedAtMs).toBe(NOW);
	});

	it("keeps the first start time for a duplicated start", () => {
		const t = tracker();
		start(t, "t", { startedAt: SEC - 50 });
		start(t, "t", { startedAt: SEC - 5 });
		expect(t.snapshot().activeTurns[0]?.startedAtMs).toBe((SEC - 50) * 1000);
	});

	it("ignores a replayed start for a turn whose completion was already seen", () => {
		const t = tracker();
		finish(t, "fast");
		start(t, "fast");
		expect(t.snapshot()).toMatchObject({ seeded: true, activeTurns: [] });
	});

	it("ignores other threads without touching state or revision", () => {
		const t = tracker();
		start(t, "mine");
		const rev = t.beginSeed();
		t.observeLifecycle(
			"turn/completed",
			completed("mine", { threadId: OTHER }),
		);
		t.observeLifecycle("turn/started", started("theirs", { threadId: OTHER }));
		expect(t.beginSeed()).toBe(rev);
		expect(ids(t)).toEqual([["mine", "unknown"]]);
	});

	it("ignores lifecycle events before the thread is bound", () => {
		const t = new LeadTurnStateTracker({ binding: binding(), now: () => NOW });
		t.observeLifecycle("turn/started", started("early"));
		t.bindThread(THREAD);
		expect(t.snapshot()).toMatchObject({ seeded: false, activeTurns: [] });
	});
});

describe("LeadTurnStateTracker — malformed current-thread events invalidate trust", () => {
	it.each([
		[
			"a completion with status inProgress",
			"turn/completed",
			completed("busy", {}, { status: "inProgress" }),
		],
		[
			"a completion without status",
			"turn/completed",
			completed("busy", {}, { status: undefined }),
		],
		[
			"a completion with an unknown status",
			"turn/completed",
			completed("busy", {}, { status: "paused" }),
		],
		[
			"a start with a terminal status",
			"turn/started",
			started("x", {}, { status: "completed" }),
		],
		[
			"a start without status",
			"turn/started",
			started("x", {}, { status: undefined }),
		],
		[
			"a start with a string startedAt",
			"turn/started",
			started("x", {}, { startedAt: "soon" }),
		],
		[
			"a start with a future startedAt",
			"turn/started",
			started("x", {}, { startedAt: SEC + 60 }),
		],
		[
			"a start with a zero startedAt",
			"turn/started",
			started("x", {}, { startedAt: 0 }),
		],
		[
			"an event without a turn id",
			"turn/completed",
			completed("busy", {}, { id: undefined }),
		],
		["an event with an empty turn id", "turn/started", started("", {})],
		[
			"an event with an oversized turn id",
			"turn/started",
			started("x".repeat(129), {}),
		],
		[
			"an event without threadId",
			"turn/completed",
			{ turn: { id: "busy", status: "completed" } },
		],
		["a non-object payload", "turn/completed", "busy"],
	])("%s → unseeded, cleared, re-seed requested", (_label, method, params) => {
		const onTrustLost = vi.fn();
		const t = tracker(binding(), onTrustLost);
		start(t, "busy");
		const rev = t.beginSeed();
		t.observeLifecycle(method, params);
		expect(t.snapshot()).toMatchObject({
			connected: true,
			seeded: false,
			activeTurns: [],
		});
		expect(t.beginSeed()).toBeGreaterThan(rev);
		expect(onTrustLost).toHaveBeenCalledTimes(1);
		expect(t.needsSeed()).toBe(true);
	});

	it("recovers trust from the next valid lifecycle event", () => {
		const t = tracker();
		t.observeLifecycle(
			"turn/completed",
			completed("x", {}, { status: "inProgress" }),
		);
		expect(t.snapshot().seeded).toBe(false);
		start(t, "next");
		expect(t.snapshot()).toMatchObject({
			seeded: true,
			activeTurns: [{ turnId: "next" }],
		});
	});
});

describe("LeadTurnStateTracker — bindings", () => {
	it("reports every binding state for message turns", () => {
		const members = Array.from({ length: 65 }, (_, i) => `d-${i}#r0`);
		const t = tracker(
			binding(
				{ ambiguous: ["e1", "e2"], bare: ["e3"], huge: ["e4"], bound: ["e5"] },
				{ e3: [], e4: members, e5: members.slice(0, 64) },
			),
		);
		for (const id of ["pending", "ambiguous", "bare", "huge", "bound"]) {
			start(t, id);
			t.setOrigin(id, "message");
		}
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
		start(t, "m");
		t.setOrigin("m", "message");
		expect(t.snapshot().activeTurns[0]).toMatchObject({
			binding: { status: "unavailable" },
		});
	});
});

describe("LeadTurnStateTracker — disconnect / generations", () => {
	it("goes unconnected + unseeded on disconnect and never revives", () => {
		const onTrustLost = vi.fn();
		const t = tracker(binding(), onTrustLost);
		start(t, "live");
		t.markDisconnected();
		expect(t.snapshot()).toMatchObject({
			connected: false,
			seeded: false,
			activeTurns: [],
		});
		t.bindThread(THREAD);
		start(t, "late");
		t.observeLifecycle("turn/completed", "garbage");
		expect(t.applySeed(t.beginSeed(), null)).toBe(false);
		expect(t.snapshot()).toMatchObject({
			connected: false,
			seeded: false,
			activeTurns: [],
		});
		expect(onTrustLost).not.toHaveBeenCalled();
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
		start(old, "stale");
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
		finish(t, "whatever");
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
		start(t, "live");
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
