import { describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { type ReviewFindingRuling, StateStore } from "../../StateStore.js";
import {
	createReviewAlertEmitter,
	toReviewFindingRulingSnapshot,
} from "../review-governance-effects.js";

const projects = [
	{
		projectName: "proj",
		leads: [
			{
				agentId: "flywheel-eng-lead",
				match: { labels: ["backend"] },
				chatChannel: "alerts",
			},
		],
	},
] as unknown as ProjectEntry[];

function ruling(): ReviewFindingRuling {
	return {
		ruling_id: "r-1",
		project_name: "proj",
		issue_id_canonical: "uuid-1",
		issue_identifier: "FLY-1251",
		finding_key: "lease",
		source_request_id: "req-8",
		source_finding_index: 0,
		finding_title: "Add a metadata lease",
		finding_severity: "MEDIUM",
		review_type: "code",
		disposition: "follow_up",
		follow_up_issue: "FLY-1274",
		rationale: "Optimize separately.",
		ruled_by: "flywheel-eng-lead",
		created_at: "2026-07-14 12:00:00",
	};
}

describe("review governance production effects", () => {
	it("maps durable ruling rows to the frozen policy snapshot without authority drift", () => {
		expect(toReviewFindingRulingSnapshot(ruling())).toEqual({
			rulingId: "r-1",
			findingKey: "lease",
			reviewType: "code",
			disposition: "follow_up",
			rationale: "Optimize separately.",
			followUpIssue: "FLY-1274",
			findingTitle: "Add a metadata lease",
			createdAt: "2026-07-14 12:00:00",
		});
	});

	it("routes structured review alerts through the owning Lead with stable ticket fields", async () => {
		const store = await StateStore.create(":memory:");
		store.upsertSession({
			execution_id: "exec-1",
			project_name: "proj",
			issue_id: "uuid-1",
			issue_identifier: "FLY-1251",
			issue_labels: JSON.stringify(["backend"]),
			status: "running",
		});
		const alert = vi.fn(async () => ({ sent: true }));
		const emit = createReviewAlertEmitter({ store, projects, alert });
		await emit({
			kind: "review_ruling_disputed",
			eventId: "review-dispute:req-9:r-1",
			issueId: "FLY-1251",
			executionId: "exec-1",
			requestId: "req-9",
			rulingId: "r-1",
			message: "Reviewer presented new HIGH evidence.",
		});
		expect(alert).toHaveBeenCalledWith({
			leadId: "flywheel-eng-lead",
			projectName: "proj",
			eventId: "review-dispute:req-9:r-1",
			eventType: "review_ruling_disputed",
			title: "Reviewer disputed a Lead ruling",
			body: "Reviewer presented new HIGH evidence.",
			severity: "warning",
			sessionKey: "exec-1",
		});
	});

	it("routes review job failures as warning alerts without raw reviewer evidence", async () => {
		const store = await StateStore.create(":memory:");
		store.upsertSession({
			execution_id: "exec-1",
			project_name: "proj",
			issue_id: "uuid-1",
			issue_identifier: "FLY-1251",
			issue_labels: JSON.stringify(["backend"]),
			status: "running",
		});
		const alert = vi.fn(async () => ({ sent: true }));
		const emit = createReviewAlertEmitter({ store, projects, alert });
		await emit({
			kind: "review_job_failed",
			eventId: "review-failed:req-9:1",
			issueId: "FLY-1251",
			executionId: "exec-1",
			requestId: "req-9",
			message:
				"Review req-9 (code R2) failed: timeout. Retry POST /review-requests with the same requestId; the gate remains closed.",
		});
		expect(alert).toHaveBeenCalledWith({
			leadId: "flywheel-eng-lead",
			projectName: "proj",
			eventId: "review-failed:req-9:1",
			eventType: "review_job_failed",
			title: "Cross-family review job failed",
			body: "Review req-9 (code R2) failed: timeout. Retry POST /review-requests with the same requestId; the gate remains closed.",
			severity: "warning",
			sessionKey: "exec-1",
		});
	});

	it("falls back from an unknown audit execution to issue identity, and fails loud if neither resolves", async () => {
		const store = await StateStore.create(":memory:");
		store.upsertSession({
			execution_id: "runner",
			project_name: "proj",
			issue_id: "uuid-1",
			issue_identifier: "FLY-1251",
			issue_labels: JSON.stringify(["backend"]),
			status: "running",
		});
		const alert = vi.fn(async () => ({ sent: true }));
		const emit = createReviewAlertEmitter({ store, projects, alert });
		await emit({
			kind: "review_ruling_recorded",
			eventId: "review-ruling:r-1",
			issueId: "FLY-1251",
			executionId: "lead-shell",
			rulingId: "r-1",
			message: "Recorded.",
		});
		expect(alert).toHaveBeenCalledTimes(1);
		await expect(
			emit({
				kind: "review_ruling_recorded",
				eventId: "review-ruling:r-2",
				issueId: "FLY-9999",
				message: "Missing.",
			}),
		).rejects.toThrow(/no session/i);
	});
});
