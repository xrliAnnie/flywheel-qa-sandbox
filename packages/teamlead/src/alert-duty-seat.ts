export const ALERT_DUTY_SEAT = {
	leadId: "claude-infra-bot-lead",
} as const;

/** Production routing is fixed; only an isolated room may select its duty seat. */
export function resolveAlertDutyLeadId(
	env: Readonly<Record<string, string | undefined>> = process.env,
): string {
	return env.FLYWHEEL_ISOLATION_ROOT && env.FLYWHEEL_ALERT_DUTY_LEAD_ID
		? env.FLYWHEEL_ALERT_DUTY_LEAD_ID
		: ALERT_DUTY_SEAT.leadId;
}

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
	const dutyLeadId = resolveAlertDutyLeadId(input.env);
	if (input.leadId !== dutyLeadId) {
		return { isDutySeat: false, alertChannelId: null };
	}

	const project = input.projects.find(
		(candidate) => candidate.projectName === input.projectName,
	);
	const lead = project?.leads.find(
		(candidate) => candidate.agentId === dutyLeadId,
	);
	const configured = lead?.alertChannel?.trim();
	const fallback = input.env.FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID?.trim();

	return {
		isDutySeat: true,
		alertChannelId: configured || fallback || null,
	};
}
