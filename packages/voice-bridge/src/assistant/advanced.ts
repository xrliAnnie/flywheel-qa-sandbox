import type { LiveToolSpec } from "flywheel-voice-core";

export interface AssistantAdvancedConfig {
	leadId: string;
	commandName?: string;
	deptLabel?: string;
	identityPath?: string;
}

export interface AdvancedDelegateDeps {
	advanced: AssistantAdvancedConfig;
	projectName: string;
	env: NodeJS.ProcessEnv;
	speak: (text: string) => void;
	log: (msg: string) => void;
	sendText?: (content: string) => Promise<unknown>;
}

export function buildAdvancedDelegateTool(
	_deps: AdvancedDelegateDeps,
): LiveToolSpec {
	throw new Error(
		"voice-bridge: huddle.assistant.advanced was retired by FLY-2105; remove huddle.assistant.advanced",
	);
}
