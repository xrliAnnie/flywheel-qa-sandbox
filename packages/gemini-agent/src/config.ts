/** FLY-2105: the Gemini deep agent is retired and cannot be reactivated. */

export class ConfigError extends Error {
	constructor(msg: string) {
		super(msg);
		this.name = "ConfigError";
	}
}

export const MODEL_IDS = {
	flash: "gemini-3.5-flash",
	pro: "gemini-3.1-pro-preview",
} as const;

export type ModelTier = keyof typeof MODEL_IDS;
export type Surface = "interactions" | "generate";

export interface AgentConfig {
	apiKey: string;
	modelTier: ModelTier;
	model: string;
	surface: Surface;
	maxSteps: number;
	tokenBudgetIn: number;
	tokenBudgetOut: number;
	toolTimeoutMs: number;
	resultCapChars: number;
	bridgeUrl: string;
	bridgeToken: string;
	auditDir: string;
}

export function loadAgentConfig(
	_env: Record<string, string | undefined> = process.env,
): AgentConfig {
	throw new ConfigError(
		"Gemini deep agent was retired by FLY-2105; remove huddle.assistant.advanced",
	);
}
