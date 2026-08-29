/**
 * FLY-1048 PR-B (Codex R2 MEDIUM): getEventsByExecution must expose the row
 * timestamp — the judge's commEvents input computes REAL event ages from it,
 * and without `ts` every event was silently dropped (Date.parse("") → NaN),
 * starving the judge of recent-context evidence.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { parseSqliteUtcMs } from "../bridge/founder-notify-utils.js";
import { StateStore } from "../StateStore.js";

describe("session_events ts round-trip (FLY-1048 PR-B)", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	it("a real inserted row comes back with a parseable ts yielding a sane age", () => {
		expect(
			store.insertEvent({
				event_id: "evt-ts-roundtrip",
				execution_id: "exec-ts",
				issue_id: "FLY-1",
				project_name: "flywheel",
				event_type: "stage_changed",
				source: "test",
			}),
		).toBe(true);
		const events = store.getEventsByExecution("exec-ts");
		expect(events).toHaveLength(1);
		const ts = events[0]!.ts;
		expect(ts).toBeTruthy();
		// sqlite CURRENT_TIMESTAMP is UTC "YYYY-MM-DD HH:MM:SS" — the judge
		// input parser handles exactly this shape.
		const ms = parseSqliteUtcMs(ts ?? "") ?? Date.parse(ts ?? "");
		expect(Number.isFinite(ms)).toBe(true);
		const ageMs = Date.now() - (ms as number);
		expect(ageMs).toBeGreaterThanOrEqual(0);
		expect(ageMs).toBeLessThan(60_000); // freshly inserted → seconds, not hours
	});
});
