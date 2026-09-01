import { describe, expect, it } from "vitest";
import type { AlertPayload } from "../../LeadAlertNotifier.js";
import { formatInfraAlertMailboxContent } from "../infra-alert-mailbox.js";

describe("formatInfraAlertMailboxContent", () => {
	it("describes a review failure as owned by the receiving Lead", () => {
		const payload: AlertPayload = {
			leadId: "flywheel-eng-lead",
			projectName: "flywheel",
			eventId: "review-failed:req-1:1",
			eventType: "review_job_failed",
			title: "Review job failed",
			body: "Review req-1 failed: head_moved.",
			severity: "warning",
			sessionKey: "exec-1",
		};

		const content = formatInfraAlertMailboxContent(payload);

		expect(content).toContain("owner=flywheel-eng-lead");
		expect(content).not.toContain("affected=flywheel-eng-lead");
		expect(content).toContain("session=exec-1");
	});
});
