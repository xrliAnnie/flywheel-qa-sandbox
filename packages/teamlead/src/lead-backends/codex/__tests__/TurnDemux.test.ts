/**
 * FLY-259 PR-B — TurnDemux unit tests: R4 HIGH-2 routing rules + the R5
 * HIGH-1 pending-dispatch handshake (notification-before-response replay).
 */

import { describe, expect, it } from "vitest";
import { extractTurnId, TurnDemux } from "../TurnDemux.js";

function harness() {
	const toExec: Array<[string, unknown]> = [];
	const toObs: Array<[string, unknown]> = [];
	let activity = 0;
	const demux = new TurnDemux({
		toExecutor: (m, p) => toExec.push([m, p]),
		toObserver: (m, p) => toObs.push([m, p]),
		onActivity: () => {
			activity += 1;
		},
	});
	return { demux, toExec, toObs, activityCount: () => activity };
}

const delta = (turnId: string, text: string) => ({
	turnId,
	delta: text,
});
const completed = (turnId: string) => ({ turn: { id: turnId } });

describe("extractTurnId", () => {
	it("reads top-level turnId (deltas) and nested turn.id (completed)", () => {
		expect(extractTurnId({ turnId: "t1" })).toBe("t1");
		expect(extractTurnId({ turn: { id: "t2" } })).toBe("t2");
		expect(extractTurnId({})).toBeUndefined();
		expect(extractTurnId(undefined)).toBeUndefined();
		expect(extractTurnId({ turnId: 42 })).toBeUndefined();
	});
});

describe("TurnDemux — routing (R4 HIGH-2)", () => {
	it("registered turn events → executor; foreign → observer; no-id → activity only", () => {
		const h = harness();
		h.demux.beginDispatch();
		h.demux.claimTurn("ours");
		h.demux.route("item/agentMessage/delta", delta("ours", "hi"));
		h.demux.route("item/agentMessage/delta", delta("founder", "yo"));
		h.demux.route("account/rateLimits/updated", { rateLimits: {} });
		expect(h.toExec).toEqual([
			["item/agentMessage/delta", delta("ours", "hi")],
		]);
		expect(h.toObs).toEqual([
			["item/agentMessage/delta", delta("founder", "yo")],
		]);
		expect(h.activityCount()).toBe(3); // every event feeds activity
	});

	it("foreign turn/completed never reaches the executor", () => {
		const h = harness();
		h.demux.beginDispatch();
		h.demux.claimTurn("ours");
		h.demux.route("turn/completed", completed("founder"));
		expect(h.toExec).toEqual([]);
		expect(h.toObs).toHaveLength(1);
	});

	it("released turn ids: late stragglers are DROPPED (code review R1 MED-5 — tombstoned, never founder rows)", () => {
		const h = harness();
		h.demux.beginDispatch();
		h.demux.claimTurn("t1");
		h.demux.releaseTurn("t1");
		h.demux.route("item/agentMessage/delta", delta("t1", "late straggler"));
		expect(h.toExec).toEqual([]);
		expect(h.toObs).toEqual([]); // dropped, not misrouted to founder observer
	});
});

describe("TurnDemux — pending-dispatch handshake (R5 HIGH-1)", () => {
	it("notification-before-response: early events for OUR turn are held and replayed IN ORDER to the executor", () => {
		const h = harness();
		h.demux.beginDispatch(); // turn/start issued, response not yet back
		h.demux.route("item/agentMessage/delta", delta("t9", "early-1"));
		h.demux.route("item/agentMessage/delta", delta("t9", "early-2"));
		expect(h.toExec).toEqual([]); // held, not lost, not misrouted
		expect(h.toObs).toEqual([]);
		h.demux.claimTurn("t9"); // response arrives
		expect(h.toExec).toEqual([
			["item/agentMessage/delta", delta("t9", "early-1")],
			["item/agentMessage/delta", delta("t9", "early-2")],
		]);
		// and live routing continues to the executor
		h.demux.route("turn/completed", completed("t9"));
		expect(h.toExec).toHaveLength(3);
	});

	it("held events for OTHER turnIds settle to the observer on claim (they were foreign all along)", () => {
		const h = harness();
		h.demux.beginDispatch();
		h.demux.route(
			"item/agentMessage/delta",
			delta("founder", "typed during dispatch"),
		);
		h.demux.route("item/agentMessage/delta", delta("t9", "ours-early"));
		h.demux.claimTurn("t9");
		expect(h.toExec).toEqual([
			["item/agentMessage/delta", delta("t9", "ours-early")],
		]);
		expect(h.toObs).toEqual([
			["item/agentMessage/delta", delta("founder", "typed during dispatch")],
		]);
	});

	it("abortDispatch (turn/start failed): all held events were foreign → observer", () => {
		const h = harness();
		h.demux.beginDispatch();
		h.demux.route("item/agentMessage/delta", delta("tX", "whose?"));
		h.demux.abortDispatch();
		expect(h.toExec).toEqual([]);
		expect(h.toObs).toHaveLength(1);
		// after settling, the window is closed: new unknown ids go straight to observer
		h.demux.route("item/agentMessage/delta", delta("tY", "post-abort"));
		expect(h.toObs).toHaveLength(2);
	});

	it("no-id events during the pending window still feed only activity (never held)", () => {
		const h = harness();
		h.demux.beginDispatch();
		h.demux.route("thread/status/changed", { status: { type: "active" } });
		h.demux.claimTurn("t1");
		expect(h.toExec).toEqual([]);
		expect(h.toObs).toEqual([]);
		expect(h.activityCount()).toBe(1);
	});
});

describe("TurnDemux — code review R1 bounds", () => {
	it("MED-4: hold-buffer overflow settles the window as abort (flush to observer, loud log)", () => {
		const toObs: unknown[] = [];
		const logs: string[] = [];
		const demux = new TurnDemux(
			{
				toExecutor: () => {},
				toObserver: (m, p) => toObs.push([m, p]),
				log: (m) => logs.push(m),
			},
			{ heldCap: 2 },
		);
		demux.beginDispatch();
		demux.route("d", { turnId: "a" });
		demux.route("d", { turnId: "b" });
		demux.route("d", { turnId: "c" }); // overflow → settle as abort
		expect(toObs).toHaveLength(3); // 2 flushed + the overflowing one
		expect(logs.some((l) => l.includes("overflow"))).toBe(true);
		// window is closed now: a late claim replays nothing to the executor
	});

	it("MED-5: late events for a RELEASED sidecar turn are dropped with a diagnostic (never founder rows)", () => {
		const toObs: unknown[] = [];
		const logs: string[] = [];
		const demux = new TurnDemux({
			toExecutor: () => {},
			toObserver: (m, p) => toObs.push([m, p]),
			log: (m) => logs.push(m),
		});
		demux.beginDispatch();
		demux.claimTurn("t1");
		demux.releaseTurn("t1");
		demux.route("turn/completed", { turn: { id: "t1" } }); // late duplicate
		expect(toObs).toHaveLength(0); // NOT a founder-terminal row
		expect(logs.some((l) => l.includes("released turn t1"))).toBe(true);
	});
});

describe("TurnDemux — R2 MED-3 poisoned claim", () => {
	it("claimTurn after an overflow-settled window returns false and registers nothing", () => {
		const toExec: unknown[] = [];
		const toObs: unknown[] = [];
		const demux = new TurnDemux(
			{
				toExecutor: (m, p) => toExec.push([m, p]),
				toObserver: (m, p) => toObs.push([m, p]),
				log: () => {},
			},
			{ heldCap: 1 },
		);
		demux.beginDispatch();
		demux.route("d", { turnId: "t1" });
		demux.route("d", { turnId: "t1" }); // overflow → settle + poison
		expect(demux.claimTurn("t1")).toBe(false); // the late claim is rejected
		demux.route("turn/completed", { turn: { id: "t1" } });
		expect(toExec).toEqual([]); // never registered — executor sees nothing
	});

	it("a normal claim after a clean window still returns true", () => {
		const demux = new TurnDemux({
			toExecutor: () => {},
			toObserver: () => {},
		});
		demux.beginDispatch();
		expect(demux.claimTurn("ok")).toBe(true);
	});
});

describe("TurnDemux — R3 MED-1 rejected-claim tombstone", () => {
	it("late completion for a poison-rejected turnId is DROPPED (observer unchanged)", () => {
		const toObs: unknown[] = [];
		const logs: string[] = [];
		const demux = new TurnDemux(
			{
				toExecutor: () => {},
				toObserver: (m, p) => toObs.push([m, p]),
				log: (m) => logs.push(m),
			},
			{ heldCap: 1 },
		);
		demux.beginDispatch();
		demux.route("d", { turnId: "t1" });
		demux.route("d", { turnId: "t1" }); // overflow → settle + poison
		const obsAfterOverflow = toObs.length;
		expect(demux.claimTurn("t1")).toBe(false);
		demux.route("turn/completed", { turn: { id: "t1" } }); // late completion
		expect(toObs).toHaveLength(obsAfterOverflow); // dropped, NOT a founder row
		expect(logs.some((l) => l.includes("released turn t1"))).toBe(true);
	});
});
