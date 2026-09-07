import type { AlertPayload } from "../LeadAlertNotifier.js";

export const INFRA_ALERT_OWNER_LEAD_ID = "claude-infra-bot-lead";

export function formatInfraAlertMailboxContent(payload: AlertPayload): string {
	const context = [
		`event=${payload.eventType}`,
		`severity=${payload.severity}`,
		`project=${payload.projectName}`,
		payload.eventType === "review_job_failed"
			? `owner=${payload.leadId}`
			: `affected=${payload.leadId}`,
		...(payload.sessionKey ? [`session=${payload.sessionKey}`] : []),
	].join(" ");
	return [`[infra_alert] ${payload.title}`, payload.body, context].join("\n");
}

export interface AlertHandoffContentInput {
	lane: "thread" | "mailbox";
	correlationKey: string;
	eventId: string;
	kind: string;
	reason: "contact_book" | "no_entry";
	note?: string;
	ref: string;
	toLeadId: string;
}

export function formatAlertHandoffContent(
	input: AlertHandoffContentInput,
): string {
	return [
		`[alert_handoff] ${input.kind} · 来自值守 · 去向 ${input.reason === "no_entry" ? "③" : "②"}`,
		`lane=${input.lane}`,
		`event=${input.eventId}`,
		`correlation=${input.correlationKey}`,
		`note=${input.note ?? "-"}`,
		`ref=${input.ref}`,
		...(input.reason === "no_entry"
			? [
					`oncall-draft add --book contact-book --event-id ${input.eventId} --to ${input.toLeadId} --file -`,
				]
			: []),
	].join("\n");
}
