import { expect, it } from "vitest";
import { CommDBLeadRuntime } from "../bridge/commdb-lead-runtime.js";
import type { LeadEventEnvelope } from "../bridge/lead-runtime.js";
import { MailboxLeadRuntime } from "../bridge/mailbox-lead-runtime.js";

it("renders the full frozen wake identity in both standard Lead transports", () => {
	const wake = {
		scheduleId: "evening",
		revision: 1,
		configDigest: "a".repeat(64),
		dueAt: "2026-09-14T20:00:00.000Z",
		localDate: "2026-09-14",
		timezone: "UTC",
	};
	const env: LeadEventEnvelope = {
		seq: 1,
		eventId: "business-wake:demo:lead:evening:2026-09-14",
		leadId: "lead",
		sessionKey: "business-wake",
		timestamp: "2026-09-14T21:00:00Z",
		event: {
			event_type: "business_wake",
			execution_id: "event",
			issue_id: "",
			project_name: "demo",
			business_wake: wake,
		},
	};
	for (const runtime of [MailboxLeadRuntime, CommDBLeadRuntime]) {
		const rendered = (
			runtime.prototype as unknown as {
				formatEnvelope(e: LeadEventEnvelope): string;
			}
		).formatEnvelope.call({}, env);
		expect(rendered).toContain(JSON.stringify(wake));
		expect(rendered).toContain(env.eventId);
	}
});
