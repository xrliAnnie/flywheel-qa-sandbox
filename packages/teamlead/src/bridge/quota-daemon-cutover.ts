export interface QuotaDaemonBridgeMode {
	cutover: boolean;
	attachAccountSwitch: boolean;
	runAccountSwitchWatchdog: boolean;
	retireAccountSwitchRoute: boolean;
	quarantinePending: boolean;
	runRunnerQuotaScan: boolean;
}

/**
 * FLY-1456 solidified truth table: the external quota daemon is the only
 * automatic account-switch executor. Bridge keeps runner quota observation
 * active but permanently retires its three legacy switch execution faces.
 */
export function resolveQuotaDaemonBridgeMode(): QuotaDaemonBridgeMode {
	return {
		cutover: true,
		attachAccountSwitch: false,
		runAccountSwitchWatchdog: false,
		retireAccountSwitchRoute: true,
		quarantinePending: true,
		runRunnerQuotaScan: true,
	};
}
