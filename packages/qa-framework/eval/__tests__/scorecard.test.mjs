import { describe, expect, it } from "vitest";
import { renderScorecard } from "../scorecard.mjs";

function cond(label, over = {}) {
	return {
		label,
		tasks: [
			{
				issueId: "FLY-SBX-1",
				conditionLabel: label,
				completionRoute: "awaiting_review",
				prOutcome: "ready_to_merge",
				qaVerdict: "pass",
				ciHealth: "green",
				reworkRounds: 0,
				partial: false,
			},
		],
		aggregate: {
			conditionLabel: label,
			n: 3,
			hardSuccessRate: 1,
			qaPassRate: 1,
			ciGreenRate: 1,
			avgReworkRounds: 0,
			coverage: { hardSuccess: 1, qa: 1, ci: 1, rework: 1 },
			partialCount: 0,
			costSummary: { medianTotalTokens: 12000, medianLinesChanged: 40 },
			recycle: { observed: 0, recycled: 0, rate: null },
			...over,
		},
	};
}

const baseComparison = {
	baselineLabel: "ponytail-off",
	candidateLabel: "ponytail-on",
	n: { baseline: 3, candidate: 3 },
	metrics: [
		{
			metric: "hardSuccess",
			baselineRate: 1,
			candidateRate: 1,
			baselineCount: 3,
			candidateCount: 3,
			countDelta: 0,
			rateDelta: 0,
			baselineCi: { low: 0.4, high: 1 },
			candidateCi: { low: 0.4, high: 1 },
			ciOverlap: true,
			softLabel: "looks_hold",
		},
		{
			metric: "qa",
			baselineRate: 1,
			candidateRate: 1,
			baselineCount: 3,
			candidateCount: 3,
			countDelta: 0,
			rateDelta: 0,
			baselineCi: { low: 0.4, high: 1 },
			candidateCi: { low: 0.4, high: 1 },
			ciOverlap: true,
			softLabel: "looks_hold",
		},
		{
			metric: "ci",
			baselineRate: 1,
			candidateRate: 1,
			baselineCount: 3,
			candidateCount: 3,
			countDelta: 0,
			rateDelta: 0,
			baselineCi: { low: 0.4, high: 1 },
			candidateCi: { low: 0.4, high: 1 },
			ciOverlap: true,
			softLabel: "looks_hold",
		},
	],
	overall: "looks_hold",
	inconclusive: false,
	reasons: [],
	reworkAdvisory: {
		baselineAvg: 0,
		candidateAvg: 0,
		baselineSum: 0,
		candidateSum: 0,
		note: null,
	},
	recycleAdvisory: { baselineRate: null, candidateRate: null, note: null },
};

const input = {
	meta: {
		issue: "FLY-616",
		date: "2026-06-28",
		taskSet: ["FLY-SBX-1", "FLY-SBX-2", "FLY-SBX-3"],
	},
	conditions: [cond("ponytail-off"), cond("ponytail-on")],
	comparison: baseComparison,
};

describe("renderScorecard", () => {
	it("renders valid HTML shell", () => {
		const html = renderScorecard(input);
		expect(html.startsWith("<!doctype html>")).toBe(true);
		expect(html).toContain("</html>");
		expect(html).toContain("FLY-616");
	});

	it("shows overall soft verdict banner + 'Annie 定' (not a hard gate)", () => {
		const html = renderScorecard(input);
		expect(html).toContain("看起来持平");
		expect(html).toContain("Annie 定");
		expect(html).toContain("不阻断");
	});

	it("renders condition labels + cost context card marked non-verdict", () => {
		const html = renderScorecard(input);
		expect(html).toContain("ponytail-off");
		expect(html).toContain("ponytail-on");
		expect(html).toContain("FLY-614");
		expect(html).toContain("非质量判据");
	});

	it("renders recycle (回炉率) card as lagging non-verdict; N/A when unobserved", () => {
		const html = renderScorecard(input);
		expect(html).toContain("回炉率");
		expect(html).toContain("待采集 / N/A");
	});

	it("dropped verdict shows ⚠️ banner", () => {
		const html = renderScorecard({
			...input,
			comparison: { ...baseComparison, overall: "looks_dropped" },
		});
		expect(html).toContain("看起来掉了");
	});

	it("coverage<1 surfaces a warning card", () => {
		const html = renderScorecard({
			...input,
			conditions: [
				cond("ponytail-off"),
				cond("ponytail-on", {
					coverage: { hardSuccess: 1, qa: 2 / 3, ci: 1, rework: 1 },
				}),
			],
		});
		expect(html).toContain("信号覆盖不全");
	});

	it("subjective slot marked next-phase", () => {
		const html = renderScorecard(input);
		expect(html).toContain("主观质量");
		expect(html).toContain("下一阶段");
	});
});
