import { describe, expect, it, vi } from "vitest";
import { type AlertPayload, LeadAlertNotifier } from "../LeadAlertNotifier.js";
import { StateStore } from "../StateStore.js";

const payload: AlertPayload = {
	leadId: "lead",
	projectName: "flywheel",
	eventId: "same",
	eventType: "bridge_abnormal_exit",
	title: "failure",
	body: "details",
	severity: "severe",
};
const subject = { baseVersion: "1.56.0", sourceCommit: "a".repeat(40) };

describe("alert readiness capture", () => {
	it("records capture gaps and keeps double-write failures until acknowledged without blocking delivery", async () => {
		const store = await StateStore.create(":memory:");
		try {
			const notifier = new LeadAlertNotifier({
				store,
				projects: [],
				deliveryEnabled: () => false,
				readinessSubject: subject,
			});
			vi.spyOn(store, "insertReleaseSignalObservation").mockImplementation(
				() => {
					throw new Error("event write failed");
				},
			);
			expect(await notifier.alert(payload)).toEqual({ skipped: "disabled" });
			expect(
				store.getReleaseReadinessEvidence(
					subject.sourceCommit,
					"2000-01-01T00:00:00.000Z",
					"2100-01-01T00:00:00.000Z",
				).gaps[0]?.reason,
			).toBe("bridge_ledger_write");
			vi.spyOn(store, "insertReleaseSignalGap").mockImplementation(() => {
				throw new Error("gap write failed");
			});
			await notifier.alert(payload);
			const observed = notifier.peekCaptureFailures();
			expect(observed).toBe(1);
			await notifier.alert(payload);
			expect(notifier.peekCaptureFailures()).toBe(2);
			notifier.ackCaptureFailures(observed);
			expect(notifier.peekCaptureFailures()).toBe(1);
		} finally {
			vi.restoreAllMocks();
			store.close();
		}
	});
	it("captures every arrival before the disabled-delivery early return", async () => {
		const store = await StateStore.create(":memory:");
		try {
			const notifier = new LeadAlertNotifier({
				store,
				projects: [],
				deliveryEnabled: () => false,
				readinessSubject: subject,
			});
			expect(await notifier.alert(payload)).toEqual({ skipped: "disabled" });
			await notifier.alert({ ...payload, severity: "warning" });
			const evidence = store.getReleaseReadinessEvidence(
				subject.sourceCommit,
				"2000-01-01T00:00:00.000Z",
				"2100-01-01T00:00:00.000Z",
			);
			expect(evidence.events).toMatchObject([
				{
					eventId: "same",
					sourceCommit: subject.sourceCommit,
					baseVersion: subject.baseVersion,
					occurrence: 1,
					severity: "severe",
				},
				{ eventId: "same", occurrence: 2, severity: "warning" },
			]);
		} finally {
			store.close();
		}
	});
});
