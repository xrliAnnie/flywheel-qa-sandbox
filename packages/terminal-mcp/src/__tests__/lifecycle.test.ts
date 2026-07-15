import { describe, expect, it } from "vitest";
import {
	ABANDON_REASON_MAX,
	ABANDON_STATUS_SET,
	ABANDON_STATUSES_PARAM,
	buildRunnerListText,
	classifyRunnerRow,
	DONE_STATUS_SET,
	DONE_STATUSES_PARAM,
	formatRunnerRow,
	mapWithConcurrency,
	REENGAGE_HINT,
	type RunnerRow,
	validateAbandonReason,
} from "../lifecycle.js";

const row = (over: Partial<RunnerRow> = {}): RunnerRow => ({
	executionId: "e1",
	tmuxWindow: "sess:@1",
	issueId: "FLY-1",
	status: "completed",
	alive: true,
	startedAt: "2026-06-05T00:00:00Z",
	...over,
});

describe("classifyRunnerRow", () => {
	it("running is always 'running' regardless of liveness", () => {
		expect(classifyRunnerRow("running", true)).toBe("running");
		expect(classifyRunnerRow("running", false)).toBe("running");
	});
	it("completed/timeout + alive → parked-alive", () => {
		expect(classifyRunnerRow("completed", true)).toBe("parked-alive");
		expect(classifyRunnerRow("timeout", true)).toBe("parked-alive");
	});
	it("completed/timeout + not alive → dead", () => {
		expect(classifyRunnerRow("completed", false)).toBe("dead");
		expect(classifyRunnerRow("timeout", false)).toBe("dead");
	});
});

describe("formatRunnerRow", () => {
	it("emits status/alive/class and appends the re-engage hint only for parked-alive", () => {
		const parked = formatRunnerRow(row({ status: "completed", alive: true }));
		expect(parked).toContain("class=parked-alive");
		expect(parked).toContain("alive=true");
		expect(parked).toContain(REENGAGE_HINT);

		const dead = formatRunnerRow(row({ status: "completed", alive: false }));
		expect(dead).toContain("class=dead");
		expect(dead).not.toContain(REENGAGE_HINT);

		const run = formatRunnerRow(row({ status: "running", alive: true }));
		expect(run).toContain("class=running");
		expect(run).not.toContain(REENGAGE_HINT);
	});
});

describe("buildRunnerListText", () => {
	const running = [row({ executionId: "r1", status: "running", alive: true })];
	const parked = row({ executionId: "p1", status: "completed", alive: true });
	const dead = row({ executionId: "d1", status: "completed", alive: false });

	it("active_only=true shows running + parked-alive, hides dead", () => {
		const txt = buildRunnerListText({
			running,
			terminal: [parked, dead],
			terminalTotal: 2,
			cap: 150,
			activeOnly: true,
		});
		expect(txt).toContain("[r1]");
		expect(txt).toContain("[p1]");
		expect(txt).not.toContain("[d1]");
	});

	it("active_only=false shows all classes including dead", () => {
		const txt = buildRunnerListText({
			running,
			terminal: [parked, dead],
			terminalTotal: 2,
			cap: 150,
			activeOnly: false,
		});
		expect(txt).toContain("[r1]");
		expect(txt).toContain("[p1]");
		expect(txt).toContain("[d1]");
	});

	it("running rows are never consumed by the terminal cap (separate inputs)", () => {
		// cap is tiny but running rows still all show
		const txt = buildRunnerListText({
			running: [
				row({ executionId: "r1", status: "running" }),
				row({ executionId: "r2", status: "running" }),
			],
			terminal: [],
			terminalTotal: 0,
			cap: 1,
			activeOnly: true,
		});
		expect(txt).toContain("[r1]");
		expect(txt).toContain("[r2]");
	});

	it("appends a count-only truncation summary when terminalTotal > cap", () => {
		const txt = buildRunnerListText({
			running: [],
			terminal: [parked],
			terminalTotal: 153,
			cap: 150,
			activeOnly: true,
		});
		expect(txt).toContain("3 older in-scope terminal sessions not examined");
		expect(txt).toContain("liveness unknown");
	});

	it("no truncation summary when within cap", () => {
		const txt = buildRunnerListText({
			running: [],
			terminal: [parked],
			terminalTotal: 1,
			cap: 150,
			activeOnly: true,
		});
		expect(txt).not.toContain("not examined");
	});

	it("returns a friendly message when nothing to show", () => {
		expect(
			buildRunnerListText({
				running: [],
				terminal: [],
				terminalTotal: 0,
				cap: 150,
				activeOnly: true,
			}),
		).toBe("No sessions found.");
	});
});

describe("validateAbandonReason", () => {
	it("rejects empty / whitespace", () => {
		expect(() => validateAbandonReason("")).toThrow(/non-empty reason/);
		expect(() => validateAbandonReason("   ")).toThrow(/non-empty reason/);
		expect(() => validateAbandonReason(undefined)).toThrow(/non-empty reason/);
	});
	it("trims and caps length", () => {
		expect(validateAbandonReason("  cancel GEO-411  ")).toBe("cancel GEO-411");
		expect(validateAbandonReason("x".repeat(600))).toHaveLength(
			ABANDON_REASON_MAX,
		);
	});
});

describe("abandon status set", () => {
	it("is exactly the parked states (no union with closable)", () => {
		expect([...ABANDON_STATUS_SET]).toEqual([
			"awaiting_review",
			"approved_to_ship",
		]);
		expect(ABANDON_STATUSES_PARAM).toBe("awaiting_review,approved_to_ship");
	});
});

// FLY-638 + FLY-1204: done-mode lookup status set (running + the two parked
// states + the three-stage Design phase-session state design_done).
describe("done status set", () => {
	it("mirrors FINALIZE_DONE_SOURCE_STATES incl. design_done (FLY-1204)", () => {
		expect([...DONE_STATUS_SET]).toEqual([
			"running",
			"awaiting_review",
			"approved_to_ship",
			"design_done",
		]);
		expect(DONE_STATUSES_PARAM).toBe(
			"running,awaiting_review,approved_to_ship,design_done",
		);
	});
});

describe("mapWithConcurrency", () => {
	it("preserves order and bounds in-flight count", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
		const out = await mapWithConcurrency(items, 3, async (n) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((r) => setTimeout(r, 1));
			inFlight--;
			return n * 2;
		});
		expect(out).toEqual(items.map((n) => n * 2));
		expect(maxInFlight).toBeLessThanOrEqual(3);
	});
	it("handles empty input", async () => {
		expect(await mapWithConcurrency([], 8, async (x) => x)).toEqual([]);
	});
});
