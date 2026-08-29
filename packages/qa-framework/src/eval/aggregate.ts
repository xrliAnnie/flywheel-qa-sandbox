// FLY-616 — aggregate + compare (count-first advisory verdict).
//
// 判定合同（Annie ③ + Codex R3/R5 §7）：摊数字 + 软建议、Annie 定最终线、
// **不设硬数字门、不做加权总分**。Wilson CI 仅 advisory 展示，绝不当判据。
// 返工/回炉/cost = advisory，不进总软判定。缺质量硬信号绝不当 pass。

import type {
	ConditionAggregate,
	EvalComparison,
	MetricComparison,
	OverallSuggestion,
	QualityMetrics,
	SoftLabel,
} from "./types.js";
import { intervalsOverlap, wilsonInterval } from "./wilson.js";

export const DEFAULT_MIN_SAMPLES = 3;
export const DEFAULT_COVERAGE_THRESHOLD = 1.0;

// ---- pass / present predicates (pure) ----

/**
 * hardSuccess PASS = 产出了可评估 PR（Codex R1 #4 + code review HIGH-1）。
 * = prOutcome∈{ready_to_merge,merged} **或** (有 pr_number 且 route 非 blocked/failed)。
 * **route 单独不算成功**（无 PR 的 completed/awaiting_review 不能 false-pass）。需信号在场。
 */
export function isHardSuccess(m: QualityMetrics): boolean {
	if (!m.signalPresent.hardSuccess) return false;
	return (
		m.prOutcome === "ready_to_merge" ||
		m.prOutcome === "merged" ||
		(m.prNumber != null &&
			m.completionRoute !== "blocked" &&
			m.completionRoute !== "failed")
	);
}
export const isQaPass = (m: QualityMetrics): boolean => m.qaVerdict === "pass";
export const isCiGreen = (m: QualityMetrics): boolean => m.ciHealth === "green";

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const s = [...values].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	if (s.length % 2) return s[mid] ?? null;
	const lo = s[mid - 1] ?? 0;
	const hi = s[mid] ?? 0;
	return (lo + hi) / 2;
}

/**
 * 聚合一个 condition。分母 = 期望任务数（缺信号算非-pass，coverage 单列）。
 */
export function aggregate(
	conditionLabel: string,
	tasks: QualityMetrics[],
): ConditionAggregate {
	const n = tasks.length;
	const rate = (count: number) => (n > 0 ? count / n : 0);

	const hardSuccessCount = tasks.filter(isHardSuccess).length;
	const qaPassCount = tasks.filter(isQaPass).length;
	const ciGreenCount = tasks.filter(isCiGreen).length;

	const cov = (pred: (m: QualityMetrics) => boolean) =>
		n > 0 ? tasks.filter(pred).length / n : 0;

	// rework advisory
	const reworkPresent = tasks.filter(
		(m) => m.signalPresent.rework && m.reworkRounds != null,
	);
	const avgReworkRounds =
		reworkPresent.length > 0
			? reworkPresent.reduce((s, m) => s + (m.reworkRounds ?? 0), 0) /
				reworkPresent.length
			: null;

	// cost summary (context)
	const tokenVals = tasks
		.map((m) => m.costContext?.tokenUsage?.totalTokens)
		.filter((v): v is number => typeof v === "number");
	const linesVals = tasks
		.map((m) => {
			const d = m.costContext?.diff;
			return d ? d.linesAdded + d.linesRemoved : undefined;
		})
		.filter((v): v is number => typeof v === "number");
	const costSummary =
		tokenVals.length || linesVals.length
			? {
					medianTotalTokens: median(tokenVals),
					medianLinesChanged: median(linesVals),
				}
			: null;

	// recycle (lagging) advisory: observed = laggingStatus==="observed"; recycled = any signal true
	const recycleObserved = tasks.filter(
		(m) => m.laggingReopen?.laggingStatus === "observed",
	);
	const recycledCount = recycleObserved.filter(
		(m) =>
			m.laggingReopen?.reopened === true ||
			m.laggingReopen?.secondRunner === true ||
			m.laggingReopen?.refixDetected === true,
	).length;

	return {
		conditionLabel,
		n,
		hardSuccessRate: rate(hardSuccessCount),
		qaPassRate: rate(qaPassCount),
		ciGreenRate: rate(ciGreenCount),
		avgReworkRounds,
		coverage: {
			hardSuccess: cov((m) => m.signalPresent.hardSuccess),
			qa: cov((m) => m.signalPresent.qa),
			ci: cov((m) => m.signalPresent.ci),
			rework: cov((m) => m.signalPresent.rework),
		},
		partialCount: tasks.filter((m) => m.partial).length,
		costSummary,
		recycle: {
			observed: recycleObserved.length,
			recycled: recycledCount,
			rate:
				recycleObserved.length > 0
					? recycledCount / recycleObserved.length
					: null,
		},
	};
}

interface CompareOpts {
	minSamples?: number;
	coverageThreshold?: number;
}

const PASS_PREDS: Record<
	MetricComparison["metric"],
	(m: QualityMetrics) => boolean
> = { hardSuccess: isHardSuccess, qa: isQaPass, ci: isCiGreen };

const PRESENT_PREDS: Record<
	MetricComparison["metric"],
	(m: QualityMetrics) => boolean
> = {
	hardSuccess: (m) => m.signalPresent.hardSuccess,
	qa: (m) => m.signalPresent.qa,
	ci: (m) => m.signalPresent.ci,
};

/**
 * 对比 baseline vs candidate（count-first advisory）。
 * 不阻断、不打硬分；inconclusive 时仍摊数字。Annie 定最终线。
 */
export function compare(
	baselineLabel: string,
	baseline: QualityMetrics[],
	candidateLabel: string,
	candidate: QualityMetrics[],
	opts: CompareOpts = {},
): EvalComparison {
	const minSamples = opts.minSamples ?? DEFAULT_MIN_SAMPLES;
	const coverageThreshold =
		opts.coverageThreshold ?? DEFAULT_COVERAGE_THRESHOLD;
	const reasons: string[] = [];

	// pair by issueId
	const bIds = new Set(baseline.map((m) => m.issueId));
	const cIds = new Set(candidate.map((m) => m.issueId));
	const sameSet =
		bIds.size === cIds.size && [...bIds].every((id) => cIds.has(id));
	if (!sameSet) reasons.push("task_set_mismatch");

	let inconclusive = !sameSet;
	if (baseline.length < minSamples || candidate.length < minSamples) {
		inconclusive = true;
		reasons.push(`n<${minSamples}`);
	}

	const metrics: MetricComparison[] = (
		["hardSuccess", "qa", "ci"] as const
	).map((metric) => {
		const passPred = PASS_PREDS[metric];
		const presentPred = PRESENT_PREDS[metric];
		const baselineCount = baseline.filter(passPred).length;
		const candidateCount = candidate.filter(passPred).length;
		const baselineRate = baseline.length ? baselineCount / baseline.length : 0;
		const candidateRate = candidate.length
			? candidateCount / candidate.length
			: 0;
		const baselineCi = wilsonInterval(baselineCount, baseline.length);
		const candidateCi = wilsonInterval(candidateCount, candidate.length);

		const bCov = baseline.length
			? baseline.filter(presentPred).length / baseline.length
			: 0;
		const cCov = candidate.length
			? candidate.filter(presentPred).length / candidate.length
			: 0;
		if (bCov < coverageThreshold || cCov < coverageThreshold) {
			inconclusive = true;
			reasons.push(`coverage<1:${metric}`);
		}

		return {
			metric,
			baselineRate,
			candidateRate,
			baselineCount,
			candidateCount,
			countDelta: candidateCount - baselineCount,
			rateDelta: candidateRate - baselineRate,
			baselineCi,
			candidateCi,
			ciOverlap: intervalsOverlap(baselineCi, candidateCi),
			softLabel: "unclear" as SoftLabel, // assigned below (needs cross-metric)
		};
	});

	// soft labels (need cross-metric countDelta)
	const anyOtherDown = (self: MetricComparison) =>
		metrics.some((o) => o.metric !== self.metric && o.countDelta <= -1);
	for (const mc of metrics) {
		if (mc.countDelta >= 0) mc.softLabel = "looks_hold";
		else if (mc.countDelta <= -2 || (mc.countDelta <= -1 && anyOtherDown(mc)))
			mc.softLabel = "looks_dropped";
		else mc.softLabel = "unclear";
	}

	// overall
	let overall: OverallSuggestion;
	if (inconclusive) {
		overall = "unclear";
	} else if (metrics.some((m) => m.softLabel === "looks_dropped")) {
		overall = "looks_dropped";
	} else if (metrics.every((m) => m.softLabel === "looks_hold")) {
		overall = "looks_hold";
	} else {
		overall = "unclear";
	}

	const bAgg = aggregate(baselineLabel, baseline);
	const cAgg = aggregate(candidateLabel, candidate);

	const reworkUp =
		bAgg.avgReworkRounds != null &&
		cAgg.avgReworkRounds != null &&
		cAgg.avgReworkRounds > bAgg.avgReworkRounds;

	return {
		baselineLabel,
		candidateLabel,
		n: { baseline: baseline.length, candidate: candidate.length },
		metrics,
		overall,
		inconclusive,
		reasons: [...new Set(reasons)],
		reworkAdvisory: {
			baselineAvg: bAgg.avgReworkRounds,
			candidateAvg: cAgg.avgReworkRounds,
			baselineSum: sumRework(baseline),
			candidateSum: sumRework(candidate),
			note: reworkUp
				? "主指标见 overall，但 candidate 返工增加（advisory）"
				: null,
		},
		recycleAdvisory: {
			baselineRate: bAgg.recycle.rate,
			candidateRate: cAgg.recycle.rate,
			note:
				cAgg.recycle.rate != null &&
				bAgg.recycle.rate != null &&
				cAgg.recycle.rate > bAgg.recycle.rate
					? "candidate 后来回炉率更高（滞后 advisory，非质量判据）"
					: null,
		},
	};
}

function sumRework(tasks: QualityMetrics[]): number | null {
	const present = tasks.filter(
		(m) => m.signalPresent.rework && m.reworkRounds != null,
	);
	if (present.length === 0) return null;
	return present.reduce((s, m) => s + (m.reworkRounds ?? 0), 0);
}
