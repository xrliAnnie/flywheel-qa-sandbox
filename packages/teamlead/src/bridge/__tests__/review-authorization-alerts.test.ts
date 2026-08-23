import { describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import type { Session } from "../../StateStore.js";
import { ReviewAuthorizationAlerts } from "../review-authorization-alerts.js";

const SHA = "a".repeat(40);

const projects = [
	{
		projectName: "proj",
		projectRoot: "/x",
		leads: [{ agentId: "lead-1", match: { labels: ["engineer"] } }],
	} as ProjectEntry,
];

function session(over: Partial<Session> = {}): Session {
	return {
		execution_id: "main-1",
		issue_id: "parent-uuid",
		project_name: "proj",
		issue_identifier: "FLY-1981",
		issue_labels: JSON.stringify(["engineer"]),
		...over,
	} as Session;
}

describe("ReviewAuthorizationAlerts", () => {
	it("emits a durable severe ship-attempt alert bound to approval and head", async () => {
		const alert = vi.fn(async () => ({ sent: true }));
		const service = new ReviewAuthorizationAlerts({
			projects,
			leadAlertNotifier: { alert: alert as never },
		});
		await service.alertShipAttemptFailed(
			session({ review_question_id: "q-1", pr_head_sha: SHA }),
			"SHIP-STALLED",
		);

		expect(alert).toHaveBeenCalledWith(
			expect.objectContaining({
				eventId: `ship-attempt-failed:main-1:q-1:${SHA}`,
				eventType: "ship_attempt_failed",
				severity: "severe",
				body: "SHIP-STALLED",
			}),
		);
	});

	it.each([{ skipped: "no-channel" as const }, { deadLettered: true }])(
		"rejects a non-durable ship-attempt alert result",
		async (result) => {
			const service = new ReviewAuthorizationAlerts({
				projects,
				leadAlertNotifier: { alert: vi.fn(async () => result) },
			});
			await expect(
				service.alertShipAttemptFailed(session(), "SHIP-STALLED"),
			).rejects.toThrow("not accepted");
		},
	);

	it("keeps live ship-alert delivery best-effort while logging failures", async () => {
		const warn = vi.fn();
		const service = new ReviewAuthorizationAlerts({
			projects,
			leadAlertNotifier: {
				alert: vi.fn(async () => {
					throw new Error("discord unavailable");
				}),
			},
			logger: { warn },
		});

		await expect(
			service.alertShipAttemptFailedBestEffort(session(), "SHIP-STALLED"),
		).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("discord unavailable"),
		);
	});

	it("emits complete-marker alerts with the caller-owned event id", async () => {
		const alert = vi.fn(async () => ({ sent: true }));
		const service = new ReviewAuthorizationAlerts({
			projects,
			leadAlertNotifier: { alert: alert as never },
		});
		await service.alertCompleteMarkerHeld({
			eventId: "complete-marker-5xx:main-1:episode",
			kind: "unknown_5xx_episode",
			execId: "main-1",
			issueId: "parent-uuid",
			projectName: "proj",
			session: session(),
			markerPath: "/state/complete-failed/main-1.json",
			reason: "Bridge returned 500 three times; marker retained",
			httpStatus: 500,
		});

		expect(alert).toHaveBeenCalledWith(
			expect.objectContaining({
				eventId: "complete-marker-5xx:main-1:episode",
				eventType: "complete_marker_held",
				severity: "severe",
			}),
		);
	});

	it("routes merge-without-approval through the preserved kind with neutral authorization copy", async () => {
		const alert = vi.fn(async () => ({ sent: true }));
		const service = new ReviewAuthorizationAlerts({
			projects,
			leadAlertNotifier: { alert: alert as never },
			now: () => 42,
		});
		await service.alertMergeWithoutApproval(session(), "self-merged");

		expect(alert).toHaveBeenCalledWith(
			expect.objectContaining({
				eventId: "merge-authorization-held:main-1:42",
				eventType: "auto_qa_stuck",
				title: "Merge authorization held — FLY-1981",
				body: "self-merged",
			}),
		);
	});

	it.each([
		{
			label: "alert sink",
			projects,
			leadAlertNotifier: undefined,
		},
		{
			label: "lead",
			projects: [],
			leadAlertNotifier: { alert: vi.fn(async () => ({ sent: true })) },
		},
	])(
		"logs and resolves when a merge alert has no $label",
		async ({ label, projects: configuredProjects, leadAlertNotifier }) => {
			const error = vi.fn();
			const service = new ReviewAuthorizationAlerts({
				projects: configuredProjects,
				leadAlertNotifier: leadAlertNotifier as never,
				logger: { warn: vi.fn(), error } as never,
			});

			await expect(
				service.alertMergeWithoutApproval(session(), "self-merged"),
			).resolves.toBeUndefined();
			expect(error).toHaveBeenCalledWith(
				expect.stringContaining(`no ${label}`),
			);
		},
	);
});
