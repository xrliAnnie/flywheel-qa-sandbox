import { describe, expect, it } from "vitest";
import type { AlertPayload } from "../../LeadAlertNotifier.js";
import {
	formatAlertHandoffContent,
	formatInfraAlertMailboxContent,
} from "../infra-alert-mailbox.js";

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

describe("formatAlertHandoffContent", () => {
	it("gives the named Lead context and the contact-book backfill command", () => {
		const content = formatAlertHandoffContent({
			lane: "mailbox",
			correlationKey: "flywheel|lead-b|bridge_abnormal_exit|",
			eventId: "event-1",
			kind: "bridge_abnormal_exit",
			reason: "no_entry",
			note: "No owner was listed; inspect the exit evidence.",
			ref: "alert-ticket lookup --event-id event-1",
			toLeadId: "flywheel-eng-lead",
		});

		expect(content.split("\n")[0]).toBe(
			"[alert_handoff] bridge_abnormal_exit · 来自值守 · 去向 ③",
		);
		expect(content).toContain("note=No owner was listed");
		expect(content).toContain(
			"oncall-draft add --book contact-book --event-id event-1 --to flywheel-eng-lead --file -",
		);
	});
});
