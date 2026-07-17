export function validateIntervals(intervals, t0, asOf) {
	for (const interval of intervals) {
		if (interval.end_ms === null && interval.state !== "open") {
			throw new Error("terminal interval is missing end_ms");
		}
		if (!Array.isArray(interval.evidence) || interval.evidence.length === 0) {
			throw new Error("interval must include evidence");
		}
		const effectiveEnd = interval.end_ms ?? asOf;
		if (
			!Number.isFinite(interval.start_ms) ||
			!Number.isFinite(effectiveEnd) ||
			interval.start_ms < t0 ||
			effectiveEnd > asOf ||
			effectiveEnd <= interval.start_ms
		) {
			throw new Error("interval is outside lifecycle bounds");
		}
	}

	const sorted = [...intervals].sort(
		(a, b) =>
			`${a.issue}\0${a.source}\0${a.kind}`.localeCompare(
				`${b.issue}\0${b.source}\0${b.kind}`,
			) || a.start_ms - b.start_ms,
	);
	for (let index = 1; index < sorted.length; index += 1) {
		const previous = sorted[index - 1];
		const current = sorted[index];
		const sameKind =
			previous.issue === current.issue &&
			previous.source === current.source &&
			previous.kind === current.kind;
		if (
			sameKind &&
			!previous.allow_overlap &&
			!current.allow_overlap &&
			current.start_ms < (previous.end_ms ?? asOf)
		) {
			throw new Error(
				`illegal interval overlap for ${current.source}/${current.kind}`,
			);
		}
	}
	return intervals;
}

const SEGMENT_LABELS = new Set([
	"infra_incident",
	"gate_waiting_human",
	"rework_loop",
	"qa_running",
	"review_running",
	"ci_waiting",
	"working",
	"idle_gap",
	"unmeasurable",
]);

export function validateReport(report) {
	if (report.kind === "no_verdict") {
		if (
			!Array.isArray(report.failed_sources) ||
			report.failed_sources.length === 0
		) {
			throw new Error("no_verdict report requires failed_sources");
		}
		return report;
	}
	if (report.kind !== "analyzed") {
		throw new Error("unknown report kind");
	}
	let cursor = report.t0;
	for (const segment of report.segments) {
		if (segment.start_ms !== cursor || segment.end_ms <= segment.start_ms) {
			throw new Error("segments do not preserve wall-clock continuity");
		}
		if (!SEGMENT_LABELS.has(segment.label)) {
			throw new Error(`unknown segment label: ${segment.label}`);
		}
		if (!Array.isArray(segment.evidence) || segment.evidence.length === 0) {
			throw new Error("segment must include evidence");
		}
		cursor = segment.end_ms;
	}
	if (cursor !== report.end_ms) {
		throw new Error("segments do not sum to wall-clock lifecycle");
	}
	return report;
}
