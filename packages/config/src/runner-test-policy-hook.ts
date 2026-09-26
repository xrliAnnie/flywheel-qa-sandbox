type JsonRecord = Record<string, unknown>;

const POLICY_BEGIN = "<!-- FLYWHEEL_LOCAL_TEST_POLICY:BEGIN -->";
const POLICY_END = "<!-- FLYWHEEL_LOCAL_TEST_POLICY:END -->";

export function buildRunnerTestPolicyHookSettings(
	prompt: string | undefined,
	hookCommand: string,
): JsonRecord | undefined {
	if (
		!prompt?.includes(POLICY_BEGIN) ||
		!prompt.includes(POLICY_END) ||
		!hookCommand
	) {
		return undefined;
	}
	return {
		hooks: {
			PreToolUse: [
				{
					matcher: "Agent || Task || Skill",
					hooks: [
						{
							type: "command",
							command: hookCommand,
							timeout: 5,
						},
					],
				},
			],
		},
	};
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function appendRunnerTestPolicyHookSettings(
	settings: JsonRecord,
	prompt: string | undefined,
	hookCommand: string,
): JsonRecord {
	const policySettings = buildRunnerTestPolicyHookSettings(prompt, hookCommand);
	if (!policySettings) return settings;

	const existingHooks = isRecord(settings.hooks) ? settings.hooks : {};
	const existingPreToolUse = Array.isArray(existingHooks.PreToolUse)
		? existingHooks.PreToolUse
		: [];
	const policyHooks = policySettings.hooks as JsonRecord;
	const policyPreToolUse = policyHooks.PreToolUse as unknown[];
	return {
		...settings,
		hooks: {
			...existingHooks,
			PreToolUse: [...existingPreToolUse, ...policyPreToolUse],
		},
	};
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildRunnerTestPolicyHookCommand(
	executable: string,
	hookPath: string,
): string {
	return `${shellQuote(executable)} ${shellQuote(hookPath)}`;
}
