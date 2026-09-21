export interface RunnerStopReportCandidate {
	id?: unknown;
	kind?: unknown;
	content?: unknown;
}

export interface RunnerStopDeclarationEvidence {
	state_key: string;
	content_hash: string;
	content: string;
	question_id: string;
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

export function runnerStopDoneProof(
	candidate: RunnerStopReportCandidate & { fromAgent?: unknown },
	declaration: RunnerStopDeclarationEvidence | undefined,
): { contentHash: string } | undefined {
	if (
		!isRunnerStopReport(candidate) ||
		!declaration ||
		typeof candidate.content !== "string"
	)
		return undefined;
	const content = candidate.content;
	const match = content.match(
		/^RUNNER-STOPPED kind=runner_stopped reason=([^ ]+) issue=([^ ]+) exec=([^ ]+) route=([^ ]+) detail=/,
	);
	if (
		match?.[1] !== "done" ||
		typeof candidate.fromAgent !== "string" ||
		match[3] !== candidate.fromAgent ||
		declaration.question_id !== candidate.id ||
		declaration.content !== content ||
		!(
			declaration.state_key.startsWith("completion\0") ||
			declaration.state_key === "session\0completed" ||
			declaration.state_key === "declared\0parked"
		)
	) {
		return undefined;
	}
	return { contentHash: declaration.content_hash };
}
