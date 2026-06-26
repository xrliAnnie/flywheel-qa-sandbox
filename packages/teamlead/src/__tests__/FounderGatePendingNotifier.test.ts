import { describe, expect, it, vi } from "vitest";
import {
	type AlertSink,
	FounderGatePendingNotifier,
} from "../FounderGatePendingNotifier.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { Session, StateStore } from "../StateStore.js";

const projects: ProjectEntry[] = [
	{
		projectName: "flywheel",
		projectRoot: "/tmp/fw",
		leads: [
			{
				agentId: "flywheel-eng-lead",
				forumChannel: "f",
				chatChannel: "c",
				match: { labels: ["Flywheel"] },
			},
		],
	},
];

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		execution_id: "exec-ar",
		issue_id: "uuid-123",
		project_name: "flywheel",
		status: "awaiting_review",
		issue_identifier: "FLY-100",
		issue_title: "do the thing",
		awaiting_review_entered_at: "2026-06-25 10:00:00",
		review_question_id: "q-1",
		...overrides,
	};
}

function makeNotifier(alert: AlertSink["alert"]) {
	const store: Pick<StateStore, "getSessionLabels"> = {
		getSessionLabels: vi.fn().mockReturnValue(["Flywheel"]),
	};
	const alertNotifier: AlertSink = { alert };
	return new FounderGatePendingNotifier({ projects, store, alertNotifier });
}

describe("FounderGatePendingNotifier (FLY-523)", () => {
	it("posts a founder_action_needed alert routed to the project's lead", async () => {
		const alert = vi.fn().mockResolvedValue({ sent: true });
		await makeNotifier(alert).notifyGatePending(makeSession());
		expect(alert).toHaveBeenCalledTimes(1);
		const payload = alert.mock.calls[0]![0];
		expect(payload.eventType).toBe("founder_action_needed");
		expect(payload.leadId).toBe("flywheel-eng-lead");
		expect(payload.projectName).toBe("flywheel");
		expect(payload.eventId).toBe(
			"founder-gate-pending:exec-ar:2026-06-25 10:00:00:q-1",
		);
		expect(payload.title.length).toBeGreaterThan(0);
		// founder-facing body must name the issue she needs to act on
		expect(payload.body).toContain("FLY-100");
	});

	it("eventId changes on a fresh review window so a re-review re-notifies", async () => {
		const alert = vi.fn().mockResolvedValue({ sent: true });
		const n = makeNotifier(alert);
		await n.notifyGatePending(
			makeSession({ awaiting_review_entered_at: "2026-06-25 10:00:00" }),
		);
		await n.notifyGatePending(
			makeSession({ awaiting_review_entered_at: "2026-06-25 12:30:00" }),
		);
		expect(alert.mock.calls[0]![0].eventId).not.toBe(
			alert.mock.calls[1]![0].eventId,
		);
	});

	it("re-notifies a same-second re-review (same timestamp, new review_question_id)", async () => {
		// Codex R1 MEDIUM: awaiting_review_entered_at is only second-precision, so a
		// feedback → re-request cycle inside the same second has an identical anchor.
		// The bound review_question_id (fresh per needs_review completion) must make
		// the eventId distinct so the founder is re-notified, not deduped away.
		const alert = vi.fn().mockResolvedValue({ sent: true });
		const n = makeNotifier(alert);
		await n.notifyGatePending(
			makeSession({
				awaiting_review_entered_at: "2026-06-25 10:00:00",
				review_question_id: "q-1",
			}),
		);
		await n.notifyGatePending(
			makeSession({
				awaiting_review_entered_at: "2026-06-25 10:00:00",
				review_question_id: "q-2",
			}),
		);
		expect(alert.mock.calls[0]![0].eventId).not.toBe(
			alert.mock.calls[1]![0].eventId,
		);
	});

	it("uses a stable eventId across repeated ticks of the same window (dedup-friendly)", async () => {
		const alert = vi.fn().mockResolvedValue({ sent: true });
		const n = makeNotifier(alert);
		await n.notifyGatePending(makeSession());
		await n.notifyGatePending(makeSession());
		expect(alert.mock.calls[0]![0].eventId).toBe(
			alert.mock.calls[1]![0].eventId,
		);
	});

	it("skips (no throw, no alert) when the project/lead cannot be resolved", async () => {
		const alert = vi.fn().mockResolvedValue({ sent: true });
		await expect(
			makeNotifier(alert).notifyGatePending(
				makeSession({ project_name: "unknown" }),
			),
		).resolves.toBeUndefined();
		expect(alert).not.toHaveBeenCalled();
	});

	it("does not throw if the underlying alert() rejects", async () => {
		const alert = vi.fn().mockRejectedValue(new Error("discord down"));
		await expect(
			makeNotifier(alert).notifyGatePending(makeSession()),
		).resolves.toBeUndefined();
	});
});
