import type { AlertPayload } from "../LeadAlertNotifier.js";
import { type ProjectEntry, resolveLeadForIssue } from "../ProjectConfig.js";
import type {
	ReviewFindingRuling,
	Session,
	StateStore,
} from "../StateStore.js";
import type { ReviewAlertEvent } from "./review-request-coordinator.js";
import type { ReviewFindingRulingSnapshot } from "./review-verdict-policy.js";

export function toReviewFindingRulingSnapshot(
	ruling: ReviewFindingRuling,
): ReviewFindingRulingSnapshot {
	return {
		rulingId: ruling.ruling_id,
		findingKey: ruling.finding_key,
		reviewType: ruling.review_type,
		disposition: ruling.disposition,
		rationale: ruling.rationale,
		...(ruling.follow_up_issue
			? { followUpIssue: ruling.follow_up_issue }
			: {}),
		...(ruling.finding_title ? { findingTitle: ruling.finding_title } : {}),
		createdAt: ruling.created_at,
		...(ruling.revoked_at ? { revokedAt: ruling.revoked_at } : {}),
	};
}

export function createReviewAlertEmitter(deps: {
	store: StateStore;
	projects: ProjectEntry[];
	alert: (payload: AlertPayload) => Promise<unknown>;
}): (event: ReviewAlertEvent) => Promise<void> {
	return async (event) => {
		const session = resolveReviewAlertSession(deps.store, event);
		if (!session) {
			throw new Error(`no session for review alert issue ${event.issueId}`);
		}
		const labels = parseLabels(session.issue_labels);
		const { lead } = resolveLeadForIssue(
			deps.projects,
			session.project_name,
			labels,
		);
		await deps.alert({
			leadId: lead.agentId,
			projectName: session.project_name,
			eventId: event.eventId,
			eventType: event.kind,
			title: reviewAlertTitle(event.kind),
			body: event.message,
			severity:
				event.kind === "review_job_failed" ||
				event.kind === "review_ruling_disputed" ||
				event.kind === "review_ruling_notify_failed"
					? "warning"
					: "info",
			sessionKey: session.execution_id,
		});
	};
}

function resolveReviewAlertSession(
	store: StateStore,
	event: ReviewAlertEvent,
): Session | undefined {
	if (event.executionId) {
		const exact = store.getSession(event.executionId);
		if (exact) return exact;
	}
	return (
		store.getSessionByIssue(event.issueId) ??
		store.getSessionByIdentifier(event.issueId)
	);
}

function parseLabels(raw: string | undefined): string[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed)
			? parsed.filter((value): value is string => typeof value === "string")
			: [];
	} catch {
		return [];
	}
}

function reviewAlertTitle(kind: ReviewAlertEvent["kind"]): string {
	switch (kind) {
		case "review_advisory_pass":
			return "Review passed with non-blocking advisories";
		case "review_job_failed":
			return "Cross-family review job failed";
		case "review_ruling_recorded":
			return "Lead review ruling recorded";
		case "review_ruling_disputed":
			return "Reviewer disputed a Lead ruling";
		case "review_ruling_notify_failed":
			return "Review ruling audit post failed";
	}
}
