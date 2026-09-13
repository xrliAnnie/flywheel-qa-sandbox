/** Shared by registration and both MCP configuration/inventory gates. */
export const RUNNER_ACTION_TOOL_NAMES = [
	"start_runner",
	"list_runners",
	"get_runner_status",
	"read_runner_tmux",
	"send_runner",
	"respond_runner",
] as const;
export const RUNNER_CARRIER_ENV_NAMES = [
	"FLYWHEEL_LEAD_CARRIER_INSTANCE_ID",
] as const;
export function leadActionCredentialNames(
	mode: "direct" | "bridge",
	runners = false,
): string[] {
	return [
		...new Set([
			...(mode === "direct"
				? ["DISCORD_BOT_TOKEN"]
				: ["BRIDGE_URL", "TEAMLEAD_API_TOKEN"]),
			...(runners
				? ["BRIDGE_URL", "TEAMLEAD_API_TOKEN", ...RUNNER_CARRIER_ENV_NAMES]
				: []),
		]),
	];
}
