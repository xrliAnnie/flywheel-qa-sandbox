const DAY_MS = 24 * 60 * 60_000;
const MAX_RETENTION_DAYS = 365;

export const DEFAULT_HEADPHONE_INBOX_RETENTION_MS = 30 * DAY_MS;

export interface HeadphoneBackgroundConfig {
	enabled: boolean;
	retentionMs: number;
}

export function resolveHeadphoneBackgroundConfig(
	env: NodeJS.ProcessEnv,
): HeadphoneBackgroundConfig {
	const configuredDays = Number(env.FLYWHEEL_HEADPHONE_INBOX_RETENTION_DAYS);
	const retentionDays =
		Number.isSafeInteger(configuredDays) &&
		configuredDays >= 1 &&
		configuredDays <= MAX_RETENTION_DAYS
			? configuredDays
			: DEFAULT_HEADPHONE_INBOX_RETENTION_MS / DAY_MS;
	return {
		enabled: env.FLYWHEEL_HEADPHONE_BACKGROUND_ENABLED === "1",
		retentionMs: retentionDays * DAY_MS,
	};
}
