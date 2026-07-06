import { describe, expect, it } from "vitest";
import {
	collectMetrics,
	deriveReopenFromTransitions,
	deriveSecondRunner,
	type EvalReaders,
	mapCompletionRoute,
	mapQaVerdict,
	parseLandingStatus,
	type RawSignals,
	toQualityMetrics,
} from "../extract.js";
import type { TaskRunHandle } from "../types.js";

describe("mapCompletionRoute", () => {
	it("maps statuses", () => {
		expect(mapCompletionRoute("completed")).toBe("completed");
		expect(mapCompletionRoute("awaiting_review")).toBe("awaiting_review");
		expect(mapCompletionRoute("approved_to_ship")).toBe("awaiting_review");
		expect(mapCompletionRoute("blocked")).toBe("blocked");
		expect(mapCompletionRoute("failed")).toBe("failed");
		expect(mapCompletionRoute("running")).toBe("unknown");
		expect(mapCompletionRoute(null)).toBe("unknown");
	});
});

describe("mapQaVerdict", () => {
	it("passed→pass, failed→fail, running/stuck/superseded→unknown, none", () => {
		expect(mapQaVerdict("passed")).toBe("pass");
		expect(mapQaVerdict("failed")).toBe("fail");
		expect(mapQaVerdict("running")).toBe("unknown");
		expect(mapQaVerdict("stuck")).toBe("unknown");
		expect(mapQaVerdict("superseded")).toBe("unknown");
		expect(mapQaVerdict(null)).toBe("none");
	});
});

describe("parseLandingStatus (3-state, Codex R4 #2)", () => {
	it("missing file → not attempted", () => {
		expect(parseLandingStatus(null)).toEqual({
			prOutcome: "none",
			ciHealth: "unknown",
		});
	});
	it("ready_to_merge / merged → green", () => {
		expect(parseLandingStatus('{"status":"ready_to_merge"}')).toEqual({
			prOutcome: "ready_to_merge",
			ciHealth: "green",
		});
		expect(parseLandingStatus('{"status":"merged"}')).toEqual({
			prOutcome: "merged",
			ciHealth: "green",
		});
	});
	it("pending → signal_missing(failed); parse error → failed", () => {
		expect(parseLandingStatus('{"status":"pending"}').prOutcome).toBe("failed");
		expect(parseLandingStatus("not json").prOutcome).toBe("failed");
	});
});

describe("deriveReopenFromTransitions (Codex R4 #1)", () => {
	const isCompleted = (s: string) => s === "Done" || s === "completed";
	it("completed→started→completed after ready MUST mark reopened (snapshot would miss)", () => {
		const transitions = [
			{ at: "2026-06-28T01:00:00Z", from: "In Progress", to: "Done" },
			{ at: "2026-06-28T02:00:00Z", from: "Done", to: "In Progress" }, // reopen
			{ at: "2026-06-28T03:00:00Z", from: "In Progress", to: "Done" }, // re-closed
		];
		expect(
			deriveReopenFromTransitions(
				transitions,
				"2026-06-28T00:30:00Z",
				isCompleted,
			),
		).toBe(true);
	});
	it("no completed→non-completed after ready → false", () => {
		const transitions = [
			{ at: "2026-06-28T01:00:00Z", from: "In Progress", to: "Done" },
		];
		expect(
			deriveReopenFromTransitions(
				transitions,
				"2026-06-28T00:30:00Z",
				isCompleted,
			),
		).toBe(false);
	});
	it("transition history unavailable → null (never infer from snapshot)", () => {
		expect(deriveReopenFromTransitions(null, "t", isCompleted)).toBeNull();
	});
	it("reopen BEFORE ready is ignored", () => {
		const transitions = [
			{ at: "2026-06-28T00:00:00Z", from: "Done", to: "In Progress" },
		];
		expect(
			deriveReopenFromTransitions(
				transitions,
				"2026-06-28T00:30:00Z",
				isCompleted,
			),
		).toBe(false);
	});
});

describe("deriveSecondRunner (Codex R4 #2 — exclude auto-QA)", () => {
	const ready = "2026-06-28T01:00:00Z";
	it("later session_role='qa' does NOT count", () => {
		const r = deriveSecondRunner(
			[
				{
					execId: "qa-1",
					sessionRole: "qa",
					startedAt: "2026-06-28T02:00:00Z",
				},
			],
			"main-1",
			ready,
		);
		expect(r.value).toBe(false);
	});
	it("later main session after pass DOES count", () => {
		const r = deriveSecondRunner(
			[
				{
					execId: "main-2",
					sessionRole: "main",
					startedAt: "2026-06-28T02:00:00Z",
				},
			],
			"main-1",
			ready,
		);
		expect(r.value).toBe(true);
		expect(r.execIds).toContain("main-2");
	});
	it("main retry BEFORE pass does NOT count as post-QA recycle", () => {
		const r = deriveSecondRunner(
			[
				{
					execId: "main-2",
					sessionRole: "main",
					startedAt: "2026-06-28T00:30:00Z",
				},
			],
			"main-1",
			ready,
		);
		expect(r.value).toBe(false);
	});
	it("no reliable pass/ready time → null", () => {
		const r = deriveSecondRunner(
			[
				{
					execId: "main-2",
					sessionRole: "main",
					startedAt: "2026-06-28T02:00:00Z",
				},
			],
			"main-1",
			null,
		);
		expect(r.value).toBeNull();
	});
});

describe("toQualityMetrics (pure)", () => {
	const baseRaw = (over: Partial<RawSignals> = {}): RawSignals => ({
		issueId: "FLY-SBX-1",
		conditionLabel: "ponytail-off",
		execId: "exec-1",
		session: {
			status: "awaiting_review",
			prNumber: 42,
			prHeadSha: "abc",
			worktreePath: "/wt",
		},
		autoQaStatus: "passed",
		qaFamilyExists: true,
		qaFailLoops: 0,
		landing: { prOutcome: "ready_to_merge", ciHealth: "green" },
		costContext: { tokenUsage: null, diff: null, durationMs: null },
		laggingReopen: null,
		...over,
	});

	it("happy path: hardSuccess+qa+ci present, not partial", () => {
		const m = toQualityMetrics(baseRaw());
		expect(m.signalPresent).toEqual({
			hardSuccess: true,
			qa: true,
			ci: true,
			rework: true,
		});
		expect(m.partial).toBe(false);
		expect(m.qaVerdict).toBe("pass");
		expect(m.prNumber).toBe(42); // carried through (Codex code review HIGH-1)
	});

	it("missing rework family alone → partial=true (Codex code review #2)", () => {
		// artificial: qa verdict present but no auto_qa_record family → rework signal absent
		const m = toQualityMetrics(
			baseRaw({ qaFamilyExists: false, qaFailLoops: null }),
		);
		expect(m.signalPresent.qa).toBe(true); // accepted verdict still present
		expect(m.signalPresent.rework).toBe(false);
		expect(m.reworkRounds).toBeNull();
		expect(m.partial).toBe(true); // missing rework marks partial (honest provenance)
	});

	it("missing QA record → qaVerdict none, qa signal absent, partial, reworkRounds null (NOT 0)", () => {
		const m = toQualityMetrics(
			baseRaw({ autoQaStatus: null, qaFamilyExists: false, qaFailLoops: null }),
		);
		expect(m.qaVerdict).toBe("none");
		expect(m.signalPresent.qa).toBe(false);
		expect(m.signalPresent.rework).toBe(false);
		expect(m.reworkRounds).toBeNull(); // Codex R4 #1: never default missing rework to 0
		expect(m.partial).toBe(true);
	});

	it("session unreadable → hardSuccess absent + partial", () => {
		const m = toQualityMetrics(baseRaw({ session: null }));
		expect(m.signalPresent.hardSuccess).toBe(false);
		expect(m.completionRoute).toBe("unknown");
		expect(m.partial).toBe(true);
	});

	it("lagging + cost missing does NOT make partial (Codex R4 #3)", () => {
		const m = toQualityMetrics(
			baseRaw({ laggingReopen: null, costContext: null }),
		);
		expect(m.partial).toBe(false); // quality signals all present
	});

	it("reworkRounds reflects qaFailLoops when family exists", () => {
		const m = toQualityMetrics(
			baseRaw({ qaFamilyExists: true, qaFailLoops: 2 }),
		);
		expect(m.reworkRounds).toBe(2);
		expect(m.signalPresent.rework).toBe(true);
	});
});

describe("collectMetrics (injected readers)", () => {
	const handle: TaskRunHandle = {
		issueId: "FLY-SBX-1",
		conditionLabel: "ponytail-on",
		execId: "exec-1",
		projectName: "flywheel",
		dbPath: "/fake/teamlead.db",
		worktreePath: "/wt",
	};

	const readers: EvalReaders = {
		async readSession() {
			return {
				status: "awaiting_review",
				prNumber: 7,
				prHeadSha: "head-1",
				worktreePath: "/wt",
			};
		},
		async readAcceptedQaStatus(_db, _parent, head) {
			return head === "head-1" ? "passed" : null;
		},
		async qaFamilyExists() {
			return true;
		},
		async countQaFailLoops() {
			return 1;
		},
		readLandingRaw() {
			return '{"status":"ready_to_merge"}';
		},
		async readFly614Tokens() {
			return null;
		},
		async readLagging() {
			return null;
		},
		async readDiff() {
			return { linesAdded: 10, linesRemoved: 2, filesChanged: 3 };
		},
	};

	it("composes readers into a QualityMetrics, binds head→accepted QA", async () => {
		const m = await collectMetrics(handle, readers);
		expect(m.issueId).toBe("FLY-SBX-1");
		expect(m.conditionLabel).toBe("ponytail-on");
		expect(m.qaVerdict).toBe("pass"); // bound via head-1
		expect(m.prOutcome).toBe("ready_to_merge");
		expect(m.ciHealth).toBe("green");
		expect(m.reworkRounds).toBe(1);
		expect(m.costContext?.diff?.filesChanged).toBe(3);
		expect(m.partial).toBe(false);
	});
});
