import {
	findDesignHtmlPaths,
	parseDesignHtmlEvidence,
} from "flywheel-comm/design-html-evidence";

export const DESIGN_HTML_EVIDENCE_ERROR = "design_html_evidence_missing";

const ISSUE_IDENTIFIER = /^[A-Z]+-\d+$/;

type AdmissionResult =
	| { ok: true; required: boolean }
	| {
			ok: false;
			code: typeof DESIGN_HTML_EVIDENCE_ERROR;
			reason: string;
			remediation: string;
	  };

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function rejected(reason: string): AdmissionResult {
	return {
		ok: false,
		code: DESIGN_HTML_EVIDENCE_ERROR,
		reason,
		remediation:
			"Create and commit the founder design HTML in this issue's doc folder, publish it with publish-report --publish-only, report the hosted URL to the Lead, then rerun complete --route phase_design_complete.",
	};
}

/**
 * Admission for the design-node completion semantic. The current legacy and
 * generalized DAG carriers both use phase_design_complete; workflow topology
 * is deliberately irrelevant here.
 */
export function validateDesignHtmlCompletion(input: {
	route: unknown;
	payload: unknown;
	authoritativeIssueIdentifier: unknown;
}): AdmissionResult {
	if (input.route !== "phase_design_complete") {
		return { ok: true, required: false };
	}
	if (
		typeof input.authoritativeIssueIdentifier !== "string" ||
		!ISSUE_IDENTIFIER.test(input.authoritativeIssueIdentifier)
	) {
		return rejected("authoritative issue identifier is missing or malformed");
	}
	const payload = record(input.payload);
	if (!payload) return rejected("completion payload is missing or malformed");
	const parsed = parseDesignHtmlEvidence(payload.designHtmlEvidence);
	if (!parsed.ok) return rejected(parsed.reason);
	if (parsed.issueIdentifier !== input.authoritativeIssueIdentifier) {
		return rejected(
			"attested issue identifier does not match the session issue",
		);
	}
	const matchingPaths = findDesignHtmlPaths(
		parsed.paths,
		parsed.issueIdentifier,
	);
	if (
		matchingPaths.length === 0 ||
		matchingPaths.length !== parsed.paths.length
	) {
		return rejected("attested HTML paths are outside the issue doc folder");
	}
	const headSha = record(payload.evidence)?.headSha;
	if (headSha !== parsed.headSha) {
		return rejected("attested head SHA does not match completion evidence");
	}
	return { ok: true, required: true };
}
