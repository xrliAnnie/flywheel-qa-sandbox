export const ALERT_DUTY_SEAT = {
	leadId: "claude-infra-bot-lead",
} as const;

export interface AlertDutyProject {
	projectName: string;
	leads: Array<{ agentId: string; alertChannel?: string }>;
}

export interface AlertDutySeatResolution {
	isDutySeat: boolean;
	alertChannelId: string | null;
}

export function resolveAlertDutySeat(input: {
	leadId: string;
	projectName: string;
	projects: AlertDutyProject[];
	env: Readonly<Record<string, string | undefined>>;
}): AlertDutySeatResolution {
	if (input.leadId !== ALERT_DUTY_SEAT.leadId) {
		return { isDutySeat: false, alertChannelId: null };
	}

	const project = input.projects.find(
		(candidate) => candidate.projectName === input.projectName,
	);
	const lead = project?.leads.find(
		(candidate) => candidate.agentId === ALERT_DUTY_SEAT.leadId,
	);
	const configured = lead?.alertChannel?.trim();
	const fallback = input.env.FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID?.trim();

	return {
		isDutySeat: true,
		alertChannelId: configured || fallback || null,
	};
}
