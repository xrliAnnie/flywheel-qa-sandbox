import { modelShortCode, vendorModelShortCode } from "./model-tiers.js";

/** Shared producer/consumer cap for the payload after the `Model ` namespace. */
export const RUNNER_MODEL_MARKER_PAYLOAD_MAX = 24;
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

function vendorFamilyShortCode(family: string): string {
	if (family === "claude" || family === "anthropic") return "A";
	if (family === "codex" || family === "openai") return "O";
	return /^[a-z0-9]/.test(family) ? family.charAt(0).toUpperCase() : "U";
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

	// FLY-2936: the first bracket identifies the vendor, while the second
	// identifies the model family. Keep model matching tied to the normalized
	// runtime family so mismatched metadata never claims the wrong model family.
	const claudeCode =
		family === "claude" || family === "anthropic"
			? claudeCodeCandidate
			: undefined;
	const normalizedVendorFamily = family === "openai" ? "codex" : family;
	const modelCode =
		claudeCode ?? vendorModelShortCode(normalizedVendorFamily, model);
	const vendorCode = vendorFamilyShortCode(family);
	const payload = safeToken(model, RUNNER_MODEL_MARKER_PAYLOAD_MAX);
	if (!modelCode && !payload) return undefined;

	const modelMarker = modelCode ? `[${modelCode}]` : `[Model ${payload}]`;
	const windowSegment = modelCode
		? `${vendorCode}${modelCode}`
		: `${vendorCode}-${payload}`;

	return {
		threadMarker: `[${vendorCode}]${modelMarker}`,
		windowLabel: windowSafe(`${family}-${windowSegment}`),
	};
}
