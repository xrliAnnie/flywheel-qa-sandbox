export const CONCURRENCY_INSUFFICIENT_MSG = "样本不足以定量,建议持续采集";
const THRESHOLDS = Object.freeze({
	coverage: 0.8,
	dominance: 0.3,
	operator: ">=",
});

export const CATEGORY_BY_LABEL = Object.freeze({
	working: "value_work",
	review_running: "necessary_process",
	qa_running: "necessary_process",
	ci_waiting: "necessary_process",
	idle_gap: "mechanism_waste",
	infra_incident: "mechanism_waste",
	rework_loop: "execution_waste",
	gate_waiting_human: "human_wait",
	unmeasurable: "unknown",
});

const duration = (segment) => segment.end_ms - segment.start_ms;

export function summarizeIssue(report) {
	const totals = {
		value_work: 0,
		necessary_process: 0,
		mechanism_waste: 0,
		execution_waste: 0,
		human_wait: 0,
		unknown: 0,
	};
	for (const segment of report.segments) {
		if (segment.in_flight) continue;
		totals[CATEGORY_BY_LABEL[segment.label]] += duration(segment);
	}
	const classifiable = Object.entries(totals)
		.filter(([category]) => category !== "unknown")
		.reduce((sum, [, value]) => sum + value, 0);
	const total = classifiable + totals.unknown;
	return {
		issue: report.issue,
		totals,
		classifiable,
		coverage_rate: total === 0 ? 0 : classifiable / total,
		mechanism_share:
			classifiable === 0 ? 0 : totals.mechanism_waste / classifiable,
		execution_share:
			classifiable === 0 ? 0 : totals.execution_waste / classifiable,
	};
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[middle - 1] + sorted[middle]) / 2
		: sorted[middle];
}

export function classifyVerdict(reports) {
	const metrics = reports
		.filter((report) => report.kind === "analyzed" && report.closed)
		.map(summarizeIssue)
		.filter((item) => item.coverage_rate >= THRESHOLDS.coverage);
	const qualifying_issues = metrics.map((item) => item.issue);
	if (metrics.length < 2) {
		return {
			kind: "inconclusive",
			qualifying_issues,
			reason: "fewer_than_two_qualifying_issues",
			thresholds: THRESHOLDS,
		};
	}
	const classifiable = metrics.reduce(
		(sum, item) => sum + item.classifiable,
		0,
	);
	const pooledMechanism =
		metrics.reduce((sum, item) => sum + item.totals.mechanism_waste, 0) /
		classifiable;
	const pooledExecution =
		metrics.reduce((sum, item) => sum + item.totals.execution_waste, 0) /
		classifiable;
	const medianMechanism = median(metrics.map((item) => item.mechanism_share));
	const medianExecution = median(metrics.map((item) => item.execution_share));
	let kind = "inconclusive";
	let reason = "threshold_not_met";
	if (
		pooledMechanism > pooledExecution &&
		pooledMechanism >= THRESHOLDS.dominance &&
		medianMechanism > medianExecution &&
		medianMechanism >= THRESHOLDS.dominance
	) {
		kind = "mechanism";
	} else if (
		pooledExecution > pooledMechanism &&
		pooledExecution >= THRESHOLDS.dominance &&
		medianExecution > medianMechanism &&
		medianExecution >= THRESHOLDS.dominance
	) {
		kind = "execution";
	} else if (
		(pooledMechanism > pooledExecution && medianMechanism < medianExecution) ||
		(pooledMechanism < pooledExecution && medianMechanism > medianExecution)
	) {
		reason = "pooled_median_disagree";
	}
	return {
		kind,
		reason: kind === "inconclusive" ? reason : undefined,
		qualifying_issues,
		thresholds: THRESHOLDS,
		pooled: { mechanism: pooledMechanism, execution: pooledExecution },
		median: { mechanism: medianMechanism, execution: medianExecution },
	};
}
