const PRIORITY = [
	"infra_incident",
	"gate_waiting_human",
	"rework_loop",
	"qa_running",
	"review_running",
	"ci_waiting",
	"working",
	"idle_gap",
	"unmeasurable",
];

const priorityOf = (label) => {
	const priority = PRIORITY.indexOf(label);
	return priority === -1 ? PRIORITY.length : priority;
};

export function segmentIssue({
	issue,
	t0,
	end,
	asOf,
	intervals,
	coverage,
	idleHints = [],
}) {
	const closed = end !== null && end <= asOf;
	const effectiveEnd = closed ? end : asOf;
	const required = new Set(["linear", "teamlead", "commdb", "gh"]);
	const failed_sources = coverage
		.filter((item) => required.has(item.source) && item.status === "failed")
		.map((item) => ({ source: item.source, kind: item.authoritative_kind }));
	if (failed_sources.length > 0) {
		return {
			kind: "no_verdict",
			issue,
			as_of: asOf,
			failed_sources,
			notes: ["required source unavailable"],
		};
	}
	const healthFailed = coverage.some(
		(item) => item.source === "system-health" && item.status === "failed",
	);
	const overlays = healthFailed
		? [
				{
					kind: "load_unknown",
					intervals: [{ start_ms: t0, end_ms: effectiveEnd }],
				},
			]
		: [];
	const normalized = intervals.map((interval) => ({
		...interval,
		end_ms: interval.end_ms ?? effectiveEnd,
		in_flight: interval.end_ms === null,
	}));
	const boundaries = [
		...new Set([
			t0,
			effectiveEnd,
			...normalized.flatMap((item) => [item.start_ms, item.end_ms]),
			...coverage.flatMap((item) =>
				item.covered.flatMap((span) => [span.start_ms, span.end_ms]),
			),
			...idleHints.flatMap((item) => [item.start_ms, item.end_ms]),
		]),
	]
		.filter((point) => point >= t0 && point <= effectiveEnd)
		.sort((a, b) => a - b);
	const firstActivityStart = Math.min(
		effectiveEnd,
		...normalized.map((item) => item.start_ms),
		...idleHints.map((item) => item.start_ms),
	);
	const segments = [];
	for (let index = 0; index < boundaries.length - 1; index += 1) {
		const start_ms = boundaries[index];
		const end_ms = boundaries[index + 1];
		const active = normalized
			.filter((item) => item.start_ms <= start_ms && item.end_ms >= end_ms)
			.sort((a, b) => priorityOf(a.label) - priorityOf(b.label));
		const dominant = active[0];
		const idleHint = idleHints.find(
			(item) => item.start_ms <= start_ms && item.end_ms >= end_ms,
		);
		const uncovered = coverage.filter(
			(item) =>
				required.has(item.source) &&
				!item.covered.some(
					(span) => span.start_ms <= start_ms && span.end_ms >= end_ms,
				),
		);
		segments.push(
			uncovered.length > 0
				? {
						start_ms,
						end_ms,
						label: "unmeasurable",
						in_flight: false,
						evidence: uncovered.map((item) => ({
							source: item.source,
							key: `${item.source}:${item.authoritative_kind}:coverage-gap`,
							summary: item.note || "source coverage gap",
						})),
					}
				: dominant
					? {
							start_ms,
							end_ms,
							label: dominant.label,
							sublabel: dominant.sublabel,
							in_flight: active.some((item) => item.in_flight),
							evidence: active.flatMap((item) => item.evidence),
						}
					: {
							start_ms,
							end_ms,
							label: "idle_gap",
							sublabel:
								idleHint?.sublabel ??
								(start_ms < firstActivityStart
									? "backlog_or_dispatch_wait"
									: "phase_handoff"),
							in_flight: false,
							evidence: idleHint?.evidence ?? [
								{
									source: "coverage",
									key: `${issue}:${start_ms}-${end_ms}`,
									summary: "all required sources covered",
								},
							],
						},
		);
	}
	return {
		kind: "analyzed",
		issue,
		t0,
		end_ms: effectiveEnd,
		as_of: asOf,
		closed,
		coverage,
		overlays,
		segments,
	};
}
