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
