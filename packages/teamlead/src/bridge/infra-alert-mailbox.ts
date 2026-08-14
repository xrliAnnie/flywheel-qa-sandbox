import type { AlertPayload } from "../LeadAlertNotifier.js";

/**
 * FLY-1764 founder-final Flow 2: actionable infra alerts have one last-mile
 * owner, claw. Discord is an optional observation copy, never the primary
 * delivery. Keeping the switch on the route makes a later channel opt-in a
 * config change rather than another transport rewrite.
 */
export const INFRA_ALERT_LAST_MILE_ROUTE = {
	ownerLeadId: "claude-infra-bot-lead",
	copyToChannelEnv: "FLYWHEEL_ALERT_COPY_TO_CHANNEL",
	copyToChannelDefault: false,
} as const;

export function shouldCopyInfraAlertToChannel(
	env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
	return env[INFRA_ALERT_LAST_MILE_ROUTE.copyToChannelEnv] === "1";
}

export function formatInfraAlertMailboxContent(payload: AlertPayload): string {
	const context = [
		`event=${payload.eventType}`,
		`severity=${payload.severity}`,
		`project=${payload.projectName}`,
		`affected=${payload.leadId}`,
		...(payload.sessionKey ? [`session=${payload.sessionKey}`] : []),
	].join(" ");
	return [`[infra_alert] ${payload.title}`, payload.body, context].join("\n");
}
