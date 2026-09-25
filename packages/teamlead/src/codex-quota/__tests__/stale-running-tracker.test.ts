import { describe, expect, it } from "vitest";
import {
	parseSqliteUtcTimestamp,
	StaleRunningTracker,
} from "../stale-running-tracker.js";

describe("FLY-2869 — SQLite CURRENT_TIMESTAMP parsing", () => {
	it.each([
		["2026-09-16 03:13:42", Date.parse("2026-09-16T03:13:42Z")],
		["2028-02-29 00:00:00", Date.parse("2028-02-29T00:00:00Z")],
		["2026-02-30 00:00:00", null],
		["2026-09-16T03:13:42Z", null],
		["2026-09-16 03:13", null],
		["", null],
		[null, null],
	])("parses %s as UTC or rejects it", (value, expected) => {
		expect(parseSqliteUtcTimestamp(value)).toBe(expected);
	});
});

describe("FLY-2869 — sustained absence of a running row's reader", () => {
	const key = "db|exec|2026-09-16 03:13:42";

	it("matures only for a round that starts 60 s after the first confirming commit", () => {
		const tracker = new StaleRunningTracker();
		// Round 1 is slow: it starts at 0 and commits at 70 s.
		const r1 = tracker.begin(0);
		expect(tracker.commit(r1, new Set([key]), 70_000)).toEqual(new Set());
		// Round 2 starts right after; 70 s since round 1 STARTED is not enough.
		const r2 = tracker.begin(70_001);
		expect(tracker.commit(r2, new Set([key]), 70_500)).toEqual(new Set());
		// Round 3 starts 60 s after round 1 COMMITTED: now it may mature.
		const r3 = tracker.begin(130_000);
		expect(tracker.commit(r3, new Set([key]), 130_100)).toEqual(new Set([key]));
	});

	it("clears a candidate the moment a round no longer confirms it", () => {
		const tracker = new StaleRunningTracker();
		tracker.commit(tracker.begin(0), new Set([key]), 1);
		tracker.commit(tracker.begin(30_000), new Set(), 30_001);
		expect(
			tracker.commit(tracker.begin(61_000), new Set([key]), 61_001),
		).toEqual(new Set());
		expect(
			tracker.commit(tracker.begin(121_002), new Set([key]), 121_003),
		).toEqual(new Set([key]));
	});

	it("never lets an older round that finishes last modify the tracker", () => {
		const tracker = new StaleRunningTracker();
		tracker.commit(tracker.begin(0), new Set([key]), 1);
		const older = tracker.begin(10_000);
		const newer = tracker.begin(61_000);
		expect(tracker.commit(newer, new Set([key]), 61_001)).toEqual(
			new Set([key]),
		);
		// The older round saw nothing (e.g. a process), but it is stale evidence.
		expect(tracker.commit(older, new Set(), 70_000)).toEqual(new Set());
		expect(
			tracker.commit(tracker.begin(62_000), new Set([key]), 62_001),
		).toEqual(new Set([key]));
	});

	it("resets everything on an incomplete round and after a restart", () => {
		const tracker = new StaleRunningTracker();
		tracker.commit(tracker.begin(0), new Set([key]), 1);
		tracker.fail(tracker.begin(30_000));
		expect(
			tracker.commit(tracker.begin(61_000), new Set([key]), 61_001),
		).toEqual(new Set());
		const restarted = new StaleRunningTracker();
		expect(
			restarted.commit(restarted.begin(500_000), new Set([key]), 500_001),
		).toEqual(new Set());
	});
});
