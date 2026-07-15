export interface QuotaDaemonBridgeMode {
	cutover: boolean;
	attachAccountSwitch: boolean;
	runAccountSwitchWatchdog: boolean;
	retireAccountSwitchRoute: boolean;
	quarantinePending: boolean;
	runRunnerQuotaScan: boolean;
}

export function quotaDaemonCutoverEnabled(
	env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
	return env.FLYWHEEL_QUOTA_DAEMON_CUTOVER === "1";
}

/**
 * One explicit truth table for every Bridge execution face retired by the
 * external quota daemon. Legacy mode is intentionally unchanged.
 */
export function resolveQuotaDaemonBridgeMode(
	poolConfigured: boolean,
	env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): QuotaDaemonBridgeMode {
	const cutover = quotaDaemonCutoverEnabled(env);
	if (cutover) {
		return {
			cutover: true,
			attachAccountSwitch: false,
			runAccountSwitchWatchdog: false,
			retireAccountSwitchRoute: true,
			quarantinePending: true,
			runRunnerQuotaScan: true,
		};
	}
	return {
		cutover: false,
		attachAccountSwitch: poolConfigured,
		runAccountSwitchWatchdog: poolConfigured,
		retireAccountSwitchRoute: false,
		quarantinePending: false,
		runRunnerQuotaScan: poolConfigured,
	};
}
