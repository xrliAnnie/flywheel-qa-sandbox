import { describe, expect, it } from "vitest";
import { aggregate, compare, isHardSuccess } from "../aggregate.js";
import type { QualityMetrics } from "../types.js";

// Build a QualityMetrics with sensible defaults; override per case.
function mk(
	issueId: string,
	over: Partial<QualityMetrics> = {},
): QualityMetrics {
	const base: QualityMetrics = {
		issueId,
		conditionLabel: "A",
		execId: `exec-${issueId}`,
		completionRoute: "awaiting_review",
		prOutcome: "ready_to_merge",
		prNumber: 123,
		qaVerdict: "pass",
		ciHealth: "green",
		reworkRounds: 0,
		costContext: { tokenUsage: null, diff: null, durationMs: null },
		laggingReopen: null,
		signalPresent: { hardSuccess: true, qa: true, ci: true, rework: true },
		partial: false,
	};
	return {
		...base,
		...over,
		signalPresent: { ...base.signalPresent, ...over.signalPresent },
	};
}

describe("isHardSuccess", () => {
	it("ready_to_merge / merged = success regardless of pr_number", () => {
		expect(
			isHardSuccess(mk("a", { prOutcome: "ready_to_merge", prNumber: null })),
		).toBe(true);
		expect(
			isHardSuccess(mk("a", { prOutcome: "merged", prNumber: null })),
		).toBe(true);
	});
	it("pr_number present + non-blocked/failed route = success", () => {
		expect(
			isHardSuccess(
				mk("a", {
					prOutcome: "none",
					completionRoute: "awaiting_review",
					prNumber: 42,
				}),
			),
		).toBe(true);
		expect(
			isHardSuccess(
				mk("a", {
					prOutcome: "none",
					completionRoute: "completed",
					prNumber: 42,
				}),
			),
		).toBe(true);
	});
	// Codex code review HIGH-1: no PR (prOutcome none + no pr_number) must NOT false-pass
	it("completed/awaiting_review but NO PR (prOutcome none + no pr_number) → NOT success", () => {
		expect(
			isHardSuccess(
				mk("a", {
					prOutcome: "none",
					completionRoute: "completed",
					prNumber: null,
				}),
			),
		).toBe(false);
		expect(
			isHardSuccess(
				mk("a", {
					prOutcome: "none",
					completionRoute: "awaiting_review",
					prNumber: null,
				}),
			),
		).toBe(false);
	});
	it("blocked/failed = not success", () => {
		expect(
			isHardSuccess(
				mk("a", { prOutcome: "failed", completionRoute: "failed" }),
			),
		).toBe(false);
		expect(
			isHardSuccess(mk("a", { prOutcome: "none", completionRoute: "blocked" })),
		).toBe(false);
	});
	it("missing signal = not success even if values look ok", () => {
		expect(
			isHardSuccess(
				mk("a", {
					prOutcome: "ready_to_merge",
					signalPresent: { hardSuccess: false } as never,
				}),
			),
		).toBe(false);
	});
});

describe("aggregate", () => {
	it("rates use n as denominator; coverage separate", () => {
		const tasks = [
			mk("1"),
			mk("2", { qaVerdict: "none", signalPresent: { qa: false } as never }),
			mk("3", { qaVerdict: "fail" }),
		];
		const agg = aggregate("A", tasks);
		expect(agg.n).toBe(3);
		expect(agg.hardSuccessRate).toBeCloseTo(1.0);
		// only task 1 passes QA → 1/3
		expect(agg.qaPassRate).toBeCloseTo(1 / 3);
		// qa present on 1 and 3 (fail is a present verdict), missing on 2 → 2/3
		expect(agg.coverage.qa).toBeCloseTo(2 / 3);
	});

	it("recycle advisory counts only observed lagging", () => {
		const tasks = [
			mk("1", {
				laggingReopen: {
					laggingStatus: "observed",
					reopened: true,
					currentStateNonCompletedAfterReady: true,
					secondRunner: false,
					refixDetected: false,
					evidence: null,
					observedAsOf: "t",
				},
			}),
			mk("2", {
				laggingReopen: {
					laggingStatus: "observed",
					reopened: false,
					currentStateNonCompletedAfterReady: false,
					secondRunner: false,
					refixDetected: false,
					evidence: null,
					observedAsOf: "t",
				},
			}),
			mk("3", {
				laggingReopen: {
					laggingStatus: "not_applicable",
					reopened: null,
					currentStateNonCompletedAfterReady: null,
					secondRunner: null,
					refixDetected: null,
					evidence: null,
					observedAsOf: null,
				},
			}),
		];
		const agg = aggregate("A", tasks);
		expect(agg.recycle.observed).toBe(2);
		expect(agg.recycle.recycled).toBe(1);
		expect(agg.recycle.rate).toBeCloseTo(0.5);
	});
});

describe("compare — count-first soft verdict", () => {
	const three = (over: Partial<QualityMetrics> = {}) => [
		mk("1", over),
		mk("2", over),
		mk("3", over),
	];

	it("all hold → looks_hold", () => {
		const r = compare("off", three(), "on", three());
		expect(r.inconclusive).toBe(false);
		expect(r.overall).toBe("looks_hold");
	});

	it("candidate better → still looks_hold (countDelta>=0)", () => {
		const baseline = [mk("1", { qaVerdict: "fail" }), mk("2"), mk("3")];
		const candidate = three();
		const r = compare("off", baseline, "on", candidate);
		expect(r.overall).toBe("looks_hold");
	});

	it("single-task regression in 3-sample → NOT dropped (unclear)", () => {
		const baseline = three();
		const candidate = [mk("1"), mk("2"), mk("3", { qaVerdict: "fail" })]; // one QA down
		const r = compare("off", baseline, "on", candidate);
		expect(r.overall).toBe("unclear");
		const qa = r.metrics.find((m) => m.metric === "qa");
		expect(qa?.softLabel).toBe("unclear");
	});

	it("two-task regression on one metric → looks_dropped", () => {
		const baseline = three();
		const candidate = [
			mk("1"),
			mk("2", { qaVerdict: "fail" }),
			mk("3", { qaVerdict: "fail" }),
		];
		const r = compare("off", baseline, "on", candidate);
		expect(r.overall).toBe("looks_dropped");
	});

	it("one-task down on TWO metrics → looks_dropped (corroborated)", () => {
		const baseline = three();
		const candidate = [
			mk("1"),
			mk("2"),
			mk("3", { qaVerdict: "fail", ciHealth: "red" }),
		];
		const r = compare("off", baseline, "on", candidate);
		expect(r.overall).toBe("looks_dropped");
	});

	// === Codex R3 #5 mandated boundary tests: missing signal must NOT look like hold ===
	it("baseline 3 pass vs candidate 2 pass + 1 missing QA → NOT hold (inconclusive)", () => {
		const baseline = three();
		const candidate = [
			mk("1"),
			mk("2"),
			mk("3", { qaVerdict: "none", signalPresent: { qa: false } as never }),
		];
		const r = compare("off", baseline, "on", candidate);
		expect(r.overall).not.toBe("looks_hold");
		expect(r.inconclusive).toBe(true);
		expect(r.reasons).toContain("coverage<1:qa");
	});

	it("candidate 2 green + 1 unknown CI → NOT hold (inconclusive)", () => {
		const baseline = three();
		const candidate = [
			mk("1"),
			mk("2"),
			mk("3", { ciHealth: "unknown", signalPresent: { ci: false } as never }),
		];
		const r = compare("off", baseline, "on", candidate);
		expect(r.overall).not.toBe("looks_hold");
		expect(r.inconclusive).toBe(true);
		expect(r.reasons).toContain("coverage<1:ci");
	});

	it("n<minSamples → inconclusive", () => {
		const r = compare("off", [mk("1"), mk("2")], "on", [mk("1"), mk("2")]);
		expect(r.inconclusive).toBe(true);
		expect(r.reasons).toContain("n<3");
	});

	it("task set mismatch → inconclusive with reason", () => {
		const r = compare("off", three(), "on", [mk("1"), mk("2"), mk("9")]);
		expect(r.inconclusive).toBe(true);
		expect(r.reasons).toContain("task_set_mismatch");
	});

	// === report-only: rework / diff missing must NOT affect hold/drop (Codex R3 #7) ===
	it("rework + diff fully missing does NOT change overall hold", () => {
		const noAdvisory = (over: Partial<QualityMetrics> = {}) =>
			[mk("1"), mk("2"), mk("3")].map((m) => ({
				...m,
				...over,
				reworkRounds: null,
				costContext: null,
				signalPresent: { ...m.signalPresent, rework: false },
			}));
		const r = compare("off", noAdvisory(), "on", noAdvisory());
		expect(r.overall).toBe("looks_hold");
		expect(r.inconclusive).toBe(false);
	});

	it("rework increase surfaces as advisory note, not a drop", () => {
		const baseline = three({ reworkRounds: 0 });
		const candidate = three({ reworkRounds: 2 });
		const r = compare("off", baseline, "on", candidate);
		expect(r.overall).toBe("looks_hold"); // quality held
		expect(r.reworkAdvisory.candidateAvg).toBeGreaterThan(
			r.reworkAdvisory.baselineAvg ?? 0,
		);
		expect(r.reworkAdvisory.note).toBeTruthy();
	});
});
