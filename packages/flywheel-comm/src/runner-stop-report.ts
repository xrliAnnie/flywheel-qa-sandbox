export interface RunnerStopReportCandidate {
	id?: unknown;
	kind?: unknown;
	content?: unknown;
}

export const RUNNER_STOP_REPORT_PREFIX = "RUNNER-STOPPED kind=runner_stopped ";
export const RUNNER_STOP_QUESTION_ID_RE = /^rstop-[0-9a-f]{32}$/;

export function isRunnerStopReport(
	candidate: RunnerStopReportCandidate,
): boolean {
	return (
		candidate.kind === "report" &&
		typeof candidate.id === "string" &&
		RUNNER_STOP_QUESTION_ID_RE.test(candidate.id) &&
		typeof candidate.content === "string" &&
		candidate.content.startsWith(RUNNER_STOP_REPORT_PREFIX)
	);
}
