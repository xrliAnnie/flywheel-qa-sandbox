/** Canonical approval-intent classifier shared by CLI and Bridge APIs. */

export type ApprovalIntent = "approve" | "reject" | "neutral";

const NEGATIVE_INTENT =
	/^\s*(?:not\s+approved?|do\s+not\s+approve|reject(?:ed)?|changes?[_ -]?requested|request\s+changes|needs?\s+(?:more\s+)?(?:changes|work|tests?))\b/i;
const POSITIVE_INTENT =
	/^\s*["'`]*(?:(?:approved?|lgtm|ship\s+it|go\s+ahead|merge\s+it)\b|(?:批准|同意(?:上线)?|可以\s*(?:merge|ship))(?=$|\s|[，。！!、,;；:：]))/i;

export function classifyApprovalIntent(answer: string): ApprovalIntent {
	try {
		const parsed = JSON.parse(answer) as {
			approved?: unknown;
			decision?: unknown;
		};
		if (parsed?.approved === true) return "approve";
		if (parsed?.approved === false) return "reject";
		if (
			parsed?.decision === "changes_requested" ||
			parsed?.decision === "reject" ||
			parsed?.decision === "rejected"
		) {
			return "reject";
		}
	} catch {
		// Plain text is classified below.
	}
	if (NEGATIVE_INTENT.test(answer)) return "reject";
	if (POSITIVE_INTENT.test(answer)) return "approve";
	return "neutral";
}

export function hasApprovalIntent(answer: string): boolean {
	return classifyApprovalIntent(answer) === "approve";
}
