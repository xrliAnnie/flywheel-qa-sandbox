/** Semantic CLI configuration only. OAuth bytes rotate and are not model input. */
export function subscriptionConfiguration(model: string, effort: string) {
	const thinkingEnv = {
		MAX_THINKING_TOKENS: "31999",
		CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "0",
		CLAUDE_CODE_DISABLE_THINKING: "0",
		...(effort === "default" ? {} : { CLAUDE_CODE_EFFORT_LEVEL: effort }),
	};
	const settings = {
		disableAllHooks: true,
		enabledPlugins: {},
		language: "english",
		alwaysThinkingEnabled: true,
		...(effort === "default" ? {} : { effortLevel: effort }),
		env: thinkingEnv,
	};
	return {
		version: 1,
		authentication: "subscription_oauth",
		configDirectory: {
			allowedFiles: [".credentials.json"],
			inheritedSettings: false,
			inheritedClaudeMd: false,
			inheritedEnvironment: false,
			isolatedHome: true,
		},
		settingsJson: JSON.stringify(settings),
		thinkingEnv,
		argv: [
			"-p",
			"--model",
			model,
			...(effort === "default" ? [] : ["--effort", effort]),
			"--output-format",
			"json",
			"--tools",
			"",
			"--mcp-config",
			'{"mcpServers":{}}',
			"--strict-mcp-config",
			"--setting-sources",
			"user",
			"--no-session-persistence",
			"--safe-mode",
			"--disable-slash-commands",
			"--settings",
			JSON.stringify(settings),
		],
	};
}
