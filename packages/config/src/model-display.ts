import { modelDisplayName, modelShortCode } from "./model-tiers.js";

const MODEL_PAYLOAD_MAX = 24;
const WINDOW_LABEL_MAX = 32;

export interface RunnerModelDisplayInput {
	vendor: string | null | undefined;
	model: string | null | undefined;
}

export interface RunnerModelDisplay {
	threadMarker: string;
	windowLabel: string;
}

function safeToken(raw: string, max: number): string {
	return raw
		.trim()
		.replace(/[^A-Za-z0-9._+-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[-._+]+|[-._+]+$/g, "")
		.slice(0, max);
}

function windowSafe(raw: string): string {
	return raw
		.replace(/[^A-Za-z0-9-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, WINDOW_LABEL_MAX);
}

export function renderRunnerModelDisplay(
	input: RunnerModelDisplayInput,
): RunnerModelDisplay | undefined {
	const model = input.model?.trim();
	if (!model) return undefined;

	const lowerModel = model.toLowerCase();
	const explicitFamily = safeToken(input.vendor ?? "", 12).toLowerCase();
	const claudeCodeCandidate = modelShortCode(model);
	const inferredFamily = claudeCodeCandidate
		? "claude"
		: lowerModel.startsWith("gpt-")
			? "codex"
			: lowerModel.startsWith("kimi-")
				? "kimi"
				: "unknown";
	const family = explicitFamily || inferredFamily;
	const claudeCode = family === "claude" ? claudeCodeCandidate : undefined;
	const familyDisplay =
		family === "claude" && claudeCode
			? modelDisplayName(model)
			: family === "codex" && lowerModel.startsWith("gpt-")
				? modelDisplayName(model)
				: undefined;
	const payload = safeToken(familyDisplay ?? model, MODEL_PAYLOAD_MAX);
	if (!payload) return undefined;

	return {
		threadMarker: claudeCode ?? `Model ${payload}`,
		windowLabel: windowSafe(`${family}-${payload}`),
	};
}
