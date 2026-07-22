import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { drainWorkflowRouteReminders } from "../workflow-route-reminder-drain.js";

describe("workflow route reminder drain", () => {
	it("tells the Lead that absent type used generic fallback, never that it was rejected", async () => {
		const store = await StateStore.create(":memory:");
		store.claimWorkflowRouteDecision({
			project: "flywheel",
			issueId: "FLY-1407",
			executionId: "exec-fallback",
			route: "generic_fallback",
			routeDigest: "digest-fallback",
			categorySource: "default_fallback",
		});
		store.insertWorkflowRouteDecisionReminder({
			executionId: "exec-fallback",
			code: "WORK_KIND_DEFAULT_FALLBACK",
			payload: { taskCategory: null, fallback: "generic" },
			recipientLeadId: "flywheel-eng-lead",
		});
		const alert = vi.fn().mockResolvedValue({ sent: true });
		await drainWorkflowRouteReminders({
			store,
			notifier: { alert },
			owner: "fallback-drain",
		});
		expect(alert).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "FLY-1407 used generic work-kind fallback",
				body: expect.stringContaining(
					"No task category was provided, so this dispatch used the generic single-session fallback",
				),
			}),
		);
		expect(alert.mock.calls[0]![0].body).not.toContain("rejected");
		store.close();
	});

	it("accepts only sent or queued outcomes and redrives duplicate outcomes", async () => {
		const store = await StateStore.create(":memory:");
		const inserted = store.insertRejectedRouteDecisionWithReminder({
			project: "flywheel",
			issueId: "FLY-1407",
			errorCode: "INVALID_TASK_CATEGORY",
			payload: { taskCategory: "coding" },
			recipientLeadId: "flywheel-eng-lead",
		});
		const alert = vi
			.fn()
			.mockResolvedValueOnce({ skipped: "duplicate" })
			.mockResolvedValueOnce({ queued: true });
		let tick = Date.parse("2026-07-21T00:00:00.000Z");
		const now = () => {
			const value = new Date(tick);
			tick += 120_000;
			return value;
		};
		expect(
			await drainWorkflowRouteReminders({
				store,
				notifier: { alert },
				owner: "test-drain",
				now,
				maxItems: 2,
			}),
		).toEqual({ attempted: 2, accepted: 1, failed: 1 });
		expect(alert).toHaveBeenCalledTimes(2);
		const ids = alert.mock.calls.map(
			(call) => (call[0] as { eventId: string }).eventId,
		);
		expect(ids).toEqual([`${inserted.dedupKey}#1`, `${inserted.dedupKey}#2`]);
		expect(store.listWorkflowRouteReminderOutbox()[0]).toMatchObject({
			status: "accepted",
			attempts: 2,
		});
		store.close();
	});
});
