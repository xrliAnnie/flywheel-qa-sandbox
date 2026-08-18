const MAX_JOB_LOG_BYTES = 256 * 1024;
const MERGE_STEP_NAME = "✅ Merge PR";

export type LandFailureKind =
	| "merge_conflict"
	| "head_moved"
	| "ci_failure"
	| "external_outage"
	| "cancelled"
	| "merged_externally"
	| "policy_blocked"
	| "unknown";

export interface LandFailureResult {
	kind: LandFailureKind;
	reason:
		| "merge_conflict"
		| "head_moved"
		| "ship_workflow_failed:ci_failure"
		| "external_outage"
		| "ship_workflow_failed:cancelled"
		| "merged_externally"
		| "policy_blocked"
		| "policy_alignment_pending"
		| "mergeability_pending"
		| "merge_state_unknown"
		| "ship_failure_unknown";
}

export interface LandFailurePrEvidence {
	state: "OPEN" | "MERGED" | "CLOSED";
	headSha: string;
	mergeStateStatus?: string | null;
	isDraft?: boolean;
	reviewDecision?: string | null;
	checks?: Array<{
		status?: string | null;
		conclusion?: string | null;
	}>;
}

export interface LandFailureWorkflowEvidence {
	conclusion?: string | null;
	failedStep?: { number: number; name: string } | null;
	structuredReason?: string | null;
	failedStepLog?: string | null;
}

export interface LandFailureEvidence {
	approvedHead: string;
	pr: LandFailurePrEvidence;
	workflow?: LandFailureWorkflowEvidence;
	probeErrorClass?: "network" | "rate_limit" | "server" | null;
}

export interface ActionsStepEnvelope {
	number: number;
	name: string;
	startedAt?: string | null;
	completedAt?: string | null;
}

function normalized(value: string | null | undefined): string {
	return value?.trim().toLowerCase() ?? "";
}

function classifyMergeEvidence(
	workflow: LandFailureWorkflowEvidence,
): LandFailureResult | undefined {
	const structured = normalized(workflow.structuredReason);
	if (structured === "merge_conflict") {
		return { kind: "merge_conflict", reason: "merge_conflict" };
	}
	if (structured === "head_moved") {
		return { kind: "head_moved", reason: "head_moved" };
	}
	if (
		structured === "external_outage" ||
		structured === "merge_error:5xx" ||
		structured === "merge_error:429"
	) {
		return { kind: "external_outage", reason: "external_outage" };
	}
	if (structured === "policy_blocked" || structured === "merge_error:403") {
		return { kind: "policy_blocked", reason: "policy_blocked" };
	}

	const log = workflow.failedStepLog ?? "";
	if (!log) return undefined;
	if (/\b(?:status\s*)?429\b|\brate limit(?:ed)?\b/i.test(log)) {
		return { kind: "external_outage", reason: "external_outage" };
	}
	if (
		/\b(?:status\s*)?5\d\d\b|service unavailable|bad gateway|gateway timeout|network error|socket hang up|econnreset/i.test(
			log,
		)
	) {
		return { kind: "external_outage", reason: "external_outage" };
	}
	if (
		/head branch was modified|expected head sha|\bstatus\s*409\b/i.test(log)
	) {
		return { kind: "head_moved", reason: "head_moved" };
	}
	if (/not mergeable|merge conflict|\bstatus\s*405\b/i.test(log)) {
		return { kind: "merge_conflict", reason: "merge_conflict" };
	}
	if (/\bstatus\s*403\b|resource not accessible|permission denied/i.test(log)) {
		return { kind: "policy_blocked", reason: "policy_blocked" };
	}
	return undefined;
}

function hasPendingChecks(pr: LandFailurePrEvidence): boolean {
	return (pr.checks ?? []).some((check) => {
		const status = normalized(check.status);
		return status !== "completed" && status !== "complete";
	});
}

export function classifyLandFailure(
	evidence: LandFailureEvidence,
): LandFailureResult {
	const prHead = evidence.pr.headSha.toLowerCase();
	const approvedHead = evidence.approvedHead.toLowerCase();
	if (evidence.pr.state === "MERGED" && prHead === approvedHead) {
		return { kind: "merged_externally", reason: "merged_externally" };
	}
	if (prHead !== approvedHead) {
		return { kind: "head_moved", reason: "head_moved" };
	}
	if (evidence.pr.isDraft === true) {
		return { kind: "policy_blocked", reason: "policy_blocked" };
	}
	if (evidence.probeErrorClass) {
		return { kind: "external_outage", reason: "external_outage" };
	}

	const conclusion = normalized(evidence.workflow?.conclusion);
	if (conclusion === "cancelled" || conclusion === "timed_out") {
		return {
			kind: "cancelled",
			reason: "ship_workflow_failed:cancelled",
		};
	}
	if (conclusion === "failure") {
		const failedStep = evidence.workflow?.failedStep;
		if (failedStep && failedStep.name !== MERGE_STEP_NAME) {
			return {
				kind: "ci_failure",
				reason: "ship_workflow_failed:ci_failure",
			};
		}
		if (failedStep?.name === MERGE_STEP_NAME && evidence.workflow) {
			const classified = classifyMergeEvidence(evidence.workflow);
			if (classified) return classified;
		}
	}

	const mergeState = evidence.pr.mergeStateStatus?.trim().toUpperCase() ?? "";
	switch (mergeState) {
		case "DIRTY":
			return { kind: "merge_conflict", reason: "merge_conflict" };
		case "UNKNOWN":
		case "":
			return { kind: "unknown", reason: "mergeability_pending" };
		case "BLOCKED":
			return hasPendingChecks(evidence.pr)
				? { kind: "unknown", reason: "policy_alignment_pending" }
				: { kind: "policy_blocked", reason: "policy_blocked" };
		case "CLEAN":
		case "BEHIND":
		case "HAS_HOOKS":
		case "UNSTABLE":
			return { kind: "unknown", reason: "ship_failure_unknown" };
		default:
			return { kind: "unknown", reason: "merge_state_unknown" };
	}
}

function lineTimestamp(line: string): number | undefined {
	const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s/.exec(
		line,
	);
	if (!match?.[1]) return undefined;
	const timestamp = Date.parse(match[1]);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

export function extractBoundedFailedStepLog(input: {
	log: string;
	failedStep: { number: number; name: string };
	steps: ActionsStepEnvelope[];
}): string | null {
	if (Buffer.byteLength(input.log, "utf8") > MAX_JOB_LOG_BYTES) return null;
	const matching = input.steps.filter(
		(step) =>
			step.number === input.failedStep.number &&
			step.name === input.failedStep.name,
	);
	if (matching.length !== 1) return null;
	const step = matching[0];
	if (!step?.startedAt || !step.completedAt) return null;
	const start = Date.parse(step.startedAt);
	const end = Date.parse(step.completedAt);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
		return null;
	const lines = input.log.split(/\r?\n/).filter((line) => {
		const timestamp = lineTimestamp(line);
		return timestamp !== undefined && timestamp >= start && timestamp <= end;
	});
	return lines.length > 0 ? lines.join("\n") : null;
}
